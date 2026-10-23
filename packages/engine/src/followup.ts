// Guided follow up checks. Some causes are fixed by the person or the vendor, not by Fixwright:
// a wall switch, a better spot for a plug, a vendor's cloud, a sign in. The diagnosis still promises to tell
// whether the fix worked, so it schedules one of these checks and the server runs it:
//   device_power_lost     comes_back   the device reports available again
//   radio_link_weak       flaps        no drops since the guidance, counted the next morning
//   vendor_cloud_outage   cloud_back   the vendor's status page reports ok again
//   account_link_expired  link_back    the integration loads again
//   wifi_network_changed  comes_back   the offline Wi-Fi devices report available again
// A check is planned only when a sensor can really answer it; otherwise the guidance promises nothing.

import { speechSafe, type DiagnosisCauseId, type Entity, type EntityId, type HouseEvent } from '@fixwright/protocol';
import { causeDef } from './causes.ts';
import { isGhost, isUnavailable } from './house.ts';
import { syncHomeEvents } from './ledger.ts';
import { phrase } from './phrase.ts';
import type { EngineDeps, GuidedCheck, GuidedCheckKind, GuidedCheckResult } from './types.ts';
import { brand, integrationName } from './util/text.ts';
import { HOUR_MS, MINUTE_MS, iso, localDayStart, nextLocalTime } from './util/time.ts';

/** When each kind of check first runs, how often it runs again while pending, and when it gives up. */
export const GUIDED_SCHEDULE: Readonly<Record<Exclude<GuidedCheckKind, 'flaps'>, { firstMs: number; everyMs: number; forMs: number }>> = {
  comes_back: { firstMs: 5 * MINUTE_MS, everyMs: 5 * MINUTE_MS, forMs: 2 * HOUR_MS },
  cloud_back: { firstMs: 15 * MINUTE_MS, everyMs: 15 * MINUTE_MS, forMs: 24 * HOUR_MS },
  link_back: { firstMs: 5 * MINUTE_MS, everyMs: 5 * MINUTE_MS, forMs: 24 * HOUR_MS },
};
/** Moving Wi-Fi devices to a new network takes longer than flipping a wall switch. */
export const WIFI_COMES_BACK_FOR_MS = 24 * HOUR_MS;
/** The flap count runs at the first 07:00 at least this long after the guidance, so there is a night to count. */
export const FLAPS_MIN_WAIT_MS = 6 * HOUR_MS;
export const FLAPS_CHECK_AT = '07:00';

export interface GuidedCheckInput {
  cause: DiagnosisCauseId;
  diagnosisId: string;
  /** The device as spoken inside a sentence ("hallway lamp"). */
  name: string;
  /** The device the person was told about (the copy that answers, when there are copies). */
  subject?: Entity;
  /** Other devices the same fix should bring back (Wi-Fi peers after a router change). */
  peers?: Entity[];
  /** Drops in the day before the guidance (radio_link_weak). */
  baseline?: number;
  /** Spoken brand of the vendor (vendor_cloud_outage). */
  brand?: string;
  nowMs: number;
  tz: string;
}

/** A device that can still come back: offline, not retired, and not an old copy nothing provides any more. */
const canComeBack = (e: Entity, nowMs: number): boolean => isUnavailable(e) && e.disabled !== true && !isGhost(e, nowMs);

function windowed(kind: GuidedCheckKind, nowMs: number, forMs?: number): Pick<GuidedCheck, 'check_at' | 'every_ms' | 'until'> {
  const s = GUIDED_SCHEDULE[kind as Exclude<GuidedCheckKind, 'flaps'>];
  return { check_at: iso(nowMs + s.firstMs), every_ms: s.everyMs, until: iso(nowMs + (forMs ?? s.forMs)) };
}

/**
 * The check that tells whether the person's fix worked, or undefined when no sensor can tell (no device,
 * a device that is already reported online, an old copy that will never come back, no vendor).
 */
export function planGuidedCheck(input: GuidedCheckInput): GuidedCheck | undefined {
  const kind = causeDef(input.cause).repair.check;
  const e = input.subject;
  if (kind === undefined || e === undefined) return undefined;
  const base = { cause_id: input.cause, diagnosis_id: input.diagnosisId, name: input.name, since: iso(input.nowMs) };
  switch (kind) {
    case 'comes_back': {
      const devices = [e, ...(input.peers ?? [])].filter((d) => canComeBack(d, input.nowMs));
      if (devices.length === 0) return undefined;
      const forMs = input.cause === 'wifi_network_changed' ? WIFI_COMES_BACK_FOR_MS : undefined;
      return { kind, ...base, entity_ids: [...new Set(devices.map((d) => d.entityId))], ...windowed(kind, input.nowMs, forMs) };
    }
    case 'flaps': {
      if (isGhost(e, input.nowMs)) return undefined;
      const at = iso(nextLocalTime(input.nowMs + FLAPS_MIN_WAIT_MS, input.tz, FLAPS_CHECK_AT));
      return { kind, ...base, entity_ids: [e.entityId], check_at: at, every_ms: 0, until: at, baseline: input.baseline ?? 0 };
    }
    case 'cloud_back': {
      if (e.vendor === undefined) return undefined;
      return { kind, ...base, entity_ids: [e.entityId], vendor: e.vendor, brand: input.brand ?? brand(e.vendor), ...windowed(kind, input.nowMs) };
    }
    case 'link_back':
      return { kind, ...base, entity_ids: [e.entityId], integration: e.integration, ...windowed(kind, input.nowMs) };
  }
}

interface Outcome {
  result: 'pass' | 'fail';
  speech: string;
  home: HouseEvent[];
  observed: Record<string, unknown>;
}

const firstSentence = (text: string): string => {
  const m = /^.*?[.!?](?=\s|$)/.exec(text);
  return m ? m[0] : text;
};

async function states(ids: readonly EntityId[], deps: EngineDeps): Promise<Map<EntityId, Entity | null>> {
  const found = await Promise.all(ids.map((id) => deps.adapter.getEntity(id)));
  return new Map(ids.map((id, i) => [id, found[i] ?? null]));
}

const online = (e: Entity | null | undefined): boolean => e !== null && e !== undefined && !isUnavailable(e) && e.disabled !== true;

async function comesBack(check: GuidedCheck, deps: EngineDeps, nowMs: number, final: boolean): Promise<Outcome | null> {
  const now = await states(check.entity_ids, deps);
  const back = check.entity_ids.filter((id) => online(now.get(id)));
  const done = back.length === check.entity_ids.length;
  if (!done && !final) return null;
  const events = await syncHomeEvents(deps, { since: check.since, until: iso(nowMs), entityIds: check.entity_ids });
  const home = back.flatMap((id) => {
    const rows = events.filter((e) => e.entityId === id && e.from === 'unavailable' && e.to !== undefined && e.to !== 'unavailable');
    return rows.length > 0 ? [rows[rows.length - 1] as HouseEvent] : [];
  });
  const n = check.entity_ids.length;
  const speech = done
    ? n === 1
      ? phrase('gc_back', { name: check.name })
      : phrase('gc_back_all', { count: n })
    : n === 1
      ? phrase('gc_not_back', { name: check.name })
      : phrase('gc_not_back_some', { missing: n - back.length, count: n });
  return { result: done ? 'pass' : 'fail', speech, home, observed: { back, states: Object.fromEntries([...now].map(([id, e]) => [id, e?.state ?? 'missing'])) } };
}

async function flaps(check: GuidedCheck, deps: EngineDeps, nowMs: number): Promise<Outcome> {
  const id = check.entity_ids[0] as EntityId;
  const events = await syncHomeEvents(deps, { since: check.since, until: iso(nowMs), entityIds: [id] });
  const drops = events.filter((e) => e.entityId === id && e.to === 'unavailable' && e.from !== 'unavailable');
  const current = (await states([id], deps)).get(id);
  const sinceMs = Date.parse(check.since);
  const period = localDayStart(sinceMs, deps.settings.tz) < localDayStart(nowMs, deps.settings.tz) ? 'since yesterday' : 'overnight';
  const observed = { drops: drops.length, state: current?.state ?? 'missing' };
  if (drops.length > 0) {
    return { result: 'fail', speech: phrase('gc_flaps_some', { name: check.name, count: drops.length, period }), home: drops, observed };
  }
  if (!online(current)) return { result: 'fail', speech: phrase('gc_not_back', { name: check.name }), home: [], observed };
  return { result: 'pass', speech: phrase('gc_flaps_none', { name: check.name, period, baseline: check.baseline ?? 0 }), home: [], observed };
}

async function cloudBack(check: GuidedCheck, deps: EngineDeps, final: boolean): Promise<Outcome | null> {
  const spoken = check.brand ?? brand(check.vendor ?? '');
  const status = await deps.adapter.cloudStatus(check.vendor ?? '');
  if (status.status === 'ok') {
    const device = (await states(check.entity_ids, deps)).get(check.entity_ids[0] ?? '');
    const speech = phrase('gc_cloud_back', { brand: spoken, ...(online(device) ? { name: check.name } : {}) });
    return { result: 'pass', speech, home: [], observed: { status: status.status, source: status.source, device: device?.state ?? 'missing' } };
  }
  if (!final) return null;
  return { result: 'fail', speech: phrase('gc_cloud_still', { brand: spoken }), home: [], observed: { status: status.status, source: status.source } };
}

async function linkBack(check: GuidedCheck, deps: EngineDeps, final: boolean): Promise<Outcome | null> {
  const integration = check.integration ?? '';
  const status = (await deps.adapter.integrations()).find((i) => i.integration === integration);
  const spoken = integrationName(integration);
  if (status?.state === 'loaded') return { result: 'pass', speech: phrase('gc_link_back', { brand: spoken }), home: [], observed: { integration, state: status.state } };
  if (!final) return null;
  return { result: 'fail', speech: phrase('gc_link_still', { brand: spoken }), home: [], observed: { integration, state: status?.state ?? 'missing' } };
}

/**
 * Runs a scheduled check. Before check_at, and while nothing is settled before `until`, it returns
 * pending with the next time to run (no ledger write, nothing to push). A pass or a fail is recorded in
 * the ledger, and its speech is the push.
 */
export async function evaluateGuidedCheck(check: GuidedCheck, deps: EngineDeps): Promise<GuidedCheckResult> {
  const nowMs = deps.clock.nowMs();
  const untilMs = Date.parse(check.until);
  const pending = (at: number): GuidedCheckResult => ({ result: 'pending', detail: phrase('gc_pending', {}), speech: '', next_check_at: iso(at), evidence: [] });
  if (nowMs < Date.parse(check.check_at)) return pending(Date.parse(check.check_at));
  const final = nowMs >= untilMs || check.every_ms <= 0;
  let outcome: Outcome | null;
  switch (check.kind) {
    case 'comes_back':
      outcome = await comesBack(check, deps, nowMs, final);
      break;
    case 'flaps':
      outcome = await flaps(check, deps, nowMs);
      break;
    case 'cloud_back':
      outcome = await cloudBack(check, deps, final);
      break;
    case 'link_back':
      outcome = await linkBack(check, deps, final);
      break;
  }
  if (outcome === null) return pending(Math.min(nowMs + check.every_ms, untilMs));
  const seq = await deps.ledger.append({
    ts: iso(nowMs),
    kind: 'note',
    ...(check.entity_ids[0] !== undefined ? { entityId: check.entity_ids[0] } : {}),
    source: 'fixwright',
    data: {
      check: 'guided',
      check_kind: check.kind,
      cause_id: check.cause_id,
      diagnosis_id: check.diagnosis_id,
      result: outcome.result,
      entity_ids: check.entity_ids,
      ...outcome.observed,
    },
  });
  const speech = speechSafe(outcome.speech);
  const evidence = [...new Set([...outcome.home.map((e) => e.seq), seq])].sort((a, b) => a - b);
  return { result: outcome.result, detail: firstSentence(speech), speech, evidence };
}
