'use strict';

const { Command, Option } = require('commander');
const { buildConfig } = require('./config');
const { Crawler } = require('./crawler');
const pkg = require('../package.json');

/** Collect repeatable flags (--include a --include b) into an array. */
const collect = (value, previous) => [...previous, value];

function createProgram() {
  const program = new Command();

  program
    .name('web-archiver')
    .description(
      'Crawl one domain and archive the selected pages as standalone HTML files.\n' +
        'Each site gets <output>/<host>/ with exactly two folders: report/ and raw-html/.\n' +
        'raw-html/ is flat - one file per page, no nested directories.'
    )
    .version(pkg.version)
    .argument('<url>', 'start URL of the site to archive')
    .option(
      '-d, --depth <n>',
      'maximum link depth from seed pages (0 = seeds only: start URL + sitemap URLs)',
      '3'
    )
    .option('-p, --max-pages <n>', 'how many pages to archive', '100')
    .option('--all-domains', 'follow links to external domains (default: same domain only)')
    .option('--include <regex>', 'only crawl URLs matching this pattern (repeatable)', collect, [])
    .option(
      '--exclude <regex>',
      'never crawl URLs matching this pattern (repeatable, wins over --include)',
      collect,
      []
    )
    .option('--sitemap <url>', 'seed the crawl from this sitemap URL instead of auto-discovering it')
    .option('--no-sitemap', 'do not seed the crawl from sitemap.xml (link discovery only)')
    .option('--delay <ms>', 'minimum delay between requests to the site', '500')
    .option('-c, --concurrency <n>', 'parallel discovery fetches', '2')
    .option('-w, --workers <n>', 'parallel browser tabs used to archive a batch', '4')
    .option('--batch <n>', 'pages discovered before each archive batch', '8')
    .option('-t, --timeout <ms>', 'per-request / per-page timeout', '30000')
    .option(
      '--deferred-images-idle <ms>',
      'how long the browser waits for lazy-loaded images per page (engine default is 1500)'
    )
    .option('--no-follow-redirects', 'do not follow HTTP redirects')
    .option('--overwrite', 'overwrite files that already exist in raw-html/')
    .option('--resume', 'resume an interrupted crawl of the same start URL')
    .option('--respect-robots', 'honor robots.txt disallow rules (off by default)')
    .option('--dry-run', 'crawl and report without archiving any pages')
    .option('-o, --output <dir>', 'base output directory (overrides OUTPUT_FOLDER from .env)')
    .option('--user-agent <ua>', 'User-Agent for discovery requests and the browser')
    .option('--report <file>', 'write the JSON report to this exact path')
    .addOption(new Option('-q, --quiet', 'only log warnings and errors').conflicts('verbose'))
    .addOption(new Option('-v, --verbose', 'enable debug logging').conflicts('quiet'))
    .showHelpAfterError();

  return program;
}

/** Parse argv, run the crawl, and resolve with the built report. */
async function run(argv) {
  const program = createProgram();
  program.parse(argv);

  const config = buildConfig(program.args[0], program.opts());
  const crawler = new Crawler(config);

  // First Ctrl+C: graceful stop (finish the current wave, save resume state).
  // Second Ctrl+C: hard exit.
  let interrupts = 0;
  const onInterrupt = () => {
    interrupts++;
    if (interrupts === 1) {
      crawler.abort();
    } else {
      process.stderr.write('\nForced exit without saving.\n');
      process.exit(130);
    }
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  try {
    return await crawler.run();
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }
}

module.exports = { run, createProgram };
