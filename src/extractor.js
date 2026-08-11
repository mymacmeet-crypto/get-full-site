'use strict';

const cheerio = require('cheerio');
const { normalizeUrl } = require('./utils/url');

/**
 * Extract crawl-relevant data from a fetched HTML document:
 *  - `links`: unique normalized http(s) URLs from <a href> / <area href>
 *  - `canonical`: normalized <link rel="canonical"> target, if present
 *
 * Extraction is DOM-based (cheerio), so malformed markup degrades gracefully
 * instead of throwing.
 */
function extractPageData(html, pageUrl) {
  const links = new Set();
  let canonical = null;

  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return { links: [], canonical: null, title: null };
  }

  // <base href> changes how relative links resolve.
  const baseHref = $('base[href]').attr('href');
  let baseUrl = pageUrl;
  if (baseHref) {
    try {
      baseUrl = new URL(baseHref, pageUrl).toString();
    } catch {
      /* keep pageUrl */
    }
  }

  $('a[href], area[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const trimmed = href.trim();
    if (
      !trimmed ||
      trimmed.startsWith('#') ||
      /^(javascript|mailto|tel|data|blob|ftp|file):/i.test(trimmed)
    ) {
      return;
    }
    const normalized = normalizeUrl(trimmed, baseUrl);
    if (normalized) links.add(normalized);
  });

  const canonicalHref = $('link[rel="canonical"]').first().attr('href');
  if (canonicalHref) canonical = normalizeUrl(canonicalHref, baseUrl);

  const title = ($('title').first().text() || '').trim() || null;

  return { links: [...links], canonical, title };
}

module.exports = { extractPageData };
