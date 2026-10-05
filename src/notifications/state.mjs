import { classifyCertainty, mayBlock } from '../attention/provenance.mjs';

export function receiveAgentNotification(attention, {
  tabId,
  projectId,
  kind,
  eventType,
  source,
  reason = null,
  title = null,
  message = null,
  sessionId = null,
  unread,
}) {
  const next = { ...attention };
  const current = attention[tabId];
  const isExplicitUserInput = kind === 'turn_started'
    && String(eventType || '').toLowerCase() === 'userpromptsubmit';

  // Once input is required, keep the amber waiting state until there is
  // direct evidence of a user response. Generic lifecycle updates can arrive
  // late or out of order, so neither working nor completion may clear it.
  // A failure is allowed to replace waiting because it is a higher-priority
  // terminal state and no longer represents an actionable input prompt.
  if (current?.waiting
    && kind !== 'needs_attention'
    && kind !== 'turn_failed'
    && !isExplicitUserInput) {
    return attention;
  }

  if (kind === 'turn_started') {
    delete next[tabId];
    return next;
  }

  const waiting = kind === 'needs_attention';

  if (!waiting && !unread) {
    delete next[tabId];
    return next;
  }

  // A structured lifecycle event from a hook or plugin is explicit. The
  // `asserted` case has no producer here yet; devinBind will be the first,
  // and it arrives through a different path.
  const certainty = classifyCertainty(source, null);

  next[tabId] = {
    projectId,
    waiting,
    // Waiting is actionable state, not a completion item that can be marked
    // read by opening the tab. Keep unread exclusively for non-waiting events.
    unread: waiting ? false : Boolean(unread),
    kind,
    eventType,
    source,
    blockingCertain: mayBlock(certainty),
    certainty,
    reason,
    title,
    message,
    sessionId,
  };
  return next;
}

export function setTerminalWaiting(attention, {
  tabId, projectId, waiting, cause = 'output', certainty = null,
}) {
  const next = { ...attention };
  const current = next[tabId];

  // Output must never erase a waiting state — whether it was set by a
  // structured lifecycle event or by PTY text heuristic. Tab switches
  // trigger terminal resize → TUI redraw → detectWaiting returns false,
  // which would spuriously clear the amber dot. Waiting is only cleared
  // by user input (cause: 'input'), an explicit UserPromptSubmit event,
  // PTY exit (cause: 'exit'), or tab close. Generic working/completion
  // events are not sufficient evidence that the user responded.
  if (!waiting && cause === 'output' && current?.waiting) {
    return attention;
  }

  if (!waiting && !current?.unread) {
    delete next[tabId];
    return next;
  }

  // Recorded, not consumed. Previously `cause` decided the behaviour and was
  // then discarded, so a hook-sourced waiting and a regex-sourced one ended up
  // as the same object and nothing downstream could tell them apart.
  const resolvedCertainty = certainty
    || (current && !waiting ? current.certainty : null)
    || classifyCertainty(current?.source || 'pty', cause);

  next[tabId] = {
    projectId,
    waiting: Boolean(waiting),
    unread: Boolean(current?.unread),
    kind: waiting ? 'needs_attention' : current?.kind || 'turn_completed',
    eventType: current?.eventType || null,
    source: current?.source || 'pty',
    // An inferred prompt may not claim blocking. Blocking means the human's
    // keystroke is the only resolution, and resolveAttention() refuses
    // blocking items -- so a false positive would be undismissable by clicking
    // and would escalate to a modal notification.
    blockingCertain: mayBlock(resolvedCertainty),
    certainty: resolvedCertainty,
    reason: waiting ? 'input' : current?.reason || null,
    title: current?.title || null,
    message: current?.message || null,
    sessionId: current?.sessionId || null,
  };
  return next;
}

export function markAgentNotificationSeen(attention, tabId) {
  const current = attention[tabId];
  if (!current) return attention;

  // Opening an input-waiting tab must not mutate its notification state.
  if (current.waiting) return attention;

  const next = { ...attention };
  delete next[tabId];
  return next;
}

export function clearTerminalAttention(attention, tabId) {
  if (!attention[tabId]) return attention;
  const next = { ...attention };
  delete next[tabId];
  return next;
}

export function summarizeTerminalAttention(attention) {
  const summary = {};
  for (const item of Object.values(attention)) {
    if (!item?.projectId) continue;
    if (!summary[item.projectId]) summary[item.projectId] = { waiting: 0, unread: 0, failed: 0 };
    if (item.waiting) summary[item.projectId].waiting += 1;
    if (item.unread) summary[item.projectId].unread += 1;
    if (item.kind === 'turn_failed') summary[item.projectId].failed += 1;
  }
  return summary;
}
