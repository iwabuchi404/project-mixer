// Attach to a running Electron instance started with --remote-debugging-port.
// This is an opt-in visual smoke check, not part of `npm test`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const port = Number(process.argv[2] || 9235);

async function connect() {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const target = targets.find((item) => item.type === 'page' && item.url.endsWith('/index.html'));
  assert.ok(target, `Project Mixer page was not found on port ${port}`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
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

  return { socket, call };
}

async function main() {
  const { socket, call } = await connect();
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 750));
  await evaluate(`new Promise((resolve) => {
    if (document.readyState === 'complete') resolve();
    else addEventListener('load', resolve, { once: true });
  })`);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const baseline = await evaluate(`(() => {
    const rect = (id) => {
      const value = document.getElementById(id).getBoundingClientRect();
      return { width: value.width, height: value.height };
    };
    const style = getComputedStyle(document.documentElement);
    return {
      title: document.title,
      webviews: document.querySelectorAll('webview').length,
      mainSurface: document.getElementById('main-surface').dataset.surface || 'terminal',
      main: rect('main-surface'),
      composer: rect('editor-pane'),
      preview: rect('preview-webview'),
      palette: ['--g-0', '--g-6', '--attn', '--act', '--err', '--ok'].map((name) => style.getPropertyValue(name).trim()),
    };
  })()`);
  assert.equal(baseline.title, 'Project Mixer');
  assert.equal(baseline.webviews, 1);
  assert.ok(baseline.main.width > 0 && baseline.main.height > 0);
  assert.ok(baseline.composer.height >= 100 && baseline.composer.height < 200);
  assert.ok(baseline.preview.width > 0 && baseline.preview.height > 0, 'hidden webview must keep non-zero geometry');
  assert.deepEqual(baseline.palette, ['#16181c', '#f0f2f5', '#c08b4d', '#4d8480', '#b56b66', '#5f9278']);

  const composerFocused = await evaluate(`(() => {
    const input = document.getElementById('editor-textarea');
    input.focus();
    return new Promise((resolve) => requestAnimationFrame(() => resolve({
      height: document.getElementById('editor-pane').getBoundingClientRect().height,
      surface: document.getElementById('main-surface').dataset.surface,
      focused: document.activeElement === input,
    })));
  })()`);
  assert.equal(composerFocused.focused, true);
  assert.ok(composerFocused.height >= 200, 'composer should expand on focus');
  assert.equal(composerFocused.surface, baseline.mainSurface, 'composer focus must not replace the main view');

  const collapse = await evaluate(`(() => {
    document.getElementById('sidebar-collapse-btn').click();
    return {
      collapsed: document.getElementById('sidebar').classList.contains('collapsed'),
      restoreVisible: !document.getElementById('sidebar-restore-bar').classList.contains('hidden'),
    };
  })()`);
  assert.deepEqual(collapse, { collapsed: true, restoreVisible: true });
  await evaluate(`document.getElementById('sidebar-restore-btn').click()`);

  const workbench = await evaluate(`(async () => {
    await window.__pmDispatch('open_browser', { url: 'http://127.0.0.1:65534' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const browserTab = document.querySelector('.browser-tab');
    const browserSource = document.getElementById('preview-webview').src;
    await window.__pmDispatch('close_tab', { filePath: browserTab.dataset.path });

    const terminalId = await window.__pmDispatch('create_terminal', {
      command: 'pwsh.exe',
      cwd: 'D:\\\\work\\\\project-mixer',
      projectId: null,
      label: 'Phase 4 check',
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const terminalSurface = document.getElementById('main-surface').dataset.surface;

    await window.__pmDispatch('open_file', {
      path: 'D:\\\\work\\\\project-mixer\\\\renderer.js',
      name: 'renderer.js',
    });
    const fileSurface = document.getElementById('main-surface').dataset.surface;
    document.getElementById('editor-textarea').focus();
    await window.__pmDispatch('close_tab', { filePath: 'D:\\\\work\\\\project-mixer\\\\renderer.js' });
    const surfaceAfterFocusedFileClose = document.getElementById('main-surface').dataset.surface;
    await window.__pmDispatch('open_file', {
      path: 'D:\\\\work\\\\project-mixer\\\\renderer.js',
      name: 'renderer.js',
    });

    await window.__pmDispatch('open_preview', {
      path: 'D:\\\\work\\\\project-mixer\\\\docs\\\\PHASE_4_PLAN.md',
      name: 'PHASE_4_PLAN.md',
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const preview = document.getElementById('preview-webview');
    preview.dataset.phase4Reuse = 'yes';
    const previewSurface = document.getElementById('main-surface').dataset.surface;
    const previewLoaded = preview.src.startsWith('data:text/html');

    document.getElementById('editor-textarea').focus();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const surfaceWhileComposing = document.getElementById('main-surface').dataset.surface;
    const composerHeight = document.getElementById('editor-pane').getBoundingClientRect().height;

    const mainTabs = [...document.querySelectorAll('#main-tab-bar .main-tab')].map((tab) => ({
      label: tab.querySelector('.tab-label, .editor-tab-name')?.textContent,
      active: tab.classList.contains('active'),
    }));
    return {
      terminalId,
      browserOpened: Boolean(browserTab) && browserSource === 'http://127.0.0.1:65534/',
      terminalSurface,
      fileSurface,
      surfaceAfterFocusedFileClose,
      previewSurface,
      surfaceWhileComposing,
      composerHeight,
      previewLoaded,
      mainTabs,
      webviewReused: preview.dataset.phase4Reuse === 'yes',
    };
  })()`);
  assert.equal(workbench.browserOpened, true);
  assert.equal(workbench.terminalSurface, 'terminal');
  assert.equal(workbench.fileSurface, 'file');
  assert.equal(workbench.surfaceAfterFocusedFileClose, 'terminal');
  assert.equal(workbench.previewSurface, 'preview');
  assert.equal(workbench.surfaceWhileComposing, 'preview');
  assert.ok(workbench.composerHeight >= 200);
  assert.equal(workbench.previewLoaded, true);
  assert.equal(workbench.webviewReused, true);
  assert.deepEqual(workbench.mainTabs.map((tab) => tab.label), ['Phase 4 check', 'renderer.js', 'PHASE_4_PLAN.md']);
  assert.equal(workbench.mainTabs.filter((tab) => tab.active).length, 1);

  const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const output = path.join(os.tmpdir(), 'project-mixer-phase4.png');
  fs.writeFileSync(output, Buffer.from(shot.data, 'base64'));

  await evaluate(`(async () => {
    await window.__pmDispatch('close_tab', { filePath: 'D:\\\\work\\\\project-mixer\\\\renderer.js' });
    const preview = [...document.querySelectorAll('.preview-tab')].find((tab) => tab.title === 'D:\\\\work\\\\project-mixer\\\\docs\\\\PHASE_4_PLAN.md');
    if (preview) await window.__pmDispatch('close_tab', { filePath: preview.dataset.path });
    await window.__pmDispatch('close_terminal', { tabId: ${workbench.terminalId} });
  })()`);

  socket.close();
  console.log(JSON.stringify({ baseline, composerFocused, collapse, workbench, screenshot: output }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
