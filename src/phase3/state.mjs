function isWindowsPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value || '') || String(value || '').includes('\\');
}

export function normalizeComparablePath(value) {
  if (typeof value !== 'string' || value.length === 0) return '';

  const windows = isWindowsPath(value);
  const raw = value.replace(/\\/g, '/');
  const prefix = raw.startsWith('/') ? '/' : '';
  const parts = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!prefix) parts.push(part);
      continue;
    }
    parts.push(part);
  }

  let normalized = prefix + parts.join('/');
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  return windows ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function isPathInsideProject(filePath, projectPath) {
  const file = normalizeComparablePath(filePath);
  const project = normalizeComparablePath(projectPath);
  return !!file && !!project && (file === project || file.startsWith(`${project}/`));
}

export function findOwningProject(projectEntries, filePath) {
  let best = null;
  let bestLength = -1;
  for (const [id, project] of projectEntries) {
    if (!project || !isPathInsideProject(filePath, project.path)) continue;
    const length = normalizeComparablePath(project.path).length;
    if (length > bestLength) {
      best = { id, project };
      bestLength = length;
    }
  }
  return best;
}

export function makePreviewPath(projectId, filePath, uniqueId = null) {
  const base = `preview:${projectId}:${filePath}`;
  return uniqueId === null || uniqueId === undefined ? base : `${base}:agent:${uniqueId}`;
}

export function decidePreviewActivation({
  sameProject,
  activeSurface,
  activePreviewPath,
  requestedPreviewPath,
  newTab = false,
}) {
  if (!sameProject) return { activate: false, preserveAttention: false, reason: 'different-project' };
  const requestedAlreadyVisible = !newTab && activePreviewPath === requestedPreviewPath;
  if (activeSurface === 'preview' && activePreviewPath && !requestedAlreadyVisible) {
    return { activate: false, preserveAttention: false, reason: 'human-on-other-preview' };
  }
  return {
    activate: true,
    preserveAttention: activeSurface !== 'preview',
    reason: requestedAlreadyVisible ? 'already-visible' : 'show-without-focus-steal',
  };
}

export function resolveAttentionFile(state, previewFiles) {
  if (!state?.activeFilePath) return { filePath: null, isPreview: false };
  if (!state.isPreview) return { filePath: state.activeFilePath, isPreview: false };
  const preview = previewFiles.get(state.activeFilePath);
  return { filePath: preview?.path || null, isPreview: true };
}

export function clampLineRange(line, endLine, lineCount) {
  const count = Math.max(1, Number(lineCount) || 1);
  const start = Math.min(count, Math.max(1, Math.trunc(Number(line) || 1)));
  const end = Math.min(count, Math.max(start, Math.trunc(Number(endLine) || start)));
  return { start, end };
}
