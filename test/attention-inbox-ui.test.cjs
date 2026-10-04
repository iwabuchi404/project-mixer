// test/attention-inbox-ui.test.cjs
// AL-3: the Attention Inbox surface.
// Run: npm run test:attention
//
// Two classes of assertion. Structural ones pin the wiring (this codebase's
// established discipline — see phase8-pane.test.cjs). Behavioural ones drive the
// real store through the real grouping rules, because the ordering is a D24
// constraint that a presence check cannot verify.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

async function loadStore() {
  const { createAttentionStore } = await import(pathToFileURL(path.join(root, 'src', 'attention', 'attention-store.mjs')).href);
  return createAttentionStore;
}

test('the Inbox is a pane surface, declared in markup and both surface switches', () => {
  const html = read('index.html');
  const renderer = read('renderer.js');

  assert.match(html, /id="attention-pane" class="main-surface-pane hidden"/);
  assert.match(html, /id="attention-list"/);
  assert.match(html, /id="attention-count"/);

  // Registration alone is not enough — see attention-surface-wiring.test.cjs.
  // These two switches decide which node a `kind` resolves to; the enumeration
  // lists that actually move the node are asserted there.
  assert.match(renderer, /if \(kind === 'attention'\) return attentionPane;/);
  assert.match(renderer, /if \(node === attentionPane\) return 'attention';/);
});

test('the Inbox has commands, and they are registered on both sides (D19)', () => {
  const types = read('src/commands/types.js');
  const schemas = read('src/commands/schemas.js');
  const renderer = read('renderer.js');

  for (const name of ['attention_inbox_open', 'attention_open']) {
    assert.match(types, new RegExp(`^\\s{2}${name}: \\{`, 'm'), `${name} missing in types.js`);
    assert.match(schemas, new RegExp(`^\\s{2}${name}: p\\(`, 'm'), `${name} missing in schemas.js`);
    assert.match(renderer, new RegExp(`register\\('${name}'`), `${name} has no handler`);
  }
});

test('the Inbox is reachable from a global keybinding', () => {
  const bindings = read('src/keybindings/registry.js');
  // Global (when: null) so it is reachable without first finding the project.
  assert.match(bindings, /\{ key: 'Ctrl\+Shift\+A', command: 'attention_inbox_open', when: null \}/);
});

test('the Inbox focus context is declared in the registry', () => {
  const bindings = read('src/keybindings/registry.js');
  const renderer = read('renderer.js');

  // getFocusContext must be able to return a context the registry knows about.
  // An undeclared name fails silently: every `when` clause naming it is false.
  assert.match(bindings, /'attentionFocus'/);
  assert.match(renderer, /ctx = new Set\(\['attentionFocus'\]\)/);
  // And it must be reachable when the human is looking at the list.
  assert.match(renderer, /ae\?\.closest\('#attention-pane'\)/);
});

test('the Inbox is restored as the focused surface on project switch', () => {
  const renderer = read('renderer.js');
  // Without this branch a project switch drops the human back to the terminal
  // even when the Inbox was the surface they were looking at.
  assert.match(renderer, /focusedView\?\.type === 'attention' && attentionTabEl/);
});

test('layout persists the Inbox as a pane tab and the schema accepts it', () => {
  const renderer = read('renderer.js');
  const config = read('src/main/config-service.cjs');

  assert.match(renderer, /nonTerminalTabs\.push\(\{ type: 'attention', projectId, paneIndex \}\)/);
  assert.match(renderer, /entry\.type === 'attention'/);
  // A layout containing an attention tab must not fail validation, or D18's
  // non-fatal reset would silently drop the Inbox on every restart.
  assert.match(config, /'file', 'preview', 'search', 'attention'/);
  assert.match(config, /!\['search', 'attention'\]\.includes\(tab\.type\) && typeof tab\.path !== 'string'/);
});

test('the Inbox tab is re-placed on every pane re-render', () => {
  // Regression found by running the app: after a re-render the surface stayed
  // visible with no tab to switch away from, because layoutNonTerminalTabs only
  // knew about the search tab.
  const source = read('renderer.js');
  const start = source.indexOf('function layoutNonTerminalTabs()');
  const end = source.indexOf("document.addEventListener('wheel'", start);
  assert.ok(end > start, 'layoutNonTerminalTabs slice is empty');
  assert.match(source.slice(start, end), /place\(attentionTabEl,/);
});

test('opening an attention acknowledges it and navigates, never steals focus', () => {
  const renderer = read('renderer.js');
  const body = renderer.slice(
    renderer.indexOf('async function openAttention('),
    renderer.indexOf('function openAttentionTab()'),
  );

  // Acknowledgement is an explicit human act, so it belongs to the click path.
  assert.match(body, /acknowledgeAttention\(item\.id\)/);
  // Cross-project navigation goes through selectProject, which the human chose.
  assert.match(body, /item\.projectId !== activeProjectId/);
  // A file target reuses the existing preview commands instead of adding a
  // second navigation path (AL-4 / 7.2).
  assert.match(body, /dispatch\('preview_open'/);
  assert.match(body, /dispatch\('preview_reveal'/);
  assert.match(body, /switchTab\(item\.tabId\)/);
});

test('the Inbox redraws from the commit that changed the store', () => {
  const renderer = read('renderer.js');
  const body = renderer.slice(
    renderer.indexOf('function commitTerminalAttention('),
    renderer.indexOf('let subscribedBadgesRef'),
  );
  // Without this the list would only refresh on tab switch, so an attention
  // raised while the Inbox is open would not appear until the human looked away.
  assert.match(body, /refreshAttentionSurface\(\)/);
});

test('the Inbox is grouped by visibility, not by global priority (D24)', async () => {
  const createAttentionStore = await loadStore();
  const store = createAttentionStore({ now: () => 1 });

  store.reconcile({
    1: { projectId: 'p1', waiting: true, unread: false, kind: 'needs_attention', source: 'claude', title: 'in view, low' },
    5: { projectId: 'p2', waiting: false, unread: true, kind: 'turn_completed', source: 'opencode', title: 'out of view, urgent-looking' },
  });

  // Tab 1 is visible and is a plain normal-priority prompt. Tab 5 is out of
  // view. Spatial grouping must put 1 first even though 5 "looks" more urgent.
  const inView = store.getAttentionInView([1], null);
  const outOfView = store.getAttentionOutOfView([1], null);

  assert.deepEqual(inView.map((i) => i.title), ['in view, low']);
  assert.deepEqual(outOfView.map((i) => i.title), ['out of view, urgent-looking']);

  // No ranked accessor may reappear (1.2).
  assert.equal(store.nextAttention, undefined);
  assert.equal(store.oldestOpenAttention, undefined);
});

test('a surface-hosted pane contributes nothing to the in-view set', async () => {
  const createAttentionStore = await loadStore();
  const store = createAttentionStore({ now: () => 1 });

  store.reconcile({
    1: { projectId: 'p1', waiting: true, unread: false, kind: 'needs_attention', source: 'claude' },
  });

  // The renderer filters pane.view panes out of attentionInViewTabIds, because a
  // pane hosting a surface shows no terminal at all.
  assert.equal(store.getAttentionInView([], null).length, 0);
  assert.equal(store.getAttentionOutOfView([], null).length, 1);
});

test('empty state explains itself instead of showing an empty box', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /Nothing is waiting\. Agents running normally are hidden\./);
  assert.match(renderer, /attention-empty/);
});

test('acknowledged items stay visible but are de-emphasised, not hidden', async () => {
  const createAttentionStore = await loadStore();
  const store = createAttentionStore({ now: () => 1 });

  store.reconcile({
    2: { projectId: 'p1', waiting: false, unread: true, kind: 'turn_completed', source: 'opencode' },
  });
  const id = store.getOpenAttention()[0].id;
  store.acknowledgeAttention(id);

  // Acknowledged means "the human saw it", not "it never happened".
  assert.equal(store.getOpenAttention().length, 1);
  assert.match(read('renderer.js'), /attention-acknowledged/);
});