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
