'use strict';

const crypto = require('node:crypto');

/** Promise-based sleep. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Short stable hash used to disambiguate truncated filenames. */
const shortHash = (input, length = 8) =>
  crypto.createHash('sha1').update(input).digest('hex').slice(0, length);

/** Format a millisecond duration as "1h 2m 3.4s". */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${rs}s`;
}

/** Format a byte count as "12.3 MB". */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Run an async mapper over items, at most `limit` in flight.
 *
 * A limit that is not a positive integer falls back to 1 rather than
 * producing an empty runner list: silently doing nothing at all is the worst
 * possible reading of "how many at a time?".
 */
async function mapWithConcurrency(items, limit, mapper) {
  const parallel = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(parallel, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = { sleep, shortHash, formatDuration, formatBytes, mapWithConcurrency };
