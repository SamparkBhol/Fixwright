// Two origins, as MCP Apps requires:
//   host     http://localhost:<hostPort>/       harness page, host stub, built views, fixtures
//   sandbox  http://127.0.0.1:<sandboxPort>/     sandbox.html only, with the spec's restrictive default CSP
// Manual use: node scripts/build.ts && node test/harness/serve.ts, then open http://localhost:8725/
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROTOCOL_FIXTURES = path.resolve(ROOT, '..', '..', 'packages', 'protocol', 'fixtures');

export const DEFAULT_PORTS = { host: 8725, sandbox: 8726 } as const;
/** Pairs tried in order when no ports are given, all inside this module's range (8721 to 8729), so a
 *  second run in parallel does not fail on a busy port. */
export const PORT_PAIRS: readonly { host: number; sandbox: number }[] = [DEFAULT_PORTS, { host: 8727, sandbox: 8728 }, { host: 8723, sandbox: 8724 }, { host: 8721, sandbox: 8722 }];

/** MCP Apps restrictive default CSP (no ui.csp declared): nothing leaves the frame. */
export const SANDBOX_CSP = [
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
].join('; ');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const SAFE_NAME = /^[a-z0-9_-]+$/i;

function hostRoute(pathname: string): string | null {
  if (pathname === '/' || pathname === '/index.html') return path.join(ROOT, 'test/harness.html');
  if (pathname === '/harness/host.js') return path.join(ROOT, 'test/harness/out/host.js');
  const view = pathname.match(/^\/views\/([^/]+)\.html$/);
  if (view?.[1] && SAFE_NAME.test(view[1])) return path.join(ROOT, 'dist', `${view[1]}.html`);
  const fx = pathname.match(/^\/fixtures\/(protocol|views)\/([^/]+)\.json$/);
  if (fx?.[2] && SAFE_NAME.test(fx[2])) return path.join(fx[1] === 'protocol' ? PROTOCOL_FIXTURES : path.join(ROOT, 'fixtures'), `${fx[2]}.json`);
  return null;
}

async function send(res: http.ServerResponse, file: string | null, headers: Record<string, string> = {}): Promise<void> {
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', ...headers }).end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}

export interface Harness {
  hostUrl: string;
  sandboxUrl: string;
  close(): Promise<void>;
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

function closeServer(s: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!s.listening) return resolve();
    s.closeAllConnections();
    s.close(() => resolve());
  });
}

/** VIEWS_HARNESS_PORTS="host,sandbox" pins the pair, for a run that must stay in another port range. */
function envPorts(): { host: number; sandbox: number } | undefined {
  const m = /^\s*(\d{4,5})\s*,\s*(\d{4,5})\s*$/.exec(process.env['VIEWS_HARNESS_PORTS'] ?? '');
  return m ? { host: Number(m[1]), sandbox: Number(m[2]) } : undefined;
}

export async function startHarness(ports?: { host: number; sandbox: number }): Promise<Harness> {
  const pinned = ports ?? envPorts();
  const pairs = pinned ? [pinned] : PORT_PAIRS;
  let lastError: unknown;
  for (const pair of pairs) {
    try {
      return await startOn(pair);
    } catch (e) {
      lastError = e;
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  throw lastError;
}

async function startOn(ports: { host: number; sandbox: number }): Promise<Harness> {
  const host = http.createServer((req, res) => void send(res, hostRoute(new URL(req.url ?? '/', 'http://x').pathname)));
  const sandbox = http.createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://x');
    void send(res, pathname === '/sandbox.html' ? path.join(ROOT, 'test/harness/out/sandbox.html') : null, { 'content-security-policy': SANDBOX_CSP });
  });
  try {
    await listen(host, ports.host);
    await listen(sandbox, ports.sandbox);
  } catch (e) {
    await Promise.all([closeServer(host), closeServer(sandbox)]);
    throw e;
  }
  const sandboxUrl = `http://127.0.0.1:${ports.sandbox}/sandbox.html`;
  return {
    hostUrl: `http://localhost:${ports.host}/?sandbox=${encodeURIComponent(sandboxUrl)}`,
    sandboxUrl,
    close: () => Promise.all([closeServer(host), closeServer(sandbox)]).then(() => undefined),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const h = await startHarness();
  console.log(`harness: ${h.hostUrl}`);
  console.log(`sandbox: ${h.sandboxUrl}`);
  const stop = () => void h.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
