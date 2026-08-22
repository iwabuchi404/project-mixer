const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  normalizeAgentNotification,
  resolveNotificationTarget,
} = require('../src/main/agent-notification-service.cjs');

async function loadState() {
  return import(pathToFileURL(path.join(__dirname, '..', 'src', 'notifications', 'state.mjs')).href);
}

test('normalizes agent hook payloads into canonical lifecycle events', () => {
  assert.deepEqual(normalizeAgentNotification({
    hook_event_type: 'Notification',
    cwd: 'D:\\work\\app',
    pty_id: 7,
  }), {
    eventType: 'Notification',
    kind: 'needs_attention',
    reason: 'input',
    title: null,
    message: null,
    sessionId: null,
    source: 'claude',
    cwd: 'D:\\work\\app',
    ptyId: 7,
  });
  assert.equal(normalizeAgentNotification({ event: 'agent-turn-complete' }).kind, 'turn_completed');
  assert.equal(normalizeAgentNotification({ type: 'agent-turn-complete', agent_source: 'codex' }).source, 'codex');
  assert.equal(normalizeAgentNotification({ hook_event_name: 'PermissionRequest' }).kind, 'needs_attention');
  assert.equal(normalizeAgentNotification({ hook_event_name: 'PermissionRequest' }).reason, 'approval');
  assert.equal(normalizeAgentNotification({ hook_event_name: 'Stop' }).kind, 'turn_completed');
  assert.equal(normalizeAgentNotification({ hook_event_name: 'StopFailure' }).kind, 'turn_failed');
  assert.equal(normalizeAgentNotification({ type: 'unrelated' }), null);
});

test('preserves concise notification content and derives permission details', () => {
  const notification = normalizeAgentNotification({
    hook_event_type: 'Notification',
    title: ' Choice needed\n',
    message: 'Use\u001b[31m API A\u001b[0m\n or API B?',
  });
  assert.equal(notification.title, 'Choice needed');
  assert.equal(notification.message, 'Use API A or API B?');

  const permission = normalizeAgentNotification({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: {
      command: 'npm test',
      description: 'Run the complete test suite',
    },
  });
  assert.equal(permission.title, 'Approval required: Bash');
  assert.equal(permission.message, 'Run the complete test suite');

  const longMessage = normalizeAgentNotification({
    hook_event_type: 'Notification',
    message: 'x'.repeat(300),
  }).message;
  assert.equal(longMessage.length, 240);
  assert.match(longMessage, /…$/);
});

test('main process forwards normalized notification content to the renderer', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /title: notification\.title/);
  assert.match(main, /message: notification\.message/);
});

test('routes by explicit PTY before cwd and refuses ambiguous cwd matches', () => {
  const ptys = new Map([
    [1, { cwd: 'D:\\work\\app' }],
    [2, { cwd: 'D:\\work\\app' }],
  ]);
  assert.deepEqual(resolveNotificationTarget({ ptyId: 2, cwd: 'D:\\work\\app' }, ptys), {
    ptyId: 2,
    ambiguous: false,
    unattributed: false,
  });
  assert.deepEqual(resolveNotificationTarget({ ptyId: null, cwd: 'D:\\work\\app' }, ptys), {
    ptyId: null,
    ambiguous: true,
    unattributed: true,
  });
  assert.deepEqual(resolveNotificationTarget({ ptyId: 99, cwd: 'D:\\work\\app' }, ptys), {
    ptyId: null,
    ambiguous: false,
    unattributed: true,
  });
});

test('keeps background completion unread until the exact tab is seen', async () => {
  const { receiveAgentNotification, markAgentNotificationSeen } = await loadState();
  const received = receiveAgentNotification({}, {
    tabId: 3,
    projectId: 'p1',
    kind: 'turn_completed',
    eventType: 'Stop',
    source: 'claude',
    unread: true,
  });
  assert.equal(received[3].unread, true);
  assert.deepEqual(markAgentNotificationSeen(received, 3), {});
});

test('keeps waiting status after it is seen and clears it after user input', async () => {
  const {
    receiveAgentNotification,
    markAgentNotificationSeen,
    setTerminalWaiting,
    summarizeTerminalAttention,
  } = await loadState();
  const received = receiveAgentNotification({}, {
    tabId: 4,
    projectId: 'p2',
    kind: 'needs_attention',
    eventType: 'PermissionRequest',
    source: 'codex',
    title: 'Approval required: Bash',
    message: 'Run npm test',
    unread: true,
  });
  const seen = markAgentNotificationSeen(received, 4);
  assert.equal(seen, received);
  assert.equal(seen[4].waiting, true);
  assert.equal(seen[4].unread, false);
  assert.equal(seen[4].title, 'Approval required: Bash');
  assert.equal(seen[4].message, 'Run npm test');
  assert.deepEqual(summarizeTerminalAttention(seen), { p2: { waiting: 1, unread: 0, failed: 0 } });
  assert.equal(setTerminalWaiting(seen, {
    tabId: 4, projectId: 'p2', waiting: false, cause: 'output',
  }), seen);
  assert.deepEqual(setTerminalWaiting(seen, {
    tabId: 4, projectId: 'p2', waiting: false, cause: 'input',
  }), {});
});

test('keeps waiting through non-input lifecycle events and clears it for explicit user input', async () => {
  const { receiveAgentNotification } = await loadState();
  const waiting = receiveAgentNotification({}, {
    tabId: 8,
    projectId: 'p6',
    kind: 'needs_attention',
    eventType: 'waiting_for_user',
    source: 'devin',
    unread: true,
  });

  const stillWaiting = receiveAgentNotification(waiting, {
    tabId: 8,
    projectId: 'p6',
    kind: 'turn_started',
    eventType: 'working',
    source: 'devin',
    unread: true,
  });
  assert.equal(stillWaiting, waiting);
  assert.equal(stillWaiting[8].waiting, true);

  const stillWaitingAfterCompletion = receiveAgentNotification(stillWaiting, {
    tabId: 8,
    projectId: 'p6',
    kind: 'turn_completed',
    eventType: 'finished',
    source: 'devin',
    unread: true,
  });
  assert.equal(stillWaitingAfterCompletion, waiting);
  assert.equal(stillWaitingAfterCompletion[8].waiting, true);

  assert.deepEqual(receiveAgentNotification(stillWaitingAfterCompletion, {
    tabId: 8,
    projectId: 'p6',
    kind: 'turn_started',
    eventType: 'UserPromptSubmit',
    source: 'devin',
    unread: true,
  }), {});
});

test('does not treat xterm protocol data as user input', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const onData = renderer.match(/terminal\.onData\(\(data\) => \{([\s\S]*?)\n  \}\);/);
  assert.ok(onData, 'terminal onData handler must exist');
  assert.doesNotMatch(onData[1], /terminal_set_waiting|clearTerminalWaitingForUserInput/);
  assert.match(renderer, /terminal\.onKey\([\s\S]*?clearTerminalWaitingForUserInput\(tabId\)/);
  assert.match(renderer, /addEventListener\('paste', \(\) => clearTerminalWaitingForUserInput\(tabId\)/);
});

test('PTY-heuristic waiting survives output (e.g. tab-switch resize redraw)', async () => {
  const { setTerminalWaiting, markAgentNotificationSeen } = await loadState();
  // detectWaiting sets waiting with source 'pty' (no hook configured).
  const waiting = setTerminalWaiting({}, {
    tabId: 7, projectId: 'p5', waiting: true, cause: 'output',
  });
  assert.equal(waiting[7].waiting, true);
  assert.equal(waiting[7].source, 'pty');
  // User opens the tab — only unread clears, waiting stays.
  const seen = markAgentNotificationSeen(waiting, 7);
  assert.equal(seen[7].waiting, true);
  assert.equal(seen[7].unread, false);
  // TUI redraw from resize sends output that detectWaiting doesn't match.
  // waiting must NOT be cleared by output.
  assert.equal(setTerminalWaiting(seen, {
    tabId: 7, projectId: 'p5', waiting: false, cause: 'output',
  }), seen);
  // User input clears it.
  assert.deepEqual(setTerminalWaiting(seen, {
    tabId: 7, projectId: 'p5', waiting: false, cause: 'input',
  }), {});
});

test('active completion does not leave an unread record', async () => {
  const { receiveAgentNotification } = await loadState();
  assert.deepEqual(receiveAgentNotification({}, {
    tabId: 5,
    projectId: 'p3',
    kind: 'turn_completed',
    eventType: 'agent-turn-complete',
    source: 'codex',
    unread: false,
  }), {});
});

test('turn start clears stale attention and failure is summarized separately', async () => {
  const { receiveAgentNotification, summarizeTerminalAttention } = await loadState();
  const failed = receiveAgentNotification({}, {
    tabId: 6,
    projectId: 'p4',
    kind: 'turn_failed',
    eventType: 'error',
    source: 'devin',
    sessionId: 'devin-123',
    unread: true,
  });
  assert.deepEqual(summarizeTerminalAttention(failed), { p4: { waiting: 0, unread: 1, failed: 1 } });
  assert.deepEqual(receiveAgentNotification(failed, {
    tabId: 6,
    projectId: 'p4',
    kind: 'turn_started',
    eventType: 'working',
    source: 'devin',
    sessionId: 'devin-123',
    unread: true,
  }), {});
});

// ============================================================
// Session resume (previous-session restore on tab open)
// ============================================================

const { buildResumeArgs } = require('../src/main/resume-args.cjs');

test('buildResumeArgs picks per-agent flags and prefers a tracked session id', () => {
  assert.deepEqual(buildResumeArgs('claude', 'abc'), ['--resume', 'abc']);
  assert.deepEqual(buildResumeArgs('claude', null), ['--continue']);
  assert.deepEqual(buildResumeArgs('codex', 's_1'), ['resume', 's_1']);
  assert.deepEqual(buildResumeArgs('codex', null), ['resume', '--last']);
  assert.deepEqual(buildResumeArgs('opencode', 'ses_x'), ['-s', 'ses_x']);
  assert.deepEqual(buildResumeArgs('opencode', null), ['--continue']);
  // Devin is cloud-based — no local resume surface.
  assert.equal(buildResumeArgs('devin', 'x'), null);
  assert.equal(buildResumeArgs('pwsh.exe', null), null);
  // .exe suffix normalized.
  assert.deepEqual(buildResumeArgs('Claude.exe', 'abc'), ['--resume', 'abc']);
});

test('hook payloads expose session_id for resume tracking and routing', () => {
  const notification = normalizeAgentNotification({
    hook_event_type: 'Stop',
    session_id: 'sess-abc',
    cwd: 'D:\\work\\app',
  });
  assert.equal(notification.sessionId, 'sess-abc');
  assert.equal(normalizeAgentNotification({ type: 'stop' }).sessionId, null);
  // OpenCode plugin payload shape (sessionId key).
  assert.equal(normalizeAgentNotification({ type: 'stop', sessionId: 'ses_1' }).sessionId, 'ses_1');
});

test('renderer tracks last sessions and prompts only for supported agents', () => {
  const renderer = require('fs').readFileSync(require('path').join(__dirname, '..', 'renderer.js'), 'utf-8');
  assert.match(renderer, /pm-last-agent-sessions/);
  assert.match(renderer, /rememberAgentSession\(t\.projectId, t\.command, sessionId\)/);
  // The prompt only fires for explicit menu-created terminals.
  assert.match(renderer, /resumePrompt: true/);
  const detect = renderer.match(/if \(resumePrompt && !effectiveResumeId && !resumeSkip && RESUME_SUPPORTED\.has\(cmd\)\)/);
  assert.ok(detect);
});

test('main process prepends resume args and passes them through pty:create', () => {
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf-8');
  assert.match(main, /buildResumeArgs\(command, resumeSessionId\)/);
  assert.match(main, /\[\.\.\.resumeArgs, \.\.\.requestedArgs\]/);
});

// ============================================================
// OpenCode notification bridge (plugin -> /hook)
// ============================================================

test('opencode payloads map onto the canonical lifecycle kinds', () => {
  // session.status idle -> stop -> turn_completed (white unread badge)
  const completed = normalizeAgentNotification({ type: 'stop', agent_source: 'opencode', pty_id: 12, cwd: 'D:\\work\\app' });
  assert.equal(completed.kind, 'turn_completed');
  assert.equal(completed.source, 'opencode');
  assert.equal(completed.ptyId, 12);

  // permission.asked -> permissionrequest -> needs_attention / approval (amber)
  const approval = normalizeAgentNotification({
    type: 'permissionrequest',
    agent_source: 'opencode',
    tool_name: 'bash',
    message: 'rm -rf dist',
  });
  assert.equal(approval.kind, 'needs_attention');
  assert.equal(approval.reason, 'approval');
  assert.equal(approval.title, null);
  assert.equal(approval.message, 'rm -rf dist');

  // question.asked -> notification -> needs_attention / input
  const question = normalizeAgentNotification({ type: 'notification', agent_source: 'opencode' });
  assert.equal(question.kind, 'needs_attention');
  assert.equal(question.reason, 'input');

  // session.error -> stopfailure -> turn_failed
  assert.equal(normalizeAgentNotification({ type: 'stopfailure', agent_source: 'opencode' }).kind, 'turn_failed');
});

test('opencode plugin source is self-contained ESM with no local imports', () => {
  const { PLUGIN_SOURCE } = require('../src/main/opencode-plugin-source.cjs');
  // No relative imports: OpenCode requires plugins to be self-contained.
  assert.doesNotMatch(PLUGIN_SOURCE, /from\s+['"]\.\.?\/|require\(['"]\.\.?\//);
  // Subscribes via the `event` hook and switches on bus event types —
  // top-level "session.idle" style handlers would be dead code.
  assert.match(PLUGIN_SOURCE, /export const ProjectMixerPlugin/);
  assert.match(PLUGIN_SOURCE, /event:\s*async \(\{ event \}\)/);
  assert.match(PLUGIN_SOURCE, /session\.status/);
  assert.match(PLUGIN_SOURCE, /permission\.asked/);
  assert.match(PLUGIN_SOURCE, /question\.asked/);
  // Endpoint comes from the PTY env; without it the plugin is inert.
  assert.match(PLUGIN_SOURCE, /process\.env\.PM_HOOK_URL/);
  assert.match(PLUGIN_SOURCE, /PROJECT_MIXER_PTY_ID/);
});

test('main process injects PM_HOOK_URL into the PTY env and installs the plugin in hook:setup', () => {
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf-8');
  // PTY env carries the /hook endpoint so the plugin can post lifecycle events.
  assert.match(main, /PM_HOOK_URL: `http:\/\/127\.0\.0\.1:\$\{HOOK_PORT\}\/hook`/);
  // hook:setup writes the bridge into the project's OpenCode plugin dir.
  assert.match(main, /OPENCODE_PLUGIN_SOURCE/);
  assert.match(main, /\.opencode', 'plugins'\)/);
  assert.match(main, /project-mixer\.js/);

  // The screen-scrape heuristic must NOT include opencode: real events now
  // drive waiting/completion, and scraping caused false amber dots.
  const renderer = require('fs').readFileSync(require('path').join(__dirname, '..', 'renderer.js'), 'utf-8');
  const detect = renderer.match(/function detectWaiting\(command, data\) \{[\s\S]*?\n\}/)[0];
  assert.match(detect, /command === 'claude' \|\| command === 'codex'/);
  assert.doesNotMatch(detect, /=== 'opencode'/);
});
