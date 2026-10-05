// Live check for the Agent State Reducer wiring (step 0b).
//
// The reducer's own rules are unit tested. What this verifies is the part a
// unit test cannot: that the renderer's flushPtyOutput path actually refutes an
// inferred candidate, and that an explicit waiting survives the same traffic.
'use strict';

const assert = require('node:assert/strict');

const port = Number(process.argv[2] || 9235);
const cwd = JSON.stringify(process.cwd());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = targets.find((t) => t.url.endsWith('index.html'));
  assert.ok(page, 'page target not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const op = pending.get(m.id);
    if (!op) return;
    pending.delete(m.id);
    if (m.error) op.reject(new Error(m.error.message));
    else op.resolve(m.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expr, label = 'eval', ms = 20000) => {
    const r = await Promise.race([
      call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${ms}ms: ${label}`)), ms)),
    ]);
    if (r.exceptionDetails) throw new Error(`${label}: ${r.exceptionDetails.text || 'threw'}`);
    return r.result.value;
  };
  return { ws, call, evaluate };
}

async function requireVisiblePage(call, evaluate) {
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await evaluate(`(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    return true;
  })()`, 'patch visibility');
  const raf = await evaluate(
    'new Promise((r) => { const t = setTimeout(() => r("no"), 4000); requestAnimationFrame(() => { clearTimeout(t); r("yes"); }); })',
    'requestAnimationFrame',
  );
  assert.equal(raf, 'yes', 'rAF must fire or create_terminal never settles');
}

const readStore = 'window.__pmAttentionDebug().open.map((i) => ({ id: i.id, blocking: i.blocking, state: i.state, title: i.title }))';

async function main() {
  const { ws, call, evaluate } = await connect();
  const created = [];
  try {
    await call('Page.enable');
    await call('Page.reload', { ignoreCache: true });
    await sleep(4000);
    await requireVisiblePage(call, evaluate);

    const boot = await evaluate(`(async () => {
      const project = document.querySelector('.project-item.active') || document.querySelector('.project-item');
      if (!project) return { error: 'no project' };
      project.click();
      await new Promise((r) => setTimeout(r, 600));
      const tabId = await window.__pmDispatch('create_terminal', {
        command: 'codex', cwd: ${cwd}, projectId: project.dataset.projectId, label: 'reducer-check',
      });
      return { projectId: project.dataset.projectId, tabId };
    })()`, 'boot', 30000);
    assert.equal(boot.error, undefined, JSON.stringify(boot));
    created.push(boot.tabId);
    // codex because detectWaiting() only scrapes claude and codex.
    await sleep(1200);

    // The reducer exposes its per-tab state through the same debug seam.
    const hasReducerState = await evaluate(`typeof window.__pmAgentState === 'function'`);
    assert.equal(hasReducerState, true, 'renderer must expose agent state for inspection');

    // --- 1. An explicit hook waiting survives simulated PTY traffic.
    await evaluate(`window.__pmDispatch('agent_notification_received', {
      tabId: ${boot.tabId}, projectId: ${JSON.stringify(boot.projectId)},
      kind: 'needs_attention', eventType: 'Notification', source: 'claude',
      reason: 'approval', title: 'Real permission request', message: 'Allow?',
    })`, 'hook event');
    await sleep(400);
    const explicit = await evaluate(readStore);
    assert.equal(explicit.length, 1);
    assert.equal(explicit[0].blocking, true, 'an explicit request must block');

    // A matching line, then another chunk: the refutation rule must not touch
    // an explicit waiting.
    // detectWaiting() reads the LAST line of a chunk and returns false when that
    // line is empty, so these strings deliberately end without a newline --
    // which is what a real prompt on a PTY looks like.
    await evaluate(`window.__pmFlushPtyForTest(${boot.tabId}, 'Do you want to proceed?')`, 'scrape 1');
    await sleep(300);
    await evaluate(`window.__pmFlushPtyForTest(${boot.tabId}, 'still streaming output')`, 'scrape 2');
    await sleep(500);

    const afterTraffic = await evaluate(readStore);
    assert.equal(afterTraffic.length, 1, 'an explicit waiting must survive PTY traffic');
    assert.equal(afterTraffic[0].blocking, true);
    assert.equal(afterTraffic[0].state === 'OPEN' || afterTraffic[0].state === 'ACKNOWLEDGED', true);

    // --- 2. An inferred candidate IS refuted by the next chunk.
    // A second tab so the first's resolved state is not in the way.
    const second = await evaluate(`(async () => window.__pmDispatch('create_terminal', {
      command: 'codex', cwd: ${cwd}, projectId: ${JSON.stringify(boot.projectId)}, label: 'refute-check',
    }))()`, 'create second', 30000);
    created.push(second);
    await sleep(1000);

    // Drive the real scraper with a line that matches /Do you want/i.
    await evaluate(`window.__pmFlushPtyForTest(${second}, 'Do you want to continue?')`, 'infer match');
    await sleep(600);
    const inferred = await evaluate(readStore);
    const candidate = inferred.find((i) => i.title === 'Waiting for input');
    assert.ok(candidate,
      `an inferred candidate should be listed, saw ${JSON.stringify(inferred)}`);
    assert.equal(candidate.blocking, false, 'an inferred candidate must not block');

    // Now more output: the candidate was a stream artefact, so it goes.
    await evaluate(`window.__pmFlushPtyForTest(${second}, 'more log lines follow')`, 'infer refute');
    await sleep(700);
    const afterRefute = await evaluate(readStore);
    assert.equal(
      afterRefute.filter((i) => i.title === 'Waiting for input').length,
      0,
      `the refuted candidate should be gone, still present: ${JSON.stringify(afterRefute)}`,
    );
    // And the explicit one from tab 1 is untouched by all of this.
    assert.ok(afterRefute.some((i) => i.title === 'Real permission request'),
      `the explicit request must survive, saw ${JSON.stringify(afterRefute)}`);

    console.log('[agent-state-reducer-ui-check] explicit survives PTY traffic; an inferred candidate is refuted by the next chunk');
  } finally {
    for (const tabId of created) {
      await evaluate(`window.__pmDispatch('close_terminal', { tabId: ${tabId} })`).catch(() => {});
    }
    ws.close();
  }
}

main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });