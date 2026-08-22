// src/main/resume-args.cjs
// CLI arguments for resuming an agent's previous session.
//
// Each agent exposes a different resume surface:
//   claude    -> --resume <id>   (fallback: --continue, cwd-scoped)
//   codex     -> resume <id>     (fallback: resume --last, NOT cwd-scoped)
//   opencode  -> -s <ses_id>     (fallback: --continue, project-scoped)
//   devin     -> unsupported (cloud sessions)
//
// A tracked session id is always preferred; the fallback flag is only used
// when PM has no id for that project+command.

const RESUME_SUPPORTED = new Set(['claude', 'codex', 'opencode']);

function buildResumeArgs(command, sessionId) {
  const name = String(command || '').toLowerCase().replace(/\.exe$/, '');
  if (!RESUME_SUPPORTED.has(name)) return null;
  if (name === 'claude') {
    return sessionId ? ['--resume', String(sessionId)] : ['--continue'];
  }
  if (name === 'codex') {
    return sessionId ? ['resume', String(sessionId)] : ['resume', '--last'];
  }
  // opencode
  return sessionId ? ['-s', String(sessionId)] : ['--continue'];
}

module.exports = { buildResumeArgs, RESUME_SUPPORTED };
