// src/files/search-command.cjs
// Builds search command arguments for git grep / rg.
// Extracted from main.js for testability (security boundary).

const path = require('path');

// Build the search command arguments for rg or git grep.
// Returns { cmd, args } or null if the command is not supported.
function buildSearchCommand(cmd, query, caseSensitive) {
  if (cmd === 'rg') {
    const args = ['--line-number', '--no-heading', '--color=never'];
    if (!caseSensitive) args.push('-i');
    // -e prevents queries starting with - from being treated as flags.
    args.push('-e', query, '.');
    return { cmd: 'rg', args };
  }
  if (cmd === 'git') {
    // --no-optional-locks prevents acquiring index.lock (D16 non-blocking rule).
    const args = ['--no-optional-locks', 'grep', '--untracked', '-n'];
    if (!caseSensitive) args.push('-i');
    // -e prevents queries starting with - from being treated as flags.
    args.push('-e', query);
    return { cmd: 'git', args };
  }
  return null;
}

// Parse a search output line into { file, line, text }.
// rg format: file:line:text
// git grep format: file:line:text (with -n flag)
function parseSearchLine(line, cwd) {
  // Try file:line:text format (both rg and git grep -n).
  const match = line.match(/^(.+?):(\d+):(.*)$/);
  if (match) {
    const [, file, lineNum, text] = match;
    return {
      file: resolveSearchPath(file, cwd),
      line: parseInt(lineNum, 10),
      text,
    };
  }
  // Fallback: file:text (git grep without -n, shouldn't happen but just in case).
  const fallback = line.match(/^(.+?):(.*)$/);
  if (fallback) {
    const [, file, text] = fallback;
    return {
      file: resolveSearchPath(file, cwd),
      line: 0,
      text,
    };
  }
  return null;
}

// Resolve a search result file path relative to the search cwd.
function resolveSearchPath(file, cwd) {
  if (path.isAbsolute(file)) return file;
  return path.resolve(cwd, file);
}

module.exports = { buildSearchCommand, parseSearchLine, resolveSearchPath };
