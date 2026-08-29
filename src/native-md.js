'use strict';

const { fetchText } = require('./dataset/source');
const { looksLikeMarkdown } = require('./markdown');

/**
 * The site's own Markdown, when it publishes any.
 *
 * Edge Delivery Services sites - aem.live and everything built on it - serve
 * `<path>.md` beside every page: the authored source, without the nav, the
 * footer or the lossy trip through HTML. When a site offers that, taking it is
 * strictly better than converting the page ourselves, so this is tried first
 * and conversion is the fallback.
 *
 * Almost every other site on the web offers nothing at that URL, so the cost
 * of asking has to be bounded. It is asked exactly once per host: the first
 * page probes, and a miss switches the whole crawl to conversion rather than
 * paying a wasted round trip on all two hundred pages. A site that serves
 * Markdown for one page serves it for all of them, and a site that serves it
 * for none is not going to start halfway through.
 */
class NativeMarkdown {
  constructor(config, logger, { rateLimiter = null } = {}) {
    this.config = config;
    this.logger = logger;
    this.rateLimiter = rateLimiter;
    // null = not yet probed, true/false = settled for this host.
    this.available = config.nativeMarkdown ? null : false;
    this.hits = 0;
    this.misses = 0;
    this._probe = null;
  }

  /**
   * The URL that would serve `pageUrl` as Markdown, or null when the question
   * does not apply.
   *
   * A query string is the disqualifying case: `/search?q=x` and `/search?q=y`
   * are different pages that would both ask for `/search.md`, so the same
   * document would be written for both. Converting each page's own DOM is the
   * only answer that stays correct there.
   */
  static documentUrl(pageUrl) {
    let url;
    try {
      url = new URL(pageUrl);
    } catch {
      return null;
    }
    if (url.search) return null;

    // A trailing slash names a directory, whose document is its index - the
    // same rule the site's own routing uses.
    let pathname = url.pathname;
    if (pathname === '' || pathname.endsWith('/')) {
      pathname = `${pathname}index`;
    } else {
      pathname = pathname.replace(/\.(html?|xhtml)$/i, '');
    }
    url.pathname = `${pathname}.md`;
    url.hash = '';
    return url.toString();
  }

  /** Options shared by every request this makes. */
  _fetchOptions() {
    return {
      timeoutMs: this.config.timeoutMs,
      userAgent: this.config.userAgent,
      maxRetries: this.config.maxRetries,
      retryDelayMs: this.config.retryDelayMs,
      rateLimiter: this.rateLimiter,
      onRetry: ({ url, attempt, wait, reason }) =>
        this.logger.debug(`markdown retry ${attempt} for ${url} in ${wait}ms (${reason})`),
    };
  }

  /**
   * Fetch `pageUrl` as Markdown, or resolve with null when the site does not
   * publish it.
   *
   * Never throws: a page with no Markdown is the ordinary case, not an error.
   */
  async fetch(pageUrl) {
    if (this.available === false) return null;

    const documentUrl = NativeMarkdown.documentUrl(pageUrl);
    if (!documentUrl) return null;

    // The first caller probes and everyone else waits on that same request, so
    // a batch of eight parallel pages costs one probe rather than eight.
    if (this.available === null) {
      this._probe = this._probe || this._runProbe(documentUrl);
      const probed = await this._probe;
      // The page that did the probing already has its answer; the others fall
      // through to their own request now that the question is settled.
      if (probed.url === documentUrl) return probed.markdown;
      if (this.available === false) return null;
    }

    return this._fetchOne(documentUrl);
  }

  async _runProbe(documentUrl) {
    const markdown = await this._fetchOne(documentUrl);
    this.available = markdown !== null;
    if (this.available) {
      this.logger.info(`Site publishes Markdown: taking <page>.md instead of converting`);
    } else {
      this.logger.info(`No Markdown at ${documentUrl} - converting captured pages instead`);
    }
    return { url: documentUrl, markdown };
  }

  async _fetchOne(documentUrl) {
    const result = await fetchText(documentUrl, this._fetchOptions());
    if (!result.ok) {
      this.misses++;
      this.logger.debug(`no markdown at ${documentUrl} (${result.error})`);
      return null;
    }
    // A 200 is not proof: a site with no such document usually answers with
    // its own HTML 404 page, which would otherwise be saved as the document.
    if (!looksLikeMarkdown(result.text, result.contentType)) {
      this.misses++;
      this.logger.debug(`${documentUrl} answered 200 but is not Markdown`);
      return null;
    }
    this.hits++;
    return result.text;
  }
}

module.exports = { NativeMarkdown };
