// src/main/integration-probe.cjs
// What can this specific agent session actually be observed through?
//
// WHY THIS IS PROBED, NOT DECLARED
// An earlier draft of the plan carried integration capability as a static
// field per provider:
//
//   integration: { lifecycle: 'hook' | 'plugin' | 'pty', ... }
//
// Measured, that is wrong. The same binary on the same machine behaves
// differently depending on configuration:
//
//   codex  `notify` is a SINGLE-VALUE slot in ~/.codex/config.toml. On this
//          machine it already belongs to the Codex Desktop computer-use
//          integration, so hook:setup refuses to touch it and codex has no
//          usable native lifecycle channel at all. On a machine where the
//          slot is free it does.
//   claude hooks are installed PER PROJECT by hook:setup. A project that has
//          never been opened in Project Mixer has no hook file, so a claude
//          session there is observation-only even though claude "supports"
//          hooks.
//   opencode the plugin is likewise a per-project file under
//          .opencode/plugins/.
//
// So capability is a property of (provider, project, machine config, this
// session) and has to be measured at session start. Declaring it per
// provider would produce exactly the failure the plan is trying to avoid:
// codex and devin being treated as if they had native events, then silently
// depending on PTY scraping with no record that they do.
//
// WHAT IS PROBED
//   protocol  does an MCP transport exist for this session? Observable: the
//             SSE server holds a live transport per token.
//   lifecycle is a native channel wired up RIGHT NOW for this session?
//               hook      .claude/settings.local.json carries our entry
//               plugin    .opencode/plugins/project-mixer.js exists
//               notify    ~/.codex/config.toml notify is OUR wrapper
//   pty       always true. It is the floor, never an option.
//
// completion / waiting are then DERIVED, not probed, because they are
// consequences of the above rather than separate facts.

const fs = require('fs');
const path = require('path');
const os = require('os');

const NATIVE_LIFECYCLE = Object.freeze(['hook', 'plugin', 'notify', 'pty']);

// Providers that can carry a Project Mixer MCP connection at all. Anything
// else is protocol 'none' by construction, not by observation.
const MCP_CAPABLE = Object.freeze(['claude', 'codex', 'opencode', 'devin']);

const HOOK_MARKER = 'project-mixer-hook.cjs';
const PLUGIN_MARKER = 'project-mixer.js';
const NOTIFY_MARKER = 'project-mixer-notify.cjs';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

// True when our hook command is present in the project's claude settings.
// Checks the recorded command string rather than only the key, because a
// project may have other Notification hooks and a bare key check would claim
// capability it does not have.
function hasClaudeHook(projectRoot) {
  const settings = readJson(path.join(projectRoot, '.claude', 'settings.local.json'));
  if (!settings || typeof settings !== 'object') return false;
  for (const group of ['Notification', 'Stop', 'UserPromptSubmit']) {
    const entries = settings.hooks?.[group];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const hook of entry?.hooks || []) {
        if (typeof hook?.command === 'string' && hook.command.includes(HOOK_MARKER)) return true;
      }
    }
  }
  return false;
}

function hasOpencodePlugin(projectRoot) {
  const plugin = path.join(projectRoot, '.opencode', 'plugins', PLUGIN_MARKER);
  try {
    return fs.statSync(plugin).isFile();
  } catch {
    return false;
  }
}

// codex notify is a single global slot. It counts as a native channel only
// when it points at OUR wrapper; a foreign notify (measured on this machine:
// the Codex Desktop computer-use integration) means codex is observation-only
// and must be recorded as such rather than assumed capable.
function hasCodexNotify(homeDir = os.homedir()) {
  const config = path.join(homeDir, '.codex', 'config.toml');
  let text;
  try {
    text = fs.readFileSync(config, 'utf-8');
  } catch {
    return false;
  }
  const match = text.match(/^\s*"?notify"?\s*=\s*(.+)$/m);
  return Boolean(match && match[1].includes(NOTIFY_MARKER));
}

/**
 * Probe one session.
 *
 * @param {object} input
 * @param {string} input.command      the terminal's command (basename ok)
 * @param {string|null} input.projectRoot  absolute project path, if any
 * @param {boolean} input.mcpConnected      a live SSE transport exists
 * @param {boolean} input.managed           Project Mixer injected a task contract
 * @param {string|null} input.homeDir       injectable for tests
 * @returns {{provider: string, protocol: string, lifecycle: string,
 *            completion: string, waiting: string, managed: boolean,
 *            ptyObservation: boolean, notes: string[]}}
 */
function probeIntegration({
  command, projectRoot = null, mcpConnected = false, managed = false, homeDir,
} = {}) {
  const provider = String(command || '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  const notes = [];

  const protocol = MCP_CAPABLE.includes(provider) ? 'mcp' : 'none';
  const mcpReady = protocol === 'mcp' && mcpConnected;
  if (protocol === 'mcp' && !mcpConnected) {
    notes.push('this provider can speak the Project Mixer protocol but has not connected');
  }

  let lifecycle = 'pty';
  if (provider === 'claude' && projectRoot && hasClaudeHook(projectRoot)) {
    lifecycle = 'hook';
  } else if (provider === 'opencode' && projectRoot && hasOpencodePlugin(projectRoot)) {
    lifecycle = 'plugin';
  } else if (provider === 'codex' && hasCodexNotify(homeDir)) {
    lifecycle = 'notify';
  }

  if (lifecycle === 'pty') {
    notes.push(provider === 'codex'
      ? 'codex notify is a single global slot and is not pointing at the Project Mixer wrapper'
      : `no native channel is wired up for ${provider} in this project`);
  }

  // `explicit` means there is a channel where this agent reports its own
  // completion or waiting state WITHOUT the human or a wrapper asking first.
  //
  // A connected MCP transport deliberately does NOT promote this. An agent can
  // call complete_task, but only if something told it to; an MCP connection
  // proves the channel exists, not that anything uses it. This is the
  // distinction between observing an existing agent and managing one as a
  // delegated sub-agent -- the plan's "既存Agentを観測する場合" versus
  // "Mixer管理下のsub-agent". Claiming `explicit` for a connected-but-unmanaged
  // devin session would promise reliable completion it does not provide.
  //
  // `managed` is the Delegation path: Project Mixer injected a task contract,
  // so the agent knows it must call complete_task. Only then is explicit right.
// `managed` only counts when the protocol is actually reachable: a contract in
  // a prompt is worthless if the agent cannot call back.
  const explicit = lifecycle !== 'pty' || (managed === true && mcpReady);
  if (mcpReady && !managed) {
    notes.push('MCP is connected but this session was not given a task contract, '
      + 'so completion still has to be observed');
  }

  return {
    provider,
    protocol: mcpReady ? 'mcp' : 'none',
    lifecycle,
    completion: explicit ? 'explicit' : 'observed',
    waiting: explicit ? 'explicit' : 'observed',
    managed: managed === true,
    // Always true. It is the reason the other two columns exist, and removing
    // it would make a codex session on this machine completely silent.
    ptyObservation: true,
    notes,
  };
}

module.exports = {
  probeIntegration,
  hasClaudeHook,
  hasOpencodePlugin,
  hasCodexNotify,
  MCP_CAPABLE,
  NATIVE_LIFECYCLE,
};