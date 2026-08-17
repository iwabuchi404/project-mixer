const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('url');
const path = require('path');

async function loadKb() {
  return import(pathToFileURL(path.join(__dirname, '..', 'src', 'keybindings', 'registry.js')).href);
}

// --- keyToString ---

test('keyToString normalizes modifier+key combinations', async () => {
  const { keyToString } = await loadKb();
  assert.equal(keyToString({ ctrlKey: true, key: 's' }), 'Ctrl+S');
  assert.equal(keyToString({ ctrlKey: true, shiftKey: true, key: 'C' }), 'Ctrl+Shift+C');
  assert.equal(keyToString({ ctrlKey: true, shiftKey: true, key: 'c' }), 'Ctrl+Shift+C');
  assert.equal(keyToString({ key: 'Escape' }), 'Escape');
  assert.equal(keyToString({ key: ' ' }), 'Space');
  assert.equal(keyToString({ key: '/' }), 'Slash');
  assert.equal(keyToString({ ctrlKey: true, key: 'Enter' }), 'Ctrl+Enter');
  assert.equal(keyToString({ ctrlKey: true, key: 'b' }), 'Ctrl+B');
});

// --- evaluateWhen ---

test('evaluateWhen returns true for null/empty when', async () => {
  const { evaluateWhen } = await loadKb();
  assert.equal(evaluateWhen(null, new Set(['terminalFocus'])), true);
  assert.equal(evaluateWhen('', new Set()), true);
  assert.equal(evaluateWhen(undefined, new Set()), true);
});

test('evaluateWhen matches single context', async () => {
  const { evaluateWhen } = await loadKb();
  assert.equal(evaluateWhen('terminalFocus', new Set(['terminalFocus'])), true);
  assert.equal(evaluateWhen('terminalFocus', new Set(['editorFocus'])), false);
});

test('evaluateWhen handles && operator', async () => {
  const { evaluateWhen } = await loadKb();
  assert.equal(evaluateWhen('treeFocus && treeFilterActive', new Set(['treeFocus', 'treeFilterActive'])), true);
  assert.equal(evaluateWhen('treeFocus && treeFilterActive', new Set(['treeFocus'])), false);
});

test('evaluateWhen handles || operator', async () => {
  const { evaluateWhen } = await loadKb();
  assert.equal(evaluateWhen('editorFocus || previewFocus', new Set(['editorFocus'])), true);
  assert.equal(evaluateWhen('editorFocus || previewFocus', new Set(['previewFocus'])), true);
  assert.equal(evaluateWhen('editorFocus || previewFocus', new Set(['terminalFocus'])), false);
});

test('evaluateWhen handles ! operator', async () => {
  const { evaluateWhen } = await loadKb();
  assert.equal(evaluateWhen('!terminalFocus', new Set(['editorFocus'])), true);
  assert.equal(evaluateWhen('!terminalFocus', new Set(['terminalFocus'])), false);
});

test('evaluateWhen handles complex expressions', async () => {
  const { evaluateWhen } = await loadKb();
  assert.equal(
    evaluateWhen('editorFocus || previewFocus', new Set(['previewFocus'])),
    true,
  );
  assert.equal(
    evaluateWhen('!terminalFocus && editorFocus', new Set(['editorFocus'])),
    true,
  );
  assert.equal(
    evaluateWhen('!terminalFocus && editorFocus', new Set(['terminalFocus', 'editorFocus'])),
    false,
  );
});

// --- detectConflicts ---

test('detectConflicts finds overlapping bindings with same key', async () => {
  const { detectConflicts } = await loadKb();
  const bindings = [
    { key: 'Ctrl+S', command: 'save', when: 'editorFocus' },
    { key: 'Ctrl+S', command: 'other', when: 'editorFocus' },
  ];
  const conflicts = detectConflicts(bindings);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].key, 'Ctrl+S');
});

test('detectConflicts does not flag non-overlapping when clauses', async () => {
  const { detectConflicts } = await loadKb();
  // editorFocus and !editorFocus are mutually exclusive (positive vs negative).
  const bindings = [
    { key: 'Ctrl+S', command: 'save', when: 'editorFocus' },
    { key: 'Ctrl+S', command: 'send', when: '!editorFocus' },
  ];
  const conflicts = detectConflicts(bindings);
  assert.equal(conflicts.length, 0);
});

test('detectConflicts does not flag different focus contexts', async () => {
  const { detectConflicts } = await loadKb();
  // editorFocus and terminalFocus are both focus contexts — mutually exclusive.
  const bindings = [
    { key: 'Ctrl+S', command: 'save', when: 'editorFocus' },
    { key: 'Ctrl+S', command: 'send', when: 'terminalFocus' },
  ];
  const conflicts = detectConflicts(bindings);
  assert.equal(conflicts.length, 0);
});

test('detectConflicts flags coexistable positive constraints', async () => {
  const { detectConflicts } = await loadKb();
  // editorFocus (focus) and findOpen (state) can both be true at the same time.
  const bindings = [
    { key: 'Ctrl+F', command: 'find', when: 'editorFocus' },
    { key: 'Ctrl+F', command: 'other', when: 'findOpen' },
  ];
  const conflicts = detectConflicts(bindings);
  assert.equal(conflicts.length, 1);
});

test('detectConflicts flags global (null when) overlap with anything', async () => {
  const { detectConflicts } = await loadKb();
  const bindings = [
    { key: 'Ctrl+B', command: 'toggle', when: null },
    { key: 'Ctrl+B', command: 'other', when: 'terminalFocus' },
  ];
  const conflicts = detectConflicts(bindings);
  assert.equal(conflicts.length, 1);
});

test('detectConflicts handles Escape with different when clauses', async () => {
  const { detectConflicts } = await loadKb();
  // Escape: close_overlay_menus (!treeFocus && !searchFocus) vs
  // tree_filter_clear (treeFocus) vs search_close (searchFocus).
  // These should NOT conflict because treeFocus and searchFocus are
  // mutually exclusive focus contexts, and close_overlay_menus negates both.
  const bindings = [
    { key: 'Escape', command: 'close_overlay_menus', when: '!treeFocus && !searchFocus' },
    { key: 'Escape', command: 'tree_filter_clear', when: 'treeFocus' },
    { key: 'Escape', command: 'search_close', when: 'searchFocus' },
  ];
  const conflicts = detectConflicts(bindings);
  assert.equal(conflicts.length, 0);
});

// --- validateBindings ---

test('validateBindings throws on conflicts', async () => {
  const { validateBindings } = await loadKb();
  const bindings = [
    { key: 'Ctrl+S', command: 'save', when: 'editorFocus' },
    { key: 'Ctrl+S', command: 'other', when: 'editorFocus' },
  ];
  assert.throws(() => validateBindings(bindings), /Conflicting bindings/);
});

test('validateBindings does not throw on clean bindings', async () => {
  const { validateBindings } = await loadKb();
  const bindings = [
    { key: 'Ctrl+S', command: 'save', when: 'editorFocus' },
    { key: 'Ctrl+S', command: 'send', when: 'terminalFocus' },
  ];
  validateBindings(bindings); // should not throw
});

// --- matchBinding ---

test('matchBinding returns matching binding for context', async () => {
  const { matchBinding, BINDINGS } = await loadKb();
  const event = { ctrlKey: true, shiftKey: false, key: 'b' };
  // Ctrl+B is now !terminalFocus, so it matches in editor context.
  const ctx = new Set(['editorFocus']);
  const binding = matchBinding(event, ctx);
  assert.ok(binding);
  assert.equal(binding.command, 'toggle_sidebar');
});

test('matchBinding returns null when no binding matches context', async () => {
  const { matchBinding } = await loadKb();
  // Ctrl+S with terminalFocus should not match (save is for editorFocus/scratchFocus)
  const event = { ctrlKey: true, shiftKey: false, key: 's' };
  const ctx = new Set(['terminalFocus']);
  const binding = matchBinding(event, ctx);
  assert.equal(binding, null);
});

test('Ctrl+B does not fire in terminalFocus (discipline 4)', async () => {
  const { matchBinding } = await loadKb();
  const event = { ctrlKey: true, shiftKey: false, key: 'b' };
  const ctx = new Set(['terminalFocus']);
  const binding = matchBinding(event, ctx);
  assert.equal(binding, null);
});

test('matchBinding returns Ctrl+Shift+F for search_text_open globally', async () => {
  const { matchBinding } = await loadKb();
  const event = { ctrlKey: true, shiftKey: true, key: 'F' };
  const ctx = new Set(['terminalFocus']);
  const binding = matchBinding(event, ctx);
  assert.ok(binding);
  assert.equal(binding.command, 'search_text_open');
});

// --- BINDINGS table integrity ---

test('default BINDINGS table has no conflicts', async () => {
  const { validateBindings, BINDINGS } = await loadKb();
  // Should not throw.
  validateBindings(BINDINGS);
});

test('BINDINGS includes all migrated bindings', async () => {
  const { BINDINGS } = await loadKb();
  const keys = BINDINGS.map(b => b.key);
  assert.ok(keys.includes('Ctrl+S'));
  assert.ok(keys.includes('Ctrl+Enter'));
  assert.ok(keys.includes('Ctrl+I'));
  assert.ok(keys.includes('Ctrl+Shift+Z'));
  assert.ok(keys.includes('Ctrl+Shift+C'));
  // Ctrl+V is deliberately NOT in the registry — it must not preventDefault
  // so native paste works. It's handled by a dedicated listener.
  assert.ok(!keys.includes('Ctrl+V'));
  assert.ok(keys.includes('Ctrl+B'));
  assert.ok(keys.includes('Escape'));
  assert.ok(keys.includes('Ctrl+Shift+F'));
});

// ============================================================
// Phase 5 S2: search command building and line parsing
// ============================================================

const { buildSearchCommand, parseSearchLine, resolveSearchPath } = require('../src/files/search-command.cjs');

// --- buildSearchCommand ---

test('buildSearchCommand builds rg command with case-insensitive flag', () => {
  const result = buildSearchCommand('rg', 'foo', false);
  assert.equal(result.cmd, 'rg');
  assert.ok(result.args.includes('--line-number'));
  assert.ok(result.args.includes('--no-heading'));
  assert.ok(result.args.includes('--color=never'));
  assert.ok(result.args.includes('-F'), 'must include -F for fixed string search');
  assert.ok(result.args.includes('-i'));
  assert.ok(result.args.includes('-e'), 'must include -e to handle queries starting with -');
  assert.ok(result.args.includes('foo'));
  assert.ok(result.args.includes('.'));
});

test('buildSearchCommand builds rg command without -i when caseSensitive', () => {
  const result = buildSearchCommand('rg', 'foo', true);
  assert.equal(result.cmd, 'rg');
  assert.ok(!result.args.includes('-i'));
});

test('buildSearchCommand builds git grep with --no-optional-locks', () => {
  const result = buildSearchCommand('git', 'foo', false);
  assert.equal(result.cmd, 'git');
  assert.ok(result.args.includes('--no-optional-locks'), 'must include --no-optional-locks to avoid index.lock contention');
  assert.ok(result.args.includes('grep'));
  assert.ok(result.args.includes('--untracked'));
  assert.ok(result.args.includes('-n'));
  assert.ok(result.args.includes('-F'), 'must include -F for fixed string search');
  assert.ok(result.args.includes('-i'));
  assert.ok(result.args.includes('-e'), 'must include -e to handle queries starting with -');
  assert.ok(result.args.includes('foo'));
});

test('buildSearchCommand builds git grep case-sensitive without -i', () => {
  const result = buildSearchCommand('git', 'foo', true);
  assert.equal(result.cmd, 'git');
  assert.ok(!result.args.includes('-i'));
});

test('buildSearchCommand returns null for unknown command', () => {
  assert.equal(buildSearchCommand('find', 'foo', false), null);
  assert.equal(buildSearchCommand(null, 'foo', false), null);
});

// --- parseSearchLine ---

test('parseSearchLine parses file:line:text format', () => {
  const result = parseSearchLine('src/main.js:42:const x = 1;', '/project');
  assert.equal(result.line, 42);
  assert.equal(result.text, 'const x = 1;');
  // Path resolution is platform-dependent; just check it ends with the file.
  assert.ok(result.file.endsWith('src') || result.file.endsWith('src\\main.js') || result.file.endsWith('src/main.js'));
});

test('parseSearchLine parses Windows-style relative paths', () => {
  const result = parseSearchLine('src\\main.js:10:hello', 'D:\\project');
  assert.equal(result.line, 10);
  assert.equal(result.text, 'hello');
});

test('parseSearchLine handles colons in text content', () => {
  const result = parseSearchLine('src/main.js:5:url: http://localhost:3000', '/project');
  assert.equal(result.line, 5);
  assert.equal(result.text, 'url: http://localhost:3000');
});

test('parseSearchLine returns null for non-matching lines', () => {
  assert.equal(parseSearchLine('no colons here', '/project'), null);
  assert.equal(parseSearchLine('', '/project'), null);
});

// --- resolveSearchPath ---

test('resolveSearchPath keeps absolute paths', () => {
  const absolute = process.platform === 'win32' ? 'D:\\project\\src\\main.js' : '/project/src/main.js';
  assert.equal(resolveSearchPath(absolute, '/other'), absolute);
});

test('resolveSearchPath resolves relative paths against cwd', () => {
  const result = resolveSearchPath('src/main.js', '/project');
  // Path resolution is platform-dependent.
  assert.ok(result.includes('project'));
  assert.ok(result.includes('main.js'));
});
