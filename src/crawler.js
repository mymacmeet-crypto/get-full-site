'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { Logger } = require('./logger');
const { CrawlQueue } = require('./queue');
const { RateLimiter } = require('./rateLimiter');
const { RobotsCache } = require('./robots');
const { CrawlReport } = require('./report');
const { CrawlState } = require('./state');
const { Archiver } = require('./archiver');
const { fetchPage } = require('./fetcher');
const { extractPageData } = require('./extractor');
const { loadSitemapEntries, sortByPriority } = require('./sitemap');
const { normalizeUrl, checkScope, isSameDomain } = require('./utils/url');
const { siteDir, reportDir, rawHtmlDir, FlatNames } = require('./utils/paths');
const { formatDuration } = require('./utils/misc');

const STATE_SAVE_INTERVAL = 10; // pages between periodic state saves

/** Run an async mapper over items, at most `limit` in flight. */
async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Crawl orchestrator, organised in waves rather than per-page workers:
 *
 *   discover a wave of pages over plain HTTP  ->  archive that whole wave in
 *   one SingleFile batch through the shared browser  ->  repeat
 *
 * The discovery fetch is what yields HTTP status, robots decisions, canonical
 * URLs and links; SingleFile's browser load is what produces the standalone
 * file. Batching the second half is what makes the shared browser and its
 * parallel tabs pay off.
 */
class Crawler {
  constructor(config) {
    this.config = config;
    this.logger = new Logger(config.logLevel);

    this.startUrl = normalizeUrl(config.startUrl);
    if (!this.startUrl) {
      throw new Error(`Invalid start URL: "${config.startUrl}" (must be http(s))`);
    }

    this.siteDirectory = siteDir(this.startUrl, config.outputFolder);
    this.reportDirectory = reportDir(this.siteDirectory);
    this.rawHtmlDirectory = rawHtmlDir(this.siteDirectory);

    this.queue = new CrawlQueue();
    this.report = new CrawlReport(config);
    this.state = new CrawlState(this.reportDirectory);
    this.rateLimiter = new RateLimiter(config.delayMs);
    this.names = new FlatNames();
    this.archiver = new Archiver(
      config,
      this.logger,
      path.join(this.reportDirectory, 'capture-errors.log')
    );
    this.robots = config.respectRobots
      ? new RobotsCache({
          userAgent: config.userAgent,
          timeoutMs: config.timeoutMs,
          logger: this.logger,
        })
      : null;

    this.scope = {
      startUrl: this.startUrl,
      sameDomainOnly: config.sameDomainOnly,
      includePatterns: config.includePatterns,
      excludePatterns: config.excludePatterns,
    };

    this.processedCount = 0; // pages that consumed a --max-pages slot
    this.aborted = false;
    this._sinceLastSave = 0;
  }

  /** Request a graceful stop: the current wave finishes, then the crawl exits. */
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.report.interrupted = true;
    this.logger.warn('Abort requested - finishing the current wave and saving state...');
  }

  async run() {
    const { config, logger } = this;
    const startedAt = Date.now();

    fs.mkdirSync(this.reportDirectory, { recursive: true });
    if (!config.dryRun) fs.mkdirSync(this.rawHtmlDirectory, { recursive: true });

    await this._initializeFrontier();

    logger.info(
      `Archiving ${this.startUrl} -> ${this.siteDirectory} ` +
        `(depth<=${config.maxDepth}, pages<=${config.maxPages}, ` +
        `discovery=${config.concurrency}, tabs=${config.workers}, batch=${config.batchSize}, ` +
        `delay=${config.delayMs}ms${config.dryRun ? ', DRY RUN' : ''})`
    );

    try {
      while (!this.aborted) {
        const wave = this._takeWave();
        if (wave.length === 0) break;

        const jobs = await this._discoverWave(wave);
        if (jobs.length > 0) await this._archiveJobs(jobs);

        this._maybePersistState(jobs.length);
      }
    } finally {
      await this.archiver.close();
    }

    return this._finalize(startedAt);
  }

  /** Pull the next slice of the frontier, respecting the remaining page budget. */
  _takeWave() {
    const remaining = this.config.maxPages - this.processedCount;
    if (remaining <= 0) return [];

    const wave = [];
    const limit = Math.min(this.config.batchSize, remaining);
    while (wave.length < limit) {
      const item = this.queue.next();
      if (!item) break;
      if (this.queue.hasVisited(item.url)) {
        // Became an alias (redirect/canonical target) of an already-done page.
        this.report.recordSkipped(item.url, 'already-visited-alias');
        continue;
      }
      wave.push(item);
    }
    return wave;
  }

  /**
   * Discovery half of a wave: fetch each page over HTTP, apply the crawl rules,
   * enqueue newly found links and return the archive jobs the wave produced.
   */
  async _discoverWave(wave) {
    const jobs = [];

    await mapWithConcurrency(wave, this.config.concurrency, async (item) => {
      try {
        const job = await this._discoverPage(item);
        if (job) jobs.push(job);
      } catch (error) {
        this.logger.error(`Unexpected error on ${item.url}: ${error.stack || error}`);
        this.report.recordFailed({
          url: item.url,
          error: `internal: ${error.message}`,
          stage: 'internal',
        });
      } finally {
        this.queue.markVisited(item.url);
      }
    });

    return jobs;
  }

  /** Returns an archive job for this page, or null when it is not archivable. */
  async _discoverPage({ url, depth }) {
    const { config, logger, report } = this;

    if (this.robots && !(await this.robots.isAllowed(url))) {
      report.recordSkipped(url, 'robots-disallowed');
      logger.debug(`robots disallowed: ${url}`);
      return null;
    }

    await this.rateLimiter.acquire();
    const result = await fetchPage(url, {
      timeoutMs: config.timeoutMs,
      followRedirects: config.followRedirects,
      userAgent: config.userAgent,
      maxRetries: config.maxRetries,
      retryDelayMs: config.retryDelayMs,
      onRetry: ({ attempt, wait, reason }) => {
        // Slow every worker down, not just this one - rate limiting is per site.
        this.rateLimiter.backOff(wait);
        logger.warn(`retry ${attempt}/${config.maxRetries} in ${wait}ms (${reason}): ${url}`);
      },
    });

    if (!result.ok) {
      if (result.redirected && !config.followRedirects) {
        report.recordSkipped(url, `redirect-not-followed:${result.status}`);
        logger.info(`skip (redirect ${result.status}, not followed): ${url}`);
      } else {
        report.recordFailed({
          url,
          error: result.error,
          attempts: result.attempts,
          stage: 'fetch',
        });
        logger.warn(`fetch failed (${result.error}) after ${result.attempts} attempt(s): ${url}`);
      }
      return null;
    }

    // A followed redirect may land on a different page entirely.
    let effectiveUrl = url;
    if (result.finalUrl && result.finalUrl !== url) {
      if (this.queue.hasVisited(result.finalUrl)) {
        report.recordSkipped(url, 'redirect-target-already-visited');
        return null;
      }
      const scope = checkScope(result.finalUrl, this.scope);
      if (!scope.allowed) {
        report.recordSkipped(url, `redirect-out-of-scope:${scope.reason}`);
        return null;
      }
      this.queue.markVisited(result.finalUrl);
      effectiveUrl = result.finalUrl;
    }

    if (result.html === null) {
      report.recordSkipped(url, `non-html:${result.contentType || 'unknown'}`);
      logger.debug(`skip (non-HTML ${result.contentType}): ${url}`);
      return null;
    }

    const { links, canonical, title } = extractPageData(result.html, effectiveUrl);

    // Canonical de-duplication: a page that declares an already-handled
    // canonical URL is duplicate content; otherwise claim the canonical form so
    // the same content is never archived twice.
    if (canonical && canonical !== effectiveUrl) {
      if (this.queue.hasVisited(canonical)) {
        report.recordSkipped(url, 'duplicate-canonical');
        logger.debug(`skip (canonical ${canonical} already visited): ${url}`);
        return null;
      }
      if (isSameDomain(canonical, effectiveUrl)) {
        this.queue.markVisited(canonical);
      }
    }

    this._enqueueLinks(links, depth);

    if (this.processedCount >= config.maxPages) {
      report.recordSkipped(url, 'page-budget-reached');
      return null;
    }

    if (config.dryRun) {
      this.processedCount++;
      report.recordDownloaded({
        url: effectiveUrl,
        file: null,
        status: result.status,
        depth,
        title,
        dryRun: true,
      });
      logger.info(`[${this.processedCount}/${config.maxPages}] depth=${depth} ${result.status} ${effectiveUrl} (dry run)`);
      return null;
    }

    const fileName = this.names.assign(effectiveUrl);
    const filePath = path.join(this.rawHtmlDirectory, fileName);

    if (!config.overwrite && fs.existsSync(filePath)) {
      report.recordSkipped(url, 'file-exists');
      logger.info(`depth=${depth} exists, skipped: ${fileName}`);
      return null;
    }

    // The slot is reserved here so a wave can never overshoot --max-pages.
    this.processedCount++;
    return { url: effectiveUrl, filePath, fileName, status: result.status, depth, title };
  }

  _enqueueLinks(links, depth) {
    if (depth >= this.config.maxDepth) return;
    for (const link of links) {
      if (this.queue.hasVisited(link) || this.queue.known.has(link)) continue;
      const scope = checkScope(link, this.scope);
      if (!scope.allowed) {
        this.report.recordSkipped(link, `out-of-scope:${scope.reason}`);
        continue;
      }
      this.queue.add(link, depth + 1);
    }
  }

  /** Archive half of a wave: one SingleFile batch through the shared browser. */
  async _archiveJobs(jobs) {
    const { config, logger, report } = this;

    // SingleFile loads every page again in the browser, so the batch costs the
    // site one more visit per page and goes through the same politeness budget.
    for (let i = 0; i < jobs.length; i++) await this.rateLimiter.acquire();

    const startedAt = Date.now();
    const results = await this.archiver.archiveBatch(
      jobs.map((job) => ({ url: job.url, filePath: job.filePath }))
    );
    const batchMs = Date.now() - startedAt;
    const perPageMs = Math.round(batchMs / jobs.length);

    results.forEach((result, index) => {
      const job = jobs[index];
      if (result.ok) {
        let bytes = 0;
        try {
          bytes = fs.statSync(job.filePath).size;
        } catch {
          /* size is informational only */
        }
        report.recordDownloaded({
          url: job.url,
          file: path.relative(this.siteDirectory, job.filePath).replace(/\\/g, '/'),
          status: job.status,
          depth: job.depth,
          title: job.title,
          bytes,
          durationMs: perPageMs,
        });
        logger.info(
          `[${report.pages.length}/${config.maxPages}] depth=${job.depth} ${job.status} ` +
            `${job.url} -> ${job.fileName} (${(bytes / 1024).toFixed(0)} KB)`
        );
      } else {
        // A failed page gives its budget slot back so --max-pages counts
        // pages actually archived.
        this.processedCount--;
        report.recordFailed({ url: job.url, error: result.error, stage: 'capture' });
        logger.warn(`archive failed: ${job.url} -> ${result.error}`);
      }
    });

    logger.debug(
      `Wave of ${jobs.length} archived in ${formatDuration(batchMs)} (~${perPageMs}ms/page)`
    );
  }

  async _initializeFrontier() {
    const previous = this.config.resume ? this.state.load(this.startUrl) : null;
    if (previous) {
      this.queue = CrawlQueue.fromJSON(previous.queue);
      this.report.restore(previous.stats);
      this.processedCount = previous.processedCount || 0;
      this.names.restore(this.report.pages);
      this.logger.info(
        `Resuming crawl saved at ${previous.savedAt}: ` +
          `${this.queue.pendingCount} pending, ${this.queue.visited.size} visited, ` +
          `${this.report.pages.length} already archived ` +
          '(sitemap URLs are already part of the saved queue)'
      );
      return;
    }

    if (this.config.resume) {
      this.logger.info('No resumable state found - starting a fresh crawl');
    }
    this.queue.add(this.startUrl, 0);
    if (this.config.sitemapEnabled) await this._seedFromSitemap();
  }

  /**
   * Seed the frontier from sitemap.xml: sitemap URLs are enqueued (highest
   * <priority> first) ahead of any link-discovered URLs and enter at depth 0,
   * i.e. they are treated as first-class seeds just like the start URL.
   * Best-effort: a missing sitemap simply leaves plain link discovery.
   */
  async _seedFromSitemap() {
    const { logger, report } = this;
    let entries;
    let sources;
    try {
      ({ entries, sources } = await loadSitemapEntries(this.startUrl, this.config, logger));
    } catch (error) {
      logger.warn(`Sitemap loading failed (${error.message}) - continuing without it`);
      report.recordError(`sitemap loading failed: ${error.message}`);
      return;
    }

    if (sources.length === 0) {
      logger.info('No sitemap found - crawling via link discovery only');
      report.sitemapInfo = { found: false, sources: [], urlCount: 0, seeded: 0 };
      return;
    }

    this._saveSitemapCopies(sources);

    let seeded = 0;
    for (const entry of sortByPriority(entries)) {
      const normalized = normalizeUrl(entry.loc, this.startUrl);
      if (!normalized || this.queue.hasVisited(normalized)) continue;
      const scope = checkScope(normalized, this.scope);
      if (!scope.allowed) {
        report.recordSkipped(normalized, `sitemap-out-of-scope:${scope.reason}`);
        continue;
      }
      if (this.queue.add(normalized, 0)) seeded++;
    }

    report.sitemapInfo = {
      found: true,
      sources: sources.map((s) => s.url),
      urlCount: entries.length,
      seeded,
    };
    logger.info(
      `Sitemap: seeded ${seeded} URL(s) by priority from ${sources.length} sitemap file(s) ` +
        `(${entries.length} listed)`
    );
  }

  /** Keep the fetched sitemap documents under report/sitemaps/. */
  _saveSitemapCopies(sources) {
    const dir = path.join(this.reportDirectory, 'sitemaps');
    try {
      fs.mkdirSync(dir, { recursive: true });
      sources.forEach(({ url, xml }, index) => {
        const base = path.basename(new URL(url).pathname) || 'sitemap.xml';
        const name = `${String(index + 1).padStart(2, '0')}-${base.replace(/\.gz$/i, '')}`;
        fs.writeFileSync(path.join(dir, name), xml);
      });
      this.logger.debug(`Saved ${sources.length} sitemap copy(ies) to ${dir}`);
    } catch (error) {
      this.report.recordError(`could not save sitemap copies: ${error.message}`);
      this.logger.warn(`Could not save sitemap copies: ${error.message}`);
    }
  }

  _maybePersistState(processedInWave) {
    this._sinceLastSave += processedInWave;
    if (this._sinceLastSave < STATE_SAVE_INTERVAL) return;
    this._sinceLastSave = 0;
    this._persistState();
  }

  _persistState() {
    // A dry run archives nothing, so saving would advance a real crawl's
    // resume point past pages it never took. Every write goes through here.
    if (this.config.dryRun) return;
    try {
      this.state.save({
        startUrl: this.startUrl,
        queue: this.queue,
        stats: this.report.statsSnapshot(),
        processedCount: this.processedCount,
      });
    } catch (error) {
      this.report.recordError(`state save failed: ${error.message}`);
      this.logger.warn(`Could not save crawl state: ${error.message}`);
    }
  }

  _finalize(startedAt) {
    const { logger, report } = this;

    // The crawl is unfinished when it was aborted or cut off by --max-pages
    // with URLs still pending. Persist state first (so a resume re-processes
    // the pending URLs), then record them as skipped in this run's report.
    const unfinished = this.aborted || this.queue.pendingCount > 0;
    if (unfinished) {
      this._persistState();
      if (this.config.dryRun) {
        logger.info('Dry run - any saved crawl state was left untouched.');
      } else if (this.aborted) {
        logger.info('State saved - rerun with --resume to continue this crawl.');
      } else {
        logger.info(
          `Reached --max-pages with ${this.queue.pendingCount} URL(s) pending - ` +
            'rerun with --resume and a higher --max-pages to continue.'
        );
      }
    } else if (!this.config.dryRun) {
      // Clearing here on a dry run would delete a real crawl's resume point,
      // which is worse than a stale save: the pending queue is unrecoverable.
      this.state.clear();
    }

    const cutoff = this.aborted ? 'interrupted' : 'max-pages-reached';
    for (const item of this.queue.pending) report.recordSkipped(item.url, cutoff);

    const builtReport = report.build(this.queue.discoveredCount);
    let reportFile = null;
    let archiveSitemapFile = null;
    try {
      reportFile = report.write(builtReport, this.siteDirectory);
    } catch (error) {
      logger.error(`Could not write report file: ${error.message}`);
    }
    try {
      archiveSitemapFile = report.writeArchiveSitemap(builtReport, this.siteDirectory);
    } catch (error) {
      logger.error(`Could not write archive sitemap: ${error.message}`);
    }
    process.stdout.write(report.summary(builtReport, reportFile, archiveSitemapFile));
    logger.debug(`Total wall time: ${formatDuration(Date.now() - startedAt)}`);

    return builtReport;
  }
}

module.exports = { Crawler, mapWithConcurrency };
