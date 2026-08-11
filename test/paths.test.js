'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  flatFileName,
  sanitizeSegment,
  siteDir,
  reportDir,
  rawHtmlDir,
  FlatNames,
} = require('../src/utils/paths');

test('flatFileName maps the site root to index.html', () => {
  assert.strictEqual(flatFileName('https://example.com/'), 'index.html');
  assert.strictEqual(flatFileName('https://example.com'), 'index.html');
});

test('flatFileName folds nested paths into one flat name', () => {
  assert.strictEqual(flatFileName('https://example.com/about'), 'about.html');
  assert.strictEqual(flatFileName('https://example.com/blog/post-1'), 'blog-post-1.html');
  assert.strictEqual(flatFileName('https://example.com/a/b/c'), 'a-b-c.html');
  assert.strictEqual(flatFileName('https://example.com/a/b/c/'), 'a-b-c.html');
});

test('flatFileName never returns a path separator', () => {
  const deep = flatFileName('https://example.com/one/two/three/four/five');
  assert.ok(!deep.includes('/'), `unexpected "/" in ${deep}`);
  assert.ok(!deep.includes('\\'), `unexpected "\\" in ${deep}`);
  assert.strictEqual(path.basename(deep), deep);
});

test('flatFileName drops a page extension only from the last segment', () => {
  assert.strictEqual(flatFileName('https://example.com/index.html'), 'index.html');
  assert.strictEqual(flatFileName('https://example.com/docs/intro.html'), 'docs-intro.html');
  assert.strictEqual(flatFileName('https://example.com/v1.0/notes'), 'v1.0-notes.html');
});

test('flatFileName encodes the query string readably', () => {
  assert.strictEqual(flatFileName('https://example.com/p?page=2'), 'p_q_page-2.html');
  assert.strictEqual(flatFileName('https://example.com/s?a=1&b=2'), 's_q_a-1_b-2.html');
});

test('flatFileName is deterministic', () => {
  const url = 'https://example.com/some/deep/page?x=1';
  assert.strictEqual(flatFileName(url), flatFileName(url));
});

test('flatFileName caps absurdly long names with a hash', () => {
  const long = `https://example.com/${'segment/'.repeat(40)}end`;
  const name = flatFileName(long);
  assert.ok(name.length <= 140, `too long: ${name.length}`);
  assert.ok(name.endsWith('.html'));
});

test('sanitizeSegment removes characters Windows rejects', () => {
  assert.strictEqual(sanitizeSegment('a:b*c?d'), 'a-b-c-d');
  assert.strictEqual(sanitizeSegment('  spaced  '), 'spaced');
  assert.strictEqual(sanitizeSegment('...hidden'), 'hidden');
  assert.strictEqual(sanitizeSegment(''), '_');
});

test('sanitizeSegment escapes reserved device names', () => {
  assert.strictEqual(sanitizeSegment('con'), '_con');
  assert.strictEqual(sanitizeSegment('COM1'), '_COM1');
});

test('FlatNames returns the same name for the same URL', () => {
  const names = new FlatNames();
  const first = names.assign('https://example.com/about');
  const second = names.assign('https://example.com/about');
  assert.strictEqual(first, second);
  assert.strictEqual(first, 'about.html');
});

test('FlatNames disambiguates two URLs that flatten alike', () => {
  const names = new FlatNames();
  const nested = names.assign('https://example.com/a/b');
  const dashed = names.assign('https://example.com/a-b');
  assert.strictEqual(nested, 'a-b.html');
  assert.notStrictEqual(dashed, nested, 'colliding URLs must not share a file');
  assert.ok(dashed.endsWith('.html'));
  assert.ok(!dashed.includes('/'));
});

test('FlatNames keeps root and /index.html apart', () => {
  const names = new FlatNames();
  const root = names.assign('https://example.com/');
  const explicit = names.assign('https://example.com/index.html');
  assert.strictEqual(root, 'index.html');
  assert.notStrictEqual(explicit, root);
});

test('FlatNames re-adopts names from a resumed crawl', () => {
  const names = new FlatNames();
  names.restore([{ url: 'https://example.com/about', file: 'raw-html/about.html' }]);
  assert.strictEqual(names.assign('https://example.com/about'), 'about.html');
  // A different URL wanting that name must now be pushed aside.
  assert.notStrictEqual(names.assign('https://example.com/about/'), 'about.html');
});

test('site layout is exactly report/ and raw-html/ under the host', () => {
  const base = path.join('C:', 'out');
  const site = siteDir('https://example.com/some/page', base);
  assert.strictEqual(site, path.join(base, 'example.com'));
  assert.strictEqual(reportDir(site), path.join(base, 'example.com', 'report'));
  assert.strictEqual(rawHtmlDir(site), path.join(base, 'example.com', 'raw-html'));
});

test('siteDir keeps a non-default port distinguishable', () => {
  const site = siteDir('http://localhost:8080/', path.join('C:', 'out'));
  assert.strictEqual(path.basename(site), 'localhost_8080');
});
