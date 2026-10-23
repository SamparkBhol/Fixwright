// Pure mapping from Home Assistant wire shapes to the Fixwright protocol. No I/O, no clock, no
// randomness: everything here is a function of its arguments, so it is unit tested without a hub.

import type {
  CloudStatus,
  Entity,
  EntityId,
  EventContext,
  EventKind,
  HouseEvent,
  IntegrationStatus,
  Iso,
  Signals,
  Transport,
} from '@fixwright/protocol';
import type {
  HaAreaEntry,
  HaConfigEntry,
  HaDeviceEntry,
  HaEntityEntry,
  HaFlowProgress,
  HaHistoryPoint,
  HaState,
  LogbookRow,
} from './ha-types.ts';

/** Unix seconds (websocket) or an ISO string with any offset (REST) to epoch milliseconds. */
export function toMs(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** The protocol's ISO form: UTC with a Z suffix, millisecond precision. */
export function toIso(value: string | number | null | undefined): Iso | undefined {
  const ms = toMs(value);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

export const domainOf = (entityId: EntityId): string => entityId.slice(0, Math.max(0, entityId.indexOf('.')));
export const objectIdOf = (entityId: EntityId): string => entityId.slice(entityId.indexOf('.') + 1);

/** light.hallway_lamp -> "Hallway Lamp", used only when Home Assistant has no name at all. */
export function nameFromEntityId(entityId: EntityId): string {
  return objectIdOf(entityId)
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export const deviceName = (device: HaDeviceEntry | undefined): string | undefined =>
  device ? (device.name_by_user ?? device.name ?? undefined) : undefined;

/**
 * The friendly name Home Assistant 2026.9.4 shows for a registry entry (helpers/entity_registry.py,
 * async_get_full_entity_name, which Entity uses for the friendly_name attribute): a user override
 * replaces the whole name; otherwise the device name and the entity's own name are joined. That holds
 * for has_entity_name entities and legacy ones alike in 2026.9: for a legacy entity Home Assistant
 * first strips a leading device name from original_name (original_name_unprefixed, "" when the entity
 * is named exactly like its device), and the registry API sends that stripped form as original_name,
 * so one join covers both. Checked against every entity of the live fixture, including legacy entities
 * on a device (test/integration/ha.integration.test.ts).
 */
export function expectedFriendlyName(entry: HaEntityEntry, device: HaDeviceEntry | undefined): string | undefined {
  if (entry.name !== null && entry.name !== undefined && entry.name !== '') return entry.name;
  const joined = [deviceName(device), entry.original_name].filter((p): p is string => !!p).join(' ');
  return joined || undefined;
}

/** Spoken aliases. A null alias means "the computed name", which is already Entity.name. */
export const spokenAliases = (entry: HaEntityEntry | undefined): string[] =>
  (entry?.aliases ?? []).filter((a): a is string => typeof a === 'string' && a.trim() !== '');

export interface ManifestInfo {
  /** cloud_polling | cloud_push | local_polling | local_push | calculated | assumed_state */
  iotClass?: string;
  /** hub | device | service | helper | entity | system | virtual | hardware */
  integrationType?: string;
}

const ZIGBEE_PLATFORMS = new Set(['zha', 'deconz', 'hue', 'tradfri', 'zigbee2mqtt', 'xiaomi_aqara']);
const THREAD_PLATFORMS = new Set(['matter', 'thread', 'otbr']);
const WIFI_PLATFORMS = new Set([
  'tplink', 'kasa', 'shelly', 'esphome', 'tasmota', 'wled', 'lifx', 'yeelight', 'wemo', 'nanoleaf',
  'elgato', 'govee_light_local', 'tuya_local', 'wiz', 'switcher_kis', 'broadlink', 'sonos', 'cast',
]);
const CLOUD_PLATFORMS = new Set([
  'ecobee', 'nest', 'ring', 'tuya', 'smartthings', 'sonoff', 'august', 'yale', 'meross_cloud', 'ifttt',
  'alexa', 'google_assistant', 'tesla_fleet', 'myq', 'netatmo', 'tado', 'honeywell', 'mill',
]);
const VIRTUAL_PLATFORMS = new Set([
  'template', 'group', 'demo', 'automation', 'script', 'scene', 'sun', 'zone', 'person', 'counter',
  'timer', 'schedule', 'input_boolean', 'input_button', 'input_datetime', 'input_number', 'input_select',
  'input_text', 'utility_meter', 'derivative', 'integration', 'statistics', 'min_max', 'threshold',
  'trend', 'switch_as_x', 'shopping_list', 'backup', 'homeassistant', 'conversation', 'tts', 'stt',
]);

const isZigbee2Mqtt = (device: HaDeviceEntry | undefined): boolean =>
  !!device?.identifiers?.some(([domain, id]) => domain === 'mqtt' && /^zigbee2mqtt/i.test(id));

/**
 * Best evidence first: an explicit hint, the device's radio connections, a Zigbee2MQTT device,
 * known integrations, what the entity itself reports (linkquality means Zigbee, rssi means Wi-Fi),
 * then the integration manifest. Local network devices the tables do not know map to 'wifi',
 * because the protocol has no wired or Bluetooth transport.
 */
export function inferTransport(input: {
  entityId: EntityId;
  integration: string;
  device?: HaDeviceEntry | undefined;
  attributes?: Record<string, unknown> | undefined;
  manifest?: ManifestInfo | undefined;
  hints?: Readonly<Record<string, Transport>> | undefined;
}): Transport {
  const { entityId, integration, device, attributes = {}, manifest, hints } = input;
  const hinted = hints?.[entityId] ?? hints?.[integration];
  if (hinted) return hinted;
  const connections = device?.connections ?? [];
  if (connections.some(([kind]) => kind === 'zigbee')) return 'zigbee';
  if (isZigbee2Mqtt(device) || ZIGBEE_PLATFORMS.has(integration)) return 'zigbee';
  if (THREAD_PLATFORMS.has(integration)) return 'thread';
  if ('linkquality' in attributes || 'lqi' in attributes) return 'zigbee';
  if ('rssi' in attributes || 'wifi_signal' in attributes) return 'wifi';
  if (CLOUD_PLATFORMS.has(integration) || manifest?.iotClass?.startsWith('cloud')) return 'cloud';
  if (WIFI_PLATFORMS.has(integration)) return 'wifi';
  if (VIRTUAL_PLATFORMS.has(integration)) return 'virtual';
  if (manifest?.iotClass === 'calculated' || ['helper', 'service', 'system', 'virtual'].includes(manifest?.integrationType ?? '')) {
    return 'virtual';
  }
  // Wired and Bluetooth devices land on 'wifi' until Transport has values for them.
  if (connections.some(([kind]) => kind === 'mac')) return 'wifi';
  return device ? 'wifi' : 'virtual';
}

export interface EntityParts {
  entityId: EntityId;
  state?: HaState | undefined;
  entry?: HaEntityEntry | undefined;
  device?: HaDeviceEntry | undefined;
  area?: HaAreaEntry | undefined;
  manifest?: ManifestInfo | undefined;
  hints?: Readonly<Record<string, Transport>> | undefined;
  /** Used for lastChanged when the entity has no state and no registry timestamps. */
  fallbackIso: Iso;
}

/** The integration name Fixwright uses: the registry platform, with Zigbee2MQTT devices named as such. */
export function integrationOf(entityId: EntityId, entry: HaEntityEntry | undefined, device: HaDeviceEntry | undefined): string {
  if (!entry) return domainOf(entityId);
  if (entry.platform === 'mqtt' && isZigbee2Mqtt(device)) return 'zigbee2mqtt';
  return entry.platform;
}

export function toEntity(p: EntityParts): Entity {
  const { entityId, state, entry, device, area } = p;
  const integration = integrationOf(entityId, entry, device);
  const attributes = state?.attributes ?? {};
  const friendly = typeof attributes['friendly_name'] === 'string' ? (attributes['friendly_name'] as string) : undefined;
  const name = friendly ?? (entry ? expectedFriendlyName(entry, device) : undefined) ?? nameFromEntityId(entityId);
  const registryIso = toIso(entry?.modified_at ?? entry?.created_at);
  const lastChanged = toIso(state?.last_changed) ?? registryIso ?? p.fallbackIso;
  const lastUpdated = toIso(state?.last_updated) ?? registryIso ?? p.fallbackIso;
  const disabled = entry ? entry.disabled_by !== null && entry.disabled_by !== undefined : undefined;
  return {
    entityId,
    name,
    aliases: spokenAliases(entry),
    domain: domainOf(entityId),
    ...(area ? { area: area.name } : {}),
    ...(entry?.device_id ? { deviceId: entry.device_id } : {}),
    integration,
    transport: inferTransport({ entityId, integration, device, attributes, manifest: p.manifest, hints: p.hints }),
    ...(device?.manufacturer ? { vendor: device.manufacturer } : {}),
    ...(device?.model ? { model: device.model } : {}),
    state: state?.state ?? 'unavailable',
    attributes,
    lastChanged,
    lastUpdated,
    ...(attributes['restored'] === true ? { restored: true } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
    ...(entry && !state ? { registryOnly: true } : {}),
  };
}

export interface Registries {
  entries: ReadonlyMap<EntityId, HaEntityEntry>;
  devices: ReadonlyMap<string, HaDeviceEntry>;
  areas: ReadonlyMap<string, HaAreaEntry>;
  manifests: ReadonlyMap<string, ManifestInfo>;
}

/** The entity's area: its own, else its device's (Home Assistant's effective area). */
export function areaFor(entry: HaEntityEntry | undefined, device: HaDeviceEntry | undefined, areas: Registries['areas']): HaAreaEntry | undefined {
  const id = entry?.area_id ?? device?.area_id ?? undefined;
  return id ? areas.get(id) : undefined;
}

export function entityFrom(
  entityId: EntityId,
  state: HaState | undefined,
  reg: Registries,
  fallbackIso: Iso,
  hints?: Readonly<Record<string, Transport>>,
): Entity {
  const entry = reg.entries.get(entityId);
  const device = entry?.device_id ? reg.devices.get(entry.device_id) : undefined;
  const integration = integrationOf(entityId, entry, device);
  return toEntity({
    entityId,
    state,
    entry,
    device,
    area: areaFor(entry, device, reg.areas),
    manifest: reg.manifests.get(entry?.platform ?? integration),
    hints,
    fallbackIso,
  });
}

/** Every entity in the state machine plus every registry entry without a state (registryOnly). */
export function buildEntities(states: HaState[], reg: Registries, fallbackIso: Iso, hints?: Readonly<Record<string, Transport>>): Entity[] {
  const seen = new Set<EntityId>();
  const out: Entity[] = [];
  for (const s of states) {
    seen.add(s.entity_id);
    out.push(entityFrom(s.entity_id, s, reg, fallbackIso, hints));
  }
  for (const id of reg.entries.keys()) {
    if (!seen.has(id)) out.push(entityFrom(id, undefined, reg, fallbackIso, hints));
  }
  return out.sort((a, b) => a.entityId.localeCompare(b.entityId));
}

const AUTH_REASON = /auth|credential|token|password|unauthori[sz]ed|login|expired|forbidden/i;

/**
 * Config entry to IntegrationStatus. Failed states that are not retries count as setup_error; an entry
 * with a reauth flow in progress (Home Assistant's ConfigEntryAuthFailed) gets a reason starting "auth".
 */
export function toIntegrationStatus(entry: HaConfigEntry, reauthEntryIds: ReadonlySet<string>): IntegrationStatus {
  const reason = entry.reason ?? undefined;
  const base = { integration: entry.domain, entryId: entry.entry_id };
  if (entry.disabled_by) return { ...base, state: 'not_loaded', reason: `disabled by ${entry.disabled_by}` };
  if (reauthEntryIds.has(entry.entry_id) || (entry.state === 'setup_error' && reason && AUTH_REASON.test(reason))) {
    return { ...base, state: 'setup_error', reason: `auth: ${reason ?? 'Home Assistant asks to sign in to this integration again'}` };
  }
  switch (entry.state) {
    case 'loaded':
      return { ...base, state: 'loaded' };
    case 'setup_retry':
      return { ...base, state: 'setup_retry', ...(reason ? { reason } : {}) };
    case 'setup_error':
    case 'migration_error':
    case 'failed_unload':
      return { ...base, state: 'setup_error', reason: reason ?? entry.state };
    default:
      return { ...base, state: 'not_loaded', reason: reason ?? entry.state };
  }
}

export function reauthEntries(flows: HaFlowProgress[]): Set<string> {
  return new Set(
    flows.filter((f) => f.context?.source === 'reauth' && f.context.entry_id).map((f) => f.context?.entry_id as string),
  );
}

export const CLOUD_UNKNOWN_SOURCE = 'not available from Home Assistant';

/** Connectivity binary sensors about a cloud link: the only states in Home Assistant that speak to one. */
export function cloudSensorCandidates(states: HaState[]): HaState[] {
  return states.filter(
    (s) =>
      s.entity_id.startsWith('binary_sensor.') &&
      s.attributes['device_class'] === 'connectivity' &&
      (/cloud/i.test(s.entity_id) || /cloud/i.test(String(s.attributes['friendly_name'] ?? ''))),
  );
}

const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Home Assistant cannot see vendor clouds. Only two things in it speak to one: a connectivity sensor an
 * integration exposes for its cloud link, and a cloud integration whose config entry keeps retrying.
 * Anything else is 'unknown', said plainly.
 */
export function cloudStatusFrom(input: {
  vendor: string;
  checkedAt: Iso;
  states: HaState[];
  entries: HaConfigEntry[];
  registry: ReadonlyMap<EntityId, HaEntityEntry>;
  devices: ReadonlyMap<string, HaDeviceEntry>;
  cloudDomains: ReadonlySet<string>;
}): CloudStatus {
  const { vendor, checkedAt } = input;
  const want = fold(vendor);
  const matches = (s: string | null | undefined): boolean => !!s && want.length > 1 && fold(s).includes(want);

  const sensor = cloudSensorCandidates(input.states).find((s) => {
    const entry = input.registry.get(s.entity_id);
    const device = entry?.device_id ? input.devices.get(entry.device_id) : undefined;
    return matches(entry?.platform) || matches(device?.manufacturer) || matches(s.entity_id) || matches(String(s.attributes['friendly_name'] ?? ''));
  });
  if (sensor) {
    const status = sensor.state === 'on' ? 'ok' : sensor.state === 'off' ? 'outage' : 'unknown';
    return { vendor, status, source: `Home Assistant sensor ${sensor.entity_id} reads ${sensor.state}`, checkedAt };
  }
  const retrying = input.entries.find((e) => matches(e.domain) && input.cloudDomains.has(e.domain) && e.state === 'setup_retry');
  if (retrying) {
    return {
      vendor,
      status: 'degraded',
      source: `Home Assistant keeps retrying the ${retrying.domain} cloud integration${retrying.reason ? `: ${retrying.reason}` : ''}`,
      checkedAt,
    };
  }
  return { vendor, status: 'unknown', source: CLOUD_UNKNOWN_SOURCE, checkedAt };
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const inRange = (v: number | undefined, lo: number, hi: number): number | undefined =>
  v !== undefined && v >= lo && v <= hi ? v : undefined;

const POWER_ON_SUFFIXES = ['power_on_behavior', 'power_on_behaviour', 'power_on_state', 'start_up_behavior', 'start_up_on_off', 'startup_on_off'];
const SUFFIXES = {
  linkQuality: ['linkquality', 'lqi', 'link_quality'],
  rssi: ['rssi', 'signal_strength', 'wifi_signal', 'wifi_rssi'],
  battery: ['battery', 'battery_level'],
  lastSeen: ['last_seen'],
  uptime: ['uptime'],
} as const;

/** Maps Zigbee2MQTT, ZHA and Matter spellings of a power on behavior to the protocol's four values. */
export function normalizePowerOn(value: unknown): Signals['powerOnBehavior'] {
  if (typeof value !== 'string') return undefined;
  const v = value.toLowerCase().replace(/[^a-z]/g, '');
  if (v === 'on') return 'on';
  if (v === 'off') return 'off';
  if (v === 'toggle') return 'toggle';
  if (v === 'previous' || v === 'previousvalue' || v === 'restore' || v === 'last' || v === 'laststate') return 'previous';
  return undefined;
}

/** Which related entity carries which signal, by suffix of its object id or by its translation key. */
function signalKind(related: HaState, entry: HaEntityEntry | undefined): keyof typeof SUFFIXES | 'powerOn' | undefined {
  const objectId = objectIdOf(related.entity_id);
  const key = entry?.translation_key ?? '';
  const domain = domainOf(related.entity_id);
  const ends = (list: readonly string[]) => list.some((s) => objectId.endsWith(`_${s}`) || key === s);
  if (domain === 'select' && ends(POWER_ON_SUFFIXES)) return 'powerOn';
  if (domain !== 'sensor') return undefined;
  const dc = related.attributes['device_class'];
  if (ends(SUFFIXES.linkQuality)) return 'linkQuality';
  if (ends(SUFFIXES.rssi) || (dc === 'signal_strength' && related.attributes['unit_of_measurement'] === 'dBm')) return 'rssi';
  if (ends(SUFFIXES.battery) || dc === 'battery') return 'battery';
  if (ends(SUFFIXES.lastSeen)) return 'lastSeen';
  if (ends(SUFFIXES.uptime)) return 'uptime';
  return undefined;
}

const UPTIME_UNIT_S: Record<string, number> = { s: 1, min: 60, h: 3600, d: 86400 };

/**
 * Signals from the entity's own attributes first (Zigbee2MQTT legacy attributes, Wi-Fi plugs), then
 * from related entities: the same device's sensors and selects, or, without a device, entities named
 * <object_id>_<signal> the way Zigbee2MQTT names them. Out of range values are dropped, never clamped.
 */
export function signalsFrom(input: {
  state?: HaState | undefined;
  related: Array<{ state: HaState; entry?: HaEntityEntry | undefined }>;
  flaps24h?: number | undefined;
}): Signals {
  const a = input.state?.attributes ?? {};
  let linkQuality = num(a['linkquality'] ?? a['lqi']);
  let rssi = num(a['rssi'] ?? a['wifi_signal']);
  let batteryPct = num(a['battery'] ?? a['battery_level']);
  let lastSeen = typeof a['last_seen'] === 'string' || typeof a['last_seen'] === 'number' ? a['last_seen'] : undefined;
  let uptimeS = num(a['uptime']);
  let powerOnBehavior = normalizePowerOn(a['power_on_behavior'] ?? a['power_on_state']);

  for (const { state: rel, entry } of input.related) {
    if (rel.state === 'unavailable' || rel.state === 'unknown') continue;
    switch (signalKind(rel, entry)) {
      case 'powerOn':
        powerOnBehavior ??= normalizePowerOn(rel.state);
        break;
      case 'linkQuality':
        linkQuality ??= num(rel.state);
        break;
      case 'rssi':
        rssi ??= num(rel.state);
        break;
      case 'battery':
        batteryPct ??= num(rel.state);
        break;
      case 'lastSeen':
        lastSeen ??= rel.state;
        break;
      case 'uptime': {
        const factor = UPTIME_UNIT_S[String(rel.attributes['unit_of_measurement'] ?? 's')];
        const v = num(rel.state);
        if (factor !== undefined && v !== undefined) uptimeS ??= v * factor;
        break;
      }
      default:
        break;
    }
  }

  // Zigbee2MQTT sends last_seen as ISO or epoch milliseconds depending on its setting.
  const lastSeenIso = typeof lastSeen === 'number' ? new Date(lastSeen).toISOString() : toIso(lastSeen);
  const out: Signals = {};
  const lq = inRange(linkQuality, 0, 255);
  const rs = inRange(rssi, -150, 0);
  const bp = inRange(batteryPct, 0, 100);
  const up = inRange(uptimeS, 0, Number.MAX_SAFE_INTEGER);
  if (lq !== undefined) out.linkQuality = lq;
  if (rs !== undefined) out.rssi = rs;
  if (lastSeenIso !== undefined) out.lastSeen = lastSeenIso;
  if (bp !== undefined) out.batteryPct = bp;
  if (up !== undefined) out.uptimeS = up;
  if (powerOnBehavior !== undefined) out.powerOnBehavior = powerOnBehavior;
  if (input.flaps24h !== undefined) out.flaps24h = input.flaps24h;
  return out;
}

/** Entities that may carry signals for `entityId`: same device, else <object_id>_<suffix> by name. */
export function relatedEntityIds(entityId: EntityId, reg: { entries: ReadonlyMap<EntityId, HaEntityEntry> }, stateIds: Iterable<EntityId>): EntityId[] {
  const deviceId = reg.entries.get(entityId)?.device_id;
  if (deviceId) {
    return [...reg.entries.values()].filter((e) => e.device_id === deviceId && e.entity_id !== entityId).map((e) => e.entity_id);
  }
  const objectId = objectIdOf(entityId);
  const suffixes = [...POWER_ON_SUFFIXES, ...Object.values(SUFFIXES).flat()];
  const wanted = new Set(suffixes.flatMap((s) => [`sensor.${objectId}_${s}`, `select.${objectId}_${s}`]));
  return [...stateIds].filter((id) => wanted.has(id));
}

/** Unavailable transitions in a history series: what Fixwright calls flaps. */
export function countFlaps(points: HaHistoryPoint[]): number {
  let flaps = 0;
  let prev: string | undefined;
  for (const p of points) {
    const s = p.s ?? p.state;
    if (s === undefined) continue;
    if (s === 'unavailable' && prev !== undefined && prev !== 'unavailable') flaps++;
    prev = s;
  }
  return flaps;
}

/** What started a logbook row's context, in the protocol's terms. */
export function contextFromRow(row: LogbookRow): EventContext | undefined {
  const ctx: EventContext = {};
  const automation =
    row.context_event_type === 'automation_triggered' ||
    (row.context_domain === 'automation' && row.context_entity_id?.startsWith('automation.'));
  if (automation && row.context_entity_id) ctx.automationId = row.context_entity_id;
  if (row.context_event_type === 'call_service' && row.context_domain && row.context_service) {
    ctx.service = `${row.context_domain}.${row.context_service}`;
  }
  if (row.context_event_type === 'script_started' && row.context_entity_id) ctx.service = row.context_entity_id;
  if (row.context_user_id) ctx.userId = row.context_user_id;
  if (row.context_event_type) ctx.eventType = row.context_event_type;
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

/** automation, user, service or none: who made a change, by the protocol's context. */
export function causeOf(ctx: EventContext | undefined): 'automation' | 'user' | 'service' | 'none' {
  if (ctx?.automationId) return 'automation';
  if (ctx?.userId) return 'user';
  if (ctx?.service) return 'service';
  return 'none';
}

const NUMERIC = /^-?\d+(\.\d+)?$/;
const isNumeric = (s: string | undefined): boolean => s !== undefined && NUMERIC.test(s);

/** Sensors that report how long a device has been running, as seconds or as a boot timestamp. */
export const isUptimeSensor = (entityId: EntityId): boolean =>
  domainOf(entityId) === 'sensor' && /(^|_)(uptime|last_restart|last_boot|boot_time)$/.test(objectIdOf(entityId));
/** Battery level sensors: few changes a day, and the checkup cares how fast they fall. */
export const isBatterySensor = (entityId: EntityId): boolean =>
  domainOf(entityId) === 'sensor' && /(^|_)(battery|battery_level)$/.test(objectIdOf(entityId));

/** A boot timestamp that moves forward by more than this means the device started again. */
const BOOT_TIME_JUMP_MS = 60_000;

/**
 * Transitions where a device says it restarted (the engine accepts these as power restore evidence): a
 * numeric uptime that goes down, or a boot timestamp that moves forward by more than a minute. The
 * comparison spans unavailable gaps, so "uptime 4000, unavailable, uptime 3" is a reset.
 */
export function uptimeResets(transitions: readonly Transition[]): Set<Transition> {
  const out = new Set<Transition>();
  const last = new Map<EntityId, { ts: boolean; v: number }>();
  const reading = (value: string | undefined): { ts: boolean; v: number } | undefined => {
    if (value === undefined) return undefined;
    if (isNumeric(value)) return { ts: false, v: Number(value) };
    const ms = /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
    return Number.isFinite(ms) ? { ts: true, v: ms } : undefined;
  };
  const ordered = transitions.filter((tr) => isUptimeSensor(tr.entityId)).sort((a, b) => a.t - b.t);
  for (const tr of ordered) {
    const prev = last.get(tr.entityId) ?? reading(tr.from);
    const now = reading(tr.to);
    if (!now) continue;
    if (prev && prev.ts === now.ts && (now.ts ? now.v - prev.v > BOOT_TIME_JUMP_MS : now.v < prev.v)) out.add(tr);
    last.set(tr.entityId, now);
  }
  return out;
}

export interface Transition {
  entityId: EntityId;
  /** Epoch milliseconds, with sub-millisecond precision kept for ordering and matching. */
  t: number;
  from?: string;
  to: string;
}

/**
 * State changes inside the window from history. The first point is the state at the window start
 * (Home Assistant clamps its time to the start), so it is a baseline, not a change. Repeated states are
 * attribute-only updates and are skipped.
 */
export function historyTransitions(history: Record<EntityId, HaHistoryPoint[]>, sinceMs: number): Transition[] {
  const out: Transition[] = [];
  for (const [entityId, points] of Object.entries(history)) {
    let prev: string | undefined;
    points.forEach((p, i) => {
      const s = p.s ?? p.state;
      const t = p.lc !== undefined ? p.lc * 1000 : p.lu !== undefined ? p.lu * 1000 : toMs(p.last_changed ?? p.last_updated);
      if (s === undefined || t === undefined) return;
      if (i === 0 && t <= sinceMs + 1) {
        prev = s;
        return;
      }
      if (s !== prev) out.push({ entityId, t, ...(prev !== undefined ? { from: prev } : {}), to: s });
      prev = s;
    });
  }
  return out;
}

const kindFor = (from: string | undefined, to: string): EventKind =>
  to === 'unavailable' || from === 'unavailable' ? 'availability' : 'state';

function rowData(row: LogbookRow): Record<string, unknown> | undefined {
  const data: Record<string, unknown> = {};
  if (row.name) data['name'] = row.name;
  if (row.context_entity_id && row.context_event_type !== 'automation_triggered') data['contextEntityId'] = row.context_entity_id;
  if (row.context_id) data['contextId'] = row.context_id;
  return Object.keys(data).length ? data : undefined;
}

/** A logbook row that is not a state change: an automation run, a script, Home Assistant itself. */
function nonStateEvent(row: LogbookRow, t: number): HouseEvent | undefined {
  const ts = new Date(t).toISOString();
  const entityId = row.entity_id;
  const context = contextFromRow(row);
  if (row.domain === 'automation' && entityId?.startsWith('automation.')) {
    return {
      seq: 0,
      ts,
      kind: 'automation_run',
      entityId,
      context: { ...context, automationId: entityId, eventType: 'automation_triggered' },
      source: 'home',
      data: { ...(row.name ? { name: row.name } : {}), ...(row.source || row.message ? { trigger: row.source ?? row.message } : {}) },
    };
  }
  if (row.domain === 'script' && entityId?.startsWith('script.')) {
    return {
      seq: 0,
      ts,
      kind: 'service_call',
      entityId,
      context: { ...context, service: entityId, eventType: 'script_started' },
      source: 'home',
      data: { ...(row.name ? { name: row.name } : {}), ...(row.source || row.message ? { trigger: row.source ?? row.message } : {}) },
    };
  }
  if (!row.message && !row.name) return undefined;
  const isCore = row.domain === 'homeassistant';
  return {
    seq: 0,
    ts,
    kind: isCore ? 'integration' : 'note',
    ...(entityId ? { entityId } : {}),
    ...(context ? { context } : {}),
    source: 'home',
    data: {
      ...(isCore ? { integration: 'homeassistant' } : {}),
      ...(row.domain ? { domain: row.domain } : {}),
      ...(row.name ? { name: row.name } : {}),
      ...(row.message ? { message: row.message } : {}),
    },
  };
}

export interface MergeOptions {
  sinceMs: number;
  untilMs: number;
  /**
   * 'drop' leaves out number-to-number sensor changes (power readings, temperatures and the like),
   * except battery levels and uptime resets. 'keep' keeps every change. Either way an uptime reset
   * carries data.uptime_reset = true, which the engine reads as a device restart.
   */
  numericChanges: 'drop' | 'keep';
  /** Sensors with device class battery, kept like `*_battery` ids whatever their id. */
  batteryIds?: ReadonlySet<EntityId>;
}

/**
 * History gives every state change with its previous state; the logbook gives who caused it. They share
 * the exact timestamp (logbook `when` is the state's last_updated), so each change is joined with the
 * logbook row for the same entity, state and time. Logbook rows with no matching change (an entity not
 * in the history query) still become events, and rows that are not state changes become their own kinds.
 */
export function mergeEvents(transitions: Transition[], rows: LogbookRow[], opts: MergeOptions): HouseEvent[] {
  type Slot = { row: LogbookRow; t: number; used: boolean };
  const byEntity = new Map<EntityId, Slot[]>();
  const items: Array<{ t: number; order: number; event: HouseEvent }> = [];
  let order = 0;

  for (const row of rows) {
    const t = toMs(row.when);
    if (t === undefined || t < opts.sinceMs - 1 || t > opts.untilMs + 1) continue;
    if (row.state !== undefined && row.entity_id) {
      const list = byEntity.get(row.entity_id) ?? [];
      list.push({ row, t, used: false });
      byEntity.set(row.entity_id, list);
    } else {
      const event = nonStateEvent(row, t);
      if (event) items.push({ t, order: order++, event });
    }
  }

  const resets = uptimeResets(transitions);
  const keep = (tr: Transition) =>
    opts.numericChanges === 'keep' || !(isNumeric(tr.from) && isNumeric(tr.to)) || resets.has(tr) || isBatterySensor(tr.entityId) || (opts.batteryIds?.has(tr.entityId) ?? false);

  for (const tr of transitions) {
    if (tr.t < opts.sinceMs - 1 || tr.t > opts.untilMs + 1 || !keep(tr)) continue;
    const slots = byEntity.get(tr.entityId) ?? [];
    let best: Slot | undefined;
    for (const s of slots) {
      if (s.used || s.row.state !== tr.to || Math.abs(s.t - tr.t) > 2) continue;
      if (!best || Math.abs(s.t - tr.t) < Math.abs(best.t - tr.t)) best = s;
    }
    if (best) best.used = true;
    const context = best ? contextFromRow(best.row) : undefined;
    const rowFields = best ? rowData(best.row) : undefined;
    const data = resets.has(tr) ? { ...rowFields, uptime_reset: true } : rowFields;
    items.push({
      t: tr.t,
      order: order++,
      event: {
        seq: 0,
        ts: new Date(tr.t).toISOString(),
        kind: kindFor(tr.from, tr.to),
        entityId: tr.entityId,
        ...(tr.from !== undefined ? { from: tr.from } : {}),
        to: tr.to,
        ...(context ? { context } : {}),
        source: 'home',
        ...(data ? { data } : {}),
      },
    });
  }

  for (const [entityId, slots] of byEntity) {
    for (const s of slots) {
      if (s.used || s.row.state === undefined) continue;
      const context = contextFromRow(s.row);
      const data = rowData(s.row);
      items.push({
        t: s.t,
        order: order++,
        event: {
          seq: 0,
          ts: new Date(s.t).toISOString(),
          kind: kindFor(undefined, s.row.state),
          entityId,
          to: s.row.state,
          ...(context ? { context } : {}),
          source: 'home',
          ...(data ? { data } : {}),
        },
      });
    }
  }

  return items.sort((a, b) => a.t - b.t || a.order - b.order).map((i) => i.event);
}
