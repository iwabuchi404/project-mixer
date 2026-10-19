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

module.exports = {
  PROVIDERS,
  scanClaude,
  scanCodex,
  scanOpenCode,
  scanDevin,
  listSessions,
  claudeSlug,
  projectSlug,
};
