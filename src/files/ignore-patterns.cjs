// src/files/ignore-patterns.cjs
// Shared exclusion rules for file tree operations.
// Used by both fs:readDir (lazy tree) and fs:indexTree (filter index)
// to avoid divergence between the two views.

const TREE_IGNORE = new Set(['.git', 'node_modules']);

function isTreeIgnored(name) {
  return TREE_IGNORE.has(name);
}

module.exports = { TREE_IGNORE, isTreeIgnored };
