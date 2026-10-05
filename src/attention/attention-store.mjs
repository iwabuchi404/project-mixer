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
import { mayInterrupt } from './provenance.mjs';

const OPEN = 'OPEN';
const ACKNOWLEDGED = 'ACKNOWLEDGED';
const RESOLVED = 'RESOLVED';

// AL-5: the open-attention cap for agent-asserted items (plan 8.5.7). Applied
// per session, not per project, so one chatty agent cannot fill the human's
// Inbox and cannot silence the others either.
export const AGENT_MAX_OPEN_ATTENTION = 3;

export function createAttentionStore({ now = () => Date.now() } = {}) {
  // Two maps, deliberately.
  //
  // `items` holds evidence: projections of terminalAttention, i.e. things a
  // hook, plugin or session file reported. reconcile() owns it end to end.
  //
  // `assertions` holds agent-asserted items from MCP request_attention: an
  // agent saying "the human should look at this". These are NOT evidence and
  // must never be laundered through the mapper, because the mapper's output
  // feeds terminalAttention and `waiting` -- letting an agent write there
  // would let it forge the amber state that the whole rung hierarchy treats
  // as ground truth.
  //
  // They also cannot live in `items`, because reconcile() withdraws anything
  // missing from the projection, so an agent item would be deleted on the very
  // next event.
  const items = new Map(); // id -> AttentionRequest (evidence)
  const assertions = new Map(); // id -> AttentionRequest (agent-asserted)

  function snapshot() {
    return Array.from(items.values(), (item) => ({ ...item }))
      .concat(Array.from(assertions.values(), (item) => ({ ...item })));
  }

  function get(id) {
    const item = items.get(id) || assertions.get(id);
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
    // Also clears anything the agent raised for this tab: the human answered in
    // the terminal, so the question is answered regardless of which channel
    // delivered it.
    const id = attentionId(projectId, tabId);
    let resolved = null;
    const existing = items.get(id);
    if (existing && existing.state !== RESOLVED) {
      const timestamp = now();
      const next = { ...existing, state: RESOLVED, resolvedAt: timestamp, updatedAt: timestamp };
      items.set(id, next);
      resolved = { ...next };
    }
    for (const [assertionId, assertion] of Array.from(assertions)) {
      if (assertion.tabId !== tabId || assertion.state === RESOLVED) continue;
      assertions.set(assertionId, {
        ...assertion,
        state: RESOLVED,
        resolvedAt: now(),
        updatedAt: now(),
      });
      resolved = resolved || { ...assertion, state: RESOLVED };
    }
    return resolved;
  }

  // Unconditional removal, for the cases where the source state itself dropped
  // the entry: tab closed, PTY exited, or seen-while-not-waiting. reconcile()
  // deliberately keeps a blocking item alive when it merely leaves the
  // projection, but here the authoritative source says there is no attention at
  // all, and a closed tab has nothing left to resolve it from.
  function forget(projectId, tabId) {
    const id = attentionId(projectId, tabId);
    const existing = items.get(id);
    let forgotten = existing ? { ...existing, state: RESOLVED, updatedAt: now() } : null;
    if (existing) items.delete(id);
    // A closed tab cannot answer anything, so agent-asserted items for it are
    // dropped outright rather than left to block the per-session cap forever.
    for (const [assertionId, assertion] of Array.from(assertions)) {
      if (assertion.tabId !== tabId) continue;
      assertions.delete(assertionId);
      forgotten = forgotten || { ...assertion, state: RESOLVED, updatedAt: now() };
    }
    return forgotten;
  }

  function acknowledgeAttention(id) {
    const map = items.has(id) ? items : assertions.has(id) ? assertions : null;
    if (!map) return null;
    const existing = map.get(id);
    if (!existing || existing.state === RESOLVED) return null;
    const timestamp = now();
    const next = { ...existing, state: ACKNOWLEDGED, acknowledgedAt: timestamp, updatedAt: timestamp };
    map.set(id, next);
    return { ...next };
  }

  // AL-5: an agent asked for the human's attention over MCP.
  //
  // Returns { ok, created, deduped } rather than throwing, because the caller
  // is an MCP tool whose failure has to be reported back to an agent as data.
  //
  // blocking is forced false here as well as in the main-process guard. Two
  // layers on purpose: this one is the store's invariant and survives any
  // future caller, the other rejects the value before it can reach us at all.
function requestAgentAttention(draft) {
     if (!draft || typeof draft !== 'object') {
       return { ok: false, error: 'Malformed attention request.' };
     }
     if (!Number.isInteger(draft.tabId) || draft.tabId <= 0) {
       return { ok: false, error: 'Could not resolve this MCP session to a terminal tab.' };
     }
     const title = typeof draft.title === 'string' ? draft.title.trim() : '';
     if (!title) return { ok: false, error: 'title is required' };
     // `blocking` on the draft is ignored outright, whatever it says. The
     // attempt is still recorded from either field so a caller that skipped
     // the main-process guard cannot hide that it tried.
     const agentDeclaredBlocking = draft.agentDeclaredBlocking === true || draft.blocking === true;

    // Distinct id space from evidence items. The evidence id is
    // `${projectId}:${tabId}`; an agent may raise several distinct items for
    // one tab, so a shared id would overwrite the evidence item and, worse,
    // make a request look like it came from a hook.
    const id = `agent:${draft.projectId}:${draft.tabId}:${draft.kind}:${title}`
      .slice(0, 200);
    const timestamp = now();

    const existing = assertions.get(id);
    if (existing && existing.state !== RESOLVED) {
      // Idempotent (plan 8.5.7). Deliberately does NOT touch updatedAt: a
      // retrying agent would otherwise keep bumping recency and an old item
      // would refuse to sink in the Inbox.
      return { ok: true, deduped: true, attention: { ...existing } };
    }
    if (existing) {
      return { ok: false, error: 'That attention was already resolved.' };
    }

    // Per-session open cap (plan 8.5.7).
    const openForTab = Array.from(assertions.values())
      .filter((item) => item.tabId === draft.tabId && item.state !== RESOLVED);
    if (openForTab.length >= AGENT_MAX_OPEN_ATTENTION) {
      return {
        ok: false,
        error: `This session already has ${openForTab.length} open attentions `
          + `(limit ${AGENT_MAX_OPEN_ATTENTION}). Wait for the human to handle one.`,
      };
    }

    const item = {
      id,
      projectId: draft.projectId,
      tabId: draft.tabId,
      sessionId: draft.sessionId || null,
      kind: draft.kind,
      requestedPriority: draft.requestedPriority || 'normal',
      effectivePriority: effectivePriorityFor({ kind: draft.kind, blocking: false }),
      // An agent cannot mark itself blocking (plan 8.5.7).
      blocking: false,
      // Agent requests arrive over MCP, which is an explicit protocol.
      certainty: 'explicit',
      title,
      summary: draft.summary || null,
      source: 'mcp',
      confidence: null,
      agentDeclaredBlocking,
      state: OPEN,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    assertions.set(id, item);
    return { ok: true, deduped: false, attention: { ...item } };
  }

  // Refuses to resolve a blocking attention. The human has to answer the agent
  // first; otherwise the item would vanish while the agent still waits.
  function resolveAttention(id) {
    const map = items.has(id) ? items : assertions.has(id) ? assertions : null;
    if (!map) return null;
    const existing = map.get(id);
    if (!existing || existing.state === RESOLVED) return null;
    if (existing.blocking) return null;
    const timestamp = now();
    const next = { ...existing, state: RESOLVED, resolvedAt: timestamp, updatedAt: timestamp };
    map.set(id, next);
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
    assertions.clear();
  }

  return {
    reconcile,
    forget,
    answerAttention,
    acknowledgeAttention,
    resolveAttention,
    requestAgentAttention,
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