// src/mcp/server.cjs
// MCP server with SSE transport.
// Runs in the main process alongside the hook server.
// Uses Phase 0.2's port discovery mechanism.

const http = require('http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');

/**
 * Start the MCP server with SSE transport.
 * @param {number} basePort - Base port to try
 * @param {function} getFocus - Returns the focus state from the renderer
 * @param {function} onReady - Called with (port) when listening
 */
function startMcpServer(basePort, getFocus, onReady) {
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

  // SSE transport: one transport per connection, stored by session ID
  const transports = new Map();

  let currentPort = basePort;
  const maxRetries = 20;
  let retryCount = 0;

  function tryListen(port) {
    const httpServer = http.createServer(async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
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
        const sessionId = transport.sessionId;
        transports.set(sessionId, transport);

        await mcpServer.connect(transport);

        res.on('close', () => {
          transports.delete(sessionId);
        });
        return;
      }

      // Message endpoint: POST /messages?sessionId=xxx
      if (req.method === 'POST' && req.url.split('?')[0] === '/messages') {
        const url = new URL(req.url, 'http://127.0.0.1');
        const sessionId = url.searchParams.get('sessionId');
        const transport = transports.get(sessionId);
        if (!transport) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No transport found for sessionId' }));
          return;
        }
        await transport.handlePostMessage(req, res);
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

module.exports = { startMcpServer };
