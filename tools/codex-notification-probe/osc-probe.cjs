#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { createTerminalSignalParser } = require('../devin-hook-probe/terminal-signal-parser.cjs');

function quotePowerShellArgument(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function defaultLogPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.resolve('.project-mixer', 'probes', `codex-terminal-signals-${timestamp}.jsonl`);
}

function parseArgs(argv) {
  let logPath = null;
  const codexArgs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--log') {
      logPath = argv[index + 1];
      if (!logPath) throw new Error('--log requires a path');
      index += 1;
      continue;
    }
    if (arg === '--') {
      codexArgs.push(...argv.slice(index + 1));
      break;
    }
    codexArgs.push(arg);
  }
  return { help: false, logPath, codexArgs };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log('Usage: node osc-probe.cjs [--log <path>] [--] [codex arguments...]');
    return;
  }

  const logPath = path.resolve(parsed.logPath || defaultLogPath());
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const forcedArgs = [
    '-c', 'tui.notifications=["agent-turn-complete","approval-requested"]',
    '-c', 'tui.notification_method="osc9"',
    '-c', 'tui.notification_condition="always"',
    ...parsed.codexArgs,
  ];
  const command = `& ${['codex', ...forcedArgs].map(quotePowerShellArgument).join(' ')}`;
  const shell = process.platform === 'win32' ? 'pwsh.exe' : 'sh';
  const shellArgs = process.platform === 'win32'
    ? ['-NoProfile', '-Command', command]
    : ['-c', ['codex', ...forcedArgs].map(quotePowerShellArgument).join(' ')];
  let cleanedUp = false;

  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
  }

  const parser = createTerminalSignalParser((signal) => {
    fs.appendFileSync(logPath, `${JSON.stringify({
      observedAt: new Date().toISOString(),
      ...signal,
    })}\n`);
  });
  const child = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols: process.stdout.columns || 100,
    rows: process.stdout.rows || 30,
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  console.error(`[codex-osc-probe] OSC 9 always enabled; log=${logPath}`);
  console.error('[codex-osc-probe] Trigger one approval and one normal completion, then exit Codex.');

  child.onData((data) => {
    parser.push(data);
    process.stdout.write(data);
  });
  function forwardInput(data) {
    child.write(data);
  }
  child.onExit(({ exitCode }) => {
    process.stdin.off('data', forwardInput);
    process.stdin.pause();
    cleanup();
    console.error(`\n[codex-osc-probe] Codex exited (${exitCode}). Signals: ${logPath}`);
    process.exit(exitCode);
  });

  process.stdin.resume();
  if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
  process.stdin.on('data', forwardInput);
  process.stdout.on('resize', () => child.resize(
    process.stdout.columns || 100,
    process.stdout.rows || 30,
  ));
  process.on('exit', cleanup);
}

try {
  main();
} catch (error) {
  console.error(`[codex-osc-probe] ${error.message}`);
  process.exitCode = 1;
}
