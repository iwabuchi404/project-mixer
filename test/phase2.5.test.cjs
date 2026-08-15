const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

function loadBundledModule(entryPoint) {
  const result = esbuild.buildSync({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const module = { exports: {} };
  const evaluate = new Function('module', 'exports', 'require', result.outputFiles[0].text);
  evaluate(module, module.exports, require);
  return module.exports;
}

const phase25 = loadBundledModule(path.join(__dirname, '..', 'src', 'phase25', 'state.js'));
const { isProbablyBinary } = require('../src/files/content.cjs');

test('pinned-to-bottom follows the xterm active buffer positions', () => {
  assert.equal(phase25.isTerminalPinnedToBottom({ viewportY: 20, baseY: 20 }), true);
  assert.equal(phase25.isTerminalPinnedToBottom({ viewportY: 12, baseY: 20 }), false);
  assert.equal(phase25.isTerminalPinnedToBottom(null), false);
});

test('queued terminal output stops following after the user scrolls', () => {
  const state = { pinnedToBottom: true, outputFollowRevision: 0, userScrollActive: false };
  const followToken = phase25.captureTerminalFollowToken(state);

  phase25.invalidateTerminalFollow(state);
  state.userScrollActive = true;
  phase25.updateTerminalScrollPosition(state, { viewportY: 12, baseY: 20 });

  assert.equal(phase25.shouldFollowTerminalOutput(state, followToken), false);
});

test('old terminal output stays invalid after returning to the bottom', () => {
  const state = { pinnedToBottom: true, outputFollowRevision: 0, userScrollActive: false };
  const oldFollowToken = phase25.captureTerminalFollowToken(state);

  phase25.invalidateTerminalFollow(state);
  state.userScrollActive = true;
  phase25.updateTerminalScrollPosition(state, { viewportY: 12, baseY: 20 });
  phase25.updateTerminalScrollPosition(state, { viewportY: 20, baseY: 20 });

  assert.equal(phase25.shouldFollowTerminalOutput(state, oldFollowToken), false);
  const newFollowToken = phase25.captureTerminalFollowToken(state);
  assert.equal(phase25.shouldFollowTerminalOutput(state, newFollowToken), true);
});

test('content-driven xterm scrolling does not change user follow intent', () => {
  const state = { pinnedToBottom: true, outputFollowRevision: 0, userScrollActive: false };

  phase25.updateTerminalScrollPosition(state, { viewportY: 0, baseY: 20 });

  assert.equal(state.pinnedToBottom, true);
});

test('terminal drop paths are quoted for the active shell', () => {
  const windowsPath = String.raw`D:\My Project\O'Brien.txt`;
  assert.equal(
    phase25.quotePathForCommand(windowsPath, 'pwsh.exe'),
    String.raw`'D:\My Project\O''Brien.txt'`,
  );
  assert.equal(
    phase25.quotePathForCommand(String.raw`D:\My Project\a.txt`, 'cmd.exe'),
    String.raw`"D:\My Project\a.txt"`,
  );
  assert.equal(
    phase25.quotePathForCommand("/tmp/O'Brien.txt", 'bash'),
    "'/tmp/O'\\''Brien.txt'",
  );
  assert.equal(phase25.quotePathForCommand('README.md', 'claude'), 'README.md');
});

test('pane width capture ignores hidden zero-width measurements', () => {
  assert.equal(phase25.captureExpandedPaneWidth({
    isCollapsed: false,
    measuredWidth: 315,
    savedWidth: 200,
  }), 315);
  assert.equal(phase25.captureExpandedPaneWidth({
    isCollapsed: true,
    measuredWidth: 0,
    savedWidth: 315,
  }), 315);
});

test('normal files use the main editor surface while scratch stays below the terminal', () => {
  assert.equal(phase25.getEditorSurfaceKind({ isScratch: false }), 'main');
  assert.equal(phase25.getEditorSurfaceKind({ isScratch: true }), 'scratch');
});

test('binary detection keeps text previewable and rejects binary buffers', () => {
  assert.equal(isProbablyBinary(Buffer.from('hello\n日本語\n', 'utf8')), false);
  assert.equal(isProbablyBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])), true);
  assert.equal(isProbablyBinary(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])), true);
});

test('known binary document formats are delegated to the OS', () => {
  assert.equal(phase25.shouldOpenInOsByName('report.pdf'), true);
  assert.equal(phase25.shouldOpenInOsByName('archive.ZIP'), true);
  assert.equal(phase25.shouldOpenInOsByName('README'), false);
  assert.equal(phase25.shouldOpenInOsByName('source.ts'), false);
});

test('packaged app includes the main-process file inspection module', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('src/files/**/*'));
});

// register()/dispatch() は COMMAND_TYPES に無い名前で throw する。
// renderer.js のトップレベルで register するため、定義漏れは起動そのものを壊す。
// 単体テストは renderer をブラウザ環境で読み込まないので、静的に突き合わせる。
test('every command used by the renderer is declared in COMMAND_TYPES', () => {
  const types = loadBundledModule(path.join(__dirname, '..', 'src', 'commands', 'types.js'));
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

  const used = new Set();
  for (const match of renderer.matchAll(/\b(?:register|dispatch)\(\s*'([a-z_]+)'/g)) {
    used.add(match[1]);
  }

  assert.ok(used.has('add_project'), 'sanity: renderer should use add_project');
  const undeclared = [...used].filter((name) => !types.COMMAND_TYPES[name]);
  assert.deepEqual(undeclared, [], `undeclared commands: ${undeclared.join(', ')}`);
});

// メニューのアクセラレータは keydown より先に消費されるため、
// ターミナルが使うキーは registerAccelerator:false で登録しない。
test('menu accelerators that collide with terminal keys are display-only', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const menuSource = main.slice(main.indexOf('function setupApplicationMenu'));

  for (const key of ['CmdOrCtrl+S', 'CmdOrCtrl+B', 'CmdOrCtrl+Enter', 'CmdOrCtrl+Shift+Z']) {
    assert.ok(
      menuSource.includes(`displayOnly('${key}')`),
      `${key} must be registered as display-only`,
    );
    assert.ok(
      !menuSource.includes(`accelerator: '${key}'`),
      `${key} must not be a live menu accelerator`,
    );
  }
  assert.ok(!menuSource.includes(`'CmdOrCtrl+N'`), 'Ctrl+N must not be taken from the terminal');
});
