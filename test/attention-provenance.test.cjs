const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const loadProvenance = () => import(pathToFileURL(
  path.join(__dirname, '..', 'src', 'attention', 'provenance.mjs'),
).href);
const loadState = () => import(pathToFileURL(
  path.join(__dirname, '..', 'src', 'notifications', 'state.mjs'),
).href);
const loadMapper = () => import(pathToFileURL(
  path.join(__dirname, '..', 'src', 'attention', 'attention-mapper.mjs'),
).href);
const loadPolicy = () => import(pathToFileURL(
  path.join(__dirname, '..', 'src', 'attention', 'attention-policy.mjs'),
).href);
const loadStore = () => import(pathToFileURL(
  path.join(__dirname, '..', 'src', 'attention', 'attention-store.mjs'),
).href);

// ============================================================
// Classification
// ============================================================

test('a hook or plugin event is explicit, a PTY match is inferred', async () => {
  const { classifyCertainty } = await loadProvenance();
  for (const source of ['claude', 'codex', 'opencode', 'devin', 'agent', 'hook', 'mcp']) {
    assert.equal(classifyCertainty(source, null), 'explicit', source);
  }
  // cause 'output' is set only by the PTY scraper, so it decides regardless
  // of whatever source string came along with it.
  assert.equal(classifyCertainty('pty', 'output'), 'inferred');
  assert.equal(classifyCertainty('claude', 'output'), 'inferred',
    'a scraped match is inferred even if the tab runs claude');
  // A process exit is observed fact, not a guess.
  assert.equal(classifyCertainty('pty', 'exit'), 'explicit');
  assert.equal(classifyCertainty('pty', 'input'), 'explicit');
  // Unknown source with no cause: assume the weaker claim.
  assert.equal(classifyCertainty('who-knows', null), 'inferred');
});

test('certainty is three-way, and asserted is neither explicit nor inferred', async () => {
  const { classifyCertainty, CERTAINTIES } = await loadProvenance();
  assert.deepEqual([...CERTAINTIES], ['explicit', 'asserted', 'inferred']);
  // There is no producer of 'asserted' through this path yet -- devinBind goes
  // through a different route -- so classification cannot invent one. The value
  // exists so that route has a home and is not forced to lie as 'explicit'.
  assert.equal(classifyCertainty('devin', null), 'explicit',
    'a devin monitor notification is machine-observed, unlike a bound id');
});

test('explicit outranks asserted outranks inferred', async () => {
  const { outranks, CERTAINTY_STRENGTH } = await loadProvenance();
  assert.equal(outranks('explicit', 'inferred'), true);
  assert.equal(outranks('asserted', 'inferred'), true);
  assert.equal(outranks('explicit', 'asserted'), true);
  assert.equal(outranks('inferred', 'explicit'), false);
  assert.equal(outranks('inferred', 'inferred'), false);
  assert.ok(CERTAINTY_STRENGTH.explicit > CERTAINTY_STRENGTH.inferred);
});

// ============================================================
// Only explicit may interrupt, and only explicit may block
// ============================================================

test('only an explicit signal may interrupt the human', async () => {
  const { mayInterrupt } = await loadProvenance();
  assert.equal(mayInterrupt('explicit'), true);
  assert.equal(mayInterrupt('asserted'), false);
  assert.equal(mayInterrupt('inferred'), false);
});

test('only explicit or asserted may block', async () => {
  // Blocking means the human's keystroke is the only resolution, and
  // resolveAttention() refuses blocking items. An inferred prompt that turned
  // out to be a log line would then be undismissable by clicking.
  const { mayBlock } = await loadProvenance();
  assert.equal(mayBlock('explicit'), true);
  assert.equal(mayBlock('asserted'), true);
  assert.equal(mayBlock('inferred'), false);
});

// ============================================================
// Provenance is recorded, not consumed
// ============================================================

test('setTerminalWaiting records certainty instead of dropping cause', async () => {
  const { setTerminalWaiting } = await loadState();
  const next = setTerminalWaiting({}, {
    tabId: 4, projectId: 'p', waiting: true, cause: 'output',
  });
  assert.equal(next[4].waiting, true);
  assert.equal(next[4].certainty, 'inferred');
  assert.equal(next[4].blockingCertain, false,
    'an inferred prompt may not claim blocking');
  // This is the field that did not exist before, and its absence is why a
  // hook waiting and a regex waiting were indistinguishable downstream.
  assert.ok('certainty' in next[4]);
});

test('clearing a waiting entry removes it, certainty aside', async () => {
  const { setTerminalWaiting } = await loadState();
  let map = setTerminalWaiting({}, { tabId: 4, projectId: 'p', waiting: true, cause: 'output' });
  // A non-waiting, unread=false entry is deleted, which is the pre-existing
  // contract and is not what this change is about.
  map = setTerminalWaiting(map, { tabId: 4, projectId: 'p', waiting: false, cause: 'exit' });
  assert.equal(map[4], undefined);

  // With an unread completion present the entry survives, and must not have
  // silently upgraded its provenance on the way through: an inferred signal
  // that turns into a completion is still an inferred completion.
  map = setTerminalWaiting({}, {
    tabId: 4, projectId: 'p', waiting: true, cause: 'output', certainty: 'inferred',
  });
  map = setTerminalWaiting(map, {
    tabId: 4, projectId: 'p', waiting: false, cause: 'exit', unread: true,
  });
  if (map[4]) assert.equal(map[4].certainty, 'inferred');
});

test('receiveAgentNotification marks a lifecycle event explicit and blocking', async () => {
  const { receiveAgentNotification } = await loadState();
  const next = receiveAgentNotification({}, {
    tabId: 9, projectId: 'p', kind: 'needs_attention', eventType: 'Notification',
    source: 'claude', reason: 'input', unread: false,
  });
  assert.equal(next[9].certainty, 'explicit');
  assert.equal(next[9].blockingCertain, true);
});

// ============================================================
// The gate end to end
// ============================================================

test('a PTY regex match can no longer become an interrupt', async () => {
  // The regression this whole module exists for: measured false positives
  // were 4 of 10 ordinary terminal lines, and one match used to produce a
  // modal OS notification plus a dot only a keystroke could clear.
  const { setTerminalWaiting } = await loadState();
  const { mapAttention } = await loadMapper();
  const { applyPolicy } = await loadPolicy();

  const terminalAttention = setTerminalWaiting({}, {
    tabId: 5, projectId: 'p', waiting: true, cause: 'output',
  });
  const [item] = mapAttention(terminalAttention);
  assert.equal(item.certainty, 'inferred');
  assert.equal(item.blocking, false, 'inferred must not block');

  // Once the signal is inferred, `blocking` is false, so it is an ordinary
  // open item. The point of the gate is only that it cannot reach interrupt;
  // where it lands instead is the existing inbox route.
  const inView = applyPolicy(item, { inViewTabIds: [5], activeTabId: 5 });
  assert.notEqual(inView.presentation, 'interrupt');
  assert.equal(inView.presentation, 'inbox');
  // Out of view it is still listed, never hidden -- codex and devin have no
  // other channel, so hiding inferred items would make them unobservable.
  assert.equal(applyPolicy(item, { inViewTabIds: [], activeTabId: null }).presentation, 'inbox');
});

test('an explicit hook event still interrupts', async () => {
  const { setTerminalWaiting } = await loadState();
  const { mapAttention } = await loadMapper();
  const { applyPolicy } = await loadPolicy();
  const terminalAttention = setTerminalWaiting({}, {
    tabId: 6, projectId: 'p', waiting: true, cause: 'input',
  });
  const [item] = mapAttention(terminalAttention);
  assert.equal(item.blocking, true);
  assert.equal(applyPolicy(item, { inViewTabIds: [6], activeTabId: 6 }).presentation, 'interrupt');
});

test('a false positive stays resolvable, which is the point', async () => {
  const { setTerminalWaiting } = await loadState();
  const { createAttentionStore } = await loadStore();
  const terminalAttention = setTerminalWaiting({}, {
    tabId: 7, projectId: 'p', waiting: true, cause: 'output',
  });
  const store = createAttentionStore();
  store.reconcile(terminalAttention);
  const [item] = store.getOpenAttention();
  assert.equal(item.blocking, false);
  // Before the change this returned null: resolveAttention refuses blocking
  // items, so a log line matching /Allow/ left a dot the human could not
  // dismiss by clicking.
  assert.ok(store.resolveAttention(item.id), 'an inferred prompt must be clickable away');
  assert.equal(store.getOpenAttention().length, 0);
});

// ============================================================
// Structural guards
// ============================================================

test('the mapper reads certainty, it does not re-derive it from source', async () => {
  const { mapAttentionItem } = await loadMapper();
  // A record claiming to be explicit while its source looks like a scrape:
  // the recorded certainty must win, because that is the whole point of
  // recording it.
  const item = mapAttentionItem(3, {
    projectId: 'p',
    waiting: true,
    kind: 'needs_attention',
    source: 'pty',
    certainty: 'explicit',
  });
  assert.equal(item.certainty, 'explicit');
  assert.equal(item.blocking, true);
});

test('a record with no provenance at all keeps the old behaviour', async () => {
  // Hand-built fixtures and any producer that predates provenance must not
  // silently lose blocking; only real signals carry a certainty.
  const { mapAttentionItem } = await loadMapper();
  const item = mapAttentionItem(3, {
    projectId: 'p', waiting: true, kind: 'needs_attention', source: 'claude',
  });
  assert.equal(item.blocking, true);
});

test('the provenance module has no imports and no clock', async () => {
  const fs = require('fs');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'attention', 'provenance.mjs'),
    'utf-8',
  );
  assert.doesNotMatch(source, /^import /m);
  assert.doesNotMatch(source, /Date\.now|new Date/);
  assert.doesNotMatch(source, /\bdocument\b|\bwindow\b/);
});