'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPageData } = require('../src/extractor');

test('extracts, resolves and normalizes anchor links', () => {
  const html = `
    <html><body>
      <a href="/a">A</a>
      <a href="b/c.html">Rel</a>
      <a href="https://other.com/x#frag">Ext</a>
      <a href="mailto:x@example.com">Mail</a>
      <a href="javascript:void(0)">JS</a>
      <a href="#top">Anchor</a>
      <a href="/a">Duplicate</a>
    </body></html>`;
  const { links } = extractPageData(html, 'https://example.com/dir/page');
  assert.deepEqual(links.sort(), [
    'https://example.com/a',
    'https://example.com/dir/b/c.html',
    'https://other.com/x',
  ]);
});

test('honors <base href> when resolving relative links', () => {
  const html = `
    <html><head><base href="https://example.com/root/"></head>
    <body><a href="child">C</a></body></html>`;
  const { links } = extractPageData(html, 'https://example.com/elsewhere/page');
  assert.deepEqual(links, ['https://example.com/root/child']);
});

test('extracts canonical URL and title', () => {
  const html = `
    <html><head>
      <title> My Page </title>
      <link rel="canonical" href="https://example.com/canonical-form/">
    </head><body></body></html>`;
  const { canonical, title } = extractPageData(html, 'https://example.com/x?utm=1');
  assert.equal(canonical, 'https://example.com/canonical-form');
  assert.equal(title, 'My Page');
});

test('malformed HTML degrades gracefully', () => {
  const { links, canonical } = extractPageData('<a href="/ok">ok<div><<<', 'https://example.com/');
  assert.deepEqual(links, ['https://example.com/ok']);
  assert.equal(canonical, null);
});
