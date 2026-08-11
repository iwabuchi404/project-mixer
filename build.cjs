// build.js — esbuild bundler for renderer.js
// Bundles renderer.js + dependencies into a single file for file:// loading

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');
const outDir = path.join(__dirname, 'dist');
const outFile = path.join(outDir, 'renderer.bundle.js');

// Ensure dist directory exists
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// Copy xterm.css to dist
const xtermCss = path.join(__dirname, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
const xtermCssDest = path.join(outDir, 'xterm.css');
if (fs.existsSync(xtermCss)) {
  fs.copyFileSync(xtermCss, xtermCssDest);
}

const buildOptions = {
  entryPoints: [path.join(__dirname, 'renderer.js')],
  bundle: true,
  outfile: outFile,
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
  sourcemap: true,
  loader: {
    '.css': 'text',
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  // xterm.js uses `this` as global; mark it as external-free
  banner: {
    js: '// Bundled by esbuild — do not edit directly',
  },
};

async function build() {
  try {
    await esbuild.build(buildOptions);
    console.log('[build] renderer.bundle.js written to dist/');
  } catch (e) {
    console.error('[build] error:', e);
    process.exit(1);
  }
}

if (isWatch) {
  (async () => {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[build] watching for changes...');
  })();
} else {
  build();
}
