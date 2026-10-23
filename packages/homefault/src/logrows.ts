// Raw home logs in the shape Home Assistant keeps them: state rows from history and logbook, plus the
// bus events that explain them (call_service, automation_triggered). Rows link through HA contexts:
// an automation run and the service calls and state changes it causes share one context id, and a
// user's call carries the user id. toHouseEvents() resolves those chains into HouseEvent contexts,
// which is the evidence an agent cites ("None of your automations fired").

import type { EventContext, HouseEvent, Iso } from './types.ts';

/** Home Assistant context: id of the originating run or call, optional parent and user. */
export interface HaContext {
  id: string;
  parent_id?: string;
  user_id?: string;
}

/** An entity changed state (history row). 'unavailable' on either side is an availability change. */
export interface StateRow {
  type: 'state';
  when: Iso;
  entity_id: string;
  state: string;
  old_state?: string;
  attributes?: Record<string, unknown>;
  context?: HaContext;
}

/** A service was called (event bus row). Fired even when the target cannot act on it. */
export interface CallServiceRow {
  type: 'call_service';
  when: Iso;
  domain: string;
  service: string;
  entity_ids: string[];
  service_data?: Record<string, unknown>;
  context?: HaContext;
}

/** An automation ran (logbook row). `error` mirrors the automation trace when an action failed. */
export interface AutomationRow {
  type: 'automation_triggered';
  when: Iso;
  entity_id: string;
  name?: string;
  source?: string;
  error?: string;
  context?: HaContext;
}

/** A config entry (integration) changed state. */
export interface IntegrationRow {
  type: 'integration';
  when: Iso;
  integration: string;
  state: 'loaded' | 'setup_error' | 'not_loaded' | 'setup_retry';
  old_state?: string;
  reason?: string;
  context?: HaContext;
}

/** The entity registry changed (entity_registry_updated). */
export interface RegistryRow {
  type: 'registry';
  when: Iso;
  action: 'create' | 'update' | 'remove';
  entity_id: string;
  changes?: Record<string, unknown>;
  context?: HaContext;
}

/** A device reported a power related event: Matter BootReason, a UPS or a power meter. */
export interface DeviceEventRow {
  type: 'device_event';
  when: Iso;
  entity_id?: string;
  event: string;
  data?: Record<string, unknown>;
  context?: HaContext;
}

export type LogRow = StateRow | CallServiceRow | AutomationRow | IntegrationRow | RegistryRow | DeviceEventRow;
export type LogRowType = LogRow['type'];

export const LOG_ROW_TYPES: readonly LogRowType[] = [
  'state',
  'call_service',
  'automation_triggered',
  'integration',
  'registry',
  'device_event',
];

export const isAvailabilityChange = (row: StateRow): boolean =>
  (row.state === 'unavailable') !== (row.old_state === 'unavailable') && row.old_state !== undefined;

/** Rows sorted by time; rows with the same time keep their relative order. */
export function sortRows<T extends LogRow>(rows: readonly T[]): T[] {
  return rows
    .map((row, i) => ({ row, i, t: Date.parse(row.when) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.row);
}

interface Origin {
  eventType: 'call_service' | 'automation_triggered';
  userId?: string;
  automationId?: string;
  service?: string;
}

/** Context id -> what started it. An automation run wins over the service calls it made. */
function origins(rows: readonly LogRow[]): Map<string, Origin> {
  const byId = new Map<string, Origin>();
  for (const row of rows) {
    const id = row.context?.id;
    if (!id) continue;
    if (row.type === 'automation_triggered') {
      byId.set(id, { eventType: 'automation_triggered', automationId: row.entity_id });
    } else if (row.type === 'call_service' && !byId.has(id)) {
      const origin: Origin = { eventType: 'call_service', service: `${row.domain}.${row.service}` };
      if (row.context?.user_id) origin.userId = row.context.user_id;
      byId.set(id, origin);
    }
  }
  // A run started by a parent context (a script, a user's call) keeps the user.
  for (const row of rows) {
    const ctx = row.context;
    if (!ctx?.parent_id) continue;
    const own = byId.get(ctx.id);
    const parent = byId.get(ctx.parent_id);
    if (own && parent?.userId && !own.userId) own.userId = parent.userId;
  }
  return byId;
}

interface IndexedCall {
  row: CallServiceRow;
  index: number;
}

/** Context id -> the service calls made under it (in log order), to name the service behind a change. */
function callsByContext(rows: readonly LogRow[]): Map<string, IndexedCall[]> {
  const byId = new Map<string, IndexedCall[]>();
  rows.forEach((row, index) => {
    if (row.type !== 'call_service' || !row.context) return;
    const list = byId.get(row.context.id);
    if (list) list.push({ row, index });
    else byId.set(row.context.id, [{ row, index }]);
  });
  return byId;
}

/** The latest call in the context that targeted the entity before the state change at `index`. */
function serviceFor(calls: Map<string, IndexedCall[]>, ctxId: string, entityId: string, index: number): string | undefined {
  let found: CallServiceRow | undefined;
  for (const c of calls.get(ctxId) ?? []) {
    if (c.index > index) break;
    if (c.row.entity_ids.includes(entityId)) found = c.row;
  }
  return found ? `${found.domain}.${found.service}` : undefined;
}

function toContext(origin: Origin | undefined, service?: string): EventContext | undefined {
  if (!origin) return undefined;
  const ctx: EventContext = { eventType: origin.eventType };
  if (origin.userId) ctx.userId = origin.userId;
  if (origin.automationId) ctx.automationId = origin.automationId;
  const svc = service ?? origin.service;
  if (svc) ctx.service = svc;
  return ctx;
}

const withContext = (event: HouseEvent, ctx: EventContext | undefined): HouseEvent =>
  ctx ? { ...event, context: ctx } : event;

/**
 * Maps raw rows to HouseEvents (seq 0: the caller's ledger assigns sequence numbers). A service call
 * with several targets becomes one event per target, so entity filters keep working.
 */
export function toHouseEvents(rows: readonly LogRow[]): HouseEvent[] {
  const sorted = sortRows(rows);
  const byCtx = origins(sorted);
  const calls = callsByContext(sorted);
  const out: HouseEvent[] = [];
  for (const [index, row] of sorted.entries()) {
    const origin = row.context ? byCtx.get(row.context.id) : undefined;
    switch (row.type) {
      case 'state': {
        const kind = isAvailabilityChange(row) ? 'availability' : 'state';
        const event: HouseEvent = { seq: 0, ts: row.when, kind, entityId: row.entity_id, to: row.state, source: 'home' };
        if (row.old_state !== undefined) event.from = row.old_state;
        if (row.attributes) event.data = { attributes: row.attributes };
        const service = origin && row.context ? serviceFor(calls, row.context.id, row.entity_id, index) : undefined;
        out.push(withContext(event, toContext(origin, service)));
        break;
      }
      case 'call_service': {
        const service = `${row.domain}.${row.service}`;
        const targets = row.entity_ids.length > 0 ? row.entity_ids : [undefined];
        for (const target of targets) {
          const event: HouseEvent = {
            seq: 0,
            ts: row.when,
            kind: 'service_call',
            source: 'home',
            data: { domain: row.domain, service: row.service, entity_ids: row.entity_ids, ...(row.service_data ? { service_data: row.service_data } : {}) },
          };
          if (target) event.entityId = target;
          const ctx = toContext(origin, service) ?? { eventType: 'call_service', service };
          if (row.context?.user_id && !ctx.userId) ctx.userId = row.context.user_id;
          out.push(withContext(event, ctx));
        }
        break;
      }
      case 'automation_triggered': {
        const data: Record<string, unknown> = {};
        if (row.name) data.name = row.name;
        if (row.source) data.trigger = row.source;
        if (row.error) data.error = row.error;
        out.push({
          seq: 0,
          ts: row.when,
          kind: 'automation_run',
          entityId: row.entity_id,
          source: 'home',
          data,
          context: { eventType: 'automation_triggered', automationId: row.entity_id, ...(origin?.userId ? { userId: origin.userId } : {}) },
        });
        break;
      }
      case 'integration': {
        const event: HouseEvent = {
          seq: 0,
          ts: row.when,
          kind: 'integration',
          to: row.state,
          source: 'home',
          data: { integration: row.integration, ...(row.reason ? { reason: row.reason } : {}) },
        };
        if (row.old_state !== undefined) event.from = row.old_state;
        out.push(event);
        break;
      }
      case 'registry': {
        out.push({
          seq: 0,
          ts: row.when,
          kind: 'note',
          entityId: row.entity_id,
          source: 'home',
          context: { eventType: 'entity_registry_updated' },
          data: { action: row.action, ...(row.changes ? { changes: row.changes } : {}) },
        });
        break;
      }
      case 'device_event': {
        const event: HouseEvent = {
          seq: 0,
          ts: row.when,
          kind: 'power',
          source: 'home',
          data: { event: row.event, ...(row.data ?? {}) },
        };
        if (row.entity_id) event.entityId = row.entity_id;
        out.push(event);
        break;
      }
    }
  }
  return out;
}

/** The entity ids a row is about. */
export function rowEntities(row: LogRow): string[] {
  switch (row.type) {
    case 'state':
    case 'automation_triggered':
    case 'registry':
      return [row.entity_id];
    case 'call_service':
      return row.entity_ids;
    case 'device_event':
      return row.entity_id ? [row.entity_id] : [];
    case 'integration':
      return [];
  }
}

/** Unavailable transitions per entity in (fromMs, toMs]. What adapters report as flaps24h. */
export function countDrops(rows: readonly LogRow[], entityId: string, fromMs: number, toMs: number): number {
  let n = 0;
  for (const row of rows) {
    if (row.type !== 'state' || row.entity_id !== entityId) continue;
    if (row.state !== 'unavailable' || row.old_state === undefined || row.old_state === 'unavailable') continue;
    const t = Date.parse(row.when);
    if (t > fromMs && t <= toMs) n++;
  }
  return n;
}
