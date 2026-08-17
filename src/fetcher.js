'use strict';

const { sleep } = require('./utils/misc');
const { normalizeUrl } = require('./utils/url');

/** HTTP status codes worth retrying (plus any network-level failure). */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 30_000;

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * Discovery fetcher: downloads page HTML for link extraction and status
 * checking (SingleFile performs its own browser-based fetch for archiving).
 *
 * Resolves with a result object — it never rejects for network/HTTP
 * problems, so one bad page can never take down the crawl:
 * {
 *   ok, status, finalUrl, redirected, html, contentType,
 *   error,            // message when ok === false
 *   retryAfterMs,     // set when the server asked us to slow down
 *   attempts,
 * }
 */
async function fetchPage(url, options) {
  const {
    timeoutMs,
    followRedirects,
    userAgent,
    maxRetries,
    retryDelayMs,
    onRetry = () => {},
  } = options;

  let lastError = 'unknown error';
  let retryAfterMs = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        redirect: followRedirects ? 'follow' : 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': userAgent,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        },
      });

      // Redirect handling when following is disabled: report, don't follow.
      if (!followRedirects && response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        discard(response);
        return {
          ok: false,
          status: response.status,
          finalUrl: url,
          redirected: true,
          redirectTarget: location ? normalizeUrl(location, url) : null,
          html: null,
          contentType: response.headers.get('content-type') || '',
          error: `redirect (${response.status}) not followed`,
          attempts: attempt,
        };
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt <= maxRetries) {
        retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        lastError = `HTTP ${response.status}`;
        discard(response);
        await backoff(attempt, retryDelayMs, retryAfterMs, onRetry, url, lastError);
        continue;
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const isHtml = contentType.includes('text/html') || contentType.includes('xhtml');
      const finalUrl = normalizeUrl(response.url) || url;

      if (!response.ok) {
        discard(response);
        return {
          ok: false,
          status: response.status,
          finalUrl,
          redirected: response.redirected,
          html: null,
          contentType,
          error: `HTTP ${response.status}`,
          attempts: attempt,
        };
      }

      // A non-HTML body is never read here. Discovery only needs the status
      // and content type; the bytes, if they turn out to be worth having, are
      // the asset downloader's job. Leaving the body unread would pin the
      // connection open until the response is collected.
      if (!isHtml) discard(response);

      return {
        ok: true,
        status: response.status,
        finalUrl,
        redirected: response.redirected,
        html: isHtml ? await response.text() : null,
        contentType,
        attempts: attempt,
        retryAfterMs,
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
    finalUrl: url,
    redirected: false,
    html: null,
    contentType: '',
    error: lastError,
    attempts: maxRetries + 1,
  };
}

/** Release a response whose body this crawl will never read. */
function discard(response) {
  if (response.body && !response.bodyUsed) response.body.cancel().catch(() => {});
}

async function backoff(attempt, retryDelayMs, retryAfterMs, onRetry, url, reason) {
  const exponential = retryDelayMs * 2 ** (attempt - 1);
  const wait = Math.min(Math.max(retryAfterMs ?? 0, exponential), MAX_BACKOFF_MS);
  onRetry({ url, attempt, wait, reason });
  await sleep(wait);
}

module.exports = { fetchPage, parseRetryAfter };
