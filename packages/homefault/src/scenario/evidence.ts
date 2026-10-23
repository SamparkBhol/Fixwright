// What any correct diagnosis of a cause needs to be able to point at, and what would contradict it.
// This is a property of the scenario, not of any agent: every fault, incident and noise-free generated
// scenario must pass it, so an agent that fails a scenario failed on evidence that was there.

import { toHouseEvents } from '../logrows.ts';
import type { CauseId, Entity, HouseEvent } from '../types.ts';
import { foldName, own } from '../util.ts';
import type { Scenario, ScenarioView } from './types.ts';

export interface EvidenceReport {
  cause_id: CauseId;
  /** Every required piece of evidence is present and nothing contradicts the cause. */
  supported: boolean;
  /** Plain descriptions of the evidence found. */
  found: string[];
  missing: string[];
  contradictions: string[];
}

const DAY = 86_400_000;
export const WEAK_LQI = 60;
export const WEAK_RSSI = -75;
export const LOW_BATTERY = 15;
const AUTH = /auth|token|credential|sign in|signed out|relink|re-link|link expired|reauth|unauthori[sz]ed|password/i;

interface Ctx {
  view: ScenarioView;
  now: number;
  entities: Map<string, Entity>;
  events: HouseEvent[];
  truth: string[];
}

const available = (e: Entity | undefined): boolean => e !== undefined && e.state !== 'unavailable' && !e.restored && !e.registryOnly;
const at = (ev: HouseEvent): number => Date.parse(ev.ts);

function dropsIn24h(c: Ctx, id: string): number {
  return c.events.filter((ev) => ev.entityId === id && ev.kind === 'availability' && ev.to === 'unavailable' && at(ev) > c.now - DAY).length;
}

type Check = (c: Ctx, r: EvidenceReport) => void;

const need = (r: EvidenceReport, ok: boolean, found: string, missing: string): void => {
  (ok ? r.found : r.missing).push(ok ? found : missing);
};

/** Groups unavailable -> back transitions that happen within windowMs of each other. */
export function restartClusters(events: readonly HouseEvent[], windowMs = 10_000): HouseEvent[][] {
  const backs = events.filter((ev) => ev.kind === 'availability' && ev.from === 'unavailable' && ev.to !== 'unavailable').sort((a, b) => at(a) - at(b));
  const clusters: HouseEvent[][] = [];
  for (const ev of backs) {
    const last = clusters[clusters.length - 1];
    if (last && at(ev) - at(last[0] as HouseEvent) <= windowMs) last.push(ev);
    else clusters.push([ev]);
  }
  return clusters;
}

const CHECKS: Readonly<Record<CauseId, Check>> = {
  stale_duplicate(c, r) {
    const ghost = c.truth.map((id) => c.entities.get(id)).find((e) => e?.restored);
    need(r, ghost !== undefined && ghost.state === 'unavailable', `${ghost?.entityId} is a restored copy, unavailable`, 'no restored, unavailable copy among the named entities');
    if (!ghost) return;
    const online = [...c.entities.values()].find((e) => e.entityId !== ghost.entityId && foldName(e.name) === foldName(ghost.name) && available(e));
    need(r, online !== undefined, `${online?.entityId} answers to the same name and is online`, 'no online entity shares the old copy\'s name');
    need(r, c.now - Date.parse(ghost.lastChanged) >= DAY, 'the old copy has been offline for over a day', 'the old copy went offline less than a day ago');
    if (online && !c.truth.includes(online.entityId)) r.contradictions.push('the online copy is not named in the ground truth');
  },
  device_power_lost(c, r) {
    const target = c.entities.get(c.truth[0] ?? '');
    if (!target) return void r.missing.push('target entity is not in the home');
    const battery = own(c.view.home.signals, target.entityId)?.batteryPct;
    const lowBattery = battery !== undefined && battery < LOW_BATTERY;
    need(r, target.state === 'unavailable' || lowBattery, target.state === 'unavailable' ? `${target.entityId} is unavailable` : `${target.entityId} battery at ${battery}%`, `${target.entityId} is neither unavailable nor low on battery`);
    const siblings = [...c.entities.values()].filter((e) => e.integration === target.integration && e.deviceId !== target.deviceId && e.entityId !== target.entityId && !e.restored && e.domain !== 'select');
    need(r, siblings.length === 0 || siblings.some(available), 'other devices on the same integration are fine', 'every other device on the integration is down too');
    const integ = c.view.home.integrations.find((i) => i.integration === target.integration);
    if (integ && integ.state !== 'loaded') r.contradictions.push(`${target.integration} is ${integ.state}`);
    if (c.view.home.hub.reachable === false) r.contradictions.push('the hub is unreachable');
  },
  radio_link_weak(c, r) {
    const id = c.truth[0] ?? '';
    const sig = own(c.view.home.signals, id) ?? {};
    const weak = (sig.linkQuality !== undefined && sig.linkQuality < WEAK_LQI) || (sig.rssi !== undefined && sig.rssi < WEAK_RSSI);
    need(r, weak, `weak link (LQI ${sig.linkQuality ?? 'n/a'}, RSSI ${sig.rssi ?? 'n/a'})`, 'link quality and RSSI look healthy');
    const drops = dropsIn24h(c, id);
    need(r, drops >= 1, `${drops} drop(s) in the last 24 h`, 'no drops in the last 24 h');
    const e = c.entities.get(id);
    const integ = e && c.view.home.integrations.find((i) => i.integration === e.integration);
    if (integ && integ.state !== 'loaded') r.contradictions.push(`${integ.integration} is ${integ.state}`);
  },
  hub_down(c, r) {
    const target = c.entities.get(c.truth[0] ?? '');
    if (!target) return void r.missing.push('target entity is not in the home');
    const same = [...c.entities.values()].filter((e) => e.integration === target.integration && !e.restored && e.domain !== 'select');
    const integ = c.view.home.integrations.find((i) => i.integration === target.integration);
    const allDown = same.length >= 2 && same.every((e) => e.state === 'unavailable');
    need(r, (integ !== undefined && integ.state !== 'loaded') || allDown, `${target.integration} is ${integ?.state ?? 'unknown'}, ${same.filter((e) => e.state === 'unavailable').length} of ${same.length} devices down`, `${target.integration} looks healthy`);
    const others = [...c.entities.values()].filter((e) => e.integration !== target.integration && e.domain !== 'automation' && !e.restored);
    need(r, others.length === 0 || others.some(available), 'devices on other integrations are fine', 'everything else is down too');
    if (integ && AUTH.test(integ.reason ?? '')) r.contradictions.push('the integration reports an authentication problem');
  },
  vendor_cloud_outage(c, r) {
    const target = c.entities.get(c.truth[0] ?? '');
    const vendor = (target?.vendor ?? '').toLowerCase();
    const cloud = c.view.home.cloud.find((x) => x.vendor.toLowerCase() === vendor || x.vendor.toLowerCase() === target?.integration);
    need(r, cloud !== undefined && (cloud.status === 'degraded' || cloud.status === 'outage'), `${cloud?.vendor} cloud is ${cloud?.status}`, `no degraded cloud status for ${vendor || 'the vendor'}`);
    const integ = target && c.view.home.integrations.find((i) => i.integration === target.integration);
    if (integ && integ.state === 'setup_error' && AUTH.test(integ.reason ?? '')) r.contradictions.push('the integration reports an authentication problem');
  },
  account_link_expired(c, r) {
    const target = c.entities.get(c.truth[0] ?? '');
    const integ = target && c.view.home.integrations.find((i) => i.integration === target.integration);
    need(r, integ?.state === 'setup_error' && AUTH.test(integ.reason ?? ''), `${integ?.integration} setup_error: ${integ?.reason}`, 'no integration reports an authentication error');
  },
  power_on_default_on(c, r) {
    const clusters = restartClusters(c.events).filter((cl) => {
      const integrations = new Set(cl.map((ev) => c.entities.get(ev.entityId ?? '')?.integration));
      return cl.length >= 5 && integrations.size >= 2;
    });
    const cluster = clusters.find((cl) => cl.some((ev) => c.truth.includes(ev.entityId ?? '')));
    need(r, cluster !== undefined, `${cluster?.length} devices came back within 10 s`, 'no restart cluster of 5+ devices across 2+ integrations');
    if (!cluster) return;
    const onWithoutCause = cluster.filter((ev) => ev.to === 'on' && !ev.context?.automationId && !ev.context?.userId);
    need(r, onWithoutCause.length >= 1, `${onWithoutCause.length} came back on with no automation or user behind it`, 'nothing came back on by itself');
    const start = at(cluster[0] as HouseEvent);
    const runs = c.events.filter((ev) => ev.kind === 'automation_run' && Math.abs(at(ev) - start) <= 60_000);
    if (runs.length > 0) r.contradictions.push(`${runs.length} automation run(s) within a minute of the restart`);
    const setOn = c.truth.filter((id) => own(c.view.home.signals, id)?.powerOnBehavior === 'on').length;
    const known = c.truth.filter((id) => own(c.view.home.signals, id)?.powerOnBehavior !== undefined).length;
    if (known > 0) need(r, setOn > 0, `${setOn} of the named devices start 'on' after power returns`, 'none of the named devices is set to start on');
  },
  name_collision(c, r) {
    const named = c.truth.map((id) => c.entities.get(id)).filter((e): e is Entity => e !== undefined);
    const [a, b] = named;
    need(r, named.length >= 2 && foldName(a?.name ?? '') === foldName(b?.name ?? ''), `${a?.entityId} and ${b?.entityId} share the name "${a?.name}"`, 'the named entities do not share a spoken name');
    need(r, named.length >= 2 && named.every((e) => !e.restored), 'both are live entities', 'one of them is an old restored copy');
    need(r, named.length >= 2 && a?.deviceId !== b?.deviceId, 'they are different devices', 'they are the same device');
  },
  dead_trigger(c, r) {
    const auto = c.truth.map((id) => c.entities.get(id)).find((e) => e?.domain === 'automation');
    const refs = Array.isArray(auto?.attributes.references) ? (auto?.attributes.references as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    const missingRefs = refs.filter((id) => !c.entities.has(id) || c.entities.get(id)?.restored === true);
    need(r, auto !== undefined && missingRefs.length > 0, `${auto?.entityId} references ${missingRefs.join(', ')} which no longer exists`, 'no automation references a missing entity');
  },
  wifi_network_changed(c, r) {
    const wifi = [...c.entities.values()].filter((e) => e.transport === 'wifi' && !e.restored);
    const down = wifi.filter((e) => e.state === 'unavailable');
    need(r, down.length >= 2 || (wifi.length === 1 && down.length === 1), `${down.length} of ${wifi.length} Wi-Fi devices are offline`, 'Wi-Fi devices are not offline together');
    const other = [...c.entities.values()].filter((e) => e.transport !== 'wifi' && e.transport !== 'virtual' && !e.restored && e.domain !== 'select');
    need(r, other.length === 0 || other.some(available), 'non Wi-Fi devices are fine', 'non Wi-Fi devices are down too');
    for (const e of down) {
      const integ = c.view.home.integrations.find((i) => i.integration === e.integration);
      if (integ && integ.state === 'setup_error' && AUTH.test(integ.reason ?? '')) r.contradictions.push(`${integ.integration} reports an authentication problem`);
    }
  },
};

/** Checks that the scenario carries the evidence its ground truth needs, and nothing that contradicts it. */
export function checkEvidence(s: Scenario): EvidenceReport {
  const view = s as ScenarioView;
  const c: Ctx = {
    view,
    now: Date.parse(s.now),
    entities: new Map(s.home.entities.map((e) => [e.entityId, e])),
    events: toHouseEvents(s.events),
    truth: s.ground_truth.entity_ids,
  };
  const r: EvidenceReport = { cause_id: s.ground_truth.cause_id, supported: false, found: [], missing: [], contradictions: [] };
  CHECKS[s.ground_truth.cause_id](c, r);
  if (s.human_truth.router_changed === 'yes' && s.ground_truth.cause_id !== 'wifi_network_changed') {
    r.contradictions.push('the person says the router changed');
  }
  r.supported = r.missing.length === 0 && r.contradictions.length === 0;
  return r;
}
