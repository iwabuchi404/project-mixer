const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  parseDevinSessionList,
  pickDevinResumeCandidate,
  isSafeCwd,
  normalizePathKey,
  SESSION_ID_PATTERN,
  MAX_SESSIONS,
} = require('../src/main/devin-session-index.cjs');
const { buildResumeArgs } = require('../src/main/resume-args.cjs');

// Real output shape from devin 3000.11.3 (`devin list --format json`).
const REAL_JSON = JSON.stringify([
  { id: 'thinkable-parakeet', short_id: 'thinkable-parakeet', working_directory: 'D:\\work\\project-mixer', last_activity_at: 1790532594, last_activity_ago: '6d ago', title: 'session history viewer' },
  { id: 'linen-peony', short_id: 'linen-peony', working_directory: 'D:\\work\\project-mixer', last_activity_at: 1789550255, last_activity_ago: '17d ago', title: 'why tabs disappear' },
  { id: 'lithe-cabbage', short_id: 'lithe-cabbage', working_directory: 'D:\\work\\other', last_activity_at: 1789999999, last_activity_ago: '1d ago', title: 'other dir' },
]);

test('parses the real devin list --format json shape', () => {
  const { sessions, truncated } = parseDevinSessionList(REAL_JSON);
  assert.equal(truncated, false);
  assert.equal(sessions.length, 3);
  assert.deepEqual(sessions[0], {
    id: 'thinkable-parakeet',
    shortId: 'thinkable-parakeet',
    workingDirectory: 'D:\\work\\project-mixer',
    lastActivityAt: 1790532594,
    title: 'session history viewer',
  });
});

test('local slug ids are accepted, which devinBind could never bind', () => {
  // The whole reason this module exists: normalizeDevinSessionId in
  // devin-session-monitor.cjs only matches `devin-<slug>`, so every id
  // `devin list` reports was previously unusable. That is why 16 real
  // devin tabs all restored fresh.
  const { normalizeDevinSessionId } = require('../src/main/devin-session-monitor.cjs');
  const { sessions } = parseDevinSessionList(REAL_JSON);
  assert.equal(normalizeDevinSessionId(sessions[0].id), null, 'premise: monitor rejects it');
  assert.ok(SESSION_ID_PATTERN.test(sessions[0].id), 'but the index accepts it');
  // And it is genuinely resumable: buildResumeArgs passes it through.
  assert.deepEqual(buildResumeArgs('devin', sessions[0].id), ['-r', 'thinkable-parakeet']);
});

test('cloud-style devin- ids are accepted too', () => {
  const { sessions } = parseDevinSessionList('[{"id":"devin-abc123","working_directory":"D:\\\\w","last_activity_at":1}]');
  assert.equal(sessions[0].id, 'devin-abc123');
});

test('picks the newest session for the requested directory only', () => {
  const { sessions } = parseDevinSessionList(REAL_JSON);
  const picked = pickDevinResumeCandidate(sessions, 'D:\\work\\project-mixer');
  assert.equal(picked.candidate.id, 'thinkable-parakeet');
  assert.equal(picked.candidate.lastActivityAt, 1790532594);
  assert.equal(picked.count, 2);
  // The newer session in the OTHER directory must not leak in.
  const other = pickDevinResumeCandidate(sessions, 'D:\\work\\other');
  assert.equal(other.candidate.id, 'lithe-cabbage');
});

test('reports ambiguity instead of pretending the mapping is known', () => {
  // Option C: propose, never silently attach. `devin list` carries no
  // per-tab identity, so >1 session in a directory must stay ambiguous.
  const { sessions } = parseDevinSessionList(REAL_JSON);
  const two = pickDevinResumeCandidate(sessions, 'D:\\work\\project-mixer');
  assert.equal(two.ambiguous, true);
  const one = parseDevinSessionList('[{"id":"solo-fox","working_directory":"D:\\\\w","last_activity_at":5}]');
  assert.equal(pickDevinResumeCandidate(one.sessions, 'D:\\w').ambiguous, false);
});

test('unknown directory yields no candidate rather than a wrong one', () => {
  const { sessions } = parseDevinSessionList(REAL_JSON);
  const picked = pickDevinResumeCandidate(sessions, 'D:\\work\\never-used');
  assert.equal(picked.candidate, null);
  assert.equal(picked.count, 0);
  assert.equal(picked.ambiguous, false);
});

test('path comparison tolerates case and trailing separators', () => {
  assert.equal(normalizePathKey('D:\\Work\\Project-Mixer\\'), normalizePathKey('d:\\work\\project-mixer'));
  const { sessions } = parseDevinSessionList(REAL_JSON);
  assert.equal(pickDevinResumeCandidate(sessions, 'd:/work/project-mixer/').candidate.id, 'thinkable-parakeet');
});

test('malformed output degrades to empty instead of throwing', () => {
  for (const bad of ['', '   ', 'not json', '{"a":1}', 'null', '[1,2,3]', '[{"no_id":true}]', '[{"id":"has space"}]', '[{"id":"x","last_activity_at":"nope"}]']) {
    const parsed = parseDevinSessionList(bad);
    assert.ok(Array.isArray(parsed.sessions), `should not throw for: ${bad}`);
  }
  // A row with a bad timestamp is kept (treated as oldest), not dropped.
  const kept = parseDevinSessionList('[{"id":"ok-id","working_directory":"D:\\\\w","last_activity_at":"nope"}]');
  assert.equal(kept.sessions.length, 1);
  assert.equal(kept.sessions[0].lastActivityAt, 0);
});

test('session list is bounded', () => {
  const many = JSON.stringify(Array.from({ length: MAX_SESSIONS + 25 }, (_, i) => ({ id: `sess-${i}`, working_directory: 'D:\\w', last_activity_at: i })));
  const { sessions, truncated } = parseDevinSessionList(many);
  assert.equal(truncated, true);
  assert.equal(sessions.length, MAX_SESSIONS);
});

test('cwd guard rejects empty and NUL-bearing paths', () => {
  assert.equal(isSafeCwd('D:\\work'), true);
  assert.equal(isSafeCwd(''), false);
  assert.equal(isSafeCwd('   '), false);
  assert.equal(isSafeCwd(null), false);
  assert.equal(isSafeCwd('D:\\a\0b'), false);
});

test('IPC handler is bounded and never blocks the main process', () => {
  const main = require('fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
  const start = main.indexOf("ipcMain.handle('devin:latest-session'");
  assert.ok(start > 0, 'handler must exist');
  const block = main.slice(start, main.indexOf('ipcMain.handle(', start + 10));
  // Async execFile, never execFileSync: a hung CLI must not freeze the app.
  assert.match(block, /await new Promise/);
  assert.doesNotMatch(block, /execFileSync/);
  assert.match(block, /timeout: 8000/);
  assert.match(block, /maxBuffer: MAX_JSON_BYTES/);
  // The cwd is resolved through the project allowlist, not taken raw.
  assert.match(block, /resolveProjectRoot\(loadProjectsConfig\(\), payload\.cwd\)/);
  assert.match(block, /isSafeCwd\(payload\.cwd\)/);
  // Failure is data, not an exception: the caller starts a fresh session.
  assert.match(block, /return \{ ok: false, candidate: null/);
});

test('renderer proposes rather than auto-attaching ambiguous devin sessions', () => {
  const renderer = require('fs').readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf-8');
  const start = renderer.indexOf("register('create_terminal'");
  const block = renderer.slice(start, renderer.indexOf("register('resume_mode_changed'"));
  assert.match(block, /window\.api\.devinLatestSession\(cwd_\)/);
  // Only devin consults the CLI; claude/codex/opencode keep the tracked path.
  assert.match(block, /commandKey === 'devin'/);
  // The ambiguity must reach the human.
  assert.match(block, /candidate\.ambiguous/);
  // Tracked id still wins over a lookup.
  assert.ok(block.indexOf('loadLastSessions()') < block.indexOf('devinLatestSession'));
});

test('preload exposes the bridge', () => {
  const preload = require('fs').readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf-8');
  assert.match(preload, /devinLatestSession: \(cwd\) => ipcRenderer\.invoke\('devin:latest-session', \{ cwd \}\)/);
});
