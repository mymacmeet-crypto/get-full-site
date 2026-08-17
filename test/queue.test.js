'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CrawlQueue } = require('../src/queue');

test('add de-duplicates URLs', () => {
  const q = new CrawlQueue();
  assert.equal(q.add('https://example.com/', 0), true);
  assert.equal(q.add('https://example.com/', 1), false);
  assert.equal(q.pendingCount, 1);
});

test('visited URLs are never re-enqueued', () => {
  const q = new CrawlQueue();
  q.markVisited('https://example.com/a');
  assert.equal(q.add('https://example.com/a', 0), false);
  assert.equal(q.pendingCount, 0);
});

test('FIFO order with depth preserved', () => {
  const q = new CrawlQueue();
  q.add('https://example.com/a', 0);
  q.add('https://example.com/b', 1);
  assert.deepEqual(q.next(), { url: 'https://example.com/a', depth: 0, referrer: null });
  assert.deepEqual(q.next(), { url: 'https://example.com/b', depth: 1, referrer: null });
  assert.equal(q.next(), undefined);
});

test('the referring page travels with a queued URL', () => {
  // A URL that turns out to be a file rather than a page only reveals that in
  // its response headers, by which point the link it came from is long gone.
  const q = new CrawlQueue();
  q.add('https://example.com/download', 1, 'https://example.com/library');
  assert.deepEqual(q.next(), {
    url: 'https://example.com/download',
    depth: 1,
    referrer: 'https://example.com/library',
  });
});

test('serialization round-trips the full state', () => {
  const q = new CrawlQueue();
  q.add('https://example.com/a', 0);
  q.add('https://example.com/b', 2);
  q.next();
  q.markVisited('https://example.com/a');

  const restored = CrawlQueue.fromJSON(JSON.parse(JSON.stringify(q.toJSON())));
  assert.equal(restored.pendingCount, 1);
  assert.deepEqual(restored.next(), {
    url: 'https://example.com/b',
    depth: 2,
    referrer: null,
  });
  assert.equal(restored.hasVisited('https://example.com/a'), true);
  assert.equal(restored.add('https://example.com/a', 0), false);
});
