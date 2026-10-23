// The household storage interface over node:sqlite, for unit tests and the Node CPU harness. Same SQL as
// the Durable Object: Cloudflare's SqlStorage is SQLite too.

import { DatabaseSync } from 'node:sqlite';
import type { Db, Row, SqlCursor, SqlValue } from '../../src/household/db.ts';

const READS = /^\s*(SELECT|WITH|PRAGMA)\b|\bRETURNING\b/i;

export function sqliteDb(path = ':memory:'): Db & { close(): void; raw: DatabaseSync } {
  const raw = new DatabaseSync(path);
  let depth = 0;
  const exec = <T extends Row>(query: string, ...bindings: SqlValue[]): SqlCursor<T> => {
    const stmt = raw.prepare(query);
    if (READS.test(query)) {
      const rows = stmt.all(...bindings) as T[];
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0] as T;
        },
      };
    }
    stmt.run(...bindings);
    return {
      toArray: () => [],
      one: () => {
        throw new Error('no rows');
      },
    };
  };
  return {
    raw,
    sql: { exec },
    transaction<T>(fn: () => T): T {
      // Nested calls join the outer transaction, as transactionSync does.
      if (depth > 0) return fn();
      depth++;
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    },
    close: () => raw.close(),
  };
}
