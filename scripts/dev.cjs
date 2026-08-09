// scripts/dev.cjs — Cross-platform dev runner
// 1. Run initial build (sync)
// 2. Start esbuild watch (async, stays running)
// 3. Start Electron with --dev
// 4. On exit, kill both processes

const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

function run(cmd, args, opts) {
  return spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts });
}

async function main() {
  // 1. Initial build (must complete before Electron starts)
  console.log('[dev] Building renderer bundle...');
  const build = run('node', ['build.cjs'], { cwd: root });
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
  const watcher = run('node', ['build.cjs', '--watch'], { cwd: root });

  // 3. Start Electron
  console.log('[dev] Starting Electron (--dev)...');
  const electron = run(electronBin, ['.', '--dev'], { cwd: root });

  // 4. Cleanup on exit
  function cleanup() {
    try { watcher.kill(); } catch (e) {}
    try { electron.kill(); } catch (e) {}
    process.exit(0);
  }

  electron.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((e) => {
  console.error('[dev] Error:', e);
  process.exit(1);
});
