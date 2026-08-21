// src/editor/cm6.mjs
// CodeMirror 6 editor surface (Phase 4.5 A1).
//
// D9 guardrail: dependencies are limited to @codemirror/state,
// @codemirror/view and @codemirror/commands. basicSetup is NOT used —
// it bundles autocompletion() and lintKeymap, which violate the guardrail
// (@codemirror/lang-* / @codemirror/autocomplete / LSP must never appear
// in package.json). Extensions are enumerated explicitly below.

import { EditorState } from '@codemirror/state';
import {
  EditorView,
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

export function buildExtensions({ onDocChanged, onSelectionChanged } = {}) {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    dropCursor(),
    history(),
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

// Scroll a 1-based line to the top of the viewport and place the cursor at
// its start. Matches the previous jumpEditorToLine behavior for textareas.
export function revealLine(view, line) {
  const target = Math.min(Math.max(1, line), view.state.doc.lines);
  const pos = view.state.doc.line(target).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: 'start' }),
  });
  view.focus();
}
