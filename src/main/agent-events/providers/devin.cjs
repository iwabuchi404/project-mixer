// src/main/agent-events/providers/devin.cjs
// D1: raw Devin hook payloads and terminal notifications → normalized
// lifecycle envelope (Devin Hooks 通知統合計画 §3, §10).
//
// Contract:
// - UserPromptSubmit → turn_started (turnId = promptId)
// - Stop             → turn_stop_requested. NEVER turn_completed: only the
//   OSC "Devin finished" notification promotes a turn to completed.
// - OSC needs input  → needs_attention(reason: input)
// - OSC finished     → turn_completed
// - PreToolUse / SessionStart / ... are ignored by design.
//
// Raw hook payloads are not persisted: only the allowlist identity fields
// (ptyId / sessionId / promptId / stopHookActive) survive mapping.

const HOOK_KINDS = new Map([
  ['userpromptsubmit', { kind: 'turn_started', reason: null }],
  ['stop', { kind: 'turn_stop_requested', reason: null }],
]);

function normalizeIdentityString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePtyId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function mapDevinHookPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const provider = typeof data.provider === 'string' ? data.provider.toLowerCase() : '';
  if (provider && provider !== 'devin') return null;
  const eventType = typeof data.eventType === 'string' ? data.eventType.trim() : '';
  if (!eventType) return null;
  const mapped = HOOK_KINDS.get(eventType.toLowerCase());
  if (!mapped) return null;
  const sessionId = normalizeIdentityString(data.sessionId ?? data.session_id);
  const promptId = normalizeIdentityString(data.promptId ?? data.prompt_id);
  return {
    eventType,
    kind: mapped.kind,
    reason: mapped.reason,
    source: 'devin',
    provider: 'devin',
    sessionId,
    turnId: promptId,
    promptId,
    stopHookActive: mapped.kind === 'turn_stop_requested'
      ? data.stopHookActive === true
      : null,
    ptyId: normalizePtyId(data.ptyId ?? data.pty_id),
    title: null,
    message: null,
    cwd: typeof data.cwd === 'string' ? data.cwd : '',
  };
}

// The renderer's OSC adapter (src/notifications/devin-terminal.mjs) already
// normalizes OSC 9/777 into { kind, eventType, source, reason }. This maps
// that shape onto the same lifecycle envelope so fixtures and the attention
// integration (D3) handle one shape only.
function mapDevinOscNotification(notification, { ptyId = null, sessionId = null } = {}) {
  if (!notification || typeof notification !== 'object' || Array.isArray(notification)) return null;
  if (notification.source !== 'devin') return null;
  if (notification.kind !== 'needs_attention' && notification.kind !== 'turn_completed') return null;
  const isComplete = notification.kind === 'turn_completed';
  return {
    eventType: typeof notification.eventType === 'string' && notification.eventType
      ? notification.eventType
      : (isComplete ? 'finished' : 'needs_input'),
    kind: notification.kind,
    reason: isComplete ? null : (notification.reason || 'input'),
    source: 'devin',
    provider: 'devin',
    sessionId: normalizeIdentityString(sessionId),
    turnId: null,
    promptId: null,
    stopHookActive: null,
    ptyId: normalizePtyId(ptyId),
    title: null,
    message: null,
    cwd: '',
  };
}

// Turn correlation state for one PM instance (計画 §10):
// - dedupe: `${provider}:${sessionId}:${promptId}:${eventType}` in a bounded
//   TTL cache — the same hook delivery arriving twice must not double-notify.
// - stale Stop: a Stop whose promptId does not match the session's current
//   turn is history only; it must not change the visible turn state.
function createDevinTurnTracker({ ttlMs = 10 * 60 * 1000, maxEntries = 500, now = Date.now } = {}) {
  const turns = new Map(); // sessionId -> { promptId, updatedAt }
  const seen = new Map(); // dedupe key -> expiresAt

  function prune(nowMs) {
    for (const [key, expiresAt] of seen) {
      if (expiresAt <= nowMs) seen.delete(key);
    }
    for (const [sessionId, turn] of turns) {
      if (nowMs - turn.updatedAt > ttlMs) turns.delete(sessionId);
    }
    while (seen.size > maxEntries) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [key, expiresAt] of seen) {
        if (expiresAt < oldest) { oldest = expiresAt; oldestKey = key; }
      }
      if (oldestKey === null) break;
      seen.delete(oldestKey);
    }
    while (turns.size > maxEntries) {
      let oldestSid = null;
      let oldest = Infinity;
      for (const [sessionId, turn] of turns) {
        if (turn.updatedAt < oldest) { oldest = turn.updatedAt; oldestSid = sessionId; }
      }
      if (oldestSid === null) break;
      turns.delete(oldestSid);
    }
  }

  return {
    noteTurnStarted(sessionId, promptId) {
      if (!sessionId) return;
      const nowMs = now();
      turns.set(sessionId, { promptId: promptId || null, updatedAt: nowMs });
      prune(nowMs);
    },
    // A Stop can only be called stale when we KNOW the session's current
    // turn and it differs. Unknown session or missing promptId: not stale.
    isStaleStop(sessionId, promptId) {
      const nowMs = now();
      prune(nowMs);
      const turn = sessionId ? turns.get(sessionId) : null;
      if (!turn || !promptId) return false;
      return turn.promptId !== null && turn.promptId !== promptId;
    },
    seenEvent(sessionId, promptId, eventType) {
      const nowMs = now();
      const key = `devin:${sessionId || ''}:${promptId || ''}:${eventType}`;
      const expiresAt = seen.get(key);
      if (expiresAt && expiresAt > nowMs) return true;
      seen.set(key, nowMs + ttlMs);
      prune(nowMs);
      return false;
    },
    size() {
      return { turns: turns.size, seen: seen.size };
    },
  };
}

module.exports = {
  mapDevinHookPayload,
  mapDevinOscNotification,
  createDevinTurnTracker,
};
