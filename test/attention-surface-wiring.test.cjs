// test/attention-surface-wiring.test.cjs
// AL-3: every place that enumerates surface nodes must include the Inbox.
//
// These regressions were found by running the app, not by tests. Each one had the
// same shape: a new surface kind was registered in surfaceNodeFor /
// kindOfSurfaceNode, but one of the places that enumerate surfaces was never
// updated. The result was not an error — it was a pane that stayed hidden, or a
// tab that vanished on the next re-render.
//
// The lesson encoded here: for a new surface kind, "is it registered" is the
// wrong question. The right one is "is it in every list that walks surfaces".
// Run: npm run test:attention

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const renderer = () => read('renderer.js');

// Slice a function body by declaration order. These helpers are not
// alphabetically or spatially adjacent, so indexOf(end) can land before the
// start and silently produce an empty string.
function body(startMarker, endMarker) {
  const source = renderer();
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `"${endMarker}" must be declared after "${startMarker}"`);
  return source.slice(start, end);
}

test('placeSurfaces enumerates the Inbox in both of its loops', () => {
  const source = renderer();
  const loops = [...source.matchAll(/\[(fileEditorPane[^\]]*?)\]\.forEach\((rememberSurfaceHome|\(node\))/g)]
    .map((match) => match[1]);
  assert.ok(loops.length >= 2, `expected the home-slot and placement loops, found ${loops.length}`);
  for (const list of loops) {
    assert.ok(list.includes('attentionPane'), `surface loop omits the Inbox: ${list}`);
  }
});

test('renderPanes rescues the Inbox before wiping the container', () => {
  // terminalContainer.innerHTML = '' destroys anything still inside. Without
  // this rescue the Inbox is deleted and never comes back.
  const rescue = body('function renderPanes()', 'function markShownTabs()');
  assert.match(rescue, /\[fileEditorPane[^\]]*attentionPane/);
});

test('layoutNonTerminalTabs re-places the Inbox tab', () => {
  // Otherwise a pane re-render leaves the surface visible with no tab to switch
  // away from, and closing the pane cannot reach it.
  const layout = body('function layoutNonTerminalTabs()', "document.addEventListener('wheel'");
  assert.ok(layout.includes('place(attentionTabEl,'), 'Inbox tab is not re-placed');
});

test('the Inbox is restored, serialized and validated as a pane tab', () => {
  const source = renderer();
  assert.match(source, /entry\.type === 'attention'/, 'restoreNonTerminalTabs does not handle it');
  assert.match(source, /nonTerminalTabs\.push\(\{ type: 'attention'/, 'saveLayout does not serialize it');
  // config-service must accept it, or D18's non-fatal reset drops the Inbox on
  // every launch while the app looks like it merely forgot the layout.
  assert.match(read('src/main/config-service.cjs'), /'file', 'preview', 'search', 'attention'/);
});

test('the Inbox focus context is declared and reachable', () => {
  // An undeclared context name makes every `when` clause naming it silently
  // false — no error, the binding just never fires.
  //
  // FOCUS_CONTEXTS decides whether a name is treated as mutually exclusive with
  // the other focus contexts during conflict checking; ALL_CONTEXTS enumerates
  // the combinations that check runs. Declaring it in only one of the two gives
  // overlap detection the wrong shape, so assert both explicitly.
  const kb = read('src/keybindings/registry.js');
  const focusSet = kb.slice(kb.indexOf('const FOCUS_CONTEXTS'), kb.indexOf('const ALL_CONTEXTS'));
  const allContexts = kb.slice(kb.indexOf('const ALL_CONTEXTS'), kb.indexOf('function collectContextNames'));

  assert.match(focusSet, /'attentionFocus'/, 'FOCUS_CONTEXTS omits attentionFocus');
  assert.match(allContexts, /'attentionFocus'/, 'ALL_CONTEXTS omits attentionFocus');
  assert.match(renderer(), /new Set\(\['attentionFocus'\]\)/, 'getFocusContext cannot return it');
});