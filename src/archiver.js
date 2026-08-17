'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * Drives the vendored capture engine in-process instead of spawning a CLI per page.
 *
 * One browser is launched for the whole crawl and every batch of pages is
 * captured through it, in parallel tabs. Measured against spawning the CLI once
 * per page, that took a 4-page run from ~9.0s/page to ~2.3s/page: the per-page
 * process + Chrome launch (~1.4s) disappears and pages overlap.
 *
 * The engine is ESM with no top-level await outside its CLI entry point, so a
 * dynamic import() reaches its API from this CommonJS codebase. Its sources are
 * vendored under vendor/capture-engine as .mjs - see that directory's NOTICE.
 */

const API_FILE = 'capture-api.mjs';

/** Browser-side files shipped with the archiver, injected into every page. */
const REVEAL_SCRIPT = path.join(__dirname, 'browser', 'reveal.js');
const REVEAL_STYLESHEET = path.join(__dirname, 'browser', 'reveal.css');

/** Candidate engine directories, most explicit first. */
function candidateDirs(explicitDir) {
  const dirs = [];
  if (explicitDir) dirs.push(explicitDir);
  dirs.push(path.resolve(__dirname, '..', 'vendor', 'capture-engine'));
  return dirs;
}

/**
 * Locate the capture engine's API module.
 * Throws with actionable advice when the vendored sources are missing.
 */
function resolveApiPath(explicitDir) {
  const tried = [];
  for (const dir of candidateDirs(explicitDir)) {
    const apiPath = path.join(dir, API_FILE);
    tried.push(apiPath);
    if (fs.existsSync(apiPath)) return apiPath;
  }
  throw new Error(
    'Capture engine not found. It ships in this repository under ' +
      'vendor/capture-engine - restore it, or set CAPTURE_ENGINE_DIR in .env. ' +
      `Looked for:\n  ${tried.join('\n  ')}`
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
    this._engine = null;
    this._errorsOffset = 0;
    this._tempDir = null;
    this.browserLaunched = false;
  }

  /**
   * Build the list of scripts injected into every page before it loads.
   *
   * The engine reads these from disk per page and concatenates them, so the
   * reveal pass's knobs travel as a tiny generated file placed immediately
   * before it. That keeps src/browser/reveal.js a plain, readable, unmodified
   * source file rather than a template someone has to mentally expand.
   */
  _revealScripts() {
    if (!this.config.revealAnimations) return [];

    this._tempDir = this._tempDir || fs.mkdtempSync(path.join(os.tmpdir(), 'web-archiver-'));
    const configFile = path.join(this._tempDir, 'reveal-config.js');
    const settings = {
      enabled: true,
      maxScrollMs: this.config.revealScrollMs,
    };
    // The trailing semicolon and newline matter: the engine concatenates these
    // files with no separator of its own.
    fs.writeFileSync(
      configFile,
      `globalThis.__WEB_ARCHIVER_REVEAL__ = ${JSON.stringify(settings)};\n`
    );
    return [configFile, REVEAL_SCRIPT];
  }

  /** Launch the browser and initialize the capture engine. Idempotent. */
  async _ensureStarted() {
    if (this._engine) return this._engine;

    const apiPath = resolveApiPath(this.config.engine.dir);
    this.logger.debug(`Capture engine API: ${apiPath}`);
    const api = await import(pathToFileURL(apiPath).href);

    const browserScripts = [...this._revealScripts(), ...this.config.browserScripts];
    const browserStylesheets = [
      ...(this.config.revealAnimations ? [REVEAL_STYLESHEET] : []),
      ...this.config.browserStylesheets,
    ];

    const options = {
      browserHeadless: true,
      browserLoadMaxTime: this.config.timeoutMs,
      browserCaptureMaxTime: this.config.timeoutMs,
      browserWaitUntil: 'networkIdle',
      userAgent: this.config.userAgent,
      maxParallelWorkers: this.config.workers,
      loadDeferredImagesMaxIdleTime: this.config.deferredImagesMaxIdleMs,
      // Pause after the page settles and before the capture script runs, so
      // JavaScript-rendered content is in the DOM by the time it is saved.
      // Costs one wait per batch rather than per page, since tabs run parallel.
      browserWaitDelay: this.config.waitAfterLoadMs,
      // The engine's default is to delete every element that is invisible at
      // capture time. That is what makes reveal-on-scroll text disappear from
      // an archived page, so with the reveal pass on it is turned off and the
      // pass decides what is genuinely hidden instead. See src/browser/.
      removeHiddenElements: this.config.removeHiddenElements,
      browserScripts,
      browserStylesheets,
      // An explicit `output` path is always supplied per page, so this returns
      // that exact path; the crawler decides itself whether to skip existing
      // files. It never combines with --output-directory, whose handling
      // discards the directory under this setting.
      filenameConflictAction: 'overwrite',
      errorsFile: this.errorsFile,
    };
    if (this.config.engine.browserExecutablePath) {
      options.browserExecutablePath = this.config.engine.browserExecutablePath;
    }

    this._engine = await api.initialize(options);
    this.browserLaunched = true;
    this.logger.debug(
      `Browser launched (workers=${this.config.workers}, ` +
        `deferredImagesMaxIdle=${this.config.deferredImagesMaxIdleMs}ms, ` +
        `reveal=${this.config.revealAnimations ? `${this.config.revealScrollMs}ms` : 'off'}, ` +
        `removeHiddenElements=${this.config.removeHiddenElements})`
    );
    if (browserScripts.length) {
      this.logger.debug(`Injected scripts: ${browserScripts.join(', ')}`);
    }
    return this._engine;
  }

  /** New text appended to the engine errors log since the last read. */
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

  /** Map the engine's error log entries back onto the URLs of this batch. */
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
   * actually exists: the engine reports failures out-of-band and does not
   * reject the capture call.
   */
  async archiveBatch(jobs) {
    if (jobs.length === 0) return [];
    const engine = await this._ensureStarted();

    for (const job of jobs) {
      await fs.promises.mkdir(path.dirname(job.filePath), { recursive: true });
    }

    let captureError = null;
    const startedAt = Date.now();
    try {
      await engine.capture(jobs.map((job) => [job.url, { output: job.filePath }]));
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
          (exists ? 'capture wrote an empty file' : 'capture produced no output file'),
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
    if (this._engine) {
      try {
        await this._engine.finish();
        this.logger.debug('Browser closed');
      } catch (error) {
        this.logger.warn(`Could not close the browser cleanly: ${error.message}`);
      } finally {
        this._engine = null;
      }
    }
    if (this._tempDir) {
      try {
        await fs.promises.rm(this._tempDir, { recursive: true, force: true });
      } catch {
        /* a leftover temp file is not worth a warning */
      }
      this._tempDir = null;
    }
  }
}

module.exports = { Archiver, resolveApiPath, firstStackLine };
