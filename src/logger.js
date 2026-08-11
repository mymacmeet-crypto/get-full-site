'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

const TAGS = {
  debug: () => paint('90', 'debug'),
  info: () => paint('36', ' info'),
  warn: () => paint('33', ' warn'),
  error: () => paint('31', 'error'),
};

/**
 * Minimal leveled console logger. Kept dependency-free so it can be swapped
 * for pino/winston later without touching call sites (same method names).
 */
class Logger {
  constructor(level = 'info') {
    this.level = LEVELS[level] === undefined ? LEVELS.info : LEVELS[level];
  }

  _log(level, args) {
    if (LEVELS[level] < this.level) return;
    const time = new Date().toISOString().slice(11, 19);
    const line = `${paint('90', time)} ${TAGS[level]()} ${args.join(' ')}`;
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  debug(...args) { this._log('debug', args); }
  info(...args) { this._log('info', args); }
  warn(...args) { this._log('warn', args); }
  error(...args) { this._log('error', args); }
}

module.exports = { Logger, LEVELS };
