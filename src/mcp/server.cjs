// src/mcp/server.cjs
// MCP server with SSE transport.
// Runs in the main process alongside the hook server.
// Uses Phase 0.2's port discovery mechanism.

const http = require('http');
const crypto = require('crypto');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');

function createMcpServer(dispatchToRenderer, sessionContext = null) {
  const mcpServer = new McpServer({
    name: 'project-mixer',
    version: '0.1.0',
  });

  // Register get_focus tool
  mcpServer.tool(
    'get_focus',
    'Returns what the human is currently looking at in Project Mixer: ' +
    'active project, open file (with cursor position and selection), ' +
    'active terminal tab, and scratch content.',
    {},
    async () => {
      const focus = await dispatchToRenderer('get_focus', {}, sessionContext);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(focus, null, 2),
        }],
      };
    }
  );

  // 3.4 show_file: open a file in the human's preview area
  mcpServer.tool(
    'show_file',
    'Open a file in the human\'s preview area so they can see what you\'re ' +
    'referring to. If the human is viewing the same project, the file opens ' +
    'in the preview pane. If the file is in a different project, a badge ' +
    'appears on that project in the sidebar (the project does NOT switch). ' +
    'Returns { shown: boolean, reason: string }.',
    {
      path: z.string().describe('Absolute path to the file to show'),
      reason: z.string().optional().describe('Short label for why you\'re showing this (e.g. "fixing typo here")'),
      line: z.number().int().positive().optional().describe('Line number to scroll to (1-based)'),
      endLine: z.number().int().positive().optional().describe('End of line range to highlight'),
      new_tab: z.boolean().optional().describe('Force a new tab instead of reusing existing (default: false)'),
    },
    async ({ path, reason, line, endLine, new_tab }) => {
      const result = await dispatchToRenderer(
        'preview_open',
        { path, reason, newTab: new_tab },
        sessionContext,
      );
      if (result?.shown && line) {
        const reveal = await dispatchToRenderer(
          'preview_reveal',
          { previewPath: result.previewPath, line, endLine },
          sessionContext,
        );
        if (!reveal?.revealed) {
          result.shown = false;
          result.reason = `${result.reason}; requested line was not revealed`;
        }
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  return mcpServer;
}

/**
 * Start the MCP server with SSE transport.
 * @param {number} basePort - Base port to try
 * @param {function} dispatchToRenderer - (commandName, args) => Promise<any>
 * @param {function} onReady - Called with (port) when listening
 * @param {function} onFailed - Called if no local port can be opened
 */
function startMcpServer(basePort, dispatchToRenderer, onReady, onFailed) {

  // SSE transport: one transport per connection, stored by session ID
  const transports = new Map();
  const sessionTokens = new Map();
  const httpServers = new Set();
  let listeningPort = null;

  function registerSession(context) {
    const token = crypto.randomBytes(32).toString('base64url');
    sessionTokens.set(token, Object.freeze({ ...context }));
    return token;
  }

  async function revokeSession(token) {
    sessionTokens.delete(token);
    const closing = [];
    for (const [sessionId, session] of transports) {
      if (session.token !== token) continue;
      transports.delete(sessionId);
      closing.push(session.transport.close().catch(() => {}));
    }
    await Promise.all(closing);
  }

  let currentPort = basePort;
  const maxRetries = 20;
  let retryCount = 0;

  function tryListen(port) {
    const httpServer = http.createServer(async (req, res) => {
      // --- Security: Origin / Host validation (MCP spec requirement) ---
      // Prevent DNS rebinding and cross-origin access from arbitrary web pages.
      // Only allow requests targeting localhost (the MCP client runs locally).
      const reqHost = req.headers['host'] || '';
      const boundPort = httpServer.address()?.port || port;
      const allowedHosts = new Set([
        `127.0.0.1:${boundPort}`,
        `localhost:${boundPort}`,
      ]);
      if (!allowedHosts.has(reqHost)) {
        res.writeHead(403);
        res.end();
        return;
      }

      // Reject requests with an Origin header from a browser page
      // (MCP clients don't send Origin; browsers do).
      const origin = req.headers['origin'];
      if (origin) {
        try {
          const u = new URL(origin);
          // Only allow localhost origins
          if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
            res.writeHead(403);
            res.end();
            return;
          }
        } catch {
          res.writeHead(403);
          res.end();
          return;
        }
      }

      // Health check
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', server: 'project-mixer-mcp' }));
        return;
      }

      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      const sseMatch = requestUrl.pathname.match(/^\/s\/([A-Za-z0-9_-]+)$/);
      const messageMatch = requestUrl.pathname.match(/^\/messages\/([A-Za-z0-9_-]+)$/);

      // One unguessable URL per PTY. A transport is permanently bound to the
      // token and project/session context used to open it.
      if (req.method === 'GET' && sseMatch) {
        const token = sseMatch[1];
        const sessionContext = sessionTokens.get(token);
        if (!sessionContext) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or expired MCP session' }));
          return;
        }
        const transport = new SSEServerTransport(`/messages/${token}`, res);
        const mcpServer = createMcpServer(dispatchToRenderer, sessionContext);
        const sessionId = transport.sessionId;
        transports.set(sessionId, { transport, mcpServer, token });

        try {
          await mcpServer.connect(transport);
        } catch (error) {
          transports.delete(sessionId);
          console.error('[MCP] Failed to open SSE session:', error);
          if (!res.headersSent) {
            res.writeHead(500);
          }
          res.end();
          return;
        }

        res.on('close', () => {
          transports.delete(sessionId);
        });
        return;
      }

      // Message endpoint: POST /messages/<token>?sessionId=xxx
      if (req.method === 'POST' && messageMatch) {
        const token = messageMatch[1];
        if (!sessionTokens.has(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or expired MCP session' }));
          return;
        }
        const sessionId = requestUrl.searchParams.get('sessionId');
        const session = transports.get(sessionId);
        if (!session || session.token !== token) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No transport found for sessionId' }));
          return;
        }
        try {
          await session.transport.handlePostMessage(req, res);
        } catch (error) {
          console.error('[MCP] Failed to handle message:', error);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to handle MCP message' }));
          } else {
            res.end();
          }
        }
        return;
      }

      res.writeHead(404);
      res.end();
    });

    httpServers.add(httpServer);
    httpServer.listen(port, '127.0.0.1');
    httpServer.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && retryCount < maxRetries) {
        httpServers.delete(httpServer);
        retryCount++;
        currentPort = port + 1;
        tryListen(currentPort);
      } else if (e.code === 'EADDRINUSE') {
        console.error(`[MCP] No available port after ${maxRetries} retries from ${basePort}.`);
        if (onFailed) onFailed(e);
      } else {
        console.error('[MCP] Server error:', e);
        if (onFailed) onFailed(e);
      }
    });
    httpServer.on('listening', () => {
      const actualPort = httpServer.address().port;
      listeningPort = actualPort;
      console.log(`[MCP] SSE server listening on http://127.0.0.1:${actualPort}`);
      if (onReady) onReady(actualPort);
    });
  }

  tryListen(basePort);
  return {
    registerSession,
    revokeSession,
    getPort: () => listeningPort,
    hasSession: (token) => sessionTokens.has(token),
    close: async () => {
      const closingTransports = Array.from(
        transports.values(),
        (session) => session.transport.close().catch(() => {}),
      );
      transports.clear();
      sessionTokens.clear();
      await Promise.all(closingTransports);
      await Promise.all(Array.from(httpServers, (server) => new Promise((resolve) => server.close(resolve))));
      httpServers.clear();
    },
  };
}

module.exports = { createMcpServer, startMcpServer };
