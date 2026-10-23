// Runs the sandbox in real workerd (wrangler dev --local, no account) on 127.0.0.1:8714 and checks the
// HTTP contract end to end, then stops wrangler and its children. Exit code 0 only when every check passes.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { SANDBOX_ROOT } from './bundle-proxy.ts';

const PORT = 8714;
const BASE = `http://127.0.0.1:${PORT}`;
const wranglerBin = join(SANDBOX_ROOT, '..', '..', 'node_modules', '.bin', 'wrangler');

const child = spawn(
  wranglerBin,
  ['dev', '--local', '--ip', '127.0.0.1', '--port', String(PORT), '--inspector-ip', '127.0.0.1', '--inspector-port', '8719', '--show-interactive-dev-session=false'],
  {
    cwd: SANDBOX_ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, X_LOCAL_OBSERVABILITY: 'false', X_LOCAL_EXPLORER: 'false', CI: '1' },
  },
);
let log = '';
child.stdout.on('data', (d: Buffer) => (log += d.toString()));
child.stderr.on('data', (d: Buffer) => (log += d.toString()));

function stop(): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

async function waitReady(ms: number): Promise<number> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE}/sandbox.html`);
      await r.arrayBuffer();
      return performance.now() - t0;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`wrangler dev not ready after ${ms} ms\n${log}`);
}

const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push([name, ok, detail]);
};

try {
  const readyMs = await waitReady(30_000);
  const page = await fetch(`${BASE}/sandbox.html`);
  const html = await page.text();
  const csp = page.headers.get('content-security-policy') ?? '';
  check('GET /sandbox.html is 200 text/html', page.status === 200 && (page.headers.get('content-type') ?? '').startsWith('text/html'), String(page.status));
  check('default CSP blocks network and frames', csp.includes("connect-src 'none'") && csp.includes("frame-src 'none'"), csp);
  check('frame-ancestors carries HOST_ORIGINS from wrangler.jsonc vars', csp.includes('frame-ancestors http://localhost:8711 http://127.0.0.1:8711'), csp);
  check('page carries the allowlist and the proxy', html.includes('"http://localhost:8711"') && html.includes('sandbox-proxy-ready'));
  check('no Set-Cookie', page.headers.get('set-cookie') === null);
  const declared = await fetch(`${BASE}/sandbox.html?csp=${encodeURIComponent(JSON.stringify({ connectDomains: ['https://api.example.com'] }))}`);
  await declared.arrayBuffer();
  check('declared connect domain reaches the CSP', (declared.headers.get('content-security-policy') ?? '').includes('connect-src https://api.example.com'));
  const other = await fetch(`${BASE}/`);
  await other.arrayBuffer();
  check('every other path is 404', other.status === 404, String(other.status));
  const post = await fetch(`${BASE}/sandbox.html`, { method: 'POST' });
  await post.arrayBuffer();
  check('POST is 405', post.status === 405, String(post.status));
  console.log(`wrangler dev ready in ${Math.round(readyMs)} ms`);
} catch (e) {
  check('wrangler dev run', false, String(e));
} finally {
  stop();
}

let failed = 0;
for (const [name, ok, detail] of results) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  (${detail})`}`);
}
await new Promise((r) => setTimeout(r, 500));
process.exit(failed === 0 ? 0 : 1);
