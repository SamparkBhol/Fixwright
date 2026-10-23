// Calls to the server's demo routes and the household token. The token lives in
// localStorage only as a convenience: storage can be missing or throw (private windows, blocked site
// data), and the host then uses the shared public household. Tokens are kept per server origin, because
// a household and its push topic only exist on the server that minted it. Response bodies are read
// defensively until the protocol package carries schemas for the demo routes.

import type { ConversationState, ReplyRoute, ToolRoute } from '@fixwright/router';

export interface Household {
  token: string;
  ntfyTopic: string | null;
}

const STORAGE_PREFIX = 'fixwright.household.v2:';

/** One storage slot per server origin; a URL that does not parse gets its own slot as written. */
export function householdKey(serverUrl: string): string {
  let origin = serverUrl;
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    // keep the raw string
  }
  return `${STORAGE_PREFIX}${origin}`;
}

export function loadHousehold(storage: () => Storage | null, serverUrl: string): Household | null {
  try {
    const raw = storage()?.getItem(householdKey(serverUrl));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Household>;
    return typeof v.token === 'string' && /^hh_[0-9a-z_]+$/i.test(v.token) ? { token: v.token, ntfyTopic: v.ntfyTopic ?? null } : null;
  } catch {
    return null;
  }
}

export function saveHousehold(storage: () => Storage | null, serverUrl: string, h: Household | null): void {
  try {
    const s = storage();
    if (!s) return;
    if (h) s.setItem(householdKey(serverUrl), JSON.stringify(h));
    else s.removeItem(householdKey(serverUrl));
  } catch {
    // storage unavailable: the token lives for this page only
  }
}

export const browserStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export interface DemoResponse {
  ok: boolean;
  status: number;
  body: unknown;
  ms: number;
}

export interface DemoApi {
  createHousehold(): Promise<Household | null>;
  fault(faultId: string): Promise<DemoResponse>;
  reset(): Promise<DemoResponse>;
  clock(to: 'next_morning' | number): Promise<DemoResponse>;
  state(): Promise<DemoResponse>;
  route(utterance: string, state: ConversationState): Promise<ToolRoute | ReplyRoute>;
}

/** A demo route that never answers gives up after this long (ready() waits for /demo/state). */
export const DEMO_TIMEOUT_MS = 10_000;

export function createDemoApi(
  serverUrl: string,
  token: () => string | null,
  now: () => number = () => performance.now(),
  timeoutMs: number = DEMO_TIMEOUT_MS,
): DemoApi {
  async function send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<DemoResponse> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const t = token();
    if (t) headers['authorization'] = `Bearer ${t}`;
    const t0 = now();
    try {
      const res = await fetch(`${serverUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON
      }
      return { ok: res.ok, status: res.status, body: parsed, ms: now() - t0 };
    } catch (e) {
      return { ok: false, status: 0, body: { error: e instanceof Error ? e.message : String(e) }, ms: now() - t0 };
    }
  }

  return {
    async createHousehold() {
      const r = await send('POST', '/demo/household', {});
      const b = r.body as { token?: unknown; ntfy_topic?: unknown } | null;
      if (!r.ok || !b || typeof b.token !== 'string') return null;
      return { token: b.token, ntfyTopic: typeof b.ntfy_topic === 'string' ? b.ntfy_topic : null };
    },
    fault: (faultId) => send('POST', '/demo/fault', { fault_id: faultId }),
    reset: () => send('POST', '/demo/reset', {}),
    clock: (to) => send('POST', '/demo/clock', { to }),
    state: () => send('GET', '/demo/state'),
    async route(utterance, state) {
      const r = await send('POST', '/assistant/route', { utterance, state });
      const b = r.body as Partial<ToolRoute & ReplyRoute> | null;
      if (r.ok && b && typeof b.tool === 'string' && typeof b.arguments === 'object') return b as ToolRoute;
      if (r.ok && b && typeof b.reply === 'string') return b as ReplyRoute;
      throw new Error(`assistant/route answered ${r.status}`);
    },
  };
}
