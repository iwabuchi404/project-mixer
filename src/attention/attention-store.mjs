// src/attention/attention-store.mjs
// Attention Store: the single writer of AttentionRequest state transitions.
//
// Authority split (IMPLEMENTATION_PLAN 3.1):
//   src/store/index.js terminalAttention  -> read-only input (rung 1-3 events)
//   this store                            -> the only writer of Attention lifecycle
//
// The store never writes back to terminalAttention. reconcile() takes a fresh
// projection and returns the changes; acknowledge/resolve are explicit human
// actions and are never inferred from a projection.
//
// Timestamps are owned here, not by the mapper. That is what lets the mapper
// stay pure and lets a re-projection preserve createdAt across ticks.

import { mapAttention, attentionId } from './attention-mapper.mjs';
import { effectivePriorityFor, applyPolicy, applyPolicyToAll } from './attention-policy.mjs';

const OPEN = 'OPEN';
const ACKNOWLEDGED = 'ACKNOWLEDGED';
const RESOLVED = 'RESOLVED';

export function createAttentionStore({ now = () => Date.now() } = {}) {
  const items = new Map(); // id -> AttentionRequest

  function snapshot() {
    return Array.from(items.values(), (item) => ({ ...item }));
  }

  function get(id) {
    const item = items.get(id);
    return item ? { ...item } : null;
  }

  // Fold a fresh projection into the store. Existing entries keep createdAt and
  // any acknowledgement. Only genuinely new or newly blocking entries move.
  //
  // Attention Policy (AL-6) runs here, but only its half that does not depend
  // on the human: effectivePriority. Presentation needs to know where the
  // human is, which changes without any agent event, so it is applied at read
  // time via presentAttention() instead of being frozen into stored state.
  //
  // effectivePriorityFor() rather than applyPolicy() on purpose: applyPolicy
  // also computes presentation, and persisting that would pin the routing
  // decision to whatever the human happened to be looking at when the event
  // arrived.
  function reconcile(attention) {
    const projected = mapAttention(attention).map((draft) => ({
      ...draft,
      effectivePriority: effectivePriorityFor(draft),
    }));
    const timestamp = now();
    const seen = new Set();
    const created = [];
    const updated = [];

    for (const draft of projected) {
      seen.add(draft.id);
      const existing = items.get(draft.id);

      if (!existing) {
        const item = {
          ...draft,
          state: OPEN,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        items.set(draft.id, item);
        created.push({ ...item });
        continue;
      }

      if (existing.state === RESOLVED) {
        // A resolved attention stays resolved. The projection re-listing it
        // means the source state has not caught up yet; re-opening on that
        // signal would resurrect dismissed items on every tick.
        continue;
      }

      const next = { ...existing, ...draft, updatedAt: timestamp };
      // A projection carries no acknowledgement, so restore it. merge() above
      // cannot drop it (draft has no such key), but being explicit keeps the
      // invariant readable.
      next.acknowledgedAt = existing.acknowledgedAt;
      const changed = existing.state !== next.state
        || existing.blocking !== next.blocking
        || existing.kind !== next.kind
        || existing.summary !== next.summary
        || existing.title !== next.title;
      items.set(draft.id, next);
      if (changed) updated.push({ ...next });
    }

    // Entries missing from the projection are no longer sourced. Resolving them
    // is correct only when they are not blocking: a blocking entry must stay
    // open until the human acts (IMPLEMENTATION_PLAN 4.3).
    const withdrawn = [];
    for (const [id, existing] of Array.from(items)) {
      if (seen.has(id) || existing.state === RESOLVED) continue;
      if (existing.blocking) continue;
      items.delete(id);
      withdrawn.push({ ...existing, state: RESOLVED, updatedAt: timestamp });
    }

    return { created, updated, withdrawn };
  }

  // The human responded in the terminal. resolveAttention refuses a blocking item
  // because no answer has arrived yet — but here the answer *is* the keystroke
  // that cleared waiting, so this is the one path that may resolve it. Anything
  // else would leave a prompt that can never be dismissed.
  function answerAttention(projectId, tabId) {
    const existing = items.get(attentionId(projectId, tabId));
    if (!existing || existing.state === RESOLVED) return null;
    const timestamp = now();
    const next = { ...existing, state: RESOLVED, resolvedAt: timestamp, updatedAt: timestamp };
    items.set(attentionId(projectId, tabId), next);
    return { ...next };
  }

  // Unconditional removal, for the cases where the source state itself dropped
  // the entry: tab closed, PTY exited, or seen-while-not-waiting. reconcile()
  // deliberately keeps a blocking item alive when it merely leaves the
  // projection, but here the authoritative source says there is no attention at
  // all, and a closed tab has nothing left to resolve it from.
  function forget(projectId, tabId) {
    const id = attentionId(projectId, tabId);
    const existing = items.get(id);
    if (!existing) return null;
    items.delete(id);
    return { ...existing, state: RESOLVED, updatedAt: now() };
  }

  function acknowledgeAttention(id) {
    const existing = items.get(id);
    if (!existing || existing.state === RESOLVED) return null;
    const timestamp = now();
    const next = { ...existing, state: ACKNOWLEDGED, acknowledgedAt: timestamp, updatedAt: timestamp };
    items.set(id, next);
    return { ...next };
  }

  // Refuses to resolve a blocking attention. The human has to answer the agent
  // first; otherwise the item would vanish while the agent still waits.
  function resolveAttention(id) {
    const existing = items.get(id);
    if (!existing || existing.state === RESOLVED) return null;
    if (existing.blocking) return null;
    const timestamp = now();
    const next = { ...existing, state: RESOLVED, resolvedAt: timestamp, updatedAt: timestamp };
    items.set(id, next);
    return { ...next };
  }

  function getOpenAttention() {
    return snapshot().filter((item) => item.state !== RESOLVED);
  }

  // Attach `presentation` to each open item given where the human currently
  // is. Called by the renderer on every render because human context changes
  // without any agent event (the human switching panes or projects is itself a
  // routing signal), so presentation must never be persisted as state.
  function presentAttention(humanContext) {
    return applyPolicyToAll(getOpenAttention(), humanContext);
  }

  function getProjectAttention(projectId) {
    return getOpenAttention().filter((item) => item.projectId === projectId);
  }

  function getTabAttention(tabId) {
    return getOpenAttention().filter((item) => item.tabId === tabId);
  }

  // D24 (1.2): the human's attention is a set plus a keyboard holder, never a
  // single ranked value. These return collections; there is deliberately no
  // nextAttention / oldestOpenAttention accessor.
  function getAttentionInView(paneTabIds, hasFocusTabId) {
    const ids = Array.isArray(paneTabIds) ? paneTabIds.filter((id) => Number.isInteger(id)) : [];
    return getOpenAttention().filter((item) => ids.includes(item.tabId) || item.tabId === hasFocusTabId);
  }

  function getAttentionOutOfView(paneTabIds, hasFocusTabId) {
    const inView = getAttentionInView(paneTabIds, hasFocusTabId);
    const inViewIds = new Set(inView.map((item) => item.id));
    return getOpenAttention().filter((item) => !inViewIds.has(item.id));
  }

  // Derived counts for the sidebar. Counts, not rankings.
  function needsHumanCount() {
    return getOpenAttention().filter((item) => item.blocking).length;
  }

  function highPriorityCount() {
    return getOpenAttention().filter((item) => item.effectivePriority === 'high').length;
  }

  function projectAttentionCounts() {
    const counts = {};
    for (const item of getOpenAttention()) {
      const bucket = counts[item.projectId] || { needsHuman: 0, high: 0, open: 0 };
      bucket.open += 1;
      if (item.blocking) bucket.needsHuman += 1;
      if (item.effectivePriority === 'high') bucket.high += 1;
      counts[item.projectId] = bucket;
    }
    return counts;
  }

  function clear() {
    items.clear();
  }

  return {
    reconcile,
    forget,
    answerAttention,
    acknowledgeAttention,
    resolveAttention,
    presentAttention,
    get,
    getOpenAttention,
    getProjectAttention,
    getTabAttention,
    getAttentionInView,
    getAttentionOutOfView,
    needsHumanCount,
    highPriorityCount,
    projectAttentionCounts,
    snapshot,
    clear,
  };
}