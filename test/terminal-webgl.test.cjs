// test/terminal-webgl.test.cjs
// WebGL renderer lifecycle discipline.
// Run: npm run test:terminal-webgl
//
// Two regressions are guarded here:
//   1. A WebGL canvas without preserveDrawingBuffer is blanked by the
//      compositor when renderPanes() re-parents the terminal element. xterm
//      cannot observe the loss and only repaints on the next write or
//      resize, so a pane whose size did not change stayed permanently
//      blank while its buffer content was intact.
//   2. Chromium force-loses WebGL contexts past a small cap and never
//      restores them. Holding one context per terminal exhausted the cap
//      with the project's 48 restored terminals, and every eviction blanked
//      the loser until it happened to be shown again.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const renderer = () => read('renderer.js');

test('WebglAddon is constructed with preserveDrawingBuffer enabled', () => {
  const src = renderer();
  assert.match(src, /new WebglAddon\(true\)/);
  // A bare constructor call is what silently reintroduced the blank canvas.
  assert.doesNotMatch(src, /new WebglAddon\(\)/);
});

test('renderer keeps a bounded, LRU-ordered WebGL context pool', () => {
  const src = renderer();
  assert.match(src, /const WEBGL_CONTEXT_BUDGET = \d+;/);
  assert.match(src, /const webglRenderers = new Map\(\);/);
  assert.match(src, /const webglRetryAfter = new Map\(\);/);
  assert.match(src, /function releaseWebglRenderer\(terminal\)/);
  assert.match(src, /function dropWebglRenderer\(terminal\)/);
  // Eviction must be least-recently-shown first, and must never take a
  // context away from a terminal that is on screen.
  assert.match(src, /if \(!visible\.has\(terminal\)\) evictable\.push/);
  assert.match(src, /evictable\.sort\(\(a, b\) => a\[1\] - b\[1\]\);/);
});

test('context acquisition is decided in one place from real visibility', () => {
  const src = renderer();
  assert.match(src, /function syncWebglRenderers\(\)/);
  assert.match(src, /function isTerminalVisible\(t\)/);
  // Parked and collapsed terminals must not hold a context either.
  assert.match(src, /if \(t\.projectId !== activeProjectId\) return false;/);
  assert.match(src, /t\.termEl\.style\.display === 'none' \|\| !t\.termEl\.isConnected/);
  assert.match(src, /t\.termEl\.offsetWidth > 0 && t\.termEl\.offsetHeight > 0/);
});

test('every path that changes terminal visibility re-syncs the pool', () => {
  const src = renderer();
  // placeSurfaces() owns per-pane display assignment, handleResize() covers
  // window and splitter drags. Both must reach syncWebglRenderers.
  const placeSurfaces = src.slice(src.indexOf('function placeSurfaces()'), src.indexOf('function restoreSurfaceToMain('));
  assert.match(placeSurfaces, /syncWebglRenderers\(\);/);
  const handleResize = src.slice(src.indexOf('function handleResize()'), src.indexOf("window.addEventListener('resize', handleResize)"));
  assert.match(handleResize, /syncWebglRenderers\(\);/);
});

test('terminal teardown drops pool bookkeeping before disposing', () => {
  const src = renderer();
  const disposals = [...src.matchAll(/([\s\S]{0,120}?)t?\.?terminal\.dispose\(\);/g)];
  assert.equal(disposals.length, 1, 'runtime disposal is centralized for close, remove, failed start and cancellation');
  for (const [match] of disposals) {
    assert.match(match, /dropWebglRenderer\(/, `dropWebglRenderer missing before: ${match.trim()}`);
  }
});
