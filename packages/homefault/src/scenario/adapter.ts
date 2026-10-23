// A HomeAdapter over a frozen scenario, so an agent can be run on any scenario exactly as on a live
// house. Reads come from the scenario. Writes land on a private overlay with the same physical rules
// as SimHome: an unavailable or missing entity rejects, a working one changes and is logged.

import { countDrops, toHouseEvents, type LogRow } from '../logrows.ts';
import { clone, codedError, foldName, own } from '../util.ts';
import type { CloudStatus, Entity, HomeAdapter, HouseEvent, IntegrationStatus, Signals } from '../types.ts';
import type { ScenarioView } from './types.ts';

export const SCENARIO_HOME_ERROR = 'ScenarioHomeError';
const err = (code: string, message: string) => codedError(SCENARIO_HOME_ERROR, code, message);

export interface ScenarioHome extends HomeAdapter {
  readonly kind: 'simhome';
  /** Rows written by the agent's actions so far (service calls, state changes, registry edits). */
  writes(): LogRow[];
}

const DAY = 86_400_000;

/** Builds an adapter over a scenario view. Each call gets its own overlay; the view is not modified. */
export function scenarioHome(view: ScenarioView): ScenarioHome {
  const entities = new Map(clone(view.home.entities).map((e) => [e.entityId, e]));
  const rows: LogRow[] = clone(view.events);
  const written: LogRow[] = [];
  const now = view.now;
  const nowMs = Date.parse(now);
  let ctxN = 0;
  const ctx = () => ({ id: `ctx_agent_${++ctxN}`, user_id: 'user_api' });
  const write = (row: LogRow): void => {
    rows.push(row);
    written.push(row);
  };
  const entity = (id: string): Entity => {
    const e = entities.get(id);
    if (!e) throw err('not_found', `No entity ${id}`);
    return e;
  };
  const hub = (): void => {
    if (!view.home.hub.reachable) throw err('hub_unreachable', 'The hub is not reachable');
  };

  const api: ScenarioHome = {
    kind: 'simhome',
    async listEntities() {
      hub();
      return clone([...entities.values()]);
    },
    async getEntity(id) {
      hub();
      const e = entities.get(id);
      return e ? clone(e) : null;
    },
    async callService(domain, service, data) {
      hub();
      const raw = data.entity_id;
      const ids = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
      if (ids.length === 0) throw err('bad_request', 'entity_id is required');
      const c = ctx();
      write({ type: 'call_service', when: now, domain, service, entity_ids: ids, context: c });
      for (const id of ids) {
        const e = entity(id);
        if (e.state === 'unavailable' || e.restored || e.registryOnly) throw err('entity_unavailable', `${e.name} (${id}) is unavailable`);
      }
      const changed: Entity[] = [];
      for (const id of ids) {
        const e = entity(id);
        if (service === 'turn_on' && typeof data.flash === 'string') continue;
        let next = e.state;
        if (service === 'turn_on') next = 'on';
        else if (service === 'turn_off') next = 'off';
        else if (service === 'toggle') next = e.state === 'on' ? 'off' : 'on';
        else if (service === 'select_option' && typeof data.option === 'string') next = data.option;
        if (next === e.state) continue;
        write({ type: 'state', when: now, entity_id: id, state: next, old_state: e.state, context: c });
        e.state = next;
        e.lastChanged = now;
        e.lastUpdated = now;
        changed.push(clone(e));
      }
      return { changed };
    },
    async events(q): Promise<HouseEvent[]> {
      hub();
      const since = Date.parse(q.since);
      const until = q.until ? Date.parse(q.until) : Infinity;
      if (!Number.isFinite(since)) throw err('bad_request', `since is not an ISO time: ${q.since}`);
      const ids = q.entityIds ? new Set(q.entityIds) : null;
      return toHouseEvents(rows).filter((ev) => {
        const t = Date.parse(ev.ts);
        return t >= since && t <= until && (ids === null || (ev.entityId !== undefined && ids.has(ev.entityId)));
      });
    },
    async signals(id): Promise<Signals> {
      hub();
      entity(id);
      const base = own(view.home.signals, id);
      return { ...(base ? clone(base) : {}), flaps24h: countDrops(rows, id, nowMs - DAY, nowMs) };
    },
    async integrations(): Promise<IntegrationStatus[]> {
      hub();
      return clone(view.home.integrations);
    },
    async hubStatus() {
      return clone(view.home.hub);
    },
    async cloudStatus(vendor): Promise<CloudStatus> {
      const found = view.home.cloud.find((c) => foldName(c.vendor) === foldName(vendor));
      return found ? clone(found) : { vendor, status: 'unknown', source: 'scenario', checkedAt: now };
    },
    async registryUpdate(id, patch) {
      hub();
      const e = entity(id);
      const changes: Record<string, unknown> = {};
      if (patch.name !== undefined && patch.name !== null) {
        changes.name = { old: e.name, new: patch.name };
        e.name = patch.name;
      }
      if (patch.aliases !== undefined) {
        changes.aliases = { old: e.aliases, new: patch.aliases };
        e.aliases = [...patch.aliases];
      }
      if (patch.disabled !== undefined) {
        changes.disabled_by = { old: e.disabled ? 'user' : null, new: patch.disabled ? 'user' : null };
        e.disabled = patch.disabled;
        e.registryOnly = patch.disabled;
      }
      write({ type: 'registry', when: now, action: 'update', entity_id: id, changes, context: ctx() });
      return clone(e);
    },
    async registryRemove(id) {
      hub();
      const e = entity(id);
      if (!e.restored && !e.registryOnly && e.state !== 'unavailable') throw err('entity_still_provided', `${id} is still provided by ${e.integration}`);
      entities.delete(id);
      write({ type: 'registry', when: now, action: 'remove', entity_id: id, context: ctx() });
    },
    async reloadIntegration(integration) {
      hub();
      const integ = view.home.integrations.find((i) => i.integration === integration);
      if (!integ) throw err('unknown_integration', `No integration ${integration}`);
      write({ type: 'integration', when: now, integration, state: integ.state, old_state: integ.state, context: ctx() });
    },
    async selectOption(id, option) {
      hub();
      const e = entity(id);
      const options = Array.isArray(e.attributes.options) ? (e.attributes.options as unknown[]) : [];
      if (!options.includes(option)) throw err('invalid_option', `Option ${option} is not one of ${options.join(', ')}`);
      await api.callService('select', 'select_option', { entity_id: id, option });
      return clone(entity(id));
    },
    now: () => now,
    writes: () => clone(written),
  };
  return api;
}
