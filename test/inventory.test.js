'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AssetInventory } = require('../src/inventory');

const SITE = 'https://site.test/';
const make = () => new AssetInventory(SITE);

/** The record for one extension, from either host table. */
function typeOf(inventory, extension, where = 'internal') {
  return inventory.toJSON().byHost[where].types.find((t) => t.extension === extension);
}

// --------------------------------------------------------------------------
// Counting
// --------------------------------------------------------------------------

test('counts an asset type whether or not it is ever downloaded', () => {
  const inventory = make();
  inventory.record('https://site.test/a.pdf', 'https://site.test/');
  inventory.record('https://site.test/b.png', 'https://site.test/');

  assert.equal(inventory.typeCount, 2);
  assert.equal(typeOf(inventory, 'pdf').urls, 1);
  assert.equal(typeOf(inventory, 'png').urls, 1);
});

test('a URL linked from many pages is one URL, not many', () => {
  const inventory = make();
  for (let i = 0; i < 40; i++) {
    inventory.record('https://site.test/report.pdf', `https://site.test/page-${i}`);
  }
  const pdf = typeOf(inventory, 'pdf');
  assert.equal(pdf.urls, 1, 'the file is counted once');
  assert.equal(pdf.linkedFromPages, 40, 'but every linking page is remembered');
});

test('a URL with no recognisable file extension is not an asset', () => {
  const inventory = make();
  assert.equal(inventory.record('https://site.test/about', 'p'), null);
  assert.equal(inventory.record('https://site.test/v1.2/guide', 'p'), null);
  // .html is a page, not a file type worth inventorying.
  assert.equal(inventory.record('https://site.test/index.html', 'p'), null);
  assert.equal(inventory.typeCount, 0);
});

test('an extension supplied by a Content-Type header is counted', () => {
  // /download?id=42 gives nothing away until its response headers arrive.
  const inventory = make();
  const url = 'https://site.test/download?id=42';
  assert.ok(inventory.record(url, 'https://site.test/', { extension: 'pdf' }));
  assert.equal(typeOf(inventory, 'pdf').urls, 1);

  // ...and the outcome still finds it, even though the URL has no extension.
  inventory.markDownloaded(url, 500);
  assert.equal(typeOf(inventory, 'pdf').downloaded, 1);
  assert.equal(typeOf(inventory, 'pdf').bytes, 500);
});

test('internal and external hosts are counted apart', () => {
  const inventory = make();
  inventory.record('https://site.test/a.pdf', 'https://site.test/');
  inventory.record('https://cdn.other.test/b.pdf', 'https://site.test/');
  inventory.record('https://files.elsewhere.test/c.pdf', 'https://site.test/');

  assert.equal(typeOf(inventory, 'pdf').urls, 1, 'one on the crawled host');
  const external = typeOf(inventory, 'pdf', 'external');
  assert.equal(external.urls, 2);
  assert.deepEqual(external.hosts, ['cdn.other.test', 'files.elsewhere.test']);
});

test('www is the same domain, not an external host', () => {
  const inventory = make();
  inventory.record('https://www.site.test/a.pdf', 'https://site.test/');
  assert.equal(typeOf(inventory, 'pdf').urls, 1);
  assert.equal(inventory.toJSON().byHost.external.types.length, 0);
});

// --------------------------------------------------------------------------
// Outcomes
// --------------------------------------------------------------------------

test('outcomes account for every URL of a type', () => {
  const inventory = make();
  for (const name of ['a', 'b', 'c', 'd']) {
    inventory.record(`https://site.test/${name}.pdf`, 'https://site.test/');
  }
  inventory.markDownloaded('https://site.test/a.pdf', 1000);
  inventory.markDownloaded('https://site.test/b.pdf', 1000, { duplicate: true });
  inventory.markFailed('https://site.test/c.pdf');
  inventory.markSkipped('https://site.test/d.pdf');

  const pdf = typeOf(inventory, 'pdf');
  assert.equal(pdf.urls, 4);
  assert.equal(pdf.downloaded + pdf.duplicate + pdf.failed + pdf.skipped, 4, 'nothing unaccounted');
  assert.equal(pdf.bytes, 1000, 'a deduplicated copy adds no bytes');
});

test('marking a URL that was never counted is harmless', () => {
  const inventory = make();
  assert.doesNotThrow(() => inventory.markDownloaded('https://site.test/never-seen.pdf', 10));
  assert.equal(inventory.typeCount, 0);
});

// --------------------------------------------------------------------------
// Serialization
// --------------------------------------------------------------------------

test('types are ordered by how many URLs each has', () => {
  const inventory = make();
  inventory.record('https://site.test/a.zip', 'p');
  for (let i = 0; i < 5; i++) inventory.record(`https://site.test/${i}.png`, 'p');
  for (let i = 0; i < 3; i++) inventory.record(`https://site.test/${i}.pdf`, 'p');

  assert.deepEqual(
    inventory.toJSON().byHost.internal.types.map((t) => t.extension),
    ['png', 'pdf', 'zip']
  );
});

test('the JSON block says what it counts, so it is not read as the filter', () => {
  const inventory = make();
  inventory.record('https://site.test/a.pdf', 'p');
  const json = inventory.toJSON();
  assert.match(json.description, /whether or not they were downloaded/);
  assert.match(json.description, /options\.assetExtensions/);
  assert.equal(json.byHost.internal.host, 'site.test');
});

test('a few sample URLs are kept per type, and only a few', () => {
  const inventory = make();
  for (let i = 0; i < 20; i++) inventory.record(`https://site.test/doc-${i}.pdf`, 'p');
  const pdf = typeOf(inventory, 'pdf');
  assert.equal(pdf.urls, 20);
  assert.equal(pdf.samples.length, 3, 'bounded, so a big site cannot balloon the report');
});

// --------------------------------------------------------------------------
// Resume
// --------------------------------------------------------------------------

test('a resumed crawl continues the tally instead of restarting it', () => {
  const first = make();
  first.record('https://site.test/a.pdf', 'https://site.test/one');
  first.record('https://site.test/b.png', 'https://site.test/one');
  first.markDownloaded('https://site.test/a.pdf', 2048);

  const state = JSON.parse(JSON.stringify(first.toState()));

  const second = make();
  second.restore(state);
  assert.equal(second.typeCount, 2);
  assert.equal(typeOf(second, 'pdf').downloaded, 1);
  assert.equal(typeOf(second, 'pdf').bytes, 2048);

  // New findings add to the restored tally.
  second.record('https://site.test/c.pdf', 'https://site.test/two');
  assert.equal(typeOf(second, 'pdf').urls, 2);
});

test('a resume does not recount a URL the first run already counted', () => {
  // The same PDF linked from an old page and a new one must stay one PDF.
  const first = make();
  first.record('https://site.test/shared.pdf', 'https://site.test/one');
  const state = JSON.parse(JSON.stringify(first.toState()));

  const second = make();
  second.restore(state);
  second.record('https://site.test/shared.pdf', 'https://site.test/two');

  assert.equal(typeOf(second, 'pdf').urls, 1, 'still one URL, not two');
});

test('a resume keeps the extension of a URL that never had one in its path', () => {
  const first = make();
  first.record('https://site.test/download?id=42', 'p', { extension: 'pdf' });
  const state = JSON.parse(JSON.stringify(first.toState()));

  const second = make();
  second.restore(state);
  // Re-deriving from the URL would find nothing; the stored extension is what
  // makes this resolvable.
  second.markDownloaded('https://site.test/download?id=42', 700);
  assert.equal(typeOf(second, 'pdf').downloaded, 1);
});

test('page counts from both runs add up', () => {
  const first = make();
  first.record('https://site.test/a.pdf', 'https://site.test/one');
  first.record('https://site.test/a.pdf', 'https://site.test/two');
  const state = JSON.parse(JSON.stringify(first.toState()));

  const second = make();
  second.restore(state);
  second.record('https://site.test/b.pdf', 'https://site.test/three');

  // A resume never revisits a page, so the two runs' pages are disjoint.
  assert.equal(typeOf(second, 'pdf').linkedFromPages, 3);
});

test('restoring nothing, or junk, leaves an empty inventory', () => {
  for (const junk of [null, undefined, {}, { tallies: {} }]) {
    const inventory = make();
    assert.doesNotThrow(() => inventory.restore(junk));
    assert.equal(inventory.typeCount, 0);
  }
});

// --------------------------------------------------------------------------
// Outcomes are per-URL, not per-call
// --------------------------------------------------------------------------

test('marking the same URL skipped repeatedly counts it once', () => {
  // AssetDownloader.enqueue() returns false both for "wrong type" and for
  // "already queued", so the crawler reaches markSkipped once per linking
  // page. A file linked from five pages is still one skipped file.
  const inventory = make();
  const url = 'https://site.test/a.png';
  inventory.record(url, 'https://site.test/one');
  for (let i = 0; i < 5; i++) inventory.markSkipped(url);

  const png = typeOf(inventory, 'png');
  assert.equal(png.urls, 1);
  assert.equal(png.skipped, 1, 'not 5');
});

test('outcomes always sum to the URL count', () => {
  const inventory = make();
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    inventory.record(`https://site.test/${name}.pdf`, 'https://site.test/');
  }
  // A realistic mix, with repeat calls of the kind the crawler really makes.
  inventory.markDownloaded('https://site.test/a.pdf', 100);
  inventory.markSkipped('https://site.test/a.pdf'); // late "already handled"
  inventory.markDownloaded('https://site.test/b.pdf', 100, { duplicate: true });
  inventory.markFailed('https://site.test/c.pdf');
  inventory.markPlanned('https://site.test/d.pdf');
  inventory.markSkipped('https://site.test/e.pdf');
  inventory.markSkipped('https://site.test/e.pdf');

  const pdf = typeOf(inventory, 'pdf');
  assert.equal(
    pdf.downloaded + pdf.duplicate + pdf.failed + pdf.skipped + pdf.planned,
    pdf.urls
  );
  assert.equal(pdf.downloaded, 1, 'a later skip cannot unmake a download');
  assert.equal(pdf.skipped, 1, 'only e.pdf');
});

test('an outcome that changes moves the count rather than adding one', () => {
  const inventory = make();
  const url = 'https://site.test/a.pdf';
  inventory.record(url, 'p');
  inventory.markPlanned(url);
  assert.equal(typeOf(inventory, 'pdf').planned, 1);

  // The same URL then really is downloaded (a dry run followed by a real one
  // inside one process, or a retry path).
  inventory.markDownloaded(url, 250);
  const pdf = typeOf(inventory, 'pdf');
  assert.equal(pdf.planned, 0, 'the old outcome is withdrawn');
  assert.equal(pdf.downloaded, 1);
  assert.equal(pdf.bytes, 250);
  assert.equal(pdf.downloaded + pdf.planned, pdf.urls);
});

test('a resume does not re-decide outcomes it already recorded', () => {
  const first = make();
  const url = 'https://site.test/a.pdf';
  first.record(url, 'https://site.test/one');
  first.markDownloaded(url, 500);
  const state = JSON.parse(JSON.stringify(first.toState()));

  const second = make();
  second.restore(state);
  // The resumed crawl meets the same URL again via a new page and declines it
  // as already handled.
  second.record(url, 'https://site.test/two');
  second.markSkipped(url);

  const pdf = typeOf(second, 'pdf');
  assert.equal(pdf.downloaded, 1);
  assert.equal(pdf.skipped, 0, 'the restored download stands');
  assert.equal(pdf.urls, 1);
});
