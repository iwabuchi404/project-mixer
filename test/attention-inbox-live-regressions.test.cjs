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

// Run the real restore function with boundary spies; no source-layout assumptions.
async function runRestore(savedTabs) {
  const vm = require('node:vm');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const body = renderer.match(/async function loadLayout\(\) \{[\s\S]*?\n\}/)[0];
  const calls = [];
  const context = {
    suppressLayoutSave: false, restoringTerminals: false,
    projects: new Map([['p', { id: 'p', path: '/project' }]]), activeProjectId: 'p',
    pushFocusCheckbox: {}, DEFAULT_TERMINAL_SEND_MODES: {},
    window: { api: { layoutLoad: async () => ({ activeProjectId: 'p', tabs: savedTabs }) } },
    dispatch: async (name) => { calls.push({ name }); },
    createTerminal: async (...args) => {
      assert.equal(context.restoringTerminals, true);
      calls.push({ name: 'descriptor', args });
      return calls.length;
    },
    applySavedPaneLayouts: async () => calls.push({ name: 'panes' }),
    showProjectTabs: () => calls.push({ name: 'show' }),
    requestVisibleTerminalStarts: () => {
      assert.equal(context.restoringTerminals, false);
      calls.push({ name: 'start-visible' });
    },
    saveLayout: async () => calls.push({ name: 'save' }),
    console,
  };
  await vm.runInNewContext(`(${body})`, context)();
  return calls;
}

test('restore creates unopened descriptors instead of launching CLI commands or a resume pool', async () => {
  const calls = await runRestore(Array.from({ length: 20 }, (_, i) => ({ command: 'devin', label: `t${i}`, projectId: 'p' })));
  const descriptors = calls.filter(x => x.name === 'descriptor');
  assert.equal(descriptors.length, 20);
  for (const { args } of descriptors) {
    assert.equal(args[5].deferStart, true);
    assert.equal(args[5].restored, true);
  }
  assert.deepEqual(calls.filter(x => !['descriptor', 'panes', 'show', 'start-visible', 'save'].includes(x.name)).map(x => x.name), ['select_project']);
});

test('restore preserves per-tab IDs without silently assigning unknown IDs', async () => {
  const calls = await runRestore([
    { command: 'devin', label: 'one', projectId: 'p', resumeSessionId: 'session-one' },
    { command: 'devin', label: 'two', projectId: 'p', resumeSessionId: 'session-two', devinSessionId: 'devin-cloud' },
    { command: 'devin', label: 'legacy', projectId: 'p' },
  ]);
  const descriptors = calls.filter(x => x.name === 'descriptor');
  assert.deepEqual(descriptors.map(x => x.args[4]), ['session-one', 'session-two', undefined]);
  assert.equal(descriptors[1].args[5].devinSessionId, 'devin-cloud');
  assert.equal(descriptors[0].args[1], '/project');
});

test('restore starts visible terminals only after final pane and tab selection', async () => {
  const calls = await runRestore([{ command: 'cmd.exe', label: 'one', projectId: 'p' }]);
  const names = calls.map(x => x.name);
  assert.ok(names.indexOf('start-visible') > names.indexOf('panes'));
  assert.ok(names.indexOf('start-visible') > names.indexOf('show'));
  assert.equal(names.filter(x => x === 'start-visible').length, 1);
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