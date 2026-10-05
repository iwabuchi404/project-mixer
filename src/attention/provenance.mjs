// src/attention/provenance.mjs
// Where a piece of agent state came from, and how much that is worth.
//
// WHY THIS EXISTS
// Measured on the current pipeline: WAITING_PATTERNS matches
// "grpc: allowing unauthenticated access", "Did the build succeed?",
// "message: Proceed? yes" and "PASS test_allow_list" -- four false
// positives out of ten ordinary terminal lines. One match used to become
// { waiting: true, blocking: true }, which resolveAttention() refuses to
// clear and which the policy escalates to a modal OS notification when the
// pane is visible. A log line could interrupt the human and leave an amber
// dot that only a real keystroke removes.
//
// The root cause is not the regex. It is that the pipeline recorded no
// provenance, so a downstream reader could not tell an assertion from an
// observation. setTerminalWaiting() received `cause: 'output'` and dropped
// it; a hook-sourced waiting and a regex-sourced waiting became the same
// object. `confidence: 0.5` existed on the AttentionRequest and was read by
// nothing.
//
// CERTAINTY IS THREE-WAY, NOT TWO
// The obvious model is explicit | inferred. The measured reality needs a
// third value:
//
//   explicit  the agent or its hook/plugin asserted it. Claude hooks,
//             OpenCode plugin, MCP request_attention, PTY exit.
//   asserted  a human typed it. `devinBind` is the only current example:
//             nobody observed that Devin session exists, the human said so.
//             Not machine-asserted, and not inferred from observation either.
//   inferred  derived from a signal that can be wrong. PTY prompt patterns,
//             output-silence heuristics, process-liveness guesses.
//
// An `asserted` value matters because it is the one case where being wrong
// is the human's own choice rather than a system defect, and because a
// future `devin list`-backed lookup lands in the same bucket.
//
// PRECEDENCE
// explicit > asserted > inferred. A reducer must not let an inferred signal
// downgrade an explicit state, and must not let an assertion be silently
// upgraded into evidence. This module only classifies; it does not reduce.

export const CERTAINTIES = Object.freeze(['explicit', 'asserted', 'inferred']);

export const CERTAINTY_STRENGTH = Object.freeze({
  inferred: 1,
  asserted: 2,
  explicit: 3,
});

// Hook and plugin sources report lifecycle events directly. `mcp` is the
// agent calling Project Mixer itself. A process exit is observed fact: the
// child terminated, whatever its exit code means.
const EXPLICIT_SOURCES = new Set([
  'claude',
  'codex',
  'opencode',
  'devin',
  'agent',
  'hook',
  'mcp',
  'exit',
]);

export function classifyCertainty(source, cause = null) {
  if (cause === 'exit') return 'explicit';
  // Only the PTY scraper sets cause 'output'. That is the whole of rung 3.
  if (cause === 'output') return 'inferred';
  if (cause === 'input') return 'explicit';
  if (typeof source === 'string' && EXPLICIT_SOURCES.has(source)) return 'explicit';
  return 'inferred';
}

// Can a signal of this certainty interrupt the human?
//
// Only an explicit one. This is the whole of step 0d: the human is not
// interrupted by a regex. An inferred signal still appears -- it becomes an
// Inbox row and a sidebar dot, because hiding it entirely would make Codex
// and Devin, whose native channels are unavailable (measured: codex notify is
// a single-slot config entry already owned by another tool; devin has no hook
// at all), permanently unobservable.
export function mayInterrupt(certainty) {
  return certainty === 'explicit';
}

// May a signal of this certainty claim `blocking`?
//
// No. Blocking means "the human's keystroke is the only thing that can
// resolve this", and resolveAttention() refuses blocking items outright. An
// inferred prompt that turns out to be a log line would then be
// unresolvable by the human clicking it away -- only typing in the terminal
// would clear it. Blocking stays reserved for explicit lifecycle events.
//
// An `asserted` value may block, because a human who bound a session accepts
// responsibility for the binding.
export function mayBlock(certainty) {
  return certainty === 'explicit' || certainty === 'asserted';
}

// Does `incoming` outrank `current`?
// Used by the reducer so an inferred signal cannot overwrite an explicit
// state of the same kind, and so an explicit signal always wins.
export function outranks(incoming, current) {
  if (!current) return true;
  const a = CERTAINTY_STRENGTH[incoming] || 0;
  const b = CERTAINTY_STRENGTH[current] || 0;
  return a > b;
}