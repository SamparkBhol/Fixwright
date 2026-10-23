// Contract round trip through the real SDKs the server and host use (@modelcontextprotocol/server and
// client 2.2.0, ext-apps 2.0.3): TOOL_DEFS register unchanged, tools/list exposes object schemas with
// described inputs and the ext-apps _meta, and every fixture passes the SDKs' own output validation.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryTransport, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { RESOURCE_URI_META_KEY, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { TOOL_DEFS, TOOL_DEF_LIST, TOOL_NAMES, toolMeta, type ToolInputMap, type ToolName } from '../src/index.ts';
import { goldenFixtures } from '../scripts/golden.ts';

const golden = goldenFixtures();

const ARGS: ToolInputMap = {
  home_checkup: {},
  diagnose: { symptom: "the hallway lamp keeps saying it's not responding", device: 'hallway lamp' },
  diagnose_answer: { diagnosis_id: golden.diagnose.diagnosis_id, question_id: golden.diagnose.question!.question_id, answer: 'Yes, it blinked.' },
  explain_event: { question: 'Why did every plug turn on at 3 a.m.?' },
  repair_plan: { diagnosis_id: golden.diagnose.diagnosis_id },
  repair_apply: { plan_id: golden.repair_plan.plan_id, confirm_token: golden.repair_plan.confirm_token },
  repair_status: { repair_id: golden.repair_apply.repair_id },
  undo: { repair_id: golden.repair_apply.repair_id },
  protect_device: { device: 'aquarium filter', reason: 'the fish need it' },
  switch_device: { device: 'living room power strip', on: false },
  refresh_view: { ref_id: golden.repair_apply.repair_id },
};

/** What each handler returns; tests swap entries to send broken or error results. */
const replies = new Map<ToolName, CallToolResult>();
const ok = (tool: ToolName): CallToolResult => ({
  content: [{ type: 'text', text: golden[tool].speech }],
  structuredContent: golden[tool],
});

function buildServer(): McpServer {
  const server = new McpServer({ name: 'fixwright-contract-test', version: '0.0.0' });
  for (const def of TOOL_DEF_LIST) {
    const config = {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
      annotations: def.annotations,
      _meta: toolMeta(def.name),
    };
    const reply = async (): Promise<CallToolResult> => replies.get(def.name) ?? ok(def.name);
    if (def.ui.resourceUri) registerAppTool(server, def.name, config, reply);
    else server.registerTool(def.name, config, reply);
  }
  return server;
}

let client: Client;
let server: McpServer;

beforeAll(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  server = buildServer();
  client = new Client({ name: 'contract-test-host', version: '0.0.0' }, { capabilities: {} });
  await server.connect(serverSide);
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

describe('MCP SDK round trip', () => {
  it('tools/list shows all 11 tools with object schemas, described inputs and ext-apps meta', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      const def = TOOL_DEFS[tool.name as ToolName];
      expect(tool.title).toBe(def.title);
      expect(tool.annotations).toMatchObject(def.annotations);
      expect(tool.inputSchema.type).toBe('object');
      expect((tool.outputSchema as { type?: string } | undefined)?.type, tool.name).toBe('object');
      for (const [key, prop] of Object.entries(tool.inputSchema.properties ?? {})) {
        expect((prop as { description?: string }).description, `${tool.name}.${key}`).toBeTruthy();
      }
      const ui = (tool._meta as { ui?: { resourceUri?: string; visibility?: string[] } } | undefined)?.ui;
      expect(ui?.resourceUri).toBe(def.ui.resourceUri);
      expect(ui?.visibility).toEqual(def.ui.visibility);
      if (def.ui.resourceUri) expect(tool._meta?.[RESOURCE_URI_META_KEY]).toBe(def.ui.resourceUri);
    }
  });

  it.each(TOOL_NAMES)('tools/call %s returns the fixture and passes server and client output validation', async (tool) => {
    replies.delete(tool);
    const result = await client.callTool({ name: tool, arguments: ARGS[tool] });
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent).toEqual(golden[tool]);
    expect(result.content).toEqual([{ type: 'text', text: golden[tool].speech }]);
  });

  it('an output that breaks a contract rule is stopped by the server', async () => {
    const broken = structuredClone(golden.diagnose);
    broken.hypotheses.reverse();
    replies.set('diagnose', { content: [{ type: 'text', text: broken.speech }], structuredContent: broken });
    const outcome = await client.callTool({ name: 'diagnose', arguments: ARGS.diagnose }).then(
      (r) => JSON.stringify(r),
      (e: unknown) => String(e),
    );
    replies.delete('diagnose');
    expect(outcome).toMatch(/most likely first/);
  });

  it('a problem output travels as an isError result without output validation', async () => {
    replies.set('repair_apply', { isError: true, content: [{ type: 'text', text: golden.problem.speech }], structuredContent: golden.problem });
    const result = await client.callTool({ name: 'repair_apply', arguments: ARGS.repair_apply });
    replies.delete('repair_apply');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(golden.problem);
  });

  it('bad input is rejected with the schema message the model can act on', async () => {
    const outcome = await client
      .callTool({ name: 'repair_plan', arguments: { diagnosis_id: golden.diagnose.diagnosis_id, issue_id: golden.home_checkup.findings[0]!.issue_id } })
      .then((r) => JSON.stringify(r), (e: unknown) => String(e));
    expect(outcome).toContain('Give exactly one of diagnosis_id, issue_id or explanation_id.');
  });
});
