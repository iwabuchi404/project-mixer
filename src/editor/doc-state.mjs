// src/editor/doc-state.mjs
// Pure helpers over CodeMirror EditorState objects (Phase 4.5 A2).
// Duck-typed on state.doc / state.selection so they are unit-testable
// without a DOM. Runtime handles (EditorView, DOM nodes) stay out of here.

export function getDocText(state) {
  return state.doc.toString();
}

// Dirty detection: same semantics as the previous
// f.content !== f.originalContent, with the EditorState as source of truth.
export function isDocDirty(state, originalContent) {
  return state.doc.toString() !== originalContent;
}

// 1-based cursor line. Mirrors the previous textarea computation
// (value.substring(0, pos).split('\n').length).
export function getCursorLine(state) {
  return state.doc.lineAt(state.selection.main.head).number;
}

// Selection as 1-based { startLine, endLine }, or null when collapsed.
// Mirrors the previous textarea semantics: a position at the start of a
// line belongs to that line (substring().split('\n').length behavior).
export function getSelectionLines(state) {
  const main = state.selection.main;
  if (main.to <= main.from) return null;
  return {
    startLine: state.doc.lineAt(main.from).number,
    endLine: state.doc.lineAt(main.to).number,
  };
}

// Character offset of the start of a 1-based line, clamped to the document.
export function lineStartOffset(state, line) {
  const target = Math.min(Math.max(1, line), state.doc.lines);
  return state.doc.line(target).from;
}

// EditorState.create normalizes CRLF to LF. To keep dirty detection and
// file saving byte-faithful, remember the file's dominant EOL and restore
// it when writing back to disk.
export function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function applyEol(text, eol) {
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

// A4: scratch reference label for a selection, e.g. "src/a.ts:L10-L20".
// Single-line selections collapse to "path:L10".
export function formatLineReference(path, { startLine, endLine }) {
  const from = Math.max(1, startLine);
  return endLine && endLine > from
    ? `${path}:L${from}-L${endLine}`
    : `${path}:L${from}`;
}
