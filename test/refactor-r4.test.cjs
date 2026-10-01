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
  validateSettings,
} = require('../src/main/config-service.cjs');
const { resolveProjectPath } = require('../src/main/path-safety.cjs');

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

test('R4/config: readConfig rejects invalid settings without overwriting them', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'settings.json');
    const original = '{"resumeMode":"sometimes"}';
    fs.writeFileSync(file, original, 'utf-8');
    assert.throws(() => readConfig(file, { resumeMode: 'ask' }), ConfigParseError);
    assert.equal(fs.readFileSync(file, 'utf-8'), original);
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

test('R4/config: validateProjects rejects duplicate ids', () => {
  assert.equal(validateProjects([
    { id: 'p1', name: 'P1', path: 'D:\\p1' },
    { id: 'p1', name: 'P1 copy', path: 'D:\\p2' },
  ]).ok, false);
});

test('R4/config: validateLayout accepts null or object', () => {
  assert.equal(validateLayout(null).ok, true);
  assert.equal(validateLayout({ activeProjectId: 'p1' }).ok, true);
});

test('R4/config: validateSettings accepts legacy values and rejects malformed input', () => {
  assert.equal(validateSettings(null).ok, true);
  assert.equal(validateSettings({ resumeMode: 'ask' }).ok, true);
  assert.equal(validateSettings({ resumeMode: 'auto', futureFlag: true }).ok, true);
  assert.equal(validateSettings([]).ok, false);
  assert.equal(validateSettings({ resumeMode: 'sometimes' }).ok, false);
});

test('R4/config: validateLayout strictly validates top-level fields and preserves old data', () => {
  const legacy = {
    activeProjectId: null,
    tabs: [{ command: 'pwsh.exe', label: 'PowerShell', cwd: 'D:\\work', projectId: null }],
    terminalSendModes: { codex: 'bracketed' },
    pushFocusEnabled: false,
  };
  const result = validateLayout(legacy);
  assert.equal(result.ok, true);
  assert.equal(result.value, legacy);
  assert.equal(validateLayout({ tabs: {} }).ok, false);
  assert.equal(validateLayout({ terminalSendModes: null }).ok, false);
  assert.equal(validateLayout({ pushFocusEnabled: 'yes' }).ok, false);
  assert.equal(validateLayout({ activeProjectId: 1 }).ok, false);
});

test('R4/config: validateLayout rejects arrays and primitives', () => {
  assert.equal(validateLayout([]).ok, false);
  assert.equal(validateLayout('x').ok, false);
});

test('R4/config: validateLayout accepts the current pane schema', () => {
  const result = validateLayout({
    paneLayouts: {
      p1: {
        direction: 'row',
        activeIndex: 0,
        panes: [{
          size: 320,
          members: [0, 1],
          active: 1,
          view: null,
        }],
      },
    },
  });
  assert.equal(result.ok, true);
});

test('R4/config: validateLayout accepts 2x2 layout metadata and bounds panes', () => {
  const result = validateLayout({
    paneLayouts: {
      p1: {
        direction: 'row',
        layoutMode: 'grid',
        activeIndex: 0,
        panes: [0, 1, 2, 3].map((slot) => ({ size: 0, members: [], active: null, slot, view: null })),
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(validateLayout({
    paneLayouts: {
      p1: {
        layoutMode: 'grid',
        activeIndex: 0,
        panes: [0, 1, 2, 3, 4].map((slot) => ({ members: [], slot, view: null })),
      },
    },
  }).ok, false);
});

test('R4/config: validateLayout rejects malformed nested pane data', () => {
  assert.equal(validateLayout({
    paneLayouts: {
      p1: {
        direction: 'row',
        activeIndex: 0,
        panes: [{ size: 0, members: null, active: null, view: null }],
      },
    },
  }).ok, false);
  assert.equal(validateLayout({
    paneLayouts: {
      p1: {
        direction: 'row',
        activeIndex: -1,
        panes: [{ size: 0, members: [], active: null, view: null }],
      },
    },
  }).ok, false);
});

// Static checks: main.js must route config writes through the service and
// stop on corrupt config (R1 decision #2).

test('R4/path: project-scoped paths reject outside targets and symlink escapes', () => {
  const root = tmpDir();
  const outside = tmpDir();
  const projects = [{ id: 'p1', path: root }];
  try {
    const file = path.join(root, 'inside.txt');
    fs.writeFileSync(file, 'inside', 'utf8');
    assert.equal(resolveProjectPath(projects, file).target, fs.realpathSync(file));
    assert.throws(() => resolveProjectPath(projects, path.join(outside, 'secret.txt')));
    const link = path.join(root, 'escape');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      assert.throws(() => resolveProjectPath(projects, path.join(link, 'secret.txt')));
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

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
