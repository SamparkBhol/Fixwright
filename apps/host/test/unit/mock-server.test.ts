// The mock server must look like the real one to an MCP client: 11 tools with schemas and ext-apps
// meta, three ui:// views, every result valid against the protocol output schemas, ids that chain,
// plans that apply once with their own token, and the demo routes the host calls.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { TOOL_NAMES, ToolOutputs, ProblemOutputSchema, VIEW_URIS, type ToolName } from '@fixwright/protocol';
import { startMockServer, type MockServer } from '../mock-server.ts';

const PORT = 8761;
const ORIGIN = 'http://localhost:8711';
let server: MockServer;
let client: Client;

async function call(name: ToolName, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  const sc = r.structuredContent as Record<string, unknown>;
  if (r.isError) expect(ProblemOutputSchema.safeParse(sc).success, JSON.stringify(sc)).toBe(true);
  else {
    const parsed = ToolOutputs[name].safeParse(sc);
    expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
  }
  return { sc, isError: r.isError === true, text: (r.content as Array<{ text?: string }>)[0]?.text };
}

beforeAll(async () => {
  server = await startMockServer({ port: PORT, hostOrigins: [ORIGIN], views: 'placeholder' });
  client = new Client({ name: 'mock-test', version: '0' }, { supportedProtocolVersions: ['2025-11-25'] });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.mcpUrl)));
});

afterAll(async () => {
  await client?.close();
  await server?.close();
});

describe('mock MCP server', () => {
  it('negotiates 2025-11-25 and lists the 11 tools with ext-apps meta', async () => {
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const diagnose = tools.find((t) => t.name === 'diagnose');
    expect((diagnose?._meta as { ui?: { resourceUri?: string } }).ui?.resourceUri).toBe(VIEW_URIS.stepper);
    const refresh = tools.find((t) => t.name === 'refresh_view');
    expect((refresh?._meta as { ui?: { visibility?: string[] } }).ui?.visibility).toEqual(['app']);
  });

  it('serves the three views as MCP Apps HTML', async () => {
    for (const uri of Object.values(VIEW_URIS)) {
      const res = await client.readResource({ uri });
      const c = res.contents[0] as { mimeType?: string; text?: string };
      expect(c.mimeType).toBe('text/html;profile=mcp-app');
      expect(c.text).toContain('<!doctype html>');
      expect(c.text).toContain('ui/initialize');
    }
  });

  it('runs the golden path with chaining ids and valid outputs', async () => {
    const dx = await call('diagnose', { symptom: 'the hallway lamp is not responding', device: 'hallway lamp' });
    expect(dx.sc['status']).toBe('needs_answer');
    const q = dx.sc['question'] as { question_id: string };
    const ans = await call('diagnose_answer', { diagnosis_id: dx.sc['diagnosis_id'], question_id: q.question_id, answer: 'Yes, it blinked.' });
    expect((ans.sc['verdict'] as { level: string }).level).toBe('confirmed');
    const again = await call('diagnose_answer', { diagnosis_id: dx.sc['diagnosis_id'], question_id: q.question_id, answer: 'yes' });
    expect(again.isError).toBe(true);
    expect((again.sc['problem'] as { code: string }).code).toBe('question_answered');

    const plan = await call('repair_plan', { diagnosis_id: dx.sc['diagnosis_id'] });
    expect(plan.sc['status']).toBe('needs_confirmation');
    const wrong = await call('repair_apply', { plan_id: plan.sc['plan_id'], confirm_token: 'x'.repeat(32) });
    expect((wrong.sc['problem'] as { code: string }).code).toBe('token_mismatch');
    const applied = await call('repair_apply', { plan_id: plan.sc['plan_id'], confirm_token: plan.sc['confirm_token'] });
    expect(applied.sc['state']).toBe('applied');
    expect(applied.sc['plan_id']).toBe(plan.sc['plan_id']);
    const twice = await call('repair_apply', { plan_id: plan.sc['plan_id'], confirm_token: plan.sc['confirm_token'] });
    expect((twice.sc['problem'] as { code: string }).code).toBe('plan_used');

    const before = await call('repair_status', { repair_id: applied.sc['repair_id'] });
    expect(before.sc['state']).toBe('applied');
    const refreshed = await call('refresh_view', { ref_id: applied.sc['repair_id'] });
    expect(refreshed.sc['repair_id']).toBe(applied.sc['repair_id']);
    expect(refreshed.sc['state']).toBe('applied');
    const undone = await call('undo', { repair_id: applied.sc['repair_id'] });
    expect(undone.sc['state']).toBe('undone');
  });

  it('answers no and unclear with a new question, never a verdict', async () => {
    const dx = await call('diagnose', { symptom: 'lamp offline' });
    const q = dx.sc['question'] as { question_id: string };
    const no = await call('diagnose_answer', { diagnosis_id: dx.sc['diagnosis_id'], question_id: q.question_id, answer: 'nahi jala' });
    expect(no.sc['status']).toBe('needs_answer');
    const q2 = no.sc['question'] as { question_id: string; text: string };
    expect(q2.question_id).not.toBe(q.question_id);
    // The mock has no model of the house: every number it returns is the fixture's own.
    expect(no.sc['hypotheses']).toEqual(dx.sc['hypotheses']);
    expect(no.sc['probes']).toEqual(dx.sc['probes']);
    const unclear = await call('diagnose_answer', { diagnosis_id: dx.sc['diagnosis_id'], question_id: q2.question_id, answer: 'not sure' });
    expect(unclear.sc['status']).toBe('needs_answer');
    expect(unclear.sc['hypotheses']).toEqual(dx.sc['hypotheses']);
  });

  it('explains, plans the suggested fix, checks up, refuses the protected strip and protects', async () => {
    const exp = await call('explain_event', { question: 'Why did every plug turn on at 3 a.m.?' });
    const fix = exp.sc['suggested_fix'] as { issue_id: string };
    const plan = await call('repair_plan', { issue_id: fix.issue_id });
    expect((plan.sc['diff_lines'] as string[])[0]).toMatch(/remember/);
    const applied = await call('repair_apply', { plan_id: plan.sc['plan_id'], confirm_token: plan.sc['confirm_token'] });
    expect(applied.sc['state']).toBe('applied');
    const chk = await call('home_checkup', {});
    expect((chk.sc['findings'] as unknown[]).length).toBe(3);
    const battery = (chk.sc['findings'] as Array<{ issue_id: string; fixable: boolean }>).find((f) => !f.fixable);
    const noFix = await call('repair_plan', { issue_id: battery?.issue_id });
    expect((noFix.sc['problem'] as { code: string }).code).toBe('no_fix');
    const strip = await call('switch_device', { device: 'living room power strip', on: false });
    expect(strip.sc['status']).toBe('refused');
    const lamp = await call('switch_device', { device: 'floor lamp', on: true });
    expect(lamp.sc['switched']).toMatchObject({ name: 'Floor Lamp', state: 'on' });
    const prot = await call('protect_device', { device: 'aquarium filter' });
    expect((prot.sc['protected'] as unknown[]).length).toBe(1);
  });
});

describe('mock HTTP routes', () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('answers CORS preflights for the host origin only', async () => {
    const ok = await fetch(server.mcpUrl, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('access-control-allow-headers')).toContain('mcp-protocol-version');
    expect(ok.headers.get('access-control-allow-headers')).toContain('authorization');
    const bad = await fetch(server.mcpUrl, { method: 'OPTIONS', headers: { origin: 'http://evil.example' } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('creates households and keeps their state apart', async () => {
    const created = (await (await post('/demo/household', {})).json()) as { token: string; ntfy_topic: string };
    expect(created.token).toMatch(/^hh_[0-9a-z]+$/);
    expect(created.ntfy_topic).toBeTruthy();
    const auth = { authorization: `Bearer ${created.token}` };
    const fault = (await (await post('/demo/fault', { fault_id: 'hub_down' }, auth)).json()) as { active_faults: string[] };
    expect(fault.active_faults).toContain('hub_down');
    const pub = (await (await fetch(`${server.url}/demo/state`)).json()) as { active_faults: string[] };
    expect(pub.active_faults).not.toContain('hub_down');
    expect((await post('/demo/fault', { fault_id: 'nope' }, auth)).status).toBe(400);
    expect((await (await post('/demo/reset', {}, auth)).json()) as { ok: boolean }).toEqual({ ok: true });
  });

  it('jumps the clock and confirms an applied repair with a push', async () => {
    const created = (await (await post('/demo/household', {})).json()) as { token: string };
    const authed = new Client({ name: 'mock-test-2', version: '0' }, { supportedProtocolVersions: ['2025-11-25'] });
    await authed.connect(
      new StreamableHTTPClientTransport(new URL(server.mcpUrl), { requestInit: { headers: { authorization: `Bearer ${created.token}` } } }),
    );
    const dx = (await authed.callTool({ name: 'diagnose', arguments: { symptom: 'lamp offline' } })).structuredContent as Record<string, unknown>;
    const q = dx['question'] as { question_id: string };
    await authed.callTool({ name: 'diagnose_answer', arguments: { diagnosis_id: dx['diagnosis_id'], question_id: q.question_id, answer: 'yes' } });
    const plan = (await authed.callTool({ name: 'repair_plan', arguments: { diagnosis_id: dx['diagnosis_id'] } })).structuredContent as Record<string, unknown>;
    const applied = (await authed.callTool({ name: 'repair_apply', arguments: { plan_id: plan['plan_id'], confirm_token: plan['confirm_token'] } }))
      .structuredContent as Record<string, unknown>;
    const jump = (await (await post('/demo/clock', { to: 'next_morning' }, { authorization: `Bearer ${created.token}` })).json()) as {
      now: string;
      pushes: Array<{ message: string }>;
    };
    expect(jump.now).toBe('2026-10-16T14:00:00.000Z');
    expect(jump.pushes[0]?.message).toBe('Hallway lamp answered all 9 commands overnight. Repair confirmed.');
    const status = (await authed.callTool({ name: 'repair_status', arguments: { repair_id: applied['repair_id'] } })).structuredContent as Record<string, unknown>;
    expect(status['state']).toBe('confirmed');
    // A repair card open at the morning check asks refresh_view and gets the same confirmed status,
    // which is the protocol's own refresh_view fixture.
    const refreshFx = (await import('@fixwright/protocol/fixtures/refresh_view.json', { with: { type: 'json' } })).default as Record<string, unknown>;
    const refreshed = (await authed.callTool({ name: 'refresh_view', arguments: { ref_id: applied['repair_id'] } })).structuredContent as Record<string, unknown>;
    expect(refreshed['state']).toBe('confirmed');
    expect(refreshed['speech']).toBe(refreshFx['speech']);
    expect(refreshed['checks']).toEqual(refreshFx['checks']);
    expect(ToolOutputs.repair_status.safeParse(refreshed).success).toBe(true);
    await authed.close();
  });

  it('routes utterances with the shared router', async () => {
    const r = (await (await post('/assistant/route', { utterance: 'Give my house a checkup' })).json()) as { tool: string };
    expect(r.tool).toBe('home_checkup');
  });

  it('reports health', async () => {
    const h = (await (await fetch(`${server.url}/health`)).json()) as { protocol: string; tools: number };
    expect(h).toMatchObject({ ok: true, protocol: '2025-11-25', tools: 11 });
  });

  it('recorded the protocol version header on MCP posts after initialize', () => {
    const posts = server.requests.filter((r) => r.path === '/mcp' && r.method === 'POST' && r.rpcMethod !== 'initialize');
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((r) => r.protocolVersion === '2025-11-25')).toBe(true);
  });
});
