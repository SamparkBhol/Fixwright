// The Worker's request pipeline, runtime neutral (the Node CPU harness drives it with in process
// households): host check, CORS, per IP rate limit, body cap, then the route.

import type { McpHttpHandler } from '@modelcontextprotocol/server';
import { TOOL_NAMES, problemOutput, protocolError, type ToolInputMap, type ToolName } from '@fixwright/protocol';
import { routeBody } from './assistant.ts';
import type { TakeResult } from './bucket.ts';
import type { Config } from './env.ts';
import { corsHeaders, decideOrigin, preflight, withHeaders } from './http/cors.ts';
import { checkHaUrl, isLoopbackHost } from './http/ha-url.ts';
import { bearer, clientIp, hostAllowed, json, MAX_BATCH_MESSAGES, parseObject, readBody, rpcError } from './http/guards.ts';
import { clockLabel } from './household/clock.ts';
import type { DemoOp, DemoReply } from './household/household.ts';
import type { ToolReply } from './household/tools.ts';
import { issueHouseholdToken, PUBLIC_HOUSEHOLD, verifyHouseholdToken } from './lib/crypto.ts';
import { makeMcpHandler, type ToolPort } from './mcp/server.ts';
import { PROTOCOL_VERSION, VERSION } from './version.ts';

const MCP_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fixwright MCP server</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:12vh auto;padding:0 20px;color:#1C2228;background:#EEF2F1;line-height:1.5}a{color:#1C2228}code{background:#fff;padding:2px 6px;border-radius:6px}</style></head><body><h1>Fixwright MCP server</h1><p>This address is the live MCP endpoint (spec 2025-11-25, Streamable HTTP). Alexa+ and other MCP clients talk to it with POST requests, so there is nothing to see here in a browser.</p><p>To try Fixwright, open the <a href="/">live demo</a>.</p><p>To call it from code, point any MCP client at <code>/mcp</code> on this host.</p></body></html>`;

export interface Platform {
  tool<N extends ToolName>(household: string, name: N, input: ToolInputMap[N]): Promise<ToolReply>;
  demo(household: string, op: DemoOp): Promise<DemoReply>;
  /** Takes `cost` tokens (default 1) from the caller's bucket. */
  take(ip: string, bucket: 'mcp' | 'demo', perMinute: number, cost?: number): Promise<TakeResult>;
  assets(request: Request): Promise<Response>;
}

const API = /^\/(mcp|health|demo\/[a-z-]+|assistant\/route)$/;

export function createApp(platform: Platform, cfgOf: () => Config): (request: Request) => Promise<Response> {
  const port: ToolPort = {
    async call(household, name, input) {
      try {
        return await platform.tool(household, name, input);
      } catch (err) {
        console.error('[mcp] household call failed', err);
        return { structuredContent: problemOutput(protocolError('internal'), { adapter: 'simhome', simulated: true }), isError: true };
      }
    },
  };
  let mcp: McpHttpHandler | undefined;

  return async function handle(request: Request): Promise<Response> {
    const cfg = cfgOf();
    const url = new URL(request.url);
    if (!API.test(url.pathname)) return platform.assets(request);

    const decision = decideOrigin(request.headers.get('origin'), url.origin, cfg.allowedOrigins);
    const cors = corsHeaders(decision);
    const done = (r: Response): Response => withHeaders(r, cors);

    if (!hostAllowed(request.headers.get('host'), cfg.hostPatterns)) return done(rpcError(403, 'Host not allowed.'));
    if (decision.kind === 'rejected') return done(rpcError(403, 'Origin not allowed.'));
    if (request.method === 'OPTIONS') return preflight(decision);

    if (url.pathname === '/health') {
      if (request.method !== 'GET') return done(rpcError(405, 'Method not allowed.', { allow: 'GET, OPTIONS' }));
      return done(json({ ok: true, version: VERSION, protocol: PROTOCOL_VERSION, tools: TOOL_NAMES.length, clock: clockLabel(cfg.demoStart) }));
    }

    const ip = clientIp(request);
    const tooMany = (retryAfterS: number): Response => done(rpcError(429, 'Too many requests. Try again in a few seconds.', { 'retry-after': String(retryAfterS) }));
    const bucket = url.pathname.startsWith('/demo/') ? 'demo' : 'mcp';
    const limit = await platform.take(ip, bucket, bucket === 'demo' ? cfg.rateDemoPerMin : cfg.rateMcpPerMin);
    if (!limit.ok) return tooMany(limit.retryAfterS);

    if (url.pathname === '/mcp' && request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html')) {
      // A person opened the endpoint in a browser; MCP clients never ask for HTML.
      return done(new Response(MCP_PAGE, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }));
    }
    if (url.pathname === '/mcp' && (request.method === 'GET' || request.method === 'DELETE')) {
      // Stateless server: no standalone SSE stream and no sessions to delete.
      return done(rpcError(405, 'Method not allowed.', { allow: 'POST, OPTIONS' }));
    }
    if (request.method !== (url.pathname === '/demo/state' ? 'GET' : 'POST')) {
      return done(rpcError(405, 'Method not allowed.', { allow: `${url.pathname === '/demo/state' ? 'GET' : 'POST'}, OPTIONS` }));
    }
    if (!cfg.secret) return done(rpcError(503, 'Server is missing CONFIRM_SECRET.'));

    const body = await readBody(request);
    if (!body.ok) return done(body.response);

    const token = bearer(request);
    const household = token ?? PUBLIC_HOUSEHOLD;
    if (url.pathname !== '/demo/household' && url.pathname !== '/assistant/route' && !(await verifyHouseholdToken(cfg.secret, household))) {
      return done(rpcError(401, 'Unknown household token. Create one with POST /demo/household, or send none for the shared demo.'));
    }

    if (url.pathname === '/mcp') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        return done(json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }, 400));
      }
      // A JSON-RPC batch (protocol 2025-03-26) is one HTTP request but many tool calls: cap it, and charge the
      // bucket one token per message (the request itself already paid for the first).
      if (Array.isArray(parsed)) {
        if (parsed.length > MAX_BATCH_MESSAGES) {
          return done(json({ jsonrpc: '2.0', error: { code: -32600, message: `A batch may hold at most ${MAX_BATCH_MESSAGES} messages.` }, id: null }, 400));
        }
        if (parsed.length > 1) {
          const extra = await platform.take(ip, 'mcp', cfg.rateMcpPerMin, parsed.length - 1);
          if (!extra.ok) return tooMany(extra.retryAfterS);
        }
      }
      mcp ??= makeMcpHandler(port);
      return done(await mcp.fetch(request, { authInfo: { token: household, clientId: 'fixwright-household', scopes: [] }, parsedBody: parsed }));
    }

    if (url.pathname === '/assistant/route') {
      const r = routeBody(parseObject(body.text));
      return done(r.ok ? json(r.route) : json({ error: r.error }, 400));
    }

    const fields = parseObject(body.text);
    let op: DemoOp;
    switch (url.pathname) {
      case '/demo/household': {
        const issued = await issueHouseholdToken(cfg.secret);
        const reply = await platform.demo(issued, { op: 'init' });
        return done(json({ token: issued, ntfy_topic: reply.body['ntfy_topic'] }, reply.status));
      }
      case '/demo/fault':
        if (typeof fields['fault_id'] !== 'string') return done(json({ ok: false, error: 'fault_id must be a string such as F1 or ghost_after_repair.' }, 400));
        op = { op: 'fault', fault_id: fields['fault_id'] };
        break;
      case '/demo/clock':
        op = { op: 'clock', to: fields['to'] };
        break;
      case '/demo/reset':
        op = { op: 'reset' };
        break;
      case '/demo/state':
        op = { op: 'state' };
        break;
      case '/demo/link-ha': {
        if (!cfg.allowHaLink) return done(json({ error: 'Not found.' }, 404));
        const baseUrl = fields['base_url'];
        const haToken = fields['token'];
        if (typeof baseUrl !== 'string' || baseUrl.length > 2048 || typeof haToken !== 'string' || haToken.length < 10 || haToken.length > 1000) {
          return done(json({ ok: false, error: 'Send base_url (your public https Home Assistant address) and token (a Home Assistant long lived token).' }, 400));
        }
        // Plain http and localhost only while this server itself runs on a loopback host (wrangler dev).
        const checked = checkHaUrl(baseUrl, { allowLoopback: isLoopbackHost(url.hostname) });
        if (!checked.ok) return done(json({ ok: false, error: checked.error }, 400));
        op = { op: 'link_ha', base_url: checked.url, token: haToken };
        break;
      }
      default:
        return done(json({ error: 'Not found.' }, 404));
    }
    const reply = await platform.demo(household, op);
    return done(json(reply.body, reply.status));
  };
}
