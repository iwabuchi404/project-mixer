// src/main/attention-request.cjs
// Guarded entry point for the MCP `request_attention` tool (IMPLEMENTATION_PLAN
// AL-5, section 8).
//
// WHY THIS LIVES IN MAIN, NOT THE RENDERER
// The guards in section 8.5(7) are a trust boundary. An MCP client is an
// agent process: anything it can assert, it can assert wrongly. Deciding what
// an agent is *allowed* to say about the human's attention has to happen
// before the value reaches the renderer, or a future UI refactor could
// reintroduce a path that trusts the agent's own `blocking`.
//
// WHY `blocking` IS FORCED FALSE HERE
// Section 8.5(7): "Agent can only specify blocking up to false.
// blocking: true is not decidable by the agent, because it stops the human."
// That is the whole reason the guard exists. The code sample in section 8.2
// passes `blocking: true`, which contradicts the guard; the guard wins,
// because section 8.5 is dated (2026-10 confirmed) and is the security
// section. A tool description that advertises a field it then ignores would
// teach agents to rely on it, so the field is accepted for compatibility but
// silently corrected, and the response says so.
//
// WHERE EACH GUARD RUNS, AND WHY
// Two of the guards need state this process does not have:
//
//   idempotence, per-session open cap  -> need the open items, which live in
//                                        the renderer's Attention Store.
//   tabId resolution                   -> the renderer owns the ptyId <->
//                                        tabId map. registerSession() is given
//                                        a ptyId, and nothing in main knows
//                                        which tab that became.
//
// So the split is deliberate rather than convenient: everything decidable from
// the request alone is enforced HERE, where the agent's words cannot skip it,
// and everything that needs application state is enforced by the renderer
// command handler that already owns the store. Duplicating the stateless half
// in the renderer would create two places to forget.
//
// This module is pure. No clock, no I/O, no renderer access, so the guards
// are testable without an Electron instance.

const AGENT_KINDS = Object.freeze([
  'question',
  'decision',
  'blocked',
  'error',
  'review',
  'completed',
  'info',
]);

const AGENT_PRIORITIES = Object.freeze(['low', 'normal', 'high']);

const MAX_TITLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 400;
const MAX_MESSAGE_LENGTH = 400;

function normalizeEnum(value, allowed, fallback) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return allowed.includes(text) ? text : fallback;
}

function clampText(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Normalize and guard one agent request. The stateless half only.
 *
 * `tabId` is deliberately NOT resolved here: main knows ptyId, and the
 * renderer owns the ptyId -> tabId map. The renderer command handler resolves
 * it and applies the stateful guards.
 *
 * @param {object} input   raw tool arguments from the agent
 * @param {object} session per-PTY session context (ptyId, projectId, cwd)
 * @returns {{ok: boolean, attention?: object, error?: string, notices?: string[]}}
 */
function prepareAgentAttention(input, session) {
  const notices = [];
  const raw = input && typeof input === 'object' ? input : {};

  // --- identity comes from the transport, never from the agent (8.4) ---
  const projectId = typeof session?.projectId === 'string' && session.projectId
    ? session.projectId
    : null;
  if (!projectId) {
    return { ok: false, error: 'This MCP session has no project; cannot attribute the request.' };
  }
  const ptyId = Number.isInteger(session?.ptyId) && session.ptyId > 0 ? session.ptyId : null;
  if (!ptyId) {
    return { ok: false, error: 'This MCP session has no terminal; cannot attribute the request.' };
  }

  const kind = normalizeEnum(raw.kind, AGENT_KINDS, 'question');
  if (raw.kind && normalizeEnum(raw.kind, AGENT_KINDS, null) === null) {
    notices.push(`unknown kind "${String(raw.kind).slice(0, 40)}" was treated as "question"`);
  }

  const title = clampText(raw.title, MAX_TITLE_LENGTH);
  if (!title) return { ok: false, error: 'title is required' };
  const summary = clampText(raw.summary, MAX_SUMMARY_LENGTH);

  // --- the guard: an agent may not declare itself blocking (8.5(7)) ---
  // Deliberately loose: zod already rejects non-booleans, but this function is
  // also called from paths that may not go through the schema, and 'yes' or 1
  // reaching here would still be an agent trying to stop the human. Record the
  // attempt either way; the outcome (blocking false) is what matters.
  const requestedBlocking = raw.blocking === true
    || raw.blocking === 'true'
    || raw.blocking === 1
    || raw.blocking === '1'
    || raw.blocking === 'yes';
  if (requestedBlocking) {
    notices.push(
      'blocking was ignored: only the human decides what stops their own work, '
      + 'so an agent cannot mark an attention as blocking (plan 8.5.7).',
    );
  }

  return {
    ok: true,
    notices,
    attention: {
      projectId,
      ptyId,
      sessionId: typeof session?.sessionId === 'string' ? session.sessionId : null,
      kind,
      requestedPriority: normalizeEnum(raw.priority, AGENT_PRIORITIES, 'normal'),
      title,
      summary,
      blocking: false,
      // Provenance is explicit so the UI can label an agent-asserted item
      // differently from a hook-observed one (8.5.6: this is a supplementary
      // channel, not a detection mechanism, so it must not be mistaken for
      // evidence).
      source: 'mcp',
      agentDeclaredBlocking: requestedBlocking,
    },
  };
}

module.exports = {
  prepareAgentAttention,
  AGENT_KINDS,
  AGENT_PRIORITIES,
  MAX_TITLE_LENGTH,
  MAX_SUMMARY_LENGTH,
};