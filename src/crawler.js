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
const { AssetDownloader } = require('./assets');
const { AssetInventory } = require('./inventory');
const { rewriteFile } = require('./rewrite');
const { fetchPage } = require('./fetcher');
const { extractPageData } = require('./extractor');
const { loadSitemapEntries, sortByPriority } = require('./sitemap');
const {
  normalizeUrl,
  checkScope,
  isSameDomain,
  groupForContentType,
} = require('./utils/url');
const { siteDir, reportDir, rawHtmlDir, assetsDir, FlatNames } = require('./utils/paths');
const { formatDuration, mapWithConcurrency } = require('./utils/misc');

const STATE_SAVE_INTERVAL = 10; // pages between periodic state saves

/**
 * Crawl orchestrator, organised in waves rather than per-page workers:
 *
 *   discover a wave of pages over plain HTTP  ->  download the files those
 *   pages link to  ->  archive the whole wave in one SingleFile batch through
 *   the shared browser, rewriting its links at the downloaded copies  ->  repeat
 *
 * The discovery fetch is what yields HTTP status, robots decisions, canonical
 * URLs and links; SingleFile's browser load is what produces the standalone
 * file. Batching the second half is what makes the shared browser and its
 * parallel tabs pay off.
 *
 * Assets sit between the two halves for a reason: a page's links can only be
 * repointed at local files that already exist, so everything a wave links to
 * is fetched before that wave is captured.
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
    this.assetsDirectory = assetsDir(this.siteDirectory);

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
    // Counts what the site holds, which is a different question from what the
    // run is configured to take - and the only record of the types a crawl
    // walked past. Runs even with downloads off, so `--assets none` is a
    // survey: crawl, report every type present, fetch nothing.
    this.inventory = new AssetInventory(this.startUrl);
    this.assets = new AssetDownloader({
      config: { ...config, startUrl: this.startUrl },
      logger: this.logger,
      report: this.report,
      rateLimiter: this.rateLimiter,
      robots: this.robots,
      directory: this.assetsDirectory,
      reportDirectory: this.reportDirectory,
      inventory: this.inventory,
    });

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

    const verb = config.survey ? 'Surveying' : 'Archiving';
    const mode = config.survey ? '' : config.dryRun ? ', DRY RUN' : '';
    logger.info(
      `${verb} ${this.startUrl} -> ${this.siteDirectory} ` +
        `(depth<=${config.maxDepth}, pages<=${config.maxPages}, ` +
        `discovery=${config.concurrency}${config.survey ? '' : `, tabs=${config.workers}`}, ` +
        `batch=${config.batchSize}, delay=${config.delayMs}ms${mode})`
    );
    if (config.survey) {
      logger.info(
        'Survey: reading each page for its links only - nothing is archived or ' +
          'downloaded. Writing report/assets-inventory.json.'
      );
    }
    logger.info(
      this.assets.enabled
        ? `Linked files: ${config.assetGroups.join(', ')} ` +
            `(${config.assetExtensions.size} extensions, hosts=${config.assetMode}, ` +
            `max=${config.maxAssets}, links ${config.rewriteLinks ? 'rewritten' : 'left live'})`
        : 'Linked files: disabled'
    );

    try {
      while (!this.aborted) {
        const wave = this._takeWave();
        if (wave.length === 0) break;

        const jobs = await this._discoverWave(wave);
        // Before the capture, so the pages being saved can be pointed at the
        // files they link to rather than at the live web.
        await this._downloadAssets();
        if (jobs.length > 0) await this._archiveJobs(jobs);

        this._maybePersistState(jobs.length);
      }
      // Anything a final wave turned up but never got to fetch. Skipped on an
      // abort: "finish the current wave, then stop" should not be followed by
      // a fresh batch of downloads. They stay queued and are reported as
      // pending, so --resume picks them up.
      if (!this.aborted) await this._downloadAssets();
    } finally {
      await this.archiver.close();
    }

    await this._catchUpRewrites();
    return this._finalize(startedAt);
  }

  /** Drain the asset queue. Never throws - a bad file cannot end a crawl. */
  async _downloadAssets() {
    if (!this.assets.enabled || this.assets.pendingCount === 0) return;
    if (this.config.dryRun) {
      // A dry run reports what it would take without touching the network any
      // more than discovery already has.
      const count = this.assets.previewPending();
      this.logger.info(`${count} linked file(s) found (dry run)`);
      return;
    }
    try {
      await this.assets.drain();
    } catch (error) {
      this.report.recordError(`asset download failed: ${error.message}`);
      this.logger.warn(`Asset download failed: ${error.message}`);
    }
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
  async _discoverPage({ url, depth, referrer = null }) {
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
      // A URL with no usable extension can still be a file: /download?id=42
      // serving a PDF only reveals itself in the response headers. This is the
      // one place those are visible, so the asset pipeline gets a look before
      // the URL is written off.
      // A URL with no extension only reveals its type here, so the inventory
      // is told the extension the headers implied rather than one parsed from
      // the path - otherwise /download?id=42 would never be counted at all.
      const byType = groupForContentType(result.contentType);
      if (byType) this.inventory.record(effectiveUrl, referrer, { extension: byType.extension });
      if (this.assets.enqueueByContentType(effectiveUrl, result.contentType, referrer)) {
        logger.debug(`linked file found by content type (${result.contentType}): ${url}`);
        return null;
      }
      if (byType) this.inventory.markSkipped(effectiveUrl);
      report.recordSkipped(url, `non-html:${result.contentType || 'unknown'}`);
      logger.debug(`skip (non-HTML ${result.contentType}): ${url}`);
      return null;
    }

    const { links, embeds, canonical, title } = extractPageData(result.html, effectiveUrl);

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

    this._enqueueLinks(links, depth, effectiveUrl);
    // Embedded files (an <iframe> or <object> holding a PDF viewer) are never
    // pages, so they only ever go to the asset pipeline.
    for (const embed of embeds) {
      const counted = this.inventory.record(embed, effectiveUrl);
      if (!this.assets.enqueue(embed, effectiveUrl) && counted) {
        this.inventory.markSkipped(embed);
      }
    }

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

  /**
   * Sort a page's outgoing links into pages to crawl and files to download.
   *
   * Assets are offered first and are not subject to `--depth`: a PDF is the
   * end of a path, not a step along one, so a file linked from the deepest
   * page the crawl reaches is still worth having. Only link *following* stops
   * at the depth limit.
   */
  _enqueueLinks(links, depth, sourceUrl) {
    for (const link of links) {
      // Counted first, and unconditionally. Every branch below can drop the
      // URL - wrong type, out of scope, past the depth limit - and each one
      // would otherwise erase the fact that this file type exists on the site.
      const counted = this.inventory.record(link, sourceUrl);
      if (this.assets.enqueue(link, sourceUrl)) continue;
      // Reached only when the downloader declined it, so it is a type the run
      // is not collecting.
      if (counted) this.inventory.markSkipped(link);

      if (depth >= this.config.maxDepth) continue;
      if (this.queue.hasVisited(link) || this.queue.known.has(link)) continue;
      const scope = checkScope(link, this.scope);
      if (!scope.allowed) {
        this.report.recordSkipped(link, `out-of-scope:${scope.reason}`);
        continue;
      }
      this.queue.add(link, depth + 1, sourceUrl);
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

    const linkMap = config.rewriteLinks ? this.assets.linkMap() : new Map();

    for (const [index, result] of results.entries()) {
      const job = jobs[index];
      if (!result.ok) {
        // A failed page gives its budget slot back so --max-pages counts
        // pages actually archived.
        this.processedCount--;
        report.recordFailed({ url: job.url, error: result.error, stage: 'capture' });
        logger.warn(`archive failed: ${job.url} -> ${result.error}`);
        continue;
      }

      const assetOrder = this.assets.order;
      const rewritten = await this._rewriteJobLinks(job, linkMap);

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
        rewrittenLinks: rewritten,
        // What the asset pipeline had taken when this page was rewritten, so
        // the final pass knows what it has not yet seen. See _catchUpRewrites.
        assetOrder,
      });
      logger.info(
        `[${report.pages.length}/${config.maxPages}] depth=${job.depth} ${job.status} ` +
          `${job.url} -> ${job.fileName} (${(bytes / 1024).toFixed(0)} KB` +
          `${rewritten ? `, ${rewritten} link${rewritten === 1 ? '' : 's'} localised` : ''})`
      );
    }

    logger.debug(
      `Wave of ${jobs.length} archived in ${formatDuration(batchMs)} (~${perPageMs}ms/page)`
    );
  }

  /**
   * Second rewrite pass, over pages archived before some of the files they
   * link to had been downloaded.
   *
   * That gap has one cause: a URL with no extension gives nothing away until
   * its response headers arrive, so `/download?id=42` enters the crawl as a
   * page and is only recognised as a PDF a wave later - by which time the page
   * that linked it has already been captured and rewritten. Without this pass
   * that link alone would still point at the live site.
   *
   * Each page is re-scanned only against the files taken *after* it was
   * written, so on the ordinary crawl - where every file is recognised from
   * its extension and fetched before the linking page is captured - this pass
   * opens no files at all.
   */
  async _catchUpRewrites() {
    if (!this.config.rewriteLinks || this.config.dryRun) return 0;

    const finalOrder = this.assets.order;
    const stale = this.report.pages.filter(
      (page) => page.file && Number.isFinite(page.assetOrder) && page.assetOrder < finalOrder
    );
    if (stale.length === 0) return 0;

    let total = 0;
    for (const page of stale) {
      const linkMap = this.assets.linkMap(page.assetOrder);
      if (linkMap.size === 0) continue;
      const filePath = path.join(this.siteDirectory, page.file);
      try {
        const added = await rewriteFile(filePath, {
          pageUrl: page.url,
          assetsByUrl: linkMap,
          keepOriginal: this.config.keepOriginalHref,
        });
        page.rewrittenLinks = (page.rewrittenLinks || 0) + added;
        page.assetOrder = finalOrder;
        total += added;
      } catch (error) {
        this.report.recordError(`late link rewrite failed for ${page.url}: ${error.message}`);
        this.logger.warn(`Could not finish rewriting ${page.file}: ${error.message}`);
      }
    }
    if (total > 0) {
      this.logger.info(
        `Localised ${total} more link(s) in ${stale.length} page(s) after later downloads`
      );
    }
    return total;
  }

  /**
   * Repoint one captured page's links at the files in assets/.
   *
   * The page is already safely on disk by this point, so a rewrite failure
   * costs a convenience, not the archive - it is reported and the page still
   * counts as archived.
   */
  async _rewriteJobLinks(job, linkMap) {
    if (linkMap.size === 0) return 0;
    try {
      return await rewriteFile(job.filePath, {
        pageUrl: job.url,
        assetsByUrl: linkMap,
        keepOriginal: this.config.keepOriginalHref,
      });
    } catch (error) {
      this.report.recordError(`link rewrite failed for ${job.url}: ${error.message}`);
      this.logger.warn(`Could not rewrite links in ${job.fileName}: ${error.message}`);
      return 0;
    }
  }

  async _initializeFrontier() {
    const previous = this.config.resume ? this.state.load(this.startUrl) : null;
    if (previous) {
      this.queue = CrawlQueue.fromJSON(previous.queue);
      this.report.restore(previous.stats);
      this.processedCount = previous.processedCount || 0;
      this.names.restore(this.report.pages);
      // Without this a resume re-downloads every file the first run already
      // took, and hands out fresh names for them on top.
      this.assets.restore(previous.assets);
      // Without this the tally would restart at zero and report a fraction of
      // what the site holds.
      this.inventory.restore(previous.inventory);
      this.logger.info(
        `Resuming crawl saved at ${previous.savedAt}: ` +
          `${this.queue.pendingCount} pending, ${this.queue.visited.size} visited, ` +
          `${this.report.pages.length} already archived, ` +
          `${this.assets.downloadedCount} file(s) already downloaded ` +
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
        assets: this.assets.toJSON(),
        inventory: this.inventory.toState(),
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
    // Files discovered but never fetched - the run's budget or its interrupt
    // caught them. Naming them is what makes a rerun worthwhile.
    for (const item of this.assets.queued.values()) {
      report.recordAssetSkipped(item.url, `asset-${cutoff}`);
    }

    // Attached before build(), which snapshots it into the report.
    report.assetInventory = this.inventory.toJSON();

    const builtReport = report.build(this.queue.discoveredCount);

    // Each output is written independently: one that fails must not take the
    // others with it, since every one of them is a different reader's way in.
    const written = {};
    // A survey exists to answer one question, so it writes one file. The rest
    // describe an archive, and a survey does not produce one.
    const outputs = this.config.survey
      ? [
          [
            'assetInventoryFile',
            'asset inventory',
            () => report.writeAssetInventory(builtReport, this.siteDirectory),
          ],
        ]
      : [
          ['reportFile', 'report file', () => report.write(builtReport, this.siteDirectory)],
          [
            'assetInventoryFile',
            'asset inventory',
            () => report.writeAssetInventory(builtReport, this.siteDirectory),
          ],
          [
            'archiveSitemapFile',
            'archive sitemap',
            () => report.writeArchiveSitemap(builtReport, this.siteDirectory),
          ],
          [
            'archiveIndexFile',
            'archive index',
            () => report.writeArchiveIndex(builtReport, this.siteDirectory),
          ],
          [
            'assetListFile',
            'file URL list',
            () => report.writeAssetList(builtReport, this.siteDirectory),
          ],
          // The manifest comes from the downloader rather than the report, and
          // a dry run has nothing on disk for it to describe.
          [
            'manifestFile',
            'asset manifest',
            () => (this.config.dryRun ? null : this.assets.save()),
          ],
        ];
    for (const [key, label, write] of outputs) {
      try {
        written[key] = write();
      } catch (error) {
        written[key] = null;
        logger.error(`Could not write the ${label}: ${error.message}`);
      }
    }

    process.stdout.write(report.summary(builtReport, written));
    logger.debug(`Total wall time: ${formatDuration(Date.now() - startedAt)}`);

    return builtReport;
  }
}

module.exports = { Crawler, mapWithConcurrency };

