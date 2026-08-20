'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createProgram } = require('../src/cli');
const { buildConfig, SURVEY_DELAY_MS, SURVEY_CONCURRENCY } = require('../src/config');

/** Build the config the CLI would produce for these arguments. */
function configFor(args) {
  const program = createProgram();
  program.parse(['node', 'x', 'https://site.test', ...args]);
  return buildConfig(program.args[0], program.opts());
}

test('--survey implies a dry run, so nothing is captured or downloaded', () => {
  const config = configFor(['--survey']);
  assert.equal(config.survey, true);
  assert.equal(config.dryRun, true, 'reuses the dry-run path rather than a second skip');
});

test('--survey lowers the delay and raises concurrency, since nothing is saved', () => {
  const config = configFor(['--survey']);
  // The politeness delay is ~96% of a survey's wall clock at the normal default.
  assert.equal(config.delayMs, SURVEY_DELAY_MS);
  assert.equal(config.concurrency, SURVEY_CONCURRENCY);

  const normal = configFor([]);
  assert.equal(normal.delayMs, 500);
  assert.equal(normal.concurrency, 2);
});

test('an explicit --delay or --concurrency still beats the survey default', () => {
  const config = configFor(['--survey', '--delay', '750', '--concurrency', '1']);
  assert.equal(config.delayMs, 750, 'the user asked to be gentler than a survey normally is');
  assert.equal(config.concurrency, 1);
});

test('a plain --dry-run keeps the normal politeness defaults', () => {
  const config = configFor(['--dry-run']);
  assert.equal(config.survey, false);
  assert.equal(config.dryRun, true);
  assert.equal(config.delayMs, 500);
});
