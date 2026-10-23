// The fault library: ten behavioural faults, each tied to the cause a correct diagnosis names, the
// checkup finding it should raise, what a person in the room would see, and the dated public report
// it was modelled on. inject() changes physical truth (or config) and lets the house show the
// consequences through its normal logs; nothing is painted onto the logs directly.

import type { HumanTruth } from './scenario/types.ts';
import { int, rngFor } from './rng.ts';
import { DAY, HOUR, iso, localDayKey, MINUTE, nextDayKey, atLocal } from './time.ts';
import type { CauseId, FindingKind } from './types.ts';
import { BATTERY_DRAIN_PER_DAY, makeEntity, powerOnSelect, powerOnSelectId } from './sim/blueprint.ts';
import { isReservedKey, own } from './util.ts';
import {
  appendRow,
  derivedState,
  newContext,
  observe,
  refreshAutomationRefs,
  schedule,
  settle,
  simError,
} from './sim/engine.ts';
import type { DeviceState, EntityState, SimState } from './sim/model.ts';

export const FAULT_IDS = [
  'ghost_after_repair',
  'power_restore_default_on',
  'duplicate_spoken_name',
  'wifi_flapping',
  'low_battery',
  'vendor_cloud_outage',
  'account_link_expired',
  'hub_down',
  'dead_trigger',
  'router_ssid_change',
] as const;
export type FaultId = (typeof FAULT_IDS)[number];

export const FAULT_CODES = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'] as const;
export type FaultCode = (typeof FAULT_CODES)[number];

export interface FaultSource {
  url: string;
  /** YYYY-MM-DD */
  date: string;
  publisher: string;
  note?: string;
}

export interface FaultDef {
  id: FaultId;
  code: FaultCode;
  cause_id: CauseId;
  /** The checkup finding this fault should raise, if any. */
  finding: FindingKind | null;
  title: string;
  description: string;
  /** Entities a correct diagnosis names, in the default house. */
  entity_ids: string[];
  /** What the person in the room would answer if asked. */
  human: HumanTruth;
  sources: FaultSource[];
  /** Why a source is missing or only shows the pattern. */
  source_note?: string;
}

/** Power-on behavior 'on' out of the box: the fourteen lights and plugs that light up after an outage. */
export const DEFAULT_ON_ENTITIES: readonly string[] = [
  'light.hallway_lamp',
  'light.porch_light',
  'light.floor_lamp',
  'light.tv_backlight',
  'switch.kettle_plug',
  'light.kitchen_counter',
  'light.kitchen_pendant',
  'light.bedroom_lamp',
  'light.bedside_lamp',
  'switch.bedroom_fan',
  'light.desk_lamp',
  'switch.monitor_plug',
  'switch.workbench_plug',
  'light.garage_light',
];

const AREA_CIRCUITS = ['hallway', 'living_room', 'kitchen', 'bedroom', 'office', 'garage'] as const;

const REDDIT = 'Reddit r/alexa';

export const FAULTS: Readonly<Record<FaultId, FaultDef>> = {
  ghost_after_repair: {
    id: 'ghost_after_repair',
    code: 'F1',
    cause_id: 'stale_duplicate',
    finding: 'ghost_entity',
    title: 'Name points at an old copy',
    description:
      'The hallway lamp was paired again. Home Assistant kept the old copy as a restored entity, offline since 3 October, and the spoken name Hallway Lamp still reaches that old copy first, so voice commands say the device is not responding while the lamp itself works.',
    entity_ids: ['light.hallway_lamp', 'light.hallway_lamp_2'],
    human: { confirm_flash: 'yes', power_switch_check: 'yes', notes: 'The lamp blinks when its online copy is flashed.' },
    sources: [
      { url: 'https://www.reddit.com/r/alexa/comments/1wbmeqx/', date: '2026-09-09', publisher: REDDIT },
      {
        url: 'https://www.theverge.com/tech/1007565/amazon-alexa-plus-review-one-year-echo-show-dot-max',
        date: '2026-10-08',
        publisher: 'The Verge',
        note: 'One year review: 55 Hue devices re-added six times in a year.',
      },
    ],
  },
  power_restore_default_on: {
    id: 'power_restore_default_on',
    code: 'F2',
    cause_id: 'power_on_default_on',
    finding: 'power_on_default',
    title: 'Everything turned on after a power cut',
    description:
      'Mains power dropped at 03:11:58 and came back at 03:12:00. Fourteen Zigbee and Matter lights and plugs whose power-on behavior is on restarted and switched themselves on. No automation, service call or person was involved.',
    entity_ids: [...DEFAULT_ON_ENTITIES],
    human: { power_switch_check: 'yes', notes: 'The lights were on in the morning. Nobody switched them on.' },
    sources: [{ url: 'https://www.reddit.com/r/alexa/comments/1wo3p68/', date: '2026-09-23', publisher: REDDIT }],
  },
  duplicate_spoken_name: {
    id: 'duplicate_spoken_name',
    code: 'F3',
    cause_id: 'name_collision',
    finding: 'duplicate_name',
    title: 'Two lights answer to Living Room Light',
    description:
      'A Hue room and a Zigbee floor lamp bulb are both named Living Room Light. Both are online, so a voice command can reach the wrong one.',
    entity_ids: ['light.living_room_light', 'light.floor_lamp'],
    human: { power_switch_check: 'yes' },
    sources: [{ url: 'https://www.reddit.com/r/alexa/comments/1lpzsqw/', date: '2025-07-02', publisher: REDDIT }],
  },
  wifi_flapping: {
    id: 'wifi_flapping',
    code: 'F4',
    cause_id: 'radio_link_weak',
    finding: 'flapping',
    title: 'Kitchen plug keeps dropping off Wi-Fi',
    description:
      'The kitchen plug sits at the edge of Wi-Fi coverage (RSSI -82 dBm) and dropped off nine times today, each time for one and a quarter to four minutes.',
    entity_ids: ['switch.kitchen_plug'],
    human: { power_switch_check: 'yes', router_changed: 'no' },
    sources: [{ url: 'https://www.reddit.com/r/amazonecho/comments/1uq82cv/', date: '2026-07-07', publisher: 'Reddit r/amazonecho' }],
  },
  low_battery: {
    id: 'low_battery',
    code: 'F5',
    cause_id: 'device_power_lost',
    finding: 'low_battery',
    title: 'Hall motion sensor battery at 6%',
    description:
      'The hall motion sensor battery is at 6% and loses about 0.4% a day, so it has about two weeks left. It still reports now; when it reaches zero the sensor loses power and the hallway night light stops working.',
    entity_ids: ['binary_sensor.hall_motion'],
    human: { notes: 'The sensor looks normal. Its battery is nearly empty.' },
    sources: [],
    source_note: 'No dated public report in our corpus matched; included as the routine maintenance case a checkup must catch before it becomes a power loss.',
  },
  vendor_cloud_outage: {
    id: 'vendor_cloud_outage',
    code: 'F6',
    cause_id: 'vendor_cloud_outage',
    finding: null,
    title: "Thermostat maker's cloud is degraded",
    description: 'The ecobee cloud is degraded, so the cloud-connected thermostat shows unavailable although the house, the hub and the Wi-Fi are fine.',
    entity_ids: ['climate.thermostat'],
    human: { router_changed: 'no', power_switch_check: 'yes', notes: 'The thermostat screen works and heats normally.' },
    sources: [
      {
        url: 'https://www.reddit.com/r/alexa/comments/1qh9utk/',
        date: '2026-01-19',
        publisher: REDDIT,
        note: 'Same pattern with Hue: the vendor app works while the cloud path reports server unresponsive.',
      },
    ],
  },
  account_link_expired: {
    id: 'account_link_expired',
    code: 'F7',
    cause_id: 'account_link_expired',
    finding: 'integration_error',
    title: 'Hue account link expired',
    description: 'The Hue integration failed to set up with an authentication error, so every Hue light is unavailable until the account is linked again.',
    entity_ids: ['light.living_room_light'],
    human: { router_changed: 'no', power_switch_check: 'yes', notes: 'The Hue lights still work from the wall and the Hue app.' },
    sources: [{ url: 'https://www.reddit.com/r/alexa/comments/1v4cetj/', date: '2026-07-23', publisher: REDDIT }],
  },
  hub_down: {
    id: 'hub_down',
    code: 'F8',
    cause_id: 'hub_down',
    finding: 'integration_error',
    title: 'Zigbee coordinator not responding',
    description:
      'The Zigbee coordinator stopped responding, so Zigbee2MQTT reports the bridge offline and every Zigbee device is unavailable at once. Reloading the integration restarts it.',
    entity_ids: [
      'light.hallway_lamp',
      'binary_sensor.hall_motion',
      'light.floor_lamp',
      'switch.kettle_plug',
      'light.bedroom_lamp',
      'light.desk_lamp',
      'switch.workbench_plug',
    ],
    human: { confirm_flash: 'no', power_switch_check: 'yes', router_changed: 'no' },
    sources: [
      {
        url: 'https://www.reddit.com/r/alexa/comments/1qcuymd/',
        date: '2026-01-14',
        publisher: REDDIT,
        note: 'After a power cut every device behind one bridge stopped answering while other brands worked.',
      },
    ],
  },
  dead_trigger: {
    id: 'dead_trigger',
    code: 'F9',
    cause_id: 'dead_trigger',
    finding: 'dead_trigger',
    title: 'Grow light schedule uses a removed plug',
    description: 'The grow light plug was removed, but the Grow light schedule automation still targets it, so it runs twice a day and does nothing.',
    entity_ids: ['automation.grow_light_schedule', 'switch.grow_light'],
    human: { notes: 'The grow light stays off in the morning.' },
    sources: [
      {
        url: 'https://www.reddit.com/r/alexa/comments/1sw9b83/',
        date: '2026-04-26',
        publisher: REDDIT,
        note: 'A grow light schedule that worked for five years broke; the removed-plug mechanism is our reconstruction.',
      },
    ],
  },
  router_ssid_change: {
    id: 'router_ssid_change',
    code: 'F10',
    cause_id: 'wifi_network_changed',
    finding: null,
    title: 'Wi-Fi plugs offline after a router change',
    description:
      'The Wi-Fi router was replaced and the network name changed. Every Kasa plug still looks for the old network and is offline, while Zigbee, Thread and cloud devices are fine. The plugs keep their relays where they were, so the aquarium filter keeps running.',
    entity_ids: ['switch.living_room_power_strip', 'switch.office_power_strip', 'switch.kitchen_plug', 'switch.grow_light'],
    human: { router_changed: 'yes', power_switch_check: 'yes', confirm_flash: 'no' },
    sources: [
      {
        url: 'https://www.reddit.com/r/alexa/comments/1x25meq/',
        date: '2026-10-10',
        publisher: REDDIT,
        note: 'Support had the user remove every device and rebuild every routine.',
      },
      { url: 'https://www.reddit.com/r/alexa/comments/1wwbpd3/', date: '2026-10-03', publisher: REDDIT, note: 'New router, smart plugs stopped working.' },
    ],
  },
};

const BY_CODE: Readonly<Record<FaultCode, FaultId>> = Object.fromEntries(
  FAULT_IDS.map((id) => [FAULTS[id].code, id]),
) as Record<FaultCode, FaultId>;

/** Accepts a fault id ('hub_down') or a code ('F8'). */
export function faultId(idOrCode: string): FaultId {
  if ((FAULT_IDS as readonly string[]).includes(idOrCode)) return idOrCode as FaultId;
  const byCode = typeof idOrCode === 'string' ? own(BY_CODE, idOrCode.toUpperCase()) : undefined;
  if (byCode) return byCode;
  const shown = String(idOrCode).slice(0, 40);
  throw simError('unknown_fault', `Unknown fault ${shown}. Use one of ${FAULT_CODES.join(', ')} or ${FAULT_IDS.join(', ')}.`);
}

export type FaultOptions = Record<string, string | number | boolean>;

/** Runs fn as if the clock read ms. Used to lay down history before the simulation reaches it. */
function at<T>(s: SimState, ms: number, fn: () => T): T {
  const real = s.nowMs;
  s.nowMs = ms;
  try {
    return fn();
  } finally {
    s.nowMs = real;
  }
}

function requireEntity(s: SimState, id: string): EntityState {
  const e = own(s.entities, id);
  if (!e) throw simError('not_found', `No entity ${id}`);
  return e;
}

function requireDevice(s: SimState, e: EntityState): DeviceState {
  const d = e.deviceId ? own(s.devices, e.deviceId) : undefined;
  if (!d) throw simError('bad_request', `${e.entityId} has no device`);
  return d;
}

function freeEntityId(s: SimState, base: string): string {
  for (let n = 2; ; n++) {
    const id = `${base}_${n}`;
    if (!Object.hasOwn(s.entities, id)) return id;
  }
}

function registryRow(s: SimState, action: 'create' | 'update' | 'remove', entityId: string, changes?: Record<string, unknown>): void {
  appendRow(s, { type: 'registry', when: iso(s.nowMs), action, entity_id: entityId, ...(changes ? { changes } : {}) });
}

/** Adds a new entity to the state machine with its first state row. */
function introduce(s: SimState, e: EntityState): void {
  s.entities[e.entityId] = e;
  registryRow(s, 'create', e.entityId, { name: e.name, platform: e.integration });
  e.state = derivedState(s, e);
  e.lastChanged = iso(s.nowMs);
  e.lastUpdated = e.lastChanged;
  appendRow(s, { type: 'state', when: e.lastChanged, entity_id: e.entityId, state: e.state, context: newContext(s) });
}

function integrationRow(s: SimState, integration: string, state: 'loaded' | 'setup_error' | 'not_loaded' | 'setup_retry', reason: string | null): void {
  const integ = own(s.integrations, integration);
  if (!integ) throw simError('unknown_integration', `No integration ${integration}`);
  const old = integ.state;
  integ.state = state;
  integ.reason = reason;
  appendRow(s, {
    type: 'integration',
    when: iso(s.nowMs),
    integration,
    state,
    old_state: old,
    ...(reason ? { reason } : {}),
  });
}

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Fault options arrive from demo panels and HTTP bodies: a few short, flat values only. */
function checkOptions(opts: unknown): FaultOptions {
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) throw simError('bad_request', 'fault options must be an object');
  const keys = Object.keys(opts);
  if (keys.length > 12) throw simError('bad_request', 'at most 12 fault options');
  const out: FaultOptions = {};
  for (const key of keys) {
    if (isReservedKey(key) || !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(key)) throw simError('bad_request', `Unsupported fault option ${key.slice(0, 40)}`);
    const v = (opts as Record<string, unknown>)[key];
    if (v === undefined) continue;
    const ok = typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200);
    if (!ok) throw simError('bad_request', `Fault option ${key} must be a short string, a number or a boolean`);
    out[key] = v as string | number | boolean;
  }
  return out;
}

/** A cloud vendor key as SimHome stores it (lowercase word, never a reserved property name). */
function vendorKey(v: unknown): string {
  const vendor = str(v, 'ecobee').toLowerCase();
  if (isReservedKey(vendor) || !/^[a-z0-9_]{1,32}$/.test(vendor)) throw simError('bad_request', `Unsupported vendor ${vendor.slice(0, 40)}`);
  return vendor;
}

/** 'HH:MM-HH:MM' local time window, end after start, '24:00' allowed as the end. */
const WINDOW = /^([01]\d|2[0-3]):([0-5]\d)-(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

function checkWindow(v: unknown): void {
  if (v === undefined) return;
  const m = typeof v === 'string' ? WINDOW.exec(v) : null;
  if (!m || (m[3] ?? '') <= `${m[1]}:${m[2]}`) throw simError('bad_request', "window must look like '09:00-15:00'");
}

/** The [start, end) instants of a flapping plug's daily window on dayKey. Default: the whole day. */
function flapWindow(s: SimState, dayKey: string, opts: FaultOptions): [number, number] {
  const dayEnd = atLocal(nextDayKey(dayKey), '00:00:00', s.tz);
  const m = typeof opts.window === 'string' ? WINDOW.exec(opts.window) : null;
  if (!m) return [atLocal(dayKey, '00:00:00', s.tz), dayEnd];
  const end = m[3] === '24:00' ? dayEnd : atLocal(dayKey, `${m[3]}:00`, s.tz);
  return [atLocal(dayKey, `${m[1]}:${m[2]}:00`, s.tz), end];
}

// F1 ghost after re-pair

/** offlineAt: when the old pairing went dark. repairAt: when the lamp was paired again (at most now). */
function injectGhost(s: SimState, opts: FaultOptions, offlineAt: number, repairAt: number): void {
  const oldId = str(opts.entity, 'light.hallway_lamp');
  const ghost = requireEntity(s, oldId);
  if (ghost.restored) return;
  const oldDevice = requireDevice(s, ghost);
  const newDevice: DeviceState = { ...JSON.parse(JSON.stringify(oldDevice)), id: `${oldDevice.id}_repaired`, actuations: [] };
  s.devices[newDevice.id] = newDevice;
  oldDevice.present = false;
  oldDevice.output = false;

  // The old pairing goes dark and HA keeps it as a restored entity.
  at(s, offlineAt, () => observe(s, ghost, 'unavailable'));
  ghost.restored = true;
  ghost.attributes.restored = true;

  // The old pairing's config select is cleaned up; the re-pair creates fresh entities.
  const oldSelect = own(s.entities, powerOnSelectId(oldId));
  if (oldSelect) {
    delete s.entities[oldSelect.entityId];
    at(s, repairAt, () => registryRow(s, 'remove', oldSelect.entityId));
  }

  // The re-pair, under the same name.
  at(s, repairAt, () => {
    const newId = freeEntityId(s, oldId);
    const fresh = makeEntity(
      {
        entityId: newId,
        name: ghost.name,
        domain: ghost.domain,
        area: ghost.area,
        deviceId: newDevice.id,
        integration: ghost.integration,
        vendor: ghost.vendor,
        model: ghost.model,
        role: 'primary',
        state: 'off',
        aliases: [],
      },
      s.nowMs,
    );
    introduce(s, fresh);
    if (oldSelect) introduce(s, powerOnSelect(newDevice, newId, ghost.name, s.nowMs));
    // The owner fixed their automation and morning routine to use the new copy. The voice name was missed.
    for (const def of Object.values(s.automations)) {
      for (const t of def.triggers) {
        for (const a of t.actions) if (a.target === oldId) a.target = newId;
        if (t.kind === 'state') for (const a of t.thenActions) if (a.target === oldId) a.target = newId;
      }
    }
    s.routine.sweep = s.routine.sweep.map((id) => (id === oldId ? newId : id));
    refreshAutomationRefs(s);
  });
}

function clearGhost(s: SimState, opts: FaultOptions): void {
  const oldId = str(opts.entity, 'light.hallway_lamp');
  const ghost = own(s.entities, oldId);
  if (ghost?.restored) {
    delete s.entities[oldId];
    registryRow(s, 'remove', oldId);
  }
}

// F2 power restore, devices default to on

/** Sets the power-on behavior of every device that exposes it (its select entity follows). */
function setPowerOn(s: SimState, behavior: 'on' | 'previous'): void {
  for (const sel of Object.values(s.entities)) {
    if (sel.role !== 'power_on' || !sel.deviceId) continue;
    const d = own(s.devices, sel.deviceId);
    if (!d?.present) continue;
    d.powerOnBehavior = behavior;
    if (sel.value !== behavior) {
      sel.value = behavior;
      observe(s, sel, behavior);
    }
  }
}

/** Schedules the outage: power off at startMs, back after durationMs, on every area circuit. */
function scheduleOutage(s: SimState, startMs: number, durationMs: number, circuits: readonly string[]): void {
  schedule(s, { at: startMs, kind: 'power', circuits: [...circuits], on: false });
  schedule(s, { at: startMs + durationMs, kind: 'power', circuits: [...circuits], on: true });
}

// F4 Wi-Fi flapping

/** Drop times spread over [fromMs, toMs), at least 6 minutes apart, avoiding the blocked windows. */
export function dropTimes(seed: number, key: string, count: number, fromMs: number, toMs: number, blocked: Array<[number, number]> = []): number[] {
  const rng = rngFor(seed, 'drops', key);
  const out: number[] = [];
  let guard = 0;
  while (out.length < count && guard++ < 5000) {
    const t = fromMs + Math.floor(rng.next() * Math.max(1, toMs - fromMs - 5 * MINUTE));
    if (blocked.some(([a, b]) => t >= a && t <= b)) continue;
    if (out.some((x) => Math.abs(x - t) < 6 * MINUTE)) continue;
    out.push(t);
  }
  return out.sort((a, b) => a - b);
}

function scheduleDrops(s: SimState, deviceId: string, times: readonly number[], key: string): void {
  const rng = rngFor(s.seed, 'drop-length', key);
  // At least 75 s: long enough for two missed 30 s polls, so every drop shows in the log.
  for (const t of times) schedule(s, { at: t, kind: 'drop', deviceId, durationMs: int(rng, 75_000, 240_000) });
}

function flapDevice(s: SimState, opts: FaultOptions): DeviceState {
  return requireDevice(s, requireEntity(s, str(opts.entity, 'switch.kitchen_plug')));
}

/**
 * Applies a fault at the current virtual time. Returns how far the clock must run for the fault to
 * finish showing itself (only F2, whose outage and restart take a few seconds).
 */
export function injectFault(s: SimState, id: FaultId, options: FaultOptions = {}): { settleMs: number } {
  let opts = checkOptions(options);
  // A fault that is already active stays as it is; only the power cut (F2) is an event that can repeat.
  if (s.faults[id] && id !== 'power_restore_default_on') return { settleMs: 0 };
  const since = s.nowMs;
  let settleMs = 0;
  switch (id) {
    case 'ghost_after_repair': {
      const offlineAt = Math.min(typeof opts.offlineSince === 'number' ? opts.offlineSince : s.nowMs, s.nowMs);
      injectGhost(s, opts, offlineAt, Math.min(offlineAt + 5 * MINUTE + 25_000, s.nowMs));
      break;
    }
    case 'power_restore_default_on': {
      setPowerOn(s, 'on');
      const start = typeof opts.at === 'number' ? opts.at : s.nowMs;
      const duration = num(opts.durationMs, 2000);
      scheduleOutage(s, start, duration, AREA_CIRCUITS);
      settleMs = Math.max(0, start - s.nowMs) + duration + 4000;
      break;
    }
    case 'duplicate_spoken_name': {
      const e = requireEntity(s, str(opts.entity, 'light.floor_lamp'));
      const name = str(opts.name, 'Living Room Light');
      const when = typeof opts.at === 'number' ? Math.min(opts.at, s.nowMs) : s.nowMs;
      at(s, when, () => {
        registryRow(s, 'update', e.entityId, { name: { old: e.name, new: name } });
        e.name = name;
        e.attributes.friendly_name = name;
        e.lastUpdated = iso(s.nowMs);
      });
      break;
    }
    case 'wifi_flapping': {
      checkWindow(opts.window);
      const d = flapDevice(s, opts);
      d.rssi = num(opts.rssi, -82);
      const perDay = num(opts.perDay, 14);
      const dayKey = localDayKey(s.nowMs, s.tz);
      const [start, end] = flapWindow(s, dayKey, opts);
      const left = Math.max(0, end - Math.max(start, s.nowMs));
      const remaining = Math.round((perDay * left) / (end - start));
      const from = Math.max(start, s.nowMs + 2 * MINUTE);
      if (remaining > 0 && from < end) scheduleDrops(s, d.id, dropTimes(s.seed, `${d.id}:${dayKey}:inject`, remaining, from, end), `${dayKey}:inject`);
      opts = { ...opts, plannedDay: dayKey };
      break;
    }
    case 'low_battery': {
      const e = requireEntity(s, str(opts.entity, 'binary_sensor.hall_motion'));
      const d = requireDevice(s, e);
      if (d.power.kind !== 'battery') throw simError('bad_request', `${e.entityId} is not battery powered`);
      d.power.pct = num(opts.pct, 6);
      e.attributes.battery = Math.floor(d.power.pct);
      e.lastUpdated = iso(s.nowMs);
      break;
    }
    case 'vendor_cloud_outage': {
      const vendor = vendorKey(opts.vendor);
      const status = opts.status === 'outage' ? 'outage' : 'degraded';
      s.cloud[vendor] = { status, since: s.nowMs };
      settle(s, 'command');
      break;
    }
    case 'account_link_expired': {
      const integration = str(opts.integration, 'hue');
      integrationRow(s, integration, 'setup_error', str(opts.reason, 'invalid_auth: the account link expired. Sign in again to relink.'));
      settle(s, 'command');
      break;
    }
    case 'hub_down': {
      const integration = str(opts.integration, 'zigbee2mqtt');
      integrationRow(s, integration, 'setup_retry', str(opts.reason, 'Bridge offline: the Zigbee coordinator is not responding'));
      settle(s, 'command');
      break;
    }
    case 'dead_trigger': {
      const e = requireEntity(s, str(opts.entity, 'switch.grow_light'));
      const d = requireDevice(s, e);
      d.present = false;
      d.output = false;
      delete s.entities[e.entityId];
      registryRow(s, 'remove', e.entityId);
      settle(s, 'now');
      break;
    }
    case 'router_ssid_change': {
      s.router.ssid = str(opts.ssid, 'home-net-6e');
      settle(s, 'command');
      break;
    }
  }
  s.faults[id] = { since, opts };
  return { settleMs };
}

export function clearFault(s: SimState, id: FaultId): void {
  const active = s.faults[id];
  const opts = active?.opts ?? {};
  switch (id) {
    case 'ghost_after_repair':
      clearGhost(s, opts);
      break;
    case 'power_restore_default_on':
      setPowerOn(s, 'previous');
      break;
    case 'duplicate_spoken_name': {
      const e = own(s.entities, str(opts.entity, 'light.floor_lamp'));
      if (e && e.name !== e.originalName) {
        registryRow(s, 'update', e.entityId, { name: { old: e.name, new: e.originalName } });
        e.name = e.originalName;
        e.attributes.friendly_name = e.name;
      }
      break;
    }
    case 'wifi_flapping': {
      const e = own(s.entities, str(opts.entity, 'switch.kitchen_plug'));
      const d = e?.deviceId ? own(s.devices, e.deviceId) : undefined;
      if (d) {
        d.rssi = -61;
        d.dropUntil = 0;
        s.pending = s.pending.filter((p) => !(p.kind === 'drop' && p.deviceId === d.id));
      }
      settle(s, 'command');
      break;
    }
    case 'low_battery': {
      const e = own(s.entities, str(opts.entity, 'binary_sensor.hall_motion'));
      const d = e?.deviceId ? own(s.devices, e.deviceId) : undefined;
      if (e && d?.power.kind === 'battery') {
        d.power.pct = 100;
        e.attributes.battery = 100;
      }
      settle(s, 'now');
      break;
    }
    case 'vendor_cloud_outage':
      s.cloud[vendorKey(opts.vendor)] = { status: 'ok', since: s.nowMs };
      settle(s, 'command');
      break;
    case 'account_link_expired':
      integrationRow(s, str(opts.integration, 'hue'), 'loaded', null);
      settle(s, 'command');
      break;
    case 'hub_down':
      integrationRow(s, str(opts.integration, 'zigbee2mqtt'), 'loaded', null);
      settle(s, 'command');
      break;
    case 'dead_trigger': {
      const entityId = str(opts.entity, 'switch.grow_light');
      const device = own(s.devices, 'dev_grow_light');
      if (device && !Object.hasOwn(s.entities, entityId)) {
        device.present = true;
        introduce(
          s,
          makeEntity(
            { entityId, name: device.name, domain: 'switch', area: device.area, deviceId: device.id, integration: device.integration, vendor: device.vendor, model: device.model, role: 'primary', state: 'off' },
            s.nowMs,
          ),
        );
      }
      break;
    }
    case 'router_ssid_change':
      for (const d of Object.values(s.devices)) if (d.transport === 'wifi') d.ssid = s.router.ssid;
      settle(s, 'command');
      break;
  }
  delete s.faults[id];
}

/** Daily processes of active faults: a flapping plug keeps dropping off on every new day, inside its window. */
export function planFaultDay(s: SimState, dayKey: string, fromMs: number, _toMs: number): void {
  const flap = s.faults.wifi_flapping;
  if (flap && !(typeof flap.opts.plannedDay === 'string' && dayKey <= flap.opts.plannedDay)) {
    const e = own(s.entities, str(flap.opts.entity, 'switch.kitchen_plug'));
    const d = e?.deviceId ? own(s.devices, e.deviceId) : undefined;
    if (d) {
      const perDay = Math.max(0, Math.round(num(flap.opts.perDay, 14)));
      const count = int(rngFor(s.seed, 'drops-per-day', dayKey), Math.max(0, perDay - 2), perDay + 2);
      const [start, end] = flapWindow(s, dayKey, flap.opts);
      const from = Math.max(start, fromMs);
      const share = from < end ? Math.round((count * (end - from)) / (end - start)) : 0;
      if (share > 0) scheduleDrops(s, d.id, dropTimes(s.seed, `${d.id}:${dayKey}`, share, from, end), dayKey);
    }
  }
}

// The default demo house

export const DEMO_GHOST_SINCE_LOCAL = '2026-10-03T18:42:10';
export const DEMO_OUTAGE_CLOCK = '03:11:58';
export const DEMO_FLAPS_TODAY = 9;
/**
 * The demo kitchen plug drops off in the daytime only. So from 15:00 on the demo day until 09:00 the
 * next morning, its count for the last 24 hours stays at exactly nine: the checkup says the same thing
 * before and after the golden path's jump to 07:00.
 */
export const DEMO_FLAP_WINDOW = '09:00-15:00';
/** Battery when the demo starts: it reads 6% from the demo day through the next two midnights. */
export const DEMO_BATTERY_PCT = 6.8;

/**
 * Lays the demo faults into the history of a fresh house whose clock sits at the start of its history
 * window. targetMs is the moment the demo begins. F1 dates from 3 October, F2 is the last 03:11:58
 * before targetMs, F3 a rename three days earlier, F4 nine drops today inside the daytime window, F5 a
 * battery that reads 6%.
 */
export function setupDemoFaults(s: SimState, targetMs: number, ghostSinceMs: number, outageMs: number): void {
  injectFault(s, 'ghost_after_repair', { offlineSince: Math.min(ghostSinceMs, s.nowMs - DAY) });

  injectFault(s, 'duplicate_spoken_name', { at: Math.min(targetMs - 3 * DAY + 4 * HOUR + 20 * MINUTE, s.nowMs) });

  const kitchen = flapDevice(s, {});
  kitchen.rssi = -82;
  const dayKey = localDayKey(targetMs, s.tz);
  const midnight = atLocal(dayKey, '00:00:00', s.tz);
  const flapOpts: FaultOptions = { entity: 'switch.kitchen_plug', rssi: -82, perDay: DEMO_FLAPS_TODAY, window: DEMO_FLAP_WINDOW, plannedDay: dayKey };
  const [windowStart, windowEnd] = flapWindow(s, dayKey, flapOpts);
  // Today's nine drops fall inside the window and before the demo starts. A demo that starts too early
  // in the day for that spreads them from midnight instead.
  const latest = Math.min(windowEnd, targetMs - 10 * MINUTE);
  const from = latest - windowStart >= 3 * HOUR ? windowStart : midnight;
  // Keep the outage hour clean: "why did everything turn on at 3 a.m." reads the whole 03:00 to 03:59 window.
  const outageHour = outageMs - ((outageMs - atLocal(localDayKey(outageMs, s.tz), '00:00:00', s.tz)) % HOUR);
  const quiet: Array<[number, number]> = [[outageHour - 10 * MINUTE, outageHour + HOUR + 5 * MINUTE]];
  const today = dropTimes(s.seed, `${kitchen.id}:${dayKey}:demo`, DEMO_FLAPS_TODAY, from, latest, quiet);
  scheduleDrops(s, kitchen.id, today, `${dayKey}:demo`);
  s.faults.wifi_flapping = { since: midnight, opts: flapOpts };

  // The battery drains at every local midnight in the history window, so start it that much higher.
  let midnights = 0;
  for (let day = localDayKey(s.nowMs, s.tz); atLocal(nextDayKey(day), '00:00:00', s.tz) <= targetMs; day = nextDayKey(day)) midnights++;
  injectFault(s, 'low_battery', { pct: Math.round((DEMO_BATTERY_PCT + BATTERY_DRAIN_PER_DAY * midnights) * 10) / 10 });

  setPowerOn(s, 'on');
  scheduleOutage(s, outageMs, 2000, AREA_CIRCUITS);
  s.faults.power_restore_default_on = { since: outageMs, opts: { at: outageMs, durationMs: 2000 } };
}
