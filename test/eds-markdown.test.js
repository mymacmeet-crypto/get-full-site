'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { cleanEdsMarkdown, parseGrid, proseLength } = require('../src/eds-markdown');

const METADATA = `+------------------------------------------------------+
| Metadata                                             |
+-------------+----------------------------------------+
| Title       | Authoring and Publishing Content       |
+-------------+----------------------------------------+
| Description | How to author, preview and publish      |
|             | content using the AEM Sidekick.         |
+-------------+----------------------------------------+
| Template    | guides                                  |
+-------------+----------------------------------------+
| Nav         | /new-nav                                |
+-------------+----------------------------------------+`;

test('the grid parser reads a merged name row above differently sized rows', () => {
  const rows = parseGrid(METADATA.split('\n'));
  assert.deepStrictEqual(rows[0], ['Metadata']);
  assert.deepStrictEqual(rows[1], ['Title', 'Authoring and Publishing Content']);
  // A cell wrapped over two lines is one value, not two.
  assert.strictEqual(
    rows[2][1].replace(/\s*\n\s*/g, ' '),
    'How to author, preview and publish content using the AEM Sidekick.'
  );
});

test('title and description are offered as header fields, site configuration is not', () => {
  // The block is lifted out and handed to the caller rather than rendered here:
  // src/front-matter.js composes one header for every document, so that a
  // converted page and a downloaded one carry the same fields.
  const { markdown, metadata, fields } = cleanEdsMarkdown(`# Heading\n\n${METADATA}`, {
    fetchedAt: '2026-08-29',
  });
  assert.strictEqual(fields.title, 'Authoring and Publishing Content');
  assert.match(fields.description, /^How to author, preview and publish content/);
  assert.strictEqual(fields.fetched, '2026-08-29');
  // Nav and Template describe how the site renders the page, not what it says.
  assert.ok(!('nav' in fields), 'Nav was offered as a header field');
  assert.ok(!('template' in fields), 'Template was offered as a header field');
  assert.ok(!markdown.includes('/new-nav'), 'Nav leaked into the document');
  assert.ok(!markdown.includes('guides'), 'Template leaked into the document');
  // Still recorded, for a caller that wants them.
  assert.strictEqual(metadata.nav, '/new-nav');
  assert.ok(!/[+|]/.test(markdown), 'box drawing survived');
});

test('a real data table becomes a GFM table rather than being deleted', () => {
  // docs/sidekick-errors.md is 91% box drawing and all of it is content, so
  // "drop every box table" would have thrown the page away.
  const source = `# Errors

+-------------------------------------------------+
| Table                                           |
+-------------------------------------------------+
| +---------------------+---------------------+   |
| | **Message**         | **Likely Cause**    |   |
| +---------------------+---------------------+   |
| | File not found.     | Not shared with AEM |   |
| +---------------------+---------------------+   |
+-------------------------------------------------+`;
  const { markdown } = cleanEdsMarkdown(source, { pageUrl: 'https://x.test/errors' });
  assert.match(markdown, /\| \*\*Message\*\* \| \*\*Likely Cause\*\* \|/);
  assert.match(markdown, /\| --- \| --- \|/);
  assert.match(markdown, /\| File not found\. \| Not shared with AEM \|/);
});

test('a wrapper block is unwrapped and its component name dropped', () => {
  const source = `+----------------------------------------+
| Columns (wide)                         |
+----------------------------------------+
| ## A real heading                      |
|                                        |
| Some prose the author wrote.           |
+----------------------------------------+`;
  const { markdown } = cleanEdsMarkdown(source, { pageUrl: 'https://x.test/p' });
  assert.match(markdown, /## A real heading/);
  assert.match(markdown, /Some prose the author wrote\./);
  // "Columns" is a component name, not something the page says.
  assert.ok(!markdown.includes('Columns'));
});

test('chrome blocks go, however much they look like content', () => {
  // Pagination appears in 74 of www.aem.live's 183 documents as a two-column
  // prev/next table, which the table rule would otherwise happily keep.
  const source = `Body text.

+-------------------------------------------------+
| Pagination (contained)                          |
+-----------------------+-------------------------+
| Previous [A](/a)      | Up Next [B](/b)         |
+-----------------------+-------------------------+`;
  const { markdown, stats } = cleanEdsMarkdown(source, { pageUrl: 'https://x.test/p' });
  assert.strictEqual(markdown.trim(), 'Body text.');
  assert.strictEqual(stats.chromeBlocks, 1);
});

test('Section Metadata never shadows the document title', () => {
  // A section block carrying its own `title` appears before the document's own
  // Metadata block, so "first one wins" would put the wrong title in the file.
  const source = `+------------------+
| Section Metadata |
+---------+--------+
| title   | A slot |
+---------+--------+

+-----------------------+
| Metadata              |
+-------+---------------+
| Title | The Real Page |
+-------+---------------+`;
  const { markdown, fields } = cleanEdsMarkdown(source);
  assert.strictEqual(fields.title, 'The Real Page');
  assert.ok(!markdown.includes('A slot'));
});

test('a listing page whose blocks are filled in at render time is flagged thin', () => {
  const source = `# AEM.live Blog

+-------------+
| Feed (blog) |
+-------------+
|             |
+-------------+`;
  const { thin, stats } = cleanEdsMarkdown(source, { pageUrl: 'https://www.aem.live/blog' });
  assert.strictEqual(thin, true, 'the empty feed should send this page to conversion');
  assert.strictEqual(stats.emptyBlocks, 1);
});

test('a short page with no empty blocks is short, not thin', () => {
  // Thin means "the site renders content this document does not hold". A page
  // that is simply brief must not be re-fetched through the browser for nothing.
  const { thin } = cleanEdsMarkdown('# Contact\n\nEmail us at hello@example.com.', {
    pageUrl: 'https://x.test/contact',
  });
  assert.strictEqual(thin, false);
});

test('a plain Markdown document is passed through untouched', () => {
  // Not every site serving .md is an Edge Delivery site; one that is not must
  // not acquire front matter it never had.
  const source = '# Plain\n\nJust ordinary Markdown, no blocks anywhere.';
  const { markdown } = cleanEdsMarkdown(source, { pageUrl: 'https://x.test/p' });
  assert.strictEqual(markdown, source);
});

test('proseLength counts prose, not headings and link targets', () => {
  const listing = '# Title\n\n## Section\n\n[One](https://a.test)\n\n[Two](https://b.test)';
  const article = 'Real sentences of actual prose that a reader would come to this page for.';
  assert.ok(proseLength(listing) < proseLength(article));
});
