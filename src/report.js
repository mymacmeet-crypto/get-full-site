'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { formatDuration, formatBytes } = require('./utils/misc');
const { reportDir } = require('./utils/paths');

// Full skipped-URL details are capped so a crawl of a heavily linked site
// cannot balloon the report; counts per reason always cover everything.
const MAX_SKIPPED_DETAIL = 5000;

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

  /** Write the JSON report into report/; returns the file path. */
  write(report, siteDirectory) {
    const file =
      this.config.reportFile || path.join(reportDir(siteDirectory), 'crawl-report.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    return file;
  }

  /**
   * Generate a sitemap.xml of the pages actually archived and write it to
   * report/. Doubles as an index of the archive, mapping each live URL to the
   * flat file that holds it. Returns the path, or null when nothing was saved.
   */
  writeArchiveSitemap(report, siteDirectory) {
    const archived = report.downloadedPages.filter((page) => page.file);
    if (archived.length === 0) return null;

    const escapeXml = (text) =>
      String(text).replace(
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

    const lastmod = report.finishedAt.slice(0, 10);
    const urls = archived
      .map((page) =>
        [
          '  <url>',
          `    <loc>${escapeXml(page.url)}</loc>`,
          `    <lastmod>${lastmod}</lastmod>`,
          `    <!-- ${escapeXml(page.file)} -->`,
          '  </url>',
        ].join('\n')
      )
      .join('\n');
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!-- Pages archived by web-archiver; the comment on each entry is the\n' +
      '     flat file in raw-html/ that holds that page. -->\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      `${urls}\n` +
      '</urlset>\n';

    const file = path.join(reportDir(siteDirectory), 'sitemap.xml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, xml);
    return file;
  }

  /** Render the console summary. */
  summary(report, files = {}) {
    const { reportFile = null, archiveSitemapFile = null, manifestFile = null } = files;
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
        `  Files downloaded:  ${t.assetFiles}` +
          `${t.assetBytes ? ` (${formatBytes(t.assetBytes)})` : ''}` +
          `${breakdown ? ` [${breakdown}]` : ''}` +
          `${t.assetDuplicates ? `, ${t.assetDuplicates} more URL(s) were the same file` : ''}`
      );
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
    if (manifestFile) lines.push(`  Asset manifest:    ${manifestFile}`);
    if (reportFile) lines.push(`  Report:            ${reportFile}`);
    lines.push('');
    return lines.join('\n');
  }
}

module.exports = { CrawlReport };
