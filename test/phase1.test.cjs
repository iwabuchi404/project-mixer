const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

const { createMcpServer } = require('../src/mcp/server.cjs');
const { buildPortRecord, writeJsonAtomic } = require('../src/ports/state.cjs');

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

test('port record advertises only servers that are listening', () => {
  assert.deepEqual(
    buildPortRecord({ hookPort: 47832, mcpPort: null, profile: 'default', pid: 123 }),
    { profile: 'default', pid: 123, port: 47832 },
  );
  assert.deepEqual(
    buildPortRecord({ hookPort: 47832, mcpPort: 47822, profile: 'default', pid: 123 }),
    { profile: 'default', pid: 123, port: 47832, mcpPort: 47822, mcpPid: 123 },
  );
});

test('port record is replaced atomically without leaving a temp file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-mixer-phase1-'));
  const file = path.join(dir, 'port.json');
  try {
    writeJsonAtomic(file, { port: 1 });
    writeJsonAtomic(file, { port: 2, mcpPort: 3 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { port: 2, mcpPort: 3 });
    assert.deepEqual(fs.readdirSync(dir), ['port.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('each MCP SSE session gets a separate server instance', () => {
  const getFocus = async () => ({ project: null });
  assert.notEqual(createMcpServer(getFocus), createMcpServer(getFocus));
});

test('packaged app includes the main-process MCP and port modules', () => {
  const packageJson = require('../package.json');
  assert.ok(packageJson.build.files.includes('src/mcp/**/*'));
  assert.ok(packageJson.build.files.includes('src/ports/**/*'));
});

test('command registry rejects commands missing from the declared vocabulary', () => {
  const registry = loadBundledModule(path.join(__dirname, '..', 'src', 'commands', 'registry.js'));
  assert.throws(() => registry.register('typo_command', () => {}), /Unknown command/);
  assert.throws(() => registry.dispatch('typo_command'), /Unknown command/);
});

test('scratch content follows the selected project even when a normal file is active', () => {
  const store = loadBundledModule(path.join(__dirname, '..', 'src', 'store', 'index.js'));
  const files = new Map([
    ['__scratch__', { isScratch: true, content: 'project B scratch' }],
    ['B.txt', { isScratch: false, content: 'normal file' }],
  ]);
  assert.equal(store.getProjectScratchContent(files, 'B.txt', '__scratch__'), 'project B scratch');
});
