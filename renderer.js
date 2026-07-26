// ============================================================
// State
// ============================================================

const projects = new Map(); // id -> { id, name, path }
let activeProjectId = null;

const tabs = new Map(); // tabId -> { id, projectId, terminal, fitAddon, ptyId, termEl, tabElement, command, cwd, waiting }
let activeTabId = null;
let tabCounter = 0;

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

// ============================================================
// PTY data/exit handlers
// ============================================================

window.api.onPtyData(({ id, data }) => {
  for (const [, t] of tabs) {
    if (t.ptyId === id) {
      t.terminal.write(data);
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
      return;
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
  }
}

async function removeProject(projectId) {
  const updated = await window.api.projectRemove(projectId);
  projects.clear();
  for (const p of updated) {
    projects.set(p.id, p);
  }
  if (activeProjectId === projectId) {
    activeProjectId = null;
    fileTreeHeader.textContent = 'Files';
    fileTree.innerHTML = '';
  }
  renderProjectList();
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
      insertPathToTerminal(entry.path);
    }
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

  tabBar.insertBefore(tabEl, newTabBtn);

  tabs.set(tabId, { id: tabId, projectId, terminal, fitAddon, ptyId, termEl, tabElement: tabEl, command, cwd, waiting: false });

  switchTab(tabId);
  saveLayout();
  return tabId;
}

function switchTab(tabId) {
  tabs.forEach((t) => {
    t.termEl.style.display = 'none';
    t.tabElement.classList.remove('active');
  });

  const t = tabs.get(tabId);
  if (t) {
    t.termEl.style.display = 'block';
    t.tabElement.classList.add('active');
    t.fitAddon.fit();
    window.api.ptyResize(t.ptyId, t.terminal.cols, t.terminal.rows);
    t.terminal.focus();
    activeTabId = tabId;
  }
}

function closeTerminal(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;

  window.api.ptyKill(t.ptyId);
  t.terminal.dispose();
  t.termEl.remove();
  t.tabElement.remove();
  tabs.delete(tabId);

  if (activeTabId === tabId) {
    const firstId = tabs.keys().next().value;
    if (firstId !== undefined) {
      switchTab(firstId);
    } else {
      activeTabId = null;
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
// Clipboard paste (Ctrl+V) -> save screenshot -> insert path
// ============================================================

document.addEventListener('keydown', async (e) => {
  if (e.ctrlKey && e.key === 'v' && activeTabId !== null) {
    const p = projects.get(activeProjectId);
    if (!p) return;
    const filepath = await window.api.clipboardSaveImage(p.path);
    if (filepath) {
      insertPathToTerminal(filepath);
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
  }
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
  await loadProjects();
  await loadLayout();
  if (tabs.size === 0 && projects.size > 0) {
    const p = projects.values().next().value;
    await selectProject(p.id);
    await createTerminal('pwsh.exe', p.path, p.id);
  }
})();
