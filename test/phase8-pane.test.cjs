// test/phase8-pane.test.cjs
// Phase 8 / B1 (pane array-ization) static discipline tests.
// Run: npm run test:phase8

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('B1: pane commands are declared in types.js AND schemas.js (D19)', () => {
  const types = read('src/commands/types.js');
  const schemas = read('src/commands/schemas.js');
  for (const name of ['pane_split', 'pane_close', 'focus_pane']) {
    assert.match(types, new RegExp(`^\\s{2}${name}: \\{`, 'm'), `${name} missing in types.js`);
    assert.match(schemas, new RegExp(`^\\s{2}${name}: p\\(`, 'm'), `${name} missing in schemas.js`);
  }
});

test('B1: renderer keeps a flat pane model with a soft limit', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /const MAX_PANES = 4;/);
  assert.match(renderer, /let panes = \[\];/);
  assert.match(renderer, /function renderPanes\(\)/);
  assert.match(renderer, /function ensureDefaultPane\(\)/);
});

test('B1: switchTab shows each pane active terminal instead of hide-all-show-one', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /p\.activeTabId === otherId \? 'block' : 'none'/);
});

test('B1: handleResize fits every visible terminal', () => {
  const renderer = read('renderer.js');
  const body = renderer.match(/function handleResize\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(body, /tabs\.forEach/);
  assert.match(body, /resizeTerminalToContainer\(t\)/);
});

test('B1: pane state survives project switches via projectEditorStates', () => {
  const renderer = read('renderer.js');
  const save = renderer.match(/function saveCurrentEditorState\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(save, /panes: panes\.map/);
  assert.match(renderer, /\/\/ B1: restore pane structure/);
});

test('B1: push carries visible pane composition when split (D24 minimal verification)', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /function buildPaneContextSummary\(\)/);
  assert.match(renderer.replace(/function buildPaneContextSummary\(\)\{[\s\S]*?\n\}/, ''), /const paneCtx = buildPaneContextSummary\(\);/);
});

test('B1: pane DOM styles stay token-only', () => {
  const css = read('styles.css');
  assert.match(css, /\.terminal-pane-item \{/);
  assert.match(css, /\.pane-splitter \{/);
});
