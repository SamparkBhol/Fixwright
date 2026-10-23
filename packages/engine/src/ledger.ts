// The ledger is the engine's only memory of what happened. Every claim cites ledger seqs, so home events
// the adapter reports are copied in (once) before the engine reasons about them.

import type { EventQuery, HouseEvent } from '@fixwright/protocol';
import type { EngineDeps, Ledger, LedgerQuery } from './types.ts';

const ms = (iso: string): number => Date.parse(iso);

export function matchesQuery(e: HouseEvent, q: LedgerQuery): boolean {
  if (q.since !== undefined && ms(e.ts) < ms(q.since)) return false;
  if (q.until !== undefined && ms(e.ts) > ms(q.until)) return false;
  if (q.entityIds !== undefined && (e.entityId === undefined || !q.entityIds.includes(e.entityId))) return false;
  if (q.kinds !== undefined && !q.kinds.includes(e.kind)) return false;
  if (q.seqs !== undefined && !q.seqs.includes(e.seq)) return false;
  if (q.source !== undefined && e.source !== q.source) return false;
  return true;
}

export interface MemoryLedger extends Ledger {
  /** Every event in seq order (a copy). */
  all(): HouseEvent[];
}

/** An in memory ledger for tests, the bench and the browser. Seqs start at 1. */
export function createMemoryLedger(): MemoryLedger {
  const events: HouseEvent[] = [];
  return {
    async append(e) {
      const seq = events.length + 1;
      events.push({ ...e, seq });
      return seq;
    },
    async query(q) {
      if (q.seqs !== undefined) {
        return q.seqs
          .map((s) => events[s - 1])
          .filter((e): e is HouseEvent => e !== undefined && matchesQuery(e, q))
          .sort((a, b) => a.seq - b.seq);
      }
      return events.filter((e) => matchesQuery(e, q));
    },
    all: () => events.map((e) => ({ ...e })),
  };
}

/** Identity of a home event, so the same row reported twice by the adapter is stored once. */
export function eventKey(e: Omit<HouseEvent, 'seq'>): string {
  const c = e.context ?? {};
  return [e.ts, e.kind, e.entityId ?? '', e.from ?? '', e.to ?? '', c.automationId ?? '', c.userId ?? '', c.service ?? '', c.eventType ?? ''].join('|');
}

export const byTime = (a: HouseEvent, b: HouseEvent): number => ms(a.ts) - ms(b.ts) || a.seq - b.seq;

/**
 * Copies the adapter's home events for a window into the ledger (skipping ones already there) and returns
 * the ledger's home events for that window, in time order, with their real seqs.
 */
export async function syncHomeEvents(deps: Pick<EngineDeps, 'adapter' | 'ledger'>, q: EventQuery): Promise<HouseEvent[]> {
  const [fresh, stored] = await Promise.all([
    deps.adapter.events(q),
    deps.ledger.query({ since: q.since, ...(q.until !== undefined ? { until: q.until } : {}), source: 'home' }),
  ]);
  const wanted = q.entityIds ? new Set(q.entityIds) : null;
  const out = stored.filter((e) => wanted === null || (e.entityId !== undefined && wanted.has(e.entityId)));
  const known = new Set(stored.map(eventKey));
  const incoming = [...fresh].sort((a, b) => ms(a.ts) - ms(b.ts));
  for (const raw of incoming) {
    const { seq: _ignored, ...rest } = raw;
    const e = { ...rest, source: 'home' as const };
    const key = eventKey(e);
    if (known.has(key)) continue;
    known.add(key);
    const seq = await deps.ledger.append(e);
    if (wanted === null || (e.entityId !== undefined && wanted.has(e.entityId))) out.push({ ...e, seq });
  }
  return out.sort(byTime);
}
