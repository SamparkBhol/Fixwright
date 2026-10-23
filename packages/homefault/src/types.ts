// Declared here rather than imported so homefault has no dependencies. TypeScript types are
// structural, so an agent that declares the same HomeAdapter shape in its own code accepts a SimHome
// or a scenario home unchanged.

/** ISO 8601 timestamp in UTC, e.g. 2026-10-15T10:12:00.000Z. */
export type Iso = string;
/** Home Assistant style entity id, e.g. light.hallway_lamp. */
export type EntityId = string;
export type Transport = 'zigbee' | 'wifi' | 'thread' | 'cloud' | 'virtual';
export type AdapterKind = 'simhome' | 'home-assistant';

export interface Entity {
  entityId: EntityId;
  /** Friendly name as spoken. */
  name: string;
  aliases: string[];
  /** light | switch | sensor | binary_sensor | select | climate | automation | ... */
  domain: string;
  area?: string;
  deviceId?: string;
  /** zigbee2mqtt | hue | kasa | matter | ecobee | template | automation | ... */
  integration: string;
  transport: Transport;
  vendor?: string;
  model?: string;
  /** 'on' | 'off' | 'unavailable' | numeric string | option */
  state: string;
  attributes: Record<string, unknown>;
  lastChanged: Iso;
  lastUpdated: Iso;
  /** Home Assistant restored=true: known to the registry but not provided by its integration. */
  restored?: boolean;
  disabled?: boolean;
  /** Present in the registry, missing from the state machine. */
  registryOnly?: boolean;
}

export type EventKind =
  | 'state'
  | 'availability'
  | 'service_call'
  | 'automation_run'
  | 'integration'
  | 'power'
  | 'probe'
  | 'human_answer'
  | 'repair'
  | 'note';

export interface EventContext {
  userId?: string;
  service?: string;
  automationId?: string;
  eventType?: string;
  parentSeq?: number;
}

export interface HouseEvent {
  /** Ledger sequence. Adapters return 0 and the ledger assigns the real value. */
  seq: number;
  ts: Iso;
  kind: EventKind;
  entityId?: EntityId;
  from?: string;
  to?: string;
  context?: EventContext;
  source: 'home' | 'fixwright';
  data?: Record<string, unknown>;
}

/** Per entity link and health signals. All optional: adapters fill what they can. */
export interface Signals {
  /** Zigbee LQI, 0 to 255. */
  linkQuality?: number;
  /** Wi-Fi RSSI in dBm. */
  rssi?: number;
  lastSeen?: Iso;
  batteryPct?: number;
  uptimeS?: number;
  powerOnBehavior?: PowerOnBehavior;
  /** Unavailable transitions in the last 24 h. */
  flaps24h?: number;
}

export type PowerOnBehavior = 'previous' | 'on' | 'off' | 'toggle';

export interface IntegrationStatus {
  integration: string;
  state: 'loaded' | 'setup_error' | 'not_loaded' | 'setup_retry';
  reason?: string;
  entryId?: string;
}

export interface CloudStatus {
  vendor: string;
  status: 'ok' | 'degraded' | 'outage' | 'unknown';
  source: string;
  checkedAt: Iso;
}

export interface HubStatus {
  reachable: boolean;
  latencyMs?: number;
  version?: string;
}

export interface EventQuery {
  since: Iso;
  until?: Iso;
  entityIds?: EntityId[];
}

export interface RegistryPatch {
  name?: string | null;
  aliases?: string[];
  disabled?: boolean;
}

export interface HomeAdapter {
  readonly kind: AdapterKind;
  listEntities(): Promise<Entity[]>;
  getEntity(id: EntityId): Promise<Entity | null>;
  callService(domain: string, service: string, data: Record<string, unknown>): Promise<{ changed: Entity[] }>;
  events(q: EventQuery): Promise<HouseEvent[]>;
  signals(id: EntityId): Promise<Signals>;
  integrations(): Promise<IntegrationStatus[]>;
  hubStatus(): Promise<HubStatus>;
  cloudStatus(vendor: string): Promise<CloudStatus>;
  registryUpdate(id: EntityId, patch: RegistryPatch): Promise<Entity>;
  registryRemove(id: EntityId): Promise<void>;
  reloadIntegration(integration: string): Promise<void>;
  selectOption(id: EntityId, option: string): Promise<Entity>;
  /** Adapter clock. SimHome runs on virtual time. */
  now(): Iso;
}

export interface Clock {
  now(): Iso;
  nowMs(): number;
}

/** Uniform random numbers in [0, 1). */
export interface Rng {
  next(): number;
}

/**
 * The single fault causes a diagnosis names. Every fault, generated scenario and incident
 * carries one of these as its ground truth.
 */
export const CAUSE_IDS = [
  'stale_duplicate',
  'device_power_lost',
  'radio_link_weak',
  'hub_down',
  'vendor_cloud_outage',
  'account_link_expired',
  'power_on_default_on',
  'name_collision',
  'dead_trigger',
  'wifi_network_changed',
] as const;
export type CauseId = (typeof CAUSE_IDS)[number];

export function isCauseId(value: unknown): value is CauseId {
  return typeof value === 'string' && (CAUSE_IDS as readonly string[]).includes(value);
}

/** Checkup finding kinds. Faults name the finding a health check should raise, if any. */
export type FindingKind =
  | 'duplicate_name'
  | 'ghost_entity'
  | 'flapping'
  | 'low_battery'
  | 'dead_trigger'
  | 'power_on_default'
  | 'integration_error'
  | 'unprotected_load';
