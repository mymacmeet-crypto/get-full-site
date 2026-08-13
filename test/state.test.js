'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CrawlState, STATE_FILENAME } = require('../src/state');
const { CrawlQueue } = require('../src/queue');
const { buildConfig } = require('../src/config');
const { Crawler } = require('../src/crawler');

/** Throwaway directory per test; no network and no browser involved. */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'web-archiver-state-'));
}

function saveSample(state, startUrl = 'https://example.com/') {
  const queue = new CrawlQueue();
  queue.add('https://example.com/a', 1);
  queue.markVisited(startUrl);
  state.save({
    startUrl,
    queue,
    stats: { pages: [{ url: startUrl, file: 'raw-html/index.html' }] },
    processedCount: 7,
  });
  return queue;
}

test('save/load round-trips the crawl state', () => {
  const dir = tmpDir();
  const state = new CrawlState(dir);
  saveSample(state);

  const loaded = state.load('https://example.com/');
  assert.equal(loaded.startUrl, 'https://example.com/');
  assert.equal(loaded.processedCount, 7);
  assert.deepEqual(loaded.queue.pending, [{ url: 'https://example.com/a', depth: 1 }]);
  assert.deepEqual(loaded.stats.pages[0].file, 'raw-html/index.html');
  assert.ok(loaded.savedAt, 'savedAt is stamped');
});

test('load refuses state saved for a different start URL', () => {
  const dir = tmpDir();
  const state = new CrawlState(dir);
  saveSample(state, 'https://example.com/');

  // Resuming the wrong crawl would replay another site's queue.
  assert.equal(state.load('https://other.example/'), null);
});

test('load returns null for a missing, corrupt or future-version file', () => {
  const dir = tmpDir();
  const state = new CrawlState(dir);
  assert.equal(state.load('https://example.com/'), null, 'missing');

  fs.writeFileSync(path.join(dir, STATE_FILENAME), '{not json');
  assert.equal(state.load('https://example.com/'), null, 'corrupt');

  fs.writeFileSync(
    path.join(dir, STATE_FILENAME),
    JSON.stringify({ version: 999, startUrl: 'https://example.com/' })
  );
  assert.equal(state.load('https://example.com/'), null, 'version mismatch');
});

test('clear removes the state file and tolerates it being gone', () => {
  const dir = tmpDir();
  const state = new CrawlState(dir);
  saveSample(state);
  assert.ok(fs.existsSync(path.join(dir, STATE_FILENAME)));

  state.clear();
  assert.equal(fs.existsSync(path.join(dir, STATE_FILENAME)), false);
  assert.doesNotThrow(() => state.clear(), 'clearing twice is a no-op');
});

/** Minimal config for a Crawler that never runs; output goes to a temp dir. */
function crawlerFor(outputFolder, { dryRun = false } = {}) {
  const config = buildConfig('https://example.com', {
    depth: '1',
    maxPages: '5',
    delay: '0',
    concurrency: '1',
    workers: '1',
    batch: '1',
    timeout: '5000',
    output: outputFolder,
    dryRun,
  });
  return new Crawler(config);
}

test('a dry run never writes crawl state', () => {
  const dir = tmpDir();
  const crawler = crawlerFor(dir, { dryRun: true });
  crawler._persistState();

  const stateFile = path.join(dir, 'example.com', 'report', STATE_FILENAME);
  assert.equal(fs.existsSync(stateFile), false, 'dry run must not save state');

  // Same call without --dry-run does write it, so the guard is what differs.
  crawlerFor(dir)._persistState();
  assert.ok(fs.existsSync(stateFile), 'a real run still saves state');
});

test('a completed dry run does not delete a saved crawl', () => {
  const dir = tmpDir();
  crawlerFor(dir)._persistState(); // a real crawl left a resume point behind
  const stateFile = path.join(dir, 'example.com', 'report', STATE_FILENAME);
  assert.ok(fs.existsSync(stateFile));

  // _finalize clears state when a crawl ends with nothing pending - which a
  // dry run always does, since it queues nothing. It must not clear then.
  const crawler = crawlerFor(dir, { dryRun: true });
  const write = process.stdout.write;
  process.stdout.write = () => true; // swallow the run summary
  try {
    crawler._finalize(Date.now());
  } finally {
    process.stdout.write = write;
  }

  assert.ok(fs.existsSync(stateFile), 'dry run must leave the resume point intact');
});
