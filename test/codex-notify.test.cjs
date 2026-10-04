const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  WRAPPER_SOURCE,
  planCodexNotifyInstall,
  findTopLevelNotify,
  insertTopLevelNotify,
} = require('../src/main/codex-notify.cjs');

// ============================================================
// Codex notify install plan (non-destructive)
// ============================================================

test('installs notify when config.toml has none', () => {
  const plan = planCodexNotifyInstall({
    existingToml: 'model = "gpt-5.6-terra"\n',
    wrapperPath: '/home/u/.codex/project-mixer-notify.cjs',
  });
  assert.equal(plan.action, 'install');
  assert.equal(findTopLevelNotify(plan.toml), '["node", "/home/u/.codex/project-mixer-notify.cjs"]');
  // Unrelated settings survive.
  assert.match(plan.toml, /^model = "gpt-5\.6-terra"$/m);
});

test('refuses to overwrite an existing top-level notify', () => {
  // This is the real-world collision: the Codex Desktop computer-use
  // integration owns `notify`. Overwriting it would break that feature,
  // and Codex rejects a list-of-lists so chaining needs a wrapper the
  // user must opt into separately.
  const existing = [
    'model = "gpt-5.6-terra"',
    'notify = [ "C:\\\\tools\\\\codex-computer-use.exe", "turn-ended" ]',
    '',
    '[features]',
    'hooks = true',
    '',
  ].join('\n');
  const plan = planCodexNotifyInstall({ existingToml: existing, wrapperPath: '/w.cjs' });
  assert.equal(plan.action, 'skip');
  assert.equal(plan.existing, '[ "C:\\\\tools\\\\codex-computer-use.exe", "turn-ended" ]');
  assert.match(plan.note, /did not modify/i);
  // The critical assertion: no toml is produced, so the caller cannot
  // write even by accident.
  assert.equal(plan.toml, undefined);
});

test('creates a config when none exists', () => {
  const plan = planCodexNotifyInstall({ existingToml: null, wrapperPath: '/w.cjs' });
  assert.equal(plan.action, 'create');
  assert.equal(findTopLevelNotify(plan.toml), '["node", "/w.cjs"]');
});

test('a notify inside a table is not mistaken for the top-level key', () => {
  // Codex reads `notify` at top level only. A same-named key under a
  // table must not suppress the install, and must not be overwritten.
  const toml = [
    'model = "x"',
    '',
    '[shell_environment_policy.set]',
    'notify = "unrelated"',
    '',
  ].join('\n');
  assert.equal(findTopLevelNotify(toml), null);
  const plan = planCodexNotifyInstall({ existingToml: toml, wrapperPath: '/w.cjs' });
  assert.equal(plan.action, 'install');
  // The table's key is preserved verbatim.
  assert.match(plan.toml, /\[shell_environment_policy\.set\]\nnotify = "unrelated"/);
});

test('quoted notify key is detected', () => {
  assert.equal(findTopLevelNotify('"notify" = ["a"]\n'), '["a"]');
});

test('inserted notify lands above the first table header', () => {
  // If it landed after a header the key would silently become part of
  // that table and Codex would ignore it.
  const toml = ['model = "x"', '', '[features]', 'hooks = true', ''].join('\n');
  const out = insertTopLevelNotify(toml, '["node", "/w.cjs"]');
  const lines = out.split('\n');
  const notifyAt = lines.findIndex((l) => l.startsWith('notify'));
  const headerAt = lines.findIndex((l) => l.trimStart().startsWith('['));
  assert.ok(notifyAt >= 0 && headerAt >= 0);
  assert.ok(notifyAt < headerAt, `notify at ${notifyAt} must precede header at ${headerAt}`);
});

test('wrapper payload mapping matches the canonical notification shape', () => {
  // Codex's legacy payload is kebab-case with 'type' for the event name.
  // `thread-id` is the resumable id (it matches the rollout filename),
  // so mapping it to session_id is what makes codex tabs resumable.
  assert.match(WRAPPER_SOURCE, /event\['thread-id'\]/);
  assert.match(WRAPPER_SOURCE, /session_id:/);
  assert.match(WRAPPER_SOURCE, /hook_event_type:/);
  assert.match(WRAPPER_SOURCE, /agent_source: 'codex'/);
  // Inert outside Project Mixer, like the Claude hook script.
  assert.match(WRAPPER_SOURCE, /if \(!hookUrl \|\| !hookToken \|\| !payload\) process\.exit\(0\)/);
  // Codex appends the payload LAST; everything before it is the previous
  // command when chaining.
  assert.match(WRAPPER_SOURCE, /argv\[argv\.length - 1\]/);
  assert.match(WRAPPER_SOURCE, /previousCommand = argv\.slice\(0, -1\)/);
});

test('hook:setup never writes codex config.toml when notify exists', () => {
  // Structure guard: the caller must branch on plan.action before any
  // writeTextAtomic of the config file.
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  const block = main.slice(main.indexOf('planCodexNotifyInstall({'), main.indexOf("results.push({ tool: 'opencode'"));
  assert.match(block, /plan\.action === 'skip'/);
  const skipBranch = block.slice(block.indexOf("plan.action === 'skip'"), block.indexOf('} else {'));
  assert.doesNotMatch(skipBranch, /writeTextAtomic\(codexConfigPath/);
});

test('agent-turn-complete maps to turn_completed via the existing kind table', () => {
  // The wrapper reuses an event name agent-notification-service.cjs
  // already handles, so no new lifecycle kind is needed.
  const { normalizeAgentNotification } = require('../src/main/agent-notification-service.cjs');
  const n = normalizeAgentNotification({
    hook_event_type: 'agent-turn-complete',
    session_id: '01a101de-19bb-7613-a004-461c49d9b576',
    cwd: 'D:\\work\\app',
    agent_source: 'codex',
  });
  assert.equal(n.kind, 'turn_completed');
  assert.equal(n.source, 'codex');
  assert.equal(n.sessionId, '01a101de-19bb-7613-a004-461c49d9b576');
});

// ============================================================
// Wrapper end-to-end: real process, real HTTP endpoint
// ============================================================

test('wrapper posts the codex payload to PM_HOOK_URL and stays silent on failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-codex-notify-'));
  const wrapper = path.join(dir, 'notify.cjs');
  const prevMarker = path.join(dir, 'prev-received.json');
  const prevScript = path.join(dir, 'prev.cjs');
  const serverScript = path.join(dir, 'server.cjs');
  const received = path.join(dir, 'received.json');
  const port = 47100 + Math.floor(Math.random() * 400);

  fs.writeFileSync(wrapper, WRAPPER_SOURCE, 'utf-8');
  // Stands in for a pre-existing notify program (the computer-use exe).
  fs.writeFileSync(
    prevScript,
    `require('fs').writeFileSync(${JSON.stringify(prevMarker)}, JSON.stringify(process.argv.slice(2)), 'utf-8');`,
    'utf-8',
  );
  fs.writeFileSync(
    serverScript,
    `const http=require('http'),fs=require('fs');
     const s=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{
       fs.writeFileSync(${JSON.stringify(received)}, JSON.stringify({token:req.headers['x-project-mixer-hook'],body:JSON.parse(b)}),'utf-8');
       res.writeHead(200);res.end('{}');s.close();});});
     s.listen(${port},'127.0.0.1');`,
    'utf-8',
  );

  const env = {
    ...process.env,
    PM_HOOK_URL: `http://127.0.0.1:${port}/hook`,
    PM_HOOK_TOKEN: 'tok-123',
  };
  const payload = JSON.stringify({
    type: 'agent-turn-complete',
    'thread-id': '01a101de-19bb-7613-a004-461c49d9b576',
    'turn-id': 'turn-1',
    cwd: 'D:\\work\\app',
    client: 'codex_exec',
    'last-assistant-message': 'done',
  });

  const { spawn } = require('child_process');
  const net = require('net');
  const server = spawn(process.execPath, [serverScript], { stdio: 'ignore' });

  const waitForPort = (deadline) => new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error('listener never bound'));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });

  return waitForPort(Date.now() + 8000)
    .then(() => new Promise((resolve, reject) => {
      // Run the wrapper asynchronously: execFileSync would block the
      // event loop and starve the listener in this same process tree.
      const child = spawn(process.execPath, [wrapper, process.execPath, prevScript, payload], {
        env,
        stdio: 'ignore',
      });
      const deadline = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error('wrapper did not exit'));
      }, 8000);
      child.on('exit', (code) => {
        clearTimeout(deadline);
        if (code !== 0) reject(new Error(`wrapper exited ${code}`));
        else resolve();
      });
    }))
    .then(() => new Promise((resolve, reject) => {
      // The endpoint writes its file on the request, so poll for it.
      const deadline = Date.now() + 8000;
      const attempt = () => {
        if (fs.existsSync(received) && fs.existsSync(prevMarker)) return resolve();
        if (Date.now() > deadline) return reject(new Error('no POST received'));
        return setTimeout(attempt, 50);
      };
      attempt();
    }))
    .then(() => {
      // The chained predecessor still received the payload.
      assert.deepEqual(JSON.parse(fs.readFileSync(prevMarker, 'utf-8')), [payload]);
      const got = JSON.parse(fs.readFileSync(received, 'utf-8'));
      assert.equal(got.token, 'tok-123');
      assert.equal(got.body.hook_event_type, 'agent-turn-complete');
      assert.equal(got.body.session_id, '01a101de-19bb-7613-a004-461c49d9b576');
      assert.equal(got.body.agent_source, 'codex');
      assert.equal(got.body.cwd, 'D:\\work\\app');
    })
    .finally(() => {
      try { server.kill('SIGKILL'); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    });
});

test('wrapper exits 0 without PM_HOOK_URL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-codex-inert-'));
  const wrapper = path.join(dir, 'notify.cjs');
  fs.writeFileSync(wrapper, WRAPPER_SOURCE, 'utf-8');
  const env = { ...process.env };
  delete env.PM_HOOK_URL;
  delete env.PM_HOOK_TOKEN;
  // Must not throw or hang when codex runs outside Project Mixer.
  const out = execFileSync(process.execPath, [wrapper, '{"type":"agent-turn-complete"}'], { env, encoding: 'utf-8' });
  assert.equal(out.trim(), '');
  fs.rmSync(dir, { recursive: true, force: true });
});
