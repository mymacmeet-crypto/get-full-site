'use strict';

/**
 * FIFO crawl frontier with visited tracking.
 *
 * Three sets cooperate to guarantee each page is handled at most once:
 *  - `pending`: items waiting to be processed ({url, depth})
 *  - `known`:   every URL ever enqueued (prevents duplicate enqueues)
 *  - `visited`: URLs whose processing finished, plus aliases discovered at
 *               fetch time (redirect targets, canonical URLs)
 */
class CrawlQueue {
  constructor() {
    this.pending = [];
    this.known = new Set();
    this.visited = new Set();
  }

  /** Enqueue a URL unless it is already known. Returns true when added. */
  add(url, depth) {
    if (this.known.has(url) || this.visited.has(url)) return false;
    this.known.add(url);
    this.pending.push({ url, depth });
    return true;
  }

  /** Next item to process, or undefined when the frontier is empty. */
  next() {
    return this.pending.shift();
  }

  /** Mark a URL (or an alias of one) as fully handled. */
  markVisited(url) {
    this.visited.add(url);
    this.known.add(url);
  }

  hasVisited(url) {
    return this.visited.has(url);
  }

  get pendingCount() {
    return this.pending.length;
  }

  get discoveredCount() {
    return this.known.size;
  }

  /** Serializable snapshot used by the resume feature. */
  toJSON() {
    return {
      pending: this.pending,
      known: [...this.known],
      visited: [...this.visited],
    };
  }

  static fromJSON(data) {
    const queue = new CrawlQueue();
    queue.pending = Array.isArray(data.pending) ? data.pending : [];
    queue.known = new Set(data.known || []);
    queue.visited = new Set(data.visited || []);
    return queue;
  }
}

module.exports = { CrawlQueue };
