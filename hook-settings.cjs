function isProjectMixerHook(hook) {
  return Boolean(
    hook
    && typeof hook === 'object'
    && typeof hook.command === 'string'
    && hook.command.includes('project-mixer-hook')
  );
}

function upsertProjectMixerHook(entries, pmHookEntry) {
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

    const hooks = entry.hooks.filter((hook) => !isProjectMixerHook(hook));
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
