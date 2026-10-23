// A small Home Assistant client for the fixture scripts (onboard.ts, inject.ts): REST over fetch and the
// websocket API over the standard WebSocket (built into Node 22). It covers only what those scripts need
// and has no dependencies, so the fixtures work without any agent's adapter. Every write that the fault
// injector relies on is read back before it returns.

export interface HaContext {
  id: string;
  parent_id: string | null;
  user_id: string | null;
}

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  context?: HaContext;
}

export interface HaEvent<T = unknown> {
  event_type: string;
  data: T;
  origin: string;
  time_fired: string;
  context: HaContext;
}

export interface StateChangedData {
  entity_id: string;
  old_state: HaState | null;
  new_state: HaState | null;
}

export interface HaConfigEntry {
  entry_id: string;
  domain: string;
  state: string;
  source: string;
  disabled_by: string | null;
}

export interface HaRest {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  config(): Promise<{ state: string; version: string }>;
  state(entityId: string): Promise<HaState>;
  forceState(entityId: string, state: string, attributes?: Record<string, unknown>): Promise<HaState>;
  callService(domain: string, service: string, data?: Record<string, unknown>): Promise<HaState[]>;
  configEntries(domain?: string): Promise<HaConfigEntry[]>;
}

export interface HaSocket {
  command<T = unknown>(type: string, payload?: Record<string, unknown>): Promise<T>;
  subscribeEvents<T = unknown>(eventType: string, onEvent: (event: HaEvent<T>) => void): Promise<() => Promise<void>>;
  close(): void;
}

export interface HaClient {
  rest: HaRest;
  /** One shared, lazily opened websocket. */
  socket(): Promise<HaSocket>;
  callService(domain: string, service: string, data?: Record<string, unknown>): Promise<HaState[]>;
  /** Reloads every config entry of an integration, or calls its reload service when it has none (YAML). */
  reloadIntegration(integration: string): Promise<void>;
  /** Renames an entity in the registry and waits until the registry shows the new name. */
  registryUpdate(entityId: string, patch: { name: string | null }): Promise<void>;
  /** Selects an option on a select entity and waits until its state reads back as that option. */
  selectOption(entityId: string, option: string): Promise<void>;
  close(): void;
}

export interface ConnectOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** A WebSocket constructor; defaults to the global one. */
  WebSocket?: new (url: string) => WebSocket;
  timeoutMs?: number;
}

const SLUG = /^[a-z0-9_]+$/;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls `read` until `ok` holds, or throws after `timeoutMs`. */
export async function readBack<T>(label: string, read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`read back failed after ${timeoutMs} ms: ${label}`);
    await sleep(50);
  }
}

export function createRest(opts: ConnectOptions): HaRest {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${method} ${path}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  const id = (entityId: string) => encodeURIComponent(entityId.toLowerCase());
  return {
    request,
    config: () => request('GET', '/api/config'),
    state: (entityId) => request('GET', `/api/states/${id(entityId)}`),
    forceState: (entityId, state, attributes = {}) => request('POST', `/api/states/${id(entityId)}`, { state, attributes }),
    callService: (domain, service, data = {}) => {
      if (!SLUG.test(domain) || !SLUG.test(service)) return Promise.reject(new Error(`not a service name: ${domain}.${service}`));
      return request('POST', `/api/services/${domain}/${service}`, data);
    },
    configEntries: (domain) =>
      request('GET', `/api/config/config_entries/entry${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`),
  };
}

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Opens the websocket API and authenticates. Home Assistant may batch several messages in one JSON array. */
export function connectSocket(opts: ConnectOptions): Promise<HaSocket> {
  const Ctor = opts.WebSocket ?? globalThis.WebSocket;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const url = `${opts.baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/api/websocket`;
  const ws = new Ctor(url);
  const pending = new Map<number, Pending>();
  const listeners = new Map<number, (event: HaEvent) => void>();
  let nextId = 1;
  let open = false;

  const failAll = (err: Error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };
  const send = (id: number, type: string, payload: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no answer to ${type} within ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, type, ...payload }));
    });

  const socket: HaSocket = {
    command: <T>(type: string, payload: Record<string, unknown> = {}) => send(nextId++, type, payload) as Promise<T>,
    async subscribeEvents<T>(eventType: string, onEvent: (event: HaEvent<T>) => void) {
      const id = nextId++;
      listeners.set(id, onEvent as (event: HaEvent) => void);
      await send(id, 'subscribe_events', { event_type: eventType });
      return async () => {
        if (!listeners.delete(id) || !open) return;
        await send(nextId++, 'unsubscribe_events', { subscription: id });
      };
    },
    close() {
      if (!open) return;
      open = false;
      failAll(new Error('the Home Assistant websocket was closed'));
      ws.close(1000, 'done');
    },
  };

  return new Promise<HaSocket>((resolve, reject) => {
    const authTimer = setTimeout(() => {
      reject(new Error(`no websocket auth from ${url} within ${timeoutMs} ms`));
      ws.close();
    }, timeoutMs);
    ws.addEventListener('message', (event: MessageEvent) => {
      const parsed: unknown = JSON.parse(String(event.data));
      for (const msg of (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>) {
        const type = msg['type'];
        if (type === 'auth_required') {
          ws.send(JSON.stringify({ type: 'auth', access_token: opts.token }));
        } else if (type === 'auth_ok') {
          open = true;
          clearTimeout(authTimer);
          resolve(socket);
        } else if (type === 'auth_invalid') {
          clearTimeout(authTimer);
          reject(new Error(`Home Assistant rejected the token: ${String(msg['message'] ?? '')}`));
          ws.close();
        } else if (type === 'event') {
          listeners.get(Number(msg['id']))?.(msg['event'] as HaEvent);
        } else if (type === 'result') {
          const p = pending.get(Number(msg['id']));
          if (!p) continue;
          pending.delete(Number(msg['id']));
          clearTimeout(p.timer);
          if (msg['success']) p.resolve(msg['result']);
          else p.reject(new Error(`websocket command failed: ${JSON.stringify(msg['error'] ?? null)}`));
        }
      }
    });
    ws.addEventListener('close', () => {
      open = false;
      failAll(new Error('the Home Assistant websocket closed'));
    });
    ws.addEventListener('error', () => {
      if (!open) {
        clearTimeout(authTimer);
        reject(new Error(`could not open a websocket to ${url}`));
      }
    });
  });
}

export function createHaClient(opts: ConnectOptions): HaClient {
  const rest = createRest(opts);
  let socketPromise: Promise<HaSocket> | undefined;
  const socket = () => (socketPromise ??= connectSocket(opts));
  return {
    rest,
    socket,
    callService: (domain, service, data) => rest.callService(domain, service, data),
    async reloadIntegration(integration) {
      const entries = (await rest.configEntries(integration)).filter((e) => e.domain === integration && !e.disabled_by);
      if (entries.length === 0) {
        await rest.callService(integration, 'reload', {});
        return;
      }
      for (const e of entries) await rest.request('POST', `/api/config/config_entries/entry/${encodeURIComponent(e.entry_id)}/reload`);
      const ids = new Set(entries.map((e) => e.entry_id));
      await readBack(
        `reload of ${integration}`,
        () => rest.configEntries(integration),
        (list) => list.filter((e) => ids.has(e.entry_id)).every((e) => e.state === 'loaded'),
      );
    },
    async registryUpdate(entityId, patch) {
      const ws = await socket();
      await ws.command('config/entity_registry/update', { entity_id: entityId, name: patch.name });
      await readBack(
        `registry name of ${entityId}`,
        () => ws.command<{ name: string | null }>('config/entity_registry/get', { entity_id: entityId }),
        (entry) => entry.name === patch.name,
      );
    },
    async selectOption(entityId, option) {
      const domain = entityId.split('.')[0] ?? '';
      if (domain !== 'select' && domain !== 'input_select') throw new Error(`${entityId} is not a select entity`);
      const current = await rest.state(entityId);
      const options = Array.isArray(current.attributes['options']) ? (current.attributes['options'] as unknown[]) : [];
      if (!options.includes(option)) throw new Error(`${entityId} has no option ${JSON.stringify(option)}`);
      if (current.state === option) return;
      await rest.callService(domain, 'select_option', { entity_id: entityId, option });
      await readBack(`${entityId} = ${option}`, () => rest.state(entityId), (s) => s.state === option);
    },
    close() {
      if (!socketPromise) return;
      socketPromise.then(
        (s) => s.close(),
        () => undefined,
      );
      socketPromise = undefined;
    },
  };
}
