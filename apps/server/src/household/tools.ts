// The 11 tools, run inside the household's Durable Object. The engine does the reasoning; this file
// stores sessions and plans, enforces the repair executor invariants (signed single use confirm token,
// each step at most once, read back, rollback) and builds the outputs the engine does not (repair
// records, protect_device, switch_device, refresh_view).

import { isHaError, toProtocolError } from '@fixwright/adapter-ha';
import {
  answerDiagnosis,
  executePlan,
  explainEvent,
  houseView,
  inferTopology,
  isEngineError,
  isUnsafeDevice,
  lowerName,
  morningCheckAt,
  phrase,
  planRepair,
  protectedGuard,
  resolveTarget,
  runCheckup,
  sourceOf,
  startDiagnosis,
  undoPlan,
  type CheckupSession,
  type DiagnosisSession,
  type EngineDeps,
  type ExplanationSession,
  type RepairPlan,
  type RepairSource,
} from '@fixwright/engine';
import {
  isProtocolError,
  newId,
  problemOutput,
  protocolError,
  speechSafe,
  type Entity,
  type Ids,
  type ProblemCode,
  type ProtocolError,
  type RepairCheck,
  type RepairStep,
  type SourceInfo,
  type ToolInputMap,
  type ToolName,
} from '@fixwright/protocol';
import { canonicalJson, sha256Hex, signConfirmToken, timingSafeEqual, verifyConfirmToken } from '../lib/crypto.ts';
import { beginUndo, claimStep, consumePlan, enqueue, transitionRepair, type RepairState } from './cas.ts';
import type { Db } from './db.ts';
import { droppingNextWrite, takeDrill } from './safety.ts';
import type { House } from './house.ts';

export interface ToolReply {
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

export interface ToolContext {
  db: Db;
  house: House;
  secret: string;
  realNow: () => number;
}

/** A failure with the words the person hears. Thrown inside a tool, turned into an isError result. */
export function problem(code: ProblemCode, speech?: string, message?: string): Error & ProtocolError {
  const p = protocolError(code, message, speech);
  return Object.assign(new Error(p.message), p);
}

/** homefault's SimHome error codes, as protocol problems. */
const SIM_CODES: Readonly<Record<string, ProblemCode>> = {
  not_found: 'not_found',
  hub_unreachable: 'hub_unreachable',
  bad_request: 'invalid_input',
  unknown_fault: 'invalid_input',
};

export function toProblem(err: unknown): ProtocolError {
  if (isEngineError(err) || isProtocolError(err)) return err;
  if (isHaError(err)) return toProtocolError(err);
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof code === 'string') return protocolError(SIM_CODES[code] ?? 'adapter_error', String((err as Error).message ?? code));
  return protocolError('internal', err instanceof Error ? err.message : String(err));
}

const ok = (out: Record<string, unknown>): ToolReply => ({ structuredContent: out, isError: false });

type SessionType = 'diagnosis' | 'explanation' | 'checkup';

function saveSession(db: Db, id: string, type: SessionType, body: unknown, output: unknown, nowMs: number): void {
  db.sql.exec(
    `INSERT INTO sessions (id, type, body, output, updated_ms) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET body = excluded.body, output = excluded.output, updated_ms = excluded.updated_ms`,
    id,
    type,
    JSON.stringify(body),
    JSON.stringify(output),
    nowMs,
  );
}

function loadSession<T>(db: Db, id: string, type: SessionType): { body: T; output: Record<string, unknown> } | undefined {
  const row = db.sql.exec<{ body: string; output: string }>(`SELECT body, output FROM sessions WHERE id = ? AND type = ?`, id, type).toArray()[0];
  return row ? { body: JSON.parse(row.body) as T, output: JSON.parse(row.output) as Record<string, unknown> } : undefined;
}

/** The newest checkup or explanation that offers this issue. */
function sessionForIssue(db: Db, issueId: string): CheckupSession | ExplanationSession | undefined {
  const rows = db.sql
    .exec<{ body: string }>(`SELECT body FROM sessions WHERE type IN ('checkup', 'explanation') AND instr(body, ?) > 0 ORDER BY updated_ms DESC LIMIT 5`, `"${issueId}"`)
    .toArray();
  for (const r of rows) {
    const s = JSON.parse(r.body) as CheckupSession | ExplanationSession;
    if (s.type === 'checkup' && s.findings.some((f) => f.finding.issue_id === issueId)) return s;
    if (s.type === 'explanation' && s.suggested_fix?.issue_id === issueId) return s;
  }
  return undefined;
}

export interface PlanRow {
  plan_id: string;
  body: string;
  plan_hash: string;
  token_hash: string;
  expires_at: string;
  used: number;
  repair_id: string | null;
  output: string;
}

export interface RepairRow {
  repair_id: string;
  plan_id: string;
  state: RepairState;
  epoch: number;
  steps: string;
  applied: string;
  checks: string;
  undo_steps: string | null;
  next_check_at: string | null;
  repaired_at: string | null;
  speech: string;
  undoable: number;
}

export function loadPlanRow(db: Db, planId: string): PlanRow | undefined {
  return db.sql.exec<PlanRow & Record<string, string | number | null>>(`SELECT * FROM plans WHERE plan_id = ?`, planId).toArray()[0];
}

export function loadRepair(db: Db, repairId: string): RepairRow | undefined {
  return db.sql.exec<RepairRow & Record<string, string | number | null>>(`SELECT * FROM repairs WHERE repair_id = ?`, repairId).toArray()[0];
}

export const planHash = (plan: RepairPlan): Promise<string> => sha256Hex(canonicalJson({ ...plan, confirm_token: '' }));

const planIds = (plan: Pick<RepairPlan, 'plan_id' | 'source'>, repairId?: string): Ids => ({
  ...plan.source,
  plan_id: plan.plan_id,
  ...(repairId !== undefined ? { repair_id: repairId } : {}),
});

/** What repair_status (and refresh_view for a repair) says about a stored repair. */
export function repairStatusOutput(db: Db, row: RepairRow, source: SourceInfo): Record<string, unknown> {
  const plan = JSON.parse((loadPlanRow(db, row.plan_id) as PlanRow).body) as RepairPlan;
  if (row.state === 'applying' || row.state === 'undoing') {
    throw problem('internal', "That fix is still running. Ask me again in a moment.", `repair ${row.repair_id} is ${row.state}`);
  }
  const state = row.state;
  const undone = state === 'undone';
  const steps = JSON.parse(undone && row.undo_steps ? row.undo_steps : row.steps) as RepairStep[];
  const checks = JSON.parse(row.checks) as RepairCheck[];
  const nextCheck = state === 'applied' && row.next_check_at ? row.next_check_at : undefined;
  const speech =
    state === 'applied'
      ? nextCheck
        ? "The fix is in place and checked. I'll look at it again at 7 in the morning."
        : 'The fix is in place and checked.'
      : row.speech;
  return {
    speech: speechSafe(speech),
    status: 'ok',
    view: 'repair_card',
    ids: planIds(plan, row.repair_id),
    source,
    repair_id: row.repair_id,
    plan_id: row.plan_id,
    state,
    steps,
    undo_available: row.undoable === 1 && (state === 'applied' || state === 'confirmed' || state === 'regressed'),
    ...(nextCheck ? { next_check_at: nextCheck } : {}),
    checks,
  };
}

type Handler<N extends ToolName> = (input: ToolInputMap[N], ctx: ToolContext, deps: EngineDeps) => Promise<ToolReply>;

/** Tools that may write to the home: the SimHome snapshot is saved after them. */
export const MUTATING: ReadonlySet<ToolName> = new Set(['diagnose', 'diagnose_answer', 'repair_apply', 'undo', 'switch_device']);

function scheduleGuidedCheck(ctx: ToolContext, session: DiagnosisSession): void {
  if (session.guided_check) enqueue(ctx.db, 'guided_check', session.diagnosis_id, Date.parse(session.guided_check.check_at));
}

const handlers: { [N in ToolName]: Handler<N> } = {
  async home_checkup(input, ctx, deps) {
    const r = await runCheckup(input, deps);
    saveSession(ctx.db, r.session.checkup_id, 'checkup', r.session, r.output, ctx.realNow());
    return ok(r.output);
  },

  async diagnose(input, ctx, deps) {
    const r = await startDiagnosis(input, deps);
    saveSession(ctx.db, r.session.diagnosis_id, 'diagnosis', r.session, r.output, ctx.realNow());
    scheduleGuidedCheck(ctx, r.session);
    return ok(r.output);
  },

  async diagnose_answer(input, ctx, deps) {
    const stored = loadSession<DiagnosisSession>(ctx.db, input.diagnosis_id, 'diagnosis');
    if (!stored) throw problem('session_expired');
    const r = await answerDiagnosis(stored.body, input, deps);
    saveSession(ctx.db, r.session.diagnosis_id, 'diagnosis', r.session, r.output, ctx.realNow());
    scheduleGuidedCheck(ctx, r.session);
    return ok(r.output);
  },

  async explain_event(input, ctx, deps) {
    const r = await explainEvent(input, deps);
    saveSession(ctx.db, r.session.explanation_id, 'explanation', r.session, r.output, ctx.realNow());
    return ok(r.output);
  },

  async repair_plan(input, ctx, deps) {
    let source: RepairSource;
    if (input.diagnosis_id !== undefined) {
      const s = loadSession<DiagnosisSession>(ctx.db, input.diagnosis_id, 'diagnosis');
      if (!s) throw problem('session_expired');
      source = { kind: 'diagnosis', session: s.body };
    } else if (input.explanation_id !== undefined) {
      const s = loadSession<ExplanationSession>(ctx.db, input.explanation_id, 'explanation');
      if (!s) throw problem('session_expired');
      source = { kind: 'explanation', session: s.body };
    } else {
      const s = sessionForIssue(ctx.db, input.issue_id as string);
      if (!s) throw problem('session_expired');
      source = { kind: 'issue', session: s, issue_id: input.issue_id as string };
    }
    const { plan: drafted, output } = await planRepair(source, deps);
    const plan: RepairPlan = { ...drafted, confirm_token: '' };
    const hash = await planHash(plan);
    const token = await signConfirmToken(ctx.secret, plan.plan_id, hash, plan.expires_at);
    const out = { ...output, confirm_token: token, expires_at: plan.expires_at };
    ctx.db.sql.exec(
      `INSERT INTO plans (plan_id, body, plan_hash, token_hash, expires_at, used, output, created_ms) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      plan.plan_id,
      JSON.stringify(plan),
      hash,
      await sha256Hex(token),
      plan.expires_at,
      JSON.stringify(out),
      ctx.realNow(),
    );
    return ok(out);
  },

  async repair_apply(input, ctx, deps) {
    const row = loadPlanRow(ctx.db, input.plan_id);
    if (!row) throw problem('not_found', "I couldn't find that fix. Want me to plan it again?");
    const plan = JSON.parse(row.body) as RepairPlan;
    // The stored plan must be the plan that was signed, and the token must be the one signed for it.
    const hash = await planHash(plan);
    const signed = timingSafeEqual(hash, row.plan_hash) && (await verifyConfirmToken(ctx.secret, input.confirm_token, plan.plan_id, hash, plan.expires_at));
    if (!signed || !timingSafeEqual(await sha256Hex(input.confirm_token), row.token_hash)) throw problem('token_mismatch');
    const nowMs = deps.clock.nowMs();
    const repairId = newId('rep', deps.clock, deps.rng);
    const initial = JSON.stringify(plan.steps.map((s) => ({ step: s.step, label: s.label, status: 'pending' })));
    const consumed = consumePlan(ctx.db, plan.plan_id, repairId, nowMs, initial);
    if (!consumed.ok) {
      if (consumed.code === 'plan_used') throw problem('plan_used');
      if (consumed.code === 'plan_expired') throw problem('plan_expired');
      throw problem('not_found', "I couldn't find that fix. Want me to plan it again?");
    }
    const epoch = consumed.epoch;
    let result: Awaited<ReturnType<typeof executePlan>>;
    // The "next step won't stick" drill (safety.ts, demo house only): this apply's first write is dropped.
    const drilled = deps.adapter.kind === 'simhome' && takeDrill(ctx.db, 'next_step_fails');
    const runDeps = drilled ? { ...deps, adapter: droppingNextWrite(deps.adapter) } : deps;
    try {
      result = await executePlan(plan, runDeps, { claim: (key) => claimStep(ctx.db, repairId, epoch, key, ctx.realNow()) });
    } catch (err) {
      // The executor reports adapter failures as read back mismatches; anything thrown here is unexpected.
      // Close the repair as failed so it never sits in applying, then report the error.
      transitionRepair(ctx.db, repairId, { state: 'applying', epoch }, 'failed', { speech: phrase('ap_failed', {}), undoable: 0 }, ctx.realNow());
      throw err;
    }
    const repairedAt = deps.adapter.now();
    const nextCheck = result.state === 'applied' ? morningCheckAt(plan, deps.clock.nowMs(), deps.settings.tz) : undefined;
    const undoable = result.state === 'applied' && plan.undoable && result.applied.length > 0;
    const moved = transitionRepair(
      ctx.db,
      repairId,
      { state: 'applying', epoch },
      result.state,
      {
        steps: JSON.stringify(result.steps),
        applied: JSON.stringify(result.applied),
        speech: result.speech,
        next_check_at: nextCheck ?? null,
        repaired_at: repairedAt,
        undoable: undoable ? 1 : 0,
      },
      ctx.realNow(),
    );
    if (!moved) throw problem('internal', undefined, `repair ${repairId} changed under epoch ${epoch}`);
    if (nextCheck) enqueue(ctx.db, 'morning_check', repairId, Date.parse(nextCheck));
    return ok({
      speech: result.speech,
      status: 'ok',
      view: 'repair_card',
      ids: planIds(plan, repairId),
      source: sourceOf(deps.adapter),
      repair_id: repairId,
      plan_id: plan.plan_id,
      state: result.state,
      steps: result.steps,
      undo_available: undoable,
      ...(nextCheck ? { next_check_at: nextCheck } : {}),
    });
  },

  async repair_status(input, ctx, deps) {
    const row = loadRepair(ctx.db, input.repair_id);
    if (!row) throw problem('not_found', "I couldn't find that fix.");
    return ok(repairStatusOutput(ctx.db, row, sourceOf(deps.adapter)));
  },

  async undo(input, ctx, deps) {
    const begun = beginUndo(ctx.db, input.repair_id, ctx.realNow());
    if (!begun.ok) {
      if (begun.state === null) throw problem('not_found', "I couldn't find that fix.");
      const speech =
        begun.state === 'undone'
          ? 'That fix is already undone.'
          : begun.state === 'confirmed'
            ? "That fix is settled now, so there's nothing to undo."
            : "There's nothing to undo for that fix.";
      throw problem('no_fix', speech, `repair ${input.repair_id} is ${begun.state}`);
    }
    const row = loadRepair(ctx.db, input.repair_id) as RepairRow;
    const plan = JSON.parse((loadPlanRow(ctx.db, row.plan_id) as PlanRow).body) as RepairPlan;
    const result = await undoPlan(plan, JSON.parse(row.applied) as number[], deps);
    const fields = { undo_steps: JSON.stringify(result.steps), speech: result.speech, next_check_at: null, undoable: 0 };
    transitionRepair(ctx.db, row.repair_id, { state: 'undoing', epoch: begun.epoch }, result.ok ? 'undone' : 'failed', fields, ctx.realNow());
    if (!result.ok) throw problem('adapter_error', result.speech, `undo of ${row.repair_id} did not read back`);
    return ok({
      speech: result.speech,
      status: 'ok',
      view: 'repair_card',
      ids: planIds(plan, row.repair_id),
      source: sourceOf(deps.adapter),
      repair_id: row.repair_id,
      plan_id: row.plan_id,
      state: 'undone',
      steps: result.steps,
      undo_available: false,
    });
  },

  async protect_device(input, ctx, deps) {
    const entities = await deps.adapter.listEntities();
    const entity = resolveDevice(entities, input.device);
    const outlet = inferTopology(entities)
      .strips.flatMap((s) => s.outlets)
      .find((o) => o.entity_id === entity.entityId);
    const name = outlet?.load ?? entity.name;
    const protect = input.protect ?? true;
    const existing = ctx.house.protectedList().find((p) => p.entity_id === entity.entityId);
    const reason = input.reason ?? existing?.reason ?? 'You asked me to keep it on.';
    ctx.house.setProtected({ entity_id: entity.entityId, name: entity.name, reason }, protect);
    const spoken = lowerName(name);
    const speech = protect
      ? outlet
        ? `Done. I'll never switch off the ${spoken}, even through its power strip.`
        : `Done. I'll never switch off the ${spoken}.`
      : `Okay. The ${spoken} is no longer protected.`;
    return ok({ speech: speechSafe(speech), status: 'ok', ids: {}, source: sourceOf(deps.adapter), protected: ctx.house.protectedList() });
  },

  async switch_device(input, ctx, deps) {
    const entities = await deps.adapter.listEntities();
    const entity = resolveDevice(entities, input.device);
    if (isUnsafeDevice(entity)) throw problem('unsafe_device');
    if (!['light', 'switch', 'fan'].includes(entity.domain)) throw problem('invalid_input', 'I can only switch lights, plugs and fans on or off.');
    const source = sourceOf(deps.adapter);
    if (!input.on) {
      const guard = protectedGuard('turn_off', entity, ctx.house.protectedList(), inferTopology(entities), { states: entities });
      if (!guard.allow) {
        if (guard.code === 'unsafe_device') throw problem('unsafe_device', guard.speech);
        const alt = guard.alternative;
        if (!alt) return ok({ speech: speechSafe(guard.speech), status: 'refused', ids: {}, source });
        const altEntity = entities.find((e) => e.entityId === alt.entity_id) as Entity;
        const state = await switchAndRead(deps, altEntity, false);
        return ok({
          speech: speechSafe(guard.speech),
          status: 'refused',
          ids: {},
          source,
          switched: { entity_id: alt.entity_id, name: altEntity.name, state },
          alternative: alt,
        });
      }
    }
    const state = await switchAndRead(deps, entity, input.on);
    return ok({
      speech: speechSafe(`Done. The ${lowerName(entity.name)} is ${input.on ? 'on' : 'off'}.`),
      status: 'ok',
      ids: {},
      source,
      switched: { entity_id: entity.entityId, name: entity.name, state },
    });
  },

  async refresh_view(input, ctx, deps) {
    const ref = input.ref_id;
    const source = sourceOf(deps.adapter);
    if (ref.startsWith('rep_')) {
      const row = loadRepair(ctx.db, ref);
      if (row) return ok(repairStatusOutput(ctx.db, row, source));
    } else if (ref.startsWith('pln_')) {
      const row = loadPlanRow(ctx.db, ref);
      if (row) return ok(JSON.parse(row.output) as Record<string, unknown>);
    } else if (ref.startsWith('iss_')) {
      const s = sessionForIssue(ctx.db, ref);
      const id = s?.type === 'checkup' ? s.checkup_id : s?.type === 'explanation' ? s.explanation_id : undefined;
      const stored = id !== undefined && s ? loadSession(ctx.db, id, s.type) : undefined;
      if (stored) return ok(stored.output);
    } else {
      const type: SessionType = ref.startsWith('dx_') ? 'diagnosis' : ref.startsWith('exp_') ? 'explanation' : 'checkup';
      const stored = loadSession(ctx.db, ref, type);
      if (stored) return ok(stored.output);
    }
    throw problem('not_found', 'That card is out of date. Ask me again and I will check.');
  },
};

function resolveDevice(entities: readonly Entity[], device: string): Entity {
  const match = resolveTarget(houseView(entities), device, device);
  const entity = match.primary ?? match.group[0];
  if (!entity) throw problem('not_found');
  return entity;
}

/** Switches one device and reads its state back; a device that does not follow is an error, not a success. */
async function switchAndRead(deps: EngineDeps, entity: Entity, on: boolean): Promise<string> {
  await deps.adapter.callService(entity.domain, on ? 'turn_on' : 'turn_off', { entity_id: entity.entityId });
  const after = await deps.adapter.getEntity(entity.entityId);
  const want = on ? 'on' : 'off';
  if (after?.state !== want) {
    throw problem('adapter_error', speechSafe(`I asked the ${lowerName(entity.name)} to switch ${want}, but it didn't follow.`), `read back ${after?.state ?? 'missing'}`);
  }
  return after.state;
}

/** Runs one tool. Every failure comes back as an isError result with a speech line, never a thrown error. */
export async function runTool<N extends ToolName>(name: N, input: ToolInputMap[N], ctx: ToolContext): Promise<ToolReply> {
  let source: SourceInfo = ctx.house.adapterConfig().kind === 'simhome' ? { adapter: 'simhome', simulated: true } : { adapter: 'home-assistant', simulated: false };
  try {
    const deps = await ctx.house.deps();
    source = sourceOf(deps.adapter);
    const reply = await (handlers[name] as Handler<N>)(input, ctx, deps);
    return reply;
  } catch (err) {
    const p = toProblem(err);
    if (p.code === 'internal') console.error(`[tool ${name}]`, err instanceof Error ? (err.stack ?? err.message) : err);
    return { structuredContent: problemOutput(p, source, idsFromInput(input)), isError: true };
  }
}

function idsFromInput(input: unknown): Ids {
  const ids: Ids = {};
  if (typeof input !== 'object' || input === null) return ids;
  const v = input as Record<string, unknown>;
  for (const key of ['diagnosis_id', 'issue_id', 'explanation_id', 'plan_id', 'repair_id', 'checkup_id'] as const) {
    if (typeof v[key] === 'string') ids[key] = v[key];
  }
  return ids;
}
