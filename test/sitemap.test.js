'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSitemapXml, sortByPriority } = require('../src/sitemap');

test('parses a urlset with loc, priority and lastmod', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url>
        <loc>https://example.com/</loc>
        <priority>1.0</priority>
        <lastmod>2026-01-15</lastmod>
      </url>
      <url>
        <loc>https://example.com/about</loc>
        <priority>0.8</priority>
      </url>
      <url><loc>https://example.com/contact</loc></url>
    </urlset>`;
  const parsed = parseSitemapXml(xml);
  assert.equal(parsed.type, 'urlset');
  assert.deepEqual(parsed.entries, [
    { loc: 'https://example.com/', priority: 1, lastmod: '2026-01-15' },
    { loc: 'https://example.com/about', priority: 0.8, lastmod: null },
    { loc: 'https://example.com/contact', priority: 0.5, lastmod: null },
  ]);
});

test('parses a sitemap index into child sitemap URLs', () => {
  const xml = `<?xml version="1.0"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
      <sitemap><loc>https://example.com/sitemap-posts.xml.gz</loc></sitemap>
    </sitemapindex>`;
  const parsed = parseSitemapXml(xml);
  assert.equal(parsed.type, 'index');
  assert.deepEqual(parsed.children, [
    'https://example.com/sitemap-pages.xml',
    'https://example.com/sitemap-posts.xml.gz',
  ]);
});

test('invalid priority values fall back to the 0.5 default', () => {
  const xml = `<urlset>
    <url><loc>https://example.com/a</loc><priority>high</priority></url>
  </urlset>`;
  assert.equal(parseSitemapXml(xml).entries[0].priority, 0.5);
});

test('entries without <loc> are dropped and bad XML degrades to empty', () => {
  const xml = `<urlset><url><priority>0.9</priority></url></urlset>`;
  assert.deepEqual(parseSitemapXml(xml).entries, []);
  assert.deepEqual(parseSitemapXml('<<< not xml >>>').entries, []);
});

test('sortByPriority is highest-first and stable among equals', () => {
  const entries = [
    { loc: 'a', priority: 0.5 },
    { loc: 'b', priority: 1.0 },
    { loc: 'c', priority: 0.5 },
    { loc: 'd', priority: 0.9 },
  ];
  assert.deepEqual(
    sortByPriority(entries).map((e) => e.loc),
    ['b', 'd', 'a', 'c']
  );
  // original array untouched
  assert.deepEqual(entries.map((e) => e.loc), ['a', 'b', 'c', 'd']);
});
