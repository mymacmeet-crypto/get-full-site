'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AssetDownloader, extensionFromDisposition } = require('../src/assets');
const {
  classifyAsset,
  checkAssetScope,
  groupForContentType,
  resolveAssetExtensions,
  urlExtension,
} = require('../src/utils/url');
const { flatAssetName, FlatNames } = require('../src/utils/paths');

// --------------------------------------------------------------------------
// Classification
// --------------------------------------------------------------------------

test('resolveAssetExtensions expands groups, bare extensions and "all"', () => {
  const documents = resolveAssetExtensions(['documents']);
  assert.ok(documents.has('pdf'));
  assert.ok(documents.has('xlsx'));
  assert.ok(!documents.has('png'), 'images are not documents');

  const mixed = resolveAssetExtensions(['documents', 'png', '.webp']);
  assert.ok(mixed.has('pdf') && mixed.has('png') && mixed.has('webp'));

  assert.ok(resolveAssetExtensions(['all']).size > documents.size);
  assert.equal(resolveAssetExtensions(['none']).size, 0);
  assert.equal(resolveAssetExtensions([]).size, 0);
});

test('resolveAssetExtensions rejects a value it cannot interpret', () => {
  assert.throws(() => resolveAssetExtensions(['documentz!']), /Unknown --assets value/);
});

test('urlExtension only treats a real suffix as an extension', () => {
  assert.equal(urlExtension('https://x.test/a/b/file.PDF'), 'pdf');
  assert.equal(urlExtension('https://x.test/a/b/file.pdf?v=2'), 'pdf');
  assert.equal(urlExtension('https://x.test/a/b/'), '');
  assert.equal(urlExtension('https://x.test/v1.2/getting-started'), '');
  assert.equal(urlExtension('https://x.test/.htaccess'), '');
});

test('classifyAsset answers against the enabled extensions, not every known one', () => {
  const documents = resolveAssetExtensions(['documents']);

  const pdf = classifyAsset('https://ontheline.trincoll.edu/images/bookdown/sample.pdf', documents);
  assert.deepEqual(pdf, { isAsset: true, extension: 'pdf', group: 'documents' });

  const png = classifyAsset('https://x.test/logo.png', documents);
  assert.equal(png.isAsset, false, 'media is a known group but was not enabled');
  assert.equal(png.group, 'media');

  const page = classifyAsset('https://x.test/about', documents);
  assert.deepEqual(page, { isAsset: false, extension: '', group: null });
});

test('groupForContentType recognises a file that has no extension in its URL', () => {
  assert.deepEqual(groupForContentType('application/pdf; charset=binary'), {
    group: 'documents',
    extension: 'pdf',
  });
  assert.equal(groupForContentType('text/html'), null);
});

test('extensionFromDisposition reads the filename the server suggests', () => {
  assert.equal(extensionFromDisposition('attachment; filename="report q1.XLSX"'), 'xlsx');
  assert.equal(extensionFromDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"), 'pdf');
  assert.equal(extensionFromDisposition('attachment'), '');
  assert.equal(extensionFromDisposition(null), '');
});

// --------------------------------------------------------------------------
// Scope
// --------------------------------------------------------------------------

test('checkAssetScope follows the chosen host rule', () => {
  const base = { startUrl: 'https://site.test/', excludePatterns: [] };
  const external = 'https://cdn.other.test/f.pdf';
  const internal = 'https://site.test/docs/f.pdf';

  assert.equal(checkAssetScope(internal, { ...base, mode: 'same' }).allowed, true);
  assert.equal(checkAssetScope(external, { ...base, mode: 'same' }).allowed, false);

  // 'linked' takes an off-host file when a crawled page pointed straight at it.
  assert.equal(
    checkAssetScope(external, { ...base, mode: 'linked', sourceUrl: 'https://site.test/p' })
      .allowed,
    true
  );
  assert.equal(checkAssetScope(external, { ...base, mode: 'linked' }).allowed, false);

  assert.equal(checkAssetScope(external, { ...base, mode: 'any' }).allowed, true);
  assert.equal(checkAssetScope(internal, { ...base, mode: 'off' }).allowed, false);
});

test('checkAssetScope honours --exclude but ignores --include', () => {
  const scope = {
    startUrl: 'https://site.test/',
    mode: 'linked',
    excludePatterns: [/\/private\//],
  };
  assert.equal(checkAssetScope('https://site.test/private/x.pdf', scope).reason, 'excluded-pattern');
  // A PDF linked from an included page keeps its own out-of-the-way URL; that
  // must not be read as "not worth taking".
  assert.equal(checkAssetScope('https://site.test/files/x.pdf', scope).allowed, true);
});

// --------------------------------------------------------------------------
// Naming
// --------------------------------------------------------------------------

test('flatAssetName folds the path in and keeps one real extension', () => {
  assert.equal(
    flatAssetName('https://ontheline.trincoll.edu/images/bookdown/sample-local-pdf.pdf', 'pdf'),
    'images-bookdown-sample-local-pdf.pdf'
  );
  assert.equal(flatAssetName('https://x.test/a/b/report.PDF', 'pdf'), 'a-b-report.pdf');
  // Extension supplied from a Content-Type when the URL carries none.
  assert.equal(flatAssetName('https://x.test/download', 'pdf'), 'download.pdf');
  assert.equal(flatAssetName('https://x.test/download', ''), 'download');
  assert.equal(flatAssetName('https://x.test/f.pdf?v=2', 'pdf'), 'f_q_v-2.pdf');
});

test('FlatNames keeps two assets that flatten onto one name apart', () => {
  const names = new FlatNames(flatAssetName);
  const first = names.assign('https://x.test/a/b.pdf', 'pdf');
  const second = names.assign('https://x.test/a-b.pdf', 'pdf');
  assert.equal(first, 'a-b.pdf');
  assert.notEqual(second, first);
  assert.ok(second.endsWith('.pdf'), 'the loser of a collision still opens as a PDF');
  // Asking again is idempotent, so a resumed crawl keeps its own file.
  assert.equal(names.assign('https://x.test/a/b.pdf', 'pdf'), first);
});

test('FlatNames disambiguates even when the name has no extension at all', () => {
  const names = new FlatNames(flatAssetName);
  const first = names.assign('https://x.test/a/b', '');
  const second = names.assign('https://x.test/a-b', '');
  assert.equal(first, 'a-b');
  assert.notEqual(second, first);
  assert.ok(!second.includes('undefined') && !second.startsWith('-'));
});

// --------------------------------------------------------------------------
// Queueing
// --------------------------------------------------------------------------

/** A downloader wired to a throwaway directory, with the network never used. */
function makeDownloader(overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-assets-'));
  const recorded = { assets: [], skipped: [], failed: [] };
  const report = {
    recordAsset: (entry) => recorded.assets.push(entry),
    recordAssetSkipped: (url, reason) => recorded.skipped.push({ url, reason }),
    recordAssetFailed: (entry) => recorded.failed.push(entry),
  };
  const config = {
    startUrl: 'https://site.test/',
    assetMode: 'linked',
    assetExtensions: resolveAssetExtensions(['documents']),
    excludePatterns: [],
    maxAssets: 1000,
    assetConcurrency: 2,
    maxAssetBytes: 100 * 1024 * 1024,
    maxRetries: 0,
    retryDelayMs: 1,
    timeoutMs: 10000,
    followRedirects: true,
    overwrite: false,
    userAgent: 'web-archiver-test',
    ...overrides,
  };
  const downloader = new AssetDownloader({
    config,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    report,
    rateLimiter: { acquire: async () => {}, backOff() {} },
    robots: null,
    directory,
    reportDirectory: directory,
  });
  return { downloader, recorded, directory };
}

test('enqueue accepts an enabled file type and rejects a page', () => {
  const { downloader } = makeDownloader();
  assert.equal(downloader.enqueue('https://site.test/docs/a.pdf', 'https://site.test/'), true);
  assert.equal(downloader.enqueue('https://site.test/about', 'https://site.test/'), false);
  assert.equal(downloader.enqueue('https://site.test/logo.png', 'https://site.test/'), false);
  assert.equal(downloader.pendingCount, 1);
});

test('enqueue records every page that links the same file, exactly once', () => {
  const { downloader } = makeDownloader();
  assert.equal(downloader.enqueue('https://site.test/a.pdf', 'https://site.test/one'), true);
  assert.equal(downloader.enqueue('https://site.test/a.pdf', 'https://site.test/two'), false);
  assert.equal(downloader.pendingCount, 1);
  assert.deepEqual(downloader.queued.get('https://site.test/a.pdf').sources, [
    'https://site.test/one',
    'https://site.test/two',
  ]);
});

test('enqueue stops at --max-assets and says why', () => {
  const { downloader, recorded } = makeDownloader({ maxAssets: 2 });
  downloader.enqueue('https://site.test/a.pdf', 'https://site.test/');
  downloader.enqueue('https://site.test/b.pdf', 'https://site.test/');
  assert.equal(downloader.enqueue('https://site.test/c.pdf', 'https://site.test/'), false);
  assert.deepEqual(recorded.skipped, [
    { url: 'https://site.test/c.pdf', reason: 'asset-budget-reached' },
  ]);
});

test('enqueueByContentType stays inside the selection the user asked for', () => {
  const { downloader } = makeDownloader();
  // A PDF behind an extension-less URL is exactly what this path is for.
  assert.equal(
    downloader.enqueueByContentType('https://site.test/download?id=42', 'application/pdf', 'p'),
    true
  );
  // A ZIP is a known asset type, but `--assets documents` did not ask for it.
  assert.equal(
    downloader.enqueueByContentType('https://site.test/get?id=9', 'application/zip', 'p'),
    false
  );
  assert.equal(downloader.enqueueByContentType('https://site.test/p', 'text/html', 'p'), false);
});

test('an off downloader accepts nothing', () => {
  const { downloader } = makeDownloader({ assetMode: 'off' });
  assert.equal(downloader.enabled, false);
  assert.equal(downloader.enqueue('https://site.test/a.pdf', 'https://site.test/'), false);
});

test('restore stops a resumed crawl re-downloading and renaming what it has', () => {
  const { downloader } = makeDownloader();
  downloader.restore({
    downloaded: [
      { url: 'https://site.test/a.pdf', file: 'assets/a.pdf', fileName: 'a.pdf', bytes: 10 },
    ],
    seen: ['https://site.test/skipped.pdf'],
  });
  assert.equal(downloader.downloadedCount, 1);
  assert.equal(downloader.enqueue('https://site.test/a.pdf', 'https://site.test/'), false);
  assert.equal(downloader.enqueue('https://site.test/skipped.pdf', 'https://site.test/'), false);
  assert.deepEqual([...downloader.linkMap()], [['https://site.test/a.pdf', 'a.pdf']]);
});

// --------------------------------------------------------------------------
// Downloading (against a local server, so nothing here touches the internet)
// --------------------------------------------------------------------------

const http = require('node:http');

/** Serve fixed bodies on fixed paths; resolves once listening. */
async function serve(routes) {
  const server = http.createServer((req, res) => {
    const route = routes[req.url.split('?')[0]];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'content-type': route.type, ...(route.headers || {}) });
    res.end(route.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('a file linked under two URLs is stored once and shared', async () => {
  const body = Buffer.from('%PDF-1.4 identical bytes under two names');
  const server = await serve({
    '/a.pdf': { type: 'application/pdf', body },
    '/copy/a.pdf': { type: 'application/pdf', body },
  });
  try {
    const { downloader, directory } = makeDownloader({ startUrl: `${server.origin}/` });
    downloader.enqueue(`${server.origin}/a.pdf`, `${server.origin}/`);
    downloader.enqueue(`${server.origin}/copy/a.pdf`, `${server.origin}/`);
    await downloader.drain();

    assert.equal(downloader.downloadedCount, 2, 'both URLs are archived');
    assert.equal(downloader.duplicateCount, 1, 'one of them is a duplicate');
    assert.equal(downloader.totalBytes, body.length, 'the bytes are counted once');

    const files = fs.readdirSync(directory).filter((name) => name.endsWith('.pdf'));
    assert.equal(files.length, 1, 'only one copy is on disk');
    assert.equal(fs.readdirSync(directory).filter((n) => n.endsWith('.part')).length, 0);

    // Both live URLs still rewrite to a link that resolves.
    const map = downloader.linkMap();
    assert.equal(map.size, 2);
    assert.equal(new Set(map.values()).size, 1, 'both point at the same file');
    assert.equal(map.get(`${server.origin}/copy/a.pdf`), files[0]);
  } finally {
    await server.close();
  }
});

test('two different files keep two copies', async () => {
  const server = await serve({
    '/a.pdf': { type: 'application/pdf', body: Buffer.from('%PDF one') },
    '/b.pdf': { type: 'application/pdf', body: Buffer.from('%PDF two') },
  });
  try {
    const { downloader, directory } = makeDownloader({ startUrl: `${server.origin}/` });
    downloader.enqueue(`${server.origin}/a.pdf`, null);
    downloader.enqueue(`${server.origin}/b.pdf`, null);
    await downloader.drain();

    assert.equal(downloader.duplicateCount, 0);
    assert.equal(fs.readdirSync(directory).filter((n) => n.endsWith('.pdf')).length, 2);
  } finally {
    await server.close();
  }
});

test('a file over the size limit is skipped, leaving nothing behind', async () => {
  const server = await serve({
    '/big.pdf': { type: 'application/pdf', body: Buffer.alloc(64 * 1024, 1) },
  });
  try {
    const { downloader, recorded, directory } = makeDownloader({
      startUrl: `${server.origin}/`,
      maxAssetBytes: 1024,
    });
    downloader.enqueue(`${server.origin}/big.pdf`, null);
    await downloader.drain();

    assert.equal(downloader.downloadedCount, 0);
    assert.equal(recorded.failed.length, 1);
    assert.match(recorded.failed[0].error, /size limit/);
    assert.deepEqual(fs.readdirSync(directory), [], 'no partial file is left');
  } finally {
    await server.close();
  }
});

test('a 404 is recorded once and never retried', async () => {
  const server = await serve({});
  try {
    const { downloader, recorded } = makeDownloader({ startUrl: `${server.origin}/` });
    downloader.enqueue(`${server.origin}/missing.pdf`, null);
    await downloader.drain();

    assert.equal(recorded.failed.length, 1);
    assert.equal(recorded.failed[0].error, 'HTTP 404');
  } finally {
    await server.close();
  }
});

test('the extension comes from Content-Disposition when the URL has none', async () => {
  const server = await serve({
    '/download': {
      type: 'application/pdf',
      body: Buffer.from('%PDF x'),
      headers: { 'content-disposition': 'attachment; filename="Q1 report.pdf"' },
    },
  });
  try {
    const { downloader } = makeDownloader({ startUrl: `${server.origin}/` });
    downloader.enqueueByContentType(`${server.origin}/download`, 'application/pdf', null);
    await downloader.drain();

    const entry = downloader.downloaded.get(`${server.origin}/download`);
    assert.ok(entry.fileName.endsWith('.pdf'), `got ${entry.fileName}`);
    assert.equal(entry.sha256.length, 64);
  } finally {
    await server.close();
  }
});

test('an interrupted run carries its pending downloads through a resume', () => {
  const first = makeDownloader().downloader;
  first.enqueue('https://site.test/taken.pdf', 'https://site.test/');
  first.downloaded.set('https://site.test/taken.pdf', {
    url: 'https://site.test/taken.pdf',
    fileName: 'taken.pdf',
    sources: [],
  });
  first.queued.delete('https://site.test/taken.pdf');
  first.enqueue('https://site.test/pending.pdf', 'https://site.test/library');

  const state = JSON.parse(JSON.stringify(first.toJSON()));

  const second = makeDownloader().downloader;
  second.restore(state);
  // The linking page is already in the crawl's visited set, so nothing will
  // ever offer this URL again - it has to come back with the state or be lost.
  assert.equal(second.pendingCount, 1);
  assert.deepEqual(second.queued.get('https://site.test/pending.pdf').sources, [
    'https://site.test/library',
  ]);
  assert.equal(second.downloadedCount, 1, 'what was taken is not queued again');
});

test('previewPending reports a dry run without leaving the queue growing', () => {
  const { downloader, recorded } = makeDownloader();
  downloader.enqueue('https://site.test/a.pdf', 'https://site.test/');
  downloader.enqueue('https://site.test/b.pdf', 'https://site.test/');
  assert.equal(downloader.previewPending(), 2);
  assert.equal(downloader.pendingCount, 0);
  assert.equal(recorded.assets.length, 2);
  assert.ok(recorded.assets.every((entry) => entry.dryRun && entry.file === null));
});
