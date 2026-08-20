'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CrawlReport } = require('../src/report');

const PDF = 'https://ontheline.trincoll.edu/images/bookdown/sample-local-pdf.pdf';
const PDF_HTTP = 'http://ontheline.trincoll.edu/images/bookdown/sample-local-pdf.pdf';
const PDF_FILE = 'assets/images-bookdown-sample-local-pdf.pdf';

function makeReport({ assetMode = 'linked' } = {}) {
  return new CrawlReport({
    startUrl: 'https://ontheline.trincoll.edu/',
    outputFolder: '/out',
    maxDepth: 3,
    maxPages: 100,
    sameDomainOnly: true,
    includePatterns: [],
    excludePatterns: [],
    delayMs: 0,
    concurrency: 2,
    workers: 4,
    batchSize: 8,
    timeoutMs: 30000,
    deferredImagesMaxIdleMs: 500,
    waitAfterLoadMs: 600,
    followRedirects: true,
    respectRobots: false,
    overwrite: false,
    dryRun: false,
    sitemapEnabled: false,
    sitemapUrl: null,
    assetMode,
    assetGroups: ['documents'],
    assetExtensions: new Set(['pdf']),
    maxAssets: 1000,
    maxAssetBytes: 104857600,
    rewriteLinks: true,
    revealAnimations: true,
    removeHiddenElements: false,
  });
}

/** A report holding one page, one file, and one duplicate URL of that file. */
function populated() {
  const report = makeReport();
  report.recordDownloaded({
    url: 'https://ontheline.trincoll.edu/',
    file: 'raw-html/index.html',
    status: 200,
    depth: 0,
    title: 'On The Line',
    bytes: 4096,
  });
  const asset = {
    file: PDF_FILE,
    fileName: path.basename(PDF_FILE),
    bytes: 1024,
    contentType: 'application/pdf',
    sha256: 'a'.repeat(64),
    status: 200,
    extension: 'pdf',
    group: 'documents',
    sources: ['https://ontheline.trincoll.edu/'],
  };
  report.recordAsset({ ...asset, url: PDF, duplicateOf: null });
  report.recordAsset({ ...asset, url: PDF_HTTP, duplicateOf: PDF });
  return report;
}

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-report-'));

// --------------------------------------------------------------------------
// archiveEntries
// --------------------------------------------------------------------------

test('archiveEntries covers pages and downloaded files alike', () => {
  const report = populated();
  const entries = report.archiveEntries(report.build(3));

  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.type),
    ['page', 'file', 'file']
  );
  const pdf = entries.find((entry) => entry.url === PDF);
  assert.equal(pdf.file, PDF_FILE);
  assert.equal(pdf.contentType, 'application/pdf');
  assert.deepEqual(pdf.sources, ['https://ontheline.trincoll.edu/']);
});

test('archiveEntries leaves out what was never written to disk', () => {
  const report = makeReport();
  // A dry run records the URL with no file, because nothing was archived.
  report.recordDownloaded({ url: 'https://x.test/', file: null, dryRun: true });
  report.recordAsset({ url: PDF, file: null, bytes: 0, dryRun: true });
  assert.deepEqual(report.archiveEntries(report.build(1)), []);
});

// --------------------------------------------------------------------------
// sitemap.xml
// --------------------------------------------------------------------------

test('the sitemap lists file URLs alongside page URLs', () => {
  const report = populated();
  const file = report.writeArchiveSitemap(report.build(3), tmpdir());
  const xml = fs.readFileSync(file, 'utf8');

  assert.equal(path.basename(file), 'sitemap.xml');
  assert.ok(xml.includes('<loc>https://ontheline.trincoll.edu/</loc>'), 'page URL');
  assert.ok(xml.includes(`<loc>${PDF}</loc>`), 'file URL');
  assert.ok(xml.includes(`<!-- ${PDF_FILE} -->`), 'names the local copy');
  assert.ok(xml.includes('<!-- 1 page(s) in raw-html/ -->'));
  assert.ok(xml.includes('<!-- 2 downloaded file(s) in assets/ -->'));
  assert.ok(xml.indexOf('raw-html/index.html') < xml.indexOf(PDF_FILE), 'pages first');
});

test('every URL of a shared file gets its own sitemap entry', () => {
  const report = populated();
  const xml = fs.readFileSync(report.writeArchiveSitemap(report.build(3), tmpdir()), 'utf8');

  assert.equal((xml.match(/<loc>/g) || []).length, 3, 'page + both file URLs');
  assert.ok(xml.includes(`<loc>${PDF_HTTP}</loc>`));
  // The duplicate says which URL owns the bytes, rather than reading as a
  // second copy on disk.
  assert.ok(xml.includes(`(same file as ${PDF})`));
});

test('a URL containing & stays parseable in the sitemap', () => {
  const report = makeReport();
  report.recordAsset({
    url: 'https://x.test/get?a=1&b=2',
    file: 'assets/get_q_a-1_b-2.pdf',
    bytes: 10,
    duplicateOf: null,
  });
  const xml = fs.readFileSync(report.writeArchiveSitemap(report.build(1), tmpdir()), 'utf8');
  assert.ok(xml.includes('<loc>https://x.test/get?a=1&amp;b=2</loc>'));
  assert.ok(!/&(?!amp;|lt;|gt;|apos;|quot;)/.test(xml), 'no bare ampersand anywhere');
});

test('a run that archived nothing writes no sitemap', () => {
  const report = makeReport();
  assert.equal(report.writeArchiveSitemap(report.build(0), tmpdir()), null);
});

test('files alone are enough to earn a sitemap', () => {
  // A crawl can legitimately take a file and no page at all, e.g. when every
  // page was already archived and only a new PDF turned up.
  const report = makeReport();
  report.recordAsset({ url: PDF, file: PDF_FILE, bytes: 10, duplicateOf: null });
  const xml = fs.readFileSync(report.writeArchiveSitemap(report.build(1), tmpdir()), 'utf8');
  assert.ok(xml.includes(`<loc>${PDF}</loc>`));
  assert.ok(!xml.includes('page(s) in raw-html/'));
});

// --------------------------------------------------------------------------
// assets.txt
// --------------------------------------------------------------------------

test('assets.txt is bare URLs, one per line, sorted', () => {
  const report = populated();
  const file = report.writeAssetList(report.build(3), tmpdir());
  const text = fs.readFileSync(file, 'utf8');

  assert.equal(path.basename(file), 'assets.txt');
  assert.deepEqual(text.split('\n').filter(Boolean), [PDF_HTTP, PDF]);
  assert.ok(text.endsWith('\n'), 'trailing newline, so wc -l and xargs agree');
  assert.ok(!text.includes('#') && !text.includes('assets/'), 'nothing but URLs');
});

test('assets.txt is not written when nothing was downloaded', () => {
  const report = makeReport();
  report.recordDownloaded({ url: 'https://x.test/', file: 'raw-html/index.html', bytes: 1 });
  assert.equal(report.writeAssetList(report.build(1), tmpdir()), null);
});

// --------------------------------------------------------------------------
// archive-index.json
// --------------------------------------------------------------------------

test('archive-index.json is one flat array of pages and files', () => {
  const report = populated();
  const file = report.writeArchiveIndex(report.build(3), tmpdir());
  const index = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.equal(path.basename(file), 'archive-index.json');
  assert.equal(index.startUrl, 'https://ontheline.trincoll.edu/');
  assert.deepEqual(index.totals, {
    entries: 3,
    pages: 1,
    files: 1, // distinct files on disk
    fileUrls: 2, // URLs pointing at them
    bytes: 4096 + 1024, // the duplicate's bytes are not counted twice
  });
  assert.equal(index.entries.length, 3);
  assert.ok(index.entries.every((entry) => entry.url && entry.file && entry.type));
});

// --------------------------------------------------------------------------
// console summary
// --------------------------------------------------------------------------

test('the summary names the file URLs, not just how many', () => {
  const report = populated();
  const text = report.summary(report.build(3), {
    reportFile: '/out/report/crawl-report.json',
    archiveSitemapFile: '/out/report/sitemap.xml',
    assetListFile: '/out/report/assets.txt',
    archiveIndexFile: '/out/report/archive-index.json',
  });

  assert.ok(text.includes(PDF), 'the URL itself appears');
  assert.ok(text.includes(`-> ${PDF_FILE}`), 'paired with its local file');
  assert.ok(text.includes('(same file as an earlier URL)'), 'duplicate is labelled');
  assert.ok(text.includes('/out/report/assets.txt'));
  assert.ok(text.includes('/out/report/archive-index.json'));
});

test('the summary defers to assets.txt rather than printing hundreds of URLs', () => {
  const report = makeReport();
  for (let i = 0; i < 25; i++) {
    report.recordAsset({
      url: `https://x.test/doc-${i}.pdf`,
      file: `assets/doc-${i}.pdf`,
      bytes: 10,
      duplicateOf: null,
    });
  }
  const text = report.summary(report.build(25), {});
  assert.ok(text.includes('https://x.test/doc-0.pdf'));
  assert.ok(!text.includes('https://x.test/doc-20.pdf'), 'the tail is not printed');
  assert.ok(text.includes('... and 15 more (all of them in report/assets.txt)'));
});

test('with downloads off the summary says nothing about files', () => {
  const report = makeReport({ assetMode: 'off' });
  report.recordDownloaded({ url: 'https://x.test/', file: 'raw-html/index.html', bytes: 1 });
  const text = report.summary(report.build(1), {});
  assert.ok(!text.includes('Files downloaded'));
  assert.ok(!text.includes('Files:'));
});

// --------------------------------------------------------------------------
// asset inventory in the console summary
// --------------------------------------------------------------------------

/** A built report carrying an inventory, without running a crawl. */
function withInventory(report, { assetMode = 'linked' } = {}) {
  const built = report.build(3);
  built.options.assetMode = assetMode;
  built.assetInventory = {
    description: 'File types found while crawling, whether or not they were downloaded.',
    totals: { types: 3, urls: 123, downloaded: 8, bytes: 1024 },
    byHost: {
      internal: {
        host: 'ontheline.trincoll.edu',
        types: [
          { extension: 'png', group: 'media', urls: 112, downloaded: 0, duplicate: 0,
            failed: 0, skipped: 112, bytes: 0, linkedFromPages: 20, hosts: [], samples: [] },
          { extension: 'pdf', group: 'documents', urls: 9, downloaded: 6, duplicate: 2,
            failed: 1, skipped: 0, bytes: 1024, linkedFromPages: 4, hosts: [], samples: [] },
        ],
      },
      external: {
        types: [
          { extension: 'pdf', group: 'documents', urls: 2, downloaded: 2, duplicate: 0,
            failed: 0, skipped: 0, bytes: 0, linkedFromPages: 2,
            hosts: ['github.com'], samples: [] },
        ],
      },
    },
  };
  return built;
}

test('the summary reports what types the site holds, downloaded or not', () => {
  const report = populated();
  const text = report.summary(withInventory(report), {});

  assert.ok(text.includes('Asset types found: 3 type(s), 123 URL(s)'));
  assert.ok(/png\s+112\s+112 not in --assets/.test(text), 'a type being skipped is visible');
  assert.ok(/pdf\s+9\s+6 downloaded, 2 duplicate URL, 1 failed/.test(text));
});

test('external hosts are listed apart, and named', () => {
  const report = populated();
  const text = report.summary(withInventory(report), {});
  assert.ok(text.includes('on other hosts:'));
  assert.ok(text.includes('[github.com]'));
});

test('the summary names the types the run walked past', () => {
  const report = populated();
  const text = report.summary(withInventory(report), {});
  // The actionable line: png exists on the site and nothing collected it.
  assert.ok(text.includes('not collected: png - add with --assets'));
});

test('with downloads off the inventory still reports, worded as a survey', () => {
  const report = populated();
  const text = report.summary(withInventory(report, { assetMode: 'off' }), {});
  assert.ok(text.includes('Asset types found:'), 'survey mode is the point of --assets none');
  assert.ok(text.includes('not taken (--assets none)'));
  assert.ok(!text.includes('add with --assets'), 'no nagging when downloads were off on purpose');
});

test('a run that found no assets prints no inventory at all', () => {
  const report = populated();
  const built = report.build(3);
  built.assetInventory = { totals: { types: 0, urls: 0 }, byHost: { internal: { types: [] }, external: { types: [] } } };
  assert.ok(!report.summary(built, {}).includes('Asset types found'));
});

test('an older report with no inventory block still renders', () => {
  const report = populated();
  const built = report.build(3);
  built.assetInventory = null;
  assert.doesNotThrow(() => report.summary(built, {}));
});

test('a dry run accounts for the files it would have taken', () => {
  const report = populated();
  const built = report.build(3);
  built.options.dryRun = true;
  built.assetInventory = {
    totals: { types: 1, urls: 12, downloaded: 0, bytes: 0 },
    byHost: {
      internal: {
        host: 'ontheline.trincoll.edu',
        types: [
          { extension: 'pdf', group: 'documents', urls: 12, downloaded: 0, duplicate: 0,
            failed: 0, skipped: 1, planned: 11, bytes: 0, linkedFromPages: 7,
            hosts: [], samples: [] },
        ],
      },
      external: { types: [] },
    },
  };
  const text = report.summary(built, {});

  // Every URL is accounted for: 11 would be taken, 1 is the wrong type.
  assert.ok(/pdf\s+12\s+11 would be taken, 1 not in --assets/.test(text));
  // And a dry run must not claim it downloaded anything.
  assert.ok(text.includes('Files to download:'));
  assert.ok(!text.includes('Files downloaded:'));
  // pdf would have been taken, so it is not a type the run walked past.
  assert.ok(!text.includes('not collected: pdf'));
});

// --------------------------------------------------------------------------
// assets-inventory.json
// --------------------------------------------------------------------------

test('the standalone inventory file carries the crawl context with the tallies', () => {
  const report = populated();
  const built = withInventory(report);
  built.options.survey = true;
  built.options.assetExtensions = ['pdf', 'docx'];
  const file = report.writeAssetInventory(built, tmpdir());
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.equal(path.basename(file), 'assets-inventory.json');
  assert.equal(json.startUrl, 'https://ontheline.trincoll.edu/');
  // "8 types" means nothing without knowing how much of the site was seen.
  assert.equal(json.crawl.pagesCrawled, 1);
  assert.equal(json.crawl.maxDepth, 3);
  assert.equal(json.crawl.mode, 'survey');
  assert.deepEqual(json.configuredToAccept, ['pdf', 'docx']);
  assert.equal(json.totals.types, 3);
  assert.ok(json.byHost.internal.types.length > 0);
});

test('the inventory file describes its own fields, not the full report', () => {
  const report = populated();
  const json = JSON.parse(
    fs.readFileSync(report.writeAssetInventory(withInventory(report), tmpdir()), 'utf8')
  );
  assert.match(json.description, /configuredToAccept/);
  assert.ok(
    !json.description.includes('options.assetExtensions'),
    'that field does not exist in this file'
  );
});

test('an incomplete crawl says so, so the counts read as a lower bound', () => {
  const report = populated();
  const built = withInventory(report);
  built.skippedByReason = { 'max-pages-reached': 30 };
  const json = JSON.parse(
    fs.readFileSync(report.writeAssetInventory(built, tmpdir()), 'utf8')
  );
  assert.equal(json.crawl.complete, false);
});

test('no inventory file when the crawl found no assets', () => {
  const report = populated();
  const built = report.build(3);
  built.assetInventory = { totals: { types: 0, urls: 0 }, byHost: { internal: { types: [] }, external: { types: [] } } };
  assert.equal(report.writeAssetInventory(built, tmpdir()), null);
  // ...and an older report with no block at all must not throw.
  built.assetInventory = null;
  assert.equal(report.writeAssetInventory(built, tmpdir()), null);
});

test('a survey says what is collectable rather than claiming a download', () => {
  const report = populated();
  const built = withInventory(report);
  built.options.survey = true;
  built.options.dryRun = true;
  const text = report.summary(built, { assetInventoryFile: '/out/report/assets-inventory.json' });

  assert.ok(text.includes('Files collectable:'));
  assert.ok(!text.includes('Files downloaded:'));
  assert.ok(!text.includes('Files to download:'));
  assert.ok(text.includes('/out/report/assets-inventory.json'));
});
