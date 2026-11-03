#!/usr/bin/env node
'use strict';

const { summarize } = require('../devin-hook-probe/view-terminal-signals.cjs');

const logPath = process.argv[2];
if (!logPath) {
  console.error('Usage: node view-signals.cjs <logPath>');
  process.exit(1);
}
summarize(logPath);
