#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { createTerminalSignalParser } = require('./terminal-signal-parser.cjs');

function usage() {
  console.log([
    'Usage: node osc-probe.cjs [--log <path>] [--] [devin arguments...]',
    '',
    'Runs Devin in an interactive PTY with notify="always" and records only',
    'BEL, OSC 9, and OSC 777 terminal notification signals as JSONL.',
  ].join('\n'));
}

function parseArgs(argv) {
  let logPath = null;
  const devinArgs = [];
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
      devinArgs.push(...argv.slice(index + 1));
      break;
    }
    devinArgs.push(arg);
  }
  return { help: false, logPath, devinArgs };
}

function findBaseConfig() {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.APPDATA || '', 'devin', 'config.json')]
    : [path.join(os.homedir(), '.config', 'devin', 'config.json')];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function createProbeConfig() {
  const basePath = findBaseConfig();
  let config = {};
  if (basePath) {
    try {
      config = JSON.parse(fs.readFileSync(basePath, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot read Devin config ${basePath}: ${error.message}`);
    }
  }
  config.notify = 'always';

  const tempPath = path.join(os.tmpdir(), `project-mixer-devin-osc-${process.pid}.json`);
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return tempPath;
}

function defaultLogPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.resolve('.project-mixer', 'probes', `devin-terminal-signals-${timestamp}.jsonl`);
}

function resolveExecutable(command) {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const installedDevin = path.join(process.env.LOCALAPPDATA, 'devin', 'cli', 'bin', 'devin.exe');
    if (fs.existsSync(installedDevin)) return installedDevin;
  }

  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  const names = process.platform === 'win32'
    ? extensions.map((extension) => `${command}${extension.toLowerCase()}`)
    : [command];

  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const cleanDirectory = directory.replace(/^"|"$/g, '');
    for (const name of names) {
      const candidate = path.join(cleanDirectory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`Cannot find ${command} on PATH`);
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    usage();
    return;
  }

  const logPath = path.resolve(parsed.logPath || defaultLogPath());
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const configPath = createProbeConfig();
  let cleanedUp = false;

  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
    try {
      fs.unlinkSync(configPath);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`[osc-probe] Failed to remove temporary config: ${error.message}`);
    }
  }

  function record(signal) {
    fs.appendFileSync(logPath, `${JSON.stringify({
      observedAt: new Date().toISOString(),
      ...signal,
    })}\n`);
  }

  const parser = createTerminalSignalParser(record);
  const executable = resolveExecutable('devin');
  const child = pty.spawn(executable, ['--config', configPath, ...parsed.devinArgs], {
    name: 'xterm-256color',
    cols: process.stdout.columns || 100,
    rows: process.stdout.rows || 30,
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
    },
  });

  console.error(`[osc-probe] notify="always"; log=${logPath}`);
  console.error('[osc-probe] Run approval, input-waiting, and normal-completion cases, then exit Devin.');

  child.onData((data) => {
    parser.push(data);
    process.stdout.write(data);
  });
  child.onExit(({ exitCode }) => {
    process.stdin.off('data', forwardInput);
    process.stdin.pause();
    cleanup();
    console.error(`\n[osc-probe] Devin exited (${exitCode}). Signals: ${logPath}`);
    // node-pty keeps its ConPTY handle alive on Windows after short-lived
    // commands. Exit explicitly once all synchronous probe output is flushed.
    process.exit(exitCode);
  });

  function forwardInput(data) {
    child.write(data);
  }

  process.stdin.resume();
  if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
  process.stdin.on('data', forwardInput);
  process.stdout.on('resize', () => {
    child.resize(process.stdout.columns || 100, process.stdout.rows || 30);
  });
  process.on('exit', cleanup);
}

try {
  main();
} catch (error) {
  console.error(`[osc-probe] ${error.message}`);
  process.exitCode = 1;
}
