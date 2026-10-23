// Websocket side of the adapter: auth handshake, numbered commands with deadlines, event subscriptions.
// Uses only the standard WebSocket API with addEventListener (workerd's WebSocket has no onmessage
// property). The connector is injectable: in a Worker, fetch(url, { headers: { Upgrade: 'websocket' } })
// followed by response.webSocket.accept() works as well as new WebSocket(url).

import { haError, isHaError, kindForWsCode } from './errors.ts';
import type { HaEvent } from './ha-types.ts';
import { DEFAULT_TIMEOUT_MS, normalizeBaseUrl } from './rest.ts';

/** The part of the standard WebSocket the adapter uses. Node's, workerd's and the browser's all fit. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** The listener gets the platform's event object; only a message event's `data` is read. */
  addEventListener(type: 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
}
export type WsConnector = (url: string) => WebSocketLike | Promise<WebSocketLike>;

export interface SocketOptions {
  baseUrl: string;
  token: string;
  /** Deadline for connect plus auth. */
  timeoutMs?: number;
  /** Default deadline for each command. */
  commandTimeoutMs?: number;
  connector?: WsConnector;
}

export interface HaSocket {
  readonly haVersion: string;
  readonly isOpen: boolean;
  command<T = unknown>(type: string, payload?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>;
  /** Home Assistant's ping/pong: false when no pong arrives in time (a half-open connection). */
  ping(timeoutMs?: number): Promise<boolean>;
  /** subscribe_events; resolves to an unsubscribe function once Home Assistant confirms. */
  subscribeEvents<T = unknown>(eventType: string, onEvent: (event: HaEvent<T>) => void): Promise<() => Promise<void>>;
  close(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Message = Record<string, unknown>;

export function websocketUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl).replace(/^http/, 'ws')}/api/websocket`;
}

/** The payload of a message event, whatever the platform's event class. */
export function eventData(event: unknown): unknown {
  return typeof event === 'object' && event !== null && 'data' in event ? (event as { data: unknown }).data : undefined;
}

function decode(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return undefined;
}

/** Home Assistant may batch messages into a JSON array (coalesce_messages); accept both shapes. */
export function parseFrame(data: unknown): Message[] {
  const text = decode(data);
  if (text === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((m): m is Message => typeof m === 'object' && m !== null);
  } catch {
    return [];
  }
}

const defaultConnector: WsConnector = (url) => new WebSocket(url);

export function connectSocket(opts: SocketOptions): Promise<HaSocket> {
  const url = websocketUrl(opts.baseUrl);
  const authTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connector = opts.connector ?? defaultConnector;
  if (!opts.token) return Promise.reject(haError('auth', 'no Home Assistant token configured'));

  const pending = new Map<number, Pending>();
  const subscriptions = new Map<number, (event: HaEvent) => void>();
  let ws: WebSocketLike | undefined;
  let nextId = 1;
  let haVersion = '';
  let state: 'connecting' | 'open' | 'closed' = 'connecting';

  const failAll = (reason: Error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    pending.clear();
    subscriptions.clear();
  };

  const dispatch = (msg: Message) => {
    const id = Number(msg['id']);
    if (msg['type'] === 'event') {
      subscriptions.get(id)?.(msg['event'] as HaEvent);
      return;
    }
    if (msg['type'] !== 'result' && msg['type'] !== 'pong') return;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (msg['type'] === 'pong' || msg['success'] === true) {
      p.resolve(msg['result']);
      return;
    }
    const error = (msg['error'] ?? {}) as { code?: string; message?: string };
    p.reject(haError(kindForWsCode(error.code), `websocket command failed: ${error.code ?? 'unknown'} ${error.message ?? ''}`.trim(), {
      ...(error.code ? { code: error.code } : {}),
    }));
  };

  const send = (id: number, type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (state !== 'open' || !ws) {
        reject(haError('unreachable', 'the Home Assistant websocket is not open'));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(haError('timeout', `websocket command ${type} took longer than ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ ...payload, id, type }));
      } catch (cause) {
        clearTimeout(timer);
        pending.delete(id);
        reject(haError('unreachable', `could not send ${type} on the Home Assistant websocket`, { cause }));
        // A socket that cannot send is dead even if its close event has not arrived yet.
        socket.close();
      }
    });

  const socket: HaSocket = {
    get haVersion() {
      return haVersion;
    },
    get isOpen() {
      return state === 'open';
    },
    command: <T>(type: string, payload: Record<string, unknown> = {}, co: { timeoutMs?: number } = {}) =>
      send(nextId++, type, payload, co.timeoutMs ?? commandTimeoutMs) as Promise<T>,
    ping: (pingTimeoutMs = 2000) =>
      send(nextId++, 'ping', {}, pingTimeoutMs).then(
        () => true,
        () => false,
      ),
    async subscribeEvents<T>(eventType: string, onEvent: (event: HaEvent<T>) => void) {
      const id = nextId++;
      subscriptions.set(id, onEvent as (event: HaEvent) => void);
      try {
        await send(id, 'subscribe_events', { event_type: eventType }, commandTimeoutMs);
      } catch (err) {
        subscriptions.delete(id);
        throw err;
      }
      return async () => {
        if (!subscriptions.delete(id) || state !== 'open') return;
        await send(nextId++, 'unsubscribe_events', { subscription: id }, commandTimeoutMs);
      };
    },
    close() {
      if (state === 'closed') return;
      state = 'closed';
      failAll(haError('unreachable', 'the Home Assistant websocket was closed'));
      try {
        ws?.close(1000, 'done');
      } catch {
        // Closing an already closed socket is not an error worth reporting.
      }
    },
  };

  return new Promise<HaSocket>((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(authTimer);
      if (err) {
        socket.close();
        reject(err);
      } else {
        resolve(socket);
      }
    };
    const authTimer = setTimeout(
      () => settle(haError('timeout', `no websocket auth from ${url} within ${authTimeoutMs} ms`)),
      authTimeoutMs,
    );

    Promise.resolve()
      .then(() => connector(url))
      .then(
        (conn) => {
          ws = conn;
          if (settled) {
            socket.close();
            return;
          }
          conn.addEventListener('message', (event) => {
            for (const msg of parseFrame(eventData(event))) {
              const type = msg['type'];
              if (type === 'auth_required') {
                conn.send(JSON.stringify({ type: 'auth', access_token: opts.token }));
              } else if (type === 'auth_ok') {
                haVersion = String(msg['ha_version'] ?? '');
                state = 'open';
                settle();
              } else if (type === 'auth_invalid') {
                settle(haError('auth', `Home Assistant rejected the token on the websocket: ${String(msg['message'] ?? '')}`, { code: 'auth_invalid' }));
              } else {
                dispatch(msg);
              }
            }
          });
          conn.addEventListener('close', () => {
            const wasOpen = state === 'open';
            state = 'closed';
            failAll(haError('unreachable', 'the Home Assistant websocket closed'));
            if (!wasOpen) settle(haError('unreachable', `the websocket to ${url} closed before auth`));
          });
          conn.addEventListener('error', () => {
            if (state !== 'open') settle(haError('unreachable', `could not open a websocket to ${url}`));
          });
        },
        (cause: unknown) =>
          settle(isHaError(cause) ? cause : haError('unreachable', `could not open a websocket to ${url}`, { cause })),
      );
  });
}
