'use strict';

/**
 * URL helpers: normalization for de-duplication, scope filtering and
 * detection of non-HTML resources that should never enter the queue.
 */

// Resource extensions that are never HTML pages. Kept conservative: anything
// ambiguous (no extension, .php, .aspx, ...) is allowed through and filtered
// later by Content-Type.
const NON_HTML_EXTENSIONS = new Set([
  '7z', 'aac', 'apk', 'avi', 'avif', 'bmp', 'bz2', 'css', 'csv', 'dmg', 'doc',
  'docx', 'eot', 'epub', 'exe', 'flac', 'flv', 'gif', 'gz', 'ico', 'iso',
  'jpeg', 'jpg', 'js', 'json', 'm4a', 'm4v', 'mjs', 'mkv', 'mov', 'mp3',
  'mp4', 'mpeg', 'mpg', 'msi', 'odp', 'ods', 'odt', 'ogg', 'ogv', 'otf',
  'pdf', 'png', 'ppt', 'pptx', 'psd', 'rar', 'rss', 'rtf', 'svg', 'tar',
  'tgz', 'tif', 'tiff', 'ttf', 'txt', 'wav', 'webm', 'webp', 'wmv', 'woff',
  'woff2', 'xls', 'xlsx', 'xml', 'xz', 'zip',
]);

/**
 * Normalize a URL into a canonical string used as the de-duplication key and
 * as the URL that is actually fetched.
 *
 * - resolves relative URLs against `base`
 * - drops fragments (#...)
 * - lowercases scheme and host, strips default ports
 * - collapses duplicate slashes in the path
 * - strips trailing slashes (except the root path)
 * - sorts query parameters for stable keys
 *
 * Returns `null` for anything that is not an http(s) URL.
 */
function normalizeUrl(input, base) {
  let url;
  try {
    url = new URL(String(input).trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  url.username = '';
  url.password = '';
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }

  let pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.replace(/\/+$/, '') || '/';
  }
  url.pathname = pathname;

  if (url.search) {
    const params = [...url.searchParams.entries()].sort(
      (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])
    );
    url.search = new URLSearchParams(params).toString();
  }

  return url.toString();
}

/** True when the URL's path extension marks it as a non-HTML resource. */
function looksLikeNonHtml(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return true;
  }
  const lastSegment = pathname.split('/').pop() || '';
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = lastSegment.slice(dot + 1).toLowerCase();
  return NON_HTML_EXTENSIONS.has(ext);
}

/** True when `url` is on the same host as `referenceUrl` (or a www variant). */
function isSameDomain(url, referenceUrl) {
  try {
    const a = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const b = new URL(referenceUrl).hostname.toLowerCase().replace(/^www\./, '');
    return a === b;
  } catch {
    return false;
  }
}

/**
 * Decide whether a normalized URL is within the configured crawl scope.
 * Returns `{ allowed: boolean, reason?: string }`.
 */
function checkScope(url, { startUrl, sameDomainOnly, includePatterns, excludePatterns }) {
  if (looksLikeNonHtml(url)) return { allowed: false, reason: 'non-html-extension' };
  if (sameDomainOnly && !isSameDomain(url, startUrl)) {
    return { allowed: false, reason: 'external-domain' };
  }
  for (const pattern of excludePatterns) {
    if (pattern.test(url)) return { allowed: false, reason: 'excluded-pattern' };
  }
  if (includePatterns.length > 0 && !includePatterns.some((p) => p.test(url))) {
    return { allowed: false, reason: 'no-include-match' };
  }
  return { allowed: true };
}

module.exports = { normalizeUrl, looksLikeNonHtml, isSameDomain, checkScope };
