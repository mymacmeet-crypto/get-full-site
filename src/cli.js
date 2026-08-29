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
      'Crawl one domain and archive the selected pages as HTML, Markdown or both.\n' +
        'Each site gets <output>/<host>/ with report/, site-data/ and, once the crawl\n' +
        "downloads a linked file, assets/. site-data/ mirrors the site's own paths -\n" +
        '/blog/post-1 is site-data/blog/post-1.html beside post-1.md - while assets/\n' +
        'stays flat, one file per download.'
    )
    .version(pkg.version)
    .argument('<url>', 'start URL of the site to archive')
    .addOption(
      new Option(
        '-f, --format <format>',
        'what to save for each page: "html" (standalone capture, every asset ' +
          'inlined), "md" (Markdown only), or "both". Markdown comes from the ' +
          "site's own <page>.md where it publishes one, and is converted from " +
          'the rendered page where it does not'
      )
        .choices(['html', 'md', 'both'])
        .default('html')
    )
    .option(
      '--no-native-md',
      'always convert pages to Markdown, even on a site that publishes its own ' +
        '<page>.md - use it when every document should have been through the ' +
        'same conversion'
    )
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
    .option(
      '--wait <ms>',
      'extra settling time after a page loads, before it is captured - raise it ' +
        'for sites that render content with JavaScript (not the same as --delay)'
    )
    .option('--no-follow-redirects', 'do not follow HTTP redirects')

    // ---- Linked files ------------------------------------------------------
    .option(
      '--assets <list>',
      'file types to download alongside pages: any of documents, archives, ' +
        'media, code, plus bare extensions - or "all" / "none"',
      'documents'
    )
    .option('--no-assets', 'do not download linked files at all')
    .option('--asset-ext <ext>', 'download this extension too (repeatable)', collect, [])
    .addOption(
      new Option(
        '--asset-domains <mode>',
        'which hosts linked files may come from: "same" (crawled host only), ' +
          '"linked" (also other hosts a crawled page links directly, e.g. a CDN), ' +
          'or "any"'
      )
        .choices(['same', 'linked', 'any'])
        .default('linked')
    )
    .option('--max-assets <n>', 'how many linked files to download', '1000')
    .option('--max-asset-size <mb>', 'skip any linked file larger than this', '100')
    .option('--asset-concurrency <n>', 'parallel asset downloads', '3')
    .option(
      '--no-rewrite-links',
      'leave links in the saved HTML pointing at the live site instead of the ' +
        'downloaded copies in assets/ (Markdown always keeps live URLs)'
    )
    .option(
      '--no-original-href',
      'when rewriting links, do not keep the live URL on data-original-href'
    )

    // ---- Capture fidelity --------------------------------------------------
    .option(
      '--no-reveal-animations',
      'do not scroll pages before capturing them - text that animates in on ' +
        'scroll will be missing from the saved file'
    )
    .option('--reveal-scroll-ms <ms>', 'time budget for the pre-capture scroll, per page', '4000')
    .option(
      '--remove-hidden',
      'let the capture engine delete elements that are invisible at capture ' +
        'time (smaller files, but risks losing animated content)'
    )
    .option(
      '--browser-script <file>',
      'extra script injected into every page before it loads (repeatable)',
      collect,
      []
    )
    .option(
      '--browser-stylesheet <file>',
      'extra stylesheet injected into every page after it loads (repeatable)',
      collect,
      []
    )

    .option('--overwrite', 'overwrite files that already exist in site-data/ and assets/')
    .option('--resume', 'resume an interrupted crawl of the same start URL')
    .option('--respect-robots', 'honor robots.txt disallow rules (off by default)')
    .option('--dry-run', 'crawl and report without archiving any pages')
    .option(
      '--survey',
      'find out what file types a site holds and nothing else: fetch each page ' +
        'once for its links, archive nothing, download nothing, and write only ' +
        'report/assets-inventory.survey.json. Uses a lower --delay and higher ' +
        '--concurrency than a normal crawl, since nothing is being saved'
    )
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
