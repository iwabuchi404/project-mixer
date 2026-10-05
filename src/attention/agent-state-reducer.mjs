// src/attention/agent-state-reducer.mjs
// Agent State Reducer: the single place that decides an agent's current state
// from a stream of events, so no single signal can flip it.
//
// WHY A REDUCER AT ALL
// Before this, PTY output went straight to terminalAttention: detectWaiting()
// matched a regex and set waiting=true, and nothing could clear it except a
// real keystroke. Measured false positives were 4 of 10 ordinary terminal
// lines, so a log line could leave an amber dot that only typing would remove.
// Step 0d fixed the consequences (provenance gating); the stale case remained:
// an inferred waiting that is never corroborated stays asserted forever.
//
// THE RULE THAT MATTERS MOST
// Output going quiet NEVER means completed. Silence is indistinguishable from
// "still working", "crashed", "waiting on a network call" or "finished and
// idle". So decay lands on `idle`, never on `completed`. Only an explicit
// lifecycle event can produce `completed`, and if the agent never sent one,
// Project Mixer does not know the task finished -- and says so.
//
// EXPLICIT NEVER DECAYS
// An explicit waiting (a hook's permission request, an MCP request_attention)
// is not a hypothesis, so it has no staleness rule. It is cleared by real user
// input, an explicit completion, or the tab closing. Applying a timeout to it
// would reintroduce the original bug in a subtler form: the amber dot
// disappearing while the agent still waits for an answer.
//
// PURE. No clock, no I/O. `now` is injected so decay is testable without
// timers, which is the only way to test a timeout honestly.

export const AGENT_STATES = Object.freeze([
  'idle',
  'working',
  'waiting',
  'error',
  'offline',
]);

// How long an inferred waiting may stand without corroboration.
//
// Measured against the false positives: /Allow/i matching
// 'grpc: allowing unauthenticated access' happens while output is still
// streaming. A real prompt sits still until the human types. So a signal that
// is contradicted by more output within a few seconds was a stream artefact,
// and a minute of silence is long enough that a genuine prompt is still
// waiting while a stray match has been contradicted many times over.
//
// Deliberately generous. Too short and a real prompt loses its dot before the
// human walks back to the keyboard; too long and the false positive survives.
// The cost of being late is a stale Inbox row the human can dismiss; the cost
// of being early is an agent that waits without being visible.
export const DEFAULT_INFERRED_STALENESS_MS = 60_000;

export const DEFAULT_NOW = () => Date.now();

export function createInitialAgentState(now = DEFAULT_NOW) {
  return {
    state: 'idle',
    certainty: null,
    since: now(),
    waitingSince: null,
    lastEventAt: null,
    lastOutputAt: null,
    // Bounded: an event log that grows with output would be a leak in a
    // long-running session. Only transitions are kept, not every chunk.
    transitions: 0,
  };
}

function sameState(current, next) {
  return current.state === next.state && current.certainty === next.certainty;
}

// Fold one event into the state. Returns a NEW object; the input is never
// mutated, because the caller keeps the previous state for comparison.
export function reduceAgentState(current, event, options = {}) {
  const now = options.now || DEFAULT_NOW;
  const stalenessMs = Number.isInteger(options.inferredStalenessMs)
    ? options.inferredStalenessMs
    : DEFAULT_INFERRED_STALENESS_MS;
  const base = current && typeof current === 'object' ? current : createInitialAgentState(now);
  const at = Number.isFinite(event?.at) ? event.at : now();
  const certainty = event?.certainty ?? base.certainty ?? null;

  const move = (state, extra = {}) => ({
    ...base,
    state,
    certainty,
    since: sameState(base, { state, certainty }) ? base.since : at,
    transitions: sameState(base, { state, certainty }) ? base.transitions : base.transitions + 1,
    waitingSince: state === 'waiting' ? (extra.waitingSince ?? at) : null,
    lastEventAt: at,
    ...extra,
  });

  switch (event?.type) {
    case 'output':
      // Output means the process is alive and producing, which settles what an
      // inferred candidate MEANS without settling the agent: a refuted
      // candidate returns to working, while an explicit request stays waiting
      // because a permission prompt is routinely followed by a spinner frame
      // and a resize alone produces output.
      //
      // lastOutputAt is always recorded: it is the evidence
      // contradictsStaleWaiting() needs, and it must be current even when the
      // state does not move.
      if (base.state === 'waiting' && base.certainty === 'inferred') {
        return move('working', { lastOutputAt: at, waitingSince: null, refutedCandidate: true });
      }
      if (base.state === 'waiting') {
        return { ...base, lastEventAt: at, lastOutputAt: at };
      }
      return move('working', { lastOutputAt: at });

    case 'prompt_detected':
      // The PTY scraper's guess. Recorded as a waiting CANDIDATE that may
      // decay; this is the whole reason certainty is recorded.
      return move('waiting', { waitingSince: at });

    case 'lifecycle': {
      const kind = event.kind;
      // A waiting is never cleared by a lifecycle event that is not itself an
      // answer. src/notifications/state.mjs already encodes this ("once input
      // is required, keep the amber waiting state until there is direct
      // evidence of a user response"); the reducer has to agree or the two
      // layers would disagree about the same agent. A turn_completed arriving
      // during a permission request means the turn ended without an answer, not
      // that the answer was given.
      if (base.state === 'waiting' && kind !== 'needs_attention') {
        return { ...base, lastEventAt: at };
      }
      if (kind === 'needs_attention') {
        // Explicit by construction: only hooks, plugins and MCP reach here.
        return move('waiting', { waitingSince: at });
      }
      if (kind === 'turn_failed') return move('error');
      if (kind === 'turn_completed') {
        // The only path to a settled turn. Note it returns to `idle`, not to
        // `completed`: this reducer tracks the CURRENT state of a session, and
        // a session that finished its last turn is idle, not completed. Task
        // completion is Delegation's concern with a different vocabulary.
        return move('idle');
      }
      if (kind === 'turn_started') return move('working');
      return move(base.state, { lastEventAt: at });
    }

    case 'user_input':
      // The only thing that clears a waiting, explicit or inferred. A
      // keystroke is the human answering, so it is evidence by definition.
      return move('working', { waitingSince: null });

    case 'exit':
      // Exit code is observed fact. Zero means the process ended; it does not
      // mean the work succeeded, so this is `offline` and not `completed`.
      return move('offline', { exitCode: event.exitCode ?? null });

    case 'attention_requested':
      // MCP request_attention. Explicit, and therefore not subject to decay.
      return move('waiting', { waitingSince: at });

    case 'tick':
      return applyStaleness(base, { at, stalenessMs });

    default:
      return { ...base, lastEventAt: at };
  }
}

// Decay an inferred waiting that has been neither corroborated nor answered.
//
// Lands on `idle`, never `completed`: see the header. And never touches an
// explicit waiting, which is not a hypothesis.
export function applyStaleness(current, { at, stalenessMs = DEFAULT_INFERRED_STALENESS_MS } = {}) {
  if (current.state !== 'waiting') return current;
  if (current.certainty !== 'inferred') return current;
  if (!Number.isInteger(current.waitingSince)) return current;
  if (at - current.waitingSince < stalenessMs) return current;
  return {
    ...current,
    state: 'idle',
    certainty: 'inferred',
    since: at,
    waitingSince: null,
    lastEventAt: at,
    transitions: current.transitions + 1,
    decayedFrom: 'waiting',
  };
}

// Would more output have contradicted this candidate?
//
// This is the sharper half of the staleness rule and the one that runs
// constantly. Measured: /Allow/i matching 'grpc: allowing unauthenticated
// access' happens *while output is still streaming*, so any subsequent chunk
// refutes it. A real prompt sits still until the human types, so silence
// supports it rather than refuting it.
//
// Counter-intuitively this means output PROVES an inferred match was wrong,
// and silence does not prove it right. So this only ever clears, never
// confirms, and the time-based rule above is what eventually releases a
// candidate that produced no further output at all.
//
// Explicit waiting is never contradicted by output: a permission prompt may be
// followed by a spinner, and clearing it on that basis would hide a real
// request.
export function contradictsStaleWaiting(current, lastOutputAt, { minGapMs = 0 } = {}) {
  if (current.state !== 'waiting') return false;
  if (current.certainty !== 'inferred') return false;
  if (!Number.isInteger(current.waitingSince)) return false;
  if (!Number.isInteger(lastOutputAt)) return false;
  return lastOutputAt - current.waitingSince >= minGapMs;
}

// A summary safe to persist or display: no transition history.
export function describeAgentState(state) {
  if (!state || !AGENT_STATES.includes(state.state)) return 'idle';
  if (state.state !== 'waiting') return state.state;
  return state.certainty === 'inferred' ? 'waiting?' : 'waiting';
}