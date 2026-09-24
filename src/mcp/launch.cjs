function normalizeCommandName(command) {
  return String(command || '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

function buildAgentMcpArgs(command, mcpUrl) {
  if (!mcpUrl) return [];
  const name = normalizeCommandName(command);
  if (name === 'claude') {
    return [
      '--mcp-config',
      JSON.stringify({
        mcpServers: {
          'project-mixer': { type: 'sse', url: mcpUrl },
        },
      }),
    ];
  }
  if (name === 'codex') {
    const escapedUrl = mcpUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return ['-c', `mcp_servers.project_mixer.url="${escapedUrl}"`];
  }
  return [];
}

function quotePowerShellArgument(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildPowerShellInvocation(command, args) {
  return `& ${[command, ...args].map(quotePowerShellArgument).join(' ')}`;
}

module.exports = { buildAgentMcpArgs, buildPowerShellInvocation, normalizeCommandName };
