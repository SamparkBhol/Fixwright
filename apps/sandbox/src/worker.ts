// fixwright-sandbox: a Worker on its own origin that serves exactly one page, /sandbox.html, the MCP
// Apps sandbox proxy. The CSP comes from ?csp= (the view's declared domains, sanitized), the hosts
// that may embed it come from the HOST_ORIGINS variable, and it never sets a cookie: the views share
// this origin, so nothing else may live here.

import { buildCsp, parseCspParam, parseOrigins } from './csp.ts';
import { sandboxHtml } from './page.ts';

export interface Env {
  /** Comma separated exact origins of the host simulator, e.g. "https://fixwright.example.workers.dev". */
  HOST_ORIGINS?: string;
}

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'cross-origin',
};

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8', ...extra },
  });
}

export function handle(request: Request, env: Env): Response {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'Method not allowed.', { allow: 'GET, HEAD' });
  if (url.pathname !== '/sandbox.html') return text(404, 'Only /sandbox.html is served here.');

  const origins = parseOrigins(env.HOST_ORIGINS);
  if (origins.length === 0) return text(503, 'HOST_ORIGINS is not configured, so no host may embed this sandbox.');

  const csp = buildCsp(parseCspParam(url.searchParams.get('csp')), origins);
  const headers = { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp };
  return new Response(request.method === 'HEAD' ? null : sandboxHtml(origins), { status: 200, headers });
}

export default {
  fetch(request: Request, env: Env): Response {
    return handle(request, env);
  },
};
