'use strict';

const cheerio = require('cheerio');
const { normalizeUrl } = require('./utils/url');

/**
 * Elements that embed a file without linking to it. A PDF is as often shown in
 * an <iframe>/<embed> viewer as it is offered through an <a href>, and those
 * never appear in `links`, so they are collected separately.
 */
const EMBED_SOURCES = [
  ['iframe[src]', 'src'],
  ['embed[src]', 'src'],
  ['object[data]', 'data'],
  ['source[src]', 'src'],
  ['video[src]', 'src'],
  ['audio[src]', 'src'],
  ['track[src]', 'src'],
  ['link[rel~="alternate"][href]', 'href'],
];

const IGNORED_SCHEMES = /^(javascript|mailto|tel|sms|data|blob|ftp|file|about):/i;

/** Normalize one raw attribute value, or null when it is not a crawlable URL. */
function toUrl(raw, baseUrl) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.startsWith('#') || IGNORED_SCHEMES.test(trimmed)) return null;
  return normalizeUrl(trimmed, baseUrl);
}

/**
 * Extract crawl-relevant data from a fetched HTML document:
 *  - `links`:    unique normalized http(s) URLs from <a href> / <area href>
 *  - `embeds`:   URLs of files embedded rather than linked (iframe, embed,
 *                object, media sources) - candidates for asset download only,
 *                never for page crawling
 *  - `canonical`: normalized <link rel="canonical"> target, if present
 *
 * Extraction is DOM-based (cheerio), so malformed markup degrades gracefully
 * instead of throwing.
 */
function extractPageData(html, pageUrl) {
  const links = new Set();
  const embeds = new Set();
  let canonical = null;

  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return { links: [], embeds: [], canonical: null, title: null };
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
    const normalized = toUrl($(el).attr('href'), baseUrl);
    if (normalized) links.add(normalized);
  });

  for (const [selector, attribute] of EMBED_SOURCES) {
    $(selector).each((_, el) => {
      const normalized = toUrl($(el).attr(attribute), baseUrl);
      // A URL reachable as a normal link is already covered; keeping it out of
      // `embeds` too means each URL is classified exactly once.
      if (normalized && !links.has(normalized)) embeds.add(normalized);
    });
  }

  const canonicalHref = $('link[rel="canonical"]').first().attr('href');
  if (canonicalHref) canonical = normalizeUrl(canonicalHref, baseUrl);

  const title = ($('title').first().text() || '').trim() || null;

  return { links: [...links], embeds: [...embeds], canonical, title };
}

module.exports = { extractPageData };
