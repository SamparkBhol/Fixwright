// Probe library. Passive probes only read; the active flash test switches the device under test
// and reads its state back; human probes ask the person in the room. Each probe has a cost, a disruption
// level (0 passive, 1 visible, 2 power), and likelihood tables P(value | cause). Human probe tables give
// the chance the fact is true under each cause; the answer then goes through the household's noise model.
// Like the priors, the tables are model parameters, not measurements.
//
// The catch all 'unknown' takes a residual likelihood (see bayes.ts) except on the probes that ask whether
// the device works right now (availability, the flash, the person seeing it, the wall switch). There it
// also stands for a fault that is not happening at the moment, or one outside the home (the voice service,
// a routine), and those leave a device that works when tested. Without these rows a device that works
// drained the posterior into whichever cause predicted nothing either way.

import type { DiagnosisCauseId, Entity, EntityId, HouseEvent, ProbeOutcome } from '@fixwright/protocol';
import { syncHomeEvents } from './ledger.ts';
import { protectedGuard } from './guard.ts';
import {
  automationRefs,
  inferTopology,
  isGhost,
  isPhysical,
  isUnavailable,
  isUnsafeDevice,
  LOW_BATTERY_PCT,
  powerOnSelect,
  SWITCHABLE_DOMAINS,
  type HouseView,
} from './house.ts';
import type { Row } from './bayes.ts';
import { phrase } from './phrase.ts';
import type { DiagnosisSession, EngineDeps } from './types.ts';
import { brand, capitalize, deviceNoun, fold, integrationName, lowerName } from './util/text.ts';
import { DAY_MS, iso, sincePhrase } from './util/time.ts';

export interface ProbeContext {
  deps: EngineDeps;
  house: HouseView;
  session: DiagnosisSession;
  primary?: Entity;
  dut?: Entity;
  twins: Entity[];
  /** Home events for the target group, synced into the ledger (time order). */
  events: HouseEvent[];
  nowMs: number;
  /** The spoken name, as the person would say it inside a sentence ("hallway lamp"). */
  spoken: string;
  noun: string;
  /** The device under test runs on a battery: its level and the entity it was read from. */
  battery?: BatteryReading;
}

/** A battery level and where it came from: the device's own signal, or a battery sensor on the same device. */
export interface BatteryReading {
  pct: number;
  source: EntityId;
}

/**
 * The battery level of a device, from its signal or from a battery sensor on the same device (the Home
 * Assistant shape), or undefined for a device that does not run on a battery.
 */
export async function batteryOf(e: Entity | undefined, deps: Pick<EngineDeps, 'adapter'>, house: HouseView): Promise<BatteryReading | undefined> {
  if (e === undefined || e.domain === 'automation') return undefined;
  const fromSignal = (await deps.adapter.signals(e.entityId)).batteryPct;
  if (typeof fromSignal === 'number' && Number.isFinite(fromSignal)) return { pct: fromSignal, source: e.entityId };
  if (e.deviceId === undefined) return undefined;
  const sensor = house.live.find(
    (x) => x !== e && x.deviceId === e.deviceId && x.domain === 'sensor' && x.attributes['device_class'] === 'battery' && Number.isFinite(Number(x.state)) && x.state.trim() !== '',
  );
  return sensor ? { pct: Number(sensor.state), source: sensor.entityId } : undefined;
}

export interface ProbeReading {
  /** null when the probe could not tell (no signal reported, vendor status unknown). */
  value: string | null;
  detail: string;
  label?: string;
  /** Home event seqs that back the reading. The probe's own ledger event is added by the runner. */
  homeEvidence: number[];
  entityIds: EntityId[];
  data: Record<string, unknown>;
}

export interface HumanSpec {
  /** The fact a "yes" reports, and the one a "no" reports. */
  yes: string;
  no: string;
  /** The active probe that must have run in this same turn (the flash the person just saw). */
  needsFresh?: string;
  /**
   * The question, a clearer way to ask it again, and (for questions about a flash) `recall`: the way to ask
   * again when the flash cannot be repeated, which asks about the flash already done.
   */
  question(ctx: ProbeContext): { text: string; clearer: string; recall?: string };
  label(said: 'yes' | 'no', ctx: ProbeContext): string;
  detail(said: 'yes' | 'no'): string;
  /** What would settle the diagnosis if this question could be asked. */
  settle: 'dx_settle_flash' | 'dx_settle_switch' | 'dx_settle_router';
}

export type ProbeTable = Readonly<Partial<Record<DiagnosisCauseId, Row>>> & {
  readonly default: Row;
  /** P(value | unknown) when it is not the residual (see the note at the top). */
  readonly unknown?: Row;
};

export interface ProbeDef {
  id: string;
  kind: 'passive' | 'active' | 'human';
  label: string;
  costMs: number;
  disruption: 0 | 1 | 2;
  values: readonly string[];
  outcome: Readonly<Record<string, ProbeOutcome>>;
  table: ProbeTable;
  applies(ctx: ProbeContext): boolean;
  run?(ctx: ProbeContext): Promise<ProbeReading>;
  human?: HumanSpec;
}

export function row(table: ProbeTable, cause: string): Row {
  return (table as Record<string, Row | undefined>)[cause] ?? table.default;
}

const LQI_WEAK = 60;
const RSSI_WEAK = -75;
const FLAPPING = 5;

const lastTo = (events: readonly HouseEvent[], entityId: EntityId, to: string): HouseEvent | undefined =>
  [...events].reverse().find((e) => e.entityId === entityId && e.to === to && (e.kind === 'availability' || e.kind === 'state'));

function flapsFromEvents(events: readonly HouseEvent[], entityId: EntityId, nowMs: number): HouseEvent[] {
  return events.filter(
    (e) => e.entityId === entityId && e.to === 'unavailable' && e.from !== 'unavailable' && nowMs - Date.parse(e.ts) <= DAY_MS,
  );
}

/** The device under test: the one we read signals from and flash. */
const subject = (ctx: ProbeContext): Entity | undefined => ctx.dut ?? ctx.primary;

const hubReachable: ProbeDef = {
  id: 'hub_reachable',
  kind: 'passive',
  label: 'Hub',
  costMs: 300,
  disruption: 0,
  values: ['up', 'down'],
  outcome: { up: 'pass', down: 'fail' },
  table: { hub_down: { up: 0.03, down: 0.97 }, default: { up: 0.97, down: 0.03 } },
  applies: (ctx) => ctx.primary !== undefined && ctx.primary.domain !== 'automation',
  async run(ctx) {
    const p = ctx.primary as Entity;
    const [hub, integrations] = await Promise.all([ctx.deps.adapter.hubStatus(), ctx.deps.adapter.integrations()]);
    const peers = ctx.house.live.filter((e) => e.integration === p.integration && isPhysical(e));
    const offline = peers.filter(isUnavailable);
    const status = integrations.find((i) => i.integration === p.integration);
    const share = peers.length === 0 ? 0 : offline.length / peers.length;
    const down = !hub.reachable || (peers.length >= 3 && share >= 0.9) || (status !== undefined && status.state !== 'loaded' && share >= 0.8);
    const hubName = p.integration === 'hue' ? 'Hue Bridge' : `${integrationName(p.integration)} hub`;
    let homeEvidence: number[] = [];
    if (down && offline.length > 0) {
      const since = iso(ctx.nowMs - 7 * DAY_MS);
      const events = await syncHomeEvents(ctx.deps, { since, until: iso(ctx.nowMs), entityIds: offline.map((e) => e.entityId) });
      homeEvidence = offline.map((e) => lastTo(events, e.entityId, 'unavailable')?.seq).filter((s): s is number => s !== undefined);
    }
    return {
      value: down ? 'down' : 'up',
      detail: down ? `The ${hubName} isn't answering.` : `The ${hubName} answered right away.`,
      homeEvidence,
      entityIds: down ? [p.entityId, ...offline.map((e) => e.entityId)] : [p.entityId],
      data: { hub: hubName, reachable: hub.reachable, peers: peers.length, offline: offline.length, offline_ids: offline.map((e) => e.entityId) },
    };
  },
};

const entityAvailability: ProbeDef = {
  id: 'entity_availability',
  kind: 'passive',
  label: 'Availability',
  costMs: 200,
  disruption: 0,
  values: ['online', 'offline', 'flapping'],
  outcome: { online: 'pass', offline: 'fail', flapping: 'fail' },
  table: {
    stale_duplicate: { online: 0.03, offline: 0.95, flapping: 0.02 },
    device_power_lost: { online: 0.05, offline: 0.9, flapping: 0.05 },
    radio_link_weak: { online: 0.15, offline: 0.25, flapping: 0.6 },
    hub_down: { online: 0.01, offline: 0.97, flapping: 0.02 },
    vendor_cloud_outage: { online: 0.2, offline: 0.7, flapping: 0.1 },
    account_link_expired: { online: 0.1, offline: 0.85, flapping: 0.05 },
    power_on_default_on: { online: 0.9, offline: 0.05, flapping: 0.05 },
    name_collision: { online: 0.8, offline: 0.15, flapping: 0.05 },
    dead_trigger: { online: 0.6, offline: 0.35, flapping: 0.05 },
    wifi_network_changed: { online: 0.02, offline: 0.95, flapping: 0.03 },
    default: { online: 0.5, offline: 0.4, flapping: 0.1 },
    unknown: { online: 0.6, offline: 0.3, flapping: 0.1 },
  },
  applies: (ctx) => ctx.primary !== undefined && ctx.primary.domain !== 'automation',
  async run(ctx) {
    const p = ctx.primary as Entity;
    const signals = await ctx.deps.adapter.signals(p.entityId);
    const flapEvents = flapsFromEvents(ctx.events, p.entityId, ctx.nowMs);
    const flaps = Math.max(signals.flaps24h ?? 0, flapEvents.length);
    const offline = isUnavailable(p);
    const value = flaps >= FLAPPING ? 'flapping' : offline ? 'offline' : 'online';
    const since = Date.parse(p.lastChanged);
    const wentOffline = offline ? lastTo(ctx.events, p.entityId, 'unavailable') : undefined;
    const homeEvidence = value === 'flapping' ? flapEvents.map((e) => e.seq) : wentOffline ? [wentOffline.seq] : [];
    const detail =
      value === 'flapping'
        ? `${p.name} dropped off ${flaps} times in the last day.`
        : offline
          ? `The device named ${p.name} has been offline ${sincePhrase(since, ctx.nowMs, ctx.deps.settings.tz)}.`
          : `${p.name} is online.`;
    return {
      value,
      detail,
      homeEvidence,
      entityIds: [p.entityId],
      data: { entity_id: p.entityId, state: p.state, offline_since: offline ? p.lastChanged : null, flaps, restored: p.restored === true },
    };
  },
};

const linkQuality: ProbeDef = {
  id: 'link_quality',
  kind: 'passive',
  label: 'Signal',
  costMs: 200,
  disruption: 0,
  values: ['good', 'weak'],
  outcome: { good: 'pass', weak: 'fail' },
  table: {
    radio_link_weak: { good: 0.1, weak: 0.9 },
    wifi_network_changed: { good: 0.75, weak: 0.25 },
    hub_down: { good: 0.8, weak: 0.2 },
    default: { good: 0.85, weak: 0.15 },
  },
  applies: (ctx) => {
    const e = subject(ctx);
    return e !== undefined && ['zigbee', 'thread', 'wifi'].includes(e.transport) && e.domain !== 'automation';
  },
  async run(ctx) {
    const e = subject(ctx) as Entity;
    const s = await ctx.deps.adapter.signals(e.entityId);
    const isTwin = ctx.dut !== undefined && ctx.dut !== ctx.primary;
    const who = isTwin ? `The ${ctx.noun} that is online` : `The ${ctx.noun}`;
    const data = { entity_id: e.entityId, transport: e.transport, link_quality: s.linkQuality ?? null, rssi: s.rssi ?? null };
    if (e.transport === 'wifi' && s.rssi !== undefined) {
      const weak = s.rssi <= RSSI_WEAK;
      return {
        value: weak ? 'weak' : 'good',
        detail: weak ? `Its Wi-Fi signal is weak, at ${s.rssi} dBm.` : `${who} has a strong Wi-Fi signal.`,
        homeEvidence: [],
        entityIds: [e.entityId],
        data,
      };
    }
    if (e.transport !== 'wifi' && s.linkQuality !== undefined) {
      const weak = s.linkQuality < LQI_WEAK;
      return {
        value: weak ? 'weak' : 'good',
        detail: weak ? `Its signal is weak, with a link quality of ${s.linkQuality} out of 255.` : `${who} has a strong signal.`,
        homeEvidence: [],
        entityIds: [e.entityId],
        data,
      };
    }
    return { value: null, detail: 'No signal reading is available.', homeEvidence: [], entityIds: [e.entityId], data };
  },
};

const cloudStatus: ProbeDef = {
  id: 'cloud_status',
  kind: 'passive',
  label: 'Cloud',
  costMs: 600,
  disruption: 0,
  values: ['ok', 'problem'],
  outcome: { ok: 'pass', problem: 'fail' },
  table: { vendor_cloud_outage: { ok: 0.05, problem: 0.95 }, default: { ok: 0.97, problem: 0.03 } },
  applies: (ctx) => subject(ctx)?.vendor !== undefined && ctx.session.causes.includes('vendor_cloud_outage'),
  async run(ctx) {
    const e = subject(ctx) as Entity;
    const vendor = e.vendor ?? '';
    const name = brand(vendor);
    const s = await ctx.deps.adapter.cloudStatus(vendor);
    const value = s.status === 'unknown' ? null : s.status === 'ok' ? 'ok' : 'problem';
    return {
      value,
      label: `${capitalize(name)} cloud`,
      detail:
        value === null ? `I couldn't get a status from the ${name} cloud.` : value === 'ok' ? `The ${name} cloud reports no problems.` : `The ${name} cloud reports a problem.`,
      homeEvidence: [],
      entityIds: [e.entityId],
      data: { vendor, brand: name, status: s.status, source: s.source, checked_at: s.checkedAt },
    };
  },
};

const AUTH_REASON = /auth|token|credential|login|log in|password|unauthori[sz]ed|reauth|expired|sign in/i;

const integrationState: ProbeDef = {
  id: 'integration_state',
  kind: 'passive',
  label: 'Connection',
  costMs: 300,
  disruption: 0,
  values: ['loaded', 'auth_error', 'error'],
  outcome: { loaded: 'pass', auth_error: 'fail', error: 'fail' },
  table: {
    account_link_expired: { loaded: 0.05, auth_error: 0.9, error: 0.05 },
    hub_down: { loaded: 0.4, auth_error: 0.02, error: 0.58 },
    vendor_cloud_outage: { loaded: 0.7, auth_error: 0.02, error: 0.28 },
    default: { loaded: 0.95, auth_error: 0.01, error: 0.04 },
  },
  applies: (ctx) => ctx.primary !== undefined,
  async run(ctx) {
    const p = ctx.primary as Entity;
    const status = (await ctx.deps.adapter.integrations()).find((i) => i.integration === p.integration);
    const name = integrationName(p.integration);
    const data = { integration: p.integration, state: status?.state ?? null, reason: status?.reason ?? null };
    if (!status) return { value: null, detail: `No status for the ${name} connection.`, homeEvidence: [], entityIds: [p.entityId], data };
    const value = status.state === 'loaded' ? 'loaded' : status.state === 'setup_error' && AUTH_REASON.test(status.reason ?? '') ? 'auth_error' : 'error';
    const detail =
      value === 'loaded'
        ? `The ${name} connection is working.`
        : value === 'auth_error'
          ? `The ${name} connection needs you to sign in again.`
          : `The ${name} connection failed to start.`;
    return { value, detail, homeEvidence: [], entityIds: [p.entityId], data };
  },
};

// One observation for the whole signature of a device paired again (an online copy plus an old copy the
// integration no longer provides), so the copy and the leftover entry are not counted as two clues.
const duplicateNameScan: ProbeDef = {
  id: 'duplicate_name_scan',
  kind: 'passive',
  label: 'Names',
  costMs: 100,
  disruption: 0,
  values: ['unique', 'stale_pair', 'twin_online', 'twin_offline'],
  outcome: { unique: 'pass', stale_pair: 'fail', twin_online: 'fail', twin_offline: 'fail' },
  table: {
    stale_duplicate: { unique: 0.05, stale_pair: 0.8, twin_online: 0.12, twin_offline: 0.03 },
    name_collision: { unique: 0.05, stale_pair: 0.08, twin_online: 0.77, twin_offline: 0.1 },
    // A dead device is often paired again in frustration, leaving this same pattern behind.
    device_power_lost: { unique: 0.7, stale_pair: 0.2, twin_online: 0.08, twin_offline: 0.02 },
    hub_down: { unique: 0.85, stale_pair: 0.05, twin_online: 0.02, twin_offline: 0.08 },
    default: { unique: 0.88, stale_pair: 0.04, twin_online: 0.06, twin_offline: 0.02 },
  },
  applies: (ctx) => ctx.primary !== undefined && ctx.primary.domain !== 'automation',
  async run(ctx) {
    const p = ctx.primary as Entity;
    const online = ctx.twins.filter((t) => !isUnavailable(t));
    const ghost = isGhost(p, ctx.nowMs);
    const value = ctx.twins.length === 0 ? 'unique' : online.length === 0 ? 'twin_offline' : ghost ? 'stale_pair' : 'twin_online';
    const twin = online[0] ?? ctx.twins[0];
    // The first event of the online copy is when it was paired again, the moment the name split.
    const firstOfTwin = twin ? ctx.events.find((e) => e.entityId === twin.entityId) : undefined;
    const wentOffline = ghost ? lastTo(ctx.events, p.entityId, 'unavailable') : undefined;
    const sameName = twin !== undefined && fold(twin.name) === fold(p.name);
    const copy = sameName ? `A second copy of the ${ctx.noun}, also called ${p.name},` : `A second copy of the ${ctx.noun}, ${twin?.name ?? ''},`;
    const detail =
      value === 'unique'
        ? `No other device is called ${p.name}.`
        : value === 'twin_offline'
          ? `Another device called ${p.name} is offline too.`
          : value === 'stale_pair'
            ? `${copy} is online. The old one has been offline ${sincePhrase(Date.parse(p.lastChanged), ctx.nowMs, ctx.deps.settings.tz)}.`
            : `${copy} is online.`;
    return {
      value,
      detail,
      homeEvidence: [wentOffline?.seq, firstOfTwin?.seq].filter((x): x is number => x !== undefined),
      entityIds: [p.entityId, ...ctx.twins.map((t) => t.entityId)],
      data: {
        primary: p.entityId,
        lastChanged: p.lastChanged,
        restored: p.restored === true,
        registry_only: p.registryOnly === true,
        twins: ctx.twins.map((t) => ({ entity_id: t.entityId, name: t.name, state: t.state })),
      },
    };
  },
};

const registryScan: ProbeDef = {
  id: 'registry_scan',
  kind: 'passive',
  label: 'Device list',
  costMs: 100,
  disruption: 0,
  values: ['provided', 'ghost', 'orphan_ref'],
  outcome: { provided: 'pass', ghost: 'fail', orphan_ref: 'fail' },
  table: {
    stale_duplicate: { provided: 0.5, ghost: 0.45, orphan_ref: 0.05 },
    device_power_lost: { provided: 0.92, ghost: 0.06, orphan_ref: 0.02 },
    hub_down: { provided: 0.5, ghost: 0.48, orphan_ref: 0.02 },
    account_link_expired: { provided: 0.45, ghost: 0.53, orphan_ref: 0.02 },
    // A device list with every reference present all but rules a dead trigger out.
    dead_trigger: { provided: 0.02, ghost: 0.03, orphan_ref: 0.95 },
    default: { provided: 0.93, ghost: 0.05, orphan_ref: 0.02 },
  },
  // With copies around, duplicate_name_scan already reads the registry state of the old copy.
  applies: (ctx) => ctx.primary !== undefined && (ctx.twins.length === 0 || ctx.primary.domain === 'automation'),
  async run(ctx) {
    const p = ctx.primary as Entity;
    if (p.domain === 'automation') {
      const missing = automationRefs(p).filter((id) => {
        const t = ctx.house.byId.get(id);
        return t === undefined || t.registryOnly === true;
      });
      return {
        value: missing.length > 0 ? 'orphan_ref' : 'provided',
        detail: missing.length > 0 ? `${p.name} still uses a device that was removed.` : `Every device ${p.name} uses still exists.`,
        homeEvidence: [],
        entityIds: [p.entityId],
        data: { entity_id: p.entityId, missing },
      };
    }
    const ghost = isGhost(p, ctx.nowMs);
    const wentOffline = lastTo(ctx.events, p.entityId, 'unavailable');
    return {
      value: ghost ? 'ghost' : 'provided',
      detail: ghost
        ? `${p.name} is an old entry your home system no longer provides, offline ${sincePhrase(Date.parse(p.lastChanged), ctx.nowMs, ctx.deps.settings.tz)}.`
        : `${p.name} is still provided by its integration.`,
      homeEvidence: ghost && wentOffline ? [wentOffline.seq] : [],
      entityIds: [p.entityId],
      data: { entity_id: p.entityId, restored: p.restored === true, registry_only: p.registryOnly === true, lastChanged: p.lastChanged },
    };
  },
};

const powerOnSetting: ProbeDef = {
  id: 'power_on_setting',
  kind: 'passive',
  label: 'Power on setting',
  costMs: 100,
  disruption: 0,
  values: ['on', 'other'],
  outcome: { on: 'fail', other: 'pass' },
  table: { power_on_default_on: { on: 0.95, other: 0.05 }, default: { on: 0.2, other: 0.8 } },
  // Runs whenever the cause is a hypothesis, so a power on verdict always rests on the setting itself.
  applies: (ctx) => {
    const e = subject(ctx);
    return e !== undefined && SWITCHABLE_DOMAINS.has(e.domain) && ctx.session.causes.includes('power_on_default_on');
  },
  async run(ctx) {
    const e = subject(ctx) as Entity;
    const select = powerOnSelect(e, ctx.house);
    const behavior = (await ctx.deps.adapter.signals(e.entityId)).powerOnBehavior ?? select?.state;
    const value = behavior === undefined || behavior === 'unavailable' || behavior === 'unknown' ? null : behavior === 'on' ? 'on' : 'other';
    return {
      value,
      detail:
        behavior === undefined
          ? `${e.name} doesn't report a power on setting.`
          : behavior === 'on'
            ? `${e.name} is set to switch on when power comes back.`
            : `${e.name} is set to ${behavior} when power comes back.`,
      homeEvidence: [],
      entityIds: [e.entityId],
      data: { entity_id: e.entityId, power_on_behavior: behavior ?? null, select: select?.entityId ?? null },
    };
  },
};

const wifiPeers: ProbeDef = {
  id: 'wifi_peers',
  kind: 'passive',
  label: 'Other Wi-Fi devices',
  costMs: 100,
  disruption: 0,
  values: ['peers_offline', 'peers_fine'],
  outcome: { peers_offline: 'fail', peers_fine: 'pass' },
  table: { wifi_network_changed: { peers_offline: 0.85, peers_fine: 0.15 }, default: { peers_offline: 0.08, peers_fine: 0.92 } },
  applies: (ctx) => ctx.primary?.transport === 'wifi' && ctx.session.causes.includes('wifi_network_changed'),
  async run(ctx) {
    const group = new Set(ctx.session.entities.group);
    const peers = ctx.house.live.filter((e) => e.transport === 'wifi' && isPhysical(e) && !group.has(e.entityId));
    const devices = new Map<string, Entity>();
    for (const e of peers) devices.set(e.deviceId ?? e.entityId, e);
    const offline = [...devices.values()].filter(isUnavailable);
    const value = devices.size === 0 ? null : offline.length >= 2 ? 'peers_offline' : 'peers_fine';
    let homeEvidence: number[] = [];
    if (offline.length > 0) {
      const events = await syncHomeEvents(ctx.deps, {
        since: iso(ctx.nowMs - 7 * DAY_MS),
        until: iso(ctx.nowMs),
        entityIds: offline.map((e) => e.entityId),
      });
      homeEvidence = offline.map((e) => lastTo(events, e.entityId, 'unavailable')?.seq).filter((s): s is number => s !== undefined);
    }
    return {
      value,
      detail: value === 'peers_offline' ? `${offline.length} other Wi-Fi devices are offline too.` : 'Your other Wi-Fi devices are online.',
      homeEvidence,
      entityIds: offline.map((e) => e.entityId),
      data: { offline: offline.map((e) => e.entityId), peers: devices.size },
    };
  },
};

// A battery device has no wall switch: a flat battery is how it loses power, so the level is the clue.
const batteryLevel: ProbeDef = {
  id: 'battery_level',
  kind: 'passive',
  label: 'Battery',
  costMs: 100,
  disruption: 0,
  values: ['low', 'ok'],
  outcome: { low: 'fail', ok: 'pass' },
  table: {
    // A device whose battery is going flat often still reports for a while, so a low reading is a strong
    // clue but not proof (model parameters, like every table here).
    device_power_lost: { low: 0.6, ok: 0.4 },
    default: { low: 0.05, ok: 0.95 },
  },
  applies: (ctx) => ctx.battery !== undefined && ctx.session.causes.includes('device_power_lost'),
  async run(ctx) {
    const e = subject(ctx) as Entity;
    const b = ctx.battery as BatteryReading;
    const pct = Math.round(b.pct);
    const low = b.pct < LOW_BATTERY_PCT;
    return {
      value: low ? 'low' : 'ok',
      detail: low ? `The battery is at ${pct}%.` : `The battery is at ${pct}%, which is fine.`,
      homeEvidence: [],
      entityIds: [e.entityId],
      data: { entity_id: e.entityId, battery_pct: pct, battery_entity: b.source },
    };
  },
};

/** Can Fixwright flash this entity: switchable, online, not a lock or camera, and not a protected load. */
export function canFlash(e: Entity | undefined, deps: EngineDeps, house: HouseView): e is Entity {
  if (!e || !SWITCHABLE_DOMAINS.has(e.domain) || isUnavailable(e) || isUnsafeDevice(e)) return false;
  if (e.state !== 'on' && e.state !== 'off') return false;
  const topology = deps.settings.topology ?? inferTopology(house.all);
  return protectedGuard('flash', e, deps.settings.protected, topology).allow;
}

/**
 * Switches an entity to the opposite state and back, `times` times, reading the state back after each
 * command. Used by the flash test and by the repair executor's on/off check.
 */
export async function flashEntity(deps: Pick<EngineDeps, 'adapter'>, e: Pick<Entity, 'entityId' | 'domain'>, initial: string, times: number) {
  const other = initial === 'on' ? 'off' : 'on';
  const sequence = Array.from({ length: times }, () => [other, initial]).flat();
  let answered = 0;
  for (const want of sequence) {
    await deps.adapter.callService(e.domain, want === 'on' ? 'turn_on' : 'turn_off', { entity_id: e.entityId });
    const after = await deps.adapter.getEntity(e.entityId);
    if (after?.state === want) answered++;
  }
  return { commands: sequence.length, answered };
}

/** How a flash went, in the words the stepper shows. `again` marks the repeat before asking again. */
export function describeFlash(ctx: Pick<ProbeContext, 'dut' | 'primary' | 'noun'>, e: Entity, answered: number, commands: number, again = false) {
  const isTwin = ctx.dut !== undefined && ctx.primary !== undefined && ctx.dut.entityId !== ctx.primary.entityId;
  const what = isTwin ? 'the online copy' : `the ${ctx.noun}`;
  const value: 'answered' | 'no_answer' = answered === commands ? 'answered' : 'no_answer';
  const flashed = `Flashed ${what} twice${again ? ' again' : ''}.`;
  const detail =
    value === 'answered'
      ? `${flashed} It answered both times.`
      : answered === 0
        ? `${flashed} It didn't answer.`
        : `${flashed} It answered ${answered} of ${commands} commands.`;
  return { value, detail, action: `Flashed the ${isTwin ? 'online ' : ''}${e.name} twice${again ? ' again' : ''}` };
}

const flashTest: ProbeDef = {
  id: 'flash_test',
  kind: 'active',
  label: 'Flash test',
  costMs: 2500,
  disruption: 1,
  values: ['answered', 'no_answer'],
  outcome: { answered: 'pass', no_answer: 'fail' },
  table: {
    stale_duplicate: { answered: 0.95, no_answer: 0.05 },
    // Integrations report state optimistically, so a device without power can still seem to answer.
    device_power_lost: { answered: 0.85, no_answer: 0.15 },
    radio_link_weak: { answered: 0.5, no_answer: 0.5 },
    hub_down: { answered: 0.03, no_answer: 0.97 },
    vendor_cloud_outage: { answered: 0.3, no_answer: 0.7 },
    account_link_expired: { answered: 0.1, no_answer: 0.9 },
    name_collision: { answered: 0.95, no_answer: 0.05 },
    power_on_default_on: { answered: 0.95, no_answer: 0.05 },
    wifi_network_changed: { answered: 0.05, no_answer: 0.95 },
    default: { answered: 0.85, no_answer: 0.15 },
    unknown: { answered: 0.85, no_answer: 0.15 },
  },
  applies: (ctx) => canFlash(ctx.dut, ctx.deps, ctx.house),
  async run(ctx) {
    const e = ctx.dut as Entity;
    const { commands, answered } = await flashEntity(ctx.deps, e, e.state, 2);
    const { value, detail, action } = describeFlash(ctx, e, answered, commands);
    return { value, detail, homeEvidence: [], entityIds: [e.entityId], data: { entity_id: e.entityId, commands, answered, initial: e.state, action } };
  },
};

type Sense = 'see' | 'click' | 'start';

function sense(ctx: ProbeContext): Sense {
  const e = ctx.dut ?? ctx.primary;
  if (e?.domain === 'fan' || ctx.noun === 'fan') return 'start';
  if (ctx.deps.settings.preferNonVisual === true) return 'click';
  if (e?.domain === 'light' || ['lamp', 'light', 'bulb'].includes(ctx.noun)) return 'see';
  return 'click';
}

const confirmFlash: ProbeDef = {
  id: 'confirm_flash',
  kind: 'human',
  label: 'You saw it blink',
  costMs: 4000,
  disruption: 0,
  values: ['seen', 'not_seen'],
  outcome: { seen: 'pass', not_seen: 'fail' },
  table: {
    stale_duplicate: { seen: 0.97, not_seen: 0.03 },
    device_power_lost: { seen: 0.03, not_seen: 0.97 },
    radio_link_weak: { seen: 0.5, not_seen: 0.5 },
    hub_down: { seen: 0.02, not_seen: 0.98 },
    vendor_cloud_outage: { seen: 0.2, not_seen: 0.8 },
    account_link_expired: { seen: 0.1, not_seen: 0.9 },
    // The copy that answered may be a different device in another room.
    name_collision: { seen: 0.35, not_seen: 0.65 },
    power_on_default_on: { seen: 0.95, not_seen: 0.05 },
    wifi_network_changed: { seen: 0.02, not_seen: 0.98 },
    default: { seen: 0.8, not_seen: 0.2 },
    unknown: { seen: 0.85, not_seen: 0.15 },
  },
  // Only where the flash it asks about can run (not on a protected load), so no settle line offers one.
  applies: (ctx) => canFlash(ctx.dut, ctx.deps, ctx.house),
  human: {
    yes: 'seen',
    no: 'not_seen',
    needsFresh: 'flash_test',
    question(ctx) {
      const s = sense(ctx);
      const name = ctx.spoken;
      if (s === 'see') {
        return { text: phrase('dx_ask_flash', { name }), clearer: phrase('dx_reask_flash', { name }), recall: phrase('dx_recall_flash', { name }) };
      }
      return {
        text: phrase(s === 'start' ? 'dx_ask_flash_start' : 'dx_ask_flash_click', { name }),
        clearer: phrase('dx_reask_flash_click', { name }),
        recall: phrase('dx_recall_click', { name }),
      };
    },
    label(said, ctx) {
      const s = sense(ctx);
      if (s === 'see') return said === 'yes' ? 'You saw it blink' : "You didn't see it blink";
      return said === 'yes' ? 'You heard it' : "You didn't hear it";
    },
    detail: (said) => (said === 'yes' ? 'You said yes, it blinked.' : "You said it didn't blink."),
    settle: 'dx_settle_flash',
  },
};

const powerSwitchCheck: ProbeDef = {
  id: 'power_switch_check',
  kind: 'human',
  label: 'Wall switch',
  costMs: 12000,
  disruption: 0,
  values: ['on', 'off'],
  outcome: { on: 'pass', off: 'fail' },
  table: {
    device_power_lost: { on: 0.15, off: 0.85 },
    default: { on: 0.97, off: 0.03 },
    unknown: { on: 0.95, off: 0.05 },
  },
  // A battery device has no wall switch or plug to ask about (battery_level reads it instead).
  applies: (ctx) =>
    ctx.session.target.guided || (ctx.primary !== undefined && isPhysical(ctx.primary) && ctx.primary.transport !== 'cloud' && ctx.battery === undefined),
  human: {
    yes: 'on',
    no: 'off',
    question(ctx) {
      const e = ctx.primary;
      const light = e === undefined ? false : e.domain === 'light' || ['lamp', 'light', 'bulb'].includes(ctx.noun);
      const text = light ? phrase('dx_ask_wall_switch', { noun: ctx.noun }) : phrase('dx_ask_plugged_in', { name: ctx.spoken });
      return { text, clearer: phrase('dx_reask_power', { name: ctx.spoken }) };
    },
    label: (said) => (said === 'yes' ? 'Wall switch is on' : 'Wall switch is off'),
    detail: (said) => (said === 'yes' ? 'You said the wall switch is on.' : 'You said the wall switch is off.'),
    settle: 'dx_settle_switch',
  },
};

const routerChanged: ProbeDef = {
  id: 'router_changed',
  kind: 'human',
  label: 'Router',
  costMs: 6000,
  disruption: 0,
  values: ['changed', 'same'],
  outcome: { changed: 'fail', same: 'pass' },
  table: { wifi_network_changed: { changed: 0.9, same: 0.1 }, default: { changed: 0.05, same: 0.95 } },
  applies: (ctx) => ctx.session.causes.includes('wifi_network_changed'),
  human: {
    yes: 'changed',
    no: 'same',
    question: () => ({ text: phrase('dx_ask_router', {}), clearer: phrase('dx_reask_router', {}) }),
    label: (said) => (said === 'yes' ? 'Router changed' : 'Router unchanged'),
    detail: (said) => (said === 'yes' ? 'You said your router changed.' : "You said your router didn't change."),
    settle: 'dx_settle_router',
  },
};

export const PROBES: readonly ProbeDef[] = [
  hubReachable,
  entityAvailability,
  linkQuality,
  cloudStatus,
  integrationState,
  duplicateNameScan,
  registryScan,
  powerOnSetting,
  wifiPeers,
  batteryLevel,
  flashTest,
  confirmFlash,
  powerSwitchCheck,
  routerChanged,
];

export const PROBE_BY_ID: ReadonlyMap<string, ProbeDef> = new Map(PROBES.map((p) => [p.id, p]));

export function probeDef(id: string): ProbeDef {
  const p = PROBE_BY_ID.get(id);
  if (!p) throw new RangeError(`unknown probe ${id}`);
  return p;
}

/** "hallway lamp" from "Hallway Lamp", for use inside a question. */
export const spokenName = (name: string): string => lowerName(name);
export const nounFor = (e: Entity | undefined, fallback: string): string => (e ? deviceNoun(e) : fallback);
