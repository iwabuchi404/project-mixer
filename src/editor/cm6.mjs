// src/editor/cm6.mjs
// CodeMirror 6 editor surface (Phase 4.5).
//
// D9 guardrail: dependencies are limited to @codemirror/state,
// @codemirror/view and @codemirror/commands. basicSetup is NOT used —
// it bundles autocompletion() and lintKeymap, which violate the guardrail
// (@codemirror/lang-* / @codemirror/autocomplete / LSP must never appear
// in package.json). Extensions are enumerated explicitly below.

import { EditorState, StateEffect, StateField } from '@codemirror/state';
import {
  EditorView,
  Decoration,
  lineNumbers,
  highlightActiveLineGutter,
  highlightActiveLine,
  drawSelection,
  dropCursor,
  keymap,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

// Preserves the previous textarea behavior: Tab inserts two spaces.
// Text input behavior, not a keybinding (same rule as insertIndent in
// renderer.js before the migration).
function insertTwoSpaces(view) {
  view.dispatch(view.state.replaceSelection('  '));
  return true;
}

// --- Line reveal highlight (Phase 4.5 A3) ---
// show_file's "pointing at a line" lands here as a persistent line
// decoration. D13-3 (decided 2026-08-22): the highlight is replaced by the
// next reveal and cleared as soon as the document is edited.

export const setLineHighlight = StateEffect.define();

function buildHighlightDecos(range, doc) {
  if (!range) return Decoration.none;
  const start = Math.min(Math.max(1, range.startLine), doc.lines);
  const end = Math.min(Math.max(start, range.endLine ?? start), doc.lines);
  const decos = [];
  for (let line = start; line <= end; line++) {
    decos.push(Decoration.line({ class: 'pm-line-reveal-highlight' }).range(doc.line(line).from));
  }
  return Decoration.set(decos, true);
}

const lineHighlightField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setLineHighlight)) {
        next = buildHighlightDecos(effect.value, tr.state.doc);
      }
    }
    if (tr.docChanged && !tr.effects.some((e) => e.is(setLineHighlight))) {
      next = Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Read back the highlighted 1-based line range, or null when no highlight
// is set. Used by tests and by renderer assertions.
export function getHighlightedLines(state) {
  const decos = state.field(lineHighlightField, false);
  if (!decos || !decos.size) return null;
  let startLine = null;
  let endLine = null;
  const cursor = decos.iter();
  while (cursor.value) {
    const number = state.doc.lineAt(cursor.from).number;
    if (startLine === null || number < startLine) startLine = number;
    if (endLine === null || number > endLine) endLine = number;
    cursor.next();
  }
  return { startLine, endLine };
}

export function buildExtensions({ onDocChanged, onSelectionChanged } = {}) {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    dropCursor(),
    history(),
    lineHighlightField,
    keymap.of([{ key: 'Tab', run: insertTwoSpaces }]),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged && !update.selectionSet) return;
      if (update.docChanged && onDocChanged) onDocChanged(update);
      if ((update.docChanged || update.selectionSet) && onSelectionChanged) {
        onSelectionChanged(update);
      }
    }),
  ];
}

// Creates the single EditorView plus a state factory for additional files.
//
// The extensions array is shared between the initial view state and every
// per-file state: EditorView ignores the `extensions` option when a full
// `state` is supplied, so states mounted later via view.setState() MUST
// carry the extensions themselves (history, updateListener included).
export function createEditorKit({ parent, doc = '', onDocChanged, onSelectionChanged }) {
  const extensions = buildExtensions({ onDocChanged, onSelectionChanged });
  return {
    view: new EditorView({ parent, doc, extensions }),
    createState: (docText = '') => EditorState.create({ doc: docText, extensions }),
  };
}

// Scroll a 1-based line to the top of the viewport, place the cursor at its
// start, and highlight the 1-based line range (line..endLine). Matches the
// previous jumpEditorToLine behavior for textareas, plus the A3 highlight.
export function revealLine(view, line, endLine = line) {
  const target = Math.min(Math.max(1, line), view.state.doc.lines);
  const pos = view.state.doc.line(target).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: [
      EditorView.scrollIntoView(pos, { y: 'start' }),
      setLineHighlight.of({ startLine: line, endLine }),
    ],
  });
  view.focus();
}
