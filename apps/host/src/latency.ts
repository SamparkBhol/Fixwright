// Latency per JSON-RPC method, measured in this browser: from the moment the host hands a request
// to the transport to the moment the matching response comes back. Pure functions over trace entries.

import { methodKey, type Lane, type TraceEntry } from './trace.ts';

export interface LatencyRow {
  method: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
  last: number;
}

/** Nearest rank percentile of an ascending list. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? Number.NaN;
}

export function roundTrips(entries: readonly TraceEntry[], lane: Lane = 'mcp'): Map<string, number[]> {
  const open = new Map<string, TraceEntry>();
  const out = new Map<string, number[]>();
  for (const e of entries) {
    if (e.lane !== lane || e.id === null) continue;
    const key = `${e.session}:${typeof e.id}:${String(e.id)}`;
    if (e.kind === 'request' && e.dir === 'out') open.set(key, e);
    else if ((e.kind === 'response' || e.kind === 'error') && e.dir === 'in') {
      const req = open.get(key);
      if (!req) continue;
      open.delete(key);
      const list = out.get(methodKey(req)) ?? [];
      list.push(e.t - req.t);
      out.set(methodKey(req), list);
    }
  }
  return out;
}

const ORDER = ['initialize', 'tools/list', 'resources/read', 'tools/call'];
const rank = (m: string): number => {
  const i = ORDER.findIndex((o) => m === o || m.startsWith(`${o} `));
  return i < 0 ? ORDER.length : i;
};

export function latencyTable(entries: readonly TraceEntry[], lane: Lane = 'mcp'): LatencyRow[] {
  const rows: LatencyRow[] = [];
  for (const [method, samples] of roundTrips(entries, lane)) {
    const sorted = [...samples].sort((a, b) => a - b);
    rows.push({
      method,
      n: samples.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted[sorted.length - 1] ?? Number.NaN,
      last: samples[samples.length - 1] ?? Number.NaN,
    });
  }
  return rows.sort((a, b) => rank(a.method) - rank(b.method) || a.method.localeCompare(b.method));
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return 'n/a';
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}
