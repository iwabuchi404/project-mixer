// test/attention-wiring.test.cjs
// 4.6: there is exactly one writer for terminalAttention.
// Run: npm run test:attention
//
// The regression this guards is D20's: attention state held in two structures
// updated by two code paths. That does not fail a test on its own — it fails
// later as an unexplained badge. So the assertion is structural: no call site
// may write the store's terminalAttention except the one function that also
// reconciles the Attention Store.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('url');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const renderer = read('renderer.js');

async function loadWiring() {
  return import(pathToFileURL(path.join(root, 'src', 'attention', 'attention-wiring.mjs')).href);
}

test('renderer routes every terminalAttention write through commitTerminalAttention', () => {
  // The single writer is allowed to set the field. Anywhere else is a second
  // path that would leave the Attention Store stale.
  const writes = [...renderer.matchAll(/setState\(\{\s*terminalAttention/g)];
  assert.equal(writes.length, 1, 'expected exactly one setState({ terminalAttention })');
  assert.match(renderer, /function commitTerminalAttention\(/);
});

test('commitTerminalAttention reconciles the Attention Store in the same step', () => {
  const body = renderer.slice(
    renderer.indexOf('function commitTerminalAttention('),
    renderer.indexOf('let subscribedBadgesRef'),
  );
  assert.match(body, /setState\(\{ terminalAttention \}\)/);
  assert.match(body, /reconcileAttention\(terminalAttention\)/);
});

test('all four terminalAttention transition sites use the single writer', () => {
  // agent_notification_received, agent_notification_seen, terminal_set_waiting,
  // terminal_clear_attention. Each previously called setState directly.
  assert.doesNotMatch(renderer, /const terminalAttention = receiveAgentNotification[\s\S]{0,400}?\n  setState\(\{ terminalAttention \}\)/);
  assert.doesNotMatch(renderer, /markAgentNotificationSeen\([^)]*\);\s*\n\s*if \([^)]*\) setState\(\{ terminalAttention \}\)/);
  assert.doesNotMatch(renderer, /setTerminalWaiting\([^;]*;\s*\n\s*setState\(\{ terminalAttention \}\)/);

  for (const call of ['receiveAgentNotification', 'markAgentNotificationSeen', 'setTerminalWaiting', 'clearTerminalAttention']) {
    const index = renderer.indexOf(`const terminalAttention = ${call}(`);
    assert.notEqual(index, -1, `${call} call site not found`);
    const after = renderer.slice(index, index + 600);
    assert.match(after, /commitTerminalAttention\(terminalAttention/, `${call} does not use the single writer`);
  }
});

test('terminal teardown forgets its attention even while blocking', async () => {
  const wiring = await loadWiring();
  wiring.__resetAttentionStoreForTest();

  const store = wiring.getAttentionStore();
  store.reconcile({
    3: {
      projectId: 'p1',
      waiting: true,
      unread: false,
      kind: 'needs_attention',
      source: 'claude',
    },
  });
  assert.equal(store.getOpenAttention().length, 1);

  // Tab closed: the terminal is gone, so nothing can answer the prompt. A
  // blocking attention that survived teardown would be unresolvable by design.
  const dropped = wiring.forgetTabAttention('p1', 3);

  assert.equal(dropped.state, 'RESOLVED');
  assert.equal(store.getOpenAttention().length, 0);
});

test('reconcile through the wiring module tracks a full agent turn', async () => {
  const wiring = await loadWiring();
  wiring.__resetAttentionStoreForTest();
  const store = wiring.getAttentionStore();

  wiring.reconcileAttention({
    3: { projectId: 'p1', waiting: false, unread: false, kind: 'turn_started', source: 'claude' },
  });
  assert.equal(store.getOpenAttention().length, 0, 'a working agent is not an attention (2.1)');

  wiring.reconcileAttention({
    3: { projectId: 'p1', waiting: true, unread: false, kind: 'needs_attention', source: 'claude', reason: 'input' },
  });
  assert.equal(store.getOpenAttention()[0].blocking, true);

  wiring.reconcileAttention({
    3: { projectId: 'p1', waiting: false, unread: true, kind: 'turn_completed', source: 'claude' },
  });
  const item = store.getOpenAttention()[0];
  assert.equal(item.blocking, false);
  assert.equal(item.kind, 'completed');

  assert.equal(wiring.resolveAttention(item.id).state, 'RESOLVED');
  assert.equal(store.getOpenAttention().length, 0);
});

test('acknowledgement is only reachable through the wiring module', async () => {
  const wiring = await loadWiring();
  wiring.__resetAttentionStoreForTest();
  const store = wiring.getAttentionStore();

  wiring.reconcileAttention({
    4: { projectId: 'p1', waiting: false, unread: true, kind: 'turn_completed', source: 'opencode' },
  });
  const id = store.getOpenAttention()[0].id;

  assert.ok(wiring.acknowledgeAttention(id).acknowledgedAt > 0);
  assert.equal(store.get(id).state, 'ACKNOWLEDGED');
});

test('forgetTabAttention is a no-op without a project id', async () => {
  const wiring = await loadWiring();
  wiring.__resetAttentionStoreForTest();

  assert.equal(wiring.forgetTabAttention(null, 3), null);
});