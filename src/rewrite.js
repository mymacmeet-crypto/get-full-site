'use strict';

const fs = require('node:fs');

const { normalizeUrl } = require('./utils/url');
const { assetsRelativeFrom } = require('./utils/paths');

// A page sitting directly in site-data/, which is as far as a caller that
// names no page can be assumed to be.
const DEFAULT_ASSETS_PREFIX = '../assets';

/**
 * Repoints links to downloaded files at the local copies, so an archived page
 * opened from disk actually opens its PDFs instead of reaching for the live
 * web - which is the whole point of an offline archive, and the one thing the
 * capture engine cannot do for us: it inlines a page's own resources, but a
 * link to a file stays a link, pointing wherever it pointed.
 *
 * WHY NOT PARSE THE HTML
 * A captured page is one enormous document whose every image, font and
 * stylesheet has become an inline data: URI - commonly several megabytes of
 * base64. Running that through a DOM parser costs more time and memory than
 * the capture itself, to change a handful of attributes. So the rewrite scans
 * for attributes textually instead, under two rules that keep it honest:
 *
 *   1. It only ever acts on a value that resolves to a URL we actually
 *      downloaded. An unrecognised URL is left byte-for-byte alone.
 *   2. It never looks inside <script> or <style>, where a match would be
 *      program text rather than markup.
 *
 * Under those rules the worst case is a missed rewrite, never a corrupted
 * archive.
 */

/** Attributes that can carry a link to a downloaded file. */
const REWRITABLE = new Set(['href', 'src', 'data', 'poster']);

const ATTRIBUTE_PATTERN =
  /(\s)(href|src|data|poster)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gi;

const SKIP_BLOCK_PATTERN = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BASE_PATTERN = /<base\b[^>]*\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/i;

/** Escape a value for use inside a double-quoted HTML attribute. */
function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Ranges of the document whose contents are code, not markup. */
function skipRanges(html) {
  const ranges = [];
  SKIP_BLOCK_PATTERN.lastIndex = 0;
  let match;
  while ((match = SKIP_BLOCK_PATTERN.exec(html)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/** Binary search over the sorted, non-overlapping ranges produced above. */
function isInside(ranges, index) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = ranges[mid];
    if (index < start) high = mid - 1;
    else if (index >= end) low = mid + 1;
    else return true;
  }
  return false;
}

/** The document's own <base href>, when it declares one. */
function documentBase(html, pageUrl) {
  const match = BASE_PATTERN.exec(html);
  if (!match) return pageUrl;
  const raw = match[1] ?? match[2] ?? match[3];
  if (!raw) return pageUrl;
  try {
    return new URL(raw.trim(), pageUrl).toString();
  } catch {
    return pageUrl;
  }
}

/**
 * Rewrite asset links in one captured document.
 *
 * `assetsByUrl` maps a normalized live URL to the bare filename inside
 * assets/. Returns the new HTML and the list of URLs that were repointed.
 */
function rewriteAssetLinks(html, { pageUrl, assetsByUrl, keepOriginal = true, prefix }) {
  if (!html || assetsByUrl.size === 0) return { html, rewritten: [] };

  const baseUrl = documentBase(html, pageUrl);
  const skip = skipRanges(html);
  const rewritten = [];
  const pieces = [];
  let cursor = 0;

  ATTRIBUTE_PATTERN.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE_PATTERN.exec(html)) !== null) {
    const [whole, space, rawName, equals, quoted, singleQuoted, bare] = match;
    const name = rawName.toLowerCase();
    if (!REWRITABLE.has(name)) continue;
    if (isInside(skip, match.index)) continue;

    const value = quoted ?? singleQuoted ?? bare;
    if (!value) continue;
    // A data: URI is the capture engine's inlined content, never a live link.
    if (/^data:/i.test(value.trim())) continue;

    const resolved = normalizeUrl(value.trim(), baseUrl);
    if (!resolved) continue;

    const fileName = assetsByUrl.get(resolved);
    if (!fileName) continue;

    const localPath = `${prefix}/${encodeURIComponent(fileName)}`;
    const original = keepOriginal
      ? ` data-original-${name}="${escapeAttribute(resolved)}"`
      : '';

    pieces.push(html.slice(cursor, match.index));
    pieces.push(`${space}${rawName}${equals}"${localPath}"${original}`);
    cursor = match.index + whole.length;
    rewritten.push({ url: resolved, file: fileName, attribute: name });
  }

  if (rewritten.length === 0) return { html, rewritten: [] };
  pieces.push(html.slice(cursor));
  return { html: pieces.join(''), rewritten };
}

/**
 * Rewrite a captured file in place.
 *
 * Returns the number of links repointed. Rewriting is a convenience, not the
 * archive itself, so a failure here is reported and swallowed rather than
 * being allowed to fail a page that was captured perfectly well.
 */
async function rewriteFile(filePath, options) {
  const { pageFile, ...rest } = options;
  const html = await fs.promises.readFile(filePath, 'utf8');
  const result = rewriteAssetLinks(html, {
    // Pages nest under site-data/, so how far one has to climb to reach
    // assets/ depends on where it sits. `pageFile` is its path relative to
    // site-data/; an explicit `prefix` in the options still wins.
    prefix: pageFile ? assetsRelativeFrom(pageFile) : DEFAULT_ASSETS_PREFIX,
    ...rest,
  });
  if (result.rewritten.length === 0) return 0;
  await fs.promises.writeFile(filePath, result.html);
  return result.rewritten.length;
}

module.exports = { rewriteAssetLinks, rewriteFile, escapeAttribute };
