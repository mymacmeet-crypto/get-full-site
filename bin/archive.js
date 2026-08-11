#!/usr/bin/env node
'use strict';

const { run } = require('../src/cli');

run(process.argv)
  .then((report) => {
    // Non-zero exit when nothing was archived so shell scripts can react.
    const failedOnly = report.totals.downloaded === 0 && report.totals.failed > 0;
    process.exitCode = report.interrupted ? 130 : failedOnly ? 2 : 0;
  })
  .catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
