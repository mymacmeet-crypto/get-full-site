'use strict';

const robotsParser = require('robots-parser');

/**
 * Per-origin robots.txt cache. Only consulted when the crawl runs with
 * --respect-robots; otherwise the crawler never even fetches robots.txt.
 *
 * Failure policy: if robots.txt cannot be fetched (network error or 5xx) we
 * fail open and allow the URL — an unreachable robots file should not stall
 * an explicitly requested archive job. 4xx (no robots file) also allows all.
 */
class RobotsCache {
  constructor({ userAgent, timeoutMs, logger }) {
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this._byOrigin = new Map(); // origin -> Promise<parser|null>
  }

  async isAllowed(url) {
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      return true;
    }

    if (!this._byOrigin.has(origin)) {
      this._byOrigin.set(origin, this._load(origin));
    }
    const parser = await this._byOrigin.get(origin);
    if (!parser) return true;
    // robots-parser returns undefined for URLs outside the robots host.
    return parser.isAllowed(url, this.userAgent) !== false;
  }

  async _load(origin) {
    const robotsUrl = `${origin}/robots.txt`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(robotsUrl, {
        signal: controller.signal,
        headers: { 'user-agent': this.userAgent },
      });
      if (!response.ok) {
        this.logger.debug(`robots.txt for ${origin}: HTTP ${response.status}, allowing all`);
        return null;
      }
      const body = await response.text();
      this.logger.debug(`robots.txt loaded for ${origin} (${body.length} bytes)`);
      return robotsParser(robotsUrl, body);
    } catch (error) {
      this.logger.warn(`robots.txt fetch failed for ${origin} (${error.message}), allowing all`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { RobotsCache };
