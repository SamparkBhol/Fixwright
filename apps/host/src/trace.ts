// Visual Trace store: every JSON-RPC message on two lanes, exactly as sent and received.
// - mcp: host <-> MCP server (captured by patching the SDK transport's send and onmessage)
// - bridge: host <-> view (captured on the AppBridge's PostMessageTransport)
// Entries are plain data; the Latency tab and the tests derive everything from them.

export type Lane = 'mcp' | 'bridge';
/** out: the host sent it (to the server or to the view). in: the host received it. */
export type Dir = 'out' | 'in';
export type MessageKind = 'request' | 'notification' | 'response' | 'error';

export interface TraceEntry {
  seq: number;
  lane: Lane;
  dir: Dir;
  /** Which MCP client or view instance; JSON-RPC ids restart per session. */
  session: number;
  /** performance.now() when the message passed the host. */
  t: number;
  kind: MessageKind;
  /** Method name, or "result" / "error" for responses. */
  method: string;
  id: string | number | null;
  /** For tools/call: the tool name. */
  tool: string | null;
  bytes: number;
  msg: unknown;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export function classify(msg: unknown): Pick<TraceEntry, 'kind' | 'method' | 'id' | 'tool'> {
  if (!isObj(msg)) return { kind: 'notification', method: 'unknown', id: null, tool: null };
  const rawId = msg['id'];
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
  if (typeof msg['method'] === 'string') {
    const params = isObj(msg['params']) ? msg['params'] : {};
    const tool = msg['method'] === 'tools/call' && typeof params['name'] === 'string' ? params['name'] : null;
    return { kind: id === null ? 'notification' : 'request', method: msg['method'], id, tool };
  }
  if ('error' in msg) return { kind: 'error', method: 'error', id, tool: null };
  return { kind: 'response', method: 'result', id, tool: null };
}

export interface TraceStore {
  readonly entries: readonly TraceEntry[];
  add(lane: Lane, dir: Dir, session: number, msg: unknown): TraceEntry;
  subscribe(fn: (e: TraceEntry) => void): () => void;
  clear(): void;
}

function sizeOf(msg: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(msg)).length;
  } catch {
    return 0;
  }
}

export function createTrace(now: () => number, cap = 2000): TraceStore {
  const entries: TraceEntry[] = [];
  const subs = new Set<(e: TraceEntry) => void>();
  let seq = 0;
  return {
    entries,
    add(lane, dir, session, msg) {
      const e: TraceEntry = { seq: ++seq, lane, dir, session, t: now(), ...classify(msg), bytes: sizeOf(msg), msg };
      entries.push(e);
      if (entries.length > cap) entries.splice(0, entries.length - cap);
      for (const fn of subs) fn(e);
      return e;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    clear() {
      entries.length = 0;
    },
  };
}

/** The request a response answers (same lane, session and id, opposite direction, earlier). */
export function requestFor(entries: readonly TraceEntry[], response: TraceEntry): TraceEntry | null {
  if (response.kind !== 'response' && response.kind !== 'error') return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.seq >= response.seq) continue;
    if (e.kind === 'request' && e.lane === response.lane && e.session === response.session && e.id === response.id && e.dir !== response.dir) return e;
  }
  return null;
}

/** "tools/call diagnose" for tool calls, the method otherwise. */
export const methodKey = (e: Pick<TraceEntry, 'method' | 'tool'>): string => (e.tool ? `${e.method} ${e.tool}` : e.method);
