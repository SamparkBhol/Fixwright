// SimHome state: one plain JSON object, so a snapshot is JSON.stringify and a Durable Object can keep it.
// Physical truth (devices, circuits, the router) lives next to what the hub observes (entities, rows).
// The difference between the two is the whole point: faults live in the gap.

import type { LogRow } from '../logrows.ts';
import type { Iso, PowerOnBehavior, Transport } from '../types.ts';

export const SNAPSHOT_VERSION = 1;

export type AreaId = 'hallway' | 'living_room' | 'kitchen' | 'bedroom' | 'office' | 'garage';

export const AREAS: Readonly<Record<AreaId, string>> = {
  hallway: 'Hallway',
  living_room: 'Living Room',
  kitchen: 'Kitchen',
  bedroom: 'Bedroom',
  office: 'Office',
  garage: 'Garage',
};

export type DeviceKind = 'light' | 'plug' | 'strip' | 'outlet' | 'motion' | 'thermostat' | 'light_group';

export type DevicePower =
  | { kind: 'mains'; circuit: string; wallSwitch: boolean | null; parent: string | null }
  | { kind: 'battery'; pct: number; drainPerDay: number };

export interface DeviceState {
  id: string;
  name: string;
  kind: DeviceKind;
  area: AreaId;
  integration: string;
  transport: Transport;
  vendor: string;
  model: string;
  /** A physical device answers to this pairing. False for a pairing whose device was reset or removed. */
  present: boolean;
  power: DevicePower;
  /** Relay or light output (motion: detected). Null for devices without one. */
  output: boolean | null;
  /** What 'previous' restores after a power cut. */
  lastOutput: boolean;
  powerOnBehavior: PowerOnBehavior | null;
  linkQuality: number | null;
  rssi: number | null;
  /** Wi-Fi network the device has credentials for. */
  ssid: string | null;
  /** A radio or Wi-Fi drop lasts until this time (0: none). */
  dropUntil: number;
  /** Booting after power returned, until this time (0: not booting). */
  bootingUntil: number;
  bootMs: number;
  lastSeenMs: number;
  /** Physically lit or running right now: powered, booted and output on. */
  lit: boolean;
  /** Recent physical output changes (ms), newest last. A person "sees it blink" from these. */
  actuations: number[];
}

export type EntityRole = 'primary' | 'power_on' | 'automation' | 'template';

export interface EntityState {
  entityId: string;
  name: string;
  /** The integration's own name, restored by registryUpdate({ name: null }). */
  originalName: string;
  aliases: string[];
  domain: string;
  area: AreaId | null;
  deviceId: string | null;
  integration: string;
  transport: Transport;
  vendor: string | null;
  model: string | null;
  role: EntityRole;
  /** Observed state, as the hub shows it. */
  state: string;
  /** Desired value for entities without a device output: select option, climate mode, automation on/off. */
  value: string | null;
  attributes: Record<string, unknown>;
  lastChanged: Iso;
  lastUpdated: Iso;
  restored: boolean;
  disabled: boolean;
  registryOnly: boolean;
  createdMs: number;
  /** A polled integration missed this entity once; a second miss marks it unavailable. */
  missedPoll: boolean;
}

export type IntegrationStateName = 'loaded' | 'setup_error' | 'not_loaded' | 'setup_retry';

export interface IntegrationState {
  state: IntegrationStateName;
  reason: string | null;
  entryId: string;
  /** 0: push (changes seen at once). Otherwise the poll interval in ms. */
  pollMs: number;
}

export interface CloudState {
  status: 'ok' | 'degraded' | 'outage';
  since: number;
}

export type ServiceRef = `${string}.${string}`;

export interface AutomationAction {
  service: ServiceRef;
  target: string;
}

export type AutomationTrigger =
  | { kind: 'time'; at: string; actions: AutomationAction[] }
  | {
      kind: 'state';
      entityId: string;
      to: string;
      condition: { entityId: string; state: string } | null;
      actions: AutomationAction[];
      /** Runs `thenActions` after this delay, inside the same run (Home Assistant "wait" steps). */
      thenAfterMs: number;
      thenActions: AutomationAction[];
    };

export interface AutomationDef {
  entityId: string;
  name: string;
  triggers: AutomationTrigger[];
}

export interface TemplateDef {
  entityId: string;
  /** Local clock times at which the template flips to the given state. */
  schedule: { at: string; state: string }[];
}

export interface ActiveFault {
  since: number;
  opts: Record<string, string | number | boolean>;
}

export type Pending =
  | { at: number; n: number; kind: 'voice'; name: string; service: string }
  | { at: number; n: number; kind: 'app'; entityId: string; service: string }
  | { at: number; n: number; kind: 'sweep'; entityIds: string[] }
  | { at: number; n: number; kind: 'motion'; entityId: string; on: boolean }
  | { at: number; n: number; kind: 'auto_time'; automationId: string; trigger: number }
  | { at: number; n: number; kind: 'auto_state'; automationId: string; trigger: number }
  | { at: number; n: number; kind: 'auto_then'; automationId: string; trigger: number; ctx: string }
  | { at: number; n: number; kind: 'template'; entityId: string; state: string }
  | { at: number; n: number; kind: 'drop'; deviceId: string; durationMs: number }
  | { at: number; n: number; kind: 'settle' }
  | { at: number; n: number; kind: 'power'; circuits: string[]; on: boolean }
  | { at: number; n: number; kind: 'boot'; deviceId: string }
  | { at: number; n: number; kind: 'observe'; entityId: string }
  | { at: number; n: number; kind: 'drain' }
  /** Local midnight: plan the new day. Planning in event order keeps runs independent of how the clock is advanced. */
  | { at: number; n: number; kind: 'plan' };

export type PendingKind = Pending['kind'];

export interface Users {
  resident: string;
  voice: string;
  api: string;
}

export interface SimState {
  v: typeof SNAPSHOT_VERSION;
  seed: number;
  tz: string;
  nowMs: number;
  /** Monotonic counter: context ids, pending order and derived random streams. */
  counter: number;
  maxRows: number;
  /** Most bytes of log rows kept (UTF-8 JSON, oldest dropped first). Bounds the snapshot by size, not only by count. */
  maxRowBytes: number;
  /** UTF-8 JSON bytes of the rows kept now, plus one separator per row. */
  rowBytes: number;
  hub: { online: boolean; version: string };
  router: { ssid: string };
  circuits: Record<string, { powered: boolean; ups: boolean }>;
  devices: Record<string, DeviceState>;
  entities: Record<string, EntityState>;
  integrations: Record<string, IntegrationState>;
  cloud: Record<string, CloudState>;
  automations: Record<string, AutomationDef>;
  templates: Record<string, TemplateDef>;
  /** Spoken names the resident uses every day, and the devices they switch off each morning. */
  routine: { sweep: string[] };
  faults: Record<string, ActiveFault>;
  rows: LogRow[];
  pending: Pending[];
  /** Last local day the resident routine and fault processes were planned for. */
  plannedThrough: string | null;
  users: Users;
}

/** A snapshot is the state itself: plain JSON. */
export type SimSnapshot = SimState;
