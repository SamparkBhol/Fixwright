// HaAdapter: HomeAdapter over a real Home Assistant 2026.9.4.
// REST for states, service calls and config entries; the websocket for registries, logbook, history,
// automation references and registry writes. registryUpdate, registryRemove, selectOption and config entry reloads are read
// back before they return, because a websocket result or a REST response can arrive before the state
// machine shows the change. callService returns what Home Assistant reports as
// changed and leaves the read-back to the caller (the engine's executor reads every step back).

import type {
  Clock,
  CloudStatus,
  Entity,
  EntityId,
  EventQuery,
  HomeAdapter,
  HouseEvent,
  HubStatus,
  IntegrationStatus,
  RegistryPatch,
  Rng,
  Signals,
  Transport,
} from '@fixwright/protocol';
import { createAuthGate } from './auth.ts';
import { haError, isHaError } from './errors.ts';
import {
  DEFAULT_DENY_DOMAINS,
  DEFAULT_UNSAFE_NAMES,
  entityRefusal,
  forwardedTo,
  hasIndirectTargets,
  normalizeEntityId,
  reachRefusal,
  resolveIndirect,
  serviceRefusal,
  serviceTarget,
  type GuardPolicy,
  type Refused,
  type TargetEntry,
} from './guard.ts';
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
import {
  buildEntities,
  cloudSensorCandidates,
  cloudStatusFrom,
  countFlaps,
  domainOf,
  entityFrom,
  expectedFriendlyName,
  historyTransitions,
  mergeEvents,
  reauthEntries,
  relatedEntityIds,
  signalsFrom,
  toIntegrationStatus,
  toMs,
  type ManifestInfo,
  type Registries,
} from './map.ts';
import { backoffMs, createRest, DEFAULT_RETRY, DEFAULT_TIMEOUT_MS, type FetchLike, type HaRest, type RetryPolicy, type Sleep } from './rest.ts';
import { connectSocket, type HaSocket, type WsConnector } from './socket.ts';

export interface HaAdapterConfig {
  /** http(s)://host:port of Home Assistant (a trailing /api is fine). */
  baseUrl: string;
  /** A long lived access token of an admin user (registry writes need admin). */
  token: string;
  /** Deadline for each REST attempt and each websocket command. Default 10 s. */
  timeoutMs?: number;
  /** Retries for idempotent reads, with jittered exponential backoff. */
  retry?: Partial<RetryPolicy>;
  /** How long a write may take to show up when read back. Default 5 s. */
  readBackTimeoutMs?: number;
  readBackPollMs?: number;
  /** Device, area and manifest registries change rarely; cache them this long. Default 30 s. */
  registryCacheMs?: number;
  /**
   * Entity domains the adapter refuses to touch, as a last line of defense under the engine's own
   * rules, however a call reaches them (src/guard.ts). Default: lock, alarm_control_panel,
   * camera, siren.
   */
  denyDomains?: readonly string[];
  /** Covers with device class garage, gate or door are refused unless this is true. */
  allowGarageCovers?: boolean;
  /** Entities named like this are refused too (default: the engine's words); null turns it off. */
  unsafeNames?: RegExp | null;
  /**
   * 'domain.service' names the guard lets through although it cannot see all they reach (an
   * integration's own services, calls without a target). The entities they name are still checked.
   */
  allowServices?: readonly string[];
  /** After Home Assistant rejects the token, calls fail without being sent for this long. Default 30 s. */
  authHoldMs?: number;
  /** Transport overrides by entity id or integration, for integrations the built-in table misreads. */
  transportHints?: Readonly<Record<string, Transport>>;
  /** Whether events() keeps number-to-number sensor changes. Default 'drop'. */
  numericChanges?: 'drop' | 'keep';
  clock?: Clock;
  rng?: Rng;
  sleep?: Sleep;
  fetch?: FetchLike;
  /** Websocket factory; in a Worker either new WebSocket(url) or the fetch Upgrade path. */
  connector?: WsConnector;
}

export interface HaAdapter extends HomeAdapter {
  readonly kind: 'home-assistant';
  readonly rest: HaRest;
  /** The shared websocket, reconnected on demand. */
  socket(): Promise<HaSocket>;
  /** Closes the websocket. The adapter reconnects if it is used again. */
  close(): void;
}

/** Above this many individual state reads, one read of the whole state machine is cheaper. */
const MAX_SINGLE_READS = 12;

const systemClock: Clock = { now: () => new Date().toISOString(), nowMs: () => Date.now() };
const mathRng: Rng = { next: () => Math.random() };
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** entity_id may be a string, a comma list or an array, directly or under target. */
export function targetEntityIds(data: Record<string, unknown>): EntityId[] {
  return serviceTarget(data).entityIds;
}

const refused = (r: Refused) => haError('refused', r.message, { refusal: r.refusal });

interface EntityIndex {
  byId: ReadonlyMap<EntityId, HaEntityEntry>;
  byDevice: ReadonlyMap<string, EntityId[]>;
}

function indexEntries(list: HaEntityEntry[]): EntityIndex {
  const byId = new Map<EntityId, HaEntityEntry>();
  const byDevice = new Map<string, EntityId[]>();
  for (const e of list) {
    byId.set(e.entity_id, e);
    if (e.device_id) byDevice.set(e.device_id, [...(byDevice.get(e.device_id) ?? []), e.entity_id]);
  }
  return { byId, byDevice };
}

export function createHaAdapter(config: HaAdapterConfig): HaAdapter {
  const clock = config.clock ?? systemClock;
  const rng = config.rng ?? mathRng;
  const sleep = config.sleep ?? realSleep;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const policy: RetryPolicy = { ...DEFAULT_RETRY, ...config.retry };
  const readBackTimeoutMs = config.readBackTimeoutMs ?? 5000;
  const readBackPollMs = config.readBackPollMs ?? 50;
  const cacheMs = config.registryCacheMs ?? 30_000;
  const guardPolicy: GuardPolicy = {
    denyDomains: new Set(config.denyDomains ?? DEFAULT_DENY_DOMAINS),
    allowGarageCovers: config.allowGarageCovers ?? false,
    unsafeNames: config.unsafeNames === undefined ? DEFAULT_UNSAFE_NAMES : config.unsafeNames,
    allowServices: new Set(config.allowServices ?? []),
  };
  const numericChanges = config.numericChanges ?? 'drop';
  const hints = config.transportHints;

  // One auth verdict for REST and the websocket login alike (src/auth.ts).
  const auth = createAuthGate({ ...(config.authHoldMs === undefined ? {} : { holdMs: config.authHoldMs }), now: () => clock.nowMs() });
  const rest = createRest({
    baseUrl: config.baseUrl,
    token: config.token,
    timeoutMs,
    retry: policy,
    rng,
    sleep,
    auth,
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });

  // Websocket: one shared connection, opened lazily and reopened after it drops. Single flight, for
  // success and failure alike: every call that arrives while a handshake is running waits for that
  // handshake and gets its socket or its error. The login also goes through the auth gate, so a wrong
  // token costs one failed login across REST and websocket together, and calls after it fail at once
  // until the hold ends (Home Assistant can ban an IP after repeated failed logins).
  let live: HaSocket | undefined;
  let connecting: Promise<HaSocket> | undefined;
  let generation = 0;
  function socket(): Promise<HaSocket> {
    if (live?.isOpen) return Promise.resolve(live);
    if (connecting) return connecting;
    const gen = generation;
    const attempt = auth.run('websocket login', () =>
      connectSocket({
        baseUrl: rest.baseUrl,
        token: config.token,
        timeoutMs,
        commandTimeoutMs: timeoutMs,
        ...(config.connector ? { connector: config.connector } : {}),
      }),
    );
    connecting = attempt;
    attempt
      .then(
        (s) => {
          // close() ran while this handshake was in flight: do not keep its socket.
          if (gen === generation) live = s;
          else s.close();
        },
        () => undefined,
      )
      .finally(() => {
        if (connecting === attempt) connecting = undefined;
      });
    return attempt;
  }

  async function ws<T>(type: string, payload: Record<string, unknown> = {}, idempotent = true): Promise<T> {
    for (let n = 0; ; n++) {
      let s: HaSocket | undefined;
      try {
        s = await socket();
        return await s.command<T>(type, payload);
      } catch (err) {
        // A command that times out on a connection that no longer answers pings means the socket is
        // half open: drop it so the next attempt reconnects instead of waiting out every retry.
        if (s && isHaError(err) && err.kind === 'timeout' && !(await s.ping(Math.min(2000, timeoutMs)))) s.close();
        // A failed handshake sent nothing, so even a write may try again.
        const mayRetry = idempotent || s === undefined;
        if (!mayRetry || n >= policy.retries || !isHaError(err) || !err.retryable) throw err;
        await sleep(backoffMs(n, policy, rng));
      }
    }
  }

  // Caches for registries that change rarely. listEntities and getEntity always read the entity
  // registry fresh; signals() uses a cached index of it (device membership rarely changes), which the
  // adapter's own registry writes clear.
  let indexCache: { at: number; value: Promise<EntityIndex> } | undefined;
  let devicesCache: { at: number; value: Promise<Map<string, HaDeviceEntry>> } | undefined;
  let areasCache: { at: number; value: Promise<Map<string, HaAreaEntry>> } | undefined;
  const manifests = new Map<string, ManifestInfo>();
  let manifestsAt = -Infinity;

  const fresh = (c: { at: number } | undefined) => c !== undefined && clock.nowMs() - c.at < cacheMs;

  function entityIndex(refresh = false): Promise<EntityIndex> {
    if (refresh || !fresh(indexCache)) {
      const value = ws<HaEntityEntry[]>('config/entity_registry/list').then(indexEntries);
      value.catch(() => {
        if (indexCache?.value === value) indexCache = undefined;
      });
      indexCache = { at: clock.nowMs(), value };
    }
    return (indexCache as { value: Promise<EntityIndex> }).value;
  }

  function devices(): Promise<Map<string, HaDeviceEntry>> {
    if (!fresh(devicesCache)) {
      const value = ws<HaDeviceEntry[]>('config/device_registry/list').then((list) => new Map(list.map((d) => [d.id, d])));
      value.catch(() => (devicesCache = undefined));
      devicesCache = { at: clock.nowMs(), value };
    }
    return (devicesCache as { value: Promise<Map<string, HaDeviceEntry>> }).value;
  }

  function areas(): Promise<Map<string, HaAreaEntry>> {
    if (!fresh(areasCache)) {
      const value = ws<HaAreaEntry[]>('config/area_registry/list').then((list) => new Map(list.map((a) => [a.area_id, a])));
      value.catch(() => (areasCache = undefined));
      areasCache = { at: clock.nowMs(), value };
    }
    return (areasCache as { value: Promise<Map<string, HaAreaEntry>> }).value;
  }

  async function manifestsFor(domains: Iterable<string>): Promise<Map<string, ManifestInfo>> {
    if (clock.nowMs() - manifestsAt >= cacheMs) {
      manifests.clear();
      manifestsAt = clock.nowMs();
    }
    const missing = [...new Set(domains)].filter((d) => !manifests.has(d));
    if (missing.length) {
      try {
        const list = await ws<Array<{ domain: string; iot_class?: string; integration_type?: string }>>('manifest/list', { integrations: missing });
        for (const m of list) {
          manifests.set(m.domain, {
            ...(m.iot_class ? { iotClass: m.iot_class } : {}),
            ...(m.integration_type ? { integrationType: m.integration_type } : {}),
          });
        }
      } catch (err) {
        // Manifests only refine transport guesses; a hub that refuses them still works.
        if (!isHaError(err) || err.kind === 'unreachable' || err.kind === 'timeout') throw err;
      }
      for (const d of missing) if (!manifests.has(d)) manifests.set(d, {});
    }
    return manifests;
  }

  // Automation references: every entity an automation triggers on, checks or acts
  // on, from Home Assistant's search/related (it lists ids that no longer exist too, which is what the
  // engine's dead_trigger finding looks for). Cached per automation for registryCacheMs.
  const refsCache = new Map<EntityId, { at: number; value: Promise<EntityId[] | undefined> }>();
  function automationReferences(id: EntityId): Promise<EntityId[] | undefined> {
    const hit = refsCache.get(id);
    if (hit && clock.nowMs() - hit.at < cacheMs) return hit.value;
    const value = ws<Partial<Record<string, string[]>>>('search/related', { item_type: 'automation', item_id: id }).then(
      (found) => [...new Set((found['entity'] ?? []).map(normalizeEntityId))].sort(),
      (err: unknown) => {
        // A hub without the search integration still works; its automations just carry no references.
        if (isHaError(err) && (err.kind === 'bad_request' || err.kind === 'not_found' || err.kind === 'command_failed')) return undefined;
        throw err;
      },
    );
    value.catch(() => {
      if (refsCache.get(id)?.value === value) refsCache.delete(id);
    });
    refsCache.set(id, { at: clock.nowMs(), value });
    return value;
  }

  async function withReferences(entities: Entity[]): Promise<Entity[]> {
    const autos = entities.filter((e) => e.domain === 'automation' && !e.registryOnly);
    if (autos.length === 0) return entities;
    const refs = new Map(await Promise.all(autos.map(async (a) => [a.entityId, await automationReferences(a.entityId)] as const)));
    return entities.map((e) => {
      const references = refs.get(e.entityId);
      return references ? { ...e, attributes: { ...e.attributes, references } } : e;
    });
  }

  async function registryEntries(ids?: EntityId[]): Promise<Map<EntityId, HaEntityEntry>> {
    const wanted = ids ?? (await ws<Array<{ entity_id: string }>>('config/entity_registry/list')).map((e) => e.entity_id);
    if (wanted.length === 0) return new Map();
    const got = await ws<Record<EntityId, HaEntityEntry | null>>('config/entity_registry/get_entries', { entity_ids: wanted });
    return new Map(Object.entries(got).filter((kv): kv is [EntityId, HaEntityEntry] => kv[1] !== null));
  }

  async function registries(ids?: EntityId[]): Promise<Registries> {
    const [entries, devs, ars] = await Promise.all([registryEntries(ids), devices(), areas()]);
    const domains = [...entries.values()].map((e) => e.platform);
    return { entries, devices: devs, areas: ars, manifests: await manifestsFor(domains) };
  }

  async function stateOrUndefined(id: EntityId): Promise<HaState | undefined> {
    try {
      return await rest.state(id);
    } catch (err) {
      if (isHaError(err) && err.kind === 'not_found') return undefined;
      throw err;
    }
  }

  async function entityOrNull(id: EntityId): Promise<Entity | null> {
    const [state, reg] = await Promise.all([stateOrUndefined(id), registries([id])]);
    if (!state && !reg.entries.has(id)) return null;
    const [entity] = await withReferences([entityFrom(id, state, reg, clock.now(), hints)]);
    return entity ?? null;
  }

  /** Polls until `check` holds or the read-back deadline passes. */
  async function readBack<T>(what: string, load: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
    const deadline = clock.nowMs() + readBackTimeoutMs;
    let value = await load();
    while (!check(value)) {
      if (clock.nowMs() >= deadline) throw haError('readback', `${what} did not show up within ${readBackTimeoutMs} ms`);
      await sleep(readBackPollMs);
      value = await load();
    }
    return value;
  }

  /**
   * Resolves everything a service call would reach (explicit ids, entity_id "all", area, device, floor
   * and label targets, then the members of groups and scenes, recursively) and refuses the call before
   * anything is sent if any of it is unsafe or cannot be resolved. See src/guard.ts.
   */
  async function guardService(domain: string, service: string, data: Record<string, unknown>): Promise<void> {
    const early = serviceRefusal(domain, service, guardPolicy);
    if (early) throw refused(early);
    const target = serviceTarget(data);
    if (target.invalidIds.length > 0) {
      throw refused({ refusal: 'unverified', message: `not entity ids Home Assistant accepts: ${target.invalidIds.join(', ')}` });
    }
    const reached = new Set<EntityId>(target.entityIds);

    // One read of the whole state machine at most, shared by everything below.
    let all: Promise<Map<EntityId, HaState>> | undefined;
    const allStates = () => (all ??= rest.states().then((list) => new Map(list.map((s) => [s.entity_id, s]))));
    if (target.matchAll) {
      for (const id of (await allStates()).keys()) if (domain === 'homeassistant' || domainOf(id) === domain) reached.add(id);
    }
    if (hasIndirectTargets(target)) {
      // Read fresh: a stale cache here could miss a lock that was just added to the area.
      const [entries, devs, ars] = await Promise.all([
        ws<TargetEntry[]>('config/entity_registry/list'),
        ws<HaDeviceEntry[]>('config/device_registry/list'),
        ws<HaAreaEntry[]>('config/area_registry/list'),
      ]);
      const resolved = resolveIndirect(target, { entries, devices: devs, areas: ars });
      if (resolved.unknownDevices.length > 0) {
        throw refused({ refusal: 'unverified', message: `unknown device ${resolved.unknownDevices.join(', ')}: Fixwright cannot see what it would reach` });
      }
      for (const id of resolved.entityIds) reached.add(id);
    }
    const nothing = reachRefusal(domain, service, reached.size, guardPolicy);
    if (nothing) throw refused(nothing);

    // Breadth first: the entities reached, then the members their groups and scenes forward to.
    let singleReads = 0;
    const seen = new Set<EntityId>();
    for (let level = [...reached]; level.length > 0; ) {
      const unseen = [...new Set(level)].filter((id) => !seen.has(id));
      for (const id of unseen) seen.add(id);
      const readAll = all !== undefined || singleReads + unseen.length > MAX_SINGLE_READS;
      if (!readAll) singleReads += unseen.length;
      const states = readAll
        ? await allStates().then((byId) => unseen.map((id) => byId.get(id)))
        : await Promise.all(unseen.map(stateOrUndefined));
      const next: EntityId[] = [];
      const problems: Refused[] = [];
      for (const [i, id] of unseen.entries()) {
        const bad = entityRefusal(id, states[i], guardPolicy, { domain, service });
        if (bad) problems.push(bad);
        next.push(...forwardedTo(states[i]));
      }
      // An unsafe device is the clearer reason to give, so it wins over "cannot check".
      const worst = problems.find((p) => p.refusal === 'unsafe_device') ?? problems[0];
      if (worst) throw refused(worst);
      level = next;
    }
  }

  async function history(ids: EntityId[], sinceIso: string, untilIso: string): Promise<Record<EntityId, HaHistoryPoint[]>> {
    if (ids.length === 0) return {};
    return ws<Record<EntityId, HaHistoryPoint[]>>('history/history_during_period', {
      start_time: sinceIso,
      end_time: untilIso,
      entity_ids: ids,
      include_start_time_state: true,
      significant_changes_only: false,
      minimal_response: true,
      no_attributes: true,
    });
  }

  const adapter: HaAdapter = {
    kind: 'home-assistant',
    rest,
    socket,

    close() {
      generation++;
      live?.close();
      live = undefined;
      connecting = undefined;
    },

    now: () => clock.now(),

    async listEntities() {
      const [states, reg] = await Promise.all([rest.states(), registries()]);
      return withReferences(buildEntities(states, reg, clock.now(), hints));
    },

    getEntity: (id) => entityOrNull(id),

    async callService(rawDomain, rawService, data) {
      // Home Assistant lower cases service names (ServiceRegistry.async_call); check what it will run.
      const domain = rawDomain.trim().toLowerCase();
      const service = rawService.trim().toLowerCase();
      await guardService(domain, service, data);
      const changed = await rest.callService(domain, service, data);
      if (!Array.isArray(changed) || changed.length === 0) return { changed: [] };
      const reg = await registries(changed.map((s) => s.entity_id));
      return { changed: await withReferences(changed.map((s) => entityFrom(s.entity_id, s, reg, clock.now(), hints))) };
    },

    async events(q: EventQuery): Promise<HouseEvent[]> {
      const sinceMs = toMs(q.since);
      const untilMs = q.until === undefined ? clock.nowMs() : toMs(q.until);
      if (sinceMs === undefined || untilMs === undefined || untilMs < sinceMs) {
        throw haError('bad_request', `not a valid time window: ${q.since} to ${q.until ?? 'now'}`);
      }
      const sinceIso = new Date(sinceMs).toISOString();
      const untilIso = new Date(untilMs).toISOString();
      const scoped = q.entityIds?.length ? q.entityIds : undefined;
      const all = scoped ? undefined : await rest.states();
      const ids = scoped ?? (all ?? []).map((s) => s.entity_id);
      // Battery sensors by device class too (not only by id), so 'drop' keeps their levels. A scoped
      // query reads the states of its sensors only, alongside the logbook and history reads.
      const batteryStates = async (): Promise<Array<HaState | undefined>> => {
        if (all) return all;
        const sensors = ids.filter((id) => domainOf(id) === 'sensor');
        if (sensors.length > MAX_SINGLE_READS) return rest.states();
        return Promise.all(sensors.map(stateOrUndefined));
      };
      const [rows, hist, batteries] = await Promise.all([
        ws<LogbookRow[]>('logbook/get_events', {
          start_time: sinceIso,
          end_time: untilIso,
          ...(scoped ? { entity_ids: scoped } : {}),
        }),
        history(ids, sinceIso, untilIso),
        batteryStates(),
      ]);
      const batteryIds = new Set(batteries.filter((s) => s?.attributes['device_class'] === 'battery').map((s) => s?.entity_id ?? ''));
      return mergeEvents(historyTransitions(hist, sinceMs), rows, { sinceMs, untilMs, numericChanges, batteryIds });
    },

    async signals(id): Promise<Signals> {
      // Scoped reads: the entity, its device's other entities (or, without a device, entities named
      // <object_id>_<signal>), and its own 24 h history. The checkup calls this for every device at
      // once, so the entity registry comes from the shared index instead of a full read per call.
      const [state, cached] = await Promise.all([stateOrUndefined(id), entityIndex()]);
      // An entity the cached index does not know may be brand new: look once more before saying so.
      const index = !state && !cached.byId.has(id) ? await entityIndex(true) : cached;
      const entry = index.byId.get(id);
      if (!state && !entry) throw haError('not_found', `no entity ${id} in Home Assistant`);

      const relatedStates = async (): Promise<Array<{ state: HaState; entry: HaEntityEntry | undefined }>> => {
        let ids: EntityId[];
        let byId: Map<EntityId, HaState | undefined>;
        if (entry?.device_id) {
          ids = (index.byDevice.get(entry.device_id) ?? []).filter((rid) => rid !== id);
          byId =
            ids.length > MAX_SINGLE_READS
              ? new Map((await rest.states()).map((s) => [s.entity_id, s]))
              : new Map(await Promise.all(ids.map(async (rid) => [rid, await stateOrUndefined(rid)] as const)));
        } else {
          byId = new Map((await rest.states()).map((s) => [s.entity_id, s]));
          ids = relatedEntityIds(id, { entries: index.byId }, byId.keys());
        }
        return ids
          .map((rid) => ({ state: byId.get(rid), entry: index.byId.get(rid) }))
          .filter((r): r is { state: HaState; entry: HaEntityEntry | undefined } => r.state !== undefined);
      };
      const untilMs = clock.nowMs();
      const [related, day] = await Promise.all([
        relatedStates(),
        history([id], new Date(untilMs - 86_400_000).toISOString(), new Date(untilMs).toISOString()),
      ]);
      return signalsFrom({ state, related, flaps24h: countFlaps(day[id] ?? []) });
    },

    async integrations(): Promise<IntegrationStatus[]> {
      const [entries, flows] = await Promise.all([
        rest.configEntries(),
        ws<HaFlowProgress[]>('config_entries/flow/progress').catch((err: unknown) => {
          if (isHaError(err) && (err.kind === 'unreachable' || err.kind === 'timeout')) throw err;
          return [] as HaFlowProgress[];
        }),
      ]);
      const reauth = reauthEntries(flows);
      return entries.map((e) => toIntegrationStatus(e, reauth));
    },

    async hubStatus(): Promise<HubStatus> {
      const t0 = clock.nowMs();
      try {
        const cfg = await rest.config({ idempotent: false });
        return { reachable: cfg.state === 'RUNNING', latencyMs: Math.max(0, clock.nowMs() - t0), version: cfg.version };
      } catch (err) {
        if (isHaError(err) && (err.kind === 'unreachable' || err.kind === 'timeout' || err.kind === 'server')) {
          return { reachable: false };
        }
        throw err;
      }
    },

    async cloudStatus(vendor): Promise<CloudStatus> {
      const [states, entries] = await Promise.all([rest.states(), rest.configEntries()]);
      // Registry rows only for the few cloud connectivity sensors, not the whole registry.
      const sensors = cloudSensorCandidates(states);
      const domains = entries.map((e) => e.domain);
      const [registry, devs, mf] = await Promise.all([
        registryEntries(sensors.map((s) => s.entity_id)),
        sensors.length > 0 ? devices() : Promise.resolve(new Map<string, HaDeviceEntry>()),
        manifestsFor(domains),
      ]);
      const cloudDomains = new Set(domains.filter((d) => mf.get(d)?.iotClass?.startsWith('cloud')));
      return cloudStatusFrom({ vendor, checkedAt: clock.now(), states: sensors, entries, registry, devices: devs, cloudDomains });
    },

    async registryUpdate(id, patch: RegistryPatch): Promise<Entity> {
      const before = (await registryEntries([id])).get(id);
      if (!before) throw haError('not_found', `${id} is not in the entity registry, so it cannot be renamed or disabled`);
      const changes: Record<string, unknown> = {};
      if (patch.name !== undefined) changes['name'] = patch.name;
      if (patch.aliases !== undefined) {
        // Keep Home Assistant's "computed name" alias (null) if the entry had it, so the name still matches.
        const keepComputed = (before.aliases ?? [null]).includes(null);
        changes['aliases'] = keepComputed ? [null, ...patch.aliases] : [...patch.aliases];
      }
      if (patch.disabled !== undefined) changes['disabled_by'] = patch.disabled ? 'user' : null;
      if (Object.keys(changes).length > 0) {
        indexCache = undefined;
        await ws('config/entity_registry/update', { entity_id: id, ...changes });
      }
      const sameAliases = (entry: HaEntityEntry) =>
        patch.aliases === undefined ||
        JSON.stringify((entry.aliases ?? []).filter((a) => a !== null).sort()) === JSON.stringify([...patch.aliases].sort());
      const entry = await readBack(
        `registry change on ${id}`,
        async () => (await registryEntries([id])).get(id),
        (e) =>
          !!e &&
          (patch.name === undefined || e.name === patch.name) &&
          sameAliases(e) &&
          (patch.disabled === undefined || (e.disabled_by !== null) === patch.disabled),
      );
      const devs = await devices();
      const device = entry?.device_id ? devs.get(entry.device_id) : undefined;
      if (patch.disabled === true) {
        // A disabled entity leaves the state machine; wait for that.
        await readBack(`${id} leaving the state machine`, () => stateOrUndefined(id), (s) => s === undefined);
      } else if (patch.name !== undefined && entry) {
        // The registry check above is the strict one. The state machine picks the new friendly name up a
        // moment later; wait for the name Home Assistant's naming rules predict, but if an integration
        // names its entities some other way, return what Home Assistant shows rather than fail a rename
        // that did happen.
        const expected = expectedFriendlyName(entry, device);
        if (expected && (await stateOrUndefined(id))) {
          await readBack(`the new name of ${id}`, () => stateOrUndefined(id), (s) => !s || s.attributes['friendly_name'] === expected).catch(
            (err: unknown) => {
              if (!isHaError(err) || err.kind !== 'readback') throw err;
            },
          );
        }
      }
      const result = await entityOrNull(id);
      if (!result) throw haError('readback', `${id} disappeared after the registry change`);
      return result;
    },

    async registryRemove(id) {
      indexCache = undefined;
      await ws('config/entity_registry/remove', { entity_id: id }, false);
      await readBack(
        `removal of ${id}`,
        async () => ({ state: await stateOrUndefined(id), entry: (await registryEntries([id])).get(id) }),
        (r) => r.state === undefined && r.entry === undefined,
      );
    },

    async reloadIntegration(integration) {
      const all = await rest.configEntries();
      const entries = all.filter((e) => (e.domain === integration || e.entry_id === integration) && !e.disabled_by);
      if (entries.length === 0) {
        // YAML integrations (template, automation, group) have no config entry but a reload service.
        try {
          await rest.callService(integration, 'reload', {});
          return;
        } catch (err) {
          if (isHaError(err) && (err.kind === 'bad_request' || err.kind === 'not_found')) {
            throw haError('not_found', `no config entry and no reload service for ${integration}`, { cause: err });
          }
          throw err;
        }
      }
      for (const e of entries) {
        const res = await rest.reloadConfigEntry(e.entry_id);
        if (res?.require_restart) throw haError('unsupported', `${e.domain} needs a Home Assistant restart to reload`);
      }
      const ids = new Set(entries.map((e) => e.entry_id));
      const settled = (list: HaConfigEntry[]) => list.filter((e) => ids.has(e.entry_id)).every((e) => e.state !== 'setup_in_progress' && e.state !== 'unload_in_progress' && e.state !== 'not_loaded');
      const after = await readBack(`reload of ${integration}`, () => rest.configEntries(), settled);
      const failed = after.find((e) => ids.has(e.entry_id) && e.state !== 'loaded');
      if (failed) throw haError('readback', `${failed.domain} reloaded into state ${failed.state}${failed.reason ? `: ${failed.reason}` : ''}`);
    },

    async selectOption(id, option) {
      const domain = domainOf(id);
      if (domain !== 'select' && domain !== 'input_select') {
        throw haError('bad_request', `${id} is not a select entity`);
      }
      const current = await rest.state(id);
      // The guard's entity rules apply here too (a lock's mode select is named like a lock).
      const unsafe = entityRefusal(id, current, guardPolicy, { domain, service: 'select_option' });
      if (unsafe) throw refused(unsafe);
      const options = Array.isArray(current.attributes['options']) ? (current.attributes['options'] as unknown[]) : [];
      if (!options.includes(option)) {
        throw haError('bad_request', `${id} has no option ${JSON.stringify(option)} (options: ${options.join(', ')})`);
      }
      if (current.state !== option) {
        await rest.callService(domain, 'select_option', { entity_id: id, option });
        await readBack(`${id} = ${option}`, () => rest.state(id), (s) => s.state === option);
      }
      const result = await entityOrNull(id);
      if (!result) throw haError('readback', `${id} disappeared after select_option`);
      return result;
    },
  };
  return adapter;
}
