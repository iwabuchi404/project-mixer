#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function loadSignals(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
      }
    });
}

function summarize(logPath) {
  const signals = loadSignals(logPath);
  console.log(`Signal log: ${path.resolve(logPath)}`);
  console.log(`Signals: ${signals.length}`);
  for (const signal of signals) {
    if (signal.signal === 'bell') {
      console.log(`${signal.observedAt}  BEL`);
      continue;
    }
    console.log(`${signal.observedAt}  OSC ${signal.identifier}  ${JSON.stringify(signal.data)}  terminator=${signal.terminator}${signal.truncated ? ' truncated' : ''}`);
  }
}

if (require.main === module) {
  const logPath = process.argv[2];
  if (!logPath) {
    console.error('Usage: node view-terminal-signals.cjs <logPath>');
    process.exit(1);
  }
  summarize(logPath);
}

module.exports = { loadSignals, summarize };
