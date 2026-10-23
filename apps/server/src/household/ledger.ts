// The engine's Ledger over the events table. The household's Durable Object is the only writer, so the
// ledger keeps an in memory mirror (loaded once per object start) for queries, and writes new events in
// batches at the end of each operation (flush), a few rows per statement. Query semantics are the engine's
// own matchesQuery: inclusive, ANDed, seq order.

import { matchesQuery, type Ledger, type LedgerQuery } from '@fixwright/engine';
import type { HouseEvent } from '@fixwright/protocol';
import type { Db } from './db.ts';

/** Durable Object SQLite allows 100 bound values per statement: 6 columns x 16 rows stays under it. */
const ROWS_PER_INSERT = 16;

export interface SqlLedger extends Ledger {
  /** Called at the end of every household operation. */
  flush(): void;
  /** Drops the mirror (after storage was wiped). */
  reset(): void;
  count(): number;
}

export function sqlLedger(db: Db): SqlLedger {
  let events: HouseEvent[] | null = null;
  let bySeq = new Map<number, HouseEvent>();
  let pending: HouseEvent[] = [];
  let nextSeq = 1;

  const load = (): HouseEvent[] => {
    if (events) return events;
    events = db.sql
      .exec<{ seq: number; body: string }>(`SELECT seq, body FROM events ORDER BY seq`)
      .toArray()
      .map((r) => ({ ...(JSON.parse(r.body) as Omit<HouseEvent, 'seq'>), seq: r.seq }));
    bySeq = new Map(events.map((e) => [e.seq, e]));
    nextSeq = (events.at(-1)?.seq ?? 0) + 1;
    return events;
  };

  return {
    async append(e) {
      const all = load();
      const { seq: _drop, ...rest } = e as HouseEvent;
      const event: HouseEvent = { ...rest, seq: nextSeq++ };
      all.push(event);
      bySeq.set(event.seq, event);
      pending.push(event);
      return event.seq;
    },
    async query(q: LedgerQuery) {
      const all = load();
      if (q.seqs !== undefined) {
        return [...new Set(q.seqs)]
          .sort((a, b) => a - b)
          .map((s) => bySeq.get(s))
          .filter((e): e is HouseEvent => e !== undefined && matchesQuery(e, q));
      }
      // Like the engine's memory ledger, results share the stored objects; the engine never mutates events.
      return all.filter((e) => matchesQuery(e, q));
    },
    flush() {
      if (pending.length === 0) return;
      const rows = pending;
      pending = [];
      db.transaction(() => {
        for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
          const chunk = rows.slice(i, i + ROWS_PER_INSERT);
          const values: (string | number | null)[] = [];
          for (const e of chunk) {
            const { seq, ...body } = e;
            values.push(seq, Date.parse(e.ts), e.kind, e.entityId ?? null, e.source, JSON.stringify(body));
          }
          db.sql.exec(`INSERT INTO events (seq, ts_ms, kind, entity_id, source, body) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`, ...values);
        }
      });
    },
    reset() {
      events = null;
      bySeq = new Map();
      pending = [];
      nextSeq = 1;
    },
    count: () => load().length,
  };
}
