// ============================================================
// Imports (bundled by esbuild)
// ============================================================

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { register, dispatch } from './src/commands/registry.js';
import { getState, setState, buildFocusState, getProjectScratchContent } from './src/store/index.js';
import { calculatePreviewWidth, getPreviewForProject, getNextPreviewForProject, isPreviewForProject } from './src/preview/state.js';
import { PREVIEW_CSP } from './src/preview/security.js';
import {
  INTERNAL_FILE_MIME,
  captureExpandedPaneWidth,
  getEditorSurfaceKind,
  isTerminalPinnedToBottom,
  quotePathForCommand,
  shouldOpenInOsByName,
} from './src/phase25/state.js';

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

const IS_WIN = navigator.userAgent.includes('Windows');
const IS_MAC = /Macintosh|MacIntel|MacPPC|Mac68K/.test(navigator.userAgent);
const PLATFORM = IS_WIN ? 'win32' : IS_MAC ? 'darwin' : 'linux';

const WIN_COMMANDS = ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'wsl.exe', 'claude', 'codex', 'devin'];
const UNIX_COMMANDS = ['bash', 'zsh', 'sh', 'claude', 'codex', 'devin'];
const COMMANDS = IS_WIN ? WIN_COMMANDS : UNIX_COMMANDS;

const TERMINAL_LABELS = {
  'pwsh.exe': 'PowerShell 7',
  'powershell.exe': 'Windows PowerShell',
  'cmd.exe': 'Command Prompt',
  'wsl.exe': 'WSL',
  'bash': 'Bash',
  'zsh': 'Zsh',
  'sh': 'Sh',
  'claude': 'Claude Code',
  'codex': 'Codex',
  'devin': 'Devin CLI',
};

function defaultShell() {
  if (IS_WIN) return 'pwsh.exe';
  if (IS_MAC) return 'zsh';
  return 'bash';
}

// ツール別の送信方式（D8: bracketed paste 挙動差を吸収）
//   'paste'    : xterm.js の paste() + \r（デフォルト。mode 有効なツール全般）
//   'bracketed': 強制マーカー \x1b[200~ ... \x1b[201~ + \r（mode 無効だがマーカーを理解する）
//   'raw'      : 生テキスト + \r（マーカーを嫌うツール）
//
// 実測（2026-07-28）:
//   Claude Code: paste（mode 有効）
//   Codex:       bracketed（mode 無効、マーカーで複数行OK）
//   Devin CLI:   raw（mode 有効だがマーカーを貼り付けとして処理しない）
//
// 新ツール時はデフォルト paste で試し、ダメならここに1行足す。
// layout.json の terminalSendModes でユーザー上書き可能。
const DEFAULT_TERMINAL_SEND_MODES = {
  codex: 'bracketed',
  devin: 'raw',
};
let terminalSendModes = { ...DEFAULT_TERMINAL_SEND_MODES };

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
const fileTreeTitle = document.getElementById('file-tree-title');
const tabBar = document.getElementById('tab-bar');
const terminalContainer = document.getElementById('terminal-container');
const terminalPane = document.getElementById('terminal-pane');
const newTabBtn = document.getElementById('new-tab-btn');
const memDisplay = document.getElementById('mem-display');
const editorPane = document.getElementById('editor-pane');
const editorTabBar = document.getElementById('editor-tab-bar');
const editorTextarea = document.getElementById('editor-textarea');
const previewWebview = document.getElementById('preview-webview');
const previewPane = document.getElementById('preview-pane');
const previewTabBar = document.getElementById('preview-tab-bar');
const vsplitter3 = document.getElementById('vsplitter-3');
const splitter = document.getElementById('splitter');
const contextMenu = document.getElementById('context-menu');
const tabContextMenu = document.getElementById('tab-context-menu');
const deleteConfirmModal = document.getElementById('delete-confirm-modal');
const deleteConfirmMessage = document.getElementById('delete-confirm-message');
const deleteCancelBtn = document.getElementById('delete-cancel-btn');
const deleteConfirmBtn = document.getElementById('delete-confirm-btn');
const promptModal = document.getElementById('prompt-modal');
const promptTitle = document.getElementById('prompt-title');
const promptLabel = document.getElementById('prompt-label');
const promptInput = document.getElementById('prompt-input');
const promptCancelBtn = document.getElementById('prompt-cancel-btn');
const promptConfirmBtn = document.getElementById('prompt-confirm-btn');
const treeReloadBtn = document.getElementById('tree-reload-btn');
const treeNewFileBtn = document.getElementById('tree-new-file-btn');
const treeNewFolderBtn = document.getElementById('tree-new-folder-btn');
const vsplitter1 = document.getElementById('vsplitter-1');
const vsplitter2 = document.getElementById('vsplitter-2');
const browseFolderBtn = document.getElementById('browse-folder-btn');
// L4: collapse/restore buttons
const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
const treeCollapseBtn = document.getElementById('tree-collapse-btn');
const sidebarRestoreBar = document.getElementById('sidebar-restore-bar');
const fileTreeRestoreBar = document.getElementById('file-tree-restore-bar');
const sidebarRestoreBtn = document.getElementById('sidebar-restore-btn');
const fileTreeRestoreBtn = document.getElementById('file-tree-restore-btn');
const statusLeft = document.getElementById('status-left');
const statusRight = document.getElementById('status-right');
const sendBtn = document.getElementById('send-btn');
const sendTarget = document.getElementById('send-target');
const pushFocusCheckbox = document.getElementById('push-focus-checkbox');
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
      const shouldFollowOutput = t.pinnedToBottom;
      t.terminal.write(data, () => {
        if (shouldFollowOutput && tabs.get(tabId) === t) {
          t.terminal.scrollToBottom();
        }
      });
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
    // A6: tooltip with full path
    el.title = p.path;
    // A7: draggable for reorder
    el.draggable = true;
    el.dataset.projectId = id;
    el.innerHTML = `
      <span class="project-status idle"></span>
      <span class="project-name">${escapeHtml(p.name)}</span>
      <span class="project-remove" data-id="${id}">×</span>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('project-remove')) {
        dispatch('remove_project', { projectId: id });
      } else {
        dispatch('select_project', { projectId: id });
      }
    });
    // A7: drag & drop reorder
    el.addEventListener('dragstart', (e) => {
      draggedProjectEl = el;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      projectList.querySelectorAll('.project-item').forEach(p => p.classList.remove('drag-over'));
      draggedProjectEl = null;
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    el.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (draggedProjectEl && el !== draggedProjectEl) {
        el.classList.add('drag-over');
      }
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      if (!draggedProjectEl || draggedProjectEl === el) return;
      // 常に before に挿すと下方向への移動が無効化され、最下段にも置けない。
      // ポインタが対象の中点より下なら after に挿す。
      const rect = el.getBoundingClientRect();
      const insertAfter = e.clientY > rect.top + rect.height / 2;
      if (insertAfter) {
        projectList.insertBefore(draggedProjectEl, el.nextSibling);
      } else {
        projectList.insertBefore(draggedProjectEl, el);
      }
      saveProjectOrder();
    });
    projectList.appendChild(el);
  }
}

let draggedProjectEl = null;

async function saveProjectOrder() {
  const orderedIds = Array.from(projectList.querySelectorAll('.project-item'))
    .map(el => el.dataset.projectId)
    .filter(Boolean);
  const updated = await window.api.projectReorder(orderedIds);
  // Update the projects Map order in-place (projects is const)
  const existing = new Map(projects);
  projects.clear();
  for (const p of updated) {
    projects.set(p.id, existing.get(p.id) || { id: p.id, name: p.name, path: p.path });
  }
}

async function selectProject(projectId) {
  switchProjectEditor(projectId);
  activeProjectId = projectId;
  setState({ activeProjectId });
  // Update editor state in store after switching project editor
  const activePreview = previewFiles.get(activePreviewPath);
  if (activeSurface === 'preview' && isPreviewForProject(activePreview, projectId)) {
    setState({ activeFilePath: activePreviewPath, isPreview: true, cursorLine: null, selection: null });
  } else {
    const activeFile = openFiles.get(activeFilePath);
    if (activeFile) {
      setState({
        activeFilePath: activeFilePath,
        isPreview: false,
        scratchContent: getProjectScratchContent(openFiles, activeFilePath, SCRATCH_PATH),
      });
    } else {
      setState({ activeFilePath: null, isPreview: false, scratchContent: '' });
    }
  }
  renderProjectList();
  const p = projects.get(projectId);
  if (p) {
    fileTreeTitle.textContent = p.name;
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
  removeProjectEditorState(projectId);

  if (activeProjectId === projectId) {
    activeProjectId = null;
    activeTabId = null;
    setState({ activeProjectId: null, activeTerminalTabId: null });
    fileTreeTitle.textContent = 'Files';
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
  await dispatch('select_project', { projectId: projects.keys().next().value });
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

// ============================================================
// File tree header actions
// ============================================================

treeReloadBtn.addEventListener('click', async () => {
  const project = projects.get(activeProjectId);
  if (project) await loadFileTree(project.path);
});

treeNewFileBtn.addEventListener('click', async () => {
  const project = projects.get(activeProjectId);
  if (!project) return;
  const name = await showPrompt('New File', `Create in: ${project.path}`, '');
  if (!name) return;
  const filePath = joinPath(project.path, name);
  const result = await window.api.createFile(filePath);
  if (!result.success) {
    alert('Create file failed: ' + result.error);
    return;
  }
  await loadFileTree(project.path);
  openFileInEditor(filePath, name.split(/[\\/]/).pop());
});

treeNewFolderBtn.addEventListener('click', async () => {
  const project = projects.get(activeProjectId);
  if (!project) return;
  const name = await showPrompt('New Folder', `Create in: ${project.path}`, '');
  if (!name) return;
  const dirPath = joinPath(project.path, name);
  const result = await window.api.createDir(dirPath);
  if (!result.success) {
    alert('Create folder failed: ' + result.error);
    return;
  }
  await loadFileTree(project.path);
});

function createTreeItem(entry, depth) {
  const el = document.createElement('div');
  el.className = 'tree-item';
  el.style.paddingLeft = (12 + depth * 16) + 'px';
  // A6: tooltip with full path
  el.title = entry.path;
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
      dispatch('append_to_scratch', { text: entry.path });
    }
  });

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, entry);
  });

  if (!entry.isDirectory) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData(INTERNAL_FILE_MIME, entry.path);
      e.dataTransfer.setData('text/plain', entry.path);
    });

    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // A4: double-click always opens in preview (read-only)
      dispatch('open_preview', { path: entry.path, name: entry.name });
    });
  }

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
  hideTabContextMenu();
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

  if (action === 'preview' && !contextMenuEntry.isDirectory) {
    // A4: always open in preview (read-only)
    dispatch('open_preview', { path: contextMenuEntry.path, name: contextMenuEntry.name });
  } else if (action === 'edit' && !contextMenuEntry.isDirectory) {
    // A4: edit in central main area
    dispatch('open_file', { path: contextMenuEntry.path, name: contextMenuEntry.name });
  } else if (action === 'open-os') {
    window.api.openInOs(contextMenuEntry.path);
  } else if (action === 'copy-path') {
    window.api.clipboardWriteText(contextMenuEntry.path);
  } else if (action === 'insert-path') {
    insertPathToTerminal(contextMenuEntry.path);
  } else if (action === 'insert-name') {
    insertNameToTerminal(contextMenuEntry.path);
  } else if (action === 'delete') {
    showDeleteConfirm(contextMenuEntry);
  }
  hideContextMenu();
});

document.addEventListener('click', () => hideContextMenu());
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.tree-item')) hideContextMenu();
});

// ============================================================
// A5: Tab context menu (per tab kind)
// ============================================================

let tabContextTarget = null; // { kind, tabId, filePath, previewPath }

function showTabContextMenu(x, y, target) {
  // タブ側の contextmenu は stopPropagation するため document 側の hide が走らない。
  // 2つのメニューが同時に開くと、古い方が前のターゲットに対して発火する。
  hideContextMenu();
  tabContextTarget = target;
  tabContextMenu.innerHTML = '';
  const items = buildTabMenuItems(target);
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'context-menu-item' + (item.danger ? ' context-menu-danger' : '');
    el.dataset.action = item.action;
    el.textContent = item.label;
    tabContextMenu.appendChild(el);
  }
  tabContextMenu.classList.remove('hidden');
  tabContextMenu.style.left = x + 'px';
  tabContextMenu.style.top = y + 'px';
}

function hideTabContextMenu() {
  tabContextMenu.classList.add('hidden');
  tabContextTarget = null;
}

function buildTabMenuItems(target) {
  switch (target.kind) {
    case 'terminal':
      return [
        { action: 'rename', label: 'Rename Tab' },
        { action: 'copy-cwd', label: 'Copy cwd' },
        { action: 'close', label: 'Close', danger: true },
      ];
    case 'preview':
    case 'editor-file':
      return [
        { action: 'copy-path', label: 'Copy Path' },
        { action: 'open-os', label: 'Open in OS' },
        { action: 'close', label: 'Close', danger: true },
      ];
    case 'scratch':
      return [
        { action: 'rename', label: 'Rename Tab' },
        { action: 'close', label: 'Close', danger: true },
      ];
    default:
      return [];
  }
}

tabContextMenu.addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action || !tabContextTarget) return;
  const t = tabContextTarget;
  hideTabContextMenu();

  if (action === 'close') {
    if (t.kind === 'terminal') dispatch('close_terminal', { tabId: t.tabId });
    else if (t.kind === 'preview') closePreviewTab(t.previewPath);
    else if (t.kind === 'editor-file') closeEditorTab(t.filePath);
    else if (t.kind === 'scratch') closeEditorTab(SCRATCH_PATH);
  } else if (action === 'copy-path') {
    if (t.filePath) window.api.clipboardWriteText(t.filePath);
  } else if (action === 'open-os') {
    if (t.filePath) window.api.openInOs(t.filePath);
  } else if (action === 'copy-cwd') {
    const term = tabs.get(t.tabId);
    if (term?.cwd) window.api.clipboardWriteText(term.cwd);
  } else if (action === 'rename') {
    if (t.kind === 'terminal') renameTerminalTab(t.tabId);
    else if (t.kind === 'scratch') renameScratchTab();
  }
});

document.addEventListener('click', () => hideTabContextMenu());
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('#tab-context-menu')) hideTabContextMenu();
});

function renameTerminalTab(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  // t.command は起動コマンド（送信方式判定・待機検出・レイアウト復元に使う機能状態）。
  // 表示名は t.label に分けて持つ。ここを混ぜると改名したタブが復元できなくなる。
  showPrompt('Rename Tab', 'Enter new label:', t.label).then((newName) => {
    if (!newName) return;
    t.label = newName;
    const labelEl = t.tabElement.querySelector('.tab-label');
    if (labelEl) labelEl.textContent = newName;
    updateSendTarget();
    saveLayout();
  });
}

function renameScratchTab() {
  const scratchFile = openFiles.get(SCRATCH_PATH);
  if (!scratchFile) return;
  // scratch タブは .editor-tab-name で描画されている（.tab-label はターミナルタブ用）
  const labelEl = scratchFile.tabEl.querySelector('.editor-tab-name');
  showPrompt('Rename Tab', 'Enter new label:', labelEl?.textContent || 'scratch').then((newName) => {
    if (!newName) return;
    if (labelEl) labelEl.textContent = newName;
  });
}

// ============================================================
// Delete confirmation modal
// ============================================================

let pendingDeleteEntry = null;

function showDeleteConfirm(entry) {
  pendingDeleteEntry = entry;
  const typeStr = entry.isDirectory ? 'folder' : 'file';
  deleteConfirmMessage.textContent = `Are you sure you want to delete this ${typeStr}?`;
  deleteConfirmMessage.innerHTML += `<br><br><code style="background:#1e1e1e;padding:4px 8px;border-radius:3px;font-size:11px;word-break:break-all;">${escapeHtml(entry.path)}</code>`;
  deleteConfirmModal.classList.remove('hidden');
}

function hideDeleteConfirm() {
  deleteConfirmModal.classList.add('hidden');
  pendingDeleteEntry = null;
}

deleteCancelBtn.addEventListener('click', hideDeleteConfirm);

deleteConfirmBtn.addEventListener('click', async () => {
  if (!pendingDeleteEntry) return;
  const entry = pendingDeleteEntry;
  hideDeleteConfirm();
  const result = await window.api.deleteFile(entry.path);
  if (!result.success) {
    alert('Delete failed: ' + result.error);
    return;
  }
  // Close editor tab if the deleted file was open
  if (openFiles.has(entry.path)) {
    closeEditorTab(entry.path);
  }
  // Refresh file tree
  const project = projects.get(activeProjectId);
  if (project) await loadFileTree(project.path);
});

// ============================================================
// Prompt modal (for new file/folder naming)
// ============================================================

let promptResolve = null;

function showPrompt(title, label, defaultValue) {
  return new Promise((resolve) => {
    promptTitle.textContent = title;
    promptLabel.textContent = label;
    promptInput.value = defaultValue || '';
    promptResolve = resolve;
    promptModal.classList.remove('hidden');
    setTimeout(() => promptInput.focus(), 0);
  });
}

function hidePrompt(value) {
  promptModal.classList.add('hidden');
  const r = promptResolve;
  promptResolve = null;
  if (r) r(value);
}

promptCancelBtn.addEventListener('click', () => hidePrompt(null));
promptConfirmBtn.addEventListener('click', () => hidePrompt(promptInput.value.trim()));
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    hidePrompt(promptInput.value.trim());
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    hidePrompt(null);
  }
});

// ============================================================
// Editor management (D8: tabs below terminal, scratch = Composer)
// ============================================================

const SCRATCH_PATH = '__scratch__';
let openFiles = new Map(); // path -> { path, name, content, originalContent, tabEl, isScratch, isTemp }
let previewFiles = new Map(); // previewPath -> { path, name, tabEl, isPreview, previewPath, projectId }
let activeFilePath = null;
let activePreviewPath = null;
let activeSurface = 'editor'; // 'editor' | 'preview', restored per project
let lastSentContent = '';
let lastSentTabPath = null;
let tempTabCounter = 0;
const projectEditorStates = new Map();
let activeEditorProjectId = null;
let editorStateInitialized = false;
let savedScratchEditorHeight = null;

let draggedEditorTab = null;

function saveCurrentEditorState() {
  if (!editorStateInitialized) return;
  projectEditorStates.set(activeEditorProjectId, {
    openFiles,
    activeFilePath,
    activePreviewPath,
    activeSurface,
    lastSentContent,
    lastSentTabPath,
    tempTabCounter,
  });
}

function switchProjectEditor(projectId) {
  if (editorStateInitialized && activeEditorProjectId === projectId) return;

  saveCurrentEditorState();
  openFiles.forEach((f) => { f.tabEl.style.display = 'none'; });
  // Hide all preview tabs, will show matching ones below
  previewFiles.forEach((f) => { f.tabEl.style.display = 'none'; });

  activeEditorProjectId = projectId;
  const state = projectEditorStates.get(projectId);
  if (state) {
    openFiles = state.openFiles;
    activeFilePath = state.activeFilePath;
    activePreviewPath = getPreviewForProject(previewFiles, projectId, state.activePreviewPath);
    activeSurface = state.activeSurface === 'preview' && activePreviewPath ? 'preview' : 'editor';
    lastSentContent = state.lastSentContent;
    lastSentTabPath = state.lastSentTabPath;
    tempTabCounter = state.tempTabCounter;
    openFiles.forEach((f) => { f.tabEl.style.display = ''; });
  } else {
    openFiles = new Map();
    activeFilePath = null;
    activePreviewPath = null;
    activeSurface = 'editor';
    lastSentContent = '';
    lastSentTabPath = null;
    tempTabCounter = 0;
    editorStateInitialized = true;
    initScratchTab();
    saveCurrentEditorState();
  }

  // Show preview tabs for this project
  previewFiles.forEach((f) => {
    if (f.projectId === projectId) {
      f.tabEl.style.display = '';
    }
  });

  activePreviewPath = getPreviewForProject(previewFiles, projectId, activePreviewPath);

  editorStateInitialized = true;
  editorTabBar.appendChild(newScratchTabBtn);
  const backgroundEditor = openFiles.get(activeFilePath || SCRATCH_PATH);
  if (backgroundEditor) applyEditorSurface(backgroundEditor);
  const shouldFocusPreview = activeSurface === 'preview' && !!activePreviewPath;
  clearPreviewContent();
  if (activePreviewPath) {
    showPreviewPane();
    switchPreviewTab(activePreviewPath);
  } else {
    hidePreviewPane();
  }
  if (!shouldFocusPreview) {
    switchEditorTab(activeFilePath || SCRATCH_PATH);
  }
}

function removeProjectEditorState(projectId) {
  const state = projectEditorStates.get(projectId);
  if (state) {
    state.openFiles.forEach((f) => f.tabEl.remove());
    projectEditorStates.delete(projectId);
  }
  // Remove preview tabs for this project
  const previewToRemove = [];
  previewFiles.forEach((f, path) => {
    if (f.projectId === projectId) {
      f.tabEl.remove();
      previewToRemove.push(path);
    }
  });
  previewToRemove.forEach((p) => previewFiles.delete(p));
  if (!isPreviewForProject(previewFiles.get(activePreviewPath), activeEditorProjectId)) {
    activePreviewPath = null;
    activeSurface = 'editor';
    hidePreviewPane();
  }
  if (activeEditorProjectId === projectId) {
    editorStateInitialized = false;
    activeEditorProjectId = null;
    openFiles = new Map();
    activeFilePath = null;
    lastSentContent = '';
    lastSentTabPath = null;
    tempTabCounter = 0;
    switchProjectEditor(null);
  }
}

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

  tabEl.addEventListener('click', () => dispatch('switch_tab', { filePath: SCRATCH_PATH }));
  // A5: scratch tab context menu
  tabEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showTabContextMenu(e.clientX, e.clientY, { kind: 'scratch' });
  });
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
      dispatch('close_tab', { filePath: tempPath });
    } else {
      dispatch('switch_tab', { filePath: tempPath });
    }
  });

  tabEl.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      dispatch('close_tab', { filePath: tempPath });
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

newScratchTabBtn.addEventListener('click', () => dispatch('create_scratch_tab'));

// ============================================================
// File preview (image / html / markdown)
// ============================================================

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];
const HTML_EXTS  = ['.html', '.htm'];
const MD_EXTS    = ['.md', '.markdown'];

function getExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}
function isImage(name)    { return IMAGE_EXTS.includes(getExt(name)); }
function isHtml(name)     { return HTML_EXTS.includes(getExt(name)); }
function isMarkdown(name) { return MD_EXTS.includes(getExt(name)); }
function isPreviewable(name) {
  return isImage(name) || isHtml(name) || isMarkdown(name);
}

function toFileUrl(p) {
  // Windows: D:\path -> file:///D:/path
  let normalized = p.replace(/\\/g, '/');
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  return 'file://' + normalized;
}

function pathDirname(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(0, i) : '';
}

function joinPath(base, sub) {
  // Normalize separators and join. Handles Windows backslash paths.
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  const trimmedBase = base.replace(/[\\/]+$/, '');
  const trimmedSub = sub.replace(/^[\\/]+/, '');
  return trimmedBase + sep + trimmedSub.replace(/\//g, sep);
}

const MD_CSS = `
body { margin:0; padding:24px; color:#c9d1d9; background:#0d1117; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; font-size:14px; line-height:1.6; }
a { color:#58a6ff; }
h1,h2,h3,h4,h5,h6 { color:#f0f6fc; margin-top:24px; margin-bottom:16px; line-height:1.25; }
h1 { font-size:2em; border-bottom:1px solid #21262d; padding-bottom:.3em; }
h2 { font-size:1.5em; border-bottom:1px solid #21262d; padding-bottom:.3em; }
code { background:#161b22; padding:.2em .4em; border-radius:6px; font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace; font-size:85%; }
pre { background:#161b22; padding:16px; border-radius:6px; overflow:auto; }
pre code { background:transparent; padding:0; font-size:100%; }
blockquote { border-left:4px solid #30363d; color:#8b949e; margin:0; padding:0 16px; }
table { border-collapse:collapse; }
th,td { border:1px solid #30363d; padding:6px 13px; }
img { max-width:100%; }
hr { border:0; border-top:1px solid #21262d; }
`;

async function openFileInPreview(filePath, name) {
  const projectId = activeEditorProjectId;
  if (shouldOpenInOsByName(name)) {
    await window.api.openInOs(filePath);
    return;
  }
  const previewPath = `preview:${projectId}:${filePath}`;
  if (previewFiles.has(previewPath)) {
    switchPreviewTab(previewPath);
    return;
  }

  let initialContent;
  if (!isImage(name)) {
    const result = await window.api.readFile(filePath);
    if (!result.success || activeEditorProjectId !== projectId) return;
    if (result.isBinary) {
      await window.api.openInOs(filePath);
      return;
    }
    initialContent = result.content;
  }

  const fileData = {
    path: filePath,
    name,
    tabEl: null,
    isPreview: true,
    previewPath,
    projectId,
    initialContent,
  };

  const tabEl = document.createElement('div');
  tabEl.className = 'preview-tab';
  tabEl.innerHTML = `<span class="editor-tab-name">${escapeHtml(name)}</span><span class="editor-tab-close">\u00d7</span>`;
  tabEl.dataset.path = previewPath;
  // A6: tooltip with full path
  tabEl.title = filePath;

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('editor-tab-close')) {
      dispatch('close_tab', { filePath: previewPath });
    } else {
      dispatch('switch_tab', { filePath: previewPath });
    }
  });

  tabEl.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      dispatch('close_tab', { filePath: previewPath });
    }
  });

  // A5: preview tab context menu
  tabEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showTabContextMenu(e.clientX, e.clientY, { kind: 'preview', previewPath, filePath });
  });

  previewTabBar.appendChild(tabEl);
  fileData.tabEl = tabEl;
  previewFiles.set(previewPath, fileData);

  showPreviewPane();
  switchPreviewTab(previewPath);
}

function loadPreviewHtml(html) {
  const dataUrl = `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
  // Assigning src is safe before the webview's initial dom-ready event.
  // loadURL() would reject until the guest WebContents has been created.
  previewWebview.src = dataUrl;
}

function buildSafePreviewDocument(source, baseUrl, extraStyle = '') {
  const sanitized = DOMPurify.sanitize(source, { WHOLE_DOCUMENT: true });
  const doc = new DOMParser().parseFromString(sanitized, 'text/html');
  doc.querySelectorAll('base, meta[http-equiv]').forEach((el) => el.remove());

  const csp = doc.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = PREVIEW_CSP;
  doc.head.prepend(csp);

  const base = doc.createElement('base');
  base.href = baseUrl;
  doc.head.appendChild(base);

  if (extraStyle) {
    const style = doc.createElement('style');
    style.textContent = extraStyle;
    doc.head.appendChild(style);
  }

  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}

function isActivePreview(f) {
  return activeEditorProjectId === f.projectId && activePreviewPath === f.previewPath;
}

async function readPreviewText(f) {
  if (f.initialContent !== undefined) {
    const content = f.initialContent;
    f.initialContent = undefined;
    return content;
  }

  const result = await window.api.readFile(f.path);
  if (!result.success || !isActivePreview(f)) return null;
  if (result.isBinary) {
    await window.api.openInOs(f.path);
    if (isActivePreview(f)) closePreviewTab(f.previewPath);
    return null;
  }
  return result.content;
}

async function loadPreviewContent(f) {
  if (isImage(f.name)) {
    if (!isActivePreview(f)) return;
    previewWebview.src = toFileUrl(f.path);
  } else if (isHtml(f.name)) {
    const content = await readPreviewText(f);
    if (content === null || !isActivePreview(f)) return;
    const baseUrl = toFileUrl(pathDirname(f.path)) + '/';
    loadPreviewHtml(buildSafePreviewDocument(content, baseUrl));
  } else if (isMarkdown(f.name)) {
    const content = await readPreviewText(f);
    if (content === null || !isActivePreview(f)) return;
    const baseUrl = toFileUrl(pathDirname(f.path)) + '/';
    const markdownHtml = `<body class="markdown-body">${marked.parse(content)}</body>`;
    loadPreviewHtml(buildSafePreviewDocument(markdownHtml, baseUrl, MD_CSS));
  } else {
    // A4: show text/code files as a safe read-only preview.
    const content = await readPreviewText(f);
    if (content === null || !isActivePreview(f)) return;
    const baseUrl = toFileUrl(pathDirname(f.path)) + '/';
    const escaped = content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const codeHtml = `<body class="markdown-body"><pre><code>${escaped}</code></pre></body>`;
    loadPreviewHtml(buildSafePreviewDocument(codeHtml, baseUrl, MD_CSS));
  }
}

function clearPreviewContent() {
  previewWebview.src = 'about:blank';
}

function showPreviewPane() {
  previewPane.classList.remove('hidden');
  vsplitter3.classList.remove('hidden');
}

function hidePreviewPane() {
  previewPane.classList.add('hidden');
  vsplitter3.classList.add('hidden');
  clearPreviewContent();
}

function switchPreviewTab(previewPath) {
  const f = previewFiles.get(previewPath);
  if (!isPreviewForProject(f, activeEditorProjectId)) return;

  previewFiles.forEach((fd) => fd.tabEl.classList.remove('active'));
  f.tabEl.classList.add('active');
  activePreviewPath = previewPath;
  activeSurface = 'preview';
  showPreviewPane();
  setState({ isPreview: true, activeFilePath: previewPath, cursorLine: null, selection: null });
  loadPreviewContent(f).catch((error) => console.error('[preview] Failed to load:', error));
}

function closePreviewTab(previewPath) {
  const f = previewFiles.get(previewPath);
  if (!f) return;

  const wasPreviewFocused = activeSurface === 'preview';
  const projectId = f.projectId;
  f.tabEl.remove();
  previewFiles.delete(previewPath);

  if (activePreviewPath === previewPath) {
    const nextPath = getNextPreviewForProject(previewFiles, projectId, previewPath);
    if (nextPath) {
      switchPreviewTab(nextPath);
      if (!wasPreviewFocused) {
        switchEditorTab(activeFilePath || SCRATCH_PATH);
      }
    } else {
      activePreviewPath = null;
      activeSurface = 'editor';
      hidePreviewPane();
      switchEditorTab(activeFilePath || SCRATCH_PATH);
    }
  }
}

async function openFileInEditor(filePath, name) {
  const projectId = activeEditorProjectId;
  if (shouldOpenInOsByName(name)) {
    await window.api.openInOs(filePath);
    return;
  }
  if (openFiles.has(filePath)) {
    switchEditorTab(filePath);
    return;
  }

  const result = await window.api.readFile(filePath);
  if (!result.success) return;
  if (activeEditorProjectId !== projectId) return;
  if (result.isBinary) {
    await window.api.openInOs(filePath);
    return;
  }

  const fileData = {
    path: filePath,
    name,
    content: result.content,
    originalContent: result.content,
    tabEl: null,
    isScratch: false,
    projectId,
  };

  const tabEl = document.createElement('div');
  tabEl.className = 'editor-tab';
  tabEl.innerHTML = `<span class="editor-tab-name">${escapeHtml(name)}</span><span class="editor-tab-dirty hidden">*</span><span class="editor-tab-close">\u00d7</span>`;
  tabEl.dataset.path = filePath;
  // A6: tooltip with full path
  tabEl.title = filePath;

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('editor-tab-close')) {
      dispatch('close_tab', { filePath });
    } else {
      dispatch('switch_tab', { filePath });
    }
  });

  tabEl.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      dispatch('close_tab', { filePath });
    }
  });

  // A5: editor file tab context menu
  tabEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showTabContextMenu(e.clientX, e.clientY, { kind: 'editor-file', filePath });
  });

  makeEditorTabDraggable(tabEl, filePath);
  editorTabBar.insertBefore(tabEl, newScratchTabBtn);
  fileData.tabEl = tabEl;
  openFiles.set(filePath, fileData);

  switchEditorTab(filePath);
}

function switchEditorTab(filePath) {
  // Preview tabs are handled by switchPreviewTab
  if (filePath && filePath.startsWith('preview:')) {
    switchPreviewTab(filePath);
    return;
  }
  const f = openFiles.get(filePath);
  if (!f) return;

  openFiles.forEach((fd) => fd.tabEl.classList.remove('active'));
  f.tabEl.classList.add('active');
  activeFilePath = filePath;
  activeSurface = 'editor';
  setState({ activeFilePath: filePath, isPreview: false });
  applyEditorSurface(f);

  editorTextarea.classList.remove('hidden');
  editorTextarea.value = f.content;
  if (f.isScratch) {
    setState({ scratchContent: f.content });
  }
  if (!f.isScratch) updateEditorDirty(filePath);
  editorTextarea.focus();
  // Recalculate cursor/selection for the newly focused file
  updateEditorCursorState();
}

function closeEditorTab(filePath) {
  // Preview tabs are handled by closePreviewTab
  if (filePath && filePath.startsWith('preview:')) {
    closePreviewTab(filePath);
    return;
  }
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
  editorPane.classList.remove('central');
  terminalPane.classList.remove('hidden');
  splitter.classList.remove('hidden');
  const defaultHeight = Math.max(200, Math.floor(window.innerHeight * 0.4));
  editorPane.style.height = `${savedScratchEditorHeight || defaultHeight}px`;
  requestAnimationFrame(handleResize);
}

function showMainEditorSurface() {
  if (!editorPane.classList.contains('central') && editorPane.offsetHeight > 0) {
    savedScratchEditorHeight = editorPane.offsetHeight;
  }
  terminalPane.classList.add('hidden');
  splitter.classList.add('hidden');
  editorPane.classList.remove('hidden');
  editorPane.classList.add('central');
  editorPane.style.height = '';
}

function applyEditorSurface(file) {
  if (getEditorSurfaceKind(file) === 'scratch') {
    showEditorPane();
  } else {
    showMainEditorSurface();
  }
}

function hideEditorPane() {
  editorPane.classList.add('hidden');
  editorPane.classList.remove('central');
  terminalPane.classList.remove('hidden');
  splitter.classList.add('hidden');
  requestAnimationFrame(handleResize);
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
  if (target.isScratch) {
    setState({ scratchContent: target.content });
  }
  if (activeFilePath === targetPath) {
    editorTextarea.value = target.content;
    editorTextarea.scrollTop = editorTextarea.scrollHeight;
  }
  switchEditorTab(targetPath);
}

function updateActiveEditorContent(content) {
  if (!activeFilePath) return;
  const f = openFiles.get(activeFilePath);
  if (f) {
    f.content = content;
    if (f.isScratch) {
      setState({ scratchContent: f.content });
    } else if (!f.isScratch) {
      updateEditorDirty(activeFilePath);
    }
    updateEditorCursorState();
  }
}

editorTextarea.addEventListener('input', () => {
  dispatch('update_editor_content', { content: editorTextarea.value });
});

// Update cursor/selection state for get_focus
function updateEditorCursorState() {
  const f = activeFilePath ? openFiles.get(activeFilePath) : null;
  if (!f || f.isPreview) {
    setState({ cursorLine: null, selection: null });
    return;
  }
  const value = editorTextarea.value;
  const pos = editorTextarea.selectionStart;
  const line = value.substring(0, pos).split('\n').length;
  const selStart = editorTextarea.selectionStart;
  const selEnd = editorTextarea.selectionEnd;
  let selection = null;
  if (selEnd > selStart) {
    const startLine = value.substring(0, selStart).split('\n').length;
    const endLine = value.substring(0, selEnd).split('\n').length;
    selection = { startLine, endLine };
  }
  setState({ cursorLine: line, selection });
}

editorTextarea.addEventListener('keyup', () => dispatch('update_editor_selection'));
editorTextarea.addEventListener('click', () => dispatch('update_editor_selection'));
editorTextarea.addEventListener('select', () => dispatch('update_editor_selection'));

editorTextarea.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 's') {
    e.preventDefault();
    dispatch('save_active_file');
  }
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    dispatch('send_to_terminal', {});
  }
  if (e.ctrlKey && e.key === 'i') {
    e.preventDefault();
    dispatch('switch_tab', { filePath: SCRATCH_PATH });
    editorTextarea.focus();
  }
  if (e.ctrlKey && e.key === 'z' && e.shiftKey) {
    e.preventDefault();
    dispatch('undo_last_send');
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
  if (!f || f.isScratch && !f.isTemp) return;

  if (f.isTemp) {
    // Show save dialog for temp tabs
    const project = projects.get(activeEditorProjectId);
    const defaultPath = project ? project.path : undefined;
    const savePath = await window.api.saveFileDialog(defaultPath, f.name || 'untitled.txt');
    if (!savePath) return;

    const result = await window.api.writeFile(savePath, f.content);
    if (!result.success) return;

    // Convert temp tab into a regular file tab
    const oldPath = activeFilePath;
    const newName = savePath.split(/[\\/]/).pop();
    openFiles.delete(oldPath);
    f.path = savePath;
    f.name = newName;
    f.isScratch = false;
    f.isTemp = false;
    f.originalContent = f.content;
    f.tabEl.classList.remove('scratch');
    f.tabEl.querySelector('.editor-tab-name').textContent = newName;
    f.tabEl.dataset.path = savePath;
    // Re-bind click handlers to new path
    f.tabEl.onclick = (e) => {
      if (e.target.classList.contains('editor-tab-close')) {
        dispatch('close_tab', { filePath: savePath });
      } else {
        dispatch('switch_tab', { filePath: savePath });
      }
    };
    // Add dirty indicator
    const dirtyEl = document.createElement('span');
    dirtyEl.className = 'editor-tab-dirty hidden';
    dirtyEl.textContent = '*';
    const closeEl = f.tabEl.querySelector('.editor-tab-close');
    f.tabEl.insertBefore(dirtyEl, closeEl);
    openFiles.set(savePath, f);
    activeFilePath = savePath;
    setState({ activeFilePath: savePath, isPreview: false, scratchContent: getState().scratchContent });
    applyEditorSurface(f);
    updateEditorDirty(savePath);
    // Refresh file tree to show the new file
    if (project) await loadFileTree(project.path);
  } else {
    const result = await window.api.writeFile(f.path, f.content);
    if (result.success) {
      f.originalContent = f.content;
      updateEditorDirty(activeFilePath);
    }
  }
}

// ============================================================
// Send to terminal (D8: bracketed paste)
// ============================================================

// 3.1 push: build a compact context block from current focus state
function getSelectionRange() {
  const start = editorTextarea.selectionStart;
  const end = editorTextarea.selectionEnd;
  if (start === end) return null;
  const before = editorTextarea.value.substring(0, start);
  const selected = editorTextarea.value.substring(start, end);
  const startLine = before.split('\n').length;
  const endLine = startLine + selected.split('\n').length - 1;
  return { startLine, endLine };
}

function buildPushFocusContext({ project, activeFilePath, isPreview, selectedText, selectionRange }) {
  const parts = [];
  parts.push('--- context ---');
  if (project) {
    parts.push(`project: ${project.name}`);
  }
  if (activeFilePath) {
    const label = isPreview ? 'preview' : 'file';
    parts.push(`${label}: ${activeFilePath}`);
  }
  if (selectionRange) {
    if (selectionRange.startLine === selectionRange.endLine) {
      parts.push(`selection: line ${selectionRange.startLine}`);
    } else {
      parts.push(`selection: lines ${selectionRange.startLine}-${selectionRange.endLine}`);
    }
  }
  parts.push('--- end context ---');
  return parts.join('\n');
}

function sendToTerminal(text, tabId) {
  if (tabId !== undefined) {
    switchTab(tabId);
  }
  if (activeTabId === null) return;
  const t = tabs.get(activeTabId);
  if (!t) return;

  const hasExplicitText = typeof text === 'string';
  const f = openFiles.get(activeFilePath);
  if (!f && !hasExplicitText) return;

  const selectedText = f
    ? editorTextarea.value.substring(editorTextarea.selectionStart, editorTextarea.selectionEnd)
    : '';
  let contentToSend = hasExplicitText ? text : (selectedText || f.content);
  if (!contentToSend) return;

  // 3.1 push: append focus context to the message
  if (pushFocusCheckbox.checked) {
    const ctx = buildPushFocusContext({
      project: projects.get(activeProjectId),
      activeFilePath,
      isPreview: f?.isPreview,
      selectedText,
      selectionRange: f ? getSelectionRange() : null,
    });
    if (ctx) {
      contentToSend = contentToSend + '\n' + ctx;
    }
  }

  const lineCount = contentToSend.split('\n').length;
  if (lineCount > 50) {
    if (!confirm(`Send ${lineCount} lines to terminal?`)) return;
  }

  // D8: 複数行の指示を1回で送る（ツール別の bracketed paste 挙動差を吸収）
  // 送信方式は terminalSendModes で管理。新ツールは DEFAULT_TERMINAL_SEND_MODES に1行足すか、
  // layout.json の terminalSendModes でユーザー上書き。
  const cmd = (t.command || '').toLowerCase();
  const mode = terminalSendModes[cmd] || 'paste';
  if (mode === 'bracketed') {
    window.api.ptyWrite(t.ptyId, '\x1b[200~' + contentToSend + '\x1b[201~');
    window.api.ptyWrite(t.ptyId, '\r');
  } else if (mode === 'raw') {
    window.api.ptyWrite(t.ptyId, contentToSend);
    window.api.ptyWrite(t.ptyId, '\r');
  } else {
    // 'paste'（デフォルト）: xterm.js が bracketed paste mode を判定して適切に処理
    t.terminal.paste(contentToSend);
    window.api.ptyWrite(t.ptyId, '\r');
  }

  if (f?.isScratch && !hasExplicitText) {
    lastSentContent = f.content;
    lastSentTabPath = activeFilePath;
    f.content = '';
    editorTextarea.value = '';
    setState({ scratchContent: '', cursorLine: null, selection: null });
  }
}

function undoLastSend() {
  if (!lastSentContent) return;
  const target = openFiles.get(lastSentTabPath || SCRATCH_PATH);
  if (!target) return;
  target.content = lastSentContent;
  if (target.isScratch) {
    setState({ scratchContent: target.content });
  }
  if (activeFilePath === (lastSentTabPath || SCRATCH_PATH)) {
    editorTextarea.value = target.content;
  }
  lastSentContent = '';
  switchEditorTab(lastSentTabPath || SCRATCH_PATH);
  editorTextarea.focus();
}

sendBtn.addEventListener('click', () => dispatch('send_to_terminal', {}));
pushFocusCheckbox.addEventListener('change', () => saveLayout());

function updateSendTarget() {
  if (activeTabId === null) {
    sendTarget.textContent = '→ no terminal';
    sendBtn.disabled = true;
  } else {
    const t = tabs.get(activeTabId);
    if (t) {
      sendTarget.textContent = `→ ${t.label}`;
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
    savedScratchEditorHeight = editorPane.offsetHeight;
    document.body.style.cursor = '';
  }
});

// ============================================================
// Terminal management
// ============================================================

async function createTerminal(command, cwd, projectId, savedLabel) {
  const terminal = new Terminal({
    fontSize: 14,
    fontFamily: 'Consolas, "Courier New", monospace',
    theme: { background: '#1e1e1e', foreground: '#cccccc' },
    cursorBlink: true,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  const termEl = document.createElement('div');
  termEl.className = 'terminal-instance';
  termEl.style.display = 'block';
  terminalContainer.appendChild(termEl);

  await new Promise((resolve) => requestAnimationFrame(resolve));
  terminal.open(termEl);
  fitAddon.fit();

  // ターミナルのコピー機能（Electron は標準コンテキストメニューが出ないため自前で実装）
  // - 右クリック: 選択範囲をコピー → 選択解除（Windows Terminal / PuTTY と同じ挙動）
  // - Ctrl+Shift+C: 同上（VSCode / GNOME Terminal と同じ挙動）
  function copyTerminalSelection() {
    const selection = terminal.getSelection();
    if (selection) {
      window.api.clipboardWriteText(selection);
      terminal.clearSelection();
    }
  }
  termEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    copyTerminalSelection();
  });
  termEl.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      e.preventDefault();
      copyTerminalSelection();
    }
  });

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
  const label = savedLabel || command.replace('.exe', '');
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.innerHTML = `<span class="tab-status idle"></span><span class="tab-label">${escapeHtml(label)}</span><span class="tab-close">\u00d7</span>`;
  tabEl.dataset.id = tabId;

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) {
      dispatch('close_terminal', { tabId });
    } else {
      dispatch('focus_terminal', { tabId });
    }
  });

  tabEl.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      dispatch('close_terminal', { tabId });
    }
  });

  // A5: terminal tab context menu
  tabEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showTabContextMenu(e.clientX, e.clientY, { kind: 'terminal', tabId });
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

  tabs.set(tabId, { id: tabId, projectId, terminal, fitAddon, ptyId, termEl, tabElement: tabEl, command, label, cwd, waiting: false, pinnedToBottom: true });

  // A2: Use xterm's buffer-level event; DOM scroll events on the viewport do
  // not bubble to termEl.
  terminal.onScroll(() => {
    const current = tabs.get(tabId);
    if (current) {
      current.pinnedToBottom = isTerminalPinnedToBottom(terminal.buffer.active);
    }
  });

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
    setState({ activeTerminalTabId: null });
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
  activeTabId = tabId;
  projectActiveTab.set(t.projectId, tabId);
  setState({ activeTerminalTabId: tabId });
  updateSendTarget();

  // Wait until display/layout changes have settled before measuring.
  requestAnimationFrame(() => {
    if (activeTabId !== tabId || t.termEl.style.display === 'none') return;
    const shouldFollow = t.pinnedToBottom;
    if (!resizeTerminalToContainer(t)) return;
    t.pinnedToBottom = shouldFollow;
    t.terminal.focus();
    if (shouldFollow) t.terminal.scrollToBottom();
  });
}

function resizeTerminalToContainer(t) {
  const rect = t.termEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const oldCols = t.terminal.cols;
  const oldRows = t.terminal.rows;
  t.fitAddon.fit();
  if (t.terminal.cols !== oldCols || t.terminal.rows !== oldRows) {
    window.api.ptyResize(t.ptyId, t.terminal.cols, t.terminal.rows);
  }
  return true;
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
      setState({ activeTerminalTabId: null });
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
// New terminal button (dropdown to select terminal type)
// ============================================================

const newTabMenu = document.getElementById('new-tab-menu');

newTabBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (newTabMenu.classList.contains('hidden')) {
    const rect = newTabBtn.getBoundingClientRect();
    const menuWidth = 140;
    let left = rect.left;
    if (left + menuWidth > window.innerWidth) {
      left = window.innerWidth - menuWidth - 4;
    }
    newTabMenu.style.left = left + 'px';
    newTabMenu.style.top = rect.bottom + 'px';
    newTabMenu.classList.remove('hidden');
  } else {
    newTabMenu.classList.add('hidden');
  }
});

// Populate menu items (only installed commands)
async function buildTerminalMenu() {
  const availability = await window.api.commandCheck(COMMANDS);
  newTabMenu.innerHTML = '';
  COMMANDS.forEach((cmd) => {
    if (availability[cmd] === false) return;
    const item = document.createElement('div');
    item.className = 'dropdown-item';
    item.textContent = TERMINAL_LABELS[cmd] || cmd;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      newTabMenu.classList.add('hidden');
      const p = projects.get(activeProjectId);
      const cwd = p ? p.path : undefined;
      dispatch('create_terminal', { command: cmd, cwd, projectId: activeProjectId });
    });
    newTabMenu.appendChild(item);
  });
}
buildTerminalMenu();

// Close menu when clicking outside
document.addEventListener('click', () => {
  newTabMenu.classList.add('hidden');
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
      dispatch('append_to_scratch', { text: filepath });
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
      if (t && t.termEl.style.display !== 'none') {
        const shouldFollow = t.pinnedToBottom;
        resizeTerminalToContainer(t);
        t.pinnedToBottom = shouldFollow;
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
// L4: Sidebar / File Tree collapse & restore
// ============================================================

const sidebar = document.getElementById('sidebar');
const fileTreePane = document.getElementById('file-tree-pane');

let sidebarCollapsed = false;
let fileTreeCollapsed = false;
let savedSidebarWidth = 200;
let savedFileTreeWidth = 240;

function applyCollapseState() {
  savedSidebarWidth = captureExpandedPaneWidth({
    isCollapsed: sidebar.classList.contains('collapsed'),
    measuredWidth: sidebar.offsetWidth,
    savedWidth: savedSidebarWidth,
  });
  savedFileTreeWidth = captureExpandedPaneWidth({
    isCollapsed: fileTreePane.classList.contains('collapsed'),
    measuredWidth: fileTreePane.offsetWidth,
    savedWidth: savedFileTreeWidth,
  });

  if (sidebarCollapsed) {
    sidebar.classList.add('collapsed');
    vsplitter1.classList.add('hidden');
    sidebarRestoreBar.classList.remove('hidden');
  } else {
    sidebar.style.width = savedSidebarWidth + 'px';
    sidebar.classList.remove('collapsed');
    vsplitter1.classList.remove('hidden');
    sidebarRestoreBar.classList.add('hidden');
  }

  if (fileTreeCollapsed) {
    fileTreePane.classList.add('collapsed');
    vsplitter2.classList.add('hidden');
    fileTreeRestoreBar.classList.remove('hidden');
  } else {
    fileTreePane.style.width = savedFileTreeWidth + 'px';
    fileTreePane.classList.remove('collapsed');
    vsplitter2.classList.remove('hidden');
    fileTreeRestoreBar.classList.add('hidden');
  }
  handleResize();
  saveCollapseState();
}

function saveCollapseState() {
  try {
    localStorage.setItem('pm-collapse', JSON.stringify({
      sidebarCollapsed, fileTreeCollapsed,
      sidebarWidth: savedSidebarWidth, fileTreeWidth: savedFileTreeWidth,
    }));
  } catch {}
}

function loadCollapseState() {
  try {
    const data = JSON.parse(localStorage.getItem('pm-collapse') || '{}');
    if (data.sidebarCollapsed !== undefined) sidebarCollapsed = data.sidebarCollapsed;
    if (data.fileTreeCollapsed !== undefined) fileTreeCollapsed = data.fileTreeCollapsed;
    if (data.sidebarWidth) { savedSidebarWidth = data.sidebarWidth; sidebar.style.width = data.sidebarWidth + 'px'; }
    if (data.fileTreeWidth) { savedFileTreeWidth = data.fileTreeWidth; fileTreePane.style.width = data.fileTreeWidth + 'px'; }
  } catch {}
  applyCollapseState();
}

sidebarCollapseBtn.addEventListener('click', () => {
  sidebarCollapsed = true;
  applyCollapseState();
});

treeCollapseBtn.addEventListener('click', () => {
  fileTreeCollapsed = true;
  applyCollapseState();
});

sidebarRestoreBtn.addEventListener('click', () => {
  sidebarCollapsed = false;
  applyCollapseState();
});

fileTreeRestoreBtn.addEventListener('click', () => {
  fileTreeCollapsed = false;
  applyCollapseState();
});

function toggleBothColumns() {
  const bothCollapsed = sidebarCollapsed && fileTreeCollapsed;
  if (bothCollapsed) {
    sidebarCollapsed = false;
    fileTreeCollapsed = false;
  } else {
    sidebarCollapsed = true;
    fileTreeCollapsed = true;
  }
  applyCollapseState();
}

// Ctrl+B: toggle both columns
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'b') {
    e.preventDefault();
    toggleBothColumns();
  }
});

loadCollapseState();

// ============================================================
// A3: Drag & Drop (from OS Explorer and app-internal)
// ============================================================

// Drop targets: preview pane, main pane (editor), scratch, terminal
// Rules:
//   preview / main-pane → open file read-only in preview
//   scratch (editor-textarea) → append absolute path
//   terminal → insert path (no Enter)
//   file-tree → nothing

function hasFileDrop(dataTransfer) {
  const types = Array.from(dataTransfer?.types || []);
  return types.includes('Files') || types.includes(INTERNAL_FILE_MIME);
}

function getDroppedFilePaths(e) {
  const paths = [];
  if (e.dataTransfer?.files) {
    for (const file of e.dataTransfer.files) {
      try {
        const filePath = window.api.getPathForFile(file);
        if (filePath) paths.push(filePath);
      } catch {}
    }
  }
  const internalPath = e.dataTransfer?.getData(INTERNAL_FILE_MIME);
  if (internalPath) paths.push(internalPath);
  return [...new Set(paths)];
}

// Preview pane: open file in preview
previewPane.addEventListener('dragover', (e) => {
  if (hasFileDrop(e.dataTransfer)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});
previewPane.addEventListener('drop', (e) => {
  e.preventDefault();
  const paths = getDroppedFilePaths(e);
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    dispatch('open_preview', { path: p, name });
  }
});

// Main pane: open file in preview (same as preview for now)
const mainPane = document.getElementById('main-pane');
mainPane.addEventListener('dragover', (e) => {
  if (hasFileDrop(e.dataTransfer)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});
mainPane.addEventListener('drop', (e) => {
  // Don't intercept if dropping on textarea or terminal (they have their own handlers)
  if (e.target === editorTextarea || e.target.closest('#terminal-container')) return;
  e.preventDefault();
  const paths = getDroppedFilePaths(e);
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    dispatch('open_preview', { path: p, name });
  }
});

// Scratch (editor textarea): append path
editorTextarea.addEventListener('dragover', (e) => {
  if (hasFileDrop(e.dataTransfer)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});
editorTextarea.addEventListener('drop', (e) => {
  e.preventDefault();
  const paths = getDroppedFilePaths(e);
  if (paths.length > 0) {
    const activeFile = openFiles.get(activeFilePath);
    if (activeFile?.isScratch) {
      dispatch('append_to_scratch', { text: paths.join('\n') });
    } else {
      for (const filePath of paths) {
        const name = filePath.split(/[\\/]/).pop();
        dispatch('open_preview', { path: filePath, name });
      }
    }
  }
});

// Terminal container: insert path (no Enter)
terminalContainer.addEventListener('dragover', (e) => {
  if (hasFileDrop(e.dataTransfer)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});
terminalContainer.addEventListener('drop', (e) => {
  e.preventDefault();
  const paths = getDroppedFilePaths(e);
  if (paths.length > 0 && activeTabId !== null) {
    const t = tabs.get(activeTabId);
    if (t) {
      const quotedPaths = paths.map((filePath) => quotePathForCommand(filePath, t.command));
      t.terminal.paste(quotedPaths.join(' '));
    }
  }
});

// File tree is explicitly a no-op drop target. Prevent Chromium's default file
// navigation so dropping a file here cannot replace the application document.
fileTree.addEventListener('dragover', (e) => {
  if (hasFileDrop(e.dataTransfer)) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'none';
  }
});
fileTree.addEventListener('drop', (e) => {
  if (hasFileDrop(e.dataTransfer)) {
    e.preventDefault();
    e.stopPropagation();
  }
});

// Prevent an unhandled OS file drop from navigating the BrowserWindow away
// from index.html.
document.addEventListener('dragover', (e) => {
  if (hasFileDrop(e.dataTransfer)) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (hasFileDrop(e.dataTransfer)) e.preventDefault();
});

// ============================================================
// Layout save/load
// ============================================================

async function saveLayout() {
  const layout = {
    activeProjectId,
    tabs: Array.from(tabs.values()).map(t => ({
      command: t.command,
      label: t.label,
      cwd: t.cwd,
      projectId: t.projectId,
    })),
    terminalSendModes,
    pushFocusEnabled: pushFocusCheckbox.checked,
  };
  await window.api.layoutSave(layout);
}

async function loadLayout() {
  const layout = await window.api.layoutLoad();
  if (!layout) return;
  // ユーザー設定で既知のツールの送信方式を上書き（未指定はデフォルトを使う）
  if (layout.terminalSendModes && typeof layout.terminalSendModes === 'object') {
    terminalSendModes = { ...DEFAULT_TERMINAL_SEND_MODES, ...layout.terminalSendModes };
  }
  if (typeof layout.pushFocusEnabled === 'boolean') {
    pushFocusCheckbox.checked = layout.pushFocusEnabled;
  }
  if (layout.activeProjectId && projects.has(layout.activeProjectId)) {
    await dispatch('select_project', { projectId: layout.activeProjectId });
  }
  if (layout.tabs && layout.tabs.length > 0) {
    for (const tab of layout.tabs) {
      await dispatch('create_terminal', tab);
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

function makeVSplitter(splitterEl, leftEl, rightEl, minLeft, minRight, onResizeEnd) {
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
      if (onResizeEnd) onResizeEnd(leftEl.offsetWidth);
    }
  });
}

function makePreviewSplitter(splitterEl, mainEl, previewEl, minMain, minPreview) {
  let dragging = false;
  let startX = 0;
  let startPreviewWidth = 0;
  let availableWidth = 0;

  splitterEl.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startPreviewWidth = previewEl.offsetWidth;
    availableWidth = mainEl.offsetWidth + startPreviewWidth;
    document.body.style.cursor = 'ew-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newWidth = calculatePreviewWidth({
      startPreviewWidth,
      delta,
      availableWidth,
      minMain,
      minPreview,
    });
    previewEl.style.width = newWidth + 'px';
    handleResize();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
  });
}

makeVSplitter(vsplitter1, sidebar, fileTreePane, 120, 300, (width) => {
  savedSidebarWidth = width;
  saveCollapseState();
});
makeVSplitter(vsplitter2, fileTreePane, document.getElementById('main-pane'), 120, 300, (width) => {
  savedFileTreeWidth = width;
  saveCollapseState();
});
makePreviewSplitter(vsplitter3, document.getElementById('main-pane'), document.getElementById('preview-pane'), 200, 150);

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
// Command handlers (Phase 1)
// ============================================================

// State-affecting UI operations enter through these handlers. The handlers
// delegate to the existing domain functions, which keep the focus store in
// sync for get_focus.

// select_project: switch active project
register('select_project', ({ projectId }) => {
  return selectProject(projectId);
});

register('remove_project', ({ projectId }) => {
  return removeProject(projectId);
});

// open_file: open a file in the editor
register('open_file', ({ path, name }) => {
  return openFileInEditor(path, name);
});

// open_preview: open a file in preview mode
register('open_preview', ({ path, name }) => {
  return openFileInPreview(path, name);
});

// close_tab: close an editor tab
register('close_tab', ({ filePath }) => {
  closeEditorTab(filePath);
});

// switch_tab: switch to an editor tab
register('switch_tab', ({ filePath }) => {
  switchEditorTab(filePath);
});

register('create_scratch_tab', () => {
  createTempTab();
});

register('append_to_scratch', ({ text }) => {
  appendToScratch(text);
});

register('update_editor_content', ({ content }) => {
  updateActiveEditorContent(content);
});

register('update_editor_selection', () => {
  updateEditorCursorState();
});

register('save_active_file', () => {
  return saveActiveFile();
});

register('undo_last_send', () => {
  undoLastSend();
});

// focus_terminal: switch to a terminal tab
register('focus_terminal', ({ tabId }) => {
  // A central file editor intentionally hides the terminal surface. An
  // explicit focus request must therefore restore the scratch/terminal
  // layout before selecting the requested terminal tab.
  if (terminalPane.classList.contains('hidden') && openFiles.has(SCRATCH_PATH)) {
    switchEditorTab(SCRATCH_PATH);
  }
  switchTab(tabId);
});

register('create_terminal', ({ command, cwd, projectId, label } = {}) => {
  // A8: メニューからの呼び出し用デフォルト。
  // 新規タブのドロップダウンはインストール済みのツールだけを出すため、
  // ここで特定の AI CLI を決め打ちすると未インストール環境で必ず失敗する。
  const cmd = command || defaultShell();
  const cwd_ = cwd || (projects.get(activeProjectId)?.path);
  const pid = projectId || activeProjectId;
  return createTerminal(cmd, cwd_, pid, label);
});

// A8: commands for application menu access
register('add_project', () => {
  showAddProjectModal();
});

register('new_file', () => {
  treeNewFileBtn.click();
});

register('new_folder', () => {
  treeNewFolderBtn.click();
});

// A8: メニューからのサイドバー開閉。合成キーイベントを送らず、
// renderer 側の実処理を直接呼ぶ（L4 の toggleBothColumns と同じ経路）。
register('toggle_sidebar', () => {
  toggleBothColumns();
});

register('close_terminal', ({ tabId }) => {
  closeTerminal(tabId);
});

// send_to_terminal: send text to terminal
register('send_to_terminal', ({ text, tabId }) => {
  sendToTerminal(text, tabId);
});

// get_focus: build the human's attention state from the store + live data
register('get_focus', () => {
  const focus = buildFocusState((id) => projects.get(id) || null);
  // Enrich terminal info from live tabs Map (store only has tabId)
  if (focus.terminal) {
    const t = tabs.get(focus.terminal.activeTabId);
    if (t) {
      focus.terminal.command = t.command;
    }
  }
  // For preview tabs, resolve the actual file path
  if (focus.editor && focus.editor.isPreview && focus.editor.filePath && focus.editor.filePath.startsWith('preview:')) {
    const pf = previewFiles.get(focus.editor.filePath);
    if (pf) {
      focus.editor.filePath = pf.path;
      focus.editor.activeTab = pf.name;
    }
  }
  return focus;
});

// Expose dispatch to main process via executeJavaScript (for MCP get_focus)
// Returns a JSON-serializable focus state
window.__pmDispatch = (name, args = {}) => {
  return dispatch(name, args);
};

// ============================================================
// Layout rectangles (Phase 2.4 — for Phase 3 WebContentsView overlay)
// Returns the screen-space bounding rect of a named pane.
// main process uses this to position absolute-coordinate overlays.
// ============================================================

window.__pmGetPaneRect = (paneName) => {
  const map = {
    terminal: 'terminal-container',
    editor: 'editor-content',
    preview: 'preview-content',
    fileTree: 'file-tree',
    sidebar: 'sidebar',
  };
  const id = map[paneName];
  if (!id) return null;
  const el = document.getElementById(id);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

window.__pmGetAllPaneRects = () => {
  const panes = ['sidebar', 'fileTree', 'terminal', 'editor', 'preview'];
  const result = {};
  for (const p of panes) {
    const r = window.__pmGetPaneRect(p);
    if (r) result[p] = r;
  }
  return result;
};

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
    await dispatch('select_project', { projectId: p.id });
    await dispatch('create_terminal', { command: defaultShell(), cwd: p.path, projectId: p.id });
  }
  if (!editorStateInitialized) switchProjectEditor(activeProjectId);
})();
