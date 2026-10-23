// Request guards in front of every route: host name check (DNS rebinding), body size cap, and the small
// JSON helpers the routes share. Pure functions over standard Request and Response.

export const MAX_BODY_BYTES = 64 * 1024;
/** Most messages in one JSON-RPC batch on /mcp; each one costs a rate limit token. */
export const MAX_BATCH_MESSAGES = 10;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

/** A JSON-RPC shaped error, so MCP clients and plain fetch callers can both read it. */
export function rpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }, status, headers);
}

/** Host name of the Host header without port or IPv6 brackets, lower case; null when malformed. */
export function hostName(hostHeader: string | null): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(h);
  return m ? (m[1] as string) : null;
}

export function hostAllowed(hostHeader: string | null, patterns: readonly RegExp[]): boolean {
  const name = hostName(hostHeader);
  return name !== null && patterns.some((p) => p.test(name));
}

export type BodyResult = { ok: true; text: string } | { ok: false; response: Response };

/**
 * Reads at most `limit` bytes of the body. A Content-Length over the limit is refused before reading;
 * a body without one is read in chunks and refused as soon as it passes the limit.
 */
export async function readBody(request: Request, limit = MAX_BODY_BYTES): Promise<BodyResult> {
  const tooLarge = (): BodyResult => ({ ok: false, response: rpcError(413, `Request body is larger than ${limit} bytes.`) });
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) return tooLarge();
  if (!request.body) return { ok: true, text: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return tooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}

/** Parses a JSON object body; anything else is an empty object (routes validate their own fields). */
export function parseObject(text: string): Record<string, unknown> {
  if (text.trim() === '') return {};
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-real-ip') ?? 'local';
}

export function bearer(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (!auth) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  return m ? (m[1] as string) : null;
}
