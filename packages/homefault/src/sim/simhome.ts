// SimHome: a deterministic digital twin of a smart home that implements the HomeAdapter shape on
// virtual time. Agents talk to it exactly as they would talk to Home Assistant; tests and demos also
// get god-view controls (inject a fault, move the clock, read physical truth, ask the person).

import { countDrops, toHouseEvents, type LogRow } from '../logrows.ts';
import type { HumanQuestionKind, YesNo } from '../scenario/types.ts';
import { DAY, HOUR, isValidTimeZone, iso, lastLocalOccurrence, parseLocal, toMs } from '../time.ts';
import type {
  CloudStatus,
  Entity,
  EntityId,
  EventQuery,
  HomeAdapter,
  HouseEvent,
  HubStatus,
  IntegrationStatus,
  Iso,
  RegistryPatch,
  Signals,
} from '../types.ts';
import { clone, foldName, isReservedKey, own } from '../util.ts';
import {
  clearFault,
  DEMO_GHOST_SINCE_LOCAL,
  DEMO_OUTAGE_CLOCK,
  FAULT_IDS,
  FAULTS,
  faultId,
  injectFault,
  planFaultDay,
  setupDemoFaults,
  type FaultCode,
  type FaultId,
  type FaultOptions,
} from '../faults.ts';
import { buildHouse, DEFAULT_MAX_ROW_BYTES } from './blueprint.ts';
import {
  apiLatency,
  appendRow,
  command,
  deviceOf,
  derivedState,
  inStateMachine,
  isAvailableNow,
  isKnownService,
  isLinked,
  isLit,
  isPowered,
  linkHolder,
  newContext,
  observe,
  resolveSpoken,
  rowSize,
  runUntil,
  schedule,
  settle,
  simError,
  targetsOf,
  trimRows,
  cutPower,
  restorePower,
} from './engine.ts';
import { AREAS, SNAPSHOT_VERSION, type EntityState, type SimSnapshot, type SimState } from './model.ts';
import { planToday } from './resident.ts';

export const DEFAULT_TZ = 'America/Los_Angeles';
/** The demo begins at 15:00 household time on 15 October 2026. */
export const DEMO_NOW_LOCAL = '2026-10-15T15:00:00';

export type FaultSpec = FaultId | FaultCode | { id: FaultId | FaultCode; opts?: FaultOptions };

export interface SimHomeOptions {
  /** Seeds every random choice. Default 1. */
  seed?: number;
  /** IANA time zone of the household. Default America/Los_Angeles. */
  tz?: string;
  /** Start of the demo: an ISO instant, a local 'YYYY-MM-DDTHH:MM:SS' or epoch ms. Default 2026-10-15T15:00:00 local. */
  now?: Iso | number;
  /** 'demo' (default): F1 to F5 as in the demo script. 'none': a healthy house. Or a list injected at the start of history. */
  faults?: 'demo' | 'none' | readonly FaultSpec[];
  /** Hours of simulated history before `now`. Default 24 (the demo needs at least 24). */
  historyHours?: number;
  /** Most log rows kept (oldest dropped first). Default 1000. */
  maxRows?: number;
  /** Most bytes of log rows kept (UTF-8 JSON, oldest dropped first). Default 150 000, which keeps a snapshot under 256 KB. */
  maxLogBytes?: number;
}

/** Caps on what callers can store, so a snapshot stays small whatever an agent or an HTTP body sends. */
export const INPUT_LIMITS = {
  /** Entities one service call may target. */
  targets: 32,
  /** Characters in a friendly name or an alias (control characters are refused). */
  name: 64,
  aliases: 4,
  /** Extra service data fields, and characters in a string value. */
  dataFields: 8,
  text: 64,
} as const;

/** Ground truth a person could see or touch, for simulating the human in the loop. */
export interface PhysicalReading {
  entityId: EntityId;
  deviceId: string | null;
  /** The physical object's name, if a device stands behind the entity. */
  name: string | null;
  /** A real device answers to this entity. False for an old pairing or a removed device. */
  exists: boolean;
  powered: boolean;
  /** The hub can reach it. */
  linked: boolean;
  /** Lit or running, as a person in the room would notice. Null for devices without an output. */
  output: 'on' | 'off' | null;
  wallSwitch: 'on' | 'off' | null;
  circuit: string | null;
  batteryPct: number | null;
  /** Recent visible changes (switching or blinking), oldest first. */
  recentActuations: Iso[];
}

export interface PersonQuestion {
  kind: HumanQuestionKind;
  /** The device the question is about, by spoken name ... */
  name?: string;
  /** ... or by entity id. A person looks at the real object, even when the entity is an old copy. */
  entityId?: EntityId;
  /** For confirm_flash: count blinks since this time. Default: the last 60 seconds. */
  since?: Iso;
}

export type PersonAnswer = YesNo | 'not sure';

export interface InjectReport {
  id: FaultId;
  code: FaultCode;
  cause_id: string;
  /** Virtual time after the fault finished showing itself. */
  at: Iso;
}

export interface SimHome extends HomeAdapter {
  readonly kind: 'simhome';
  readonly seed: number;
  readonly tz: string;
  /** Applies a fault at the current virtual time (F2 runs the clock about six seconds through the outage). */
  inject(fault: FaultId | FaultCode, opts?: FaultOptions): InjectReport;
  /** Removes a fault the way its real fix would (rename, relink, battery swap, ...). */
  clear(fault: FaultId | FaultCode): void;
  activeFaults(): FaultId[];
  /** Runs the house forward: resident, automations, fault processes. */
  advance(ms: number): void;
  /** Runs the house forward to a time. Earlier times are a no-op. */
  advanceTo(time: Iso | number): void;
  /** The whole state as plain JSON. restore(snapshot()) continues byte for byte. */
  snapshot(): SimSnapshot;
  restore(snapshot: SimSnapshot): void;
  physical(entityId: EntityId): PhysicalReading;
  /** What the person in the room would answer, from physical truth. */
  person(question: PersonQuestion): PersonAnswer;
  /** The entity a spoken name reaches, as a voice assistant would resolve it. */
  resolveName(spoken: string): Entity | null;
  /** Raw Home Assistant shaped log rows in a window (copies). */
  rows(q?: { since?: Iso; until?: Iso }): LogRow[];
  /**
   * A mains power cut on some circuits (default: every area), then power back after durationMs
   * (default 2000). Runs the clock through the restart. Unlike F2 it leaves device settings alone.
   */
  powerCut(opts?: { durationMs?: number; circuits?: string[] }): void;
  setWallSwitch(entityId: EntityId, on: boolean): void;
  setCircuit(circuit: string, powered: boolean): void;
  setHubOnline(online: boolean): void;
}

const VENDORS: Readonly<Record<string, string>> = {
  ecobee: 'ecobee',
  hue: 'hue',
  'philips hue': 'hue',
  philips: 'hue',
  signify: 'hue',
  'light maker': 'hue',
  kasa: 'kasa',
  'tp link': 'kasa',
  tplink: 'kasa',
};

export function toEntity(e: EntityState): Entity {
  const out: Entity = {
    entityId: e.entityId,
    name: e.name,
    aliases: [...e.aliases],
    domain: e.domain,
    integration: e.integration,
    transport: e.transport,
    state: e.state,
    attributes: clone(e.attributes),
    lastChanged: e.lastChanged,
    lastUpdated: e.lastUpdated,
  };
  if (e.area) out.area = e.area;
  if (e.deviceId) out.deviceId = e.deviceId;
  if (e.vendor) out.vendor = e.vendor;
  if (e.model) out.model = e.model;
  if (e.restored) out.restored = true;
  if (e.disabled) out.disabled = true;
  if (e.registryOnly) out.registryOnly = true;
  return out;
}

const plan = (s: SimState): void => planToday(s, planFaultDay);

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function validateSnapshot(snap: unknown): SimSnapshot {
  const s = isRecord(snap) ? (snap as Partial<SimSnapshot>) : null;
  const records = s ? [s.entities, s.devices, s.integrations, s.circuits, s.cloud, s.automations, s.templates, s.faults] : [];
  if (
    !s ||
    s.v !== SNAPSHOT_VERSION ||
    typeof s.nowMs !== 'number' ||
    typeof s.seed !== 'number' ||
    typeof s.tz !== 'string' ||
    !records.every(isRecord) ||
    !Array.isArray(s.rows) ||
    !Array.isArray(s.pending)
  ) {
    throw simError('bad_snapshot', `Not a SimHome snapshot (version ${SNAPSHOT_VERSION})`);
  }
  return s as SimSnapshot;
}

/** A private copy of a snapshot, with the log byte count recomputed (older snapshots did not carry it). */
export function rehydrate(snapshot: SimSnapshot): SimState {
  const s = clone(validateSnapshot(snapshot));
  if (typeof s.maxRowBytes !== 'number') s.maxRowBytes = DEFAULT_MAX_ROW_BYTES;
  s.rowBytes = s.rows.reduce((n, r) => n + rowSize(r), 0);
  trimRows(s);
  return s;
}

const short = (text: string): string => (text.length > 60 ? `${text.slice(0, 57)}...` : text);
const badRequest = (message: string) => simError('bad_request', message);

/** Extra service call fields, checked: short strings, numbers, booleans and short lists of numbers only. */
function serviceData(data: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(data).filter((k) => k !== 'entity_id');
  if (keys.length > INPUT_LIMITS.dataFields) throw badRequest(`At most ${INPUT_LIMITS.dataFields} service data fields`);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!/^[a-z_][a-z0-9_]{0,31}$/.test(key) || isReservedKey(key)) throw badRequest(`Unsupported service data field ${short(key)}`);
    const v = data[key];
    const ok =
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v)) ||
      (typeof v === 'string' && v.length <= INPUT_LIMITS.text) ||
      (Array.isArray(v) && v.length <= 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x)));
    if (!ok) throw badRequest(`Service data field ${key} must be a short string, a number, a boolean or a list of up to 4 numbers`);
    out[key] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

function checkName(name: unknown, field: string): string {
  if (typeof name !== 'string') throw badRequest(`${field} must be a string`);
  const trimmed = name.trim();
  if (!trimmed) throw badRequest(`${field} must not be empty`);
  if (trimmed.length > INPUT_LIMITS.name) throw badRequest(`${field} is longer than ${INPUT_LIMITS.name} characters`);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw badRequest(`${field} must not contain control characters`);
  return trimmed;
}

function checkPatch(patch: unknown): { name?: string | null; aliases?: string[]; disabled?: boolean } {
  if (!isRecord(patch)) throw badRequest('patch must be an object');
  const out: { name?: string | null; aliases?: string[]; disabled?: boolean } = {};
  if (patch.name !== undefined) out.name = patch.name === null ? null : checkName(patch.name, 'name');
  if (patch.aliases !== undefined) {
    if (!Array.isArray(patch.aliases) || patch.aliases.length > INPUT_LIMITS.aliases) throw badRequest(`aliases must be a list of at most ${INPUT_LIMITS.aliases} names`);
    out.aliases = patch.aliases.map((a) => checkName(a, 'alias'));
  }
  if (patch.disabled !== undefined) {
    if (typeof patch.disabled !== 'boolean') throw badRequest('disabled must be true or false');
    out.disabled = patch.disabled;
  }
  return out;
}

function instance(initial: SimState): SimHome {
  let s = initial;

  const flush = (): void => runUntil(s, s.nowMs, plan);
  /**
   * Every write is one API round trip: it runs at the current virtual time, then the clock moves on by
   * the hub's latency (9 to 31 ms), whether the write worked or not. So each write gets its own timestamp
   * (a command and the state change it causes share one), and "since the repair" starts after the
   * repair's last read-back.
   */
  const write = <T>(run: () => T): T => {
    try {
      return run();
    } finally {
      runUntil(s, s.nowMs + apiLatency(s), plan);
    }
  };
  const hub = (): void => {
    if (!s.hub.online) throw simError('hub_unreachable', 'The hub is not reachable');
  };
  const entity = (id: EntityId): EntityState => {
    const e = typeof id === 'string' ? own(s.entities, id) : undefined;
    if (!e) throw simError('not_found', `No entity ${short(String(id))}`);
    return e;
  };
  const parseTime = (t: Iso, field: string): number => {
    const ms = typeof t === 'string' ? Date.parse(t) : NaN;
    if (!Number.isFinite(ms)) throw badRequest(`${field} is not an ISO time: ${short(String(t))}`);
    return ms;
  };

  function signalsOf(e: EntityState): Signals {
    const sig: Signals = { flaps24h: countDrops(s.rows, e.entityId, s.nowMs - DAY, s.nowMs) };
    const d = deviceOf(s, e);
    if (!d) return sig;
    const linked = isLinked(s, d) && !e.restored;
    sig.lastSeen = iso(linked ? s.nowMs : d.lastSeenMs);
    if (e.restored) return sig;
    const holder = linkHolder(s, d);
    if (d.integration === 'zigbee2mqtt' && d.linkQuality !== null) sig.linkQuality = d.linkQuality;
    if (holder.rssi !== null) sig.rssi = holder.rssi;
    if (d.power.kind === 'battery') sig.batteryPct = Math.floor(d.power.pct);
    if (d.integration === 'matter' && linked) sig.uptimeS = Math.floor((s.nowMs - d.bootMs) / 1000);
    const hasSelect = Object.values(s.entities).some((x) => x.role === 'power_on' && x.deviceId === d.id);
    if (hasSelect && d.powerOnBehavior) sig.powerOnBehavior = d.powerOnBehavior;
    return sig;
  }

  function devicesFor(q: PersonQuestion): string[] {
    const ids = new Set<string>();
    const byName = (name: string): void => {
      const want = foldName(name);
      for (const d of Object.values(s.devices)) if (d.present && foldName(d.name) === want) ids.add(d.id);
      for (const e of Object.values(s.entities)) {
        if (e.deviceId && foldName(e.name) === want && own(s.devices, e.deviceId)?.present) ids.add(e.deviceId);
      }
    };
    if (typeof q.entityId === 'string') {
      const e = own(s.entities, q.entityId);
      const d = e ? deviceOf(s, e) : undefined;
      if (d?.present) ids.add(d.id);
      else if (e) byName(e.name);
    }
    if (typeof q.name === 'string') byName(q.name);
    return [...ids];
  }

  const home: SimHome = {
    kind: 'simhome',
    get seed() {
      return s.seed;
    },
    get tz() {
      return s.tz;
    },

    async listEntities() {
      hub();
      return Object.values(s.entities)
        .map(toEntity)
        .sort((a, b) => a.entityId.localeCompare(b.entityId));
    },

    async getEntity(id) {
      hub();
      const e = typeof id === 'string' ? own(s.entities, id) : undefined;
      return e ? toEntity(e) : null;
    },

    async callService(domain, service, data) {
      return write(() => {
        hub();
        if (typeof domain !== 'string' || typeof service !== 'string' || !isKnownService(domain, service)) {
          throw simError('unknown_service', `Unknown service ${short(`${String(domain)}.${String(service)}`)}`);
        }
        if (!isRecord(data)) throw badRequest('service data must be an object');
        const targets = [...new Set(targetsOf(data))];
        if (targets.length === 0) throw badRequest('entity_id is required');
        if (targets.length > INPUT_LIMITS.targets) throw badRequest(`At most ${INPUT_LIMITS.targets} entities per call`);
        const extra = serviceData(data);
        const found = targets.map((id) => {
          const e = own(s.entities, id);
          if (!e || !inStateMachine(e)) throw simError('not_found', `No entity ${short(id)}`);
          if (e.domain !== domain && !(domain === 'automation' && e.role === 'automation')) throw badRequest(`${id} is not a ${domain} entity`);
          return e;
        });
        const ctx = newContext(s, s.users.api);
        appendRow(s, {
          type: 'call_service',
          when: iso(s.nowMs),
          domain,
          service,
          entity_ids: targets,
          ...(Object.keys(extra).length > 0 ? { service_data: extra } : {}),
          context: ctx,
        });
        for (const e of found) {
          if (!isAvailableNow(s, e)) {
            settle(s, 'command', e.deviceId ? new Set([e.deviceId]) : undefined);
            throw simError('entity_unavailable', `${e.name} (${e.entityId}) is unavailable`);
          }
        }
        const changed = new Set<string>();
        for (const id of targets) {
          const result = command(s, domain, service, id, extra, ctx, { logCall: false });
          if (!result.ok) throw simError(result.error?.startsWith('Option') ? 'invalid_option' : 'entity_unavailable', result.error ?? 'failed');
          for (const c of result.changed) changed.add(c);
        }
        flush();
        return { changed: [...changed].flatMap((id) => {
          const e = own(s.entities, id);
          return e ? [toEntity(e)] : [];
        }) };
      });
    },

    async events(q: EventQuery): Promise<HouseEvent[]> {
      hub();
      if (!isRecord(q)) throw badRequest('query must be an object');
      const since = parseTime(q.since, 'since');
      const until = q.until ? parseTime(q.until, 'until') : Infinity;
      const ids = Array.isArray(q.entityIds) ? new Set(q.entityIds) : null;
      return toHouseEvents(s.rows).filter((ev) => {
        const t = Date.parse(ev.ts);
        if (t < since || t > until) return false;
        return ids === null || (ev.entityId !== undefined && ids.has(ev.entityId));
      });
    },

    async signals(id) {
      hub();
      return signalsOf(entity(id));
    },

    async integrations(): Promise<IntegrationStatus[]> {
      hub();
      return Object.entries(s.integrations)
        .map(([integration, st]) => ({
          integration,
          state: st.state,
          entryId: st.entryId,
          ...(st.reason ? { reason: st.reason } : {}),
        }))
        .sort((a, b) => a.integration.localeCompare(b.integration));
    },

    async hubStatus(): Promise<HubStatus> {
      return s.hub.online ? { reachable: true, latencyMs: apiLatency(s), version: s.hub.version } : { reachable: false };
    },

    async cloudStatus(vendor): Promise<CloudStatus> {
      const name = typeof vendor === 'string' ? vendor : '';
      const folded = foldName(name);
      const key = own(VENDORS, folded) ?? folded;
      const status = own(s.cloud, key)?.status ?? 'unknown';
      return { vendor: short(name), status, source: 'simulated vendor status page', checkedAt: iso(s.nowMs) };
    },

    async registryUpdate(id, patch: RegistryPatch) {
      return write(() => {
        hub();
        const e = entity(id);
        const p = checkPatch(patch);
        const changes: Record<string, unknown> = {};
        if (p.name !== undefined) {
          const name = p.name === null ? e.originalName : p.name;
          if (name !== e.name) changes.name = { old: e.name, new: name };
          e.name = name;
          e.attributes.friendly_name = name;
        }
        if (p.aliases !== undefined) {
          changes.aliases = { old: [...e.aliases], new: [...p.aliases] };
          e.aliases = p.aliases;
        }
        if (p.disabled !== undefined && p.disabled !== e.disabled) {
          changes.disabled_by = { old: e.disabled ? 'user' : null, new: p.disabled ? 'user' : null };
          e.disabled = p.disabled;
          e.registryOnly = p.disabled;
          if (p.disabled) {
            e.state = 'unavailable';
          } else {
            observe(s, e, derivedState(s, e));
          }
        }
        e.lastUpdated = iso(s.nowMs);
        appendRow(s, { type: 'registry', when: iso(s.nowMs), action: 'update', entity_id: e.entityId, changes, context: newContext(s, s.users.api) });
        flush();
        return toEntity(e);
      });
    },

    async registryRemove(id) {
      write(() => {
        hub();
        const e = entity(id);
        const d = deviceOf(s, e);
        const provided = !e.restored && !e.registryOnly && (e.role === 'automation' || e.role === 'template' || (d?.present ?? false));
        if (provided) {
          throw simError('entity_still_provided', `${e.entityId} is still provided by ${e.integration}. Disable it instead.`);
        }
        delete s.entities[e.entityId];
        appendRow(s, { type: 'registry', when: iso(s.nowMs), action: 'remove', entity_id: e.entityId, context: newContext(s, s.users.api) });
        flush();
      });
    },

    async reloadIntegration(integration) {
      write(() => {
        hub();
        const st = typeof integration === 'string' ? own(s.integrations, integration) : undefined;
        if (!st) throw simError('unknown_integration', `No integration ${short(String(integration))}`);
        const before = st.state;
        appendRow(s, { type: 'integration', when: iso(s.nowMs), integration, state: 'not_loaded', old_state: before, context: newContext(s, s.users.api) });
        let next: IntegrationStatus['state'] = 'loaded';
        let reason: string | null = null;
        const hubFault = s.faults.hub_down;
        const linkFault = s.faults.account_link_expired;
        if (hubFault && String(hubFault.opts.integration ?? 'zigbee2mqtt') === integration) {
          if (hubFault.opts.hard === true) {
            next = 'setup_retry';
            reason = st.reason;
          } else {
            delete s.faults.hub_down;
          }
        }
        if (linkFault && String(linkFault.opts.integration ?? 'hue') === integration) {
          next = 'setup_error';
          reason = st.reason;
        }
        st.state = next;
        st.reason = reason;
        appendRow(s, { type: 'integration', when: iso(s.nowMs), integration, state: next, old_state: 'not_loaded', ...(reason ? { reason } : {}) });
        settle(s, 'command');
        flush();
      });
    },

    async selectOption(id, option) {
      return write(() => {
        hub();
        const e = entity(id);
        if (e.domain !== 'select') throw badRequest(`${e.entityId} is not a select entity`);
        if (typeof option !== 'string' || option.length > INPUT_LIMITS.text) throw simError('invalid_option', 'option must be a short string');
        const result = command(s, 'select', 'select_option', e.entityId, { option }, newContext(s, s.users.api), { logCall: true });
        if (!result.ok) {
          const code = result.error?.startsWith('Option') ? 'invalid_option' : 'entity_unavailable';
          throw simError(code, result.error ?? 'failed');
        }
        flush();
        return toEntity(e);
      });
    },

    now: () => iso(s.nowMs),

    inject(fault, opts = {}) {
      const id = faultId(fault);
      const { settleMs } = injectFault(s, id, opts);
      runUntil(s, s.nowMs + settleMs, plan);
      const def = FAULTS[id];
      return { id, code: def.code, cause_id: def.cause_id, at: iso(s.nowMs) };
    },

    clear(fault) {
      clearFault(s, faultId(fault));
      flush();
    },

    activeFaults: () => FAULT_IDS.filter((id) => s.faults[id] !== undefined),

    advance(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw badRequest('advance needs a non-negative number of ms');
      runUntil(s, s.nowMs + ms, plan);
    },

    advanceTo(time) {
      const target = toMs(time, s.tz);
      if (target > s.nowMs) runUntil(s, target, plan);
    },

    snapshot: () => clone(s),

    restore(snapshot) {
      s = rehydrate(snapshot);
    },

    physical(entityId) {
      const e = entity(entityId);
      const d = deviceOf(s, e);
      if (!d) {
        return { entityId: e.entityId, deviceId: null, name: null, exists: false, powered: false, linked: false, output: null, wallSwitch: null, circuit: null, batteryPct: null, recentActuations: [] };
      }
      return {
        entityId: e.entityId,
        deviceId: d.id,
        name: d.name,
        exists: d.present,
        powered: isPowered(s, d),
        linked: isLinked(s, d),
        output: d.output === null || d.kind === 'motion' ? null : isLit(s, d) ? 'on' : 'off',
        wallSwitch: d.power.kind === 'mains' && d.power.wallSwitch !== null ? (d.power.wallSwitch ? 'on' : 'off') : null,
        circuit: d.power.kind === 'mains' ? d.power.circuit : null,
        batteryPct: d.power.kind === 'battery' ? Math.floor(d.power.pct) : null,
        recentActuations: d.actuations.map(iso),
      };
    },

    person(q) {
      if (!isRecord(q)) throw badRequest('question must be an object');
      if (q.kind === 'router_changed') return s.faults.router_ssid_change ? 'yes' : 'no';
      if (q.kind !== 'confirm_flash' && q.kind !== 'power_switch_check') throw badRequest(`Unknown question ${short(String(q.kind))}`);
      const devices = devicesFor(q).flatMap((id) => own(s.devices, id) ?? []);
      if (devices.length === 0) return 'not sure';
      if (q.kind === 'power_switch_check') return devices.some((d) => isPowered(s, d)) ? 'yes' : 'no';
      const since = q.since ? parseTime(q.since, 'since') : s.nowMs - 60_000;
      return devices.some((d) => d.actuations.some((t) => t >= since)) ? 'yes' : 'no';
    },

    resolveName(spoken) {
      if (typeof spoken !== 'string') return null;
      const e = resolveSpoken(s, spoken);
      return e ? toEntity(e) : null;
    },

    rows(q = {}) {
      const since = q.since ? parseTime(q.since, 'since') : -Infinity;
      const until = q.until ? parseTime(q.until, 'until') : Infinity;
      return clone(s.rows.filter((r) => {
        const t = Date.parse(r.when);
        return t >= since && t <= until;
      }));
    },

    powerCut(opts = {}) {
      const circuits = opts.circuits ?? Object.keys(s.circuits).filter((c) => !own(s.circuits, c)?.ups);
      for (const c of circuits) if (!own(s.circuits, c)) throw badRequest(`No circuit ${short(String(c))}`);
      const duration = opts.durationMs ?? 2000;
      if (!Number.isFinite(duration) || duration < 0) throw badRequest('durationMs must be a non-negative number');
      cutPower(s, circuits);
      schedule(s, { at: s.nowMs + duration, kind: 'power', circuits, on: true });
      runUntil(s, s.nowMs + duration + 4000, plan);
    },

    setWallSwitch(entityId, on) {
      const d = deviceOf(s, entity(entityId));
      if (!d || d.power.kind !== 'mains' || d.power.wallSwitch === null) throw badRequest(`${short(entityId)} has no wall switch`);
      if (!on && d.output !== null && isPowered(s, d)) d.lastOutput = d.output;
      d.power.wallSwitch = on;
      if (on) {
        d.output = d.powerOnBehavior === null ? d.lastOutput : d.powerOnBehavior === 'on' ? true : d.powerOnBehavior === 'off' ? false : d.lastOutput;
        d.bootMs = s.nowMs;
      }
      settle(s, 'now');
      flush();
    },

    setCircuit(circuit, powered) {
      if (!own(s.circuits, circuit)) throw badRequest(`No circuit ${short(String(circuit))}. Circuits: ${Object.keys(s.circuits).join(', ')}`);
      if (powered) restorePower(s, [circuit]);
      else cutPower(s, [circuit]);
      flush();
    },

    setHubOnline(online) {
      s.hub.online = online;
      if (online) settle(s, 'command');
    },
  };
  return home;
}

function normalizeFaults(faults: SimHomeOptions['faults']): Array<{ id: FaultId; opts: FaultOptions }> {
  if (faults === undefined || faults === 'demo' || faults === 'none') return [];
  return faults.map((f) => (typeof f === 'string' ? { id: faultId(f), opts: {} } : { id: faultId(f.id), opts: f.opts ?? {} }));
}

function create(opts: SimHomeOptions = {}): SimHome {
  const tz = opts.tz ?? DEFAULT_TZ;
  if (!isValidTimeZone(tz)) throw simError('bad_request', `Unknown time zone ${tz}`);
  const seed = opts.seed ?? 1;
  if (!Number.isInteger(seed)) throw simError('bad_request', 'seed must be an integer');
  for (const [field, value] of [['maxRows', opts.maxRows], ['maxLogBytes', opts.maxLogBytes], ['historyHours', opts.historyHours]] as const) {
    if (value !== undefined && !(Number.isInteger(value) && value > 0)) throw simError('bad_request', `${field} must be a positive integer`);
  }
  const targetMs = opts.now === undefined ? parseLocal(DEMO_NOW_LOCAL, tz) : toMs(opts.now, tz);
  const demo = opts.faults === undefined || opts.faults === 'demo';
  const historyHours = Math.max(demo ? 24 : 1, opts.historyHours ?? 24);
  const startMs = targetMs - historyHours * HOUR;
  const state = buildHouse({
    seed,
    tz,
    startMs,
    ...(opts.maxRows ? { maxRows: opts.maxRows } : {}),
    ...(opts.maxLogBytes ? { maxRowBytes: opts.maxLogBytes } : {}),
  });
  plan(state);

  if (demo) {
    setupDemoFaults(state, targetMs, parseLocal(DEMO_GHOST_SINCE_LOCAL, tz), lastLocalOccurrence(targetMs, DEMO_OUTAGE_CLOCK, tz));
  } else {
    for (const f of normalizeFaults(opts.faults)) {
      const { settleMs } = injectFault(state, f.id, f.opts);
      if (settleMs > 0) runUntil(state, state.nowMs + settleMs, plan);
    }
  }
  runUntil(state, targetMs, plan);
  return instance(state);
}

function fromSnapshot(snapshot: SimSnapshot): SimHome {
  return instance(rehydrate(snapshot));
}

/** Factory: SimHome.create(opts) builds a house; SimHome.fromSnapshot(json) brings one back. */
export const SimHome = { create, fromSnapshot, AREAS } as const;
