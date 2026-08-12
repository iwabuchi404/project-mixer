// src/store/index.js
// Focus state store: the single source of truth for "what the human is
// looking at right now" and agent attention state (badges, waiting).
//
// R2 scope: badge and waiting state are centralized here so that project
// list re-renders no longer drop them. Runtime handles (DOM, Terminal,
// FitAddon, Promise) stay in renderer-side registries, not here.

const subscribers = new Set();

const state = {
  // Which project the human is working in
  activeProjectId: null,

  // Editor / preview state
  activeFilePath: null,   // null when no file open
  isPreview: false,       // true if active tab is a preview
  cursorLine: null,       // 1-based, null if not applicable
  selection: null,        // { startLine, endLine } 1-based, null if no selection

  // Terminal state
  activeTerminalTabId: null,

  // Scratch (human→AI input channel)
  scratchContent: '',

  // R2: agent attention state — previously DOM-only, now authoritative here.
  // projectBadges: { [projectId]: string } — badge kind, or null/undefined for none.
  projectBadges: {},
  // waitingTabs: { [tabId]: { projectId: string, waiting: boolean } }
  waitingTabs: {},
};

export function getState() {
  return { ...state };
}

export function setState(patch) {
  let changed = false;
  for (const key of Object.keys(patch)) {
    if (state[key] !== patch[key]) {
      state[key] = patch[key];
      changed = true;
    }
  }
  if (changed) {
    for (const fn of subscribers) {
      try { fn(state); } catch (e) { console.error('[store] subscriber error:', e); }
    }
  }
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getProjectScratchContent(openFiles, activeFilePath, scratchPath) {
  const activeFile = openFiles.get(activeFilePath);
  const scratchFile = activeFile?.isScratch
    ? activeFile
    : openFiles.get(scratchPath);
  return scratchFile?.content || '';
}

// R2: selectors for badge and waiting state.

export function getProjectBadge(projectId) {
  return state.projectBadges[projectId] || null;
}

export function getWaitingSummary() {
  const summary = {};
  for (const info of Object.values(state.waitingTabs)) {
    if (info && info.waiting) {
      summary[info.projectId] = (summary[info.projectId] || 0) + 1;
    }
  }
  return summary;
}

export function isTabWaiting(tabId) {
  return Boolean(state.waitingTabs[tabId]?.waiting);
}

// Build the get_focus response from current state + project lookup
export function buildFocusState(projectLookup) {
  const project = projectLookup(state.activeProjectId);
  const s = state;

  return {
    project: project ? {
      id: project.id,
      name: project.name,
      path: project.path,
    } : null,

    editor: s.activeFilePath ? {
      activeTab: s.activeFilePath,
      filePath: s.activeFilePath,
      isPreview: s.isPreview,
      selection: s.selection,
      cursorLine: s.cursorLine,
    } : null,

    terminal: s.activeTerminalTabId ? {
      activeTabId: s.activeTerminalTabId,
      // command and cwd are filled by renderer (it has the tabs Map)
    } : null,

    scratch: {
      content: s.scratchContent,
      length: s.scratchContent.length,
    },
  };
}
