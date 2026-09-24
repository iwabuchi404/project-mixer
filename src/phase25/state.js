export const INTERNAL_FILE_MIME = 'application/x-project-mixer-file-path';

const OS_ONLY_EXTENSIONS = new Set([
  '.7z', '.avi', '.bin', '.class', '.db', '.dll', '.doc', '.docx', '.exe',
  '.flac', '.gz', '.jar', '.mkv', '.mov', '.mp3', '.mp4', '.msi', '.otf',
  '.pdf', '.ppt', '.pptx', '.rar', '.sqlite', '.tar', '.ttf', '.wasm',
  '.wav', '.woff', '.woff2', '.xls', '.xlsx', '.zip',
]);

export function shouldOpenInOsByName(name) {
  const dotIndex = name.lastIndexOf('.');
  const extension = dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : '';
  return OS_ONLY_EXTENSIONS.has(extension);
}

export function isTerminalPinnedToBottom(buffer) {
  return !!buffer && buffer.viewportY >= buffer.baseY;
}

export function captureTerminalFollowToken(state) {
  if (!state?.pinnedToBottom) return null;
  return state.outputFollowRevision ?? 0;
}

export function invalidateTerminalFollow(state) {
  if (!state) return;
  state.outputFollowRevision = (state.outputFollowRevision ?? 0) + 1;
}

export function updateTerminalScrollPosition(state, buffer) {
  if (!state) return false;
  if (!state.userScrollActive) return !!state.pinnedToBottom;
  const pinnedToBottom = isTerminalPinnedToBottom(buffer);
  state.pinnedToBottom = pinnedToBottom;
  return pinnedToBottom;
}

export function shouldFollowTerminalOutput(state, followToken) {
  return followToken !== null
    && !!state?.pinnedToBottom
    && (state.outputFollowRevision ?? 0) === followToken;
}

export function quotePathForCommand(filePath, command = '') {
  const normalizedCommand = String(command || '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');

  if (normalizedCommand === 'pwsh' || normalizedCommand === 'powershell') {
    return `'${filePath.replace(/'/g, "''")}'`;
  }

  if (normalizedCommand === 'cmd') {
    return `"${filePath}"`;
  }

  if (['bash', 'zsh', 'sh', 'wsl'].includes(normalizedCommand)) {
    return `'${filePath.replace(/'/g, `'\\''`)}'`;
  }

  return /\s/.test(filePath) ? `"${filePath}"` : filePath;
}

export function resolveTerminalDropTarget(eventTarget, panes, tabs) {
  const paneElement = eventTarget?.closest?.('.terminal-pane-item');
  const terminalElement = eventTarget?.closest?.('.terminal-instance');
  if (!paneElement || !terminalElement) return null;

  const paneId = Number(paneElement.dataset.paneId);
  const pane = panes.find((candidate) => candidate.id === paneId);
  const tabId = pane?.activeTabId;
  const terminal = tabs.get(tabId);
  if (!terminal || !terminal.termEl.contains(eventTarget)) return null;
  return { paneId, tabId, terminal };
}

export function captureExpandedPaneWidth({ isCollapsed, measuredWidth, savedWidth }) {
  if (isCollapsed || !Number.isFinite(measuredWidth) || measuredWidth <= 0) {
    return savedWidth;
  }
  return measuredWidth;
}

export function getEditorSurfaceKind(file) {
  return file?.isScratch ? 'scratch' : 'main';
}
