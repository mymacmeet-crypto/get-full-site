'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();

const { resolveAssetExtensions } = require('./utils/url');

const DEFAULT_USER_AGENT = 'WebArchiver/1.0 (+https://github.com/your-org/web-archiver)';

// SingleFile's own default is 1500ms per page. 500ms measured ~28% faster with
// byte-identical output on sites that do not lean on lazy loading.
const DEFAULT_DEFERRED_IMAGES_IDLE_MS = 500;

// The reveal pass starts at DOMContentLoaded, so most of its scroll overlaps
// the tail of page load and costs nothing. This is only the slack left over
// after networkIdle, for the last passes to land before the capture fires.
const DEFAULT_WAIT_WITH_REVEAL_MS = 600;

const ASSET_MODES = new Set(['off', 'same', 'linked', 'any']);

/** Compile CLI-provided pattern strings into RegExp, failing fast on typos. */
function compilePatterns(patterns, flagName) {
  return (patterns || []).map((raw) => {
    try {
      return new RegExp(raw);
    } catch (error) {
      throw new Error(`Invalid regular expression for ${flagName}: "${raw}" (${error.message})`);
    }
  });
}

function positiveInt(value, flagName, { min = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || !Number.isInteger(n)) {
    throw new Error(`${flagName} must be an integer >= ${min}, got "${value}"`);
  }
  return n;
}

function positiveNumber(value, flagName, { min = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`${flagName} must be a number >= ${min}, got "${value}"`);
  }
  return n;
}

/** Split a comma- or space-separated list, dropping empties. */
function splitList(value) {
  if (value === undefined || value === null || value === false) return [];
  if (Array.isArray(value)) return value.flatMap(splitList);
  return String(value)
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * Resolve user-supplied browser script/stylesheet paths, failing fast: a typo
 * would otherwise be silently ignored by the capture engine, and the crawl
 * would finish looking successful while doing none of what was asked.
 */
function resolveInjectedFiles(values, flagName) {
  return splitList(values).map((file) => {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) {
      throw new Error(`${flagName} file not found: ${resolved}`);
    }
    return resolved;
  });
}

/**
 * Decide how far off-host asset downloads may go.
 *
 * `--no-assets` and `--assets none` both mean "off", and either one wins over
 * the domain mode, so turning downloads off never needs two flags.
 */
function resolveAssetMode(cliOptions, env, assetGroups) {
  const disabled =
    cliOptions.assets === false ||
    assetGroups.length === 0 ||
    assetGroups.some((group) => String(group).toLowerCase() === 'none');
  if (disabled) return 'off';

  const raw = String(cliOptions.assetDomains || env.ASSET_DOMAINS || 'linked')
    .trim()
    .toLowerCase();
  if (!ASSET_MODES.has(raw)) {
    throw new Error(
      `--asset-domains must be one of: ${[...ASSET_MODES].join(', ')}, got "${raw}"`
    );
  }
  return raw;
}

/**
 * Merge CLI options over .env values over built-in defaults into the single
 * frozen config object the rest of the archiver consumes.
 */
function buildConfig(startUrl, cliOptions) {
  const env = process.env;

  const outputFolder = path.resolve(cliOptions.output || env.OUTPUT_FOLDER || './archive');

  // `--assets` accepts group names, bare extensions, "all" and "none"; the
  // default is documents, the group whose loss the HTML archive cannot make up
  // for. `--no-assets` sets cliOptions.assets to false.
  const assetGroups =
    cliOptions.assets === false
      ? []
      : splitList(cliOptions.assets ?? env.ASSET_TYPES ?? 'documents');
  const assetMode = resolveAssetMode(cliOptions, env, assetGroups);
  const assetExtensions =
    assetMode === 'off'
      ? new Set()
      : resolveAssetExtensions(assetGroups, splitList(cliOptions.assetExt));

  const revealAnimations = cliOptions.revealAnimations !== false && env.REVEAL_ANIMATIONS !== '0';

  const config = {
    startUrl,
    outputFolder,

    maxDepth: positiveInt(cliOptions.depth, '--depth'),
    maxPages: positiveInt(cliOptions.maxPages, '--max-pages', { min: 1 }),
    sameDomainOnly: !cliOptions.allDomains,
    includePatterns: compilePatterns(cliOptions.include, '--include'),
    excludePatterns: compilePatterns(cliOptions.exclude, '--exclude'),

    delayMs: positiveInt(cliOptions.delay, '--delay'),
    concurrency: positiveInt(cliOptions.concurrency, '--concurrency', { min: 1 }),
    // Parallel tabs inside the one shared browser.
    workers: positiveInt(cliOptions.workers, '--workers', { min: 1 }),
    // Pages discovered before each archive batch is handed to SingleFile.
    batchSize: positiveInt(cliOptions.batch, '--batch', { min: 1 }),
    timeoutMs: positiveInt(cliOptions.timeout, '--timeout', { min: 1000 }),
    followRedirects: cliOptions.followRedirects !== false,

    // --sitemap <url> yields a string, --no-sitemap yields false,
    // and omitting both leaves undefined (= enabled, auto-discover).
    sitemapEnabled: cliOptions.sitemap !== false,
    sitemapUrl: typeof cliOptions.sitemap === 'string' ? cliOptions.sitemap : null,

    overwrite: Boolean(cliOptions.overwrite),
    resume: Boolean(cliOptions.resume),
    respectRobots: Boolean(cliOptions.respectRobots),
    dryRun: Boolean(cliOptions.dryRun),

    userAgent: cliOptions.userAgent || env.USER_AGENT || DEFAULT_USER_AGENT,
    maxRetries: positiveInt(env.MAX_RETRIES ?? 3, 'MAX_RETRIES'),
    retryDelayMs: positiveInt(env.RETRY_DELAY_MS ?? 1000, 'RETRY_DELAY_MS'),
    deferredImagesMaxIdleMs: positiveInt(
      cliOptions.deferredImagesIdle ??
        env.DEFERRED_IMAGES_MAX_IDLE_MS ??
        DEFAULT_DEFERRED_IMAGES_IDLE_MS,
      '--deferred-images-idle'
    ),
    // Settling time after load, before capture. Off by default, because it is
    // pure wall-clock on every page - except with the reveal pass on, which
    // needs a moment after networkIdle to finish its last sweeps.
    waitAfterLoadMs: positiveInt(
      cliOptions.wait ??
        env.WAIT_AFTER_LOAD_MS ??
        (revealAnimations ? DEFAULT_WAIT_WITH_REVEAL_MS : 0),
      '--wait'
    ),

    // ---- Linked files (PDFs, spreadsheets, archives) ----------------------
    assetMode,
    assetGroups,
    assetExtensions,
    assetConcurrency: positiveInt(
      cliOptions.assetConcurrency ?? env.ASSET_CONCURRENCY ?? 3,
      '--asset-concurrency',
      { min: 1 }
    ),
    maxAssets: positiveInt(cliOptions.maxAssets ?? env.MAX_ASSETS ?? 1000, '--max-assets', {
      min: 1,
    }),
    maxAssetBytes: Math.round(
      positiveNumber(
        cliOptions.maxAssetSize ?? env.MAX_ASSET_SIZE_MB ?? 100,
        '--max-asset-size',
        { min: 0.001 }
      ) *
        1024 *
        1024
    ),
    // Repoint links in the saved HTML at the downloaded copies, so the archive
    // works offline. The live URL is kept on data-original-href unless asked
    // otherwise, so nothing about the original page is lost.
    rewriteLinks: cliOptions.rewriteLinks !== false && assetMode !== 'off',
    keepOriginalHref: cliOptions.originalHref !== false,

    // ---- Capture fidelity -------------------------------------------------
    revealAnimations,
    revealScrollMs: positiveInt(
      cliOptions.revealScrollMs ?? env.REVEAL_SCROLL_MS ?? 4000,
      '--reveal-scroll-ms'
    ),
    // The capture engine deletes anything invisible at capture time, which is
    // exactly how reveal-on-scroll text goes missing. Keeping hidden elements
    // is the safety net behind the reveal pass; it costs some file size.
    removeHiddenElements: cliOptions.removeHidden === true || !revealAnimations,
    browserScripts: resolveInjectedFiles(cliOptions.browserScript, '--browser-script'),
    browserStylesheets: resolveInjectedFiles(
      cliOptions.browserStylesheet,
      '--browser-stylesheet'
    ),

    engine: {
      // SINGLEFILE_DIR still works so existing .env files keep functioning.
      dir: env.CAPTURE_ENGINE_DIR || env.SINGLEFILE_DIR || null,
      browserExecutablePath: env.BROWSER_EXECUTABLE_PATH || null,
    },

    logLevel: cliOptions.verbose ? 'debug' : cliOptions.quiet ? 'warn' : 'info',
    reportFile: cliOptions.report || null,
  };

  return Object.freeze(config);
}

module.exports = {
  buildConfig,
  splitList,
  DEFAULT_USER_AGENT,
  DEFAULT_DEFERRED_IMAGES_IDLE_MS,
  DEFAULT_WAIT_WITH_REVEAL_MS,
};
