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
const {
  siteDir,
  reportDir,
  siteDataDir,
  assetsDir,
  nestedFileName,
  markdownSibling,
  SITE_DATA_DIRNAME,
  FlatNames,
} = require('./utils/paths');
const { htmlToMarkdown } = require('./markdown');
const { NativeMarkdown } = require('./native-md');
const { cleanEdsMarkdown } = require('./eds-markdown');
const { formatDuration, mapWithConcurrency } = require('./utils/misc');

const STATE_SAVE_INTERVAL = 10; // pages between periodic state saves

/** A report record's `file` (site-relative) as a site-data-relative path. */
function siteDataRelative(file) {
  return String(file || '').replace(new RegExp(`^${SITE_DATA_DIRNAME}/`), '');
}

/**
 * The name a page was given on the run being resumed.
 *
 * Under --format md a record has no `file` at all, so the Markdown path is
 * what carries the name; both formats share one, so swapping the extension
 * recovers it. Without this a resumed Markdown-only crawl would hand out
 * fresh names and rewrite files it already had.
 */
function restoredPageName({ file, markdownFile }) {
  const stored = file || markdownFile;
  if (!stored) return null;
  return siteDataRelative(stored).replace(/\.md$/i, '.html');
}

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
    this.siteDataDirectory = siteDataDir(this.siteDirectory);
    this.assetsDirectory = assetsDir(this.siteDirectory);

    this.queue = new CrawlQueue();
    this.report = new CrawlReport(config);
    this.state = new CrawlState(this.reportDirectory);
    this.rateLimiter = new RateLimiter(config.delayMs);
    // Page names are nested paths now, not bare filenames, so the collision
    // handling works over `blog/post-1.html` rather than `blog-post-1.html`.
    this.names = new FlatNames((url) => nestedFileName(url, '.html'));
    // The site's own Markdown, asked for once per host. Shares the rate
    // limiter: a .md request is a request to the same server as everything
    // else, and the politeness budget is per site, not per pipeline.
    this.nativeMd = config.wantsMarkdown
      ? new NativeMarkdown(config, this.logger, { rateLimiter: this.rateLimiter })
      : null;
    // Stamped into the front matter of every document taken from the site, so
    // a corpus says when it was collected without anyone consulting the report.
    this.fetchedOn = new Date().toISOString().slice(0, 10);
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
    if (!config.dryRun) fs.mkdirSync(this.siteDataDirectory, { recursive: true });

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
          'downloaded. Writing report/assets-inventory.survey.json.'
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

    // One name per page, shared by both formats: blog/post-1.html and
    // blog/post-1.md differ in nothing but the extension, so a reader who has
    // one can find the other without consulting the report.
    const fileName = this.names.assign(effectiveUrl);
    const filePath = path.join(this.siteDataDirectory, fileName);
    const markdownName = config.wantsMarkdown ? markdownSibling(fileName) : null;
    const markdownPath = markdownName ? path.join(this.siteDataDirectory, markdownName) : null;

    // What this run still owes the page. A crawl that captured HTML last week
    // and is asked for --format both today has the Markdown left to write, so
    // "the file exists" is only a reason to skip when every requested format
    // exists.
    const needsHtml = config.wantsHtml && (config.overwrite || !fs.existsSync(filePath));
    const needsMarkdown =
      config.wantsMarkdown && (config.overwrite || !fs.existsSync(markdownPath));

    if (!needsHtml && !needsMarkdown) {
      report.recordSkipped(url, 'file-exists');
      logger.info(`depth=${depth} exists, skipped: ${fileName}`);
      return null;
    }

    // The slot is reserved here so a wave can never overshoot --max-pages.
    this.processedCount++;
    return {
      url: effectiveUrl,
      filePath,
      fileName,
      markdownPath,
      markdownName,
      needsHtml,
      needsMarkdown,
      // Set once the site has been asked for its own Markdown and had none:
      // only then does the page need its DOM converting.
      needsConversion: false,
      markdown: null,
      markdownSource: null,
      status: result.status,
      depth,
      title,
    };
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

  /**
   * What the browser is asked to do for one page.
   *
   * A page that needed only Markdown, and got it from the site, is not here at
   * all - `_captureJobs` has already dropped it.
   */
  static _captureMode(job) {
    if (!job.needsHtml) return 'dom';
    return job.needsConversion ? 'both' : 'html';
  }

  /** The pages of a wave that still have to go through the browser. */
  static _captureJobs(jobs) {
    return jobs.filter((job) => job.needsHtml || job.needsConversion);
  }

  /**
   * Archive half of a wave.
   *
   * Two sources feed it, and which ones a page uses is decided per page:
   *
   *   the site's own <page>.md   one HTTP request, no browser at all
   *   the capture engine         the standalone HTML, the rendered DOM, or both
   *
   * The Markdown request goes first for exactly that reason: on an Edge
   * Delivery site under --format md it answers for every page, and the browser
   * is never launched.
   */
  async _archiveJobs(jobs) {
    const { config, logger, report } = this;

    await this._collectNativeMarkdown(jobs);

    const captureJobs = Crawler._captureJobs(jobs);
    // SingleFile loads every page again in the browser, so the batch costs the
    // site one more visit per page and goes through the same politeness budget.
    for (let i = 0; i < captureJobs.length; i++) await this.rateLimiter.acquire();

    const startedAt = Date.now();
    const results = await this.archiver.archiveBatch(
      captureJobs.map((job) => ({
        url: job.url,
        filePath: job.filePath,
        mode: Crawler._captureMode(job),
      }))
    );
    const batchMs = Date.now() - startedAt;
    const perPageMs = captureJobs.length ? Math.round(batchMs / captureJobs.length) : 0;

    // Keyed rather than zipped: `jobs` and `results` no longer line up, since
    // the pages served by the site's own Markdown never entered the batch.
    const byUrl = new Map(results.map((result) => [result.url, result]));
    const linkMap = config.rewriteLinks ? this.assets.linkMap() : new Map();

    for (const job of jobs) {
      const result = byUrl.get(job.url);
      if (result && !result.ok) {
        // A failed page gives its budget slot back so --max-pages counts
        // pages actually archived.
        this.processedCount--;
        report.recordFailed({ url: job.url, error: result.error, stage: 'capture' });
        logger.warn(`archive failed: ${job.url} -> ${result.error}`);
        continue;
      }

      const assetOrder = this.assets.order;
      const wroteHtml = job.needsHtml && Boolean(result);
      const rewritten = wroteHtml ? await this._rewriteJobLinks(job, linkMap) : 0;
      const markdownFile = await this._writeMarkdown(job, result ? result.renderedDom : null);

      let bytes = 0;
      if (wroteHtml) {
        try {
          bytes = fs.statSync(job.filePath).size;
        } catch {
          /* size is informational only */
        }
      }
      report.recordDownloaded({
        url: job.url,
        // null under --format md: there is no HTML file, and claiming one
        // would send every later pass - link rewriting included - looking for
        // a file that was never written.
        file: wroteHtml ? path.relative(this.siteDirectory, job.filePath).replace(/\\/g, '/') : null,
        markdownFile,
        markdownSource: markdownFile ? job.markdownSource : null,
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
          `${job.url} -> ${this._describeOutputs(job, { wroteHtml, markdownFile, bytes })}` +
          `${rewritten ? `, ${rewritten} link${rewritten === 1 ? '' : 's'} localised` : ''}`
      );
    }

    if (captureJobs.length) {
      logger.debug(
        `Wave of ${captureJobs.length} captured in ${formatDuration(batchMs)} ` +
          `(~${perPageMs}ms/page)`
      );
    }
  }

  /** The "-> file (12 KB), file.md" tail of a per-page log line. */
  _describeOutputs(job, { wroteHtml, markdownFile, bytes }) {
    const parts = [];
    if (wroteHtml) parts.push(`${job.fileName} (${(bytes / 1024).toFixed(0)} KB)`);
    if (markdownFile) parts.push(`${job.markdownName} [${job.markdownSource}]`);
    return parts.join(' + ') || '(nothing written)';
  }

  /**
   * Ask the site for its own Markdown, for every page of the wave that wants
   * Markdown at all.
   *
   * A page that gets it needs no conversion; a page that does not is marked
   * for conversion, which is what puts it in front of the browser. On a site
   * that publishes none, the probe inside NativeMarkdown settles after the
   * first request and every later page falls straight through to conversion.
   */
  async _collectNativeMarkdown(jobs) {
    const wanted = jobs.filter((job) => job.needsMarkdown);
    if (wanted.length === 0) return;

    if (!this.nativeMd || this.nativeMd.available === false) {
      for (const job of wanted) job.needsConversion = true;
      return;
    }

    await mapWithConcurrency(wanted, this.config.concurrency, async (job) => {
      let published = null;
      try {
        published = await this.nativeMd.fetch(job.url);
      } catch (error) {
        // Never fatal: conversion is a complete answer to this failing.
        this.logger.debug(`markdown lookup failed for ${job.url}: ${error.message}`);
      }
      if (!published) {
        job.needsConversion = true;
        return;
      }

      // What the site publishes is an authoring document, not a finished one:
      // the prose is the author's own, but it arrives wrapped in the block
      // syntax the authoring tools use. See src/eds-markdown.js.
      const cleaned = cleanEdsMarkdown(published, {
        pageUrl: job.url,
        fetchedAt: this.fetchedOn,
      });

      if (cleaned.thin) {
        // A listing page: its blocks are filled in at render time, so the
        // authored document holds none of the items the page shows. Here the
        // rendered page is the better document, and it is the only case where
        // conversion beats the site's own Markdown.
        job.needsConversion = true;
        this.logger.debug(
          `published markdown for ${job.url} is ${cleaned.stats.proseLength} chars of prose ` +
            `across ${cleaned.stats.emptyBlocks} empty block(s) - converting the rendered page`
        );
        return;
      }

      job.markdown = cleaned.markdown;
      job.markdownSource = 'site';
    });
  }

  /**
   * Write one page's Markdown, from whichever source produced it.
   *
   * Returns its path relative to the site directory, or null when the page
   * wanted no Markdown or none could be made. A page that converts to nothing
   * is reported and left without a .md rather than given an empty file: an
   * empty document in a corpus is worse than a missing one, because it looks
   * like it worked.
   */
  async _writeMarkdown(job, renderedDom) {
    if (!job.needsMarkdown) return null;

    let markdown = job.markdown;
    if (!markdown && renderedDom) {
      try {
        markdown = htmlToMarkdown(renderedDom, { pageUrl: job.url, title: job.title });
        job.markdownSource = 'converted';
      } catch (error) {
        this.report.recordError(`markdown conversion failed for ${job.url}: ${error.message}`);
        this.logger.warn(`Could not convert ${job.url} to Markdown: ${error.message}`);
        markdown = null;
      }
    }

    if (!markdown) {
      this.report.recordError(`no markdown produced for ${job.url}`);
      this.logger.warn(`No Markdown for ${job.url}`);
      return null;
    }

    try {
      await fs.promises.mkdir(path.dirname(job.markdownPath), { recursive: true });
      // One trailing newline: these are text files people and tools read line
      // by line, and a missing final newline is a papercut in both.
      await fs.promises.writeFile(job.markdownPath, `${markdown}\n`, 'utf8');
    } catch (error) {
      this.report.recordError(`could not write markdown for ${job.url}: ${error.message}`);
      this.logger.warn(`Could not write ${job.markdownName}: ${error.message}`);
      return null;
    }

    return path.relative(this.siteDirectory, job.markdownPath).replace(/\\/g, '/');
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
          pageFile: siteDataRelative(page.file),
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
        pageFile: job.fileName,
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
      this.names.restore(this.report.pages, restoredPageName);
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

