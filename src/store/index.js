// src/store/index.js
// Focus state store: the single source of truth for "what the human is
// looking at right now". Updated via commands, read by get_focus.
//
// Phase 1 scope: only the state needed by get_focus is centralized here.
// Other UI state (terminal send modes, tree expansion, etc.) stays in
// renderer.js as before and migrates incrementally.

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
