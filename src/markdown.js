'use strict';

const cheerio = require('cheerio');
const TurndownService = require('turndown');
const { gfm } = require('turndown-plugin-gfm');

/**
 * Turning an archived page into Markdown.
 *
 * Two sources, in this order of preference:
 *
 *   1. The site's own Markdown. Edge Delivery Services sites (aem.live and
 *      everything built on it) serve `<path>.md` as the authored source of
 *      each page. That is the real document - no nav, no chrome, no lossy
 *      round trip - so when it exists it wins outright.
 *
 *   2. Conversion of the rendered DOM. Everything else. The DOM comes from
 *      the browser *before* the capture engine inlines assets, so links and
 *      images still carry real URLs rather than megabytes of base64.
 *
 * Both paths are expected to produce the same *shape* of document - body
 * prose, no site chrome - which is why conversion extracts the main content
 * rather than converting the whole page. A corpus where half the documents
 * repeat the nav and half do not is worse than either choice made uniformly.
 */

/**
 * Elements that never carry page content, removed before anything else looks
 * at the document. `template` matters more than it appears: its contents are
 * inert markup the page may never have rendered, and Turndown cannot tell.
 */
const NON_CONTENT = [
  'script',
  'style',
  'noscript',
  'template',
  'link',
  'meta',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'textarea',
].join(',');

/**
 * Site chrome: the same words on every page of the site.
 *
 * Left in, these dominate a retrieval corpus - every document matches a query
 * about the nav rather than about its own subject.
 *
 * `header` is deliberately absent from the bare-tag entries. Inside an article
 * it is usually the title block, which is content; the *page* header sits
 * outside the content root picked below and is dropped by that instead.
 */
const CHROME = [
  'nav',
  'aside',
  'footer',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  '[role="search"]',
  '[aria-hidden="true"]',
  'header.header',
  '.nav',
  '.navbar',
  '.navigation',
  '.menu',
  '.breadcrumb',
  '.breadcrumbs',
  '.sidebar',
  '.site-header',
  '.site-footer',
  '.skip-link',
  '.cookie',
  '.cookie-banner',
  '.cookie-consent',
  '#cookie-banner',
  '#onetrust-consent-sdk',
  '.social-share',
  '.share-buttons',
].join(',');

/**
 * Where a page's own content lives, most explicit signal first.
 *
 * `main` and `[role="main"]` are the author telling us directly. `article` is
 * next because a page with one article is that article. The class and id
 * guesses below them are conventions, not standards, so they are a fallback
 * rather than the rule - and `body` is the honest last resort.
 */
const CONTENT_ROOTS = [
  'main',
  '[role="main"]',
  'article',
  '#main-content',
  '#main',
  '#content',
  '.main-content',
  '.post-content',
  '.entry-content',
  '.article-body',
];

/**
 * A content root has to actually hold the content.
 *
 * Some templates ship an empty <main> and render the article beside it. Taking
 * it on faith yields an empty document that still looks like a success, so a
 * candidate is only accepted when it carries a real amount of the page's text.
 */
const MIN_ROOT_TEXT_LENGTH = 200;
const MIN_ROOT_TEXT_SHARE = 0.25;

function textLength($, node) {
  return $(node).text().replace(/\s+/g, ' ').trim().length;
}

/** Pick the element whose subtree is the page's own content. */
function findContentRoot($) {
  const bodyLength = textLength($, 'body');
  for (const selector of CONTENT_ROOTS) {
    const candidate = $(selector).first();
    if (candidate.length === 0) continue;
    const length = textLength($, candidate);
    // On a short page the share test is the meaningful one; on a long page the
    // absolute floor is. Requiring both would reject real content on a page
    // that happens to be mostly a big footer.
    const enough =
      length >= MIN_ROOT_TEXT_LENGTH ||
      (bodyLength > 0 && length / bodyLength >= MIN_ROOT_TEXT_SHARE);
    if (enough) return candidate;
  }
  return $('body').length ? $('body') : $.root();
}

/**
 * Point every link and image at something that still resolves once the file is
 * a local .md.
 *
 * Relative URLs are made absolute against the page they came from - a Markdown
 * file two directories deep would otherwise resolve `/docs/x` against the
 * filesystem. Images inlined as data: URIs are dropped: they are the capture
 * engine's business, and a base64 payload in a text corpus is noise measured
 * in megabytes.
 */
function absolutizeUrls($, root, pageUrl) {
  if (!pageUrl) return;
  const resolve = (value) => {
    try {
      return new URL(value, pageUrl).toString();
    } catch {
      return null;
    }
  };

  root.find('a[href]').each((_, element) => {
    const link = $(element);
    const href = link.attr('href');
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return;
    const absolute = resolve(href);
    if (absolute) link.attr('href', absolute);
  });

  root.find('img').each((_, element) => {
    const image = $(element);
    // srcset never survives the conversion, and leaving it lets a later reader
    // think the Markdown lost a resolution it never actually had.
    image.removeAttr('srcset');
    image.removeAttr('loading');
    const src = image.attr('src');
    if (!src || /^data:/i.test(src)) {
      image.remove();
      return;
    }
    const absolute = resolve(src);
    if (absolute) image.attr('src', absolute);
  });
}

/**
 * Elements that cannot sit inside a Markdown link.
 *
 * A card on a listing page is usually one `<a>` wrapped around a heading, a
 * summary and an image. Turndown emits the link delimiters where the anchor
 * opens and closes, so those land on their own lines with blocks between them:
 *
 *   ](https://example.com/blog/post)[
 *
 * That is not ugly Markdown, it is broken Markdown - a stray bracket that
 * swallows whatever follows. Every card listing produces one per card.
 */
const BLOCK_LEVEL = [
  'address',
  'article',
  'aside',
  'blockquote',
  'div',
  'dl',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
].join(',');

/**
 * Rewrite anchors that wrap block content into something Markdown can express.
 *
 * The link moves onto the card's heading, which is where a reader would expect
 * it and what keeps the destination attached to the thing it names. A card
 * with no heading gets the link appended after its content instead, so the URL
 * is never simply dropped.
 */
function unwrapBlockAnchors($, root) {
  // Document order, so an outer anchor is handled before any nested one and
  // the inner element is still a live node when its turn comes.
  root.find('a[href]').each((_, element) => {
    const anchor = $(element);
    if (anchor.find(BLOCK_LEVEL).length === 0) return; // an ordinary inline link

    const href = anchor.attr('href');
    const heading = anchor.find('h1,h2,h3,h4,h5,h6').first();

    if (heading.length > 0) {
      const link = $('<a></a>').attr('href', href);
      link.append(heading.contents());
      heading.empty().append(link);
    } else if (anchor.text().trim()) {
      const trailing = $('<p></p>');
      trailing.append($('<a></a>').attr('href', href).text(href));
      anchor.append(trailing);
    }

    anchor.replaceWith(anchor.contents());
  });
}

/**
 * Drop `title` attributes that only repeat the link text.
 *
 * Turndown renders them as `[Valtech](https://... "Valtech")`. The title is
 * real information when it differs from the text and pure duplication when it
 * does not - and on a site that sets it from the link text, that is every
 * single link in the corpus.
 */
function dropEchoedTitles($, root) {
  root.find('a[title], img[title]').each((_, element) => {
    const node = $(element);
    const title = (node.attr('title') || '').trim();
    if (!title) return;
    const label = (node.is('img') ? node.attr('alt') || '' : node.text()).trim();
    if (title === label) node.removeAttr('title');
  });
}

/** A Turndown instance configured once and reused for the whole run. */
function createTurndown() {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  service.use(gfm);

  // An image with no source left after absolutizeUrls is a spacer or an icon,
  // not a picture of anything: "![]()" is pure noise in a corpus.
  service.addRule('dropSourcelessImages', {
    filter: (node) => node.nodeName === 'IMG' && !node.getAttribute('src'),
    replacement: () => '',
  });

  // A link left with nothing inside it - typically an icon link whose only
  // child was an inlined data: image that absolutizeUrls removed. "[](url)" in
  // the middle of a sentence is noise that also breaks the sentence.
  service.addRule('dropEmptyLinks', {
    filter: (node) =>
      node.nodeName === 'A' &&
      node.getAttribute('href') &&
      !node.textContent.trim() &&
      node.getElementsByTagName('img').length === 0,
    replacement: () => '',
  });

  // Turndown keeps <figcaption> as a bare paragraph glued to the image above
  // it. An explicit blank line is what makes the caption read as a caption.
  service.addRule('figcaption', {
    filter: 'figcaption',
    replacement: (content) => (content.trim() ? `\n\n${content.trim()}\n\n` : ''),
  });

  return service;
}

let turndown = null;

/**
 * Clean up the gaps that stripping elements leaves behind: runs of blank
 * lines, and the double spaces left where a removed inline image sat between
 * two words ("and  and").
 *
 * The space collapsing skips fenced code blocks and indented lines, where
 * whitespace is content rather than accident.
 */
function tidy(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;
  const cleaned = lines.map((line) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line.replace(/[ \t]+$/, '');
    }
    if (inFence || /^(\s{4,}|\t)/.test(line)) return line.replace(/[ \t]+$/, '');
    return line.replace(/(\S) {2,}(?=\S)/g, '$1 ').replace(/[ \t]+$/, '');
  });
  return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Convert a page's rendered HTML to Markdown.
 *
 * `fullPage` keeps the whole document including chrome, for the caller who
 * would rather have the nav than risk the extraction picking the wrong root.
 *
 * Returns '' for a document with no usable content rather than throwing: one
 * page that converts to nothing is a page worth reporting, not a reason to end
 * a crawl of two hundred.
 */
function htmlToMarkdown(html, { pageUrl = null, fullPage = false, title = null } = {}) {
  if (!html || !html.trim()) return '';

  const $ = cheerio.load(html);
  $(NON_CONTENT).remove();

  const body = $('body');
  const root = fullPage ? (body.length ? body : $.root()) : findContentRoot($);
  if (!fullPage) {
    // Scoped to the content root, so chrome *inside* the article - a "share
    // this" widget, an inline nav - goes, while the surrounding page was
    // already excluded by the choice of root itself.
    root.find(CHROME).remove();
  }

  absolutizeUrls($, root, pageUrl);
  unwrapBlockAnchors($, root);
  dropEchoedTitles($, root);

  turndown = turndown || createTurndown();
  const markdown = tidy(turndown.turndown(root.html() || ''));
  if (!markdown) return '';

  // A content root that held no heading loses the page's title entirely, since
  // <title> lives in the <head> that was never part of that root.
  if (title && !/^#\s/.test(markdown)) {
    return `# ${title.trim()}\n\n${markdown}`;
  }
  return markdown;
}

/**
 * Does this response body look like Markdown rather than an HTML page?
 *
 * A site with no `<path>.md` usually answers the request with its own 404
 * page, at HTTP 200, in HTML. Writing that to disk as blog.md would fill the
 * corpus with "Page not found" documents that look perfectly successful.
 */
function looksLikeMarkdown(text, contentType = '') {
  if (!text || !text.trim()) return false;
  if (/^text\/html/i.test(contentType)) return false;
  if (/^\s*(<!doctype\b|<html\b|<head\b|<body\b)/i.test(text)) return false;
  return true;
}

module.exports = {
  htmlToMarkdown,
  looksLikeMarkdown,
  findContentRoot,
  CONTENT_ROOTS,
};
