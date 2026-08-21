// ============================================================
// Imports (bundled by esbuild)
// ============================================================

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import sharedScrollbarCss from './scrollbars.css';
import { register, dispatch } from './src/commands/registry.js';
import { BINDINGS, validateBindings, matchBinding, keyToString, evaluateWhen } from './src/keybindings/registry.js';
import { getState, setState, buildFocusState, getProjectScratchContent, getProjectBadge, getTabAttention, getTerminalAttentionSummary, getTerminalAgentBinding } from './src/store/index.js';
import { clearTerminalAttention, markAgentNotificationSeen, receiveAgentNotification, setTerminalWaiting } from './src/notifications/state.mjs';
import { registerDevinTerminalNotifications } from './src/notifications/devin-terminal.mjs';
import {
  clampLineRange,
  decidePreviewActivation,
  findOwningProject,
  makePreviewPath,
  resolveAttentionFile,
} from './src/phase3/state.mjs';
import { getPreviewForProject, getNextPreviewForProject, isPreviewForProject } from './src/preview/state.js';
import { PREVIEW_CSP } from './src/preview/security.js';
import { getBrowserTabLabel, normalizeLocalBrowserUrl } from './src/ui/browser.mjs';
import { createEditorKit, revealLine } from './src/editor/cm6.mjs';
import { isDocDirty, getCursorLine, getSelectionLines, detectEol, applyEol } from './src/editor/doc-state.mjs';
import {
  INTERNAL_FILE_MIME,
  captureTerminalFollowToken,
  captureExpandedPaneWidth,
  invalidateTerminalFollow,
  quotePathForCommand,
  shouldFollowTerminalOutput,
  shouldOpenInOsByName,
  updateTerminalScrollPosition,
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
const PREVIEW_FONT = {
  win32: '"Cascadia Mono", Consolas, "BIZ UDGothic", "MS Gothic", monospace',
  darwin: '"SF Mono", Menlo, Monaco, "Hiragino Sans", monospace',
  linux: '"Noto Sans Mono CJK JP", "DejaVu Sans Mono", "Liberation Mono", monospace',
}[PLATFORM];

const WIN_COMMANDS = ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'wsl.exe', 'claude', 'codex', 'devin', 'opencode'];
const UNIX_COMMANDS = ['bash', 'zsh', 'sh', 'claude', 'codex', 'devin', 'opencode'];
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
  'opencode': 'OpenCode',
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
const treeFilterInput = document.getElementById('tree-filter-input');
const treeFilterBar = document.getElementById('tree-filter-bar');
const treeSearchBtn = document.getElementById('tree-search-btn');
const treeFilterCloseBtn = document.getElementById('tree-filter-close-btn');
const treeFilterClearBtn = document.getElementById('tree-filter-clear-btn');
const navigationPane = document.getElementById('navigation-pane');
const tabBar = document.getElementById('main-tab-bar');
const mainSurface = document.getElementById('main-surface');
const terminalContainer = document.getElementById('terminal-container');
const terminalPane = document.getElementById('terminal-pane');
const newTabBtn = document.getElementById('new-tab-btn');
const editorPane = document.getElementById('editor-pane');
const editorTextarea = document.getElementById('editor-textarea');
const fileEditorPane = document.getElementById('file-editor-pane');
const fileEditorMount = document.getElementById('file-editor-mount');
const previewWebview = document.getElementById('preview-webview');
const previewPane = document.getElementById('preview-pane');
const searchPane = document.getElementById('search-pane');
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
const searchStatus = document.getElementById('search-status');
const searchCaseCheckbox = document.getElementById('search-case-checkbox');
const previewTabBar = tabBar;
const splitter = document.getElementById('splitter');
const contextMenu = document.getElementById('context-menu');
const tabContextMenu = document.getElementById('tab-context-menu');
const previewContextMenu = document.getElementById('preview-context-menu');
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
const confirmModal = document.getElementById('confirm-modal');
const confirmTitle = document.getElementById('confirm-title');
const confirmMessage = document.getElementById('confirm-message');
const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
const confirmOkBtn = document.getElementById('confirm-ok-btn');
let confirmResolve = null;
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
const statusSystem = document.getElementById('status-system');
const sendBtn = document.getElementById('send-btn');
const sendTarget = document.getElementById('send-target');
const pushFocusCheckbox = document.getElementById('push-focus-checkbox');
const titleBarContext = document.getElementById('title-bar-context');
const titleBarPath = document.getElementById('title-bar-path');
const appMenuBtn = document.getElementById('app-menu-btn');
const scratchCollapseBtn = document.getElementById('scratch-collapse-btn');
const toastRegion = document.getElementById('toast-region');
const errorRegion = document.getElementById('error-region');

const TAB_ICONS = {
  terminal: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 4 3.5 4L3 12M8 12h5"/></svg>',
  file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3"/></svg>',
  preview: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 8s2.2-4 6.2-4 6.2 4 6.2 4-2.2 4-6.2 4-6.2-4-6.2-4Z"/><circle cx="8" cy="8" r="1.8"/></svg>',
  browser: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M2.5 8h11M8 2c1.7 1.6 2.6 3.6 2.6 6S9.7 12.4 8 14M8 2C6.3 3.6 5.4 5.6 5.4 8s.9 4.4 2.6 6"/></svg>',
  scratch: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12.5h10M4 10l6.8-6.8 2 2L6 12H4z"/></svg>',
  search: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>',
};

const TREE_ICONS = {
  folder: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5h5l1.4 1.6h6.6v7.4h-13z"/></svg>',
  file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3.5h3"/></svg>',
};

function tabIcon(kind) {
  return `<span class="tab-icon tab-icon-${kind}">${TAB_ICONS[kind] || TAB_ICONS.file}</span>`;
}

function setTabSelected(tabEl, selected) {
  if (!tabEl) return;
  tabEl.classList.toggle('active', selected);
  tabEl.setAttribute('aria-selected', selected ? 'true' : 'false');
}

function activateMainTab(tabEl) {
  tabBar.querySelectorAll('.main-tab').forEach((el) => setTabSelected(el, el === tabEl));
}

// R3: shared tab element factory. The 4 tab kinds (preview, browser,
// editor-file, terminal) previously duplicated markup + event setup 4 times.
// This factory keeps them consistent without a base class. The terminal and
// webview mount strategies are NOT shared — callers still own those.
//
// kind: 'preview' | 'browser' | 'file' | 'terminal'
// ident: { key: 'path' | 'id', value: string|number } — dataset key/value
// label: visible tab name
// closeSelector: CSS selector for the close button inside the tab
// actions: { onSwitch(args), onClose(args), onContext(args, x, y) }
// extraInner: optional extra HTML inserted after the icon (e.g. dirty marker)
function createMainTab({ kind, ident, label, closeSelector, actions, extraInner = '' }) {
  const tabEl = document.createElement('div');
  const classByKind = {
    preview: 'preview-tab main-tab',
    browser: 'preview-tab main-tab browser-tab',
    file: 'editor-tab main-tab',
    terminal: 'tab main-tab',
    search: 'search-tab main-tab',
  };
  tabEl.className = classByKind[kind] || 'main-tab';
  tabEl.setAttribute('role', 'tab');
  tabEl.setAttribute('aria-selected', 'false');
  tabEl.dataset[ident.key] = ident.value;

  const statusInner = kind === 'terminal'
    ? '<span class="tab-status idle"></span>'
    : '';
  const notificationInner = (kind === 'preview' || kind === 'browser')
    ? '<span class="tab-notification"></span>'
    : '';
  const dirtyInner = kind === 'file'
    ? '<span class="editor-tab-dirty hidden">*</span>'
    : '';
  const labelClass = kind === 'terminal' ? 'tab-label' : 'editor-tab-name';
  const closeClass = kind === 'terminal' ? 'tab-close' : 'editor-tab-close';

  tabEl.innerHTML =
    `${tabIcon(kind)}` +
    `${extraInner}` +
    `<span class="${labelClass}">${escapeHtml(label)}</span>` +
    `${dirtyInner}` +
    `${statusInner}` +
    `${notificationInner}` +
    `<span class="${closeClass}">\u00d7</span>`;

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains(closeClass)) {
      actions.onClose(ident.value);
    } else {
      actions.onSwitch(ident.value);
    }
  });
  tabEl.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      actions.onClose(ident.value);
    }
  });
  tabEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    actions.onContext(ident.value, e.clientX, e.clientY);
  });
  return tabEl;
}

function showMainSurface(kind) {
  if (mainSurface.dataset.surface === 'preview' && kind !== 'preview') {
    queueVisiblePreviewScrollCapture();
  }
  terminalPane.classList.toggle('hidden', kind !== 'terminal');
  fileEditorPane.classList.toggle('hidden', kind !== 'file');
  previewPane.classList.toggle('hidden', kind !== 'preview');
  searchPane.classList.toggle('hidden', kind !== 'search');
  mainSurface.dataset.surface = kind;
  requestAnimationFrame(handleResize);
}

const visibleToasts = new Map();

function showToast({
  key = 'default',
  message,
  detail = '',
  type = 'info',
  duration = 1500,
  actionLabel = '',
  onAction = null,
  persistent = false,
}) {
  const previous = visibleToasts.get(key);
  if (previous) previous.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-glyph" aria-hidden="true">${type === 'error' ? '\u00d7' : (type === 'warn' ? '!' : '\u2713')}</span><span class="toast-message"></span>`;
  const messageEl = toast.querySelector('.toast-message');
  messageEl.textContent = message;
  if (detail) {
    const detailEl = document.createElement('span');
    detailEl.className = 'toast-detail';
    detailEl.textContent = detail;
    messageEl.append(' ', detailEl);
  }
  if (actionLabel && onAction) {
    const action = document.createElement('button');
    action.className = 'toast-action';
    action.textContent = actionLabel;
    action.addEventListener('click', () => {
      onAction();
      toast.remove();
      visibleToasts.delete(key);
    });
    toast.appendChild(action);
  } else if (persistent || type === 'error') {
    const dismiss = document.createElement('button');
    dismiss.className = 'toast-action toast-dismiss';
    dismiss.textContent = '\u00d7';
    dismiss.title = 'Dismiss';
    dismiss.addEventListener('click', () => {
      toast.remove();
      visibleToasts.delete(key);
    });
    toast.appendChild(dismiss);
  }
  const region = persistent || type === 'error' ? errorRegion : toastRegion;
  region.appendChild(toast);
  visibleToasts.set(key, toast);
  if (!persistent && duration > 0) {
    setTimeout(() => {
      if (visibleToasts.get(key) === toast) visibleToasts.delete(key);
      toast.remove();
    }, duration);
  }
  return toast;
}

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
  const isAgent = command === 'claude' || command === 'codex' || command === 'opencode';
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

function clearTerminalWaitingForUserInput(tabId) {
  const terminal = tabs.get(tabId);
  if (!terminal || !getTabAttention(tabId)?.waiting) return;
  dispatch('terminal_set_waiting', {
    tabId,
    projectId: terminal.projectId,
    waiting: false,
    cause: 'input',
  });
}

window.api.onPtyData(({ id, data }) => {
  for (const [tabId, t] of tabs) {
    if (t.ptyId === id) {
      const followToken = captureTerminalFollowToken(t);
      t.terminal.write(data, () => {
        if (tabs.get(tabId) === t && shouldFollowTerminalOutput(t, followToken)) {
          t.terminal.scrollToBottom();
        }
      });
      // PTY output can SET waiting (e.g. detecting a prompt pattern) but
      // must never CLEAR it. Tab switches trigger terminal resize → TUI
      // redraw → detectWaiting returns false, which would spuriously clear
      // the amber dot. Waiting is only cleared by real user input,
      // an explicit UserPromptSubmit, PTY exit, or tab close.
      const waiting = detectWaiting(t.command, data);
      const currentWaiting = Boolean(getTabAttention(tabId)?.waiting);
      if (waiting && !currentWaiting) {
        dispatch('terminal_set_waiting', { tabId, projectId: t.projectId, waiting: true, cause: 'output' });
      }
      return;
    }
  }
});

window.api.onPtyExit(({ id, exitCode }) => {
  for (const [tabId, t] of tabs) {
    if (t.ptyId === id) {
      t.terminal.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`);
      dispatch('terminal_set_waiting', { tabId, projectId: t.projectId, waiting: false, cause: 'exit' });
      dispatch('agent_session_unbound', { tabId });
      return;
    }
  }
});

// Hook-based waiting indicator (Claude Code Notification/Stop, Codex notify)
// R1: strict routing — only deliver to the tab whose PTY matches. When the
// main process cannot identify a unique PTY (no match or ambiguous cwd),
// show a persistent unattributed notice instead of fanning out to the
// active project's agent tabs.
window.api.onHookNotify(({ type, source, kind, reason, title, message, sessionId, cwd, ptyId, ambiguous }) => {
  // Match by ptyId (from cwd matching in main process)
  if (ptyId !== null && ptyId !== undefined) {
    for (const [tabId, t] of tabs) {
      if (t.ptyId === ptyId) {
        dispatch('agent_notification_received', {
          tabId,
          projectId: t.projectId,
          kind,
          eventType: type,
          source,
          reason,
          title,
          message,
          sessionId,
        });
        return;
      }
    }
    // ptyId was provided but no tab has it — the PTY may have been closed.
    // Fall through to unattributed notice.
  }
  // Unattributed or ambiguous: show a persistent notice instead of
  // guessing which tab should receive it.
  const label = ambiguous ? 'ambiguous cwd' : 'no matching terminal';
  const cwdDetail = cwd ? `cwd: ${cwd}` : 'cwd: unknown';
  showToast({
    key: `hook-unattributed-${type}`,
    message: `Agent notification (${type || 'unknown'}) — ${label}`,
    detail: cwdDetail,
    type: 'warn',
    persistent: true,
  });
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
      <span class="project-badge" data-id="${id}"></span>
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
  // R2: re-apply badge and waiting status from the store so a re-render
  // does not drop agent attention state that lives only in the store.
  for (const id of projects.keys()) {
    renderProjectBadge(id);
  }
  const attention = getTerminalAttentionSummary();
  for (const [pid, summary] of Object.entries(attention)) {
    if (summary.waiting > 0 || summary.unread > 0 || summary.failed > 0) updateProjectStatus(pid);
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
  focusedTreeEntry = null;
  setState({ activeProjectId });
  dispatch('project_set_badge', { projectId, kind: 'clear' });
  // タイトルは「どのプロジェクトか」。名前が主役で、パスは補助。
  // パスは画面の他のどこにも出ないため、同名プロジェクトや worktree の
  // 取り違えを防ぐ唯一の手がかりになる。
  const activeProject = projects.get(projectId);
  titleBarContext.textContent = activeProject?.name || '';
  titleBarPath.textContent = activeProject?.path || '';
  titleBarPath.title = activeProject?.path || '';
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
    // プロジェクトを跨ぐと展開状態は無意味になるので捨てる
    // Close filter bar and clear state so stale data doesn't leak across projects.
    closeTreeFilter();
    treeIndex = null;
    filterVisiblePaths = null;
    // Cancel any in-flight search and clear results so stale data
    // from the previous project doesn't reappear when reopening Search.
    searchGeneration++;
    if (currentSearchId) {
      window.api.cancelSearch(currentSearchId);
      currentSearchId = null;
    }
    if (searchResults) searchResults.innerHTML = '';
    if (searchStatus) searchStatus.textContent = '';
    if (searchInput) searchInput.value = '';
    await loadFileTree(p.path, { preserveState: false });
    // Phase 5 S1: build tree index for filtering (async, non-blocking).
    buildTreeIndex(p.path);
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

// 展開中のディレクトリを絶対パスで覚えておく。ツリーは再読込のたびに
// 作り直されるため、DOM 側に状態を持たせると毎回失われる。
const expandedTreePaths = new Set();

// Phase 5 S1: Tree filter state.
// treeIndex holds the flat recursive file listing from fs:indexTree.
// treeFilterActive tracks whether the filter is currently applied.
// savedExpansionState preserves the pre-filter expansion state for restoration.
let treeIndex = null; // { files, count, durationMs, truncated }
let treeFilterActive = false;
let savedExpansionState = null; // Set of expanded paths before filter
let filterTimeout = null;
let filterVisiblePaths = null; // Set of paths visible in current filter
let treeIndexGeneration = 0; // increments on each build to reject stale results

async function loadFileTree(dirPath, { preserveState = true } = {}) {
  const previousScroll = fileTree.scrollTop;
  const previousSelection = preserveState ? focusedTreeEntry?.path || null : null;
  if (!preserveState) expandedTreePaths.clear();

  fileTree.innerHTML = '';
  fileTree.setAttribute('role', 'tree');
  fileTree.setAttribute('aria-label', 'Project files');
  const entries = await window.api.readDir(dirPath);
  for (const entry of entries) {
    fileTree.appendChild(createTreeItem(entry, 0));
  }

  if (!preserveState) {
    focusedTreeEntry = null;
    return;
  }

  await restoreTreeExpansion(fileTree);
  restoreTreeSelection(previousSelection);
  fileTree.scrollTop = previousScroll;
}

// 展開状態は親から順に復元する。子は展開して初めて DOM に現れるため、
// 再帰的にたどる必要がある。
async function restoreTreeExpansion(container) {
  const items = Array.from(container.children).filter((el) => el.classList.contains('tree-item'));
  for (const el of items) {
    if (!el.dataset.isDirectory || !expandedTreePaths.has(el.dataset.path)) continue;
    await el.__pmExpand?.();
    const children = el.nextElementSibling;
    if (children?.classList.contains('tree-children')) {
      await restoreTreeExpansion(children);
    }
  }
}

function restoreTreeSelection(selectedPath) {
  if (!selectedPath) return;
  const el = fileTree.querySelector(`.tree-item[data-path="${cssEscape(selectedPath)}"]`);
  // 再読込中にフォーカスを奪うと入力中のターミナルからカーソルが飛ぶ。
  // 選択の見た目だけ戻し、キーボードフォーカスは動かさない。
  if (el) selectTreeEntry(el, el.__pmEntry, { focus: false });
}

function cssEscape(value) {
  return window.CSS?.escape ? window.CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

// ============================================================
// Phase 5 S1: Tree filter
// ============================================================

// Build (or rebuild) the tree index for the current project.
// Called on project selection, tree reload, and file/folder create/delete.
async function buildTreeIndex(dirPath) {
  if (!dirPath) return;
  const gen = ++treeIndexGeneration;
  try {
    const result = await window.api.indexTree(dirPath);
    // Reject stale results from a previous project switch.
    if (gen !== treeIndexGeneration) return;
    treeIndex = result;
    // If the user typed a filter while the index was building, reapply it.
    if (treeFilterInput && treeFilterInput.value && treeFilterInput.value.trim()) {
      applyTreeFilter(treeFilterInput.value);
    }
  } catch (e) {
    if (gen !== treeIndexGeneration) return;
    console.error('[tree-filter] indexTree failed:', e);
    treeIndex = null;
  }
}

// Apply a filter query to the file tree.
// Matches file names with partial (substring) matching.
// Folders that contain matching descendants are shown expanded.
function applyTreeFilter(query) {
  if (!query || !query.trim() || !treeIndex) {
    clearTreeFilter();
    return;
  }
  const lower = query.toLowerCase().trim();

  // Find matching files (substring match on name, not path).
  const matchingFiles = treeIndex.files.filter(
    (f) => !f.isDirectory && f.name.toLowerCase().includes(lower),
  );

  if (matchingFiles.length === 0) {
    // Show empty tree with a "no results" message.
    if (!treeFilterActive) {
      savedExpansionState = new Set(expandedTreePaths);
      treeFilterActive = true;
    }
    expandedTreePaths.clear();
    fileTree.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'tree-filter-empty';
    empty.textContent = 'No matching files';
    fileTree.appendChild(empty);
    return;
  }

  // Build a path→entry map for O(1) ancestor lookup.
  const pathMap = new Map();
  for (const f of treeIndex.files) {
    pathMap.set(f.path, f);
  }

  // Collect all paths that need to be visible:
  // matching files + all their ancestor directories.
  const visiblePaths = new Set();
  for (const m of matchingFiles) {
    visiblePaths.add(m.path);
    let p = m.parentPath;
    while (p) {
      visiblePaths.add(p);
      const parent = pathMap.get(p);
      p = parent?.parentPath || null;
    }
  }
  filterVisiblePaths = visiblePaths;

  // Save expansion state on first filter activation.
  if (!treeFilterActive) {
    savedExpansionState = new Set(expandedTreePaths);
    treeFilterActive = true;
  }

  // Render filtered tree: all visible paths are shown expanded.
  expandedTreePaths.clear();
  for (const p of visiblePaths) expandedTreePaths.add(p);

  fileTree.innerHTML = '';
  fileTree.setAttribute('role', 'tree');
  fileTree.setAttribute('aria-label', 'Project files (filtered)');

  // Build a parent->children map from the index for efficient rendering.
  const childrenMap = new Map(); // parentPath -> [entries]
  for (const f of treeIndex.files) {
    if (!visiblePaths.has(f.path)) continue;
    const parent = f.parentPath || null;
    if (!childrenMap.has(parent)) childrenMap.set(parent, []);
    childrenMap.get(parent).push(f);
  }

  // Render top-level entries (parentPath === null).
  renderFilteredChildren(null, 0, childrenMap, fileTree);
}

function renderFilteredChildren(parentPath, depth, childrenMap, container) {
  const children = childrenMap.get(parentPath) || [];
  for (const entry of children) {
    const item = createTreeItem(entry, depth);
    container.appendChild(item);
    if (entry.isDirectory) {
      // Mark as expanded and recursively render children.
      item.dataset.expanded = 'true';
      item.setAttribute('aria-expanded', 'true');
      const childContainer = document.createElement('div');
      childContainer.className = 'tree-children';
      childContainer.setAttribute('role', 'group');
      renderFilteredChildren(entry.path, depth + 1, childrenMap, childContainer);
      container.appendChild(childContainer);
    }
  }
}

// Clear the filter state. Does NOT reload the tree — callers are
// responsible for calling loadFileTree() afterwards. This prevents
// double-rendering when callers also call loadFileTree().
function clearTreeFilter() {
  if (!treeFilterActive) return;
  treeFilterActive = false;
  filterVisiblePaths = null;
  expandedTreePaths.clear();
  if (savedExpansionState) {
    for (const p of savedExpansionState) expandedTreePaths.add(p);
    savedExpansionState = null;
  }
}

// Return the set of paths visible in the current filter.
// Used by expandEntry to show only filtered children when opening folders.
function getVisiblePathsForFilter() {
  return filterVisiblePaths || new Set();
}

// Toggle the filter bar visibility.
function toggleTreeFilter() {
  if (treeFilterBar.classList.contains('hidden')) {
    treeFilterBar.classList.remove('hidden');
    treeFilterInput.focus();
    treeFilterInput.select();
  } else {
    closeTreeFilter();
    // Reload the tree to show the full (unfiltered) view.
    const project = projects.get(activeProjectId);
    if (project) loadFileTree(project.path);
  }
}

// Close the filter bar and clear the filter state.
// Does NOT reload the tree — callers are responsible for calling
// loadFileTree() if they need the tree re-rendered. This prevents
// double-rendering when the caller also calls loadFileTree().
function closeTreeFilter() {
  treeFilterBar.classList.add('hidden');
  treeFilterInput.value = '';
  treeFilterClearBtn.classList.add('hidden');
  clearTreeFilter();
}

// Clear the filter input but keep the bar open.
// Reloads the tree to show the full (unfiltered) view.
function clearFilterInput() {
  treeFilterInput.value = '';
  treeFilterClearBtn.classList.add('hidden');
  if (treeFilterActive) {
    clearTreeFilter();
    const project = projects.get(activeProjectId);
    if (project) loadFileTree(project.path);
  }
  treeFilterInput.focus();
}

// Debounced filter input handler.
if (treeFilterInput) {
  treeFilterInput.addEventListener('input', () => {
    // Show/hide clear button based on input content.
    if (treeFilterInput.value) {
      treeFilterClearBtn.classList.remove('hidden');
    } else {
      treeFilterClearBtn.classList.add('hidden');
    }
    clearTimeout(filterTimeout);
    filterTimeout = setTimeout(() => {
      const query = treeFilterInput.value;
      if (!query || !query.trim()) {
        // Empty query: restore the normal tree.
        if (treeFilterActive) {
          clearTreeFilter();
          const project = projects.get(activeProjectId);
          if (project) loadFileTree(project.path);
        }
        return;
      }
      applyTreeFilter(query);
    }, 80);
  });
  // Escape in the filter input is handled by the keybinding registry
  // (tree_filter_clear, when: treeFocus). No individual handler needed.
}

// Search button toggles the filter bar.
if (treeSearchBtn) {
  treeSearchBtn.addEventListener('click', () => {
    toggleTreeFilter();
  });
}

// Close button in the filter bar.
if (treeFilterCloseBtn) {
  treeFilterCloseBtn.addEventListener('click', () => {
    closeTreeFilter();
  });
}

// Clear button inside the input.
if (treeFilterClearBtn) {
  treeFilterClearBtn.addEventListener('click', () => {
    clearFilterInput();
  });
}

let focusedTreeEntry = null;

function selectTreeEntry(el, entry, { focus = true } = {}) {
  fileTree.querySelectorAll('.tree-item[aria-selected="true"]').forEach((item) => {
    item.setAttribute('aria-selected', 'false');
    item.tabIndex = -1;
  });
  focusedTreeEntry = entry;
  el.setAttribute('aria-selected', 'true');
  el.tabIndex = 0;
  if (focus) el.focus();
}

function getTreeCreateParent(projectPath) {
  if (!focusedTreeEntry) return projectPath;
  return focusedTreeEntry.isDirectory
    ? focusedTreeEntry.path
    : pathDirname(focusedTreeEntry.path);
}

// ============================================================
// File tree header actions
// ============================================================

treeReloadBtn.addEventListener('click', async () => {
  const project = projects.get(activeProjectId);
  if (!project) return;
  // Close filter bar so reload shows the full tree, not stale filtered view.
  closeTreeFilter();
  await loadFileTree(project.path);
  buildTreeIndex(project.path);
});

treeNewFileBtn.addEventListener('click', async () => {
  const project = projects.get(activeProjectId);
  if (!project) return;
  const parentPath = getTreeCreateParent(project.path);
  const name = await showPrompt('New File', `Create in: ${parentPath}`, '');
  if (!name) return;
  const filePath = joinPath(parentPath, name);
  const result = await window.api.createFile(filePath);
  if (!result.success) {
    showToast({ key: 'create-file-error', message: 'Create file failed', detail: result.error, type: 'error', persistent: true });
    return;
  }
  // 作成先が畳まれていると結果が見えないので開いておく
  if (parentPath !== project.path) expandedTreePaths.add(parentPath);
  closeTreeFilter();
  await loadFileTree(project.path);
  buildTreeIndex(project.path);
  openFileInEditor(filePath, name.split(/[\\/]/).pop());
});

treeNewFolderBtn.addEventListener('click', async () => {
  const project = projects.get(activeProjectId);
  if (!project) return;
  const parentPath = getTreeCreateParent(project.path);
  const name = await showPrompt('New Folder', `Create in: ${parentPath}`, '');
  if (!name) return;
  const dirPath = joinPath(parentPath, name);
  const result = await window.api.createDir(dirPath);
  if (!result.success) {
    showToast({ key: 'create-folder-error', message: 'Create folder failed', detail: result.error, type: 'error', persistent: true });
    return;
  }
  if (parentPath !== project.path) expandedTreePaths.add(parentPath);
  closeTreeFilter();
  await loadFileTree(project.path);
  buildTreeIndex(project.path);
});

function createTreeItem(entry, depth) {
  const el = document.createElement('div');
  el.className = 'tree-item';
  el.style.paddingLeft = (12 + depth * 16) + 'px';
  el.tabIndex = -1;
  el.setAttribute('role', 'treeitem');
  el.setAttribute('aria-selected', 'false');
  if (entry.isDirectory) el.setAttribute('aria-expanded', 'false');
  // 再読込後に状態を復元するための手がかり
  el.dataset.path = entry.path;
  if (entry.isDirectory) el.dataset.isDirectory = 'true';
  el.__pmEntry = entry;
  // A6: tooltip with full path
  el.title = entry.path;
  el.innerHTML = `<span class="tree-icon">${entry.isDirectory ? TREE_ICONS.folder : TREE_ICONS.file}</span><span class="tree-name">${escapeHtml(entry.name)}</span>`;

  const expandEntry = async () => {
    if (!entry.isDirectory || el.dataset.expanded === 'true') return;
    el.dataset.expanded = 'true';
    el.setAttribute('aria-expanded', 'true');
    expandedTreePaths.add(entry.path);

    let children;
    if (treeFilterActive && treeIndex) {
      // フィルタ中はインデックスからフィルタ済みの子を取得する。
      // readDir を使うと未フィルタの全子要素で上書きされてしまう。
      const visiblePaths = getVisiblePathsForFilter();
      children = treeIndex.files.filter(
        (f) => f.parentPath === entry.path && visiblePaths.has(f.path),
      );
    } else {
      children = await window.api.readDir(entry.path);
    }
    const container = document.createElement('div');
    container.className = 'tree-children';
    container.setAttribute('role', 'group');
    for (const child of children) {
      container.appendChild(createTreeItem(child, depth + 1));
    }
    el.after(container);
  };

  const collapseEntry = () => {
    if (!entry.isDirectory) return;
    el.dataset.expanded = 'false';
    el.setAttribute('aria-expanded', 'false');
    expandedTreePaths.delete(entry.path);
    const next = el.nextElementSibling;
    if (next && next.classList.contains('tree-children')) next.remove();
  };

  // 再読込時に外から展開を復元できるようにする
  el.__pmExpand = expandEntry;

  const activateEntry = async () => {
    if (entry.isDirectory) {
      if (el.dataset.expanded === 'true') collapseEntry();
      else await expandEntry();
    } else {
      dispatch('open_preview', { path: entry.path, name: entry.name });
    }
  };

  el.addEventListener('click', async () => {
    selectTreeEntry(el, entry);
    if (entry.isDirectory) await activateEntry();
  });

  el.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    await activateEntry();
  });

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // 右クリックした対象を選択状態にする。メニューの操作対象と、
    // 新規作成の親（getTreeCreateParent）が見えているものと一致する。
    selectTreeEntry(el, entry);
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
      selectTreeEntry(el, entry);
      activateEntry();
    });
  }

  return el;
}

function insertPathToTerminal(filePath) {
  if (activeTabId === null) return;
  const t = tabs.get(activeTabId);
  if (t) {
    window.api.ptyWrite(t.ptyId, filePath);
    clearTerminalWaitingForUserInput(activeTabId);
  }
}

function insertNameToTerminal(filePath) {
  if (activeTabId === null) return;
  const t = tabs.get(activeTabId);
  if (t) {
    const name = filePath.split(/[\\/]/).pop();
    window.api.ptyWrite(t.ptyId, name);
    clearTerminalWaitingForUserInput(activeTabId);
  }
}

// ============================================================
// Context menu
// ============================================================

let contextMenuEntry = null;

function showContextMenu(x, y, entry) {
  hideTabContextMenu();
  contextMenuEntry = entry;
  contextMenu.querySelector('[data-action="preview"]').classList.toggle('hidden', entry.isDirectory);
  contextMenu.querySelector('[data-action="edit"]').classList.toggle('hidden', entry.isDirectory);
  contextMenu.querySelector('[data-action="open-os"]').classList.toggle('hidden', entry.isDirectory);
  contextMenu.querySelector('[data-action="open-explorer"]').classList.toggle('hidden', !entry.isDirectory);
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
  } else if (action === 'open-explorer' && contextMenuEntry.isDirectory) {
    window.api.openInOs(contextMenuEntry.path);
  } else if (action === 'copy-path') {
    window.api.clipboardWriteText(contextMenuEntry.path);
    showToast({ key: 'copy-path', message: 'Path copied', detail: contextMenuEntry.path });
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
    case 'terminal': {
      const terminal = tabs.get(target.tabId);
      const binding = getTerminalAgentBinding(target.tabId);
      const isDevin = isDevinCommand(terminal?.command);
      const items = [
        { action: 'rename', label: 'Rename Tab' },
      ];
      if (isDevin) {
        items.push(binding
          ? { action: 'unbind-devin', label: 'Unbind Devin Cloud Session' }
          : { action: 'bind-devin', label: 'Bind Devin Cloud Session…' });
      }
      items.push({ action: 'copy-cwd', label: 'Copy cwd' });
      items.push({ action: 'close', label: 'Close', danger: true });
      return items;
    }
    case 'preview':
    case 'editor-file':
      return [
        { action: 'copy-path', label: 'Copy Path' },
        { action: 'open-os', label: 'Open in OS' },
        { action: 'close', label: 'Close', danger: true },
      ];
    case 'browser':
      return [
        { action: 'copy-path', label: 'Copy URL' },
        { action: 'close', label: 'Close', danger: true },
      ];
    case 'search':
      return [
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
    else if (t.kind === 'preview' || t.kind === 'browser') closePreviewTab(t.previewPath);
    else if (t.kind === 'editor-file') closeEditorTab(t.filePath);
    else if (t.kind === 'search') closeSearchTab();
  } else if (action === 'copy-path') {
    if (t.filePath) {
      window.api.clipboardWriteText(t.filePath);
      showToast({ key: 'copy-path', message: 'Path copied', detail: t.filePath });
    }
  } else if (action === 'open-os') {
    if (t.filePath) window.api.openInOs(t.filePath);
  } else if (action === 'copy-cwd') {
    const term = tabs.get(t.tabId);
    if (term?.cwd) {
      window.api.clipboardWriteText(term.cwd);
      showToast({ key: 'copy-cwd', message: 'Working directory copied', detail: term.cwd });
    }
  } else if (action === 'rename') {
    if (t.kind === 'terminal') renameTerminalTab(t.tabId);
  } else if (action === 'bind-devin') {
    void bindDevinSession(t.tabId);
  } else if (action === 'unbind-devin') {
    void unbindDevinSession(t.tabId);
  }
});

function isDevinCommand(command) {
  const executable = String(command || '').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  return executable === 'devin';
}

async function bindDevinSession(tabId) {
  const terminal = tabs.get(tabId);
  if (!terminal) return;
  const current = getTerminalAgentBinding(tabId);
  const sessionId = await showPrompt(
    'Connect Devin Notifications',
    'Devin Cloud session ID (devin-...) or session URL:',
    current?.sessionId || '',
  );
  if (!sessionId) return;
  const result = await window.api.devinBind(terminal.ptyId, sessionId);
  if (!result?.ok) {
    showToast({
      key: `devin-bind-${tabId}`,
      message: 'Could not bind Devin session',
      detail: result?.error || 'Unknown error',
      type: 'error',
      persistent: true,
    });
    return;
  }
  dispatch('agent_session_bound', { tabId, ...result.binding });
  showToast({
    key: `devin-bound-${tabId}`,
    message: 'Devin Cloud session connected',
    detail: result.binding.sessionId,
  });
}

async function unbindDevinSession(tabId) {
  const terminal = tabs.get(tabId);
  if (!terminal) return;
  await window.api.devinUnbind(terminal.ptyId);
  dispatch('agent_session_unbound', { tabId });
  showToast({ key: `devin-unbound-${tabId}`, message: 'Devin Cloud session disconnected' });
}

document.addEventListener('click', () => hideTabContextMenu());
document.addEventListener('click', () => previewContextMenu.classList.add('hidden'));
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('#tab-context-menu')) hideTabContextMenu();
  if (!e.target.closest('#preview-context-menu')) previewContextMenu.classList.add('hidden');
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

// ============================================================
// Delete confirmation modal
// ============================================================

let pendingDeleteEntry = null;

function showDeleteConfirm(entry) {
  pendingDeleteEntry = entry;
  const typeStr = entry.isDirectory ? 'folder' : 'file';
  deleteConfirmMessage.innerHTML = `Are you sure you want to delete this ${typeStr}?<br><code>${escapeHtml(entry.path)}</code>`;
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
    showToast({ key: 'delete-error', message: 'Delete failed', detail: result.error, type: 'error', persistent: true });
    return;
  }
  // Close editor tab if the deleted file was open
  if (openFiles.has(entry.path)) {
    closeEditorTab(entry.path);
  }
  // Refresh file tree
  const project = projects.get(activeProjectId);
  if (project) {
    closeTreeFilter();
    await loadFileTree(project.path);
    buildTreeIndex(project.path);
  }
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
// Confirm modal (yes/no confirmation for external link navigation etc.)
// ============================================================

function showConfirm(title, message) {
  return new Promise((resolve) => {
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmResolve = resolve;
    confirmModal.classList.remove('hidden');
    setTimeout(() => confirmOkBtn.focus(), 0);
  });
}

function hideConfirm(value) {
  confirmModal.classList.add('hidden');
  const r = confirmResolve;
  confirmResolve = null;
  if (r) r(value);
}

confirmCancelBtn.addEventListener('click', () => hideConfirm(false));
confirmOkBtn.addEventListener('click', () => hideConfirm(true));
confirmModal.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    hideConfirm(false);
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    hideConfirm(true);
  }
});

// ============================================================
// Editor management (D8: tabs below terminal, scratch = Composer)
// ============================================================

const SCRATCH_PATH = '__scratch__';
// path -> { path, name, content, originalContent, state, scrollTop, tabEl, isScratch }
// Main files: `state` (CM6 EditorState) is authoritative; `content` mirrors
// state.doc for legacy readers and scratch. Scratch stays a plain string.
let openFiles = new Map();
let previewFiles = new Map(); // previewPath -> { path, name, tabEl, isPreview, previewPath, projectId }
let activeFilePath = null;
let activePreviewPath = null;
let activeSurface = 'editor'; // 'editor' | 'preview', restored per project
let activeComposerPath = SCRATCH_PATH;
let activeMainView = 'terminal'; // 'terminal' | 'file' | 'preview'
let activeMainFilePath = null;
let previewReturnView = 'terminal';
let previewReturnFilePath = null;
let lastSentContent = '';
let lastSentTabPath = null;
let agentPreviewCounter = 0;
const projectEditorStates = new Map();
let activeEditorProjectId = null;
let editorStateInitialized = false;
const SCRATCH_COMPACT_HEIGHT = 112;
const SCRATCH_DEFAULT_EXPANDED_HEIGHT = 220;
let savedScratchEditorHeight = SCRATCH_DEFAULT_EXPANDED_HEIGHT;
let scratchCollapsed = false;
let scratchExpanded = false;

let draggedEditorTab = null;

// Phase 4.5 A1/A2: single CM6 EditorView; per-file EditorState lives in
// openFiles entries and is swapped in via setState on tab switch.
let currentlyMountedPath = null;

const editorKit = createEditorKit({
  parent: fileEditorMount,
  doc: '',
  onDocChanged: (update) => {
    const f = openFiles.get(currentlyMountedPath);
    if (!f) return;
    f.state = update.state;
    f.content = update.state.doc.toString();
    dispatch('update_editor_content', { filePath: f.path, content: f.content });
  },
  onSelectionChanged: () => dispatch('update_editor_selection'),
});
const fileEditorView = editorKit.view;

function syncMountedFileScroll() {
  const f = currentlyMountedPath !== null ? openFiles.get(currentlyMountedPath) : null;
  if (f) f.scrollTop = fileEditorView.scrollDOM.scrollTop;
}

function mountFileDoc(f, { focus = true } = {}) {
  syncMountedFileScroll();
  currentlyMountedPath = f.path;
  if (fileEditorView.state !== f.state) {
    fileEditorView.setState(f.state);
  }
  fileEditorView.scrollDOM.scrollTop = f.scrollTop || 0;
  updateEditorDirty(f.path);
  if (focus) fileEditorView.focus();
  requestAnimationFrame(() => fileEditorView.requestMeasure());
  updateEditorCursorState();
}

function saveCurrentEditorState() {
  if (!editorStateInitialized) return;
  projectEditorStates.set(activeEditorProjectId, {
    openFiles,
    activeFilePath,
    activePreviewPath,
    activeSurface,
    activeComposerPath,
    activeMainView,
    activeMainFilePath,
    previewReturnView,
    previewReturnFilePath,
    lastSentContent,
    lastSentTabPath,
  });
}

function switchProjectEditor(projectId) {
  if (editorStateInitialized && activeEditorProjectId === projectId) return;

  saveCurrentEditorState();
  syncMountedFileScroll();
  openFiles.forEach((f) => { if (f.tabEl) f.tabEl.style.display = 'none'; });
  // Hide all preview tabs, will show matching ones below
  previewFiles.forEach((f) => { f.tabEl.style.display = 'none'; });

  activeEditorProjectId = projectId;
  const state = projectEditorStates.get(projectId);
  if (state) {
    openFiles = state.openFiles;
    activeFilePath = state.activeFilePath;
    activePreviewPath = getPreviewForProject(previewFiles, projectId, state.activePreviewPath);
    activeSurface = state.activeSurface === 'preview' && activePreviewPath ? 'preview' : 'editor';
    activeComposerPath = state.activeComposerPath && state.openFiles.has(state.activeComposerPath)
      ? state.activeComposerPath
      : SCRATCH_PATH;
    activeMainView = state.activeMainView || 'terminal';
    activeMainFilePath = state.activeMainFilePath && state.openFiles.has(state.activeMainFilePath)
      ? state.activeMainFilePath
      : null;
    previewReturnView = state.previewReturnView || 'terminal';
    previewReturnFilePath = state.previewReturnFilePath && state.openFiles.has(state.previewReturnFilePath)
      ? state.previewReturnFilePath
      : null;
    lastSentContent = state.lastSentContent;
    lastSentTabPath = state.lastSentTabPath;
    openFiles.forEach((f) => { if (f.tabEl) f.tabEl.style.display = ''; });
  } else {
    openFiles = new Map();
    activeFilePath = null;
    activePreviewPath = null;
    activeSurface = 'editor';
    activeComposerPath = SCRATCH_PATH;
    activeMainView = 'terminal';
    activeMainFilePath = null;
    previewReturnView = 'terminal';
    previewReturnFilePath = null;
    lastSentContent = '';
    lastSentTabPath = null;
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
  const composer = openFiles.get(activeComposerPath) || openFiles.get(SCRATCH_PATH);
  if (composer) selectComposerTab(composer, { focus: false });
  if (activeMainView === 'preview' && activePreviewPath) {
    switchPreviewTab(activePreviewPath);
  } else if (activeMainView === 'file' && activeMainFilePath) {
    switchEditorTab(activeMainFilePath, { focus: false });
  } else {
    const terminalId = projectActiveTab.get(projectId);
    if (terminalId !== undefined && tabs.has(terminalId)) switchTab(terminalId, { focus: false });
    else showMainSurface('terminal');
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
    activeComposerPath = SCRATCH_PATH;
    activeMainView = 'terminal';
    activeMainFilePath = null;
    previewReturnView = 'terminal';
    previewReturnFilePath = null;
    lastSentContent = '';
    lastSentTabPath = null;
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
    tabEl.parentElement?.querySelectorAll('.editor-tab').forEach(t => t.classList.remove('drag-over'));
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
    if (draggedEditorTab.parentElement === tabEl.parentElement) {
      tabEl.parentElement.insertBefore(draggedEditorTab, tabEl);
    }
  });
}

function initScratchTab() {
  const tabEl = document.createElement('div');
  tabEl.dataset.path = SCRATCH_PATH;

  const scratchData = {
    path: SCRATCH_PATH,
    name: 'scratch',
    content: '',
    originalContent: '',
    tabEl,
    isScratch: true,
  };
  openFiles.set(SCRATCH_PATH, scratchData);
  activeFilePath = SCRATCH_PATH;
  activeComposerPath = SCRATCH_PATH;
  showEditorPane();
}

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

function fileUrlToPath(url) {
  // file:///D:/path -> D:\path (Windows)
  // file:///path -> /path (Unix)
  let p = url.replace(/^file:\/\//, '');
  // 先頭の / を取り除いてからOSのセパレータに戻す
  // Windows: /D:/path -> D:\path
  // Unix: /path -> /path
  if (IS_WIN && /^\/[A-Za-z]:/.test(p)) {
    p = p.slice(1); // 先頭の / を削除
  }
  return IS_WIN ? p.replace(/\//g, '\\') : p;
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
body { margin:0; padding:24px; color:#c8ccd4; background:#1c1f24; font-family:${PREVIEW_FONT}; font-size:13px; line-height:1.6; }
a { color:#4d8480; }
h1,h2,h3,h4,h5,h6 { color:#f0f2f5; margin-top:24px; margin-bottom:16px; line-height:1.25; }
h1 { font-size:2em; border-bottom:1px solid #2e333b; padding-bottom:.3em; }
h2 { font-size:1.5em; border-bottom:1px solid #2e333b; padding-bottom:.3em; }
code { background:#23272e; padding:.2em .4em; border-radius:6px; font-family:${PREVIEW_FONT}; font-size:85%; }
pre { background:#23272e; padding:16px; border-radius:6px; overflow:auto; }
pre code { background:transparent; padding:0; font-size:100%; }
blockquote { border-left:4px solid #2e333b; color:#6b7280; margin:0; padding:0 16px; }
table { border-collapse:collapse; }
th,td { border:1px solid #2e333b; padding:6px 13px; }
img { max-width:100%; }
hr { border:0; border-top:1px solid #2e333b; }
`;

function getPreviewScrollbarCss() {
  const tokens = getComputedStyle(document.documentElement);
  const names = [
    '--scrollbar-size',
    '--scrollbar-border',
    '--scrollbar-radius',
    '--scrollbar-track',
    '--scrollbar-thumb',
    '--scrollbar-thumb-hover',
  ];
  const resolveToken = (name, seen = new Set()) => {
    if (seen.has(name)) return '';
    seen.add(name);
    return tokens.getPropertyValue(name).trim().replace(/var\((--[\w-]+)\)/g, (_match, nested) => (
      resolveToken(nested, seen)
    ));
  };
  const guestTokens = names.map((name) => `${name}:${resolveToken(name)};`).join('');
  return `:root{${guestTokens}}\n${sharedScrollbarCss}`;
}

// ページ内アンカー（目次リンク）を自前で処理する。
// <base> を置いているため `#foo` は file:// のベース URL に解決され、
// 素のままだとページ内移動ではなく「別ページへの遷移」になってしまう。
// executeJavaScript はページの CSP の影響を受けないので注入できる。
//
// ついでに:
// - 全リンクのクリックを preventDefault し、webview のナビゲーションを阻止する。
//   <webview> の will-navigate の preventDefault() は効かないため、
//   ゲストページ側でクリックを止める必要がある。
// - リンクURLは console.log の特殊プレフィックス経由でrendererに通知する。
// - contextmenu イベントをキャッチし、選択テキストとリンクURLを
//   window.__pmContextMenu に保存する。
const PREVIEW_ANCHOR_SCRIPT = `(() => {
  if (window.__pmAnchorsBound) return true;
  window.__pmAnchorsBound = true;
  document.addEventListener('click', (event) => {
    const link = event.target.closest && event.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#') && href !== '#') {
      event.preventDefault();
      let id = href.slice(1);
      try { id = decodeURIComponent(id); } catch (e) { /* 生の値のまま使う */ }
      const target = document.getElementById(id)
        || document.getElementsByName(id)[0]
        || document.getElementById(href.slice(1));
      if (target) target.scrollIntoView({ block: 'start' });
      return;
    }
    // 全リンクのデフォルト遷移を阻止。
    // will-navigate の preventDefault() が <webview> で効かないため。
    event.preventDefault();
    // リンクURLを console.log 経由で renderer に通知。
    // CSP で postMessage が使えないため、console-message イベントで受ける。
    const url = link.href;
    if (url) console.log('__pm_navigate:' + url);
  }, true);
  document.addEventListener('contextmenu', (event) => {
    const link = event.target.closest && event.target.closest('a[href]');
    const selection = window.getSelection ? window.getSelection().toString() : '';
    window.__pmContextMenu = {
      clientX: event.clientX,
      clientY: event.clientY,
      linkHref: link ? link.href : null,
      linkText: link ? link.textContent : null,
      hasSelection: !!(selection && selection.trim()),
      selection: selection || '',
    };
  }, true);
  return true;
})()`;

previewWebview.addEventListener('dom-ready', () => {
  previewWebview.insertCSS(getPreviewScrollbarCss()).catch((error) => {
    console.warn('[preview] Failed to apply scrollbar style:', error);
  });
  previewWebview.executeJavaScript(PREVIEW_ANCHOR_SCRIPT).catch((error) => {
    console.warn('[preview] Failed to bind in-page anchors:', error);
  });
});

// プレビュー内のナビゲーションを制御する。
// ゲストページ側でクリックを preventDefault しているので、
// webview の will-navigate は発火しない（または発火しても無視）。
// リンクURLは console.log の特殊プレフィックス経由で通知される。
//
// - file:// の相対リンク → PM のプレビュー機構で開く
// - http(s):// の外部リンク → モーダルで確認してから OS ブラウザで開く
// - それ以外 → 無視
previewWebview.addEventListener('console-message', async (e) => {
  // e.message はゲストページの console.log の出力
  const msg = e.message;
  if (!msg || typeof msg !== 'string') return;
  const prefix = '__pm_navigate:';
  if (!msg.startsWith(prefix)) return;
  const url = msg.slice(prefix.length).trim();

  if (url.startsWith('file://')) {
    try {
      const filePath = fileUrlToPath(url);
      const name = filePath.split(/[/\\]/).pop();
      dispatch('open_preview', { path: filePath, name });
    } catch (error) {
      console.warn('[preview] Failed to handle navigation to', url, error);
    }
    return;
  }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    const ok = await showConfirm('Open external link?', url);
    if (ok) {
      window.api.openInOs(url);
    }
    return;
  }

  // その他のプロトコル（mailto:, tel: 等）は無視
});

// will-navigate はフォールバック。ゲスト側で preventDefault できなかった
// 場合（JS無効化時など）の最終防波堤。ただし <webview> では
// preventDefault() が効かないことがあるため、ここで止められない場合は
// console-message 経由の処理に頼る。
previewWebview.addEventListener('will-navigate', (e) => {
  const url = e.url;
  if (!url || url === previewWebview.src) return;
  // ゲスト側で処理済みのはずなので、念のためブロックだけする
  e.preventDefault();
});

// ============================================================
// Preview context menu (copy selection, link actions)
// ============================================================

let previewContextInfo = null;

previewWebview.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  // ゲストページから contextmenu 情報を取得
  try {
    const info = await previewWebview.executeJavaScript(`window.__pmContextMenu || null`);
    previewContextInfo = info;
  } catch {
    previewContextInfo = null;
  }

  // webviewの座標系はゲストページ内。rendererの座標系に変換するため、
  // webview要素の画面上の位置を加える。
  const rect = previewWebview.getBoundingClientRect();
  const x = rect.left + (info?.clientX || e.clientX - rect.left);
  const y = rect.top + (info?.clientY || e.clientY - rect.top);

  showPreviewContextMenu(x, y, previewContextInfo);
});

function showPreviewContextMenu(x, y, info) {
  previewContextMenu.innerHTML = '';
  const items = [];

  // 選択テキストがある場合：コピー
  if (info?.hasSelection) {
    items.push({ action: 'copy-selection', label: 'Copy' });
  }

  // リンク上の場合：URL関連のメニュー
  if (info?.linkHref) {
    const href = info.linkHref;
    if (items.length > 0) items.push({ separator: true });
    items.push({ action: 'link-open-tab', label: 'Open Link in New Tab', url: href });
    items.push({ action: 'link-open-browser', label: 'Open Link in Browser', url: href });
    items.push({ action: 'link-open-os', label: 'Open Link in OS', url: href });
    items.push({ action: 'link-copy', label: 'Copy Link Address', url: href });
  }

  if (items.length === 0) return;

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      previewContextMenu.appendChild(sep);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'context-menu-item';
    el.dataset.action = item.action;
    if (item.url) el.dataset.url = item.url;
    el.textContent = item.label;
    previewContextMenu.appendChild(el);
  }

  previewContextMenu.classList.remove('hidden');
  previewContextMenu.style.left = Math.min(x, window.innerWidth - 200) + 'px';
  previewContextMenu.style.top = Math.min(y, window.innerHeight - 200) + 'px';
}

previewContextMenu.addEventListener('click', async (e) => {
  const item = e.target.closest('.context-menu-item');
  if (!item) return;
  const action = item.dataset.action;
  const url = item.dataset.url;
  previewContextMenu.classList.add('hidden');

  if (action === 'copy-selection' && previewContextInfo?.selection) {
    try {
      await navigator.clipboard.writeText(previewContextInfo.selection);
      showToast({ key: 'preview-copy', message: 'Copied' });
    } catch {}
  } else if (action === 'link-open-tab' && url) {
    // file:// はPMのプレビューで開く、http(s):// はブラウザタブで開く
    if (url.startsWith('file://')) {
      try {
        const filePath = fileUrlToPath(url);
        const name = filePath.split(/[/\\]/).pop();
        dispatch('open_preview', { path: filePath, name });
      } catch {}
    } else {
      // ブラウザタブとして開く
      openBrowserUrl(url);
    }
  } else if (action === 'link-open-browser' && url) {
    const ok = await showConfirm('Open external link?', url);
    if (ok) window.api.openInOs(url);
  } else if (action === 'link-open-os' && url) {
    const ok = await showConfirm('Open external link?', url);
    if (ok) window.api.openInOs(url);
  } else if (action === 'link-copy' && url) {
    try {
      await navigator.clipboard.writeText(url);
      showToast({ key: 'preview-copy', message: 'Copied', detail: url });
    } catch {}
  }
});

async function openFileInPreview(filePath, name, options = {}) {
  const projectId = options.projectId ?? activeEditorProjectId;
  const activate = options.activate !== false;
  const allowOs = options.allowOs !== false;
  const previewPath = options.previewPath || makePreviewPath(projectId, filePath);
  if (shouldOpenInOsByName(name)) {
    if (allowOs) {
      await window.api.openInOs(filePath);
      showToast({ key: `open-os:${filePath}`, message: 'Opened with the default app', detail: name });
    }
    return { shown: false, previewPath: null, reason: 'file type is not supported by the preview' };
  }
  if (previewFiles.has(previewPath)) {
    let loaded = true;
    if (activate) {
      loaded = await switchPreviewTab(previewPath, { preserveAttention: options.preserveAttention });
    }
    return {
      shown: loaded && activate && activeEditorProjectId === projectId && activePreviewPath === previewPath,
      previewPath,
      reason: !loaded
        ? 'preview was superseded before it finished rendering'
        : (activate ? 'reused existing preview tab' : 'existing preview tab left in background'),
    };
  }

  let initialContent;
  if (!isImage(name)) {
    const result = await window.api.readFile(filePath);
    if (!result.success) {
      return { shown: false, previewPath: null, reason: result.error || 'failed to read file' };
    }
    if (result.isBinary) {
      if (allowOs) {
        await window.api.openInOs(filePath);
        showToast({ key: `open-os:${filePath}`, message: 'Opened binary with the default app', detail: name });
      }
      return { shown: false, previewPath: null, reason: 'binary file cannot be previewed' };
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
    scrollPosition: { x: 0, y: 0 },
  };

  const tabEl = createMainTab({
    kind: 'preview',
    ident: { key: 'path', value: previewPath },
    label: name,
    actions: {
      onSwitch: () => dispatch('switch_tab', { filePath: previewPath }),
      onClose: () => dispatch('close_tab', { filePath: previewPath }),
      onContext: (_v, x, y) => showTabContextMenu(x, y, { kind: 'preview', previewPath, filePath }),
    },
  });
  // A6: tooltip with full path
  tabEl.title = `Preview — ${filePath}`;

  previewTabBar.insertBefore(tabEl, newTabBtn);
  fileData.tabEl = tabEl;
  previewFiles.set(previewPath, fileData);

  // Tabs belonging to another project are prepared in the background. They
  // become visible when the human switches to that project themselves.
  tabEl.style.display = projectId === activeEditorProjectId ? '' : 'none';

  if (activate && projectId === activeEditorProjectId) {
    showPreviewPane();
    try {
      const loaded = await switchPreviewTab(previewPath, { preserveAttention: options.preserveAttention });
      if (!loaded || activePreviewPath !== previewPath) {
        return { shown: false, previewPath, reason: 'preview was superseded before it finished rendering' };
      }
    } catch (error) {
      closePreviewTab(previewPath);
      return { shown: false, previewPath: null, reason: error.message || 'failed to render preview' };
    }
    return { shown: true, previewPath, reason: 'opened in preview pane' };
  }

  return {
    shown: false,
    previewPath,
    reason: projectId === activeEditorProjectId
      ? 'preview tab created without activation'
      : 'preview tab created in another project',
  };
}

async function openBrowserUrl(value) {
  const url = normalizeLocalBrowserUrl(value);
  if (!url) {
    showToast({
      key: 'browser-url-error',
      message: 'Only local HTTP URLs can be opened',
      detail: 'Use localhost, 127.0.0.1, or [::1]',
      type: 'error',
      persistent: true,
    });
    return;
  }

  const projectId = activeEditorProjectId;
  const previewPath = `browser:${projectId || 'global'}:${url}`;
  if (previewFiles.has(previewPath)) {
    await switchPreviewTab(previewPath);
    return;
  }

  const name = getBrowserTabLabel(url);
  const fileData = {
    path: url,
    name,
    tabEl: null,
    isPreview: true,
    isBrowser: true,
    previewPath,
    projectId,
    scrollPosition: { x: 0, y: 0 },
  };
  const tabEl = createMainTab({
    kind: 'browser',
    ident: { key: 'path', value: previewPath },
    label: name,
    actions: {
      onSwitch: () => dispatch('switch_tab', { filePath: previewPath }),
      onClose: () => dispatch('close_tab', { filePath: previewPath }),
      onContext: (_v, x, y) => showTabContextMenu(x, y, { kind: 'browser', previewPath, filePath: url }),
    },
  });
  tabEl.title = url;

  tabBar.insertBefore(tabEl, newTabBtn);
  fileData.tabEl = tabEl;
  previewFiles.set(previewPath, fileData);
  await switchPreviewTab(previewPath);
}

let pendingPreviewLoad = null;
let pendingPreviewScrollCapture = Promise.resolve();
let previewSwitchSerial = 0;

async function capturePreviewScroll(f) {
  if (!f) return;
  try {
    const position = await previewWebview.executeJavaScript(`(() => {
      const root = document.scrollingElement || document.documentElement;
      return { x: root.scrollLeft || window.scrollX || 0, y: root.scrollTop || window.scrollY || 0 };
    })()`);
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
      f.scrollPosition = { x: position.x, y: position.y };
    }
  } catch (error) {
    console.warn('[preview] Failed to capture scroll position:', error);
  }
}

function queueVisiblePreviewScrollCapture() {
  const preview = previewFiles.get(activePreviewPath);
  pendingPreviewScrollCapture = capturePreviewScroll(preview);
  return pendingPreviewScrollCapture;
}

async function restorePreviewScroll(f) {
  if (!f || !f.scrollPosition) return;
  const { x, y } = f.scrollPosition;
  if (!x && !y) return;
  try {
    await previewWebview.executeJavaScript(`(() => {
      const root = document.scrollingElement || document.documentElement;
      root.scrollLeft = ${Number(x) || 0};
      root.scrollTop = ${Number(y) || 0};
      return { x: root.scrollLeft, y: root.scrollTop };
    })()`);
  } catch (error) {
    console.warn('[preview] Failed to restore scroll position:', error);
  }
}

function loadPreviewUrl(url, revealRange = null, scrollPosition = null) {
  // Assigning src is safe before the webview's initial dom-ready event.
  // loadURL() would reject until the guest WebContents has been created.
  if (pendingPreviewLoad) pendingPreviewLoad.cancel();
  // スクロール位置は dom-ready のうちに当てる。読み込み完了後に当てると
  // 先頭で描画されてから動くため、その移動が見えてしまう。
  // 位置が確定するまではゲストページ内で visibility:hidden にして
  // 描画を隠す。ホスト側の #preview-webview.settling だけでは
  // webview のゲストコンテンツまで隠れないため、ゲスト側にも注入する。
  previewWebview.classList.add('settling');
  const loaded = new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      previewWebview.removeEventListener('dom-ready', onReady);
      clearTimeout(timeoutId);
      previewWebview.classList.remove('settling');
      if (pendingPreviewLoad?.finish === finish) pendingPreviewLoad = null;
      resolve(value);
    };
    const onReady = async () => {
      // ゲストページを隠す（スクロール前に隠さないと先頭が見える）
      try {
        await previewWebview.executeJavaScript(`(() => {
          document.documentElement.style.visibility = 'hidden';
          return true;
        })()`);
      } catch { /* 初回 dom-ready ではゲストが準備中の可能性 */ }

      if (revealRange) {
        try {
          await previewWebview.executeJavaScript(`(() => {
            const target = document.querySelector('[data-pm-line="${revealRange.start}"]');
            if (target) target.scrollIntoView({ block: 'center' });
            return !!target;
          })()`);
        } catch (error) {
          console.warn('[preview] Failed to reveal line:', error);
        }
      } else if (scrollPosition && (scrollPosition.x || scrollPosition.y)) {
        try {
          await previewWebview.executeJavaScript(`(() => {
            const root = document.scrollingElement || document.documentElement;
            root.scrollLeft = ${Number(scrollPosition.x) || 0};
            root.scrollTop = ${Number(scrollPosition.y) || 0};
            return { x: root.scrollLeft, y: root.scrollTop };
          })()`);
        } catch (error) {
          console.warn('[preview] Failed to restore scroll position:', error);
        }
      }

      // スクロール位置が確定してからゲストページを表示
      try {
        await previewWebview.executeJavaScript(`(() => {
          document.documentElement.style.visibility = '';
          return true;
        })()`);
      } catch { /* ゲストが既に破棄されている場合は無視 */ }

      finish(true);
    };
    const timeoutId = setTimeout(() => finish(false), 10000);
    pendingPreviewLoad = { finish, cancel: () => finish(false) };
    previewWebview.addEventListener('dom-ready', onReady);
  });
  previewWebview.src = url;
  return loaded;
}

function loadPreviewHtml(html, revealRange = null, scrollPosition = null) {
  return loadPreviewUrl(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`, revealRange, scrollPosition);
}

// marked v18 は見出しに id を付けない（headerIds は廃止された）。
// 目次リンクは GitHub 互換のスラッグを指すため、同じ規則で id を補う。
function slugifyHeading(text) {
  return String(text).trim().toLowerCase()
    .replace(/[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, '')
    .replace(/\s+/g, '-');
}

function addHeadingIds(doc) {
  const used = new Map();
  for (const heading of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (heading.id) continue;
    const base = slugifyHeading(heading.textContent);
    if (!base) continue;
    const seen = used.get(base) || 0;
    used.set(base, seen + 1);
    heading.id = seen === 0 ? base : `${base}-${seen}`;
  }
}

function buildSafePreviewDocument(source, baseUrl, extraStyle = '', { headingIds = false } = {}) {
  const sanitized = DOMPurify.sanitize(source, { WHOLE_DOCUMENT: true });
  const doc = new DOMParser().parseFromString(sanitized, 'text/html');
  doc.querySelectorAll('base, meta[http-equiv]').forEach((el) => el.remove());
  if (headingIds) addHeadingIds(doc);

  const csp = doc.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = PREVIEW_CSP;
  doc.head.prepend(csp);

  const base = doc.createElement('base');
  base.href = baseUrl;
  doc.head.appendChild(base);

  const style = doc.createElement('style');
  style.textContent = `body { font-family:${PREVIEW_FONT}; }\n${extraStyle}`;
  doc.head.appendChild(style);

  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}

function isActivePreview(f) {
  return activeEditorProjectId === f.projectId && activePreviewPath === f.previewPath;
}

async function readPreviewText(f, allowOs = true) {
  if (f.initialContent !== undefined) {
    const content = f.initialContent;
    f.initialContent = undefined;
    return content;
  }

  const result = await window.api.readFile(f.path);
  if (!result.success || !isActivePreview(f)) return null;
  if (result.isBinary) {
    if (allowOs) {
      await window.api.openInOs(f.path);
      showToast({ key: `open-os:${f.path}`, message: 'Opened binary with the default app', detail: f.name });
    }
    if (isActivePreview(f)) closePreviewTab(f.previewPath);
    return null;
  }
  return result.content;
}

function buildLinePreviewDocument(content, baseUrl, line, endLine) {
  const lines = String(content).split('\n');
  const range = clampLineRange(line, endLine, lines.length);
  const lineHtml = lines.map((value, index) => {
    const lineNumber = index + 1;
    const escaped = escapeHtml(value || ' ');
    const highlighted = lineNumber >= range.start && lineNumber <= range.end ? ' pm-highlight' : '';
    return `<span class="pm-source-line${highlighted}" data-pm-line="${lineNumber}"><span class="pm-line-number">${lineNumber}</span><span class="pm-line-text">${escaped}</span></span>`;
  }).join('');
  const css = `${MD_CSS}
body { padding:0; }
.pm-source { margin:0; padding:18px 0; overflow:visible; background:#0d1117; }
.pm-source-line { display:flex; min-height:1.45em; white-space:pre; }
.pm-line-number { box-sizing:border-box; flex:0 0 5em; padding:0 1em; color:#6e7681; text-align:right; user-select:none; }
.pm-line-text { flex:1; padding-right:24px; }
.pm-highlight { background:rgba(210,153,34,.24); box-shadow:inset 3px 0 #d29922; }
`;
  const source = `<body><pre class="pm-source"><code>${lineHtml}</code></pre></body>`;
  return {
    html: buildSafePreviewDocument(source, baseUrl, css),
    range,
  };
}

async function loadPreviewContent(f, reveal = null, allowOs = true) {
  // 前回見ていた位置。描画前に当てるため読み込み経路へ渡す。
  const restoreTo = reveal ? null : f.scrollPosition || null;

  if (f.isBrowser) {
    if (!isActivePreview(f)) return false;
    return await loadPreviewUrl(f.path, null, restoreTo);
  }
  if (isImage(f.name)) {
    if (!isActivePreview(f)) return false;
    return await loadPreviewUrl(toFileUrl(f.path), null, restoreTo);
  }

  if (reveal?.line) {
    const content = await readPreviewText(f, allowOs);
    if (content === null || !isActivePreview(f)) return false;
    const baseUrl = toFileUrl(pathDirname(f.path)) + '/';
    const document = buildLinePreviewDocument(content, baseUrl, reveal.line, reveal.endLine);
    return await loadPreviewHtml(document.html, document.range);
  }

  if (isHtml(f.name)) {
    const content = await readPreviewText(f, allowOs);
    if (content === null || !isActivePreview(f)) return false;
    const baseUrl = toFileUrl(pathDirname(f.path)) + '/';
    return await loadPreviewHtml(buildSafePreviewDocument(content, baseUrl), null, restoreTo);
  } else if (isMarkdown(f.name)) {
    const content = await readPreviewText(f, allowOs);
    if (content === null || !isActivePreview(f)) return false;
    const baseUrl = toFileUrl(pathDirname(f.path)) + '/';
    const markdownHtml = `<body class="markdown-body">${marked.parse(content)}</body>`;
    return await loadPreviewHtml(buildSafePreviewDocument(markdownHtml, baseUrl, MD_CSS, { headingIds: true }), null, restoreTo);
  } else {
    // A4: show text/code files as a safe read-only preview.
    const content = await readPreviewText(f, allowOs);
    if (content === null || !isActivePreview(f)) return false;
    const baseUrl = toFileUrl(pathDirname(f.path)) + '/';
    const escaped = content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const codeHtml = `<body class="markdown-body"><pre><code>${escaped}</code></pre></body>`;
    return await loadPreviewHtml(buildSafePreviewDocument(codeHtml, baseUrl, MD_CSS), null, restoreTo);
  }
}

function showPreviewPane() {
  showMainSurface('preview');
}

function hidePreviewPane() {
  showMainSurface(activeMainFilePath ? 'file' : 'terminal');
}

async function switchPreviewTab(previewPath, { preserveAttention = false, reveal = null } = {}) {
  const f = previewFiles.get(previewPath);
  if (!isPreviewForProject(f, activeEditorProjectId)) return false;

  const serial = ++previewSwitchSerial;
  await pendingPreviewScrollCapture;
  const previous = previewFiles.get(activePreviewPath);
  if (mainSurface.dataset.surface === 'preview' && previous) {
    await capturePreviewScroll(previous);
  }
  if (serial !== previewSwitchSerial) return false;

  if (activeMainView !== 'preview') {
    previewReturnView = activeMainView;
    previewReturnFilePath = activeMainFilePath;
  }
  activateMainTab(f.tabEl);
  f.tabEl.classList.remove('notified');
  activePreviewPath = previewPath;
  activeMainView = 'preview';
  showPreviewPane();
  if (!preserveAttention) {
    activeSurface = 'preview';
    setState({ isPreview: true, activeFilePath: previewPath, cursorLine: null, selection: null });
  }
  try {
    // スクロール復元は loadPreviewContent の中（描画前）で行う。
    // ここで当てると先頭で描画されてから動くのが見えてしまう。
    const loaded = await loadPreviewContent(f, reveal);
    if (!loaded || serial !== previewSwitchSerial || !isActivePreview(f)) return false;
    // dom-ready 経由で復元されなかった場合のフォールバック
    if (!reveal) await restorePreviewScroll(f);
    return true;
  } catch (error) {
    console.error('[preview] Failed to load:', error);
    return false;
  }
}

function closePreviewTab(previewPath) {
  const f = previewFiles.get(previewPath);
  if (!f) return;

  const wasPreviewVisible = activeMainView === 'preview';
  const projectId = f.projectId;
  f.tabEl.remove();
  previewFiles.delete(previewPath);

  if (activePreviewPath === previewPath) {
    const nextPath = getNextPreviewForProject(previewFiles, projectId, previewPath);
    if (nextPath) {
      if (wasPreviewVisible) switchPreviewTab(nextPath);
      else activePreviewPath = nextPath;
    } else {
      activePreviewPath = null;
      activeSurface = 'editor';
      if (!wasPreviewVisible) {
        // A background preview can close without moving the human's current main tab.
      } else if (previewReturnView === 'file' && previewReturnFilePath && openFiles.has(previewReturnFilePath)) {
        switchEditorTab(previewReturnFilePath, { focus: false });
      } else if (activeTabId !== null && tabs.has(activeTabId)) {
        switchTab(activeTabId, { focus: false });
      } else {
        showMainSurface('terminal');
      }
      previewReturnView = 'terminal';
      previewReturnFilePath = null;
    }
  }
}

async function openFileInEditor(filePath, name) {
  const projectId = activeEditorProjectId;
  if (shouldOpenInOsByName(name)) {
    await window.api.openInOs(filePath);
    showToast({ key: `open-os:${filePath}`, message: 'Opened with the default app', detail: name });
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
    showToast({ key: `open-os:${filePath}`, message: 'Opened binary with the default app', detail: name });
    return;
  }

  // EditorState.create normalizes CRLF to LF: keep the doc text and the
  // dirty-detection baseline in normalized form, and restore the file's
  // own EOL when saving (applyEol in saveActiveFile).
  const state = editorKit.createState(result.content);
  const fileData = {
    path: filePath,
    name,
    content: state.doc.toString(),
    originalContent: state.doc.toString(),
    eol: detectEol(result.content),
    state,
    scrollTop: 0,
    tabEl: null,
    isScratch: false,
    projectId,
  };

  const tabEl = createMainTab({
    kind: 'file',
    ident: { key: 'path', value: filePath },
    label: name,
    actions: {
      onSwitch: () => dispatch('switch_tab', { filePath }),
      onClose: () => dispatch('close_tab', { filePath }),
      onContext: (_v, x, y) => showTabContextMenu(x, y, { kind: 'editor-file', filePath }),
    },
  });
  // A6: tooltip with full path
  tabEl.title = `Edit — ${filePath}`;

  makeEditorTabDraggable(tabEl, filePath);
  tabBar.insertBefore(tabEl, newTabBtn);
  fileData.tabEl = tabEl;
  openFiles.set(filePath, fileData);

  switchEditorTab(filePath);
}

function switchEditorTab(filePath, { focus = true } = {}) {
  // Preview tabs are handled by switchPreviewTab
  if (previewFiles.has(filePath)) {
    return switchPreviewTab(filePath);
  }
  const f = openFiles.get(filePath);
  if (!f) return;

  activeFilePath = filePath;
  activeSurface = 'editor';
  setState({ activeFilePath: filePath, isPreview: false });
  if (f.isScratch) {
    selectComposerTab(f, { focus });
    setState({ scratchContent: f.content });
    return;
  }

  activateMainTab(f.tabEl);
  activeMainFilePath = filePath;
  activeMainView = 'file';
  showMainSurface('file');
  mountFileDoc(f, { focus });
  return true;
}

function selectComposerTab(file, { focus = true } = {}) {
  if (!file?.isScratch) return;
  openFiles.forEach((candidate) => {
    if (candidate.isScratch) setTabSelected(candidate.tabEl, candidate === file);
  });
  activeComposerPath = file.path;
  activeFilePath = file.path;
  activeSurface = 'editor';
  editorTextarea.value = file.content;
  setState({ activeFilePath: file.path, isPreview: false, scratchContent: file.content });
  if (focus) {
    setScratchCollapsed(false);
    editorTextarea.focus();
  }
  updateEditorCursorState();
}

function closeEditorTab(filePath) {
  // Preview tabs are handled by closePreviewTab
  if (previewFiles.has(filePath)) {
    closePreviewTab(filePath);
    return;
  }
  const f = openFiles.get(filePath);
  if (!f || f.isScratch) return;
  const wasMainFile = !f.isScratch && activeMainView === 'file' && activeMainFilePath === filePath;

  f.tabEl.remove();
  openFiles.delete(filePath);

  if (f.isScratch && activeComposerPath === filePath) {
    activeComposerPath = SCRATCH_PATH;
    switchEditorTab(SCRATCH_PATH);
  } else if (wasMainFile) {
    activeMainFilePath = null;
    if (activeTabId !== null && tabs.has(activeTabId)) {
      switchTab(activeTabId, { focus: false });
    } else {
      showMainSurface('terminal');
      switchEditorTab(activeComposerPath, { focus: false });
    }
  } else if (activeFilePath === filePath) {
    switchEditorTab(activeComposerPath, { focus: false });
  }
  if (activeMainFilePath === filePath) activeMainFilePath = null;
}

function showEditorPane() {
  editorPane.classList.remove('hidden');
  splitter.classList.toggle('hidden', scratchCollapsed);
  if (scratchCollapsed) {
    applyScratchHeight(34);
  } else {
    // Always show at saved height — no focus-based expand/shrink.
    editorPane.classList.add('expanded');
    applyScratchHeight(clampScratchExpandedHeight(savedScratchEditorHeight));
  }
}

function clampScratchExpandedHeight(height) {
  return Math.max(SCRATCH_COMPACT_HEIGHT, Math.min(height, window.innerHeight - 120));
}

function applyScratchHeight(height) {
  editorPane.style.height = `${height}px`;
  editorPane.style.flexBasis = `${height}px`;
  requestAnimationFrame(handleResize);
}

appMenuBtn.addEventListener('click', async (event) => {
  event.stopPropagation();
  const rect = appMenuBtn.getBoundingClientRect();
  appMenuBtn.setAttribute('aria-expanded', 'true');
  try {
    await window.api.menuPopup(rect.left, rect.bottom);
  } finally {
    appMenuBtn.setAttribute('aria-expanded', 'false');
  }
});

function setScratchExpanded(expanded) {
  scratchExpanded = !scratchCollapsed && Boolean(expanded);
  editorPane.classList.toggle('expanded', scratchExpanded);
  applyScratchHeight(scratchExpanded
    ? clampScratchExpandedHeight(savedScratchEditorHeight)
    : SCRATCH_COMPACT_HEIGHT);
}

function setScratchCollapsed(collapsed) {
  scratchCollapsed = Boolean(collapsed);
  editorPane.classList.toggle('collapsed', scratchCollapsed);
  splitter.classList.toggle('hidden', scratchCollapsed);
  scratchCollapseBtn.setAttribute('aria-expanded', scratchCollapsed ? 'false' : 'true');
  scratchCollapseBtn.title = scratchCollapsed ? 'Expand Scratch' : 'Collapse Scratch';
  scratchCollapseBtn.setAttribute('aria-label', scratchCollapseBtn.title);
  try {
    localStorage.setItem('pm-scratch-collapsed', scratchCollapsed ? 'true' : 'false');
  } catch {}
  if (scratchCollapsed) {
    scratchExpanded = false;
    editorPane.classList.remove('expanded');
    applyScratchHeight(34);
  } else {
    // Always show at saved height — no focus-based expand/shrink.
    scratchExpanded = true;
    editorPane.classList.add('expanded');
    applyScratchHeight(clampScratchExpandedHeight(savedScratchEditorHeight));
  }
}

scratchCollapseBtn.addEventListener('click', () => {
  setScratchCollapsed(!scratchCollapsed);
  if (!scratchCollapsed) editorTextarea.focus();
});

// No focusin/focusout handlers — scratch size is stable regardless of focus.
// Size changes only via collapse button and splitter drag.

function hideEditorPane() {
  editorPane.classList.add('hidden');
  splitter.classList.add('hidden');
  requestAnimationFrame(handleResize);
}

function updateEditorDirty(filePath) {
  const f = openFiles.get(filePath);
  if (!f || f.isScratch) return;
  const dirty = isDocDirty(f.state, f.originalContent);
  const dirtyEl = f.tabEl.querySelector('.editor-tab-dirty');
  if (dirtyEl) {
    if (dirty) dirtyEl.classList.remove('hidden');
    else dirtyEl.classList.add('hidden');
  }
}

function appendToScratch(text) {
  const targetPath = openFiles.has(activeComposerPath) ? activeComposerPath : SCRATCH_PATH;
  const target = openFiles.get(targetPath);
  if (!target) return;
  const sep = target.content && !target.content.endsWith('\n') ? '\n' : '';
  target.content += sep + text + '\n';
  if (target.isScratch) {
    setState({ scratchContent: target.content });
  }
  editorTextarea.value = target.content;
  editorTextarea.scrollTop = editorTextarea.scrollHeight;
  switchEditorTab(targetPath);
}

function updateEditorContent(filePath, content) {
  if (!filePath) return;
  const f = openFiles.get(filePath);
  if (f) {
    f.content = content;
    if (f.isScratch) {
      setState({ scratchContent: f.content });
    } else if (!f.isScratch) {
      updateEditorDirty(filePath);
    }
    updateEditorCursorState();
  }
}

editorTextarea.addEventListener('input', () => {
  dispatch('update_editor_content', { filePath: activeComposerPath, content: editorTextarea.value });
});
editorTextarea.addEventListener('focus', () => {
  const composer = openFiles.get(activeComposerPath) || openFiles.get(SCRATCH_PATH);
  if (composer) selectComposerTab(composer, { focus: false });
});

// Update cursor/selection state for get_focus
function updateEditorCursorState() {
  const f = activeFilePath ? openFiles.get(activeFilePath) : null;
  if (!f || f.isPreview) {
    setState({ cursorLine: null, selection: null });
    return;
  }
  if (f.isScratch) {
    const value = editorTextarea.value;
    const pos = editorTextarea.selectionStart;
    const line = value.substring(0, pos).split('\n').length;
    let selection = null;
    if (editorTextarea.selectionEnd > pos) {
      selection = {
        startLine: line,
        endLine: value.substring(0, editorTextarea.selectionEnd).split('\n').length,
      };
    }
    setState({ cursorLine: line, selection });
    return;
  }
  const state = f.state || fileEditorView.state;
  setState({ cursorLine: getCursorLine(state), selection: getSelectionLines(state) });
}

editorTextarea.addEventListener('keyup', () => dispatch('update_editor_selection'));
editorTextarea.addEventListener('click', () => dispatch('update_editor_selection'));
editorTextarea.addEventListener('select', () => dispatch('update_editor_selection'));

function insertIndent(input) {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.value = input.value.substring(0, start) + '  ' + input.value.substring(end);
  input.selectionStart = input.selectionEnd = start + 2;
  input.dispatchEvent(new Event('input'));
}

editorTextarea.addEventListener('keydown', (e) => {
  // Tab indentation is text input behavior, not a keybinding.
  if (e.key === 'Tab') {
    e.preventDefault();
    insertIndent(editorTextarea);
  }
});

async function saveActiveFile() {
  if (!activeFilePath) return;
  const f = openFiles.get(activeFilePath);
  if (!f || f.isScratch) return;

  const text = applyEol(f.content, f.eol || '\n');
  const result = await window.api.writeFile(f.path, text);
  if (result.success) {
    f.originalContent = f.content;
    updateEditorDirty(activeFilePath);
  }
}

// ============================================================
// Send to terminal (D8: bracketed paste)
// ============================================================

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
  const focusState = getState();
  const f = openFiles.get(activeComposerPath) || openFiles.get(SCRATCH_PATH);
  if (!f && !hasExplicitText) return;

  const selectedText = f
    ? editorTextarea.value.substring(editorTextarea.selectionStart, editorTextarea.selectionEnd)
    : '';
  let contentToSend = hasExplicitText ? text : (selectedText || f.content);
  if (!contentToSend) return;

  // 3.1 push: append focus context to the message
  if (pushFocusCheckbox.checked) {
    const attention = resolveAttentionFile(focusState, previewFiles);
    const ctx = buildPushFocusContext({
      project: projects.get(focusState.activeProjectId),
      activeFilePath: attention.filePath,
      isPreview: attention.isPreview,
      selectedText,
      selectionRange: focusState.selection,
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
  clearTerminalWaitingForUserInput(activeTabId);

  if (f?.isScratch && !hasExplicitText) {
    lastSentContent = f.content;
    lastSentTabPath = activeComposerPath;
    f.content = '';
    editorTextarea.value = '';
    setState({ scratchContent: '', cursorLine: null, selection: null });
    showToast({
      key: 'send-to-terminal',
      message: `Sent to ${t.label}`,
      detail: pushFocusCheckbox.checked ? 'context attached' : '',
      duration: 4000,
      actionLabel: 'Undo',
      onAction: () => dispatch('undo_last_send'),
    });
    // Move focus to the receiving terminal so the user can immediately interact.
    switchTab(activeTabId);
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
  if (activeComposerPath === (lastSentTabPath || SCRATCH_PATH)) {
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
    sendTarget.innerHTML = `${tabIcon('terminal')}<span>no terminal</span>`;
    sendBtn.disabled = true;
  } else {
    const t = tabs.get(activeTabId);
    if (t) {
      sendTarget.innerHTML = `${tabIcon('terminal')}<span>${escapeHtml(t.label)}</span>`;
      sendTarget.title = `Send destination: ${t.label}`;
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
  if (scratchCollapsed) return;
  splitterDragging = true;
  scratchExpanded = true;
  editorPane.classList.add('expanded');
  // サイズ変更開始時にフォーカスをscratchエリアに移動する。
  // これにより、ドラッグ中に focusout で expanded が解除されるのを防ぐ。
  editorTextarea.focus();
  splitterStartY = e.clientY;
  splitterStartHeight = editorPane.offsetHeight;
  document.body.style.cursor = 'ns-resize';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!splitterDragging) return;
  const delta = splitterStartY - e.clientY;
  const newHeight = clampScratchExpandedHeight(splitterStartHeight + delta);
  applyScratchHeight(newHeight);
});

document.addEventListener('mouseup', () => {
  if (splitterDragging) {
    splitterDragging = false;
    savedScratchEditorHeight = clampScratchExpandedHeight(editorPane.offsetHeight);
    try {
      localStorage.setItem('pm-scratch-expanded-height', String(savedScratchEditorHeight));
    } catch {}
    document.body.style.cursor = '';
    // No focus-based shrink — keep the height the user dragged to.
  }
});

// ============================================================
// Terminal management
// ============================================================

// File path patterns for link detection in terminal output.
// Matches absolute paths (Windows drive letter or POSIX /) and relative
// paths that contain a dot in the filename (to reduce false positives).
// The path portion excludes ':' so that :line:col suffix is captured
// separately and not included in the file path.
const FILE_PATH_RE = /(?:[A-Za-z]:[\\/](?:[^\s'"<>|*?:]+[\\/])*[^\s'"<>|*?:]+|\/(?:[^\s'"<>|*?:]+[\\/])*[^\s'"<>|*?:]+|[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-][^\s'"<>|*?:]*)(?::(\d+))?(?::(\d+))?/g;

// Extensions that are better opened in preview rather than the text editor.
const PREVIEW_EXTENSIONS = new Set([
  '.md', '.markdown', '.html', '.htm', '.png', '.jpg', '.jpeg', '.gif',
  '.webp', '.svg', '.bmp', '.ico',
]);

function resolveFilePath(candidate, cwd) {
  // Normalize backslashes to forward slashes for consistent handling.
  let p = candidate.replace(/\\/g, '/');
  // Absolute Windows path (D:/...) or POSIX absolute path (/...)
  if (/^[A-Za-z]:\//.test(p) || p.startsWith('/')) {
    return candidate;
  }
  // Relative path — resolve against the terminal's cwd.
  if (!cwd) return null;
  const base = cwd.replace(/\\/g, '/').replace(/\/$/, '');
  return `${base}/${candidate}`;
}

function registerFilePathLinkProvider(terminal, { cwd, projectId }) {
  terminal.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback([]);
        return;
      }
      const text = line.translateToString(true);
      const links = [];
      FILE_PATH_RE.lastIndex = 0;
      let match;
      while ((match = FILE_PATH_RE.exec(text)) !== null) {
        const [fullMatch, lineNum, colNum] = match;
        // Strip optional :line:col suffix to get the pure file path.
        const pathOnly = fullMatch.replace(/:\d+$/, '').replace(/:\d+$/, '');
        // Filter: require at least one path separator or drive prefix,
        // and a dot in the last segment (reduces false positives on
        // plain words like "foo" or "test").
        const lastSlash = Math.max(pathOnly.lastIndexOf('/'), pathOnly.lastIndexOf('\\'));
        const lastSegment = pathOnly.slice(lastSlash + 1);
        if (!lastSegment.includes('.')) continue;
        if (!pathOnly.includes('/') && !pathOnly.includes('\\')) continue;

        const startCol = match.index + 1; // xterm uses 1-based columns
        const endCol = startCol + fullMatch.length;
        const resolved = resolveFilePath(pathOnly, cwd);
        if (!resolved) continue;

        links.push({
          range: { start: { x: startCol, y: bufferLineNumber }, end: { x: endCol, y: bufferLineNumber } },
          text: fullMatch,
          activate: (_event, _text) => {
            // xterm's activate callback does not await or catch, so wrap
            // the async call to prevent unhandled rejections.
            openTerminalLinkFile(resolved, lineNum, colNum, projectId).catch((e) => {
              console.error('[terminal-link] failed to open:', e);
            });
          },
          hover: () => {},
          leave: () => {},
        });
      }
      callback(links);
    },
  });
}

async function openTerminalLinkFile(filePath, lineNum, colNum, projectId) {
  const name = filePath.split(/[/\\]/).pop();
  const ext = name.lastIndexOf('.') >= 0 ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
  // Switch to the owning project if different from active.
  if (projectId && projectId !== activeProjectId) {
    dispatch('select_project', { projectId });
  }
  const line = lineNum ? parseInt(lineNum, 10) : 0;
  if (PREVIEW_EXTENSIONS.has(ext)) {
    const shown = await dispatch('open_preview', { path: filePath, name });
    if (line > 0 && shown?.shown && shown.previewPath) {
      await dispatch('preview_reveal', { previewPath: shown.previewPath, line });
    }
  } else {
    await dispatch('open_file', { path: filePath, name });
    // Jump to the line in the textarea editor.
    if (line > 0 && activeMainFilePath === filePath) {
      jumpEditorToLine(line);
    }
  }
}

// Scroll the editor to a specific 1-based line number.
function jumpEditorToLine(line) {
  revealLine(fileEditorView, line);
  updateEditorCursorState();
}

async function createTerminal(command, cwd, projectId, savedLabel) {
  const terminal = new Terminal({
    fontSize: 13,
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    theme: { background: '#1c1f24', foreground: '#c8ccd4', cursor: '#f0f2f5', selectionBackground: '#2e333b' },
    cursorBlink: true,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  // Web links addon: makes URLs in terminal output clickable.
  // Custom handler routes localhost URLs to PM's browser tab and
  // external URLs to the OS default browser.
  terminal.loadAddon(new WebLinksAddon((event, uri) => {
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(uri);
    if (isLocal) {
      dispatch('open_browser', { url: uri });
    } else {
      window.api.openInOs(uri);
    }
  }));

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

  // Phase 5 S0: xterm key handling. PM only intercepts Ctrl+Shift+* keys
  // in the terminal. All other keys (Ctrl+F, Ctrl+R, Ctrl+S, etc.) must
  // reach the shell. The global document keydown handler dispatches the
  // command; this handler just prevents xterm from consuming the key.
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.shiftKey) {
      const ctx = new Set(['terminalFocus']);
      const binding = matchBinding(e, ctx);
      if (binding) return false; // don't pass to xterm/shell
    }
    return true; // pass to shell
  });

  const cols = terminal.cols;
  const rows = terminal.rows;

  const ptyId = await window.api.ptyCreate({
    command,
    args: [],
    cwd: cwd || undefined,
    projectId: projectId || null,
    cols,
    rows,
  });

  terminal.onData((data) => {
    window.api.ptyWrite(ptyId, data);
  });

  const tabId = ++tabCounter;
  const label = savedLabel || command.replace('.exe', '');
  const tabEl = createMainTab({
    kind: 'terminal',
    ident: { key: 'id', value: tabId },
    label,
    actions: {
      onSwitch: () => dispatch('focus_terminal', { tabId }),
      onClose: () => dispatch('close_terminal', { tabId }),
      onContext: (_v, x, y) => showTabContextMenu(x, y, { kind: 'terminal', tabId }),
    },
  });
  tabEl.dataset.ptyId = String(ptyId);

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

  tabs.set(tabId, {
    id: tabId,
    projectId,
    terminal,
    fitAddon,
    ptyId,
    termEl,
    tabElement: tabEl,
    command,
    label,
    cwd,
    pinnedToBottom: true,
    outputFollowRevision: 0,
    userScrollActive: false,
  });

  // xterm onData also carries terminal-generated protocol replies such as
  // focus-in (ESC [ I). Treat only actual keyboard, paste, and composition
  // events as user input so opening a focused TUI tab cannot clear waiting.
  terminal.onKey(({ key, domEvent }) => {
    const isCopyShortcut = domEvent.ctrlKey && domEvent.shiftKey
      && (domEvent.key === 'C' || domEvent.key === 'c');
    if (key && !isCopyShortcut) clearTerminalWaitingForUserInput(tabId);
  });
  termEl.addEventListener('paste', () => clearTerminalWaitingForUserInput(tabId), true);
  termEl.addEventListener('compositionend', (event) => {
    if (event.data) clearTerminalWaitingForUserInput(tabId);
  }, true);

  // Devin 3000.4.16 emits the same semantic terminal notification as OSC 9
  // and OSC 777. Register both and deduplicate them in the adapter.
  registerDevinTerminalNotifications(terminal, command, (notification) => {
    dispatch('agent_notification_received', {
      tabId,
      projectId,
      ...notification,
    });
  });

  // File path link provider: detect file paths (absolute or relative) with
  // optional line/column numbers in terminal output and make them clickable.
  // Clicking opens the file in PM's editor or preview.
  registerFilePathLinkProvider(terminal, { cwd, projectId });

  function finishUserScroll() {
    requestAnimationFrame(() => {
      const current = tabs.get(tabId);
      if (!current) return;
      updateTerminalScrollPosition(current, terminal.buffer.active);
      current.userScrollActive = false;
    });
  }

  // xterm's scroll event also fires for content-driven movement. Only use it
  // while a wheel or scrollbar interaction proves that the user is scrolling.
  terminal.onScroll(() => {
    const current = tabs.get(tabId);
    if (current) updateTerminalScrollPosition(current, terminal.buffer.active);
  });

  // Invalidate already queued write callbacks before xterm processes a user
  // scroll. Without this, an older callback can pull the viewport back down.
  termEl.addEventListener('wheel', (event) => {
    const current = tabs.get(tabId);
    if (!current) return;
    invalidateTerminalFollow(current);
    current.userScrollActive = true;
    if (event.deltaY < 0) current.pinnedToBottom = false;
    finishUserScroll();
  }, { capture: true, passive: true });

  termEl.addEventListener('pointerdown', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('.xterm-viewport')) return;
    const current = tabs.get(tabId);
    if (!current) return;
    invalidateTerminalFollow(current);
    current.userScrollActive = true;
    current.pinnedToBottom = false;

    const finishPointerScroll = (pointerEvent) => {
      if (pointerEvent.pointerId !== event.pointerId) return;
      window.removeEventListener('pointerup', finishPointerScroll, true);
      window.removeEventListener('pointercancel', finishPointerScroll, true);
      finishUserScroll();
    };
    window.addEventListener('pointerup', finishPointerScroll, true);
    window.addEventListener('pointercancel', finishPointerScroll, true);
  }, true);

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
    if (activeMainView === 'terminal') {
      switchTab(restoreId);
    } else {
      activeTabId = restoreId;
      projectActiveTab.set(projectId, restoreId);
      setState({ activeTerminalTabId: restoreId });
      updateSendTarget();
    }
  } else {
    activeTabId = null;
    setState({ activeTerminalTabId: null });
    updateSendTarget();
  }
}

function switchTab(tabId, { focus = true } = {}) {
  const t = tabs.get(tabId);
  if (!t) return;

  // Hide all terminal elements (across all projects)
  tabs.forEach((td) => {
    td.termEl.style.display = 'none';
    setTabSelected(td.tabElement, false);
  });

  t.termEl.style.display = 'block';
  activateMainTab(t.tabElement);
  showMainSurface('terminal');
  activeTabId = tabId;
  activeMainView = 'terminal';
  activeSurface = 'editor';
  const composer = openFiles.get(activeComposerPath) || openFiles.get(SCRATCH_PATH);
  if (composer) {
    activeFilePath = composer.path;
    setState({ activeFilePath: composer.path, isPreview: false, scratchContent: composer.content });
  }
  projectActiveTab.set(t.projectId, tabId);
  setState({ activeTerminalTabId: tabId });
  // Completion notices become read when opened. Input-waiting notices are
  // intentionally not "seen" because they remain actionable until input.
  if (!getTabAttention(tabId)?.waiting) {
    dispatch('agent_notification_seen', { tabId });
  }
  updateSendTarget();

  // Wait until display/layout changes have settled before measuring.
  requestAnimationFrame(() => {
    if (activeTabId !== tabId || t.termEl.style.display === 'none') return;
    const shouldFollow = t.pinnedToBottom;
    if (!resizeTerminalToContainer(t)) return;
    t.pinnedToBottom = shouldFollow;
    if (focus) t.terminal.focus();
    if (shouldFollow) t.terminal.scrollToBottom();
  });
}

function resizeTerminalToContainer(t) {
  const rect = t.termEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  const oldCols = t.terminal.cols;
  const oldRows = t.terminal.rows;
  // Preserve the user's scroll position when not following the bottom.
  // fit() reflows rows and can shift the viewport; restore the top line.
  const savedBaseY = t.pinnedToBottom ? null : t.terminal.buffer.active.baseY;
  t.fitAddon.fit();
  if (t.terminal.cols !== oldCols || t.terminal.rows !== oldRows) {
    window.api.ptyResize(t.ptyId, t.terminal.cols, t.terminal.rows);
  }
  if (savedBaseY !== null) {
    const delta = savedBaseY - t.terminal.buffer.active.baseY;
    if (delta !== 0) t.terminal.scrollLines(delta);
  }
  return true;
}

function closeTerminal(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;

  const projectId = t.projectId;
  void window.api.devinUnbind(t.ptyId);
  window.api.ptyKill(t.ptyId);
  t.terminal.dispose();
  t.termEl.remove();
  t.tabElement.remove();
  dispatch('agent_session_unbound', { tabId });
  tabs.delete(tabId);
  dispatch('terminal_clear_attention', { tabId });

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
      activateMainTab(null);
      showMainSurface('terminal');
      updateSendTarget();
    }
  }
  saveLayout();
}

function updateTabStatus(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;
  const attention = getTabAttention(tabId);
  const statusEl = t.tabElement.querySelector('.tab-status');
  if (statusEl) {
    const status = attention?.kind === 'turn_failed'
      ? 'failed'
      : attention?.waiting
        ? 'waiting'
        : attention?.unread
          ? 'notified'
          : 'idle';
    statusEl.className = `tab-status ${status}`;
    statusEl.title = attention?.waiting
      ? attention.reason === 'approval' ? 'Agent is waiting for approval' : 'Agent is waiting for input'
      : attention?.kind === 'turn_failed'
        ? 'Agent failed'
      : attention?.unread
        ? 'Agent finished'
        : '';
  }
}

function updateProjectStatus(projectId) {
  if (!projectId) return;
  const summary = getTerminalAttentionSummary()[projectId] || { waiting: 0, unread: 0, failed: 0 };
  const items = projectList.querySelectorAll('.project-item');
  for (const item of items) {
    if (item.dataset.projectId === projectId) {
      const statusEl = item.querySelector('.project-status');
      if (statusEl) {
        statusEl.className = 'project-status ' + (summary.failed > 0 ? 'failed' : summary.waiting > 0 ? 'waiting' : summary.unread > 0 ? 'notified' : 'idle');
        statusEl.title = summary.failed > 0
          ? `${summary.failed} failed agent notification${summary.failed === 1 ? '' : 's'}`
          : summary.waiting > 0
          ? `${summary.waiting} agent${summary.waiting === 1 ? '' : 's'} waiting for input`
          : summary.unread > 0
            ? `${summary.unread} completed agent notification${summary.unread === 1 ? '' : 's'}`
            : '';
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
  const browserItem = document.createElement('div');
  browserItem.className = 'dropdown-item dropdown-item-browser';
  browserItem.textContent = 'Open localhost…';
  browserItem.addEventListener('click', async (event) => {
    event.stopPropagation();
    newTabMenu.classList.add('hidden');
    const url = await showPrompt('Open Local URL', 'localhost URL:', 'http://localhost:3000');
    if (url) dispatch('open_browser', { url });
  });
  newTabMenu.appendChild(browserItem);
}
buildTerminalMenu();

// Close menu when clicking outside
document.addEventListener('click', () => {
  newTabMenu.classList.add('hidden');
});

// ============================================================
// メニューのバックドロップ
// document の click だけでは <webview>（プレビュー）上のクリックを
// 拾えない。ゲスト側のイベントはホストに伝播しないため、開いている
// 間だけ全面を覆ってそこで受ける。
// <webview> は WebContentsView と違い z-index が効くので前面に出せる。
// ============================================================

const menuBackdrop = document.getElementById('menu-backdrop');
const overlayMenus = [contextMenu, tabContextMenu, newTabMenu, previewContextMenu];

function closeOverlayMenus() {
  hideContextMenu();
  hideTabContextMenu();
  newTabMenu.classList.add('hidden');
  previewContextMenu.classList.add('hidden');
}

function syncMenuBackdrop() {
  const anyOpen = overlayMenus.some((menu) => !menu.classList.contains('hidden'));
  menuBackdrop.classList.toggle('hidden', !anyOpen);
}

// 呼び出し側が classList を直接触っている箇所が多いので、表示状態を
// 監視して同期する（呼び忘れによる同期漏れが起きない）
const menuBackdropObserver = new MutationObserver(syncMenuBackdrop);
for (const menu of overlayMenus) {
  menuBackdropObserver.observe(menu, { attributes: true, attributeFilter: ['class'] });
}

menuBackdrop.addEventListener('mousedown', (e) => {
  e.preventDefault();
  closeOverlayMenus();
});
menuBackdrop.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  closeOverlayMenus();
});
// <webview> は別プロセスのため、backdrop の z-index が効かず、
// webview 上のクリックが renderer に届かない。webview がフォーカスを
// 取った瞬間にメニューを閉じる。
previewWebview.addEventListener('focus', closeOverlayMenus);
window.addEventListener('blur', closeOverlayMenus);

// ============================================================
// Phase 5 S0: Global keybinding handler
// ============================================================
//
// All keyboard shortcuts are centralized through the keybinding registry
// (src/keybindings/registry.js). The registry uses `when` clauses to
// determine which binding applies based on the current focus context.
// Individual addEventListener('keydown') handlers for shortcuts have been
// migrated here. Text input behavior (Tab indentation, Enter in modals)
// remains in their respective element listeners.

// Validate the binding table at startup. Throws if conflicts are found.
validateBindings(BINDINGS);

function getFocusContext() {
  const ae = document.activeElement;
  if (ae === editorTextarea) return new Set(['scratchFocus']);
  if (ae && fileEditorMount.contains(ae)) return new Set(['editorFocus']);
  // treeFilterFocus: filter input is focused. Slash binding (treeFocus)
  // won't fire, so / can be typed. Escape binding (treeFocus || treeFilterFocus)
  // will fire, so Escape clears the filter.
  if (ae === treeFilterInput) return new Set(['treeFilterFocus']);
  if (ae?.closest('#file-tree')) return new Set(['treeFocus']);
  if (ae === searchInput || ae?.closest('#search-pane')) return new Set(['searchFocus']);
  // When a terminal tab is active, treat as terminalFocus even if focus
  // is on <body> (e.g. after closing a modal). This ensures Ctrl+B
  // (!terminalFocus) correctly defers to the shell's tmux prefix.
  if (activeMainView === 'terminal') return new Set(['terminalFocus']);
  if (activeMainView === 'preview') return new Set(['previewFocus']);
  if (activeMainView === 'file') return new Set(['editorFocus']);
  return new Set();
}

document.addEventListener('keydown', (e) => {
  // Ctrl+V is handled by a dedicated listener below (clipboard image paste).
  // It must NOT be preventDefault'd so native paste still works in terminals
  // and textareas. The keybinding registry deliberately omits Ctrl+V.
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 'v') return;

  // Don't intercept when typing in input fields that aren't part of the
  // main editing surfaces (project name input, prompt modal, etc).
  // Those have their own keydown handlers.
  const ae = document.activeElement;
  if (ae && ae.tagName === 'INPUT' && ae !== editorTextarea && ae !== treeFilterInput && ae !== searchInput) {
    // Allow global bindings (Ctrl+Shift+F) even in inputs.
    const key = keyToString(e);
    const isGlobal = BINDINGS.some(b => b.key === key && (b.when === null || b.when === undefined || b.when === ''));
    if (!isGlobal) return;
  }

  const ctx = getFocusContext();
  const binding = matchBinding(e, ctx);
  if (binding) {
    e.preventDefault();
    e.stopPropagation();
    dispatch(binding.command, binding.args || {});
  }
});

// ============================================================
// Clipboard paste (Ctrl+V) -> save screenshot -> append path to scratch
// ============================================================
// Not in the keybinding registry because it must NOT preventDefault —
// native paste must still work in terminals and textareas. This listener
// only acts when there's an image in the clipboard; text paste falls
// through to the browser's default behavior.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key === 'v') {
    // Only handle image paste when a terminal or scratch editor is focused.
    // In modals, project name inputs, etc., native paste should work freely.
    const ctx = getFocusContext();
    if (ctx.has('terminalFocus') || ctx.has('scratchFocus') || ctx.has('editorFocus')) {
      dispatch('terminal_paste_image');
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
  statusSystem.textContent = `${mem.workingSetMB} MB  |  ${mem.ptyCount} PTY`;
}
setInterval(updateMemory, 2000);
updateMemory();
setInterval(updateStatusBar, 500);

// ============================================================
// L4: Stacked Projects / File Tree collapse & restore
// ============================================================

const sidebar = document.getElementById('sidebar');
const fileTreePane = document.getElementById('file-tree-pane');

let sidebarCollapsed = false;
let fileTreeCollapsed = false;
let savedNavigationWidth = 280;
let savedSidebarHeight = 220;

function applyCollapseState() {
  const bothWereCollapsed = sidebar.classList.contains('collapsed') && fileTreePane.classList.contains('collapsed');
  savedNavigationWidth = captureExpandedPaneWidth({
    isCollapsed: bothWereCollapsed,
    measuredWidth: navigationPane.offsetWidth,
    savedWidth: savedNavigationWidth,
  });
  savedSidebarHeight = captureExpandedPaneWidth({
    isCollapsed: sidebar.classList.contains('collapsed') || fileTreePane.classList.contains('collapsed'),
    measuredWidth: sidebar.offsetHeight,
    savedWidth: savedSidebarHeight,
  });

  const bothCollapsed = sidebarCollapsed && fileTreeCollapsed;
  // 両方畳んだときは復元バーの中身に合わせる。固定幅を与えると
  // ラベル付きボタンが押し潰されて崩れる。
  navigationPane.classList.toggle('all-collapsed', bothCollapsed);
  navigationPane.style.width = bothCollapsed ? '' : savedNavigationWidth + 'px';
  vsplitter2.classList.toggle('hidden', bothCollapsed);

  if (sidebarCollapsed) {
    sidebar.classList.add('collapsed');
    sidebarRestoreBar.classList.remove('hidden');
  } else {
    sidebar.classList.remove('collapsed');
    sidebarRestoreBar.classList.add('hidden');
    if (fileTreeCollapsed) {
      sidebar.style.height = 'auto';
      sidebar.style.flexBasis = 'auto';
      sidebar.style.flexGrow = '1';
    } else {
      sidebar.style.height = savedSidebarHeight + 'px';
      sidebar.style.flexBasis = savedSidebarHeight + 'px';
      sidebar.style.flexGrow = '0';
    }
  }

  if (fileTreeCollapsed) {
    fileTreePane.classList.add('collapsed');
    fileTreeRestoreBar.classList.remove('hidden');
  } else {
    fileTreePane.classList.remove('collapsed');
    fileTreeRestoreBar.classList.add('hidden');
  }
  vsplitter1.classList.toggle('hidden', sidebarCollapsed || fileTreeCollapsed);
  handleResize();
  saveCollapseState();
}

function saveCollapseState() {
  try {
    localStorage.setItem('pm-collapse', JSON.stringify({
      sidebarCollapsed, fileTreeCollapsed,
      navigationWidth: savedNavigationWidth,
      sidebarHeight: savedSidebarHeight,
    }));
  } catch {}
}

function loadCollapseState() {
  try {
    const data = JSON.parse(localStorage.getItem('pm-collapse') || '{}');
    if (data.sidebarCollapsed !== undefined) sidebarCollapsed = data.sidebarCollapsed;
    if (data.fileTreeCollapsed !== undefined) fileTreeCollapsed = data.fileTreeCollapsed;
    savedNavigationWidth = data.navigationWidth || data.fileTreeWidth || savedNavigationWidth;
    savedSidebarHeight = data.sidebarHeight || data.sidebarWidth || savedSidebarHeight;
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
  e.stopPropagation();
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
  // Don't intercept if dropping on the editor or terminal (they have their own handlers)
  if (e.target === editorTextarea || fileEditorMount.contains(e.target) || e.target.closest('#terminal-container')) return;
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
    dispatch('append_to_scratch', { text: paths.join('\n') });
    editorTextarea.focus();
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
      clearTerminalWaitingForUserInput(activeTabId);
      // Focus the terminal only when it is already the visible surface,
      // so dropping on a hidden terminal does not yank the user's view.
      if (mainSurface.dataset.surface === 'terminal') t.terminal.focus();
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
// Navigation splitters (Projects / Files | main-pane)
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

function makeHSplitter(splitterEl, topEl, containerEl, minTop, minBottom, onResizeEnd) {
  let dragging = false;
  let startY = 0;
  let startHeight = 0;

  splitterEl.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startHeight = topEl.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const maxHeight = containerEl.clientHeight - minBottom - splitterEl.offsetHeight;
    const newHeight = Math.max(minTop, Math.min(startHeight + e.clientY - startY, maxHeight));
    topEl.style.height = newHeight + 'px';
    topEl.style.flexBasis = newHeight + 'px';
    handleResize();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    if (onResizeEnd) onResizeEnd(topEl.offsetHeight);
  });
}

makeHSplitter(vsplitter1, sidebar, navigationPane, 100, 120, (height) => {
  savedSidebarHeight = height;
  saveCollapseState();
});
makeVSplitter(vsplitter2, navigationPane, document.getElementById('main-pane'), 180, 300, (width) => {
  savedNavigationWidth = width;
  saveCollapseState();
});

// ============================================================
// Status bar
// ============================================================

function updateStatusBar() {
  const p = projects.get(activeProjectId);
  statusLeft.textContent = p ? p.name : 'No project selected';

  const parts = [];
  if (activeMainView === 'terminal' && activeTabId !== null) {
    const t = tabs.get(activeTabId);
    if (t) parts.push(t.command.replace('.exe', ''));
  } else if (activeMainView === 'file' && activeMainFilePath) {
    const f = openFiles.get(activeMainFilePath);
    if (f) parts.push(f.name + (f.content !== f.originalContent ? ' *' : ''));
  } else if (activeMainView === 'preview' && activePreviewPath) {
    const preview = previewFiles.get(activePreviewPath);
    if (preview) parts.push(preview.name);
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

register('open_browser', ({ url }) => {
  return openBrowserUrl(url);
});

// close_tab: close an editor tab
register('close_tab', ({ filePath }) => {
  closeEditorTab(filePath);
});

// switch_tab: switch to an editor tab
register('switch_tab', ({ filePath }) => {
  return switchEditorTab(filePath);
});

register('append_to_scratch', ({ text }) => {
  appendToScratch(text);
});

register('update_editor_content', ({ filePath, content }) => {
  updateEditorContent(filePath || activeFilePath, content);
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
  switchTab(tabId);
});

// ============================================================
// Phase 5 S0: Keybinding commands
// ============================================================

register('focus_scratch', () => {
  dispatch('switch_tab', { filePath: SCRATCH_PATH });
  editorTextarea.focus();
});

register('terminal_copy', () => {
  if (activeTabId === null) return;
  const t = tabs.get(activeTabId);
  if (!t) return;
  const selection = t.terminal.getSelection();
  if (selection) {
    window.api.clipboardWriteText(selection);
    t.terminal.clearSelection();
  }
});

register('terminal_select_all', () => {
  if (activeTabId === null) return;
  const t = tabs.get(activeTabId);
  if (!t) return;
  t.terminal.selectAll();
});

register('terminal_paste_image', async () => {
  if (activeTabId === null) return;
  const p = projects.get(activeProjectId);
  if (!p) return;
  const filepath = await window.api.clipboardSaveImage(p.path);
  if (filepath) {
    dispatch('append_to_scratch', { text: filepath });
    showToast({ key: 'screenshot-saved', message: 'Screenshot saved', detail: filepath });
  }
});

register('close_overlay_menus', () => {
  closeOverlayMenus();
});

// Phase 5 S1/S2 stubs — implemented in S1/S2 sections.
register('tree_filter_focus', () => {
  if (treeFilterBar.classList.contains('hidden')) {
    treeFilterBar.classList.remove('hidden');
  }
  treeFilterInput.focus();
  treeFilterInput.select();
});

register('tree_filter_clear', () => {
  closeTreeFilter();
  // Reload the tree to show the full (unfiltered) view.
  const project = projects.get(activeProjectId);
  if (project) loadFileTree(project.path);
  fileTree.focus();
});

register('search_text_open', () => {
  openSearchTab();
});

register('search_close', () => {
  searchGeneration++;
  if (currentSearchId) {
    window.api.cancelSearch(currentSearchId);
    currentSearchId = null;
  }
  searchInput.value = '';
  searchResults.innerHTML = '';
  searchStatus.textContent = '';
  closeSearchTab();
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

// ============================================================
// 3.4 show_file: external UI control commands
// ============================================================

// project_set_badge: show a notification dot on a project in the sidebar.
// R2: badge state is authoritative in the store; the DOM is derived from it.
// This survives project list re-renders that previously dropped badges.
register('project_set_badge', ({ projectId, kind }) => {
  const badges = { ...getState().projectBadges };
  if (kind === 'clear' || !kind) {
    delete badges[projectId];
  } else {
    badges[projectId] = kind;
  }
  setState({ projectBadges: badges });
  renderProjectBadge(projectId);
});

// ============================================================
// OS notification (Windows toast / macOS Notification Center)
// ============================================================
//
// Shown for needs_attention (input-waiting) and turn_failed events.
// turn_completed is excluded to avoid noise. Clicking the notification
// focuses the PM window and switches to the relevant terminal tab.

const visibleOsNotifications = new Map();

function closeOsNotification(tabId) {
  const notification = visibleOsNotifications.get(tabId);
  if (!notification) return;
  visibleOsNotifications.delete(tabId);
  notification.close();
}

function showOsNotification({ tabId, projectId, kind, source, reason, title: detailTitle, message, eventType }) {
  if (typeof Notification !== 'function') return;

  const project = projects.get(projectId);
  const projectName = project?.name || 'Unknown project';
  const agentLabel = source ? source.charAt(0).toUpperCase() + source.slice(1) : 'Agent';
  let title, fallbackBody;
  if (kind === 'needs_attention') {
    title = `${agentLabel} needs input`;
    fallbackBody = reason === 'approval' ? 'Approval required' : 'Waiting for input';
  } else {
    title = `${agentLabel} failed`;
    fallbackBody = eventType || 'An error occurred';
  }
  title += ` — ${projectName}`;
  const bodyParts = [detailTitle, message]
    .filter((part, index, parts) => part && parts.indexOf(part) === index);
  const body = bodyParts.join(' — ') || fallbackBody;

  closeOsNotification(tabId);
  let notification;
  try {
    notification = new Notification(title, {
      body,
      silent: false,
      requireInteraction: kind === 'needs_attention',
      tag: `agent-attention-${tabId}`,
    });
  } catch (error) {
    console.warn('[notifications] Failed to show OS notification:', error);
    return;
  }
  visibleOsNotifications.set(tabId, notification);
  notification.onclose = () => {
    if (visibleOsNotifications.get(tabId) === notification) {
      visibleOsNotifications.delete(tabId);
    }
  };
  notification.onerror = (error) => {
    if (visibleOsNotifications.get(tabId) === notification) {
      visibleOsNotifications.delete(tabId);
    }
    console.warn('[notifications] OS notification error:', error);
  };
  notification.onclick = () => {
    window.api.focusWindow();
    if (projectId !== activeProjectId) {
      dispatch('select_project', { projectId });
    }
    // Wait for project switch to settle before switching tab.
    requestAnimationFrame(() => {
      const tab = tabs.get(tabId);
      if (tab && tab.projectId === projectId) {
        switchTab(tabId);
      }
    });
  };
}

window.api.onDevinMonitorError(({ ptyId, sessionId, message }) => {
  const tab = Array.from(tabs.values()).find((candidate) => candidate.ptyId === ptyId);
  if (!tab) return;
  showToast({
    key: `devin-monitor-${sessionId}`,
    message: 'Devin session monitoring paused',
    detail: message,
    type: 'warn',
    persistent: true,
  });
});

register('agent_notification_received', ({ tabId, projectId, kind, eventType, source, reason, title, message, sessionId }) => {
  if (!tabs.has(tabId)) return;
  const unread = activeMainView !== 'terminal' || activeTabId !== tabId || activeProjectId !== projectId;
  const wasWaiting = Boolean(getTabAttention(tabId)?.waiting);
  const terminalAttention = receiveAgentNotification(getState().terminalAttention, {
    tabId,
    projectId,
    kind,
    eventType,
    source,
    reason,
    title,
    message,
    sessionId,
    unread,
  });
  setState({ terminalAttention });
  if (wasWaiting && !terminalAttention[tabId]?.waiting) closeOsNotification(tabId);
  updateTabStatus(tabId);
  updateProjectStatus(projectId);
  if (source === 'devin' && sessionId) {
    const current = getTerminalAgentBinding(tabId);
    if (current?.sessionId === sessionId) {
      dispatch('agent_session_bound', { tabId, ...current, status: eventType });
    }
  }
  if (kind === 'turn_failed') {
    showToast({
      key: `agent-failed-${source}-${sessionId || tabId}`,
      message: `${source} agent failed`,
      detail: eventType,
      type: 'error',
      persistent: true,
    });
  }
  // OS notification for input-waiting and failure events.
  // Completion (turn_completed) is intentionally excluded to avoid noise.
  if (kind === 'needs_attention' || kind === 'turn_failed') {
    showOsNotification({ tabId, projectId, kind, source, reason, title, message, eventType });
  }
});

register('agent_notification_seen', ({ tabId }) => {
  const tab = tabs.get(tabId);
  const terminalAttention = markAgentNotificationSeen(getState().terminalAttention, tabId);
  if (terminalAttention !== getState().terminalAttention) setState({ terminalAttention });
  updateTabStatus(tabId);
  if (tab) updateProjectStatus(tab.projectId);
});

register('terminal_set_waiting', ({ tabId, projectId, waiting, cause }) => {
  const wasWaiting = Boolean(getTabAttention(tabId)?.waiting);
  const terminalAttention = setTerminalWaiting(getState().terminalAttention, { tabId, projectId, waiting, cause });
  setState({ terminalAttention });
  const isWaiting = Boolean(terminalAttention[tabId]?.waiting);
  if (wasWaiting && !isWaiting) closeOsNotification(tabId);
  if (!wasWaiting && isWaiting) {
    const tab = tabs.get(tabId);
    showOsNotification({
      tabId,
      projectId,
      kind: 'needs_attention',
      source: tab?.command || 'terminal',
      reason: 'input',
      eventType: 'terminal_waiting',
    });
  }
  updateTabStatus(tabId);
  updateProjectStatus(projectId);
});

register('terminal_clear_attention', ({ tabId }) => {
  const tab = tabs.get(tabId);
  const projectId = tab?.projectId || getTabAttention(tabId)?.projectId;
  const terminalAttention = clearTerminalAttention(getState().terminalAttention, tabId);
  if (terminalAttention !== getState().terminalAttention) setState({ terminalAttention });
  closeOsNotification(tabId);
  if (projectId) updateProjectStatus(projectId);
});

register('agent_session_bound', ({ tabId, provider, sessionId, status }) => {
  if (!tabs.has(tabId)) return;
  const terminalAgentBindings = {
    ...getState().terminalAgentBindings,
    [tabId]: { provider, sessionId, status: status || null },
  };
  setState({ terminalAgentBindings });
  tabs.get(tabId).tabElement.title = `${provider}: ${sessionId}${status ? ` (${status})` : ''}`;
});

register('agent_session_unbound', ({ tabId }) => {
  const terminalAgentBindings = { ...getState().terminalAgentBindings };
  delete terminalAgentBindings[tabId];
  setState({ terminalAgentBindings });
  const terminal = tabs.get(tabId);
  if (terminal) terminal.tabElement.removeAttribute('title');
});

function renderProjectBadge(projectId) {
  const item = projectList.querySelector(`.project-item[data-project-id="${projectId}"]`);
  if (!item) return;
  const badge = item.querySelector('.project-badge');
  if (!badge) return;
  const kind = getProjectBadge(projectId);
  if (kind) {
    badge.classList.add('active');
  } else {
    badge.classList.remove('active');
  }
}

// tab_activate: switch to an existing tab by filePath
register('tab_activate', ({ filePath }) => {
  if (!filePath) return;
  if (previewFiles.has(filePath)) {
    switchPreviewTab(filePath);
  } else if (openFiles.has(filePath)) {
    switchEditorTab(filePath);
  }
});

// preview_open: open a file in the preview area (show_file core)
// Returns { shown: boolean, reason: string }
register('preview_open', async ({ path: filePath, reason, newTab }) => {
  if (!filePath) return { shown: false, reason: 'no path' };

  // Compare complete path segments and prefer the deepest nested project.
  // A raw startsWith() would incorrectly assign app-extra to app on Windows.
  const owner = findOwningProject(projects, filePath);
  if (!owner) {
    return { shown: false, reason: 'file not in any open project' };
  }
  const { id: targetProjectId, project: targetProject } = owner;

  const name = filePath.split(/[/\\]/).pop();
  const previewPath = makePreviewPath(
    targetProjectId,
    filePath,
    newTab ? ++agentPreviewCounter : null,
  );
  const sameProject = targetProjectId === activeProjectId && targetProjectId === activeEditorProjectId;
  const activation = decidePreviewActivation({
    sameProject,
    activeSurface,
    activePreviewPath,
    requestedPreviewPath: previewPath,
    newTab,
  });
  const { activate, preserveAttention } = activation;

  const result = await openFileInPreview(filePath, name, {
    projectId: targetProjectId,
    previewPath,
    activate,
    preserveAttention,
    // Agent-originated show_file must never launch an external application.
    allowOs: false,
  });

  if (result.previewPath && reason) {
    const preview = previewFiles.get(result.previewPath);
    if (preview) {
      preview.tabEl.classList.add('notified');
      preview.tabEl.title = `${filePath} — ${reason}`;
    }
  }

  if (!sameProject) {
    dispatch('project_set_badge', { projectId: targetProjectId, kind: 'show_file' });
    return {
      ...result,
      shown: false,
      reason: result.previewPath
        ? `preview tab created in project "${targetProject.name}"; project was not switched`
        : result.reason,
    };
  }

  if (activation.reason === 'human-on-other-preview') {
    return {
      ...result,
      shown: false,
      reason: 'preview tab created without activation because the human is viewing another preview tab',
    };
  }

  return result;
});

// preview_reveal: scroll to a line in the active preview
register('preview_reveal', async ({ previewPath, line, endLine }) => {
  if (!line) return { revealed: false, reason: 'no line' };
  const targetPath = previewPath || activePreviewPath;
  const preview = previewFiles.get(targetPath);
  if (!preview || targetPath !== activePreviewPath || !isActivePreview(preview)) {
    return { revealed: false, reason: 'preview is not visible' };
  }
  if (isImage(preview.name)) {
    return { revealed: false, reason: 'line reveal is not supported for images' };
  }
  if (preview.isBrowser) {
    return { revealed: false, reason: 'line reveal is not supported for browser tabs' };
  }
  const revealed = await loadPreviewContent(preview, { line, endLine: endLine || line }, false);
  if (!revealed) return { revealed: false, reason: 'file could not be rendered' };
  return { revealed: true, previewPath: targetPath };
});

register('close_terminal', ({ tabId }) => {
  closeTerminal(tabId);
});

// send_to_terminal: send text to terminal
register('send_to_terminal', ({ text, tabId }) => {
  sendToTerminal(text, tabId);
});

// get_focus: build the human's attention state from the store + live data
register('get_focus', ({ $session: session = null } = {}) => {
  const focus = buildFocusState((id) => projects.get(id) || null);
  const scopedProjectId = session?.projectId || focus.project?.id || null;

  // A PTY may remain alive while the human looks at another project. In that
  // case do not leak the other project's editor/scratch state into this MCP
  // session; report the owning project and that it is currently in background.
  if (session?.projectId && session.projectId !== focus.project?.id) {
    const project = projects.get(session.projectId) || null;
    const editorState = projectEditorStates.get(session.projectId);
    focus.project = project ? { id: project.id, name: project.name, path: project.path } : {
      id: session.projectId,
      name: null,
      path: session.cwd || null,
    };
    focus.editor = null;
    focus.scratch = {
      content: editorState
        ? getProjectScratchContent(editorState.openFiles, editorState.activeFilePath, SCRATCH_PATH)
        : '',
      length: 0,
    };
    focus.scratch.length = focus.scratch.content.length;
  }

  // Enrich terminal info from live tabs Map (store only has tabId)
  let sessionTerminal = null;
  if (session?.ptyId) {
    for (const [tabId, tab] of tabs) {
      if (tab.ptyId === session.ptyId) {
        sessionTerminal = {
          activeTabId: tabId === activeTabId ? tabId : null,
          ownTabId: tabId,
          active: tabId === activeTabId,
          command: tab.command,
          cwd: session.cwd || null,
        };
        break;
      }
    }
  }
  if (sessionTerminal) {
    focus.terminal = sessionTerminal;
  } else if (focus.terminal) {
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
  focus.session = session ? {
    projectId: scopedProjectId,
    ptyId: session.ptyId || null,
    cwd: session.cwd || null,
    activeProject: scopedProjectId === activeProjectId,
  } : null;
  return focus;
});

// ============================================================
// Phase 5 S2: Project text search (git grep / rg)
// ============================================================

let searchTabEl = null;
let currentSearchId = null;
let searchGeneration = 0; // increments on each search start/clear to reject stale results
let searchResultCount = 0;
let searchTruncated = false;
let searchFocusedResult = null; // { file, line } for keyboard navigation
let searchLastFile = null; // path of the last file header rendered

function openSearchTab() {
  if (!searchTabEl) createSearchTab();
  activateSearchTab();
  searchInput.focus();
  searchInput.select();
}

function createSearchTab() {
  searchTabEl = createMainTab({
    kind: 'search',
    ident: { key: 'searchTab', value: 'search' },
    label: 'Search',
    closeSelector: 'editor-tab-close',
    actions: {
      onSwitch: () => activateSearchTab(),
      onClose: () => closeSearchTab(),
      onContext: (_v, x, y) => showTabContextMenu(x, y, { kind: 'search' }),
    },
  });
  tabBar.insertBefore(searchTabEl, newTabBtn);
}

function activateSearchTab() {
  // Hide other main tabs' selection.
  tabBar.querySelectorAll('.main-tab').forEach((el) => setTabSelected(el, el === searchTabEl));
  showMainSurface('search');
  activeMainView = 'search';
  // Hide editor/preview tabs when search is active.
  openFiles.forEach((f) => { if (f.tabEl) f.tabEl.style.display = 'none'; });
  previewFiles.forEach((f) => { if (f.tabEl) f.tabEl.style.display = 'none'; });
}

function closeSearchTab() {
  if (!searchTabEl) return;
  searchTabEl.remove();
  searchTabEl = null;
  // Restore visibility of editor/preview tabs for the active project only.
  // previewFiles is cross-project; other projects' tabs must stay hidden.
  openFiles.forEach((f) => { if (f.tabEl) f.tabEl.style.display = ''; });
  previewFiles.forEach((f) => {
    if (f.tabEl && f.projectId === activeEditorProjectId) {
      f.tabEl.style.display = '';
    }
  });
  // Switch back to terminal or editor.
  if (activeTabId !== null) {
    const t = tabs.get(activeTabId);
    if (t) {
      switchTab(activeTabId);
      return;
    }
  }
  // Fallback: show terminal surface.
  showMainSurface('terminal');
  activeMainView = 'terminal';
}

// Register the search_text command.
register('search_text', async ({ query, cwd, caseSensitive }) => {
  const project = projects.get(activeProjectId);
  const searchCwd = cwd || project?.path;
  if (!searchCwd || !query) return { searchId: null, error: 'missing query or cwd' };

  // Cancel any in-flight search before starting a new one.
  if (currentSearchId) {
    window.api.cancelSearch(currentSearchId);
  }

  // Increment generation so stale results from previous searches are rejected.
  const gen = ++searchGeneration;

  // Reset results.
  searchResults.innerHTML = '';
  searchResultCount = 0;
  searchTruncated = false;
  searchLastFile = null;
  searchStatus.textContent = 'Searching...';

  const result = await window.api.searchText(searchCwd, query, { caseSensitive: !!caseSensitive });
  // Check if a newer search was started or the query was cleared while awaiting.
  if (gen !== searchGeneration) {
    // Stale: cancel the search we just started and discard its result.
    if (result.searchId) window.api.cancelSearch(result.searchId);
    return result;
  }
  if (result.error) {
    searchStatus.textContent = result.error;
    return result;
  }
  currentSearchId = result.searchId;
  return result;
});

// Receive search results from main process.
window.api.onSearchResult(({ searchId, result }) => {
  if (searchId !== currentSearchId) return; // stale result
  appendSearchResult(result);
});

window.api.onSearchDone(({ searchId, truncated, totalCount, error, cancelled }) => {
  if (searchId !== currentSearchId) return;
  if (cancelled) return;
  if (error) {
    searchResults.innerHTML = '';
    searchStatus.textContent = `Search error: ${error}`;
    return;
  }
  searchTruncated = truncated;
  if (searchResultCount === 0) {
    searchResults.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'search-result-empty';
    empty.textContent = 'No results found';
    searchResults.appendChild(empty);
  }
  searchStatus.textContent = truncated
    ? `${totalCount}+ results (truncated)`
    : `${totalCount} result${totalCount === 1 ? '' : 's'}`;
});

function appendSearchResult(result) {
  searchResultCount++;

  // Group by file: only insert a header when the file changes.
  const relativePath = getRelativePath(result.file);

  if (searchLastFile !== result.file) {
    const fileHeader = document.createElement('div');
    fileHeader.className = 'search-result-file';
    fileHeader.dataset.path = result.file;
    fileHeader.textContent = relativePath;
    searchResults.appendChild(fileHeader);
    searchLastFile = result.file;
  }

  const item = document.createElement('div');
  item.className = 'search-result-item';
  item.innerHTML =
    `<span class="search-result-line">${result.line}</span>` +
    `<span class="search-result-text">${escapeHtml(result.text)}</span>`;
  item.addEventListener('click', () => {
    openSearchResult(result);
  });
  searchResults.appendChild(item);
}

function getRelativePath(filePath) {
  const project = projects.get(activeProjectId);
  if (!project) return filePath;
  const prefix = project.path;
  if (filePath.startsWith(prefix)) {
    const rel = filePath.slice(prefix.length).replace(/^[\\/]+/, '');
    return rel || filePath;
  }
  return filePath;
}

async function openSearchResult(result) {
  // Open the file in the preview/editor, then reveal the line.
  const shown = await dispatch('preview_open', { path: result.file, reason: 'search' });
  if (shown?.shown && result.line > 0) {
    await dispatch('preview_reveal', { previewPath: shown.previewPath, line: result.line });
  }
}

// Search input handler.
if (searchInput) {
  let searchTimeout;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const query = searchInput.value.trim();
    if (!query) {
      // Invalidate current search: bump generation, cancel process, clear DOM.
      searchGeneration++;
      if (currentSearchId) {
        window.api.cancelSearch(currentSearchId);
        currentSearchId = null;
      }
      searchResults.innerHTML = '';
      searchStatus.textContent = '';
      return;
    }
    searchTimeout = setTimeout(() => {
      dispatch('search_text', {
        query,
        caseSensitive: searchCaseCheckbox?.checked || false,
      });
    }, 200);
  });
  searchInput.addEventListener('keydown', (e) => {
    // Escape is handled by the keybinding registry (search_close, when: searchFocus).
    if (e.key === 'Enter') {
      e.preventDefault();
      const query = searchInput.value.trim();
      if (query) {
        dispatch('search_text', {
          query,
          caseSensitive: searchCaseCheckbox?.checked || false,
        });
      }
    }
  });
}

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
    search: 'search-content',
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
  try {
    const savedHeight = Number(localStorage.getItem('pm-scratch-expanded-height'));
    if (Number.isFinite(savedHeight) && savedHeight >= SCRATCH_COMPACT_HEIGHT) {
      savedScratchEditorHeight = clampScratchExpandedHeight(savedHeight);
    }
    setScratchCollapsed(localStorage.getItem('pm-scratch-collapsed') === 'true');
  } catch {
    setScratchCollapsed(false);
  }
  await loadProjects();
  await loadLayout();
  if (tabs.size === 0 && projects.size > 0) {
    const p = projects.values().next().value;
    await dispatch('select_project', { projectId: p.id });
    await dispatch('create_terminal', { command: defaultShell(), cwd: p.path, projectId: p.id });
  }
  if (!editorStateInitialized) switchProjectEditor(activeProjectId);
})();
