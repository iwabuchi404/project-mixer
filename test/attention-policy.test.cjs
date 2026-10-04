const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(
  path.join(__dirname, '..', 'src', 'attention', 'attention-policy.mjs'),
).href);

const SRC = path.join(__dirname, '..', 'src', 'attention', 'attention-policy.mjs');

// ============================================================
// effectivePriority (plan 9.2)
// ============================================================

test('effectivePriority follows the plan 9.2 table', async () => {
  const { effectivePriorityFor } = await load();
  assert.equal(effectivePriorityFor({ kind: 'error', blocking: false }), 'high');
  assert.equal(effectivePriorityFor({ kind: 'completed', blocking: false }), 'low');
  assert.equal(effectivePriorityFor({ kind: 'question', blocking: true }), 'normal');
  assert.equal(effectivePriorityFor({ kind: 'question', blocking: false }), 'normal');
  assert.equal(effectivePriorityFor({ kind: 'blocked', blocking: false }), 'normal');
  assert.equal(effectivePriorityFor({ kind: 'review', blocking: false }), 'normal');
  // Defensive: junk must not become high by accident.
  assert.equal(effectivePriorityFor(null), 'normal');
  assert.equal(effectivePriorityFor({}), 'normal');
});

// error outranks blocking: a failed turn is high even though it is no longer
// waiting, because the human still has to look at it.
test('kind=error outranks blocking', async () => {
  const { effectivePriorityFor } = await load();
  assert.equal(effectivePriorityFor({ kind: 'error', blocking: true }), 'high');
});

// THE rule that makes this module necessary (plan 9.2 + D24 in 1.2):
// human context must not reach effectivePriority. If it did, a background
// project's item would be silently demoted and never surface at all, which
// inverts plan 2.1 ("a healthy agent does not call the human") into "the
// human never finds out".
test('human context cannot change effectivePriority', async () => {
  const { applyPolicy } = await load();
  const item = { kind: 'error', blocking: true, tabId: 7, projectId: 'p-other', effectivePriority: 'low' };
  const here = applyPolicy(item, {
    inViewTabIds: [7], activeTabId: 7, activeProjectId: 'p-here',
  });
  const far = applyPolicy(item, {
    inViewTabIds: [], activeTabId: null, activeProjectId: 'p-here',
  });
  assert.equal(here.effectivePriority, 'high');
  assert.equal(far.effectivePriority, 'high');
  // Presentation is the only thing that moved.
  assert.equal(here.presentation, 'interrupt');
  assert.equal(far.presentation, 'highlight');
});

// ============================================================
// presentation (plan 9.3)
// ============================================================

test('resolved items are never presented', async () => {
  const { applyPolicy } = await load();
  // state: 'RESOLVED' is what the store sets; a draft without a state is not
  // resolved and must still be presented.
  for (const blocking of [true, false]) {
    const item = applyPolicy({ kind: 'question', blocking, tabId: 3, projectId: 'p', state: 'RESOLVED' }, {
      inViewTabIds: [3], activeTabId: 3,
    });
    assert.equal(item.presentation, 'hidden', `blocking=${blocking}`);
  }
  assert.equal(
    applyPolicy({ kind: 'question', blocking: true, tabId: 3, projectId: 'p' }, { activeTabId: 3 }).presentation,
    'interrupt',
    'a draft with no state is not resolved',
  );
});

test('blocking in the current pane interrupts; out of view highlights', async () => {
  const { applyPolicy } = await load();
  const blocking = { kind: 'question', blocking: true, tabId: 3, projectId: 'p' };
  assert.equal(applyPolicy(blocking, { inViewTabIds: [3], activeTabId: 3 }).presentation, 'interrupt');
  assert.equal(applyPolicy(blocking, { inViewTabIds: [9], activeTabId: 9 }).presentation, 'highlight');
  // Active tab counts as in view even if the pane list missed it.
  assert.equal(applyPolicy(blocking, { inViewTabIds: [], activeTabId: 3 }).presentation, 'interrupt');
});

test('non-blocking open items land in the Inbox, never interrupt', async () => {
  const { applyPolicy } = await load();
  const item = { kind: 'question', blocking: false, tabId: 3, projectId: 'p' };
  assert.equal(applyPolicy(item, { inViewTabIds: [3], activeTabId: 3 }).presentation, 'inbox');
  assert.equal(applyPolicy(item, { inViewTabIds: [], activeTabId: null }).presentation, 'inbox');
});

test('a completed turn is presence only, never Inbox noise', async () => {
  // Plan 2.2: "completed" is an event. Promoting it to the Inbox on every
  // finished turn is exactly the churn plan 2.1 forbids.
  const { applyPolicy } = await load();
  const done = { kind: 'completed', blocking: false, tabId: 4, projectId: 'p' };
  assert.equal(applyPolicy(done, { inViewTabIds: [4], activeTabId: 4 }).presentation, 'presence');
  assert.equal(applyPolicy(done, {}).presentation, 'presence');
});

test('interrupt stays rare: it needs BOTH blocking and in view', async () => {
  // Plan 9.3 says interrupt should not be reserved for future use, and plan
  // 2.5 forbids stealing focus. So a non-blocking item the human is looking
  // at is not an interrupt, it is already visible.
  const { applyPolicy } = await load();
  assert.equal(
    applyPolicy({ kind: 'completed', blocking: false, tabId: 1 }, { inViewTabIds: [1], activeTabId: 1 }).presentation,
    'presence',
  );
  assert.equal(
    applyPolicy({ kind: 'question', blocking: false, tabId: 1 }, { inViewTabIds: [1], activeTabId: 1 }).presentation,
    'inbox',
  );
});

// ============================================================
// rollups
// ============================================================

test('the strongest presentation wins a project rollup', async () => {
  const { strongestPresentation, projectPresentation } = await load();
  assert.equal(strongestPresentation(['presence', 'inbox']), 'inbox');
  assert.equal(strongestPresentation(['inbox', 'highlight']), 'highlight');
  assert.equal(strongestPresentation(['highlight', 'interrupt']), 'interrupt');
  assert.equal(strongestPresentation(['presence']), 'presence');
  assert.equal(strongestPresentation([]), 'hidden');
  assert.equal(strongestPresentation(undefined), 'hidden');
  // A resolved item must not mask a live blocking one.
  assert.equal(
    projectPresentation([
      { presentation: 'hidden' },
      { presentation: 'interrupt' },
      { presentation: 'presence' },
    ]),
    'interrupt',
  );
});

test('policy is pure: the input object is never mutated', async () => {
  const { applyPolicy, applyPolicyToAll } = await load();
  const item = Object.freeze({ kind: 'question', blocking: true, tabId: 1, projectId: 'p' });
  const list = Object.freeze([item]);
  assert.doesNotThrow(() => applyPolicy(item, { activeTabId: 1 }));
  assert.doesNotThrow(() => applyPolicyToAll(list, {}));
  // Frozen inputs mean an in-place write would have thrown in strict mode.
  assert.equal(item.effectivePriority, undefined);
  assert.equal(item.presentation, undefined);
});

test('malformed input degrades instead of throwing', async () => {
  const { applyPolicy, applyPolicyToAll, normalizeHumanContext } = await load();
  assert.equal(applyPolicy(null), null);
  assert.equal(applyPolicy(undefined), null);
  assert.deepEqual(applyPolicyToAll(undefined), []);
  assert.deepEqual(applyPolicyToAll('nope'), []);
  const ctx = normalizeHumanContext({ inViewTabIds: ['x', 4, null], activeTabId: 'y' });
  assert.deepEqual(ctx.inViewTabIds, [4]);
  assert.equal(ctx.activeTabId, null);
  assert.doesNotThrow(() => normalizeHumanContext(null));
});

// ============================================================
// store + wiring integration
// ============================================================

test('the store applies effectivePriority on reconcile', async () => {
  const { createAttentionStore } = await import(pathToFileURL(
    path.join(__dirname, '..', 'src', 'attention', 'attention-store.mjs'),
  ).href);
  const store = createAttentionStore();
  store.reconcile({
    5: { projectId: 'p1', waiting: true, kind: 'needs_attention', source: 'claude', reason: 'input' },
  });
  const [item] = store.getOpenAttention();
  assert.equal(item.requestedPriority, 'normal');
  assert.equal(item.effectivePriority, 'normal');
  assert.equal(item.blocking, true);
});

test('the store recomputes effectivePriority from kind, not from the mapper', async () => {
  // The mapper still mirrors requestedPriority into effectivePriority. If the
  // store trusted that, an error event would keep priority=normal forever and
  // highPriorityCount() would always be 0.
  const { createAttentionStore } = await import(pathToFileURL(
    path.join(__dirname, '..', 'src', 'attention', 'attention-store.mjs'),
  ).href);
  const store = createAttentionStore();
  store.reconcile({
    6: { projectId: 'p1', waiting: false, kind: 'turn_failed', source: 'claude', unread: true },
  });
  const [item] = store.getOpenAttention();
  assert.equal(item.kind, 'error');
  assert.equal(item.effectivePriority, 'high');
  assert.equal(store.highPriorityCount(), 1);
});

test('presentation is applied at read time, never persisted', async () => {
  const { createAttentionStore } = await import(pathToFileURL(
    path.join(__dirname, '..', 'src', 'attention', 'attention-store.mjs'),
  ).href);
  const store = createAttentionStore();
  store.reconcile({
    7: { projectId: 'p1', waiting: true, kind: 'needs_attention', source: 'claude' },
  });
  // Stored state carries no presentation: the human moving between panes must
  // change it without any agent event, so it cannot live in the store.
  assert.equal(store.getOpenAttention()[0].presentation, undefined);
  assert.equal(store.presentAttention({ inViewTabIds: [7], activeTabId: 7 })[0].presentation, 'interrupt');
  assert.equal(store.presentAttention({ inViewTabIds: [], activeTabId: null })[0].presentation, 'highlight');
  // Reading presentation must not mutate stored state either.
  assert.equal(store.getOpenAttention()[0].presentation, undefined);
});

test('wiring exposes the policy read path', async () => {
  const wiring = await import(pathToFileURL(
    path.join(__dirname, '..', 'src', 'attention', 'attention-wiring.mjs'),
  ).href);
  wiring.__resetAttentionStoreForTest();
  wiring.reconcileAttention({
    8: { projectId: 'pA', waiting: true, kind: 'needs_attention', source: 'claude' },
    9: { projectId: 'pB', waiting: false, kind: 'turn_failed', source: 'claude', unread: true },
  });
  const inView = wiring.currentAttentionPresentation({ inViewTabIds: [8], activeTabId: 8 });
  assert.equal(inView, 'interrupt');
  const perProject = wiring.projectAttentionPresentations({ inViewTabIds: [8], activeTabId: 8 });
  assert.equal(perProject.pA, 'interrupt');
  assert.equal(perProject.pB, 'highlight');
  wiring.__resetAttentionStoreForTest();
});

test('the policy module does not read renderer state or a clock', () => {
  // Structural guard. A policy that imported the store, touched `document` or
  // called Date.now() would be impossible to unit test and would smuggle
  // human context into priority.
  const source = require('fs').readFileSync(SRC, 'utf-8');
  assert.doesNotMatch(source, /\bdocument\b/);
  assert.doesNotMatch(source, /\bwindow\b/);
  assert.doesNotMatch(source, /Date\.now|new Date/);
  assert.doesNotMatch(source, /^import /m, 'the policy must have no imports at all');
  assert.doesNotMatch(source, /localStorage/);
});