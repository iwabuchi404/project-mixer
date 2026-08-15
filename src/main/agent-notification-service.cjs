const path = require('path');

const EVENT_KINDS = new Map([
  ['userpromptsubmit', 'turn_started'],
  ['turnstarted', 'turn_started'],
  ['beforeagent', 'turn_started'],
  ['notification', 'needs_attention'],
  ['permissionrequest', 'needs_attention'],
  ['approval-requested', 'needs_attention'],
  ['stop', 'turn_completed'],
  ['agent-turn-complete', 'turn_completed'],
  ['afteragent', 'turn_completed'],
  ['stopfailure', 'turn_failed'],
]);

const MAX_NOTIFICATION_TITLE_LENGTH = 80;
const MAX_NOTIFICATION_MESSAGE_LENGTH = 240;

function normalizeDisplayText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function getPermissionDetails(data) {
  const toolName = normalizeDisplayText(data.tool_name, 40);
  const toolInput = data.tool_input && typeof data.tool_input === 'object' && !Array.isArray(data.tool_input)
    ? data.tool_input
    : null;
  if (!toolInput) return { title: null, message: null };

  const detail = [
    toolInput.description,
    toolInput.command,
    toolInput.file_path,
    toolInput.path,
    toolInput.query,
    toolInput.url,
  ].find((value) => typeof value === 'string' && value.trim());

  return {
    title: toolName ? `Approval required: ${toolName}` : null,
    message: normalizeDisplayText(detail, MAX_NOTIFICATION_MESSAGE_LENGTH),
  };
}

function normalizeAgentNotification(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const eventType = String(
    data.hook_event_type || data.hook_event_name || data.event || data.type || '',
  ).trim();
  const kind = EVENT_KINDS.get(eventType.toLowerCase());
  if (!kind) return null;

  const source = typeof data.agent_source === 'string'
    ? data.agent_source
    : data.hook_event_type
      ? 'claude'
      : data.hook_event_name || data.event
        ? 'codex'
        : 'agent';
  const explicitPtyId = Number(data.pty_id ?? data.ptyId);
  const permissionDetails = eventType.toLowerCase() === 'permissionrequest'
    ? getPermissionDetails(data)
    : { title: null, message: null };
  const title = normalizeDisplayText(data.title, MAX_NOTIFICATION_TITLE_LENGTH)
    || permissionDetails.title;
  const rawMessage = [
    data.message,
    data['last-assistant-message'],
    data.last_assistant_message,
    data.error,
  ].find((value) => typeof value === 'string' && value.trim());
  const message = normalizeDisplayText(rawMessage, MAX_NOTIFICATION_MESSAGE_LENGTH)
    || permissionDetails.message;

  return {
    eventType,
    kind,
    reason: kind === 'needs_attention'
      ? /permission|approval/i.test(eventType) ? 'approval' : 'input'
      : null,
    title,
    message,
    source,
    cwd: typeof data.cwd === 'string'
      ? data.cwd
      : typeof data.working_directory === 'string'
        ? data.working_directory
        : '',
    ptyId: Number.isInteger(explicitPtyId) && explicitPtyId > 0
      ? explicitPtyId
      : null,
  };
}

function resolveNotificationTarget(notification, ptys) {
  if (notification.ptyId !== null) {
    if (ptys.has(notification.ptyId)) {
      return { ptyId: notification.ptyId, ambiguous: false, unattributed: false };
    }
    return { ptyId: null, ambiguous: false, unattributed: true };
  }

  if (!notification.cwd) {
    return { ptyId: null, ambiguous: false, unattributed: true };
  }

  const normalizedCwd = path.resolve(notification.cwd).toLowerCase();
  const matches = [];
  for (const [id, pty] of ptys) {
    if (path.resolve(pty.cwd).toLowerCase() === normalizedCwd) matches.push(id);
  }

  if (matches.length === 1) {
    return { ptyId: matches[0], ambiguous: false, unattributed: false };
  }
  return {
    ptyId: null,
    ambiguous: matches.length > 1,
    unattributed: true,
  };
}

module.exports = { normalizeAgentNotification, resolveNotificationTarget };
