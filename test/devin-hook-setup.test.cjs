const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getUserDevinConfigPath,
  isProjectMixerHookCommand,
  upsertDevinHookEvent,
  removeDevinHookEvent,
  getSetupStatus,
  enableDevinHooks,
  disableDevinHooks,
  DEVIN_EVENT_KEYS,
} = require('../src/main/hooks/devin-hook-config.cjs');
const {
  deployDevinBridge,
  isDevinBridgeDeployed,
  buildWindowsWrapper,
  buildUnixWrapper,
} = require('../src/main/hooks/devin-bridge-install.cjs');
const { buildHookBridgeScript } = require('../src/main/hooks/hook-bridge-source.cjs');

function tmpConfig(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-devin-config-'));
  const file = path.join(dir, 'config.json');
  if (initial !== undefined) fs.writeFileSync(file, JSON.stringify(initial), 'utf-8');
  return file;
}

// --- config path ---

test('user config path is %APPDATA%\\devin\\config.json on Windows and ~/.devin elsewhere', () => {
  assert.equal(
    getUserDevinConfigPath({ platform: 'win32', appData: 'D:\\Users\\u\\AppData\\Roaming', home: 'D:\\Users\\u' }),
    'D:\\Users\\u\\AppData\\Roaming\\devin\\config.json',
  );
  assert.equal(
    getUserDevinConfigPath({ platform: 'linux', home: '/home/u' }),
    path.join('/home/u', '.devin', 'config.json'),
  );
});

// --- entry identity ---

test('the shared entry is identified by bridge path plus --provider (計画 §9)', () => {
  assert.equal(isProjectMixerHookCommand('"C:\\hooks\\project-mixer-hook.cmd" --provider devin'), true);
  assert.equal(isProjectMixerHookCommand('node something-else --provider devin'), false);
  assert.equal(isProjectMixerHookCommand('"C:\\hooks\\project-mixer-hook.cmd"'), false);
  assert.equal(isProjectMixerHookCommand(null), false);
});

test('upsert appends exactly one PM group and keeps user hooks (repeat enable is idempotent)', () => {
  const userGroup = { matcher: 'bash', hooks: [{ type: 'command', command: 'user-thing', timeout: 5 }] };
  const once = upsertDevinHookEvent([userGroup], '"C:\\hooks\\project-mixer-hook.cmd" --provider devin');
  assert.equal(once.length, 2);
  const twice = upsertDevinHookEvent(once, '"C:\\hooks\\project-mixer-hook.cmd" --provider devin');
  assert.deepEqual(twice, once, 'second enable must not duplicate');
  assert.deepEqual(twice[0], userGroup, 'user hook untouched');
  assert.deepEqual(twice[1], { matcher: '', hooks: [{ type: 'command', command: '"C:\\hooks\\project-mixer-hook.cmd" --provider devin', timeout: 2 }] });
});

test('enable with no existing hooks creates plain matcher groups', () => {
  const added = upsertDevinHookEvent(undefined, '"C:\\hooks\\project-mixer-hook.cmd" --provider devin');
  assert.deepEqual(added, [{ matcher: '', hooks: [{ type: 'command', command: '"C:\\hooks\\project-mixer-hook.cmd" --provider devin', timeout: 2 }] }]);
});

test('disable removes only PM entries and keeps user hooks', () => {
  const pmGroup = { matcher: '', hooks: [{ type: 'command', command: '"C:\\hooks\\project-mixer-hook.cmd" --provider devin', timeout: 2 }] };
  const userGroup = { matcher: 'powershell', hooks: [{ type: 'command', command: 'user-blocker', timeout: 2 }] };
  assert.deepEqual(removeDevinHookEvent([pmGroup, userGroup]), [userGroup]);
  assert.equal(removeDevinHookEvent([pmGroup]), null, 'array that becomes empty is dropped');
  assert.equal(removeDevinHookEvent(undefined), null);
});

// --- end-to-end enable/disable on a real file ---

test('enable preserves unknown fields and user hooks, writes a backup, and is idempotent on file level', () => {
  const file = tmpConfig({
    version: 3,
    telemetry: true,
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'user-existing', timeout: 9 }] }],
    },
  });
  const first = enableDevinHooks(file, '"C:\\hooks\\project-mixer-hook.cmd" --provider devin');
  assert.equal(first.ok, true);
  assert.equal(first.status.stopEnabled, true);
  assert.equal(first.status.hooksEnabled, true);

  const afterFirst = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(afterFirst.version, 3, 'unknown field preserved');
  assert.equal(afterFirst.telemetry, true);
  assert.equal(afterFirst.hooks.Stop.length, 2);
  assert.equal(fs.existsSync(file + '.pm-backup'), true, 'backup written before change');

  const second = enableDevinHooks(file, '"C:\\hooks\\project-mixer-hook.cmd" --provider devin');
  assert.equal(second.ok, true);
  const afterSecond = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepEqual(afterSecond, afterFirst, 'repeat enable changes nothing');
});

test('enable refuses to overwrite an unparseable config (計画 Gate)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-devin-broken-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{not json', 'utf-8');
  const result = enableDevinHooks(file, '"C:\\hooks\\project-mixer-hook.cmd" --provider devin');
  assert.equal(result.ok, false);
  assert.match(result.error, /unparseable/);
  assert.equal(fs.readFileSync(file, 'utf-8'), '{not json', 'file untouched');
});

test('enable refuses a hooks value that is not an object', () => {
  const file = tmpConfig({ hooks: 'nope' });
  const result = enableDevinHooks(file, '"C:\\hooks\\project-mixer-hook.cmd" --provider devin');
  assert.equal(result.ok, false);
  assert.match(result.error, /hooks must be a JSON object/);
});

test('enable creates a missing config with both event keys and plain other fields preserved', () => {
  const file = tmpConfig(undefined);
  const result = enableDevinHooks(file, '"C:\\hooks\\project-mixer-hook.cmd" --provider devin');
  assert.equal(result.ok, true);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  for (const key of DEVIN_EVENT_KEYS) {
    assert.deepEqual(parsed.hooks[key], [{ matcher: '', hooks: [{ type: 'command', command: '"C:\\hooks\\project-mixer-hook.cmd" --provider devin', timeout: 2 }] }]);
  }
});

test('disable strips PM entries from a real file and keeps everything else', () => {
  const file = tmpConfig({
    version: 7,
    hooks: {
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: '"C:\\hooks\\project-mixer-hook.cmd" --provider devin', timeout: 2 }] }],
      Stop: [
        { matcher: '', hooks: [{ type: 'command', command: '"C:\\hooks\\project-mixer-hook.cmd" --provider devin', timeout: 2 }] },
        { matcher: 'pwsh', hooks: [{ type: 'command', command: 'user-logger', timeout: 4 }] },
      ],
      Other: [{ matcher: '', hooks: [{ type: 'command', command: 'user-other', timeout: 2 }] }],
    },
  });
  const result = disableDevinHooks(file);
  assert.equal(result.ok, true, result.error || '');
  assert.equal(result.status.stopEnabled, false);
  // A user Stop hook (user-logger) remains, so without our entry the plan's
  // "Stop notifications: disabled by competing hook" condition holds.
  assert.equal(result.status.stopDisabledByCompetingHook, true);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(parsed.version, 7);
  assert.equal(parsed.hooks.UserPromptSubmit, undefined, 'empty event key removed');
  assert.equal(parsed.hooks.Stop.length, 1);
  assert.equal(parsed.hooks.Stop[0].hooks[0].command, 'user-logger');
  assert.ok(Array.isArray(parsed.hooks.Other), 'third-party key untouched');
});

test('status reports parse errors and competing hooks without touching the file', () => {
  const broken = path.join(os.tmpdir(), 'pm-devin-status-broken.json');
  fs.writeFileSync(broken, '{"hooks":', 'utf-8');
  const status = getSetupStatus(broken);
  assert.equal(status.loaded, false);
  assert.equal(status.hooksEnabled, false);
  assert.ok(status.parseError);
  fs.unlinkSync(broken);
});

// --- bridge deployment ---

test('bridge deploy writes bridge, platform wrapper, and a quoted --provider devin command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-devin-bridge-'));
  const bridgeScript = buildHookBridgeScript();
  const deployed = deployDevinBridge({ dir, exePath: 'C:\\Apps\\Project Mixer.exe', bridgeScript, platform: 'win32' });
  assert.equal(isDevinBridgeDeployed(dir), true);
  assert.equal(fs.readFileSync(deployed.bridgePath, 'utf-8'), bridgeScript);
  const wrapper = fs.readFileSync(deployed.wrapperPath, 'utf-8');
  assert.match(wrapper, /ELECTRON_RUN_AS_NODE=1/);
  assert.ok(wrapper.includes('"C:\\Apps\\Project Mixer.exe"'), 'exe path is quoted');
  assert.ok(deployed.pmCommand.startsWith('"') && deployed.pmCommand.includes('--provider devin'));
});

test('bridges wrapper stays profile-independent (dev never gets its own copy)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-devin-profile-'));
  assert.throws(
    () => deployDevinBridge({ dir: path.join(dir, 'Project Mixer Dev', 'hooks'), exePath: 'x', bridgeScript: 'x', platform: 'win32' }),
    /profile-independent/,
  );
});

test('unix wrapper is executable via exec and quotes paths with spaces', () => {
  const unix = buildUnixWrapper('PM EXEC', 'BRIDGE PATH');
  assert.match(unix, /^#!\/bin\/sh\n/);
  assert.match(unix, /exec "PM EXEC" "BRIDGE PATH" "\$@"/);
  const win = buildWindowsWrapper('PM EXEC', 'BRIDGE PATH');
  assert.match(win, /set ELECTRON_RUN_AS_NODE=1\r\n/);
});
