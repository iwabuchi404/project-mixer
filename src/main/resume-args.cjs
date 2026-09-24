// src/main/resume-args.cjs
// CLI arguments for resuming an agent's previous session.
//
// Each agent exposes a different resume surface:
//   claude    -> --resume <id>
//   codex     -> resume <id>
//   opencode  -> -s <ses_id>
//   devin     -> -r <ses_id>  (cloud session; reattaches via the Devin CLI)
//
// No tracked session id means a fresh launch (null) — the resume prompt's
// Cancel must start clean, never implicitly continue the last session.

const RESUME_SUPPORTED = new Set(['claude', 'codex', 'opencode', 'devin']);

function buildResumeArgs(command, sessionId) {
  const name = String(command || '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (!RESUME_SUPPORTED.has(name)) return null;
  if (!sessionId) return null;
  if (name === 'claude') {
    return ['--resume', String(sessionId)];
  }
  if (name === 'codex') {
    return ['resume', String(sessionId)];
  }
  if (name === 'devin') {
    return ['-r', String(sessionId)];
  }
  // opencode
  return ['-s', String(sessionId)];
}

module.exports = { buildResumeArgs, RESUME_SUPPORTED };
