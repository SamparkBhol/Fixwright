// CORS for hosts on other origins. Exact origins only, Vary: Origin on every answer, and the
// headers go on errors too, so a browser host can read a 429 or a 403 instead of an opaque failure.

export const ALLOW_METHODS = 'GET, POST, DELETE, OPTIONS';
export const ALLOW_HEADERS = 'content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id, mcp-method, mcp-name';
export const EXPOSE_HEADERS = 'mcp-session-id, mcp-protocol-version, retry-after';
export const MAX_AGE = '7200';

export type OriginDecision =
  /** No Origin header: curl, server to server, MCP clients outside a browser. */
  | { kind: 'none' }
  /** The page this Worker serves itself. */
  | { kind: 'same' }
  | { kind: 'allowed'; origin: string }
  | { kind: 'rejected'; origin: string };

export function decideOrigin(origin: string | null, selfOrigin: string, allowed: ReadonlySet<string>): OriginDecision {
  if (origin === null || origin === '') return { kind: 'none' };
  if (origin === selfOrigin) return { kind: 'same' };
  if (allowed.has(origin)) return { kind: 'allowed', origin };
  return { kind: 'rejected', origin };
}

/** Headers every response carries for this origin decision. Rejected origins get Vary only. */
export function corsHeaders(decision: OriginDecision): Record<string, string> {
  const headers: Record<string, string> = { vary: 'Origin' };
  if (decision.kind === 'allowed') {
    headers['access-control-allow-origin'] = decision.origin;
    headers['access-control-expose-headers'] = EXPOSE_HEADERS;
  }
  return headers;
}

/** OPTIONS answer: 204 with the full preflight set for an allowed origin, 403 otherwise. */
export function preflight(decision: OriginDecision): Response {
  const ok = decision.kind === 'allowed' || decision.kind === 'same';
  const headers: Record<string, string> = { ...corsHeaders(decision) };
  if (ok) {
    headers['access-control-allow-methods'] = ALLOW_METHODS;
    headers['access-control-allow-headers'] = ALLOW_HEADERS;
    headers['access-control-max-age'] = MAX_AGE;
  }
  return new Response(null, { status: ok ? 204 : 403, headers });
}

/** Adds headers to a response, copying it first when its headers are immutable (assets, fetch). */
export function withHeaders(response: Response, headers: Record<string, string>): Response {
  let out = response;
  try {
    for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  } catch {
    out = new Response(response.body, response);
    for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  }
  // Vary must list Origin even when the inner response already varies on something else.
  const vary = out.headers.get('vary');
  if (vary && !/\borigin\b/i.test(vary)) out.headers.set('vary', `${vary}, Origin`);
  return out;
}
