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
