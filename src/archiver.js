'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * Drives SingleFile in-process instead of spawning its CLI per page.
 *
 * One browser is launched for the whole crawl and every batch of pages is
 * captured through it, in parallel tabs. Measured against spawning the CLI once
 * per page, that took a 4-page run from ~9.0s/page to ~2.3s/page: the per-page
 * process + Chrome launch (~1.4s) disappears and pages overlap.
 *
 * SingleFile is ESM with no top-level await outside its CLI entry point, so a
 * dynamic import() reaches its API from this CommonJS codebase.
 */

const API_FILE = 'single-file-cli-api.js';

/** Candidate SingleFile checkouts, most explicit first. */
function candidateDirs(explicitDir) {
  const dirs = [];
  if (explicitDir) dirs.push(explicitDir);
  dirs.push(path.resolve(__dirname, '..', 'vendor', 'single-file-cli'));
  dirs.push(path.resolve(__dirname, '..', '..', 'single-file-cli'));
  return dirs;
}

/**
 * Locate the SingleFile API module.
 * Throws with actionable advice when no checkout is present.
 */
function resolveApiPath(explicitDir) {
  const tried = [];
  for (const dir of candidateDirs(explicitDir)) {
    const apiPath = path.join(dir, API_FILE);
    tried.push(apiPath);
    if (fs.existsSync(apiPath)) return apiPath;
  }
  throw new Error(
    'SingleFile not found. Run `npm run setup` to fetch the submodule, or set ' +
      `SINGLEFILE_DIR in .env. Looked for:\n  ${tried.join('\n  ')}`
  );
}

/** First line of a captured stack trace, which carries the real message. */
function firstStackLine(block) {
  const match = block.match(/Stack:\s*([^\n\r]+)/);
  return match ? match[1].trim() : null;
}

class Archiver {
  constructor(config, logger, errorsFile) {
    this.config = config;
    this.logger = logger;
    this.errorsFile = errorsFile;
    this._singlefile = null;
    this._errorsOffset = 0;
    this.browserLaunched = false;
  }

  /** Launch the browser and initialize SingleFile. Idempotent. */
  async _ensureStarted() {
    if (this._singlefile) return this._singlefile;

    const apiPath = resolveApiPath(this.config.singlefile.dir);
    this.logger.debug(`SingleFile API: ${apiPath}`);
    const api = await import(pathToFileURL(apiPath).href);

    const options = {
      browserHeadless: true,
      browserLoadMaxTime: this.config.timeoutMs,
      browserCaptureMaxTime: this.config.timeoutMs,
      browserWaitUntil: 'networkIdle',
      userAgent: this.config.userAgent,
      maxParallelWorkers: this.config.workers,
      loadDeferredImagesMaxIdleTime: this.config.deferredImagesMaxIdleMs,
      // An explicit `output` path is always supplied per page, so this returns
      // that exact path; the crawler decides itself whether to skip existing
      // files. It never combines with --output-directory, whose handling
      // discards the directory under this setting.
      filenameConflictAction: 'overwrite',
      errorsFile: this.errorsFile,
    };
    if (this.config.singlefile.browserExecutablePath) {
      options.browserExecutablePath = this.config.singlefile.browserExecutablePath;
    }

    this._singlefile = await api.initialize(options);
    this.browserLaunched = true;
    this.logger.debug(
      `Browser launched (workers=${this.config.workers}, ` +
        `deferredImagesMaxIdle=${this.config.deferredImagesMaxIdleMs}ms)`
    );
    return this._singlefile;
  }

  /** New text appended to the SingleFile errors log since the last read. */
  _readNewErrors() {
    try {
      if (!fs.existsSync(this.errorsFile)) return '';
      const { size } = fs.statSync(this.errorsFile);
      if (size <= this._errorsOffset) return '';
      const handle = fs.openSync(this.errorsFile, 'r');
      try {
        const length = size - this._errorsOffset;
        const buffer = Buffer.alloc(length);
        fs.readSync(handle, buffer, 0, length, this._errorsOffset);
        this._errorsOffset = size;
        return buffer.toString('utf8');
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      return '';
    }
  }

  /** Map SingleFile's error log entries back onto the URLs of this batch. */
  _errorsByUrl(text) {
    const byUrl = new Map();
    if (!text) return byUrl;
    for (const block of text.split(/(?=\[\d{4}-\d{2}-\d{2}T)/)) {
      const urlMatch = block.match(/URL:\s*(\S+)/);
      if (!urlMatch) continue;
      const message = firstStackLine(block);
      if (message) byUrl.set(urlMatch[1], message);
    }
    return byUrl;
  }

  /**
   * Archive a batch of pages through the shared browser.
   *
   * `jobs` is [{ url, filePath }]. Resolves with one result per job:
   * { url, filePath, ok, error? } - never rejects, so a single bad page can
   * never abort the crawl. A page counts as archived only when its file
   * actually exists: SingleFile reports failures out-of-band and does not
   * reject the capture call.
   */
  async archiveBatch(jobs) {
    if (jobs.length === 0) return [];
    const singlefile = await this._ensureStarted();

    for (const job of jobs) {
      await fs.promises.mkdir(path.dirname(job.filePath), { recursive: true });
    }

    let captureError = null;
    const startedAt = Date.now();
    try {
      await singlefile.capture(jobs.map((job) => [job.url, { output: job.filePath }]));
    } catch (error) {
      // A whole-batch failure (e.g. the browser died) still has to be reported
      // per page rather than thrown away.
      captureError = error.message || String(error);
    }
    const batchMs = Date.now() - startedAt;

    const errors = this._errorsByUrl(this._readNewErrors());
    const results = jobs.map((job) => {
      let exists = false;
      let size = 0;
      try {
        const stats = fs.statSync(job.filePath);
        exists = stats.isFile();
        size = stats.size;
      } catch {
        exists = false;
      }
      if (exists && size > 0) {
        return { url: job.url, filePath: job.filePath, ok: true };
      }
      return {
        url: job.url,
        filePath: job.filePath,
        ok: false,
        error:
          errors.get(job.url) ||
          captureError ||
          (exists ? 'SingleFile wrote an empty file' : 'SingleFile produced no output file'),
      };
    });

    const failed = results.filter((result) => !result.ok).length;
    this.logger.debug(
      `Batch of ${jobs.length} captured in ${batchMs}ms` + (failed ? ` (${failed} failed)` : '')
    );
    return results;
  }

  /** Close the browser. Safe to call even if nothing was ever archived. */
  async close() {
    if (!this._singlefile) return;
    try {
      await this._singlefile.finish();
      this.logger.debug('Browser closed');
    } catch (error) {
      this.logger.warn(`Could not close the browser cleanly: ${error.message}`);
    } finally {
      this._singlefile = null;
    }
  }
}

module.exports = { Archiver, resolveApiPath, firstStackLine };
