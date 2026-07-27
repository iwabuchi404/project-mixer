// ============================================================
// State
// ============================================================

const projects = new Map(); // id -> { id, name, path }
let activeProjectId = null;

const tabs = new Map(); // tabId -> { id, projectId, terminal, fitAddon, ptyId, termEl, tabElement, command, cwd, waiting }
let activeTabId = null;
let tabCounter = 0;
const projectActiveTab = new Map(); // projectId -> last active tabId
let draggedTerminalTab = null;

const COMMANDS = ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'claude', 'codex'];

// ============================================================
// DOM refs
// ============================================================

const projectList = document.getElementById('project-list');
const addProjectBtn = document.getElementById('add-project-btn');
const addProjectModal = document.getElementById('add-project-modal');
const projectNameInput = document.getElementById('project-name-input');
const projectPathInput = document.getElementById('project-path-input');
const projectCancelBtn = document.getElementById('project-cancel-btn');
const projectConfirmBtn = document.getElementById('project-confirm-btn');
const fileTree = document.getElementById('file-tree');
const fileTreeHeader = document.getElementById('file-tree-header');
const tabBar = document.getElementById('tab-bar');
const terminalContainer = document.getElementById('terminal-container');
const newTabBtn = document.getElementById('new-tab-btn');
const memDisplay = document.getElementById('mem-display');
const editorPane = document.getElementById('editor-pane');
const editorTabBar = document.getElementById('editor-tab-bar');
const editorTextarea = document.getElementById('editor-textarea');
const splitter = document.getElementById('splitter');
const contextMenu = document.getElementById('context-menu');
const vsplitter1 = document.getElementById('vsplitter-1');
const vsplitter2 = document.getElementById('vsplitter-2');
const browseFolderBtn = document.getElementById('browse-folder-btn');
const statusLeft = document.getElementById('status-left');
const statusRight = document.getElementById('status-right');
const sendBtn = document.getElementById('send-btn');
const sendTarget = document.getElementById('send-target');
const newScratchTabBtn = document.createElement('button');
newScratchTabBtn.id = 'new-scratch-tab-btn';
newScratchTabBtn.title = 'New scratch buffer';
newScratchTabBtn.textContent = '+';

// ============================================================
// PTY data/exit handlers
// ============================================================

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b[()][AB012]/g, '');
}

const WAITING_PATTERNS = [
  /> \s*$/,                  // generic prompt ending with "> "
  /❯\s*$/,                   // Claude Code prompt
  /\?\s+(Yes|No|y\/n)/i,     // yes/no confirmation
  /Do you want/i,
  /Would you like/i,
  /Allow/i,
  /Proceed\?/i,
  /Press Enter/i,
  /\[y\/N\]/i,
  /\(yes\)/i,
  /\(no\)/i,
  /Enter to continue/i,
];

function detectWaiting(command, data) {
  const isAgent = command === 'claude' || command === 'codex';
  if (!isAgent) return false;
  const stripped = stripAnsi(data);
  const lines = stripped.split(/\r?\n/);
  const lastLine = lines[lines.length - 1].trimEnd();
  if (!lastLine) return false;
  for (const pattern of WAITING_PATTERNS) {
    if (pattern.test(lastLine)) return true;
  }
  return false;
}

window.api.onPtyData(({ id, data }) => {
  for (const [tabId, t] of tabs) {
    if (t.ptyId === id) {
      t.terminal.write(data);
      const wasWaiting = t.waiting;
      t.waiting = detectWaiting(t.command, data);
      if (t.waiting !== wasWaiting) {
        updateTabStatus(tabId);
        updateProjectStatus(t.projectId);
      }
      return;
    }
  }
});

window.api.onPtyExit(({ id, exitCode }) => {
  for (const [tabId, t] of tabs) {
    if (t.ptyId === id) {
      t.terminal.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`);
      t.waiting = false;
      updateTabStatus(tabId);
      updateProjectStatus(t.projectId);
      return;
    }
  }
});

// Hook-based waiting indicator (Claude Code Notification/Stop, Codex notify)
window.api.onHookNotify(({ type, cwd, ptyId, waiting }) => {
  // Match by ptyId (from cwd matching in main process)
  if (ptyId !== null && ptyId !== undefined) {
    for (const [tabId, t] of tabs) {
      if (t.ptyId === ptyId) {
        const wasWaiting = t.waiting;
        t.waiting = waiting;
        if (t.waiting !== wasWaiting) {
          updateTabStatus(tabId);
          updateProjectStatus(t.projectId);
        }
        return;
      }
    }
  }
  // Fallback: match by projectId if cwd doesn't match a specific PTY
  if (activeProjectId) {
    for (const [tabId, t] of tabs) {
      if (t.projectId === activeProjectId && (t.command === 'claude' || t.command === 'codex')) {
        const wasWaiting = t.waiting;
        t.waiting = waiting;
        if (t.waiting !== wasWaiting) {
          updateTabStatus(tabId);
          updateProjectStatus(t.projectId);
        }
      }
    }
  }
});

// ============================================================
// Project management
// ============================================================

async function loadProjects() {
  const list = await window.api.projectList();
  projects.clear();
  for (const p of list) {
    projects.set(p.id, p);
  }
  renderProjectList();
}

function renderProjectList() {
  projectList.innerHTML = '';
  for (const [id, p] of projects) {
    const el = document.createElement('div');
    el.className = 'project-item' + (id === activeProjectId ? ' active' : '');
    el.innerHTML = `
      <span class="project-status idle"></span>
      <span class="project-name">${escapeHtml(p.name)}</span>
      <span class="project-remove" data-id="${id}">×</span>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('project-remove')) {
        removeProject(id);
      } else {
        selectProject(id);
      }
    });
    projectList.appendChild(el);
  }
}

async function selectProject(projectId) {
  activeProjectId = projectId;
  renderProjectList();
  const p = projects.get(projectId);
  if (p) {
    fileTreeHeader.textContent = p.name;
    await loadFileTree(p.path);
    window.api.hookSetup(p.path);
  }
  showProjectTabs(projectId);
}

async function removeProject(projectId) {
  const updated = await window.api.projectRemove(projectId);
  projects.clear();
  for (const p of updated) {
    projects.set(p.id, p);
  }

  // Kill all tabs belonging to the removed project
  const tabsToKill = [];
  for (const [tid, t] of tabs) {
    if (t.projectId === projectId) tabsToKill.push(tid);
  }
  for (const tid of tabsToKill) {
    const t = tabs.get(tid);
    window.api.ptyKill(t.ptyId);
    t.terminal.dispose();
    t.termEl.remove();
    t.tabElement.remove();
    tabs.delete(tid);
  }
  projectActiveTab.delete(projectId);

  if (activeProjectId === projectId) {
    activeProjectId = null;
    activeTabId = null;
    fileTreeHeader.textContent = 'Files';
    fileTree.innerHTML = '';
    updateSendTarget();
  }
  renderProjectList();
  saveLayout();
}

function showAddProjectModal() {
  addProjectModal.classList.remove('hidden');
  projectNameInput.value = '';
  projectPathInput.value = '';
  projectNameInput.focus();
}

function hideAddProjectModal() {
  addProjectModal.classList.add('hidden');
}

addProjectBtn.addEventListener('click', showAddProjectModal);
projectCancelBtn.addEventListener('click', hideAddProjectModal);

browseFolderBtn.addEventListener('click', async () => {
  const folder = await window.api.openFolderDialog();
  if (folder) {
    projectPathInput.value = folder;
    if (!projectNameInput.value.trim()) {
      const basename = folder.split(/[\\/]/).pop();
      projectNameInput.value = basename;
    }
  }
});

projectConfirmBtn.addEventListener('click', async () => {
  const name = projectNameInput.value.trim();
  const projPath = projectPathInput.value.trim();
  if (!name || !projPath) return;
  const updated = await window.api.projectAdd(name, projPath);
  projects.clear();
  for (const p of updated) {
    projects.set(p.id, p);
  }
  renderProjectList();
  hideAddProjectModal();
  selectProject(projects.keys().next().value);
});

projectNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') projectPathInput.focus();
  if (e.key === 'Escape') hideAddProjectModal();
});
projectPathInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') projectConfirmBtn.click();
  if (e.key === 'Escape') hideAddProjectModal();
});

// ============================================================
// File tree
// ============================================================

async function loadFileTree(dirPath) {
  fileTree.innerHTML = '';
  const entries = await window.api.readDir(dirPath);
  for (const entry of entries) {
    fileTree.appendChild(createTreeItem(entry, 0));
  }
}

function createTreeItem(entry, depth) {
  const el = document.createElement('div');
  el.className = 'tree-item';
  el.style.paddingLeft = (12 + depth * 16) + 'px';
  el.innerHTML = `<span class="tree-icon">${entry.isDirectory ? '\u{1F4C1}' : '\u{1F4C4}'}</span><span class="tree-name">${escapeHtml(entry.name)}</span>`;

  el.addEventListener('click', async (e) => {
    if (entry.isDirectory) {
      const expanded = el.dataset.expanded === 'true';
      if (expanded) {
        el.dataset.expanded = 'false';
        const next = el.nextElementSibling;
        if (next && next.classList.contains('tree-children')) next.remove();
      } else {
        el.dataset.expanded = 'true';
        const children = await window.api.readDir(entry.path);
        const container = document.createElement('div');
        container.className = 'tree-children';
        for (const child of children) {
          container.appendChild(createTreeItem(child, depth + 1));
        }
        el.after(container);
      }
    } else {
      appendToScratch(entry.path);
    }
  });

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, entry);
  });

  return el;
}

function insertPathToTerminal(filePath) {
  if (activeTabId === null) return;
  const t = tabs.get(activeTabId);
  if (t) {
    window.api.ptyWrite(t.ptyId, filePath);
  }
}

function insertNameToTerminal(filePath) {
  if (activeTabId === null) return;
  const t = tabs.get(activeTabId);
  if (t) {
    const name = filePath.split(/[\\/]/).pop();
    window.api.ptyWrite(t.ptyId, name);
  }
}

// ============================================================
// Context menu
// ============================================================

let contextMenuEntry = null;

function showContextMenu(x, y, entry) {
  contextMenuEntry = entry;
  contextMenu.classList.remove('hidden');
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
}

function hideContextMenu() {
  contextMenu.classList.add('hidden');
  contextMenuEntry = null;
}

contextMenu.addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action || !contextMenuEntry) return;

  if (action === 'open' && !contextMenuEntry.isDirectory) {
    openFileInEditor(contextMenuEntry.path, contextMenuEntry.name);
  } else if (action === 'insert-path') {
    insertPathToTerminal(contextMenuEntry.path);
  } else if (action === 'insert-name') {
    insertNameToTerminal(contextMenuEntry.path);
  }
  hideContextMenu();
});

document.addEventListener('click', () => hideContextMenu());
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.tree-item')) hideContextMenu();
});

// ============================================================
// Editor management (D8: tabs below terminal, scratch = Composer)
// ============================================================

const SCRATCH_PATH = '__scratch__';
const openFiles = new Map(); // path -> { path, name, content, originalContent, tabEl, isScratch, isTemp }
let activeFilePath = null;
let lastSentContent = '';
let lastSentTabPath = null;
let tempTabCounter = 0;

let draggedEditorTab = null;

function makeEditorTabDraggable(tabEl, path) {
  tabEl.draggable = true;
  tabEl.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', path);
    draggedEditorTab = tabEl;
    tabEl.classList.add('dragging');
  });
  tabEl.addEventListener('dragend', () => {
    tabEl.classList.remove('dragging');
    editorTabBar.querySelectorAll('.editor-tab').forEach(t => t.classList.remove('drag-over'));
    draggedEditorTab = null;
  });
  tabEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  tabEl.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (draggedEditorTab && tabEl !== draggedEditorTab) {
      tabEl.classList.add('drag-over');
    }
  });
  tabEl.addEventListener('dragleave', () => {
    tabEl.classList.remove('drag-over');
  });
  tabEl.addEventListener('drop', (e) => {
    e.preventDefault();
    tabEl.classList.remove('drag-over');
    if (!draggedEditorTab || draggedEditorTab === tabEl) return;
    editorTabBar.insertBefore(draggedEditorTab, tabEl);
  });
}

function initScratchTab() {
  const tabEl = document.createElement('div');
  tabEl.className = 'editor-tab scratch active';
  tabEl.innerHTML = `<span class="editor-tab-name">scratch</span>`;
  tabEl.dataset.path = SCRATCH_PATH;

  tabEl.addEventListener('click', () => switchEditorTab(SCRATCH_PATH));
  makeEditorTabDraggable(tabEl, SCRATCH_PATH);
  editorTabBar.appendChild(tabEl);
  editorTabBar.appendChild(newScratchTabBtn);

  const scratchData = {
    path: SCRATCH_PATH,
    name: 'scratch',
    content: '',
    originalContent: '',
    tabEl,
    isScratch: true,
    isTemp: false,
  };
  openFiles.set(SCRATCH_PATH, scratchData);
  activeFilePath = SCRATCH_PATH;
  showEditorPane();
}

function createTempTab() {
  tempTabCounter++;
  const tempPath = `__temp_${tempTabCounter}__`;
  const name = `temp-${tempTabCounter}`;

  const tabEl = document.createElement('div');
  tabEl.className = 'editor-tab scratch';
  tabEl.innerHTML = `<span class="editor-tab-name">${name}</span><span class="editor-tab-close">\u00d7</span>`;
  tabEl.dataset.path = tempPath;

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('editor-tab-close')) {
      closeEditorTab(tempPath);
    } else {
      switchEditorTab(tempPath);
    }
  });

  tabEl.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      closeEditorTab(tempPath);
    }
  });

  makeEditorTabDraggable(tabEl, tempPath);
  editorTabBar.insertBefore(tabEl, newScratchTabBtn);

  openFiles.set(tempPath, {
    path: tempPath,
    name,
    content: '',
    originalContent: '',
    tabEl,
    isScratch: true,
    isTemp: true,
  });

  showEditorPane();
  switchEditorTab(tempPath);
}

newScratchTabBtn.addEventListener('click', createTempTab);

async function openFileInEditor(filePath, name) {
  if (openFiles.has(filePath)) {
    switchEditorTab(filePath);
    return;
  }

  const result = await window.api.readFile(filePath);
  if (!result.success) return;

  const fileData = {
    path: filePath,
    name,
    content: result.content,
    originalContent: result.content,
    tabEl: null,
    isScratch: false,
  };

  const tabEl = document.createElement('div');
  tabEl.className = 'editor-tab';
  tabEl.innerHTML = `<span class="editor-tab-name">${escapeHtml(name)}</span><span class="editor-tab-dirty hidden">*</span><span class="editor-tab-close">\u00d7</span>`;
  tabEl.dataset.path = filePath;

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('editor-tab-close')) {
      closeEditorTab(filePath);
    } else {
      switchEditorTab(filePath);
    }
  });

  tabEl.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      closeEditorTab(filePath);
    }
  });

  makeEditorTabDraggable(tabEl, filePath);
  editorTabBar.insertBefore(tabEl, newScratchTabBtn);
  fileData.tabEl = tabEl;
  openFiles.set(filePath, fileData);

  showEditorPane();
  switchEditorTab(filePath);
}

function switchEditorTab(filePath) {
  const f = openFiles.get(filePath);
  if (!f) return;

  openFiles.forEach((fd) => fd.tabEl.classList.remove('active'));
  f.tabEl.classList.add('active');

  editorTextarea.value = f.content;
  activeFilePath = filePath;
  if (!f.isScratch) updateEditorDirty(filePath);
  editorTextarea.focus();
}

function closeEditorTab(filePath) {
  const f = openFiles.get(filePath);
  if (!f || (f.isScratch && !f.isTemp)) return;

  f.tabEl.remove();
  openFiles.delete(filePath);

  if (activeFilePath === filePath) {
    switchEditorTab(SCRATCH_PATH);
  }
}

function showEditorPane() {
  editorPane.classList.remove('hidden');
  splitter.classList.remove('hidden');
}

function hideEditorPane() {
  editorPane.classList.add('hidden');
  splitter.classList.add('hidden');
}

function updateEditorDirty(filePath) {
  const f = openFiles.get(filePath);
  if (!f || f.isScratch) return;
  const dirty = f.content !== f.originalContent;
  const dirtyEl = f.tabEl.querySelector('.editor-tab-dirty');
  if (dirtyEl) {
    if (dirty) dirtyEl.classList.remove('hidden');
    else dirtyEl.classList.add('hidden');
  }
}

function appendToScratch(text) {
  let targetPath = SCRATCH_PATH;
  const active = openFiles.get(activeFilePath);
  if (active && active.isScratch) {
    targetPath = activeFilePath;
  }
  const target = openFiles.get(targetPath);
  if (!target) return;
  const sep = target.content && !target.content.endsWith('\n') ? '\n' : '';
  target.content += sep + text + '\n';
  if (activeFilePath === targetPath) {
    editorTextarea.value = target.content;
    editorTextarea.scrollTop = editorTextarea.scrollHeight;
  }
  switchEditorTab(targetPath);
}

editorTextarea.addEventListener('input', () => {
  if (!activeFilePath) return;
  const f = openFiles.get(activeFilePath);
  if (f) {
    f.content = editorTextarea.value;
    if (!f.isScratch) updateEditorDirty(activeFilePath);
  }
});

editorTextarea.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 's') {
    e.preventDefault();
    saveActiveFile();
  }
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    sendToTerminal();
  }
  if (e.ctrlKey && e.key === 'i') {
    e.preventDefault();
    switchEditorTab(SCRATCH_PATH);
    editorTextarea.focus();
  }
  if (e.ctrlKey && e.key === 'z' && e.shiftKey) {
    e.preventDefault();
    undoLastSend();
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = editorTextarea.selectionStart;
    const end = editorTextarea.selectionEnd;
    editorTextarea.value = editorTextarea.value.substring(0, start) + '  ' + editorTextarea.value.substring(end);
    editorTextarea.selectionStart = editorTextarea.selectionEnd = start + 2;
    editorTextarea.dispatchEvent(new Event('input'));
  }
});

async function saveActiveFile() {
  if (!activeFilePath) return;
  const f = openFiles.get(activeFilePath);
  if (!f || f.isScratch) return;
  const result = await window.api.writeFile(f.path, f.content);
  if (result.success) {
    f.originalContent = f.content;
    updateEditorDirty(activeFilePath);
  }
}

// ============================================================
// Send to terminal (D8: bracketed paste)
// ============================================================

function sendToTerminal() {
  if (activeTabId === null) return;
  const t = tabs.get(activeTabId);
  if (!t) return;

  const f = openFiles.get(activeFilePath);
  if (!f) return;

  const selectedText = editorTextarea.value.substring(editorTextarea.selectionStart, editorTextarea.selectionEnd);
  const text = selectedText || f.content;
  if (!text) return;

  const lineCount = text.split('\n').length;
  if (lineCount > 50) {
    if (!confirm(`Send ${lineCount} lines to terminal?`)) return;
  }

  const useBracketedPaste = t.terminal._bracketedPasteMode;

  if (useBracketedPaste) {
    window.api.ptyWrite(t.ptyId, '\x1b[200~' + text + '\x1b[201~');
  } else {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      window.api.ptyWrite(t.ptyId, lines[i]);
      if (i < lines.length - 1) window.api.ptyWrite(t.ptyId, '\r');
    }
  }
  window.api.ptyWrite(t.ptyId, '\r');

  if (f.isScratch) {
    lastSentContent = f.content;
    lastSentTabPath = activeFilePath;
    f.content = '';
    editorTextarea.value = '';
  }
}

function undoLastSend() {
  if (!lastSentContent) return;
  const target = openFiles.get(lastSentTabPath || SCRATCH_PATH);
  if (!target) return;
  target.content = lastSentContent;
  if (activeFilePath === (lastSentTabPath || SCRATCH_PATH)) {
    editorTextarea.value = target.content;
  }
  lastSentContent = '';
  switchEditorTab(lastSentTabPath || SCRATCH_PATH);
  editorTextarea.focus();
}

sendBtn.addEventListener('click', sendToTerminal);

function updateSendTarget() {
  if (activeTabId === null) {
    sendTarget.textContent = '→ no terminal';
    sendBtn.disabled = true;
  } else {
    const t = tabs.get(activeTabId);
    if (t) {
      sendTarget.textContent = `→ ${t.command.replace('.exe', '')}`;
      sendBtn.disabled = false;
    }
  }
}

// ============================================================
// Splitter drag
// ============================================================

let splitterDragging = false;
let splitterStartY = 0;
let splitterStartHeight = 0;

splitter.addEventListener('mousedown', (e) => {
  splitterDragging = true;
  splitterStartY = e.clientY;
  splitterStartHeight = editorPane.offsetHeight;
  document.body.style.cursor = 'ns-resize';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!splitterDragging) return;
  const delta = splitterStartY - e.clientY;
  const newHeight = Math.max(80, Math.min(splitterStartHeight + delta, window.innerHeight - 120));
  editorPane.style.height = newHeight + 'px';
  handleResize();
});

document.addEventListener('mouseup', () => {
  if (splitterDragging) {
    splitterDragging = false;
    document.body.style.cursor = '';
  }
});

// ============================================================
// Terminal management
// ============================================================

async function createTerminal(command, cwd, projectId) {
  const terminal = new Terminal({
    fontSize: 14,
    fontFamily: 'Consolas, "Courier New", monospace',
    theme: { background: '#1e1e1e', foreground: '#cccccc' },
    cursorBlink: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);

  const termEl = document.createElement('div');
  termEl.className = 'terminal-instance';
  termEl.style.display = 'block';
  terminalContainer.appendChild(termEl);

  await new Promise((resolve) => requestAnimationFrame(resolve));
  terminal.open(termEl);
  fitAddon.fit();

  const cols = terminal.cols;
  const rows = terminal.rows;

  const ptyId = await window.api.ptyCreate({ command, args: [], cwd: cwd || undefined, cols, rows });

  terminal.onData((data) => {
    window.api.ptyWrite(ptyId, data);
    for (const [tid, td] of tabs) {
      if (td.ptyId === ptyId && td.waiting) {
        td.waiting = false;
        updateTabStatus(tid);
        updateProjectStatus(td.projectId);
        break;
      }
    }
  });

  const tabId = ++tabCounter;
  const label = command.replace('.exe', '');
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.innerHTML = `<span class="tab-status idle"></span><span class="tab-label">${label}</span><span class="tab-close">\u00d7</span>`;
  tabEl.dataset.id = tabId;

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) {
      closeTerminal(tabId);
    } else {
      switchTab(tabId);
    }
  });

  tabEl.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      closeTerminal(tabId);
    }
  });

  tabEl.draggable = true;
  tabEl.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(tabId));
    draggedTerminalTab = tabEl;
    tabEl.classList.add('dragging');
  });
  tabEl.addEventListener('dragend', () => {
    tabEl.classList.remove('dragging');
    tabBar.querySelectorAll('.tab').forEach(t => t.classList.remove('drag-over'));
    draggedTerminalTab = null;
  });
  tabEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  tabEl.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (draggedTerminalTab && tabEl !== draggedTerminalTab) {
      tabEl.classList.add('drag-over');
    }
  });
  tabEl.addEventListener('dragleave', () => {
    tabEl.classList.remove('drag-over');
  });
  tabEl.addEventListener('drop', (e) => {
    e.preventDefault();
    tabEl.classList.remove('drag-over');
    if (!draggedTerminalTab || draggedTerminalTab === tabEl) return;
    tabBar.insertBefore(draggedTerminalTab, tabEl);
  });

  tabBar.insertBefore(tabEl, newTabBtn);

  tabs.set(tabId, { id: tabId, projectId, terminal, fitAddon, ptyId, termEl, tabElement: tabEl, command, cwd, waiting: false });

  // Only switch to new tab if it belongs to the active project
  if (projectId === activeProjectId) {
    switchTab(tabId);
  } else {
    // Hide tab element since it's not in the active project
    tabEl.style.display = 'none';
  }
  saveLayout();
  return tabId;
}

function showProjectTabs(projectId) {
  // Hide all tabs and terminal elements
  tabs.forEach((t) => {
    const visible = t.projectId === projectId;
    t.tabElement.style.display = visible ? '' : 'none';
    t.termEl.style.display = 'none'; // always hide terminal, switchTab will show the active one
    t.tabElement.classList.remove('active');
  });

  // Restore last active tab for this project, or pick first visible
  let restoreId = projectActiveTab.get(projectId);
  if (restoreId === undefined || !tabs.has(restoreId) || tabs.get(restoreId).projectId !== projectId) {
    for (const [tid, t] of tabs) {
      if (t.projectId === projectId) { restoreId = tid; break; }
    }
  }

  if (restoreId !== undefined && tabs.has(restoreId)) {
    switchTab(restoreId);
  } else {
    activeTabId = null;
    updateSendTarget();
  }
}

function switchTab(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;

  // Hide all terminal elements (across all projects)
  tabs.forEach((td) => {
    td.termEl.style.display = 'none';
    td.tabElement.classList.remove('active');
  });

  t.termEl.style.display = 'block';
  t.tabElement.classList.add('active');
  t.fitAddon.fit();
  window.api.ptyResize(t.ptyId, t.terminal.cols, t.terminal.rows);
  t.terminal.focus();
  activeTabId = tabId;
  projectActiveTab.set(t.projectId, tabId);
  updateSendTarget();
}

function closeTerminal(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;

  const projectId = t.projectId;
  window.api.ptyKill(t.ptyId);
  t.terminal.dispose();
  t.termEl.remove();
  t.tabElement.remove();
  tabs.delete(tabId);
  updateProjectStatus(projectId);

  if (activeTabId === tabId) {
    // Find next tab in the same project
    let nextId = null;
    for (const [tid, td] of tabs) {
      if (td.projectId === projectId) { nextId = tid; break; }
    }
    if (nextId !== null) {
      switchTab(nextId);
    } else {
      activeTabId = null;
      projectActiveTab.delete(projectId);
      updateSendTarget();
    }
  }
  saveLayout();
}

function updateTabStatus(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  const statusEl = t.tabElement.querySelector('.tab-status');
  if (statusEl) {
    statusEl.className = 'tab-status ' + (t.waiting ? 'waiting' : 'idle');
  }
}

function updateProjectStatus(projectId) {
  if (!projectId) return;
  const anyWaiting = Array.from(tabs.values()).some(t => t.projectId === projectId && t.waiting);
  const el = projectList.querySelector(`.project-item .project-status`);
  const items = projectList.querySelectorAll('.project-item');
  for (const item of items) {
    const removeBtn = item.querySelector('.project-remove');
    if (removeBtn && removeBtn.dataset.id === projectId) {
      const statusEl = item.querySelector('.project-status');
      if (statusEl) {
        statusEl.className = 'project-status ' + (anyWaiting ? 'waiting' : 'idle');
      }
      return;
    }
  }
}

// ============================================================
// New terminal button (cycle through commands)
// ============================================================

let commandIndex = 0;
newTabBtn.addEventListener('click', () => {
  const p = projects.get(activeProjectId);
  const cwd = p ? p.path : undefined;
  const command = COMMANDS[commandIndex % COMMANDS.length];
  commandIndex++;
  createTerminal(command, cwd, activeProjectId);
});

// ============================================================
// Clipboard paste (Ctrl+V) -> save screenshot -> append path to scratch
// ============================================================

document.addEventListener('keydown', async (e) => {
  if (e.ctrlKey && e.key === 'v' && activeTabId !== null) {
    const p = projects.get(activeProjectId);
    if (!p) return;
    const filepath = await window.api.clipboardSaveImage(p.path);
    if (filepath) {
      appendToScratch(filepath);
    }
  }
});

// ============================================================
// Resize handling
// ============================================================

let resizeTimeout;
function handleResize() {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (activeTabId !== null) {
      const t = tabs.get(activeTabId);
      if (t) {
        t.fitAddon.fit();
        window.api.ptyResize(t.ptyId, t.terminal.cols, t.terminal.rows);
      }
    }
  }, 50);
}
window.addEventListener('resize', handleResize);
const resizeObserver = new ResizeObserver(handleResize);
resizeObserver.observe(terminalContainer);

// ============================================================
// Memory display
// ============================================================

async function updateMemory() {
  const mem = await window.api.memGet();
  memDisplay.textContent = `${mem.workingSetMB} MB | ${mem.ptyCount} PTY`;
}
setInterval(updateMemory, 2000);
updateMemory();
setInterval(updateStatusBar, 500);

// ============================================================
// Layout save/load
// ============================================================

async function saveLayout() {
  const layout = {
    activeProjectId,
    tabs: Array.from(tabs.values()).map(t => ({
      command: t.command,
      cwd: t.cwd,
      projectId: t.projectId,
    })),
  };
  await window.api.layoutSave(layout);
}

async function loadLayout() {
  const layout = await window.api.layoutLoad();
  if (!layout) return;
  if (layout.activeProjectId && projects.has(layout.activeProjectId)) {
    await selectProject(layout.activeProjectId);
  }
  if (layout.tabs && layout.tabs.length > 0) {
    for (const tab of layout.tabs) {
      await createTerminal(tab.command, tab.cwd, tab.projectId);
    }
    // After restoring all tabs, show the active project's tabs
    if (activeProjectId) {
      showProjectTabs(activeProjectId);
    }
  }
}

// ============================================================
// Vertical splitters (sidebar | file-tree | main-pane)
// ============================================================

function makeVSplitter(splitterEl, leftEl, rightEl, minLeft, minRight) {
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  splitterEl.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = leftEl.offsetWidth;
    document.body.style.cursor = 'ew-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newWidth = Math.max(minLeft, Math.min(startWidth + delta, window.innerWidth - minRight));
    leftEl.style.width = newWidth + 'px';
    handleResize();
  });

  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = '';
    }
  });
}

makeVSplitter(vsplitter1, document.getElementById('sidebar'), document.getElementById('file-tree-pane'), 120, 300);
makeVSplitter(vsplitter2, document.getElementById('file-tree-pane'), document.getElementById('main-pane'), 120, 300);

// ============================================================
// Status bar
// ============================================================

function updateStatusBar() {
  const p = projects.get(activeProjectId);
  statusLeft.textContent = p ? p.name : 'No project selected';

  const parts = [];
  if (activeTabId !== null) {
    const t = tabs.get(activeTabId);
    if (t) parts.push(t.command.replace('.exe', ''));
  }
  if (activeFilePath) {
    const f = openFiles.get(activeFilePath);
    if (f) parts.push(f.name + (f.content !== f.originalContent ? ' *' : ''));
  }
  statusRight.textContent = parts.join('  |  ');
}

// ============================================================
// Init
// ============================================================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

(async () => {
  initScratchTab();
  await loadProjects();
  await loadLayout();
  if (tabs.size === 0 && projects.size > 0) {
    const p = projects.values().next().value;
    await selectProject(p.id);
    await createTerminal('pwsh.exe', p.path, p.id);
  }
})();
