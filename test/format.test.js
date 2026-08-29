'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Crawler } = require('../src/crawler');
const { Archiver } = require('../src/archiver');
const { createProgram } = require('../src/cli');
const { buildConfig } = require('../src/config');

/** Build a config the way the CLI would, for one set of flags. */
function configFor(...flags) {
  const program = createProgram();
  program.exitOverride();
  program.configureOutput({ writeOut() {}, writeErr() {} });
  program.parse(['node', 'web-archiver', 'https://example.com', ...flags]);
  return buildConfig(program.args[0], program.opts());
}

test('--format decides which outputs a run owes each page', () => {
  const html = configFor();
  assert.strictEqual(html.format, 'html');
  assert.deepStrictEqual([html.wantsHtml, html.wantsMarkdown], [true, false]);

  const md = configFor('--format', 'md');
  assert.deepStrictEqual([md.wantsHtml, md.wantsMarkdown], [false, true]);

  const both = configFor('--format', 'both');
  assert.deepStrictEqual([both.wantsHtml, both.wantsMarkdown], [true, true]);
});

test('an unknown format is refused before the crawl starts', () => {
  assert.throws(() => configFor('--format', 'pdf'), /Allowed choices are html, md, both/);
});

test('the browser is asked for exactly what the page still needs', () => {
  // HTML only: capture and nothing more.
  assert.strictEqual(Crawler._captureMode({ needsHtml: true, needsConversion: false }), 'html');
  // HTML plus a conversion: one page load produces both.
  assert.strictEqual(Crawler._captureMode({ needsHtml: true, needsConversion: true }), 'both');
  // Markdown only, on a site publishing none: the DOM is all that is wanted,
  // so the inlining and serialization are skipped entirely.
  assert.strictEqual(Crawler._captureMode({ needsHtml: false, needsConversion: true }), 'dom');
});

test('a page whose Markdown came from the site never reaches the browser', () => {
  const jobs = [
    { url: 'a', needsHtml: false, needsConversion: false }, // site served its .md
    { url: 'b', needsHtml: false, needsConversion: true }, // must be converted
    { url: 'c', needsHtml: true, needsConversion: false }, // wants HTML
  ];
  assert.deepStrictEqual(
    Crawler._captureJobs(jobs).map((job) => job.url),
    ['b', 'c']
  );
});

test('engine options carry an output path only when a file is wanted', () => {
  assert.deepStrictEqual(Archiver.engineOptions({ mode: 'html', filePath: '/o/p.html' }), {
    output: '/o/p.html',
  });
  assert.deepStrictEqual(Archiver.engineOptions({ mode: 'both', filePath: '/o/p.html' }), {
    output: '/o/p.html',
    saveRenderedDom: true,
  });
  // No output: a DOM-only page writes no HTML, and naming one would leave a
  // stray capture on disk that nothing in the report points at.
  assert.deepStrictEqual(Archiver.engineOptions({ mode: 'dom', filePath: '/o/p.html' }), {
    renderedDomOnly: true,
  });
});

test('the report records the format so a rerun can be compared against it', () => {
  const { CrawlReport } = require('../src/report');
  const report = new CrawlReport(configFor('--format', 'both', '--no-native-md'));
  const built = report.build({ startUrl: 'https://example.com', durationMs: 1 });
  assert.strictEqual(built.options.format, 'both');
  assert.strictEqual(built.options.nativeMarkdown, false);
});
