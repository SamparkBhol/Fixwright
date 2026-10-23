// The adapter's own safety check for service calls, the last line of defense under the engine's rules
// (never act on locks, garage doors, alarms, cameras or security systems). Home Assistant
// lets a call reach entities in many indirect ways: area, device, floor and label targets, entity_id
// "all", groups, cover groups and scenes that forward to their members, scripts that run anything, and
// integration services that address a device directly. The adapter resolves every target the way Home
// Assistant does (helpers/target.py and helpers/config_validation.py, 2026.9.4), but errs wide: it reads
// entity ids exactly as Home Assistant will (lower case), never leaves out hidden or diagnostic entities,
// and refuses what it cannot resolve. Everything here is pure; adapter.ts does the reads.

import type { EntityId } from '@fixwright/protocol';
import type { HaAreaEntry, HaDeviceEntry, HaState } from './ha-types.ts';
import type { Refusal } from './errors.ts';

export const DEFAULT_DENY_DOMAINS: readonly string[] = ['lock', 'alarm_control_panel', 'camera', 'siren'];
export const GARAGE_CLASSES: ReadonlySet<string> = new Set(['garage', 'gate', 'door']);

/**
 * Names that mark a device Fixwright never touches, the same words the engine uses (engine house.ts),
 * matched on the friendly name and on the entity id with underscores read as spaces.
 */
export const DEFAULT_UNSAFE_NAMES = /\b(lock|garage door|garage opener|gate|alarm|camera|security system|doorbell|siren)\b/i;

/**
 * Domains whose services act only on the entities a call targets: Home Assistant's entity platforms
 * (homeassistant/generated/entity_platforms.py, 2026.9.4) plus the helpers and core components that own
 * entities. Any other domain is an integration's own service (mqtt.publish,
 * zha.issue_zigbee_cluster_command, zwave_js.set_value, knx.send, ESPHome actions and the like), which can
 * address a device directly whatever entity it names, so the guard cannot check its reach.
 */
export const ENTITY_SERVICE_DOMAINS: ReadonlySet<string> = new Set([
  // Entity platforms.
  'ai_task', 'air_quality', 'alarm_control_panel', 'assist_satellite', 'binary_sensor', 'button', 'calendar',
  'camera', 'climate', 'conversation', 'cover', 'date', 'datetime', 'device_tracker', 'event', 'fan',
  'geo_location', 'humidifier', 'image', 'image_processing', 'infrared', 'lawn_mower', 'light', 'lock',
  'media_player', 'notify', 'number', 'radio_frequency', 'remote', 'scene', 'select', 'sensor', 'siren',
  'stt', 'switch', 'text', 'time', 'todo', 'tts', 'update', 'vacuum', 'valve', 'wake_word', 'water_heater',
  'weather',
  // Core and helper components that own entities.
  'homeassistant', 'automation', 'script', 'group', 'template', 'counter', 'timer', 'schedule', 'person',
  'zone', 'input_boolean', 'input_button', 'input_datetime', 'input_number', 'input_select', 'input_text',
]);

/**
 * Services of entity domains whose effect the adapter cannot see in advance: they run user written
 * actions, stop the hub, or send raw infrared or radio codes to whatever device listens.
 */
const UNCHECKABLE: Readonly<Record<string, ReadonlySet<string>>> = {
  automation: new Set(['trigger']),
  homeassistant: new Set(['stop', 'restart']),
  remote: new Set(['send_command', 'learn_command']),
};
/** Script services that never run the script. */
const SCRIPT_SAFE = new Set(['turn_off', 'reload']);
/** Services that start a scene or a script when they reach one (directly or through homeassistant.*). */
const ACTIVATES = new Set(['turn_on', 'toggle']);

export interface GuardPolicy {
  denyDomains: ReadonlySet<string>;
  allowGarageCovers: boolean;
  /** null turns the name rule off. */
  unsafeNames: RegExp | null;
  /**
   * 'domain.service' names let through even though the guard cannot see all they reach (integration
   * services, calls without a target). The entities they name are still checked.
   */
  allowServices: ReadonlySet<string>;
}

export interface Refused {
  refusal: Refusal;
  message: string;
}

/** Every way a service call names what it acts on, read from the top level and from `target`. */
export interface ServiceTarget {
  /** Lower cased, the way Home Assistant reads them (cv.entity_id), and valid. */
  entityIds: EntityId[];
  /** Values that are not entity ids even after lower casing; Home Assistant would reject the call. */
  invalidIds: string[];
  deviceIds: string[];
  areaIds: string[];
  floorIds: string[];
  labelIds: string[];
  /** entity_id "all" (any case): every entity of the service's domain. */
  matchAll: boolean;
}

/**
 * Home Assistant's entity id rule (core.py VALID_ENTITY_ID, 2026.9.4): slug domain and object id, no
 * double underscore, no leading or trailing underscore. Python's `\d` there is any Unicode digit.
 */
const VALID_ENTITY_ID = /^(?!.+__)(?!_)[\p{Nd}a-z_]+(?<!_)\.(?!_)[\p{Nd}a-z_]+(?<!_)$/u;

export const isValidEntityId = (id: string): boolean => VALID_ENTITY_ID.test(id);

/** What Home Assistant makes of an entity id it is given: cv.entity_id lower cases it. */
export const normalizeEntityId = (raw: string): string => raw.trim().toLowerCase();

const MATCH_ALL = 'all';
const MATCH_NONE = 'none';

/** A value Home Assistant reads as a list of ids: a comma separated string, an array, or one value. */
function listOf(value: unknown): { strings: string[]; bad: string[] } {
  if (value === undefined || value === null) return { strings: [], bad: [] };
  const list: unknown[] = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [value];
  const strings: string[] = [];
  const bad: string[] = [];
  for (const v of list) {
    if (typeof v !== 'string') bad.push(JSON.stringify(v) ?? String(v));
    else if (v.trim() !== '') strings.push(v.trim());
  }
  return { strings, bad };
}

function entityIdsOf(value: unknown): { ids: EntityId[]; invalid: string[]; matchAll: boolean } {
  const { strings, bad } = listOf(value);
  const ids: EntityId[] = [];
  const invalid = [...bad];
  let matchAll = false;
  for (const raw of strings) {
    const id = normalizeEntityId(raw);
    if (id === MATCH_ALL) matchAll = true;
    else if (id === MATCH_NONE) continue;
    else if (isValidEntityId(id)) ids.push(id);
    else invalid.push(raw);
  }
  return { ids, invalid, matchAll };
}

export function serviceTarget(data: Record<string, unknown>): ServiceTarget {
  const target = typeof data['target'] === 'object' && data['target'] !== null ? (data['target'] as Record<string, unknown>) : {};
  const invalid: string[] = [];
  let matchAll = false;
  const entities = (value: unknown): EntityId[] => {
    const r = entityIdsOf(value);
    invalid.push(...r.invalid);
    matchAll ||= r.matchAll;
    return r.ids;
  };
  const others = (key: string): string[] => {
    const r = [listOf(data[key]), listOf(target[key])];
    invalid.push(...r.flatMap((x) => x.bad));
    return [...new Set(r.flatMap((x) => x.strings).filter((v) => v.toLowerCase() !== MATCH_NONE))];
  };
  // scene.apply and scene.create name entities as data (a map of entity id to state), not as a target.
  const sceneData = data['entities'];
  const sceneIds = typeof sceneData === 'object' && sceneData !== null && !Array.isArray(sceneData) ? Object.keys(sceneData) : sceneData;
  const entityIds = [
    ...entities(data['entity_id']),
    ...entities(target['entity_id']),
    ...entities(sceneIds),
    ...entities(data['snapshot_entities']),
  ];
  return {
    entityIds: [...new Set(entityIds)],
    invalidIds: invalid,
    deviceIds: others('device_id'),
    areaIds: others('area_id'),
    floorIds: others('floor_id'),
    labelIds: others('label_id'),
    matchAll,
  };
}

export const hasIndirectTargets = (t: ServiceTarget): boolean =>
  t.deviceIds.length + t.areaIds.length + t.floorIds.length + t.labelIds.length > 0;

const unverified = (message: string): Refused => ({ refusal: 'unverified', message });

/** A refusal decided from the domain and service alone, before any target is read. */
export function serviceRefusal(domain: string, service: string, policy: GuardPolicy): Refused | undefined {
  if (policy.denyDomains.has(domain)) {
    return { refusal: 'unsafe_device', message: `Fixwright does not operate ${domain} devices` };
  }
  const name = `${domain}.${service}`;
  if (policy.allowServices.has(name)) return undefined;
  if ((domain === 'script' && !SCRIPT_SAFE.has(service)) || UNCHECKABLE[domain]?.has(service)) {
    return unverified(`${name} runs actions or sends codes Fixwright cannot check before they happen`);
  }
  if (!ENTITY_SERVICE_DOMAINS.has(domain)) {
    return unverified(`${name} is an integration service that can reach devices directly, so Fixwright cannot check what it touches`);
  }
  return undefined;
}

/**
 * A call that reaches no entity at all: Fixwright cannot see what it does (conversation.process,
 * device_tracker.see, a legacy notify service ...). Only reload services of entity domains and the
 * policy's allowServices may go without a target.
 */
export function reachRefusal(domain: string, service: string, reached: number, policy: GuardPolicy): Refused | undefined {
  if (reached > 0) return undefined;
  if ((service === 'reload' && ENTITY_SERVICE_DOMAINS.has(domain)) || policy.allowServices.has(`${domain}.${service}`)) return undefined;
  return unverified(`${domain}.${service} names no entity Fixwright can check`);
}

/** The registry rows target resolution needs (config/entity_registry/list, partial form). */
export interface TargetEntry {
  entity_id: EntityId;
  device_id: string | null;
  area_id: string | null;
  labels?: string[];
}

/**
 * Area, device, floor and label targets to entity ids, like helpers/target.py but wider: ids match in
 * any case, child devices of a targeted device count, an entity counts for its device's area even when
 * it has its own, and hidden or diagnostic entities are never skipped. Unknown device ids are returned
 * separately, because Home Assistant can split one device id into several and the adapter cannot see that.
 */
export function resolveIndirect(
  t: ServiceTarget,
  reg: { entries: readonly TargetEntry[]; devices: readonly HaDeviceEntry[]; areas: readonly HaAreaEntry[] },
): { entityIds: Set<EntityId>; unknownDevices: string[] } {
  const low = (ids: readonly string[]) => new Set(ids.map((id) => id.toLowerCase()));
  const [wantDevices, wantAreas, wantFloors, wantLabels] = [low(t.deviceIds), low(t.areaIds), low(t.floorIds), low(t.labelIds)];
  const labelled = (labels: readonly string[] | undefined) => labels?.some((l) => wantLabels.has(l.toLowerCase())) ?? false;
  const known = low(reg.devices.map((d) => d.id));
  const unknownDevices = t.deviceIds.filter((id) => !known.has(id.toLowerCase()));

  const areas = new Set<string>();
  for (const a of reg.areas) {
    const floor = a.floor_id?.toLowerCase();
    if (wantAreas.has(a.area_id.toLowerCase()) || (floor !== undefined && wantFloors.has(floor)) || labelled(a.labels)) areas.add(a.area_id);
  }

  const devices = new Set<string>();
  for (const d of reg.devices) {
    if (wantDevices.has(d.id.toLowerCase()) || labelled(d.labels) || (d.area_id !== null && areas.has(d.area_id))) devices.add(d.id);
  }
  // Children (via_device_id) of every targeted device, to any depth.
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of reg.devices) {
      if (!devices.has(d.id) && d.via_device_id && devices.has(d.via_device_id)) {
        devices.add(d.id);
        grew = true;
      }
    }
  }

  const entityIds = new Set<EntityId>();
  for (const e of reg.entries) {
    const byDevice = e.device_id !== null && devices.has(e.device_id);
    const byArea = e.area_id !== null && areas.has(e.area_id);
    if (byDevice || byArea || labelled(e.labels)) entityIds.add(normalizeEntityId(e.entity_id));
  }
  return { entityIds, unknownDevices };
}

/** Members a group, cover group, light group or scene forwards a call to (its entity_id attribute). */
export function forwardedTo(state: HaState | undefined): EntityId[] {
  const members = state?.attributes['entity_id'];
  if (!Array.isArray(members)) return [];
  return members.filter((m): m is string => typeof m === 'string').map(normalizeEntityId).filter(isValidEntityId);
}

const domainOf = (entityId: EntityId): string => entityId.slice(0, Math.max(0, entityId.indexOf('.')));

/**
 * Why one resolved entity must not be operated, or undefined when it may be. `call` is the service being
 * called: a script or an integration's scene that the call would start is refused too (homeassistant.*
 * forwards to every domain; any other domain's services act only on entities of that domain).
 */
export function entityRefusal(
  entityId: EntityId,
  state: HaState | undefined,
  policy: GuardPolicy,
  call?: { domain: string; service: string },
): Refused | undefined {
  const id = normalizeEntityId(entityId);
  const domain = domainOf(id);
  if (policy.denyDomains.has(domain)) {
    return { refusal: 'unsafe_device', message: `Fixwright does not operate ${domain} devices (${id})` };
  }
  if (domain === 'cover' && !policy.allowGarageCovers) {
    const dc = String(state?.attributes['device_class'] ?? '');
    if (GARAGE_CLASSES.has(dc)) return { refusal: 'unsafe_device', message: `Fixwright does not operate ${dc} covers (${id})` };
  }
  if (policy.unsafeNames && !(domain === 'cover' && policy.allowGarageCovers)) {
    const name = String(state?.attributes['friendly_name'] ?? '');
    const spokenId = id.slice(domain.length + 1).replace(/_/g, ' ');
    if (policy.unsafeNames.test(name) || policy.unsafeNames.test(spokenId)) {
      return { refusal: 'unsafe_device', message: `${id} (${name || spokenId}) is named like a lock, garage door, alarm or camera` };
    }
  }
  const acts = call !== undefined && (call.domain === 'homeassistant' || call.domain === domain);
  if (acts && !policy.allowServices.has(`${call.domain}.${call.service}`)) {
    if (domain === 'script' && !SCRIPT_SAFE.has(call.service)) return unverified(`${call.domain}.${call.service} would run the script ${id}`);
    // Scenes from integrations (not Home Assistant's own) do not list their members.
    if (domain === 'scene' && ACTIVATES.has(call.service) && forwardedTo(state).length === 0) {
      return unverified(`${call.domain}.${call.service} would start the scene ${id}, whose devices Fixwright cannot see`);
    }
  }
  return undefined;
}
