// src/mcp/server.cjs
// MCP server with SSE transport.
// Runs in the main process alongside the hook server.
// Uses Phase 0.2's port discovery mechanism.

const http = require('http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');

function createMcpServer(getFocus) {
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
      const focus = await getFocus();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(focus, null, 2),
        }],
      };
    }
  );

  return mcpServer;
}

/**
 * Start the MCP server with SSE transport.
 * @param {number} basePort - Base port to try
 * @param {function} getFocus - Returns the focus state from the renderer
 * @param {function} onReady - Called with (port) when listening
 */
function startMcpServer(basePort, getFocus, onReady) {

  // SSE transport: one transport per connection, stored by session ID
  const transports = new Map();

  let currentPort = basePort;
  const maxRetries = 20;
  let retryCount = 0;

  function tryListen(port) {
    const httpServer = http.createServer(async (req, res) => {
      // --- Security: Origin / Host validation (MCP spec requirement) ---
      // Prevent DNS rebinding and cross-origin access from arbitrary web pages.
      // Only allow requests targeting localhost (the MCP client runs locally).
      const reqHost = req.headers['host'] || '';
      const allowedHosts = new Set([
        `127.0.0.1:${port}`,
        `localhost:${port}`,
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

      // SSE endpoint: GET /sse — opens the event stream
      if (req.method === 'GET' && req.url.split('?')[0] === '/sse') {
        const transport = new SSEServerTransport('/messages', res);
        const mcpServer = createMcpServer(getFocus);
        const sessionId = transport.sessionId;
        transports.set(sessionId, { transport, mcpServer });

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

      // Message endpoint: POST /messages?sessionId=xxx
      if (req.method === 'POST' && req.url.split('?')[0] === '/messages') {
        const url = new URL(req.url, 'http://127.0.0.1');
        const sessionId = url.searchParams.get('sessionId');
        const session = transports.get(sessionId);
        if (!session) {
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

    httpServer.listen(port, '127.0.0.1');
    httpServer.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && retryCount < maxRetries) {
        retryCount++;
        currentPort = port + 1;
        tryListen(currentPort);
      } else if (e.code === 'EADDRINUSE') {
        console.error(`[MCP] No available port after ${maxRetries} retries from ${basePort}.`);
      } else {
        console.error('[MCP] Server error:', e);
      }
    });
    httpServer.on('listening', () => {
      const actualPort = httpServer.address().port;
      console.log(`[MCP] SSE server listening on http://127.0.0.1:${actualPort}/sse`);
      if (onReady) onReady(actualPort);
    });
  }

  tryListen(basePort);
}

module.exports = { createMcpServer, startMcpServer };
