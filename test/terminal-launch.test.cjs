const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../src/ui/terminal-launch.mjs');
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('restoring unopened tabs does not allocate any process', async () => {
  const { createTerminalLauncher } = await load();
  let starts = 0;
  const tabs = Array.from({ length: 20 }, () => createTerminalLauncher({ start: async () => ++starts, dispose() {} }));
  assert.equal(starts, 0);
  await Promise.all([tabs[0].ensure(), tabs[0].ensure(), tabs[3].ensure()]);
  assert.equal(starts, 2);
  await tabs[0].ensure();
  assert.equal(starts, 2);
});

test('closing during creation disposes the late PTY exactly once', async () => {
  const { createTerminalLauncher } = await load();
  const wait = deferred();
  const killed = [];
  let stillOwned;
  const tab = createTerminalLauncher({ start: async (owns) => { stillOwned = owns; return wait.promise; }, dispose: (p) => killed.push(p) });
  const launch = tab.ensure();
  await Promise.resolve();
  tab.close();
  assert.equal(stillOwned(), false);
  wait.resolve({ ptyId: 31 });
  assert.equal(await launch, null);
  assert.deepEqual(killed, [{ ptyId: 31 }]);
  tab.close();
  assert.equal(killed.length, 1);
});

test('closing before the asynchronous start begins creates no PTY', async () => {
  const { createTerminalLauncher } = await load();
  let starts = 0;
  const tab = createTerminalLauncher({ start: async () => ++starts, dispose() {} });
  const launch = tab.ensure();
  tab.close();
  await launch;
  assert.equal(starts, 0);
});

test('failed launches retry only on explicit request', async () => {
  const { createTerminalLauncher } = await load();
  let starts = 0;
  const tab = createTerminalLauncher({ start: async () => { if (++starts === 1) throw new Error('missing CLI'); return { ptyId: 9 }; }, dispose() {} });
  await assert.rejects(tab.ensure(), /missing CLI/);
  await tab.ensure();
  assert.equal(starts, 1);
  await tab.ensure({ retry: true });
  assert.equal(starts, 2);
  assert.equal(tab.state, 'running');
});

test('exit during attach and natural exit never trigger an automatic restart', async () => {
  const { createTerminalLauncher } = await load();
  let starts = 0;
  let disposals = 0;
  const wait = deferred();
  const tab = createTerminalLauncher({ start: async () => { starts++; return wait.promise; }, dispose() { disposals++; } });
  const launch = tab.ensure();
  tab.markExited();
  wait.resolve({ ptyId: 5 });
  await launch;
  assert.equal(tab.state, 'exited');
  await tab.ensure();
  assert.equal(starts, 1);
  tab.close();
  assert.equal(disposals, 1);
});
