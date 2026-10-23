// Executing a plan through the adapter: apply a step, read it back, and on any mismatch roll back every
// step already done (each inverse read back too). The server owns persistence and idempotency: it passes
// hooks so each `plan_id:step` key runs at most once even when a Durable Object alarm fires twice.
// Also here: undo, and the next morning check that confirms a repair held (only for plans a sensor can
// verify; morningCheckAt says when, or that there is nothing to schedule).

import { speechSafe, type EntityId, type HouseEvent, type RepairStep, type RepairStepStatus } from '@fixwright/protocol';
import { syncHomeEvents } from './ledger.ts';
import { phrase } from './phrase.ts';
import { flashEntity } from './probes.ts';
import type { EngineDeps, PlanAction, PlanOp, PlanStep, ReadBackExpectation, RepairPlan } from './types.ts';
import { fold } from './util/text.ts';
import { iso, localTime, nextLocalTime } from './util/time.ts';

/** Household time of the next morning check. */
export const MORNING_CHECK_AT = '07:00';

/** Does the plan leave something a sensor can check the next morning? */
export const isVerifiable = (plan: Pick<RepairPlan, 'verify'>): boolean => plan.verify.kind !== 'none' && plan.verify.entity_ids.length > 0;

type AdapterDeps = Pick<EngineDeps, 'adapter'>;

export interface OpOutcome {
  /** For flash checks: commands sent and answered. */
  commands?: number;
  answered?: number;
}

/** Runs one op through the adapter. Throws whatever the adapter throws. */
export async function applyOp(op: PlanOp, deps: AdapterDeps): Promise<OpOutcome> {
  const a = deps.adapter;
  switch (op.kind) {
    case 'registry_update':
      await a.registryUpdate(op.entity_id, op.patch);
      return {};
    case 'registry_remove':
      await a.registryRemove(op.entity_id);
      return {};
    case 'select_option':
      await a.selectOption(op.entity_id, op.option);
      return {};
    case 'reload_integration':
      await a.reloadIntegration(op.integration);
      return {};
    case 'call_service':
      await a.callService(op.domain, op.service, { entity_id: op.entity_id });
      return {};
    case 'flash_check': {
      const e = await a.getEntity(op.entity_id);
      if (!e) return { commands: op.times * 2, answered: 0 };
      return flashEntity(deps, { entityId: e.entityId, domain: op.domain }, e.state, op.times);
    }
  }
}

export interface ReadBack {
  ok: boolean;
  /** What was seen, for logs and the ledger. */
  observed: string;
}

/** Reads the home and checks it against an expectation. `outcome` carries what a flash check read back. */
export async function readBack(expect: ReadBackExpectation, deps: AdapterDeps, outcome: OpOutcome = {}): Promise<ReadBack> {
  const a = deps.adapter;
  switch (expect.kind) {
    case 'name': {
      const e = await a.getEntity(expect.entity_id);
      return { ok: e?.name === expect.equals, observed: `name ${e?.name ?? 'missing'}` };
    }
    case 'aliases': {
      const e = await a.getEntity(expect.entity_id);
      const have = new Set((e?.aliases ?? []).map(fold));
      const want = new Set(expect.equals.map(fold));
      const ok = e !== null && have.size === want.size && [...want].every((w) => have.has(w));
      return { ok, observed: `aliases ${e === null ? 'missing' : e.aliases.join(', ') || 'none'}` };
    }
    case 'disabled': {
      const e = await a.getEntity(expect.entity_id);
      // A disabled entity may vanish from the state machine entirely; that reads as disabled.
      const disabled = e === null ? true : e.disabled === true;
      return { ok: disabled === expect.equals, observed: `disabled ${String(disabled)}` };
    }
    case 'state': {
      const e = await a.getEntity(expect.entity_id);
      return { ok: e?.state === expect.equals, observed: `state ${e?.state ?? 'missing'}` };
    }
    case 'absent': {
      const e = await a.getEntity(expect.entity_id);
      return { ok: e === null, observed: e === null ? 'absent' : 'still present' };
    }
    case 'integration_loaded': {
      const s = (await a.integrations()).find((i) => i.integration === expect.integration);
      return { ok: s?.state === 'loaded', observed: `integration ${s?.state ?? 'missing'}` };
    }
    case 'answers': {
      const commands = outcome.commands ?? 0;
      const answered = outcome.answered ?? 0;
      return { ok: commands > 0 && answered === commands, observed: `answered ${answered} of ${commands}` };
    }
  }
}

/** Applies an action and reads it back. Adapter errors count as a failed read back. */
export async function runAction(action: PlanAction, deps: AdapterDeps): Promise<ReadBack> {
  try {
    const outcome = await applyOp(action.op, deps);
    return await readBack(action.expect, deps, outcome);
  } catch (err) {
    return { ok: false, observed: `error ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface ExecuteHooks {
  /**
   * Called before a step runs with its idempotency key. Return false when the key already ran (a retried
   * alarm, say); the step is then reported as skipped and not run again.
   */
  claim?(key: string): boolean | Promise<boolean>;
}

export interface ExecutionResult {
  state: 'applied' | 'rolled_back' | 'failed';
  steps: RepairStep[];
  /** Step numbers whose change is in place (what undo has to reverse). */
  applied: number[];
  speech: string;
}

function entityOf(op: PlanOp): EntityId | undefined {
  return op.kind === 'reload_integration' ? undefined : op.entity_id;
}

async function log(deps: EngineDeps, plan: RepairPlan, step: number, action: PlanAction, status: RepairStepStatus, rb: ReadBack, phase: 'apply' | 'rollback' | 'undo'): Promise<number> {
  const entityId = entityOf(action.op);
  return deps.ledger.append({
    ts: deps.clock.now(),
    kind: 'repair',
    ...(entityId !== undefined ? { entityId } : {}),
    source: 'fixwright',
    data: { plan_id: plan.plan_id, step, phase, op: action.op.kind, status, observed: rb.observed, idempotency_key: `${plan.plan_id}:${step}`, entity_ids: entityId ? [entityId] : [] },
  });
}

/**
 * Runs a plan step by step, reading each step back. On the first mismatch it rolls back the steps already
 * done, in reverse, reading each inverse back. State 'failed' means a rollback did not read back cleanly.
 */
export async function executePlan(plan: RepairPlan, deps: EngineDeps, hooks: ExecuteHooks = {}): Promise<ExecutionResult> {
  const steps: RepairStep[] = plan.steps.map((s) => ({ step: s.step, label: s.label, status: 'pending' }));
  const done: PlanStep[] = [];
  let failedAt: number | undefined;
  for (const s of plan.steps) {
    const view = steps[s.step - 1] as RepairStep;
    if (hooks.claim && !(await hooks.claim(s.idempotency_key))) {
      view.status = 'skipped';
      view.read_back = 'Already applied';
      continue;
    }
    const rb = await runAction(s, deps);
    view.status = rb.ok ? 'done' : 'failed';
    if (rb.ok) view.read_back = s.read_back_text;
    await log(deps, plan, s.step, s, view.status, rb, 'apply');
    if (!rb.ok) {
      failedAt = s.step;
      break;
    }
    done.push(s);
  }
  if (failedAt === undefined) {
    const last = plan.steps.at(-1);
    const flashed = last?.op.kind === 'flash_check' && steps.at(-1)?.status === 'done';
    const lines = [flashed ? phrase('ap_done_flash', {}) : phrase('ap_done', { count: done.length })];
    if (isVerifiable(plan)) {
      // Applied before 7:00 (a real house at dawn), the check is this morning, not tomorrow.
      const nowMs = deps.clock.nowMs();
      const today = localTime(nextLocalTime(nowMs, deps.settings.tz, MORNING_CHECK_AT), deps.settings.tz).day === localTime(nowMs, deps.settings.tz).day;
      lines.push(phrase('ap_next_check', { count: plan.verify.kind === 'setting_holds' ? plan.verify.entity_ids.length : 1, today }));
    }
    return { state: 'applied', steps, applied: done.map((s) => s.step), speech: speechSafe(lines.join(' ')) };
  }
  let clean = true;
  // The failed step may be half applied; undo it too when it has an inverse.
  const failed = plan.steps[failedAt - 1];
  const toUndo = [...done, ...(failed?.inverse ? [failed] : [])].reverse();
  for (const s of toUndo) {
    if (!s.inverse) continue;
    const rb = await runAction(s.inverse, deps);
    const view = steps[s.step - 1] as RepairStep;
    if (s.step !== failedAt) view.status = rb.ok ? 'rolled_back' : 'failed';
    view.read_back = rb.ok ? s.inverse.read_back_text : `Could not undo: ${rb.observed}`;
    await log(deps, plan, s.step, s.inverse, rb.ok ? 'rolled_back' : 'failed', rb, 'rollback');
    clean &&= rb.ok;
  }
  for (const v of steps) if (v.status === 'pending') v.status = 'skipped';
  return {
    state: clean ? 'rolled_back' : 'failed',
    steps,
    applied: clean ? [] : done.map((s) => s.step),
    speech: speechSafe(phrase(clean ? 'ap_rolled_back' : 'ap_failed', {})),
  };
}

export interface UndoResult {
  ok: boolean;
  /** The inverse steps, numbered from 1, each read back. */
  steps: RepairStep[];
  speech: string;
}

/** What undo says: settings plans count the settings, other plans name the device, checks change nothing. */
function undoSpeech(plan: RepairPlan, ok: boolean, undone: number): string {
  if (!ok) return phrase('undo_partial', {});
  if (undone === 0) return phrase('undo_nothing', {});
  if (plan.verify.kind === 'setting_holds') return phrase('undo_settings', { count: undone });
  return phrase('undo_done', { name: plan.verify.name });
}

/** Reverses the applied steps of a plan, newest first, reading each inverse back. */
export async function undoPlan(plan: RepairPlan, applied: readonly number[], deps: EngineDeps): Promise<UndoResult> {
  const order = plan.steps.filter((s) => applied.includes(s.step) && s.inverse !== null).reverse();
  const steps: RepairStep[] = [];
  let ok = true;
  for (const s of order) {
    const inverse = s.inverse as PlanAction;
    const rb = await runAction(inverse, deps);
    steps.push({ step: steps.length + 1, label: inverse.label, status: rb.ok ? 'done' : 'failed', read_back: rb.ok ? inverse.read_back_text : `Could not undo: ${rb.observed}` });
    await log(deps, plan, s.step, inverse, rb.ok ? 'done' : 'failed', rb, 'undo');
    ok &&= rb.ok;
  }
  return { ok, steps, speech: speechSafe(undoSpeech(plan, ok, steps.length)) };
}

export interface MorningCheck {
  /**
   * 'not_checked': the plan has nothing a sensor can verify (verify.kind 'none'). It is not a pass: record
   * no check, push nothing, and never say "Repair confirmed".
   */
  result: 'pass' | 'fail' | 'not_checked';
  /** One sentence for repair_status checks[].detail. */
  detail: string;
  /** The push and spoken line: the detail plus "Repair confirmed." or what happens next. Empty when not_checked. */
  speech: string;
  answered: number;
  total: number;
  /** Ledger seqs: the commands and replies seen, any drops, and the note recording this check. */
  evidence: number[];
}

const ANSWER_WINDOW_MS = 10_000;

/** The first sentence, for checks[].detail ("Hallway lamp answered all 9 commands overnight, but went offline once."). */
const firstSentence = (text: string): string => /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;

/** A command counts as answered when the device reports the commanded state within 10 s. */
function commandsAnswered(events: readonly HouseEvent[], ids: ReadonlySet<EntityId>) {
  const commands = events.filter((e) => e.kind === 'service_call' && e.entityId !== undefined && ids.has(e.entityId));
  const evidence: number[] = [];
  let answered = 0;
  for (const c of commands) {
    const service = String(c.data?.['service'] ?? '');
    const want = /turn_on$/.test(service) ? 'on' : /turn_off$/.test(service) ? 'off' : undefined;
    const reply = events.find(
      (e) =>
        e.kind === 'state' &&
        e.entityId === c.entityId &&
        Date.parse(e.ts) >= Date.parse(c.ts) &&
        Date.parse(e.ts) - Date.parse(c.ts) <= ANSWER_WINDOW_MS &&
        (want === undefined || e.to === want),
    );
    evidence.push(c.seq);
    if (reply) {
      answered++;
      evidence.push(reply.seq);
    }
  }
  return { total: commands.length, answered, evidence };
}

/** Records what the morning check saw as a ledger note, so a pass or a fail cites something it observed. */
async function recordCheck(plan: RepairPlan, result: 'pass' | 'fail', observed: Record<string, unknown>, deps: EngineDeps): Promise<number> {
  const ids = plan.verify.entity_ids;
  return deps.ledger.append({
    ts: deps.clock.now(),
    kind: 'note',
    ...(ids[0] !== undefined ? { entityId: ids[0] } : {}),
    source: 'fixwright',
    data: { check: 'morning', plan_id: plan.plan_id, cause_id: plan.cause_id, verify: plan.verify.kind, result, entity_ids: [...ids], ...observed },
  });
}

/**
 * Checks a repair the morning after: did the device answer every command since the repair (or stay online
 * if nobody used it), and did changed settings hold? Every checked result appends a ledger note with the
 * states it read and cites it, next to the home events behind it.
 */
export async function morningCheck(plan: RepairPlan, since: string, deps: EngineDeps): Promise<MorningCheck> {
  const ids = new Set(plan.verify.entity_ids);
  const until = deps.clock.now();
  const name = plan.verify.name;
  if (!isVerifiable(plan)) {
    return { result: 'not_checked', detail: phrase('mc_not_checked', {}), speech: '', answered: 0, total: 0, evidence: [] };
  }
  if (plan.verify.kind === 'setting_holds') {
    const wanted = new Map(plan.steps.flatMap((s) => (s.expect.kind === 'state' ? [[s.expect.entity_id, s.expect.equals] as const] : [])));
    const seen: Record<string, string> = {};
    let held = 0;
    for (const [id, value] of wanted) {
      const state = (await deps.adapter.getEntity(id))?.state ?? 'missing';
      seen[id] = state;
      if (state === value) held++;
    }
    const ok = held === wanted.size;
    const line = ok ? phrase('mc_setting_pass', { count: wanted.size }) : phrase('mc_setting_fail', { changed: wanted.size - held, count: wanted.size });
    const seq = await recordCheck(plan, ok ? 'pass' : 'fail', { held, total: wanted.size, wanted: Object.fromEntries(wanted), observed: seen }, deps);
    return { result: ok ? 'pass' : 'fail', detail: line.split('. ')[0] + '.', speech: speechSafe(line), answered: held, total: wanted.size, evidence: [seq] };
  }
  const events = await syncHomeEvents(deps, { since, until, entityIds: [...ids] });
  const offline = events.filter((e) => e.to === 'unavailable');
  const { total, answered, evidence } = commandsAnswered(events, ids);
  const current = await Promise.all([...ids].map((id) => deps.adapter.getEntity(id)));
  const online = current.every((e) => e !== null && e.state !== 'unavailable');
  let speech: string;
  let pass: boolean;
  if (total > 0) {
    const missed = total - answered;
    const drops = offline.length;
    pass = missed === 0 && drops === 0;
    speech =
      missed === 0
        ? drops === 0
          ? phrase('mc_pass', { name, count: total })
          : phrase('mc_answered_offline', { name, count: total, drops })
        : drops === 0
          ? phrase('mc_fail', { name, missed, count: total })
          : phrase('mc_fail_offline', { name, missed, count: total, drops });
  } else {
    pass = online && offline.length === 0;
    speech = phrase(pass ? 'mc_pass_quiet' : 'mc_offline', { name });
  }
  const states = Object.fromEntries([...ids].map((id, i) => [id, current[i]?.state ?? 'missing']));
  const seq = await recordCheck(plan, pass ? 'pass' : 'fail', { since, commands: total, answered, offline_events: offline.length, states }, deps);
  const detail = firstSentence(speech);
  const cited = [...new Set([...evidence, ...offline.map((e) => e.seq), seq])].sort((a, b) => a - b);
  return { result: pass ? 'pass' : 'fail', detail, speech: speechSafe(speech), answered, total, evidence: cited };
}

/**
 * When the server should run morningCheck for an applied plan: the next 07:00 household time, or undefined
 * when the plan has nothing a sensor can verify (then repair_apply carries no next_check_at).
 */
export function morningCheckAt(plan: RepairPlan, appliedAtMs: number, tz: string): string | undefined {
  if (!isVerifiable(plan)) return undefined;
  return iso(nextLocalTime(appliedAtMs, tz, MORNING_CHECK_AT));
}
