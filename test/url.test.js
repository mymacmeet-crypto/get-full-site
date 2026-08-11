'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrl, looksLikeNonHtml, isSameDomain, checkScope } = require('../src/utils/url');

test('normalizeUrl strips fragments', () => {
  assert.equal(
    normalizeUrl('https://example.com/page#section-2'),
    'https://example.com/page'
  );
});

test('normalizeUrl lowercases host and drops default ports', () => {
  assert.equal(normalizeUrl('HTTPS://ExAmPlE.com:443/A/B'), 'https://example.com/A/B');
  assert.equal(normalizeUrl('http://example.com:80/'), 'http://example.com/');
  assert.equal(normalizeUrl('http://example.com:8080/'), 'http://example.com:8080/');
});

test('normalizeUrl strips trailing slashes except root', () => {
  assert.equal(normalizeUrl('https://example.com/about/'), 'https://example.com/about');
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/');
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com/');
});

test('normalizeUrl collapses duplicate slashes', () => {
  assert.equal(normalizeUrl('https://example.com//a///b'), 'https://example.com/a/b');
});

test('normalizeUrl sorts query parameters', () => {
  assert.equal(
    normalizeUrl('https://example.com/p?b=2&a=1'),
    normalizeUrl('https://example.com/p?a=1&b=2')
  );
});

test('normalizeUrl resolves relative URLs against a base', () => {
  assert.equal(
    normalizeUrl('../up/page.html', 'https://example.com/a/b/c'),
    'https://example.com/a/up/page.html'
  );
});

test('normalizeUrl rejects non-http schemes and garbage', () => {
  assert.equal(normalizeUrl('mailto:x@example.com'), null);
  assert.equal(normalizeUrl('javascript:void(0)'), null);
  assert.equal(normalizeUrl('not a url at all'), null);
});

test('normalizeUrl strips credentials', () => {
  assert.equal(normalizeUrl('https://user:pass@example.com/x'), 'https://example.com/x');
});

test('looksLikeNonHtml flags binary/resource extensions only', () => {
  assert.equal(looksLikeNonHtml('https://example.com/report.pdf'), true);
  assert.equal(looksLikeNonHtml('https://example.com/img/logo.PNG'), true);
  assert.equal(looksLikeNonHtml('https://example.com/page.html'), false);
  assert.equal(looksLikeNonHtml('https://example.com/page.php'), false);
  assert.equal(looksLikeNonHtml('https://example.com/about'), false);
  assert.equal(looksLikeNonHtml('https://example.com/v2.0/docs'), false);
});

test('isSameDomain treats www as equivalent and rejects other hosts', () => {
  assert.equal(isSameDomain('https://www.example.com/a', 'https://example.com'), true);
  assert.equal(isSameDomain('https://example.com/a', 'https://example.com/b'), true);
  assert.equal(isSameDomain('https://blog.example.com', 'https://example.com'), false);
  assert.equal(isSameDomain('https://evil.com', 'https://example.com'), false);
});

test('checkScope applies domain, include and exclude rules in order', () => {
  const scope = {
    startUrl: 'https://example.com/',
    sameDomainOnly: true,
    includePatterns: [/\/blog\//],
    excludePatterns: [/\/blog\/draft/],
  };
  assert.equal(checkScope('https://example.com/blog/post-1', scope).allowed, true);
  assert.equal(checkScope('https://example.com/blog/draft-x', scope).reason, 'excluded-pattern');
  assert.equal(checkScope('https://example.com/shop', scope).reason, 'no-include-match');
  assert.equal(checkScope('https://other.com/blog/post', scope).reason, 'external-domain');
  assert.equal(
    checkScope('https://example.com/blog/file.zip', scope).reason,
    'non-html-extension'
  );
});
