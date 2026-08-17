'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATE_VERSION = 1;
const STATE_FILENAME = '.crawl-state.json';

/**
 * Persistence for resumable crawls. The state file lives inside the site's
 * output directory, so `--resume` with the same start URL and output folder
 * finds it automatically. It is written atomically (tmp file + rename) so an
 * interrupt mid-save can never corrupt it.
 */
class CrawlState {
  constructor(siteDirectory) {
    this.file = path.join(siteDirectory, STATE_FILENAME);
  }

  /** Load previous state, or null when absent/incompatible. */
  load(startUrl) {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return null;
    }
    try {
      const data = JSON.parse(raw);
      if (data.version !== STATE_VERSION) return null;
      if (data.startUrl !== startUrl) return null;
      return data;
    } catch {
      return null; // corrupt state: start fresh rather than crash
    }
  }

  save({ startUrl, queue, stats, processedCount, assets }) {
    const payload = JSON.stringify(
      {
        version: STATE_VERSION,
        savedAt: new Date().toISOString(),
        startUrl,
        queue: queue.toJSON(),
        stats,
        processedCount,
        // What the asset pipeline has already fetched, so a resume neither
        // re-downloads those files nor renames them.
        assets: assets || null,
      },
      null,
      2
    );
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, this.file);
  }

  /** Remove the state file after a crawl completes successfully. */
  clear() {
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* already gone */
    }
  }
}

module.exports = { CrawlState, STATE_FILENAME };
