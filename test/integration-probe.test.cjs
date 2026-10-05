const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  probeIntegration,
  hasClaudeHook,
  hasOpencodePlugin,
  hasCodexNotify,
  MCP_CAPABLE,
} = require('../src/main/integration-probe.cjs');

// Build throwaway project / home directories so the probe is measured against
// real files rather than a stubbed fs. A stubbed fs would let the very bug
// this guards against -- "assumes the file is there" -- pass.
function makeProject({ hook = false, plugin = false, notify = null, notifyBody = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-probe-proj-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-probe-home-'));

  if (hook) {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: {
          Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'node "D:\\\\x\\\\.claude\\\\project-mixer-hook.cjs" Notification' }] }],
        },
      }, null, 2),
      'utf-8',
    );
  }
  if (plugin) {
    fs.mkdirSync(path.join(root, '.opencode', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(root, '.opencode', 'plugins', 'project-mixer.js'), '// plugin\n', 'utf-8');
  }
  if (notify || notifyBody) {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.codex', 'config.toml'),
      notifyBody !== null ? notifyBody : `notify = [ "node", "C:\\\\pm\\\\${notify}" ]\n`,
      'utf-8',
    );
  }
  return { root, home };
}

// ============================================================
// The measured case that motivates probing at all
// ============================================================

test('codex with a foreign notify is observation-only, not native', () => {
  // Measured on this machine: ~/.codex/config.toml already holds
  // notify = [...codex-computer-use.exe, "turn-ended"], and Codex's parser
  // rejects a list-of-lists, so hook:setup refuses to overwrite it. Declaring
  // codex "native" per provider would therefore be a lie.
  const { root, home } = makeProject({
    notifyBody: 'notify = [ "C:\\\\tools\\\\codex-computer-use.exe", "turn-ended" ]\n',
  });
  const result = probeIntegration({ command: 'codex', projectRoot: root, homeDir: home });
  assert.equal(result.lifecycle, 'pty');
  assert.equal(result.completion, 'observed');
  assert.equal(result.waiting, 'observed');
  assert.ok(result.notes.some((n) => /notify is a single global slot/.test(n)));
});

test('codex with our own notify wrapper is native', () => {
  const { root, home } = makeProject({ notify: 'project-mixer-notify.cjs' });
  const result = probeIntegration({ command: 'codex', projectRoot: root, homeDir: home });
  assert.equal(result.lifecycle, 'notify');
  assert.equal(result.completion, 'explicit');
  assert.equal(result.waiting, 'explicit');
});

test('devin has no native channel, and MCP alone does not make it explicit', () => {
  // Measured: the Devin CLI exposes no hook mechanism. Its session id is a
  // value the human types, which is why provenance has an `asserted` tier.
  const { root, home } = makeProject({ hook: true, plugin: true });
  const result = probeIntegration({ command: 'devin', projectRoot: root, homeDir: home, mcpConnected: true });
  assert.equal(result.lifecycle, 'pty');
  assert.equal(result.protocol, 'mcp');
  // A connected channel is not a reporting channel. The agent can call
  // complete_task only if something told it to, so completion is observed.
  assert.equal(result.completion, 'observed');
  assert.equal(result.waiting, 'observed');
  assert.ok(result.notes.some((n) => /not given a task contract/.test(n)));
});

test('a managed devin session IS explicit, because the contract was injected', () => {
  // This is the plan's "Mixer管理下のsub-agent" case, and it is the reason the
  // managed flag exists. Same binary, same machine, opposite conclusion: the
  // difference is whether Project Mixer told the agent it must report.
  const { root, home } = makeProject({});
  const result = probeIntegration({
    command: 'devin', projectRoot: root, homeDir: home, mcpConnected: true, managed: true,
  });
  assert.equal(result.completion, 'explicit');
  assert.equal(result.waiting, 'explicit');
  assert.equal(result.managed, true);
  assert.equal(result.lifecycle, 'pty', 'the underlying channel is still observation');
});

test('a managed session with a broken native channel is still observed', () => {
  // `managed` must not paper over a missing channel. If the agent cannot reach
  // the protocol at all, a contract in its prompt is worthless.
  const { root, home } = makeProject({});
  const result = probeIntegration({
    command: 'devin', projectRoot: root, homeDir: home, mcpConnected: false, managed: true,
  });
  assert.equal(result.completion, 'observed');
  assert.equal(result.protocol, 'none');
});

// ============================================================
// Capability is per project, not per provider
// ============================================================

test('claude is native only in a project whose hook was installed', () => {
  const withHook = makeProject({ hook: true });
  const without = makeProject({ hook: false });
  assert.equal(probeIntegration({ command: 'claude', projectRoot: withHook.root }).lifecycle, 'hook');
  // hook:setup runs on project switch, so a project that was never opened in
  // Project Mixer has no hook file. A per-provider declaration would get this
  // wrong for every such project.
  assert.equal(probeIntegration({ command: 'claude', projectRoot: without.root }).lifecycle, 'pty');
});

test('a foreign Notification hook does not count as ours', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-probe-foreign-'));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude', 'settings.local.json'),
    JSON.stringify({ hooks: { Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'somebody-elses-hook.sh' }] }] } }),
    'utf-8',
  );
  // A bare key check would report a capability the session does not have.
  assert.equal(hasClaudeHook(root), false);
  assert.equal(probeIntegration({ command: 'claude', projectRoot: root }).lifecycle, 'pty');
});

test('opencode is native only where its plugin file exists', () => {
  const withPlugin = makeProject({ plugin: true });
  const without = makeProject({ plugin: false });
  assert.equal(probeIntegration({ command: 'opencode', projectRoot: withPlugin.root }).lifecycle, 'plugin');
  assert.equal(probeIntegration({ command: 'opencode', projectRoot: without.root }).lifecycle, 'pty');
  assert.equal(hasOpencodePlugin(withPlugin.root), true);
  assert.equal(hasOpencodePlugin(without.root), false);
});

test('a malformed settings file degrades to observation, not to a crash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-probe-bad-'));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), '{ not json', 'utf-8');
  const result = probeIntegration({ command: 'claude', projectRoot: root });
  assert.equal(result.lifecycle, 'pty');
});

// ============================================================
// MCP connectivity changes after spawn
// ============================================================

test('a registered token is not the same as a connected agent', () => {
  // pty:create hands out the token immediately; the transport only appears when
  // the agent dials in. Reporting protocol 'mcp' at spawn would claim a
  // capability that has not been exercised yet, which for a slow-starting CLI
  // is most of its first seconds.
  const { root, home } = makeProject({ hook: true });
  const before = probeIntegration({ command: 'claude', projectRoot: root, mcpConnected: false });
  const after = probeIntegration({ command: 'claude', projectRoot: root, mcpConnected: true });
  assert.equal(before.protocol, 'none');
  assert.equal(after.protocol, 'mcp');
  // Lifecycle is unaffected: hooks exist whether or not MCP connected.
  assert.equal(before.lifecycle, 'hook');
  assert.equal(after.lifecycle, 'hook');
  assert.ok(before.notes.some((n) => /has not connected/.test(n)));
});

test('a non-agent command can never be protocol capable', () => {
  const result = probeIntegration({ command: 'pwsh.exe', mcpConnected: true });
  assert.equal(result.protocol, 'none');
  assert.equal(result.lifecycle, 'pty');
  assert.equal(result.completion, 'observed');
  assert.ok(!MCP_CAPABLE.includes('pwsh'));
});

// ============================================================
// Shape and robustness
// ============================================================

test('pty observation is always true', () => {
  // It is the reason the other columns exist. If this ever became false a
  // codex session on this machine would have no channel at all.
  for (const command of ['claude', 'codex', 'opencode', 'devin', 'pwsh.exe', 'bash']) {
    assert.equal(probeIntegration({ command }).ptyObservation, true, command);
  }
});

test('malformed input degrades instead of throwing', () => {
  for (const input of [undefined, {}, { command: null }, { command: '' }, { command: 123 }]) {
    const result = probeIntegration(input);
    assert.equal(typeof result.lifecycle, 'string');
    assert.equal(result.ptyObservation, true);
  }
  assert.equal(probeIntegration({ command: 'CLAUDE.EXE' }).provider, 'claude');
  assert.equal(probeIntegration({ command: 'D:\\tools\\Codex\\codex.exe' }).provider, 'codex');
});

test('missing config files read as absent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-probe-empty-'));
  assert.equal(hasCodexNotify(home), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-probe-nodir-'));
  assert.equal(hasClaudeHook(root), false);
});

// ============================================================
// Wiring
// ============================================================

test('main probes at spawn and exposes a re-probe IPC', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  // Probed once at spawn, stored on the pty record.
  assert.match(main, /ptyRecord\.integration = probeIntegration\(/);
  // Not awaited: the file reads must never delay the PTY.
  assert.doesNotMatch(main, /await probeIntegration\(/);
  // And refreshable, because MCP connectivity changes after spawn.
  assert.match(main, /ipcMain\.handle\('probe:integration'/);
  assert.match(main, /isSessionConnected/);
});

test('the MCP server can tell a registered token from a live transport', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'server.cjs'), 'utf-8');
  assert.match(server, /function isSessionConnected\(token\)/);
  assert.match(server, /session\.token === token/);
  // hasSession only knows the token was issued; the two must stay distinct.
  assert.match(server, /hasSession: \(token\) => sessionTokens\.has\(token\)/);
});

test('preload exposes the bridge', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf-8');
  assert.match(preload, /probeIntegration: \(ptyId\) => ipcRenderer\.invoke\('probe:integration', \{ ptyId \}\)/);
});

test('the probe reads no environment and spawns nothing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'integration-probe.cjs'), 'utf-8');
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /child_process/);
  assert.doesNotMatch(source, /http/);
});