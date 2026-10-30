const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapDevinHookPayload,
  mapDevinOscNotification,
  createDevinTurnTracker,
} = require('../src/main/agent-events/providers/devin.cjs');
const { normalizeAgentNotification } = require('../src/main/agent-notification-service.cjs');

// --- D1 gate: hook payload mapping ---

test('UserPromptSubmit maps to turn_started with the prompt as turnId', () => {
  const event = mapDevinHookPayload({
    provider: 'devin',
    eventType: 'UserPromptSubmit',
    ptyId: 42,
    sessionId: 'devin-abc',
    promptId: 'prompt-1',
  });
  assert.equal(event.kind, 'turn_started');
  assert.equal(event.provider, 'devin');
  assert.equal(event.ptyId, 42);
  assert.equal(event.sessionId, 'devin-abc');
  assert.equal(event.turnId, 'prompt-1');
  assert.equal(event.stopHookActive, null);
});

test('Stop maps to turn_stop_requested and never to turn_completed', () => {
  const event = mapDevinHookPayload({
    provider: 'devin',
    eventType: 'Stop',
    ptyId: 42,
    sessionId: 'devin-abc',
    promptId: 'prompt-1',
    stopHookActive: false,
  });
  assert.equal(event.kind, 'turn_stop_requested');
  assert.notEqual(event.kind, 'turn_completed');
  assert.equal(event.stopHookActive, false);
  assert.equal(mapDevinHookPayload({ provider: 'devin', eventType: 'Stop', promptId: 'p', stopHookActive: true }).stopHookActive, true);
});

test('out-of-scope and malformed hook payloads are ignored', () => {
  assert.equal(mapDevinHookPayload({ provider: 'devin', eventType: 'PreToolUse' }), null);
  assert.equal(mapDevinHookPayload({ provider: 'devin', eventType: 'SessionStart' }), null);
  assert.equal(mapDevinHookPayload({ provider: 'devin' }), null);
  assert.equal(mapDevinHookPayload({ provider: 'claude', eventType: 'Stop' }), null);
  assert.equal(mapDevinHookPayload(null), null);
  assert.equal(mapDevinHookPayload('Stop'), null);
  assert.equal(mapDevinHookPayload([1, 2]), null);
});

test('missing promptId and ptyId degrade to null identity fields', () => {
  const event = mapDevinHookPayload({ provider: 'devin', eventType: 'Stop' });
  assert.equal(event.kind, 'turn_stop_requested');
  assert.equal(event.sessionId, null);
  assert.equal(event.turnId, null);
  assert.equal(event.ptyId, null);
});

// --- D1 gate: OSC-derived mapping ---

test('OSC needs input maps to needs_attention(input)', () => {
  const event = mapDevinOscNotification({
    kind: 'needs_attention', eventType: 'needs_input', source: 'devin', reason: 'input',
  }, { ptyId: 7 });
  assert.equal(event.kind, 'needs_attention');
  assert.equal(event.reason, 'input');
  assert.equal(event.ptyId, 7);
  assert.equal(event.provider, 'devin');
});

test('OSC finished maps to turn_completed', () => {
  const event = mapDevinOscNotification({
    kind: 'turn_completed', eventType: 'finished', source: 'devin', reason: null,
  });
  assert.equal(event.kind, 'turn_completed');
  assert.equal(event.reason, null);
});

test('non-devin OSC notifications are ignored', () => {
  assert.equal(mapDevinOscNotification({ kind: 'needs_attention', source: 'claude' }), null);
  assert.equal(mapDevinOscNotification({ kind: 'turn_started', source: 'devin' }), null);
  assert.equal(mapDevinOscNotification(null), null);
});

// --- turn tracker: dedupe + stale Stop (計画 §10) ---

test('tracker dedupes identical turn events within the TTL', () => {
  let t = 1000;
  const tracker = createDevinTurnTracker({ now: () => t });
  assert.equal(tracker.seenEvent('s1', 'p1', 'Stop'), false);
  assert.equal(tracker.seenEvent('s1', 'p1', 'Stop'), true);
  t += 10 * 60 * 1000 + 1;
  assert.equal(tracker.seenEvent('s1', 'p1', 'Stop'), false, 'entry expires after the TTL');
});

test('tracker flags a Stop whose promptId no longer matches the current turn', () => {
  let t = 1000;
  const tracker = createDevinTurnTracker({ now: () => t });
  tracker.noteTurnStarted('s1', 'turn-A');
  assert.equal(tracker.isStaleStop('s1', 'turn-A'), false);
  // Turn B started (late Stop A still in flight).
  t += 10;
  tracker.noteTurnStarted('s1', 'turn-B');
  assert.equal(tracker.isStaleStop('s1', 'turn-A'), true);
  assert.equal(tracker.isStaleStop('s1', 'turn-B'), false);
});

test('tracker cannot call a Stop stale without a known current turn', () => {
  const tracker = createDevinTurnTracker({ now: () => 0 });
  assert.equal(tracker.isStaleStop('unknown-session', 'turn-A'), false);
  tracker.noteTurnStarted('s1', 'turn-A');
  assert.equal(tracker.isStaleStop('s1', null), false);
  assert.equal(tracker.isStaleStop(null, 'turn-A'), false);
});

test('tracker entries expire and stay bounded', () => {
  let t = 1000;
  const tracker = createDevinTurnTracker({ now: () => t, ttlMs: 1000, maxEntries: 3 });
  tracker.noteTurnStarted('s1', 'p1');
  t += 1001;
  assert.equal(tracker.isStaleStop('s1', 'p2'), false, 'expired turn is forgotten');
  for (let i = 0; i < 10; i++) tracker.seenEvent(`s${i}`, 'p', 'Stop');
  assert.ok(tracker.size().seen <= 3, `seen cache bounded: ${tracker.size().seen}`);
});

// --- shared receiver integration ---

test('normalizeAgentNotification routes devin payloads through the devin mapper', () => {
  const n = normalizeAgentNotification({
    provider: 'devin',
    eventType: 'Stop',
    ptyId: 9,
    sessionId: 'devin-abc',
    promptId: 'p1',
    stopHookActive: false,
  });
  assert.equal(n.kind, 'turn_stop_requested');
  assert.equal(n.source, 'devin');
});

test('claude and codex Stop semantics are unchanged (regression)', () => {
  assert.equal(
    normalizeAgentNotification({ hook_event_type: 'Stop', agent_source: 'claude', pty_id: 1 }).kind,
    'turn_completed',
  );
  assert.equal(
    normalizeAgentNotification({ hook_event_name: 'stop', agent_source: 'codex', ptyId: 2 }).kind,
    'turn_completed',
  );
});

// --- D3: attention integration (src/notifications/state.mjs) ---

const loadState = async () => {
  const { pathToFileURL } = require('node:url');
  const path = require('node:path');
  return import(pathToFileURL(path.join(__dirname, '..', 'src', 'notifications', 'state.mjs')).href);
};

test('D3: a Devin Stop hook must not erase an unread completed badge (late Stop after OSC finished)', async () => {
  const { receiveAgentNotification } = await loadState();
  const base = receiveAgentNotification({}, {
    tabId: 1,
    projectId: 'proj',
    kind: 'turn_completed',
    eventType: 'turn_finished',
    source: 'devin',
    unread: true,
  });
  assert.equal(base[1].unread, true, 'OSC finished leaves an unread completed badge');

  const afterStop = receiveAgentNotification(base, {
    tabId: 1,
    projectId: 'proj',
    kind: 'turn_stop_requested',
    eventType: 'Stop',
    source: 'devin',
  });
  assert.equal(afterStop, base, 'turn_stop_requested is a no-op at the attention layer');
});

test('D3: a Devin Stop hook must not clear an amber waiting (needs_attention ignored as always)', async () => {
  const { receiveAgentNotification } = await loadState();
  const waiting = receiveAgentNotification({}, {
    tabId: 2,
    projectId: 'proj',
    kind: 'needs_attention',
    eventType: 'Notification',
    source: 'devin',
    reason: 'input',
  });
  assert.equal(waiting[2].waiting, true);

  const afterStop = receiveAgentNotification(waiting, {
    tabId: 2,
    projectId: 'proj',
    kind: 'turn_stop_requested',
    eventType: 'Stop',
    source: 'devin',
  });
  assert.equal(afterStop[2].waiting, true, 'waiting is not cleared by a Stop hook');
});

test('D3: a Devin Stop hook must not create a new attention entry', async () => {
  const { receiveAgentNotification } = await loadState();
  const next = receiveAgentNotification({}, {
    tabId: 3,
    projectId: 'proj',
    kind: 'turn_stop_requested',
    eventType: 'Stop',
    source: 'devin',
  });
  assert.deepEqual(next, {});
});

test('D3: a fresh Devin prompt (UserPromptSubmit) clears a stale waiting, like other agents', async () => {
  const { receiveAgentNotification } = await loadState();
  const waiting = receiveAgentNotification({}, {
    tabId: 4,
    projectId: 'proj',
    kind: 'needs_attention',
    eventType: 'Notification',
    source: 'devin',
    reason: 'input',
  });
  const cleared = receiveAgentNotification(waiting, {
    tabId: 4,
    projectId: 'proj',
    kind: 'turn_started',
    eventType: 'UserPromptSubmit',
    source: 'devin',
  });
  assert.equal(cleared[4], undefined, 'new prompt is the acknowledgement');
});
