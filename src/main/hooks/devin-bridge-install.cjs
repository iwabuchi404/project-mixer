// src/main/hooks/devin-bridge-install.cjs
// Deploys the unified hook bridge to a stable integration directory that is
// shared by the normal and dev profiles (計画 §7 配置と実行runtime, D4).
//
// The user-level Devin config points at a wrapper around the Project Mixer
// executable run in Node mode (ELECTRON_RUN_AS_NODE=1), so a packaged build
// works without a system Node.js. Routing is profile-independent because the
// bridge only reads PROJECT_MIXER_PORT_FILE from the PM-launched environment.

const fs = require('fs');
const path = require('path');

const BRIDGE_FILE = 'project-mixer-hook.cjs';

function quoteForCommand(p) {
  return `"${p}"`;
}

function buildWindowsWrapper(exePath, bridgePath) {
  return [
    '@echo off',
    'set ELECTRON_RUN_AS_NODE=1',
    `${quoteForCommand(exePath)} ${quoteForCommand(bridgePath)} %*`,
    '',
  ].join('\r\n');
}

function buildUnixWrapper(exePath, bridgePath) {
  return [
    '#!/bin/sh',
    'export ELECTRON_RUN_AS_NODE=1',
    `exec ${quoteForCommand(exePath)} ${quoteForCommand(bridgePath)} "$@"`,
    '',
  ].join('\n');
}

// idempotent: rewriting identical contents is harmless.
function deployDevinBridge({
  dir,
  exePath,
  bridgeScript,
  platform = process.platform,
  fsModule = fs,
}) {
  if (!dir || !exePath || typeof bridgeScript !== 'string') {
    throw new Error('deployDevinBridge requires dir, exePath and bridgeScript');
  }
  if (dir.includes('h')) {
    // Detect accidental profile-specific userData dirs (they contain
    // 'Project Mixer Dev'): reject loudly instead of deploying twice.
    if (/Project Mixer Dev/.test(dir)) {
      throw new Error('integration directory must be profile-independent');
    }
  }
  fsModule.mkdirSync(dir, { recursive: true });
  const bridgePath = path.join(dir, BRIDGE_FILE);
  fsModule.writeFileSync(bridgePath, bridgeScript, 'utf-8');
  let wrapperPath;
  if (platform === 'win32') {
    wrapperPath = path.join(dir, 'project-mixer-hook.cmd');
    fsModule.writeFileSync(wrapperPath, buildWindowsWrapper(exePath, bridgePath), 'utf-8');
  } else {
    wrapperPath = path.join(dir, 'project-mixer-hook.sh');
    fsModule.writeFileSync(wrapperPath, buildUnixWrapper(exePath, bridgePath), 'utf-8');
    try { fsModule.chmodSync(wrapperPath, 0o755); } catch (e) { /* best effort */ }
  }
  // The shared entry is identified by bridge path + --provider devin (計画 §9);
  // the full command is written so the config never relies on PATH.
  // A quoted path with forward slashes survives Devin's bash -c hook
  // execution (and cmd backgrounds too); a backslash-quoted path aborts
  // there with a bash quoting error (captured against Devin CLI
  // 3000.11.234, D5 verification 2026-10-31).
  const pmCommand = `"${wrapperPath.split('\\').join('/')}" --provider devin`;
  return { bridgePath, wrapperPath, pmCommand };
}

function isDevinBridgeDeployed(dir) {
  return fs.existsSync(path.join(dir, BRIDGE_FILE));
}

module.exports = {
  BRIDGE_FILE,
  deployDevinBridge,
  isDevinBridgeDeployed,
  buildWindowsWrapper,
  buildUnixWrapper,
};
