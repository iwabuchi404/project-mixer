const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function relativeLuminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => parseInt(value, 16) / 255);
  const [r, g, b] = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

test('Phase 4 tokens match the approved palette and scale', () => {
  const css = read('tokens.css');
  const expected = {
    '--g-0': '#16181c', '--g-1': '#1c1f24', '--g-2': '#23272e',
    '--g-3': '#2e333b', '--g-4': '#6b7280', '--g-5': '#c8ccd4',
    '--g-6': 'var(--g-5)', '--attn': '#c08b4d', '--act': '#5b9691',
    '--act-ink': '#0d1412',
    '--err': '#b56b66', '--ok': '#5f9278', '--s-1': '4px',
    '--s-2': '8px', '--s-3': '12px', '--s-4': '16px', '--s-5': '24px',
    '--t-sm': '11px', '--t-md': '13px', '--t-lg': '15px',
    '--r-1': '3px', '--r-2': '6px',
    '--scrollbar-size': '12px', '--scrollbar-border': '2px',
    '--scrollbar-radius': '6px', '--scrollbar-track': 'var(--g-1)',
    '--scrollbar-thumb': 'var(--g-3)', '--scrollbar-thumb-hover': 'var(--g-4)',
  };
  for (const [name, value] of Object.entries(expected)) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(css, new RegExp(`${name}:\\s*${escaped}`));
  }
  assert.equal((css.match(/--g-\d:/g) || []).length, 7);
  assert.equal((css.match(/--s-\d:/g) || []).length, 5);
  assert.equal((css.match(/--t-[a-z]+:/g) || []).length, 3);
  assert.equal((css.match(/--r-\d:/g) || []).length, 2);
  assert.equal((css.match(/--g-\d:\s*#[0-9a-f]{6}/gi) || []).length, 6);
  assert.ok(contrastRatio('#5b9691', '#0d1412') >= 4.5);
});

test('the workbench stylesheet is token-only instead of an override layer', () => {
  const css = read('styles.css');
  assert.doesNotMatch(css, /Phase 4\s+[—-]\s+unified workbench skin/);
  assert.equal((css.match(/#[0-9a-f]{3,8}\b/gi) || []).length, 0);
  assert.equal((css.match(/font-size:\s*\d+(?:\.\d+)?px/gi) || []).length, 0);
  assert.equal((css.match(/border-radius:\s*\d+(?:\.\d+)?px/gi) || []).length, 0);
  assert.match(css, /#send-btn,[\s\S]*color:\s*var\(--act-ink\);[\s\S]*background:\s*var\(--act\)/);
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
  assert.match(html, /id="scratch-header"[\s\S]*id="send-target"[\s\S]*id="send-btn"[\s\S]*id="scratch-collapse-btn"[\s\S]*id="editor-textarea"/);
  assert.doesNotMatch(html, /id="editor-tab-bar"|id="send-bar"/);
  assert.match(html, /id="file-editor-mount"/);
  const css = read('styles.css');
  const renderer = read('renderer.js');
  assert.match(css, /#editor-pane\s*\{[\s\S]*height:\s*112px/);
  assert.match(css, /#editor-pane\.collapsed,[\s\S]*height:\s*34px\s*!important/);
  assert.doesNotMatch(css, /#editor-pane:focus-within/);
  assert.match(renderer, /SCRATCH_COMPACT_HEIGHT = 112/);
  assert.match(renderer, /SCRATCH_DEFAULT_EXPANDED_HEIGHT = 220/);
  // Scratch size is stable — no focusin/focusout expand/shrink handlers.
  assert.doesNotMatch(renderer, /editorPane\.addEventListener\('focusin'/);
  assert.doesNotMatch(renderer, /editorPane\.addEventListener\('focusout'/);
  assert.match(renderer, /savedScratchEditorHeight = clampScratchExpandedHeight\(editorPane\.offsetHeight\)/);
});

test('tabs and pane gaps use wider visual and pointer targets', () => {
  const css = read('styles.css');
  assert.match(css, /#app\s*\{[\s\S]*gap:\s*2px/);
  assert.match(css, /#main-tab-bar\s*\{[\s\S]*height:\s*34px;[\s\S]*gap:\s*3px;[\s\S]*padding:\s*2px var\(--s-1\) var\(--s-1\)/);
  assert.match(css, /\.main-tab\.active\s*\{[\s\S]*background:\s*var\(--g-3\);[\s\S]*font-weight:\s*600/);
  assert.doesNotMatch(css, /\.main-tab\.active\s*\{[\s\S]*box-shadow:\s*inset 0 -/);
  assert.match(css, /\.vsplitter\s*\{[\s\S]*width:\s*2px;[\s\S]*flex:\s*0 0 2px/);
  assert.match(css, /\.vsplitter::before\s*\{[\s\S]*inset:\s*0 -4px/);
  assert.match(css, /#vsplitter-1::before,[\s\S]*inset:\s*-4px 0/);
  assert.match(css, /#splitter::before\s*\{[\s\S]*inset:\s*-4px 0/);
});

test('projects and files share a vertically resizable navigation column', () => {
  const html = read('index.html');
  const css = read('styles.css');
  const renderer = read('renderer.js');
  assert.match(html, /id="navigation-pane"[\s\S]*id="sidebar"[\s\S]*id="vsplitter-1" class="hsplitter"[\s\S]*id="file-tree-pane"[\s\S]*id="vsplitter-2" class="vsplitter"[\s\S]*id="main-pane"/);
  assert.match(css, /#navigation-pane\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(css, /\.hsplitter\s*\{[\s\S]*height:\s*2px;[\s\S]*cursor:\s*ns-resize/);
  assert.match(renderer, /function makeHSplitter\([\s\S]*clientY[\s\S]*minBottom/);
  assert.match(renderer, /makeHSplitter\(vsplitter1, sidebar, navigationPane/);
  assert.match(renderer, /makeVSplitter\(vsplitter2, navigationPane/);
});

test('navigation headers and main editors use the requested edge separation', () => {
  const css = read('styles.css');
  assert.match(css, /#sidebar-header,[\s\S]*#file-tree-header\s*\{[\s\S]*border-bottom:\s*1px solid var\(--g-2\)/);
  assert.match(css, /#project-list,[\s\S]*#file-tree\s*\{[\s\S]*box-shadow:\s*inset/);
  assert.match(css, /#preview-content\s*\{[\s\S]*padding-right:\s*var\(--s-1\)/);
  assert.match(css, /#file-editor-pane\s*\{[\s\S]*padding-right:\s*var\(--s-1\)/);
  assert.match(css, /#editor-content\s*\{[\s\S]*padding-right:\s*var\(--s-1\)/);
});

test('title bar menu button opens the existing Electron application menu', () => {
  const html = read('index.html');
  const css = read('styles.css');
  const renderer = read('renderer.js');
  const preload = read('preload.js');
  const main = read('main.js');
  assert.match(html, /id="title-bar"[\s\S]*id="app-menu-btn"/);
  assert.match(css, /#app-menu-btn\s*\{[\s\S]*-webkit-app-region:\s*no-drag/);
  assert.match(renderer, /appMenuBtn\.addEventListener\('click'[\s\S]*window\.api\.menuPopup/);
  assert.match(preload, /menuPopup:\s*\(x, y\) => ipcRenderer\.invoke\('menu:popup'/);
  assert.match(main, /applicationMenu = Menu\.buildFromTemplate\(template\)[\s\S]*Menu\.setApplicationMenu\(applicationMenu\)/);
  assert.match(main, /ipcMain\.handle\('menu:popup'[\s\S]*applicationMenu\.popup\(options\)/);
});

test('preview font follows the requested platform-specific Japanese mono stacks', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /const PREVIEW_FONT = \{[\s\S]*win32:[\s\S]*BIZ UDGothic[\s\S]*darwin:[\s\S]*Hiragino Sans[\s\S]*linux:[\s\S]*Noto Sans Mono CJK JP[\s\S]*\}\[PLATFORM\]/);
  assert.match(renderer, /body \{[^}]*font-family:\$\{PREVIEW_FONT\}/);
  assert.match(renderer, /code \{[^}]*font-family:\$\{PREVIEW_FONT\}/);
});

test('host and preview webview share one scrollbar stylesheet and token set', () => {
  const html = read('index.html');
  const css = read('scrollbars.css');
  const renderer = read('renderer.js');
  const build = read('build.cjs');
  const pkg = JSON.parse(read('package.json'));
  assert.match(html, /href="tokens\.css"[\s\S]*href="scrollbars\.css"[\s\S]*href="styles\.css"/);
  assert.match(css, /width:\s*var\(--scrollbar-size\)/);
  assert.match(css, /border:\s*var\(--scrollbar-border\) solid var\(--scrollbar-track\)/);
  assert.doesNotMatch(css, /scrollbar-width|scrollbar-color/);
  assert.match(renderer, /import sharedScrollbarCss from '\.\/scrollbars\.css'/);
  assert.match(renderer, /return `:root\{\$\{guestTokens\}\}\\n\$\{sharedScrollbarCss\}`/);
  assert.match(renderer, /previewWebview\.addEventListener\('dom-ready'[\s\S]*previewWebview\.insertCSS\(getPreviewScrollbarCss\(\)\)/);
  assert.match(build, /'\.css':\s*'text'/);
  assert.ok(pkg.build.files.includes('scrollbars.css'));
});

test('preview tabs retain independent scroll positions', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /function capturePreviewScroll\([\s\S]*document\.scrollingElement[\s\S]*f\.scrollPosition/);
  assert.match(renderer, /function restorePreviewScroll\([\s\S]*root\.scrollTop/);
  assert.match(renderer, /async function switchPreviewTab\([\s\S]*capturePreviewScroll\(previous\)[\s\S]*restorePreviewScroll\(f\)/);
});

test('tree focus controls creation targets and folders open in Explorer', () => {
  const html = read('index.html');
  const renderer = read('renderer.js');
  assert.match(renderer, /const TREE_ICONS = \{[\s\S]*folder:[\s\S]*file:/);
  assert.doesNotMatch(renderer, /\\u\{1F4C1\}|\\u\{1F4C4\}|📁|📄/);
  assert.match(renderer, /function selectTreeEntry\([\s\S]*aria-selected/);
  assert.match(renderer, /function getTreeCreateParent\([\s\S]*focusedTreeEntry\.isDirectory[\s\S]*pathDirname/);
  assert.match(renderer, /Create in: \$\{parentPath\}/);
  assert.match(html, /data-action="open-explorer"/);
  assert.match(renderer, /action === 'open-explorer'[\s\S]*window\.api\.openInOs/);
});

test('runtime metrics share the global status bar', () => {
  const html = read('index.html');
  const renderer = read('renderer.js');
  assert.doesNotMatch(html, /sidebar-footer|mem-display/);
  assert.match(html, /id="status-right"[\s\S]*id="status-system"/);
  assert.match(renderer, /statusSystem\.textContent = `\$\{mem\.workingSetMB\} MB/);
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

test('input-waiting events create persistent OS notifications with tab-scoped cleanup', () => {
  const renderer = read('renderer.js');
  assert.doesNotMatch(renderer, /Notification\.isSupported/);
  assert.match(renderer, /const visibleOsNotifications = new Map\(\)/);
  assert.match(renderer, /requireInteraction:\s*kind === 'needs_attention'/);
  assert.match(renderer, /tag:\s*`agent-attention-\$\{tabId\}`/);
  assert.match(renderer, /function closeOsNotification\(tabId\)/);
  assert.match(renderer, /if \(wasWaiting && !isWaiting\) closeOsNotification\(tabId\)/);
  assert.match(renderer, /const bodyParts = \[detailTitle, message\]/);
  assert.match(renderer, /bodyParts\.join\(' — '\) \|\| fallbackBody/);
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
