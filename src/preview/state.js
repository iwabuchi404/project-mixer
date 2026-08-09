export function isPreviewForProject(preview, projectId) {
  return !!preview && preview.projectId === projectId;
}

export function getPreviewForProject(previewFiles, projectId, preferredPath = null) {
  if (preferredPath) {
    const preferred = previewFiles.get(preferredPath);
    if (isPreviewForProject(preferred, projectId)) {
      return preferredPath;
    }
  }

  for (const [path, preview] of previewFiles) {
    if (isPreviewForProject(preview, projectId)) {
      return path;
    }
  }
  return null;
}

export function getNextPreviewForProject(previewFiles, projectId, excludedPath) {
  for (const [path, preview] of previewFiles) {
    if (path !== excludedPath && isPreviewForProject(preview, projectId)) {
      return path;
    }
  }
  return null;
}

export function calculatePreviewWidth({
  startPreviewWidth,
  delta,
  availableWidth,
  minMain,
  minPreview,
}) {
  const maxPreviewWidth = Math.max(minPreview, availableWidth - minMain);
  return Math.max(minPreview, Math.min(startPreviewWidth - delta, maxPreviewWidth));
}
