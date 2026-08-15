'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

async function loadModule() {
  return import(pathToFileURL(path.join(__dirname, '..', 'src', 'notifications', 'devin-terminal.mjs')).href);
}

test('normalizes measured Devin OSC 9 and OSC 777 messages', async () => {
  const { normalizeDevinTerminalNotification } = await loadModule();

  assert.deepEqual(normalizeDevinTerminalNotification(9, 'Devin needs input'), {
    kind: 'needs_attention',
    eventType: 'needs_input',
    source: 'devin',
    reason: 'input',
  });
  assert.deepEqual(normalizeDevinTerminalNotification(777, 'notify;Devin;Devin finished'), {
    kind: 'turn_completed',
    eventType: 'finished',
    source: 'devin',
    reason: null,
  });
  assert.equal(normalizeDevinTerminalNotification(777, 'notify;Other;Devin finished'), null);
  assert.equal(normalizeDevinTerminalNotification(9, 'Unknown notification'), null);
});

test('registers only for Devin commands and deduplicates paired OSC notifications', async () => {
  const { registerDevinTerminalNotifications } = await loadModule();
  const handlers = new Map();
  const terminal = {
    parser: {
      registerOscHandler(identifier, callback) {
        handlers.set(identifier, callback);
        return { dispose() {} };
      },
    },
  };
  const received = [];
  let timestamp = 1000;

  const disposables = registerDevinTerminalNotifications(
    terminal,
    'C:\\tools\\devin.exe',
    (notification) => received.push(notification),
    { now: () => timestamp },
  );

  assert.equal(disposables.length, 2);
  assert.deepEqual([...handlers.keys()], [9, 777]);
  assert.equal(handlers.get(9)('Devin needs input'), true);
  timestamp += 1;
  assert.equal(handlers.get(777)('notify;Devin;Devin needs input'), true);
  assert.equal(received.length, 1);

  timestamp += 300;
  handlers.get(9)('Devin needs input');
  assert.equal(received.length, 2);

  const otherHandlers = new Map();
  assert.deepEqual(registerDevinTerminalNotifications({
    parser: {
      registerOscHandler(identifier, callback) {
        otherHandlers.set(identifier, callback);
      },
    },
  }, 'codex', () => {}), []);
  assert.equal(otherHandlers.size, 0);
});
