// The HouseholdDO's SQLite schema and the narrow storage interface the household code uses.
// Durable Object SqlStorage satisfies it directly; unit tests and the Node CPU harness back it with
// node:sqlite, so the same SQL and the same compare and set logic run in both places.

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

/** What the household reads from a cursor. Writes that must know whether they changed a row use RETURNING. */
export interface SqlCursor<T> {
  toArray(): T[];
  one(): T;
}

export interface Sql {
  exec<T extends Row = Row>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
}

export interface Db {
  sql: Sql;
  /** Runs fn atomically: all of its writes or none. */
  transaction<T>(fn: () => T): T;
}

export const SCHEMA = [
  // Append only ledger. seq is what every claim cites.
  `CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    entity_id TEXT,
    source TEXT NOT NULL,
    body TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_ts ON events(ts_ms)`,
  // Diagnoses, explanations and checkups as engine JSON, with the latest output for refresh_view.
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    body TEXT NOT NULL,
    output TEXT NOT NULL,
    updated_ms INTEGER NOT NULL
  )`,
  // A plan is used at most once: used flips 0 -> 1 in the same transaction that creates its repair.
  `CREATE TABLE IF NOT EXISTS plans (
    plan_id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    plan_hash TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    repair_id TEXT,
    output TEXT NOT NULL,
    created_ms INTEGER NOT NULL
  )`,
  // state: applying | applied | rolled_back | failed | confirmed | regressed | undoing | undone.
  // epoch fences every writer: a step claim or a state change names the epoch it started under.
  `CREATE TABLE IF NOT EXISTS repairs (
    repair_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    steps TEXT NOT NULL,
    applied TEXT NOT NULL,
    checks TEXT NOT NULL,
    undo_steps TEXT,
    next_check_at TEXT,
    repaired_at TEXT,
    speech TEXT NOT NULL,
    undoable INTEGER NOT NULL DEFAULT 1,
    updated_ms INTEGER NOT NULL
  )`,
  // Idempotency keys plan_id:step. A key is inserted once, ever, so a step runs at most once.
  `CREATE TABLE IF NOT EXISTS step_claims (
    key TEXT PRIMARY KEY,
    repair_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS protected (
    entity_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    reason TEXT NOT NULL,
    at_ms INTEGER NOT NULL
  )`,
  // The due queue behind the one alarm. due_ms is household time. status: pending | running | done.
  `CREATE TABLE IF NOT EXISTS due (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    due_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    epoch INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_ms INTEGER,
    result TEXT,
    UNIQUE (kind, ref_id, due_ms)
  )`,
  `CREATE INDEX IF NOT EXISTS due_pending ON due(status, due_ms)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sim (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL, saved_ms INTEGER NOT NULL)`,
  // Every push attempt, delivered or not.
  `CREATE TABLE IF NOT EXISTS pushes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    tags TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    error TEXT,
    ref_id TEXT
  )`,
] as const;

export const TABLES = ['events', 'sessions', 'plans', 'repairs', 'step_claims', 'protected', 'due', 'settings', 'sim', 'pushes'] as const;

export function migrate(db: Db): void {
  for (const statement of SCHEMA) db.sql.exec(statement);
}

/** Empties every table (a household reset). sqlite_sequence restarts ledger seqs at 1. */
export function wipe(db: Db): void {
  db.transaction(() => {
    for (const t of TABLES) db.sql.exec(`DELETE FROM ${t}`);
    db.sql.exec(`DELETE FROM sqlite_sequence`);
  });
}

// Settings: one JSON value per key.

export function getSetting<T>(db: Db, key: string): T | undefined {
  const rows = db.sql.exec<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, key).toArray();
  return rows[0] ? (JSON.parse(rows[0].value) as T) : undefined;
}

export function putSetting(db: Db, key: string, value: unknown): void {
  db.sql.exec(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, JSON.stringify(value));
}
