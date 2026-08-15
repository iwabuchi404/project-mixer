// Attach to a running Electron dev instance whose PATH resolves the fake
// test/fixtures/devin.cmd, then verify OSC -> attention state -> badges.
// Usage: node test/devin-terminal-notification-ui-check.cjs <debug-port>
'use strict';

const assert = require('node:assert/strict');

const debugPort = Number(process.argv[2] || 9242);

async function connect() {
  const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
  const target = targets.find((item) => item.type === 'page' && item.url.endsWith('/index.html'));
  assert.ok(target, `Project Mixer page was not found on port ${debugPort}`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    if (message.error) operation.reject(new Error(message.error.message));
    else operation.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  return { socket, evaluate, call };
}

async function main() {
  const { socket, evaluate, call } = await connect();
  const projectCwd = JSON.stringify(process.cwd());
  let ids = null;
  try {
    ids = await evaluate(`(async () => {
      const nativeNotificationSupported = typeof window.Notification === 'function';
      window.__pmOsNotifications = [];
      window.Notification = class FakeNotification {
        constructor(title, options) {
          this.title = title;
          this.options = options;
          this.closed = false;
          window.__pmOsNotifications.push(this);
        }
        close() {
          if (this.closed) return;
          this.closed = true;
          if (this.onclose) this.onclose();
        }
      };
      const project = document.querySelector('.project-item.active') || document.querySelector('.project-item');
      if (!project) return { error: 'An existing project is required for this smoke check' };
      project.click();
      const projectId = project.dataset.projectId;
      const devinTabId = await window.__pmDispatch('create_terminal', {
        command: 'devin',
        cwd: ${projectCwd},
        projectId,
        label: 'Devin OSC check',
      });
      const foregroundTabId = await window.__pmDispatch('create_terminal', {
        command: 'pwsh.exe',
        cwd: ${projectCwd},
        projectId,
        label: 'OSC foreground',
      });
      return { projectId, devinTabId, foregroundTabId, nativeNotificationSupported };
    })()`);
    assert.equal(ids.error, undefined, JSON.stringify(ids));
    assert.equal(ids.nativeNotificationSupported, true);

    await new Promise((resolve) => setTimeout(resolve, 1800));
    const waiting = await evaluate(`(() => {
      const tab = document.querySelector('.main-tab[data-id="${ids.devinTabId}"]');
      const project = document.querySelector('.project-item[data-project-id="${ids.projectId}"]');
      return {
        tabStatus: tab?.querySelector('.tab-status')?.className || '',
        projectStatus: project?.querySelector('.project-status')?.className || '',
        title: tab?.querySelector('.tab-status')?.title || '',
      };
    })()`);
    assert.match(waiting.tabStatus, /waiting/);
    assert.match(waiting.projectStatus, /waiting/);
    assert.equal(waiting.title, 'Agent is waiting for input');
    const waitingOsNotification = await evaluate(`(() => {
      const notification = window.__pmOsNotifications.at(-1);
      return notification ? {
        title: notification.title,
        requireInteraction: notification.options.requireInteraction,
        closed: notification.closed,
      } : null;
    })()`);
    assert.match(waitingOsNotification.title, /Devin needs input/);
    assert.equal(waitingOsNotification.requireInteraction, true);
    assert.equal(waitingOsNotification.closed, false);

    await evaluate(`document.querySelector('.main-tab[data-id="${ids.devinTabId}"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const opened = await evaluate(`(() => {
      const tab = document.querySelector('.main-tab[data-id="${ids.devinTabId}"]');
      const project = document.querySelector('.project-item[data-project-id="${ids.projectId}"]');
      return {
        tabStatus: tab?.querySelector('.tab-status')?.className || '',
        projectStatus: project?.querySelector('.project-status')?.className || '',
        title: tab?.querySelector('.tab-status')?.title || '',
      };
    })()`);
    assert.match(opened.tabStatus, /waiting/);
    assert.match(opened.projectStatus, /waiting/);
    assert.equal(opened.title, 'Agent is waiting for input');
    assert.equal(await evaluate('window.__pmOsNotifications.at(-1)?.closed'), false);

    // The fixture emits a delayed completion event. Waiting remains sticky
    // until a real key event is sent to the terminal.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const afterCompletion = await evaluate(`(() => {
      const tab = document.querySelector('.main-tab[data-id="${ids.devinTabId}"]');
      return tab?.querySelector('.tab-status')?.className || '';
    })()`);
    assert.match(afterCompletion, /waiting/);

    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'y',
      code: 'KeyY',
      text: 'y',
      windowsVirtualKeyCode: 89,
    });
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'y',
      code: 'KeyY',
      windowsVirtualKeyCode: 89,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterInput = await evaluate(`(() => {
      const tab = document.querySelector('.main-tab[data-id="${ids.devinTabId}"]');
      return tab?.querySelector('.tab-status')?.className || '';
    })()`);
    assert.match(afterInput, /idle/);
    assert.equal(await evaluate('window.__pmOsNotifications.at(-1)?.closed'), true);

    await evaluate(`window.__pmDispatch('agent_notification_received', {
      tabId: ${ids.devinTabId},
      projectId: ${JSON.stringify(ids.projectId)},
      kind: 'needs_attention',
      eventType: 'Notification',
      source: 'claude',
      reason: 'input',
      title: 'Choice needed',
      message: 'Use API A or API B?',
    })`);
    const detailedOsNotification = await evaluate(`(() => {
      const notification = window.__pmOsNotifications.at(-1);
      return notification ? {
        title: notification.title,
        body: notification.options.body,
        requireInteraction: notification.options.requireInteraction,
      } : null;
    })()`);
    assert.match(detailedOsNotification.title, /Claude needs input/);
    assert.equal(detailedOsNotification.body, 'Choice needed — Use API A or API B?');
    assert.equal(detailedOsNotification.requireInteraction, true);

    console.log('[devin-terminal-notification-ui-check] waiting lifecycle and detailed OS notification passed');
  } finally {
    if (ids?.devinTabId) {
      await evaluate(`window.__pmDispatch('close_terminal', { tabId: ${ids.devinTabId} })`).catch(() => {});
    }
    if (ids?.foregroundTabId) {
      await evaluate(`window.__pmDispatch('close_terminal', { tabId: ${ids.foregroundTabId} })`).catch(() => {});
    }
    socket.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
