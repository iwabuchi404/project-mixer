const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const esbuild = require('esbuild');

function loadBundledModule(entryPoint) {
  const result = esbuild.buildSync({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  const module = { exports: {} };
  const evaluate = new Function('module', 'exports', 'require', result.outputFiles[0].text);
  evaluate(module, module.exports, require);
  return module.exports;
}

const previewState = loadBundledModule(path.join(__dirname, '..', 'src', 'preview', 'state.js'));
const previewSecurity = loadBundledModule(path.join(__dirname, '..', 'src', 'preview', 'security.js'));

function preview(projectId) {
  return { projectId };
}

test('preferred preview must belong to the selected project', () => {
  const files = new Map([
    ['preview:a', preview('A')],
    ['preview:b', preview('B')],
  ]);

  assert.equal(previewState.getPreviewForProject(files, 'B', 'preview:a'), 'preview:b');
  assert.equal(previewState.getPreviewForProject(files, 'C', 'preview:a'), null);
});

test('closing a preview never selects a tab from another project', () => {
  const files = new Map([
    ['preview:a1', preview('A')],
    ['preview:b1', preview('B')],
    ['preview:a2', preview('A')],
  ]);

  assert.equal(previewState.getNextPreviewForProject(files, 'A', 'preview:a1'), 'preview:a2');
  assert.equal(previewState.getNextPreviewForProject(files, 'B', 'preview:b1'), null);
});

test('HTML preview CSP disables script execution and outbound connections', () => {
  assert.match(previewSecurity.PREVIEW_CSP, /script-src 'none'/);
  assert.match(previewSecurity.PREVIEW_CSP, /connect-src 'none'/);
  assert.match(previewSecurity.PREVIEW_CSP, /form-action 'none'/);
});

test('preview splitter resizes the preview side and respects both minimums', () => {
  const options = {
    startPreviewWidth: 400,
    availableWidth: 1000,
    minMain: 200,
    minPreview: 150,
  };

  assert.equal(previewState.calculatePreviewWidth({ ...options, delta: 100 }), 300);
  assert.equal(previewState.calculatePreviewWidth({ ...options, delta: 500 }), 150);
  assert.equal(previewState.calculatePreviewWidth({ ...options, delta: -1000 }), 800);
});
