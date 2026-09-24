function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isProjectMixerHook(hook, hookPath) {
  if (!hook || typeof hook !== 'object' || typeof hook.command !== 'string') return false;
  const expectedPath = hookPath || 'project-mixer-hook.cjs';
  const pattern = new RegExp(`(?:^|["'\\s])${escapeRegExp(expectedPath)}(?=["'\\s]|$)`);
  return pattern.test(hook.command);
}

function upsertProjectMixerHook(entries, pmHookEntry, hookPath) {
  if (entries === undefined) {
    return [{ matcher: '', hooks: [pmHookEntry] }];
  }
  if (!Array.isArray(entries)) {
    throw new TypeError('Hook configuration must be an array');
  }

  const preservedEntries = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) {
      preservedEntries.push(entry);
      continue;
    }

    const hooks = entry.hooks.filter((hook) => !isProjectMixerHook(hook, hookPath));
    if (hooks.length === entry.hooks.length) {
      preservedEntries.push(entry);
    } else if (hooks.length > 0) {
      preservedEntries.push({ ...entry, hooks });
    }
  }

  preservedEntries.push({ matcher: '', hooks: [pmHookEntry] });
  return preservedEntries;
}

module.exports = { upsertProjectMixerHook };
