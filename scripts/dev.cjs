// scripts/dev.cjs — Cross-platform dev runner
// 1. Run initial build (sync)
// 2. Start esbuild watch (async, stays running)
// 3. Start Electron with --dev
// 4. On exit, kill both processes

const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');
const nodeBin = process.execPath;

function run(cmd, args, opts) {
  return spawn(cmd, args, { stdio: 'inherit', shell: false, ...opts });
}

async function main() {
  // 1. Initial build (must complete before Electron starts)
  console.log('[dev] Building renderer bundle...');
  const build = run(nodeBin, [path.join(root, 'build.cjs')], { cwd: root });
  await new Promise((resolve, reject) => {
    build.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Build failed with code ${code}`));
    });
    build.on('error', reject);
  });
  console.log('[dev] Build complete.');

  // 2. Start watch mode
  console.log('[dev] Starting esbuild watch...');
  const watcher = run(nodeBin, [path.join(root, 'build.cjs'), '--watch'], { cwd: root });

  // 3. Start Electron
  console.log('[dev] Starting Electron (--dev)...');
  const electron = run(electronBin, ['.', '--dev'], { cwd: root });

  // 4. Cleanup on exit
  let shuttingDown = false;
  function cleanup(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exitCode = exitCode;
    try { if (watcher.exitCode === null) watcher.kill(); } catch (e) {}
    try { if (electron.exitCode === null) electron.kill(); } catch (e) {}
  }

  electron.on('error', (e) => {
    console.error('[dev] Electron failed to start:', e);
    cleanup(1);
  });
  watcher.on('error', (e) => {
    console.error('[dev] Watcher failed to start:', e);
    cleanup(1);
  });
  electron.on('exit', (code, signal) => cleanup(code ?? (signal ? 1 : 0)));
  watcher.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`[dev] Watcher stopped unexpectedly (${signal || code || 0}).`);
      cleanup(code || 1);
    }
  });
  process.on('SIGINT', () => cleanup(0));
  process.on('SIGTERM', () => cleanup(0));
}

main().catch((e) => {
  console.error('[dev] Error:', e);
  process.exit(1);
});
