// Recovery sweep for repairs a Durable Object left half done. A repair stays in 'applying' or 'undoing' only
// while a call is working on it; when the object is evicted or redeployed mid call, nothing ever finishes it
// and repair_status would say "still running" for good. A fresh object has no call in flight, so on its first
// call the household settles every such repair by reading the home back:
//   applying -> applied      every step was claimed and every one reads back as planned
//   applying -> rolled_back  anything else: each step that may have run is put back, each inverse read back
//              (failed when an inverse does not read back, as in the executor)
//   undoing  -> undone       the undo is run again (inverses are idempotent "set" changes), read back
//              (failed when it does not read back)
// A step whose check is "the device answered" (a flash check) cannot be read back without acting again, so it
// never counts as verified: a repair stopped there is rolled back, which is the safe direction.
// Every read back lands in the ledger, so the settled state cites what was observed.

import { morningCheckAt, phrase, readBack, runAction, undoPlan, type EngineDeps, type PlanAction, type PlanStep, type ReadBack, type RepairPlan } from '@fixwright/engine';
import { speechSafe, type RepairStep } from '@fixwright/protocol';
import { enqueue, transitionRepair, type RepairState } from './cas.ts';
import type { Db, Row } from './db.ts';
import { loadPlanRow, type RepairRow } from './tools.ts';

export interface Recovered {
  repair_id: string;
  from: 'applying' | 'undoing';
  to: RepairState;
}

/** Repairs no call is working on any more (only meaningful on a fresh object). */
export function stuckRepairs(db: Db): RepairRow[] {
  return db.sql.exec<RepairRow & Row>(`SELECT * FROM repairs WHERE state IN ('applying', 'undoing') ORDER BY updated_ms, repair_id`).toArray();
}

async function check(expect: PlanAction['expect'], deps: EngineDeps): Promise<ReadBack> {
  try {
    return await readBack(expect, deps);
  } catch (err) {
    return { ok: false, observed: `error ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function log(deps: EngineDeps, plan: RepairPlan, step: PlanStep, action: PlanAction, status: string, rb: ReadBack): Promise<void> {
  const entityId = action.op.kind === 'reload_integration' ? undefined : action.op.entity_id;
  await deps.ledger.append({
    ts: deps.clock.now(),
    kind: 'repair',
    ...(entityId !== undefined ? { entityId } : {}),
    source: 'fixwright',
    data: { plan_id: plan.plan_id, step: step.step, phase: 'recovery', op: action.op.kind, status, observed: rb.observed, idempotency_key: step.idempotency_key, entity_ids: entityId ? [entityId] : [] },
  });
}

async function settleApply(db: Db, deps: EngineDeps, row: RepairRow, plan: RepairPlan, nowMs: number): Promise<Recovered> {
  const claimed = new Set(db.sql.exec<{ key: string }>(`SELECT key FROM step_claims WHERE repair_id = ?`, row.repair_id).toArray().map((r) => r.key));
  const steps: RepairStep[] = plan.steps.map((s) => ({ step: s.step, label: s.label, status: 'pending' }));
  const ran = plan.steps.filter((s) => claimed.has(s.idempotency_key));
  let holds = ran.length === plan.steps.length;
  for (const s of ran) {
    const view = steps[s.step - 1] as RepairStep;
    if (s.expect.kind === 'answers') {
      holds = false;
      continue;
    }
    const rb = await check(s.expect, deps);
    await log(deps, plan, s, s, rb.ok ? 'done' : 'failed', rb);
    view.status = rb.ok ? 'done' : 'failed';
    if (rb.ok) view.read_back = s.read_back_text;
    holds &&= rb.ok;
  }

  if (holds) {
    const nextCheck = morningCheckAt(plan, deps.clock.nowMs(), deps.settings.tz);
    const applied = plan.steps.map((s) => s.step);
    const moved = transitionRepair(
      db,
      row.repair_id,
      { state: 'applying', epoch: row.epoch },
      'applied',
      {
        steps: JSON.stringify(steps),
        applied: JSON.stringify(applied),
        speech: speechSafe(phrase('ap_done', { count: applied.length })),
        next_check_at: nextCheck ?? null,
        repaired_at: row.repaired_at ?? deps.adapter.now(),
        undoable: plan.undoable ? 1 : 0,
      },
      nowMs,
      true,
    );
    if (moved && nextCheck) enqueue(db, 'morning_check', row.repair_id, Date.parse(nextCheck));
    return { repair_id: row.repair_id, from: 'applying', to: moved ? 'applied' : 'applying' };
  }

  // Put back every step that may have run, newest first; a step without an inverse changed nothing.
  let clean = true;
  const stillApplied: number[] = [];
  for (const s of [...ran].reverse()) {
    const view = steps[s.step - 1] as RepairStep;
    if (!s.inverse) {
      view.status = 'skipped';
      continue;
    }
    let rb: ReadBack;
    try {
      rb = await runAction(s.inverse, deps);
    } catch (err) {
      rb = { ok: false, observed: `error ${err instanceof Error ? err.message : String(err)}` };
    }
    await log(deps, plan, s, s.inverse, rb.ok ? 'rolled_back' : 'failed', rb);
    view.status = rb.ok ? 'rolled_back' : 'failed';
    view.read_back = rb.ok ? s.inverse.read_back_text : `Could not undo: ${rb.observed}`;
    if (!rb.ok) stillApplied.push(s.step);
    clean &&= rb.ok;
  }
  for (const v of steps) if (v.status === 'pending' || v.status === 'done') v.status = 'skipped';
  const to = clean ? 'rolled_back' : 'failed';
  const moved = transitionRepair(
    db,
    row.repair_id,
    { state: 'applying', epoch: row.epoch },
    to,
    { steps: JSON.stringify(steps), applied: JSON.stringify(stillApplied.sort((a, b) => a - b)), speech: speechSafe(phrase(clean ? 'ap_rolled_back' : 'ap_failed', {})), next_check_at: null, undoable: 0 },
    nowMs,
    true,
  );
  return { repair_id: row.repair_id, from: 'applying', to: moved ? to : 'applying' };
}

async function settleUndo(db: Db, deps: EngineDeps, row: RepairRow, plan: RepairPlan, nowMs: number): Promise<Recovered> {
  const result = await undoPlan(plan, JSON.parse(row.applied) as number[], deps);
  const to = result.ok ? 'undone' : 'failed';
  const moved = transitionRepair(
    db,
    row.repair_id,
    { state: 'undoing', epoch: row.epoch },
    to,
    { undo_steps: JSON.stringify(result.steps), speech: result.speech, next_check_at: null, undoable: 0 },
    nowMs,
    true,
  );
  return { repair_id: row.repair_id, from: 'undoing', to: moved ? to : 'undoing' };
}

/**
 * Settles every stuck repair. Returns what it did; an empty list when there was nothing to do. When the hub
 * does not answer, nothing can be read back, so it changes nothing and says so (the caller tries again later).
 */
export async function recoverStuckRepairs(db: Db, deps: EngineDeps, realNow: () => number): Promise<{ recovered: Recovered[]; deferred: boolean }> {
  const stuck = stuckRepairs(db);
  if (stuck.length === 0) return { recovered: [], deferred: false };
  const hub = await deps.adapter.hubStatus().catch(() => ({ reachable: false }));
  if (!hub.reachable) return { recovered: [], deferred: true };
  const recovered: Recovered[] = [];
  for (const row of stuck) {
    const planRow = loadPlanRow(db, row.plan_id);
    if (!planRow) continue;
    const plan = JSON.parse(planRow.body) as RepairPlan;
    recovered.push(row.state === 'applying' ? await settleApply(db, deps, row, plan, realNow()) : await settleUndo(db, deps, row, plan, realNow()));
  }
  return { recovered, deferred: false };
}
