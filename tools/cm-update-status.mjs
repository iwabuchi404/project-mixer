// Update the Context Mixer doc status (提案 → 確定) via MCP.
import fs from 'node:fs';
import path from 'node:path';
const token = fs.readFileSync(path.join(process.env.TEMP, 'cm-token.txt'), 'utf8').trim();
const url = 'https://context-mixer.frog404.work/mcp';
const docId = process.argv[2] || 'doc_1787641731144_vyxy45huu';
const tmpDoc = process.env.TEMP + '/multipane-doc.md';

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
  if (text.includes('data:')) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) { try { data = JSON.parse(line.slice(5).trim()); } catch {} }
    }
  } else if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: res.status, sessionId: sid || sessionId, data };
}

async function main() {
  const init = await rpc(null, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'project-mixer-dev', version: '0.0.1' } },
  });
  const session = init.sessionId;
  await rpc(session, { jsonrpc: '2.0', method: 'notifications/initialized' });

  // read current content, patch status line, write back
  const doc = await rpc(session, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'get_doc', arguments: { id: docId, view: 'full' } },
  });
  const dc = doc.data?.result?.content;
  const parsed = JSON.parse(dc[0].text);
  const updated = parsed.content.replace(
    '**作成日**: 2026-08-25 **状態**: 提案（未確定）',
    '**作成日**: 2026-08-25 **状態**: 確定（2026-08-25、ユーザー承認）',
  );
  if (updated === parsed.content) { console.log('status line not found — no change'); process.exit(0); }
  const write = await rpc(session, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'write_doc', arguments: { id: docId, title: parsed.title, content: updated } },
  });
  console.log('write:', JSON.stringify(write.data).slice(0, 200));
  process.exit(0);
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
