'use strict';

const { sleep } = require('../utils/misc');

/**
 * Source adapter for Adobe Edge Delivery Services sites - aem.live itself, and
 * anything else built on it.
 *
 * Such a site publishes two things that make a crawl unnecessary:
 *
 *   <origin>/query-index.json   every published path, with title, description,
 *                               lastModified and a robots column
 *   <path>.md                   that page as clean Markdown
 *
 * So there is no frontier, no link discovery and no browser: the index *is*
 * the list of documents, and each one is fetched directly as text.
 *
 * Measured on www.aem.live: 8.8 KB of Markdown per page against ~1.1 MB for
 * the same page captured by the browser engine - and the Markdown carried more
 * prose, not less (126 distinct words against 100), because the capture also
 * holds the nav chrome that the Markdown leaves out.
 *
 * Note this cannot reuse src/fetcher.js: that one is built for discovery and
 * deliberately cancels the body of any non-HTML response, which is exactly the
 * bytes wanted here.
 */

/** Statuses worth a retry; everything else is reported as-is. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 30_000;

/**
 * Fetch a URL as text, with retries.
 *
 * Resolves with `{ ok, status, text, contentType, bytes, error, attempts }`
 * and never rejects for a network or HTTP problem: one unreachable document
 * must not end a collection of two hundred.
 */
async function fetchText(url, options) {
  const { timeoutMs, userAgent, maxRetries, retryDelayMs, rateLimiter, onRetry = () => {} } =
    options;

  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (rateLimiter) await rateLimiter.acquire();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': userAgent, accept: 'text/markdown, text/plain, */*;q=0.5' },
      });

      if (RETRYABLE_STATUS.has(response.status) && attempt <= maxRetries) {
        lastError = `HTTP ${response.status}`;
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        if (response.body && !response.bodyUsed) response.body.cancel().catch(() => {});
        // A 429 slows the whole run down, not just this request: the limiter is
        // shared, so pushing its next slot out spaces every worker apart.
        if (retryAfter && rateLimiter) rateLimiter.backOff(retryAfter);
        await backoff(attempt, retryDelayMs, retryAfter, onRetry, url, lastError);
        continue;
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (!response.ok) {
        if (response.body && !response.bodyUsed) response.body.cancel().catch(() => {});
        return {
          ok: false,
          status: response.status,
          text: null,
          contentType,
          bytes: 0,
          error: `HTTP ${response.status}`,
          attempts: attempt,
        };
      }

      const text = await response.text();
      return {
        ok: true,
        status: response.status,
        text,
        contentType,
        bytes: Buffer.byteLength(text),
        finalUrl: response.url || url,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : error.message;
      if (attempt <= maxRetries) {
        await backoff(attempt, retryDelayMs, null, onRetry, url, lastError);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    status: 0,
    text: null,
    contentType: '',
    bytes: 0,
    error: lastError,
    attempts: maxRetries + 1,
  };
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

async function backoff(attempt, retryDelayMs, retryAfterMs, onRetry, url, reason) {
  const exponential = retryDelayMs * 2 ** (attempt - 1);
  const wait = Math.min(Math.max(retryAfterMs ?? 0, exponential), MAX_BACKOFF_MS);
  onRetry({ url, attempt, wait, reason });
  await sleep(wait);
}

/**
 * Read every row of a site's query index.
 *
 * The endpoint paginates (`?offset=&limit=`) and reports `total`, so this
 * follows it to the end rather than trusting one response to hold everything -
 * a site larger than the default page size would otherwise be silently
 * truncated, which for a dataset is the worst kind of bug: it looks like it
 * worked.
 */
async function fetchIndex(origin, options) {
  const { indexPath = '/query-index.json', pageSize = 500, logger } = options;
  const rows = [];
  const sources = [];
  let offset = 0;
  let total = null;

  for (;;) {
    const url = new URL(indexPath, origin);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(pageSize));

    const result = await fetchText(url.toString(), options);
    if (!result.ok) {
      throw new Error(`could not read ${url} - ${result.error}`);
    }

    let payload;
    try {
      payload = JSON.parse(result.text);
    } catch (error) {
      throw new Error(`${url} is not valid JSON (${error.message})`);
    }
    if (!Array.isArray(payload.data)) {
      throw new Error(`${url} has no "data" array - is this an Edge Delivery site?`);
    }

    sources.push(url.toString());
    rows.push(...payload.data);
    total = Number.isFinite(payload.total) ? payload.total : rows.length;
    if (logger) {
      logger.debug(`index page: offset=${offset} rows=${payload.data.length} total=${total}`);
    }

    // Stop on a short page as well as on the count: a server that ignores
    // `limit` would otherwise loop forever re-reading the same first page.
    if (payload.data.length === 0 || rows.length >= total) break;
    offset += payload.data.length;
  }

  return { rows, total: total ?? rows.length, sources };
}

/**
 * The URL that serves one index path as text.
 *
 * A path ending in `/` names a directory, and appending the extension to it
 * would ask for `/docs/.md`, which is a 404. The document behind it is
 * `/docs/index.md` - the same rule the site's own routing uses. The root path
 * `/` is the same case, and it is the site's front page, so getting this wrong
 * silently loses real documents rather than obviously breaking.
 */
function documentUrl(origin, docPath, extension = '.md') {
  const normalized = docPath.endsWith('/') ? `${docPath}index` : docPath;
  return new URL(`${normalized}${extension}`, origin).toString();
}

/** Fetch one document as Markdown. `docPath` is site-absolute, e.g. `/developer/x`. */
async function fetchDocument(origin, docPath, options) {
  const url = documentUrl(origin, docPath, options.extension || '.md');
  const result = await fetchText(url, options);
  return { ...result, url };
}

module.exports = { fetchIndex, fetchDocument, fetchText, documentUrl };
