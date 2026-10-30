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
