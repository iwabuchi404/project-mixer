// Live check for step 0d: an inferred (PTY-scraped) waiting must not
// interrupt, while an explicit hook event still must. Runs against a real dev
// instance over CDP, because the false-positive that motivated this cannot be
// reproduced from a fixture -- it needs the real flushPtyOutput path.
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
  const notifications = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (/notify|interrupt|attention/i.test(text)) notifications.push(text.slice(0, 200));
    }
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
  return { ws, call, evaluate, notifications };
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

async function main() {
  const { ws, call, evaluate, notifications } = await connect();
  const created = [];
  try {
    // The renderer loads dist/renderer.bundle.js once at startup. esbuild's
    // watcher rebuilds the file, but a running page keeps the old code, so a
    // check after a source change would silently assert against the previous
    // build. Reload first and wait for the bundle to be back.
    await call('Page.enable');
    await call('Page.reload', { ignoreCache: true });
    await sleep(4000);

    await requireVisiblePage(call, evaluate);

    // The Attention Store is a process-lifetime singleton, so a previous
    // aborted run leaves items behind and every count below would be off by
    // that much. Fail loudly rather than assert against foreign state.
    const stale = await evaluate(`(() => {
      const open = window.__pmAttentionDebug().open;
      if (open.length === 0) return { ok: true };
      // Clear through the public command, not by poking the store.
      for (const item of open) {
        window.__pmDispatch('terminal_clear_attention', { tabId: item.tabId });
      }
      return { ok: true, cleared: open.length };
    })()`, 'reset store');
    assert.equal(stale.ok, true);
    if (stale.cleared) {
      console.log(`note: cleared ${stale.cleared} stale item(s) from a previous run`);
      await sleep(500);
    }
    assert.equal(await evaluate('window.__pmAttentionDebug().open.length'), 0,
      'attention store must be empty before this check runs');

    const boot = await evaluate(`(async () => {
      const project = document.querySelector('.project-item.active') || document.querySelector('.project-item');
      if (!project) return { error: 'no project' };
      project.click();
      await new Promise((r) => setTimeout(r, 600));
      const projectId = project.dataset.projectId;
      const tabId = await window.__pmDispatch('create_terminal', {
        command: 'pwsh.exe', cwd: ${cwd}, projectId, label: 'provenance-check',
      });
      return { projectId, tabId };
    })()`, 'boot');
    assert.equal(boot.error, undefined, JSON.stringify(boot));
    created.push(boot.tabId);
    await sleep(900);

    // --- 1. Explicit hook event: still interrupts.
    await evaluate(`window.__pmDispatch('agent_notification_received', {
      tabId: ${boot.tabId}, projectId: ${JSON.stringify(boot.projectId)},
      kind: 'needs_attention', eventType: 'Notification', source: 'claude',
      reason: 'approval', title: 'Allow this write?', message: 'src/a.ts',
    })`, 'hook event');
    await sleep(400);

    const explicit = await evaluate(`(() => {
      const items = window.__pmAttentionDebug().open;
      const list = [...document.querySelectorAll('#attention-list > *')];
      const groups = list.filter((n) => n.classList.contains('attention-group')).map((g) => g.textContent.trim());
      return {
        count: items.length,
        item: items[0] ? { blocking: items[0].blocking, state: items[0].state, title: items[0].title } : null,
        groups,
      };
    })()`, 'read explicit');
    assert.equal(explicit.count, 1);
    assert.equal(explicit.item.blocking, true, 'an explicit hook event must block');

    // Answer it, the way a human would. This resolves the item, and a resolved
    // item stays resolved on purpose (reconcile refuses to resurrect one), so
    // the second half needs its own tab rather than a reuse of this one.
    await evaluate(`window.__pmDispatch('terminal_set_waiting', {
      tabId: ${boot.tabId}, projectId: ${JSON.stringify(boot.projectId)}, waiting: false, cause: 'input',
    })`, 'clear');
    await sleep(400);
    assert.equal(await evaluate('window.__pmAttentionDebug().open.length'), 0);

    // --- 2. Inferred PTY match: must not block, must not interrupt.
    const second = await evaluate(`(async () => window.__pmDispatch('create_terminal', {
      command: 'pwsh.exe', cwd: ${cwd}, projectId: ${JSON.stringify(boot.projectId)}, label: 'inferred-check',
    }))()`, 'create second', 25000);
    created.push(second);
    await sleep(900);

    // Drive the real production path: cause 'output' is what flushPtyOutput
    // sends when detectWaiting() matches. terminal_set_waiting is a sync
    // handler and returns undefined, so awaiting it throws -- fire and forget.
    await evaluate(`(() => {
      window.__pmDispatch('terminal_set_waiting', {
        tabId: ${second}, projectId: ${JSON.stringify(boot.projectId)}, waiting: true, cause: 'output',
      });
      return true;
    })()`, 'inferred set');
    await sleep(500);

    const observed = await evaluate(`(() => {
      const items = window.__pmAttentionDebug().open;
      return items.length ? { count: items.length, blocking: items[0].blocking, title: items[0].title } : { count: 0 };
    })()`, 'read inferred');
    assert.equal(observed.count, 1, 'the inferred signal must still be surfaced');
    assert.equal(observed.blocking, false,
      'an inferred prompt must not block, or resolveAttention refuses it and the dot is stuck');

    // Presentation: must not be interrupt. Read through the policy by asking
    // the store what it would show given this pane is the focused one.
    const presentation = await evaluate(`(() => {
      const debug = window.__pmAttentionDebug();
      return { inViewTabIds: debug.inViewTabIds, activeTabId: debug.activeTabId };
    })()`, 'in view');
    assert.ok(presentation.inViewTabIds.includes(second),
      'the inferred tab is focused, so an un-gated item would have interrupted here');

    // And it must be clickable away: the whole point of not blocking. Opening the
    // Inbox first is required -- there is no item element to click while the
    // pane is closed.
    await evaluate(`window.__pmDispatch('attention_inbox_open')`, 'open inbox');
    await sleep(500);
    const clicked = await evaluate(`(() => {
      const items = window.__pmAttentionDebug().open;
      if (items.length !== 1) return { ok: false, reason: 'expected 1 item, got ' + items.length };
      const el = document.querySelector('.attention-item');
      if (!el) return { ok: false, reason: 'no item element rendered' };
      el.click();
      return { ok: true, id: items[0].id, blocking: items[0].blocking };
    })()`, 'click');
    assert.equal(clicked.ok, true, clicked.reason || '');
    assert.equal(clicked.blocking, false);
    await sleep(500);
    const after = await evaluate('window.__pmAttentionDebug().open.map((i) => ({ state: i.state, blocking: i.blocking }))');
    assert.equal(after.length, 1, 'clicking acknowledges rather than resolving');
    assert.equal(after[0].state, 'ACKNOWLEDGED');
    assert.equal(after[0].blocking, false);

    if (notifications.length) {
      console.log('console lines mentioning attention:');
      for (const line of notifications.slice(0, 5)) console.log('  ' + line);
    }
    console.log('[attention-provenance-ui-check] explicit blocks and interrupts; inferred does neither and stays clickable');
  } finally {
    for (const tabId of created) {
      await evaluate(`window.__pmDispatch('close_terminal', { tabId: ${tabId} })`).catch(() => {});
    }
    ws.close();
  }
}

main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });