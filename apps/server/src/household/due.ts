// The due queue behind the household's one alarm: next morning repair checks, guided follow up checks and
// push retries. Items are claimed by compare and set with a fencing epoch (cas.ts), every handler is
// idempotent (alarms can fire more than once), and a wake up sweeps everything overdue, not just the item
// the alarm was set for.

import { applyOp, auditHumanAnswers, evaluateGuidedCheck, morningCheck, type DiagnosisSession, type EngineDeps, type RepairPlan } from '@fixwright/engine';
import type { RepairCheck } from '@fixwright/protocol';
import { claimDue, claimStep, completeDue, dueNow, enqueue, nextDue, releaseDue, transitionRepair, type DueRow } from './cas.ts';
import type { Db } from './db.ts';
import type { House } from './house.ts';
import { loadPlanRow, loadRepair } from './tools.ts';

export interface PushRecord {
  id: number;
  at: string;
  title: string;
  message: string;
  tags: string;
  status: 'sent' | 'failed';
  attempts: number;
  error: string | null;
  ref_id: string | null;
}

export interface Push {
  title: string;
  message: string;
  at: string;
  delivered: boolean;
}

export interface DueContext {
  db: Db;
  house: House;
  ntfyBase: string;
  realNow: () => number;
  fetch: typeof fetch;
}

const PUSH_TIMEOUT_MS = 5000;
/** A failed push is tried once more after this long (household time). */
export const PUSH_RETRY_MS = 60_000;
/** A handler that threw is retried after this long (household time). */
const HANDLER_RETRY_MS = 5 * 60_000;

/** POST <base>/<topic> with Title and Tags headers (ntfy's publish API). */
async function deliver(ctx: DueContext, title: string, message: string, tags: string): Promise<string | null> {
  const topic = ctx.house.info().ntfy_topic;
  try {
    const res = await ctx.fetch(`${ctx.ntfyBase}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: title, Tags: tags, 'content-type': 'text/plain; charset=utf-8' },
      body: message,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    return res.ok ? null : `ntfy answered ${res.status}`;
  } catch (err) {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
}

/** Sends a push and records it. A failure is recorded and retried once by the queue. */
export async function sendPush(ctx: DueContext, title: string, message: string, tags: string, refId: string | null): Promise<Push> {
  const at = new Date(ctx.house.nowMs()).toISOString();
  const error = await deliver(ctx, title, message, tags);
  const id = ctx.db.sql
    .exec<{ id: number }>(
      `INSERT INTO pushes (at, title, message, tags, status, attempts, error, ref_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?) RETURNING id`,
      at,
      title,
      message,
      tags,
      error ? 'failed' : 'sent',
      error,
      refId,
    )
    .one().id;
  if (error) enqueue(ctx.db, 'push_retry', String(id), ctx.house.nowMs() + PUSH_RETRY_MS);
  return { title, message, at, delivered: error === null };
}

async function retryPush(ctx: DueContext, pushId: string): Promise<{ result: unknown; pushes: Push[] }> {
  const row = ctx.db.sql.exec<PushRecord & Record<string, string | number | null>>(`SELECT * FROM pushes WHERE id = ?`, Number(pushId)).toArray()[0];
  if (!row || row.status === 'sent' || row.attempts >= 2) return { result: { skipped: true }, pushes: [] };
  const error = await deliver(ctx, row.title, row.message, row.tags);
  ctx.db.sql.exec(`UPDATE pushes SET status = ?, attempts = attempts + 1, error = ? WHERE id = ? AND attempts = ?`, error ? 'failed' : 'sent', error, row.id, row.attempts);
  return { result: { delivered: error === null, error }, pushes: [{ title: row.title, message: row.message, at: row.at, delivered: error === null }] };
}

/** The 07:00 check after a repair: evaluate, record, push, and on a pass run the plan's follow up. */
async function runMorningCheck(ctx: DueContext, repairId: string, deps: EngineDeps): Promise<{ result: unknown; pushes: Push[] }> {
  const row = loadRepair(ctx.db, repairId);
  // Undone, rolled back or already checked: nothing to do (this is what makes a repeated alarm harmless).
  if (!row || row.state !== 'applied') return { result: { skipped: row?.state ?? 'missing' }, pushes: [] };
  const plan = JSON.parse(loadPlanRow(ctx.db, row.plan_id)?.body ?? 'null') as RepairPlan | null;
  if (!plan) return { result: { skipped: 'no plan' }, pushes: [] };
  const check = await morningCheck(plan, row.repaired_at ?? plan.created_at, deps);
  if (check.result === 'not_checked') return { result: { not_checked: true }, pushes: [] };
  const at = deps.clock.now();
  const checks = [...(JSON.parse(row.checks) as RepairCheck[]), { at, result: check.result, detail: check.detail }];
  const pass = check.result === 'pass';
  const moved = transitionRepair(
    ctx.db,
    repairId,
    { state: 'applied', epoch: row.epoch },
    pass ? 'confirmed' : 'regressed',
    { checks: JSON.stringify(checks), speech: check.speech, next_check_at: null, ...(pass && plan.follow_up.length > 0 ? { undoable: 0 } : {}) },
    ctx.realNow(),
  );
  if (!moved) return { result: { skipped: 'changed meanwhile' }, pushes: [] };
  if (pass) {
    // Follow up ops (removing the retired copy) run once each, under the same idempotency rule as steps.
    for (const [i, op] of plan.follow_up.entries()) {
      if (claimStep(ctx.db, repairId, row.epoch, `${plan.plan_id}:follow_up:${i + 1}`, ctx.realNow(), 'confirmed')) {
        await applyOp(op, deps).catch((err: unknown) => console.error('[due] follow up failed', err));
      }
    }
    const dx = plan.source.diagnosis_id;
    const stored = dx ? ctx.db.sql.exec<{ body: string }>(`SELECT body FROM sessions WHERE id = ?`, dx).toArray()[0] : undefined;
    if (stored) {
      const session = JSON.parse(stored.body) as DiagnosisSession;
      ctx.house.setReliability(auditHumanAnswers(session, plan.cause_id, ctx.house.reliability()).reliability);
    }
  }
  const push = await sendPush(ctx, pass ? 'Repair confirmed' : 'Repair needs a look', check.speech, pass ? 'white_check_mark,house' : 'warning,house', repairId);
  return { result: { check: check.result, detail: check.detail }, pushes: [push] };
}

/** A guided follow up (the person fixes it, a sensor tells): pending enqueues again, pass or fail pushes. */
async function runGuidedCheck(ctx: DueContext, diagnosisId: string, deps: EngineDeps): Promise<{ result: unknown; pushes: Push[] }> {
  const stored = ctx.db.sql.exec<{ body: string }>(`SELECT body FROM sessions WHERE id = ? AND type = 'diagnosis'`, diagnosisId).toArray()[0];
  const session = stored ? (JSON.parse(stored.body) as DiagnosisSession) : undefined;
  if (!session?.guided_check) return { result: { skipped: 'no check' }, pushes: [] };
  const r = await evaluateGuidedCheck(session.guided_check, deps);
  if (r.result === 'pending') {
    if (r.next_check_at) enqueue(ctx.db, 'guided_check', diagnosisId, Date.parse(r.next_check_at));
    return { result: { pending: true, next_check_at: r.next_check_at }, pushes: [] };
  }
  if (r.result === 'pass') ctx.house.setReliability(auditHumanAnswers(session, session.guided_check.cause_id, ctx.house.reliability()).reliability);
  const push = await sendPush(ctx, r.result === 'pass' ? 'Fixed' : 'Still not fixed', r.speech, r.result === 'pass' ? 'white_check_mark,house' : 'warning,house', diagnosisId);
  return { result: { check: r.result, detail: r.detail }, pushes: [push] };
}

async function runItem(ctx: DueContext, row: DueRow): Promise<{ result: unknown; pushes: Push[] }> {
  if (row.kind === 'push_retry') return retryPush(ctx, row.ref_id);
  const deps = await ctx.house.deps();
  return row.kind === 'morning_check' ? runMorningCheck(ctx, row.ref_id, deps) : runGuidedCheck(ctx, row.ref_id, deps);
}

/**
 * Runs everything due at household time now: claim (CAS + epoch), run, complete. Returns the pushes sent.
 * Safe to call any number of times, concurrently or not: a claimed or finished item is never run twice.
 */
export async function runDue(ctx: DueContext): Promise<{ ran: number; pushes: Push[] }> {
  const pushes: Push[] = [];
  let ran = 0;
  // A handler can enqueue more work that is already due (a push retry, a pending guided check); loop a
  // bounded number of times so one wake up catches up completely.
  for (let round = 0; round < 4; round++) {
    const rows = dueNow(ctx.db, ctx.house.nowMs(), ctx.realNow());
    if (rows.length === 0) break;
    for (const row of rows) {
      const epoch = claimDue(ctx.db, row, ctx.realNow());
      if (epoch === null) continue;
      ran++;
      try {
        const out = await runItem(ctx, row);
        completeDue(ctx.db, row.id, epoch, out.result);
        pushes.push(...out.pushes);
      } catch (err) {
        console.error(`[due] ${row.kind} ${row.ref_id} failed`, err);
        releaseDue(ctx.db, row.id, epoch, ctx.house.nowMs() + HANDLER_RETRY_MS, err instanceof Error ? err.message : String(err));
      }
    }
  }
  return { ran, pushes };
}

/** Real time the alarm should fire for the earliest waiting item, or null when nothing waits. */
export function alarmTime(ctx: Pick<DueContext, 'db' | 'house' | 'realNow'>): number | null {
  const { dueMs, leaseMs } = nextDue(ctx.db);
  const offset = ctx.house.exists() ? ctx.house.info().clock_offset_ms : 0;
  const candidates = [dueMs === null ? null : dueMs - offset, leaseMs].filter((t): t is number => t !== null);
  if (candidates.length === 0) return null;
  return Math.max(ctx.realNow() + 50, Math.min(...candidates));
}
