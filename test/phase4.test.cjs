const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Phase 4 tokens match the approved palette and scale', () => {
  const css = read('tokens.css');
  const expected = {
    '--g-0': '#16181c', '--g-1': '#1c1f24', '--g-2': '#23272e',
    '--g-3': '#2e333b', '--g-4': '#6b7280', '--g-5': '#c8ccd4',
    '--g-6': '#f0f2f5', '--attn': '#c08b4d', '--act': '#4d8480',
    '--err': '#b56b66', '--ok': '#5f9278', '--s-1': '4px',
    '--s-2': '8px', '--s-3': '12px', '--s-4': '16px', '--s-5': '24px',
    '--t-sm': '11px', '--t-md': '13px', '--t-lg': '15px',
    '--r-1': '3px', '--r-2': '6px',
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.match(css, new RegExp(`${name}:\\s*${value.replace('#', '\\#').replace('.', '\\.')}`));
  }
  assert.equal((css.match(/--g-\d:/g) || []).length, 7);
  assert.equal((css.match(/--s-\d:/g) || []).length, 5);
  assert.equal((css.match(/--t-[a-z]+:/g) || []).length, 3);
  assert.equal((css.match(/--r-\d:/g) || []).length, 2);
});

test('terminal, file editor, and preview share one main tab surface', () => {
  const html = read('index.html');
  assert.equal((html.match(/<webview\b/g) || []).length, 1);
  assert.match(html, /id="main-tab-bar"[\s\S]*id="main-surface"/);
  assert.match(html, /id="main-surface"[\s\S]*id="terminal-pane"[\s\S]*id="file-editor-pane"[\s\S]*id="preview-pane"/);
  assert.doesNotMatch(html, /vsplitter-3|preview-tab-bar/);
});

test('scratch composer remains a separate persistent lower surface', () => {
  const html = read('index.html');
  assert.match(html, /id="main-surface"[\s\S]*id="splitter"[\s\S]*id="editor-pane"/);
  assert.match(html, /id="editor-tab-bar"[\s\S]*id="editor-textarea"[\s\S]*id="send-target"/);
  assert.match(html, /id="file-editor-textarea"/);
  const css = read('styles.css');
  assert.match(css, /#editor-pane\s*\{[\s\S]*height:\s*112px/);
  assert.match(css, /#editor-pane:focus-within\s*\{[\s\S]*height:\s*220px\s*!important/);
});

test('hidden main surfaces stay mounted and the webview is reused', () => {
  const css = read('styles.css');
  assert.match(css, /#main-surface\s*>\s*\.main-surface-pane\.hidden\s*\{[\s\S]*display:\s*block;[\s\S]*visibility:\s*hidden/);
  const renderer = read('renderer.js');
  assert.doesNotMatch(renderer, /createElement\(['"]webview['"]\)/);
  assert.doesNotMatch(renderer, /previewWebview\.remove\(\)/);
});

test('tab switching retains terminal zero-size and bottom-follow guards', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /rect\.width\s*<=\s*0\s*\|\|\s*rect\.height\s*<=\s*0/);
  assert.match(renderer, /const shouldFollow = t\.pinnedToBottom/);
  assert.match(renderer, /if \(shouldFollow\) t\.terminal\.scrollToBottom\(\)/);
  assert.match(renderer, /activateMainTab\(t\.tabElement\)/);
  assert.match(renderer, /showMainSurface\('terminal'\)/);
});

test('toast effects deduplicate and agent notices remain badges', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /const visibleToasts = new Map\(\)/);
  assert.match(renderer, /const previous = visibleToasts\.get\(key\)/);
  assert.match(renderer, /if \(previous\) previous\.remove\(\)/);
  assert.match(renderer, /preview\.tabEl\.classList\.add\('notified'\)/);
  assert.match(renderer, /project_set_badge/);
});

test('packaged app includes tokens and the hidden title bar', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.files.includes('tokens.css'));
  assert.equal(pkg.scripts['test:phase4'], 'node --test test/phase4.test.cjs');
  const main = read('main.js');
  assert.match(main, /titleBarStyle:\s*'hidden'/);
  assert.match(main, /titleBarOverlay:/);
});

test('browser tabs accept local HTTP origins and reject remote sites', async () => {
  const moduleUrl = pathToFileURL(path.join(root, 'src', 'ui', 'browser.mjs')).href;
  const { getBrowserTabLabel, normalizeLocalBrowserUrl } = await import(moduleUrl);
  assert.equal(normalizeLocalBrowserUrl('localhost:5173'), 'http://localhost:5173/');
  assert.equal(normalizeLocalBrowserUrl('https://127.0.0.1:4173/app'), 'https://127.0.0.1:4173/app');
  assert.equal(normalizeLocalBrowserUrl('http://[::1]:8080'), 'http://[::1]:8080/');
  assert.equal(normalizeLocalBrowserUrl('https://example.com'), null);
  assert.equal(normalizeLocalBrowserUrl('file:///etc/passwd'), null);
  assert.equal(getBrowserTabLabel('http://localhost:5173/app'), 'localhost:5173/app');
});
