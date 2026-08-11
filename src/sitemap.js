'use strict';

const zlib = require('node:zlib');
const cheerio = require('cheerio');

/**
 * Sitemap discovery and parsing used to seed the crawl frontier.
 *
 * Discovery order: an explicit --sitemap URL wins; otherwise `Sitemap:`
 * directives from robots.txt (fetched only to find sitemaps - disallow rules
 * stay opt-in) plus the conventional <origin>/sitemap.xml. Sitemap index
 * files are followed recursively and .gz sitemaps are decompressed.
 *
 * Everything here is best-effort: a missing or broken sitemap never fails
 * the crawl, it just means seeding falls back to plain link discovery.
 */

const MAX_CHILD_SITEMAPS = 50;
const MAX_SITEMAP_URLS = 50_000;
const DEFAULT_PRIORITY = 0.5;

/**
 * Parse one sitemap document. Returns either
 *   { type: 'index',  children: [url, ...] }                        or
 *   { type: 'urlset', entries: [{ loc, priority, lastmod }, ...] }.
 */
function parseSitemapXml(xml) {
  let $;
  try {
    $ = cheerio.load(xml, { xmlMode: true });
  } catch {
    return { type: 'urlset', entries: [] };
  }

  if ($('sitemapindex').length > 0) {
    const children = $('sitemap > loc')
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    return { type: 'index', children };
  }

  const entries = $('url')
    .map((_, el) => {
      const $el = $(el);
      const loc = $el.children('loc').first().text().trim();
      const priorityText = $el.children('priority').first().text().trim();
      const priority = Number(priorityText);
      return {
        loc,
        priority: priorityText !== '' && Number.isFinite(priority) ? priority : DEFAULT_PRIORITY,
        lastmod: $el.children('lastmod').first().text().trim() || null,
      };
    })
    .get()
    .filter((entry) => entry.loc);

  return { type: 'urlset', entries };
}

/** Stable sort: highest <priority> first, original order among equals. */
function sortByPriority(entries) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.priority - a.entry.priority || a.index - b.index)
    .map(({ entry }) => entry);
}

/** Fetch a sitemap document, transparently decompressing .gz payloads. */
async function fetchSitemapXml(url, { timeoutMs, userAgent, logger }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': userAgent, accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5' },
    });
    if (!response.ok) {
      logger.debug(`sitemap fetch ${url}: HTTP ${response.status}`);
      return null;
    }
    const isGzipFile = new URL(response.url || url).pathname.toLowerCase().endsWith('.gz');
    if (isGzipFile) {
      const buffer = Buffer.from(await response.arrayBuffer());
      return zlib.gunzipSync(buffer).toString('utf8');
    }
    return await response.text();
  } catch (error) {
    logger.debug(`sitemap fetch ${url} failed: ${error.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Collect candidate sitemap URLs for a site. */
async function discoverSitemapUrls(startUrl, config, logger) {
  if (config.sitemapUrl) return [config.sitemapUrl];

  const origin = new URL(startUrl).origin;
  const candidates = [];

  // robots.txt is fetched here purely for its Sitemap: directives.
  const robotsTxt = await fetchSitemapXml(`${origin}/robots.txt`, {
    timeoutMs: config.timeoutMs,
    userAgent: config.userAgent,
    logger,
  });
  if (robotsTxt) {
    for (const match of robotsTxt.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
      candidates.push(match[1]);
    }
  }
  if (candidates.length === 0) candidates.push(`${origin}/sitemap.xml`);
  return candidates;
}

/**
 * Load all sitemap entries for a site.
 * Resolves with { entries, sources } where `sources` holds each successfully
 * fetched sitemap document ({ url, xml }) so callers can archive the copies.
 */
async function loadSitemapEntries(startUrl, config, logger) {
  const fetchOptions = { timeoutMs: config.timeoutMs, userAgent: config.userAgent, logger };
  const queue = await discoverSitemapUrls(startUrl, config, logger);
  const seen = new Set();
  const sources = [];
  const entries = [];

  while (queue.length > 0 && sources.length < MAX_CHILD_SITEMAPS && entries.length < MAX_SITEMAP_URLS) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    const xml = await fetchSitemapXml(url, fetchOptions);
    if (!xml) continue;

    const parsed = parseSitemapXml(xml);
    sources.push({ url, xml });
    if (parsed.type === 'index') {
      logger.debug(`sitemap index ${url}: ${parsed.children.length} child sitemap(s)`);
      queue.push(...parsed.children);
    } else {
      logger.debug(`sitemap ${url}: ${parsed.entries.length} URL(s)`);
      entries.push(...parsed.entries);
    }
  }

  if (queue.length > 0 || entries.length > MAX_SITEMAP_URLS) {
    logger.warn(
      `Sitemap traversal capped (${MAX_CHILD_SITEMAPS} files / ${MAX_SITEMAP_URLS} URLs) - ` +
        'remaining entries will still be found via link discovery.'
    );
  }

  return { entries: entries.slice(0, MAX_SITEMAP_URLS), sources };
}

module.exports = {
  parseSitemapXml,
  sortByPriority,
  loadSitemapEntries,
  MAX_CHILD_SITEMAPS,
  MAX_SITEMAP_URLS,
};
