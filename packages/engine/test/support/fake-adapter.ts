// A HomeAdapter over a plain in memory house, for tests. It keeps the registry, states, signals, events
// and statuses in one mutable object so tests can set up any fault. Like real integrations it reports
// state optimistically: a device in `unpowered` still answers commands in software.

import type {
  CloudStatus,
  Entity,
  EntityId,
  HomeAdapter,
  HouseEvent,
  HubStatus,
  IntegrationStatus,
  Signals,
} from '@fixwright/protocol';
import type { ManualClock } from '@fixwright/protocol';

export interface FakeHouse {
  entities: Map<EntityId, Entity>;
  /** Home events as an adapter reports them (seq 0). */
  events: HouseEvent[];
  signals: Map<EntityId, Signals>;
  integrations: IntegrationStatus[];
  hub: HubStatus;
  /** Cloud status by vendor string. Missing vendors report ok. */
  cloud: Map<string, CloudStatus['status']>;
  /** Entities that ignore commands (state never changes). */
  deaf: Set<EntityId>;
  /** Every service call the adapter received, in order, with the adapter clock time it arrived. */
  calls: { domain: string; service: string; data: Record<string, unknown>; at: string }[];
}

export interface FakeAdapter extends HomeAdapter {
  readonly house: FakeHouse;
  /** Number of adapter method calls, for cost checks. */
  readonly stats: { calls: number };
}

const copy = (e: Entity): Entity => ({ ...e, aliases: [...e.aliases], attributes: { ...e.attributes } });

export function emptyHouse(): FakeHouse {
  return {
    entities: new Map(),
    events: [],
    signals: new Map(),
    integrations: [],
    hub: { reachable: true, latencyMs: 40, version: 'fake-1' },
    cloud: new Map(),
    deaf: new Set(),
    calls: [],
  };
}

export function createFakeAdapter(house: FakeHouse, clock: ManualClock, kind: HomeAdapter['kind'] = 'simhome'): FakeAdapter {
  const stats = { calls: 0 };
  const tick = (): void => {
    stats.calls++;
  };
  const must = (id: EntityId): Entity => {
    const e = house.entities.get(id);
    if (!e) throw new Error(`no entity ${id}`);
    return e;
  };
  const setState = (e: Entity, state: string, context?: HouseEvent['context']): void => {
    const from = e.state;
    if (from === state) return;
    const now = clock.now();
    e.state = state;
    e.lastChanged = now;
    e.lastUpdated = now;
    house.events.push({ seq: 0, ts: now, kind: 'state', entityId: e.entityId, from, to: state, source: 'home', ...(context ? { context } : {}) });
  };

  return {
    kind,
    house,
    stats,
    async listEntities() {
      tick();
      return [...house.entities.values()].map(copy);
    },
    async getEntity(id) {
      tick();
      const e = house.entities.get(id);
      return e ? copy(e) : null;
    },
    async callService(domain, service, data) {
      tick();
      house.calls.push({ domain, service, data: { ...data }, at: clock.now() });
      const ids = Array.isArray(data['entity_id']) ? (data['entity_id'] as EntityId[]) : [String(data['entity_id'])];
      const changed: Entity[] = [];
      for (const id of ids) {
        const e = house.entities.get(id);
        if (!e || e.state === 'unavailable' || house.deaf.has(id)) continue;
        const want = service === 'turn_on' ? 'on' : service === 'turn_off' ? 'off' : service === 'toggle' ? (e.state === 'on' ? 'off' : 'on') : e.state;
        setState(e, want, { service: `${domain}.${service}`, userId: 'fixwright' });
        changed.push(copy(e));
      }
      return { changed };
    },
    async events(q) {
      tick();
      const since = Date.parse(q.since);
      const until = q.until === undefined ? Infinity : Date.parse(q.until);
      return house.events
        .filter((e) => {
          const t = Date.parse(e.ts);
          if (t < since || t > until) return false;
          return q.entityIds === undefined || (e.entityId !== undefined && q.entityIds.includes(e.entityId));
        })
        .map((e) => ({ ...e, seq: 0 }));
    },
    async signals(id) {
      tick();
      return { ...(house.signals.get(id) ?? {}) };
    },
    async integrations() {
      tick();
      return house.integrations.map((i) => ({ ...i }));
    },
    async hubStatus() {
      tick();
      return { ...house.hub };
    },
    async cloudStatus(vendor) {
      tick();
      return { vendor, status: house.cloud.get(vendor) ?? 'ok', source: 'fake status page', checkedAt: clock.now() };
    },
    async registryUpdate(id, patch) {
      tick();
      const e = must(id);
      if (patch.name !== undefined) e.name = patch.name ?? String(e.attributes['original_name'] ?? e.name);
      if (patch.aliases !== undefined) e.aliases = [...patch.aliases];
      if (patch.disabled !== undefined) e.disabled = patch.disabled;
      e.lastUpdated = clock.now();
      return copy(e);
    },
    async registryRemove(id) {
      tick();
      house.entities.delete(id);
    },
    async reloadIntegration(integration) {
      tick();
      const status = house.integrations.find((i) => i.integration === integration);
      if (status) {
        status.state = 'loaded';
        delete status.reason;
      }
      house.hub.reachable = true;
    },
    async selectOption(id, option) {
      tick();
      const select = must(id);
      setState(select, option, { service: 'select.select_option', userId: 'fixwright' });
      for (const e of house.entities.values()) {
        if (e !== select && e.deviceId !== undefined && e.deviceId === select.deviceId) {
          const s = house.signals.get(e.entityId) ?? {};
          house.signals.set(e.entityId, { ...s, powerOnBehavior: option as Signals['powerOnBehavior'] });
        }
      }
      return copy(select);
    },
    now: () => clock.now(),
  };
}

export function addEntity(house: FakeHouse, e: Partial<Entity> & Pick<Entity, 'entityId' | 'name'>, signals?: Signals): Entity {
  const domain = e.entityId.split('.')[0] ?? 'switch';
  const full: Entity = {
    aliases: [],
    domain,
    integration: 'demo',
    transport: 'virtual',
    state: 'off',
    attributes: {},
    lastChanged: '2026-10-01T00:00:00.000Z',
    lastUpdated: '2026-10-01T00:00:00.000Z',
    ...e,
  };
  full.attributes = { original_name: full.name, ...full.attributes };
  house.entities.set(full.entityId, full);
  if (signals) house.signals.set(full.entityId, signals);
  return full;
}

export function addEvent(house: FakeHouse, e: Omit<HouseEvent, 'seq' | 'source'> & { source?: HouseEvent['source'] }): void {
  house.events.push({ seq: 0, source: 'home', ...e });
}
