// test/refactor-r4.test.cjs
// R4: tests for the extracted main-process services. These run without
// Electron so they can verify config parse/atomic-write behavior directly.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ConfigParseError,
  readConfig,
  writeConfig,
  validateProjects,
  validateLayout,
} = require('../src/main/config-service.cjs');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pm-r4-'));
}

test('R4/config: readConfig returns fallback for a missing file', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'missing.json');
    assert.deepEqual(readConfig(file, []), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R4/config: readConfig throws ConfigParseError on corrupt JSON', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'projects.json');
    fs.writeFileSync(file, '{ not valid json', 'utf-8');
    assert.throws(() => readConfig(file, []), ConfigParseError);
    // The corrupt file must NOT be overwritten by the caller — verify the
    // content is still the original corrupt text.
    assert.equal(fs.readFileSync(file, 'utf-8'), '{ not valid json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R4/config: writeConfig writes atomically and reads back', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'projects.json');
    writeConfig(file, [{ id: 'p1', name: 'P1', path: 'D:\\p1' }]);
    const back = readConfig(file, []);
    assert.equal(back.length, 1);
    assert.equal(back[0].id, 'p1');
    // No leftover temp file.
    const temps = fs.readdirSync(dir).filter((n) => n.startsWith('.projects.json.'));
    assert.equal(temps.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R4/config: validateProjects accepts a valid array', () => {
  const r = validateProjects([{ id: 'p1', name: 'P1', path: 'D:\\p1' }]);
  assert.equal(r.ok, true);
});

test('R4/config: validateProjects rejects non-array', () => {
  assert.equal(validateProjects({}).ok, false);
  assert.equal(validateProjects(null).ok, false);
});

test('R4/config: validateProjects rejects entries missing fields', () => {
  assert.equal(validateProjects([{ id: 'p1', name: 'P1' }]).ok, false);
  assert.equal(validateProjects([{ id: 1, name: 'P1', path: 'x' }]).ok, false);
});

test('R4/config: validateLayout accepts null or object', () => {
  assert.equal(validateLayout(null).ok, true);
  assert.equal(validateLayout({ activeProjectId: 'p1' }).ok, true);
});

test('R4/config: validateLayout rejects arrays and primitives', () => {
  assert.equal(validateLayout([]).ok, false);
  assert.equal(validateLayout('x').ok, false);
});

// Static checks: main.js must route config writes through the service and
// stop on corrupt config (R1 decision #2).

test('R4/static: main.js imports config-service', () => {
  const main = read('main.js');
  assert.match(main, /require\('\.\/src\/main\/config-service\.cjs'\)/);
});

test('R4/static: main.js uses atomic writeConfig, not raw writeFileSync for config', () => {
  const main = read('main.js');
  // The old saveJson that used writeFileSync directly must be gone.
  assert.doesNotMatch(main, /function saveJson\(file, data\) \{[^}]*writeFileSync/);
  // Config writes must go through writeConfig (atomic).
  assert.match(main, /writeConfig\(/);
});
