const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('preview_open: MCP sessions are detected and already-visible requests skip re-render', () => {
  const renderer = read('renderer.js');
  const start = renderer.indexOf("register('preview_open'");
  const end = renderer.indexOf("register('preview_reveal'");
  assert.ok(start !== -1 && end !== -1 && start < end, 'preview_open handler exists');
  const fn = renderer.slice(start, end);

  // main.js injects $session only for MCP-originated dispatches; the handler
  // must use it to tell agent calls from human UI calls.
  assert.ok(fn.includes('$session: session = null'), 'handler accepts $session');
  assert.ok(fn.includes('session && activate && result.shown'), 'agent takeover is detected');

  // Already-visible requests must return BEFORE the load pipeline: re-running
  // it re-reads the file and replays guest round-trips for no visual change.
  const skipAt = fn.indexOf("activation.reason === 'already-visible'");
  const openAt = fn.indexOf('await openFileInPreview(');
  assert.ok(skipAt !== -1 && openAt !== -1 && skipAt < openAt, 'already-visible skip precedes the load');
  assert.ok(fn.includes("markNotified({ shown: true, previewPath, reason: 'already-visible' })"), 'skip keeps the notified marker');

  // The takeover toast names the agent so the human knows who switched it.
  assert.ok(fn.includes('opened ${name} in preview'), 'takeover toast names the file');
  assert.ok(fn.includes('normalizeRendererCommand(agentTab.command)'), 'toast names the agent command');
});
