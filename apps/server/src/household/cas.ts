// Compare and set state machines for plans, repairs and the due queue. Every function here is a small
// synchronous transaction over Db, so it behaves the same under a Durable Object (where requests can
// interleave at any await on real I/O, such as a Home Assistant call) and in the node:sqlite tests.
//
// Invariants:
// - A plan's confirm token is consumed in the same transaction that creates its repair (at most one repair
//   per plan, whatever arrives concurrently).
// - A step runs at most once: its idempotency key plan_id:step is inserted once, ever, and only by the
//   writer holding the repair's current epoch.
// - Every repair state change names the epoch it started under; a stale writer changes nothing.
// - A due item is claimed by moving pending -> running with epoch + 1; only that epoch may finish it. A
//   running item whose lease has passed (the alarm died mid run) can be claimed again by the catch up sweep.

import type { Db, Row, SqlValue } from './db.ts';

/**
 * Rows a write changed, counted with RETURNING. Durable Object `rowsWritten` also counts index rows, so a
 * one row insert into a table with a primary key reports 2; RETURNING counts what the statement changed.
 */
function changed(db: Db, query: string, ...bindings: SqlValue[]): number {
  return db.sql.exec<Row>(`${query} RETURNING 1 AS changed`, ...bindings).toArray().length;
}

export type RepairState = 'applying' | 'applied' | 'rolled_back' | 'failed' | 'confirmed' | 'regressed' | 'undoing' | 'undone';

export const UNDOABLE_STATES: readonly RepairState[] = ['applied', 'confirmed', 'regressed'];

export type ConsumeResult =
  | { ok: true; repairId: string; epoch: number }
  | { ok: false; code: 'not_found' | 'plan_used' | 'plan_expired' };

/**
 * Marks the plan used and creates its repair row (state applying, epoch 1), atomically. The token itself is
 * verified by the caller before this runs; this is the single use half of the check.
 */
export function consumePlan(db: Db, planId: string, repairId: string, nowMs: number, initialSteps: string): ConsumeResult {
  return db.transaction((): ConsumeResult => {
    const rows = db.sql.exec<{ used: number; expires_at: string }>(`SELECT used, expires_at FROM plans WHERE plan_id = ?`, planId).toArray();
    const plan = rows[0];
    if (!plan) return { ok: false, code: 'not_found' };
    if (plan.used !== 0) return { ok: false, code: 'plan_used' };
    if (Date.parse(plan.expires_at) < nowMs) return { ok: false, code: 'plan_expired' };
    const flipped = changed(db, `UPDATE plans SET used = 1, repair_id = ? WHERE plan_id = ? AND used = 0`, repairId, planId);
    if (flipped !== 1) return { ok: false, code: 'plan_used' };
    db.sql.exec(
      `INSERT INTO repairs (repair_id, plan_id, state, epoch, steps, applied, checks, speech, updated_ms) VALUES (?, ?, 'applying', 1, ?, '[]', '[]', '', ?)`,
      repairId,
      planId,
      initialSteps,
      nowMs,
    );
    return { ok: true, repairId, epoch: 1 };
  });
}

/**
 * The executor's claim hook: true exactly once per key, and only while the repair is still in `inState`
 * under `epoch`. A retried alarm, a second request or a stale writer gets false and skips the step.
 */
export function claimStep(db: Db, repairId: string, epoch: number, key: string, nowMs: number, inState: RepairState = 'applying'): boolean {
  return db.transaction(() => {
    const current = db.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM repairs WHERE repair_id = ? AND epoch = ? AND state = ?`, repairId, epoch, inState).one().n;
    if (current !== 1) return false;
    return changed(db, `INSERT INTO step_claims (key, repair_id, epoch, at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`, key, repairId, epoch, nowMs) === 1;
  });
}

/** Moves a repair from one state to another under its epoch. Returns false when someone else moved it. */
export function transitionRepair(
  db: Db,
  repairId: string,
  from: { state: RepairState | readonly RepairState[]; epoch: number },
  to: RepairState,
  fields: Partial<Record<'steps' | 'applied' | 'checks' | 'undo_steps' | 'next_check_at' | 'repaired_at' | 'speech' | 'undoable', string | number | null>>,
  nowMs: number,
  bumpEpoch = false,
): boolean {
  const states = Array.isArray(from.state) ? (from.state as readonly RepairState[]) : [from.state as RepairState];
  const sets = ['state = ?', 'updated_ms = ?', ...(bumpEpoch ? ['epoch = epoch + 1'] : [])];
  const values: (string | number | null)[] = [to, nowMs];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    values.push(v ?? null);
  }
  const where = `repair_id = ? AND epoch = ? AND state IN (${states.map(() => '?').join(', ')})`;
  return changed(db, `UPDATE repairs SET ${sets.join(', ')} WHERE ${where}`, ...values, repairId, from.epoch, ...states) === 1;
}

/** Starts an undo: applied, confirmed or regressed -> undoing with a new epoch. */
export function beginUndo(db: Db, repairId: string, nowMs: number): { ok: true; epoch: number } | { ok: false; state: string | null } {
  return db.transaction(() => {
    const rows = db.sql.exec<{ state: string; epoch: number; undoable: number }>(`SELECT state, epoch, undoable FROM repairs WHERE repair_id = ?`, repairId).toArray();
    const r = rows[0];
    if (!r) return { ok: false as const, state: null };
    if (r.undoable !== 1 || !(UNDOABLE_STATES as readonly string[]).includes(r.state)) return { ok: false as const, state: r.state };
    const moved = transitionRepair(db, repairId, { state: UNDOABLE_STATES, epoch: r.epoch }, 'undoing', {}, nowMs, true);
    return moved ? { ok: true as const, epoch: r.epoch + 1 } : { ok: false as const, state: r.state };
  });
}

export type DueKind = 'morning_check' | 'guided_check' | 'push_retry';

export interface DueRow {
  id: number;
  due_ms: number;
  kind: DueKind;
  ref_id: string;
  status: 'pending' | 'running' | 'done';
  epoch: number;
  attempts: number;
  lease_ms: number | null;
  result: string | null;
}

/** How long a claimed item may run before the catch up sweep may take it over. */
export const LEASE_MS = 60_000;
/** A due item that failed this many times is closed with its last error. */
export const MAX_ATTEMPTS = 3;

/** Adds a due item; the same kind, ref and time is stored once. */
export function enqueue(db: Db, kind: DueKind, refId: string, dueMs: number): void {
  db.sql.exec(`INSERT OR IGNORE INTO due (due_ms, kind, ref_id) VALUES (?, ?, ?)`, Math.round(dueMs), kind, refId);
}

/** Items to run at household time `nowMs`: pending and due, or running with an expired lease. */
export function dueNow(db: Db, nowMs: number, realNowMs: number): DueRow[] {
  return db.sql
    .exec<DueRow & Record<string, string | number | null>>(
      `SELECT * FROM due WHERE (status = 'pending' AND due_ms <= ?) OR (status = 'running' AND lease_ms < ?) ORDER BY due_ms, id`,
      nowMs,
      realNowMs,
    )
    .toArray();
}

/** Claims an item: CAS on (id, epoch, status). The winner gets the new epoch, everyone else null. */
export function claimDue(db: Db, row: Pick<DueRow, 'id' | 'epoch'>, realNowMs: number): number | null {
  const written = changed(
    db,
    `UPDATE due SET status = 'running', epoch = epoch + 1, attempts = attempts + 1, lease_ms = ?
     WHERE id = ? AND epoch = ? AND (status = 'pending' OR (status = 'running' AND lease_ms < ?))`,
    realNowMs + LEASE_MS,
    row.id,
    row.epoch,
    realNowMs,
  );
  return written === 1 ? row.epoch + 1 : null;
}

/** Finishes a claimed item; only the epoch that claimed it can. */
export function completeDue(db: Db, id: number, epoch: number, result: unknown): boolean {
  return changed(db, `UPDATE due SET status = 'done', lease_ms = NULL, result = ? WHERE id = ? AND epoch = ? AND status = 'running'`, JSON.stringify(result), id, epoch) === 1;
}

/** Puts a claimed item back (to retry at `nextMs`, household time), or closes it after MAX_ATTEMPTS. */
export function releaseDue(db: Db, id: number, epoch: number, nextMs: number, error: string): boolean {
  return db.transaction(() => {
    const rows = db.sql.exec<{ attempts: number }>(`SELECT attempts FROM due WHERE id = ? AND epoch = ? AND status = 'running'`, id, epoch).toArray();
    const r = rows[0];
    if (!r) return false;
    if (r.attempts >= MAX_ATTEMPTS) return completeDue(db, id, epoch, { error });
    return changed(db, `UPDATE due SET status = 'pending', lease_ms = NULL, due_ms = ?, result = ? WHERE id = ? AND epoch = ?`, Math.round(nextMs), JSON.stringify({ error }), id, epoch) === 1;
  });
}

/** Earliest household time anything is waiting for (pending items, or running ones once their lease ends). */
export function nextDue(db: Db): { dueMs: number | null; leaseMs: number | null } {
  const p = db.sql.exec<{ t: number | null }>(`SELECT MIN(due_ms) AS t FROM due WHERE status = 'pending'`).one().t;
  const l = db.sql.exec<{ t: number | null }>(`SELECT MIN(lease_ms) AS t FROM due WHERE status = 'running'`).one().t;
  return { dueMs: p, leaseMs: l };
}
