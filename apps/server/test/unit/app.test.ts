// The Worker pipeline in process (no workerd): rate limit accounting for JSON-RPC batches. The views are
// wrangler Text modules, so they are stubbed here; test/integration serves the real ones.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/mcp/views.ts', () => ({ VIEWS: [] }));

import { createApp, type Platform } from '../../src/app.ts';
import { takeToken, type Bucket } from '../../src/bucket.ts';
import { parseConfig, type Env } from '../../src/env.ts';
import { MAX_BATCH_MESSAGES } from '../../src/http/guards.ts';

const SECRET = 'unit-test-secret-unit-test-secret-0002';
const BASE = 'http://127.0.0.1:8701';

function rig(perMinute: number) {
  const buckets = new Map<string, Bucket>();
  const toolCalls: string[] = [];
  const takes: { ip: string; cost: number }[] = [];
  const platform: Platform = {
    async tool(_household, name) {
      toolCalls.push(name);
      return { structuredContent: { speech: 'ok' }, isError: false };
    },
    async demo() {
      return { status: 200, body: {} };
    },
    async take(ip, bucket, perMin, cost = 1) {
      takes.push({ ip, cost });
      const key = `${ip}|${bucket}`;
      const out = takeToken(buckets.get(key), 0, perMin, cost);
      buckets.set(key, out.bucket);
      return out.result;
    },
    async assets() {
      return new Response('not found', { status: 404 });
    },
  };
  const cfg = parseConfig({ CONFIRM_SECRET: SECRET, RATE_MCP_PER_MIN: String(perMinute) } as Env);
  return { handle: createApp(platform, () => cfg), toolCalls, takes };
}

const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'home_checkup', arguments: {} } });

function post(body: unknown, ip = '203.0.113.7'): Request {
  return new Request(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:8701',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26',
      'cf-connecting-ip': ip,
    },
    body: JSON.stringify(body),
  });
}

describe('JSON-RPC batches and the rate limit', () => {
  it('charges one token per message in a batch', async () => {
    const r = rig(12);
    const first = await r.handle(post(Array.from({ length: MAX_BATCH_MESSAGES }, (_, i) => call(i + 1))));
    expect(first.status).toBe(200);
    await first.text();
    expect(r.toolCalls).toHaveLength(MAX_BATCH_MESSAGES);
    expect(r.takes).toEqual([
      { ip: '203.0.113.7', cost: 1 },
      { ip: '203.0.113.7', cost: MAX_BATCH_MESSAGES - 1 },
    ]);
    // 12 tokens: the first batch spent 10, so a second batch of 10 is refused before any tool runs.
    const second = await r.handle(post(Array.from({ length: MAX_BATCH_MESSAGES }, (_, i) => call(i + 20))));
    expect(second.status).toBe(429);
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(r.toolCalls).toHaveLength(MAX_BATCH_MESSAGES);
    // One token is left for a single call; the refused batch cost nothing beyond its own request token.
    const single = await r.handle(post(call(99)));
    expect(single.status).toBe(200);
    await single.text();
    expect(r.toolCalls).toHaveLength(MAX_BATCH_MESSAGES + 1);
  });

  it(`refuses a batch of more than ${MAX_BATCH_MESSAGES} messages without running any of them`, async () => {
    const r = rig(240);
    const res = await r.handle(post(Array.from({ length: MAX_BATCH_MESSAGES + 1 }, (_, i) => call(i + 1))));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32600);
    expect(r.toolCalls).toHaveLength(0);
  });

  it('a 100 message batch runs nothing', async () => {
    const r = rig(240);
    const res = await r.handle(post(Array.from({ length: 100 }, (_, i) => call(i + 1))));
    expect(res.status).toBe(400);
    expect(r.toolCalls).toHaveLength(0);
  });

  it('a single message still costs exactly one token', async () => {
    const r = rig(240);
    const res = await r.handle(post(call(1)));
    expect(res.status).toBe(200);
    await res.text();
    expect(r.takes).toEqual([{ ip: '203.0.113.7', cost: 1 }]);
  });
});
