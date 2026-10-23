// The host's MCP client: one long lived Client per page.
// - Legacy negotiation pinned to 2025-11-25 (the Alexa+ lane): supportedProtocolVersions ['2025-11-25'].
// - Fetch wrapper: the server is stateless, so the SDK's standalone GET (SSE stream) is answered locally
//   with 405 instead of a network 405 that Chromium logs as a console error; POST bodies are drained
//   before close; every request carries the household token; HTTP timing is recorded.
// - Trace capture by patching the transport's send and onmessage, so the Visual Trace shows the
//   JSON-RPC messages exactly as the SDK sends and receives them (SSE or JSON framing alike).
// - ui:// resources are prefetched and cached at connect, which took first paint from 63 to 46 ms.

import { Client, StreamableHTTPClientTransport, type CallToolResult, type FetchLike, type JSONRPCMessage, type Tool } from '@modelcontextprotocol/client';
import { RESOURCE_MIME_TYPE, type McpUiResourceCsp, type McpUiResourcePermissions } from '@modelcontextprotocol/ext-apps/app-bridge';
import { toolResourceUri } from './policy.ts';
import type { TraceStore } from './trace.ts';

export const PROTOCOL_VERSION = '2025-11-25';
export const HOST_INFO = { name: 'fixwright-host-sim', version: '0.1.0' } as const;
// The version here is the MCP clientInfo; the package version is shown in About.
const UI_EXTENSION = 'io.modelcontextprotocol/ui';

export interface UiResource {
  uri: string;
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
}

export interface HttpRecord {
  method: string;
  status: number;
  msToHeaders: number;
  local: boolean;
}

export interface McpSession {
  readonly client: Client;
  readonly session: number;
  readonly tools: ReadonlyMap<string, Tool>;
  readonly protocolVersion: string | undefined;
  readonly era: string | undefined;
  readonly serverInfo: { name: string; version: string } | undefined;
  readonly http: readonly HttpRecord[];
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  readUi(uri: string): Promise<UiResource>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  mcpUrl: string;
  trace: TraceStore;
  session: number;
  token: () => string | null;
  now?: () => number;
}

function hostFetch(opts: ConnectOptions, http: HttpRecord[], openBodies: { n: number }): FetchLike {
  const now = opts.now ?? (() => performance.now());
  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      http.push({ method, status: 405, msToHeaders: 0, local: true });
      return new Response(null, { status: 405, statusText: 'Method Not Allowed' });
    }
    const headers = new Headers(init?.headers);
    const token = opts.token();
    if (token) headers.set('authorization', `Bearer ${token}`);
    const t0 = now();
    const res = await fetch(url, { ...init, headers });
    http.push({ method, status: res.status, msToHeaders: now() - t0, local: false });
    if (method === 'POST' && res.body) {
      openBodies.n++;
      res
        .clone()
        .arrayBuffer()
        .catch(() => undefined)
        .finally(() => openBodies.n--);
    }
    return res;
  };
}

function instrument(transport: StreamableHTTPClientTransport, trace: TraceStore, session: number): void {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    for (const m of Array.isArray(message) ? message : [message]) trace.add('mcp', 'out', session, m);
    return send(message, options);
  };
  let inner: ((m: JSONRPCMessage, extra?: unknown) => void) | undefined;
  const wrapped = (m: JSONRPCMessage, extra?: unknown): void => {
    trace.add('mcp', 'in', session, m);
    inner?.(m, extra);
  };
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    enumerable: true,
    get: () => (inner ? wrapped : undefined),
    set: (fn: ((m: JSONRPCMessage, extra?: unknown) => void) | undefined) => {
      inner = fn;
    },
  });
}

export async function connectMcp(opts: ConnectOptions): Promise<McpSession> {
  const http: HttpRecord[] = [];
  const openBodies = { n: 0 };
  const transport = new StreamableHTTPClientTransport(new URL(opts.mcpUrl), { fetch: hostFetch(opts, http, openBodies) });
  instrument(transport, opts.trace, opts.session);
  const client = new Client(
    { ...HOST_INFO },
    {
      capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: [RESOURCE_MIME_TYPE] } } },
      supportedProtocolVersions: [PROTOCOL_VERSION],
      versionNegotiation: { mode: 'legacy' },
    },
  );
  await client.connect(transport);
  const tools = new Map<string, Tool>();
  for (const t of (await client.listTools()).tools) tools.set(t.name, t);

  const uiCache = new Map<string, Promise<UiResource>>();
  const readUi = (uri: string): Promise<UiResource> => {
    let p = uiCache.get(uri);
    if (!p) {
      p = (async () => {
        const res = await client.readResource({ uri });
        const c = res.contents[0] as { mimeType?: string; text?: string; blob?: string; _meta?: { ui?: { csp?: McpUiResourceCsp; permissions?: McpUiResourcePermissions } } } | undefined;
        if (!c || c.mimeType !== RESOURCE_MIME_TYPE) throw new Error(`${uri} is not an MCP Apps view (${c?.mimeType ?? 'no content'})`);
        const html = typeof c.text === 'string' ? c.text : typeof c.blob === 'string' ? new TextDecoder().decode(Uint8Array.from(atob(c.blob), (ch) => ch.charCodeAt(0))) : '';
        const ui = c._meta?.ui;
        return { uri, html, ...(ui?.csp ? { csp: ui.csp } : {}), ...(ui?.permissions ? { permissions: ui.permissions } : {}) };
      })();
      p.catch(() => uiCache.delete(uri));
      uiCache.set(uri, p);
    }
    return p;
  };
  // Prefetch every view at connect, so a tool result paints without waiting for resources/read.
  const uris = new Set([...tools.values()].map(toolResourceUri).filter((u): u is string => u !== null));
  await Promise.all([...uris].map((u) => readUi(u).catch(() => undefined)));

  const serverVersion = client.getServerVersion();
  return {
    client,
    session: opts.session,
    tools,
    protocolVersion: client.getNegotiatedProtocolVersion(),
    era: client.getProtocolEra(),
    serverInfo: serverVersion ? { name: serverVersion.name, version: serverVersion.version } : undefined,
    http,
    callTool: async (name, args) => (await client.callTool({ name, arguments: args })) as CallToolResult,
    readUi,
    async close() {
      const until = performance.now() + 1000;
      while (openBodies.n > 0 && performance.now() < until) await new Promise((r) => setTimeout(r, 5));
      await client.close();
    },
  };
}

/** The spoken line of a tool result: the text content, else structuredContent.speech. */
export function speechOf(result: CallToolResult): string {
  for (const c of result.content ?? []) if (c.type === 'text' && c.text.trim()) return c.text.trim();
  const sc = result.structuredContent as { speech?: unknown } | undefined;
  return typeof sc?.speech === 'string' ? sc.speech : '';
}
