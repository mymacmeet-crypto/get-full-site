'use strict';

const path = require('node:path');
const { Command } = require('commander');
require('dotenv').config();

const { collect } = require('./collect');
const pkg = require('../../package.json');

const DEFAULT_USER_AGENT = 'WebArchiver-Dataset/1.0 (+https://github.com/your-org/web-archiver)';

const collectFlag = (value, previous) => [...previous, value];

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

function createProgram() {
  const program = new Command();

  program
    .name('web-archiver-dataset')
    .description(
      'Collect a text corpus from an Adobe Edge Delivery Services site.\n\n' +
        'Reads the site\'s query-index.json and fetches each published page as\n' +
        'Markdown, writing one JSON object per document to dataset.jsonl. No\n' +
        'crawl and no browser: the index is the document list.\n\n' +
        'Rerun the same command to refresh - documents whose lastModified has\n' +
        'not moved are reused from the existing dataset rather than re-fetched.'
    )
    .version(pkg.version)
    .argument('<url>', 'site to collect from, e.g. https://www.aem.live')
    .option('--index <path>', 'path to the query index', '/query-index.json')
    .option(
      '--extension <ext>',
      'per-document extension to fetch (.md for Markdown, .plain.html for the raw blocks)',
      '.md'
    )
    .option('--include <regex>', 'only collect paths matching this pattern (repeatable)', collectFlag, [])
    .option(
      '--exclude <regex>',
      'never collect paths matching this pattern (repeatable, wins over --include)',
      collectFlag,
      []
    )
    .option(
      '--include-noindex',
      'collect pages the index marks "noindex" too (they are skipped by default)'
    )
    .option('--force', 're-fetch every document, ignoring lastModified')
    .option('-c, --concurrency <n>', 'parallel document fetches', '6')
    .option('--delay <ms>', 'minimum delay between requests', '100')
    .option('-t, --timeout <ms>', 'per-request timeout', '30000')
    .option('--dry-run', 'report what would be collected without writing anything')
    .option('-o, --output <dir>', 'base output directory (overrides OUTPUT_FOLDER from .env)')
    .option('--dataset <file>', 'write the JSONL to this exact path')
    .option(
      '--no-files',
      'do not save each document as its own file - write only the JSONL and the manifest'
    )
    .option(
      '--files-dir <dir>',
      'save the per-document files here instead of <output>/<host>/markdown/'
    )
    .option('--user-agent <ua>', 'User-Agent for requests')
    .option('-q, --quiet', 'only log warnings and errors')
    .option('-v, --verbose', 'enable debug logging')
    .showHelpAfterError();

  return program;
}

function buildConfig(siteUrl, options) {
  let parsed;
  try {
    parsed = new URL(siteUrl);
  } catch {
    throw new Error(`Not a valid URL: "${siteUrl}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs are supported, got "${siteUrl}"`);
  }
  if (options.quiet && options.verbose) {
    throw new Error('--quiet and --verbose cannot be used together');
  }

  const env = process.env;
  const outputFolder = path.resolve(options.output || env.OUTPUT_FOLDER || './archive');

  return {
    siteUrl: parsed.toString(),
    outputFolder,
    datasetFile: options.dataset ? path.resolve(options.dataset) : null,
    // commander turns `--no-files` into files:false, defaulting to true.
    writeFiles: options.files !== false,
    documentsDir: options.filesDir ? path.resolve(options.filesDir) : null,
    indexPath: options.index,
    extension: options.extension.startsWith('.') ? options.extension : `.${options.extension}`,
    includePatterns: compilePatterns(options.include, '--include'),
    excludePatterns: compilePatterns(options.exclude, '--exclude'),
    includeNoIndex: Boolean(options.includeNoindex ?? options.includeNoIndex),
    force: Boolean(options.force),
    dryRun: Boolean(options.dryRun),
    concurrency: positiveInt(options.concurrency, '--concurrency', { min: 1 }),
    delayMs: positiveInt(options.delay, '--delay'),
    timeoutMs: positiveInt(options.timeout, '--timeout', { min: 1 }),
    maxRetries: positiveInt(env.MAX_RETRIES ?? '3', 'MAX_RETRIES'),
    retryDelayMs: positiveInt(env.RETRY_DELAY_MS ?? '1000', 'RETRY_DELAY_MS'),
    userAgent: options.userAgent || env.USER_AGENT || DEFAULT_USER_AGENT,
    logLevel: options.quiet ? 'warn' : options.verbose ? 'debug' : 'info',
  };
}

async function run(argv) {
  const program = createProgram();
  program.parse(argv);
  const config = buildConfig(program.args[0], program.opts());
  return collect(config);
}

module.exports = { run, createProgram, buildConfig };
