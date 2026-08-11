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
  await evaluate(`localStorage.removeItem('pm-scratch-expanded-height'); localStorage.removeItem('pm-collapse');`);
  await call('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 750));
  await evaluate(`new Promise((resolve) => {
    if (document.readyState === 'complete') resolve();
    else addEventListener('load', resolve, { once: true });
  })`);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const baseline = await evaluate(`(() => {
    const editorPane = document.getElementById('editor-pane');
    if (editorPane.classList.contains('collapsed')) document.getElementById('scratch-collapse-btn').click();
    const rect = (id) => {
      const value = document.getElementById(id).getBoundingClientRect();
      return { width: value.width, height: value.height };
    };
    const style = getComputedStyle(document.documentElement);
    const tabBar = document.getElementById('main-tab-bar');
    const menuButton = document.getElementById('app-menu-btn');
    const projectHeader = document.getElementById('sidebar-header');
    const fileHeader = document.getElementById('file-tree-header');
    const splitterStyle = getComputedStyle(document.getElementById('splitter'), '::before');
    const horizontalStyle = getComputedStyle(document.getElementById('vsplitter-1'), '::before');
    const verticalStyle = getComputedStyle(document.getElementById('vsplitter-2'), '::before');
    return {
      title: document.title,
      webviews: document.querySelectorAll('webview').length,
      mainSurface: document.getElementById('main-surface').dataset.surface || 'terminal',
      main: rect('main-surface'),
      composer: rect('editor-pane'),
      preview: rect('preview-webview'),
      menuButton: rect('app-menu-btn'),
      layout: {
        appGap: getComputedStyle(document.getElementById('app')).gap,
        tabGap: getComputedStyle(tabBar).gap,
        tabBarTop: tabBar.getBoundingClientRect().top,
        tabBarHeight: tabBar.getBoundingClientRect().height,
        projectHeaderTop: projectHeader.getBoundingClientRect().top,
        projectHeaderHeight: projectHeader.getBoundingClientRect().height,
        fileHeaderTop: fileHeader.getBoundingClientRect().top,
        fileHeaderHeight: fileHeader.getBoundingClientRect().height,
        navigationWidth: document.getElementById('navigation-pane').getBoundingClientRect().width,
        projectHeight: document.getElementById('sidebar').getBoundingClientRect().height,
        fileTreeHeight: document.getElementById('file-tree-pane').getBoundingClientRect().height,
        navigationSplitterHeight: document.getElementById('vsplitter-1').getBoundingClientRect().height,
        verticalSplitterWidth: document.getElementById('vsplitter-2').getBoundingClientRect().width,
        scratchSplitterHeight: document.getElementById('splitter').getBoundingClientRect().height,
        verticalHitLeft: verticalStyle.left,
        navigationHitTop: horizontalStyle.top,
        scratchHitTop: splitterStyle.top,
      },
      palette: ['--g-0', '--g-6', '--attn', '--act', '--err', '--ok'].map((name) => style.getPropertyValue(name).trim()),
      hostScrollbarSize: getComputedStyle(document.getElementById('file-tree'), '::-webkit-scrollbar').width,
      hostScrollbarThumb: getComputedStyle(document.getElementById('file-tree'), '::-webkit-scrollbar-thumb').backgroundColor,
      edgeStyle: {
        projectHeaderBorder: getComputedStyle(projectHeader).borderBottomWidth,
        fileHeaderBorder: getComputedStyle(fileHeader).borderBottomWidth,
        projectListShadow: getComputedStyle(document.getElementById('project-list')).boxShadow,
        fileTreeShadow: getComputedStyle(document.getElementById('file-tree')).boxShadow,
        previewRightGap: getComputedStyle(document.getElementById('preview-content')).paddingRight,
        fileEditorRightGap: getComputedStyle(document.getElementById('file-editor-pane')).paddingRight,
        scratchRightGap: getComputedStyle(document.getElementById('editor-content')).paddingRight,
        menuAppRegion: getComputedStyle(menuButton).webkitAppRegion,
      },
    };
  })()`);
  assert.equal(baseline.title, 'Project Mixer');
  assert.equal(baseline.webviews, 1);
  assert.ok(baseline.main.width > 0 && baseline.main.height > 0);
  assert.ok(baseline.composer.height >= 100 && baseline.composer.height < 200);
  assert.ok(baseline.preview.width > 0 && baseline.preview.height > 0, 'hidden webview must keep non-zero geometry');
  assert.deepEqual(baseline.palette, ['#16181c', '#c8ccd4', '#c08b4d', '#5b9691', '#b56b66', '#5f9278']);
  assert.equal(baseline.hostScrollbarSize, '12px');
  assert.equal(baseline.hostScrollbarThumb, 'rgb(46, 51, 59)');
  assert.deepEqual(baseline.menuButton, { width: 24, height: 24 });
  assert.equal(baseline.edgeStyle.projectHeaderBorder, '1px');
  assert.equal(baseline.edgeStyle.fileHeaderBorder, '1px');
  assert.notEqual(baseline.edgeStyle.projectListShadow, 'none');
  assert.notEqual(baseline.edgeStyle.fileTreeShadow, 'none');
  assert.equal(baseline.edgeStyle.previewRightGap, '4px');
  assert.equal(baseline.edgeStyle.fileEditorRightGap, '4px');
  assert.equal(baseline.edgeStyle.scratchRightGap, '4px');
  assert.equal(baseline.edgeStyle.menuAppRegion, 'no-drag');
  assert.equal(baseline.layout.appGap, '2px');
  assert.equal(baseline.layout.tabGap, '3px');
  assert.equal(baseline.layout.tabBarTop, baseline.layout.projectHeaderTop);
  assert.equal(baseline.layout.tabBarHeight, baseline.layout.projectHeaderHeight);
  assert.equal(baseline.layout.tabBarHeight, baseline.layout.fileHeaderHeight);
  assert.ok(baseline.layout.fileHeaderTop > baseline.layout.projectHeaderTop);
  assert.ok(baseline.layout.navigationWidth >= 180);
  assert.ok(baseline.layout.projectHeight >= 100);
  assert.ok(baseline.layout.fileTreeHeight >= 120);
  assert.equal(baseline.layout.navigationSplitterHeight, 2);
  assert.equal(baseline.layout.verticalSplitterWidth, 2);
  assert.equal(baseline.layout.scratchSplitterHeight, 2);
  assert.equal(baseline.layout.verticalHitLeft, '-4px');
  assert.equal(baseline.layout.navigationHitTop, '-4px');
  assert.equal(baseline.layout.scratchHitTop, '-4px');
  console.log('[ui-check] baseline');

  const composerFocused = await evaluate(`(() => {
    const input = document.getElementById('editor-textarea');
    document.getElementById('new-tab-btn').focus();
    input.focus();
    return new Promise((resolve) => setTimeout(() => resolve({
      height: document.getElementById('editor-pane').getBoundingClientRect().height,
      surface: document.getElementById('main-surface').dataset.surface,
      focused: document.activeElement === input,
    }), 20));
  })()`);
  assert.equal(composerFocused.focused, true);
  assert.ok(composerFocused.height > baseline.composer.height, `composer should expand on focus: ${JSON.stringify(composerFocused)}`);
  assert.equal(composerFocused.surface, baseline.mainSurface, 'composer focus must not replace the main view');
  console.log('[ui-check] composer focus');

  const scratchResize = await evaluate(`(async () => {
    const pane = document.getElementById('editor-pane');
    const input = document.getElementById('editor-textarea');
    const handle = document.getElementById('splitter');
    input.focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = pane.getBoundingClientRect().height;
    const y = handle.getBoundingClientRect().top;
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: y }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: y - 36 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientY: y - 36 }));
    const resized = pane.getBoundingClientRect().height;
    document.getElementById('new-tab-btn').focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const compact = pane.getBoundingClientRect().height;
    input.focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const restored = pane.getBoundingClientRect().height;
    return { before, resized, compact, restored };
  })()`);
  assert.ok(scratchResize.resized >= scratchResize.before + 30);
  assert.equal(scratchResize.compact, 112);
  assert.equal(scratchResize.restored, scratchResize.resized);
  console.log('[ui-check] scratch resize');

  const navigationResize = await evaluate(`(() => {
    const navigation = document.getElementById('navigation-pane');
    const projects = document.getElementById('sidebar');
    const rowHandle = document.getElementById('vsplitter-1');
    const columnHandle = document.getElementById('vsplitter-2');
    const before = { width: navigation.offsetWidth, projectHeight: projects.offsetHeight };
    const rowY = rowHandle.getBoundingClientRect().top;
    rowHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: rowY }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: rowY + 32 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientY: rowY + 32 }));
    const columnX = columnHandle.getBoundingClientRect().left;
    columnHandle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: columnX }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: columnX + 32 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: columnX + 32 }));
    return {
      before,
      width: navigation.offsetWidth,
      projectHeight: projects.offsetHeight,
      fileTreeHeight: document.getElementById('file-tree-pane').offsetHeight,
    };
  })()`);
  assert.ok(navigationResize.width >= navigationResize.before.width + 30);
  assert.ok(navigationResize.projectHeight >= navigationResize.before.projectHeight + 30);
  assert.ok(navigationResize.fileTreeHeight >= 120);
  console.log('[ui-check] navigation resize');

  const scratchToggle = await evaluate(`(() => {
    const button = document.getElementById('scratch-collapse-btn');
    button.click();
    const collapsedHeight = document.getElementById('editor-pane').getBoundingClientRect().height;
    const collapsed = document.getElementById('editor-pane').classList.contains('collapsed');
    button.click();
    return { collapsed, collapsedHeight, expanded: button.getAttribute('aria-expanded') };
  })()`);
  assert.equal(scratchToggle.collapsed, true);
  assert.ok(scratchToggle.collapsedHeight <= 36);
  assert.equal(scratchToggle.expanded, 'true');
  console.log('[ui-check] scratch toggle');

  const tree = await evaluate(`(async () => {
    let createdProject = false;
    if (!document.querySelector('.project-item')) {
      document.getElementById('add-project-btn').click();
      document.getElementById('project-name-input').value = 'Phase 4 UI check';
      document.getElementById('project-path-input').value = 'D:\\\\work\\\\project-mixer';
      document.getElementById('project-confirm-btn').click();
      await new Promise((resolve) => setTimeout(resolve, 250));
      createdProject = true;
    }
    const project = [...document.querySelectorAll('.project-item')]
      .find((item) => /[\\\\/]project-mixer$/i.test(item.title));
    if (project?.querySelector('.project-name')?.textContent === 'Phase 4 UI check') createdProject = true;
    if (project) await window.__pmDispatch('select_project', { projectId: project.dataset.projectId });
    const folder = document.querySelector('.tree-item[aria-expanded]');
    if (!folder) return {
      missing: true,
      projects: [...document.querySelectorAll('.project-item')].map((item) => item.title),
      treeItems: [...document.querySelectorAll('.tree-item')].map((item) => item.title),
    };
    folder.click();
    const focusedAfterClick = document.activeElement === folder;
    document.getElementById('tree-new-file-btn').click();
    const createLabel = document.getElementById('prompt-label').textContent;
    document.getElementById('prompt-cancel-btn').click();
    folder.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }));
    const explorerVisible = !document.querySelector('[data-action="open-explorer"]').classList.contains('hidden');
    document.body.click();
    return {
      selected: folder.getAttribute('aria-selected'),
      focused: focusedAfterClick,
      createLabel,
      folderPath: folder.title,
      projectId: project?.dataset.projectId || null,
      createdProject,
      explorerVisible,
      svgIcons: document.querySelectorAll('.tree-icon svg').length,
      emojiIcons: [...document.querySelectorAll('.tree-icon')].filter((icon) => /[📁📄]/u.test(icon.textContent)).length,
    };
  })()`);
  assert.equal(tree.missing, undefined, `the active project should expose at least one folder: ${JSON.stringify(tree)}`);
  assert.equal(tree.selected, 'true');
  assert.equal(tree.focused, true);
  assert.equal(tree.createLabel, `Create in: ${tree.folderPath}`);
  assert.equal(tree.explorerVisible, true);
  assert.ok(tree.svgIcons > 0);
  assert.equal(tree.emojiIcons, 0);
  console.log('[ui-check] tree');

  const collapse = await evaluate(`(() => {
    document.getElementById('sidebar-collapse-btn').click();
    return {
      collapsed: document.getElementById('sidebar').classList.contains('collapsed'),
      restoreVisible: !document.getElementById('sidebar-restore-bar').classList.contains('hidden'),
    };
  })()`);
  assert.deepEqual(collapse, { collapsed: true, restoreVisible: true });
  await evaluate(`document.getElementById('sidebar-restore-btn').click()`);
  console.log('[ui-check] sidebar collapse');

  console.log('[ui-check] workbench start');
  const workbench = await evaluate(`(async () => {
    for (const tab of [...document.querySelectorAll('#main-tab-bar .tab')]) {
      if (tab.querySelector('.tab-label')?.textContent === 'Phase 4 check') {
        await window.__pmDispatch('close_terminal', { tabId: Number(tab.dataset.id) });
      }
    }
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
    const planPreviewPath = document.querySelector('.preview-tab.active').dataset.path;
    const planScroll = await preview.executeJavaScript("(() => { const root = document.scrollingElement || document.documentElement; root.scrollTop = Math.min(360, root.scrollHeight - root.clientHeight); return { y: root.scrollTop, max: root.scrollHeight - root.clientHeight, scrollbarSize: getComputedStyle(root, '::-webkit-scrollbar').width, scrollbarThumb: getComputedStyle(root, '::-webkit-scrollbar-thumb').backgroundColor, fontFamily: getComputedStyle(document.body).fontFamily }; })()");
    await window.__pmDispatch('open_preview', {
      path: 'D:\\\\work\\\\project-mixer\\\\renderer.js',
      name: 'renderer.js',
    });
    const codePreviewPath = document.querySelector('.preview-tab.active').dataset.path;
    const codeScroll = await preview.executeJavaScript("(() => { const root = document.scrollingElement || document.documentElement; root.scrollTop = Math.min(640, root.scrollHeight - root.clientHeight); return { y: root.scrollTop, max: root.scrollHeight - root.clientHeight }; })()");
    await window.__pmDispatch('switch_tab', { filePath: planPreviewPath });
    const restoredPlanScroll = await preview.executeJavaScript("(document.scrollingElement || document.documentElement).scrollTop");
    await window.__pmDispatch('switch_tab', { filePath: codePreviewPath });
    const restoredCodeScroll = await preview.executeJavaScript("(document.scrollingElement || document.documentElement).scrollTop");
    await window.__pmDispatch('close_tab', { filePath: codePreviewPath });
    await window.__pmDispatch('switch_tab', { filePath: planPreviewPath });

    document.getElementById('editor-textarea').focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const surfaceWhileComposing = document.getElementById('main-surface').dataset.surface;
    const composerHeight = document.getElementById('editor-pane').getBoundingClientRect().height;

    const mainTabs = [...document.querySelectorAll('#main-tab-bar .main-tab')].map((tab) => ({
      label: tab.querySelector('.tab-label, .editor-tab-name')?.textContent,
      active: tab.classList.contains('active'),
      background: getComputedStyle(tab).backgroundColor,
      boxShadow: getComputedStyle(tab).boxShadow,
      fontWeight: getComputedStyle(tab).fontWeight,
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
      planScroll,
      codeScroll,
      restoredPlanScroll,
      restoredCodeScroll,
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
  assert.ok(workbench.composerHeight > 112, `composer should expand while composing: ${JSON.stringify(workbench)}`);
  assert.equal(workbench.previewLoaded, true);
  console.log('[ui-check] preview scroll', JSON.stringify({
    planScroll: workbench.planScroll,
    codeScroll: workbench.codeScroll,
    restoredPlanScroll: workbench.restoredPlanScroll,
    restoredCodeScroll: workbench.restoredCodeScroll,
  }));
  assert.ok(workbench.planScroll.max > 0);
  assert.ok(workbench.codeScroll.max > 0);
  assert.equal(workbench.restoredPlanScroll, workbench.planScroll.y);
  assert.equal(workbench.restoredCodeScroll, workbench.codeScroll.y);
  assert.equal(workbench.planScroll.scrollbarSize, baseline.hostScrollbarSize);
  assert.equal(workbench.planScroll.scrollbarThumb, baseline.hostScrollbarThumb);
  assert.match(workbench.planScroll.fontFamily, /Cascadia Mono.*BIZ UDGothic.*MS Gothic.*monospace/);
  assert.equal(workbench.webviewReused, true);
  assert.deepEqual(workbench.mainTabs.slice(-3).map((tab) => tab.label), ['Phase 4 check', 'renderer.js', 'PHASE_4_PLAN.md']);
  assert.equal(workbench.mainTabs.filter((tab) => tab.active).length, 1);
  const activeTab = workbench.mainTabs.find((tab) => tab.active);
  const inactiveTab = workbench.mainTabs.find((tab) => !tab.active);
  assert.equal(activeTab.boxShadow, 'none');
  assert.notEqual(activeTab.background, inactiveTab.background);
  assert.ok(Number(activeTab.fontWeight) >= 600);
  console.log('[ui-check] workbench');

  const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const output = path.join(os.tmpdir(), 'project-mixer-phase4.png');
  fs.writeFileSync(output, Buffer.from(shot.data, 'base64'));

  await evaluate(`(async () => {
    await window.__pmDispatch('close_tab', { filePath: 'D:\\\\work\\\\project-mixer\\\\renderer.js' });
    const preview = [...document.querySelectorAll('.preview-tab')].find((tab) => tab.title.endsWith('D:\\\\work\\\\project-mixer\\\\docs\\\\PHASE_4_PLAN.md'));
    if (preview) await window.__pmDispatch('close_tab', { filePath: preview.dataset.path });
    await window.__pmDispatch('close_terminal', { tabId: ${workbench.terminalId} });
    if (${tree.createdProject ? 'true' : 'false'}) {
      await window.__pmDispatch('remove_project', { projectId: ${JSON.stringify(tree.projectId)} });
    }
  })()`);

  socket.close();
  console.log(JSON.stringify({ baseline, composerFocused, collapse, workbench, screenshot: output }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
