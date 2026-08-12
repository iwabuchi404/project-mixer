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
  for (const p of value) {
    if (!p || typeof p !== 'object') {
      return { ok: false, code: 'INVALID_ENTRY', message: 'each project must be an object' };
    }
    if (typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.path !== 'string') {
      return { ok: false, code: 'MISSING_FIELDS', message: 'each project needs id, name, path (string)' };
    }
  }
  return { ok: true, value };
}

// Validate that a layout object is a plain object (or null).
function validateLayout(value) {
  if (value === null) return { ok: true, value };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'NOT_OBJECT', message: 'layout.json must be an object or null' };
  }
  return { ok: true, value };
}

module.exports = {
  ConfigParseError,
  readConfig,
  writeConfig,
  validateProjects,
  validateLayout,
};
