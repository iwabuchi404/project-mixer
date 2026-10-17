// src/main/config-service.cjs
// R4: config persistence service. Extracted from main.js so it can be tested
// without Electron. Responsibilities:
//   - parse JSON config files with schema validation
//   - on parse failure, throw (caller decides whether to stop startup or
//     present a recovery UI — per R1 decision, startup stops)
//   - atomic writes via the shared persistence helper
//
// Discipline: this module never calls app.getPath — the caller passes in
// the file paths. This keeps it Electron-free and unit-testable.

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../ports/state.cjs');

// Read a JSON config file. On a missing file, returns the fallback.
// On a parse error, throws a ConfigParseError so callers can distinguish
// "file does not exist" from "file is corrupt" and avoid overwriting
// corrupt data.
class ConfigParseError extends Error {
  constructor(file, cause) {
    super(`Corrupt config file ${file}: ${cause.message}`);
    this.name = 'ConfigParseError';
    this.file = file;
    this.cause = cause;
  }
}

function readConfig(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    throw new ConfigParseError(file, e);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new ConfigParseError(file, e);
  }
  if (path.basename(file) === 'settings.json') {
    const validation = validateSettings(data);
    if (!validation.ok) throw new ConfigParseError(file, new Error(validation.message));
    return validation.value;
  }
  return data;
}

// Write a config file atomically. The temp-file + rename pattern in
// writeJsonAtomic ensures readers never see a partial document.
function writeConfig(file, data) {
  writeJsonAtomic(file, data);
}

// Validate that a projects list is an array of objects with id/name/path.
function validateProjects(value) {
  if (!Array.isArray(value)) {
    return { ok: false, code: 'NOT_ARRAY', message: 'projects.json must be an array' };
  }
  const ids = new Set();
  const paths = new Set();
  for (const p of value) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return { ok: false, code: 'INVALID_ENTRY', message: 'each project must be an object' };
    }
    if (typeof p.id !== 'string' || !p.id || p.id.length > 200
      || typeof p.name !== 'string' || !p.name || p.name.length > 200
      || typeof p.path !== 'string' || !p.path || p.path.length > 4096) {
      return { ok: false, code: 'MISSING_FIELDS', message: 'each project needs non-empty id, name, path strings' };
    }
    if (ids.has(p.id)) {
      return { ok: false, code: 'DUPLICATE_ID', message: `duplicate project id: ${p.id}` };
    }
    let canonicalPath;
    try {
      canonicalPath = fs.realpathSync.native(p.path);
    } catch {
      canonicalPath = path.resolve(p.path);
    }
    const comparablePath = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
    if (paths.has(comparablePath)) {
      return { ok: false, code: 'DUPLICATE_PATH', message: `duplicate project path: ${p.path}` };
    }
    ids.add(p.id);
    paths.add(comparablePath);
  }
  return { ok: true, value };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateSettings(value) {
  if (value === null) return { ok: true, value };
  if (!isRecord(value)) {
    return { ok: false, code: 'NOT_OBJECT', message: 'settings.json must be an object or null' };
  }
  if (value.resumeMode !== undefined && value.resumeMode !== 'ask' && value.resumeMode !== 'auto') {
    return { ok: false, code: 'INVALID_RESUME_MODE', message: 'resumeMode must be ask or auto' };
  }
  return { ok: true, value };
}

function validateLayout(value) {
  if (value === null) return { ok: true, value };
  if (!isRecord(value)) {
    return { ok: false, code: 'NOT_OBJECT', message: 'layout.json must be an object or null' };
  }
  if (value.activeProjectId !== undefined && value.activeProjectId !== null && typeof value.activeProjectId !== 'string') {
    return { ok: false, code: 'INVALID_ACTIVE_PROJECT', message: 'activeProjectId must be a string or null' };
  }
  if (value.tabs !== undefined) {
    if (!Array.isArray(value.tabs)) {
      return { ok: false, code: 'INVALID_TABS', message: 'tabs must be an array' };
    }
    for (const tab of value.tabs) {
      if (!isRecord(tab) || typeof tab.command !== 'string' || !tab.command
        || typeof tab.label !== 'string'
        || (tab.cwd !== undefined && typeof tab.cwd !== 'string')
        || (tab.projectId !== undefined && tab.projectId !== null && typeof tab.projectId !== 'string')
        || (tab.devinSessionId !== undefined && typeof tab.devinSessionId !== 'string')) {
        return { ok: false, code: 'INVALID_TAB', message: 'layout contains an invalid tab' };
      }
    }
  }
  if (value.terminalSendModes !== undefined && !isRecord(value.terminalSendModes)) {
    return { ok: false, code: 'INVALID_TERMINAL_SEND_MODES', message: 'terminalSendModes must be an object' };
  }
  if (value.pushFocusEnabled !== undefined && typeof value.pushFocusEnabled !== 'boolean') {
    return { ok: false, code: 'INVALID_PUSH_FOCUS', message: 'pushFocusEnabled must be a boolean' };
  }
  if (value.nonTerminalTabs !== undefined) {
    if (!Array.isArray(value.nonTerminalTabs) || value.nonTerminalTabs.length > 10000) {
      return { ok: false, code: 'INVALID_NON_TERMINAL_TABS', message: 'nonTerminalTabs must be a bounded array' };
    }
    for (const tab of value.nonTerminalTabs) {
      if (!isRecord(tab)
        || !['file', 'preview', 'search', 'attention'].includes(tab.type)
        || typeof tab.projectId !== 'string' || !tab.projectId
        || !Number.isInteger(tab.paneIndex) || tab.paneIndex < 0
        // search and attention are panes, not files, so they carry no path.
        || (!['search', 'attention'].includes(tab.type) && typeof tab.path !== 'string')
        || (tab.type === 'preview' && typeof tab.previewPath !== 'string')) {
        return { ok: false, code: 'INVALID_NON_TERMINAL_TAB', message: 'layout contains an invalid non-terminal tab' };
      }
    }
  }
  if (value.paneLayouts === undefined) return { ok: true, value };
  if (!isRecord(value.paneLayouts)) {
    return { ok: false, code: 'INVALID_PANE_LAYOUTS', message: 'paneLayouts must be an object' };
  }
  for (const [projectId, saved] of Object.entries(value.paneLayouts)) {
    if (!projectId || !isRecord(saved)) {
      return { ok: false, code: 'INVALID_PANE_LAYOUT', message: `invalid pane layout for ${projectId}` };
    }
    if (!Array.isArray(saved.panes) || saved.panes.length === 0) {
      return { ok: false, code: 'INVALID_PANES', message: `pane layout for ${projectId} needs panes` };
    }
    if (saved.activeIndex !== undefined && (!Number.isInteger(saved.activeIndex) || saved.activeIndex < 0 || saved.activeIndex >= saved.panes.length)) {
      return { ok: false, code: 'INVALID_ACTIVE_PANE', message: `invalid active pane for ${projectId}` };
    }
    if (saved.direction !== undefined && saved.direction !== 'row' && saved.direction !== 'column') {
      return { ok: false, code: 'INVALID_PANE_DIRECTION', message: `invalid pane direction for ${projectId}` };
    }
    if (saved.layoutMode !== undefined && !['single', 'row', 'column', 'grid', 't'].includes(saved.layoutMode)) {
      return { ok: false, code: 'INVALID_PANE_LAYOUT_MODE', message: `invalid pane layout mode for ${projectId}` };
    }
    if (saved.panes.length > 4) {
      return { ok: false, code: 'TOO_MANY_PANES', message: `pane layout for ${projectId} exceeds four panes` };
    }
    for (const pane of saved.panes) {
      if (!isRecord(pane) || !Array.isArray(pane.members)) {
        return { ok: false, code: 'INVALID_PANE', message: `invalid pane entry for ${projectId}` };
      }
      if (pane.size !== undefined && (!Number.isFinite(pane.size) || pane.size < 0)) {
        return { ok: false, code: 'INVALID_PANE_SIZE', message: `invalid pane size for ${projectId}` };
      }
      if (pane.slot !== undefined && pane.slot !== null && (!Number.isInteger(pane.slot) || pane.slot < 0 || pane.slot > 3)) {
        return { ok: false, code: 'INVALID_PANE_SLOT', message: `invalid pane slot for ${projectId}` };
      }
      if (!pane.members.every((index) => Number.isInteger(index) && index >= 0)
        || new Set(pane.members).size !== pane.members.length) {
        return { ok: false, code: 'INVALID_PANE_MEMBERS', message: `invalid pane members for ${projectId}` };
      }
      if (pane.active !== undefined && pane.active !== null && (!Number.isInteger(pane.active) || pane.active < 0)) {
        return { ok: false, code: 'INVALID_ACTIVE_TAB', message: `invalid active tab for ${projectId}` };
      }
      if (pane.view !== undefined && pane.view !== null) {
        if (!isRecord(pane.view)
          || (pane.view.type !== undefined && typeof pane.view.type !== 'string')
          || (pane.view.path !== undefined && pane.view.path !== null && typeof pane.view.path !== 'string')) {
          return { ok: false, code: 'INVALID_PANE_VIEW', message: `invalid pane view for ${projectId}` };
        }
      }
    }
  }
  return { ok: true, value };
}

module.exports = {
  ConfigParseError,
  readConfig,
  writeConfig,
  validateProjects,
  validateSettings,
  validateLayout,
};
