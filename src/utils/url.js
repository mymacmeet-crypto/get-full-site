'use strict';

/**
 * URL helpers: normalization for de-duplication, scope filtering, and the
 * classification that decides whether a link is a page to crawl, a file to
 * download, or neither.
 */

/**
 * Downloadable resource extensions, grouped so `--assets` can name a group
 * instead of spelling out thirty extensions.
 *
 * `documents` is the default group: it is what people mean by "the PDFs and
 * spreadsheets linked from the site", and it is the one group where losing a
 * file loses information the HTML archive cannot reconstruct.
 */
const ASSET_GROUPS = Object.freeze({
  documents: [
    'pdf', 'doc', 'docx', 'dot', 'dotx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx',
    'pps', 'ppsx', 'csv', 'tsv', 'txt', 'rtf', 'odt', 'ods', 'odp', 'odg',
    'epub', 'mobi', 'djvu', 'ps', 'tex',
  ],
  archives: [
    '7z', 'bz2', 'dmg', 'gz', 'iso', 'rar', 'tar', 'tgz', 'xz', 'zip',
    'apk', 'exe', 'msi', 'deb', 'rpm',
  ],
  media: [
    'aac', 'avi', 'avif', 'bmp', 'flac', 'flv', 'gif', 'ico', 'jpeg', 'jpg',
    'm4a', 'm4v', 'mkv', 'mov', 'mp3', 'mp4', 'mpeg', 'mpg', 'ogg', 'ogv',
    'opus', 'png', 'psd', 'svg', 'tif', 'tiff', 'wav', 'webm', 'webp', 'wmv',
  ],
  code: [
    'css', 'eot', 'js', 'json', 'map', 'mjs', 'otf', 'rss', 'ttf', 'woff',
    'woff2', 'xml', 'yaml', 'yml',
  ],
});

/** Every known asset extension, whatever group it belongs to. */
const ALL_ASSET_EXTENSIONS = new Set(Object.values(ASSET_GROUPS).flat());

// Resource extensions that are never HTML pages. Kept conservative: anything
// ambiguous (no extension, .php, .aspx, ...) is allowed through and filtered
// later by Content-Type.
const NON_HTML_EXTENSIONS = ALL_ASSET_EXTENSIONS;

/**
 * Content types that mark a response as a downloadable file rather than a
 * page, mapped to the extension to save it under. Consulted for URLs that
 * carry no usable extension - `/download?id=42` serving a PDF is common
 * enough that extension-only detection would quietly lose those files.
 */
const CONTENT_TYPE_EXTENSIONS = Object.freeze({
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/rtf': 'rtf',
  'application/epub+zip': 'epub',
  'application/zip': 'zip',
  'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'text/csv': 'csv',
  'text/tab-separated-values': 'tsv',
  'text/plain': 'txt',
});

/** The group a content type belongs to, or null when it is not an asset. */
function groupForContentType(contentType) {
  const extension = CONTENT_TYPE_EXTENSIONS[String(contentType).split(';')[0].trim().toLowerCase()];
  return extension ? { group: groupForExtension(extension), extension } : null;
}

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

/**
 * Lowercased file extension of a URL's last path segment, or '' when it has
 * none. A leading dot ('.htaccess') is not an extension.
 */
function urlExtension(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return '';
  }
  const lastSegment = pathname.split('/').pop() || '';
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0) return '';
  const extension = lastSegment.slice(dot + 1).toLowerCase();
  // Guard against a dot inside a path segment that is not a suffix at all,
  // e.g. /v1.2/getting-started.
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : '';
}

/** Which asset group an extension belongs to, or null when it is not one. */
function groupForExtension(extension) {
  for (const [group, extensions] of Object.entries(ASSET_GROUPS)) {
    if (extensions.includes(extension)) return group;
  }
  return null;
}

/** True when the URL's path extension marks it as a non-HTML resource. */
function looksLikeNonHtml(url) {
  const extension = urlExtension(url);
  return extension ? NON_HTML_EXTENSIONS.has(extension) : false;
}

/**
 * Classify a URL against the enabled asset extensions.
 * Returns `{ isAsset, extension, group }`.
 */
function classifyAsset(url, enabledExtensions) {
  const extension = urlExtension(url);
  if (!extension) return { isAsset: false, extension: '', group: null };
  return {
    isAsset: enabledExtensions.has(extension),
    extension,
    group: groupForExtension(extension),
  };
}

/**
 * Resolve the `--assets` selection into the set of extensions to download.
 *
 * Accepts group names ('documents', 'media', ...), the shorthands 'all' and
 * 'none', and bare extensions ('pdf', '.pdf') so a one-off addition does not
 * need a whole group. Throws on an unrecognised token rather than silently
 * archiving less than the caller asked for.
 */
function resolveAssetExtensions(groups, extraExtensions = []) {
  const extensions = new Set();
  for (const raw of groups) {
    const token = String(raw).trim().toLowerCase().replace(/^\./, '');
    if (!token || token === 'none') continue;
    if (token === 'all') {
      for (const extension of ALL_ASSET_EXTENSIONS) extensions.add(extension);
      continue;
    }
    if (ASSET_GROUPS[token]) {
      for (const extension of ASSET_GROUPS[token]) extensions.add(extension);
      continue;
    }
    if (/^[a-z0-9]{1,8}$/.test(token)) {
      extensions.add(token);
      continue;
    }
    throw new Error(
      `Unknown --assets value "${raw}". Use one of: ` +
        `${Object.keys(ASSET_GROUPS).join(', ')}, all, none, or a bare extension like "pdf".`
    );
  }
  for (const raw of extraExtensions) {
    const token = String(raw).trim().toLowerCase().replace(/^\./, '');
    if (token) extensions.add(token);
  }
  return extensions;
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

/**
 * Decide whether an asset URL may be downloaded.
 *
 * Deliberately not the same rule as `checkScope`: `--include` narrows which
 * *pages* are worth crawling, and applying it to assets would drop the PDF
 * linked from an included page just because the PDF's own URL sits elsewhere.
 * `--exclude` still applies, since that flag means "never touch this".
 *
 * `mode` selects how far off-host to follow:
 *   'same'   - only the crawled host
 *   'linked' - the crawled host, plus other hosts when a crawled page links
 *              the file directly (CDN- and S3-hosted downloads)
 *   'any'    - any host
 *   'off'    - download nothing
 */
function checkAssetScope(url, { startUrl, sourceUrl, mode, excludePatterns = [] }) {
  if (mode === 'off') return { allowed: false, reason: 'assets-disabled' };
  for (const pattern of excludePatterns) {
    if (pattern.test(url)) return { allowed: false, reason: 'excluded-pattern' };
  }
  if (mode === 'any') return { allowed: true };
  if (isSameDomain(url, startUrl)) return { allowed: true };
  if (mode === 'same') return { allowed: false, reason: 'external-domain' };
  if (sourceUrl) return { allowed: true };
  return { allowed: false, reason: 'external-domain-not-linked' };
}

module.exports = {
  normalizeUrl,
  looksLikeNonHtml,
  isSameDomain,
  checkScope,
  checkAssetScope,
  classifyAsset,
  groupForContentType,
  groupForExtension,
  resolveAssetExtensions,
  urlExtension,
  ASSET_GROUPS,
  ALL_ASSET_EXTENSIONS,
  CONTENT_TYPE_EXTENSIONS,
};
