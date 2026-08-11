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

module.exports = { sleep, shortHash, formatDuration };
