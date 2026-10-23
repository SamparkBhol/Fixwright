// Node adapters for the three local origins of the test and dev setup:
// - serveFetch: runs a web standard fetch handler (a Worker's shape) on node:http,
// - staticHandler: serves a directory (the built host app) with no caching.
// Only 127.0.0.1 is bound; nothing listens on other interfaces.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

async function toRequest(req: IncomingMessage, port: number): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    body = Uint8Array.from(Buffer.concat(chunks));
  }
  const host = req.headers.host ?? `127.0.0.1:${port}`;
  return new Request(`http://${host}${req.url ?? '/'}`, { method: req.method, headers, body });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(response.status, headers);
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}

export function serveFetch(handler: FetchHandler, port: number, host = '127.0.0.1'): Promise<RunningServer> {
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const response = await handler(await toRequest(req, port));
        await writeResponse(res, response);
      } catch (e) {
        console.error('[serveFetch] handler failed', e);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      }
    })();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        url: `http://${host}:${port}`,
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serves files under `dir`. "/" is index.html. Paths outside `dir` are refused. */
export function staticHandler(dir: string, extraHeaders: Record<string, string> = {}): FetchHandler {
  const root = normalize(dir + sep);
  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = normalize(join(root, rel));
    if (!file.startsWith(root)) return new Response('not found', { status: 404 });
    try {
      const body = await readFile(file);
      return new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store', ...extraHeaders },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
}
