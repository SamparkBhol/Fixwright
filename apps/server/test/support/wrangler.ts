// Starts `wrangler dev --local` for a test (no account, isolated --persist-to dir) and stops
// it by its own process group. Also a tiny ntfy stand in that records every push.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, openSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url));
const WRANGLER = fileURLToPath(new URL('../../../../node_modules/.bin/wrangler', import.meta.url));

export interface Dev {
  base: string;
  port: number;
  logFile: string;
  stop(): Promise<void>;
  /** PIDs of workerd processes in this dev server's process group (for the CPU meter). */
  pgid: number;
}

export async function startDev(opts: { port: number; inspector: number; name: string; vars?: Record<string, string> }): Promise<Dev> {
  const persist = `${SERVER_DIR}.wrangler/test-${opts.name}-${process.pid}`;
  rmSync(persist, { recursive: true, force: true });
  mkdirSync(persist, { recursive: true });
  const logFile = `${persist}.log`;
  const out = openSync(logFile, 'w');
  const args = [
    'dev',
    '--port', String(opts.port),
    '--ip', '127.0.0.1',
    '--inspector-port', String(opts.inspector),
    '--inspector-ip', '127.0.0.1',
    '--local',
    '--persist-to', persist,
    '--show-interactive-dev-session=false',
    // .dev.vars is git ignored, so tests bring their own (not secret) signing key.
    ...Object.entries({ CONFIRM_SECRET: 'fixwright-test-only-confirm-secret-000001', ...opts.vars }).flatMap(([k, v]) => ['--var', `${k}:${v}`]),
  ];
  const child: ChildProcess = spawn(WRANGLER, args, {
    cwd: SERVER_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, X_LOCAL_OBSERVABILITY: 'false', X_LOCAL_EXPLORER: 'false' },
  });
  const pgid = child.pid as number;
  const base = `http://127.0.0.1:${opts.port}`;
  const stop = async (): Promise<void> => {
    try {
      process.kill(-pgid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 40 && alive(pgid); i++) await new Promise((r) => setTimeout(r, 100));
    if (alive(pgid)) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    rmSync(persist, { recursive: true, force: true });
  };
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > 60_000 || child.exitCode !== null) {
      await stop();
      throw new Error(`wrangler dev did not start on ${opts.port}; see ${logFile}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { base, port: opts.port, logFile, stop, pgid };
}

function alive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface NtfyMock {
  base: string;
  received: { title: string | null; tags: string | null; body: string; topic: string }[];
  close(): Promise<void>;
}

export async function startNtfy(port: number): Promise<NtfyMock> {
  const received: NtfyMock['received'] = [];
  const server: Server = createServer((req, res) => {
    const decoder = new TextDecoder();
    let body = '';
    req.on('data', (c: Uint8Array) => (body += decoder.decode(c, { stream: true })));
    req.on('end', () => {
      if (req.method === 'POST') {
        received.push({ title: (req.headers['title'] as string) ?? null, tags: (req.headers['tags'] as string) ?? null, body, topic: decodeURIComponent((req.url ?? '/').slice(1)) });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"mock","event":"message"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
