// Token bucket arithmetic, pure: capacity = perMinute (the burst), refilled continuously at perMinute/60 s.
// A request may cost more than one token (a JSON-RPC batch costs one per message); a refused take costs nothing.

export interface Bucket {
  tokens: number;
  atMs: number;
}

export type TakeResult = { ok: true; remaining: number } | { ok: false; retryAfterS: number };

export function takeToken(bucket: Bucket | undefined, nowMs: number, perMinute: number, cost = 1): { bucket: Bucket; result: TakeResult } {
  const capacity = perMinute;
  const ratePerMs = perMinute / 60_000;
  const need = Math.max(1, Math.ceil(cost));
  const prev = bucket ?? { tokens: capacity, atMs: nowMs };
  const elapsed = Math.max(0, nowMs - prev.atMs);
  const tokens = Math.min(capacity, prev.tokens + elapsed * ratePerMs);
  if (tokens >= need) {
    return { bucket: { tokens: tokens - need, atMs: nowMs }, result: { ok: true, remaining: Math.floor(tokens - need) } };
  }
  // A cost above the burst can never be paid; the answer is still a finite wait (a full bucket's worth).
  const retryAfterS = Math.max(1, Math.ceil((Math.min(need, capacity) - tokens) / ratePerMs / 1000));
  return { bucket: { tokens, atMs: nowMs }, result: { ok: false, retryAfterS } };
}
