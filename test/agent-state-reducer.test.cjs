const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(
  path.join(__dirname, '..', 'src', 'attention', 'agent-state-reducer.mjs'),
).href);

const T0 = 1_000_000;

// ============================================================
// The rule that must never be broken
// ============================================================

test('output going quiet NEVER produces completed', async () => {
  // The one absolute in this module. Silence is indistinguishable from still
  // working, crashed, blocked on a network call, or finished. Only an explicit
  // lifecycle event may settle a turn, and if none arrives, Project Mixer does
  // not know the task finished.
  const { reduceAgentState, createInitialAgentState, applyStaleness } = await load();
  let state = createInitialAgentState(() => T0);
  state = reduceAgentState(state, { type: 'prompt_detected', certainty: 'inferred', at: T0 }, { now: () => T0 });
  assert.equal(state.state, 'waiting');

  // An hour of nothing at all.
  for (let i = 1; i <= 12; i += 1) {
    state = applyStaleness(state, { at: T0 + i * 300_000, stalenessMs: 60_000 });
  }
  assert.equal(state.state, 'idle');
  assert.notEqual(state.state, 'completed');

  // Ticks with no event at all.
  state = reduceAgentState(state, { type: 'tick', at: T0 + 10_000_000 }, { now: () => T0 });
  assert.notEqual(state.state, 'completed');

  // And the vocabulary has no 'completed' member to reach for.
  const { AGENT_STATES } = await load();
  assert.ok(!AGENT_STATES.includes('completed'));
});

test('exit is offline, not completed, whatever the code', async () => {
  const { reduceAgentState, createInitialAgentState } = await load();
  let state = createInitialAgentState(() => T0);
  state = reduceAgentState(state, { type: 'lifecycle', kind: 'turn_completed', certainty: 'explicit', at: T0 }, { now: () => T0 });
  state = reduceAgentState(state, { type: 'exit', exitCode: 0, at: T0 + 10 }, { now: () => T0 });
  // A zero exit means the process ended, not that the work succeeded.
  assert.equal(state.state, 'offline');
  assert.equal(state.exitCode, 0);
  state = reduceAgentState(state, { type: 'exit', exitCode: 2, at: T0 + 20 }, { now: () => T0 });
  assert.equal(state.state, 'offline');
});

// ============================================================
// Explicit never decays
// ============================================================

test('an explicit waiting has no staleness rule', async () => {
  // Applying a timeout to a real permission request would reintroduce the
  // original bug in a subtler form: the dot vanishing while the agent still
  // waits for an answer.
  const { reduceAgentState, createInitialAgentState, applyStaleness, contradictsStaleWaiting } = await load();
  let state = createInitialAgentState(() => T0);
  state = reduceAgentState(state, { type: 'lifecycle', kind: 'needs_attention', certainty: 'explicit', at: T0 }, { now: () => T0 });
  assert.equal(state.state, 'waiting');
  assert.equal(state.certainty, 'explicit');

  for (const at of [T0 + 60_000, T0 + 600_000, T0 + 10_000_000]) {
    state = applyStaleness(state, { at, stalenessMs: 60_000 });
    assert.equal(state.state, 'waiting', `must survive until ${at - T0}ms`);
  }
  // Output does not refute it either: a prompt is often followed by a spinner.
  for (const at of [T0 + 100, T0 + 5_000, T0 + 900_000]) {
    assert.equal(contradictsStaleWaiting(state, at), false, `output at +${at - T0}`);
  }
});

test('MCP request_attention is explicit and therefore sticky', async () => {
  const { reduceAgentState, createInitialAgentState, applyStaleness } = await load();
  let state = createInitialAgentState(() => T0);
  state = reduceAgentState(state, { type: 'attention_requested', certainty: 'explicit', at: T0 }, { now: () => T0 });
  assert.equal(state.state, 'waiting');
  state = applyStaleness(state, { at: T0 + 10_000_000, stalenessMs: 60_000 });
  assert.equal(state.state, 'waiting');
});

// ============================================================
// Inferred candidates decay, and output is the evidence
// ============================================================

test('an inferred candidate decays to idle after the staleness window', async () => {
  const { reduceAgentState, createInitialAgentState, applyStaleness } = await load();
  let state = createInitialAgentState(() => T0);
  state = reduceAgentState(state, { type: 'prompt_detected', certainty: 'inferred', at: T0 }, { now: () => T0 });

  state = applyStaleness(state, { at: T0 + 59_999, stalenessMs: 60_000 });
  assert.equal(state.state, 'waiting', 'must not decay one millisecond early');

  state = applyStaleness(state, { at: T0 + 60_000, stalenessMs: 60_000 });
  assert.equal(state.state, 'idle');
  assert.equal(state.waitingSince, null);
  assert.equal(state.decayedFrom, 'waiting');
});

test('output refutes an inferred candidate, and silence does not confirm it', async () => {
  // Counter-intuitive but measured: /Allow/i matching
  // 'grpc: allowing unauthenticated access' happens WHILE output streams, so a
  // following chunk refutes it. A real prompt sits still, so silence supports
  // it. Therefore output only ever clears, never confirms.
  const { createInitialAgentState, contradictsStaleWaiting } = await load();
  let state = createInitialAgentState(() => T0);
  state = { ...state, state: 'waiting', certainty: 'inferred', waitingSince: T0 };

  assert.equal(contradictsStaleWaiting(state, T0 + 5), true, 'a chunk right after refutes it');
  assert.equal(contradictsStaleWaiting(state, T0 + 10_000), true);
  // No output at all: nothing to refute it with.
  assert.equal(contradictsStaleWaiting(state, undefined), false);
  assert.equal(contradictsStaleWaiting(state, null), false);
  // An output at or before the match is not a contradiction.
  assert.equal(contradictsStaleWaiting(state, T0 - 1), false);
  // Explicit is never contradicted by output.
  assert.equal(contradictsStaleWaiting({ ...state, certainty: 'explicit' }, T0 + 5), false);
  // Not waiting: nothing to contradict.
  assert.equal(contradictsStaleWaiting({ ...state, state: 'working' }, T0 + 5), false);
});

test('minGapMs lets a same-instant chunk be ignored', async () => {
  const { contradictsStaleWaiting } = await load();
  const state = { state: 'waiting', certainty: 'inferred', waitingSince: T0 };
  assert.equal(contradictsStaleWaiting(state, T0 + 5, { minGapMs: 50 }), false);
  assert.equal(contradictsStaleWaiting(state, T0 + 60, { minGapMs: 50 }), true);
});

// ============================================================
// Only input clears a waiting
// ============================================================

test('user input is the only thing that clears an explicit waiting', async () => {
  const { reduceAgentState, createInitialAgentState } = await load();
  let state = createInitialAgentState(() => T0);
  state = reduceAgentState(state, { type: 'lifecycle', kind: 'needs_attention', certainty: 'explicit', at: T0 }, { now: () => T0 });
  state = reduceAgentState(state, { type: 'lifecycle', kind: 'turn_completed', certainty: 'explicit', at: T0 + 5 }, { now: () => T0 });
  assert.equal(state.state, 'waiting', 'a completion does not answer a permission request');
  state = reduceAgentState(state, { type: 'user_input', at: T0 + 10 }, { now: () => T0 });
  assert.equal(state.state, 'working');
  assert.equal(state.waitingSince, null);
});

test('a completed turn returns to idle, and a new prompt waits again', async () => {
  const { reduceAgentState, createInitialAgentState } = await load();
  let state = createInitialAgentState(() => T0);
  state = reduceAgentState(state, { type: 'lifecycle', kind: 'turn_started', at: T0 }, { now: () => T0 });
  assert.equal(state.state, 'working');
  state = reduceAgentState(state, { type: 'lifecycle', kind: 'turn_completed', at: T0 + 100 }, { now: () => T0 });
  assert.equal(state.state, 'idle');
  state = reduceAgentState(state, { type: 'prompt_detected', certainty: 'inferred', at: T0 + 200 }, { now: () => T0 });
  assert.equal(state.state, 'waiting');
  assert.equal(state.waitingSince, T0 + 200, 'a new candidate gets a fresh timestamp');
});

test('a failure is error and stays until something else happens', async () => {
  const { reduceAgentState, createInitialAgentState, applyStaleness } = await load();
  let state = createInitialAgentState(() => T0);
  state = reduceAgentState(state, { type: 'lifecycle', kind: 'turn_failed', at: T0 }, { now: () => T0 });
  assert.equal(state.state, 'error');
  state = applyStaleness(state, { at: T0 + 10_000_000 });
  assert.equal(state.state, 'error', 'staleness only applies to a waiting hypothesis');
});

// ============================================================
// Timestamps, purity, bookkeeping
// ============================================================

test('`since` only moves on a real change', async () => {
  const { reduceAgentState, createInitialAgentState } = await load();
  // An explicit waiting, so output does NOT refute it. Repeated output while a
  // spinner runs must not reset the clock, or staleness would never arrive.
  let state = createInitialAgentState(() => T0);
  state = reduceAgentState(state, { type: 'lifecycle', kind: 'needs_attention', certainty: 'explicit', at: T0 }, { now: () => T0 });
  const firstSince = state.since;
  for (let i = 1; i <= 5; i += 1) {
    state = reduceAgentState(state, { type: 'output', at: T0 + i * 100 }, { now: () => T0 });
    assert.equal(state.state, 'waiting', `output ${i} must not clear an explicit waiting`);
    assert.equal(state.since, firstSince, `output ${i} must not move since`);
  }
  state = reduceAgentState(state, { type: 'user_input', at: T0 + 1_000 }, { now: () => T0 });
  assert.equal(state.state, 'working');
  assert.equal(state.since, T0 + 1_000, 'a real transition moves it');
});

test('output refutes an inferred candidate in one step', async () => {
  const { reduceAgentState, createInitialAgentState } = await load();
  let state = createInitialAgentState(() => T0);
  state = reduceAgentState(state, { type: 'prompt_detected', certainty: 'inferred', at: T0 }, { now: () => T0 });
  state = reduceAgentState(state, { type: 'output', at: T0 + 50 }, { now: () => T0 });
  // The sharp half of the staleness rule: a matching line inside a stream is
  // refuted by the next chunk, without waiting for any timeout.
  assert.equal(state.state, 'working');
  assert.equal(state.waitingSince, null);
  assert.equal(state.refutedCandidate, true);
});

test('the transition counter is bounded bookkeeping, not a log', async () => {
  const { reduceAgentState, createInitialAgentState } = await load();
  let state = createInitialAgentState(() => T0);
  // Thousands of chunks must not accumulate anything unbounded.
  for (let i = 0; i < 5_000; i += 1) {
    state = reduceAgentState(state, { type: 'output', at: T0 + i }, { now: () => T0 });
  }
  assert.equal(state.transitions, 1, 'repeated output is not a transition');
  assert.ok(Object.keys(state).length < 15, `state shape is fixed, got ${Object.keys(state).length} keys`);
});

test('the reducer is pure and never mutates its input', async () => {
  const { reduceAgentState, createInitialAgentState, applyStaleness } = await load();
  const state = Object.freeze({ ...createInitialAgentState(() => T0), state: 'waiting', certainty: 'inferred', waitingSince: T0 });
  assert.doesNotThrow(() => reduceAgentState(state, { type: 'output', at: T0 + 1 }, { now: () => T0 }));
  assert.doesNotThrow(() => applyStaleness(state, { at: T0 + 999_999 }));
  assert.equal(state.since, T0, 'the input object is untouched');
  // Unknown events and junk input degrade rather than throw.
  assert.doesNotThrow(() => reduceAgentState(state, { type: 'nonsense' }));
  assert.doesNotThrow(() => reduceAgentState(undefined, {}));
  assert.doesNotThrow(() => reduceAgentState(state, null));
});

test('describeAgentState marks an inferred waiting as a question', async () => {
  const { describeAgentState } = await load();
  assert.equal(describeAgentState({ state: 'waiting', certainty: 'explicit' }), 'waiting');
  assert.equal(describeAgentState({ state: 'waiting', certainty: 'inferred' }), 'waiting?');
  assert.equal(describeAgentState({ state: 'working' }), 'working');
  assert.equal(describeAgentState(null), 'idle');
  assert.equal(describeAgentState({ state: 'nonsense' }), 'idle');
});

test('the reducer has no imports, no clock and no storage', () => {
  // Structural guard: `now` is injected, so a hidden Date.now() would make
  // the staleness rule untestable and therefore untrustworthy.
  const fs = require('fs');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'attention', 'agent-state-reducer.mjs'),
    'utf-8',
  );
  assert.doesNotMatch(source, /^import /m);
  // Date.now appears only inside the DEFAULT_NOW definition, which callers may
  // replace; assert it is that and nothing else.
  const uses = [...source.matchAll(/Date\.now\(\)/g)];
  assert.equal(uses.length, 1, 'Date.now may appear only as the replaceable default');
  assert.match(source, /export const DEFAULT_NOW = \(\) => Date\.now\(\)/);
  assert.doesNotMatch(source, /localStorage|\bdocument\b|\bwindow\b/);
});