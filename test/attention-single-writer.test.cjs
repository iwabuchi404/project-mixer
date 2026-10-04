// test/attention-single-writer.test.cjs
// 4.6 end-to-end: the store and the Attention Store cannot drift.
// Run: npm run test:attention
//
// The wiring test asserts the code shape (one writer). This one drives the real
// store module together with the real Attention Store through the same
// transitions the command handlers use, and asserts the two always agree.
//
// This is the test that would have caught D20's double management: a badge that
// says waiting while the Inbox has no such item.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');

// Both modules are singletons and the ESM cache is shared across tests in a
// file, so every case needs a clean slate in both structures.
async function loadAll() {
  const url = (p) => pathToFileURL(path.join(root, p)).href;
  const store = await import(url('src/store/index.js'));
  const notifications = await import(url('src/notifications/state.mjs'));
  const wiring = await import(url('src/attention/attention-wiring.mjs'));
  wiring.__resetAttentionStoreForTest();
  store.setState({ terminalAttention: {} });
  return { store, notifications, wiring };
}

// Mirrors commitTerminalAttention in renderer.js. Kept as a local helper rather
// than importing the bundle: this asserts the two modules agree when driven
// correctly, and renderer.js is covered structurally by attention-wiring.
function commit(store, wiring, terminalAttention, options) {
  store.setState({ terminalAttention });
  wiring.reconcileAttention(terminalAttention);
  if (!options) return;
  if (options.forgetTabId) {
    wiring.forgetTabAttention(options.forgetProjectId, options.forgetTabId);
  }
  if (options.answeredTabId) {
    wiring.answerTabAttention(options.answeredProjectId, options.answeredTabId);
  }
}

// The notification reducers are pure, so every step must feed the previous
// result back in. Reading the current value from the store keeps the tests from
// accidentally modelling a sequence the app never produces.
function notifier(store, wiring, notifications) {
  return (patch) => commit(store, wiring, notifications.receiveAgentNotification(
    store.getState().terminalAttention,
    patch,
  ));
}

test('a waiting agent is present in both structures at every step', async () => {
  const { store, notifications, wiring } = await loadAll();
  wiring.__resetAttentionStoreForTest();

  const notify = notifier(store, wiring, notifications);

  notify({ tabId: 1, projectId: 'p1', kind: 'turn_started', eventType: 'UserPromptSubmit', source: 'claude', unread: false });
  assert.equal(store.getTabAttention(1), null);
  assert.equal(wiring.getAttentionStore().getOpenAttention().length, 0);

  notify({ tabId: 1, projectId: 'p1', kind: 'needs_attention', eventType: 'Notification', source: 'claude', reason: 'input', unread: false });
  assert.equal(store.getTabAttention(1).waiting, true);
  assert.equal(wiring.getAttentionStore().getOpenAttention().length, 1);
  assert.equal(wiring.getAttentionStore().getOpenAttention()[0].blocking, true);

  // The regression: a completion arrives late. Both structures must keep waiting.
  notify({ tabId: 1, projectId: 'p1', kind: 'turn_completed', eventType: 'Stop', source: 'claude', unread: true });
  assert.equal(store.getTabAttention(1).waiting, true, 'store lost waiting on completion');
  assert.equal(wiring.getAttentionStore().getOpenAttention()[0].blocking, true, 'attention store lost blocking');
  assert.equal(wiring.resolveAttention('p1:1'), null, 'a blocking attention must not resolve');
});

test('the human answering clears both structures', async () => {
  const { store, notifications, wiring } = await loadAll();
  wiring.__resetAttentionStoreForTest();

  commit(store, wiring, notifications.receiveAgentNotification(store.getState().terminalAttention, {
    tabId: 2, projectId: 'p1', kind: 'needs_attention', eventType: 'Notification', source: 'claude', unread: false,
  }));

  const previous = store.getTabAttention(2);
  const answered = notifications.setTerminalWaiting(store.getState().terminalAttention, {
    tabId: 2, projectId: 'p1', waiting: false, cause: 'input',
  });
  commit(store, wiring, answered, {
    answeredTabId: 2,
    answeredProjectId: previous.projectId,
  });

  assert.equal(store.getTabAttention(2), null);
  assert.equal(wiring.getAttentionStore().getOpenAttention().length, 0);
});

test('waiting lost to anything other than human input stays open', async () => {
  const { store, notifications, wiring } = await loadAll();
  wiring.__resetAttentionStoreForTest();

  commit(store, wiring, notifications.receiveAgentNotification(store.getState().terminalAttention, {
    tabId: 8, projectId: 'p1', kind: 'needs_attention', eventType: 'Notification', source: 'claude', unread: false,
  }));

  // A terminal resize redraw makes the PTY heuristic report not-waiting.
  // state.mjs already refuses that transition upstream and returns the same
  // object, so both structures stay untouched. This is what answerTabAttention's
  // `cause === 'input'` guard protects: if `output` were ever allowed to clear
  // waiting, an answer would be inferred from a redraw and the prompt would be
  // dismissed unanswered.
  const lost = notifications.setTerminalWaiting(store.getState().terminalAttention, {
    tabId: 8, projectId: 'p1', waiting: false, cause: 'output',
  });
  assert.equal(lost, store.getState().terminalAttention, 'output must not clear waiting');
  commit(store, wiring, lost);

  assert.equal(store.getTabAttention(8).waiting, true);
  assert.equal(wiring.getAttentionStore().getOpenAttention().length, 1);
  assert.equal(wiring.getAttentionStore().getOpenAttention()[0].blocking, true);
});

test('a failure is visible in both structures and is not blocking', async () => {
  const { store, notifications, wiring } = await loadAll();
  wiring.__resetAttentionStoreForTest();

  commit(store, wiring, notifications.receiveAgentNotification(store.getState().terminalAttention, {
    tabId: 3, projectId: 'p2', kind: 'turn_failed', eventType: 'StopFailure', source: 'codex', unread: true,
  }));

  const attentionStore = wiring.getAttentionStore();
  assert.equal(store.getTabAttention(3).kind, 'turn_failed');
  assert.equal(attentionStore.getOpenAttention().length, 1);

  const item = attentionStore.getOpenAttention()[0];
  assert.equal(item.kind, 'error');
  assert.equal(item.blocking, false, 'a failed turn must not pin an unanswerable prompt');
  assert.equal(item.effectivePriority, 'high');
  assert.ok(wiring.resolveAttention(item.id));
});

test('closing a waiting tab leaves nothing behind in either structure', async () => {
  const { store, notifications, wiring } = await loadAll();
  wiring.__resetAttentionStoreForTest();

  const attention = {};
  commit(store, wiring, notifications.receiveAgentNotification(attention, {
    tabId: 4, projectId: 'p3', kind: 'needs_attention', eventType: 'Notification', source: 'opencode', unread: false,
  }));
  assert.equal(wiring.getAttentionStore().getOpenAttention().length, 1);

  const current = store.getState().terminalAttention;
  commit(store, wiring, notifications.clearTerminalAttention(current, 4), {
    forgetTabId: 4,
    forgetProjectId: 'p3',
  });

  assert.equal(store.getTabAttention(4), null);
  assert.equal(wiring.getAttentionStore().getOpenAttention().length, 0, 'a closed tab must not strand a blocking attention');
});

test('marking a non-blocking completion seen clears both structures', async () => {
  const { store, notifications, wiring } = await loadAll();
  wiring.__resetAttentionStoreForTest();

  const attention = {};
  commit(store, wiring, notifications.receiveAgentNotification(attention, {
    tabId: 5, projectId: 'p1', kind: 'turn_completed', eventType: 'Stop', source: 'claude', unread: true,
  }));
  assert.equal(wiring.getAttentionStore().getOpenAttention().length, 1);

  const seen = notifications.markAgentNotificationSeen(store.getState().terminalAttention, 5);
  commit(store, wiring, seen);

  assert.equal(store.getTabAttention(5), null);
  assert.equal(wiring.getAttentionStore().getOpenAttention().length, 0);
});

test('opening a waiting tab does not acknowledge it', async () => {
  const { store, notifications, wiring } = await loadAll();
  wiring.__resetAttentionStoreForTest();

  const attention = {};
  commit(store, wiring, notifications.receiveAgentNotification(attention, {
    tabId: 6, projectId: 'p1', kind: 'needs_attention', eventType: 'Notification', source: 'claude', unread: false,
  }));

  // markAgentNotificationSeen refuses to touch a waiting entry upstream.
  const seen = notifications.markAgentNotificationSeen(store.getState().terminalAttention, 6);
  commit(store, wiring, seen);

  assert.equal(store.getTabAttention(6).waiting, true);
  const item = wiring.getAttentionStore().getOpenAttention()[0];
  assert.equal(item.blocking, true);
  assert.equal(item.acknowledgedAt, undefined, 'an input prompt is actionable, not a notification to dismiss');
});

test('per-project counts agree between the badge summary and the attention store', async () => {
  const { store, notifications, wiring } = await loadAll();
  wiring.__resetAttentionStoreForTest();

  const notify = notifier(store, wiring, notifications);

  notify({ tabId: 1, projectId: 'p1', kind: 'needs_attention', eventType: 'Notification', source: 'claude', unread: false });
  notify({ tabId: 2, projectId: 'p1', kind: 'turn_failed', eventType: 'StopFailure', source: 'codex', unread: false });
  notify({ tabId: 3, projectId: 'p2', kind: 'turn_completed', eventType: 'Stop', source: 'opencode', unread: true });

  const summary = store.getTerminalAttentionSummary();
  const counts = wiring.getAttentionStore().projectAttentionCounts();

  assert.equal(summary.p1.waiting, counts.p1.needsHuman);
  assert.equal(summary.p1.failed, counts.p1.high);
  assert.equal(summary.p2.unread, counts.p2.open);
});