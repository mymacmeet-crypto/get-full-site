'use strict';

const path = require('node:path');
const { shortHash } = require('./misc');

/**
 * Every archived site gets exactly one directory:
 *
 *   <out>/example.com/report/      reports, archive sitemap, resume state
 *   <out>/example.com/site-data/   one file per page, NESTED to mirror the URL
 *   <out>/example.com/assets/      linked files (PDFs, spreadsheets, ...), FLAT
 *
 * assets/ only appears when the crawl actually downloaded something.
 *
 * site-data/ mirrors the site's own path structure, and a page's HTML and
 * Markdown are the same name with different extensions, so the two formats sit
 * side by side and either one is findable from a URL by reading it:
 *
 *   https://example.com/              -> index.html      index.md
 *   https://example.com/about         -> about.html      about.md
 *   https://example.com/blog/post-1   -> blog/post-1.html
 *   https://example.com/a/b/c/        -> a/b/c/index.html
 *   https://example.com/p?page=2      -> p_q_page-2.html
 *
 * A page at /blog and pages under /blog/ coexist as blog.html beside a blog/
 * directory, which every filesystem this runs on allows.
 *
 * assets/ stays flat instead - a downloaded file is referenced by name from
 * pages at many different depths, so one directory keeps that link short and
 * identical from everywhere:
 *
 *   https://example.com/docs/f.pdf    -> docs-f.pdf   (in assets/)
 *
 * Either rule can make two different URLs want the same name (/a/b/c and
 * /a/b/c/ both want a/b/c/index.html; /a/b and /a-b both want a-b.pdf), so
 * names are handed out through FlatNames, which appends a short URL hash to
 * the loser of any collision rather than letting one page overwrite another.
 */

const SITE_DATA_DIRNAME = 'site-data';
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
 * Shared body of the flat-name rules: fold the path into one hyphenated token,
 * append a readable query suffix, truncate with a hash, then add `extension`.
 *
 * `stripExtension` is the pattern to drop from the final path segment before
 * the new one is added, so /a/b.pdf becomes a-b.pdf rather than a-b.pdf.pdf.
 */
function buildFlatName(url, extension, stripExtension) {
  const u = new URL(url);
  const segments = u.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => sanitizeSegment(decodeSafe(segment)));

  let base;
  if (segments.length === 0) {
    base = 'index';
  } else {
    // Only the last segment carries an extension worth dropping.
    segments[segments.length - 1] = segments[segments.length - 1].replace(stripExtension, '');
    base = segments.filter(Boolean).join('-') || 'index';
  }

  let name = `${base}${querySuffix(u.search)}`;
  if (name.length > MAX_FILENAME_LENGTH) {
    name = `${name.slice(0, MAX_FILENAME_LENGTH)}-${shortHash(url)}`;
  }
  return `${name}${extension}`;
}

/**
 * Flat filename (no directory part) for a page URL. Pure function: the same
 * URL always yields the same name, independent of what else has been archived.
 */
function flatFileName(url) {
  return buildFlatName(url, '.html', /\.(html?|xhtml)$/i);
}

/**
 * Nested relative path (directories included) for a page URL, mirroring the
 * site's own structure under site-data/.
 *
 * Pure function, like flatFileName: the same URL always yields the same path.
 * A trailing slash names a directory, whose document is its index - the same
 * rule the site's own routing uses, so /docs/ and /docs/index land together
 * rather than /docs/ silently becoming a file named after nothing.
 *
 * The extension is a parameter rather than baked in, so a page's .html and .md
 * are guaranteed to differ in nothing but that suffix.
 */
function nestedFileName(url, extension = '.html') {
  const u = new URL(url);
  const segments = u.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => sanitizeSegment(decodeSafe(segment)));

  let directories;
  let base;
  if (segments.length === 0) {
    directories = [];
    base = 'index';
  } else if (u.pathname.endsWith('/')) {
    directories = segments;
    base = 'index';
  } else {
    directories = segments.slice(0, -1);
    // Only the last segment carries an extension worth dropping, and dropping
    // it is what keeps /about and /about.html from becoming two files.
    base = segments[segments.length - 1].replace(/\.(html?|xhtml)$/i, '') || 'index';
  }

  let name = `${base}${querySuffix(u.search)}`;
  if (name.length > MAX_FILENAME_LENGTH) {
    name = `${name.slice(0, MAX_FILENAME_LENGTH)}-${shortHash(url)}`;
  }
  return path.join(...directories, `${name}${extension}`);
}

/**
 * The Markdown sibling of a page path handed out for HTML.
 *
 * Deliberately a suffix swap rather than a second trip through the naming
 * rules: a collision resolved by FlatNames put a hash in the HTML name, and
 * only a swap carries that same hash onto the Markdown file. Re-deriving it
 * would hand the .md the *unhashed* name and quietly let two pages overwrite
 * each other's Markdown while their HTML stayed correctly separate.
 */
function markdownSibling(pagePath) {
  return pagePath.replace(/\.html$/i, '') + '.md';
}

/**
 * Flat filename for a downloaded asset, keeping its real extension so the file
 * still opens in the reader's PDF viewer or spreadsheet app.
 *
 * `extension` overrides what the URL says, for the case where the URL carries
 * none and the extension came from the response's Content-Type.
 */
function flatAssetName(url, extension) {
  const suffix = String(extension || '')
    .trim()
    .replace(/^\./, '')
    .toLowerCase();
  const safeSuffix = /^[a-z0-9]{1,8}$/.test(suffix) ? `.${suffix}` : '';
  // Strip whatever extension the URL already ends in, so the one we settled on
  // is the only one on the file.
  return buildFlatName(url, safeSuffix, /\.[A-Za-z0-9]{1,8}$/);
}

/** Directory holding everything belonging to one archived site. */
function siteDir(startUrl, baseDir) {
  return path.join(baseDir, hostSegment(startUrl));
}

function reportDir(siteDirectory) {
  return path.join(siteDirectory, 'report');
}

/**
 * Directory holding the archived pages.
 *
 * Named site-data/ because it now holds two formats, not one: raw-html/ told
 * the reader the directory was HTML, which stopped being true the moment
 * --format grew a Markdown option.
 */
function siteDataDir(siteDirectory) {
  return path.join(siteDirectory, SITE_DATA_DIRNAME);
}

function assetsDir(siteDirectory) {
  return path.join(siteDirectory, 'assets');
}

/**
 * Relative path from a page in site-data/ to the assets/ directory.
 *
 * Depth-dependent now that pages nest: site-data/blog/post.html has to climb
 * two levels, site-data/index.html only one. `pagePath` is the page's path
 * relative to site-data/, exactly what FlatNames hands out.
 */
function assetsRelativeFrom(pagePath) {
  const depth = pagePath.split(/[\\/]/).length - 1;
  return `${'../'.repeat(depth + 1)}assets`;
}

/**
 * Hands out unique flat filenames within one flat directory.
 *
 * Asking twice for the same URL returns the same name, so a resumed crawl or a
 * retried page keeps writing to the file it already owns.
 *
 * `nameFor` is the pure URL -> filename rule; assets pass their own so the
 * collision handling is shared between raw-html/ and assets/ rather than
 * duplicated with a subtly different tie-break.
 */
class FlatNames {
  constructor(nameFor = flatFileName) {
    this._nameFor = nameFor;
    this._byUrl = new Map(); // url -> filename
    this._byName = new Map(); // filename -> url
  }

  /** Reserve (or recall) the filename for `url`. */
  assign(url, ...extra) {
    const existing = this._byUrl.get(url);
    if (existing) return existing;

    const preferred = this._nameFor(url, ...extra);
    let name = preferred;
    const owner = this._byName.get(name);
    if (owner && owner !== url) {
      // Distinct URLs flattened onto one name: disambiguate deterministically.
      // An asset URL can legitimately produce a name with no extension at all,
      // so the split point has to survive lastIndexOf returning -1.
      // Only a dot in the *last* segment is an extension: site-data holds
      // paths, and a directory called "v1.2" would otherwise be split through
      // the middle, turning v1.2/post.html into v1-<hash>.2/post.html.
      const lastSeparator = Math.max(preferred.lastIndexOf('/'), preferred.lastIndexOf('\\'));
      const dot = preferred.indexOf('.', lastSeparator + 1);
      const splitAt = dot > lastSeparator + 1 ? dot : -1;
      const stem = splitAt > 0 ? preferred.slice(0, splitAt) : preferred;
      const suffix = splitAt > 0 ? preferred.slice(splitAt) : '';
      name = `${stem}-${shortHash(url)}${suffix}`;
      let counter = 2;
      while (this._byName.has(name) && this._byName.get(name) !== url) {
        name = `${stem}-${shortHash(url)}-${counter++}${suffix}`;
      }
    }
    this._byUrl.set(url, name);
    this._byName.set(name, url);
    return name;
  }

  /**
   * Re-adopt names from a resumed crawl so they are never reissued.
   *
   * `pairs` carry `file` as a path relative to the *site* directory, so the
   * leading directory has to come off to get back to the name this instance
   * handed out. `toName` does that; the default suits the flat directories,
   * where the name is simply the basename.
   *
   * Getting this wrong is silent: blog/post.html and docs/post.html both
   * reduce to "post.html" under a basename rule, so a resumed crawl would
   * think they had collided and start hashing names that were already fine.
   */
  restore(pairs, toName = (file) => path.basename(file)) {
    for (const { url, file } of pairs) {
      if (!url || !file) continue;
      const name = toName(file);
      if (!name) continue;
      this._byUrl.set(url, name);
      this._byName.set(name, url);
    }
  }
}

module.exports = {
  flatFileName,
  nestedFileName,
  markdownSibling,
  flatAssetName,
  sanitizeSegment,
  hostSegment,
  siteDir,
  reportDir,
  siteDataDir,
  assetsDir,
  SITE_DATA_DIRNAME,
  assetsRelativeFrom,
  FlatNames,
};
