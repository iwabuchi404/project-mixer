const tabs = new Map();
let activeTabId = null;
let tabCounter = 0;

const tabBar = document.getElementById('tab-bar');
const terminalContainer = document.getElementById('terminal-container');
const newTabBtn = document.getElementById('new-tab-btn');
const spawn8Btn = document.getElementById('spawn8-btn');
const commandSelect = document.getElementById('command-select');
const cwdInput = document.getElementById('cwd-input');
const memDisplay = document.getElementById('mem-display');

window.api.onPtyData(({ id, data }) => {
  for (const [, t] of tabs) {
    if (t.ptyId === id) {
      t.terminal.write(data);
      return;
    }
  }
});

window.api.onPtyExit(({ id, exitCode }) => {
  for (const [tabId, t] of tabs) {
    if (t.ptyId === id) {
      t.terminal.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`);
      return;
    }
  }
});

async function createTerminal(command, cwd) {
  const terminal = new Terminal({
    fontSize: 14,
    fontFamily: 'Consolas, "Courier New", monospace',
    theme: { background: '#1e1e1e', foreground: '#cccccc' },
    cursorBlink: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);

  const termEl = document.createElement('div');
  termEl.className = 'terminal-instance';
  termEl.style.display = 'block';
  terminalContainer.appendChild(termEl);

  await new Promise((resolve) => requestAnimationFrame(resolve));
  terminal.open(termEl);
  fitAddon.fit();

  const cols = terminal.cols;
  const rows = terminal.rows;

  const ptyId = await window.api.ptyCreate({ command, args: [], cwd: cwd || undefined, cols, rows });

  terminal.onData((data) => {
    window.api.ptyWrite(ptyId, data);
  });

  const tabId = ++tabCounter;
  const label = command.replace('.exe', '');
  const tabEl = document.createElement('div');
  tabEl.className = 'tab';
  tabEl.innerHTML = `<span class="tab-label">${label}</span><span class="tab-close">×</span>`;
  tabEl.dataset.id = tabId;

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) {
      closeTerminal(tabId);
    } else {
      switchTab(tabId);
    }
  });

  tabBar.insertBefore(tabEl, newTabBtn);

  tabs.set(tabId, { tabElement: tabEl, terminal, fitAddon, ptyId, termEl });

  switchTab(tabId);
  return tabId;
}

function switchTab(tabId) {
  tabs.forEach((t) => {
    t.termEl.style.display = 'none';
    t.tabElement.classList.remove('active');
  });

  const t = tabs.get(tabId);
  if (t) {
    t.termEl.style.display = 'block';
    t.tabElement.classList.add('active');
    t.fitAddon.fit();
    window.api.ptyResize(t.ptyId, t.terminal.cols, t.terminal.rows);
    t.terminal.focus();
    activeTabId = tabId;
  }
}

function closeTerminal(tabId) {
  const t = tabs.get(tabId);
  if (!t) return;

  window.api.ptyKill(t.ptyId);
  t.terminal.dispose();
  t.termEl.remove();
  t.tabElement.remove();
  tabs.delete(tabId);

  if (activeTabId === tabId) {
    const firstId = tabs.keys().next().value;
    if (firstId !== undefined) {
      switchTab(firstId);
    } else {
      activeTabId = null;
    }
  }
}

let resizeTimeout;
function handleResize() {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    if (activeTabId !== null) {
      const t = tabs.get(activeTabId);
      if (t) {
        t.fitAddon.fit();
        window.api.ptyResize(t.ptyId, t.terminal.cols, t.terminal.rows);
      }
    }
  }, 50);
}
window.addEventListener('resize', handleResize);
const resizeObserver = new ResizeObserver(handleResize);
resizeObserver.observe(terminalContainer);

async function updateMemory() {
  const mem = await window.api.memGet();
  memDisplay.textContent = `Memory: ${mem.workingSetMB} MB | PTYs: ${mem.ptyCount}`;
}
setInterval(updateMemory, 2000);
updateMemory();

newTabBtn.addEventListener('click', () => {
  createTerminal(commandSelect.value, cwdInput.value);
});

spawn8Btn.addEventListener('click', async () => {
  const cwd = cwdInput.value;
  for (let i = 0; i < 8; i++) {
    await createTerminal('pwsh.exe', cwd);
  }
});

createTerminal('pwsh.exe', '');
