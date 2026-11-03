// Call Context Mixer MCP (Streamable HTTP) with the stored OAuth token.
import fs from 'node:fs';
import path from 'node:path';
const token = fs.readFileSync(path.join(process.env.TEMP, 'cm-token.txt'), 'utf8').trim();
const url = 'https://context-mixer.frog404.work/mcp';

async function rpc(sessionId, body) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  const text = await res.text();
  let data = null;
  // Streamable HTTP may answer with SSE framing.
  if (text.startsWith('event:') || text.includes('data:')) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) { try { data = JSON.parse(line.slice(5).trim()); } catch {} }
    }
  } else if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: res.status, sessionId: sid || sessionId, data };
}

async function main() {
  let session = null;
  const init = await rpc(null, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'project-mixer-dev', version: '0.0.1' },
    },
  });
  console.log('init:', init.status, init.data?.result?.serverInfo?.name || JSON.stringify(init.data).slice(0, 200));
  session = init.sessionId;

  const query = process.argv[2] || 'マルチペイン';
  const search = await rpc(session, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'search_docs', arguments: { q: query } },
  });
  const content = search.data?.result?.content;
  console.log('search results for', JSON.stringify(query), ':');
  if (content) for (const c of content) console.log(c.text?.slice(0, 600));
  else console.log(JSON.stringify(search.data).slice(0, 400));

  // fetch full doc
  const docId = process.argv[3];
  if (docId) {
    const doc = await rpc(session, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'get_doc', arguments: { id: docId, view: 'full' } },
    });
    const dc = doc.data?.result?.content;
    if (dc) {
      const full = dc.map((c) => c.text).join('\n');
      fs.writeFileSync(path.join(process.env.TEMP, 'multipane-doc.md'), full, 'utf8');
      console.log('doc written to', path.join(process.env.TEMP, 'multipane-doc.md'), 'length:', full.length);
    } else console.log('doc:', JSON.stringify(doc.data).slice(0, 300));
  }

  // notifications/initialized
  await rpc(session, { jsonrpc: '2.0', method: 'notifications/initialized' });
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
