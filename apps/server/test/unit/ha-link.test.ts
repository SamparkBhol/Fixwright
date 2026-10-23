// /demo/link-ha hardening (only reachable with ALLOW_HA_LINK=1): the address guard, the sealed token, and
// error answers that never carry Home Assistant's own text. Home Assistant is a stub fetch here; the real
// hub run is test/integration/ha.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/mcp/views.ts', () => ({ VIEWS: [] }));

import { createApp, type Platform } from '../../src/app.ts';
import { parseConfig, type Env } from '../../src/env.ts';
import { checkHaUrl, isLoopbackHost } from '../../src/http/ha-url.ts';
import type { Db } from '../../src/household/db.ts';
import { createHousehold, type DemoOp } from '../../src/household/household.ts';
import { seal, unseal } from '../../src/lib/seal.ts';
import { sqliteDb } from '../support/sqlite-db.ts';

const SECRET = 'unit-test-secret-unit-test-secret-0003';
const HA_KEY = 'unit-test-ha-token-key-unit-test-ha-0001';
const GOOD = 'good-token-0123456789';
const HH = 'hh_link_test';

describe('checkHaUrl', () => {
  const pub = { allowLoopback: false };
  const dev = { allowLoopback: true };

  it('takes public https addresses and normalizes them', () => {
    expect(checkHaUrl('https://ha.example.com', pub)).toEqual({ ok: true, url: 'https://ha.example.com' });
    expect(checkHaUrl('https://ha.example.com:8123/', pub)).toEqual({ ok: true, url: 'https://ha.example.com:8123' });
    expect(checkHaUrl('https://example.com/ha/', pub)).toEqual({ ok: true, url: 'https://example.com/ha' });
    expect(checkHaUrl('https://93.184.216.34', pub).ok).toBe(true);
    expect(checkHaUrl('https://[2606:4700::1111]', pub).ok).toBe(true);
  });

  it('refuses plain http, credentials, queries and anything that is not a URL', () => {
    for (const bad of ['http://ha.example.com', 'ftp://ha.example.com', 'https://user:pw@ha.example.com', 'https://ha.example.com/?x=1', 'https://ha.example.com/#x', 'not a url', 'javascript:alert(1)']) {
      expect(checkHaUrl(bad, pub).ok, bad).toBe(false);
    }
  });

  it('refuses private, loopback, link-local, metadata and reserved IP literals in every spelling', () => {
    for (const bad of [
      'https://10.1.2.3',
      'https://172.16.0.1',
      'https://172.31.255.255',
      'https://192.168.1.10:8123',
      'https://127.0.0.1',
      'https://127.1',
      'https://2130706433',
      'https://0x7f.0.0.1',
      'https://0.0.0.0',
      'https://169.254.169.254',
      'https://100.64.0.1',
      'https://224.0.0.1',
      'https://255.255.255.255',
      'https://[::1]',
      'https://[::]',
      'https://[::ffff:127.0.0.1]',
      'https://[::ffff:a9fe:a9fe]',
      'https://[64:ff9b::a00:1]',
      'https://[fd00:ec2::254]',
      'https://[fc00::1]',
      'https://[fe80::1]',
      'https://[ff02::1]',
    ]) {
      expect(checkHaUrl(bad, pub).ok, bad).toBe(false);
    }
  });

  it('refuses names that only resolve inside a network', () => {
    for (const bad of ['https://localhost', 'https://homeassistant', 'https://homeassistant.local', 'https://metadata.google.internal', 'https://ha.home.arpa', 'https://ha.lan', 'https://x.localhost']) {
      expect(checkHaUrl(bad, pub).ok, bad).toBe(false);
    }
  });

  it('allows localhost over http only while the server itself runs on a loopback host', () => {
    expect(checkHaUrl('http://127.0.0.1:8741', dev)).toEqual({ ok: true, url: 'http://127.0.0.1:8741' });
    expect(checkHaUrl('http://localhost:8123', dev).ok).toBe(true);
    expect(checkHaUrl('http://127.0.0.1:8741', pub).ok).toBe(false);
    expect(checkHaUrl('http://10.0.0.2:8123', dev).ok).toBe(false);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('fixwright.example.workers.dev')).toBe(false);
  });
});

describe('sealed tokens', () => {
  it('round trips, and does not open for another household, another key or a changed byte', async () => {
    const sealed = await seal(HA_KEY, GOOD, HH);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(GOOD);
    expect(await unseal(HA_KEY, sealed, HH)).toBe(GOOD);
    expect(await unseal(HA_KEY, sealed, 'hh_other')).toBeNull();
    expect(await unseal(SECRET, sealed, HH)).toBeNull();
    // Change one character in the middle of the ciphertext (6 whole bits, never the padding bits).
    const at = sealed.lastIndexOf('.') + 10;
    const flipped = sealed.slice(0, at) + (sealed[at] === 'A' ? 'B' : 'A') + sealed.slice(at + 1);
    expect(flipped).not.toBe(sealed);
    expect(await unseal(HA_KEY, flipped, HH)).toBeNull();
    expect(await unseal(HA_KEY, 'v1.x.y', HH)).toBeNull();
    expect(await seal(HA_KEY, GOOD, HH)).not.toBe(sealed); // a fresh IV every time
  });
});

interface Seen {
  url: string;
  auth: string | null;
  redirect: RequestRedirect | undefined;
}

/** A Home Assistant stand in: /api/config answers for the good token, everything else fails with a body. */
function haStub(mode: { down?: boolean } = {}) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization');
    if (url.startsWith('http://ntfy.test')) return new Response('{}');
    seen.push({ url, auth, redirect: init?.redirect });
    if (mode.down) throw new TypeError('fetch failed: connect ECONNREFUSED 203.0.113.9:8123');
    if (auth !== `Bearer ${GOOD}`) return new Response('401: upstream says the token abc-secret-detail is wrong', { status: 401 });
    if (url.endsWith('/api/config')) return Response.json({ state: 'RUNNING', version: '2026.9.4', location_name: 'Test', time_zone: 'America/Los_Angeles', unit_system: {}, components: [] });
    return new Response('upstream stack trace with internal detail', { status: 500 });
  }) as typeof fetch;
  return { fetchFn, seen };
}

function household(db: Db, fetchFn: typeof fetch, tokenKey = HA_KEY) {
  return createHousehold(db, HH, { secret: SECRET, tokenKey, ntfyBase: 'http://ntfy.test', demoStart: '2026-10-15T22:00:00.000Z', allowHaLink: true, realNow: () => Date.parse('2026-10-17T12:00:00.000Z'), fetch: fetchFn, setAlarm: async () => {} });
}

const link: DemoOp = { op: 'link_ha', base_url: 'https://ha.example.com', token: GOOD };

describe('linking a household to Home Assistant', () => {
  const dbs: (Db & { close(): void })[] = [];
  const db = () => {
    const d = sqliteDb();
    dbs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dbs.splice(0)) d.close();
  });

  it('stores the token sealed, never in plain text, and calls without following redirects', async () => {
    const d = db();
    const ha = haStub();
    const out = await household(d, ha.fetchFn).demo(link);
    expect(out).toEqual({ status: 200, body: { ok: true, adapter: 'home-assistant', version: '2026.9.4' } });
    expect(ha.seen.every((s) => s.redirect === 'manual')).toBe(true);
    const stored = JSON.parse(d.sql.exec<{ value: string }>(`SELECT value FROM settings WHERE key = 'adapter'`).one().value) as Record<string, string>;
    expect(Object.keys(stored).sort()).toEqual(['base_url', 'kind', 'token_sealed']);
    expect(await unseal(HA_KEY, stored['token_sealed'] as string, HH)).toBe(GOOD);
    const everything = d.sql.exec<{ value: string }>(`SELECT value FROM settings`).toArray().map((r) => r.value).join('\n');
    expect(everything).not.toContain(GOOD);
  });

  it('a later call opens the token and sends it; upstream error text never reaches the caller', async () => {
    const d = db();
    const ha = haStub();
    await household(d, ha.fetchFn).demo(link);
    const woke = household(d, ha.fetchFn);
    ha.seen.length = 0;
    const out = await woke.tool('home_checkup', {});
    expect(ha.seen.length).toBeGreaterThan(0);
    expect(ha.seen.every((s) => s.auth === `Bearer ${GOOD}` && s.redirect === 'manual')).toBe(true);
    expect(out.isError).toBe(true);
    const text = JSON.stringify(out.structuredContent);
    expect(text).not.toContain('upstream');
    expect(text).not.toContain('internal detail');
    // Tool errors carry a code and a spoken line only (protocol problemOutput), never the upstream message.
    expect(Object.keys(out.structuredContent['problem'] as object).sort()).toEqual(['code', 'retryable']);
  });

  it('a token sealed under another key asks the person to link again', async () => {
    const d = db();
    const ha = haStub();
    await household(d, ha.fetchFn).demo(link);
    const rekeyed = household(d, ha.fetchFn, 'another-ha-token-key-another-ha-token-key');
    const out = await rekeyed.tool('home_checkup', {});
    expect(out.isError).toBe(true);
    expect(out.structuredContent['speech']).toBe("I can't use the saved Home Assistant link any more. Please link it again in the Fixwright settings.");
  });

  it('a refused token or an unreachable hub gets a fixed line, not Home Assistant text', async () => {
    const bad = await household(db(), haStub().fetchFn).demo({ ...link, token: 'wrong-token-0000000' });
    expect(bad).toEqual({ status: 502, body: { ok: false, error: 'Home Assistant did not accept that token.' } });
    const down = await household(db(), haStub({ down: true }).fetchFn).demo(link);
    expect(down.status).toBe(502);
    expect(['Could not reach Home Assistant at that address.', 'Home Assistant did not answer as running.']).toContain(down.body['error']);
    expect(JSON.stringify(down.body)).not.toContain('ECONNREFUSED');
  });
});

describe('POST /demo/link-ha address guard', () => {
  function app(host: string) {
    const ops: DemoOp[] = [];
    const platform: Platform = {
      tool: async () => ({ structuredContent: {}, isError: true }),
      demo: async (_hh, op) => {
        ops.push(op);
        return { status: 200, body: { ok: true } };
      },
      take: async () => ({ ok: true, remaining: 1 }),
      assets: async () => new Response('', { status: 404 }),
    };
    const cfg = parseConfig({ CONFIRM_SECRET: SECRET, ALLOW_HA_LINK: '1', PUBLIC_HOSTNAMES: 'localhost,127.0.0.1,fixwright.*.workers.dev' } as Env);
    const handle = createApp(platform, () => cfg);
    const post = (baseUrl: string) =>
      handle(new Request(`http://${host}/demo/link-ha`, { method: 'POST', headers: { host, 'content-type': 'application/json' }, body: JSON.stringify({ base_url: baseUrl, token: GOOD }) }));
    return { post, ops };
  }

  it('deployed: refuses localhost, private addresses and http before any Durable Object is reached', async () => {
    const a = app('fixwright.demo.workers.dev');
    for (const bad of ['http://127.0.0.1:8741', 'https://192.168.1.2:8123', 'http://ha.example.com', 'https://169.254.169.254']) {
      const res = await a.post(bad);
      expect(res.status, bad).toBe(400);
    }
    expect(a.ops).toHaveLength(0);
    expect((await a.post('https://ha.example.com/')).status).toBe(200);
    expect(a.ops).toEqual([{ op: 'link_ha', base_url: 'https://ha.example.com', token: GOOD }]);
  });

  it('under wrangler dev on 127.0.0.1: the local test hub over http is allowed', async () => {
    const a = app('127.0.0.1:8701');
    expect((await a.post('http://127.0.0.1:8741')).status).toBe(200);
    expect((await a.post('https://10.0.0.3')).status).toBe(400);
  });
});
