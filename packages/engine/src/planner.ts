// Repair planner. Turns a verdict, a checkup finding or an explanation into a dry run: steps,
// each with the adapter op, the read back it must pass and the inverse that undoes it, plus a diff and the
// same diff in plain sentences. Nothing runs here; the server executes the plan (see executor.ts) after one
// explicit yes. Never plans on locks, garage doors, alarms, cameras or security systems, and never
// switches off a protected load.

import {
  ID_ALPHABET,
  newId,
  speechSafe,
  type DiagnosisCauseId,
  type DiffRow,
  type Entity,
  type EntityId,
  type RepairPlanOutput,
} from '@fixwright/protocol';
import { causeDef, isAutomatic } from './causes.ts';
import { sourceOf } from './common.ts';
import { engineError, isEngineError } from './errors.ts';
import { protectedGuard } from './guard.ts';
import { houseView, inferTopology, isGhost, isGroup, isUnavailable, isUnsafeDevice, powerOnSelect, previousOption, type HouseView } from './house.ts';
import { phrase } from './phrase.ts';
import { canFlash } from './probes.ts';
import type {
  CheckupSession,
  DiagnosisSession,
  EngineDeps,
  ExplanationSession,
  PlanAction,
  PlanOp,
  PlanStep,
  RepairPlan,
  RepairVerify,
} from './types.ts';
import { brand, capitalize, deviceNoun, fold, integrationName, isMakerDescription, lowerName } from './util/text.ts';
import { MINUTE_MS, iso, sincePhrase } from './util/time.ts';

/** How long a plan's confirm token stays valid. */
export const PLAN_TTL_MS = 5 * MINUTE_MS;
const TOKEN_LENGTH = 32;

export type RepairSource =
  | { kind: 'diagnosis'; session: DiagnosisSession }
  | { kind: 'issue'; session: CheckupSession | ExplanationSession; issue_id: string }
  | { kind: 'explanation'; session: ExplanationSession };

export interface PlanResult {
  plan: RepairPlan;
  output: RepairPlanOutput;
}

interface Draft {
  steps: (PlanAction & { inverse: PlanAction | null })[];
  diff: DiffRow[];
  diffLines: string[];
  conflicts: string[];
  followUp: PlanOp[];
  verify: RepairVerify;
}

interface Target {
  cause: DiagnosisCauseId;
  entityIds: EntityId[];
  ids: RepairPlan['source'];
}

function targetOf(source: RepairSource): Target {
  if (source.kind === 'diagnosis') {
    const s = source.session;
    const v = s.verdict;
    if (!v || v.level === 'cant_tell') throw engineError('no_fix', 'the diagnosis has no verdict to fix');
    if (!v.fix_available) {
      const check = s.guided_check;
      const guidance = causeDef(v.cause_id as DiagnosisCauseId).repair.guidance?.({
        name: lowerName(s.target.name),
        check: check !== undefined,
        count: check?.entity_ids.length ?? 1,
      });
      throw engineError('no_fix', `${v.cause_id} has no automatic repair`, guidance ? `I can't fix that one by myself. ${guidance}` : undefined);
    }
    return { cause: v.cause_id as DiagnosisCauseId, entityIds: s.entities.group, ids: { diagnosis_id: s.diagnosis_id } };
  }
  if (source.kind === 'explanation' || source.session.type === 'explanation') {
    const s = source.session as ExplanationSession;
    const fix = s.suggested_fix;
    if (!fix || (source.kind === 'issue' && fix.issue_id !== source.issue_id)) throw engineError('no_fix', 'the explanation offered no fix');
    return {
      cause: fix.cause_id,
      entityIds: fix.entity_ids,
      ids: { explanation_id: s.explanation_id, issue_id: fix.issue_id },
    };
  }
  const record = source.session.findings.find((f) => f.finding.issue_id === source.issue_id);
  if (!record) throw engineError('not_found', `no issue ${source.issue_id} in checkup ${source.session.checkup_id}`);
  if (!record.repair) throw engineError('no_fix', `${record.finding.kind} has no automatic repair`);
  return { cause: record.repair.cause_id, entityIds: record.repair.entity_ids, ids: { issue_id: source.issue_id } };
}

function nameStep(e: Entity, to: string, label: string, extraAliases: string[] = []): PlanAction & { inverse: PlanAction } {
  const aliases = [...new Set([...e.aliases, ...extraAliases])];
  const aliasPatch = aliases.length !== e.aliases.length ? { aliases } : {};
  return {
    label,
    op: { kind: 'registry_update', entity_id: e.entityId, patch: { name: to, ...aliasPatch } },
    expect: { kind: 'name', entity_id: e.entityId, equals: to },
    read_back_text: phrase('rb_name', { name: to }),
    inverse: {
      label: phrase('inv_name', { name: e.name }),
      op: { kind: 'registry_update', entity_id: e.entityId, patch: { name: e.name, ...(aliasPatch.aliases ? { aliases: [...e.aliases] } : {}) } },
      expect: { kind: 'name', entity_id: e.entityId, equals: e.name },
      read_back_text: phrase('rb_name', { name: e.name }),
    },
  };
}

/** Lets an entity also answer to `add`, with an inverse that puts its own aliases back. */
function aliasStep(e: Entity, add: string[], noun: string): PlanAction & { inverse: PlanAction } {
  const aliases = [...e.aliases, ...add];
  return {
    label: phrase('st_aliases', { noun, aliases: add }),
    op: { kind: 'registry_update', entity_id: e.entityId, patch: { aliases } },
    expect: { kind: 'aliases', entity_id: e.entityId, equals: aliases },
    read_back_text: phrase('rb_aliases', { aliases: add }),
    inverse: {
      label: phrase('inv_aliases', { noun }),
      op: { kind: 'registry_update', entity_id: e.entityId, patch: { aliases: [...e.aliases] } },
      expect: { kind: 'aliases', entity_id: e.entityId, equals: [...e.aliases] },
      read_back_text: phrase('rb_aliases_back', {}),
    },
  };
}

function flashStep(e: Entity): PlanAction & { inverse: null } {
  return {
    label: phrase('st_check', {}),
    op: { kind: 'flash_check', entity_id: e.entityId, domain: e.domain, times: 2 },
    expect: { kind: 'answers', entity_id: e.entityId, times: 2 },
    read_back_text: phrase('rb_answers', { times: 2 }),
    inverse: null,
  };
}

function staleDuplicate(t: Target, house: HouseView, deps: EngineDeps): Draft {
  const nowMs = deps.clock.nowMs();
  const members = t.entityIds.map((id) => house.byId.get(id)).filter((e): e is Entity => e !== undefined);
  const old = members.find((e) => isGhost(e, nowMs)) ?? members.find((e) => isUnavailable(e) && (e.restored === true || e.registryOnly === true)) ?? members.find(isUnavailable);
  if (!old) throw engineError('no_fix', 'no old copy left to retire', "It looks like that's already fixed. There's no old copy left.");
  const online = members.find((e) => e !== old && !isUnavailable(e));
  const noun = deviceNoun(old);
  const since = sincePhrase(Date.parse(old.lastChanged), nowMs, deps.settings.tz);
  const draft: Draft = { steps: [], diff: [], diffLines: [], conflicts: [], followUp: [], verify: { kind: 'none', entity_ids: [], name: old.name } };

  if (online) {
    draft.diffLines.push(phrase('pl_stale_point', { name: old.name, noun }));
    if (fold(online.name) !== fold(old.name)) {
      draft.steps.push(nameStep(online, old.name, phrase('st_rename_online', { noun, name: old.name }), old.aliases));
      draft.diff.push({ entity_id: online.entityId, field: 'name', from: online.name, to: old.name });
    } else {
      // Same name already: the rename changes nothing, but the old copy's other names ("hall light") must move
      // too, or retiring it silently drops them.
      const known = new Set([online.name, ...online.aliases].map(fold));
      const add = [...new Map(old.aliases.filter((a) => !known.has(fold(a))).map((a) => [fold(a), a])).values()];
      if (add.length > 0) {
        draft.steps.push(aliasStep(online, add, noun));
        draft.diff.push({ entity_id: online.entityId, field: 'aliases', from: online.aliases.join(', ') || 'none', to: [...online.aliases, ...add].join(', ') });
        draft.diffLines.push(phrase('pl_stale_aliases', { noun, aliases: add }));
      }
    }
  }
  draft.steps.push({
    label: phrase('st_retire', {}),
    op: { kind: 'registry_update', entity_id: old.entityId, patch: { disabled: true } },
    expect: { kind: 'disabled', entity_id: old.entityId, equals: true },
    read_back_text: phrase('rb_retired', {}),
    inverse: {
      label: phrase('inv_retire', {}),
      op: { kind: 'registry_update', entity_id: old.entityId, patch: { disabled: false } },
      expect: { kind: 'disabled', entity_id: old.entityId, equals: false },
      read_back_text: phrase('rb_restored', {}),
    },
  });
  draft.diff.push({ entity_id: old.entityId, field: 'registry', from: `kept, offline ${since}`, to: 'retired' });
  draft.diffLines.push(phrase('pl_stale_retire', { since }));
  // Home Assistant cannot bring a removed registry entry back, so the removal waits for the morning check.
  if (old.restored === true || old.registryOnly === true) draft.followUp.push({ kind: 'registry_remove', entity_id: old.entityId });

  if (online && canFlash(online, deps, house)) draft.steps.push(flashStep(online));
  else if (online) draft.conflicts.push(...protectedLines(online, deps, house));
  draft.verify = { kind: online ? 'commands_answered' : 'none', entity_ids: online ? [online.entityId] : [], name: old.name };
  return draft;
}

function protectedLines(e: Entity, deps: EngineDeps, house: HouseView): string[] {
  const topology = deps.settings.topology ?? inferTopology(house.all);
  const d = protectedGuard('flash', e, deps.settings.protected, topology);
  return d.allow || d.code !== 'protected_load' ? [] : [phrase('pl_protected', { load: lowerName(e.name) })];
}

function powerOnDefault(t: Target, house: HouseView): Draft {
  const draft: Draft = { steps: [], diff: [], diffLines: [], conflicts: [], followUp: [], verify: { kind: 'setting_holds', entity_ids: [], name: 'power on settings' } };
  const cannot: string[] = [];
  const devices = t.entityIds.map((id) => house.byId.get(id)).filter((e): e is Entity => e !== undefined);
  let first: Entity | undefined;
  const planned = new Set<EntityId>();
  for (const e of devices) {
    const select = powerOnSelect(e, house);
    const option = select ? previousOption(select) : undefined;
    // An old copy the integration no longer provides has no setting that matters, even when it shares the house with a second fault.
    if (!select && e.restored === true) continue;
    if (select && planned.has(select.entityId)) continue;
    if (select) planned.add(select.entityId);
    if (!select || option === undefined) {
      cannot.push(lowerName(e.name));
      continue;
    }
    if (select.state === option) continue;
    first ??= e;
    draft.steps.push({
      label: phrase('st_power_on', { name: e.name }),
      op: { kind: 'select_option', entity_id: select.entityId, option },
      expect: { kind: 'state', entity_id: select.entityId, equals: option },
      read_back_text: phrase('rb_option', { option }),
      inverse: {
        label: phrase('inv_option', { name: e.name, option: select.state }),
        op: { kind: 'select_option', entity_id: select.entityId, option: select.state },
        expect: { kind: 'state', entity_id: select.entityId, equals: select.state },
        read_back_text: phrase('rb_option', { option: select.state }),
      },
    });
    draft.diff.push({ entity_id: select.entityId, field: 'power on behavior', from: select.state, to: option });
    draft.verify.entity_ids.push(select.entityId);
  }
  if (draft.steps.length === 0) throw engineError('no_fix', 'no power on setting can be changed from here');
  draft.diffLines.push(phrase('pl_power_on', { count: draft.steps.length, name: lowerName(first?.name ?? '') }));
  if (cannot.length > 0) draft.diffLines.push(phrase('pl_cant_change', { names: cannot }));
  return draft;
}

function describe(e: Entity): string {
  return isGroup(e) ? `${integrationName(e.integration)} group` : `${integrationName(e.integration)} ${deviceNoun(e)}`;
}

/** A distinct, speakable name for one of two devices that share a name. */
export function proposeName(e: Entity, house: HouseView): string {
  const taken = new Set(house.live.flatMap((x) => [x.name, ...x.aliases].map(fold)));
  const noun = capitalize(deviceNoun(e));
  const options = [
    isGroup(e) ? `${e.name} Group` : undefined,
    e.area && !fold(e.name).includes(fold(e.area)) ? `${e.area} ${noun}` : undefined,
    e.vendor && !isMakerDescription(e.vendor) ? `${brand(e.vendor)} ${e.name}` : undefined,
    `${e.name} ${noun === 'Light' || noun === 'Lamp' ? 'Bulb' : 'Two'}`,
  ];
  for (const name of options) if (name !== undefined && !taken.has(fold(name))) return name;
  return `${e.name} Two`;
}

function nameCollision(t: Target, house: HouseView): Draft {
  const members = t.entityIds.map((id) => house.byId.get(id)).filter((e): e is Entity => e !== undefined);
  if (members.length < 2) throw engineError('no_fix', 'the names no longer collide', "It looks like that's already fixed.");
  const pick = members.find(isGroup) ?? [...members].sort((a, b) => b.entityId.localeCompare(a.entityId))[0] ?? members[0];
  const e = pick as Entity;
  const to = proposeName(e, house);
  const from = describe(e);
  return {
    steps: [nameStep(e, to, phrase('st_rename', { from: `the ${from}`, to }))],
    diff: [{ entity_id: e.entityId, field: 'name', from: e.name, to }],
    diffLines: [phrase('pl_rename', { from, to, name: e.name })],
    conflicts: [],
    followUp: [],
    verify: { kind: 'none', entity_ids: [], name: e.name },
  };
}

async function hubDown(t: Target, house: HouseView, deps: EngineDeps): Promise<Draft> {
  const e = house.byId.get(t.entityIds[0] ?? '');
  if (!e) throw engineError('not_found', 'the device behind this fix is gone');
  const status = (await deps.adapter.integrations()).find((i) => i.integration === e.integration);
  const hub = e.integration === 'hue' ? 'Hue Bridge' : `${integrationName(e.integration)} hub`;
  return {
    steps: [
      {
        label: phrase('st_reload', { hub }),
        op: { kind: 'reload_integration', integration: e.integration },
        expect: { kind: 'integration_loaded', integration: e.integration },
        read_back_text: phrase('rb_loaded', {}),
        inverse: null,
      },
    ],
    diff: [{ entity_id: e.entityId, field: 'connection', from: (status?.state ?? 'unknown').replace(/_/g, ' '), to: 'reloaded' }],
    diffLines: [phrase('pl_reload', { hub })],
    conflicts: [],
    followUp: [],
    verify: { kind: 'available', entity_ids: [e.entityId], name: e.name },
  };
}

function deadTrigger(t: Target, house: HouseView): Draft {
  const a = house.byId.get(t.entityIds[0] ?? '');
  if (!a || a.domain !== 'automation') throw engineError('not_found', 'the automation is gone');
  return {
    steps: [
      {
        label: phrase('st_automation_off', { name: a.name }),
        op: { kind: 'call_service', domain: 'automation', service: 'turn_off', entity_id: a.entityId },
        expect: { kind: 'state', entity_id: a.entityId, equals: 'off' },
        read_back_text: phrase('rb_state', { state: 'off' }),
        inverse: {
          label: phrase('inv_automation_on', { name: a.name }),
          op: { kind: 'call_service', domain: 'automation', service: 'turn_on', entity_id: a.entityId },
          expect: { kind: 'state', entity_id: a.entityId, equals: 'on' },
          read_back_text: phrase('rb_state', { state: 'on' }),
        },
      },
    ],
    diff: [{ entity_id: a.entityId, field: 'state', from: a.state, to: 'off' }],
    diffLines: [phrase('pl_dead_trigger', { name: a.name })],
    conflicts: [],
    followUp: [],
    verify: { kind: 'none', entity_ids: [], name: a.name },
  };
}

/** The device a helper entity belongs to: a power on select speaks for its light or plug. */
function ownerOf(e: Entity, house: HouseView): Entity {
  if (e.domain !== 'select' || e.deviceId === undefined) return e;
  return house.live.find((x) => x.deviceId === e.deviceId && x.domain !== 'select') ?? e;
}

function opTarget(op: PlanOp): EntityId | undefined {
  return op.kind === 'reload_integration' ? undefined : op.entity_id;
}

/**
 * Drops every step on a lock, garage door, alarm or camera (refusing the plan if nothing else is left) and
 * every step that would cut a protected load, saying why in the plan.
 */
function enforceSafety(draft: Draft, house: HouseView, deps: EngineDeps): Draft {
  const topology = deps.settings.topology ?? inferTopology(house.all);
  const unsafe = draft.steps.filter((s) => {
    const id = opTarget(s.op);
    const e = id ? house.byId.get(id) : undefined;
    return e !== undefined && isUnsafeDevice(e);
  });
  if (unsafe.length > 0) {
    if (unsafe.length === draft.steps.filter((s) => s.op.kind !== 'flash_check').length) {
      throw engineError('unsafe_device', `plan touches ${unsafe.map((s) => opTarget(s.op)).join(', ')}`);
    }
    for (const s of unsafe) {
      const e = house.byId.get(opTarget(s.op) ?? '');
      draft.conflicts.push(phrase('pl_unsafe', { name: lowerName(e ? ownerOf(e, house).name : 'device') }));
    }
    const skipped = new Set(unsafe.map((s) => opTarget(s.op)));
    draft = {
      ...draft,
      steps: draft.steps.filter((s) => !unsafe.includes(s)),
      diff: draft.diff.filter((d) => !skipped.has(d.entity_id)),
    };
  }
  const steps = draft.steps.filter((s) => {
    const cuts = s.op.kind === 'flash_check' || (s.op.kind === 'call_service' && (s.op.service === 'turn_off' || s.op.service === 'toggle'));
    const id = opTarget(s.op);
    const e = id ? house.byId.get(id) : undefined;
    if (!cuts || !e || e.domain === 'automation') return true;
    const d = protectedGuard(s.op.kind === 'flash_check' ? 'flash' : 'turn_off', e, deps.settings.protected, topology);
    if (!d.allow) draft.conflicts.push(phrase('pl_protected', { load: lowerName(e.name) }));
    return d.allow;
  });
  return { ...draft, steps };
}

function confirmToken(deps: EngineDeps): string {
  let out = '';
  for (let i = 0; i < TOKEN_LENGTH; i++) out += ID_ALPHABET.charAt(Math.floor(deps.rng.next() * ID_ALPHABET.length));
  return out;
}

/** The safe draft for a cause and its devices, or an engine error ('no_fix', 'not_found', 'unsafe_device'). */
async function draftFor(target: Target, house: HouseView, deps: EngineDeps): Promise<Draft> {
  let draft: Draft;
  switch (target.cause) {
    case 'stale_duplicate':
      draft = staleDuplicate(target, house, deps);
      break;
    case 'power_on_default_on':
      draft = powerOnDefault(target, house);
      break;
    case 'name_collision':
      draft = nameCollision(target, house);
      break;
    case 'hub_down':
      draft = await hubDown(target, house, deps);
      break;
    case 'dead_trigger':
      draft = deadTrigger(target, house);
      break;
    default: {
      const guidance = causeDef(target.cause).repair.guidance?.({ name: 'device', check: false, count: 1 });
      throw engineError('no_fix', `${target.cause} has no automatic repair`, guidance ? `I can't fix that one by myself. ${guidance}` : undefined);
    }
  }
  draft = enforceSafety(draft, house, deps);
  if (draft.steps.length === 0) throw engineError('no_fix', 'nothing left to change after the safety checks');
  return draft;
}

/**
 * Whether planRepair could build a plan for this cause and these devices right now (same drafts, same
 * safety rules, nothing changed). A verdict or an explanation offers a fix only when this holds, so "Want me
 * to fix that?" is never followed by "I can't fix that one by myself."
 */
export async function canRepair(cause: DiagnosisCauseId, entityIds: readonly EntityId[], deps: EngineDeps, house?: HouseView): Promise<boolean> {
  if (!isAutomatic(cause)) return false;
  try {
    await draftFor({ cause, entityIds: [...entityIds], ids: {} }, house ?? houseView(await deps.adapter.listEntities()), deps);
    return true;
  } catch (err) {
    if (isEngineError(err)) return false;
    throw err;
  }
}

/** Builds a dry run for a finished diagnosis, a checkup finding or an explanation's suggested fix. */
export async function planRepair(source: RepairSource, deps: EngineDeps): Promise<PlanResult> {
  const target = targetOf(source);
  const house = houseView(await deps.adapter.listEntities());
  const draft = await draftFor(target, house, deps);

  const nowMs = deps.clock.nowMs();
  const planId = newId('pln', deps.clock, deps.rng);
  const steps: PlanStep[] = draft.steps.map((s, i) => ({ ...s, step: i + 1, idempotency_key: `${planId}:${i + 1}` }));
  const plan: RepairPlan = {
    type: 'plan',
    version: 1,
    plan_id: planId,
    created_at: iso(nowMs),
    expires_at: iso(nowMs + PLAN_TTL_MS),
    confirm_token: confirmToken(deps),
    source: target.ids,
    cause_id: target.cause,
    steps,
    diff: draft.diff,
    diff_lines: draft.diffLines,
    protected_conflicts: [...new Set(draft.conflicts)],
    follow_up: draft.followUp,
    verify: draft.verify,
    undoable: steps.every((s) => s.inverse !== null || s.op.kind === 'flash_check' || s.op.kind === 'reload_integration'),
  };
  const output: RepairPlanOutput = {
    speech: speechSafe([phrase('pl_intro', {}), ...plan.diff_lines, ...plan.protected_conflicts, phrase('pl_confirm', {})].join(' ')),
    status: 'needs_confirmation',
    view: 'stepper',
    ids: { ...target.ids, plan_id: planId },
    source: sourceOf(deps.adapter),
    plan_id: planId,
    confirm_token: plan.confirm_token,
    expires_at: plan.expires_at,
    diff: plan.diff.map((d) => ({ ...d })),
    diff_lines: [...plan.diff_lines],
    steps: steps.map((s) => ({ step: s.step, label: s.label, status: 'pending' as const })),
    protected_conflicts: [...plan.protected_conflicts],
  };
  return { plan, output };
}
