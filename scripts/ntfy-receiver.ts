// A local stand in for ntfy.sh: records every push the server sends (POST /<topic> with Title and Tags
// headers) so the demo and the end to end test never post to the public service.
//
//   node scripts/ntfy-receiver.ts [port]     default 8703
//   GET  /_received        every push so far, oldest first, as JSON
//   GET  /_received?topic= only that topic's pushes
//   POST /_clear           forget them
//   POST /<topic>          what the server calls; answers like ntfy ({ id, event: 'message' })

import { createServer } from 'node:http';

interface Push {
  topic: string;
  title: string | null;
  tags: string | null;
  message: string;
  at: string;
}

const port = Number(process.argv[2] ?? 8703);
const received: Push[] = [];
const MAX = 1000;

const header = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && url.pathname === '/_received') {
    const topic = url.searchParams.get('topic');
    send(200, topic ? received.filter((p) => p.topic === topic) : received);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    send(200, { ok: true, received: received.length });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/_clear') {
    received.length = 0;
    send(200, { ok: true });
    return;
  }
  const topic = decodeURIComponent(url.pathname.slice(1));
  if (req.method !== 'POST' || topic === '' || topic.includes('/')) {
    send(404, { error: 'not found' });
    return;
  }
  const decoder = new TextDecoder();
  let body = '';
  req.on('data', (c: Uint8Array) => {
    body += decoder.decode(c, { stream: true });
  });
  req.on('end', () => {
    received.push({ topic, title: header(req.headers['title']), tags: header(req.headers['tags']), message: body, at: new Date().toISOString() });
    if (received.length > MAX) received.splice(0, received.length - MAX);
    send(200, { id: `local${received.length}`, event: 'message', topic });
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`ntfy receiver on http://127.0.0.1:${port}\n`);
});
const stop = (): void => {
  server.close(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
