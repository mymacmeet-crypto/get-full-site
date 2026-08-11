'use strict';

const path = require('node:path');
const { shortHash } = require('./misc');

/**
 * Every archived site gets exactly one directory, holding exactly two:
 *
 *   <out>/example.com/report/      reports, archive sitemap, resume state
 *   <out>/example.com/raw-html/    one standalone HTML file per page, FLAT
 *
 * raw-html/ is deliberately flat - the site's directory structure is folded
 * into the filename instead of becoming nested folders:
 *
 *   https://example.com/              -> index.html
 *   https://example.com/about         -> about.html
 *   https://example.com/blog/post-1   -> blog-post-1.html
 *   https://example.com/a/b/c/        -> a-b-c.html
 *   https://example.com/p?page=2      -> p_q_page-2.html
 *
 * Flattening can make two different URLs want the same name (/a/b and /a-b),
 * so names are handed out through FlatNames, which appends a short URL hash to
 * the loser of any collision rather than letting one page overwrite another.
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_SEGMENT_LENGTH = 80;
const MAX_FILENAME_LENGTH = 120; // leaves room for a hash suffix and ".html"

/** Make a single path segment safe on Windows/macOS/Linux filesystems. */
function sanitizeSegment(segment) {
  let clean = segment
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    // Leading dots are stripped so page files can never masquerade as dotfiles.
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (!clean) clean = '_';
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
  if (clean.length > MAX_SEGMENT_LENGTH) {
    clean = `${clean.slice(0, MAX_SEGMENT_LENGTH)}-${shortHash(segment)}`;
  }
  return clean;
}

function decodeSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Compact readable token for a query string, hash-suffixed when truncated. */
function querySuffix(search) {
  const raw = search.replace(/^\?/, '');
  if (!raw) return '';
  let token = decodeSafe(raw).replace(/=/g, '-').replace(/&/g, '_');
  token = sanitizeSegment(token);
  if (token.length > 48) token = `${token.slice(0, 48)}-${shortHash(raw)}`;
  return `_q_${token}`;
}

/** Host token used as the per-site directory name. */
function hostSegment(url) {
  const u = new URL(url);
  return sanitizeSegment(u.hostname + (u.port ? `_${u.port}` : ''));
}

/**
 * Flat filename (no directory part) for a URL. Pure function: the same URL
 * always yields the same name, independent of what else has been archived.
 */
function flatFileName(url) {
  const u = new URL(url);
  const segments = u.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => sanitizeSegment(decodeSafe(segment)));

  let base;
  if (segments.length === 0) {
    base = 'index';
  } else {
    // Only the last segment carries a page extension worth dropping.
    segments[segments.length - 1] = segments[segments.length - 1].replace(
      /\.(html?|xhtml)$/i,
      ''
    );
    base = segments.filter(Boolean).join('-') || 'index';
  }

  let name = `${base}${querySuffix(u.search)}`;
  if (name.length > MAX_FILENAME_LENGTH) {
    name = `${name.slice(0, MAX_FILENAME_LENGTH)}-${shortHash(url)}`;
  }
  return `${name}.html`;
}

/** Directory holding everything belonging to one archived site. */
function siteDir(startUrl, baseDir) {
  return path.join(baseDir, hostSegment(startUrl));
}

function reportDir(siteDirectory) {
  return path.join(siteDirectory, 'report');
}

function rawHtmlDir(siteDirectory) {
  return path.join(siteDirectory, 'raw-html');
}

/**
 * Hands out unique flat filenames within one raw-html/ directory.
 *
 * Asking twice for the same URL returns the same name, so a resumed crawl or a
 * retried page keeps writing to the file it already owns.
 */
class FlatNames {
  constructor() {
    this._byUrl = new Map(); // url -> filename
    this._byName = new Map(); // filename -> url
  }

  /** Reserve (or recall) the filename for `url`. */
  assign(url) {
    const existing = this._byUrl.get(url);
    if (existing) return existing;

    const preferred = flatFileName(url);
    let name = preferred;
    const owner = this._byName.get(name);
    if (owner && owner !== url) {
      // Distinct URLs flattened onto one name: disambiguate deterministically.
      const dot = preferred.lastIndexOf('.');
      name = `${preferred.slice(0, dot)}-${shortHash(url)}${preferred.slice(dot)}`;
      let counter = 2;
      while (this._byName.has(name) && this._byName.get(name) !== url) {
        name = `${preferred.slice(0, dot)}-${shortHash(url)}-${counter++}${preferred.slice(dot)}`;
      }
    }
    this._byUrl.set(url, name);
    this._byName.set(name, url);
    return name;
  }

  /** Re-adopt names from a resumed crawl so they are never reissued. */
  restore(pairs) {
    for (const { url, file } of pairs) {
      if (!url || !file) continue;
      const name = path.basename(file);
      this._byUrl.set(url, name);
      this._byName.set(name, url);
    }
  }
}

module.exports = {
  flatFileName,
  sanitizeSegment,
  hostSegment,
  siteDir,
  reportDir,
  rawHtmlDir,
  FlatNames,
};
