'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { isNoIndex, selectRows, planWork, droppedPaths, collect } = require('../src/dataset/collect');
const { documentUrl, fetchIndex } = require('../src/dataset/source');
const {
  buildRecord,
  readDataset,
  writeDataset,
  isoFromEpoch,
  sectionOf,
  documentFilePath,
  writeDocumentFiles,
  removeDocumentFiles,
} = require('../src/dataset/dataset');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-dataset-'));
const ORIGIN = 'https://www.aem.live';

function config(overrides = {}) {
  return {
    includeNoIndex: false,
    includePatterns: [],
    excludePatterns: [],
    force: false,
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// robots column
// --------------------------------------------------------------------------

test('the robots column is read as a directive list, not a string match', () => {
  assert.equal(isNoIndex({ robots: 'noindex' }), true);
  assert.equal(isNoIndex({ robots: 'noindex, nofollow' }), true);
  assert.equal(isNoIndex({ robots: 'NOINDEX' }), true, 'case insensitive');
  assert.equal(isNoIndex({ robots: 'none' }), true, '"none" implies noindex');
  assert.equal(isNoIndex({ robots: 'index, follow' }), false);
  assert.equal(isNoIndex({ robots: '' }), false);
  assert.equal(isNoIndex({}), false, 'absent robots means indexable');
  // "nofollow" alone governs link following, not indexing: a page marked only
  // nofollow is still meant to be indexed and belongs in the corpus.
  assert.equal(isNoIndex({ robots: 'nofollow' }), false);
});

test('noindex documents are excluded by default and includable on request', () => {
  const rows = [
    { path: '/docs/real' },
    { path: '/footer', robots: 'noindex, nofollow' },
    { path: '/thank-you', robots: 'noindex' },
  ];

  const skipped = [];
  assert.deepEqual(
    selectRows(rows, config(), skipped).map((row) => row.path),
    ['/docs/real']
  );
  assert.deepEqual(
    skipped.map((entry) => entry.reason),
    ['robots-noindex', 'robots-noindex']
  );

  assert.equal(selectRows(rows, config({ includeNoIndex: true }), []).length, 3);
});

test('include and exclude patterns apply, with exclude winning', () => {
  const rows = [
    { path: '/developer/a' },
    { path: '/developer/archive/old' },
    { path: '/docs/b' },
    { path: 'not-a-path' },
  ];
  const skipped = [];
  const selected = selectRows(
    rows,
    config({
      includePatterns: [/^\/developer\//],
      excludePatterns: [/\/archive\//],
    }),
    skipped
  );

  assert.deepEqual(
    selected.map((row) => row.path),
    ['/developer/a']
  );
  const reasons = Object.fromEntries(skipped.map((entry) => [entry.path, entry.reason]));
  assert.equal(reasons['/developer/archive/old'], 'excluded-pattern');
  assert.equal(reasons['/docs/b'], 'no-include-match');
  assert.equal(reasons['not-a-path'], 'no-usable-path');
});

// --------------------------------------------------------------------------
// document URLs
// --------------------------------------------------------------------------

test('a directory path asks for its index document, not a bare extension', () => {
  // Getting this wrong loses the site's front page to a 404 that looks like a
  // missing page rather than a bug.
  assert.equal(documentUrl(ORIGIN, '/'), `${ORIGIN}/index.md`);
  assert.equal(documentUrl(ORIGIN, '/docs/'), `${ORIGIN}/docs/index.md`);
  assert.equal(documentUrl(ORIGIN, '/developer/x'), `${ORIGIN}/developer/x.md`);
  assert.equal(documentUrl(ORIGIN, '/developer/x', '.plain.html'), `${ORIGIN}/developer/x.plain.html`);
});

// --------------------------------------------------------------------------
// record shape
// --------------------------------------------------------------------------

test('epoch seconds become ISO timestamps, and nonsense becomes null', () => {
  assert.equal(isoFromEpoch(1785961301), '2026-08-05T20:21:41.000Z');
  assert.equal(isoFromEpoch(1785961301000), '2026-08-05T20:21:41.000Z', 'tolerates milliseconds');
  assert.equal(isoFromEpoch(0), null);
  assert.equal(isoFromEpoch(undefined), null);
  assert.equal(isoFromEpoch('nope'), null);
});

test('the section is the first path segment', () => {
  assert.equal(sectionOf('/developer/x'), 'developer');
  assert.equal(sectionOf('/docs/a/b'), 'docs');
  assert.equal(sectionOf('/'), '(root)');
});

test('a record carries the index metadata beside the text', () => {
  const record = buildRecord({
    row: {
      path: '/developer/aem-playground',
      title: 'Explore new AI workflows',
      description: 'A description',
      lastModified: 1785961301,
      robots: '',
      image: '/media_123.png',
    },
    origin: ORIGIN,
    text: '# Heading\n\nBody text.\n',
    sourceUrl: `${ORIGIN}/developer/aem-playground.md`,
    fetchedAt: '2026-08-24T00:00:00.000Z',
    format: 'markdown',
  });

  assert.equal(record.url, `${ORIGIN}/developer/aem-playground`);
  assert.equal(record.section, 'developer');
  assert.equal(record.title, 'Explore new AI workflows');
  assert.equal(record.lastModified, '2026-08-05T20:21:41.000Z');
  assert.equal(record.format, 'markdown');
  assert.equal(record.bytes, Buffer.byteLength('# Heading\n\nBody text.\n'));
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
  assert.equal(record.text, '# Heading\n\nBody text.\n');
  // Columns the schema does not name are kept rather than dropped.
  assert.deepEqual(record.indexFields, { image: '/media_123.png' });
});

// --------------------------------------------------------------------------
// jsonl round trip
// --------------------------------------------------------------------------

test('the dataset round-trips through JSONL, sorted by path', () => {
  const file = path.join(tmpdir(), 'dataset.jsonl');
  const make = (docPath) => ({ path: docPath, text: `text of ${docPath}`, bytes: 1 });
  writeDataset(file, [make('/z'), make('/a'), make('/m')]);

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).path),
    ['/a', '/m', '/z'],
    'sorted so two runs diff cleanly'
  );

  const read = readDataset(file);
  assert.equal(read.size, 3);
  assert.equal(read.get('/m').text, 'text of /m');
});

test('one truncated line does not cost the whole corpus', () => {
  const file = path.join(tmpdir(), 'dataset.jsonl');
  fs.writeFileSync(file, '{"path":"/a","text":"a"}\n{"path":"/b","text":"b"}\n{"path":"/c","tex');

  const read = readDataset(file);
  assert.deepEqual([...read.keys()], ['/a', '/b']);
  assert.equal(read.malformed, 1, 'the bad line is counted so the run can report it');
});

test('a missing dataset file reads as an empty corpus, not an error', () => {
  assert.equal(readDataset(path.join(tmpdir(), 'nope.jsonl')).size, 0);
});

// --------------------------------------------------------------------------
// per-document files
// --------------------------------------------------------------------------

test('a document file mirrors the site path', () => {
  assert.equal(documentFilePath('/developer/aem-playground'), path.join('developer', 'aem-playground.md'));
  assert.equal(documentFilePath('/docs/a/b/c'), path.join('docs', 'a', 'b', 'c.md'));
  assert.equal(documentFilePath('/'), 'index.md');
  assert.equal(documentFilePath('/docs/'), path.join('docs', 'index.md'));
  assert.equal(documentFilePath('/x', '.plain.html'), 'x.plain.html');
  assert.equal(documentFilePath('/already.md'), 'already.md', 'no doubled extension');
});

test('a path from the index can never write outside the output directory', () => {
  // The index is remote data. Treating its paths as filesystem paths without
  // this would let one row overwrite anything the process can reach.
  for (const evil of ['/../../etc/passwd', '/a/../../../b', '/./../x']) {
    const relative = documentFilePath(evil);
    assert.ok(!relative.includes('..'), `"${evil}" escaped: ${relative}`);
    assert.ok(!path.isAbsolute(relative), `"${evil}" became absolute: ${relative}`);
  }
});

test('segments unusable as filenames are made safe', () => {
  assert.ok(!documentFilePath('/a<b>c:d|e?f*g').includes('<'));
  // Reserved device names on Windows, and dotfile-looking segments.
  assert.equal(documentFilePath('/con'), '_con.md');
  assert.ok(!path.basename(documentFilePath('/.hidden')).startsWith('.'));
});

test('documents are written as files, and dropped ones are cleaned up', () => {
  const dir = path.join(tmpdir(), 'markdown');
  const records = [
    { path: '/developer/a', text: '# A' },
    { path: '/docs/deep/b', text: '# B' },
    { path: '/', text: '# Home' },
  ];

  const result = writeDocumentFiles(dir, records);
  assert.equal(result.files.length, 3);
  assert.equal(fs.readFileSync(path.join(dir, 'developer', 'a.md'), 'utf8'), '# A');
  assert.equal(fs.readFileSync(path.join(dir, 'docs', 'deep', 'b.md'), 'utf8'), '# B');
  assert.equal(fs.readFileSync(path.join(dir, 'index.md'), 'utf8'), '# Home');

  removeDocumentFiles(dir, ['/docs/deep/b']);
  assert.ok(!fs.existsSync(path.join(dir, 'docs', 'deep', 'b.md')));
  // The directories that file was alone in go too, rather than leaving an
  // empty tree behind.
  assert.ok(!fs.existsSync(path.join(dir, 'docs')));
  assert.ok(fs.existsSync(path.join(dir, 'developer', 'a.md')), 'siblings untouched');
});

// --------------------------------------------------------------------------
// incremental refresh
// --------------------------------------------------------------------------

test('unchanged documents are reused and changed ones re-fetched', () => {
  const existing = new Map([
    ['/a', { path: '/a', lastModified: '2026-01-01T00:00:00.000Z', text: 'old a' }],
    ['/b', { path: '/b', lastModified: '2026-01-01T00:00:00.000Z', text: 'old b' }],
  ]);
  const epoch = Date.parse('2026-01-01T00:00:00.000Z') / 1000;
  const rows = [
    { path: '/a', lastModified: epoch }, // unchanged
    { path: '/b', lastModified: epoch + 86400 }, // moved on
    { path: '/c', lastModified: epoch }, // new
  ];

  const { fetchList, reused } = planWork(rows, existing, config());
  assert.deepEqual(
    reused.map((record) => record.path),
    ['/a']
  );
  assert.deepEqual(
    fetchList.map((item) => [item.row.path, item.reason]),
    [
      ['/b', 'changed'],
      ['/c', 'new'],
    ]
  );
});

test('--force re-fetches everything, and a row with no timestamp is never assumed fresh', () => {
  const epoch = Date.parse('2026-01-01T00:00:00.000Z') / 1000;
  const existing = new Map([
    ['/a', { path: '/a', lastModified: '2026-01-01T00:00:00.000Z', text: 'old' }],
    ['/b', { path: '/b', lastModified: null, text: 'old' }],
  ]);

  assert.equal(planWork([{ path: '/a', lastModified: epoch }], existing, config()).reused.length, 1);
  assert.equal(
    planWork([{ path: '/a', lastModified: epoch }], existing, config({ force: true })).fetchList
      .length,
    1,
    '--force ignores the timestamp'
  );
  // No timestamp means no evidence of freshness, so it is re-fetched.
  assert.equal(planWork([{ path: '/b' }], existing, config()).fetchList.length, 1);
});

test('documents that left the index are dropped from the corpus', () => {
  const existing = new Map([
    ['/keep', {}],
    ['/gone', {}],
  ]);
  assert.deepEqual(droppedPaths(existing, [{ path: '/keep' }, { path: '/new' }]), ['/gone']);
});

// --------------------------------------------------------------------------
// end to end, against a loopback server
// --------------------------------------------------------------------------

/** A fake Edge Delivery site whose index and documents the test can mutate. */
function fakeSite(rows, bodies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/query-index.json') {
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || rows.length);
      const page = rows.slice(offset, offset + limit);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ columns: [], data: page, offset, limit, total: rows.length }));
      return;
    }
    const key = url.pathname.replace(/\.md$/, '');
    if (bodies[key] !== undefined) {
      res.writeHead(200, { 'content-type': 'text/markdown' });
      res.end(bodies[key]);
      return;
    }
    res.writeHead(404).end('nope');
  });
  return { server, requests };
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

function runConfig(port, output, overrides = {}) {
  return {
    siteUrl: `http://127.0.0.1:${port}/`,
    outputFolder: output,
    datasetFile: null,
    indexPath: '/query-index.json',
    extension: '.md',
    includePatterns: [],
    excludePatterns: [],
    includeNoIndex: false,
    force: false,
    dryRun: false,
    writeFiles: true,
    documentsDir: null,
    concurrency: 4,
    delayMs: 0,
    timeoutMs: 5000,
    maxRetries: 0,
    retryDelayMs: 1,
    userAgent: 'test',
    logLevel: 'silent',
    ...overrides,
  };
}

test('a collection writes every in-scope document, then reuses them on a refresh', async () => {
  const rows = [
    { path: '/docs/a', title: 'A', lastModified: 1700000000 },
    { path: '/docs/b', title: 'B', lastModified: 1700000000 },
    { path: '/footer', title: 'Footer', lastModified: 1700000000, robots: 'noindex' },
  ];
  const bodies = { '/docs/a': '# A\n\nbody a', '/docs/b': '# B\n\nbody b', '/footer': 'nav' };
  const { server, requests } = fakeSite(rows, bodies);
  const port = await listen(server);
  const output = tmpdir();

  try {
    const first = await collect(runConfig(port, output));
    assert.equal(first.documents, 2, 'the noindex row is not collected');
    assert.equal(first.fetched, 2);
    assert.equal(first.skipped, 1);
    assert.ok(!requests.some((url) => url.startsWith('/footer')), 'and is never even fetched');

    const onDisk = readDataset(first.datasetFile);
    assert.deepEqual([...onDisk.keys()], ['/docs/a', '/docs/b']);
    assert.equal(onDisk.get('/docs/a').text, '# A\n\nbody a');
    assert.equal(onDisk.get('/docs/a').title, 'A');

    // Refresh with nothing changed: the index is read, no document is.
    requests.length = 0;
    const second = await collect(runConfig(port, output));
    assert.equal(second.documents, 2);
    assert.equal(second.fetched, 0, 'nothing re-fetched');
    assert.equal(second.reused, 2);
    assert.deepEqual(
      requests.filter((url) => !url.startsWith('/query-index.json')),
      [],
      'not one document request'
    );
  } finally {
    server.close();
  }
});

test('a refresh re-fetches only what the index says changed', async () => {
  const rows = [
    { path: '/docs/a', lastModified: 1700000000 },
    { path: '/docs/b', lastModified: 1700000000 },
  ];
  const bodies = { '/docs/a': 'a v1', '/docs/b': 'b v1' };
  const { server, requests } = fakeSite(rows, bodies);
  const port = await listen(server);
  const output = tmpdir();

  try {
    await collect(runConfig(port, output));

    // /docs/b is republished; /docs/a is untouched.
    rows[1].lastModified = 1800000000;
    bodies['/docs/b'] = 'b v2';
    bodies['/docs/a'] = 'a SHOULD NOT BE REFETCHED';
    requests.length = 0;

    const refreshed = await collect(runConfig(port, output));
    assert.equal(refreshed.fetched, 1);
    assert.equal(refreshed.reused, 1);
    assert.deepEqual(
      requests.filter((url) => !url.startsWith('/query-index.json')),
      ['/docs/b.md']
    );

    const onDisk = readDataset(refreshed.datasetFile);
    assert.equal(onDisk.get('/docs/b').text, 'b v2', 'the changed one is updated');
    assert.equal(onDisk.get('/docs/a').text, 'a v1', 'the unchanged one keeps its stored text');
  } finally {
    server.close();
  }
});

test('a real collection writes the markdown files beside the dataset', async () => {
  const rows = [
    { path: '/developer/a', lastModified: 1700000000 },
    { path: '/docs/', lastModified: 1700000000 },
  ];
  const { server } = fakeSite(rows, { '/developer/a': '# A\n\nbody', '/docs/index': '# Docs' });
  const port = await listen(server);
  const output = tmpdir();

  try {
    const result = await collect(runConfig(port, output));
    assert.equal(result.documentFiles, 2);

    const dir = result.documentsDirectory;
    assert.equal(path.basename(dir), 'markdown');
    assert.equal(fs.readFileSync(path.join(dir, 'developer', 'a.md'), 'utf8'), '# A\n\nbody');
    assert.equal(fs.readFileSync(path.join(dir, 'docs', 'index.md'), 'utf8'), '# Docs');
  } finally {
    server.close();
  }
});

test('the files are rewritten even when every document was reused', async () => {
  // The text is already in hand on a refresh, so a folder deleted by hand comes
  // back rather than silently staying out of step with dataset.jsonl.
  const rows = [{ path: '/developer/a', lastModified: 1700000000 }];
  const { server } = fakeSite(rows, { '/developer/a': '# A' });
  const port = await listen(server);
  const output = tmpdir();

  try {
    const first = await collect(runConfig(port, output));
    fs.rmSync(first.documentsDirectory, { recursive: true });

    const second = await collect(runConfig(port, output));
    assert.equal(second.fetched, 0, 'nothing re-fetched');
    assert.equal(second.documentFiles, 1);
    assert.equal(fs.readFileSync(path.join(second.documentsDirectory, 'developer', 'a.md'), 'utf8'), '# A');
  } finally {
    server.close();
  }
});

test('--no-files writes only the dataset and manifest', async () => {
  const rows = [{ path: '/developer/a', lastModified: 1700000000 }];
  const { server } = fakeSite(rows, { '/developer/a': '# A' });
  const port = await listen(server);
  const output = tmpdir();

  try {
    const result = await collect(runConfig(port, output, { writeFiles: false }));
    assert.equal(result.documentFiles, 0);
    assert.equal(result.documentsDirectory, null);
    assert.deepEqual(
      fs.readdirSync(path.join(output, '127.0.0.1')).sort(),
      ['dataset-manifest.json', 'dataset.jsonl']
    );
  } finally {
    server.close();
  }
});

test('a document that leaves the index leaves the corpus', async () => {
  const rows = [
    { path: '/docs/a', lastModified: 1700000000 },
    { path: '/docs/gone', lastModified: 1700000000 },
  ];
  const { server } = fakeSite(rows, { '/docs/a': 'a', '/docs/gone': 'gone' });
  const port = await listen(server);
  const output = tmpdir();

  try {
    const first = await collect(runConfig(port, output));
    assert.equal(first.documents, 2);

    const goneFile = path.join(first.documentsDirectory, 'docs', 'gone.md');
    assert.ok(fs.existsSync(goneFile));

    rows.pop(); // unpublished
    const second = await collect(runConfig(port, output));
    assert.equal(second.documents, 1);
    assert.equal(second.removed, 1);
    assert.deepEqual([...readDataset(second.datasetFile).keys()], ['/docs/a']);
    assert.ok(!fs.existsSync(goneFile), 'its file is deleted too');
  } finally {
    server.close();
  }
});

test('a failed document does not remove the rest, and is reported', async () => {
  const rows = [
    { path: '/docs/a', lastModified: 1700000000 },
    { path: '/docs/missing', lastModified: 1700000000 },
  ];
  const { server } = fakeSite(rows, { '/docs/a': 'a' });
  const port = await listen(server);
  const output = tmpdir();

  try {
    const result = await collect(runConfig(port, output));
    assert.equal(result.documents, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual([...readDataset(result.datasetFile).keys()], ['/docs/a']);

    const manifest = JSON.parse(fs.readFileSync(result.manifestFile, 'utf8'));
    assert.equal(manifest.totals.failed, 1);
    assert.equal(manifest.failures[0].path, '/docs/missing');
  } finally {
    server.close();
  }
});

test('a dry run fetches no documents and writes no corpus', async () => {
  const rows = [{ path: '/docs/a', lastModified: 1700000000 }];
  const { server, requests } = fakeSite(rows, { '/docs/a': 'a' });
  const port = await listen(server);
  const output = tmpdir();

  try {
    const result = await collect(runConfig(port, output, { dryRun: true }));
    assert.equal(result.dryRun, true);
    assert.equal(result.datasetFile, null);
    assert.deepEqual(
      requests.filter((url) => !url.startsWith('/query-index.json')),
      [],
      'no document is fetched'
    );
    // The corpus itself is untouched - only the preview is written.
    assert.deepEqual(fs.readdirSync(path.join(output, '127.0.0.1')), [
      'dataset-manifest.dry-run.json',
    ]);
  } finally {
    server.close();
  }
});

test('a dry run leaves a preview naming every document it would collect', async () => {
  const rows = [
    { path: '/docs/a', title: 'A', lastModified: 1700000000 },
    { path: '/docs/b', title: 'B', lastModified: 1700000000 },
    { path: '/footer', lastModified: 1700000000, robots: 'noindex' },
  ];
  const { server } = fakeSite(rows, { '/docs/a': 'a', '/docs/b': 'b' });
  const port = await listen(server);
  const output = tmpdir();

  try {
    const result = await collect(runConfig(port, output, { dryRun: true }));
    const preview = JSON.parse(fs.readFileSync(result.previewFile, 'utf8'));

    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.totals, {
      wouldCollect: 2,
      wouldFetch: 2,
      wouldReuse: 0,
      wouldRemove: 0,
      skipped: 1,
    });
    assert.deepEqual(
      preview.wouldFetch.map((doc) => [doc.path, doc.reason]),
      [
        ['/docs/a', 'new'],
        ['/docs/b', 'new'],
      ]
    );
    assert.deepEqual(preview.skippedDocuments, [{ path: '/footer', reason: 'robots-noindex' }]);
    // It names where the real run would put things, so the preview answers
    // "what will this do?" without having to run it.
    assert.equal(path.basename(preview.wouldWrite.dataset), 'dataset.jsonl');
    assert.equal(path.basename(preview.wouldWrite.documents), 'markdown');
  } finally {
    server.close();
  }
});

test('a dry run never overwrites a real collection', async () => {
  const rows = [{ path: '/docs/a', lastModified: 1700000000 }];
  const { server } = fakeSite(rows, { '/docs/a': 'real text' });
  const port = await listen(server);
  const output = tmpdir();

  try {
    const real = await collect(runConfig(port, output));
    const before = fs.readFileSync(real.manifestFile, 'utf8');

    const preview = await collect(runConfig(port, output, { dryRun: true }));
    assert.notEqual(preview.previewFile, real.manifestFile);
    assert.equal(fs.readFileSync(real.manifestFile, 'utf8'), before, 'manifest untouched');
    assert.equal(readDataset(real.datasetFile).get('/docs/a').text, 'real text');
    assert.equal(
      fs.readFileSync(path.join(real.documentsDirectory, 'docs', 'a.md'), 'utf8'),
      'real text',
      'the markdown files survive too'
    );
  } finally {
    server.close();
  }
});

test('an index larger than one page is followed to the end', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    path: `/docs/p${i}`,
    lastModified: 1700000000,
  }));
  const bodies = Object.fromEntries(rows.map((row) => [row.path, `body ${row.path}`]));
  const { server } = fakeSite(rows, bodies);
  const port = await listen(server);

  try {
    const index = await fetchIndex(`http://127.0.0.1:${port}`, {
      timeoutMs: 5000,
      userAgent: 'test',
      maxRetries: 0,
      retryDelayMs: 1,
      pageSize: 5,
    });
    assert.equal(index.rows.length, 12, 'every page of the index, not just the first');
    assert.equal(index.sources.length, 3, '5 + 5 + 2');
  } finally {
    server.close();
  }
});

test('an index that is not an Edge Delivery index fails clearly', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ something: 'else' }));
  });
  const port = await listen(server);

  try {
    await assert.rejects(
      fetchIndex(`http://127.0.0.1:${port}`, {
        timeoutMs: 5000,
        userAgent: 'test',
        maxRetries: 0,
        retryDelayMs: 1,
      }),
      /has no "data" array/
    );
  } finally {
    server.close();
  }
});
