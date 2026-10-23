// The generator's own world model, deliberately separate from SimHome: a random house, a list of
// timestamped intents (people, automations, sensors, failures) and a small event-level simulator that
// turns them into Home Assistant shaped rows. Nothing here knows how any agent diagnoses.

import type { HaContext, LogRow } from '../logrows.ts';
import { between, chance, int, pick, sample, shuffle } from '../rng.ts';
import { atLocal, iso, localDayKey, nextDayKey, HOUR, MINUTE } from '../time.ts';
import type { CloudStatus, Entity, IntegrationStatus, PowerOnBehavior, Rng, Signals, Transport } from '../types.ts';
import { foldName } from '../util.ts';

export type GenKind = 'light' | 'plug' | 'motion' | 'contact' | 'temp' | 'thermostat';

export interface GenDevice {
  deviceId: string;
  entityId: string;
  name: string;
  kind: GenKind;
  domain: string;
  room: string;
  integration: string;
  transport: Transport;
  vendor: string;
  model: string;
  mains: boolean;
  battery?: number;
  lqi?: number;
  rssi?: number;
  powerOn?: PowerOnBehavior;
  /** Last boot, for Matter uptime. */
  bootMs: number;
}

export interface GenAutomation {
  entityId: string;
  name: string;
  /** Local clock times it fires, or the motion sensor that triggers it. */
  times: string[];
  motion?: string;
  targets: string[];
  service: 'turn_on' | 'turn_off';
  /** For motion: turn targets off again after this delay. */
  offAfterMs?: number;
}

export interface GenHouse {
  tz: string;
  nowMs: number;
  startMs: number;
  rooms: string[];
  devices: GenDevice[];
  automations: GenAutomation[];
  /** Entities with no live device: restored old copies. */
  ghosts: Entity[];
  integrations: Map<string, IntegrationStatus>;
  cloud: Map<string, CloudStatus['status']>;
  /** Entity ids removed from the registry (still referenced, maybe). */
  removed: Set<string>;
  users: string[];
}

export const TIME_ZONES = ['America/Los_Angeles', 'America/New_York', 'America/Chicago', 'America/Denver', 'Europe/London', 'Europe/Berlin', 'Asia/Kolkata', 'Australia/Sydney'];
const ROOMS = ['Kitchen', 'Living Room', 'Bedroom', 'Office', 'Hallway', 'Garage', 'Dining Room', 'Nursery', 'Basement', 'Porch', 'Bathroom', 'Guest Room', 'Den', 'Patio'];
const LIGHT_NAMES = ['Lamp', 'Ceiling Light', 'Pendant', 'Floor Lamp', 'Night Light', 'Light', 'Spotlights', 'Strip'];
const PLUG_NAMES = ['Plug', 'Fan', 'Heater', 'Kettle', 'Coffee Maker', 'Humidifier', 'TV', 'Speaker', 'Dehumidifier', 'Fountain'];

interface IntegrationSpec {
  transport: Transport;
  vendors: string[];
  model: string;
}

export const GEN_INTEGRATIONS: Readonly<Record<string, IntegrationSpec>> = {
  zigbee2mqtt: { transport: 'zigbee', vendors: ['IKEA', 'Aqara', 'Sonoff', 'Innr'], model: 'Zigbee device' },
  hue: { transport: 'zigbee', vendors: ['Signify'], model: 'Hue bulb' },
  matter: { transport: 'thread', vendors: ['Nanoleaf', 'Eve', 'Meross'], model: 'Matter over Thread' },
  kasa: { transport: 'wifi', vendors: ['TP-Link'], model: 'Kasa smart plug' },
  shelly: { transport: 'wifi', vendors: ['Shelly'], model: 'Shelly Plus' },
  tuya: { transport: 'cloud', vendors: ['Tuya'], model: 'Smart Life device' },
  ecobee: { transport: 'cloud', vendors: ['ecobee'], model: 'Smart Thermostat' },
};

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function uniqueEntityId(house: GenHouse, domain: string, name: string): string {
  const base = `${domain}.${slug(name)}`;
  const taken = new Set([...house.devices.map((d) => d.entityId), ...house.ghosts.map((g) => g.entityId), ...house.removed]);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

export function addDevice(rng: Rng, house: GenHouse, init: { kind: GenKind; room: string; integration: string; name?: string; powerOn?: PowerOnBehavior }): GenDevice {
  const spec = GEN_INTEGRATIONS[init.integration] ?? GEN_INTEGRATIONS.zigbee2mqtt!;
  const kind = init.kind;
  const taken = new Set([...house.devices.map((d) => foldName(d.name)), ...house.ghosts.map((g) => foldName(g.name))]);
  const thingFor = (): string =>
    init.name ?? (kind === 'light' ? pick(rng, LIGHT_NAMES) : kind === 'plug' ? pick(rng, PLUG_NAMES) : kind === 'motion' ? 'Motion Sensor' : kind === 'contact' ? 'Door Sensor' : kind === 'temp' ? 'Temperature' : 'Thermostat');
  const nameFor = (thing: string): string => (init.name && init.name.includes(' ') ? init.name : `${init.room} ${thing}`);
  // People rarely give two devices the same name by accident; the name_collision story does it on purpose.
  let name = nameFor(thingFor());
  for (let i = 0; i < 6 && taken.has(foldName(name)); i++) name = nameFor(thingFor());
  for (let n = 2; taken.has(foldName(name)); n++) name = `${nameFor(thingFor())} ${n}`;
  const domain = kind === 'light' ? 'light' : kind === 'plug' ? 'switch' : kind === 'temp' ? 'sensor' : kind === 'thermostat' ? 'climate' : 'binary_sensor';
  const mains = kind === 'light' || kind === 'plug' || kind === 'thermostat';
  const device: GenDevice = {
    deviceId: `dev_${house.devices.length + house.ghosts.length + 1}`,
    entityId: uniqueEntityId(house, domain, name),
    name,
    kind,
    domain,
    room: init.room,
    integration: init.integration,
    transport: spec.transport,
    vendor: pick(rng, spec.vendors),
    model: spec.model,
    mains,
    bootMs: house.nowMs - int(rng, 2, 40) * 24 * HOUR,
  };
  if (!mains) device.battery = int(rng, 22, 100);
  if (init.integration === 'zigbee2mqtt') device.lqi = int(rng, 90, 230);
  if (spec.transport === 'wifi') device.rssi = int(rng, -67, -42);
  if (mains && (init.integration === 'zigbee2mqtt' || init.integration === 'matter') && kind !== 'thermostat') {
    device.powerOn = init.powerOn ?? (chance(rng, 0.7) ? 'previous' : pick(rng, ['on', 'off'] as const));
  }
  house.devices.push(device);
  ensureIntegration(house, init.integration);
  return device;
}

export function ensureIntegration(house: GenHouse, integration: string): void {
  if (!house.integrations.has(integration)) {
    house.integrations.set(integration, { integration, state: 'loaded', entryId: `entry_${integration}` });
  }
  const spec = GEN_INTEGRATIONS[integration];
  if (spec?.transport === 'cloud' && !house.cloud.has(integration)) house.cloud.set(integration, 'ok');
}

/** A random house: 3 to 6 rooms, 2 to 5 devices each, from the generator's own catalog. */
export function sampleHouse(rng: Rng, nowMs: number, tz: string, windowMs: number): GenHouse {
  const house: GenHouse = {
    tz,
    nowMs,
    startMs: nowMs - windowMs,
    rooms: sample(rng, ROOMS, int(rng, 3, 6)),
    devices: [],
    automations: [],
    ghosts: [],
    integrations: new Map(),
    cloud: new Map(),
    removed: new Set(),
    users: chance(rng, 0.4) ? ['user_resident', 'user_resident_2'] : ['user_resident'],
  };
  ensureIntegration(house, 'automation');
  const lightIntegrations = shuffle(rng, ['zigbee2mqtt', 'hue', 'matter']).slice(0, int(rng, 1, 3));
  const plugIntegrations = shuffle(rng, ['kasa', 'shelly', 'zigbee2mqtt', 'matter', 'tuya']).slice(0, int(rng, 1, 3));
  for (const room of house.rooms) {
    const n = int(rng, 2, 5);
    for (let i = 0; i < n; i++) {
      const roll = rng.next();
      if (roll < 0.5) addDevice(rng, house, { kind: 'light', room, integration: pick(rng, lightIntegrations) });
      else if (roll < 0.8) addDevice(rng, house, { kind: 'plug', room, integration: pick(rng, plugIntegrations) });
      else if (roll < 0.9) addDevice(rng, house, { kind: 'motion', room, integration: 'zigbee2mqtt' });
      else if (roll < 0.95) addDevice(rng, house, { kind: 'contact', room, integration: 'zigbee2mqtt' });
      else addDevice(rng, house, { kind: 'temp', room, integration: 'zigbee2mqtt' });
    }
  }
  if (chance(rng, 0.6)) addDevice(rng, house, { kind: 'thermostat', room: house.rooms[0] ?? 'Hallway', integration: 'ecobee', name: 'Thermostat' });
  addAutomations(rng, house);
  return house;
}

const AUTOMATION_NAMES = ['Morning lights', 'Evening lights', 'Good night', 'Away mode', 'Wake up', 'Porch at dusk', 'Bedtime'];

export function addAutomations(rng: Rng, house: GenHouse): void {
  const switchable = house.devices.filter((d) => d.kind === 'light' || d.kind === 'plug');
  const motion = house.devices.find((d) => d.kind === 'motion');
  const names = shuffle(rng, AUTOMATION_NAMES);
  const count = Math.min(int(rng, 1, 3), switchable.length);
  for (let i = 0; i < count; i++) {
    const targets = sample(rng, switchable, int(rng, 1, 2)).map((d) => d.entityId);
    const on = chance(rng, 0.6);
    const name = names[i] ?? `Routine ${i + 1}`;
    house.automations.push({
      entityId: uniqueAutomationId(house, name),
      name,
      times: [on ? `${int(rng, 17, 19)}:${String(int(rng, 0, 5) * 10).padStart(2, '0')}` : `${int(rng, 22, 23)}:${String(int(rng, 0, 5) * 10).padStart(2, '0')}`],
      targets,
      service: on ? 'turn_on' : 'turn_off',
    });
  }
  if (motion && switchable.length > 0 && chance(rng, 0.6)) {
    const target = pick(rng, switchable);
    house.automations.push({ entityId: uniqueAutomationId(house, 'Night light'), name: 'Night light', times: [], motion: motion.entityId, targets: [target.entityId], service: 'turn_on', offAfterMs: 5 * MINUTE });
  }
}

function uniqueAutomationId(house: GenHouse, name: string): string {
  const base = `automation.${slug(name)}`;
  const taken = new Set(house.automations.map((a) => a.entityId));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

export const references = (a: GenAutomation): string[] => [...new Set([...(a.motion ? [a.motion] : []), ...a.targets])].sort();

export type Intent =
  | { t: number; kind: 'cmd'; entityId: string; service: 'turn_on' | 'turn_off'; by: 'voice' | 'app'; user: string }
  | { t: number; kind: 'auto'; automationId: string; source: string; service: 'turn_on' | 'turn_off'; targets: string[] }
  | { t: number; kind: 'sense'; entityId: string; to: string }
  | { t: number; kind: 'down'; entityId: string }
  | { t: number; kind: 'up'; entityId: string; to?: string }
  /** Looks available, but commands no longer reach the device (a degraded cloud). */
  | { t: number; kind: 'stuck'; entityId: string }
  /** Deleted from the registry at this time. */
  | { t: number; kind: 'remove'; entityId: string }
  | { t: number; kind: 'row'; row: LogRow };

export interface WorldState {
  state: Map<string, string>;
  lastChanged: Map<string, number>;
  /** Unreachable right now. */
  down: Set<string>;
  /** State before the entity went unavailable. */
  before: Map<string, string>;
  stuck: Set<string>;
  removed: Set<string>;
}

/** Initial states at the start of the window, chosen to look like a lived-in home. */
export function initialWorld(rng: Rng, house: GenHouse): WorldState {
  const w: WorldState = { state: new Map(), lastChanged: new Map(), down: new Set(), before: new Map(), stuck: new Set(), removed: new Set() };
  for (const d of house.devices) {
    const initial = d.kind === 'temp' ? String(between(rng, 18, 24).toFixed(1)) : d.kind === 'thermostat' ? pick(rng, ['heat', 'cool', 'heat_cool']) : d.kind === 'plug' && chance(rng, 0.3) ? 'on' : 'off';
    w.state.set(d.entityId, initial);
    w.lastChanged.set(d.entityId, house.startMs - int(rng, 1, 600) * MINUTE);
  }
  for (const g of house.ghosts) {
    w.state.set(g.entityId, 'unavailable');
    w.lastChanged.set(g.entityId, Date.parse(g.lastChanged));
    w.down.add(g.entityId);
  }
  for (const a of house.automations) {
    w.state.set(a.entityId, 'on');
    w.lastChanged.set(a.entityId, house.startMs - 30 * 24 * HOUR);
  }
  return w;
}

/** Runs intents in time order and returns the rows Home Assistant would have logged. */
export function simulate(house: GenHouse, world: WorldState, intents: readonly Intent[]): LogRow[] {
  const rows: LogRow[] = [];
  let n = 0;
  const ctx = (user?: string, parent?: string): HaContext => ({ id: `ctx_${(++n).toString(36).padStart(5, '0')}`, ...(parent ? { parent_id: parent } : {}), ...(user ? { user_id: user } : {}) });
  const exists = (id: string): boolean => world.state.has(id) && !world.removed.has(id);
  const set = (t: number, id: string, to: string, c?: HaContext): void => {
    const from = world.state.get(id);
    if (from === to) return;
    rows.push({ type: 'state', when: iso(t), entity_id: id, state: to, ...(from !== undefined ? { old_state: from } : {}), ...(c ? { context: c } : {}) });
    world.state.set(id, to);
    world.lastChanged.set(id, t);
  };
  const act = (t: number, id: string, service: 'turn_on' | 'turn_off', c: HaContext): string | undefined => {
    rows.push({ type: 'call_service', when: iso(t), domain: id.slice(0, id.indexOf('.')), service, entity_ids: [id], context: c });
    if (!exists(id)) return `Entity ${id} not found`;
    if (world.down.has(id) || world.stuck.has(id)) return undefined;
    set(t + 40, id, service === 'turn_on' ? 'on' : 'off', c);
    return undefined;
  };
  const sorted = [...intents].sort((a, b) => a.t - b.t);
  for (const it of sorted) {
    if (it.t > house.nowMs) continue;
    switch (it.kind) {
      case 'cmd':
        act(it.t, it.entityId, it.service, ctx(it.by === 'voice' ? 'user_voice_assistant' : it.user));
        break;
      case 'auto': {
        if (world.state.get(it.automationId) === 'off') break;
        const c = ctx();
        const row: LogRow = { type: 'automation_triggered', when: iso(it.t), entity_id: it.automationId, name: house.automations.find((a) => a.entityId === it.automationId)?.name ?? it.automationId, source: it.source, context: c };
        rows.push(row);
        let error: string | undefined;
        for (const target of it.targets) error = act(it.t + 20, target, it.service, c) ?? error;
        if (error) row.error = error;
        break;
      }
      case 'sense':
        if (!world.down.has(it.entityId) && exists(it.entityId)) set(it.t, it.entityId, it.to, ctx());
        break;
      case 'down':
        if (world.down.has(it.entityId) || !exists(it.entityId)) break;
        world.before.set(it.entityId, world.state.get(it.entityId) ?? 'off');
        world.down.add(it.entityId);
        set(it.t, it.entityId, 'unavailable');
        break;
      case 'up':
        if (!world.down.has(it.entityId)) break;
        world.down.delete(it.entityId);
        set(it.t, it.entityId, it.to ?? world.before.get(it.entityId) ?? 'off', ctx());
        break;
      case 'stuck':
        world.stuck.add(it.entityId);
        break;
      case 'remove':
        world.removed.add(it.entityId);
        break;
      case 'row':
        rows.push(it.row);
        break;
    }
  }
  return rows;
}

function dayKeys(house: GenHouse): string[] {
  const keys: string[] = [];
  for (let day = localDayKey(house.startMs, house.tz); ; day = nextDayKey(day)) {
    keys.push(day);
    if (day >= localDayKey(house.nowMs, house.tz)) return keys;
  }
}

const clock = (rng: Rng, fromH: number, toH: number): string => `${String(int(rng, fromH, toH)).padStart(2, '0')}:${String(int(rng, 0, 59)).padStart(2, '0')}:${String(int(rng, 0, 59)).padStart(2, '0')}`;

/** People switching things, automations on schedule, sensors reporting. `quiet` entities get no use. */
export function everydayLife(rng: Rng, house: GenHouse, quiet: ReadonlySet<string> = new Set()): Intent[] {
  const intents: Intent[] = [];
  const within = (t: number): boolean => t >= house.startMs && t <= house.nowMs;
  for (const day of dayKeys(house)) {
    for (const d of house.devices) {
      if (quiet.has(d.entityId)) continue;
      if (d.kind === 'light' || d.kind === 'plug') {
        if (chance(rng, 0.65)) {
          const by = chance(rng, 0.55) ? 'voice' : 'app';
          const on = atLocal(day, clock(rng, 17, 20), house.tz);
          const off = atLocal(day, clock(rng, 21, 23), house.tz);
          const user = pick(rng, house.users);
          if (within(on)) intents.push({ t: on, kind: 'cmd', entityId: d.entityId, service: 'turn_on', by, user });
          if (within(off)) intents.push({ t: off, kind: 'cmd', entityId: d.entityId, service: 'turn_off', by, user });
        }
        if (chance(rng, 0.3)) {
          const on = atLocal(day, clock(rng, 6, 7), house.tz);
          const off = on + int(rng, 20, 90) * MINUTE;
          const user = pick(rng, house.users);
          if (within(on)) intents.push({ t: on, kind: 'cmd', entityId: d.entityId, service: 'turn_on', by: 'app', user });
          if (within(off)) intents.push({ t: off, kind: 'cmd', entityId: d.entityId, service: 'turn_off', by: 'app', user });
        }
      } else if (d.kind === 'motion' || d.kind === 'contact') {
        for (let i = int(rng, 2, 7); i > 0; i--) {
          const t = atLocal(day, clock(rng, 0, 23), house.tz);
          if (!within(t)) continue;
          intents.push({ t, kind: 'sense', entityId: d.entityId, to: 'on' });
          intents.push({ t: t + int(rng, 30, 180) * 1000, kind: 'sense', entityId: d.entityId, to: 'off' });
          for (const a of house.automations) {
            if (a.motion !== d.entityId) continue;
            intents.push({ t: t + 300, kind: 'auto', automationId: a.entityId, source: `state of ${d.entityId}`, service: 'turn_on', targets: a.targets });
            if (a.offAfterMs) intents.push({ t: t + a.offAfterMs, kind: 'auto', automationId: a.entityId, source: `state of ${d.entityId}`, service: 'turn_off', targets: a.targets });
          }
        }
      } else if (d.kind === 'temp') {
        for (let h = 0; h < 24; h += int(rng, 2, 4)) {
          const t = atLocal(day, `${String(h).padStart(2, '0')}:${String(int(rng, 0, 59)).padStart(2, '0')}:00`, house.tz);
          if (within(t)) intents.push({ t, kind: 'sense', entityId: d.entityId, to: between(rng, 18, 24).toFixed(1) });
        }
      }
    }
    for (const a of house.automations) {
      for (const time of a.times) {
        const t = atLocal(day, `${time}:00`, house.tz);
        if (within(t)) intents.push({ t, kind: 'auto', automationId: a.entityId, source: `time pattern ${time}`, service: a.service, targets: a.targets });
      }
    }
  }
  return intents;
}

export function homeEntities(house: GenHouse, world: WorldState): Entity[] {
  const out: Entity[] = [];
  for (const d of house.devices) {
    if (house.removed.has(d.entityId)) continue;
    const changed = iso(world.lastChanged.get(d.entityId) ?? house.startMs);
    const attributes: Record<string, unknown> = { friendly_name: d.name };
    if (d.kind === 'motion') attributes.device_class = 'motion';
    if (d.kind === 'contact') attributes.device_class = 'door';
    if (d.kind === 'temp') attributes.unit_of_measurement = '°C';
    if (d.battery !== undefined) attributes.battery = d.battery;
    out.push({
      entityId: d.entityId,
      name: d.name,
      aliases: [],
      domain: d.domain,
      area: d.room.toLowerCase().replace(/ /g, '_'),
      deviceId: d.deviceId,
      integration: d.integration,
      transport: d.transport,
      vendor: d.vendor,
      model: d.model,
      state: world.state.get(d.entityId) ?? 'off',
      attributes,
      lastChanged: changed,
      lastUpdated: changed,
    });
  }
  for (const g of house.ghosts) out.push(g);
  for (const a of house.automations) {
    const changed = iso(world.lastChanged.get(a.entityId) ?? house.startMs);
    out.push({
      entityId: a.entityId,
      name: a.name,
      aliases: [],
      domain: 'automation',
      integration: 'automation',
      transport: 'virtual',
      state: world.state.get(a.entityId) ?? 'on',
      attributes: { friendly_name: a.name, references: references(a) },
      lastChanged: changed,
      lastUpdated: changed,
    });
  }
  return out.sort((a, b) => a.entityId.localeCompare(b.entityId));
}

export function homeSignals(house: GenHouse, world: WorldState): Record<string, Signals> {
  const out: Record<string, Signals> = {};
  for (const d of house.devices) {
    if (house.removed.has(d.entityId)) continue;
    const sig: Signals = {};
    const isDown = world.down.has(d.entityId);
    sig.lastSeen = iso(isDown ? (world.lastChanged.get(d.entityId) ?? house.nowMs) : house.nowMs);
    if (d.lqi !== undefined) sig.linkQuality = d.lqi;
    if (d.rssi !== undefined) sig.rssi = d.rssi;
    if (d.battery !== undefined) sig.batteryPct = d.battery;
    if (d.integration === 'matter' && !isDown) sig.uptimeS = Math.floor((house.nowMs - d.bootMs) / 1000);
    if (d.powerOn) sig.powerOnBehavior = d.powerOn;
    out[d.entityId] = sig;
  }
  for (const g of house.ghosts) out[g.entityId] = { lastSeen: g.lastChanged };
  return out;
}
