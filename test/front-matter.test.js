'use strict';

// The header every Markdown document carries.
//
// Worth its own tests because it is the one part of a corpus that has to be
// machine-readable: a header whose shape depends on the page it describes is
// one that something downstream will eventually parse wrongly.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFrontMatter,
  withFrontMatter,
  stripFrontMatter,
  today,
  METHOD_DOWNLOADED,
  METHOD_CONVERTED,
} = require('../src/front-matter');

test('the block has the documented shape', () => {
  const header = buildFrontMatter({
    title: 'Essentials by AAI: Car Insurance & Home Insurance',
    url: 'https://www.essentialsbyaai.com.au/',
    fetched: '2026-08-30',
    method: METHOD_DOWNLOADED,
  });
  assert.strictEqual(
    header,
    '---\n' +
      'title: "Essentials by AAI: Car Insurance & Home Insurance"\n' +
      'url: "https://www.essentialsbyaai.com.au/"\n' +
      'fetched: 2026-08-30\n' +
      'method: "Downloaded"\n' +
      '---\n'
  );
});

test('field order is fixed, not the caller\'s key order', () => {
  // Two documents must not differ only in how their headers are arranged.
  const header = buildFrontMatter({
    method: METHOD_CONVERTED,
    fetched: '2026-08-30',
    url: 'https://x.test/p',
    title: 'T',
    description: 'D',
  });
  assert.deepStrictEqual(header.trimEnd().split('\n'), [
    '---',
    'title: "T"',
    'description: "D"',
    'url: "https://x.test/p"',
    'fetched: 2026-08-30',
    'method: "Converted"',
    '---',
  ]);
});

test('a field with no value is left out, not emitted empty', () => {
  // `title: ""` claims the page had an empty title, which is a different thing
  // from not having found one.
  const header = buildFrontMatter({ url: 'https://x.test/p', fetched: '2026-08-30' });
  assert.ok(!header.includes('title:'));
  assert.ok(!header.includes('description:'));
  assert.ok(!header.includes('method:'));
});

test('fetched defaults to today rather than being omitted', () => {
  // Every document is meant to say when it was taken; a missing date is the
  // one field that cannot be recovered later.
  assert.match(buildFrontMatter({ url: 'https://x.test/p' }), /\nfetched: \d{4}-\d{2}-\d{2}\n/);
});

test('quotes and backslashes in a title cannot break out of the value', () => {
  const header = buildFrontMatter({ title: 'He said "hi" \\ bye', fetched: '2026-08-30' });
  assert.ok(header.includes('title: "He said \\"hi\\" \\\\ bye"'));
});

test('a multi-line title is folded onto one line', () => {
  // A raw newline inside a double-quoted scalar would end the field and leave
  // the rest of the title parsed as a key.
  const header = buildFrontMatter({ title: 'First\n  second', fetched: '2026-08-30' });
  assert.ok(header.includes('title: "First second"'));
});

test('the header goes in front of the body', () => {
  const document = withFrontMatter('# Heading\n\nBody text.', {
    title: 'T',
    url: 'https://x.test/p',
    fetched: '2026-08-30',
    method: METHOD_CONVERTED,
  });
  assert.match(document, /^---\ntitle: "T"\n/);
  assert.match(document, /---\n\n# Heading\n\nBody text\.$/);
});

test('a document that already had front matter gets ours, not both', () => {
  // A site's own .md may ship a header. Two `---` blocks in one file is not
  // richer metadata, it is a file whose second block is body text.
  const source = '---\ntitle: Theirs\nlayout: post\n---\n\n# Heading\n\nBody.';
  const document = withFrontMatter(source, {
    title: 'Ours',
    fetched: '2026-08-30',
    method: METHOD_DOWNLOADED,
  });
  assert.ok(document.includes('title: "Ours"'));
  assert.ok(!document.includes('Theirs'));
  assert.ok(!document.includes('layout: post'));
  assert.strictEqual(document.match(/^---$/gm).length, 2);
});

test('a body that opens with a horizontal rule is not mistaken for front matter', () => {
  // `---` on its own is also Markdown's thematic break, and the closing fence
  // has to actually be there before anything is treated as a header.
  const source = '---\n\nJust a rule, then prose.';
  assert.strictEqual(stripFrontMatter(source), source);
});

test('an empty document still gets a header', () => {
  // Nothing else records where the file came from, so the header is the part
  // that must not be conditional.
  const document = withFrontMatter('', { url: 'https://x.test/p', fetched: '2026-08-30' });
  assert.match(document, /^---\nurl: "https:\/\/x\.test\/p"\nfetched: 2026-08-30\n---$/);
});

test('today is the local date, not the UTC one', () => {
  // At UTC+5:30 the UTC date is yesterday's until half past five in the
  // morning, and the crawl was not run yesterday.
  const date = new Date(2026, 7, 30, 2, 15);
  assert.strictEqual(today(date), '2026-08-30');
});
