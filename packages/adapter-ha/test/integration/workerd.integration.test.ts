// Runs worker/smoke.ts in workerd (wrangler dev, local mode, port 8742, inspector 8743) against the live
// Home Assistant fixture and checks every step the Worker reports. Proves the adapter needs nothing
// beyond fetch, the standard WebSocket and addEventListener. Tagged integration and workerd.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESULTS_DIR = process.env['HA_RESULTS_DIR'] ?? join(PKG, '.runtime', 'results');
const PORT = 8742;
const INSPECTOR = 8743;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let child: ChildProcess | undefined;

async function stopWrangler(): Promise<void> {
  const pid = child?.pid;
  if (!pid || child?.exitCode !== null) return;
  const gone = new Promise<void>((r) => child?.once('exit', () => r()));
  try {
    process.kill(-pid, 'SIGTERM'); // the whole group: wrangler and its workerd child
  } catch {
    return;
  }
  await Promise.race([gone, sleep(5000)]);
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

describe('HaAdapter inside workerd', { tags: ['integration', 'workerd'] }, () => {
  afterAll(stopWrangler);

  it('runs every adapter step inside wrangler dev against the live hub', { timeout: 120_000 }, async () => {
    mkdirSync(join(PKG, '.runtime'), { recursive: true });
    const log = createWriteStream(join(PKG, '.runtime', 'wrangler.log'));
    const wrangler = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');
    const t0 = Date.now();
    child = spawn(
      process.execPath,
      [wrangler, 'dev', '--ip', '127.0.0.1', '--port', String(PORT), '--inspector-port', String(INSPECTOR), '--log-level', 'warn'],
      { cwd: join(PKG, 'worker'), detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
    );
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);

    let readyMs: number | undefined;
    for (let i = 0; i < 600 && child.exitCode === null; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1000) });
        await res.body?.cancel();
        if (res.ok) {
          readyMs = Date.now() - t0;
          break;
        }
      } catch {
        // Not listening yet.
      }
      await sleep(100);
    }
    expect(readyMs, 'wrangler dev never answered; see .runtime/wrangler.log').toBeDefined();

    const res = await fetch(`http://127.0.0.1:${PORT}/smoke?ha=${encodeURIComponent(process.env['HA_URL'] ?? '')}`, {
      headers: { 'x-ha-token': process.env['HA_TOKEN'] ?? '' },
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json()) as { ok: boolean; runtime: string; steps: Record<string, { ok: boolean; ms: number; error?: string }> };
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, 'workerd-smoke.json'), `${JSON.stringify({ measured_at: new Date().toISOString(), wrangler_ready_ms: readyMs, ...body }, null, 2)}\n`);
    console.log(`workerd smoke: ready in ${readyMs} ms, runtime ${body.runtime}, steps ${JSON.stringify(Object.fromEntries(Object.entries(body.steps).map(([k, v]) => [k, v.ok ? `ok ${v.ms} ms` : v.error])))}`);

    expect(body.runtime).toBe('Cloudflare-Workers');
    for (const [name, s] of Object.entries(body.steps)) expect(s.ok, `${name}: ${s.error ?? JSON.stringify(s)}`).toBe(true);
    expect(Object.keys(body.steps)).toHaveLength(10);
    expect(body.ok).toBe(true);
  });
});
