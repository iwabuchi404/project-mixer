// src/attention/attention-wiring.mjs
// The one place where terminalAttention transitions become Attention Store
// transitions (IMPLEMENTATION_PLAN 4.6).
//
// R2 made src/store/index.js the single source of truth for badge/waiting
// state. AL-1 added a second source of truth for the same facts. Left alone,
// that is the double management D20 exists to prevent: two structures updated
// by two code paths, diverging quietly and surfacing as a UI bug nobody can
// trace.
//
// The fix is not discipline, it is structure. Every terminalAttention write
// goes through commitAttention(), which reconciles the Attention Store in the
// same step. A write that skipped this module would be visible in review as a
// missing commitAttention call, and the test suite asserts there is no other
// path.

import { createAttentionStore } from './attention-store.mjs';
import {
  normalizeHumanContext,
  projectPresentation,
  strongestPresentation,
} from './attention-policy.mjs';

let store = createAttentionStore();

export function getAttentionStore() {
  return store;
}

// Attention Policy (AL-6) read path. Human context is passed in rather than
// read from renderer state so this module stays free of UI dependencies and
// the policy stays unit-testable.
//
// Only presentation is computed here. effectivePriority is applied inside the
// store on reconcile because it depends only on the event kind.
export function presentAttention(humanContext) {
  return store.presentAttention(normalizeHumanContext(humanContext));
}

// Strongest presentation across the human's current open attention. The
// sidebar uses this so a blocking item cannot be masked by a quieter sibling.
export function currentAttentionPresentation(humanContext) {
  return strongestPresentation(presentAttention(humanContext).map((item) => item.presentation));
}

// Per-project rollup, for sidebar badges.
export function projectAttentionPresentations(humanContext) {
  const presented = presentAttention(humanContext);
  const byProject = new Map();
  for (const item of presented) {
    if (!byProject.has(item.projectId)) byProject.set(item.projectId, []);
    byProject.get(item.projectId).push(item);
  }
  const result = {};
  for (const [projectId, items] of byProject) {
    result[projectId] = projectPresentation(items);
  }
  return result;
}

// Reconcile after a terminalAttention transition. Returns the store diff so a
// caller can react (toast, OS notification) without re-reading either store.
export function reconcileAttention(terminalAttention) {
  return store.reconcile(terminalAttention || {});
}

// AL-5: an agent asked for the human's attention. Goes straight into the
// store's assertion space and deliberately does NOT touch terminalAttention:
// that map is evidence derived from hooks, and letting an agent write there
// would let it forge the amber `waiting` state the rest of the system treats
// as ground truth.
export function requestAgentAttention(draft) {
  return store.requestAgentAttention(draft);
}

// Explicit human actions. Neither is ever inferred from a projection: opening a
// tab is not acknowledgement, and nothing but the human resolves.
export function acknowledgeAttention(id) {
  return store.acknowledgeAttention(id);
}

export function resolveAttention(id) {
  return store.resolveAttention(id);
}

// The human typed the answer. This is the only path that may resolve a blocking
// attention, because the keystroke that produced it is the resolution.
export function answerTabAttention(projectId, tabId) {
  if (!projectId) return null;
  return store.answerAttention(projectId, tabId);
}

// Tab teardown. Drops the attention regardless of blocking, because there is no
// tab left to answer from — the amber dot would outlive its terminal.
export function forgetTabAttention(projectId, tabId) {
  if (!projectId) return null;
  return store.forget(projectId, tabId);
}

// Test seam. Production code never resets the store; tests need a clean slate
// between cases and there is no other way to get one.
export function __resetAttentionStoreForTest() {
  store = createAttentionStore();
}