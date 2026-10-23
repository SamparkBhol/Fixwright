// The MCP surface: 11 tools from @fixwright/protocol TOOL_DEFS and the three ui:// views. Runtime neutral
// (no cloudflare:* imports), so the Node CPU harness runs exactly this code.
//
// createMcpHandler builds a fresh McpServer per request (legacy 'stateless'), and registerTool converts
// every schema to JSON Schema. cachedJson() keeps those conversions for the life of the isolate,
// and primeSchemas() does them once at module scope, inside the startup budget instead of a request's.

import { createMcpHandler, McpServer, type AuthInfo, type CallToolResult, type McpHttpHandler, type ReadResourceResult } from '@modelcontextprotocol/server';
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { TOOL_DEF_LIST, toolMeta, type ToolInputMap, type ToolName } from '@fixwright/protocol';
import { cachedJson } from './schema-cache.ts';
import { VIEWS } from './views.ts';
import { VERSION } from '../version.ts';

export interface ToolPort {
  /** Always resolves: failures come back with isError. */
  call<N extends ToolName>(household: string, name: N, input: ToolInputMap[N]): Promise<{ structuredContent: Record<string, unknown>; isError: boolean }>;
}

const CACHED = new Map(TOOL_DEF_LIST.map((def) => [def.name, { input: cachedJson(def.inputSchema), output: cachedJson(def.outputSchema) }]));

const INSTRUCTIONS =
  'Fixwright is a home doctor. Use diagnose when a device misbehaves, explain_event for something the home already did, ' +
  'home_checkup for a general check. Ask the person every question a result carries, word for word. Never call repair_apply ' +
  'until the person has said yes to that exact plan. Speak the speech field as it is.';

function toResult(reply: { structuredContent: Record<string, unknown>; isError: boolean }): CallToolResult {
  const speech = typeof reply.structuredContent['speech'] === 'string' ? (reply.structuredContent['speech'] as string) : '';
  return {
    content: [{ type: 'text', text: speech }],
    structuredContent: reply.structuredContent,
    ...(reply.isError ? { isError: true } : {}),
  };
}

export function buildServer(port: ToolPort, household: string): McpServer {
  const server = new McpServer({ name: 'fixwright', title: 'Fixwright', version: VERSION }, { instructions: INSTRUCTIONS });
  for (const def of TOOL_DEF_LIST) {
    const schemas = CACHED.get(def.name) as { input: ReturnType<typeof cachedJson>; output: ReturnType<typeof cachedJson> };
    const config = {
      title: def.title,
      description: def.description,
      inputSchema: schemas.input,
      outputSchema: schemas.output,
      annotations: def.annotations,
      _meta: toolMeta(def.name),
    };
    const handler = async (args: unknown): Promise<CallToolResult> =>
      toResult(await port.call(household, def.name, args as ToolInputMap[typeof def.name]));
    if (def.ui.resourceUri) registerAppTool(server, def.name, config, handler);
    else server.registerTool(def.name, config, handler);
  }
  for (const view of VIEWS) {
    registerAppResource(server, view.name, view.uri, { description: view.description, mimeType: RESOURCE_MIME_TYPE }, async (): Promise<ReadResourceResult> => ({
      contents: [{ uri: view.uri, mimeType: RESOURCE_MIME_TYPE, text: view.html, _meta: { ui: { prefersBorder: false } } }],
    }));
  }
  return server;
}

/** The household comes in as authInfo.token, already verified by the router. */
export function makeMcpHandler(port: ToolPort): McpHttpHandler {
  return createMcpHandler((ctx) => buildServer(port, (ctx.authInfo as AuthInfo | undefined)?.token ?? 'hh_public'), {
    legacy: 'stateless',
    onerror: (e) => console.error('[mcp]', e?.message ?? e),
  });
}

/** Every schema conversion happens here, at module scope, instead of in the first request. */
export function primeSchemas(): void {
  const noop: ToolPort = { call: async () => ({ structuredContent: {}, isError: true }) };
  const server = buildServer(noop, 'prime');
  void server;
}
