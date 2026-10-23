import { describe, expect, it } from 'vitest';
import { takeToken } from '../../src/bucket.ts';
import { ALLOW_HEADERS, corsHeaders, decideOrigin, preflight, withHeaders } from '../../src/http/cors.ts';
import { bearer, hostAllowed, hostName, MAX_BODY_BYTES, parseObject, readBody } from '../../src/http/guards.ts';
import { hostPattern, parseConfig, parseOrigins } from '../../src/env.ts';

const allowed = parseOrigins('http://localhost:8711, https://host.example, not-an-origin, https://x.example/path');
const SELF = 'https://fixwright.demo.workers.dev';

describe('CORS', () => {
  it('keeps only exact, well formed origins', () => {
    expect([...allowed]).toEqual(['http://localhost:8711', 'https://host.example']);
  });

  it('allows listed origins with Vary and exposed headers', () => {
    const d = decideOrigin('https://host.example', SELF, allowed);
    expect(d).toEqual({ kind: 'allowed', origin: 'https://host.example' });
    expect(corsHeaders(d)).toMatchObject({ vary: 'Origin', 'access-control-allow-origin': 'https://host.example' });
    expect(corsHeaders(d)['access-control-expose-headers']).toContain('mcp-session-id');
  });

  it('rejects near misses: other port, other scheme, subdomain, null', () => {
    for (const o of ['http://localhost:8712', 'http://host.example', 'https://evil.host.example', 'null']) {
      const d = decideOrigin(o, SELF, allowed);
      expect(d.kind, o).toBe('rejected');
      expect(corsHeaders(d)).toEqual({ vary: 'Origin' });
    }
  });

  it('treats same origin and no origin as allowed without CORS headers', () => {
    expect(decideOrigin(SELF, SELF, allowed).kind).toBe('same');
    expect(decideOrigin(null, SELF, allowed).kind).toBe('none');
  });

  it('answers preflight 204 with the full CORS header set, 403 for a rejected origin', () => {
    const ok = preflight(decideOrigin('http://localhost:8711', SELF, allowed));
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE, OPTIONS');
    expect(ok.headers.get('access-control-allow-headers')).toBe(ALLOW_HEADERS);
    expect(ALLOW_HEADERS.split(', ')).toEqual(['content-type', 'accept', 'authorization', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id', 'mcp-method', 'mcp-name']);
    expect(ok.headers.get('access-control-max-age')).toBe('7200');
    const no = preflight(decideOrigin('https://evil.example', SELF, allowed));
    expect(no.status).toBe(403);
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
    expect(no.headers.get('vary')).toBe('Origin');
  });

  it('adds headers to immutable responses and keeps an existing Vary', async () => {
    const frozen = Response.redirect('https://example.com/', 302);
    const out = withHeaders(frozen, { vary: 'Origin', 'access-control-allow-origin': 'https://host.example' });
    expect(out.headers.get('access-control-allow-origin')).toBe('https://host.example');
    const varied = withHeaders(new Response('x', { headers: { vary: 'Accept-Encoding' } }), {});
    expect(varied.headers.get('vary')).toBe('Accept-Encoding, Origin');
  });
});

describe('host check', () => {
  const patterns = ['localhost', '127.0.0.1', 'fixwright.*.workers.dev'].map(hostPattern).filter((p): p is RegExp => p !== null);
  it('matches names with ports and one label wildcards only', () => {
    expect(hostAllowed('127.0.0.1:8701', patterns)).toBe(true);
    expect(hostAllowed('fixwright.someone.workers.dev', patterns)).toBe(true);
    expect(hostAllowed('fixwright.a.b.workers.dev', patterns)).toBe(false);
    expect(hostAllowed('evil.example', patterns)).toBe(false);
    expect(hostAllowed(null, patterns)).toBe(false);
    expect(hostName('[::1]:80')).toBe('[::1]');
    expect(hostName('bad host')).toBeNull();
  });
});

describe('body cap and helpers', () => {
  it('refuses a declared or streamed body over 64 KB, accepts one at the limit', async () => {
    const big = 'x'.repeat(MAX_BODY_BYTES + 1);
    const declared = await readBody(new Request('https://a.example/', { method: 'POST', body: big }));
    expect(declared.ok).toBe(false);
    if (!declared.ok) expect(declared.response.status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 70; i++) c.enqueue(new Uint8Array(1024));
        c.close();
      },
    });
    const streamed = await readBody(new Request('https://a.example/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit));
    expect(streamed.ok).toBe(false);
    const exact = await readBody(new Request('https://a.example/', { method: 'POST', body: 'y'.repeat(MAX_BODY_BYTES) }));
    expect(exact.ok && exact.text.length).toBe(MAX_BODY_BYTES);
  });

  it('parses bearer tokens and JSON objects defensively', () => {
    expect(bearer(new Request('https://a.example/', { headers: { authorization: 'Bearer hh_x' } }))).toBe('hh_x');
    expect(bearer(new Request('https://a.example/', { headers: { authorization: 'Basic abc' } }))).toBeNull();
    expect(parseObject('[1]')).toEqual({});
    expect(parseObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseObject('{oops')).toEqual({});
  });

  it('parses config with safe defaults', () => {
    const c = parseConfig({ CONFIRM_SECRET: 'short', NTFY_BASE: 'ftp://x', RATE_MCP_PER_MIN: '-1' } as never);
    expect(c.secret).toBeNull();
    expect(c.ntfyBase).toBe('https://ntfy.sh');
    expect(c.rateMcpPerMin).toBe(240);
    expect(c.allowHaLink).toBe(false);
  });
});

describe('token bucket', () => {
  it('allows a burst of perMinute, then refuses with Retry-After, then refills', () => {
    let bucket;
    let t = 0;
    for (let i = 0; i < 5; i++) {
      const r = takeToken(bucket, t, 5);
      expect(r.result.ok).toBe(true);
      bucket = r.bucket;
    }
    const refused = takeToken(bucket, t, 5);
    expect(refused.result).toEqual({ ok: false, retryAfterS: 12 });
    t += 12_000;
    expect(takeToken(refused.bucket, t, 5).result.ok).toBe(true);
  });

  it('takes several tokens at once, and a refused take costs nothing', () => {
    const a = takeToken(undefined, 0, 10, 7);
    expect(a.result).toEqual({ ok: true, remaining: 3 });
    const b = takeToken(a.bucket, 0, 10, 4);
    expect(b.result).toEqual({ ok: false, retryAfterS: 6 });
    expect(b.bucket.tokens).toBe(3);
    expect(takeToken(b.bucket, 0, 10, 3).result).toEqual({ ok: true, remaining: 0 });
    expect(takeToken(undefined, 0, 5, 9).result.ok).toBe(false);
  });
});
