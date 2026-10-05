const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const {
  prepareAgentAttention,
  AGENT_KINDS,
  AGENT_PRIORITIES,
  MAX_TITLE_LENGTH,
} = require('../src/main/attention-request.cjs');

const loadStore = () => import(pathToFileURL(
  path.join(__dirname, '..', 'src', 'attention', 'attention-store.mjs'),
).href);
const loadWiring = () => import(pathToFileURL(
  path.join(__dirname, '..', 'src', 'attention', 'attention-wiring.mjs'),
).href);

const SESSION = { ptyId: 12, projectId: 'proj-1', cwd: 'D:\\work\\app' };

// ============================================================
// Guard: blocking (plan 8.5.7)
// ============================================================

test('an agent can never mark its own attention as blocking', () => {
  // "blocking: true は人間のリソースを止めるので Agent 側では決められない".
  // This is the whole reason the guard exists.
  for (const blocking of [true, 'true', 1, 'yes']) {
    const prepared = prepareAgentAttention({ title: 'x', blocking }, SESSION);
    assert.ok(prepared.ok, `blocking=${blocking} should still be accepted`);
    assert.equal(prepared.attention.blocking, false, `blocking=${blocking} must be forced false`);
    assert.equal(prepared.attention.agentDeclaredBlocking, true, 'but the attempt is recorded');
    assert.ok(prepared.notices.some((n) => /blocking was ignored/.test(n)));
  }
  // Nothing declared -> nothing to report.
  const plain = prepareAgentAttention({ title: 'x' }, SESSION);
  assert.equal(plain.attention.agentDeclaredBlocking, false);
  assert.deepEqual(plain.notices, []);
});

// ============================================================
// Identity comes from the transport (plan 8.4)
// ============================================================

test('identity is never taken from the agent arguments', () => {
  const prepared = prepareAgentAttention({
    title: 'x',
    projectId: 'proj-attacker',
    ptyId: 999,
    tabId: 42,
  }, SESSION);
  assert.equal(prepared.attention.projectId, 'proj-1', 'session project wins');
  assert.equal(prepared.attention.ptyId, 12, 'session pty wins');
  // An agent-supplied tabId is dropped entirely: the renderer resolves ptyId.
  assert.equal(prepared.attention.tabId, undefined);
});

test('a session without a project or terminal is refused, not guessed', () => {
  assert.equal(prepareAgentAttention({ title: 'x' }, { ptyId: 1 }).ok, false);
  assert.equal(prepareAgentAttention({ title: 'x' }, { projectId: 'p' }).ok, false);
  assert.equal(prepareAgentAttention({ title: 'x' }, null).ok, false);
  const message = prepareAgentAttention({ title: 'x' }, { projectId: 'p' }).error;
  assert.match(message, /no terminal/);
});

// ============================================================
// Input validation
// ============================================================

test('title is required and length-capped', () => {
  assert.match(prepareAgentAttention({}, SESSION).error, /title is required/);
  assert.match(prepareAgentAttention({ title: '   ' }, SESSION).error, /title is required/);
  const long = prepareAgentAttention({ title: 'x'.repeat(500) }, SESSION);
  assert.equal(long.ok, true);
  assert.equal(long.attention.title.length, MAX_TITLE_LENGTH);
  assert.match(long.attention.title, /…$/);
});

test('an unknown kind degrades to question with a notice', () => {
  const prepared = prepareAgentAttention({ title: 'x', kind: 'drop-tables' }, SESSION);
  assert.equal(prepared.attention.kind, 'question');
  assert.ok(prepared.notices.some((n) => /unknown kind/.test(n)));
  // A valid kind produces no notice.
  assert.deepEqual(prepareAgentAttention({ title: 'x', kind: 'decision' }, SESSION).notices, []);
});

test('every kind and priority the tool advertises is accepted', () => {
  for (const kind of AGENT_KINDS) {
    assert.equal(prepareAgentAttention({ title: 'x', kind }, SESSION).attention.kind, kind);
  }
  for (const priority of AGENT_PRIORITIES) {
    assert.equal(
      prepareAgentAttention({ title: 'x', priority }, SESSION).attention.requestedPriority,
      priority,
    );
  }
  // Case and whitespace are tolerated; junk falls back to normal.
  assert.equal(prepareAgentAttention({ title: 'x', priority: ' HIGH ' }, SESSION).attention.requestedPriority, 'high');
  assert.equal(prepareAgentAttention({ title: 'x', priority: 'urgent' }, SESSION).attention.requestedPriority, 'normal');
});

test('the guard module is pure: no clock, no IO, no renderer', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'attention-request.cjs'), 'utf-8');
  assert.doesNotMatch(source, /Date\.now|new Date/);
  assert.doesNotMatch(source, /\bdocument\b|\bwindow\b/);
  assert.doesNotMatch(source, /require\(/);
});

// ============================================================
// Store: idempotence and the per-session cap (plan 8.5.7)
// ============================================================

test('the same kind + title from one tab is idempotent', async () => {
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore();
  const draft = { projectId: 'p', tabId: 3, kind: 'decision', title: 'API shape' };
  const first = store.requestAgentAttention(draft);
  assert.equal(first.ok, true);
  assert.equal(first.deduped, false);
  const second = store.requestAgentAttention(draft);
  assert.equal(second.ok, true);
  assert.equal(second.deduped, true);
  assert.equal(store.getOpenAttention().length, 1, 'no duplicate row');
});

test('a retry does not bump recency', async () => {
  // An Inbox that re-sorts on recency would otherwise let an old item refuse
  // to sink as long as the agent keeps retrying.
  let clock = 1000;
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore({ now: () => clock });
  const draft = { projectId: 'p', tabId: 3, kind: 'decision', title: 'API shape' };
  const first = store.requestAgentAttention(draft);
  clock = 5000;
  const second = store.requestAgentAttention(draft);
  assert.equal(second.attention.createdAt, first.attention.createdAt);
  assert.equal(second.attention.updatedAt, first.attention.updatedAt);
});

test('distinct titles from one tab coexist up to the cap', async () => {
  const { createAttentionStore, AGENT_MAX_OPEN_ATTENTION } = await loadStore();
  const store = createAttentionStore();
  for (let i = 0; i < AGENT_MAX_OPEN_ATTENTION; i += 1) {
    const r = store.requestAgentAttention({ projectId: 'p', tabId: 3, kind: 'decision', title: `q${i}` });
    assert.equal(r.ok, true, `item ${i} should be accepted`);
  }
  const overflow = store.requestAgentAttention({ projectId: 'p', tabId: 3, kind: 'decision', title: 'one too many' });
  assert.equal(overflow.ok, false);
  assert.match(overflow.error, /limit/);
});

test('the cap is per session, so one agent cannot silence another', async () => {
  const { createAttentionStore, AGENT_MAX_OPEN_ATTENTION } = await loadStore();
  const store = createAttentionStore();
  for (let i = 0; i < AGENT_MAX_OPEN_ATTENTION; i += 1) {
    store.requestAgentAttention({ projectId: 'p', tabId: 1, kind: 'decision', title: `a${i}` });
  }
  const other = store.requestAgentAttention({ projectId: 'p', tabId: 2, kind: 'decision', title: 'b' });
  assert.equal(other.ok, true, 'a different tab in the same project is unaffected');
});

test('a resolved item does not count against the cap, and cannot be revived', async () => {
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore();
  const draft = { projectId: 'p', tabId: 3, kind: 'decision', title: 'API shape' };
  const created = store.requestAgentAttention(draft);
  store.resolveAttention(created.attention.id);
  const again = store.requestAgentAttention(draft);
  assert.equal(again.ok, false, 'a resolved request cannot resurrect itself');
  assert.match(again.error, /already resolved/);
});

// ============================================================
// Assertion space is separate from evidence
// ============================================================

test('an agent item never becomes evidence', async () => {
  // If it went through the mapper it would land in terminalAttention and could
  // forge the amber `waiting` state that the whole rung hierarchy trusts.
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore();
  store.requestAgentAttention({ projectId: 'p', tabId: 3, kind: 'question', title: 'ask' });
  // A reconcile with no terminalAttention for that tab must not resurrect or
  // touch the agent item.
  store.reconcile({});
  const open = store.getOpenAttention();
  assert.equal(open.length, 1);
  assert.equal(open[0].source, 'mcp');
  assert.equal(open[0].blocking, false);
  assert.match(open[0].id, /^agent:/, 'assertion ids are namespaced away from evidence ids');
});

test('an agent item and an evidence item for the same tab coexist', async () => {
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore();
  store.requestAgentAttention({ projectId: 'p', tabId: 3, kind: 'question', title: 'agent asks' });
  store.reconcile({
    3: { projectId: 'p', waiting: true, kind: 'needs_attention', source: 'claude', reason: 'input' },
  });
  const open = store.getOpenAttention();
  assert.equal(open.length, 2, 'the agent request does not overwrite hook evidence');
  assert.equal(open.filter((i) => i.blocking).length, 1, 'only the evidence item blocks');
});

test('acknowledging works on both spaces', async () => {
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore();
  const evidence = store.reconcile({
    4: { projectId: 'p', waiting: false, kind: 'turn_failed', source: 'claude', unread: true },
  }).created[0];
  const agent = store.requestAgentAttention({ projectId: 'p', tabId: 5, kind: 'decision', title: 'ask' }).attention;
  assert.equal(store.acknowledgeAttention(evidence.id).state, 'ACKNOWLEDGED');
  assert.equal(store.acknowledgeAttention(agent.id).state, 'ACKNOWLEDGED');
});

test('answering in the terminal also clears what the agent asked', async () => {
  // The human typed the answer in the terminal, so the question is answered
  // no matter which channel delivered it.
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore();
  store.requestAgentAttention({ projectId: 'p', tabId: 6, kind: 'question', title: 'ask' });
  store.answerAttention('p', 6);
  assert.equal(store.getOpenAttention().length, 0);
});

test('closing a tab forgets what the agent asked', async () => {
  // Otherwise a closed tab's items would sit against the per-session cap
  // forever and the tab could never ask anything again.
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore();
  store.requestAgentAttention({ projectId: 'p', tabId: 7, kind: 'question', title: 'ask' });
  store.forget('p', 7);
  assert.equal(store.getOpenAttention().length, 0);
  const again = store.requestAgentAttention({ projectId: 'p', tabId: 7, kind: 'question', title: 'ask again' });
  assert.equal(again.ok, true);
});

test('an agent item gets an effectivePriority from the policy, not the claim', async () => {
  const { createAttentionStore } = await loadStore();
  const store = createAttentionStore();
  const item = store.requestAgentAttention({
    projectId: 'p', tabId: 8, kind: 'error', requestedPriority: 'low', title: 'failed',
  }).attention;
  // requestedPriority is the agent's word; effectivePriority is derived from
  // kind. An agent cannot talk its way down from an error.
  assert.equal(item.requestedPriority, 'low');
  assert.equal(item.effectivePriority, 'high');
});

// ============================================================
// Wiring + renderer surface
// ============================================================

test('wiring exposes requestAgentAttention without touching evidence', async () => {
  const wiring = await loadWiring();
  wiring.__resetAttentionStoreForTest();
  wiring.reconcileAttention({
    9: { projectId: 'p', waiting: true, kind: 'needs_attention', source: 'claude' },
  });
  const result = wiring.requestAgentAttention({
    projectId: 'p', tabId: 9, kind: 'question', title: 'also this', blocking: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attention.blocking, false);
  assert.equal(result.attention.agentDeclaredBlocking, true);
  assert.equal(wiring.getAttentionStore().getOpenAttention().length, 2);
  wiring.__resetAttentionStoreForTest();
});

test('the renderer resolves ptyId and refuses a dead terminal', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf-8');
  const start = renderer.indexOf("register('agent_request_attention'");
  assert.ok(start > 0, 'the command must be registered');
  const block = renderer.slice(start, renderer.indexOf("register('agent_notification_seen'"));
  // tabId is derived from the renderer's own ptyId map, never from args.
  assert.match(block, /if \(terminal\.ptyId === ptyId\)/);
  assert.doesNotMatch(block, /tabId:\s*ptyId/);
  assert.match(block, /That terminal is no longer open/);
  // It must not write terminalAttention: that map is hook evidence.
  assert.doesNotMatch(block, /commitTerminalAttention|setTerminalWaiting|receiveAgentNotification/);
  assert.match(block, /blocking: false/);
});

test('the MCP tool exists and never advertises blocking as usable', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'server.cjs'), 'utf-8');
  const start = server.indexOf("'request_attention'");
  assert.ok(start > 0);
  const block = server.slice(start, server.indexOf('return mcpServer;', start));
  // Guards run before dispatch.
  assert.match(block, /prepareAgentAttention\(args, sessionContext\)/);
  assert.ok(block.indexOf('prepareAgentAttention') < block.indexOf('dispatchToRenderer'));
  assert.match(block, /isError: true/);
  // The description must tell agents this is not for progress updates.
  assert.match(block, /Do NOT use it for progress updates/);
  assert.match(block, /blocking: z\.boolean\(\)\.optional\(\)\s*\n\s*\.describe\('Ignored/);
});

test('the command schema accepts exactly what the tool sends', () => {
  const schemas = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'schemas.js'), 'utf-8');
  assert.match(schemas, /agent_request_attention: p\(\{/);
  assert.match(schemas, /ptyId: z\.number\(\)/);
  // blocking must be optional: the guard rejects true, and a required field
  // would make the schema contradict the guard.
  assert.match(schemas, /blocking: z\.boolean\(\)\.optional\(\)/);
});