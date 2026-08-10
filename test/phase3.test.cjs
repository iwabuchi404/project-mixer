const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// 3.1 push: verify the renderer has the push focus infrastructure
test('renderer has push focus checkbox and context builder', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  assert.match(renderer, /pushFocusCheckbox/);
  assert.match(renderer, /buildPushFocusContext/);
  assert.match(renderer, /getSelectionRange/);
  assert.match(renderer, /pushFocusEnabled/);
});

test('index.html has the push focus toggle', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /push-focus-toggle/);
  assert.match(html, /push-focus-checkbox/);
});

test('styles.css has push focus toggle styles', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(css, /#push-focus-toggle/);
});

test('sendToTerminal appends context when checkbox is checked', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  // The push logic must be inside sendToTerminal, gated by the checkbox
  assert.match(renderer, /if \(pushFocusCheckbox\.checked\)/);
  assert.match(renderer, /contentToSend = contentToSend \+ '\\n' \+ ctx/);
});

test('push focus state is persisted in layout', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  assert.match(renderer, /pushFocusEnabled: pushFocusCheckbox\.checked/);
  assert.match(renderer, /layout\.pushFocusEnabled/);
});

// 3.3 command types: show_file commands registered
test('command types include show_file commands', () => {
  const types = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'types.js'), 'utf8');
  assert.match(types, /preview_open:/);
  assert.match(types, /preview_reveal:/);
  assert.match(types, /tab_activate:/);
  assert.match(types, /project_set_badge:/);
});

// 3.4 show_file: command handlers
test('renderer registers show_file command handlers', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  assert.match(renderer, /register\('preview_open'/);
  assert.match(renderer, /register\('preview_reveal'/);
  assert.match(renderer, /register\('tab_activate'/);
  assert.match(renderer, /register\('project_set_badge'/);
});

test('preview_open returns shown:boolean and reason:string', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  assert.match(renderer, /shown: false, reason: 'no path'/);
  assert.match(renderer, /shown: false, reason: 'file not in any open project'/);
  assert.match(renderer, /shown: true, reason: 'opened in active project'/);
  assert.match(renderer, /shown: false, reason: `file is in project/);
});

test('preview_open does not switch project for cross-project files', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  // Case 2 must badge, not switch
  assert.match(renderer, /dispatch\('project_set_badge'/);
  // Must NOT call select_project in the cross-project path
  const previewOpenMatch = renderer.match(/register\('preview_open'[\s\S]*?\}\);/);
  assert.ok(previewOpenMatch, 'preview_open handler must exist');
  assert.doesNotMatch(previewOpenMatch[0], /dispatch\('select_project'/, 'must not switch project');
});

test('project badge element exists in project list items', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  assert.match(renderer, /project-badge/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(css, /\.project-badge/);
  assert.match(css, /\.project-badge\.active/);
});

// 3.5 MCP server: show_file tool and dispatch interface
test('MCP server registers show_file tool', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'server.cjs'), 'utf8');
  assert.match(server, /'show_file'/);
  assert.match(server, /preview_open/);
  assert.match(server, /preview_reveal/);
});

test('MCP server uses generic dispatchToRenderer, not hardcoded getFocus', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'server.cjs'), 'utf8');
  assert.match(server, /function createMcpServer\(dispatchToRenderer\)/);
  assert.match(server, /dispatchToRenderer\('get_focus'\)/);
  assert.match(server, /dispatchToRenderer\('preview_open'/);
  // Old getFocus parameter should not remain
  assert.doesNotMatch(server, /createMcpServer\(getFocus\)/);
});

test('main.js injects PM_MCP_URL env into PTY processes', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /PM_MCP_URL/);
  assert.match(main, /MCP_PORT/);
});

test('main.js dispatchToRenderer passes command name and args', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /commandName, args/);
  assert.match(main, /__pmDispatch\(.*commandName.*args\)/);
});
