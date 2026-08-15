'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalSignalParser } = require('../tools/devin-hook-probe/terminal-signal-parser.cjs');

test('captures OSC 9 and OSC 777 terminated by BEL or ST', () => {
  const signals = [];
  const parser = createTerminalSignalParser((signal) => signals.push(signal));

  parser.push('before\x1b]9;Action required\x07middle');
  parser.push('\x1b]777;notify;Devin;Approval requested\x1b\\after');

  assert.deepEqual(signals, [
    {
      signal: 'osc',
      identifier: 9,
      data: 'Action required',
      payloadLength: 15,
      truncated: false,
      terminator: 'BEL',
    },
    {
      signal: 'osc',
      identifier: 777,
      data: 'notify;Devin;Approval requested',
      payloadLength: 31,
      truncated: false,
      terminator: 'ST',
    },
  ]);
});

test('handles OSC sequences split across PTY chunks without treating terminators as bells', () => {
  const signals = [];
  const parser = createTerminalSignalParser((signal) => signals.push(signal));

  parser.push('\x1b');
  parser.push(']9;Session ');
  parser.push('complete\x07');
  parser.push('\x07');

  assert.equal(signals.length, 2);
  assert.equal(signals[0].data, 'Session complete');
  assert.deepEqual(signals[1], { signal: 'bell' });
});

test('ignores unrelated OSC identifiers and bounds recorded payloads', () => {
  const signals = [];
  const parser = createTerminalSignalParser((signal) => signals.push(signal), {
    maxPayloadLength: 8,
  });

  parser.push('\x1b]0;window title\x07');
  parser.push('\x1b]9;1234567890\x07');

  assert.equal(signals.length, 1);
  assert.equal(signals[0].identifier, 9);
  assert.equal(signals[0].data, '123456');
  assert.equal(signals[0].payloadLength, 10);
  assert.equal(signals[0].truncated, true);
});
