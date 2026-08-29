'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  flatFileName,
  nestedFileName,
  markdownSibling,
  sanitizeSegment,
  siteDir,
  reportDir,
  siteDataDir,
  assetsRelativeFrom,
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

test('site layout is exactly report/ and site-data/ under the host', () => {
  const base = path.join('C:', 'out');
  const site = siteDir('https://example.com/some/page', base);
  assert.strictEqual(site, path.join(base, 'example.com'));
  assert.strictEqual(reportDir(site), path.join(base, 'example.com', 'report'));
  assert.strictEqual(siteDataDir(site), path.join(base, 'example.com', 'site-data'));
});

test('siteDir keeps a non-default port distinguishable', () => {
  const site = siteDir('http://localhost:8080/', path.join('C:', 'out'));
  assert.strictEqual(path.basename(site), 'localhost_8080');
});

test('nestedFileName mirrors the site path instead of flattening it', () => {
  assert.strictEqual(nestedFileName('https://example.com/'), 'index.html');
  assert.strictEqual(nestedFileName('https://example.com/blog'), 'blog.html');
  assert.strictEqual(
    nestedFileName('https://example.com/blog/adapt-to-2025'),
    path.join('blog', 'adapt-to-2025.html')
  );
  // A trailing slash names a directory, whose document is its index.
  assert.strictEqual(
    nestedFileName('https://example.com/a/b/c/'),
    path.join('a', 'b', 'c', 'index.html')
  );
  // /about and /about.html are the same page, so they must be the same file.
  assert.strictEqual(nestedFileName('https://example.com/about.html'), 'about.html');
});

test('nestedFileName keeps a query string readable in the name', () => {
  assert.strictEqual(nestedFileName('https://example.com/p?page=2'), 'p_q_page-2.html');
});

test('nestedFileName takes the extension it is given', () => {
  assert.strictEqual(
    nestedFileName('https://example.com/blog/post', '.md'),
    path.join('blog', 'post.md')
  );
});

test('a page HTML and Markdown differ in nothing but the extension', () => {
  const html = nestedFileName('https://example.com/blog/post');
  assert.strictEqual(markdownSibling(html), path.join('blog', 'post.md'));
});

test('markdownSibling carries a collision hash onto the Markdown file', () => {
  // What FlatNames hands the loser of a collision. Re-deriving the name from
  // the URL instead would drop the hash and let two pages share one .md.
  assert.strictEqual(markdownSibling(path.join('blog', 'post-a1b2c3.html')), path.join('blog', 'post-a1b2c3.md'));
});

test('FlatNames disambiguates nested pages without splitting a directory name', () => {
  const names = new FlatNames((url) => nestedFileName(url, '.html'));
  const first = names.assign('https://example.com/v1.2/post');
  assert.strictEqual(first, path.join('v1.2', 'post.html'));
  // The hash belongs on the filename, never inside the directory above it.
  assert.ok(first.endsWith('post.html'));
});

test('FlatNames keeps same-named pages in different directories apart', () => {
  const names = new FlatNames((url) => nestedFileName(url, '.html'));
  const blog = names.assign('https://example.com/blog/post');
  const docs = names.assign('https://example.com/docs/post');
  assert.notStrictEqual(blog, docs);
  assert.strictEqual(blog, path.join('blog', 'post.html'));
  assert.strictEqual(docs, path.join('docs', 'post.html'));
});

test('a resumed crawl re-adopts nested names by their full path', () => {
  const names = new FlatNames((url) => nestedFileName(url, '.html'));
  // Basenames would collapse these two onto "post.html" and invent a collision.
  names.restore(
    [
      { url: 'https://example.com/blog/post', file: 'site-data/blog/post.html' },
      { url: 'https://example.com/docs/post', file: 'site-data/docs/post.html' },
    ],
    (file) => file.replace(/^site-data\//, '')
  );
  assert.strictEqual(names.assign('https://example.com/blog/post'), 'blog/post.html');
  assert.strictEqual(names.assign('https://example.com/docs/post'), 'docs/post.html');
});

test('assetsRelativeFrom climbs out of however deep a page sits', () => {
  assert.strictEqual(assetsRelativeFrom('index.html'), '../assets');
  assert.strictEqual(assetsRelativeFrom(path.join('blog', 'post.html')), '../../assets');
  assert.strictEqual(
    assetsRelativeFrom(path.join('a', 'b', 'c', 'index.html')),
    '../../../../assets'
  );
});
