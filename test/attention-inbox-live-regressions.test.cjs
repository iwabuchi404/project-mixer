const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Regression guard for the bug the live check caught: the Inbox only
// redrew when commitTerminalAttention was called WITH options, so a plain
// agent_notification_received left the list showing its empty state while
// the store already held the item.
test('every attention commit refreshes the Inbox, not just option-carrying ones', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf-8');
  const start = renderer.indexOf('function commitTerminalAttention');
  const body = renderer.slice(start, renderer.indexOf('\n}', start));
  assert.ok(start > 0, 'commitTerminalAttention must exist');
  // No early return that skips the refresh.
  assert.doesNotMatch(body, /if \(!options\) return;/,
    'an options-less commit must still refresh the Inbox');
  assert.doesNotMatch(body, /return;\s*$/m);
  // The refresh is unconditional at the end.
  assert.match(body, /refreshAttentionSurface\(\);\s*$/m);
});

test('notification and completion paths both go through the committing writer', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf-8');
  const receive = renderer.slice(
    renderer.indexOf("register('agent_notification_received'"),
    renderer.indexOf("register('terminal_set_waiting'"),
  );
  assert.match(receive, /commitTerminalAttention\(terminalAttention\)/);
  // No direct store mutation path that bypasses the refresh.
  assert.doesNotMatch(receive, /reconcileAttention\(/);
});

test('devin resume pool hands out distinct sessions per reopening tab', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf-8');
  // takeDevinResumeCandidate must shift, not peek: two tabs restoring in the
  // same project must not both resume the same session id.
  const take = renderer.slice(
    renderer.indexOf('function takeDevinResumeCandidate'),
    renderer.indexOf('async function loadLayout'),
  );
  assert.match(take, /list\.shift\(\)/, 'must consume the entry');
  assert.doesNotMatch(take, /list\[0\]\s*;/, 'must not peek and leave it');
});

test('devin lookup happens once per project, not once per tab', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf-8');
  const pool = renderer.slice(
    renderer.indexOf('async function buildDevinResumePool'),
    renderer.indexOf('function takeDevinResumeCandidate'),
  );
  // Keyed by projectId in a Set, so N devin tabs in one project = 1 CLI call.
  assert.match(pool, /needsLookup = new Set\(\)/);
  assert.match(pool, /for \(const projectId of needsLookup\)|\[\.\.\.needsLookup\]/);
  // The pool is built before the per-tab loop, not inside it.
  assert.match(renderer, /const devinResumePool = await buildDevinResumePool\(layout\.tabs\)/);
});

test('devin layout restore only fills in ids that are genuinely missing', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf-8');
  const block = renderer.slice(
    renderer.indexOf('const tracked = !tab.devinSessionId'),
    renderer.indexOf('const newId = await dispatch(\'create_terminal\', args)'),
  );
  // A tab that already has an id must never be overridden by the pool.
  assert.match(block, /!tab\.resumeSessionId && !tab\.devinSessionId && !tracked/);
  assert.match(block, /normalizeRendererCommand\(tab\.command\) === 'devin'/);
  // Pooled ids rank below the explicit ones.
  assert.match(block, /tab\.resumeSessionId \|\| tab\.devinSessionId \|\| tracked \|\| pooled\?\.id/);
});

test('the devin index IPC is bounded and never returns a raw path', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  const start = main.indexOf("ipcMain.handle('devin:latest-session'");
  assert.ok(start > 0);
  const block = main.slice(start, main.indexOf('ipcMain.handle(', start + 10));
  assert.match(block, /timeout: 8000/);
  assert.match(block, /maxBuffer: MAX_JSON_BYTES/);
  assert.match(block, /\.slice\(0, 20\)/, 'the `all` list must be bounded');
  // workingDirectory may be read to filter by cwd, but must never appear in
  // the object handed back to the renderer.
  const returned = block.slice(block.indexOf('return {', block.indexOf('const all')));
  assert.doesNotMatch(returned, /workingDirectory/,
    'never echo a filesystem path to the renderer');
});

test('hook setup results are surfaced, not discarded', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf-8');
  // The project-switch call site must await a reporting wrapper.
  assert.match(renderer, /void reportHookSetup\(p\.path\)/);
  assert.doesNotMatch(renderer, /^\s*window\.api\.hookSetup\(p\.path\);$/m);
  // Skipped configs become a persistent warning, failures an error.
  assert.match(renderer, /r\.skipped/);
  assert.match(renderer, /type: 'warn'/);
  assert.match(renderer, /success === false/);
  // Repeated project switches must not repeat the same warning.
  assert.match(renderer, /reportedHookSetups = new Set\(\)/);
});