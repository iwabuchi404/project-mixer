// src/editor/cm6.mjs
// CodeMirror 6 editor surface (Phase 4.5).
//
// D9 guardrail: dependencies are limited to @codemirror/state,
// @codemirror/view, @codemirror/commands and @codemirror/search (added in
// Phase 5 S3 as the find bar's delegation target — explicitly approved by
// the S3 decision). basicSetup is NOT used —
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
import { search, setSearchQuery, findNext as cmFindNext, findPrevious as cmFindPrevious, selectNextOccurrence as cmSelectNextOccurrence, SearchQuery } from '@codemirror/search';

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

// --- Find match highlight (Phase 5 S3 follow-up) ---
// The stock search extension paints match decorations only while its panel
// is open. The shared find bar never opens the panel (D21), so this field
// paints fixed-string matches itself. The match containing the selection
// head is tagged -selected (findNext places the cursor inside it).

export const setFindHighlight = StateEffect.define(); // { query, caseSensitive } | null (clears)

function buildFindDecos(state, spec, head = null) {
  if (!spec || !spec.query) return Decoration.none;
  const docText = state.doc.sliceString(0);
  const hay = spec.caseSensitive ? docText : docText.toLowerCase();
  const needle = spec.caseSensitive ? spec.query : spec.query.toLowerCase();
  if (!needle) return Decoration.none;
  const decos = [];
  let pos = 0;
  for (;;) {
    const idx = hay.indexOf(needle, pos);
    if (idx === -1) break;
    // head (when provided) marks the match containing it as -selected.
    const cls = head !== null && idx <= head && head <= idx + needle.length
      ? 'cm-searchMatch cm-searchMatch-selected'
      : 'cm-searchMatch';
    decos.push(Decoration.mark({ class: cls }).range(idx, idx + needle.length));
    pos = idx + needle.length;
  }
  return Decoration.set(decos, true);
}

const findHighlightField = StateField.define({
  create: () => ({ query: '', caseSensitive: false, decos: Decoration.none }),
  update(value, tr) {
    let spec = { query: value.query, caseSensitive: value.caseSensitive };
    let forced = false;
    for (const effect of tr.effects) {
      if (effect.is(setFindHighlight)) {
        spec = effect.value || { query: '', caseSensitive: false };
        forced = true;
      }
    }
    // Recompute only on a new query or an edit (positions shift). NOT on
    // selection moves: repainting decorations on every cursor move rewrites
    // the DOM, which disturbs the native selection and makes CM6 read the
    // selection back as a single range — collapsing multi-cursor (Ctrl+D).
    // The current match is indicated by the native selection instead.
    if (!forced && !tr.docChanged) return value;
    if (!spec.query) return { ...spec, decos: Decoration.none };
    return { ...spec, decos: buildFindDecos(tr.state, spec, tr.state.selection.main.head) };
  },
  provide: (field) => EditorView.decorations.from(field, (v) => v.decos),
});

// Test/diagnostic accessor: read the painted match ranges (0-based offsets)
// and the selected one. Headless tests cannot read view decorations.
export function getFindHighlightRanges(state) {
  const v = state.field(findHighlightField, false);
  if (!v || !v.decos || !v.decos.size) return { ranges: [], selected: null };
  const ranges = [];
  let selected = null;
  const cursor = v.decos.iter();
  while (cursor.value) {
    const cls = cursor.value.spec.class || '';
    const range = { from: cursor.from, to: cursor.to };
    ranges.push(range);
    if (cls.includes('cm-searchMatch-selected')) selected = range;
    cursor.next();
  }
  return { ranges, selected };
}

export function buildExtensions({ onDocChanged, onSelectionChanged } = {}) {
  return [
    // VSCode-style multi-cursor (Ctrl+D): CM6 drops all but the main range
    // unless this facet is enabled.
    EditorState.allowMultipleSelections.of(true),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    dropCursor(),
    history(),
    // Phase 5 S3: query state for the shared find bar. The default search
    // panel and its keymap are deliberately NOT registered — a panel would
    // duplicate the bar and the keymap would bypass the keybinding
    // registry (D21). The panel is never opened, so no panel DOM exists.
    search(),
    // S3 follow-up: our own match decorations (the stock highlighter only
    // paints while the stock panel is open). The current match — the one
    // containing the selection head — gets the -selected class.
    findHighlightField,
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

// --- Shared find bar delegation (Phase 5 S3) ---

// Set the current search query from the find bar. caseSensitive maps to
// SearchQuery's caseSensitive flag; no regex (fixed-string only).
export function setEditorSearchQuery(view, queryString, { caseSensitive = false } = {}) {
  const query = new SearchQuery({ search: queryString, caseSensitive });
  view.dispatch({
    effects: [
      setSearchQuery.of(query),
      // The stock search extension only paints match highlights while its
      // panel is open — we never open the panel (D21), so paint our own.
      setFindHighlight.of({ query: queryString, caseSensitive }),
    ],
  });
}

export function editorFindNext(view) {
  return cmFindNext(view);
}

export function editorFindPrevious(view) {
  return cmFindPrevious(view);
}

// VSCode-style Ctrl+D: select the word at the cursor, then add the next
// occurrence to the selection (multi-cursor). @codemirror/search provides
// the command; drawSelection already renders multiple ranges.
export function editorSelectNextOccurrence(view) {
  return cmSelectNextOccurrence(view);
}

// Effect: scroll so the end of the document is visible (scratch append).
export function scrollToEndEffect(view) {
  return EditorView.scrollIntoView(view.state.doc.length, { y: 'end' });
}

// Count matches of the query in the document and locate the one starting at
// or after the selection head (1-based). Pure over (state, query) —
// headless testable. Fixed-string matching only; no regex.
export function countEditorMatches(state, queryString, { caseSensitive = false } = {}) {
  if (!queryString) return { total: 0, index: 0 };
  const docText = state.doc.toString();
  const hay = caseSensitive ? docText : docText.toLowerCase();
  const needle = caseSensitive ? queryString : queryString.toLowerCase();
  const head = state.selection.main.head;
  let total = 0;
  let wrappedIndex = null;
  let pos = 0;
  while ((pos = hay.indexOf(needle, pos)) !== -1) {
    total++;
    if (wrappedIndex === null && pos >= head) wrappedIndex = total;
    pos += needle.length;
  }
  if (total === 0) return { total: 0, index: 0 };
  return { total, index: wrappedIndex !== null ? wrappedIndex : 1 };
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
