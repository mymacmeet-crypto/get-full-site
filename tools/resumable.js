#!/usr/bin/env node
'use strict';

/**
 * Finds resumable crawls under an output folder and reports them in formats
 * a shell can read without a JSON parser. Both runner.ps1 and runner.sh call
 * this, so the scan rules and the carried-forward options live in one place.
 *
 *   node tools/resumable.js list <base>
 *       One tab-separated line per crawl, newest first:
 *       index <TAB> url <TAB> age <TAB> archived <TAB> pending
 *
 *   node tools/resumable.js show <base> <index>
 *       key=value lines for one crawl (split on the FIRST "=" - a regex value
 *       can contain more).
 *
 *   node tools/resumable.js args <base> <index>
 *       The previous run's scope and tuning flags, one argument per line, ready
 *       to append to an argv. One per line so patterns containing spaces or
 *       quotes survive the trip through the shell.
 *
 * A crawl is resumable when <base>/<host>/report/.crawl-state.json exists; the
 * archiver writes it on an interrupt or when --max-pages is hit with URLs still
 * pending, and deletes it when a crawl finishes cleanly.
 */

const fs = require('node:fs');
const path = require('node:path');

const STATE_FILENAME = '.crawl-state.json';

function humanAge(iso) {
  const saved = Date.parse(iso);
  if (!Number.isFinite(saved)) return 'unknown';
  const seconds = Math.max(0, Math.round((Date.now() - saved) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Every resumable crawl under `base`, newest save first. */
function scan(base) {
  let dirents;
  try {
    dirents = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return []; // no output folder yet
  }

  const crawls = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;

    const siteDir = path.join(base, dirent.name);
    const reportDir = path.join(siteDir, 'report');
    const state = readJson(path.join(reportDir, STATE_FILENAME));
    if (!state || !state.startUrl) continue;

    // The report is written on every run, including interrupted ones, so it is
    // normally there - but a hard kill can lose it. Missing means "no previous
    // options", and the runner falls back to the CLI defaults.
    const report = readJson(path.join(reportDir, 'crawl-report.json'));
    const options = (report && report.options) || null;

    const pages = (state.stats && state.stats.pages) || [];
    const queue = state.queue || {};

    crawls.push({
      url: state.startUrl,
      savedAt: state.savedAt || '',
      age: humanAge(state.savedAt),
      archived: pages.filter((page) => page.file).length,
      // Pages that consumed a --max-pages slot: the number the budget counts.
      processed: state.processedCount || 0,
      pending: Array.isArray(queue.pending) ? queue.pending.length : 0,
      visited: Array.isArray(queue.visited) ? queue.visited.length : 0,
      site: siteDir,
      base,
      options,
    });
  }

  return crawls.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

function pick(crawls, indexArg) {
  const index = Number(indexArg);
  if (!Number.isInteger(index) || index < 1 || index > crawls.length) {
    process.stderr.write(`No resumable crawl at index ${indexArg}\n`);
    process.exit(1);
  }
  return crawls[index - 1];
}

function emitList(crawls) {
  crawls.forEach((crawl, i) => {
    process.stdout.write(
      [i + 1, crawl.url, crawl.age, crawl.archived, crawl.pending].join('\t') + '\n'
    );
  });
}

function emitShow(crawl) {
  const o = crawl.options || {};
  const sitemap = o.sitemapUrl ? o.sitemapUrl : o.sitemapEnabled === false ? 'off' : 'auto';

  const fields = {
    url: crawl.url,
    age: crawl.age,
    savedAt: crawl.savedAt,
    archived: crawl.archived,
    processed: crawl.processed,
    pending: crawl.pending,
    visited: crawl.visited,
    site: crawl.site,
    base: crawl.base,
    // 1 when a previous crawl-report.json supplied the settings below.
    optionsFound: crawl.options ? 1 : 0,
    maxPages: o.maxPages ?? 100,
    maxDepth: o.maxDepth ?? 3,
    // Only the first pattern is offered as a prompt default; the counts let the
    // runner warn instead of silently dropping the rest.
    include: (o.include && o.include[0]) || '',
    includeCount: (o.include && o.include.length) || 0,
    exclude: (o.exclude && o.exclude[0]) || '',
    excludeCount: (o.exclude && o.exclude.length) || 0,
    sitemap,
    allDomains: o.sameDomainOnly === false ? 1 : 0,
    respectRobots: o.respectRobots ? 1 : 0,
    followRedirects: o.followRedirects === false ? 0 : 1,
    workers: o.workers ?? 4,
    concurrency: o.concurrency ?? 2,
    batch: o.batchSize ?? 8,
    delay: o.delayMs ?? 500,
    timeout: o.timeoutMs ?? 30000,
    idle: o.deferredImagesMaxIdleMs ?? 500,
    wait: o.waitAfterLoadMs ?? 0,
    // Linked files and capture fidelity. A crawl saved before these existed
    // reports the current defaults, which is what a resume of it would use.
    assets: o.assetMode === 'off' ? 'none' : (o.assetGroups || ['documents']).join(','),
    assetDomains: o.assetMode && o.assetMode !== 'off' ? o.assetMode : 'linked',
    maxAssets: o.maxAssets ?? 1000,
    maxAssetSize: Math.round((o.maxAssetBytes ?? 100 * 1024 * 1024) / (1024 * 1024)),
    rewriteLinks: o.rewriteLinks === false ? 0 : 1,
    revealAnimations: o.revealAnimations === false ? 0 : 1,
  };

  for (const [key, value] of Object.entries(fields)) {
    process.stdout.write(`${key}=${value}\n`);
  }
}

/**
 * Scope and tuning flags to carry into the resumed run. --max-pages and --depth
 * are left out: the runner re-asks those. So are --overwrite and --dry-run,
 * which are decisions about this run rather than properties of the crawl.
 */
function emitArgs(crawl) {
  const o = crawl.options;
  if (!o) return; // nothing recorded - the CLI defaults apply

  const args = [];
  for (const pattern of o.include || []) args.push('--include', pattern);
  for (const pattern of o.exclude || []) args.push('--exclude', pattern);
  if (o.sameDomainOnly === false) args.push('--all-domains');
  if (o.respectRobots) args.push('--respect-robots');
  if (o.followRedirects === false) args.push('--no-follow-redirects');
  if (o.sitemapUrl) args.push('--sitemap', o.sitemapUrl);
  else if (o.sitemapEnabled === false) args.push('--no-sitemap');
  if (o.workers != null) args.push('--workers', String(o.workers));
  if (o.concurrency != null) args.push('--concurrency', String(o.concurrency));
  if (o.batchSize != null) args.push('--batch', String(o.batchSize));
  if (o.delayMs != null) args.push('--delay', String(o.delayMs));
  if (o.timeoutMs != null) args.push('--timeout', String(o.timeoutMs));
  if (o.deferredImagesMaxIdleMs != null) {
    args.push('--deferred-images-idle', String(o.deferredImagesMaxIdleMs));
  }
  if (o.waitAfterLoadMs) args.push('--wait', String(o.waitAfterLoadMs));

  // Which files a crawl takes is a property of that crawl: resuming with a
  // different selection would leave one archive holding two different answers.
  if (o.assetMode === 'off') {
    args.push('--no-assets');
  } else if (o.assetMode) {
    if (o.assetGroups && o.assetGroups.length) args.push('--assets', o.assetGroups.join(','));
    args.push('--asset-domains', o.assetMode);
    if (o.maxAssets != null) args.push('--max-assets', String(o.maxAssets));
    if (o.maxAssetBytes != null) {
      args.push('--max-asset-size', String(Math.round(o.maxAssetBytes / (1024 * 1024))));
    }
    if (o.rewriteLinks === false) args.push('--no-rewrite-links');
  }
  if (o.revealAnimations === false) args.push('--no-reveal-animations');
  if (o.removeHiddenElements === true && o.revealAnimations !== false) args.push('--remove-hidden');

  for (const arg of args) process.stdout.write(`${arg}\n`);
}

function main(argv) {
  const [mode, base, index] = argv;
  if (!mode || !base) {
    process.stderr.write('usage: resumable.js <list|show|args> <base> [index]\n');
    process.exit(2);
  }

  const crawls = scan(path.resolve(base));

  switch (mode) {
    case 'list':
      emitList(crawls);
      // Exit 1 on an empty list so a shell can branch on it without counting.
      process.exit(crawls.length > 0 ? 0 : 1);
      break;
    case 'show':
      emitShow(pick(crawls, index));
      break;
    case 'args':
      emitArgs(pick(crawls, index));
      break;
    default:
      process.stderr.write(`Unknown mode: ${mode}\n`);
      process.exit(2);
  }
}

main(process.argv.slice(2));
