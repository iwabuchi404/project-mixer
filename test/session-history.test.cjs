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
  readTranscript,
  safeSessionId,
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

// --- H2: transcript reading ---

test('safeSessionId rejects path-shaped ids', () => {
  assert.equal(safeSessionId('abc-123_DEF.1'), true);
  assert.equal(safeSessionId(''), false);
  assert.equal(safeSessionId('..'), false);
  assert.equal(safeSessionId('a/b'), false);
  assert.equal(safeSessionId('a\\b'), false);
  assert.equal(safeSessionId('a:b'), false);
  assert.equal(safeSessionId('x'.repeat(129)), false);
});

test('readTranscript rejects unknown providers and invalid ids', async () => {
  assert.deepEqual(await readTranscript({ provider: 'nope', sessionId: 'abc' }), { messages: [], truncated: false, error: 'unknown provider' });
  assert.equal((await readTranscript({ provider: 'claude', sessionId: '../etc' })).error, 'invalid session id');
});

test('readTranscript parses claude jsonl messages, blocks, and tools', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const dir = path.join(home, '.claude', 'projects', claudeSlug('D:\\work\\proj'));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'system', timestamp: '2026-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'hidden sidechain' } }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:01:00Z', message: { content: 'hello' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:02:00Z', message: { content: [
      { type: 'text', text: 'hi there' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', content: 'file1\nfile2' },
    ] } }),
  ];
  fs.writeFileSync(path.join(dir, 'sess-x.jsonl'), lines.join('\n'));
  const { messages, truncated } = await readTranscript({ provider: 'claude', sessionId: 'sess-x', cwd: 'D:\\work\\proj', home });
  assert.equal(truncated, false);
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.map((m) => [m.role, m.kind]), [
    ['user', 'text'], ['assistant', 'text'], ['tool', 'tool'], ['tool', 'tool'],
  ]);
  assert.equal(messages[0].text, 'hello');
  assert.equal(messages[1].text, 'hi there');
  assert.match(messages[2].text, /Bash/);
  assert.equal(messages[3].text, 'file1\nfile2');
});

test('readTranscript parses codex response_item payloads', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const dir = path.join(home, '.codex', 'sessions', '2026', '10', '19');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-1', cwd: 'D:\\work\\proj', timestamp: '2026-10-19T00:00:00Z' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', timestamp: '2026-10-19T00:01:00Z', content: [{ type: 'input_text', text: 'fix the bug' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'thinking about it' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', arguments: '{}' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } }),
  ];
  fs.writeFileSync(path.join(dir, 'rollout-1-codex-1.jsonl'), lines.join('\n'));
  const { messages } = await readTranscript({ provider: 'codex', sessionId: 'codex-1', cwd: 'D:\\work\\proj', home });
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.map((m) => [m.role, m.kind]), [
    ['user', 'text'], ['assistant', 'reasoning'], ['tool', 'tool'], ['assistant', 'text'],
  ]);
  assert.equal(messages[3].text, 'done');
});

test('readTranscript parses opencode message+part trees', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const session = path.join(home, '.local', 'share', 'opencode', 'project', claudeSlug('D:\\work\\proj'), 'storage', 'session');
  const msgDir = path.join(session, 'message', 'ses_1');
  const partDir = path.join(session, 'part', 'ses_1');
  fs.mkdirSync(msgDir, { recursive: true });
  fs.mkdirSync(path.join(partDir, 'msg_1'), { recursive: true });
  fs.mkdirSync(path.join(partDir, 'msg_2'), { recursive: true });
  fs.writeFileSync(path.join(msgDir, 'msg_1.json'), JSON.stringify({ id: 'msg_1', role: 'user', time: { created: 1000 } }));
  fs.writeFileSync(path.join(msgDir, 'msg_2.json'), JSON.stringify({ id: 'msg_2', role: 'assistant', time: { created: 2000 } }));
  fs.writeFileSync(path.join(partDir, 'msg_1', 'prt_a.json'), JSON.stringify({ type: 'text', text: 'question' }));
  fs.writeFileSync(path.join(partDir, 'msg_2', 'prt_b.json'), JSON.stringify({ type: 'tool', tool: 'read', state: { input: { file: 'a.js' } } }));
  fs.writeFileSync(path.join(partDir, 'msg_2', 'prt_c.json'), JSON.stringify({ type: 'text', text: 'answer' }));
  const { messages } = await readTranscript({ provider: 'opencode', sessionId: 'ses_1', cwd: 'D:\\work\\proj', home });
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((m) => [m.role, m.kind]), [
    ['user', 'text'], ['tool', 'tool'], ['assistant', 'text'],
  ]);
});

test('readTranscript reads devin session messages via API', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ messages: [
    { role: 'user', content: 'build it', time: 5 },
    { role: 'assistant', content: [{ type: 'text', text: 'built' }], time: 6 },
  ] }) });
  const { messages } = await readTranscript({ provider: 'devin', sessionId: 'devin-1', fetchImpl, token: 'tok', orgId: 'org-1' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[1].text, 'built');
});

test('readTranscript truncates very long transcripts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const dir = path.join(home, '.claude', 'projects', claudeSlug('D:\\work\\proj'));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < 600; i++) {
    lines.push(JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: `m${i}` } }));
  }
  fs.writeFileSync(path.join(dir, 'big.jsonl'), lines.join('\n'));
  const { messages, truncated } = await readTranscript({ provider: 'claude', sessionId: 'big', cwd: 'D:\\work\\proj', home });
  assert.equal(messages.length, 500);
  assert.equal(truncated, true);
});
