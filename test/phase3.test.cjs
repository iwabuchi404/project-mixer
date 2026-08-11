const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

async function phase3State() {
  return import(pathToFileURL(path.join(root, 'src', 'phase3', 'state.mjs')).href);
}

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

function request({ port, pathname, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    if (method === 'POST') req.end('{}');
    else req.end();
  });
}

function openSse({ port, token }) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: `/s/${token}` }, (res) => {
      const status = res.statusCode;
      res.once('data', (chunk) => {
        const body = String(chunk);
        res.destroy();
        resolve({ status, body });
      });
    });
    req.on('error', reject);
  });
}

test('project ownership compares complete normalized path segments', async () => {
  const { findOwningProject, isPathInsideProject } = await phase3State();
  assert.equal(isPathInsideProject('D:\\work\\app-extra\\x.js', 'D:\\work\\app'), false);
  assert.equal(isPathInsideProject('d:/WORK/app/src/../src/x.js', 'D:\\work\\app'), true);

  const projects = new Map([
    ['root', { path: 'D:\\work' }],
    ['app', { path: 'D:\\work\\app' }],
  ]);
  assert.equal(findOwningProject(projects, 'D:\\work\\app\\src\\x.js').id, 'app');
});

test('new_tab creates a distinct preview identity while default reuses one', async () => {
  const { makePreviewPath } = await phase3State();
  const reusedA = makePreviewPath('p1', 'D:\\work\\a.txt');
  const reusedB = makePreviewPath('p1', 'D:\\work\\a.txt');
  const fresh = makePreviewPath('p1', 'D:\\work\\a.txt', 1);
  assert.equal(reusedA, reusedB);
  assert.notEqual(fresh, reusedA);
});

test('show_file activation preserves editor attention and leaves other preview active', async () => {
  const { decidePreviewActivation } = await phase3State();
  assert.deepEqual(decidePreviewActivation({
    sameProject: true,
    activeSurface: 'editor',
    activePreviewPath: null,
    requestedPreviewPath: 'preview:p:a',
  }), {
    activate: true,
    preserveAttention: true,
    reason: 'show-without-focus-steal',
  });
  assert.equal(decidePreviewActivation({
    sameProject: true,
    activeSurface: 'preview',
    activePreviewPath: 'preview:p:a',
    requestedPreviewPath: 'preview:p:b',
  }).activate, false);
  assert.equal(decidePreviewActivation({
    sameProject: false,
    activeSurface: 'editor',
    activePreviewPath: null,
    requestedPreviewPath: 'preview:q:b',
  }).activate, false);
});

test('line ranges are integer, ordered, and clamped to the file', async () => {
  const { clampLineRange } = await phase3State();
  assert.deepEqual(clampLineRange(0, 99, 10), { start: 1, end: 10 });
  assert.deepEqual(clampLineRange(8.9, 3, 10), { start: 8, end: 8 });
});

test('push focus resolves a preview key to the actual file path', async () => {
  const { resolveAttentionFile } = await phase3State();
  const previews = new Map([['preview:p:key', { path: 'D:\\work\\p\\README.md' }]]);
  assert.deepEqual(resolveAttentionFile({ activeFilePath: 'preview:p:key', isPreview: true }, previews), {
    filePath: 'D:\\work\\p\\README.md',
    isPreview: true,
  });
});

test('MCP server requires a unique live token per PTY session', async (t) => {
  const { startMcpServer } = require('../src/mcp/server.cjs');
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const server = startMcpServer(0, async () => ({}), ready);
  t.after(async () => server.close());
  const port = await readyPromise;

  const tokenA = server.registerSession({ ptyId: 1, projectId: 'a', cwd: 'D:\\a' });
  const tokenB = server.registerSession({ ptyId: 2, projectId: 'b', cwd: 'D:\\b' });
  assert.notEqual(tokenA, tokenB);
  assert.equal(server.hasSession(tokenA), true);

  // Multiple clients must each receive an independent Protocol/transport.
  // This is the behavioral regression for "Already connected to a transport".
  const [connectionA, connectionB] = await Promise.all([
    openSse({ port, token: tokenA }),
    openSse({ port, token: tokenA }),
  ]);
  assert.equal(connectionA.status, 200);
  assert.equal(connectionB.status, 200);
  assert.match(connectionA.body, /event: endpoint/);
  assert.match(connectionB.body, /event: endpoint/);

  const invalid = await request({ port, pathname: '/s/not-a-session' });
  assert.equal(invalid.status, 401);
  const legacy = await request({ port, pathname: '/sse' });
  assert.equal(legacy.status, 404);

  await server.revokeSession(tokenA);
  assert.equal(server.hasSession(tokenA), false);
  const revoked = await request({ port, pathname: `/messages/${tokenA}?sessionId=missing`, method: 'POST' });
  assert.equal(revoked.status, 401);
});

test('renderer has exact line rendering and does not use a missing webview IPC receiver', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(renderer, /data-pm-line/);
  assert.match(renderer, /scrollIntoView/);
  assert.doesNotMatch(renderer, /previewWebview\.send\('reveal-line'/);
});

test('human and MCP callers share one command trace without retaining values', async () => {
  const registry = loadBundledModule(path.join(root, 'src', 'commands', 'registry.js'));
  registry.register('get_focus', async ({ source }) => source);
  assert.equal(await registry.dispatch('get_focus', { source: 'human', secret: 'do not retain' }), 'human');
  assert.equal(await registry.dispatch('get_focus', { source: 'mcp' }), 'mcp');

  const trace = registry.getTrace();
  assert.equal(trace.length, 2);
  assert.deepEqual(trace.map((entry) => entry.name), ['get_focus', 'get_focus']);
  assert.deepEqual(trace[0].argKeys, ['secret', 'source']);
  assert.equal(JSON.stringify(trace).includes('do not retain'), false);
  assert.ok(trace.every((entry) => entry.status === 'fulfilled'));
});

test('PTY creation passes project ownership and injects a token URL', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  assert.match(renderer, /projectId: projectId \|\| null/);
  assert.match(main, /registerSession/);
  assert.match(main, /\/s\/\$\{mcpToken\}/);
  assert.doesNotMatch(main, /PM_MCP_URL: `http:\/\/127\.0\.0\.1:\$\{MCP_PORT\}\/sse`/);
});

test('agent launch flags use the per-PTY URL without project file changes', () => {
  const { buildAgentMcpArgs, buildPowerShellInvocation } = require('../src/mcp/launch.cjs');
  const url = 'http://127.0.0.1:47822/s/private-token';
  const claudeArgs = buildAgentMcpArgs('claude', url);
  assert.equal(claudeArgs[0], '--mcp-config');
  assert.equal(JSON.parse(claudeArgs[1]).mcpServers['project-mixer'].url, url);

  assert.deepEqual(buildAgentMcpArgs('codex', url), [
    '-c',
    `mcp_servers.project_mixer.url="${url}"`,
  ]);
  const invocation = buildPowerShellInvocation('claude', claudeArgs);
  assert.match(invocation, /^& 'claude' '--mcp-config'/);
  assert.match(invocation, /private-token/);
});
