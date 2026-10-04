// test/attention-mapper.test.cjs
// AL-1: terminalAttention -> AttentionRequest mapping.
// Run: npm run test:attention-mapper
//
// The regression that matters here is 4.3: an input prompt must survive a
// late completion event. src/notifications/state.mjs enforces it upstream and
// the mapper is a pure projection, so the two together must never let a
// `turn_completed` clear a `blocking` attention.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('url');

async function loadMapper() {
  return import(pathToFileURL(path.join(__dirname, '..', 'src', 'attention', 'attention-mapper.mjs')).href);
}

function waitingItem(overrides = {}) {
  return {
    projectId: 'p1',
    waiting: true,
    unread: false,
    kind: 'needs_attention',
    eventType: 'Notification',
    source: 'claude',
    reason: 'input',
    title: null,
    message: null,
    sessionId: 's1',
    ...overrides,
  };
}

test('maps an input prompt to a blocking question', async () => {
  const { mapAttentionItem } = await loadMapper();

  assert.deepEqual(mapAttentionItem(3, waitingItem()), {
    id: 'p1:3',
    projectId: 'p1',
    tabId: 3,
    sessionId: 's1',
    kind: 'question',
    requestedPriority: 'normal',
    effectivePriority: 'normal',
    blocking: true,
    title: 'Waiting for input',
    summary: null,
    reason: 'input',
    source: 'agent',
    confidence: 1,
  });
});

test('a late completion event never clears a blocking attention', async () => {
  const { mapAttentionItem } = await loadMapper();

  // state.mjs keeps the waiting entry alive but the stored `kind` can still be
  // the older one. Trusting `kind` here is what produced the original bug.
  const late = waitingItem({ kind: 'turn_completed', eventType: 'Stop' });
  const mapped = mapAttentionItem(3, late);

  assert.equal(mapped.kind, 'question');
  assert.equal(mapped.blocking, true);
  assert.equal(mapped.requestedPriority, 'normal');
});

test('turn_started produces no attention (policy 2.1)', async () => {
  const { mapAttentionItem } = await loadMapper();

  assert.equal(mapAttentionItem(3, {
    projectId: 'p1',
    waiting: false,
    unread: false,
    kind: 'turn_started',
    source: 'claude',
  }), null);
});

test('maps a failure to a high priority error that is not blocking', async () => {
  const { mapAttentionItem } = await loadMapper();

  const mapped = mapAttentionItem(7, {
    projectId: 'p2',
    waiting: false,
    unread: false,
    kind: 'turn_failed',
    source: 'codex',
    title: 'shell exited 1',
    message: 'npm test failed',
  });

  assert.equal(mapped.kind, 'error');
  // Not blocking: a failed turn is a terminal state, not an input prompt.
  // state.mjs already clears `waiting` on turn_failed, and a failure that
  // blocked would pin the amber dot forever with no action the human can take.
  assert.equal(mapped.blocking, false);
  assert.equal(mapped.requestedPriority, 'high');
  assert.equal(mapped.title, 'shell exited 1');
  assert.equal(mapped.summary, 'npm test failed');
});

test('maps an unread completion to a non-blocking low priority item', async () => {
  const { mapAttentionItem } = await loadMapper();

  const mapped = mapAttentionItem(1, {
    projectId: 'p1',
    waiting: false,
    unread: true,
    kind: 'turn_completed',
    source: 'opencode',
  });

  assert.equal(mapped.kind, 'completed');
  assert.equal(mapped.blocking, false);
  assert.equal(mapped.requestedPriority, 'low');
});

test('PTY heuristics are reported as terminal-sourced with lower confidence', async () => {
  const { mapAttentionItem } = await loadMapper();

  const mapped = mapAttentionItem(5, {
    projectId: 'p1',
    waiting: true,
    unread: false,
    kind: 'needs_attention',
    source: 'pty',
    reason: 'approval',
  });

  assert.equal(mapped.source, 'terminal');
  assert.equal(mapped.confidence, 0.5);
  assert.equal(mapped.title, 'Approval required');
});

test('rejects items without a usable tab or project', async () => {
  const { mapAttentionItem } = await loadMapper();

  assert.equal(mapAttentionItem(0, waitingItem()), null);
  assert.equal(mapAttentionItem(Number.NaN, waitingItem()), null);
  assert.equal(mapAttentionItem(3, null), null);
  assert.equal(mapAttentionItem(3, { ...waitingItem(), projectId: '   ' }), null);
  assert.equal(mapAttentionItem(3, { ...waitingItem(), projectId: undefined }), null);
});

test('mapAttention projects the whole map in ascending tab order', async () => {
  const { mapAttention } = await loadMapper();

  const mapped = mapAttention({
    9: { ...waitingItem({ projectId: 'p2' }), kind: 'turn_failed', waiting: false },
    2: waitingItem(),
    4: { projectId: 'p1', waiting: false, unread: false, kind: 'turn_started', source: 'claude' },
  });

  assert.deepEqual(mapped.map((item) => [item.tabId, item.kind]), [
    [2, 'question'],
    [9, 'error'],
  ]);
});

test('ids stay stable across re-projection and across a kind change', async () => {
  const { mapAttention, attentionId } = await loadMapper();

  const state = { 2: waitingItem() };
  const first = mapAttention(state);
  const second = mapAttention(state);

  assert.deepEqual(first, second);
  assert.equal(first[0].id, attentionId('p1', 2));

  // A tab's attention changes kind over its life. Keying the id on kind would
  // strand the blocking predecessor, so the id must survive the change.
  const later = mapAttention({ 2: waitingItem({ waiting: false, kind: 'turn_completed', unread: true }) });
  assert.equal(later[0].id, first[0].id);
  assert.equal(later[0].kind, 'completed');
  assert.equal(later[0].blocking, false);
});

test('an unread-free completion is not an attention', async () => {
  const { mapAttentionItem } = await loadMapper();

  assert.equal(mapAttentionItem(3, {
    projectId: 'p1',
    waiting: false,
    unread: false,
    kind: 'turn_completed',
    source: 'claude',
  }), null);
});