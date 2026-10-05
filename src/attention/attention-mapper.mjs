// src/attention/attention-mapper.mjs
// Pure projection: terminalAttention -> AttentionRequest.
//
// Provenance: `certainty` is read from the notification record rather than
// re-derived from `source`, because source alone cannot distinguish a
// hook assertion from a PTY observation that looked similar.
//
// Purity is the point, not a style choice. The "an input prompt is never
// cleared by a late completion event" rule already lives in
// src/notifications/state.mjs. A pure re-labelling cannot violate that rule;
// a mapper that owned transitions could. So this module never mutates its
// input and never resolves anything.
//
// Timestamps are deliberately absent (IMPLEMENTATION_PLAN 4.2 / 3.1):
// createdAt / updatedAt / acknowledgedAt / resolvedAt belong to the
// Attention Store, which is the only writer of state transitions.

import { classifyCertainty, mayBlock } from './provenance.mjs';

export const ATTENTION_KINDS = Object.freeze([
  'question',
  'decision',
  'blocked',
  'error',
  'review',
  'completed',
  'info',
]);

export const ATTENTION_PRIORITIES = Object.freeze(['low', 'normal', 'high']);

export const ATTENTION_SOURCES = Object.freeze(['agent', 'hook', 'terminal', 'system']);

const DEFAULT_TITLES = Object.freeze({
  question: 'Waiting for input',
  error: 'Turn failed',
  completed: 'Turn completed',
});

// rung 3 (PTY heuristic) is the only source that cannot state where its
// evidence came from, so it is recorded as inferred provenance rather than a
// bare source string. See src/attention/provenance.mjs for why certainty is
// three-way and what it gates.
const HEURISTIC_SOURCE = 'pty';
const HEURISTIC_CONFIDENCE = 0.5;

// `waiting` is authoritative and is checked before `kind` on purpose. The
// store keeps a waiting entry alive across out-of-order lifecycle updates, so
// the entry can still carry a stale `kind`. Trusting `kind` there would let a
// late completion event downgrade an input prompt.
function classifyKind(item) {
  if (item.waiting) return 'question';
  switch (item.kind) {
    case 'needs_attention':
      return 'question';
    case 'turn_failed':
      return 'error';
    case 'turn_completed':
      // A completion with nothing unread is not an attention at all: the
      // store drops those, so this only guards hand-built fixtures.
      return item.unread ? 'completed' : null;
    default:
      // turn_started and anything unrecognised mean "working normally",
      // which policy 2.1 says must not notify.
      return null;
  }
}

// Classification default. Attention Policy (AL-6) is what later separates
// requestedPriority from effectivePriority; until then they are equal so no
// policy decision is smuggled into the mapper.
function classifyPriority(kind) {
  if (kind === 'error') return 'high';
  if (kind === 'completed') return 'low';
  return 'normal';
}

function classifySource(rawSource) {
  switch (rawSource) {
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'devin':
    case 'agent':
      return 'agent';
    case 'hook':
      return 'hook';
    case HEURISTIC_SOURCE:
      return 'terminal';
    default:
      return 'system';
  }
}

function classifyConfidence(rawSource) {
  return rawSource === HEURISTIC_SOURCE ? HEURISTIC_CONFIDENCE : 1;
}

// Provenance travels with the item instead of being re-derived here. The
// notification layer already recorded how the signal arrived; re-deriving it
// from `source` would be exactly the guesswork this replaced.
function classifyCertaintyOf(item) {
  if (typeof item.certainty === 'string') return item.certainty;
  return classifyCertainty(item.source, null);
}

function classifyTitle(kind, item) {
  const declared = typeof item.title === 'string' ? item.title.trim() : '';
  if (declared) return declared;
  if (kind === 'question' && item.reason === 'approval') return 'Approval required';
  return DEFAULT_TITLES[kind] || 'Agent update';
}

function optionalText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

// One open attention per tab. src/notifications/state.mjs holds at most one
// entry per tabId, so (projectId, tabId) is unique among open items and stays
// stable across re-projection.
//
// The id deliberately excludes `kind`. A tab's attention changes kind over its
// life (question -> completed, question -> error). Keying on kind would make
// that look like "one attention vanished and another appeared", leaving the
// blocking predecessor stranded and unresolvable.
export function attentionId(projectId, tabId) {
  return `${projectId}:${tabId}`;
}

// Returns the classification part of an AttentionRequest, or null when the
// item does not warrant attention.
// Provenance-aware blocking. `item.waiting` alone would let a PTY regex
// match become a blocking attention, and resolveAttention() refuses blocking
// items -- so a false positive would survive every click. The notification
// layer records `blockingCertain` for exactly this decision.
function classifyBlocking(item) {
  if (!item.waiting) return false;
  if (typeof item.blockingCertain === 'boolean') return item.blockingCertain;
  if (typeof item.certainty === 'string') return mayBlock(classifyCertaintyOf(item));
  // Neither field present: a hand-built fixture or a producer that predates
  // provenance. `waiting` was the whole signal before, and these records are
  // not observations, so honour it. Only real signals carry a certainty, and
  // those are gated above.
  return true;
}

export function mapAttentionItem(tabId, item) {
  if (!Number.isInteger(tabId) || tabId <= 0) return null;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

  const projectId = optionalText(item.projectId);
  if (!projectId) return null;

  const kind = classifyKind(item);
  if (!kind) return null;

const requestedPriority = classifyPriority(kind);

  return {
    id: attentionId(projectId, tabId),
    projectId,
    tabId,
    sessionId: optionalText(item.sessionId),
    kind,
    requestedPriority,
    // Placeholder. Attention Policy (AL-6, attention-policy.mjs) owns this
    // field and recomputes it; the mapper must not smuggle in a policy
    // decision, so it only mirrors requestedPriority until the store runs
    // the policy over the projection.
    effectivePriority: requestedPriority,
    blocking: classifyBlocking(item),
    title: classifyTitle(kind, item),
    summary: optionalText(item.message),
    reason: optionalText(item.reason),
    source: classifySource(item.source),
    confidence: classifyConfidence(item.source),
    certainty: classifyCertaintyOf(item),
  };
}

// Project the whole attention map. Ordering is stable (ascending tabId) so
// the Store can diff two projections without reshuffling.
export function mapAttention(attention) {
  if (!attention || typeof attention !== 'object' || Array.isArray(attention)) return [];
  const mapped = [];
  for (const key of Object.keys(attention)) {
    const tabId = Number(key);
    if (!Number.isInteger(tabId)) continue;
    const item = mapAttentionItem(tabId, attention[key]);
    if (item) mapped.push(item);
  }
  mapped.sort((a, b) => a.tabId - b.tabId);
  return mapped;
}