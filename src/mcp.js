// MCP over Streamable HTTP, stateless: each POST is JSON-RPC and gets a JSON reply.
// Same tools and the same agent identity as the REST API.
const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function handleMcp(body, { listTools, callTool, instructions }) {
  const batch = Array.isArray(body);
  const out = [];
  for (const m of batch ? body : [body]) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') { out.push(err(m?.id ?? null, -32600, 'Invalid request')); continue; }
    if (m.id === undefined || m.id === null) continue;   // notifications
    const p = m.params || {};
    if (m.method === 'initialize') out.push(ok(m.id, { protocolVersion: VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : VERSIONS[0],
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'hyperplex', version: '1.0.0' }, instructions }));
    else if (m.method === 'ping') out.push(ok(m.id, {}));
    else if (m.method === 'tools/list') out.push(ok(m.id, { tools: (await listTools()).map(t => ({ name: t.name, description: t.description, inputSchema: t.input,
      annotations: { readOnlyHint: !!t.readOnly, openWorldHint: true } })) }));
    else if (m.method === 'tools/call') {
      try {
        const r = await callTool(p.name, p.arguments || {});
        out.push(ok(m.id, { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) }],
          ...(r && typeof r === 'object' && !Array.isArray(r) ? { structuredContent: r } : {}), isError: false }));
      } catch (e) {
        out.push(ok(m.id, { content: [{ type: 'text', text: e.message + (e.details ? `\n${JSON.stringify(e.details)}` : '') }], isError: true }));
      }
    } else out.push(err(m.id, -32601, `Method not found: ${m.method}`));
  }
  if (!out.length) return null;
  return batch ? out : out[0];
}
