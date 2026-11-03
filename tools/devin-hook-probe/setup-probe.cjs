// Sets up an isolated Devin hook probe workspace and prints run instructions.
//
// This does NOT touch the real project's .devin/ directory. It creates a
// throwaway workspace under the OS temp dir, writes a .devin/hooks.v1.json
// that points the three lifecycle events (UserPromptSubmit, PermissionRequest,
// Stop) at probe-hook.cjs, and (optionally) adds a competing blocking Stop
// hook for case 4. It then prints the exact commands to run.
//
// Usage:
//   node setup-probe.cjs                 # basic probe (cases 1,2,3,5,6,7)
//   node setup-probe.cjs --block-stop    # also add a competing blocking Stop hook (case 4)
//   node setup-probe.cjs --summary       # print a summary of the current log instead
//
// Environment (optional, for case 6 / 9 — PM env inheritance & dual profile):
//   PROJECT_MIXER_PTY_ID       - set this when launching Devin from a PM PTY
//   PROJECT_MIXER_PORT_FILE    - set this to a port.json path
//
// The probe log path is printed and also written to <workspace>/probe-log.txt
// so probe-hook.cjs can be invoked with it as argv[2].

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HERE = __dirname;
const PROBE_HOOK = path.join(HERE, 'probe-hook.cjs');
const BLOCKING_HOOK = path.join(HERE, 'blocking-stop-hook.cjs');

function quote(p) {
  // Wrap in double quotes and escape backslashes + embedded quotes for JSON.
  return '"' + p.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function cmdFor(script, ...args) {
  return `node ${quote(script)}${args.length ? ' ' + args.map(quote).join(' ') : ''}`;
}

function setupWorkspace({ blockStop }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-probe-'));
  const devinDir = path.join(root, '.devin');
  fs.mkdirSync(devinDir, { recursive: true });

  const logPath = path.join(root, 'probe-log.jsonl');
  // Touch the log so it exists.
  fs.writeFileSync(logPath, '', 'utf-8');

  const hooks = {
    UserPromptSubmit: [
      { matcher: '', hooks: [{ type: 'command', command: cmdFor(PROBE_HOOK, logPath), timeout: 2 }] },
    ],
    PermissionRequest: [
      { matcher: '', hooks: [{ type: 'command', command: cmdFor(PROBE_HOOK, logPath), timeout: 2 }] },
    ],
    Stop: [
      { matcher: '', hooks: [{ type: 'command', command: cmdFor(PROBE_HOOK, logPath), timeout: 2 }] },
    ],
  };

  if (blockStop) {
    const counterFile = path.join(root, 'block-counter.txt');
    fs.writeFileSync(counterFile, '0', 'utf-8');
    // Add a competing Stop hook AFTER the probe hook so both fire. Order of
    // arrival is one of the things the probe records.
    hooks.Stop[0].hooks.push({
      type: 'command',
      command: cmdFor(BLOCKING_HOOK, counterFile, '1'),
      timeout: 2,
    });
  }

  // .devin/hooks.v1.json: the hooks object IS the entire file.
  fs.writeFileSync(
    path.join(devinDir, 'hooks.v1.json'),
    JSON.stringify(hooks, null, 2),
    'utf-8',
  );

  return { root, logPath, blockStop };
}

function printInstructions(ws) {
  const { root, logPath, blockStop } = ws;
  console.log('=== Devin Lifecycle Hook Probe workspace ===');
  console.log('');
  console.log(`Workspace:  ${root}`);
  console.log(`Probe log:   ${logPath}`);
  console.log(`Hooks file:  ${path.join(root, '.devin', 'hooks.v1.json')}`);
  if (blockStop) console.log('Competing blocking Stop hook: ENABLED (blocks first Stop, then allows)');
  console.log('');
  console.log('--- How to run ---');
  console.log('');
  console.log('1) Start Devin inside the probe workspace:');
  console.log('');
  console.log(`     cd "${root}"`);
  console.log('     devin');
  console.log('');
  console.log('   Inside Devin, run /hooks to confirm the hooks are loaded and to');
  console.log('   capture the loaded source list for the probe record.');
  console.log('');
  console.log('2) Run the probe cases (see docs/Devin Hooks 通知統合計画.md D0):');
  console.log('     case 1: send a simple prompt, let the agent finish (UserPromptSubmit + Stop)');
  console.log('     case 2: ask the agent to do something requiring 2 approvals in one turn');
  console.log('     case 3: approve vs reject a permission request');
  if (blockStop) console.log('     case 4: competing Stop hook blocks first Stop, then agent finishes');
  console.log('     case 5: send a new prompt immediately after a Stop');
  console.log('     case 6: launch a 2nd Devin in the same workspace to test PTY/cwd separation');
  console.log('     case 7: stop Project Mixer / remove port file, then send a prompt');
  console.log('');
  console.log('3) For PM env-inheritance (probe case 6 / D2): launch Devin from a');
  console.log('   Project Mixer PTY so PROJECT_MIXER_PTY_ID / PROJECT_MIXER_PORT_FILE');
  console.log('   are present, then compare with a plain terminal launch.');
  console.log('');
  console.log('4) Inspect the recorded events:');
  console.log('');
  console.log(`     node "${path.join(HERE, 'view-probe.cjs')}" "${logPath}"`);
  console.log('');
  console.log('5) Clean up when done:');
  console.log('');
  console.log(`     rmdir /s /q "${root}"   (Windows)`);
  console.log(`     rm -rf "${root}"        (Unix)`);
  console.log('');
  console.log('The probe records field names, types, ids, stop_hook_active, env');
  console.log('presence, and timing ONLY. It never logs prompt text, tool_input,');
  console.log('tool_response, tokens, or a full environment dump.');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--summary')) {
    const logArg = args[args.indexOf('--summary') + 1];
    if (!logArg || !fs.existsSync(logArg)) {
      console.error('No log path given or file missing for --summary.');
      process.exit(1);
    }
    require('./view-probe.cjs').summarize(logArg);
    return;
  }
  const blockStop = args.includes('--block-stop');
  const ws = setupWorkspace({ blockStop });
  printInstructions(ws);
}

main();
