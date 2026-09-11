// test/refactor-r2.test.cjs
// R2: the store is the single source of truth for attention state.
//
// Covers:
// - store subscription semantics (synchronous notify, change-only)
// - renderer wiring: commitAttention choke point, subscription-driven
//   redraw of the project list and tab status, removal of paired dual-writes

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function loadBundledStore() {
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, 'src', 'store', 'index.js')],
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

test('R2: setState notifies subscribers synchronously with the new state', () => {
  const store = loadBundledStore();
  const seen = [];
  const unsubscribe = store.subscribe((s) => seen.push(s.activeProjectId));
  store.setState({ activeProjectId: 'p1' });
  assert.deepEqual(seen, ['p1']);
  unsubscribe();
});

test('R2: unchanged values do not notify subscribers', () => {
  const store = loadBundledStore();
  let calls = 0;
  store.setState({ activeFilePath: '/a/b.ts' });
  const unsubscribe = store.subscribe(() => calls++);
  store.setState({ activeFilePath: '/a/b.ts' });
  assert.equal(calls, 0);
  store.setState({ activeFilePath: null });
  assert.equal(calls, 1);
  unsubscribe();
});

test('R2: getState returns a copy — mutating it does not affect the store', () => {
  const store = loadBundledStore();
  store.setState({ activeProjectId: 'p1' });
  const snapshot = store.getState();
  snapshot.activeProjectId = 'mutated';
  assert.equal(store.getState().activeProjectId, 'p1');
  assert.notEqual(store.getState(), snapshot);
});

test('R2: renderer routes attention writes through commitAttention', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /function commitAttention\(patch\) \{/);
  // The paired dual-writes are gone; the cache assignments live only inside
  // commitAttention.
  assert.doesNotMatch(renderer, /^\s*activeProjectId = projectId;/m);
  assert.doesNotMatch(renderer, /^\s*activeTabId = restoreId;/m);
  assert.doesNotMatch(renderer, /^\s*activeTabId = tabId;/m);
  assert.doesNotMatch(renderer, /^\s*activeTabId = null;\n\s*setState\(\{ activeTerminalTabId/m);
});

test('R2: store subscriptions drive project list and tab status redraw', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /subscribe\(\(s\) => \{/);
  assert.match(renderer, /subscribedBadgesRef[\s\S]*?renderProjectList\(\)/);
  assert.match(renderer, /subscribedAttentionRef[\s\S]*?for \(const tabId of tabs\.keys\(\)\) updateTabStatus\(tabId\);/);
});

test('R2: title bar is generated from the committed attention state', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /function updateTitleBar\(\) \{[\s\S]*?projects\.get\(activeProjectId\)/);
  assert.match(renderer, /commitAttention\(\{ activeProjectId: projectId \}\);\s*\n\s*dispatch\('project_set_badge'[\s\S]*?updateTitleBar\(\);/);
});
