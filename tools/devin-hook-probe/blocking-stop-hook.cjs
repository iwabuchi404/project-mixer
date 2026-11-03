// Devin Stop hook that blocks the first N Stop events, then allows the rest.
//
// Purpose: D0 probe case 4 — observe what Project Mixer's observation Stop
// hook receives when a *competing* Stop hook blocks, whether the agent
// resumes and re-fires Stop, and how `stop_hook_active` changes across the
// block/resume cycle.
//
// Usage:
//   node blocking-stop-hook.cjs <counterFile> [blockCount]
//
//   counterFile  - path to a small file tracking how many times this hook
//                  has blocked. Created on first run.
//   blockCount   - number of Stop events to block (exit 2) before allowing
//                  (exit 0). Default 1.
//
// This hook reads no stdin and writes no stdout. It only manipulates the
// counter file and exits with the appropriate code. It never records
// prompt or payload content.

'use strict';

const fs = require('fs');

const counterFile = process.argv[2];
const blockCount = Number(process.argv[3] || 1) || 1;

if (!counterFile) {
  // Nothing to do; allow the stop.
  process.exit(0);
}

let count = 0;
try {
  if (fs.existsSync(counterFile)) {
    count = Number(fs.readFileSync(counterFile, 'utf-8').trim()) || 0;
  }
} catch (_) { /* treat as fresh */ }

const shouldBlock = count < blockCount;
try {
  fs.writeFileSync(counterFile, String(count + 1), 'utf-8');
} catch (_) { /* ignore; still exit cleanly */ }

if (shouldBlock) {
  // Exit 2 = block per Devin hook exit-code semantics. The agent should
  // resume and eventually fire Stop again.
  process.exit(2);
}
process.exit(0);
