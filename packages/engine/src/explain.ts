// explain_event: "Why did every plug turn on at 3 a.m.?" Reads the time window from the
// question, copies the home events in it into the ledger, and runs these detectors in order:
//   power_restore       at least 5 devices across at least 2 integrations come back within 10 s, and the
//                       on transitions after it carry no automation, service or user context. When the
//                       question names a device that was not part of it, that is said, and the device's
//                       own changes are explained instead.
//   automation_trigger  the changes carry an automation's context: name it and its trigger
//   user_action         the changes carry a person's context: someone used the app
//   fixwright           the changes were Fixwright's own writes (a flash test, a repair step, an undo): the
//                       hub logs them with the API user's context, exactly like an app command, so they are
//                       matched against Fixwright's own ledger rows by device and time ("That was me.")
//   none                can't tell, and say what is missing
// Of user_action and fixwright, the one with the latest change answers. Every number in the answer (the
// time, the device count, the seconds) is computed from the events.

import {
  CAUSE_LABELS,
  CONFIRM_THRESHOLD,
  newId,
  speechSafe,
  type CauseId,
  type Entity,
  type EntityId,
  type ExplainEventInput,
  type ExplainEventOutput,
  type HouseEvent,
  type TimelineEntry,
  type Verdict,
} from '@fixwright/protocol';
import { floor3 } from './bayes.ts';
import { checkVerdict, phraseLines } from './claims.ts';
import { clone, houseWords, sourceOf } from './common.ts';
import { houseView, isPhysical, objectId, powerOnSelect, previousOption, SWITCHABLE_DOMAINS, type HouseView } from './house.ts';
import { syncHomeEvents } from './ledger.ts';
import { phrase } from './phrase.ts';
import { canRepair } from './planner.ts';
import { resolveTarget } from './target.ts';
import type { CheckedClaim, Detector, EngineDeps, ExplanationSession, SuggestedRepair } from './types.ts';
import { capitalize, lowerName, numberWord, secondsPhrase, theName } from './util/text.ts';
import { DAY_MS, MINUTE_MS, clockTime, iso, localTime } from './util/time.ts';
import { needsMeridiem, timeWindowCandidates, withoutTimes, type TimeWindow } from './timewindow.ts';

/** A power restore needs this many devices from this many integrations coming back within this window. */
export const RESTORE_MIN_DEVICES = 5;
export const RESTORE_MIN_INTEGRATIONS = 2;
export const RESTORE_CLUSTER_MS = 10_000;
/** How long after the devices come back their on transitions still count as part of the restore. */
const ON_AFTER_MS = 60_000;
const LOOKBACK_FOR_OUTAGE_MS = 10 * MINUTE_MS;
/**
 * How long after a change the ledger row of Fixwright's write that caused it may land (a flash sends four
 * commands and reads each one back), and how far before it (a small clock difference between hub and server).
 */
export const OWN_WRITE_LAG_MS = 15_000;
export const OWN_WRITE_LEAD_MS = 2_000;

export interface ExplanationResult {
  session: ExplanationSession;
  output: ExplainEventOutput;
}

interface Detection {
  detector: Detector;
  cause: CauseId;
  /** Replaces the cause's protocol label (Fixwright's own writes have no cause id of their own). */
  label?: string;
  /** When the latest change it explains happened. */
  lastMs?: number;
  /** Strength of the signature, 0 to 1. */
  confidence: number;
  claims: CheckedClaim[];
  timeline: TimelineEntry[];
  /** Spoken after the claims (an offer or what would settle it). */
  tail: string[];
  fix?: SuggestedRepair;
}

/** Why Fixwright wrote to the house: a flash test, a repair's on and off check, a repair step, an undo. */
type OwnPurpose = 'test' | 'check' | 'fix' | 'undo';

/** One of Fixwright's own writes, from its ledger row. */
interface OwnWrite {
  seq: number;
  ms: number;
  entityIds: Set<EntityId>;
  purpose: OwnPurpose;
}

interface Subject {
  ids: Set<EntityId>;
  /** As spoken inside a sentence ("kitchen plug"). */
  name: string;
}

interface Scene {
  deps: EngineDeps;
  house: HouseView;
  events: HouseEvent[];
  window: TimeWindow;
  meridiem: boolean;
  subject: Subject | null;
  /** Home events that were Fixwright's own writes, by seq, with the write that caused each. */
  own: Map<number, OwnWrite>;
}

const t = (e: HouseEvent): number => Date.parse(e.ts);
const seqs = (events: readonly HouseEvent[]): number[] => [...new Set(events.map((e) => e.seq))].sort((a, b) => a - b);
const inWindow = (e: HouseEvent, w: TimeWindow): boolean => t(e) >= w.sinceMs && t(e) <= w.untilMs;
const minuteOf = (ms: number): { since: string; until: string } => {
  const start = Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  return { since: iso(start), until: iso(start + MINUTE_MS - 1) };
};

const hasCause = (e: HouseEvent): boolean =>
  e.context !== undefined &&
  (e.context.automationId !== undefined || e.context.userId !== undefined || e.context.service !== undefined || e.context.parentSeq !== undefined);

/**
 * A device restart it reported itself: an uptime reset, or a boot reason of power on (Matter
 * GeneralDiagnostics BootReason PowerOnReboot, as SimHome and Matter bridges report it).
 */
export function isRestartSignal(e: HouseEvent): boolean {
  const d = e.data ?? {};
  if (d['uptime_reset'] === true) return true;
  if (typeof d['boot_reason'] === 'string' && /power/i.test(d['boot_reason'])) return true;
  return e.entityId !== undefined && /boot|restart/i.test(String(d['event'] ?? '')) && /power/i.test(String(d['reason'] ?? ''));
}

/** A device coming back: unavailable to anything else, or a reported restart. */
function isComeBack(e: HouseEvent): boolean {
  if ((e.kind === 'availability' || e.kind === 'state') && e.from === 'unavailable' && e.to !== undefined && e.to !== 'unavailable') return true;
  return isRestartSignal(e);
}

/** Switched on: a state change to on, or a device that came back already on. */
const isOn = (e: HouseEvent): boolean => (e.kind === 'state' || e.kind === 'availability') && e.to === 'on' && e.from !== 'on';

/** Mains power returning, as a circuit model reports it (not a single device's boot report). */
const isMainsOn = (e: HouseEvent): boolean => e.kind === 'power' && e.to === 'on' && !isRestartSignal(e);

function deviceOf(e: HouseEvent, house: HouseView): string {
  const entity = e.entityId ? house.byId.get(e.entityId) : undefined;
  return entity?.deviceId ?? e.entityId ?? `seq${e.seq}`;
}

function integrationOf(e: HouseEvent, house: HouseView): string {
  const entity = e.entityId ? house.byId.get(e.entityId) : undefined;
  const fromData = e.data?.['integration'];
  return entity?.integration ?? (typeof fromData === 'string' ? fromData : 'unknown');
}

const PURPOSE_ORDER: readonly OwnPurpose[] = ['test', 'check', 'fix', 'undo'];

function purposeOf(row: HouseEvent): OwnPurpose | undefined {
  if (row.kind === 'probe') return row.data?.['probe_id'] === 'flash_test' ? 'test' : undefined;
  if (row.kind !== 'repair') return undefined;
  const phase = row.data?.['phase'];
  if (phase === 'undo' || phase === 'rollback') return 'undo';
  return row.data?.['op'] === 'flash_check' ? 'check' : 'fix';
}

/** Fixwright's own writes to the house around a span: flash tests (probe rows) and repair, rollback and undo steps. */
async function ownWrites(deps: EngineDeps, sinceMs: number, untilMs: number): Promise<OwnWrite[]> {
  const rows = await deps.ledger.query({
    since: iso(sinceMs - OWN_WRITE_LEAD_MS),
    until: iso(untilMs + OWN_WRITE_LAG_MS),
    source: 'fixwright',
    kinds: ['probe', 'repair'],
  });
  return rows.flatMap((row) => {
    const purpose = purposeOf(row);
    if (purpose === undefined) return [];
    const ids = new Set<EntityId>(row.entityId !== undefined ? [row.entityId] : []);
    const listed = row.data?.['entity_ids'];
    if (Array.isArray(listed)) for (const id of listed) if (typeof id === 'string') ids.add(id);
    return [{ seq: row.seq, ms: t(row), entityIds: ids, purpose }];
  });
}

/**
 * The write of Fixwright's that made this change, if any: a change commanded through the API (it carries a
 * user or service context, never an automation's) on the same device, just before Fixwright logged a write
 * to it. Hubs log Fixwright's commands with the API user's context, the same way they log an app command.
 */
function ownWriteOf(e: HouseEvent, writes: readonly OwnWrite[]): OwnWrite | undefined {
  if ((e.kind !== 'state' && e.kind !== 'availability') || e.entityId === undefined) return undefined;
  const c = e.context;
  if (c === undefined || c.automationId !== undefined || (c.userId === undefined && c.service === undefined)) return undefined;
  const at = t(e);
  let best: OwnWrite | undefined;
  for (const w of writes) {
    if (!w.entityIds.has(e.entityId) || at < w.ms - OWN_WRITE_LAG_MS || at > w.ms + OWN_WRITE_LEAD_MS) continue;
    if (!best || Math.abs(w.ms - at) < Math.abs(best.ms - at)) best = w;
  }
  return best;
}

const notOwn = (s: Scene) => (e: HouseEvent): boolean => !s.own.has(e.seq);

/** "the porch light" for one entity, "fourteen devices" for many. */
function what(entityIds: readonly EntityId[], house: HouseView): string {
  const unique = [...new Set(entityIds)];
  if (unique.length === 1) {
    const e = house.byId.get(unique[0] ?? '');
    return e ? theName(lowerName(e.name)) : 'one device';
  }
  return `${numberWord(unique.length)} devices`;
}

const oddsToP = (odds: number): number => odds / (1 + odds);

interface Restore {
  /** One comeback row per device, in time order. */
  reps: Map<string, HouseEvent>;
  cluster: HouseEvent[];
  integrations: Set<string>;
  startMs: number;
  lastBackMs: number;
  /** The mains power row when the house reports one. */
  power?: HouseEvent;
}

/** The largest cluster of devices coming back within 10 s, when it is big and wide enough to be a power restore. */
function findRestore(s: Scene): Restore | null {
  const { house, events } = s;
  const backs = events.filter((e) => isComeBack(e) && inWindow(e, s.window));
  let cluster: HouseEvent[] = [];
  for (let i = 0; i < backs.length; i++) {
    const start = backs[i] as HouseEvent;
    const group = backs.filter((e, j) => j >= i && t(e) - t(start) <= RESTORE_CLUSTER_MS);
    const devices = new Set(group.map((e) => deviceOf(e, house))).size;
    if (devices > new Set(cluster.map((e) => deviceOf(e, house))).size) cluster = group;
  }
  const reps = new Map<string, HouseEvent>();
  for (const e of cluster) if (!reps.has(deviceOf(e, house))) reps.set(deviceOf(e, house), e);
  const integrations = new Set([...reps.values()].map((e) => integrationOf(e, house)));
  if (reps.size < RESTORE_MIN_DEVICES || integrations.size < RESTORE_MIN_INTEGRATIONS) return null;
  const startMs = t([...reps.values()][0] as HouseEvent);
  const power = events.find((e) => isMainsOn(e) && t(e) >= startMs - RESTORE_CLUSTER_MS && t(e) <= startMs + 1_000);
  return { reps, cluster, integrations, startMs, lastBackMs: Math.max(...[...reps.values()].map(t)), ...(power ? { power } : {}) };
}

/** The rows of the restore that are about the device the question names (empty when it was not part of it). */
function subjectRows(s: Scene, r: Restore): HouseEvent[] {
  if (s.subject === null) return [];
  const devices = new Set([...s.subject.ids].map((id) => s.house.byId.get(id)?.deviceId ?? id));
  return [...r.reps.entries()].filter(([device, e]) => devices.has(device) || (e.entityId !== undefined && s.subject?.ids.has(e.entityId))).map(([, e]) => e);
}

/** "The kitchen plug wasn't one of the fourteen devices that restarted when power came back at 3:12." */
function notInRestore(s: Scene, r: Restore): CheckedClaim {
  const backMs = r.power ? t(r.power) : r.startMs;
  const subject = s.subject as Subject;
  return {
    text: phrase('ex_not_in_restore', { name: subject.name, count: r.reps.size, time: clockTime(backMs, s.deps.settings.tz, s.meridiem) }),
    evidence: seqs([...(r.power ? [r.power] : []), ...r.reps.values()]),
    kind: 'fact',
    support: { distinctEntities: r.reps.size, notAbout: [...subject.ids], window: minuteOf(backMs) },
  };
}

/**
 * How many devices the power on fix would really change: their power on select can be set to previous and is
 * not already (the same test repair_plan's draft makes, counted per device).
 */
function settableDevices(entityIds: readonly EntityId[], house: HouseView): number {
  const devices = new Set<string>();
  for (const id of entityIds) {
    const e = house.byId.get(id);
    const select = e ? powerOnSelect(e, house) : undefined;
    const option = select ? previousOption(select) : undefined;
    if (e && select && option !== undefined && select.state !== option) devices.add(e.deviceId ?? id);
  }
  return devices.size;
}

async function restoreDetection(s: Scene, r: Restore): Promise<Detection | null> {
  const { house, events, deps } = s;
  const tz = deps.settings.tz;
  const { reps, cluster, integrations, startMs, lastBackMs, power } = r;
  const first = [...reps.values()][0] as HouseEvent;
  const devices = new Set(reps.keys());
  // Fixwright's own switching right after the restore is not part of it.
  const ons = events.filter((e) => isOn(e) && !s.own.has(e.seq) && t(e) >= startMs && t(e) <= lastBackMs + ON_AFTER_MS && devices.has(deviceOf(e, house)));
  if (ons.some(hasCause)) return null;
  const runs = events.filter((e) => e.kind === 'automation_run' && t(e) >= startMs - 5_000 && t(e) <= lastBackMs + ON_AFTER_MS);
  const restarts = cluster.filter(isRestartSignal);
  const outagePower = events.find((e) => e.kind === 'power' && e.to === 'off' && !isRestartSignal(e) && t(e) <= startMs && t(e) >= startMs - LOOKBACK_FOR_OUTAGE_MS);
  const drops = events.filter(
    (e) => e.to === 'unavailable' && devices.has(deviceOf(e, house)) && t(e) <= startMs && t(e) >= startMs - LOOKBACK_FOR_OUTAGE_MS,
  );
  const outage = outagePower ? [outagePower] : drops.length >= RESTORE_MIN_DEVICES ? drops : [];

  const backMs = power ? t(power) : startMs;
  const backEvidence = power ? [power] : [first];
  const spanS = (lastBackMs - startMs) / 1000;
  const withinS = Math.max(1, Math.ceil(spanS - 1e-9));
  const time = clockTime(backMs, tz, s.meridiem);
  const restarted = phrase('ex_restarted', { count: reps.size, within: secondsPhrase(spanS) });
  const claims: CheckedClaim[] = [
    { text: phrase('ex_power_back', { time }), evidence: seqs(backEvidence), kind: 'fact', support: { window: minuteOf(backMs) } },
    {
      text: restarted,
      evidence: seqs([...reps.values()]),
      kind: 'fact',
      support: { distinctEntities: reps.size, allWithin: { since: iso(startMs), until: iso(startMs + withinS * 1000) } },
    },
  ];
  // A question about one device: say that it was one of them.
  const mine = subjectRows(s, r);
  if (s.subject !== null && mine.length > 0) {
    claims.push({
      text: phrase('ex_in_restore', { name: s.subject.name }),
      evidence: seqs(mine),
      kind: 'fact',
      support: { entityIds: [...s.subject.ids], allWithin: { since: iso(startMs), until: iso(startMs + withinS * 1000) } },
    });
  }
  if (ons.length > 0 && runs.length === 0) {
    claims.push({
      text: phrase('ex_no_automation', {}),
      evidence: seqs(ons),
      kind: 'fact',
      support: { noContext: true, absent: { kinds: ['automation_run'], since: iso(startMs - 5_000), until: iso(lastBackMs + ON_AFTER_MS) } },
    });
  }

  const timeline: TimelineEntry[] = [];
  if (outage.length > 0) timeline.push({ ts: (outage[0] as HouseEvent).ts, label: phrase('ex_tl_out', {}), evidence: seqs(outage) });
  timeline.push({ ts: iso(backMs), label: phrase('ex_tl_back', {}), evidence: seqs(backEvidence) });
  timeline.push({ ts: first.ts, label: restarted.replace(/\.$/, ''), evidence: seqs([...reps.values()]) });
  const onIds = [...new Set(ons.map((e) => e.entityId).filter((id): id is EntityId => id !== undefined))];
  if (ons.length > 0) {
    const lastOn = ons.reduce((a, b) => (t(b) > t(a) ? b : a));
    timeline.push({ ts: lastOn.ts, label: phrase('ex_tl_no_context', { count: onIds.length }), evidence: seqs(ons) });
  }
  timeline.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  // Signature strength as odds: many devices, several integrations, no context, an explicit power or
  // restart signal and a matching outage each make a power restore more likely than a coincidence.
  let odds = 4 * 3;
  if (integrations.size >= 3) odds *= 1.5;
  if (ons.length > 0 && runs.length === 0) odds *= 2;
  if (power || restarts.length > 0) odds *= 3;
  if (outage.length > 0) odds *= 1.5;

  const fixable: EntityId[] = [];
  for (const id of onIds) if ((await deps.adapter.signals(id)).powerOnBehavior === 'on') fixable.push(id);
  // Offered only when repair_plan can really change at least one of those settings (a power on select).
  const fix: SuggestedRepair | undefined =
    fixable.length > 0 && (await canRepair('power_on_default_on', fixable, deps, s.house))
      ? {
          issue_id: newId('iss', deps.clock, deps.rng),
          label: phrase('ex_fix_label', { count: fixable.length }),
          cause_id: 'power_on_default_on',
          entity_ids: fixable,
        }
      : undefined;
  // When only some of the devices that restarted have a power on setting the plan can change, say how many
  // ("Six of the nine can remember their last state."), so a fix for six after "Nine devices restarted" adds up.
  const settable = settableDevices(fixable, house);
  const offer = settable > 0 && settable < reps.size ? { count: settable, restarted: reps.size } : { count: fixable.length };
  return {
    detector: 'power_restore',
    cause: 'power_restore',
    lastMs: Math.max(lastBackMs, ...ons.map(t)),
    confidence: oddsToP(odds),
    claims,
    timeline,
    tail: fix ? [phrase('ex_offer_power_fix', offer)] : [],
    ...(fix ? { fix } : {}),
  };
}

function automationEntity(id: string, house: HouseView): Entity | undefined {
  return house.all.find((e) => e.domain === 'automation' && (e.attributes['id'] === id || e.entityId === id || objectId(e.entityId) === id));
}

const prettyId = (id: string): string => capitalize(objectId(id).replace(/_/g, ' '));

function changesIn(s: Scene): HouseEvent[] {
  return s.events.filter(
    (e) => e.kind === 'state' && e.from !== e.to && inWindow(e, s.window) && (s.subject === null || (e.entityId !== undefined && s.subject.ids.has(e.entityId))),
  );
}

function detectAutomation(s: Scene): Detection | null {
  const runsBySeq = new Map(s.events.filter((e) => e.kind === 'automation_run').map((e) => [e.seq, e]));
  const automationOf = (e: HouseEvent): string | undefined =>
    e.context?.automationId ?? (e.context?.parentSeq !== undefined ? runsBySeq.get(e.context.parentSeq)?.context?.automationId : undefined);
  const byAutomation = new Map<string, HouseEvent[]>();
  for (const e of changesIn(s)) {
    const id = automationOf(e);
    if (id !== undefined) byAutomation.set(id, [...(byAutomation.get(id) ?? []), e]);
  }
  const [aid, changes] = [...byAutomation.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
  if (aid === undefined || !changes || changes.length === 0) return null;
  const tz = s.deps.settings.tz;
  const entity = automationEntity(aid, s.house);
  const name = entity?.name ?? prettyId(aid);
  const firstMs = Math.min(...changes.map(t));
  const run = s.events.find(
    (e) => e.kind === 'automation_run' && e.context?.automationId === aid && t(e) <= firstMs && t(e) >= firstMs - 5 * MINUTE_MS,
  );
  const ids = changes.map((e) => e.entityId).filter((x): x is EntityId => x !== undefined);
  const evidence = run ? [run, ...changes] : changes;
  const claims: CheckedClaim[] = [
    {
      text: phrase('ex_automation', { automation: name, what: what(ids, s.house), time: clockTime(firstMs, tz, s.meridiem) }),
      evidence: seqs(evidence),
      kind: 'fact',
      support: { entityIds: [...ids, ...(run?.entityId ? [run.entityId] : []), ...(entity ? [entity.entityId] : [])], window: minuteOf(firstMs) },
    },
  ];
  const trigger = run?.data?.['trigger'];
  if (run && typeof trigger === 'string' && trigger.trim() !== '') {
    claims.push({ text: phrase('ex_automation_trigger', { trigger: trigger.trim() }), evidence: [run.seq], kind: 'fact' });
  }
  const timeline: TimelineEntry[] = [];
  if (run) timeline.push({ ts: run.ts, label: `${name} ran`, evidence: [run.seq] });
  timeline.push({ ts: iso(firstMs), label: `${name} switched ${what(ids, s.house)}`, evidence: seqs(changes) });
  return {
    detector: 'automation_trigger',
    cause: 'automation_trigger',
    lastMs: Math.max(...changes.map(t)),
    confidence: oddsToP(24),
    claims,
    timeline,
    tail: [],
  };
}

function detectUser(s: Scene): Detection | null {
  const changes = changesIn(s).filter((e) => e.context?.userId !== undefined && e.context.automationId === undefined && !s.own.has(e.seq));
  if (changes.length === 0) return null;
  const firstMs = Math.min(...changes.map(t));
  const ids = changes.map((e) => e.entityId).filter((x): x is EntityId => x !== undefined);
  const text = phrase('ex_user', { what: what(ids, s.house), time: clockTime(firstMs, s.deps.settings.tz, s.meridiem) });
  return {
    detector: 'user_action',
    cause: 'user_action',
    lastMs: Math.max(...changes.map(t)),
    confidence: oddsToP(13),
    claims: [{ text, evidence: seqs(changes), kind: 'fact', support: { entityIds: ids, window: minuteOf(firstMs) } }],
    timeline: [{ ts: iso(firstMs), label: text.replace(/\.$/, ''), evidence: seqs(changes) }],
    tail: [],
  };
}

const PURPOSE_WORDS: Readonly<Record<OwnPurpose, (many: boolean) => string>> = {
  test: (many) => (many ? 'to test them' : 'to test it'),
  check: () => 'to check the fix',
  fix: () => 'as part of the fix',
  undo: () => 'to undo the fix',
};

/** "That was me. I switched the hallway lamp at 3:00 to test it." Fixwright's own writes, matched to its ledger rows. */
function detectOwn(s: Scene): Detection | null {
  const changes = changesIn(s).filter((e) => s.own.has(e.seq));
  if (changes.length === 0) return null;
  const firstMs = Math.min(...changes.map(t));
  const ids = [...new Set(changes.map((e) => e.entityId).filter((x): x is EntityId => x !== undefined))];
  const writes = [...new Map(changes.map((e) => s.own.get(e.seq) as OwnWrite).map((w) => [w.seq, w])).values()];
  const purposes = PURPOSE_ORDER.filter((p) => writes.some((w) => w.purpose === p)).map((p) => PURPOSE_WORDS[p](ids.length > 1));
  const settings = ids.every((id) => s.house.byId.get(id)?.domain === 'select');
  const subjectWords = settings && ids.length > 1 ? `${numberWord(ids.length)} settings` : what(ids, s.house);
  const text = phrase('ex_own', {
    verb: settings ? 'changed' : 'switched',
    what: subjectWords,
    time: clockTime(firstMs, s.deps.settings.tz, s.meridiem),
    purposes,
  });
  const evidence = [...new Set([...changes.map((e) => e.seq), ...writes.map((w) => w.seq)])].sort((a, b) => a - b);
  return {
    detector: 'fixwright',
    // The protocol has no cause id for Fixwright's own writes.
    // user_action is the nearest (a command through the API), and the label says who it was.
    cause: 'user_action',
    label: phrase('ex_own_label', {}),
    lastMs: Math.max(...changes.map(t)),
    confidence: oddsToP(49),
    claims: [
      { text: phrase('ex_own_intro', {}), evidence: [], kind: 'framing' },
      { text, evidence, kind: 'fact', support: { entityIds: ids, window: minuteOf(firstMs) } },
    ],
    timeline: [{ ts: iso(firstMs), label: text.replace(/\.$/, ''), evidence }],
    tail: [],
  };
}

/** Of the detections given, the one with the latest change answers ("why did it just turn on", "why did it blink"). */
function latestOf(...found: (Detection | null)[]): Detection | null {
  return found.reduce<Detection | null>((best, d) => (d !== null && (best === null || (d.lastMs ?? 0) > (best.lastMs ?? 0)) ? d : best), null);
}

function cantTell(s: Scene): Detection {
  const ons = changesIn(s).filter(isOn).filter(notOwn(s));
  if (ons.length === 0) {
    return {
      detector: 'none',
      cause: 'unknown',
      confidence: 0,
      claims: [{ text: phrase('ex_cant_tell', {}), evidence: [], kind: 'framing' }],
      timeline: [],
      tail: [phrase('ex_settle', {})],
    };
  }
  const firstMs = Math.min(...ons.map(t));
  const ids = ons.map((e) => e.entityId).filter((x): x is EntityId => x !== undefined);
  const text = phrase('ex_unexplained', { what: what(ids, s.house), time: clockTime(firstMs, s.deps.settings.tz, s.meridiem) });
  return {
    detector: 'none',
    cause: 'unknown',
    confidence: 0,
    claims: [{ text, evidence: seqs(ons), kind: 'fact', support: { entityIds: ids, window: minuteOf(firstMs), noContext: true } }],
    timeline: [{ ts: iso(firstMs), label: text.replace(/, but.*$/, ''), evidence: seqs(ons) }],
    tail: [phrase('ex_settle', {})],
  };
}

/** "every plug", "all my lights", "everything": a question about the house, not one device. */
const MANY = /\b(every|everything|all|devices|things|sab|saare|sabhi)\b/;
/** "why did the lamp blink?": a quick on and off, so the latest change is the one asked about. */
const BLINK = /\b(blink|blinks|blinked|blinking|flash|flashed|flashing|flicker|flickers|flickered|flickering)\b/;

/**
 * The one device the question asks about, or null for a question about the house or about nothing named.
 * Time expressions go first, so "at 3" cannot pick "Plug 3"; a bare number stays, since there it is the name.
 */
function subjectOf(question: string, house: HouseView): Subject | null {
  const text = withoutTimes(question);
  if (MANY.test(text)) return null;
  try {
    const m = resolveTarget(house, text);
    return m.guided ? null : { ids: new Set(m.group.map((e) => e.entityId)), name: lowerName(m.name) };
  } catch {
    return null;
  }
}

/** Something explain_event could talk about: a device switching or going offline or back, or mains power. */
function isActivity(e: HouseEvent, house: HouseView): boolean {
  if (e.kind === 'power') return true;
  if ((e.kind !== 'state' && e.kind !== 'availability') || e.from === e.to) return false;
  if (e.from === 'unavailable' || e.to === 'unavailable') return true;
  const entity = e.entityId !== undefined ? house.byId.get(e.entityId) : undefined;
  return entity !== undefined && isPhysical(entity) && SWITCHABLE_DOMAINS.has(entity.domain);
}

const isSubject = (s: Scene, e: HouseEvent): boolean => s.subject !== null && e.entityId !== undefined && s.subject.ids.has(e.entityId);

/**
 * Does the window hold anything about the device asked about (anywhere in the house for a question about
 * the house, or when `anywhere`)? Fixwright's own writes count only for the device they switched, when the
 * question names it: "why did the hallway lamp turn on at 3?" right after a flash test is about that flash.
 */
function hasActivity(s: Scene, anywhere = false): boolean {
  return s.events.some(
    (e) =>
      inWindow(e, s.window) &&
      isActivity(e, s.house) &&
      (!s.own.has(e.seq) || isSubject(s, e)) &&
      (anywhere || s.subject === null || e.entityId === undefined || isSubject(s, e)),
  );
}

async function sceneFor(deps: EngineDeps, house: HouseView, span: TimeWindow, subject: Subject | null, ambiguous: boolean): Promise<Scene> {
  const sinceMs = span.sinceMs - LOOKBACK_FOR_OUTAGE_MS;
  const untilMs = span.untilMs + ON_AFTER_MS;
  const events = await syncHomeEvents(deps, { since: iso(sinceMs), until: iso(untilMs) });
  const writes = await ownWrites(deps, sinceMs, untilMs);
  const own = new Map<number, OwnWrite>();
  if (writes.length > 0) {
    for (const e of events) {
      const w = ownWriteOf(e, writes);
      if (w) own.set(e.seq, w);
    }
  }
  return { deps, house, events, window: span, meridiem: ambiguous || needsMeridiem(span, deps.settings.tz), subject, own };
}

/** Explains something the home already did. Returns the session (for repair_plan) and the tool output. */
export async function explainEvent(input: ExplainEventInput, deps: EngineDeps): Promise<ExplanationResult> {
  const nowMs = deps.clock.nowMs();
  const tz = deps.settings.tz;
  const explicit = input.since !== undefined || input.until !== undefined;
  const candidates: TimeWindow[] = explicit
    ? [
        {
          sinceMs: input.since !== undefined ? Date.parse(input.since) : nowMs - DAY_MS,
          untilMs: input.until !== undefined ? Date.parse(input.until) : nowMs,
          label: 'then',
        },
      ]
    : timeWindowCandidates(input.question, nowMs, tz);
  if (candidates.length === 0) candidates.push({ sinceMs: nowMs - DAY_MS, untilMs: nowMs, label: 'in the last day' });
  const house = houseView(await deps.adapter.listEntities());
  const subject = subjectOf(input.question, house);
  // An hour asked without a.m. or p.m. ("at 3") is answered with one, so the person hears which it was.
  const ambiguous = new Set(candidates.map((w) => localTime(w.sinceMs, tz).hour < 12)).size > 1;
  // A clock time with no day ("at 3 a.m.", "at 3"): the most recent time that hour came round in the last
  // 48 hours with something about the device asked about, else the most recent one with anything going on
  // in the house, else the most recent. After the 07:00 jump, "at 3 a.m." is still the night of the outage.
  const scenes: Scene[] = [];
  let sc: Scene | undefined;
  for (const w of candidates) {
    const scene = await sceneFor(deps, house, w, subject, ambiguous);
    scenes.push(scene);
    if (hasActivity(scene)) {
      sc = scene;
      break;
    }
  }
  sc ??= scenes.find((x) => hasActivity(x, true)) ?? (scenes[0] as Scene);
  const span = sc.window;

  const restore = findRestore(sc);
  const lead: CheckedClaim[] = [];
  let found: Detection | null = null;
  if (BLINK.test(input.question.toLowerCase())) {
    // A blink is one quick change: of everything that switched it, the latest answers.
    const inRestore = restore !== null && (sc.subject === null || subjectRows(sc, restore).length > 0);
    found = latestOf(inRestore ? await restoreDetection(sc, restore) : null, detectAutomation(sc), detectUser(sc), detectOwn(sc));
  } else if (restore) {
    if (sc.subject === null || subjectRows(sc, restore).length > 0) found = await restoreDetection(sc, restore);
    else lead.push(notInRestore(sc, restore));
  }
  found ??= detectAutomation(sc) ?? latestOf(detectUser(sc), detectOwn(sc));
  if (found === null) {
    if (restore && sc.subject !== null && lead.length === 0 && subjectRows(sc, restore).length === 0) lead.push(notInRestore(sc, restore));
    found = cantTell(sc);
  }
  const claims = [...lead, ...found.claims];
  const level: Verdict['level'] =
    found.detector === 'none' ? 'cant_tell' : found.confidence >= CONFIRM_THRESHOLD ? 'confirmed' : found.confidence >= 0.6 ? 'likely' : 'cant_tell';
  const words = houseWords(house);
  const { verdict } = await checkVerdict(
    {
      level,
      cause_id: found.cause,
      label: found.label ?? CAUSE_LABELS[found.cause].label,
      confidence: floor3(found.confidence),
      claims: [],
      fix_available: found.fix !== undefined,
    },
    claims,
    deps.ledger,
    { houseWords: words },
  );
  const said = await phraseLines(
    claims.filter((c) => c.kind === 'framing' || verdict.claims.some((v) => v.text === c.text)),
    deps.phraser,
    words,
  );
  const speech = speechSafe([...said, ...found.tail].join(' '));

  const explanationId = newId('exp', deps.clock, deps.rng);
  const session: ExplanationSession = {
    type: 'explanation',
    version: 1,
    explanation_id: explanationId,
    created_at: deps.clock.now(),
    question: input.question,
    window: { since: iso(span.sinceMs), until: iso(span.untilMs), label: span.label },
    detector: found.detector,
    verdict,
    timeline: found.timeline,
    ...(found.fix ? { suggested_fix: found.fix } : {}),
  };
  const output: ExplainEventOutput = {
    speech,
    status: 'ok',
    view: 'stepper',
    ids: { explanation_id: explanationId, ...(found.fix ? { issue_id: found.fix.issue_id } : {}) },
    source: sourceOf(deps.adapter),
    explanation_id: explanationId,
    verdict: clone(verdict),
    timeline: clone(found.timeline),
    ...(found.fix ? { suggested_fix: { issue_id: found.fix.issue_id, label: found.fix.label } } : {}),
  };
  return { session, output };
}
