// src/main/hooks/hook-bridge-source.cjs
// Source of the unified Project Mixer hook bridge (Devin Hooks 通知統合計画 §7).
//
// buildHookBridgeScript() returns a self-contained CommonJS script that is
// written to a stable integration directory and referenced from user-level
// agent hook configs (installation itself is D4's Setup UX).
//
// Contract:
// - Reads one JSON payload from stdin (arg form kept for the legacy Claude/
//   Codex usage: `node project-mixer-hook.cjs Stop`).
// - ALLOWLIST ONLY: prompt text, tool_input bodies, tool responses and
//   environment dumps never reach Project Mixer.
// - Reads routing/token from the PM-spawned environment (PM_HOOK_URL,
//   PM_HOOK_TOKEN, PROJECT_MIXER_PTY_ID). No PM environment → silent exit:
//   only agents started inside PM notify (計画 §8).
// - Every failure mode exits 0 within the bounded timeout. A broken bridge
//   must never block the agent (計画 §15).
// - stdin over 64 KiB is dropped (payload cannot be trusted wholesale).

function buildHookBridgeScript() {
  return `#!/usr/bin/env node
// Project Mixer unified hook bridge (devin/claude/codex).
// Allowlist-only forwarding to the local hook receiver. Always exit 0.
const http = require('http');

const MAX_STDIN_BYTES = 64 * 1024;
const HTTP_TIMEOUT_MS = 800;

const LEGACY_FIELDS = [
  'hook_event_type', 'hook_event_name', 'event', 'type',
  'title', 'message', 'last-assistant-message', 'last_assistant_message',
  'error', 'session_id', 'tool_name', 'tool_input', 'agent_source',
];

function identityString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function detectProvider(namedEvent, input) {
  const argProvider = readProviderArg();
  if (argProvider) return argProvider;
  const envProvider = identityString(process.env.PROJECT_MIXER_HOOK_PROVIDER);
  if (envProvider) return envProvider.toLowerCase();
  const inputProvider = identityString(input.provider);
  if (inputProvider) return inputProvider.toLowerCase();
  if (identityString(input.eventType)) return 'devin';
  if (identityString(input.hook_event_type)) return 'claude';
  if (identityString(input.hook_event_name) || identityString(input.event)) return 'codex';
  return namedEvent ? 'claude' : 'codex';
}

function readProviderArg() {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--provider');
  if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith('{')) {
    return argv[index + 1].toLowerCase();
  }
  const prefixed = argv.find((a) => a.startsWith('--provider='));
  return prefixed ? prefixed.slice('--provider='.length).toLowerCase() : null;
}

function buildPayload(namedEvent, input) {
  const provider = detectProvider(namedEvent, input);
  const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : process.cwd();
  const ptyId = Number(process.env.PROJECT_MIXER_PTY_ID) || undefined;
  if (provider === 'devin') {
    const eventType = identityString(input.eventType) || identityString(namedEvent);
    if (!eventType) return null;
    return {
      provider: 'devin',
      eventType,
      sessionId: identityString(input.sessionId) || identityString(input.session_id),
      promptId: identityString(input.promptId) || identityString(input.prompt_id),
      stopHookActive: input.stopHookActive === true,
      cwd,
      pty_id: ptyId,
    };
  }
  const payload = { cwd, pty_id: ptyId };
  for (const field of LEGACY_FIELDS) {
    if (input[field] !== undefined) payload[field] = input[field];
  }
  if (identityString(input.provider)) payload.provider = input.provider;
  if (!payload.hook_event_type && !payload.hook_event_name && !payload.event && !payload.type) {
    payload.hook_event_type = namedEvent || 'Notification';
  }
  if (!payload.agent_source) payload.agent_source = provider;
  return payload;
}

function send(payload) {
  const hookUrl = identityString(process.env.PM_HOOK_URL);
  const hookToken = identityString(process.env.PM_HOOK_TOKEN);
  if (!hookUrl || !hookToken) process.exit(0);
  let target;
  try { target = new URL(hookUrl); } catch (e) { process.exit(0); }
  const body = JSON.stringify(payload);
  const req = http.request({
    hostname: target.hostname,
    port: target.port,
    path: target.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Project-Mixer-Hook': hookToken,
    },
  }, () => { process.exit(0); });
  req.setTimeout(HTTP_TIMEOUT_MS, () => { req.destroy(); process.exit(0); });
  req.on('error', () => { process.exit(0); });
  req.write(body);
  req.end();
}

function main() {
  const argv = process.argv.slice(2);
  const namedEvent = argv.find((a) => a && !a.startsWith('--') && !a.startsWith('{')) || '';
  let argPayload = null;
  const jsonArg = argv.find((a) => a && a.startsWith('{'));
  if (jsonArg) {
    try { argPayload = JSON.parse(jsonArg); } catch (e) { argPayload = null; }
  }
  const finish = (input) => {
    let payload = null;
    try { payload = buildPayload(namedEvent, input || {}); } catch (e) { payload = null; }
    if (!payload) process.exit(0);
    send(payload);
  };
  if (argPayload) { finish(argPayload); return; }
  let stdin = '';
  let overflow = false;
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    if (overflow) return;
    if (stdin.length + chunk.length > MAX_STDIN_BYTES) { overflow = true; return; }
    stdin += chunk;
  });
  process.stdin.on('end', () => {
    if (overflow) process.exit(0);
    let input = {};
    if (stdin.trim()) {
      try { input = JSON.parse(stdin); } catch (e) { input = {}; }
    }
    finish(input);
  });
  process.stdin.resume();
}

main();
`;
}

module.exports = { buildHookBridgeScript };
