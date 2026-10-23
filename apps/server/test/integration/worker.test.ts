// The real Worker under `wrangler dev --local` (workerd, SQLite Durable Objects, Text module views, the
// assets binding), driven like a host would: the MCP client 2.2.0 on the 2025-11-25 legacy lane, plain
// fetch for the demo routes, and curl for the raw initialize transcript.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { TOOL_DEFS, TOOL_NAMES, VIEW_URIS, type ToolName } from '@fixwright/protocol';
import { goldenPath, type Driver, type Reply } from '../support/golden.ts';
import { SERVER_DIR, startDev, startNtfy, type Dev, type NtfyMock } from '../support/wrangler.ts';

// FIXWRIGHT_TEST_PORT moves the three ports (wrangler, its inspector, the ntfy mock) when 8701 to 8703 are
// taken, for example by the dev stack.
const PORT = Number(process.env['FIXWRIGHT_TEST_PORT'] ?? 8701);
const NTFY_PORT = PORT + 2;
const HOST_ORIGIN = 'http://localhost:8711';
let dev: Dev;
let ntfy: NtfyMock;

beforeAll(async () => {
  ntfy = await startNtfy(NTFY_PORT);
  dev = await startDev({
    port: PORT,
    inspector: PORT + 1,
    name: 'worker',
    vars: { NTFY_BASE: ntfy.base, DEMO_START: '2026-10-15T22:00:00.000Z', ALLOWED_ORIGINS: HOST_ORIGIN, RATE_DEMO_PER_MIN: '20' },
  });
});

afterAll(async () => {
  await dev?.stop();
  await ntfy?.close();
});

/** Every request from a test names its own client address, so rate limit buckets do not mix. */
let ipCounter = 10;
const freshIp = (): string => `198.51.100.${ipCounter++}`;

async function connect(token?: string, ip = freshIp()): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${dev.base}/mcp`), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('cf-connecting-ip', ip);
      if (token) headers.set('authorization', `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    },
  });
  const client = new Client({ name: 'fixwright-server-test', version: '0.0.0' }, { capabilities: {}, supportedProtocolVersions: ['2025-11-25'], versionNegotiation: { mode: 'legacy' } });
  await client.connect(transport);
  return client;
}

async function demo(path: string, body?: unknown, token?: string, ip = freshIp()): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${dev.base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

const reply = (r: CallToolResult): Reply => ({
  structuredContent: (r.structuredContent ?? {}) as Record<string, unknown>,
  isError: r.isError === true,
  text: (r.content[0] as { text?: string } | undefined)?.text ?? '',
});

describe('MCP on workerd', () => {
  it('initialize at 2025-11-25: raw curl transcript saved to evidence/', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'curl', version: '8' } } });
    const args = ['-sS', '-i', '-X', 'POST', `${dev.base}/mcp`, '-H', 'content-type: application/json', '-H', 'accept: application/json, text/event-stream', '-H', `origin: ${HOST_ORIGIN}`, '--data', body];
    const out = execFileSync('curl', args, { encoding: 'utf8' });
    expect(out).toMatch(/^HTTP\/1\.1 200/);
    expect(out).toContain('"protocolVersion":"2025-11-25"');
    expect(out.toLowerCase()).toContain(`access-control-allow-origin: ${HOST_ORIGIN}`);
    mkdirSync(`${SERVER_DIR}evidence`, { recursive: true });
    const cmd = `curl ${args.map((a) => (/[\s"{}]/.test(a) ? `'${a}'` : a)).join(' ')}`;
    writeFileSync(`${SERVER_DIR}evidence/initialize-2025-11-25.txt`, `# ${new Date().toISOString()} wrangler dev --local, 127.0.0.1:${PORT}\n$ ${cmd}\n\n${out.replace(/\r\n/g, '\n')}\n`);
  });

  it('tools/list: 11 tools, view tools carry their ui:// resource, refresh_view is app only', async () => {
    const client = await connect();
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      for (const t of tools) {
        const def = TOOL_DEFS[t.name as ToolName];
        const ui = (t._meta as { ui?: { resourceUri?: string; visibility?: string[] } }).ui;
        expect(ui?.visibility, t.name).toEqual(def.ui.visibility);
        expect(ui?.resourceUri, t.name).toBe(def.ui.resourceUri);
        expect(t.outputSchema?.type).toBe('object');
      }
      expect(tools.filter((t) => (t._meta as { ui?: { resourceUri?: string } }).ui?.resourceUri).length).toBe(8);
      expect((tools.find((t) => t.name === 'refresh_view')?._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(['app']);
    } finally {
      await client.close();
    }
  });

  it('resources/read returns the three views as MCP Apps HTML', async () => {
    const client = await connect();
    try {
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri).sort()).toEqual(Object.values(VIEW_URIS).sort());
      for (const uri of Object.values(VIEW_URIS)) {
        const res = await client.readResource({ uri });
        const c = res.contents[0] as { mimeType?: string; text?: string };
        expect(c.mimeType).toBe(RESOURCE_MIME_TYPE);
        expect(c.text?.startsWith('<!doctype html') || c.text?.startsWith('<!DOCTYPE html')).toBe(true);
        expect(c.text?.length).toBeGreaterThan(10_000);
      }
    } finally {
      await client.close();
    }
  });

  it('golden path through the MCP client, with the push from the next morning check', async () => {
    const client = await connect();
    try {
      const d: Driver = {
        call: async (name, args) => reply((await client.callTool({ name, arguments: args })) as CallToolResult),
        nextMorning: async () => {
          const r = await demo('/demo/clock', { to: 'next_morning' });
          expect(r.status).toBe(200);
          return r.json as never;
        },
        received: () => ntfy.received,
      };
      const out = await goldenPath(d);
      const topic = (await demo('/demo/state')).json['ntfy_topic'];
      expect(ntfy.received[0]?.topic).toBe(topic);
      expect(ntfy.received[0]?.tags).toBe('white_check_mark,house');
      mkdirSync(`${SERVER_DIR}evidence`, { recursive: true });
      writeFileSync(`${SERVER_DIR}evidence/golden-path.txt`, `# ${new Date().toISOString()} golden path through wrangler dev --local and @modelcontextprotocol/client 2.2.0\n${out.steps.join('\n')}\n`);
    } finally {
      await client.close();
    }
  });
});

describe('HTTP edges', () => {
  it('GET and DELETE /mcp answer 405; a body over 64 KB 413; a bad JSON body a parse error', async () => {
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(`${dev.base}/mcp`, { method, headers: { 'cf-connecting-ip': freshIp(), accept: 'text/event-stream' } });
      expect(r.status, method).toBe(405);
    }
    const big = await fetch(`${dev.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': freshIp() }, body: 'x'.repeat(70_000) });
    expect(big.status).toBe(413);
    const bad = await fetch(`${dev.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'cf-connecting-ip': freshIp() }, body: '{oops' });
    expect(bad.status).toBe(400);
  });

  it('CORS: the allowed origin gets headers on preflight, success and errors; another origin is refused', async () => {
    const pre = await fetch(`${dev.base}/mcp`, { method: 'OPTIONS', headers: { origin: HOST_ORIGIN, 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(HOST_ORIGIN);
    expect(pre.headers.get('access-control-allow-headers')).toContain('mcp-protocol-version');
    expect(pre.headers.get('vary')).toContain('Origin');
    const err = await fetch(`${dev.base}/mcp`, { method: 'GET', headers: { origin: HOST_ORIGIN, 'cf-connecting-ip': freshIp() } });
    expect(err.status).toBe(405);
    expect(err.headers.get('access-control-allow-origin')).toBe(HOST_ORIGIN);
    const evilPre = await fetch(`${dev.base}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(evilPre.status).toBe(403);
    expect(evilPre.headers.get('access-control-allow-origin')).toBeNull();
    const evil = await fetch(`${dev.base}/health`, { headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('vary')).toContain('Origin');
  });

  it('refuses a Host header that is not ours (DNS rebinding)', async () => {
    const out = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'host: evil.example', `${dev.base}/health`], { encoding: 'utf8' });
    expect(out).toBe('403');
  });

  it('rate limits per IP: 429 with Retry-After once the demo bucket is empty', async () => {
    const ip = freshIp();
    let limited: Response | undefined;
    for (let i = 0; i < 25 && !limited; i++) {
      const r = await fetch(`${dev.base}/demo/state`, { headers: { 'cf-connecting-ip': ip, origin: HOST_ORIGIN } });
      if (r.status === 429) limited = r;
      else await r.body?.cancel();
    }
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(limited?.headers.get('access-control-allow-origin')).toBe(HOST_ORIGIN);
    // Another address is unaffected.
    expect((await demo('/demo/state')).status).toBe(200);
  });

  it('a JSON-RPC batch costs one token per message and holds at most 10 messages', async () => {
    const batch = (n: number, ip: string) =>
      fetch(`${dev.base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26', 'cf-connecting-ip': ip },
        body: JSON.stringify(Array.from({ length: n }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/list' }))),
      });
    const tooBig = await batch(11, freshIp());
    expect(tooBig.status).toBe(400);
    expect(((await tooBig.json()) as { error: { code: number } }).error.code).toBe(-32600);
    // 240 tokens a minute: one token per request would allow 240 batches; one per message allows about 24.
    const ip = freshIp();
    let ok = 0;
    let limited: Response | undefined;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await batch(10, ip);
      if (r.status === 429) limited = r;
      else {
        expect(r.status).toBe(200);
        await r.body?.cancel();
        ok++;
      }
    }
    expect(limited?.status).toBe(429);
    expect(ok).toBeGreaterThanOrEqual(20);
    expect(ok).toBeLessThanOrEqual(30);
  });

  it('health and static assets', async () => {
    const h = await (await fetch(`${dev.base}/health`)).json();
    expect(h).toEqual({
      ok: true,
      version: '0.1.0',
      protocol: '2025-11-25',
      tools: 11,
      clock: { simulated: true, starts_at: '2026-10-15T22:00:00.000Z', tz: 'America/Los_Angeles', note: 'Simulated clock. Each new demo house starts at 2026-10-15T22:00:00.000Z, then runs with real time.' },
    });
    const page = await fetch(`${dev.base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
  });

  it('/assistant/route answers the deterministic router', async () => {
    const r = await demo('/assistant/route', { utterance: "Alexa, ask Fixwright why the hallway lamp keeps saying it's not responding." });
    expect(r.json).toMatchObject({ tool: 'diagnose', intent: 'diagnose' });
    const junk = await demo('/assistant/route', { utterance: 'yes', state: { pendingPlan: 'not an object', findings: 'x' } });
    expect(junk.status).toBe(200);
    expect((await demo('/assistant/route', { utterance: '' })).status).toBe(400);
  });

  it('/demo/link-ha does not exist unless ALLOW_HA_LINK=1', async () => {
    expect((await demo('/demo/link-ha', { base_url: 'http://127.0.0.1:8741', token: 'x'.repeat(40) })).status).toBe(404);
  });
});

describe('households', () => {
  it('a new household is isolated from hh_public and from a forged token', async () => {
    const created = await demo('/demo/household', {});
    expect(created.status).toBe(200);
    const token = created.json['token'] as string;
    expect(token).toMatch(/^hh_[0-9a-z]{32}$/);
    expect(created.json['ntfy_topic']).toMatch(/^fixwright-[0-9a-z]{20}$/);

    const f = await demo('/demo/fault', { fault_id: 'F8' }, token);
    expect(f.json['active_faults']).toContain('hub_down');
    const pub = await demo('/demo/state');
    expect(pub.json['active_faults']).not.toContain('hub_down');
    const mine = await demo('/demo/state', undefined, token);
    expect(mine.json['ntfy_topic']).toBe(created.json['ntfy_topic']);
    expect(mine.json['household']).toBe('private');
    // A private house built from the isolate's template starts on the same simulated clock as hh_public.
    expect(mine.json['clock']).toMatchObject({ simulated: true, starts_at: '2026-10-15T22:00:00.000Z', tz: 'America/Los_Angeles' });
    expect(mine.json['protected']).toEqual(pub.json['protected']);

    // A session made in one household cannot be continued from another.
    const a = await connect(token);
    const b = await connect();
    try {
      const dx = reply((await a.callTool({ name: 'home_checkup', arguments: {} })) as CallToolResult);
      expect(dx.isError).toBe(false);
      const checkupId = dx.structuredContent['checkup_id'] as string;
      const other = reply((await b.callTool({ name: 'refresh_view', arguments: { ref_id: checkupId } })) as CallToolResult);
      expect(other.isError).toBe(true);
      const same = reply((await a.callTool({ name: 'refresh_view', arguments: { ref_id: checkupId } })) as CallToolResult);
      expect(same.structuredContent['checkup_id']).toBe(checkupId);
    } finally {
      await a.close();
      await b.close();
    }

    const forged = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect((await demo('/demo/state', undefined, forged)).status).toBe(401);
    const reset = await demo('/demo/reset', {}, token);
    expect(reset.json['active_faults']).not.toContain('hub_down');
  });

  it('the Durable Object alarm itself runs the morning check and pushes (no demo jump at 07:00)', async () => {
    const created = await demo('/demo/household', {});
    const token = created.json['token'] as string;
    const client = await connect(token);
    try {
      const call = async (name: string, args: Record<string, unknown>) => reply((await client.callTool({ name, arguments: args })) as CallToolResult).structuredContent;
      const dx = await call('diagnose', { symptom: "the hallway lamp isn't responding", device: 'hallway lamp' });
      const q = dx['question'] as { question_id: string };
      await call('diagnose_answer', { diagnosis_id: dx['diagnosis_id'], question_id: q.question_id, answer: 'yes' });
      const plan = await call('repair_plan', { diagnosis_id: dx['diagnosis_id'] });
      const applied = await call('repair_apply', { plan_id: plan['plan_id'], confirm_token: plan['confirm_token'] });
      expect(applied['state']).toBe('applied');
      // Move household time to two seconds before the check; the alarm, not the jump, must then run it.
      const state = await demo('/demo/state', undefined, token);
      const jumpTo = Date.parse(applied['next_check_at'] as string) - 2000;
      const jump = await demo('/demo/clock', { to: jumpTo - Date.parse(state.json['now'] as string) }, token);
      expect(jump.json['pushes']).toEqual([]);
      const topic = created.json['ntfy_topic'] as string;
      const t0 = Date.now();
      while (!ntfy.received.some((p) => p.topic === topic) && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 200));
      const push = ntfy.received.find((p) => p.topic === topic);
      expect(push?.body).toMatch(/Repair confirmed\.$/);
      const status = await call('repair_status', { repair_id: applied['repair_id'] });
      expect(status['state']).toBe('confirmed');
    } finally {
      await client.close();
    }
  });
});
