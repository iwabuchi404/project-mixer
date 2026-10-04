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

let store = createAttentionStore();

export function getAttentionStore() {
  return store;
}

// Reconcile after a terminalAttention transition. Returns the store diff so a
// caller can react (toast, OS notification) without re-reading either store.
export function reconcileAttention(terminalAttention) {
  return store.reconcile(terminalAttention || {});
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