// Devin Lifecycle Hook probe — observation only.
//
// Records schema-level facts about each Devin hook event to a JSONL log,
// WITHOUT recording prompt text, tool_input, tool_response, tokens, or a
// full environment dump. This is the D0 probe instrument described in
// docs/Devin Hooks 通知統合計画.md.
//
// Usage (written into .devin/hooks.v1.json by setup-probe.cjs):
//   node probe-hook.cjs <logPath>
//
// The hook always exits 0 within the Devin hook timeout so it can never
// block the agent. Log writes are synchronous appends; if anything fails
// the hook still exits 0.
//
// Recorded per event:
//   observedAt        ISO timestamp + hrtime milliseconds
//   hook_event_name   event name from stdin
//   session_id        correlation id (UUID, not sensitive)
//   prompt_id         per-turn id (present? + value; absent before first prompt)
//   stop_hook_active  Stop event only (present? + value)
//   tool_name         tool events only (present? + value; tool names are not secrets)
//   fieldSchema       { fieldName: jsType } for every top-level stdin key
//   sensitivePresence { prompt: len|null, tool_input: bool, tool_response: bool,
//                       summary: bool, reason: bool, source: bool }
//   pmPtyId           value of PROJECT_MIXER_PTY_ID env (probe case 6)
//   pmPortFilePresent whether PROJECT_MIXER_PORT_FILE is set
//   devinProjectDir   value of DEVIN_PROJECT_DIR env (project root, not secret)
//   argv              process.argv.slice(2)
//   stdinBytes        raw stdin byte length
//   exitCode          always 0

'use strict';

const fs = require('fs');

const logPath = process.argv[2];
const argvTail = process.argv.slice(3);

function jsType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function record(entry) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (_) {
    // never block Devin on a log failure
  }
}

function main() {
  const start = process.hrtime.bigint();
  // Always record a "called" marker immediately, before reading stdin.
  // This separates "hook was never invoked" from "stdin handling failed".
  record({
    observedAt: new Date().toISOString(),
    phase: 'called',
    pid: process.pid,
    pmPtyId: process.env.PROJECT_MIXER_PTY_ID || null,
    argv: argvTail,
  });
  let raw = '';
  let stdinBytes = 0;
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
    stdinBytes += chunk.length;
  });
  process.stdin.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }

    const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};

    const fieldSchema = {};
    for (const key of Object.keys(data)) {
      fieldSchema[key] = jsType(data[key]);
    }

    const sensitivePresence = {
      prompt: typeof data.prompt === 'string' ? data.prompt.length : null,
      tool_input: data.tool_input !== undefined,
      tool_response: data.tool_response !== undefined,
      summary: data.summary !== undefined,
      reason: data.reason !== undefined,
      source: data.source !== undefined,
    };

    const entry = {
      observedAt: new Date().toISOString(),
      elapsedNs: Number(process.hrtime.bigint() - start),
      hook_event_name: data.hook_event_name || null,
      session_id: data.session_id || null,
      prompt_id: data.prompt_id !== undefined ? data.prompt_id : null,
      prompt_id_present: data.prompt_id !== undefined,
      stop_hook_active: data.stop_hook_active !== undefined ? data.stop_hook_active : null,
      stop_hook_active_present: data.stop_hook_active !== undefined,
      tool_name: data.tool_name !== undefined ? data.tool_name : null,
      tool_name_present: data.tool_name !== undefined,
      fieldSchema,
      sensitivePresence,
      pmPtyId: process.env.PROJECT_MIXER_PTY_ID || null,
      pmPtyId_present: process.env.PROJECT_MIXER_PTY_ID !== undefined,
      pmPortFilePresent: process.env.PROJECT_MIXER_PORT_FILE !== undefined,
      devinProjectDir: process.env.DEVIN_PROJECT_DIR || null,
      devinProjectDir_present: process.env.DEVIN_PROJECT_DIR !== undefined,
      argv: argvTail,
      stdinBytes,
      parseOk: parsed !== null,
      exitCode: 0,
    };

    record(entry);
    process.exit(0);
  });
  // If stdin never emits 'end' (e.g. closed early), still exit cleanly.
  process.stdin.on('error', () => process.exit(0));
  process.stdin.resume();
}

main();
