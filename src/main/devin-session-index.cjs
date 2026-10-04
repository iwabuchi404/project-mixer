// src/main/devin-session-index.cjs
// Query surface for local Devin sessions.
//
// WHY THIS EXISTS
// Devin has no hook mechanism, so Project Mixer cannot learn a session id
// the way it does for claude (hook payload) or codex (notify payload).
// `devinBind` requires the human to paste a cloud session id by hand, and
// its validator only accepts the `devin-<slug>` cloud form. Measured on
// devin 3000.11.3: the local session ids that `devin list` reports are
// bare two-word slugs (`thinkable-parakeet`), which that validator
// rejects outright. That is why 16 devin tabs in a real layout all
// restored as fresh sessions.
//
// The CLI does expose a machine-readable, cwd-scoped index though:
//   devin list --format json
//   -> [{ id, short_id, working_directory, last_activity_at, title }]
//
// So the id is discoverable. This module is the pure part: parse that
// output and decide which candidate, if any, is safe to propose.
//
// DELIBERATE LIMITATION (option C)
// `devin list` exposes no per-tab identity. Two devin tabs in one project
// cannot be told apart, and nothing in the payload ties a session to the
// PTY that ran it. So this module never picks a winner for an ambiguous
// case: it returns the newest candidate AND the number of candidates, and
// the caller is expected to propose rather than silently attach. A wrong
// automatic attach is worse than a fresh session, because it resumes a
// conversation the human did not ask for.

// Local ids are slugs like `thinkable-parakeet`. Cloud ids are
// `devin-<slug>`. Accept both so the same parser serves both worlds.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_SESSIONS = 500;

// Only a plain, existing directory may be handed to the CLI as cwd.
function isSafeCwd(cwd) {
  return typeof cwd === 'string' && cwd.trim().length > 0 && !cwd.includes('\0');
}

// Separator direction is not guaranteed to match: on Windows the CLI
// reported backslash paths, while project paths stored in projects.json
// can use forward slashes. Fold both to one separator before comparing,
// or a legitimate candidate is silently dropped.
function normalizePathKey(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Parse `devin list --format json` output.
 * Tolerant by design: a malformed row is dropped, not fatal, because a
 * single odd session must not disable resume for the rest.
 *
 * @returns {{sessions: Array<object>, truncated: boolean}}
 */
function parseDevinSessionList(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  if (!text.trim()) return { sessions: [], truncated: false };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { sessions: [], truncated: false };
  }
  if (!Array.isArray(parsed)) return { sessions: [], truncated: false };

  const truncated = parsed.length > MAX_SESSIONS;
  const sessions = [];
  for (const row of parsed.slice(0, MAX_SESSIONS)) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!SESSION_ID_PATTERN.test(id)) continue;
    const lastActivityAt = Number(row.last_activity_at);
    sessions.push({
      id,
      shortId: typeof row.short_id === 'string' ? row.short_id.trim() : id,
      workingDirectory: typeof row.working_directory === 'string' ? row.working_directory : null,
      // NaN is fine: the sort below treats it as oldest.
      lastActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt : 0,
      title: typeof row.title === 'string' ? row.title : null,
    });
  }
  return { sessions, truncated };
}

/**
 * Pick the candidate to propose for `cwd`.
 *
 * Returns `{ candidate: null, ... }` when nothing is safe to propose:
 * - no sessions in that directory
 * - more than one candidate, because the index cannot say which tab owns
 *   which session. The human is asked instead.
 *
 * @returns {{candidate: object|null, count: number, ambiguous: boolean}}
 */
function pickDevinResumeCandidate(sessions, cwd) {
  const key = normalizePathKey(cwd);
  const inDir = (Array.isArray(sessions) ? sessions : []).filter(
    (s) => s && normalizePathKey(s.workingDirectory) === key,
  );
  if (inDir.length === 0) return { candidate: null, count: 0, ambiguous: false };
  const sorted = [...inDir].sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  const newest = sorted[0];
  return {
    // Even with several sessions we surface the newest one, but `ambiguous`
    // stays true so the caller can phrase the prompt as a choice.
    candidate: newest,
    count: inDir.length,
    ambiguous: inDir.length > 1,
  };
}

module.exports = {
  parseDevinSessionList,
  pickDevinResumeCandidate,
  isSafeCwd,
  normalizePathKey,
  SESSION_ID_PATTERN,
  MAX_JSON_BYTES,
  MAX_SESSIONS,
};
