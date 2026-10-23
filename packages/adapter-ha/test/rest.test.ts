import { describe, expect, it } from 'vitest';
import { seededRng } from '@fixwright/protocol';
import { isHaError, type HaError } from '../src/errors.ts';
import { backoffMs, createRest, normalizeBaseUrl, type FetchLike } from '../src/rest.ts';

const TOKEN = 'secret-token-value';

function scripted(...steps: Array<Response | Error | 'hang'>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)] ?? 'hang';
    if (step === 'hang') {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step.clone());
  };
  return { fetch, calls };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const status = (code: number, body = '{"message":"nope"}', headers: Record<string, string> = {}) => new Response(body, { status: code, headers });

async function failure(p: Promise<unknown>): Promise<HaError> {
  try {
    await p;
  } catch (err) {
    if (isHaError(err)) return err;
    throw err;
  }
  throw new Error('expected a failure');
}

function rest(fetch: FetchLike, sleeps: number[] = [], over: Partial<Parameters<typeof createRest>[0]> = {}) {
  return createRest({
    baseUrl: 'http://ha.local:8123',
    token: TOKEN,
    fetch,
    rng: seededRng(7),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...over,
  });
}

describe('normalizeBaseUrl', () => {
  it('accepts a bare origin, a trailing slash or a trailing /api', () => {
    expect(normalizeBaseUrl('http://ha.local:8123')).toBe('http://ha.local:8123');
    expect(normalizeBaseUrl('http://ha.local:8123/')).toBe('http://ha.local:8123');
    expect(normalizeBaseUrl(' https://home.example/api/ ')).toBe('https://home.example');
    expect(normalizeBaseUrl('https://proxy.example/ha')).toBe('https://proxy.example/ha');
  });

  it('rejects what is not an http(s) URL', () => {
    expect(() => normalizeBaseUrl('ha.local')).toThrow(/not a valid Home Assistant URL/);
    expect(() => normalizeBaseUrl('ftp://ha.local')).toThrow(/http/);
  });
});

describe('backoffMs', () => {
  it('grows exponentially with equal jitter and a cap', () => {
    const policy = { retries: 5, baseMs: 100, maxMs: 1000 };
    const low = { next: () => 0 };
    const high = { next: () => 0.999999 };
    expect(backoffMs(0, policy, low)).toBe(50);
    expect(backoffMs(0, policy, high)).toBe(100);
    expect(backoffMs(2, policy, low)).toBe(200);
    expect(backoffMs(10, policy, high)).toBe(1000);
  });
});

describe('createRest', () => {
  it('sends the bearer token and JSON, and parses the answer', async () => {
    const { fetch, calls } = scripted(ok([{ entity_id: 'light.a' }]));
    const r = rest(fetch);
    const states = await r.callService('light', 'turn_on', { entity_id: 'light.a' });
    expect(states).toEqual([{ entity_id: 'light.a' }]);
    expect(calls[0]?.url).toBe('http://ha.local:8123/api/services/light/turn_on');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(calls[0]?.init.body).toBe('{"entity_id":"light.a"}');
  });

  it('tells auth from not found, and never retries either', async () => {
    const auth = scripted(status(401));
    const e1 = await failure(rest(auth.fetch).states());
    expect(e1.kind).toBe('auth');
    expect(e1.status).toBe(401);
    expect(auth.calls).toHaveLength(1);

    const missing = scripted(status(404, '{"message":"Entity not found."}'));
    const e2 = await failure(rest(missing.fetch).state('light.nope'));
    expect(e2.kind).toBe('not_found');
    expect(missing.calls).toHaveLength(1);
  });

  it('reports a refused connection as unreachable and retries reads with jittered backoff', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const { fetch, calls } = scripted(refused, refused, ok({ message: 'API running.' }));
    const sleeps: number[] = [];
    const out = await rest(fetch, sleeps).apiStatus();
    expect(out.message).toBe('API running.');
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(125);
    expect(sleeps[0]).toBeLessThanOrEqual(250);
    expect(sleeps[1]).toBeGreaterThanOrEqual(250);
    expect(sleeps[1]).toBeLessThanOrEqual(500);
  });

  it('gives up after the configured retries with an unreachable error that names the cause', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const { fetch, calls } = scripted(refused);
    const err = await failure(rest(fetch, [], { retry: { retries: 1 } }).states());
    expect(err.kind).toBe('unreachable');
    expect(err.message).toMatch(/ECONNREFUSED/);
    expect(err.message).not.toContain(TOKEN);
    expect(calls).toHaveLength(2);
  });

  it('never retries a service call, because a second toggle is a new fault', async () => {
    const { fetch, calls } = scripted(status(503), ok([]));
    const err = await failure(rest(fetch).callService('light', 'toggle', { entity_id: 'light.a' }));
    expect(err.kind).toBe('server');
    expect(calls).toHaveLength(1);
  });

  it('honours Retry-After on 429 and 503, capped by maxMs', async () => {
    const { fetch } = scripted(status(429, '{}', { 'retry-after': '2' }), ok([]));
    const sleeps: number[] = [];
    await rest(fetch, sleeps, { retry: { maxMs: 1500 } }).states();
    expect(sleeps).toEqual([1500]);
  });

  it('turns a hung request into a timeout error after the deadline', async () => {
    const { fetch } = scripted('hang');
    const t0 = Date.now();
    const err = await failure(rest(fetch, [], { timeoutMs: 30, retry: { retries: 0 } }).config());
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('reports a non JSON body as a protocol error', async () => {
    const { fetch } = scripted(new Response('<html>proxy error</html>', { status: 200 }));
    const err = await failure(rest(fetch).states());
    expect(err.kind).toBe('protocol');
  });

  it('refuses service names that could escape the path', async () => {
    const { fetch, calls } = scripted(ok([]));
    const err = await failure(rest(fetch).callService('light/../../api', 'x'));
    expect(err.kind).toBe('bad_request');
    expect(calls).toHaveLength(0);
  });

  it('needs a token', () => {
    expect(() => createRest({ baseUrl: 'http://ha.local', token: '' })).toThrow(/token/);
  });

  it('encodes entity ids and config entry ids in paths', async () => {
    const { fetch, calls } = scripted(ok({ entity_id: 'x' }));
    const r = rest(fetch);
    await r.state('light.a b');
    await r.reloadConfigEntry('01/ABC');
    expect(calls.map((c) => c.url)).toEqual([
      'http://ha.local:8123/api/states/light.a%20b',
      'http://ha.local:8123/api/config/config_entries/entry/01%2FABC/reload',
    ]);
  });
});
