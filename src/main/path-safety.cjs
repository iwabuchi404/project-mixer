const fs = require('fs');
const path = require('path');

function assertPathString(value, label = 'path') {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${label} must be a non-empty path string`);
  }
  return path.resolve(value);
}

function realpathOrNearestExisting(value) {
  let current = assertPathString(value);
  const suffix = [];
  while (true) {
    try {
      const real = fs.realpathSync.native(current);
      return path.join(real, ...suffix);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      try {
        fs.lstatSync(current);
        throw error;
      } catch (lstatError) {
        if (lstatError === error) throw error;
        if (!['ENOENT', 'ENOTDIR'].includes(lstatError.code)) throw lstatError;
      }
      const parent = path.dirname(current);
      if (parent === current) return assertPathString(value);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isPathInside(root, target, { allowRoot = true } = {}) {
  const relative = path.relative(root, target);
  if (relative === '') return allowRoot;
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function realProjectRoots(projects) {
  const roots = [];
  for (const project of projects) {
    if (!project || typeof project.path !== 'string' || !project.path.trim()) continue;
    const root = assertPathString(project.path, 'project path');
    let realRoot;
    try {
      realRoot = fs.realpathSync.native(root);
    } catch {
      continue;
    }
    roots.push({ project, root: realRoot });
  }
  roots.sort((a, b) => b.root.length - a.root.length);
  return roots;
}

function resolveProjectPath(projects, value, {
  allowRoot = true,
  exactRoot = false,
  requireExisting = true,
  type = null,
} = {}) {
  const requested = assertPathString(value, 'project path');
  const target = requireExisting
    ? (() => {
      if (!fs.existsSync(requested)) throw new Error(`Path does not exist: ${requested}`);
      return fs.realpathSync.native(requested);
    })()
    : realpathOrNearestExisting(requested);
  const roots = realProjectRoots(projects);
  const match = roots.find(({ root }) => (
    isPathInside(root, target, { allowRoot: exactRoot ? true : allowRoot })
    && (!exactRoot || path.relative(root, target) === '')
  ));
  if (!match) throw new Error('Path is outside the configured project roots');
  if (type) {
    const stat = fs.statSync(target);
    if (type === 'file' && !stat.isFile()) throw new Error('Path is not a file');
    if (type === 'directory' && !stat.isDirectory()) throw new Error('Path is not a directory');
  }
  return { ...match, requested, target };
}

function resolveProjectRoot(projects, value) {
  return resolveProjectPath(projects, value, { exactRoot: true, requireExisting: true, type: 'directory' });
}

module.exports = {
  assertPathString,
  isPathInside,
  realpathOrNearestExisting,
  resolveProjectPath,
  resolveProjectRoot,
};
