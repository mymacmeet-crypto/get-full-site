#!/usr/bin/env node
'use strict';

const { run } = require('../src/dataset/cli');

run(process.argv)
  .then((result) => {
    // Non-zero when nothing was collected but documents failed, so a scheduled
    // refresh that quietly stops working is noticed.
    const failedOnly = result.documents === 0 && result.failed > 0;
    process.exitCode = failedOnly ? 2 : 0;
  })
  .catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
