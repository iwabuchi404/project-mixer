const DEVIN_NEEDS_INPUT = 'Devin needs input';
const DEVIN_FINISHED = 'Devin finished';

export function isDevinCommand(command) {
  const executable = String(command || '')
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    .toLowerCase();
  return executable === 'devin' || executable === 'devin.exe';
}

export function normalizeDevinTerminalNotification(identifier, data) {
  if (identifier !== 9 && identifier !== 777) return null;

  let message = String(data || '').trim();
  if (identifier === 777) {
    const parts = message.split(';');
    if (parts.length < 3 || parts[0].toLowerCase() !== 'notify' || parts[1].toLowerCase() !== 'devin') {
      return null;
    }
    message = parts.slice(2).join(';').trim();
  }

  if (message === DEVIN_NEEDS_INPUT) {
    return {
      kind: 'needs_attention',
      eventType: 'needs_input',
      source: 'devin',
      reason: 'input',
    };
  }
  if (message === DEVIN_FINISHED) {
    return {
      kind: 'turn_completed',
      eventType: 'finished',
      source: 'devin',
      reason: null,
    };
  }
  return null;
}

export function registerDevinTerminalNotifications(
  terminal,
  command,
  onNotification,
  { now = Date.now, dedupeMs = 250 } = {},
) {
  if (!isDevinCommand(command)) return [];

  let previous = null;
  const handle = (identifier, data) => {
    const notification = normalizeDevinTerminalNotification(identifier, data);
    if (!notification) return false;

    const observedAt = now();
    const key = `${notification.kind}:${notification.eventType}`;
    if (!previous || previous.key !== key || observedAt - previous.observedAt > dedupeMs) {
      previous = { key, observedAt };
      onNotification(notification);
    }
    return true;
  };

  return [9, 777].map((identifier) => (
    terminal.parser.registerOscHandler(identifier, (data) => handle(identifier, data))
  ));
}
