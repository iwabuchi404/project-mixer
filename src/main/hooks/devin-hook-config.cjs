// src/main/hooks/devin-hook-config.cjs
// User-level Devin hook configuration (Devin Hooks 通知統合計画 §9, D4).
//
// Devin's user-level config lives at %APPDATA%\devin\config.json on Windows.
// Project Mixer never touches project-level files: Enable merges its shared
// entries into the `hooks` value of the user config, preserving every unknown
// field and any user hooks. A parse failure is refused, never overwritten.
// Every mutation takes a backup and replaces the file atomically.

const fs = require('fs');
const path = require('path');
const { writeTextAtomic } = require('../../ports/state.cjs');

const DEVIN_EVENT_KEYS = Object.freeze(['UserPromptSubmit', 'Stop']);
const BACKUP_SUFFIX = '.pm-backup';

function getUserDevinConfigPath({ platform = process.platform, appData = process.env.APPDATA, home = require('os').homedir() } = {}) {
  if (platform === 'win32') {
    if (typeof appData !== 'string' || !appData.trim()) {
      throw new Error('APPDATA is not set; cannot locate the Devin user config');
    }
    return path.join(appData, 'devin', 'config.json');
  }
  return path.join(home, '.devin', 'config.json');
}

// 計画 §9: the shared entry is identified by the bridge path,
// `--provider devin`, and the event keys — never by custom fields.
function isProjectMixerHookCommand(command) {
  return typeof command === 'string'
    && command.includes('project-mixer-hook')
    && command.includes('--provider devin');
}

function isPmHookGroup(group) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return false;
  if (!Array.isArray(group.hooks)) return false;
  return group.hooks.some((h) => h && typeof h === 'object'
    && h.type === 'command'
    && isProjectMixerHookCommand(h.command));
}

function pmHookGroup(pmCommand) {
  return { matcher: '', hooks: [{ type: 'command', command: pmCommand, timeout: 2 }] };
}

// Idempotent merge for one event key: remove any previous PM entries, keep
// every user group untouched, and append exactly one PM group.
function upsertDevinHookEvent(existing, pmCommand) {
  const groups = Array.isArray(existing)
    ? existing.filter((g) => !isPmHookGroup(g))
    : [];
  groups.push(pmHookGroup(pmCommand));
  return groups;
}

// Disable must remove ONLY Project Mixer entries (計画 Gate). An event key
// whose array becomes empty is dropped; user hooks and unknown keys stay.
function removeDevinHookEvent(existing) {
  if (!Array.isArray(existing) || existing.length === 0) return null;
  const kept = existing.filter((g) => !isPmHookGroup(g));
  return kept.length === 0 ? null : kept;
}

function readConfigState(configPath) {
  if (!fs.existsSync(configPath)) {
    return { exists: false, parseOk: false, parsed: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { exists: true, parseOk: false, error: 'config.json must contain a JSON object' };
    }
    return { exists: true, parseOk: true, parsed };
  } catch (e) {
    return { exists: true, parseOk: false, error: e.message };
  }
}

function buildSetupStatus(configPath, configState) {
  const hooks = configState.parseOk && configState.parsed
  && typeof configState.parsed.hooks === 'object' && !Array.isArray(configState.parsed.hooks)
    ? configState.parsed.hooks
    : null;
  const eventHasPm = (key) => Array.isArray(hooks?.[key]) && hooks[key].some((g) => isPmHookGroup(g));
  const hasOtherCommandHook = (key) => {
    if (!Array.isArray(hooks?.[key]) || eventHasPm(key)) return false;
    return hooks[key].some((g) => g && typeof g === 'object'
      && Array.isArray(g.hooks)
      && g.hooks.some((h) => h && typeof h === 'object' && h.type === 'command'));
  };
  const hooksEnabled = DEVIN_EVENT_KEYS.every(eventHasPm);
  return {
    configPath,
    loaded: configState.parseOk,
    parseError: configState.parseOk ? null : (configState.error || 'config unreadable'),
    exists: configState.exists,
    hooksConfigured: Boolean(hooks),
    hooksEnabled,
    userPromptSubmitEnabled: eventHasPm('UserPromptSubmit'),
    stopEnabled: eventHasPm('Stop'),
    stopDisabledByCompetingHook: hasOtherCommandHook('Stop'),
  };
}

function getSetupStatus(configPath) {
  return buildSetupStatus(configPath, readConfigState(configPath));
}

function writeWithBackup(configPath, contents) {
  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, configPath + BACKUP_SUFFIX);
  }
  writeTextAtomic(configPath, contents, 'utf-8');
}

// 計画 Gate: enabling twice must not duplicate entries; user hooks and
// unknown fields survive; an unparseable config is never overwritten.
function enableDevinHooks(configPath, pmCommand) {
  if (typeof pmCommand !== 'string' || !pmCommand.trim()) {
    return { ok: false, error: 'pmCommand is required' };
  }
  const state = readConfigState(configPath);
  if (state.exists && !state.parseOk) {
    return { ok: false, error: `refusing to overwrite unparseable config: ${state.error}`, status: buildSetupStatus(configPath, state) };
  }
  const parsed = state.parsed || {};
  if (parsed.hooks !== undefined
    && (typeof parsed.hooks !== 'object' || Array.isArray(parsed.hooks))) {
    return { ok: false, error: 'hooks must be a JSON object', status: buildSetupStatus(configPath, state) };
  }
  const nextHooks = { ...(parsed.hooks || {}) };
  for (const key of DEVIN_EVENT_KEYS) {
    const existing = nextHooks[key];
    if (existing !== undefined && !Array.isArray(existing)) {
      return { ok: false, error: `hooks.${key} must be an array`, status: buildSetupStatus(configPath, state) };
    }
    nextHooks[key] = upsertDevinHookEvent(existing, pmCommand);
  }
  try {
    writeWithBackup(configPath, JSON.stringify({ ...parsed, hooks: nextHooks }, null, 2));
  } catch (e) {
    return { ok: false, error: e.message, status: buildSetupStatus(configPath, state) };
  }
  return { ok: true, status: getSetupStatus(configPath) };
}

function disableDevinHooks(configPath) {
  const state = readConfigState(configPath);
  if (!state.exists) {
    return { ok: true, status: buildSetupStatus(configPath, state) };
  }
  if (!state.parseOk) {
    return { ok: false, error: `refusing to overwrite unparseable config: ${state.error}`, status: buildSetupStatus(configPath, state) };
  }
  const hooks = typeof state.parsed.hooks === 'object' && state.parsed.hooks !== null
    ? state.parsed.hooks
    : {};
  const nextHooks = { ...hooks };
  for (const key of DEVIN_EVENT_KEYS) {
    if (nextHooks[key] === undefined) continue;
    if (!Array.isArray(nextHooks[key])) {
      return { ok: false, error: `hooks.${key} must be an array`, status: buildSetupStatus(configPath, state) };
    }
    const kept = removeDevinHookEvent(nextHooks[key]);
    if (kept === null) delete nextHooks[key];
    else nextHooks[key] = kept;
  }
  try {
    writeWithBackup(configPath, JSON.stringify({ ...state.parsed, hooks: nextHooks }, null, 2));
  } catch (e) {
    return { ok: false, error: e.message, status: buildSetupStatus(configPath, state) };
  }
  return { ok: true, status: getSetupStatus(configPath) };
}

module.exports = {
  DEVIN_EVENT_KEYS,
  getUserDevinConfigPath,
  isProjectMixerHookCommand,
  isPmHookGroup,
  upsertDevinHookEvent,
  removeDevinHookEvent,
  getSetupStatus,
  readConfigState,
  enableDevinHooks,
  disableDevinHooks,
};
