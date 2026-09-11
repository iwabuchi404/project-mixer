// src/main/resume-args.cjs
// CLI arguments for resuming an agent's previous session.
//
// Each agent exposes a different resume surface:
//   claude    -> --resume <id>
//   codex     -> resume <id>
//   opencode  -> -s <ses_id>
//   devin     -> unsupported (cloud sessions)
//
// No tracked session id means a fresh launch (null) — the resume prompt's
// Cancel must start clean, never implicitly continue the last session.

const RESUME_SUPPORTED = new Set(['claude', 'codex', 'opencode']);

function buildResumeArgs(command, sessionId) {
  const name = String(command || '').toLowerCase().replace(/\.exe$/, '');
  if (!RESUME_SUPPORTED.has(name)) return null;
  if (!sessionId) return null;
  if (name === 'claude') {
    return ['--resume', String(sessionId)];
  }
  if (name === 'codex') {
    return ['resume', String(sessionId)];
  }
  // opencode
  return ['-s', String(sessionId)];
}

module.exports = { buildResumeArgs, RESUME_SUPPORTED };
