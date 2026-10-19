const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  scanClaude,
  scanCodex,
  scanOpenCode,
  scanDevin,
  listSessions,
  claudeSlug,
} = require('../src/main/session-history.cjs');

test('claudeSlug converts cwd to slug', () => {
  assert.equal(claudeSlug('D:\\work\\project-mixer'), 'D--work-project-mixer');
});

test('scanClaude returns [] for missing dir', () => {
  const r = scanClaude('D:\\nope', { home: os.tmpdir() });
  assert.deepEqual(r, []);
});

test('scanClaude matches project dir case-insensitively', () => {
  // Claude derives the slug from the cwd string it was launched with, so
  // D:\work\kamox can be stored as d--work-kamox (real machine observation).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const dir = path.join(home, '.claude', 'projects', 'd--work-kamox');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess-k.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'kamox session' } }));
  const r = scanClaude('D:\\work\\kamox', { home });
  assert.equal(r.length, 1);
  assert.equal(r[0].sessionId, 'sess-k');
});

test('scanClaude parses jsonl for title and timestamp', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const slug = claudeSlug('D:\\work\\proj');
  const dir = path.join(home, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'hello world' } }),
  ];
  const file = path.join(dir, 'sess-1.jsonl');
  fs.writeFileSync(file, lines.join('\n'));
  const r = scanClaude('D:\\work\\proj', { home });
  assert.equal(r.length, 1);
  assert.equal(r[0].provider, 'claude');
  assert.equal(r[0].sessionId, 'sess-1');
  assert.equal(r[0].title, 'hello world');
  assert.ok(r[0].createdAt > 0);
  // updatedAt follows the file mtime so the list sorts by recent activity.
  assert.ok(r[0].updatedAt >= r[0].createdAt);
});

test('scanCodex parses current session_meta payload wrapper and filters by cwd', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const dir = path.join(home, '.codex', 'sessions', '2026', '10', '19');
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    timestamp: '2026-10-18T18:58:46.305Z',
    type: 'session_meta',
    payload: { session_id: 'c1', id: 'c1', cwd: 'D:\\work\\proj', timestamp: '2026-10-18T18:58:43.434Z' },
  };
  fs.writeFileSync(path.join(dir, 'rollout-x.jsonl'), JSON.stringify(meta) + '\n');
  // another cwd
  const dir2 = path.join(home, '.codex', 'sessions', '2026', '10', '18');
  fs.mkdirSync(dir2, { recursive: true });
  const meta2 = { type: 'session_meta', payload: { session_id: 'c2', cwd: 'D:\\other', timestamp: '2026-01-03T00:00:00Z' } };
  fs.writeFileSync(path.join(dir2, 'rollout-y.jsonl'), JSON.stringify(meta2) + '\n');
  const r = scanCodex('D:\\work\\proj', { home });
  assert.equal(r.length, 1);
  assert.equal(r[0].sessionId, 'c1');
});

test('scanCodex skips sessions without a cwd instead of leaking across projects', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const dir = path.join(home, '.codex', 'sessions', '2026', '07', '26');
  fs.mkdirSync(dir, { recursive: true });
  // Older builds wrote a bare { id, timestamp } first line with no cwd.
  const legacy = { id: 'legacy-1', timestamp: '2026-07-26T23:35:31.871Z', instructions: 'x' };
  fs.writeFileSync(path.join(dir, 'rollout-legacy.jsonl'), JSON.stringify(legacy) + '\n');
  const r = scanCodex('D:\\work\\proj', { home });
  assert.deepEqual(r, []);
});

test('scanOpenCode returns only the matching project', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const base = path.join(home, '.local', 'share', 'opencode', 'project');
  const info = (name) => path.join(base, name, 'storage', 'session', 'info');
  fs.mkdirSync(info('D--work-proj'), { recursive: true });
  fs.mkdirSync(info('D--work-other'), { recursive: true });
  fs.mkdirSync(info('global'), { recursive: true });
  fs.writeFileSync(path.join(info('D--work-proj'), 'ses_abc.json'), JSON.stringify({ id: 'ses_abc', title: 't', time: { created: 1000, updated: 2000 } }));
  fs.writeFileSync(path.join(info('D--work-other'), 'ses_xyz.json'), JSON.stringify({ id: 'ses_xyz', title: 'other', time: { created: 3000, updated: 4000 } }));
  fs.writeFileSync(path.join(info('global'), 'ses_g.json'), JSON.stringify({ id: 'ses_g', title: 'global', time: { created: 5000, updated: 6000 } }));
  const r = scanOpenCode('D:\\work\\proj', { home });
  assert.equal(r.length, 1);
  assert.equal(r[0].provider, 'opencode');
  assert.equal(r[0].sessionId, 'ses_abc');
  assert.equal(r[0].title, 't');
  assert.equal(r[0].updatedAt, 2000);
});

test('scanOpenCode matches project dir case-insensitively', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const base = path.join(home, '.local', 'share', 'opencode', 'project');
  const info = path.join(base, 'd--work-proj', 'storage', 'session', 'info');
  fs.mkdirSync(info, { recursive: true });
  fs.writeFileSync(path.join(info, 'ses_low.json'), JSON.stringify({ id: 'ses_low', title: 'low', time: { created: 1, updated: 2 } }));
  const r = scanOpenCode('D:\\work\\proj', { home });
  assert.equal(r.length, 1);
  assert.equal(r[0].sessionId, 'ses_low');
});

test('scanDevin returns [] without config', async () => {
  const r = await scanDevin({});
  assert.deepEqual(r, []);
});

test('scanDevin parses API list', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [{ id: 'devin-1', title: 'd', created_at: 5, updated_at: 6 }] });
  const r = await scanDevin({ token: 'tok', orgId: 'org-1', fetchImpl });
  assert.equal(r.length, 1);
  assert.equal(r[0].provider, 'devin');
  assert.equal(r[0].sessionId, 'devin-1');
});

test('listSessions aggregates and sorts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const slug = claudeSlug('D:\\work\\proj');
  const dir = path.join(home, '.claude', 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'hi' } }));
  const r = await listSessions({ cwd: 'D:\\work\\proj', providers: ['claude'], home });
  assert.equal(r.length, 1);
});
