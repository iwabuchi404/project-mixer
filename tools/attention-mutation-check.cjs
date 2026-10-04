// Mutation check: break each wiring site in turn and confirm the new tests fail.
// This proves the tests actually observe the thing that broke in the app.
const fs = require('fs');
const { spawnSync } = require('child_process');

const RENDERER = 'D:/work/project-mixer/renderer.js';
const CONFIG = 'D:/work/project-mixer/src/main/config-service.cjs';
const KB = 'D:/work/project-mixer/src/keybindings/registry.js';
const TEST = 'test/attention-surface-wiring.test.cjs';
const TEST2 = 'test/attention-inbox-ui.test.cjs';

const original = {};
for (const f of [RENDERER, CONFIG, KB]) original[f] = fs.readFileSync(f, 'utf8');

function restore() {
  for (const [f, content] of Object.entries(original)) fs.writeFileSync(f, content);
}

function runSuite() {
  let failed = false;
  for (const t of [TEST, TEST2]) {
    const r = spawnSync('node', ['--test', t], { encoding: 'utf8', cwd: 'D:/work/project-mixer' });
    if (r.status !== 0) failed = true;
  }
  return failed;
}

// Match on the identifier list itself rather than the whole statement, so the
// patterns survive whitespace and indentation changes in renderer.js.


const mutations = [
  { name: 'placeSurfaces home loop', file: RENDERER,
    mutate: (c) => c.replace('[fileEditorPane, previewPane, searchPane, attentionPane].forEach(rememberSurfaceHome)',
      '[fileEditorPane, previewPane, searchPane].forEach(rememberSurfaceHome)') },
  { name: 'placeSurfaces place loop', file: RENDERER,
    mutate: (c) => {
      // Remove attentionPane from the Nth occurrence of the surface list, where
      // N is given by the caller. Occurrence 1 = rememberSurfaceHome,
      // 2 = the placement loop, 3 = the renderPanes rescue.
      const list = '[fileEditorPane, previewPane, searchPane, attentionPane]';
      const nth = (source, n) => {
        let idx = -1;
        for (let i = 0; i < n; i += 1) idx = source.indexOf(list, idx + 1);
        return idx;
      };
      const at = nth(c, 2);
      if (at === -1) return c;
      return c.slice(0, at) + '[fileEditorPane, previewPane, searchPane]' + c.slice(at + list.length);
    } },
  { name: 'renderPanes rescue (first remaining list)', file: RENDERER,
    mutate: (c) => {
      const idx = c.indexOf('function renderPanes()');
      const head = c.slice(0, idx);
      const tail = c.slice(idx).replace('[fileEditorPane, previewPane, searchPane, attentionPane]',
        '[fileEditorPane, previewPane, searchPane]');
      return head + tail;
    } },
  { name: 'layoutNonTerminalTabs place', file: RENDERER,
    mutate: (c) => c.replace('place(attentionTabEl, attentionTabEl._paneId);', 'void attentionTabEl;') },
  { name: 'saveLayout serialization', file: RENDERER,
    mutate: (c) => c.replace("nonTerminalTabs.push({ type: 'attention', projectId, paneIndex });", '') },
  { name: 'restoreNonTerminalTabs branch', file: RENDERER,
    mutate: (c) => c.replace("} else if (entry.type === 'attention') {", '} else if (false) {') },
  { name: 'config-service type list', file: CONFIG,
    mutate: (c) => c.replace("'file', 'preview', 'search', 'attention'", "'file', 'preview', 'search'") },
  { name: 'attentionFocus FOCUS_CONTEXTS declaration', file: KB,
    mutate: (c) => {
      // The declaration is preceded by a comment block; drop the entry only
      // inside FOCUS_CONTEXTS, leaving ALL_CONTEXTS intact.
      const start = c.indexOf('const FOCUS_CONTEXTS');
      const end = c.indexOf('const ALL_CONTEXTS');
      if (start === -1 || end === -1) return c;
      const head = c.slice(0, start);
      const focus = c.slice(start, end).replace(/\s*'attentionFocus',/, '');
      return head + focus + c.slice(end);
    } },
  { name: 'attentionFocus ALL_CONTEXTS entry', file: KB,
    mutate: (c) => c.replace("'scratchFocus', 'searchFocus', 'treeFilterFocus', 'attentionFocus',",
      "'scratchFocus', 'searchFocus', 'treeFilterFocus',") },
  { name: 'getFocusContext branch', file: RENDERER,
    mutate: (c) => c.replace("ctx = new Set(['attentionFocus']);", "ctx = new Set(['editorFocus']);") },
];

console.log('baseline (unmutated):', runSuite() ? 'FAIL' : 'pass', '\n');
let setupFailures = 0;
for (const m of mutations) {
  const content = original[m.file];
  const mutated = m.mutate(content);
  if (mutated === content) { console.log(`SETUP FAIL (no change): ${m.name}`); setupFailures++; continue; }
  fs.writeFileSync(m.file, mutated);
  const caught = runSuite();
  restore();
  console.log(`${caught ? 'CAUGHT ' : 'MISSED '} ${m.name}`);
}
restore();
console.log('\nrestored:', runSuite() ? 'FAIL' : 'pass');