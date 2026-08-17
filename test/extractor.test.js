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

test('embedded files are collected apart from links', () => {
  const html = `
    <html><body>
      <a href="/docs/report.pdf">Download</a>
      <iframe src="/viewer/manual.pdf"></iframe>
      <object data="/spec.pdf"></object>
      <embed src="/slides.pdf">
      <video src="/clip.mp4"></video>
      <iframe src="/docs/report.pdf"></iframe>
    </body></html>`;
  const { links, embeds } = extractPageData(html, 'https://example.com/page');

  assert.deepEqual(links, ['https://example.com/docs/report.pdf']);
  assert.deepEqual(embeds.sort(), [
    'https://example.com/clip.mp4',
    'https://example.com/slides.pdf',
    'https://example.com/spec.pdf',
    'https://example.com/viewer/manual.pdf',
  ]);
});

test('a URL reachable as a link is not also reported as an embed', () => {
  const html = '<a href="/f.pdf">L</a><iframe src="/f.pdf"></iframe>';
  const { links, embeds } = extractPageData(html, 'https://example.com/');
  assert.deepEqual(links, ['https://example.com/f.pdf']);
  assert.deepEqual(embeds, [], 'classified exactly once, as a link');
});

test('embeds honour <base href> and skip non-http schemes', () => {
  const html =
    '<head><base href="https://cdn.example.com/files/"></head>' +
    '<body><iframe src="a.pdf"></iframe><iframe src="data:text/html,x"></iframe>' +
    '<iframe src="about:blank"></iframe></body>';
  const { embeds } = extractPageData(html, 'https://example.com/page');
  assert.deepEqual(embeds, ['https://cdn.example.com/files/a.pdf']);
});

test('malformed markup still yields the four expected keys', () => {
  const result = extractPageData('<html><body><a href=', 'https://example.com/');
  assert.deepEqual(Object.keys(result).sort(), ['canonical', 'embeds', 'links', 'title']);
});
