'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { sleep, mapWithConcurrency } = require('./utils/misc');
const {
  checkAssetScope,
  classifyAsset,
  groupForContentType,
  groupForExtension,
  urlExtension,
} = require('./utils/url');
const { flatAssetName, FlatNames } = require('./utils/paths');

const MANIFEST_FILENAME = 'assets-manifest.json';
const MANIFEST_VERSION = 1;
const MAX_BACKOFF_MS = 30_000;

/** Thrown when a response exceeds --max-asset-size; never retried. */
class AssetTooLargeError extends Error {
  constructor(limitBytes) {
    super(`larger than the ${(limitBytes / (1024 * 1024)).toFixed(0)} MB asset size limit`);
    this.name = 'AssetTooLargeError';
    this.fatal = true;
  }
}

/** Extension suggested by a Content-Disposition filename, or ''. */
function extensionFromDisposition(header) {
  if (!header) return '';
  // RFC 5987 form wins when present: it is the one that survives non-ASCII.
  const match =
    /filename\*=(?:UTF-8'')?"?([^";]+)"?/i.exec(header) ||
    /filename="?([^";]+)"?/i.exec(header);
  if (!match) return '';
  let filename = match[1].trim();
  try {
    filename = decodeURIComponent(filename);
  } catch {
    /* keep the raw value */
  }
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return '';
  const extension = filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : '';
}

/**
 * Downloads the files a site links to but never inlines - PDFs, spreadsheets,
 * archives - into <site>/assets/, and records where each one came from.
 *
 * Separate from the page pipeline on purpose. The capture engine inlines a
 * page's own resources into the standalone HTML, but a link to a PDF stays a
 * link: nothing about archiving the page fetches the file behind it. Assets
 * therefore get their own queue, their own budget and their own scope rule,
 * and they never consume a --max-pages slot.
 *
 * Nothing here throws for a bad file: one unreachable PDF must not be able to
 * end a crawl, so failures are recorded and the queue moves on.
 */
class AssetDownloader {
  constructor({ config, logger, report, rateLimiter, robots, directory, reportDirectory }) {
    this.config = config;
    this.logger = logger;
    this.report = report;
    this.rateLimiter = rateLimiter;
    this.robots = robots;
    this.directory = directory;
    this.manifestFile = path.join(reportDirectory, MANIFEST_FILENAME);

    this.names = new FlatNames(flatAssetName);
    this.downloaded = new Map(); // normalized url -> manifest entry
    this.queued = new Map(); // normalized url -> { url, sourceUrl }
    this.seen = new Set(); // every url ever queued, downloaded or rejected
    // sha256 -> { url, fileName } of the first URL that produced that content.
    // Sites routinely link the same file under more than one URL - an http://
    // and an https:// form of the same path is the usual one - and storing a
    // second copy under a hash-suffixed name would leave the archive holding
    // the same document twice under two confusing names.
    this._byHash = new Map();
    // Monotonic counter stamped on each download, so a page archived earlier
    // can ask "what arrived after me?" without diffing whole maps.
    this._order = 0;
    this._directoryReady = false;
  }

  /** How many files have been taken so far; the stamp a page records. */
  get order() {
    return this._order;
  }

  get enabled() {
    return this.config.assetMode !== 'off' && this.config.assetExtensions.size > 0;
  }

  get pendingCount() {
    return this.queued.size;
  }

  get downloadedCount() {
    return this.downloaded.size;
  }

  /** Bytes actually stored: a deduplicated copy is counted once, not twice. */
  get totalBytes() {
    let total = 0;
    for (const entry of this.downloaded.values()) {
      if (entry.duplicateOf) continue;
      total += entry.bytes || 0;
    }
    return total;
  }

  /** URLs that turned out to be another name for a file already taken. */
  get duplicateCount() {
    let count = 0;
    for (const entry of this.downloaded.values()) if (entry.duplicateOf) count++;
    return count;
  }

  /**
   * Offer a URL to the asset pipeline.
   *
   * Returns true when it was accepted as a new download. A URL the crawler
   * would rather treat as a page is rejected here without a trace, so the
   * caller can simply ask about every link it finds.
   */
  enqueue(url, sourceUrl) {
    if (!this.enabled) return false;

    const { isAsset, extension, group } = classifyAsset(url, this.config.assetExtensions);
    if (!isAsset) return false;

    // Already handled: still worth recording the extra referring page, because
    // the manifest's `sources` is how someone finds where a file was linked.
    const existing = this.downloaded.get(url);
    if (existing) {
      if (sourceUrl && !existing.sources.includes(sourceUrl)) existing.sources.push(sourceUrl);
      return false;
    }
    const pending = this.queued.get(url);
    if (pending) {
      if (sourceUrl && !pending.sources.includes(sourceUrl)) pending.sources.push(sourceUrl);
      return false;
    }
    if (this.seen.has(url)) return false;

    const scope = checkAssetScope(url, {
      startUrl: this.config.startUrl,
      sourceUrl,
      mode: this.config.assetMode,
      excludePatterns: this.config.excludePatterns,
    });
    if (!scope.allowed) {
      this.seen.add(url);
      this.report.recordAssetSkipped(url, `asset-${scope.reason}`);
      return false;
    }

    if (this.downloaded.size + this.queued.size >= this.config.maxAssets) {
      this.seen.add(url);
      this.report.recordAssetSkipped(url, 'asset-budget-reached');
      return false;
    }

    this.seen.add(url);
    this.queued.set(url, { url, extension, group, sources: sourceUrl ? [sourceUrl] : [] });
    return true;
  }

  /**
   * Offer a URL that turned out to be a file only once its headers arrived -
   * `/download?id=42` serving a PDF has no extension to classify on.
   */
  enqueueByContentType(url, contentType, sourceUrl) {
    if (!this.enabled) return false;
    const match = groupForContentType(contentType);
    if (!match) return false;
    // Respect the same selection the extension path uses, so `--assets
    // documents` never quietly pulls in a ZIP because a header said so.
    if (!this.config.assetExtensions.has(match.extension)) return false;
    if (this.downloaded.has(url) || this.queued.has(url) || this.seen.has(url)) return false;

    const scope = checkAssetScope(url, {
      startUrl: this.config.startUrl,
      sourceUrl,
      mode: this.config.assetMode,
      excludePatterns: this.config.excludePatterns,
    });
    if (!scope.allowed) {
      this.seen.add(url);
      this.report.recordAssetSkipped(url, `asset-${scope.reason}`);
      return false;
    }
    if (this.downloaded.size + this.queued.size >= this.config.maxAssets) {
      this.seen.add(url);
      this.report.recordAssetSkipped(url, 'asset-budget-reached');
      return false;
    }

    this.seen.add(url);
    this.queued.set(url, {
      url,
      extension: match.extension,
      group: match.group,
      sources: sourceUrl ? [sourceUrl] : [],
    });
    return true;
  }

  /**
   * Dry-run counterpart to drain(): record what would have been fetched and
   * clear the queue, so a dry run reports the same set without the traffic and
   * without the pending count growing wave after wave.
   */
  previewPending() {
    const count = this.queued.size;
    for (const item of this.queued.values()) {
      this.report.recordAsset({
        url: item.url,
        file: null,
        fileName: null,
        bytes: 0,
        contentType: null,
        sha256: null,
        status: null,
        extension: item.extension || null,
        group: item.group || null,
        sources: [...item.sources],
        dryRun: true,
      });
      this.downloaded.set(item.url, { url: item.url, file: null, bytes: 0, sources: item.sources });
    }
    this.queued.clear();
    return count;
  }

  /** Download everything queued so far. Never rejects. */
  async drain() {
    if (this.queued.size === 0) return [];

    const batch = [...this.queued.values()];
    this.queued.clear();
    await this._ensureDirectory();

    return mapWithConcurrency(batch, this.config.assetConcurrency, async (item) => {
      try {
        return await this._download(item);
      } catch (error) {
        // _download already handles its own failures; this is the last net.
        this.report.recordAssetFailed({ url: item.url, error: `internal: ${error.message}` });
        this.logger.warn(`asset failed: ${item.url} -> internal: ${error.message}`);
        return null;
      }
    });
  }

  async _ensureDirectory() {
    if (this._directoryReady) return;
    await fs.promises.mkdir(this.directory, { recursive: true });
    this._directoryReady = true;
  }

  async _download(item) {
    const { config, logger, report } = this;

    if (this.robots && !(await this.robots.isAllowed(item.url))) {
      report.recordAssetSkipped(item.url, 'asset-robots-disallowed');
      logger.debug(`asset robots disallowed: ${item.url}`);
      return null;
    }

    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
      await this.rateLimiter.acquire();
      try {
        const entry = await this._attempt(item);
        if (entry) {
          entry.order = this._order++;
          this.downloaded.set(item.url, entry);
          report.recordAsset(entry);
          logger.info(
            `asset ${this.downloaded.size}/${config.maxAssets} ` +
              `${item.url} -> ${entry.file} (${(entry.bytes / 1024).toFixed(0)} KB)`
          );
        }
        return entry;
      } catch (error) {
        lastError = error.message || String(error);
        if (error.fatal || attempt > config.maxRetries) break;
        const wait = Math.min(config.retryDelayMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        this.rateLimiter.backOff(wait);
        logger.warn(
          `asset retry ${attempt}/${config.maxRetries} in ${wait}ms (${lastError}): ${item.url}`
        );
        await sleep(wait);
      }
    }

    report.recordAssetFailed({ url: item.url, error: lastError, sources: item.sources });
    logger.warn(`asset failed: ${item.url} -> ${lastError}`);
    return null;
  }

  /** One download attempt. Throws on failure; `error.fatal` blocks retries. */
  async _attempt(item) {
    const { config } = this;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    let response;
    try {
      response = await fetch(item.url, {
        redirect: config.followRedirects ? 'follow' : 'manual',
        signal: controller.signal,
        headers: { 'user-agent': config.userAgent, accept: '*/*' },
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        // 4xx other than the rate-limit codes will not improve on a retry.
        error.fatal = response.status >= 400 && response.status < 500 && response.status !== 429;
        throw error;
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > config.maxAssetBytes) {
        throw new AssetTooLargeError(config.maxAssetBytes);
      }

      // Settle on an extension before writing, so the file lands with a name
      // the reader's OS can actually open.
      const extension =
        urlExtension(item.url) ||
        item.extension ||
        extensionFromDisposition(response.headers.get('content-disposition')) ||
        (groupForContentType(contentType) || {}).extension ||
        '';

      const fileName = this.names.assign(item.url, extension);
      const filePath = path.join(this.directory, fileName);

      if (!config.overwrite && fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (stats.size > 0) {
          this.logger.debug(`asset exists, skipped: ${fileName}`);
          return this._entry(item, {
            fileName,
            bytes: stats.size,
            contentType,
            sha256: null,
            status: response.status,
            extension,
            reused: true,
          });
        }
      }

      const { bytes, sha256, tempPath } = await this._writeBody(
        response,
        filePath,
        config.maxAssetBytes
      );

      // Same bytes as a file already taken: keep the one copy and point this
      // URL at it. Both URLs still rewrite to a working local link.
      //
      // The lookup and the claim must sit together with no await between them.
      // Downloads run in parallel, so two copies of one file can finish at
      // nearly the same moment; yielding here would let both conclude they
      // were first and store the file twice.
      const original = this._byHash.get(sha256);
      if (!original) this._byHash.set(sha256, { url: item.url, fileName });

      if (original && original.fileName !== fileName) {
        await fs.promises.rm(tempPath, { force: true });
        this.logger.debug(`asset is a duplicate of ${original.fileName}: ${item.url}`);
        return this._entry(item, {
          fileName: original.fileName,
          bytes,
          contentType,
          sha256,
          status: response.status,
          extension,
          duplicateOf: original.url,
        });
      }

      try {
        await fs.promises.rename(tempPath, filePath);
      } catch (error) {
        // The claim above promised this content lives at `fileName`. It does
        // not, so release it rather than sending a later duplicate to a file
        // that was never written.
        if (!original) this._byHash.delete(sha256);
        throw error;
      }
      return this._entry(item, {
        fileName,
        bytes,
        contentType,
        sha256,
        status: response.status,
        extension,
        reused: false,
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`timeout after ${config.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      // A body left unread keeps the socket alive; a body already consumed
      // cancels harmlessly.
      if (response && response.body && !response.bodyUsed) {
        response.body.cancel().catch(() => {});
      }
    }
  }

  /**
   * Stream the response to disk, hashing and metering as it goes.
   *
   * Stops at the temp file and hands its path back rather than renaming: the
   * hash is only known once the last byte has arrived, and the caller needs it
   * to decide whether this content already exists under another name. Nothing
   * ever appears at the final path until that is settled, so an interrupted
   * download cannot leave a truncated file behind for `--resume` to mistake
   * for a complete one.
   */
  async _writeBody(response, filePath, maxBytes) {
    const hash = crypto.createHash('sha256');
    let bytes = 0;

    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          callback(new AssetTooLargeError(maxBytes));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    const tempPath = `${filePath}.part`;
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        meter,
        fs.createWriteStream(tempPath, { flags: 'w' })
      );
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true });
      throw error;
    }

    if (bytes === 0) {
      await fs.promises.rm(tempPath, { force: true });
      const error = new Error('server returned an empty file');
      error.fatal = true;
      throw error;
    }

    return { bytes, sha256: hash.digest('hex'), tempPath };
  }

  _entry(
    item,
    { fileName, bytes, contentType, sha256, status, extension, reused, duplicateOf = null }
  ) {
    return {
      url: item.url,
      file: `assets/${fileName}`,
      fileName,
      bytes,
      contentType: contentType || null,
      sha256,
      status,
      extension: extension || null,
      group: item.group || groupForExtension(extension) || null,
      sources: [...item.sources],
      reused: Boolean(reused),
      // Set when this URL served content already stored under another name;
      // `file` then points at that shared copy.
      duplicateOf,
    };
  }

  /**
   * Map of live URL -> filename in assets/, for the link rewriter.
   *
   * `sinceOrder` narrows it to files taken after that stamp. A page is
   * rewritten against everything downloaded up to the moment it was captured;
   * a file discovered later - which happens when only a response header could
   * reveal it was a file at all - would otherwise stay a live link on every
   * page archived before it arrived. Asking for the tail is what lets the
   * final pass fix those pages without re-scanning against the whole set.
   */
  linkMap(sinceOrder = 0) {
    const map = new Map();
    for (const [url, entry] of this.downloaded) {
      if (!entry.fileName) continue;
      if (sinceOrder > 0 && !(entry.order >= sinceOrder)) continue;
      map.set(url, entry.fileName);
    }
    return map;
  }

  /**
   * Serializable state, carried through --resume inside the crawl state.
   *
   * The pending queue goes with it. Every queued URL is already in `seen`, and
   * the page that linked it is already in the crawl's visited set, so a resume
   * would neither rediscover it nor accept it if offered - dropping the queue
   * here would lose those files for good.
   */
  toJSON() {
    return {
      downloaded: [...this.downloaded.values()],
      queued: [...this.queued.values()],
      seen: [...this.seen],
    };
  }

  restore(data) {
    if (!data) return;
    for (const entry of data.downloaded || []) {
      if (!entry || !entry.url) continue;
      this.downloaded.set(entry.url, { sources: [], ...entry });
      if (Number.isFinite(entry.order)) this._order = Math.max(this._order, entry.order + 1);
      // Rebuild the content index, so a resumed crawl still recognises a file
      // the first run already stored rather than saving a second copy.
      if (entry.sha256 && !entry.duplicateOf && !this._byHash.has(entry.sha256)) {
        this._byHash.set(entry.sha256, { url: entry.url, fileName: entry.fileName });
      }
    }
    for (const url of data.seen || []) this.seen.add(url);
    // Re-queued ahead of the `seen` check, which enqueue() consults last.
    for (const item of data.queued || []) {
      if (!item || !item.url || this.downloaded.has(item.url)) continue;
      this.queued.set(item.url, { sources: [], ...item });
    }
    this.names.restore([...this.downloaded.values()]);
  }

  /** Write assets-manifest.json. Returns the path, or null when nothing ran. */
  save() {
    if (this.downloaded.size === 0) return null;
    const payload = {
      version: MANIFEST_VERSION,
      savedAt: new Date().toISOString(),
      startUrl: this.config.startUrl,
      directory: 'assets/',
      totals: {
        urls: this.downloaded.size,
        files: this.downloaded.size - this.duplicateCount,
        duplicates: this.duplicateCount,
        bytes: this.totalBytes,
      },
      assets: [...this.downloaded.values()].sort((a, b) => a.url.localeCompare(b.url)),
    };
    fs.mkdirSync(path.dirname(this.manifestFile), { recursive: true });
    fs.writeFileSync(this.manifestFile, JSON.stringify(payload, null, 2));
    return this.manifestFile;
  }
}

module.exports = { AssetDownloader, MANIFEST_FILENAME, extensionFromDisposition };
