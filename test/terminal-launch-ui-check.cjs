// Opt-in integration check. Uses isolated userData and real Windows cmd PTYs.
// node test/terminal-launch-ui-check.cjs <absolute scratch directory>
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const mainPath = process.env.PM_LAZY_MAIN_PATH || path.join(root, 'main.js');
const scratch = process.env.PM_LAZY_CHECK_DIR || process.argv[2];
if (!scratch || !path.isAbsolute(scratch)) throw new Error('An absolute scratch directory is required');
const scenario = process.env.PM_LAZY_CHECK_SCENARIO || 'single';
const dir = path.join(scratch, scenario);
fs.mkdirSync(dir, { recursive: true });

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const scenarios = process.argv[3] === '--live' ? ['live'] : ['single', 'split', 'file'];
  for (const name of scenarios) {
    const result = spawnSync(require('electron'), [__filename], {
      cwd: root, windowsHide: true, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, PM_LAZY_CHECK_DIR: scratch, PM_LAZY_CHECK_SCENARIO: name,
        PM_LAZY_LIVE_FILE: process.argv[4] || '' },
    });
    fs.writeFileSync(path.join(scratch, `${name}-stdout.log`), result.stdout || '');
    fs.writeFileSync(path.join(scratch, `${name}-stderr.log`), result.stderr || '');
    assert.equal(result.status, 0, `${name}: ${result.error || result.stderr}`);
    const evidence = JSON.parse(fs.readFileSync(path.join(scratch, name, 'result.json')));
    assert.equal(evidence.passed, true, `${name}: ${evidence.failure || 'missing completion receipt'}`);
    assert.equal(evidence.failure, undefined);
    console.log(`${name}: passed`);
  }
} else {
  const { app, ipcMain } = require('electron');
  // main.js quits when its last window closes. Keep this harness alive until
  // native PTY exit events have also been verified, including on failure.
  app.on('before-quit', (event) => event.preventDefault());
  const profile = path.join(dir, 'profile');
  const config = path.join(profile, 'project-mixer');
  fs.mkdirSync(config, { recursive: true });
  const live = scenario === 'live' ? JSON.parse(fs.readFileSync(process.env.PM_LAZY_LIVE_FILE, 'utf8')) : null;
  const projects = ['a', 'b'].map(id => {
    const cwd = path.join(dir, id);
    fs.mkdirSync(cwd, { recursive: true });
    return { id, name: `Lazy test ${id}`, path: cwd };
  });
  if (live) projects[0].path = live.cwd;
  if (scenario === 'file') fs.writeFileSync(path.join(projects[0].path, 'readme.txt'), 'Lazy terminal integration check');
  const tabs = live ? live.sessionIds.map((resumeSessionId, i) => ({
    command: 'devin', label: `live-${i}`, cwd: live.cwd, projectId: 'a', resumeSessionId,
  })) : Array.from({ length: 20 }, (_, i) => ({
    command: 'cmd.exe', label: `saved-${i}`, cwd: projects[i < 10 ? 0 : 1].path, projectId: i < 10 ? 'a' : 'b',
  }));
  const split = ['split', 'file'].includes(scenario);
  const panes = split
    ? [{ members: [0, 1, 2, 3, 4], active: 0, size: 1 }, { members: [5, 6, 7, 8, 9], active: 5, size: 1 }]
    : [{ members: Array.from({ length: live ? tabs.length : 10 }, (_, i) => i), active: 0, size: 1 }];
  if (scenario === 'file') panes[0].view = { type: 'file', path: path.join(projects[0].path, 'readme.txt') };
  fs.writeFileSync(path.join(config, 'projects.json'), JSON.stringify(projects));
  fs.writeFileSync(path.join(config, 'layout.json'), JSON.stringify({
    activeProjectId: 'a', tabs,
    paneLayouts: {
      a: { direction: 'row', layoutMode: split ? 'row' : 'single', activeIndex: 0, panes },
      b: { direction: 'row', layoutMode: 'single', activeIndex: 0, panes: [{ members: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19], active: 10 }] },
    },
  }));
  app.setPath('userData', profile);
  delete process.env.PM_PROFILE;
  const pty = require('node:module').createRequire(mainPath)('node-pty');
  const spawn = pty.spawn;
  const spawned = [], exited = [], errors = [];
  let failNext = false, delayNext = false;
  pty.spawn = function(...args) {
    if (failNext) { failNext = false; throw new Error('Deliberate test spawn failure'); }
    const proc = spawn(...args);
    spawned.push({ pid: proc.pid, file: args[0], args: args[1] });
    proc.onExit(() => exited.push(proc.pid));
    return proc;
  };
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
    const result = await listener(...args);
    if (channel === 'pty:create' && delayNext) {
      delayNext = false;
      await new Promise(r => setTimeout(r, 500));
    }
    return result;
  });
  let win;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, message, attempts = 150) => {
    for (let i = 0; i < attempts; i++) { if (await fn()) return; await wait(40); }
    throw new Error(message);
  };
  const evaluate = code => win.webContents.executeJavaScript(code);
  const processes = () => {
    const { execFileSync } = require('node:child_process');
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      '@(Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId,CreationDate) | ConvertTo-Json -Compress'],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(raw.trim());
  };
  const snapshot = () => evaluate(`(async () => ({
    tabs: [...document.querySelectorAll('.main-tab[data-id]')].map(e => ({ id: Number(e.dataset.id), state: e.dataset.launchState, pty: e.dataset.ptyId })),
    memory: await window.api.memGet(),
  }))()`);
  const dispatch = (name, args) => evaluate(`window.__pmDispatch(${JSON.stringify(name)}, ${JSON.stringify(args)})`);
  app.on('browser-window-created', (_, window) => {
    if (win) return;
    win = window;
    win.hide();
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', (_, level, message) => { if (level >= 2) errors.push(message); });
    win.webContents.once('did-finish-load', async () => {
      const evidence = { scenario, spawned, exited, errors };
      try {
        await evaluate(`window.__lazyOutput = ''; window.api.onPtyData(({data}) => {window.__lazyOutput += data;}); true`);
        const initial = scenario === 'split' ? 2 : 1;
        await until(async () => {
          const s = await snapshot();
          return s.tabs.length === tabs.length && s.memory.ptyCount === initial && s.tabs.filter(t => t.state === 'running').length === initial;
        }, 'restored PTY count differs from visible terminals');
        await wait(300);
        assert.equal(spawned.length, initial, 'no temporary startup shells or hidden terminals');
        evidence.initial = await snapshot();
        assert.equal(evidence.initial.tabs.filter(t => t.state === 'dormant').length, tabs.length - initial);
        if (live) {
          await until(() => evaluate(`window.__lazyOutput.includes('OK') && window.__lazyOutput.includes('Context:')`), 'first Devin conversation did not resume', 1000);
          assert.ok(spawned[0].args.join(' ').includes(live.sessionIds[0]));
          const before = JSON.parse(fs.readFileSync(path.join(config, 'layout.json')));
          assert.deepEqual(before.tabs.map(t => t.resumeSessionId), live.sessionIds);
          await evaluate(`window.__lazyOutput = ''; true`);
          await dispatch('focus_terminal', { tabId: 2 });
          await until(async () => (await snapshot()).memory.ptyCount === 2, 'second Devin tab did not launch');
          await until(() => evaluate(`window.__lazyOutput.includes('OK') && window.__lazyOutput.includes('Context:')`), 'second Devin conversation did not resume', 1000);
          assert.ok(spawned[1].args.join(' ').includes(live.sessionIds[1]));
          evidence.final = await snapshot();
        }
        if (scenario === 'single') {
          const first = evidence.initial.tabs.find(t => t.state === 'running').id;
          const second = first + 1;
          // Delay the real PTY response to close its tab while it is starting.
          delayNext = true;
          await dispatch('focus_terminal', { tabId: second });
          await until(() => spawned.length === 2, 'second PTY never started');
          const latePid = spawned.at(-1).pid;
          await dispatch('close_terminal', { tabId: second });
          await until(() => exited.includes(latePid), 'late PTY survived its closed tab');
          await until(async () => (await snapshot()).memory.ptyCount === 1, 'late PTY remained registered');

          const third = first + 2;
          failNext = true;
          await dispatch('focus_terminal', { tabId: third });
          await until(async () => (await snapshot()).tabs.find(t => t.id === third)?.state === 'failed', 'spawn error not shown');
          const count = spawned.length;
          await dispatch('focus_terminal', { tabId: first });
          await dispatch('focus_terminal', { tabId: third });
          await wait(150);
          assert.equal(spawned.length, count, 'failed tabs retried automatically');
          await evaluate(`document.querySelector('.main-tab[data-id="${third}"]') && document.querySelector('.terminal-launch-state button').click()`);
          await until(async () => (await snapshot()).tabs.find(t => t.id === third)?.state === 'running', 'retry failed');

          await evaluate(`window.__lazyOutput = ''; window.api.onPtyData(({data}) => {window.__lazyOutput += data;}); true`);
          const ready = (await snapshot()).tabs.find(t => t.id === third);
          await evaluate(`window.api.ptyWrite(${Number(ready.pty)}, 'echo PM_LAZY_EXECUTED_%OS%\\r')`);
          await until(() => evaluate(`window.__lazyOutput.includes('PM_LAZY_EXECUTED_Windows_NT')`), 'command was not executed by the real PTY');
          await dispatch('select_project', { projectId: 'b' });
          await until(async () => (await snapshot()).memory.ptyCount === 3, 'background project did not start its selected tab');
          await dispatch('select_project', { projectId: 'a' });
          await wait(200);
          assert.equal((await snapshot()).memory.ptyCount, 3, 'switching back started extra terminals');
          evidence.final = await snapshot();
          // The renderer already persists the full descriptor list on each change.
          const saved = JSON.parse(fs.readFileSync(path.join(config, 'layout.json')));
          assert.equal(saved.tabs.length, 19, 'unopened tabs were dropped when saving');
        }
        const shot = await win.webContents.capturePage();
        fs.writeFileSync(path.join(dir, 'screen.png'), shot.toPNG());
        const all = processes();
        const owned = new Set(spawned.map(p => p.pid));
        for (let i = 0; i < 8; i++) {
          for (const p of all) if (owned.has(p.ParentProcessId)) owned.add(p.ProcessId);
        }
        evidence.processTree = all.filter(p => owned.has(p.ProcessId));
        win.close();
        await until(() => exited.length === spawned.length, 'PTYs survived window shutdown');
        const after = processes();
        evidence.remaining = evidence.processTree.filter(p => after.some(q => q.ProcessId === p.ProcessId && q.Name === p.Name && q.CreationDate === p.CreationDate));
        assert.equal(evidence.remaining.length, 0, 'native descendants survived window shutdown');
        assert.deepEqual(errors.filter(message => !message.startsWith('task queue exceeded allotted deadline')), [], 'renderer reported an unexpected error');
        evidence.passed = true;
        fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(evidence, null, 2));
        app.exit(0);
      } catch (error) {
        evidence.passed = false;
        evidence.failure = error.stack;
        fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(evidence, null, 2));
        console.error(error);
        if (!win.isDestroyed()) win.close();
        await wait(1000);
        app.exit(1);
      }
    });
  });
  require(mainPath);
}
