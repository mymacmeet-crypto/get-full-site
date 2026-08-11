'use strict';

const { sleep } = require('./utils/misc');

/**
 * Global politeness limiter: spaces out network operations so that at most
 * one request *starts* every `delayMs` milliseconds across all workers.
 * Callers `await limiter.acquire()` before touching the network.
 */
class RateLimiter {
  constructor(delayMs) {
    this.delayMs = delayMs;
    this._nextSlot = 0;
  }

  async acquire() {
    if (this.delayMs <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, this._nextSlot);
    this._nextSlot = slot + this.delayMs;
    const wait = slot - now;
    if (wait > 0) await sleep(wait);
  }

  /** Push the next slot out, e.g. after a 429 with Retry-After. */
  backOff(ms) {
    this._nextSlot = Math.max(this._nextSlot, Date.now() + ms);
  }
}

module.exports = { RateLimiter };
