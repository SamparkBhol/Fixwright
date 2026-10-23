// Mock Fixwright server, so host tests and local demos run without apps/server and wrangler.
// - /mcp: a real MCP server (@modelcontextprotocol/server 2.2.0, createMcpHandler, stateless legacy
//   lane, so the host negotiates 2025-11-25) with all 11 tools registered from the protocol's
//   TOOL_DEFS, answering from the golden path fixtures with consistent ids (test/mock/household.ts),
//   and the three ui:// views (apps/views/dist when built, else the placeholder view).
// - /demo/household, /demo/fault, /demo/reset, /demo/clock, /demo/state, /assistant/route, /health:
//   small stubs of the server's demo routes.
// - CORS exactly like the real Worker: allowlisted origins only, Vary: Origin, OPTIONS 204.
// Run standalone: node test/mock-server.ts [--port 8713] [--host-origin http://localhost:8711] [--views auto|dist|placeholder]

import { McpServer, createMcpHandler, type CallToolResult, type ReadResourceResult } from '@modelcontextprotocol/server';
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { TOOL_DEF_LIST, VIEW_URIS, toolMeta, type ToolName, type ViewKind } from '@fixwright/protocol';
import { initialState, routeUtterance, type ConversationState } from '@fixwright/router';
import { createHousehold, type MockHousehold } from './mock/household.ts';
import { loadViews, type ViewBundle } from './mock/views.ts';
import { serveFetch, type RunningServer } from './support/http.ts';

export const MOCK_VERSION = '0.1.0-mock';
export const PUBLIC_HOUSEHOLD = 'hh_public';

const ALLOW_HEADERS = 'content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id, mcp-method, mcp-name';
const EXPOSE_HEADERS = 'mcp-session-id, mcp-protocol-version';
const TOKEN = /^hh_[0-9a-z]{4,40}$/;

export interface RecordedRequest {
  method: string;
  path: string;
  origin: string | null;
  authorization: string | null;
  protocolVersion: string | null;
  rpcMethod: string | null;
  toolName: string | null;
  status: number;
}

export interface MockServerOptions {
  port?: number;
  hostOrigins: string[];
  views?: 'auto' | 'dist' | 'placeholder';
  /** Delay every tools/call by this many ms (to see the host's busy states). */
  toolDelayMs?: number;
}

export interface MockServer extends RunningServer {
  mcpUrl: string;
  viewSource: ViewBundle['source'];
  requests: RecordedRequest[];
  households: Map<string, MockHousehold>;
}

const VIEW_NAMES: Record<ViewKind, string> = { stepper: 'Diagnosis and repair stepper', carousel: 'Checkup carousel', repair_card: 'Repair card' };

function buildMcpServer(household: MockHousehold, views: ViewBundle, delayMs: number): McpServer {
  const server = new McpServer({ name: 'fixwright-mock', version: MOCK_VERSION });
  for (const def of TOOL_DEF_LIST) {
    const config = {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
      annotations: def.annotations,
      _meta: toolMeta(def.name),
    };
    const handler = async (args: Record<string, unknown>): Promise<CallToolResult> => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const reply = household.call(def.name as ToolName, args);
      const speech = String(reply.structuredContent['speech'] ?? '');
      return { content: [{ type: 'text', text: speech }], structuredContent: reply.structuredContent, ...(reply.isError ? { isError: true } : {}) };
    };
    if (def.ui.resourceUri) registerAppTool(server, def.name, config, handler);
    else server.registerTool(def.name, config, handler);
  }
  for (const kind of Object.keys(VIEW_URIS) as ViewKind[]) {
    const uri = VIEW_URIS[kind];
    registerAppResource(
      server,
      VIEW_NAMES[kind],
      uri,
      { mimeType: RESOURCE_MIME_TYPE, description: `${VIEW_NAMES[kind]} (${views.source} build)` },
      async (): Promise<ReadResourceResult> => ({
        contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: views.html[kind], _meta: { ui: { prefersBorder: false } } }],
      }),
    );
  }
  return server;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await request.json();
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createMockFetch(opts: MockServerOptions, views: ViewBundle) {
  const households = new Map<string, MockHousehold>();
  const requests: RecordedRequest[] = [];
  let created = 0;

  const householdFor = (request: Request): MockHousehold => {
    const auth = request.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') && TOKEN.test(auth.slice(7)) ? auth.slice(7) : PUBLIC_HOUSEHOLD;
    let h = households.get(token);
    if (!h) {
      h = createHousehold(token);
      households.set(token, h);
    }
    return h;
  };

  const mcp = createMcpHandler((ctx) => {
    const req = ctx.requestInfo ?? new Request('http://local/mcp');
    return buildMcpServer(householdFor(req), views, opts.toolDelayMs ?? 0);
  });

  async function route(request: Request, url: URL): Promise<Response> {
    if (url.pathname === '/mcp') return mcp.fetch(request);
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, version: MOCK_VERSION, protocol: '2025-11-25', tools: TOOL_DEF_LIST.length, mock: true, views: views.source });
    }
    if (request.method === 'POST' && url.pathname === '/demo/household') {
      created++;
      const token = `hh_mock${String(created).padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`;
      const h = createHousehold(token);
      households.set(token, h);
      return json({ token, ntfy_topic: h.ntfyTopic });
    }
    if (request.method === 'POST' && url.pathname === '/demo/fault') {
      const body = await readJson(request);
      const result = householdFor(request).injectFault(String(body['fault_id'] ?? ''));
      return json(result.ok ? result : { ...result, error: 'unknown fault_id' }, result.ok ? 200 : 400);
    }
    if (request.method === 'POST' && url.pathname === '/demo/reset') {
      householdFor(request).reset();
      return json({ ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/demo/clock') {
      const body = await readJson(request);
      return json(householdFor(request).jumpClock(body['to']));
    }
    if (request.method === 'GET' && url.pathname === '/demo/state') return json(householdFor(request).snapshot());
    if (request.method === 'POST' && url.pathname === '/assistant/route') {
      const body = await readJson(request);
      const state = (typeof body['state'] === 'object' && body['state'] !== null ? body['state'] : initialState()) as ConversationState;
      return json(routeUtterance(String(body['utterance'] ?? ''), state));
    }
    return json({ error: 'not found' }, 404);
  }

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const cors: Record<string, string> = { vary: 'Origin' };
    if (origin && opts.hostOrigins.includes(origin)) {
      cors['access-control-allow-origin'] = origin;
      cors['access-control-expose-headers'] = EXPOSE_HEADERS;
    }
    let rpcMethod: string | null = null;
    let toolName: string | null = null;
    if (request.method === 'POST' && url.pathname === '/mcp') {
      try {
        const body = (await request.clone().json()) as { method?: string; params?: { name?: string } };
        rpcMethod = body.method ?? null;
        toolName = body.params?.name ?? null;
      } catch {
        /* not JSON; the MCP handler answers it */
      }
    }
    let response: Response;
    if (request.method === 'OPTIONS') {
      response = new Response(null, {
        status: cors['access-control-allow-origin'] ? 204 : 403,
        headers: { 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-allow-headers': ALLOW_HEADERS, 'access-control-max-age': '7200' },
      });
    } else {
      response = await route(request, url);
    }
    requests.push({
      method: request.method,
      path: url.pathname,
      origin,
      authorization: request.headers.get('authorization'),
      protocolVersion: request.headers.get('mcp-protocol-version'),
      rpcMethod,
      toolName,
      status: response.status,
    });
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }

  return { fetch, requests, households };
}

export async function startMockServer(opts: MockServerOptions): Promise<MockServer> {
  const views = await loadViews(opts.views ?? 'auto');
  const { fetch, requests, households } = createMockFetch(opts, views);
  const running = await serveFetch(fetch, opts.port ?? 8713);
  return { ...running, mcpUrl: `${running.url}/mcp`, viewSource: views.source, requests, households };
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

if (process.argv[1]?.endsWith('mock-server.ts')) {
  const server = await startMockServer({
    port: Number(arg('port', '8713')),
    hostOrigins: arg('host-origin', 'http://localhost:8711,http://127.0.0.1:8711').split(','),
    views: arg('views', 'auto') as 'auto' | 'dist' | 'placeholder',
  });
  console.log(`[mock] Fixwright mock server ${server.mcpUrl} (views: ${server.viewSource})`);
  const stop = (): void => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
