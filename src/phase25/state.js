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

export function quotePathForCommand(filePath, command = '') {
  const normalizedCommand = command.toLowerCase().replace(/\.exe$/, '');

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

export function captureExpandedPaneWidth({ isCollapsed, measuredWidth, savedWidth }) {
  if (isCollapsed || !Number.isFinite(measuredWidth) || measuredWidth <= 0) {
    return savedWidth;
  }
  return measuredWidth;
}

export function getEditorSurfaceKind(file) {
  return file?.isScratch ? 'scratch' : 'main';
}
