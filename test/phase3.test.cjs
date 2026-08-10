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
