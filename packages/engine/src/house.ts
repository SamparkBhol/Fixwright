// Facts about entities that several parts of the engine share: which entities are live, which are old
// copies, which integrations sit behind a hub, which devices are never touched, and power strip wiring.

import type { Entity, EntityId } from '@fixwright/protocol';
import type { Outlet, PowerStrip, Topology } from './types.ts';
import { fold, tokens } from './util/text.ts';
import { DAY_MS } from './util/time.ts';

export interface HouseView {
  /** Every entity the adapter listed, including disabled ones. */
  all: Entity[];
  /** Entities that are not disabled. */
  live: Entity[];
  byId: Map<EntityId, Entity>;
}

export function houseView(entities: readonly Entity[]): HouseView {
  const all = [...entities];
  return { all, live: all.filter((e) => e.disabled !== true), byId: new Map(all.map((e) => [e.entityId, e])) };
}

export const isUnavailable = (e: Entity): boolean => e.state === 'unavailable';

/** A battery below this is low: the checkup's low_battery finding and the diagnosis's battery_level probe. */
export const LOW_BATTERY_PCT = 15;

/** An old copy: offline, no longer provided by its integration (restored or registry only), for over 24 h. */
export function isGhost(e: Entity, nowMs: number): boolean {
  if (!isUnavailable(e) && e.registryOnly !== true) return false;
  if (e.restored !== true && e.registryOnly !== true) return false;
  return nowMs - Date.parse(e.lastChanged) > DAY_MS;
}

/** Integrations that reach devices through a hub, bridge or coordinator. */
export const HUB_INTEGRATIONS: ReadonlySet<string> = new Set([
  'zigbee2mqtt', 'zha', 'deconz', 'hue', 'matter', 'thread', 'zwave_js', 'tradfri', 'homekit_controller', 'lutron_caseta', 'insteon',
]);

/** Integrations that sign in to a vendor account, so their link can expire. */
export const ACCOUNT_INTEGRATIONS: ReadonlySet<string> = new Set([
  'hue', 'ecobee', 'nest', 'tuya', 'ring', 'smartthings', 'tplink_tapo', 'wyze', 'meross_cloud', 'lifx', 'myq', 'alexa_devices',
]);

const PHYSICAL_DOMAINS: ReadonlySet<string> = new Set([
  'light', 'switch', 'fan', 'climate', 'cover', 'lock', 'sensor', 'binary_sensor', 'media_player', 'vacuum', 'humidifier',
  'water_heater', 'camera', 'siren', 'valve', 'alarm_control_panel', 'button', 'remote',
]);

export const isPhysical = (e: Entity): boolean => PHYSICAL_DOMAINS.has(e.domain) && e.transport !== 'virtual';

/** Domains Fixwright can switch on and off (the flash test, read back checks). */
export const SWITCHABLE_DOMAINS: ReadonlySet<string> = new Set(['light', 'switch', 'fan']);

const UNSAFE_DOMAINS: ReadonlySet<string> = new Set(['lock', 'alarm_control_panel', 'camera', 'siren']);
// Names that mean the device itself secures the home. "Garage Light" is a light; "Garage Door" is not.
const UNSAFE_WORDS = /\b(lock|garage door|garage opener|gate|alarm|camera|security system|doorbell|siren)\b/;

/** Locks, garage doors, alarms, cameras and security systems: Fixwright never plans or probes on them. */
export function isUnsafeDevice(e: Pick<Entity, 'domain' | 'name' | 'attributes'>): boolean {
  if (UNSAFE_DOMAINS.has(e.domain)) return true;
  const deviceClass = typeof e.attributes['device_class'] === 'string' ? e.attributes['device_class'] : '';
  if (e.domain === 'cover' && /garage|gate|door/.test(deviceClass)) return true;
  return UNSAFE_WORDS.test(fold(e.name));
}

export function objectId(entityId: EntityId): string {
  return entityId.slice(entityId.indexOf('.') + 1);
}

/** A Hue or Home Assistant light group rather than one bulb. */
export function isGroup(e: Entity): boolean {
  return (
    e.attributes['is_hue_group'] === true ||
    Array.isArray(e.attributes['entity_id']) ||
    /\bgroup\b/i.test(e.model ?? '') ||
    e.integration === 'group'
  );
}

const POWER_ON_ID = /(power_on_behaviou?r|power_on_state|start_?up_on_off|start_up_behaviou?r|power_outage_memory|restore_state)$/;
const POWER_ON_SUFFIX = new RegExp(`^${POWER_ON_ID.source}`);

/**
 * The select entity holding a device's power on behaviour (Zigbee2MQTT power_on_behavior, Matter
 * StartUpOnOff): same device, or the `select.<object id>_power_on_behavior` naming convention.
 */
export function powerOnSelect(e: Entity, house: HouseView): Entity | undefined {
  const selects = house.live.filter((s) => s.domain === 'select' && POWER_ON_ID.test(objectId(s.entityId)));
  const sameDevice = e.deviceId !== undefined ? selects.find((s) => s.deviceId === e.deviceId) : undefined;
  // By name: 'light.porch_light' has 'select.porch_light_power_on_behavior', but 'light.hallway_lamp' does
  // not own 'select.hallway_lamp_2_power_on_behavior' (that one belongs to 'light.hallway_lamp_2').
  const prefix = `${objectId(e.entityId)}_`;
  return sameDevice ?? selects.find((s) => objectId(s.entityId).startsWith(prefix) && POWER_ON_SUFFIX.test(objectId(s.entityId).slice(prefix.length)));
}

/** The option that makes a device come back the way it was: 'previous' (or 'restore', 'last'). */
export function previousOption(select: Entity): string | undefined {
  const options = Array.isArray(select.attributes['options']) ? (select.attributes['options'] as unknown[]) : [];
  const found = options.find((o): o is string => typeof o === 'string' && /previous|restore|last/i.test(o));
  return found ?? (options.length === 0 ? 'previous' : undefined);
}

/** Entity ids an automation refers to, from the attribute names Home Assistant and SimHome use. */
export function automationRefs(e: Entity): EntityId[] {
  const keys = ['entity_ids', 'references', 'entities', 'trigger_entities', 'target_entities', 'referenced_entities'];
  const refs = new Set<EntityId>();
  for (const key of keys) {
    const value = e.attributes[key];
    if (Array.isArray(value)) for (const v of value) if (typeof v === 'string' && v.includes('.')) refs.add(v);
  }
  return [...refs];
}

/** Automations that point at an entity which no longer exists (or is only a registry leftover). */
export function deadTriggers(house: HouseView): { automation: Entity; missing: EntityId[] }[] {
  const out: { automation: Entity; missing: EntityId[] }[] = [];
  for (const a of house.live) {
    if (a.domain !== 'automation') continue;
    const missing = automationRefs(a).filter((id) => {
      const target = house.byId.get(id);
      return target === undefined || target.registryOnly === true;
    });
    if (missing.length > 0) out.push({ automation: a, missing });
  }
  return out;
}

const OUTLET_ID = /^(.*)_outlet_(\d+)$/;
const isStripName = (e: Entity): boolean => tokens(e.name).includes('strip') || /power_strip/.test(objectId(e.entityId));

function outletNumber(e: Entity): number | undefined {
  const attr = e.attributes['outlet'];
  if (typeof attr === 'number' && Number.isInteger(attr)) return attr;
  const m = OUTLET_ID.exec(objectId(e.entityId));
  return m ? Number(m[2]) : undefined;
}

function outletLoad(e: Entity, n: number): string {
  for (const key of ['load', 'feeds', 'connected_load']) {
    const v = e.attributes[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return /^outlet\s*\d+$/i.test(e.name.trim()) ? `outlet ${n}` : e.name;
}

/**
 * Power strips and what each outlet feeds, from the entity list: a switch whose name says strip, plus the
 * switches on the same device (or named `<strip>_outlet_<n>`) that carry an outlet number.
 */
export function inferTopology(entities: readonly Entity[]): Topology {
  const switches = entities.filter((e) => e.domain === 'switch' && e.disabled !== true);
  const strips: PowerStrip[] = [];
  for (const strip of switches) {
    if (!isStripName(strip) || outletNumber(strip) !== undefined) continue;
    const stripObj = objectId(strip.entityId);
    const outlets: Outlet[] = [];
    for (const e of switches) {
      if (e === strip) continue;
      const n = outletNumber(e);
      if (n === undefined) continue;
      const sameDevice = strip.deviceId !== undefined && e.deviceId === strip.deviceId;
      const named = OUTLET_ID.exec(objectId(e.entityId))?.[1] === stripObj;
      const parent = e.attributes['power_strip'] === strip.entityId || e.attributes['parent'] === strip.entityId;
      if (sameDevice || named || parent) outlets.push({ entity_id: e.entityId, name: e.name, outlet: n, load: outletLoad(e, n) });
    }
    if (outlets.length > 0) {
      outlets.sort((a, b) => a.outlet - b.outlet);
      strips.push({ entity_id: strip.entityId, name: strip.name, outlets });
    }
  }
  return { strips };
}

export const ESSENTIAL_LOAD = /\b(aquarium|fish ?tank|freezer|fridge|refrigerator|grow ?lights?|filters?|pumps?|cpap|oxygen|incubator|terrarium|heat ?lamp|medical)\b/;
