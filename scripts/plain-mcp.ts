// A bare MCP client: plain fetch and JSON-RPC over Streamable HTTP, no SDK. The video's terminal beat runs
// it against the same server the host uses.
//
//   node --no-warnings video/src/plain-mcp.ts http://127.0.0.1:8701/mcp
//   FIXWRIGHT_TOKEN=hh_... selects a household (Authorization: Bearer); without it the server uses its
//   shared demo household.
//
// Prints one line per request ("> method") and per answer ("< ..."), long JSON cut with a byte count.

const PROTOCOL = '2025-11-25';

export interface RpcResult {
  status: number;
  body: { result?: Record<string, unknown>; error?: { code: number; message: string } } | null;
  raw: string;
}

/** Streamable HTTP answers either application/json or an SSE stream; take the JSON-RPC message from either. */
export function parseRpcBody(contentType: string, text: string): RpcResult['body'] {
  if (contentType.includes('text/event-stream')) {
    const data = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    for (const d of data) {
      const msg = JSON.parse(d) as RpcResult['body'];
      if (msg && ('result' in msg || 'error' in msg)) return msg;
    }
    return null;
  }
  return text ? (JSON.parse(text) as RpcResult['body']) : null;
}

export function cut(s: string, max: number): string {
  const bytes = new TextEncoder().encode(s).length;
  return s.length <= max ? s : `${s.slice(0, max)}… (${bytes} bytes)`;
}

export function maskToken(token: string): string {
  return token.length > 12 ? `${token.slice(0, 7)}…${token.slice(-4)}` : token;
}

async function main(): Promise<void> {
  const url = process.argv[2] ?? 'http://127.0.0.1:8701/mcp';
  const token = process.env['FIXWRIGHT_TOKEN'];
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> | undefined, notify = false): Promise<RpcResult> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL,
    };
    if (token) headers['authorization'] = `Bearer ${token}`;
    const msg = notify ? { jsonrpc: '2.0', method, ...(params ? { params } : {}) } : { jsonrpc: '2.0', id: id++, method, ...(params ? { params } : {}) };
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(msg), signal: AbortSignal.timeout(15_000) });
    const raw = await r.text();
    return { status: r.status, body: notify ? null : parseRpcBody(r.headers.get('content-type') ?? '', raw), raw };
  };
  const fail = (what: string, r: RpcResult): never => {
    console.log(`< ${r.status} ${what} failed: ${cut(r.raw, 200)}`);
    process.exit(1);
  };

  if (token) console.log(`# household ${maskToken(token)} (from FIXWRIGHT_TOKEN)`);
  console.log(`> initialize  protocolVersion ${PROTOCOL}`);
  const init = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'plain-mcp', version: '1.0.0' } });
  if (!init.body?.result) fail('initialize', init);
  const ir = init.body?.result ?? {};
  console.log(`< ${init.status} ${cut(JSON.stringify({ protocolVersion: ir['protocolVersion'], serverInfo: ir['serverInfo'], capabilities: ir['capabilities'] }), 230)}`);
  await rpc('notifications/initialized', undefined, true);

  console.log('> tools/list');
  const list = await rpc('tools/list', {});
  const tools = (list.body?.result?.['tools'] as Array<{ name: string }> | undefined) ?? fail('tools/list', list);
  console.log(`< ${list.status} ${tools.length} tools (${new TextEncoder().encode(list.raw).length} bytes): ${tools.map((t) => t.name).join(', ')}`);

  const args = { symptom: "keeps saying it's not responding", device: 'hallway lamp' };
  console.log(`> tools/call diagnose ${JSON.stringify(args)}`);
  const call = await rpc('tools/call', { name: 'diagnose', arguments: args });
  const res = call.body?.result ?? fail('tools/call', call);
  const sc = (res['structuredContent'] ?? {}) as Record<string, unknown>;
  const text = ((res['content'] as Array<{ type: string; text?: string }> | undefined) ?? []).find((c) => c.type === 'text')?.text ?? '';
  console.log(`< ${call.status} content[0].text: ${JSON.stringify(text)}`);
  const hyps = ((sc['hypotheses'] as Array<{ cause_id: string; p: number }> | undefined) ?? []).map((h) => ({ cause_id: h.cause_id, p: h.p }));
  const excerpt = { status: sc['status'], view: sc['view'], hypotheses: hyps, question: (sc['question'] as { text?: string } | undefined)?.text };
  console.log(`  structuredContent, ${Object.keys(excerpt).length} of ${Object.keys(sc).length} fields: ${cut(JSON.stringify(excerpt), 330)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
