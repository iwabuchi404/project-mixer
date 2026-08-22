// test/codemirror.test.cjs
// Phase 4.5 A1/A2: CodeMirror 6 editor migration.
//
// Covers:
// - doc-state helpers (dirty detection, cursor/selection lines) and their
//   equivalence with the previous textarea computations
// - D9 guardrail: only the three approved CM6 packages, no basicSetup,
//   no lang/autocomplete/LSP packages anywhere in dependencies
// - static wiring of the single EditorView mount and per-file state swap

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

async function importEsm(rel) {
  return import('file://' + path.join(root, rel).replace(/\\/g, '/'));
}

// ---------------------------------------------------------------------------
// doc-state helpers (real EditorState instances)
// ---------------------------------------------------------------------------

test('A2: isDocDirty detects edits against originalContent', async () => {
  const { EditorState } = await import('@codemirror/state');
  const docs = await importEsm('src/editor/doc-state.mjs');

  const state = EditorState.create({ doc: 'hello' });
  assert.equal(docs.isDocDirty(state, 'hello'), false);
  const edited = state.update({ changes: { from: 5, to: 5, insert: '!' } }).state;
  assert.equal(docs.isDocDirty(edited, 'hello'), true);
  assert.equal(docs.getDocText(edited), 'hello!');
});

test('A2: getCursorLine matches the previous textarea computation', async () => {
  const { EditorState } = await import('@codemirror/state');
  const docs = await importEsm('src/editor/doc-state.mjs');

  const content = 'ab\ncd\nef';
  // Old formula: value.substring(0, pos).split('\n').length
  for (const pos of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    const expected = content.substring(0, pos).split('\n').length;
    const state = EditorState.create({ doc: content, selection: { anchor: pos } });
    assert.equal(docs.getCursorLine(state), expected, `pos=${pos}`);
  }
});

test('A2: getSelectionLines matches the previous textarea computation', async () => {
  const { EditorState } = await import('@codemirror/state');
  const docs = await importEsm('src/editor/doc-state.mjs');

  const content = 'ab\ncd';
  const cases = [
    [0, 2], // "ab" -> lines 1-1
    [0, 3], // "ab\n" -> lines 1-2 (start of line 2 belongs to line 2)
    [0, 5], // whole doc -> lines 1-2
    [3, 5], // "cd" -> lines 2-2
    [2, 4], // "\nc" -> lines 1-2
  ];
  for (const [from, to] of cases) {
    const state = EditorState.create({ doc: content, selection: { anchor: from, head: to } });
    const before = content.substring(0, from).split('\n').length;
    const selected = content.substring(from, to);
    const expectedEnd = before + selected.split('\n').length - 1;
    assert.deepEqual(
      docs.getSelectionLines(state),
      { startLine: before, endLine: expectedEnd },
      `range ${from}-${to}`,
    );
  }
});

test('A2: getSelectionLines returns null for collapsed selections', async () => {
  const { EditorState } = await import('@codemirror/state');
  const docs = await importEsm('src/editor/doc-state.mjs');

  const state = EditorState.create({ doc: 'abc', selection: { anchor: 1 } });
  assert.equal(docs.getSelectionLines(state), null);
});

test('A2: lineStartOffset clamps out-of-range lines', async () => {
  const { EditorState } = await import('@codemirror/state');
  const docs = await importEsm('src/editor/doc-state.mjs');

  const state = EditorState.create({ doc: 'ab\ncd' });
  assert.equal(docs.lineStartOffset(state, 1), 0);
  assert.equal(docs.lineStartOffset(state, 2), 3);
  assert.equal(docs.lineStartOffset(state, 99), 3);
  assert.equal(docs.lineStartOffset(state, 0), 0);
  assert.equal(docs.lineStartOffset(state, -5), 0);
});

test('A2: EOL detection and restore round-trips CRLF files', async () => {
  const { EditorState } = await import('@codemirror/state');
  const docs = await importEsm('src/editor/doc-state.mjs');

  const crlfFile = '{\r\n  "a": 1\r\n}\r\n';
  assert.equal(docs.detectEol(crlfFile), '\r\n');
  assert.equal(docs.detectEol('{\n  "a": 1\n}\n'), '\n');

  // State creation normalizes CRLF to LF (CM6 behavior this compensates for).
  const state = EditorState.create({ doc: crlfFile });
  assert.equal(state.doc.toString().includes('\r'), false);

  // Restoring the EOL on save reproduces the original bytes.
  const restored = docs.applyEol(state.doc.toString(), docs.detectEol(crlfFile));
  assert.equal(restored, crlfFile);

  // LF files pass through unchanged.
  assert.equal(docs.applyEol('a\nb', '\n'), 'a\nb');
});

// ---------------------------------------------------------------------------
// D9 guardrail
// ---------------------------------------------------------------------------

test('D9 guardrail: no forbidden editor packages in dependencies', () => {
  const pkg = JSON.parse(read('package.json'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const forbidden = Object.keys(allDeps).filter((name) =>
    /^@codemirror\/lang-/.test(name)
    || name === '@codemirror/autocomplete'
    || name === '@codemirror/lint'
    || /(^|\/)(typescript-language-server|vscode-languageserver|lsp)/.test(name),
  );
  assert.deepEqual(forbidden, []);
});

test('D9 guardrail: exactly the three approved CM6 packages are installed', () => {
  const pkg = JSON.parse(read('package.json'));
  const cmPackages = Object.keys(pkg.dependencies).filter((name) => name.startsWith('@codemirror/'));
  assert.deepEqual(cmPackages.sort(), [
    '@codemirror/commands',
    '@codemirror/state',
    '@codemirror/view',
  ]);
});

test('D9 guardrail: cm6.mjs does not use basicSetup', () => {
  const source = read(path.join('src', 'editor', 'cm6.mjs'))
    .replace(/\/\/.*$/gm, '');
  // basicSetup lives in the "codemirror" meta package — importing it is
  // forbidden. Extensions must come from the three approved packages only.
  assert.doesNotMatch(source, /from\s+'codemirror'/);
  assert.doesNotMatch(source, /@codemirror\/(lang-|autocomplete|lint)/);
});

// ---------------------------------------------------------------------------
// A3: line reveal highlight (StateField + Decoration.line)
// ---------------------------------------------------------------------------

async function makeHighlightState(doc) {
  const { EditorState } = await import('@codemirror/state');
  const cm6 = await importEsm('src/editor/cm6.mjs');
  const state = EditorState.create({ doc, extensions: cm6.buildExtensions() });
  return { state, cm6 };
}

test('A3: setLineHighlight decorates the requested range', async () => {
  const { state, cm6 } = await makeHighlightState('l1\nl2\nl3\nl4');
  const next = state.update({
    effects: cm6.setLineHighlight.of({ startLine: 2, endLine: 3 }),
  }).state;
  assert.deepEqual(cm6.getHighlightedLines(next), { startLine: 2, endLine: 3 });
  assert.equal(cm6.getHighlightedLines(state), null);
});

test('A3: a new reveal replaces the previous highlight', async () => {
  const { state, cm6 } = await makeHighlightState('l1\nl2\nl3\nl4');
  let cur = state.update({ effects: cm6.setLineHighlight.of({ startLine: 1 }) }).state;
  cur = cur.update({ effects: cm6.setLineHighlight.of({ startLine: 4 }) }).state;
  assert.deepEqual(cm6.getHighlightedLines(cur), { startLine: 4, endLine: 4 });
});

test('A3: editing the document clears the highlight (D13-3)', async () => {
  const { state, cm6 } = await makeHighlightState('l1\nl2\nl3');
  let cur = state.update({ effects: cm6.setLineHighlight.of({ startLine: 2 }) }).state;
  cur = cur.update({ changes: { from: 0, insert: 'x' } }).state;
  assert.equal(cm6.getHighlightedLines(cur), null);
});

test('A3: highlight survives selection-only transactions and maps across edits when set together', async () => {
  const { state, cm6 } = await makeHighlightState('l1\nl2');
  // Selection change alone must not clear.
  let cur = state.update({ selection: { anchor: 0 } }).state;
  cur = cur.update({ effects: cm6.setLineHighlight.of({ startLine: 1 }) }).state;
  cur = cur.update({ selection: { anchor: 1 } }).state;
  assert.deepEqual(cm6.getHighlightedLines(cur), { startLine: 1, endLine: 1 });
  // Edit + new reveal in one transaction: effect wins over the clear rule.
  cur = cur.update({
    changes: { from: 5, insert: '\nl3' },
    effects: cm6.setLineHighlight.of({ startLine: 3 }),
  }).state;
  assert.deepEqual(cm6.getHighlightedLines(cur), { startLine: 3, endLine: 3 });
});

test('A3: out-of-range lines are clamped to the document', async () => {
  const { state, cm6 } = await makeHighlightState('l1\nl2');
  const next = state.update({
    effects: cm6.setLineHighlight.of({ startLine: 99, endLine: 200 }),
  }).state;
  assert.deepEqual(cm6.getHighlightedLines(next), { startLine: 2, endLine: 2 });
});

test('A3: preview_reveal routes text/code files to the editor', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /async function revealInEditor\(filePath, line, endLine\)/);
  assert.match(renderer, /!preview\.isBrowser && !isImage\(preview\.name\) && !isHtml\(preview\.name\) && !isMarkdown\(preview\.name\)/);
  // jumpEditorToLine highlights as well (terminal link pointing).
  assert.match(renderer, /function jumpEditorToLine\(line, endLine\) \{\s*\n\s*revealLine\(fileEditorView, line, endLine\);/);
});

// ---------------------------------------------------------------------------
// Static wiring
// ---------------------------------------------------------------------------

test('A1: index.html mounts a single CM6 container instead of the textarea', () => {
  const html = read('index.html');
  assert.match(html, /id="file-editor-mount"/);
  assert.doesNotMatch(html, /id="file-editor-textarea"/);
});

test('A2: renderer swaps per-file EditorState via setState on tab switch', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /createEditorKit\(\{/);
  assert.match(renderer, /fileEditorView\.setState\(f\.state\)/);
  assert.match(renderer, /const state = editorKit\.createState\(result\.content\)/);
  assert.match(renderer, /originalContent: state\.doc\.toString\(\)/);
  assert.match(renderer, /eol: detectEol\(result\.content\)/);
  assert.match(renderer, /applyEol\(f\.content, f\.eol/);
  assert.match(renderer, /isDocDirty\(f\.state, f\.originalContent\)/);
  // No leftover references to the removed textarea element.
  assert.doesNotMatch(renderer, /fileEditorTextarea/);
});

test('A1: per-file states carry the shared extensions (EditorView ignores extensions when state is given)', () => {
  const source = read(path.join('src', 'editor', 'cm6.mjs'));
  // The kit must build one extensions array and use it both for the view
  // (doc + extensions form) and for createState().
  assert.match(source, /new EditorView\(\{ parent, doc, extensions \}\)/);
  assert.match(source, /EditorState\.create\(\{ doc: docText, extensions \}\)/);
});

test('A2: update_editor_content fires from the CM6 updateListener', () => {
  const renderer = read('renderer.js');
  assert.match(renderer, /onDocChanged[\s\S]*?dispatch\('update_editor_content'/);
  assert.match(renderer, /onSelectionChanged: \(\) => dispatch\('update_editor_selection'\)/);
});
