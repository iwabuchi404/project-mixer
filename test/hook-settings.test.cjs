const test = require('node:test');
const assert = require('node:assert/strict');
const { upsertProjectMixerHook } = require('../hook-settings.cjs');

const pmHook = (eventName) => ({
  type: 'command',
  command: `node "project-mixer-hook.cjs" ${eventName}`,
});

test('adds a dedicated Project Mixer entry when no hooks exist', () => {
  assert.deepEqual(upsertProjectMixerHook(undefined, pmHook('Stop')), [
    { matcher: '', hooks: [pmHook('Stop')] },
  ]);
});

test('removes only the old Project Mixer hook from a mixed entry', () => {
  const otherHook = { type: 'command', command: 'node other-hook.cjs' };
  const result = upsertProjectMixerHook([
    {
      matcher: 'permission_prompt',
      hooks: [otherHook, { type: 'command', command: 'node project-mixer-hook.cjs' }],
    },
  ], pmHook('Notification'));

  assert.deepEqual(result, [
    { matcher: 'permission_prompt', hooks: [otherHook] },
    { matcher: '', hooks: [pmHook('Notification')] },
  ]);
});

test('replaces a Project Mixer-only entry without accumulating duplicates', () => {
  const result = upsertProjectMixerHook([
    { matcher: '', hooks: [{ type: 'command', command: 'node project-mixer-hook.cjs' }] },
  ], pmHook('Stop'));

  assert.deepEqual(result, [
    { matcher: '', hooks: [pmHook('Stop')] },
  ]);
});

test('preserves hooks with a different path that contains the PM filename', () => {
  const foreignHook = { type: 'command', command: 'node other-project-mixer-hook.cjs Stop' };
  const result = upsertProjectMixerHook([
    { matcher: '', hooks: [foreignHook] },
  ], pmHook('Stop'));
  assert.deepEqual(result, [
    { matcher: '', hooks: [foreignHook] },
    { matcher: '', hooks: [pmHook('Stop')] },
  ]);
});

test('matches only the configured absolute PM hook path', () => {
  const hookPath = '/work/project/.claude/project-mixer-hook.cjs';
  const foreignHook = { type: 'command', command: `node "/work/other/.claude/project-mixer-hook.cjs" Stop` };
  const result = upsertProjectMixerHook([
    { matcher: '', hooks: [foreignHook] },
  ], { type: 'command', command: `node "${hookPath}" Stop` }, hookPath);
  assert.deepEqual(result[0].hooks, [foreignHook]);
});
test('rejects an invalid hook collection instead of overwriting it', () => {
  assert.throws(
    () => upsertProjectMixerHook({ matcher: '' }, pmHook('Stop')),
    /must be an array/,
  );
});
