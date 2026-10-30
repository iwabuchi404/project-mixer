const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildHookBridgeScript } = require('../src/main/hooks/hook-bridge-source.cjs');
const { normalizeAgentNotification, resolveNotificationTarget, createSessionBindingStore } = require('../src/main/agent-notification-service.cjs');

// --- sessionId binding store ---

test('session binding store binds, looks up, and stays bounded', () => {
  const store = createSessionBindingStore({ maxEntries: 2 });
  assert.equal(store.bind('devin-a', 1), true);
  assert.equal(store.lookup('devin-a'), 1);
  assert.equal(store.lookup('devin-b'), null);
  assert.equal(store.bind('devin-b', 2), true);
  assert.equal(store.bind('devin-c', 3), true);
  assert.equal(store.lookup('devin-a'), null, 'oldest entry evicted');
  assert.equal(store.size(), 2);
  assert.equal(store.bind('bad', -1), false);
  assert.equal(store.bind('', 1), false);
});

test('resolveNotificationTarget prefers ptyId, then session binding, then cwd', () => {
  const ptys = new Map([[1, { cwd: 'D:\\w\\a' }], [2, { cwd: 'D:\\w\\a' }]]);
  const bindings = createSessionBindingStore();
  bindings.bind('devin-x', 2);
  const notification = { ptyId: null, sessionId: 'devin-x', cwd: 'D:\\w\\a' };
  // Two PTYs share the cwd: without a binding this would be ambiguous.
  assert.deepEqual(resolveNotificationTarget(notification, ptys, bindings), {
    ptyId: 2, ambiguous: false, unattributed: false, via: 'session',
  });
  // Explicit ptyId wins over the binding.
  assert.deepEqual(resolveNotificationTarget({ ...notification, ptyId: 1 }, ptys, bindings), {
    ptyId: 1, ambiguous: false, unattributed: false,
  });
  // Explicit but exited ptyId: unattributed, never falls through to cwd (D2 Gate).
  assert.deepEqual(resolveNotificationTarget({ ...notification, ptyId: 99 }, ptys, bindings), {
    ptyId: null, ambiguous: false, unattributed: true,
  });
  // Binding to an exited pty: falls down the chain (cwd, ambiguous here).
  const deadBinding = createSessionBindingStore();
  deadBinding.bind('devin-x', 77);
  assert.deepEqual(resolveNotificationTarget(notification, ptys, deadBinding), {
    ptyId: null, ambiguous: true, unattributed: true,
  });
  // Unknown session: plain cwd routing still works (single pty case).
  const single = new Map([[5, { cwd: 'D:\\w\\a' }]]);
  assert.deepEqual(resolveNotificationTarget({ ptyId: null, sessionId: 'nobody', cwd: 'D:\\w\\a' }, single, bindings), {
    ptyId: 5, ambiguous: false, unattributed: false,
  });
});

// --- hook bridge subprocess (end-to-end against a local receiver) ---

function startReceiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
  });
}

function runBridge(args, input, env = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    // The bridge is deployed as a script file (D4 writes it to a stable
    // integration directory), so spawn it as a file exactly like agents do.
    const bridgePath = path.join(os.tmpdir(), `pm-hook-bridge-${process.pid}.cjs`);
    fs.writeFileSync(bridgePath, buildHookBridgeScript());
    const child = spawn(process.execPath, [bridgePath, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdin.write(input);
    child.stdin.end();
    child.on('close', (code) => {
      fs.unlink(bridgePath, () => resolve({ code, stderr, elapsed: Date.now() - startedAt }));
    });
  });
}

test('bridge forwards devin allowlist fields and drops prompt/tool bodies', async () => {
  const { server, received, port } = await startReceiver();
  try {
    const { code } = await runBridge(['--provider', 'devin'], JSON.stringify({
      eventType: 'Stop',
      sessionId: 'devin-abc',
      promptId: 'prompt-1',
      stopHookActive: false,
      prompt: 'SECRET PROMPT TEXT',
      tool_input: { command: 'SECRET COMMAND' },
      env: { EVERYTHING: 'SECRET' },
    }), {
      PM_HOOK_URL: `http://127.0.0.1:${port}/hook`,
      PM_HOOK_TOKEN: 'tok-1',
      PROJECT_MIXER_PTY_ID: '42',
    });
    assert.equal(code, 0);
    assert.equal(received.length, 1);
    const payload = JSON.parse(received[0].body);
    assert.equal(received[0].headers['x-project-mixer-hook'], 'tok-1');
    assert.equal(payload.provider, 'devin');
    assert.equal(payload.eventType, 'Stop');
    assert.equal(payload.sessionId, 'devin-abc');
    assert.equal(payload.promptId, 'prompt-1');
    assert.equal(payload.stopHookActive, false);
    assert.equal(payload.pty_id, 42);
    assert.equal(payload.prompt, undefined, 'prompt text must not be forwarded');
    assert.equal(payload.tool_input, undefined, 'tool bodies must not be forwarded');
    assert.equal(JSON.stringify(payload).includes('SECRET'), false, 'no secret leakage');
  } finally {
    server.close();
  }
});

test('bridge keeps legacy claude/codex arg behaviour without secrets growth', async () => {
  const { server, received, port } = await startReceiver();
  try {
    const { code } = await runBridge(['Stop'], JSON.stringify({
      hook_event_type: 'Stop',
      session_id: 'claude-1',
      prompt: 'SECRET',
      message: 'done',
    }), {
      PM_HOOK_URL: `http://127.0.0.1:${port}/hook`,
      PM_HOOK_TOKEN: 'tok-2',
      PROJECT_MIXER_PTY_ID: '7',
    });
    assert.equal(code, 0);
    assert.equal(received.length, 1);
    const payload = JSON.parse(received[0].body);
    assert.equal(payload.hook_event_type, 'Stop');
    assert.equal(payload.agent_source, 'claude');
    assert.equal(payload.pty_id, 7);
    assert.equal(payload.session_id, 'claude-1');
    assert.equal(payload.prompt, undefined, 'prompt text must not be forwarded');
  } finally {
    server.close();
  }
});

test('bridge without PM environment exits 0 silently', async () => {
  const { server, received, port } = await startReceiver();
  try {
    const { code } = await runBridge(['--provider', 'devin'], JSON.stringify({ eventType: 'Stop' }), {});
    assert.equal(code, 0);
    assert.equal(received.length, 0);
  } finally {
    server.close();
  }
});

test('bridge exits 0 within the bounded timeout when the receiver hangs', async () => {
  const server = http.createServer(() => { /* never respond */ });
  const { port } = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address())));
  try {
    const { code, elapsed } = await runBridge(['--provider', 'devin'], JSON.stringify({ eventType: 'Stop' }), {
      PM_HOOK_URL: `http://127.0.0.1:${port}/hook`,
      PM_HOOK_TOKEN: 'tok',
    });
    assert.equal(code, 0);
    assert.ok(elapsed < 5000, `bridge hung for ${elapsed}ms`);
  } finally {
    server.close();
  }
});

test('bridge source is self-contained (no repo-relative requires)', () => {
  const script = buildHookBridgeScript();
  assert.doesNotMatch(script, /require\('\.\//);
  assert.match(script, /MAX_STDIN_BYTES/);
  fs.writeFileSync(path.join(os.tmpdir(), 'pm-bridge-syntax-check.cjs'), script);
  const { spawnSync } = require('node:child_process');
  const check = spawnSync(process.execPath, ['--check', path.join(os.tmpdir(), 'pm-bridge-syntax-check.cjs')]);
  assert.equal(check.status, 0, check.stderr?.toString());
});
