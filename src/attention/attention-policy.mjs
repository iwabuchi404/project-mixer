// src/attention/attention-policy.mjs
// Attention Policy (IMPLEMENTATION_PLAN AL-6, sections 9.2 / 9.3).
//
// Splits two things the plan keeps separate:
//
//   requestedPriority  what the agent's event implies
//   effectivePriority   what the policy decides from that
//
// and then, separately:
//
//   presentation        how it should be shown, given where the human is
//
// WHY effectivePriority MUST NOT SEE HUMAN CONTEXT
// Plan 9.2 is explicit: an attention arriving from another project, or the
// decay rules, must NOT lower effectivePriority. Plan 1.2 (D24) is the
// reason -- steering the human is a ROUTING problem, not a PRIORITY
// problem. If a background project's low-priority item were silently
// demoted, the human would never learn it existed, and "the human does not
// have to notice agents" (plan 2.1) would invert into "the human never
// finds out". Human context therefore only ever reaches `presentation`.
//
// Purity: no I/O, no clock, no access to renderer state. The caller passes
// human context in. That keeps the policy testable and makes an accidental
// priority mutation impossible to hide.

export const ATTENTION_PRIORITIES = Object.freeze(['low', 'normal', 'high']);

export const ATTENTION_PRESENTATIONS = Object.freeze([
  'hidden',
  'presence',
  'inbox',
  'highlight',
  'interrupt',
]);

// Presentation ordering, weakest first. Used to pick the strongest
// presentation for a project that holds several open attentions, so the
// sidebar cannot be told "inbox" while a blocking interrupt is pending.
export const PRESENTATION_STRENGTH = Object.freeze({
  hidden: 0,
  presence: 1,
  inbox: 2,
  highlight: 3,
  interrupt: 4,
});

export const RESOLVED_STATES = Object.freeze(['RESOLVED']);

// effectivePriority from the classified kind alone. Plan 9.2:
//
//   blocking=true  -> at least normal (an agent that is waiting)
//   kind=error     -> high
//   kind=completed -> low
//
// Everything else is normal: a question, a block, a review. Those are the
// cases the human opened the Inbox for.
export function effectivePriorityFor(item) {
  if (!item || typeof item !== 'object') return 'normal';
  if (item.kind === 'error') return 'high';
  if (item.kind === 'completed') return 'low';
  if (item.blocking) return 'normal';
  return 'normal';
}

// Plan 9.2: resolved -> nothing is presented at all.
//
// Without this a dismissed item that is still in the projection would keep
// a badge alive. The store already refuses to resurrect a RESOLVED entry,
// so this is the second half of the same rule: store keeps it resolved,
// policy keeps it invisible.
function presentationForState(state) {
  return RESOLVED_STATES.includes(state) ? 'hidden' : null;
}

// Plan 9.3 + plan 2.4 (raw terminal is the bottom layer, not the UI).
//
// The human's location decides the CEILING, importance decides whether the
// item clears the visibility floor:
//
//   interrupt  blocking AND the human is already looking at it. Plan 9.3 says
//              interrupt must stay rare, and plan 2.5 forbids stealing focus,
//              so this is capped at the current pane. Nothing here moves the
//              human.
//   highlight  important AND out of view: sidebar AND Inbox both draw the
//              eye. Two things qualify -- a blocking item the human is not
//              watching (an agent is stuck), and a high-priority item outside
//              the current pane (a failed turn in another project).
//   inbox      open and worth listing.
//   presence   low-priority background noise: a dot, never a list entry. A
//              completed turn lands here, so plan 2.2 ("completed" is an event,
//              promoted only when it matters) does not produce Inbox churn.
//   hidden     resolved.
//
// Why priority cannot pick a presentation by itself: an item can be high
// priority and already on screen, where "highlight" would be pure noise. That
// is why both inputs are required.
export function presentationFor(item, humanContext = {}) {
  const byState = presentationForState(item?.state);
  if (byState) return byState;

  const blocking = Boolean(item?.blocking);
  const priority = item?.effectivePriority || 'normal';
  const inView = Boolean(humanContext.inViewTabIds?.includes(item?.tabId))
    || humanContext.activeTabId === item?.tabId;

  if (blocking && inView) return 'interrupt';
  // A completed turn is history, not a task: visible as a dot so the human can
  // tell "finished" from "never ran", but never listed.
  if (priority === 'low' && !blocking) return 'presence';
  if (blocking || priority === 'high') return 'highlight';
  return 'inbox';
}

// Human context is derived once by the caller and reused for every item.
//
// Fields:
//   inViewTabIds     tabIds whose terminal is visible in some pane
//   activeTabId      the tab the human is focused on
//   activeProjectId  the project the human is working in
//   activePaneId     the pane holding the human's focus
//
// Note there is no `priority` field: see the module header.
export function normalizeHumanContext(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const inViewTabIds = Array.isArray(source.inViewTabIds)
    ? source.inViewTabIds.filter((id) => Number.isInteger(id))
    : [];
  return {
    inViewTabIds,
    activeTabId: Number.isInteger(source.activeTabId) ? source.activeTabId : null,
    activeProjectId: typeof source.activeProjectId === 'string' ? source.activeProjectId : null,
    activePaneId: Number.isInteger(source.activePaneId) ? source.activePaneId : null,
  };
}

// Apply the policy to one mapped item. Returns a new object; the input is
// never mutated, because the mapper's output is shared with tests.
export function applyPolicy(item, humanContext = {}) {
  if (!item || typeof item !== 'object') return null;
  const effectivePriority = effectivePriorityFor(item);
  const withPriority = { ...item, effectivePriority };
  return {
    ...withPriority,
    presentation: presentationFor(withPriority, humanContext),
  };
}

// Apply to a whole list. `effectivePriority` is recomputed from the item
// itself, so a mapper that still sets effectivePriority = requestedPriority
// is corrected here rather than trusted.
export function applyPolicyToAll(items, humanContext = {}) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => applyPolicy(item, humanContext)).filter(Boolean);
}

// Strongest presentation across a set, for a project badge or sidebar row.
// Ties break toward the stronger value so a blocking item is never hidden
// behind a quieter sibling.
export function strongestPresentation(presentations) {
  let best = 'hidden';
  for (const presentation of Array.isArray(presentations) ? presentations : []) {
    if ((PRESENTATION_STRENGTH[presentation] ?? 0) > PRESENTATION_STRENGTH[best]) {
      best = presentation;
    }
  }
  return best;
}

// Convenience: the presentation a project should show given its open items.
export function projectPresentation(items) {
  return strongestPresentation((items || []).map((item) => item.presentation));
}