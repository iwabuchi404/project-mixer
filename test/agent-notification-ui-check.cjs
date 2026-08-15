// Attach to a running Electron dev instance and verify real hook delivery.
// Usage: node test/agent-notification-ui-check.cjs <debug-port> <hook-port>
const assert = require('node:assert/strict');

const debugPort = Number(process.argv[2] || 9238);
const hookPort = Number(process.argv[3] || 47842);

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
  await call('Page.bringToFront');
  await call('Page.setWebLifecycleState', { state: 'active' });
  return { socket, evaluate };
}

async function main() {
  const { socket, evaluate } = await connect();
  try {
    const target = await evaluate(`(async () => {
      let project = document.querySelector('.project-item.active') || document.querySelector('.project-item');
      if (!project) {
        document.getElementById('add-project-btn').click();
        document.getElementById('project-name-input').value = 'Agent notification check';
        document.getElementById('project-path-input').value = 'D:\\\\work\\\\project-mixer';
        document.getElementById('project-confirm-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 250));
        project = document.querySelector('.project-item.active') || document.querySelector('.project-item');
      }
      if (!project) return {
        error: 'project unavailable',
        dispatch: typeof window.__pmDispatch,
        addButton: Boolean(document.getElementById('add-project-btn')),
        modalHidden: document.getElementById('add-project-modal')?.classList.contains('hidden'),
      };
      project.click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      let terminalTab = document.querySelector('.tab.main-tab');
      let createError = null;
      if (!terminalTab) {
        try {
          await Promise.race([
            window.__pmDispatch('create_terminal', {
              command: 'pwsh.exe',
              cwd: 'D:\\\\work\\\\project-mixer',
              projectId: project.dataset.projectId,
              label: 'Notification check',
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('create terminal timed out')), 2000)),
          ]);
        } catch (error) {
          createError = error.message;
        }
        terminalTab = document.querySelector('.tab.main-tab');
      }
      if (!terminalTab) return { error: createError || 'terminal unavailable' };
      window.__pmDispatch('open_file', {
        path: 'D:\\\\work\\\\project-mixer\\\\renderer.js',
        name: 'renderer.js',
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { ptyId: Number(terminalTab.dataset.ptyId), tabId: terminalTab.dataset.id };
    })()`);
    assert.ok(target?.ptyId, `An active project and terminal are required: ${JSON.stringify(target)}`);

    const response = await fetch(`http://127.0.0.1:${hookPort}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_type: 'Stop', pty_id: target.ptyId }),
    });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const beforeSeen = await evaluate(`(() => {
      const tab = document.querySelector('.tab.main-tab[data-id="${target.tabId}"]');
      return {
        tabStatus: tab.querySelector('.tab-status').className,
        projectStatus: document.querySelector('.project-item.active .project-status')?.className || '',
      };
    })()`);
    assert.match(beforeSeen.tabStatus, /notified/);
    assert.match(beforeSeen.projectStatus, /notified/);

    const afterSeen = await evaluate(`(() => {
      const tab = document.querySelector('.tab.main-tab[data-id="${target.tabId}"]');
      tab.click();
      return {
        tabStatus: tab.querySelector('.tab-status').className,
        projectStatus: document.querySelector('.project-item.active .project-status')?.className || '',
      };
    })()`);
    assert.match(afterSeen.tabStatus, /idle/);
    assert.match(afterSeen.projectStatus, /idle/);
    console.log('[agent-notification-ui-check] hook delivery, unread badge, and seen transition passed');
  } finally {
    socket.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
