// test/attention-store.test.cjs
// AL-2: Attention Store lifecycle.
// Run: npm run test:attention-store
//
// The invariants that matter:
//   - createdAt is owned by the store and survives re-projection
//   - a blocking attention is never auto-resolved, not even when it leaves the
//     projection (4.3)
//   - an acknowledged attention keeps its acknowledgement across projections
//   - there is no single ranked accessor (D24 / 1.2)

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('url');

async function loadStore() {
  return import(pathToFileURL(path.join(__dirname, '..', 'src', 'attention', 'attention-store.mjs')).href);
}

function clock(start = 1000) {
  let value = start;
  return () => { value += 10; return value; };
}

function questionItem(overrides = {}) {
  return {
    projectId: 'p1',
    waiting: true,
    unread: false,
    kind: 'needs_attention',
    source: 'claude',
    reason: 'input',
    sessionId: 's1',
    ...overrides,
  };
}

test('reconcile creates open items with store-owned timestamps', async () => {
  const { createAttentionStore } = await loadStore();
  const now = clock();
  const store = createAttentionStore({ now });

  const { created } = store.reconcile({ 2: questionItem() });

  assert.equal(created.length, 1);
  assert.equal(created[0].state, 'OPEN');
  assert.equal(created[0].createdAt, now() - 10);
  assert.ok(created[0].updatedAt >= created[0].createdAt);
});

test('re-projecting the same state preserves createdAt', async () => {
  const { createAttentionStore } = await loadStore();
  const now = clock();
  const store = createAttentionStore({ now });

  store.reconcile({ 2: questionItem() });
  const createdAt = store.getOpenAttention()[0].createdAt;
  now();
  const second = store.reconcile({ 2: questionItem() });

  assert.equal(second.created.length, 0);
  assert.equal(second.updated.length, 0);
  assert.equal(store.getOpenAttention()[0].createdAt, createdAt);
});

test('a blocking attention is not withdrawn when it leaves the projection', async () => {
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore({ now: clock() });

  store.reconcile({ 2: questionItem() });
  const { withdrawn } = store.reconcile({});

  assert.equal(withdrawn.length, 0);
  assert.equal(store.getOpenAttention().length, 1);
  assert.equal(store.getOpenAttention()[0].blocking, true);
});

test('a non-blocking attention is withdrawn when it leaves the projection', async () => {
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore({ now: clock() });

  store.reconcile({ 4: { projectId: 'p1', waiting: false, unread: true, kind: 'turn_completed', source: 'opencode' } });
  const { withdrawn } = store.reconcile({});

  assert.equal(withdrawn.length, 1);
  assert.equal(withdrawn[0].state, 'RESOLVED');
  assert.equal(store.getOpenAttention().length, 0);
});

test('a blocking attention cannot be resolved by hand', async () => {
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore({ now: clock() });

  const { created } = store.reconcile({ 2: questionItem() });
  const id = created[0].id;

  assert.equal(store.resolveAttention(id), null);
  assert.equal(store.get(id).state, 'OPEN');
});

test('a blocking attention becomes resolvable once it stops blocking', async () => {
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore({ now: clock() });

  const { created } = store.reconcile({ 2: questionItem() });
  const id = created[0].id;

  // The realistic transition: the human answers, waiting clears, and the turn
  // completes unread. Same tab, so the same id, now non-blocking.
  store.reconcile({ 2: { projectId: 'p1', waiting: false, unread: true, kind: 'turn_completed', source: 'claude' } });
  assert.equal(store.get(id).blocking, false);

  const resolved = store.resolveAttention(id);
  assert.equal(resolved.state, 'RESOLVED');
  assert.ok(resolved.resolvedAt > 0);
});

test('a resolved attention is not reopened by a later projection', async () => {
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore({ now: clock() });

  const { created } = store.reconcile({ 4: { projectId: 'p1', waiting: false, unread: true, kind: 'turn_completed', source: 'opencode' } });
  store.resolveAttention(created[0].id);
  const second = store.reconcile({ 4: { projectId: 'p1', waiting: false, unread: true, kind: 'turn_completed', source: 'opencode' } });

  assert.equal(second.created.length, 0);
  assert.equal(store.getOpenAttention().length, 0);
});

test('acknowledgement survives re-projection', async () => {
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore({ now: clock() });

  const { created } = store.reconcile({ 4: { projectId: 'p1', waiting: false, unread: true, kind: 'turn_completed', source: 'opencode' } });
  const id = created[0].id;

  const acknowledged = store.acknowledgeAttention(id);
  assert.equal(acknowledged.state, 'ACKNOWLEDGED');
  assert.ok(acknowledged.acknowledgedAt > 0);

  store.reconcile({ 4: { projectId: 'p1', waiting: false, unread: true, kind: 'turn_completed', source: 'opencode', title: 'done' } });
  assert.equal(store.get(id).state, 'ACKNOWLEDGED');
  assert.equal(store.get(id).acknowledgedAt, acknowledged.acknowledgedAt);
});

test('in-view and out-of-view partition the open set (D24)', async () => {
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore({ now: clock() });

  store.reconcile({
    1: questionItem({ projectId: 'p1' }),
    5: questionItem({ projectId: 'p2' }),
    9: questionItem({ projectId: 'p3' }),
  });

  const inView = store.getAttentionInView([1, 5], 5);
  const outOfView = store.getAttentionOutOfView([1, 5], 5);

  assert.deepEqual(inView.map((item) => item.tabId), [1, 5]);
  assert.deepEqual(outOfView.map((item) => item.tabId), [9]);
  // No single ranked accessor exists by design (1.2).
  assert.equal(store.nextAttention, undefined);
  assert.equal(store.oldestOpenAttention, undefined);
});

test('derived counts report needs-human and high priority separately', async () => {
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore({ now: clock() });

  store.reconcile({
    1: questionItem({ projectId: 'p1' }),
    2: { projectId: 'p1', waiting: false, unread: false, kind: 'turn_failed', source: 'codex' },
    3: { projectId: 'p2', waiting: false, unread: true, kind: 'turn_completed', source: 'opencode' },
  });

  assert.equal(store.needsHumanCount(), 1);
  assert.equal(store.highPriorityCount(), 1);
  assert.deepEqual(store.projectAttentionCounts(), {
    p1: { needsHuman: 1, high: 1, open: 2 },
    p2: { needsHuman: 0, high: 0, open: 1 },
  });
});

test('getTabAttention and getProjectAttention scope correctly', async () => {
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore({ now: clock() });

  store.reconcile({
    1: questionItem({ projectId: 'p1' }),
    2: questionItem({ projectId: 'p2' }),
  });

  assert.deepEqual(store.getTabAttention(1).map((item) => item.projectId), ['p1']);
  assert.deepEqual(store.getProjectAttention('p2').map((item) => item.tabId), [2]);
});