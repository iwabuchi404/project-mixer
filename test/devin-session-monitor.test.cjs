const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DevinSessionMonitor,
  mapDevinSessionStatus,
  normalizeDevinSessionId,
} = require('../src/main/devin-session-monitor.cjs');

test('accepts Devin Cloud IDs and URLs but rejects local CLI session names', () => {
  assert.equal(normalizeDevinSessionId('devin-abc_123'), 'devin-abc_123');
  assert.equal(
    normalizeDevinSessionId('https://app.devin.ai/sessions/devin-abc_123?view=full'),
    'devin-abc_123',
  );
  assert.equal(normalizeDevinSessionId('caring-cyclamen'), null);
});

test('maps Devin status_detail to the shared observation model', () => {
  assert.deepEqual(mapDevinSessionStatus({ status: 'running', status_detail: 'working' }), {
    kind: 'turn_started', reason: null, eventType: 'working',
  });
  assert.equal(mapDevinSessionStatus({ status_detail: 'waiting_for_user' }).reason, 'input');
  assert.equal(mapDevinSessionStatus({ status_detail: 'waiting_for_approval' }).reason, 'approval');
  assert.equal(mapDevinSessionStatus({ status_detail: 'finished' }).kind, 'turn_completed');
  assert.equal(mapDevinSessionStatus({ status: 'error' }).kind, 'turn_failed');
  assert.equal(mapDevinSessionStatus({ status: 'suspended', status_detail: 'inactivity' }), null);
  assert.equal(mapDevinSessionStatus({ status: 'suspended', status_detail: 'usage_limit' }).kind, 'turn_failed');
});

test('polls the organization session endpoint and emits only status changes', async () => {
  let statusDetail = 'working';
  const calls = [];
  const events = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'running', status_detail: statusDetail }),
    };
  };
  const monitor = new DevinSessionMonitor({
    token: 'secret-token',
    orgId: 'org-example',
    fetchImpl,
    intervalMs: 60000,
    onLifecycleEvent: (event) => events.push(event),
  });

  const bound = await monitor.bind({ ptyId: 7, sessionId: 'devin-session1' });
  assert.equal(bound.ok, true);
  assert.equal(calls[0].url, 'https://api.devin.ai/v3/organizations/org-example/sessions/devin-session1');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'turn_started');

  await monitor.pollAll();
  assert.equal(events.length, 1);
  statusDetail = 'waiting_for_approval';
  await monitor.pollAll();
  assert.equal(events.length, 2);
  assert.equal(events[1].reason, 'approval');
  monitor.dispose();
});

test('fails closed without configuration and never includes the token in errors', async () => {
  const missing = new DevinSessionMonitor();
  assert.equal((await missing.bind({ ptyId: 1, sessionId: 'devin-a' })).ok, false);

  const errors = [];
  const monitor = new DevinSessionMonitor({
    token: 'do-not-leak',
    orgId: 'org-example',
    fetchImpl: async () => ({ ok: false, status: 401 }),
    onError: (error) => errors.push(error),
  });
  const result = await monitor.bind({ ptyId: 1, sessionId: 'devin-a' });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify({ result, errors }).includes('do-not-leak'), false);
});

test('Devin binding keeps tab rename separate and asks for a session ID or URL', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  assert.match(renderer, /\{ action: 'rename', label: 'Rename Tab' \}/);
  assert.match(renderer, /Devin Cloud session ID \(devin-\.\.\.\) or session URL:/);
});
