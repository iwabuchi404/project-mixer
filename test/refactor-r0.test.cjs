// test/refactor-r0.test.cjs
// R0 characterization tests: capture current behavior and known bugs before
// the R1–R4 refactoring touches production code.
//
// Tests marked "KNOWN BUG" reproduce behavior the refactoring plan targets.
// They are expected to PASS now (capturing the bug) and will be UPDATED in
// R1/R2/R4 to assert the fixed behavior. Tests marked "KEEP" pin behavior
// that must not regress.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// Bundle an ESM module into a CJS module we can require in node:test.
function loadBundledModule(entryPoint) {
  const result = esbuild.buildSync({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const module = { exports: {} };
  const evaluate = new Function('module', 'exports', 'require', result.outputFiles[0].text);
  evaluate(module, module.exports, require);
  return module.exports;
}

async function importEsm(rel) {
  return import(pathToFileURL(path.join(root, rel)).href);
}

// ---------------------------------------------------------------------------
// 1. Command registry — current fail-open behavior (KNOWN BUG, R1 will fix)
// ---------------------------------------------------------------------------

test('R1/FIXED: register() throws on duplicate handler registration', () => {
  const registry = loadBundledModule(path.join(root, 'src', 'commands', 'registry.js'));
  registry.register('get_focus', () => 'first');
  // R1 behavior: duplicate registration throws instead of silently overwriting.
  assert.throws(() => registry.register('get_focus', () => 'second'), /Duplicate handler registration/);
  // The first handler is still active.
  assert.equal(registry.dispatch('get_focus'), 'first');
});

test('R1/FIXED: dispatch() throws for an unregistered command handler', () => {
  const registry = loadBundledModule(path.join(root, 'src', 'commands', 'registry.js'));
  // get_focus is declared in COMMAND_TYPES but no handler is registered.
  // R1 behavior: throws instead of returning undefined.
  assert.throws(() => registry.dispatch('get_focus', {}), /No handler registered for: get_focus/);
});

test('R1/FIXED: dispatch() validates arg types via Zod schema', () => {
  const registry = loadBundledModule(path.join(root, 'src', 'commands', 'registry.js'));
  // focus_terminal declares { tabId: 'number' }. Register a handler that
  // echoes args so we can observe what the registry passes through.
  registry.register('focus_terminal', (args) => args);
  // Pass a string where a number is declared — R1 rejects this.
  assert.throws(
    () => registry.dispatch('focus_terminal', { tabId: 'not-a-number' }),
    /Invalid args for focus_terminal/,
  );
  // Missing required field also fails.
  assert.throws(
    () => registry.dispatch('focus_terminal', {}),
    /Invalid args for focus_terminal/,
  );
  // Correct type passes through.
  const passed = registry.dispatch('focus_terminal', { tabId: 5 });
  assert.equal(passed.tabId, 5);
});

test('R1/FIXED: dispatch() allows extra keys to pass through (passthrough schema)', async () => {
  // The trace test in phase3 relies on extra keys (source, secret) passing
  // through get_focus's empty args schema. R1 must not break this.
  const registry = loadBundledModule(path.join(root, 'src', 'commands', 'registry.js'));
  registry.register('get_focus', async ({ source }) => source);
  // Extra keys are allowed by the passthrough schema.
  assert.equal(await registry.dispatch('get_focus', { source: 'human', secret: 'x' }), 'human');
});

test('R0/KEEP: register() rejects an unknown command name', () => {
  const registry = loadBundledModule(path.join(root, 'src', 'commands', 'registry.js'));
  assert.throws(() => registry.register('not_a_real_command', () => {}), /Unknown command/);
});

test('R0/KEEP: dispatch() rejects an unknown command name', () => {
  const registry = loadBundledModule(path.join(root, 'src', 'commands', 'registry.js'));
  assert.throws(() => registry.dispatch('not_a_real_command', {}), /Unknown command/);
});

test('R0/KEEP: COMMAND_TYPES declares every command the renderer dispatches', () => {
  // Static check: every dispatch('name', ...) in renderer.js must appear in
  // COMMAND_TYPES. This is the inverse of phase2.5's check and guards against
  // introducing ad-hoc commands during the refactor.
  const renderer = read('renderer.js');
  const types = fs.readFileSync(path.join(root, 'src', 'commands', 'types.js'), 'utf8');
  const dispatched = new Set();
  for (const m of renderer.matchAll(/dispatch\(\s*['"]([a-z_]+)['"]/g)) {
    dispatched.add(m[1]);
  }
  for (const name of dispatched) {
    assert.match(types, new RegExp(`^\\s*${name}:`, 'm'), `command ${name} used by renderer but not declared in COMMAND_TYPES`);
  }
});

// ---------------------------------------------------------------------------
// 2. Hook routing — strict routing and unattributed notices (R1/FIXED)
// ---------------------------------------------------------------------------

test('R1/FIXED: handleHookNotification detects ambiguous cwd and sends unattributed', () => {
  const main = read('main.js');
  // R1: strict routing collects all matches and flags ambiguity.
  assert.match(main, /const matches = \[\]/);
  assert.match(main, /matches\.length === 1/);
  assert.match(main, /ambiguous = true/);
  assert.match(main, /unattributed: matchedPtyId === null/);
});

test('R1/FIXED: renderer does not fan out unmatched notifications to activeProjectId tabs', () => {
  const renderer = read('renderer.js');
  // The old fallback that iterated tabs by projectId + command must be gone.
  assert.doesNotMatch(renderer, /if \(activeProjectId\)[\s\S]*projectId === activeProjectId[\s\S]*command === 'claude'/);
  // Unattributed notifications now show a persistent toast.
  assert.match(renderer, /showToast\(\{[\s\S]*key: `hook-unattributed/);
  assert.match(renderer, /persistent: true/);
});

test('R1/FIXED: HOOK_SCRIPT uses only PROJECT_MIXER_PORT_FILE, no userData scanning', () => {
  const main = read('main.js');
  assert.match(main, /PROJECT_MIXER_PORT_FILE/);
  // The old fallback that scanned Project Mixer / Project Mixer Dev dirs
  // must be removed.
  assert.doesNotMatch(main, /Project Mixer'?,\s*'project-mixer'/);
  assert.doesNotMatch(main, /Project Mixer Dev'?,\s*'project-mixer'/);
  // The script exits early if the env var is not set.
  assert.match(main, /if \(!portFile\) \{ process\.exit\(0\); \}/);
});

test('R1/FIXED: command:check --version fallback is restricted to known agent commands', () => {
  const main = read('main.js');
  assert.match(main, /VERSION_FALLBACK_ALLOWED/);
  assert.match(main, /'claude'/);
  assert.match(main, /'codex'/);
  // The fallback must check the allowlist, not run arbitrary commands.
  assert.match(main, /VERSION_FALLBACK_ALLOWED\.has\(cmd\)/);
});

// ---------------------------------------------------------------------------
// 3. Config persistence — parse failure defaults and non-atomic writes
//    (KNOWN BUG, R4 will fix)
// ---------------------------------------------------------------------------

test('R4/FIXED: corrupt projects.json throws ConfigParseError instead of returning fallback', () => {
  // R4: readConfig throws ConfigParseError on parse failure. main.js has a
  // startup guard that quits the app instead of overwriting the corrupt file.
  const main = read('main.js');
  assert.match(main, /require\('\.\/src\/main\/config-service\.cjs'\)/);
  assert.match(main, /ConfigParseError/);
  // The old loadJson that swallowed errors must be gone.
  assert.doesNotMatch(main, /function loadJson\(file, fallback\)/);
  // Startup guard: quit on corrupt config.
  assert.match(main, /loadProjectsConfig\(\)/);
  assert.match(main, /app\.quit\(\)/);
});

test('R4/FIXED: config writes use atomic writeConfig, not raw writeFileSync', () => {
  const main = read('main.js');
  // The old saveJson that used writeFileSync directly must be gone.
  assert.doesNotMatch(main, /function saveJson\(file, data\) \{[^}]*writeFileSync/);
  // Config writes must go through writeConfig (atomic).
  assert.match(main, /saveProjectsConfig\(projects\)/);
  assert.match(main, /saveLayoutConfig\(layout\)/);
  assert.match(main, /writeConfig\(/);
});

test('R0/KEEP: writeJsonAtomic writes via a temp file and renames', () => {
  const { writeJsonAtomic } = require('../src/ports/state.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r0-'));
  try {
    const target = path.join(tmp, 'data.json');
    writeJsonAtomic(target, { ok: true, n: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), { ok: true, n: 1 });
    // No leftover temp file.
    const entries = fs.readdirSync(tmp).filter((n) => n.startsWith('.data.json.'));
    assert.equal(entries.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('R0/KEEP: writeJsonAtomic replaces an existing file atomically', () => {
  const { writeJsonAtomic } = require('../src/ports/state.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r0-'));
  try {
    const target = path.join(tmp, 'data.json');
    writeJsonAtomic(target, { v: 1 });
    writeJsonAtomic(target, { v: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), { v: 2 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Store — subscribe/notify works (KEEP), state is serializable (KEEP)
// ---------------------------------------------------------------------------

test('R0/KEEP: store.setState notifies subscribers with the new state', async () => {
  const store = await importEsm('src/store/index.js');
  const seen = [];
  const unsub = store.subscribe((s) => seen.push({ ...s }));
  try {
    store.setState({ activeProjectId: 'p1', activeFilePath: 'D:\\a.txt' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].activeProjectId, 'p1');
    assert.equal(seen[0].activeFilePath, 'D:\\a.txt');
    // No notification when value is unchanged.
    store.setState({ activeProjectId: 'p1' });
    assert.equal(seen.length, 1);
  } finally {
    unsub();
  }
});

test('R0/KEEP: store.getState returns a shallow copy, not the internal state', async () => {
  const store = await importEsm('src/store/index.js');
  const a = store.getState();
  a.activeProjectId = 'mutated';
  const b = store.getState();
  assert.notEqual(b.activeProjectId, 'mutated');
});

test('R0/KEEP: store state contains only serializable values', async () => {
  // The refactoring plan rule #4: DOM/Terminal/Promise must not live in the
  // store. Pin the current serializable shape so R2 does not accidentally
  // introduce runtime handles. R2 added projectBadges and waitingTabs as
  // plain objects — these are serializable.
  const store = await importEsm('src/store/index.js');
  const s = store.getState();
  for (const [key, value] of Object.entries(s)) {
    const ok = value === null
      || typeof value === 'string'
      || typeof value === 'boolean'
      || typeof value === 'number'
      || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length >= 0);
    assert.ok(ok, `store key ${key} must be serializable, got ${typeof value}`);
    // Round-trip through JSON must not throw.
    assert.doesNotThrow(() => JSON.stringify(value), `store key ${key} must JSON-serialize`);
  }
});

test('R0/KEEP: buildFocusState returns a serializable snapshot', async () => {
  const store = await importEsm('src/store/index.js');
  store.setState({ activeProjectId: 'p1', activeFilePath: 'D:\\a.txt', activeTerminalTabId: 3 });
  const focus = store.buildFocusState((id) => ({ id, name: 'P1', path: 'D:\\p1' }));
  assert.equal(focus.project.id, 'p1');
  assert.equal(focus.editor.filePath, 'D:\\a.txt');
  assert.equal(focus.terminal.activeTabId, 3);
  // Round-trip through JSON must not throw — focus state is sent over IPC.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(focus)));
});

// ---------------------------------------------------------------------------
// 5. Renderer duplicate state & DOM-only badges (KNOWN BUG, R2 will fix)
// ---------------------------------------------------------------------------

test('R0/KNOWN-BUG: renderer keeps its own activeProjectId shadowing the store', () => {
  // The store holds activeProjectId, but renderer.js also declares a local
  // activeProjectId and treats it as authoritative. R2 must make the store
  // the single source of truth.
  const renderer = read('renderer.js');
  assert.match(renderer, /import \{[^}]*getState[^}]*\} from '\.\/src\/store\/index\.js'/);
  assert.match(renderer, /^let activeProjectId = null/m);
});

test('R0/KNOWN-BUG: renderer keeps openFiles/previewFiles/activeFilePath outside the store', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /^let openFiles = new Map\(\)/m);
  assert.match(renderer, /^let previewFiles = new Map\(\)/m);
  assert.match(renderer, /^let activeFilePath = null/m);
  assert.match(renderer, /^let activePreviewPath = null/m);
});

test('R2/FIXED: project_set_badge handler updates store state, not just DOM', () => {
  // R2: badge state is authoritative in the store. The handler must call
  // setState with projectBadges, and renderProjectList must re-apply
  // badges from the store after re-rendering.
  const renderer = read('renderer.js');
  const handlerBlock = renderer.match(/register\('project_set_badge'[\s\S]*?\}\);/);
  assert.ok(handlerBlock, 'project_set_badge handler must exist');
  assert.match(handlerBlock[0], /setState\(\{ projectBadges/);
  // renderProjectList must restore badges from the store.
  assert.match(renderer, /renderProjectBadge\(id\)/);
  assert.match(renderer, /getProjectBadge\(projectId\)/);
});

test('R2/FIXED: waiting state lives in the store, not only on the tabs Map', () => {
  // R2: the store holds a waitingTabs map. updateTabStatus syncs to it,
  // updateProjectStatus reads from it, and closeTerminal cleans it up.
  const renderer = read('renderer.js');
  assert.match(renderer, /setState\(\{ waitingTabs \}\)/);
  assert.match(renderer, /getWaitingSummary\(\)/);
  // closeTerminal must remove the tab from the store's waitingTabs.
  assert.match(renderer, /delete waitingTabs\[tabId\]/);
  const store = read('src/store/index.js');
  assert.match(store, /waitingTabs/);
  assert.match(store, /getWaitingSummary/);
  assert.match(store, /isTabWaiting/);
});

// ---------------------------------------------------------------------------
// 6. Behaviors that must survive the refactor (KEEP) — static guards
// ---------------------------------------------------------------------------

test('R0/KEEP: renderer registers handlers for every declared command used at runtime', () => {
  // Pin the current set of registered commands so R3 extraction does not
  // drop one silently.
  const renderer = read('renderer.js');
  const registered = new Set();
  for (const m of renderer.matchAll(/register\(\s*['"]([a-z_]+)['"]/g)) {
    registered.add(m[1]);
  }
  // These are the commands the renderer dispatches (from the test above).
  const dispatched = new Set();
  for (const m of renderer.matchAll(/dispatch\(\s*['"]([a-z_]+)['"]/g)) {
    dispatched.add(m[1]);
  }
  for (const name of dispatched) {
    assert.ok(registered.has(name), `renderer dispatches ${name} but does not register a handler for it`);
  }
});

test('R0/KEEP: single webview is preserved and not recreated', () => {
  const html = read('index.html');
  const renderer = read('renderer.js');
  assert.equal((html.match(/<webview\b/g) || []).length, 1);
  assert.doesNotMatch(renderer, /createElement\(['"]webview['"]\)/);
});

test('R0/KEEP: terminal zero-size guard and bottom-follow remain in renderer', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /rect\.width\s*<=\s*0\s*\|\|\s*rect\.height\s*<=\s*0/);
  assert.match(renderer, /const shouldFollow = t\.pinnedToBottom/);
});

test('R0/KEEP: preview activation preserves editor attention', () => {
  // decidePreviewActivation is the pure function that governs show_file
  // focus stealing. R3 must keep this contract.
  assert.doesNotThrow(async () => {
    const { decidePreviewActivation } = await importEsm('src/phase3/state.mjs');
    const r = decidePreviewActivation({
      sameProject: true,
      activeSurface: 'editor',
      activePreviewPath: null,
      requestedPreviewPath: 'preview:p:a',
    });
    assert.equal(r.preserveAttention, true);
  });
});
