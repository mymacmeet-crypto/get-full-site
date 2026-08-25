'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { formatDuration, formatBytes } = require('./utils/misc');
const { reportDir } = require('./utils/paths');

// Full skipped-URL details are capped so a crawl of a heavily linked site
// cannot balloon the report; counts per reason always cover everything.
const MAX_SKIPPED_DETAIL = 5000;

// How many URLs the console summary names before deferring to the files in
// report/, which always carry the complete lists. Bounds terminal noise only.
const MAX_SUMMARY_URLS = 10;

// Asset types named in the console inventory before it defers to the report.
const MAX_SUMMARY_TYPES = 8;

/**
 * Why a finished run archived fewer pages than --max-pages asked for.
 *
 * Every one of these is normal behaviour, but without an explanation a short
 * count reads as a miscount, so the run says which it was. Returns null when
 * the budget was met, when the run was cut short, or on a dry run (where
 * "archived" means "would have been").
 */
function shortfallReason(report) {
  const { downloaded, failed } = report.totals;
  const budget = report.options.maxPages;
  if (report.interrupted || report.options.dryRun) return null;
  if (downloaded >= budget) return null;

  const reasons = [];
  const skipped = report.skippedByReason || {};

  // Pages that were reached but deliberately not archived.
  const existing = skipped['file-exists'] || 0;
  if (existing) {
    reasons.push(`${existing} already archived (use --overwrite to redo them)`);
  }
  if (failed) reasons.push(`${failed} failed`);

  const duplicates =
    (skipped['duplicate-canonical'] || 0) + (skipped['already-visited-alias'] || 0);
  if (duplicates) reasons.push(`${duplicates} duplicate of a page already taken`);

  const outOfScope = Object.entries(skipped)
    .filter(([reason]) => reason.startsWith('out-of-scope') || reason.startsWith('redirect-'))
    .reduce((sum, [, count]) => sum + count, 0);
  if (outOfScope) reasons.push(`${outOfScope} out of scope`);

  if (skipped['robots-disallowed']) {
    reasons.push(`${skipped['robots-disallowed']} disallowed by robots.txt`);
  }

  // Nothing pending means the crawl simply ran out of pages to take, which is
  // the usual answer: the site had fewer reachable pages than the budget.
  const pending = skipped['max-pages-reached'] || 0;
  if (pending === 0) {
    reasons.push('no linked pages left to crawl (try a higher --depth)');
  }

  return reasons.length > 0 ? reasons.join(', ') : null;
}

/**
 * Collects per-page outcomes during the crawl and renders them as JSON plus a
 * human-readable console summary. Everything it writes lands in report/.
 */
class CrawlReport {
  constructor(config) {
    this.config = config;
    this.startedAt = new Date();
    this.pages = []; // { url, file, status, depth, title, durationMs }
    this.skipped = []; // { url, reason } - capped detail list
    this.skippedCounts = {}; // reason -> count - always complete
    this.skippedOverflow = 0;
    this.failed = []; // { url, error, attempts, stage }
    this.errors = []; // crawl-level errors (state save failures, ...)
    this.interrupted = false;
    this.sitemapInfo = null; // { found, sources, urlCount, seeded } when seeding ran
    this._seenSkips = new Set();

    // Linked files are counted apart from pages throughout: they do not
    // consume a --max-pages slot, and folding them into the page totals would
    // make "20 of 20 pages archived" read as wrong on any site with PDFs.
    this.assets = []; // { url, file, bytes, contentType, sha256, group, sources }
    this.assetsFailed = []; // { url, error, sources }
    this.assetsSkippedCounts = {}; // reason -> count
    this._seenAssetSkips = new Set();
    // Set by the crawler: what file types the site turned out to hold, as
    // opposed to which ones this run was configured to take.
    this.assetInventory = null;
  }

  recordDownloaded(page) {
    this.pages.push(page);
  }

  recordSkipped(url, reason) {
    if (this._seenSkips.has(url)) return;
    this._seenSkips.add(url);
    this.skippedCounts[reason] = (this.skippedCounts[reason] || 0) + 1;
    if (this.skipped.length < MAX_SKIPPED_DETAIL) this.skipped.push({ url, reason });
    else this.skippedOverflow++;
  }

  recordFailed(entry) {
    this.failed.push(entry);
  }

  recordError(message) {
    this.errors.push(message);
  }

  recordAsset(entry) {
    this.assets.push(entry);
  }

  recordAssetFailed(entry) {
    this.assetsFailed.push(entry);
  }

  recordAssetSkipped(url, reason) {
    if (this._seenAssetSkips.has(url)) return;
    this._seenAssetSkips.add(url);
    this.assetsSkippedCounts[reason] = (this.assetsSkippedCounts[reason] || 0) + 1;
  }

  /** Restore counters from a resumed crawl's saved state. */
  restore(stats) {
    if (!stats) return;
    this.pages = stats.pages || [];
    this.skipped = stats.skipped || [];
    this.skippedCounts = stats.skippedCounts || {};
    this.skippedOverflow = stats.skippedOverflow || 0;
    this.failed = stats.failed || [];
    this.errors = stats.errors || [];
    this.sitemapInfo = stats.sitemapInfo || null;
    this.assets = stats.assets || [];
    this.assetsFailed = stats.assetsFailed || [];
    this.assetsSkippedCounts = stats.assetsSkippedCounts || {};
    this._seenSkips = new Set(this.skipped.map((s) => s.url));
  }

  /** Serializable snapshot stored inside the resume state file. */
  statsSnapshot() {
    return {
      pages: this.pages,
      skipped: this.skipped,
      skippedCounts: this.skippedCounts,
      skippedOverflow: this.skippedOverflow,
      failed: this.failed,
      errors: this.errors,
      sitemapInfo: this.sitemapInfo,
      assets: this.assets,
      assetsFailed: this.assetsFailed,
      assetsSkippedCounts: this.assetsSkippedCounts,
    };
  }

  build(discoveredCount) {
    const finishedAt = new Date();
    const skippedTotal = Object.values(this.skippedCounts).reduce((a, b) => a + b, 0);
    const archived = this.pages.filter((page) => page.file);
    const totalBytes = archived.reduce((sum, page) => sum + (page.bytes || 0), 0);
    // A file linked under two URLs is stored once, so its bytes are counted
    // once - otherwise the total claims disk use the archive does not have.
    const assetBytes = this.assets.reduce(
      (sum, asset) => sum + (asset.duplicateOf ? 0 : asset.bytes || 0),
      0
    );
    const assetDuplicates = this.assets.filter((asset) => asset.duplicateOf).length;
    const assetsSkippedTotal = Object.values(this.assetsSkippedCounts).reduce((a, b) => a + b, 0);
    const rewrittenLinks = this.pages.reduce((sum, page) => sum + (page.rewrittenLinks || 0), 0);

    return {
      startUrl: this.config.startUrl,
      outputFolder: this.config.outputFolder,
      interrupted: this.interrupted,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - this.startedAt,
      options: {
        maxDepth: this.config.maxDepth,
        maxPages: this.config.maxPages,
        sameDomainOnly: this.config.sameDomainOnly,
        include: this.config.includePatterns.map((p) => p.source),
        exclude: this.config.excludePatterns.map((p) => p.source),
        delayMs: this.config.delayMs,
        concurrency: this.config.concurrency,
        workers: this.config.workers,
        batchSize: this.config.batchSize,
        timeoutMs: this.config.timeoutMs,
        deferredImagesMaxIdleMs: this.config.deferredImagesMaxIdleMs,
        waitAfterLoadMs: this.config.waitAfterLoadMs,
        followRedirects: this.config.followRedirects,
        respectRobots: this.config.respectRobots,
        overwrite: this.config.overwrite,
        dryRun: this.config.dryRun,
        survey: Boolean(this.config.survey),
        sitemapEnabled: this.config.sitemapEnabled,
        sitemapUrl: this.config.sitemapUrl,
        assetMode: this.config.assetMode,
        assetGroups: this.config.assetGroups,
        assetExtensions: [...(this.config.assetExtensions || [])].sort(),
        maxAssets: this.config.maxAssets,
        maxAssetBytes: this.config.maxAssetBytes,
        rewriteLinks: this.config.rewriteLinks,
        revealAnimations: this.config.revealAnimations,
        removeHiddenElements: this.config.removeHiddenElements,
      },
      sitemap: this.sitemapInfo || { found: false, sources: [], urlCount: 0, seeded: 0 },
      totals: {
        discovered: discoveredCount,
        downloaded: this.pages.length,
        skipped: skippedTotal,
        failed: this.failed.length,
        archivedBytes: totalBytes,
        assets: this.assets.length,
        assetFiles: this.assets.length - assetDuplicates,
        assetDuplicates,
        assetBytes,
        assetsFailed: this.assetsFailed.length,
        assetsSkipped: assetsSkippedTotal,
        rewrittenLinks,
      },
      skippedByReason: this.skippedCounts,
      // Kept up here beside `totals`, deliberately. The per-URL arrays below
      // run to thousands of lines on a real crawl, and anything after them is
      // effectively invisible to someone opening the file.
      assetInventory: this.assetInventory,
      downloadedPages: this.pages,
      skippedUrls: this.skipped,
      skippedUrlsTruncated: this.skippedOverflow,
      failedUrls: this.failed,
      downloadedAssets: this.assets,
      failedAssets: this.assetsFailed,
      assetsSkippedByReason: this.assetsSkippedCounts,
      errors: this.errors,
    };
  }

  /**
   * Path in report/ for one of this run's files.
   *
   * A dry run and a survey archive nothing, so their output must never land on
   * the filenames a real crawl wrote. The pages and files that crawl saved are
   * still on disk, and a report claiming `dryRun: true` sitting next to them
   * reads as though the dry run had downloaded them. It also kept the wrong
   * settings: tools/resumable.js carries a crawl's options forward from
   * crawl-report.json, and a dry run overwriting it fed a dry run's options
   * into the next --resume.
   *
   *   real crawl  report/crawl-report.json
   *   --dry-run   report/crawl-report.dry-run.json
   *   --survey    report/assets-inventory.survey.json
   */
  _reportPath(siteDirectory, fileName) {
    const mode = this.config.survey ? 'survey' : this.config.dryRun ? 'dry-run' : null;
    const named = mode ? fileName.replace(/(\.[^.]+)$/, `.${mode}$1`) : fileName;
    return path.join(reportDir(siteDirectory), named);
  }

  /** Write the JSON report into report/; returns the file path. */
  write(report, siteDirectory) {
    // An explicit --report path is the caller's own choice of filename and is
    // used verbatim, dry run or not.
    const file = this.config.reportFile || this._reportPath(siteDirectory, 'crawl-report.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    return file;
  }

  /**
   * XML-escape a text node or attribute value.
   *
   * A URL legitimately contains `&` (query separators), so this is not
   * optional politeness - an unescaped one makes the whole sitemap unparseable.
   */
  static _escapeXml(text) {
    return String(text).replace(
      /[<>&'"]/g,
      (ch) =>
        ({
          '<': '&lt;',
          '>': '&gt;',
          '&': '&amp;',
          "'": '&apos;',
          '"': '&quot;',
        })[ch]
    );
  }

  /**
   * Every live URL this archive covers, paired with the file that holds it.
   *
   * Pages and downloaded files both appear: the question a reader brings to
   * this list is "is this URL in the archive, and where?", and a PDF linked
   * from a page is as much a part of the archive as the page is.
   *
   * A file linked under several URLs contributes one entry per URL, all naming
   * the single stored copy - otherwise a lookup by the other URL would come up
   * empty even though the archive holds the bytes. `duplicateOf` on the entry
   * says which URL owns the file.
   *
   * Dry runs produce nothing here: every `file` is null, because a dry run
   * archives nothing to point at.
   */
  archiveEntries(report) {
    const entries = [];
    for (const page of report.downloadedPages) {
      if (!page.file) continue;
      entries.push({
        type: 'page',
        url: page.url,
        file: page.file,
        bytes: page.bytes || 0,
        status: page.status ?? null,
        title: page.title || null,
        depth: page.depth ?? null,
      });
    }
    for (const asset of report.downloadedAssets) {
      if (!asset.file) continue;
      entries.push({
        type: 'file',
        url: asset.url,
        file: asset.file,
        bytes: asset.bytes || 0,
        status: asset.status ?? null,
        contentType: asset.contentType || null,
        group: asset.group || null,
        // Non-null when this URL shares its bytes with another URL's file.
        duplicateOf: asset.duplicateOf || null,
        // The pages that linked it, which is how someone finds the context a
        // bare file URL has lost.
        sources: asset.sources || [],
      });
    }
    return entries;
  }

  /**
   * Generate a sitemap.xml of everything actually archived and write it to
   * report/. Doubles as an index of the archive, mapping each live URL to the
   * flat file that holds it. Returns the path, or null when nothing was saved.
   */
  writeArchiveSitemap(report, siteDirectory) {
    const entries = this.archiveEntries(report);
    if (entries.length === 0) return null;

    const escapeXml = CrawlReport._escapeXml;
    const lastmod = report.finishedAt.slice(0, 10);

    const renderUrl = (entry) =>
      [
        '  <url>',
        `    <loc>${escapeXml(entry.url)}</loc>`,
        `    <lastmod>${lastmod}</lastmod>`,
        `    <!-- ${escapeXml(entry.file)}${
          entry.duplicateOf ? ` (same file as ${escapeXml(entry.duplicateOf)})` : ''
        } -->`,
        '  </url>',
      ].join('\n');

    // Pages first, then files. Grouping beats interleaving by URL: it keeps the
    // page list byte-identical to what earlier versions produced, and someone
    // reading the file top to bottom meets the pages before their attachments.
    const pages = entries.filter((entry) => entry.type === 'page');
    const files = entries.filter((entry) => entry.type === 'file');

    const sections = [];
    if (pages.length > 0) {
      sections.push(`  <!-- ${pages.length} page(s) in raw-html/ -->`);
      sections.push(pages.map(renderUrl).join('\n'));
    }
    if (files.length > 0) {
      sections.push(`  <!-- ${files.length} downloaded file(s) in assets/ -->`);
      sections.push(files.map(renderUrl).join('\n'));
    }

    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!-- Everything archived by web-archiver: the pages and the files they\n' +
      '     link to. The comment on each entry is the file that holds it. -->\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      `${sections.join('\n')}\n` +
      '</urlset>\n';

    const file = path.join(reportDir(siteDirectory), 'sitemap.xml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, xml);
    return file;
  }

  /**
   * report/assets-inventory.json - what file types the site holds.
   *
   * The same tallies `crawl-report.json` carries, in a file small enough to
   * read. In the full report they sit past thousands of lines of per-URL
   * arrays, and the numbers also need context to mean anything: "8 types" is a
   * different claim depending on whether the crawl covered the whole site or
   * stopped at its page budget. So the crawl's shape travels with them.
   *
   * Returns the path, or null when the crawl saw no asset URLs at all.
   */
  writeAssetInventory(report, siteDirectory) {
    const inventory = report.assetInventory;
    if (!inventory || !inventory.totals || inventory.totals.types === 0) return null;

    const skipped = report.skippedByReason || {};
    const payload = {
      version: 1,
      startUrl: report.startUrl,
      finishedAt: report.finishedAt,
      description:
        'File types found while crawling, whether or not they were downloaded. ' +
        '"configuredToAccept" below lists the types this run was set to take; ' +
        'the difference between the two is what the crawl walked past.',
      // Whether this is the whole site or a bounded sample of it. Without
      // these, a type count reads as complete when it may not be.
      crawl: {
        pagesCrawled: report.totals.downloaded,
        pagesFailed: report.totals.failed,
        maxDepth: report.options.maxDepth,
        maxPages: report.options.maxPages,
        // False when the run stopped early, so the inventory is a lower bound.
        complete:
          !report.interrupted &&
          !skipped['max-pages-reached'] &&
          !skipped['interrupted'],
        mode: report.options.survey
          ? 'survey'
          : report.options.dryRun
            ? 'dry-run'
            : 'archive',
      },
      // What the run was configured to take, next to what it found - the two
      // are easy to confuse, and the gap between them is the actionable part.
      configuredToAccept: report.options.assetExtensions || [],
      assetMode: report.options.assetMode,
      totals: inventory.totals,
      byHost: inventory.byHost,
    };

    const file = this._reportPath(siteDirectory, 'assets-inventory.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    return file;
  }

  /**
   * report/assets.txt - one downloaded file URL per line and nothing else, so
   * it pipes straight into wget/curl/xargs without needing a JSON parser.
   *
   * Returns the path, or null when the run downloaded nothing.
   */
  writeAssetList(report, siteDirectory) {
    const urls = report.downloadedAssets
      .filter((asset) => asset.file)
      .map((asset) => asset.url)
      .sort((a, b) => a.localeCompare(b));
    if (urls.length === 0) return null;

    const file = path.join(reportDir(siteDirectory), 'assets.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${urls.join('\n')}\n`);
    return file;
  }

  /**
   * report/archive-index.json - pages and files in one flat array.
   *
   * Same content the sitemap carries, in the form a script wants: reading one
   * array beats joining `downloadedPages` against `downloadedAssets` and
   * reconciling their different shapes.
   */
  writeArchiveIndex(report, siteDirectory) {
    const entries = this.archiveEntries(report);
    if (entries.length === 0) return null;

    const pages = entries.filter((entry) => entry.type === 'page');
    const files = entries.filter((entry) => entry.type === 'file');
    const payload = {
      version: 1,
      startUrl: report.startUrl,
      finishedAt: report.finishedAt,
      totals: {
        entries: entries.length,
        pages: pages.length,
        // Distinct stored files, so this agrees with what is on disk.
        files: files.filter((entry) => !entry.duplicateOf).length,
        fileUrls: files.length,
        bytes: entries
          .filter((entry) => !entry.duplicateOf)
          .reduce((sum, entry) => sum + entry.bytes, 0),
      },
      entries,
    };

    const file = path.join(reportDir(siteDirectory), 'archive-index.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    return file;
  }

  /**
   * The "what does this site hold?" table.
   *
   * Deliberately outside the `assetMode !== 'off'` block above: with downloads
   * turned off this is the entire point of the run, since `--assets none`
   * doubles as a survey - crawl, report every type present, fetch nothing.
   */
  static _inventoryLines(report) {
    const inventory = report.assetInventory;
    if (!inventory || inventory.totals.types === 0) return [];

    const lines = [];
    const internal = inventory.byHost.internal;
    const external = inventory.byHost.external;
    const downloadsOff = report.options.assetMode === 'off';

    lines.push(
      `  Asset types found: ${inventory.totals.types} type(s), ` +
        `${inventory.totals.urls} URL(s)`
    );

    /** One row: extension, URL count, and what became of them. */
    const row = (type, indent = '    ') => {
      const parts = [];
      if (type.planned) parts.push(`${type.planned} would be taken`);
      if (type.downloaded) parts.push(`${type.downloaded} downloaded`);
      if (type.duplicate) parts.push(`${type.duplicate} duplicate URL`);
      if (type.failed) parts.push(`${type.failed} failed`);
      if (type.skipped) {
        // Saying only "skipped" invites the question this answers.
        parts.push(
          downloadsOff
            ? `${type.skipped} not taken (--assets none)`
            : `${type.skipped} not in --assets`
        );
      }
      const hosts = type.hosts && type.hosts.length ? `  [${type.hosts.slice(0, 2).join(', ')}` +
        `${type.hosts.length > 2 ? `, +${type.hosts.length - 2}` : ''}]` : '';
      return (
        `${indent}${type.extension.padEnd(6)} ${String(type.urls).padStart(5)}` +
        `${parts.length ? `   ${parts.join(', ')}` : ''}${hosts}`
      );
    };

    for (const type of internal.types.slice(0, MAX_SUMMARY_TYPES)) lines.push(row(type));
    if (internal.types.length > MAX_SUMMARY_TYPES) {
      lines.push(
        `    ... and ${internal.types.length - MAX_SUMMARY_TYPES} more type(s) (see the report)`
      );
    }

    if (external.types.length > 0) {
      lines.push(`    on other hosts:`);
      for (const type of external.types.slice(0, MAX_SUMMARY_TYPES)) lines.push(row(type, '      '));
      if (external.types.length > MAX_SUMMARY_TYPES) {
        lines.push(
          `      ... and ${external.types.length - MAX_SUMMARY_TYPES} more type(s) (see the report)`
        );
      }
    }

    // The actionable part: name the types this run walked past.
    // Falsy rather than `=== 0`, so a report written before `planned` existed
    // still renders instead of silently dropping every row.
    const missed = [
      ...new Set(
        [...internal.types, ...external.types]
          .filter((type) => type.skipped > 0 && !type.downloaded && !type.planned)
          .map((type) => type.extension)
      ),
    ];
    if (missed.length > 0 && !downloadsOff) {
      lines.push(
        `    not collected: ${missed.slice(0, 12).join(', ')}` +
          `${missed.length > 12 ? `, +${missed.length - 12}` : ''}` +
          ` - add with --assets`
      );
    }
    return lines;
  }

  /** Render the console summary. */
  summary(report, files = {}) {
    const {
      reportFile = null,
      archiveSitemapFile = null,
      manifestFile = null,
      assetListFile = null,
      archiveIndexFile = null,
      assetInventoryFile = null,
    } = files;
    const t = report.totals;
    const sitemapLine = report.sitemap.found
      ? `${report.sitemap.seeded} URL(s) seeded from ${report.sitemap.sources.length} file(s)`
      : report.options.sitemapEnabled
        ? 'not found'
        : 'disabled';
    const mb = (t.archivedBytes / (1024 * 1024)).toFixed(1);
    const lines = [
      '',
      `Archive ${report.interrupted ? 'INTERRUPTED' : 'finished'}: ${report.startUrl}`,
      `  Duration:          ${formatDuration(report.durationMs)}`,
      `  Sitemap:           ${sitemapLine}`,
      `  URLs discovered:   ${t.discovered}`,
      `  Pages archived:    ${t.downloaded}${t.archivedBytes ? ` (${mb} MB)` : ''}`,
      `  Skipped:           ${t.skipped}${
        t.skipped
          ? ` (${Object.entries(report.skippedByReason)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => `${reason}: ${count}`)
              .join(', ')})`
          : ''
      }`,
      `  Failed:            ${t.failed}`,
    ];

    if (report.options.assetMode !== 'off') {
      const byGroup = {};
      for (const asset of report.downloadedAssets) {
        if (asset.duplicateOf) continue; // counted under the file it shares
        const key = asset.group || asset.extension || 'other';
        byGroup[key] = (byGroup[key] || 0) + 1;
      }
      const breakdown = Object.entries(byGroup)
        .sort((a, b) => b[1] - a[1])
        .map(([group, count]) => `${group}: ${count}`)
        .join(', ');
      lines.push(
        `  ${
          report.options.survey
            ? 'Files collectable: '
            : report.options.dryRun
              ? 'Files to download:'
              : 'Files downloaded: '
        } ${t.assetFiles}` +
          `${t.assetBytes ? ` (${formatBytes(t.assetBytes)})` : ''}` +
          `${breakdown ? ` [${breakdown}]` : ''}` +
          `${t.assetDuplicates ? `, ${t.assetDuplicates} more URL(s) were the same file` : ''}`
      );

      // The URLs themselves, not just the count. A file URL is the one thing a
      // reader cannot reconstruct from the page list, and it is what they need
      // to check a download or fetch it again by hand.
      const taken = report.downloadedAssets.filter((asset) => asset.file);
      if (taken.length > 0) {
        lines.push('  Files:');
        for (const asset of taken.slice(0, MAX_SUMMARY_URLS)) {
          lines.push(
            `    - ${asset.url} -> ${asset.file}` +
              `${asset.duplicateOf ? ' (same file as an earlier URL)' : ''}`
          );
        }
        if (taken.length > MAX_SUMMARY_URLS) {
          lines.push(
            `    ... and ${taken.length - MAX_SUMMARY_URLS} more ` +
              '(all of them in report/assets.txt)'
          );
        }
      }

      if (t.assetsFailed || t.assetsSkipped) {
        const detail = Object.entries(report.assetsSkippedByReason)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count]) => `${reason.replace(/^asset-/, '')}: ${count}`)
          .join(', ');
        lines.push(
          `  Files not taken:   ${t.assetsFailed} failed, ${t.assetsSkipped} skipped` +
            `${detail ? ` (${detail})` : ''}`
        );
      }
      if (t.rewrittenLinks) {
        lines.push(`  Links localised:   ${t.rewrittenLinks} (now open from assets/)`);
      }
    }

    lines.push(...CrawlReport._inventoryLines(report));

    // "I asked for 20 pages and got 17" reads as a bug unless the run says why.
    const shortfall = shortfallReason(report);
    if (shortfall) lines.push(`  Short of --max-pages ${report.options.maxPages}: ${shortfall}`);

    if (report.failedUrls.length > 0) {
      lines.push('  Failures:');
      for (const failure of report.failedUrls.slice(0, 10)) {
        lines.push(`    - ${failure.url} -> ${failure.error}`);
      }
      if (report.failedUrls.length > 10) {
        lines.push(`    ... and ${report.failedUrls.length - 10} more (see report)`);
      }
    }
    if (report.failedAssets.length > 0) {
      lines.push('  File failures:');
      for (const failure of report.failedAssets.slice(0, 5)) {
        lines.push(`    - ${failure.url} -> ${failure.error}`);
      }
      if (report.failedAssets.length > 5) {
        lines.push(`    ... and ${report.failedAssets.length - 5} more (see report)`);
      }
    }
    if (report.interrupted) {
      lines.push('  Resume with:       --resume');
    }
    if (archiveSitemapFile) lines.push(`  Archive sitemap:   ${archiveSitemapFile}`);
    if (assetInventoryFile) lines.push(`  Asset inventory:   ${assetInventoryFile}`);
    if (archiveIndexFile) lines.push(`  Archive index:     ${archiveIndexFile}`);
    if (manifestFile) lines.push(`  Asset manifest:    ${manifestFile}`);
    if (assetListFile) lines.push(`  File URL list:     ${assetListFile}`);
    if (reportFile) lines.push(`  Report:            ${reportFile}`);
    lines.push('');
    return lines.join('\n');
  }
}

module.exports = { CrawlReport };
