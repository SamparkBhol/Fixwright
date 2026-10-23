// Diagnosis: rank single fault causes with Bayes, run every applicable passive probe,
// then pick active and human probes by expected information gain per unit of disruption and cost, ask the
// person when no sensor can answer, and stop at 0.9 with a verdict whose every claim cites the ledger.
// Sessions are plain JSON: startDiagnosis returns one, answerDiagnosis takes it back.

import {
  CAUSE_LABELS,
  CONFIRM_THRESHOLD,
  newId,
  parseYesNo,
  speechSafe,
  type CauseId,
  type DiagnoseAnswerInput,
  type DiagnoseInput,
  type DiagnoseOutput,
  type DiagnosisCauseId,
  type Entity,
  type Hypothesis,
  type ProbeResult,
  type Verdict,
} from '@fixwright/protocol';
import {
  DEFAULT_RELIABILITY,
  updateHumanReliability,
  answerLikelihood,
  bayesUpdate,
  expectedInfoGain,
  normalize,
  floor3,
  jointLikelihood,
  jointValues,
  ranked,
  residualLikelihood,
  UNKNOWN,
  type Dist,
  type LikelihoodFn,
} from './bayes.ts';
import { causeDef, isAutomatic, priorFor } from './causes.ts';
import { checkClaims, checkVerdict, phraseLines } from './claims.ts';
import { clone, houseWords, sourceOf } from './common.ts';
import { engineError } from './errors.ts';
import { planGuidedCheck } from './followup.ts';
import { houseView, isUnavailable, powerOnSelect, previousOption, SWITCHABLE_DOMAINS, type HouseView } from './house.ts';
import { syncHomeEvents } from './ledger.ts';
import { BATTERY_SPOKEN, CAUSE_SPOKEN, phrase } from './phrase.ts';
import { canRepair } from './planner.ts';
import { batteryOf, canFlash, describeFlash, flashEntity, PROBE_BY_ID, PROBES, probeDef, row, type ProbeContext, type ProbeDef } from './probes.ts';
import { classifySymptom, resolveTarget } from './target.ts';
import type { CheckedClaim, DiagnosisSession, EngineDeps, GuidedCheck, HumanReliability, HypothesisId, Observation, PendingQuestion } from './types.ts';
import { deviceNoun, integrationName, lowerName } from './util/text.ts';
import { DAY_MS, inQuietHours, iso, localDayStart, monthDay, sincePhrase } from './util/time.ts';

/** Below this many bits a probe is not worth its cost. */
export const MIN_GAIN = 0.01;
/** Questions per diagnosis, not counting permission to flash during quiet hours. */
export const MAX_QUESTIONS = 3;
/** Verdicts between this and CONFIRM_THRESHOLD are 'likely'; below it, 'cant_tell'. */
export const LIKELY_THRESHOLD = 0.6;
/**
 * A cause is named (likely or confirmed) only when it fits the complaint at least this well (its symptom
 * weight): an old copy is a real fault, but it cannot switch a lamp on by itself.
 */
export const FIT_MIN = 0.2;
/**
 * A sensor reading that came out clean (its probe passed) and is this unlikely under a cause rules the cause
 * out ("Every device Night Lights uses still exists." cannot be followed by "most likely an automation using
 * a removed device"). A failed reading never rules a cause out: it shows some fault, and a house can have two.
 */
export const RULED_OUT_LIKELIHOOD = 0.05;
/**
 * A failed reading at least this likely under a fault that cannot cause the complaint is put down to that
 * fault, and set aside with it when looking for a second fault that can (an old copy and a lamp
 * set to switch on when power comes back).
 */
export const EXPLAINED_LIKELIHOOD = 0.5;
/** A can't tell line names a cause only when it holds at least this much of the posterior. */
export const NAME_FLOOR = 0.1;
const EVENT_HISTORY_MS = 45 * DAY_MS;

export interface DiagnosisResult {
  session: DiagnosisSession;
  output: DiagnoseOutput;
}

interface Turn extends ProbeContext {
  /** A flash ran in this call, so the person can be asked about it now. */
  freshFlash: number[] | null;
  /** Lines to say before the question or verdict. */
  lead: CheckedClaim[];
  /** Checked lines to say after the verdict's claims (a real fault that does not explain the complaint). */
  aside: CheckedClaim[];
}

/** Probe score: information gain / (1 + 2 * disruption + cost_ms / 2000). */
export const probeScore = (gain: number, def: Pick<ProbeDef, 'disruption' | 'costMs'>): number =>
  gain / (1 + 2 * def.disruption + def.costMs / 2000);

function sensorLikelihood(def: ProbeDef, causes: readonly HypothesisId[]): LikelihoodFn {
  const rows = causes.filter((c) => c !== UNKNOWN).map((c) => row(def.table, c));
  const own = def.table.unknown;
  return (h, v) => (h === UNKNOWN ? (own?.[v] ?? residualLikelihood(rows, def.values, v)) : (row(def.table, h)[v] ?? 0));
}

function humanLikelihood(def: ProbeDef, session: DiagnosisSession): LikelihoodFn {
  const yes = def.human?.yes ?? '';
  const fact = sensorLikelihood(def, session.causes);
  return (h, said) => answerLikelihood(fact(h, yes), said === 'yes' ? 'yes' : 'no', session.reliability);
}

const gainOf = (def: ProbeDef, s: DiagnosisSession): number =>
  def.kind === 'human'
    ? expectedInfoGain(s.posterior, ['yes', 'no'], humanLikelihood(def, s))
    : expectedInfoGain(s.posterior, def.values, sensorLikelihood(def, s.causes));

async function loadTurn(session: DiagnosisSession, deps: EngineDeps, house: HouseView): Promise<Turn> {
  const nowMs = deps.clock.nowMs();
  const get = (id: string | undefined): Entity | undefined => (id === undefined ? undefined : house.byId.get(id));
  const primary = get(session.entities.primary);
  const twins = session.entities.twins.map(get).filter((e): e is Entity => e !== undefined);
  const dut = get(session.entities.dut);
  const group = [primary, ...twins].filter((e): e is Entity => e !== undefined);
  const oldest = Math.min(nowMs - DAY_MS, ...group.map((e) => Date.parse(e.lastChanged)));
  const events =
    group.length === 0
      ? []
      : await syncHomeEvents(deps, {
          since: iso(Math.max(oldest - 60_000, nowMs - EVENT_HISTORY_MS)),
          until: iso(nowMs),
          entityIds: group.map((e) => e.entityId),
        });
  const spoken = lowerName(session.target.name);
  // Guided mode has no entity, so the noun comes from the person's own words ("bathroom fan" gives "fan").
  const noun = primary ? deviceNoun(primary) : deviceNoun({ name: session.target.name, domain: '' });
  // A battery device loses power by its battery going flat, not at a wall switch.
  const battery = await batteryOf(dut ?? primary, deps, house);
  return {
    deps,
    house,
    session,
    ...(primary ? { primary } : {}),
    ...(dut ? { dut } : {}),
    twins,
    events,
    nowMs,
    spoken,
    noun,
    ...(battery ? { battery } : {}),
    freshFlash: null,
    lead: [],
    aside: [],
  };
}

function recordResult(t: Turn, result: ProbeResult, obs: Observation): void {
  t.session.probes.push(result);
  t.session.observations.push(obs);
}

async function runProbe(t: Turn, def: ProbeDef): Promise<Observation> {
  if (!def.run) throw new Error(`probe ${def.id} cannot run by itself`);
  const s = t.session;
  const reading = await def.run(t);
  const at = t.deps.clock.now();
  const outcome = reading.value === null ? 'unknown' : (def.outcome[reading.value] ?? 'unknown');
  const seq = await t.deps.ledger.append({
    ts: at,
    kind: 'probe',
    ...(reading.entityIds[0] !== undefined ? { entityId: reading.entityIds[0] } : {}),
    source: 'fixwright',
    data: { ...reading.data, probe_id: def.id, value: reading.value, outcome, diagnosis_id: s.diagnosis_id, entity_ids: reading.entityIds },
  });
  const evidence = [...new Set([...reading.homeEvidence, seq])].sort((a, b) => a - b);
  const obs: Observation = { probe_id: def.id, value: reading.value, outcome, evidence, at, data: reading.data };
  recordResult(
    t,
    { probe_id: def.id, label: reading.label ?? def.label, outcome, detail: reading.detail, evidence, disruptive: def.disruption > 0, at },
    obs,
  );
  if (reading.value !== null) s.posterior = bayesUpdate(s.posterior, reading.value, sensorLikelihood(def, s.causes));
  if (def.id === 'flash_test') t.freshFlash = [seq];
  return obs;
}

const ran = (s: DiagnosisSession, id: string): boolean => s.observations.some((o) => o.probe_id === id);

function topOf(s: DiagnosisSession): [string, number] {
  return ranked(s.posterior)[0] ?? [UNKNOWN, 1];
}

function quiet(t: Turn): boolean {
  return inQuietHours(t.nowMs, t.deps.settings.tz, t.deps.settings.quietHours);
}

/** Best active probe by score, looking one question ahead for probes that enable one (flash, then ask). */
function pickActive(t: Turn): ProbeDef | undefined {
  const s = t.session;
  let best: { def: ProbeDef; score: number } | undefined;
  for (const def of PROBES) {
    if (def.kind !== 'active' || ran(s, def.id) || !def.applies(t)) continue;
    if (def.disruption > 0 && s.consent.disruptive === 'declined') continue;
    let gain = gainOf(def, s);
    for (const h of PROBES) {
      if (h.kind !== 'human' || h.human?.needsFresh !== def.id || ran(s, h.id) || !h.applies(t)) continue;
      const joint = jointLikelihood(sensorLikelihood(def, s.causes), humanLikelihood(h, s));
      gain = Math.max(gain, expectedInfoGain(s.posterior, jointValues(def.values, ['yes', 'no']), joint));
    }
    if (gain < MIN_GAIN) continue;
    const score = probeScore(gain, def);
    if (!best || score > best.score) best = { def, score };
  }
  return best?.def;
}

function pickHuman(t: Turn): ProbeDef | undefined {
  const s = t.session;
  if (s.questions_asked >= MAX_QUESTIONS) return undefined;
  let best: { def: ProbeDef; score: number } | undefined;
  for (const def of PROBES) {
    if (def.kind !== 'human' || ran(s, def.id) || !def.applies(t)) continue;
    if (def.human?.needsFresh !== undefined && t.freshFlash === null) continue;
    const gain = gainOf(def, s);
    if (gain < MIN_GAIN) continue;
    const score = probeScore(gain, def);
    if (!best || score > best.score) best = { def, score };
  }
  return best?.def;
}

function ask(t: Turn, def: ProbeDef, kind: PendingQuestion['kind']): void {
  const s = t.session;
  const id = newId('q', t.deps.clock, t.deps.rng);
  const flash = t.freshFlash ?? [];
  const lastFlash = [...s.observations].reverse().find((o) => o.probe_id === 'flash_test');
  if (kind === 'consent') {
    s.pending = {
      question_id: id,
      probe_id: def.id,
      kind,
      text: phrase('dx_ask_consent', { name: t.spoken }),
      clearer: phrase('dx_reask_consent', { name: t.spoken }),
      asked_at: t.deps.clock.now(),
      reasked: false,
      evidence: [],
    };
  } else {
    const q = def.human?.question(t) ?? { text: '', clearer: '' };
    const action = def.human?.needsFresh !== undefined ? lastFlash?.data['action'] : undefined;
    s.pending = {
      question_id: id,
      probe_id: def.id,
      kind,
      text: q.text,
      clearer: q.clearer,
      asked_at: t.deps.clock.now(),
      reasked: false,
      evidence: def.human?.needsFresh !== undefined ? flash : [],
      ...(typeof action === 'string' ? { action_performed: action } : {}),
    };
    s.questions_asked += 1;
  }
  s.status = 'needs_answer';
}

/** Runs probes until the diagnosis needs an answer or reaches a verdict. */
async function advance(t: Turn): Promise<void> {
  const s = t.session;
  if (!s.passive_done) {
    let pending = PROBES.filter((p) => p.kind === 'passive' && !ran(s, p.id) && p.applies(t));
    while (pending.length > 0) {
      const next = pending.map((def) => ({ def, score: probeScore(gainOf(def, s), def) })).sort((a, b) => b.score - a.score)[0];
      if (!next) break;
      await runProbe(t, next.def);
      pending = pending.filter((p) => p !== next.def);
    }
    s.passive_done = true;
  }
  for (;;) {
    if (topOf(s)[1] >= CONFIRM_THRESHOLD) return finish(t);
    const active = pickActive(t);
    if (active) {
      if (active.disruption > 0 && quiet(t) && s.consent.disruptive !== 'granted') return ask(t, active, 'consent');
      await runProbe(t, active);
      continue;
    }
    const human = pickHuman(t);
    if (human) return ask(t, human, 'observe');
    return finish(t);
  }
}

const latest = (s: DiagnosisSession, id: string): Observation | undefined =>
  [...s.observations].reverse().find((o) => o.probe_id === id && o.value !== null);

const ev = (...obs: (Observation | undefined)[]): number[] =>
  [...new Set(obs.flatMap((o) => o?.evidence ?? []))].sort((a, b) => a - b);

const values = (probe_id: string, ...v: string[]) => ({ probe_id, values: v });

function claimsFor(cause: DiagnosisCauseId, t: Turn): CheckedClaim[] {
  const s = t.session;
  const tz = t.deps.settings.tz;
  const p = t.primary;
  const group = s.entities.group;
  const out: CheckedClaim[] = [];
  const fact = (text: string, evidence: number[], support: CheckedClaim['support']): void => {
    if (evidence.length > 0) out.push({ text, evidence, kind: 'fact', ...(support ? { support } : {}) });
  };
  const avail = latest(s, 'entity_availability');
  const flash = latest(s, 'flash_test');
  const seen = latest(s, 'confirm_flash');
  switch (cause) {
    case 'stale_duplicate': {
      const dut = s.entities.dut ?? s.entities.primary;
      if (seen?.value === 'seen') {
        fact(phrase('claim_works', { noun: t.noun }), ev(flash, seen), {
          ...(dut ? { entityIds: [dut] } : {}),
          probeValues: [values('confirm_flash', 'seen')],
        });
      } else if (flash?.value === 'answered') {
        fact(phrase('claim_online_answers', { noun: t.noun }), ev(flash), {
          ...(dut ? { entityIds: [dut] } : {}),
          probeValues: [values('flash_test', 'answered')],
        });
      }
      const dup = latest(s, 'duplicate_name_scan');
      const reg = latest(s, 'registry_scan');
      const offlineMs = p && isUnavailable(p) ? Date.parse(p.lastChanged) : NaN;
      const support = {
        entityIds: group,
        probeValues: [values('duplicate_name_scan', 'stale_pair', 'twin_online', 'twin_offline'), values('entity_availability', 'offline', 'flapping')],
      };
      if (Number.isFinite(offlineMs)) {
        fact(phrase('claim_stale', { name: s.target.name, date: monthDay(offlineMs, tz) }), ev(avail, dup, reg), {
          ...support,
          window: { since: iso(localDayStart(offlineMs, tz)), until: iso(localDayStart(offlineMs, tz, 1) - 1) },
        });
      } else {
        fact(phrase('claim_stale_nodate', { name: s.target.name }), ev(avail, dup, reg), support);
      }
      break;
    }
    case 'device_power_lost': {
      // With copies, the person looked at the copy that answers. The old copy has been offline since the lamp
      // was paired again, which says nothing about this power cut, so it is only claimed when it is
      // the device under test.
      const testedOther = p !== undefined && s.entities.dut !== undefined && s.entities.dut !== p.entityId;
      if (seen?.value === 'not_seen') {
        const dut = s.entities.dut ?? s.entities.primary;
        fact(phrase('claim_no_blink', { name: t.spoken }), ev(flash, seen), {
          ...(dut ? { entityIds: [dut] } : {}),
          probeValues: [values('confirm_flash', 'not_seen')],
        });
      }
      if (p && avail?.value === 'offline' && !testedOther) {
        const since = Date.parse(p.lastChanged);
        fact(phrase('claim_offline_since', { name: t.spoken, since: sincePhrase(since, t.nowMs, tz) }), ev(avail), {
          entityIds: [p.entityId],
          window: { since: iso(since - 60_000), until: iso(since + 60_000) },
          probeValues: [values('entity_availability', 'offline')],
        });
      }
      const battery = latest(s, 'battery_level');
      if (battery?.value === 'low') {
        const dut = s.entities.dut ?? s.entities.primary;
        fact(phrase('claim_battery_low', { name: t.spoken, pct: Number(battery.data['battery_pct']) }), ev(battery), {
          ...(dut ? { entityIds: [dut] } : {}),
          probeValues: [values('battery_level', 'low')],
        });
      }
      const sw = latest(s, 'power_switch_check');
      if (sw?.value === 'off') {
        fact(phrase('claim_switch_off', out.length > 0 ? {} : { name: t.spoken }), ev(sw), { probeValues: [values('power_switch_check', 'off')] });
      }
      const hub = latest(s, 'hub_reachable');
      const link = latest(s, 'link_quality');
      if (hub?.value === 'up' && link?.value === 'good') {
        fact(phrase('claim_infra_fine', {}), ev(hub, link), { probeValues: [values('hub_reachable', 'up'), values('link_quality', 'good')] });
      }
      break;
    }
    case 'radio_link_weak': {
      if (p && avail?.value === 'flapping') {
        fact(phrase('claim_flaps', { name: t.spoken, count: Number(avail.data['flaps']) }), ev(avail), {
          entityIds: [p.entityId],
          probeValues: [values('entity_availability', 'flapping')],
        });
      }
      const link = latest(s, 'link_quality');
      if (link?.value === 'weak') {
        const rssi = link.data['rssi'];
        const lqi = link.data['link_quality'];
        const text = typeof rssi === 'number' ? phrase('claim_weak_wifi', { dbm: rssi }) : phrase('claim_weak_zigbee', { lqi: Number(lqi) });
        fact(text, ev(link), { probeValues: [values('link_quality', 'weak')] });
      }
      break;
    }
    case 'hub_down': {
      const hub = latest(s, 'hub_reachable');
      if (hub?.value === 'down') {
        fact(phrase('claim_hub_down', { hub: String(hub.data['hub']) }), ev(hub), { probeValues: [values('hub_reachable', 'down')] });
        const n = Number(hub.data['offline']);
        if (n > 0) fact(phrase('claim_hub_devices', { count: n }), ev(hub), { probeValues: [values('hub_reachable', 'down')] });
      }
      break;
    }
    case 'vendor_cloud_outage': {
      const cloud = latest(s, 'cloud_status');
      if (cloud?.value === 'problem') {
        fact(phrase('claim_cloud', { brand: String(cloud.data['brand']) }), ev(cloud), { probeValues: [values('cloud_status', 'problem')] });
      }
      break;
    }
    case 'account_link_expired': {
      const integ = latest(s, 'integration_state');
      if (integ?.value === 'auth_error' && p) {
        fact(phrase('claim_auth', { brand: integrationName(p.integration) }), ev(integ), { probeValues: [values('integration_state', 'auth_error')] });
      }
      break;
    }
    case 'power_on_default_on': {
      const pos = latest(s, 'power_on_setting');
      if (pos?.value === 'on') fact(phrase('claim_power_on', { name: t.spoken }), ev(pos), { probeValues: [values('power_on_setting', 'on')] });
      break;
    }
    case 'name_collision': {
      const dup = latest(s, 'duplicate_name_scan');
      if (dup && dup.value !== 'unique') {
        fact(phrase('claim_collision', { name: s.target.name, count: group.length }), ev(dup), {
          entityIds: group,
          probeValues: [values('duplicate_name_scan', 'stale_pair', 'twin_online', 'twin_offline')],
        });
        if (dup.value === 'twin_online' && avail?.value === 'online') {
          fact(phrase('claim_collision_online', { count: group.length }), ev(dup, avail), {
            entityIds: group,
            probeValues: [values('entity_availability', 'online')],
          });
        }
      }
      break;
    }
    case 'dead_trigger': {
      const reg = latest(s, 'registry_scan');
      if (reg?.value === 'orphan_ref' && p) {
        fact(phrase('claim_dead_trigger', { name: p.name }), ev(reg), { entityIds: [p.entityId], probeValues: [values('registry_scan', 'orphan_ref')] });
      }
      break;
    }
    case 'wifi_network_changed': {
      const peers = latest(s, 'wifi_peers');
      const offline = Array.isArray(peers?.data['offline']) ? (peers?.data['offline'] as unknown[]).length : 0;
      if (peers?.value === 'peers_offline') fact(phrase('claim_wifi_peers', { count: offline }), ev(peers), { probeValues: [values('wifi_peers', 'peers_offline')] });
      const router = latest(s, 'router_changed');
      if (router?.value === 'changed') fact(phrase('claim_router_changed', {}), ev(router), { probeValues: [values('router_changed', 'changed')] });
      break;
    }
  }
  return out;
}

/** What would settle an unconfirmed diagnosis: the most informative probe we could not use. */
function settleLine(t: Turn): string {
  const s = t.session;
  let best: { def: ProbeDef; gain: number } | undefined;
  for (const def of PROBES) {
    if (def.kind === 'passive' || ran(s, def.id) || !def.applies(t)) continue;
    const gain = gainOf(def, s);
    if (gain >= MIN_GAIN && (!best || gain > best.gain)) best = { def, gain };
  }
  if (!best) return phrase('dx_settle_generic', {});
  if (best.def.id === 'flash_test') return phrase('dx_settle_flash', {});
  return phrase(best.def.human?.settle ?? 'dx_settle_generic', {});
}

function hypothesesOf(s: DiagnosisSession): Hypothesis[] {
  return ranked(s.posterior)
    .slice(0, 3)
    .map(([id, p]) => ({ cause_id: id as CauseId, label: CAUSE_LABELS[id as CauseId].label, p: floor3(p) }));
}

/**
 * Does a claim rest on an observed fault: a probe or answer of this diagnosis that came out 'fail' (the
 * device offline, a weak signal, the wall switch off, the setting on)? Lines such as "The lamp works." or
 * "Your hub and its signal look fine." are true but only rule other causes out.
 */
function showsFault(c: CheckedClaim): boolean {
  if (c.kind !== 'fact') return false;
  return (c.support?.probeValues ?? []).some((pv) => pv.values.length > 0 && pv.values.every((v) => probeDef(pv.probe_id).outcome[v] === 'fail'));
}

/** For a verdict that names no cause: the device answered (and the person saw it) when tested just now. */
async function worksNow(t: Turn, words: string[]): Promise<CheckedClaim | undefined> {
  const s = t.session;
  const dut = s.entities.dut ?? s.entities.primary;
  const flash = latest(s, 'flash_test');
  const seen = latest(s, 'confirm_flash');
  if (dut === undefined || flash?.value !== 'answered' || seen?.value === 'not_seen') return undefined;
  const claim: CheckedClaim =
    seen?.value === 'seen'
      ? {
          text: phrase('claim_worked_now', { name: t.spoken }),
          evidence: ev(flash, seen),
          kind: 'fact',
          support: { entityIds: [dut], probeValues: [values('flash_test', 'answered'), values('confirm_flash', 'seen')] },
        }
      : {
          text: phrase('claim_answered_now', { name: t.spoken }),
          evidence: ev(flash),
          kind: 'fact',
          support: { entityIds: [dut], probeValues: [values('flash_test', 'answered')] },
        };
  return (await checkClaims([claim], t.deps.ledger, { houseWords: words })).kept[0];
}

/** Does the cause fit what the person described well enough to be named? The catch all always fits. */
const fits = (s: DiagnosisSession, id: HypothesisId): boolean =>
  id === UNKNOWN || causeDef(id as DiagnosisCauseId).symptom[s.symptom_class] >= FIT_MIN;

/**
 * The probes that test each cause directly: the sensor reading, and for some causes the question that
 * settles it. Only these decide whether a cause is ruled out or shown: the tables are single fault, so
 * another probe's row (an old copy's offline reading under a power on setting, say) says nothing about a
 * second fault in the same house.
 */
const DEFINING_PROBES: Readonly<Record<DiagnosisCauseId, readonly string[]>> = {
  stale_duplicate: ['duplicate_name_scan'],
  name_collision: ['duplicate_name_scan'],
  device_power_lost: ['entity_availability', 'battery_level', 'power_switch_check'],
  radio_link_weak: ['link_quality'],
  hub_down: ['hub_reachable'],
  vendor_cloud_outage: ['cloud_status'],
  account_link_expired: ['integration_state'],
  power_on_default_on: ['power_on_setting'],
  dead_trigger: ['registry_scan'],
  wifi_network_changed: ['wifi_peers', 'router_changed'],
};

/** The latest reading of each of the cause's own probes. */
function ownReadings(s: DiagnosisSession, id: HypothesisId): Observation[] {
  if (id === UNKNOWN) return [];
  return (DEFINING_PROBES[id as DiagnosisCauseId] ?? []).map((p) => latest(s, p)).filter((o): o is Observation => o !== undefined);
}

/** Did one of the cause's own probes fail? Then the house shows that fault, whatever the other probes say. */
const ownProbeFailed = (s: DiagnosisSession, id: HypothesisId): boolean => ownReadings(s, id).some((o) => o.outcome === 'fail');

/**
 * Has one of the cause's own sensor probes come out clean, at a reading all but impossible under it, with
 * none of its own probes failing? A person's answer never rules a cause out, and neither does another
 * probe's reading.
 */
function ruledOut(s: DiagnosisSession, id: HypothesisId): boolean {
  const own = ownReadings(s, id);
  if (own.some((o) => o.outcome === 'fail')) return false;
  return own.some((o) => {
    const def = PROBE_BY_ID.get(o.probe_id);
    if (def === undefined || def.kind === 'human' || o.value === null || def.outcome[o.value] !== 'pass') return false;
    return (row(def.table, id)[o.value] ?? 1) <= RULED_OUT_LIKELIHOOD;
  });
}

/** The causes a can't tell line may still name, most probable first: they fit the complaint and no sensor ruled them out. */
const openCauses = (s: DiagnosisSession): [HypothesisId, number][] =>
  (ranked(s.posterior) as [HypothesisId, number][]).filter(([id]) => fits(s, id) && !ruledOut(s, id));

/**
 * The posterior with one fault set aside, together with the failed readings it accounts for: what is left
 * to explain the complaint once that fault is known to be there too.
 */
function withoutFault(s: DiagnosisSession, aside: HypothesisId): Dist {
  const causes = s.causes.filter((c) => c !== aside);
  const rest: DiagnosisSession = { ...s, causes };
  let d = normalize(Object.fromEntries(causes.map((c) => [c, s.prior[c] ?? 0])));
  for (const o of s.observations) {
    const def = PROBE_BY_ID.get(o.probe_id);
    if (def === undefined || o.value === null) continue;
    if (def.kind === 'human') {
      if (o.answer === undefined) continue;
      if (o.outcome === 'fail' && humanLikelihood(def, s)(aside, o.answer.said) >= EXPLAINED_LIKELIHOOD) continue;
      d = bayesUpdate(d, o.answer.said, humanLikelihood(def, rest));
    } else {
      if (o.outcome === 'fail' && (row(def.table, aside)[o.value] ?? 0) >= EXPLAINED_LIKELIHOOD) continue;
      d = bayesUpdate(d, o.value, sensorLikelihood(def, causes));
    }
  }
  return d;
}

/**
 * Once a fault that cannot cause the complaint is set aside: a second fault that can, named only when it
 * clears the likely bar on what is left and one of its own probes failed. Its confidence is that
 * posterior (what is left to explain the complaint), not the single fault one.
 */
async function otherFault(t: Turn, aside: HypothesisId, words: string[]): Promise<Verdict | undefined> {
  const s = t.session;
  const [id, p] = (ranked(withoutFault(s, aside))[0] ?? [UNKNOWN, 0]) as [HypothesisId, number];
  if (id === UNKNOWN || p < LIKELY_THRESHOLD || !fits(s, id) || ruledOut(s, id) || !ownProbeFailed(s, id)) return undefined;
  const base: Verdict = {
    level: p >= CONFIRM_THRESHOLD ? 'confirmed' : 'likely',
    cause_id: id as CauseId,
    label: CAUSE_LABELS[id as CauseId].label,
    confidence: floor3(p),
    claims: [],
    fix_available: false,
  };
  const checked = await checkVerdict(base, claimsFor(id as DiagnosisCauseId, t), t.deps.ledger, { houseWords: words });
  return checked.kept.some(showsFault) ? checked.verdict : undefined;
}

/** A can't tell verdict for a fault that does not fit the complaint: it names the best cause that would. */
function unfitVerdict(s: DiagnosisSession): Verdict {
  const [id, p] = openCauses(s)[0] ?? [UNKNOWN, s.posterior[UNKNOWN] ?? 0];
  return { level: 'cant_tell', cause_id: id as CauseId, label: CAUSE_LABELS[id as CauseId].label, confidence: floor3(p), claims: [], fix_available: false };
}

/** "I did find an old copy of the device, but that wouldn't switch it on by itself." Cites the fault's own evidence. */
async function asideFor(t: Turn, cause: DiagnosisCauseId, fault: CheckedClaim, words: string[], also: boolean): Promise<CheckedClaim | undefined> {
  const claim: CheckedClaim = {
    text: phrase('dx_unrelated_fault', { cause: spokenCause(t, cause), complaint: t.session.symptom_class, also }),
    evidence: [...fault.evidence],
    kind: 'fact',
    ...(fault.support ? { support: fault.support } : {}),
  };
  return (await checkClaims([claim], t.deps.ledger, { houseWords: words })).kept[0];
}

/** For an automation that still has every device it uses: say so, so a can't tell does not sound like nothing was checked. */
async function checkedOk(t: Turn, words: string[]): Promise<CheckedClaim | undefined> {
  const reg = latest(t.session, 'registry_scan');
  if (t.primary?.domain !== 'automation' || reg?.value !== 'provided') return undefined;
  const claim: CheckedClaim = {
    text: phrase('claim_refs_ok', { name: t.primary.name }),
    evidence: ev(reg),
    kind: 'fact',
    support: { entityIds: [t.primary.entityId], probeValues: [values('registry_scan', 'provided')] },
  };
  return (await checkClaims([claim], t.deps.ledger, { houseWords: words })).kept[0];
}

/** How a cause is said inside a sentence; a power problem on a battery device with a low reading is its battery. */
function spokenCause(t: Turn, id: string): string {
  if (id === 'device_power_lost' && latest(t.session, 'battery_level')?.value === 'low') return BATTERY_SPOKEN;
  return CAUSE_SPOKEN[id] ?? CAUSE_SPOKEN[UNKNOWN] ?? '';
}

/**
 * Turns the posterior into a verdict. A cause is named (likely or confirmed) only when at
 * least one claim that survives the checker shows a fault pointing at it. Otherwise the top cause is just
 * what the others left over (the device worked when tested and nothing else is wrong), so the verdict is
 * can't tell, saying what was seen and what would settle it. A fix is offered only when the
 * planner can really build one.
 */
async function finish(t: Turn): Promise<void> {
  const s = t.session;
  const [topId, topP] = topOf(s);
  const level: Verdict['level'] = topId === UNKNOWN ? 'cant_tell' : topP >= CONFIRM_THRESHOLD ? 'confirmed' : topP >= LIKELY_THRESHOLD ? 'likely' : 'cant_tell';
  const cause = topId as DiagnosisCauseId;
  const words = houseWords(t.house);
  const base: Verdict = {
    level,
    cause_id: topId as CauseId,
    label: CAUSE_LABELS[topId as CauseId].label,
    confidence: floor3(topP),
    claims: [],
    fix_available: false,
  };
  let verdict = base;
  let unfit = false;
  if (level !== 'cant_tell') {
    const checked = await checkVerdict(base, claimsFor(cause, t), t.deps.ledger, { houseWords: words });
    const fault = checked.kept.find(showsFault);
    if (fault === undefined) verdict = { ...base, level: 'cant_tell' };
    else if (fits(s, topId as HypothesisId)) verdict = checked.verdict;
    else {
      // A real fault, but not one that explains the complaint: say what was found, and that it is not the
      // answer. A second fault that does explain it is named instead, when its own reading shows it.
      const other = await otherFault(t, topId as HypothesisId, words);
      verdict = other ?? unfitVerdict(s);
      unfit = true;
      const aside = await asideFor(t, cause, fault, words, other !== undefined);
      if (aside) t.aside.push(aside);
    }
  } else if (topId !== UNKNOWN && !fits(s, topId as HypothesisId)) {
    // Below the likely bar, and the best single fault could not cause the complaint anyway. When a reading
    // shows that fault is there, a second fault that can cause it is still named on its own failed probe
    // (for example an old copy or a power problem on top, below the bar, and a power on setting set to on).
    const checked = await checkVerdict({ ...base, level: 'likely' }, claimsFor(cause, t), t.deps.ledger, { houseWords: words });
    const fault = checked.kept.find(showsFault);
    const other = fault ? await otherFault(t, topId as HypothesisId, words) : undefined;
    if (fault && other) {
      verdict = other;
      unfit = true;
      const aside = await asideFor(t, cause, fault, words, true);
      if (aside) t.aside.push(aside);
    }
  }
  let works: CheckedClaim | undefined;
  if (verdict.level === 'cant_tell') {
    // A can't tell verdict shows the best cause still open: never one a sensor ruled out (a dead
    // trigger with every device present) or one that cannot cause the complaint.
    const shown = verdict.cause_id as HypothesisId;
    if (ruledOut(s, shown) || !fits(s, shown)) verdict = unfitVerdict(s);
    works = await worksNow(t, words);
    if (works) verdict = { ...verdict, claims: [{ text: works.text, evidence: [...works.evidence] }] };
    else {
      const checked = await checkedOk(t, words);
      if (checked) verdict = { ...verdict, claims: [{ text: checked.text, evidence: [...checked.evidence] }] };
    }
  } else if (isAutomatic(verdict.cause_id)) {
    verdict = { ...verdict, fix_available: await canRepair(verdict.cause_id as DiagnosisCauseId, s.entities.group, t.deps, t.house) };
  }
  s.verdict = verdict;
  s.status = 'ok';
  delete s.pending;
  delete s.settle;
  // When it works now, testing anything else would not explain what happened before.
  if (verdict.level !== 'confirmed') s.settle = works || unfit ? phrase('dx_settle_generic', {}) : settleLine(t);
  delete s.guided_check;
  const named = verdict.cause_id as DiagnosisCauseId;
  const check = verdict.level === 'cant_tell' || verdict.fix_available || verdict.cause_id === UNKNOWN ? undefined : guidedCheckOf(t, named);
  if (check) s.guided_check = check;
}

/** The follow up check that tells whether the person's (or the vendor's) fix worked, when a sensor can tell. */
function guidedCheckOf(t: Turn, cause: DiagnosisCauseId): GuidedCheck | undefined {
  const s = t.session;
  const named = t.dut ?? t.primary;
  const subject = cause === 'radio_link_weak' || cause === 'account_link_expired' || cause === 'wifi_network_changed' ? t.primary : named;
  const peers: Entity[] = [];
  if (cause === 'device_power_lost' && t.primary && t.primary !== named) peers.push(t.primary);
  if (cause === 'wifi_network_changed') {
    const offline = latest(s, 'wifi_peers')?.data['offline'];
    for (const id of Array.isArray(offline) ? offline : []) {
      const e = typeof id === 'string' ? t.house.byId.get(id) : undefined;
      if (e) peers.push(e);
    }
  }
  const flaps = Number(latest(s, 'entity_availability')?.data['flaps']);
  const cloudBrand = latest(s, 'cloud_status')?.data['brand'];
  return planGuidedCheck({
    cause,
    diagnosisId: s.diagnosis_id,
    name: t.spoken,
    ...(subject ? { subject } : {}),
    peers,
    ...(Number.isFinite(flaps) ? { baseline: flaps } : {}),
    ...(typeof cloudBrand === 'string' ? { brand: cloudBrand } : {}),
    nowMs: t.nowMs,
    tz: t.deps.settings.tz,
  });
}

function infraSummary(t: Turn, fromIndex: number): CheckedClaim | undefined {
  const s = t.session;
  const fresh = s.observations.slice(fromIndex);
  const parts: string[] = [];
  const evidence: number[] = [];
  const pv: { probe_id: string; values: string[] }[] = [];
  const hub = fresh.find((o) => o.probe_id === 'hub_reachable' && o.value === 'up');
  const link = fresh.find((o) => o.probe_id === 'link_quality' && o.value === 'good');
  const cloud = fresh.find((o) => o.probe_id === 'cloud_status' && o.value === 'ok');
  if (hub) parts.push('your hub is reachable'), evidence.push(...hub.evidence), pv.push(values('hub_reachable', 'up'));
  if (link) parts.push('the signal is good'), evidence.push(...link.evidence), pv.push(values('link_quality', 'good'));
  if (cloud) parts.push(`the ${String(cloud.data['brand'])} cloud is fine`), evidence.push(...cloud.evidence), pv.push(values('cloud_status', 'ok'));
  if (parts.length === 0) return undefined;
  return { text: phrase('dx_passive_summary', { parts }), evidence, kind: 'fact', support: { probeValues: pv } };
}

function verdictTail(t: Turn, v: Verdict): string[] {
  const s = t.session;
  if (v.level === 'cant_tell') {
    // The only claim a can't tell verdict carries is that the device works right now.
    if (v.claims.length > 0) return [phrase('dx_cant_tell_works', {}), s.settle ?? phrase('dx_settle_generic', {})];
    const top2 = openCauses(s)
      .filter(([, p]) => p >= NAME_FLOOR)
      .slice(0, 2)
      .map(([id]) => spokenCause(t, id));
    return [phrase('dx_cant_tell', { causes: top2 }), s.settle ?? phrase('dx_settle_generic', {})];
  }
  const tail: string[] = [];
  if (v.level === 'likely') tail.push(phrase('dx_likely', { cause: spokenCause(t, v.cause_id) }));
  if (v.fix_available) tail.push(phrase('dx_offer_fix', {}));
  else {
    const check = s.guided_check;
    const guidance = causeDef(v.cause_id as DiagnosisCauseId).repair.guidance?.({
      name: t.spoken,
      check: check !== undefined,
      count: check?.entity_ids.length ?? 1,
      battery: t.battery !== undefined,
      batteryLow: latest(s, 'battery_level')?.value === 'low',
    });
    if (guidance) tail.push(guidance);
  }
  return tail;
}

async function speak(t: Turn, observationsBefore: number): Promise<string> {
  const s = t.session;
  const words = houseWords(t.house);
  if (s.status === 'needs_answer' && s.pending) {
    const lines: CheckedClaim[] = [...t.lead];
    if (observationsBefore === 0) {
      const summary = infraSummary(t, 0);
      if (summary) {
        const { kept } = await checkClaims([summary], t.deps.ledger, { houseWords: words });
        lines.push(...kept);
      }
      if (s.target.guided && s.questions_asked === 1) lines.push({ text: phrase('dx_guided_intro', { name: t.spoken }), evidence: [], kind: 'framing' });
    }
    const said = await phraseLines(lines, t.deps.phraser, words);
    return speechSafe([...said, s.pending.text].join(' '));
  }
  const v = s.verdict;
  if (!v) return speechSafe(phrase('problem', { code: 'internal' }));
  const lines: CheckedClaim[] = [...t.lead, ...v.claims.map((c) => ({ text: c.text, evidence: c.evidence, kind: 'fact' as const })), ...t.aside];
  const said = await phraseLines(lines, t.deps.phraser, words);
  return speechSafe([...said, ...verdictTail(t, v)].join(' '));
}

function outputOf(t: Turn, speech: string): DiagnoseOutput {
  const s = t.session;
  s.hypotheses = hypothesesOf(s);
  s.updated_at = t.deps.clock.now();
  const base = {
    speech,
    view: 'stepper' as const,
    ids: { diagnosis_id: s.diagnosis_id },
    source: sourceOf(t.deps.adapter),
    diagnosis_id: s.diagnosis_id,
    target: { ...s.target },
    probes: s.probes.map((p) => ({ ...p, evidence: [...p.evidence] })),
    hypotheses: s.hypotheses.map((h) => ({ ...h })),
  };
  if (s.status === 'needs_answer' && s.pending) {
    const q = s.pending;
    return {
      ...base,
      status: 'needs_answer',
      question: {
        question_id: q.question_id,
        text: q.text,
        expects: 'yes_no',
        ...(q.action_performed !== undefined ? { action_performed: q.action_performed } : {}),
      },
    };
  }
  return { ...base, status: 'ok', ...(s.verdict ? { verdict: clone(s.verdict) } : {}) };
}

/**
 * Can the device's power on behaviour be read ('signal') or also set to previous ('select')? Without either,
 * power_on_default_on is not a hypothesis: nothing could test it or fix it.
 */
async function powerOnSupport(e: Entity, house: HouseView, deps: EngineDeps): Promise<'select' | 'signal' | undefined> {
  if (!SWITCHABLE_DOMAINS.has(e.domain)) return undefined;
  const select = powerOnSelect(e, house);
  if (select && previousOption(select) !== undefined) return 'select';
  if (select) return 'signal';
  return (await deps.adapter.signals(e.entityId)).powerOnBehavior !== undefined ? 'signal' : undefined;
}

/** Starts a diagnosis from the person's words. Returns the session to persist and the tool output. */
export async function startDiagnosis(input: DiagnoseInput, deps: EngineDeps): Promise<DiagnosisResult> {
  const house = houseView(await deps.adapter.listEntities());
  const match = resolveTarget(house, input.symptom, input.device);
  const symptom = classifySymptom(input.symptom);
  const primary = match.primary;
  const twins = match.group.slice(1);
  const onlineTwin = primary && isUnavailable(primary) ? twins.find((e) => !isUnavailable(e)) : undefined;
  const dut = onlineTwin ?? primary;
  const powerOn = dut ? await powerOnSupport(dut, house, deps) : undefined;
  const prior = priorFor({ ...(primary ? { primary } : {}), ...(dut ? { dut } : {}), guided: match.guided, symptom, ...(powerOn ? { powerOn } : {}) });
  const now = deps.clock.now();
  const session: DiagnosisSession = {
    type: 'diagnosis',
    version: 1,
    diagnosis_id: newId('dx', deps.clock, deps.rng),
    created_at: now,
    updated_at: now,
    symptom: input.symptom,
    symptom_class: symptom,
    target: { ...(primary ? { entity_id: primary.entityId } : {}), name: match.name, guided: match.guided },
    entities: {
      ...(primary ? { primary: primary.entityId } : {}),
      ...(dut ? { dut: dut.entityId } : {}),
      twins: twins.map((e) => e.entityId),
      group: match.group.map((e) => e.entityId),
    },
    causes: Object.keys(prior) as HypothesisId[],
    prior,
    posterior: { ...prior },
    probes: [],
    observations: [],
    consent: {},
    questions_asked: 0,
    passive_done: false,
    status: 'needs_answer',
    hypotheses: [],
    reliability: { ...deps.settings.humanReliability },
  };
  const t = await loadTurn(session, deps, house);
  await advance(t);
  return { session, output: outputOf(t, await speak(t, 0)) };
}

export async function answerDiagnosis(session: DiagnosisSession, input: DiagnoseAnswerInput, deps: EngineDeps): Promise<DiagnosisResult> {
  if (session.type !== 'diagnosis' || session.diagnosis_id !== input.diagnosis_id) {
    throw engineError('session_expired', `no diagnosis ${input.diagnosis_id}`);
  }
  const s: DiagnosisSession = clone(session);
  const pending = s.pending;
  if (!pending || pending.question_id !== input.question_id) {
    throw engineError('question_answered', `question ${input.question_id} is not the open question`);
  }
  const house = houseView(await deps.adapter.listEntities());
  const t = await loadTurn(s, deps, house);
  const before = s.observations.length;
  const said = parseYesNo(input.answer, { consent: pending.kind === 'consent' });
  const def = probeDef(pending.probe_id);
  const at = deps.clock.now();
  const subjectId = s.entities.dut ?? s.entities.primary;
  const value = said === 'unclear' ? null : pending.kind === 'consent' ? said : said === 'yes' ? (def.human?.yes ?? said) : (def.human?.no ?? said);
  const answerSeq = await deps.ledger.append({
    ts: at,
    kind: 'human_answer',
    ...(subjectId !== undefined ? { entityId: subjectId } : {}),
    source: 'fixwright',
    data: {
      diagnosis_id: s.diagnosis_id,
      question_id: pending.question_id,
      probe_id: pending.kind === 'consent' ? `${pending.probe_id}_consent` : pending.probe_id,
      answer: input.answer,
      parsed: said,
      value,
      ...(pending.kind === 'observe' && value !== null ? { outcome: def.outcome[value] ?? 'unknown' } : {}),
      entity_ids: subjectId !== undefined ? [subjectId] : [],
    },
  });

  if (said === 'unclear' && !pending.reasked) {
    await reask(t, pending);
    return { session: s, output: outputOf(t, speechSafe(s.pending?.text ?? pending.clearer)) };
  }

  delete s.pending;
  if (pending.kind === 'consent') {
    s.consent.disruptive = said === 'yes' ? 'granted' : 'declined';
    if (s.consent.disruptive === 'declined') t.lead.push({ text: phrase('dx_quiet_declined', {}), evidence: [], kind: 'framing' });
  } else {
    const evidence = [...pending.evidence, answerSeq];
    if (said === 'unclear') {
      recordResult(
        t,
        { probe_id: def.id, label: def.label, outcome: 'unknown', detail: "I couldn't tell from the answer.", evidence, disruptive: false, at },
        { probe_id: def.id, value: null, outcome: 'unknown', evidence, at, data: {} },
      );
    } else {
      const v = value as string;
      recordResult(
        t,
        {
          probe_id: def.id,
          label: def.human?.label(said, t) ?? def.label,
          outcome: def.outcome[v] ?? 'unknown',
          detail: def.human?.detail(said) ?? '',
          evidence,
          disruptive: false,
          at,
        },
        {
          probe_id: def.id,
          value: v,
          outcome: def.outcome[v] ?? 'unknown',
          evidence,
          at,
          answer: { question_id: pending.question_id, said },
          data: { answer: input.answer },
        },
      );
      s.posterior = bayesUpdate(s.posterior, said, humanLikelihood(def, s));
    }
  }
  await advance(t);
  return { session: s, output: outputOf(t, await speak(t, before)) };
}

/**
 * Asks once more, with a clearer question. A flash question flashes again so there is something to see, but
 * only under the same rules as the first flash: never during quiet hours without the person's yes. When
 * the flash cannot be repeated, the second asking is about the flash already done.
 */
async function reask(t: Turn, pending: PendingQuestion): Promise<void> {
  const s = t.session;
  const def = probeDef(pending.probe_id);
  let evidence = pending.evidence;
  let text = pending.clearer;
  let action = pending.action_performed;
  if (def.human?.needsFresh === 'flash_test') {
    const dut = t.dut;
    const allowed = canFlash(dut, t.deps, t.house) && (!quiet(t) || s.consent.disruptive === 'granted');
    if (allowed) {
      const { commands, answered } = await flashEntity(t.deps, dut, dut.state, 2);
      const at = t.deps.clock.now();
      const flash = describeFlash(t, dut, answered, commands, true);
      const outcome = probeDef('flash_test').outcome[flash.value] ?? 'unknown';
      const seq = await t.deps.ledger.append({
        ts: at,
        kind: 'probe',
        entityId: dut.entityId,
        source: 'fixwright',
        data: { probe_id: 'flash_test', value: flash.value, outcome, repeat: true, commands, answered, entity_ids: [dut.entityId], diagnosis_id: s.diagnosis_id },
      });
      // Shown on the stepper like any probe. It is not a new observation: the device's software answered
      // the same way a minute ago, so it would count the same evidence twice.
      s.probes.push({ probe_id: 'flash_test', label: 'Flash test again', outcome, detail: flash.detail, evidence: [seq], disruptive: true, at });
      evidence = [...evidence, seq];
      action = flash.action;
    } else {
      text = def.human.question(t).recall ?? pending.clearer;
    }
  }
  s.pending = {
    ...pending,
    question_id: newId('q', t.deps.clock, t.deps.rng),
    text,
    asked_at: t.deps.clock.now(),
    reasked: true,
    evidence,
    ...(action !== undefined ? { action_performed: action } : {}),
  };
  s.status = 'needs_answer';
}

/**
 * Once sensor evidence settles the real cause (a repair confirmed the next morning, say), scores each
 * answer the person gave against what that cause predicts and updates the household's reliability.
 * Answers the cause says little about are skipped.
 */
export function auditHumanAnswers(
  session: DiagnosisSession,
  cause: string,
  reliability: HumanReliability,
): { reliability: Required<HumanReliability>; contradicted: string[] } {
  let rel: Required<HumanReliability> = {
    sensitivity: reliability.sensitivity,
    specificity: reliability.specificity,
    positives: reliability.positives ?? DEFAULT_RELIABILITY.positives,
    negatives: reliability.negatives ?? DEFAULT_RELIABILITY.negatives,
  };
  const contradicted: string[] = [];
  for (const o of session.observations) {
    if (!o.answer) continue;
    const def = probeDef(o.probe_id);
    const yes = def.human?.yes;
    if (yes === undefined) continue;
    const pFact = row(def.table, cause)[yes] ?? 0.5;
    if (pFact > 0.2 && pFact < 0.8) continue;
    const factTrue = pFact >= 0.8;
    if ((o.answer.said === 'yes') !== factTrue) contradicted.push(o.answer.question_id);
    rel = updateHumanReliability(rel, o.answer.said, factTrue);
  }
  return { reliability: rel, contradicted };
}
