// Attach to a running Electron dev instance and verify the Attention
// Inbox, including the multi-pane IN VIEW / OUT OF VIEW split.
//
// This is the live check for the pane-enumeration class of bug that
// test/attention-surface-wiring.test.cjs guards statically: adding a new
// surface kind without adding it to every list that enumerates surfaces
// renders nothing. Three such omissions were found during implementation
// (placeSurfaces x2, renderPanes rescue, layoutNonTerminalTabs) and none
// of them were visible from a unit test.
//
// Uses window.__pmDispatch (commands) and window.__pmAttentionDebug (store
// read-back), the same seam the other *-ui-check.cjs scripts use.
//
// Usage: node test/attention-inbox-ui-check.cjs <debug-port>
'use strict';

const assert = require('node:assert/strict');

const debugPort = Number(process.argv[2] || process.env.PM_REMOTE_DEBUGGING_PORT || 9242);
const port = debugPort;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const target = targets.find((item) => item.type === 'page' && item.url.endsWith('/index.html'));
  assert.ok(target, `Project Mixer page was not found on port ${debugPort}`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    if (message.error) operation.reject(new Error(message.error.message));
    else operation.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, label = 'evaluate', timeoutMs = 25000) => {
    const result = await Promise.race([
      call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT ${timeoutMs}ms: ${label}`)), timeoutMs)),
    ]);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed');
    return result.result.value;
  };
  return { socket, evaluate, call };
}

// createTerminal awaits requestAnimationFrame before terminal.open():
//   await new Promise((resolve) => requestAnimationFrame(resolve));
// Chromium throttles rAF to zero in a hidden or occluded window, so when
// this check drives a window that is not on screen, create_terminal never
// settles and no tab is ever added -- indistinguishable from a wiring bug.
// Every CDP-driven create in this file deadlocks without this, so make the
// page believe it is visible and focused before driving the UI.
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
  assert.equal(raf, 'yes',
    'requestAnimationFrame must fire, otherwise create_terminal can never settle in this harness');
}

// What the human actually sees. Selectors mirror renderer.js exactly:
// the group header carries its label as textContent, and a blocking item
// is marked with .attention-blocking (not .blocking).
const readInbox = `(() => {
  const pane = document.querySelector('#attention-pane');
  const groups = [...document.querySelectorAll('#attention-list > .attention-group')].map((g) => ({
    label: g.textContent.trim(),
    items: [...g.nextElementSibling?.classList?.contains('attention-item')
      ? [g.nextElementSibling] : []].map(() => null),
  }));
  // Walk children directly: groups and items are siblings in order.
  const nodes = [...document.querySelectorAll('#attention-list > *')];
  const rebuilt = [];
  for (const node of nodes) {
    if (node.classList.contains('attention-group')) {
      rebuilt.push({ label: node.textContent.trim(), items: [] });
    } else if (node.classList.contains('attention-item') && rebuilt.length) {
      rebuilt[rebuilt.length - 1].items.push({
        title: node.querySelector('.attention-item-title')?.textContent?.trim() || '',
        summary: node.querySelector('.attention-item-summary')?.textContent?.trim() || '',
        blocking: node.classList.contains('attention-blocking'),
        acknowledged: node.classList.contains('attention-acknowledged'),
        id: node.dataset.attentionId || '',
      });
    }
  }
  return {
    paneExists: Boolean(pane),
    paneHidden: pane?.classList.contains('hidden') ?? null,
    // The pane must be hosted inside a pane body. An unhosted pane is
    // exactly what renderPanes' rescue list exists to prevent.
    hostedInPaneBody: Boolean(pane?.closest('.terminal-pane-body')),
    count: document.querySelector('#attention-count')?.textContent?.trim() || '',
    emptyState: document.querySelector('#attention-list .attention-empty')?.textContent?.trim() || '',
    groups: rebuilt,
    inViewTabIds: window.__pmAttentionDebug().inViewTabIds,
  };
})()`;

// setTabSelected marks the active tab with .active, not .selected
// (renderer.js:298). Getting this wrong made the check read a null active
// tab and fail for a reason that had nothing to do with attention.
const readPanes = `(() => [...document.querySelectorAll('.terminal-pane-item')].map((p) => ({
  paneId: p.dataset.paneId,
  tabIds: [...p.querySelectorAll('.main-tab')].map((t) => t.dataset.id),
  hostsSurface: Boolean(p.querySelector('.main-surface-pane:not(.hidden)')),
  activeTabId: p.querySelector('.main-tab.active')?.dataset.id || null,
})))()`;

async function main() {
  const { socket, evaluate, call } = await connect();
  const cwd = JSON.stringify(process.cwd());
  const created = [];

  try {
    await requireVisiblePage(call, evaluate);

    // Start from a known-empty attention state. A previous run (or a real
    // agent that was waiting when the app started) would otherwise leave
    // items in the singleton store and every count/group assertion below
    // would be off by that much.
    const cleared = await evaluate(`(() => {
      const before = window.__pmAttentionDebug().open.length;
      return { before };
    })()`, 'store before');
    assert.equal(cleared.before, 0,
      `attention store must be empty at the start of this check; found ${cleared.before} open item(s). `
      + 'Close any waiting agent tabs, or restart the dev instance.');

    // --- 1. Open the Inbox on a single pane: it must actually be hosted.
    const boot = await evaluate(`(async () => {
      const project = document.querySelector('.project-item.active') || document.querySelector('.project-item');
      if (!project) return { error: 'An existing project is required for this check' };
      project.click();
      await new Promise((r) => setTimeout(r, 600));
      const projectId = project.dataset.projectId;
      const tabId = await window.__pmDispatch('create_terminal', {
        command: 'pwsh.exe', cwd: ${cwd}, projectId, label: 'attention-ui-check',
      });
      return { projectId, tabId };
    })()`, 'boot');
    assert.equal(boot.error, undefined, JSON.stringify(boot));
    created.push(boot.tabId);
    await sleep(900);

    await evaluate(`window.__pmDispatch('attention_inbox_open')`);
    await sleep(400);

    const empty = await evaluate(readInbox);
    assert.equal(empty.paneExists, true, 'attention pane must exist');
    assert.equal(empty.hostedInPaneBody, true,
      'attention pane must be hosted in a .terminal-pane-body, not orphaned');
    assert.equal(empty.paneHidden, false, 'opening the inbox must unhide the pane');
    assert.match(empty.emptyState, /Nothing is waiting/);
    assert.equal(empty.count, '', 'an empty inbox shows no count chip');

    // The attention tab element itself must sit in a pane tab bar.
    const tabPlacement = await evaluate(`(() => {
      const tab = document.querySelector('.main-tab[data-attention-tab]');
      return {
        exists: Boolean(tab),
        paneId: tab?.closest('.terminal-pane-item')?.dataset.paneId || null,
        inPaneTabBar: Boolean(tab?.closest('.pane-tab-bar')),
      };
    })()`);
    assert.equal(tabPlacement.exists, true, 'the Inbox tab must exist');
    assert.equal(tabPlacement.inPaneTabBar, true,
      'the Inbox tab must live in a pane tab bar, not the pre-render shared bar');

    // --- 2. A blocking item on the focused tab => IN VIEW.
    await evaluate(`window.__pmDispatch('agent_notification_received', {
      tabId: ${boot.tabId}, projectId: ${JSON.stringify(boot.projectId)},
      kind: 'needs_attention', eventType: 'Notification', source: 'claude',
      reason: 'input', title: 'Approval needed', message: 'Allow this write?',
    })`);
    await sleep(300);
    // Re-focus the terminal so the item's tab is the visible one again.
    // focus_terminal takes a tabId; switch_tab is for files only.
    await evaluate(`window.__pmDispatch('focus_terminal', { tabId: ${boot.tabId} })`);
    await sleep(400);

    const store = await evaluate('window.__pmAttentionDebug()');
    assert.equal(store.open.length, 1, 'store should hold exactly one open item');
    assert.equal(store.open[0].blocking, true, 'reason=input must be blocking');
    assert.equal(store.open[0].state, 'OPEN');

    const inView = await evaluate(readInbox);
    // inViewTabIds is the union of every pane's active tab, so leftover tabs
    // from earlier runs legitimately appear alongside ours. Assert
    // membership, not equality.
    assert.ok(inView.inViewTabIds.includes(boot.tabId),
      `the focused tab ${boot.tabId} must be IN VIEW, got ${JSON.stringify(inView.inViewTabIds)}`);
    assert.equal(inView.groups.length, 1, 'only IN VIEW should render while it is in view');
    assert.equal(inView.groups[0].label, 'IN VIEW');
    assert.equal(inView.groups[0].items.length, 1);
    assert.equal(inView.groups[0].items[0].title, 'Approval needed');
    assert.equal(inView.groups[0].items[0].summary, 'Allow this write?');
    assert.equal(inView.groups[0].items[0].blocking, true);
    assert.match(inView.count, /1 item needs you/);

    // --- 3. Multi-pane: a background tab in a pane is OUT OF VIEW.
    // attentionInViewTabIds() unions the activeTabId of every pane that
    // shows a terminal, so a second terminal in the SAME pane is out of
    // view while the first is still the pane's active tab.
    const second = await evaluate(`(async () => {
      const tabId = await window.__pmDispatch('create_terminal', {
        command: 'pwsh.exe', cwd: ${cwd}, projectId: ${JSON.stringify(boot.projectId)}, label: 'attention-ui-check-2',
      });
      await new Promise((r) => setTimeout(r, 700));
      // The newly created tab took focus; put it back on the first one.
      await window.__pmDispatch('focus_terminal', { tabId: ${boot.tabId} });
      await new Promise((r) => setTimeout(r, 400));
      return tabId;
    })()`);
    created.push(second);
    await sleep(400);

    const twoTabs = await evaluate(readPanes);
    const paneWithBoth = twoTabs.find((p) => p.tabIds.includes(String(boot.tabId)) && p.tabIds.includes(String(second)));
    assert.ok(paneWithBoth,
      `both terminals should share one pane, got ${JSON.stringify(twoTabs.map((p) => p.tabIds))}`);
    assert.equal(paneWithBoth.activeTabId, String(boot.tabId),
      'the first tab must be the pane active tab');

    // Now split, and put the attention on the OTHER pane's active tab.
    const split = await evaluate(`(async () => {
      await window.__pmDispatch('pane_split', { direction: 'row' });
      await new Promise((r) => setTimeout(r, 700));
      return true;
    })()`);
    assert.equal(split, true);
    const panesAfterSplit = await evaluate(readPanes);
    assert.ok(panesAfterSplit.length >= 2,
      `pane_split should add a pane, got ${JSON.stringify(panesAfterSplit.map((p) => p.paneId))}`);

    const hostPane = panesAfterSplit.find((p) => p.tabIds.includes(String(boot.tabId)));
    assert.ok(hostPane, 'the attention tab must still be in some pane after the split');

    // Put attention on the second tab (now in a different pane, or a
    // background tab in the first) so the first tab stops being in view.
    await evaluate(`window.__pmDispatch('agent_notification_received', {
      tabId: ${second}, projectId: ${JSON.stringify(boot.projectId)},
      kind: 'needs_attention', eventType: 'Notification', source: 'claude',
      reason: 'input', title: 'Second approval', message: 'Allow this other write?',
    })`);
    await sleep(300);
    await evaluate(`window.__pmDispatch('focus_terminal', { tabId: ${second} })`);
    await sleep(500);

    const afterMove = await evaluate(readInbox);
    // Whichever pane each tab ended up in, exactly one of the two must be
    // IN VIEW and the other OUT OF VIEW. Both in view would mean the
    // union is too wide; both out of view would mean it is empty.
    assert.equal(afterMove.groups.length, 2,
      `expected IN VIEW and OUT OF VIEW groups, got ${JSON.stringify(afterMove.groups.map((g) => g.label))}`);
    assert.deepEqual(afterMove.groups.map((g) => g.label), ['IN VIEW', 'OUT OF VIEW']);
    assert.equal(afterMove.groups[0].items.length, 1, 'one item in view');
    assert.equal(afterMove.groups[1].items.length, 1, 'one item out of view');
    assert.deepEqual(
      [afterMove.groups[0].items[0].title, afterMove.groups[1].items[0].title].sort(),
      ['Approval needed', 'Second approval'],
      'each group must hold its own item',
    );
    assert.match(afterMove.count, /2 items need you/);

    // --- 4. Clicking an item acknowledges it; it stays listed but dimmed.
    await evaluate(`document.querySelector('#attention-list > .attention-item')?.click()`);
    await sleep(500);
    const acknowledged = await evaluate('window.__pmAttentionDebug()');
    assert.equal(acknowledged.open.length, 2, 'acknowledging must not drop the items');
    assert.equal(acknowledged.open.filter((i) => i.state === 'ACKNOWLEDGED').length, 1);
    const afterClick = await evaluate(readInbox);
    const ackedItem = afterClick.groups.flatMap((g) => g.items).find((i) => i.acknowledged);
    assert.ok(ackedItem, 'the acknowledged item should render with its dimmed state');

    // --- 5. Answering the agent clears its attention entirely.
    await evaluate(`window.__pmDispatch('terminal_set_waiting', { tabId: ${boot.tabId}, waiting: false, cause: 'input' })`);
    await sleep(400);
    const afterAnswer = await evaluate('window.__pmAttentionDebug()');
    assert.equal(afterAnswer.open.length, 1,
      'answering a blocking item must remove it, leaving only the other');

    // A completion event must NOT clear a blocking item.
    await evaluate(`window.__pmDispatch('agent_notification_received', {
      tabId: ${second}, projectId: ${JSON.stringify(boot.projectId)},
      kind: 'turn_completed', eventType: 'Stop', source: 'claude', reason: 'completion',
    })`);
    await sleep(400);
    const afterCompletion = await evaluate('window.__pmAttentionDebug()');
    assert.equal(afterCompletion.open.length, 1,
      'a late completion must not resolve a still-blocking attention');

    // --- 6. Real key event for Ctrl+Shift+A keeps the pane hosted.
    await call('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 | 8,
    });
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 | 8,
    });
    await sleep(500);
    const afterKey = await evaluate(readInbox);
    assert.equal(afterKey.paneExists, true);
    assert.equal(afterKey.hostedInPaneBody, true,
      'Ctrl+Shift+A must not unhost the attention pane');

    console.log('[attention-inbox-ui-check] hosting, IN VIEW / OUT OF VIEW split across panes, acknowledge, answer, and Ctrl+Shift+A passed');
  } finally {
    for (const tabId of created) {
      await evaluate(`window.__pmDispatch('close_terminal', { tabId: ${tabId} })`).catch(() => {});
    }
    socket.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
