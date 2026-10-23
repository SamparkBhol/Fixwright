// The three local origins the host needs, all in this Node process:
//   host     http://localhost:<hostPort>          the built dist/ (static)
//   sandbox  http://127.0.0.1:<sandboxPort>       the fixwright-sandbox Worker's own fetch handler
//   server   http://127.0.0.1:<serverPort>        the mock Fixwright server (MCP + demo routes)
// Host and sandbox differ in host name and port, so they are cross origin and cross site, like the
// two workers.dev hostnames in production.

import { dirname, join } from 'node:path';
import sandbox from '@fixwright/sandbox';
import { startMockServer, type MockServer } from '../mock-server.ts';
import { serveFetch, staticHandler, type RunningServer } from './http.ts';

export const HOST_DIST = join(dirname(new URL(import.meta.url).pathname), '..', '..', 'dist');

export interface StackOptions {
  hostPort?: number;
  sandboxPort?: number;
  serverPort?: number;
  views?: 'auto' | 'dist' | 'placeholder';
  toolDelayMs?: number;
}

export interface Stack {
  hostOrigin: string;
  sandboxUrl: string;
  serverUrl: string;
  mock: MockServer;
  /** The host page URL with server, sandbox and test mode wired in. */
  pageUrl(extra?: Record<string, string>): string;
  close(): Promise<void>;
}

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  const hostPort = opts.hostPort ?? 8711;
  const sandboxPort = opts.sandboxPort ?? 8712;
  const serverPort = opts.serverPort ?? 8713;
  const hostOrigin = `http://localhost:${hostPort}`;
  const running: RunningServer[] = [];
  try {
    running.push(await serveFetch(staticHandler(HOST_DIST), hostPort));
    running.push(await serveFetch((req) => sandbox.fetch(req, { HOST_ORIGINS: hostOrigin }), sandboxPort));
    const mock = await startMockServer({
      port: serverPort,
      hostOrigins: [hostOrigin],
      ...(opts.views ? { views: opts.views } : {}),
      ...(opts.toolDelayMs ? { toolDelayMs: opts.toolDelayMs } : {}),
    });
    running.push(mock);
    const sandboxUrl = `http://127.0.0.1:${sandboxPort}/sandbox.html`;
    const serverUrl = mock.url;
    return {
      hostOrigin,
      sandboxUrl,
      serverUrl,
      mock,
      pageUrl(extra = {}) {
        const q = new URLSearchParams({ server: serverUrl, sandbox: sandboxUrl, ...extra });
        return `${hostOrigin}/?${q.toString()}`;
      },
      async close() {
        await Promise.all(running.map((r) => r.close()));
      },
    };
  } catch (e) {
    await Promise.all(running.map((r) => r.close()));
    throw e;
  }
}
