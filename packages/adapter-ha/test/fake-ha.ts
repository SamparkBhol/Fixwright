// An in-memory Home Assistant for unit tests: a fetch function and a WebSocket connector that answer
// the REST routes and websocket commands the adapter uses, with the shapes recorded from 2026.9.4.
import type { FetchLike } from '../src/rest.ts';
import type { WebSocketLike, WsConnector } from '../src/socket.ts';
import type {
  HaAreaEntry,
  HaConfigEntry,
  HaDeviceEntry,
  HaEntityEntry,
  HaFlowProgress,
  HaHistoryPoint,
  HaState,
  LogbookRow,
} from '../src/ha-types.ts';

export interface FakeHome {
  token: string;
  haVersion: string;
  coreState: string;
  states: Map<string, HaState>;
  entries: Map<string, HaEntityEntry>;
  devices: HaDeviceEntry[];
  areas: HaAreaEntry[];
  configEntries: HaConfigEntry[];
  flows: HaFlowProgress[];
  logbook: LogbookRow[];
  history: Record<string, HaHistoryPoint[]>;
  manifests: Array<{ domain: string; iot_class?: string; integration_type?: string }>;
  /** false: registry writes are acknowledged but never applied (a hub that loses writes). */
  applyRegistryWrites: boolean;
  /** State reads that still show the old friendly name after a rename. */
  renameLagReads: number;
  /** Renames not yet visible in the state machine. */
  pendingRenames: Map<string, { name: string; reads: number }>;
  /** State after a config entry reload, by entry id (default 'loaded'). */
  reloadResult: Record<string, string>;
  /** Config entries whose reload answers require_restart: true. */
  restartOnly: string[];
  /** The entity ids of every config/entity_registry/get_entries call, in order. */
  getEntriesCalls: string[][];
  /** search/related answers by item id; false makes the command unknown (no search integration). */
  related: Record<string, Record<string, string[]>>;
  searchLoaded: boolean;
  /** Every request, for assertions: "GET /api/states", "ws config/entity_registry/list", ... */
  log: string[];
  sockets: Array<{ close(): void }>;
}

export const T0 = '2026-10-15T10:00:00.000000+00:00';

export function haState(entityId: string, state: string, attributes: Record<string, unknown> = {}, at = T0): HaState {
  return {
    entity_id: entityId,
    state,
    attributes,
    last_changed: at,
    last_updated: at,
    context: { id: `ctx-${entityId}`, parent_id: null, user_id: null },
  };
}

export function haEntry(entityId: string, over: Partial<HaEntityEntry> = {}): HaEntityEntry {
  return {
    entity_id: entityId,
    platform: 'template',
    config_entry_id: null,
    device_id: null,
    area_id: null,
    name: null,
    original_name: null,
    has_entity_name: false,
    aliases: [null],
    disabled_by: null,
    hidden_by: null,
    translation_key: null,
    created_at: 1792058400,
    modified_at: 1792058400,
    ...over,
  };
}

export function fakeHome(over: Partial<FakeHome> = {}): FakeHome {
  return {
    token: 'test-token',
    haVersion: '2026.9.4',
    coreState: 'RUNNING',
    states: new Map(),
    entries: new Map(),
    devices: [],
    areas: [],
    configEntries: [],
    flows: [],
    logbook: [],
    history: {},
    manifests: [],
    applyRegistryWrites: true,
    renameLagReads: 0,
    pendingRenames: new Map(),
    reloadResult: {},
    restartOnly: [],
    getEntriesCalls: [],
    related: {},
    searchLoaded: true,
    log: [],
    sockets: [],
    ...over,
  };
}

export function addEntity(home: FakeHome, state: HaState | undefined, entry?: Partial<HaEntityEntry> | null): void {
  const id = state?.entity_id ?? entry?.entity_id;
  if (!id) throw new Error('need a state or an entry');
  if (state) home.states.set(id, state);
  if (entry !== null && entry !== undefined) home.entries.set(id, haEntry(id, entry));
}

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function readState(home: FakeHome, id: string): HaState | undefined {
  const s = home.states.get(id);
  const rename = home.pendingRenames.get(id);
  if (s && rename) {
    if (rename.reads > 0) {
      rename.reads--;
      return s;
    }
    s.attributes = { ...s.attributes, friendly_name: rename.name };
    home.pendingRenames.delete(id);
  }
  return s;
}

function serviceCall(home: FakeHome, domain: string, service: string, data: Record<string, unknown>): Response {
  const ids = typeof data['entity_id'] === 'string' ? [data['entity_id']] : Array.isArray(data['entity_id']) ? (data['entity_id'] as string[]) : [];
  const changed: HaState[] = [];
  const set = (id: string, state: string) => {
    const s = home.states.get(id);
    if (!s || s.state === state) return;
    const next = { ...s, state, last_changed: '2026-10-15T10:05:00.000000+00:00', last_updated: '2026-10-15T10:05:00.000000+00:00' };
    home.states.set(id, next);
    changed.push(next);
  };
  if (service === 'turn_on' || service === 'turn_off') {
    for (const id of ids) set(id, service === 'turn_on' ? 'on' : 'off');
    return json(200, changed);
  }
  if (service === 'open_cover' || service === 'close_cover') {
    for (const id of ids) set(id, service === 'open_cover' ? 'open' : 'closed');
    return json(200, changed);
  }
  if (service === 'select_option') {
    const id = ids[0] ?? '';
    const options = (home.states.get(id)?.attributes['options'] as string[] | undefined) ?? [];
    if (!options.includes(String(data['option']))) return json(400, { message: 'Invalid option' });
    set(id, String(data['option']));
    return json(200, changed);
  }
  if (service === 'reload' && home.manifests.some((m) => m.domain === domain)) return json(200, []);
  return json(400, { message: `Service ${domain}.${service} not found.` });
}

export function fakeFetch(home: FakeHome): FetchLike {
  return async (url, init) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    home.log.push(`${method} ${u.pathname}`);
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (headers['Authorization'] !== `Bearer ${home.token}`) return json(401, { message: '401: Unauthorized' });
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const path = u.pathname;
    let m: RegExpMatchArray | null;
    if (method === 'GET' && path === '/api/') return json(200, { message: 'API running.' });
    if (method === 'GET' && path === '/api/config') return json(200, { version: home.haVersion, state: home.coreState, components: [] });
    if (method === 'GET' && path === '/api/states') return json(200, [...home.states.keys()].map((id) => readState(home, id)));
    if ((m = path.match(/^\/api\/states\/(.+)$/))) {
      const id = decodeURIComponent(m[1] ?? '');
      if (method === 'POST') {
        const next = haState(id, String(body['state']), (body['attributes'] as Record<string, unknown>) ?? {});
        home.states.set(id, next);
        return json(200, next);
      }
      const s = readState(home, id);
      return s ? json(200, s) : json(404, { message: 'Entity not found.' });
    }
    if (method === 'POST' && (m = path.match(/^\/api\/services\/([a-z0-9_]+)\/([a-z0-9_]+)$/))) {
      return serviceCall(home, m[1] ?? '', m[2] ?? '', body);
    }
    if (method === 'GET' && path === '/api/config/config_entries/entry') {
      const domain = u.searchParams.get('domain');
      return json(200, home.configEntries.filter((e) => !domain || e.domain === domain));
    }
    if (method === 'POST' && (m = path.match(/^\/api\/config\/config_entries\/entry\/([^/]+)\/reload$/))) {
      const entry = home.configEntries.find((e) => e.entry_id === m?.[1]);
      if (!entry) return json(404, { message: 'Invalid entry specified' });
      if (home.restartOnly.includes(entry.entry_id)) return json(200, { require_restart: true });
      entry.state = home.reloadResult[entry.entry_id] ?? 'loaded';
      return json(200, { require_restart: false });
    }
    return json(404, { message: 'Not Found' });
  };
}

type Msg = Record<string, unknown>;

function wsCommand(home: FakeHome, msg: Msg): { result?: unknown; error?: { code: string; message: string } } {
  const type = String(msg['type']);
  const entryIds = (msg['entity_ids'] as string[] | undefined) ?? [];
  switch (type) {
    case 'config/entity_registry/list':
      return { result: [...home.entries.values()].map(({ aliases: _a, ...partial }) => partial) };
    case 'config/entity_registry/get_entries':
      home.getEntriesCalls.push([...entryIds]);
      return { result: Object.fromEntries(entryIds.map((id) => [id, home.entries.get(id) ?? null])) };
    case 'config/entity_registry/get': {
      const e = home.entries.get(String(msg['entity_id']));
      return e ? { result: e } : { error: { code: 'not_found', message: 'Entity not found' } };
    }
    case 'config/entity_registry/update': {
      const id = String(msg['entity_id']);
      const e = home.entries.get(id);
      if (!e) return { error: { code: 'not_found', message: 'Entity not found' } };
      if (home.applyRegistryWrites) {
        const next = { ...e };
        if ('name' in msg) next.name = msg['name'] as string | null;
        if ('aliases' in msg) next.aliases = msg['aliases'] as Array<string | null>;
        if ('disabled_by' in msg) next.disabled_by = msg['disabled_by'] as string | null;
        if ('area_id' in msg) next.area_id = msg['area_id'] as string | null;
        home.entries.set(id, next);
        if (next.disabled_by) home.states.delete(id);
        if ('name' in msg && home.states.has(id)) {
          home.pendingRenames.set(id, { name: (next.name ?? next.original_name ?? '') as string, reads: home.renameLagReads });
        }
      }
      return { result: { entity_entry: home.entries.get(id) } };
    }
    case 'config/entity_registry/remove': {
      const id = String(msg['entity_id']);
      if (!home.entries.delete(id)) return { error: { code: 'not_found', message: 'Entity not found' } };
      home.states.delete(id);
      return { result: null };
    }
    case 'config/device_registry/list':
      return { result: home.devices };
    case 'config/area_registry/list':
      return { result: home.areas };
    case 'manifest/list': {
      const want = msg['integrations'] as string[] | undefined;
      return { result: home.manifests.filter((m) => !want || want.includes(m.domain)) };
    }
    case 'config_entries/flow/progress':
      return { result: home.flows };
    case 'logbook/get_events': {
      const since = Date.parse(String(msg['start_time'])) / 1000;
      const until = msg['end_time'] ? Date.parse(String(msg['end_time'])) / 1000 : Infinity;
      return {
        result: home.logbook.filter((r) => {
          const t = typeof r.when === 'number' ? r.when : Date.parse(r.when) / 1000;
          return t >= since && t <= until && (!entryIds.length || (r.entity_id !== undefined && entryIds.includes(r.entity_id)));
        }),
      };
    }
    case 'history/history_during_period':
      return { result: Object.fromEntries(entryIds.filter((id) => home.history[id]).map((id) => [id, home.history[id]])) };
    case 'search/related':
      if (!home.searchLoaded) return { error: { code: 'unknown_command', message: 'Unknown command.' } };
      return { result: home.related[String(msg['item_id'])] ?? {} };
    case 'subscribe_events':
    case 'unsubscribe_events':
      return { result: null };
    case 'auth/long_lived_access_token':
      return { result: 'llat' };
    default:
      return { error: { code: 'unknown_command', message: `Unknown command ${type}` } };
  }
}

export interface FakeSocketOptions {
  /** Reply to auth with auth_invalid. */
  rejectAuth?: boolean;
  /** Never answer commands of these types (to test deadlines). */
  silent?: string[];
  /** Batch replies into JSON arrays like coalesce_messages. */
  coalesce?: boolean;
}

/** A standard-WebSocket-shaped fake that speaks Home Assistant's websocket protocol. */
export function fakeConnector(home: FakeHome, opts: FakeSocketOptions = {}): WsConnector {
  return (url) => {
    home.log.push(`ws connect ${url}`);
    const listeners: Record<string, Array<(e: unknown) => void>> = { message: [], close: [], error: [] };
    let open = true;
    const emit = (type: string, event: unknown) => setTimeout(() => listeners[type]?.forEach((l) => l(event)), 0);
    const reply = (msgs: Msg[]) => {
      if (!open) return;
      if (opts.coalesce) emit('message', { data: JSON.stringify(msgs) });
      else for (const m of msgs) emit('message', { data: JSON.stringify(m) });
    };
    const ws: WebSocketLike & { close(): void } = {
      addEventListener(type, listener) {
        listeners[type]?.push(listener);
      },
      send(data) {
        if (!open) throw new Error('socket closed');
        const msg = JSON.parse(data) as Msg;
        if (msg['type'] === 'auth') {
          reply([
            opts.rejectAuth || msg['access_token'] !== home.token
              ? { type: 'auth_invalid', message: 'Invalid access token or password' }
              : { type: 'auth_ok', ha_version: home.haVersion },
          ]);
          return;
        }
        home.log.push(`ws ${String(msg['type'])}`);
        if (opts.silent?.includes(String(msg['type']))) return;
        if (msg['type'] === 'ping') {
          reply([{ id: msg['id'], type: 'pong' }]);
          return;
        }
        const out = wsCommand(home, msg);
        reply([
          out.error
            ? { id: msg['id'], type: 'result', success: false, error: out.error }
            : { id: msg['id'], type: 'result', success: true, result: out.result },
        ]);
      },
      close() {
        if (!open) return;
        open = false;
        emit('close', { code: 1000 });
      },
    };
    home.sockets.push(ws);
    emit('message', { data: JSON.stringify({ type: 'auth_required', ha_version: home.haVersion }) });
    return ws;
  };
}
