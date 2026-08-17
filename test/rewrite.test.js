'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { rewriteAssetLinks, escapeAttribute } = require('../src/rewrite');

const PAGE = 'https://ontheline.trincoll.edu/bookdown/index.html';
const PDF = 'https://ontheline.trincoll.edu/images/bookdown/sample-local-pdf.pdf';

const assets = () => new Map([[PDF, 'images-bookdown-sample-local-pdf.pdf']]);

const rewrite = (html, options = {}) =>
  rewriteAssetLinks(html, {
    pageUrl: PAGE,
    assetsByUrl: assets(),
    prefix: '../assets',
    ...options,
  });

test('an absolute link to a downloaded file is repointed at the local copy', () => {
  const { html, rewritten } = rewrite(`<a href="${PDF}">Sample</a>`);
  assert.equal(
    html,
    '<a href="../assets/images-bookdown-sample-local-pdf.pdf" ' +
      `data-original-href="${PDF}">Sample</a>`
  );
  assert.deepEqual(rewritten, [
    { url: PDF, file: 'images-bookdown-sample-local-pdf.pdf', attribute: 'href' },
  ]);
});

test('a relative link resolves against the page before it is matched', () => {
  const { html, rewritten } = rewrite('<a href="../images/bookdown/sample-local-pdf.pdf">S</a>');
  assert.equal(rewritten.length, 1);
  assert.ok(html.includes('href="../assets/images-bookdown-sample-local-pdf.pdf"'));
});

test('a link that differs only in fragment or query order still matches', () => {
  assert.equal(rewrite(`<a href="${PDF}#page=3">S</a>`).rewritten.length, 1);
});

test('a <base href> in the captured document is what relative links resolve against', () => {
  const html =
    '<head><base href="https://ontheline.trincoll.edu/images/bookdown/"></head>' +
    '<body><a href="sample-local-pdf.pdf">S</a></body>';
  assert.equal(rewrite(html).rewritten.length, 1);
});

test('src, data and poster attributes are rewritten as well as href', () => {
  const result = rewrite(
    `<iframe src="${PDF}"></iframe><object data="${PDF}"></object>`
  );
  assert.equal(result.rewritten.length, 2);
  assert.ok(result.html.includes('src="../assets/images-bookdown-sample-local-pdf.pdf"'));
  assert.ok(result.html.includes(`data-original-data="${PDF}"`));
});

test('keepOriginal false drops the provenance attribute but not the rewrite', () => {
  const { html } = rewrite(`<a href="${PDF}">S</a>`, { keepOriginal: false });
  assert.equal(html, '<a href="../assets/images-bookdown-sample-local-pdf.pdf">S</a>');
});

test('single-quoted and unquoted attribute values are handled', () => {
  assert.ok(rewrite(`<a href='${PDF}'>S</a>`).html.includes('href="../assets/'));
  assert.ok(rewrite(`<a href=${PDF}>S</a>`).html.includes('href="../assets/'));
});

test('anything not downloaded is left byte-for-byte alone', () => {
  const html = `<a href="https://elsewhere.test/other.pdf">O</a><a href="/about">A</a>`;
  const result = rewrite(html);
  assert.equal(result.html, html);
  assert.deepEqual(result.rewritten, []);
});

test('matches inside <script> and <style> are program text, not markup', () => {
  const html =
    `<script>var t = 'href="${PDF}"';</script>` +
    `<style>a[href="${PDF}"] { color: red }</style>` +
    `<a href="${PDF}">Real</a>`;
  const result = rewrite(html);
  assert.equal(result.rewritten.length, 1, 'only the real anchor is touched');
  assert.ok(result.html.includes(`var t = 'href="${PDF}"'`), 'the script is unchanged');
  assert.ok(result.html.includes(`a[href="${PDF}"] { color: red }`), 'the CSS is unchanged');
});

test('inlined data: URIs are never treated as live links', () => {
  const html = '<img src="data:image/png;base64,iVBORw0KGgo=">';
  assert.equal(rewrite(html).html, html);
});

test('an empty asset map short-circuits without touching the document', () => {
  const html = `<a href="${PDF}">S</a>`;
  const result = rewriteAssetLinks(html, {
    pageUrl: PAGE,
    assetsByUrl: new Map(),
    prefix: '../assets',
  });
  assert.equal(result.html, html);
  assert.deepEqual(result.rewritten, []);
});

test('a filename needing URL or HTML escaping survives the round trip', () => {
  const url = 'https://site.test/f.pdf?a=1&b=2';
  const { html } = rewriteAssetLinks(`<a href="${url}">S</a>`, {
    pageUrl: PAGE,
    assetsByUrl: new Map([['https://site.test/f.pdf?a=1&b=2', 'f q a-1_b-2.pdf']]),
    prefix: '../assets',
  });
  assert.ok(html.includes('href="../assets/f%20q%20a-1_b-2.pdf"'), 'spaces are percent-encoded');
  assert.ok(html.includes('data-original-href="https://site.test/f.pdf?a=1&amp;b=2"'));
});

test('escapeAttribute closes the obvious injection routes', () => {
  assert.equal(escapeAttribute('a"b&c<d>'), 'a&quot;b&amp;c&lt;d&gt;');
});

test('several links in one document are all rewritten, in order', () => {
  const other = 'https://ontheline.trincoll.edu/docs/second.pdf';
  const map = new Map([
    [PDF, 'images-bookdown-sample-local-pdf.pdf'],
    [other, 'docs-second.pdf'],
  ]);
  const { html, rewritten } = rewriteAssetLinks(
    `<a href="${PDF}">1</a><p>text</p><a href="${other}">2</a><a href="${PDF}">3</a>`,
    { pageUrl: PAGE, assetsByUrl: map, prefix: '../assets' }
  );
  assert.equal(rewritten.length, 3);
  assert.ok(html.includes('<p>text</p>'), 'untouched markup between matches is preserved');
  assert.equal(html.match(/\.\.\/assets\//g).length, 3);
});
