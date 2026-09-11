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
  assert.match(css, /\.main-tab\.shown-in-pane \{/);
});

test('B1 usability: surface placement is diff-based, never home-everything', () => {
  const renderer = read('renderer.js');
  const body = renderer.match(/function placeSurfaces\(\) \{[\s\S]*?\n  markShownTabs\(\);/)[0];
  // Only the displaced node moves; untouched hosts are left alone so the
  // <webview> guest is not reloaded on unrelated pane operations.
  assert.match(body, /node\.parentElement !== body/);
  assert.doesNotMatch(body, /restoreSurfacesToMain\(\);[\s\S]*Object\.entries\(hostOf\)/);
});

test('B1 usability: preview loads survive other-pane activity', () => {
  const renderer = read('renderer.js');
  const gate = renderer.match(/function isActivePreview\(f\) \{[\s\S]*?\n\}/)[0];
  assert.match(gate, /p\.view\.type === 'preview' && p\.view\.path === f\.previewPath/);
});

test('B1 usability: non-terminal tabs keep pane membership, display separated from focus', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /function layoutNonTerminalTabs\(\)/);
  assert.match(renderer, /function markShownTabs\(\)/);
  assert.doesNotMatch(renderer, /reparentNonTerminalTabs\(\)/);
  assert.match(renderer, /paneId: focusedPane\(\)\?\.id/);
});

test('B1 usability: closing a tab only affects its hosting pane', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /const hostPane = panes\.find\(\(p\) => p\.view && p\.view\.type === 'preview'/);
  // Both close paths clear the hosted view unconditionally (the document is
  // gone regardless of which pane has the keyboard).
  assert.match(renderer, /if \(hostPane\) \{\s*\n\s*hostPane\.view = null;\s*\n\s*placeSurfaces\(\);/);
});

test('B1 usability: send destination follows the focused pane', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /function sendTargetTabId\(\)/);
  const update = renderer.match(/function updateSendTarget\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(update, /sendTargetTabId\(\)/);
});

test('B1 usability: hosted views are validated on restore and persisted', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /function validatePaneViews\(\)/);
  assert.match(renderer, /view: p\.view && p\.view\.type !== 'terminal' \? \{ type: p\.view\.type, path: p\.view\.path/);
});

test('B1 stability: guest calls always settle, preview switches cannot hang', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /function guestJs\(promise, ms, label\)/);
  const gate = renderer.match(/const serial = \+\+previewSwitchSerial;[\s\S]*?const previous = previewFiles\.get\(activePreviewPath\);/)[0];
  assert.match(gate, /guestJs\(pendingPreviewScrollCapture/);
  // executeJavaScript sites go through the timeout wrapper.
  const jsCalls = renderer.match(/previewWebview\.executeJavaScript\(/g) || [];
  const wrapped = renderer.match(/guestJs\(previewWebview\.executeJavaScript\(/g) || [];
  assert.equal(wrapped.length, jsCalls.length, `unwrapped guest calls: ${jsCalls.length - wrapped.length}`);
});

test('B1 stability: same-document preview re-show skips reload', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /previewWebview\.getURL\(\) === url/);
});

test('B1 stability: tab moves tolerate missing source pane', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /if \(from\) \{\s*\n\s*from\.tabIds = from\.tabIds\.filter/);
});

test('B1 pane UX: splitters drive flex-basis (width alone loses to flex 1 1 0%)', () => {
  const renderer = read('renderer.js');
  const vsplit = renderer.match(/function makeVSplitter\(splitterEl, leftEl, rightEl, minLeft, minRight, onResizeEnd\) \{[\s\S]*?\n\}/)[0];
  assert.match(vsplit, /leftEl\.style\.flexBasis = newWidth \+ 'px'/);
  const sizes = renderer.match(/function applyPaneSizes\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(sizes, /flexBasis/);
});

test('B1 splitter: pointer capture, container-relative clamp, no ghost handlers', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /function makePaneSplitter\(splitterEl, prevRoot, nextRoot, prevState, nextState, horizontal\)/);
  const body = renderer.slice(renderer.indexOf('function makePaneSplitter('), renderer.indexOf('function makePaneSplitter(') + 6000);
  assert.match(body, /setPointerCapture/);
  assert.match(body, /terminalContainer\.clientWidth/);
  assert.match(body, /terminalContainer\.clientHeight/);
  assert.match(body, /root\.style\.flexBasis/);
  assert.match(body, /root\.style\.flexGrow/);
  assert.doesNotMatch(body, /document\.addEventListener/);
  // Shared splitters stop on buttonless moves (missed mouseup guard).
  assert.match(renderer, /e\.buttons !== undefined && \(e\.buttons & 1\) === 0/);
});

test('B1 pane UX: tab bars accept OS file drops, boundaries always visible', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /const isOsFileDrag = types\.includes\('Files'\)/);
  assert.match(renderer, /getDroppedFilePaths\(e\)/);
  const css = read('styles.css');
  assert.match(css, /\.pane-splitter:hover/);
  assert.match(css, /outline: 1px solid var\(--g-2\)/);
});

test('B1 tab bar UX: slim always-visible scrollbar from shared tokens', () => {
  const css = read('styles.css');
  assert.match(css, /\.pane-tab-bar::-webkit-scrollbar \{\s*\n\s*height: 7px;/);
  assert.match(css, /scrollbar-color: var\(--scrollbar-thumb\) transparent;/);
  assert.match(css, /background-clip: content-box;/);
  // Empty bars keep a drop hit area.
  assert.match(css, /min-height: 24px;/);
});

test('B1 tab bar UX: vertical wheel scrolls the bar horizontally', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /closest\?\.\('\.pane-tab-bar'\)/);
  assert.match(renderer, /bar\.scrollLeft \+= delta/);
});

test('B1 membership: opening a second preview must not re-host the first one', () => {
  const renderer = read('renderer.js');
  // openFileInPreview must not call showPreviewPane() before switchPreviewTab
  // — activePreviewPath still points at the previous preview there, and
  // hosting would rewrite the old tab's paneId (cross-pane tab migration).
  const body = renderer.slice(
    renderer.indexOf('async function openFileInPreview('),
    renderer.indexOf('async function openBrowserUrl('),
  );
  assert.match(body, /do NOT showPreviewPane\(\) here/);
  assert.match(body, /const loaded = await switchPreviewTab\(previewPath/);
});

test('B1 drag UX: drop target marks pane body, dragend clears all cues', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /paneRoot\?\.classList\.add\('drop-target'\)/);
  const clears = renderer.match(/terminal-pane-item\.drop-target/g) || [];
  assert.ok(clears.length >= 3, 'all three dragend paths must clear drop-target');
  const css = read('styles.css');
  assert.match(css, /\.terminal-pane-item\.drop-target > \.terminal-pane-body::before/);
  assert.match(css, /\.main-tab\.drag-over \{[\s\S]*?box-shadow: inset 3px 0 var\(--act\)/);
  assert.match(css, /\.main-tab\.dragging \{[\s\S]*?opacity: \.35/);
});

test('B1 audit fixes: stale awaits, monotonic ids, project guards', () => {
  const renderer = read('renderer.js');
  // createTerminal re-checks the project after ptyCreate (stale flag fix).
  assert.match(renderer, /Re-check AFTER the ptyCreate await/);
  // switchTab refuses foreign-project tabs.
  const st = renderer.slice(renderer.indexOf('function switchTab('), renderer.indexOf('function resizeTerminalToContainer('));
  assert.match(st, /t\.projectId !== activeProjectId\) return;/);
  // nextPaneId only ever rises (state restore).
  assert.match(renderer, /nextPaneId = Math\.max\(nextPaneId,/);
  // layoutNonTerminalTabs guards foreign projects' paneIds.
  assert.match(renderer, /f\.projectId === activeEditorProjectId && !getPane\(f\.paneId\)/);
  // moveTabToPane re-validates dest after the switch_tab await.
  assert.match(renderer, /if \(!panes\.includes\(dest\)\) return;/);
  // loadLayout keeps idMap aligned on failed creates.
  assert.match(renderer, /idMap\.push\(null\);/);
  // activeMainView restore rejects 'search'.
  assert.match(renderer, /\['terminal', 'file', 'preview'\]\.includes\(state\.activeMainView\)/);
  // closeFocusedPane keeps the surviving pane's hosted surface.
  const cfp = renderer.match(/function closeFocusedPane\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(cfp, /if \(target\.view\) \{/);
});

test('B1 tab DnD: same-bar reorder consumes the drop, cross-pane bubbles', () => {
  const renderer = read('renderer.js');
  // Terminal + editor tab drops stop propagation on same-parent reorder.
  const reorderStops = renderer.match(/parent\.contains\(tabEl\)\) \{[\s\S]*?insertBefore\(/g) || [];
  assert.ok(reorderStops.length >= 2, 'terminal + editor reorder must stopPropagation');
  assert.match(renderer, /e\.stopPropagation\(\);\s*\n\s*parent\.insertBefore\(draggedTerminalTab, tabEl\);/);
  // Bar handler resolves non-terminal source panes via entry paneId
  // (paneOfTab only knows terminal ids).
  assert.match(renderer, /openFiles\.get\(nonTermPath\) \|\| previewFiles\.get\(nonTermPath\)/);
  // Preview/browser tabs get their own same-bar reorder drop.
  assert.match(renderer, /Same-bar reorder for tab kinds without their own drop handler/);
});

test('B1 membership: normalized on render, retired with panes, same-pane close', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /function normalizePaneMembership\(\)/);
  assert.match(renderer, /function retirePaneMembership\(deadId, survivorId\)/);
  const render = renderer.match(/function renderPanes\(\) \{[\s\S]*?\n  terminalContainer\.innerHTML/)[0];
  assert.match(render, /normalizePaneMembership\(\);/);
  // Closing a terminal prefers the next tab in the same pane.
  const close = renderer.match(/const closedPane = paneOfTab\(tabId\);[\s\S]*?if \(nextId === null\)/)[0];
  assert.match(close, /for \(const tid of closedPane\.tabIds\)/);
  // Creation never disagrees about the owning pane.
  assert.match(renderer, /Re-home it so[\s\S]*?element and membership never disagree/);
});
