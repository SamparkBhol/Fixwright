// The sandbox Worker's HTTP contract: one page, a CSP built only from sanitized declared domains, an
// embedding allowlist from HOST_ORIGINS, no cookies. Browser behaviour (double iframe, relaying) is
// covered by the host's Playwright end to end test.

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import worker, { handle, type Env } from '../src/worker.ts';
import { buildCsp, parseCspParam, parseOrigins, sanitizeSources } from '../src/csp.ts';
import { sandboxHtml, scriptSafeJson } from '../src/page.ts';
import { GENERATED_PATH, bundleProxy, generatedModule } from '../scripts/bundle-proxy.ts';

const ENV: Env = { HOST_ORIGINS: 'http://localhost:8711, http://127.0.0.1:8711' };
const get = (path: string, env: Env = ENV, method = 'GET'): Response => handle(new Request(`http://127.0.0.1:8714${path}`, { method }), env);

const DEFAULT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "media-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  'frame-ancestors http://localhost:8711 http://127.0.0.1:8711',
].join('; ');

describe('GET /sandbox.html', () => {
  it('serves the proxy page with the spec default CSP when nothing is declared', async () => {
    const res = get('/sandbox.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(DEFAULT_CSP);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await res.text();
    expect(html).toContain('<script type="application/json" id="fixwright-hosts">["http://localhost:8711","http://127.0.0.1:8711"]</script>');
    expect(html).toContain('ui/notifications/sandbox-proxy-ready');
  });

  it('never sets a cookie, on any path or method', () => {
    for (const [path, method] of [['/sandbox.html', 'GET'], ['/sandbox.html', 'HEAD'], ['/', 'GET'], ['/sandbox.html', 'POST']] as const) {
      expect(get(path, ENV, method).headers.get('set-cookie'), `${method} ${path}`).toBeNull();
    }
  });

  it('appends declared domains from ?csp=', () => {
    const csp = encodeURIComponent(JSON.stringify({ connectDomains: ['https://api.example.com'], resourceDomains: ['https://cdn.example.com'] }));
    const header = get(`/sandbox.html?csp=${csp}`).headers.get('content-security-policy') ?? '';
    expect(header).toContain("connect-src https://api.example.com");
    expect(header).toContain("script-src 'self' 'unsafe-inline' https://cdn.example.com");
    expect(header).toContain("img-src 'self' data: https://cdn.example.com");
    expect(header).toContain("frame-src 'none'");
  });

  it('drops anything in ?csp= that could inject a directive', () => {
    const evil = {
      connectDomains: ["https://ok.example.com; script-src 'unsafe-eval'", '*', "'self'", 'javascript:alert(1)', 'https://a.example.com https://b.example.com'],
      frameDomains: ['https://frames.example.com'],
    };
    const header = get(`/sandbox.html?csp=${encodeURIComponent(JSON.stringify(evil))}`).headers.get('content-security-policy') ?? '';
    expect(header).not.toContain('unsafe-eval');
    expect(header).not.toContain('javascript:');
    expect(header).toContain("connect-src 'none'");
    expect(header).toContain('frame-src https://frames.example.com');
    expect(header.split(';').length).toBe(12);
  });

  it('treats a malformed ?csp= as nothing declared', () => {
    expect(get('/sandbox.html?csp=%7Bnot-json').headers.get('content-security-policy')).toBe(DEFAULT_CSP);
    expect(get('/sandbox.html?csp=%5B1%2C2%5D').headers.get('content-security-policy')).toBe(DEFAULT_CSP);
  });

  it('answers HEAD with headers and no body', async () => {
    const res = get('/sandbox.html', ENV, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(DEFAULT_CSP);
    expect(await res.text()).toBe('');
  });

  it('fails closed when no host origin is configured', () => {
    expect(get('/sandbox.html', {}).status).toBe(503);
    expect(get('/sandbox.html', { HOST_ORIGINS: 'not-an-origin, javascript:alert(1)' }).status).toBe(503);
  });
});

describe('everything else', () => {
  it('404s every other path', () => {
    for (const p of ['/', '/index.html', '/sandbox.html/', '/mcp', '/sandbox.js']) expect(get(p).status, p).toBe(404);
  });

  it('405s methods other than GET and HEAD', () => {
    const res = get('/sandbox.html', ENV, 'POST');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('exports a Workers module default with fetch', () => {
    const res = worker.fetch(new Request('http://x/sandbox.html'), ENV);
    expect(res.status).toBe(200);
  });
});

describe('helpers', () => {
  it('parseOrigins keeps exact origins only, lower cased, without duplicates', () => {
    expect(parseOrigins('https://Fixwright.example.workers.dev/, http://localhost:8711 http://localhost:8711,ftp://x, https://a.b/path')).toEqual([
      'https://fixwright.example.workers.dev',
      'http://localhost:8711',
    ]);
    expect(parseOrigins(undefined)).toEqual([]);
  });

  it('sanitizeSources caps the list and removes duplicates', () => {
    const many = Array.from({ length: 40 }, (_, i) => `https://h${i}.example.com`);
    expect(sanitizeSources([...many, many[0]]).length).toBe(20);
    expect(sanitizeSources(['https://*.example.com', 'wss://socket.example.com:443'])).toEqual(['https://*.example.com', 'wss://socket.example.com:443']);
  });

  it('parseCspParam ignores unknown keys and non objects', () => {
    expect(parseCspParam(JSON.stringify({ connectDomains: ['https://a.example.com'], other: ['x'] }))).toEqual({
      connectDomains: ['https://a.example.com'],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    });
    expect(parseCspParam('null')).toEqual({});
  });

  it('buildCsp forbids all embedding when no host is allowed', () => {
    expect(buildCsp({}, [])).toContain("frame-ancestors 'none'");
  });

  it('scriptSafeJson cannot close the script element', () => {
    const json = scriptSafeJson(['</script><script>alert(1)</script>', '<!--', '\u2028']);
    expect(json).not.toMatch(/[<>\u2028]/);
    expect(JSON.parse(json)).toEqual(['</script><script>alert(1)</script>', '<!--', '\u2028']);
  });

  it('the page embeds exactly one executable script', () => {
    const html = sandboxHtml(['http://localhost:8711']);
    expect(html.match(/<script>/g)?.length).toBe(1);
    expect(html.match(/<\/script>/g)?.length).toBe(2);
  });
});

describe('generated proxy script', () => {
  it('matches a fresh bundle of src/proxy.ts', async () => {
    const fresh = generatedModule(await bundleProxy());
    expect(await readFile(GENERATED_PATH, 'utf8')).toBe(fresh);
  });
});
