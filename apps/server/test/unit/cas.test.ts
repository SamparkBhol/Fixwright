// The compare and set state machines on node:sqlite (the same SQL the Durable Object runs).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beginUndo, claimDue, claimStep, completeDue, consumePlan, dueNow, enqueue, LEASE_MS, MAX_ATTEMPTS, nextDue, releaseDue, transitionRepair } from '../../src/household/cas.ts';
import { migrate, type Db } from '../../src/household/db.ts';
import { sqliteDb } from '../support/sqlite-db.ts';

let db: Db & { close(): void };
const NOW = Date.parse('2026-10-15T22:00:00.000Z');

function addPlan(planId: string, expiresAt = '2026-10-15T22:05:00.000Z'): void {
  db.sql.exec(`INSERT INTO plans (plan_id, body, plan_hash, token_hash, expires_at, used, output, created_ms) VALUES (?, '{}', 'h', 't', ?, 0, '{}', ?)`, planId, expiresAt, NOW);
}

beforeEach(() => {
  db = sqliteDb();
  migrate(db);
});
afterEach(() => db.close());

describe('plans are single use', () => {
  it('the first consume creates the repair, the second is refused', () => {
    addPlan('pln_1');
    expect(consumePlan(db, 'pln_1', 'rep_1', NOW, '[]')).toEqual({ ok: true, repairId: 'rep_1', epoch: 1 });
    expect(consumePlan(db, 'pln_1', 'rep_2', NOW, '[]')).toEqual({ ok: false, code: 'plan_used' });
    expect(db.sql.exec(`SELECT COUNT(*) AS n FROM repairs`).one()['n']).toBe(1);
  });

  it('refuses expired and unknown plans without creating anything', () => {
    addPlan('pln_old', '2026-10-15T21:00:00.000Z');
    expect(consumePlan(db, 'pln_old', 'rep_1', NOW, '[]')).toEqual({ ok: false, code: 'plan_expired' });
    expect(consumePlan(db, 'pln_none', 'rep_1', NOW, '[]')).toEqual({ ok: false, code: 'not_found' });
    expect(db.sql.exec(`SELECT COUNT(*) AS n FROM repairs`).one()['n']).toBe(0);
  });

  it('a failure inside the transaction leaves the plan unused', () => {
    addPlan('pln_1');
    db.sql.exec(`INSERT INTO repairs (repair_id, plan_id, state, epoch, steps, applied, checks, speech, updated_ms) VALUES ('rep_1', 'pln_other', 'applied', 1, '[]', '[]', '[]', '', 0)`);
    expect(() => consumePlan(db, 'pln_1', 'rep_1', NOW, '[]')).toThrow();
    expect(db.sql.exec(`SELECT used FROM plans WHERE plan_id = 'pln_1'`).one()['used']).toBe(0);
  });
});

describe('repair steps run at most once, under the current epoch', () => {
  beforeEach(() => {
    addPlan('pln_1');
    consumePlan(db, 'pln_1', 'rep_1', NOW, '[]');
  });

  it('claims each idempotency key once', () => {
    expect(claimStep(db, 'rep_1', 1, 'pln_1:1', NOW)).toBe(true);
    expect(claimStep(db, 'rep_1', 1, 'pln_1:1', NOW)).toBe(false);
    expect(claimStep(db, 'rep_1', 1, 'pln_1:2', NOW)).toBe(true);
  });

  it('a stale epoch or a finished repair claims nothing', () => {
    expect(claimStep(db, 'rep_1', 0, 'pln_1:1', NOW)).toBe(false);
    expect(transitionRepair(db, 'rep_1', { state: 'applying', epoch: 1 }, 'applied', { steps: '[]' }, NOW)).toBe(true);
    expect(claimStep(db, 'rep_1', 1, 'pln_1:3', NOW)).toBe(false);
  });

  it('transitions are compare and set on state and epoch', () => {
    expect(transitionRepair(db, 'rep_1', { state: 'applying', epoch: 2 }, 'applied', {}, NOW)).toBe(false);
    expect(transitionRepair(db, 'rep_1', { state: 'applying', epoch: 1 }, 'applied', {}, NOW)).toBe(true);
    expect(transitionRepair(db, 'rep_1', { state: 'applying', epoch: 1 }, 'failed', {}, NOW)).toBe(false);
  });

  it('undo starts once, with a new epoch, and never from applying', () => {
    expect(beginUndo(db, 'rep_1', NOW)).toEqual({ ok: false, state: 'applying' });
    transitionRepair(db, 'rep_1', { state: 'applying', epoch: 1 }, 'applied', {}, NOW);
    expect(beginUndo(db, 'rep_1', NOW)).toEqual({ ok: true, epoch: 2 });
    expect(beginUndo(db, 'rep_1', NOW)).toEqual({ ok: false, state: 'undoing' });
    expect(transitionRepair(db, 'rep_1', { state: 'undoing', epoch: 1 }, 'undone', {}, NOW)).toBe(false);
    expect(transitionRepair(db, 'rep_1', { state: 'undoing', epoch: 2 }, 'undone', {}, NOW)).toBe(true);
    expect(beginUndo(db, 'rep_x', NOW)).toEqual({ ok: false, state: null });
  });

  it('a repair marked not undoable refuses undo', () => {
    transitionRepair(db, 'rep_1', { state: 'applying', epoch: 1 }, 'confirmed', { undoable: 0 }, NOW);
    expect(beginUndo(db, 'rep_1', NOW)).toEqual({ ok: false, state: 'confirmed' });
  });
});

describe('due queue', () => {
  it('enqueue is idempotent per kind, ref and time', () => {
    enqueue(db, 'morning_check', 'rep_1', NOW + 1000);
    enqueue(db, 'morning_check', 'rep_1', NOW + 1000);
    expect(db.sql.exec(`SELECT COUNT(*) AS n FROM due`).one()['n']).toBe(1);
  });

  it('only one claimer wins; the loser and a stale epoch get nothing', () => {
    enqueue(db, 'morning_check', 'rep_1', NOW);
    const [row] = dueNow(db, NOW, NOW);
    if (!row) throw new Error('no due row');
    const a = claimDue(db, row, NOW);
    const b = claimDue(db, row, NOW);
    expect(a).toBe(1);
    expect(b).toBeNull();
    expect(completeDue(db, row.id, 0, {})).toBe(false);
    expect(completeDue(db, row.id, 1, { ok: true })).toBe(true);
    expect(completeDue(db, row.id, 1, { ok: true })).toBe(false);
    expect(dueNow(db, NOW + 10 * LEASE_MS, NOW + 10 * LEASE_MS)).toEqual([]);
  });

  it('items not yet due wait; nextDue reports the earliest', () => {
    enqueue(db, 'morning_check', 'rep_1', NOW + 5000);
    enqueue(db, 'guided_check', 'dx_1', NOW + 2000);
    expect(dueNow(db, NOW, NOW)).toEqual([]);
    expect(nextDue(db)).toEqual({ dueMs: NOW + 2000, leaseMs: null });
    expect(dueNow(db, NOW + 5000, NOW).map((r) => r.ref_id)).toEqual(['dx_1', 'rep_1']);
  });

  it('a running item whose lease expired is swept up again with a newer epoch', () => {
    enqueue(db, 'morning_check', 'rep_1', NOW);
    const row = dueNow(db, NOW, NOW)[0];
    if (!row) throw new Error('no due row');
    const first = claimDue(db, row, NOW);
    expect(dueNow(db, NOW, NOW + 1000)).toEqual([]);
    const later = NOW + LEASE_MS + 1;
    const again = dueNow(db, NOW, later)[0];
    if (!again) throw new Error('lease not swept');
    const second = claimDue(db, again, later);
    expect(second).toBe((first as number) + 1);
    expect(completeDue(db, row.id, first as number, {})).toBe(false);
    expect(completeDue(db, row.id, second as number, {})).toBe(true);
  });

  it('a failed item is retried later and closed after MAX_ATTEMPTS', () => {
    enqueue(db, 'push_retry', '7', NOW);
    let t = NOW;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const row = dueNow(db, t, t)[0];
      if (!row) throw new Error(`attempt ${i} not due`);
      const epoch = claimDue(db, row, t) as number;
      expect(releaseDue(db, row.id, epoch, t + 1000, 'boom')).toBe(true);
      t += 1000;
    }
    expect(dueNow(db, t + 10_000, t + 10_000)).toEqual([]);
    const done = db.sql.exec(`SELECT status, attempts, result FROM due`).one();
    expect(done).toEqual({ status: 'done', attempts: MAX_ATTEMPTS, result: '{"error":"boom"}' });
  });
});
