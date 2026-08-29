#!/usr/bin/env node
'use strict';

// CloseEvent is used by vendor/simple-cdp but is not a Node.js global.
if (typeof CloseEvent === 'undefined') {
  globalThis.CloseEvent = class CloseEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.code = init.code ?? 0;
      this.reason = init.reason ?? '';
      this.wasClean = init.wasClean ?? false;
    }
  };
}

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
