// src/keybindings/registry.js
// Keybinding registry: single source of truth for keyboard shortcuts.
//
// Discipline (D21): key handling is centralized here instead of scattered
// across addEventListener('keydown') calls. The `when` clause determines
// which binding applies based on the current focus context.
//
// `when` vocabulary (fixed — do not expand without discussion):
//   terminalFocus | editorFocus | previewFocus | treeFocus |
//   scratchFocus  | findOpen     | paletteOpen  | searchFocus |
//   treeFilterFocus
//
// D24: searchFocus added for Phase 5 S2 search tab Escape handling.
//      Used by search_close (positive) and close_overlay_menus (negative).
// D25: treeFilterFocus added so Escape works in the filter input while
//      Slash (tree_filter_focus) does not intercept typing in the input.
//
// Operators: && || ! only. No nested parentheses (keeps the parser small).

// --- Binding table ---

export const BINDINGS = [
  // Existing bindings migrated from scattered keydown listeners.
  { key: 'Ctrl+S', command: 'save_active_file', when: 'scratchFocus || editorFocus' },
  { key: 'Ctrl+Enter', command: 'send_to_terminal', when: 'scratchFocus' },
  { key: 'Ctrl+I', command: 'focus_scratch', when: 'scratchFocus' },
  { key: 'Ctrl+Shift+Z', command: 'undo_last_send', when: 'scratchFocus' },
  { key: 'Ctrl+Shift+C', command: 'terminal_copy', when: 'terminalFocus' },
  { key: 'Ctrl+A', command: 'terminal_select_all', when: 'terminalFocus' },
  { key: 'Ctrl+B', command: 'toggle_sidebar', when: '!terminalFocus' },
  { key: 'Escape', command: 'close_overlay_menus', when: '!findOpen && !treeFocus && !treeFilterFocus && !searchFocus' },

  // Phase 5 additions.
  { key: 'Ctrl+Shift+F', command: 'search_text_open', when: null },
  { key: 'Slash', command: 'tree_filter_focus', when: 'treeFocus' },
  { key: 'Escape', command: 'tree_filter_clear', when: '!findOpen && treeFocus || !findOpen && treeFilterFocus' },
  { key: 'Escape', command: 'search_close', when: '!findOpen && searchFocus' },
  // Phase 4.5 A4: point at selected editor lines from the scratch composer.
  { key: 'Ctrl+Shift+Enter', command: 'insert_selection_to_scratch', when: 'editorFocus' },
  // Phase 5 S3: shared find bar. Terminal keeps Ctrl+F (forward-char), so
  // find_open only applies to editor/preview focus contexts.
  { key: 'Ctrl+F', command: 'find_open', when: 'editorFocus || previewFocus' },
  { key: 'Escape', command: 'find_close', when: 'findOpen' },
];

// --- Key normalization ---

export function keyToString(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Meta');

  let key = e.key;
  // Normalize special keys to readable names.
  if (key === ' ') key = 'Space';
  if (key === '/') key = 'Slash';
  if (key.length === 1) key = key.toUpperCase();

  parts.push(key);
  return parts.join('+');
}

// --- `when` evaluation ---

// Tokenize a `when` expression into operators and operands.
// Supported: && || ! and identifiers. No nested parentheses.
function tokenizeWhen(expr) {
  if (expr === null || expr === undefined || expr === '') return [];
  const tokens = [];
  let i = 0;
  const s = String(expr);
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t') { i++; continue; }
    if (ch === '&' && s[i + 1] === '&') { tokens.push({ type: 'op', value: '&&' }); i += 2; continue; }
    if (ch === '|' && s[i + 1] === '|') { tokens.push({ type: 'op', value: '||' }); i += 2; continue; }
    if (ch === '!') { tokens.push({ type: 'op', value: '!' }); i++; continue; }
    // Identifier: read until whitespace or operator char.
    let j = i;
    while (j < s.length && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '&' && s[j] !== '|' && s[j] !== '!') j++;
    tokens.push({ type: 'ident', value: s.slice(i, j) });
    i = j;
  }
  return tokens;
}

// Evaluate a tokenized `when` expression against a context set.
// Context is a Set of active context names (e.g. {'terminalFocus'}).
// Grammar: expr := term (('||' term)*)
//           term := factor (('&&' factor)*)
//           factor := '!' factor | ident
function evalTokens(tokens, ctx, pos = 0) {
  let result, next;
  ({ result, next } = evalTerm(tokens, ctx, pos));
  while (next < tokens.length && tokens[next].type === 'op' && tokens[next].value === '||') {
    let r;
    ({ result: r, next } = evalTerm(tokens, ctx, next + 1));
    result = result || r;
  }
  return { result, next };
}

function evalTerm(tokens, ctx, pos) {
  let result, next;
  ({ result, next } = evalFactor(tokens, ctx, pos));
  while (next < tokens.length && tokens[next].type === 'op' && tokens[next].value === '&&') {
    let r;
    ({ result: r, next } = evalFactor(tokens, ctx, next + 1));
    result = result && r;
  }
  return { result, next };
}

function evalFactor(tokens, ctx, pos) {
  if (pos >= tokens.length) return { result: false, next: pos };
  const tok = tokens[pos];
  if (tok.type === 'op' && tok.value === '!') {
    const { result, next } = evalFactor(tokens, ctx, pos + 1);
    return { result: !result, next };
  }
  if (tok.type === 'ident') {
    return { result: ctx.has(tok.value), next: pos + 1 };
  }
  return { result: false, next: pos + 1 };
}

export function evaluateWhen(expr, contextSet) {
  if (expr === null || expr === undefined || expr === '') return true;
  const ctx = contextSet instanceof Set ? contextSet : new Set(contextSet || []);
  const tokens = tokenizeWhen(expr);
  if (tokens.length === 0) return true;
  const { result, next } = evalTokens(tokens, ctx, 0);
  // If not all tokens were consumed, the expression was malformed.
  if (next < tokens.length) return false;
  return result;
}

// --- Conflict detection ---

// Extract positive (must be true) and negative (must be false) context
// names from a `when` expression. Returns { positive: Set, negative: Set }.
function extractConstraints(expr) {
  const tokens = tokenizeWhen(expr);
  const positive = new Set();
  const negative = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'op' && tokens[i].value === '!' && i + 1 < tokens.length && tokens[i + 1].type === 'ident') {
      negative.add(tokens[i + 1].value);
      i++; // skip the ident
    } else if (tokens[i].type === 'ident') {
      positive.add(tokens[i].value);
    }
  }
  return { positive, negative };
}

// Focus contexts are mutually exclusive — only one can be active at a time
// (getFocusContext returns exactly one focus set). State contexts (findOpen,
// paletteOpen) can coexist with any focus context and with each other.
const FOCUS_CONTEXTS = new Set([
  'terminalFocus', 'editorFocus', 'previewFocus', 'treeFocus',
  'scratchFocus', 'searchFocus', 'treeFilterFocus',
]);

// All context names used in the binding table's `when` clauses.
// Used to enumerate all possible context combinations for overlap checking.
const ALL_CONTEXTS = [
  'terminalFocus', 'editorFocus', 'previewFocus', 'treeFocus',
  'scratchFocus', 'searchFocus', 'treeFilterFocus',
  'findOpen', 'paletteOpen',
];

// Collect all context names referenced in a `when` expression.
function collectContextNames(expr) {
  const tokens = tokenizeWhen(expr);
  const names = new Set();
  for (const tok of tokens) {
    if (tok.type === 'ident') names.add(tok.value);
  }
  return names;
}

// Check if two `when` clauses can both be true at the same time.
// Enumerates all possible context combinations over the union of contexts
// referenced in both expressions. For each combination, evaluates both
// expressions. If any combination makes both true, they overlap.
//
// Focus contexts are mutually exclusive (only one can be true at a time),
// so we only enumerate combinations where at most one focus context is true.
// State contexts can be independently true or false.
function whenOverlaps(a, b) {
  if (a === null || a === undefined || a === '') return true;
  if (b === null || b === undefined || b === '') return true;
  const namesA = collectContextNames(a);
  const namesB = collectContextNames(b);
  const allNames = [...new Set([...namesA, ...namesB])];
  // Split into focus and state contexts.
  const focusNames = allNames.filter((n) => FOCUS_CONTEXTS.has(n));
  const stateNames = allNames.filter((n) => !FOCUS_CONTEXTS.has(n));
  // Enumerate: one focus context true (or none), all state combinations.
  // Case 1: no focus context is true (empty base set).
  const combos = [new Set()];
  // Case 2: each focus context true individually.
  for (const f of focusNames) {
    combos.push(new Set([f]));
  }
  // For each focus base, enumerate all state combinations.
  const results = [];
  for (const base of combos) {
    const stateCount = stateNames.length;
    for (let mask = 0; mask < (1 << stateCount); mask++) {
      const ctx = new Set(base);
      for (let i = 0; i < stateCount; i++) {
        if (mask & (1 << i)) ctx.add(stateNames[i]);
      }
      results.push(ctx);
    }
  }
  // Check if any combination makes both expressions true.
  for (const ctx of results) {
    if (evaluateWhen(a, ctx) && evaluateWhen(b, ctx)) return true;
  }
  return false;
}

export function detectConflicts(bindings) {
  const conflicts = [];
  for (let i = 0; i < bindings.length; i++) {
    for (let j = i + 1; j < bindings.length; j++) {
      if (bindings[i].key === bindings[j].key && whenOverlaps(bindings[i].when, bindings[j].when)) {
        conflicts.push({
          key: bindings[i].key,
          a: { command: bindings[i].command, when: bindings[i].when },
          b: { command: bindings[j].command, when: bindings[j].when },
        });
      }
    }
  }
  return conflicts;
}

// Validate bindings at startup. Throws if conflicts are found.
export function validateBindings(bindings) {
  const conflicts = detectConflicts(bindings);
  if (conflicts.length > 0) {
    const lines = conflicts.map(c =>
      `  ${c.key}: "${c.a.command}" (${c.a.when || 'global'}) vs "${c.b.command}" (${c.b.when || 'global'})`
    );
    throw new Error(`[keybindings] Conflicting bindings detected:\n${lines.join('\n')}`);
  }
}

// --- Binding matching ---

// Find the best matching binding for a keyboard event and context.
// Returns the binding object or null.
export function matchBinding(event, contextSet) {
  const key = keyToString(event);
  const ctx = contextSet instanceof Set ? contextSet : new Set(contextSet || []);
  for (const binding of BINDINGS) {
    if (binding.key !== key) continue;
    if (evaluateWhen(binding.when, ctx)) return binding;
  }
  return null;
}
