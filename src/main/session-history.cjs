// src/main/session-history.cjs
// Unified scanner for agent session history (claude / codex / opencode / devin).
//
// Returns normalized records: { provider, sessionId, title, createdAt, updatedAt }.
// Each provider degrades to [] on any parse failure (defensive parse).
//
// cwd attribution: claude / codex / opencode are filtered to the given project
// directory (case-insensitively — Claude and OpenCode derive their directory
// slug from the cwd string at launch, so the drive-letter case varies, e.g.
// "d--work-kamox" for D:\work\kamox). Devin's cloud API exposes no cwd, so its
// sessions stay org-wide by design (SESSION_HISTORY_PLAN, risk table).

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROVIDERS = ['claude', 'codex', 'opencode', 'devin'];

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function safeReadLines(filePath, maxLines = 8) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.split(/\r?\n/).filter(Boolean).slice(0, maxLines);
  } catch {
    return [];
  }
}

function safeMtimeMs(filePath) {
  try {
    const ms = fs.statSync(filePath).mtimeMs;
    return Number.isFinite(ms) ? Math.floor(ms) : 0;
  } catch {
    return 0;
  }
}

function toEpoch(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function projectSlug(cwd) {
  // ~/.claude/projects/<cwd-slug>/ and opencode's project/<slug>/ replace path
  // separators with '-'. Claude and OpenCode use the same encoding.
  return String(cwd || '').replace(/[:\\/]/g, '-');
}

// Alias kept for the existing call sites/tests; the slug is shared.
const claudeSlug = projectSlug;

function scanClaude(cwd, opts = {}) {
  const home = opts.home || os.homedir();
  const projectsRoot = path.join(home, '.claude', 'projects');
  const wanted = projectSlug(cwd).toLowerCase();
  if (!wanted) return [];
  const out = [];
  for (const entry of safeReadDir(projectsRoot)) {
    if (!entry.isDirectory() || entry.name.toLowerCase() !== wanted) continue;
    out.push(...readClaudeProjectDir(path.join(projectsRoot, entry.name)));
  }
  return out;
}

function readClaudeProjectDir(root) {
  const out = [];
  for (const entry of safeReadDir(root)) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const full = path.join(root, entry.name);
    const sessionId = entry.name.replace(/\.jsonl$/, '');
    // List view only: stop reading at the first user message instead of
    // loading whole multi-MB transcripts (SESSION_HISTORY_PLAN, risk table).
    const lines = safeReadLines(full, 12);
    let createdAt = 0;
    let title = null;
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!createdAt && obj?.timestamp) createdAt = toEpoch(obj.timestamp);
      if (!title && obj?.type === 'user') {
        const c = obj?.message?.content;
        if (typeof c === 'string') title = c.slice(0, 80);
        else if (Array.isArray(c)) {
          const text = c.find((b) => b?.type === 'text')?.text;
          if (text) title = String(text).slice(0, 80);
        }
      }
      if (createdAt && title) break;
    }
    // jsonl lines carry the creation time; the file mtime tracks the latest
    // append, so the list sorts by recent activity.
    const updatedAt = safeMtimeMs(full) || createdAt;
    out.push({ provider: 'claude', sessionId, title: title || sessionId, createdAt, updatedAt });
  }
  return out;
}

function scanCodex(cwd, opts = {}) {
  const home = opts.home || os.homedir();
  const root = path.join(home, '.codex', 'sessions');
  if (!cwd) return [];
  const out = [];
  function walk(dir, depth) {
    if (depth > 4) return;
    for (const entry of safeReadDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const lines = safeReadLines(full, 3);
      const first = lines[0];
      if (!first) continue;
      let meta;
      try { meta = JSON.parse(first); } catch { continue; }
      // Current format: { type: 'session_meta', payload: { session_id, cwd, ... } }.
      // Older builds wrote a bare { id, timestamp } line with no cwd — those
      // cannot be attributed to a project and are skipped (plan: cwd filter is
      // mandatory; unknown formats degrade instead of leaking across projects).
      const m = meta?.payload || meta?.session_meta || meta;
      if (!m?.cwd) continue;
      if (String(m.cwd).toLowerCase() !== String(cwd).toLowerCase()) continue;
      const sessionId = m?.session_id || m?.id || entry.name.replace(/^rollout-/, '').replace(/\.jsonl$/, '');
      const createdAt = toEpoch(m?.timestamp || m?.created_at);
      const updatedAt = safeMtimeMs(full) || createdAt;
      out.push({ provider: 'codex', sessionId, title: m?.title || sessionId, createdAt, updatedAt });
    }
  }
  walk(root, 0);
  return out;
}

function scanOpenCode(cwd, opts = {}) {
  // opencode stores per-project under ~/.local/share/opencode/project/<slug>/storage/session/info/.
  // The info JSON has no path field, so the directory slug IS the attribution.
  const home = opts.home || os.homedir();
  const base = path.join(home, '.local', 'share', 'opencode', 'project');
  const wanted = projectSlug(cwd).toLowerCase();
  if (!wanted) return [];
  const out = [];
  for (const proj of safeReadDir(base)) {
    // 'global' and other projects never match a concrete cwd slug.
    if (!proj.isDirectory() || proj.name.toLowerCase() !== wanted) continue;
    const infoDir = path.join(base, proj.name, 'storage', 'session', 'info');
    for (const entry of safeReadDir(infoDir)) {
      if (!entry.isFile() || !entry.name.startsWith('ses_') || !entry.name.endsWith('.json')) continue;
      const obj = safeReadJson(path.join(infoDir, entry.name));
      if (!obj || !obj.id) continue;
      const createdAt = toEpoch(obj?.time?.created || obj?.createdAt);
      const updatedAt = toEpoch(obj?.time?.updated || obj?.updatedAt) || createdAt;
      out.push({
        provider: 'opencode',
        sessionId: obj.id,
        title: obj.title || obj.id,
        createdAt,
        updatedAt,
      });
    }
  }
  return out;
}

async function scanDevin(opts = {}) {
  const token = opts.token || process.env.DEVIN_API_TOKEN || '';
  const orgId = opts.orgId || process.env.DEVIN_ORG_ID || '';
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const baseUrl = (opts.baseUrl || 'https://api.devin.ai').replace(/\/$/, '');
  if (!token || !orgId || !orgId.startsWith('org-') || typeof fetchImpl !== 'function') return [];
  try {
    const url = `${baseUrl}/v3/organizations/${encodeURIComponent(orgId)}/sessions`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res || !res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data) ? data : (Array.isArray(data?.sessions) ? data.sessions : []);
    return list.map((s) => ({
      provider: 'devin',
      sessionId: s?.id || s?.session_id,
      title: s?.title || s?.id || s?.session_id,
      createdAt: toEpoch(s?.created_at),
      updatedAt: toEpoch(s?.updated_at),
    })).filter((r) => r.sessionId);
  } catch {
    return [];
  }
}

async function listSessions({ cwd, providers, ...opts } = {}) {
  const wanted = Array.isArray(providers) && providers.length ? providers : PROVIDERS;
  const results = [];
  if (wanted.includes('claude')) results.push(...scanClaude(cwd, opts));
  if (wanted.includes('codex')) results.push(...scanCodex(cwd, opts));
  if (wanted.includes('opencode')) results.push(...scanOpenCode(cwd, opts));
  if (wanted.includes('devin')) results.push(...(await scanDevin(opts)));
  return results
    .filter((r) => r && r.sessionId)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}

// ============================================================
// H2: transcript reading
// ============================================================
//
// Normalized message: { role, timestamp, text, kind } where role is
// 'user' | 'assistant' | 'tool', kind is 'text' | 'tool' | 'reasoning'.
// Every provider degrades to [] on any parse failure (defensive parse).
// Session ids come from list output but end up inside file paths, so they
// are validated against a strict shape before any filesystem/API use.

const MAX_TRANSCRIPT_MESSAGES = 500;

function safeSessionId(sessionId) {
  return typeof sessionId === 'string'
    && sessionId.length >= 1
    && sessionId.length <= 128
    && /^[A-Za-z0-9._-]+$/.test(sessionId)
    && !sessionId.includes('..');
}

function clampTranscript(messages) {
  return {
    messages: messages.slice(0, MAX_TRANSCRIPT_MESSAGES),
    truncated: messages.length > MAX_TRANSCRIPT_MESSAGES,
  };
}

function transcriptMessage(role, text, { timestamp = 0, kind = 'text' } = {}) {
  const clean = String(text ?? '').trim();
  return { role, timestamp, text: clean, kind };
}

// --- claude: ~/.claude/projects/<slug>/<sessionId>.jsonl ---

function findClaudeSessionFile(cwd, sessionId, opts = {}) {
  const home = opts.home || os.homedir();
  const projectsRoot = path.join(home, '.claude', 'projects');
  const wanted = projectSlug(cwd).toLowerCase();
  if (!wanted) return null;
  for (const entry of safeReadDir(projectsRoot)) {
    if (!entry.isDirectory() || entry.name.toLowerCase() !== wanted) continue;
    const candidate = path.join(projectsRoot, entry.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readClaudeTranscript(cwd, sessionId, opts = {}) {
  const file = findClaudeSessionFile(cwd, sessionId, opts);
  if (!file) return [];
  const out = [];
  // Transcripts can be multi-MB; stream line by line instead of one big read.
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.isSidechain) continue;
    const type = obj?.type;
    if (type !== 'user' && type !== 'assistant') continue;
    const role = type === 'user' ? 'user' : 'assistant';
    const timestamp = toEpoch(obj?.timestamp);
    const content = obj?.message?.content;
    if (typeof content === 'string') {
      if (content.trim()) out.push(transcriptMessage(role, content, { timestamp }));
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && String(block.text ?? '').trim()) {
          out.push(transcriptMessage(role, block.text, { timestamp }));
        } else if (block?.type === 'tool_use') {
          out.push(transcriptMessage('tool', `${block.name || 'tool'}: ${JSON.stringify(block.input ?? {})}`, { timestamp, kind: 'tool' }));
        } else if (block?.type === 'tool_result') {
          const text = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
              : JSON.stringify(block.content ?? {});
          out.push(transcriptMessage('tool', String(text ?? ''), { timestamp, kind: 'tool' }));
        }
      }
    }
  }
  return out;
}

// --- codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl ---

function findCodexSessionFile(cwd, sessionId, opts = {}) {
  const home = opts.home || os.homedir();
  const root = path.join(home, '.codex', 'sessions');
  let found = null;
  function walk(dir, depth) {
    if (found || depth > 4) return;
    for (const entry of safeReadDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const lines = safeReadLines(full, 1);
      let meta;
      try { meta = JSON.parse(lines[0] || ''); } catch { continue; }
      const m = meta?.payload || meta?.session_meta || meta;
      const id = m?.session_id || m?.id;
      if (id === sessionId) { found = full; return; }
    }
  }
  walk(root, 0);
  return found;
}

function readCodexTranscript(cwd, sessionId, opts = {}) {
  const file = findCodexSessionFile(cwd, sessionId, opts);
  if (!file) return [];
  const out = [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const payload = obj?.payload;
    if (!payload) continue;
    const timestamp = toEpoch(payload.timestamp || obj?.timestamp);
    if (payload.type === 'message') {
      const role = payload.role === 'user' ? 'user' : 'assistant';
      const text = Array.isArray(payload.content)
        ? payload.content
          .filter((c) => c?.type === 'input_text' || c?.type === 'output_text' || c?.type === 'text')
          .map((c) => c.text).join('\n')
        : String(payload.content ?? '');
      if (text.trim()) out.push(transcriptMessage(role, text, { timestamp }));
    } else if (payload.type === 'reasoning') {
      const text = Array.isArray(payload.summary)
        ? payload.summary.map((s) => s?.text || '').join('\n')
        : String(payload.summary ?? '');
      if (text.trim()) out.push(transcriptMessage('assistant', text, { timestamp, kind: 'reasoning' }));
    } else if (payload.type === 'function_call') {
      out.push(transcriptMessage('tool', `${payload.name || 'tool'}: ${payload.arguments || ''}`, { timestamp, kind: 'tool' }));
    } else if (payload.type === 'function_call_output') {
      out.push(transcriptMessage('tool', String(payload.output ?? ''), { timestamp, kind: 'tool' }));
    }
  }
  return out;
}

// --- opencode: project/<slug>/storage/session/{message,part}/<ses>/... ---

function findOpenCodeProjectDir(cwd, opts = {}) {
  const home = opts.home || os.homedir();
  const base = path.join(home, '.local', 'share', 'opencode', 'project');
  const wanted = projectSlug(cwd).toLowerCase();
  if (!wanted) return null;
  for (const entry of safeReadDir(base)) {
    if (entry.isDirectory() && entry.name.toLowerCase() === wanted) {
      return path.join(base, entry.name, 'storage', 'session');
    }
  }
  return null;
}

function readOpenCodeTranscript(cwd, sessionId, opts = {}) {
  const sessionRoot = findOpenCodeProjectDir(cwd, opts);
  if (!sessionRoot) return [];
  const messageDir = path.join(sessionRoot, 'message', sessionId);
  const partBase = path.join(sessionRoot, 'part', sessionId);
  const entries = safeReadDir(messageDir)
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => {
      const obj = safeReadJson(path.join(messageDir, e.name));
      return obj?.id ? { file: e.name, obj } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.obj?.time?.created || 0) - (b.obj?.time?.created || 0));
  const out = [];
  for (const { obj } of entries) {
    const role = obj.role === 'user' ? 'user' : 'assistant';
    const timestamp = toEpoch(obj?.time?.created);
    const partDir = path.join(partBase, obj.id);
    const parts = safeReadDir(partDir)
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => ({ name: e.name, obj: safeReadJson(path.join(partDir, e.name)) }))
      .filter((p) => p.obj)
      .sort((a, b) => (a.obj?.seq ?? a.name).toString().localeCompare((b.obj?.seq ?? b.name).toString()));
    for (const part of parts) {
      if (part.obj.type === 'text' && String(part.obj.text ?? '').trim()) {
        out.push(transcriptMessage(role, part.obj.text, { timestamp }));
      } else if (part.obj.type === 'tool') {
        out.push(transcriptMessage('tool', `${part.obj.tool || 'tool'}: ${JSON.stringify(part.obj.state?.input ?? {})}`, { timestamp, kind: 'tool' }));
      } else if (part.obj.type === 'reasoning' && String(part.obj.text ?? '').trim()) {
        out.push(transcriptMessage('assistant', part.obj.text, { timestamp, kind: 'reasoning' }));
      }
    }
  }
  return out;
}

// --- devin: GET /v3/organizations/{org}/sessions/{id} ---

async function readDevinTranscript(cwd, sessionId, opts = {}) {
  const token = opts.token || process.env.DEVIN_API_TOKEN || '';
  const orgId = opts.orgId || process.env.DEVIN_ORG_ID || '';
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const baseUrl = (opts.baseUrl || 'https://api.devin.ai').replace(/\/$/, '');
  if (!token || !orgId || !orgId.startsWith('org-') || typeof fetchImpl !== 'function') return [];
  try {
    const url = `${baseUrl}/v3/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res || !res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data?.messages) ? data.messages : [];
    return list.map((m) => {
      const role = m?.role === 'user' ? 'user' : 'assistant';
      const text = typeof m?.content === 'string'
        ? m.content
        : Array.isArray(m?.content)
          ? m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
          : String(m?.message ?? m?.text ?? '');
      return transcriptMessage(role, text, { timestamp: toEpoch(m?.time), kind: 'text' });
    }).filter((m) => m.text);
  } catch {
    return [];
  }
}

async function readTranscript({ provider, sessionId, cwd, ...opts } = {}) {
  if (!PROVIDERS.includes(provider)) {
    return { messages: [], truncated: false, error: 'unknown provider' };
  }
  if (!safeSessionId(sessionId)) {
    return { messages: [], truncated: false, error: 'invalid session id' };
  }
  let messages;
  if (provider === 'claude') messages = readClaudeTranscript(cwd, sessionId, opts);
  else if (provider === 'codex') messages = readCodexTranscript(cwd, sessionId, opts);
  else if (provider === 'opencode') messages = readOpenCodeTranscript(cwd, sessionId, opts);
  else messages = await readDevinTranscript(cwd, sessionId, opts);
  return { messages: clampTranscript(messages).messages, truncated: messages.length > MAX_TRANSCRIPT_MESSAGES };
}

module.exports = {
  PROVIDERS,
  scanClaude,
  scanCodex,
  scanOpenCode,
  scanDevin,
  listSessions,
  claudeSlug,
  projectSlug,
  readTranscript,
  safeSessionId,
};
