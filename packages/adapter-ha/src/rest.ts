// REST side of the adapter: fetch only, so it runs unchanged in workerd, Node 22 and the browser.
// Every attempt has a deadline. Idempotent reads retry with jittered exponential backoff; writes
// (service calls, reloads) never retry on their own, because sending a toggle twice is a new fault.

import type { Rng } from '@fixwright/protocol';
import { createAuthGate, type AuthGate } from './auth.ts';
import { haError, isHaError, kindForStatus } from './errors.ts';
import type { HaConfig, HaConfigEntry, HaState } from './ha-types.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export interface RetryPolicy {
  /** Extra attempts after the first one. */
  retries: number;
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { retries: 2, baseMs: 250, maxMs: 4000 };
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface RestOptions {
  baseUrl: string;
  token: string;
  /** Deadline for each attempt, response body included. */
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  fetch?: FetchLike;
  sleep?: Sleep;
  rng?: Rng;
  /** Shared with the websocket handshake; a fresh gate (30 s hold) when absent. */
  auth?: AuthGate;
}

export interface RequestOptions {
  timeoutMs?: number;
  /** Retry on network errors, timeouts, 429 and 5xx. Defaults to true for GET only. */
  idempotent?: boolean;
}

export interface HaRest {
  readonly baseUrl: string;
  /** Holds every call back for a while after Home Assistant rejects the token (src/auth.ts). */
  readonly auth: AuthGate;
  request<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  apiStatus(): Promise<{ message: string }>;
  config(opts?: RequestOptions): Promise<HaConfig>;
  states(): Promise<HaState[]>;
  /** Throws a not_found HaError when the entity has no state. */
  state(entityId: string): Promise<HaState>;
  /** POST /api/services/<domain>/<service>: the states that changed while the call ran. */
  callService(domain: string, service: string, data?: Record<string, unknown>): Promise<HaState[]>;
  /** Writes a state straight into the state machine. Cosmetic: the integration's next write replaces it. */
  forceState(entityId: string, state: string, attributes?: Record<string, unknown>): Promise<HaState>;
  configEntries(domain?: string): Promise<HaConfigEntry[]>;
  reloadConfigEntry(entryId: string): Promise<{ require_restart: boolean }>;
}

const SLUG = /^[a-z0-9_]+$/;

/** Accepts "http://host:8123", "http://host:8123/" or ".../api"; rejects anything that is not http(s). */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw haError('bad_request', `not a valid Home Assistant URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw haError('bad_request', `Home Assistant URL must start with http:// or https://, got ${url.protocol}`);
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
  return `${url.origin}${path}`;
}

/** Equal jitter: half the exponential step fixed, half random, capped. */
export function backoffMs(attempt: number, policy: RetryPolicy, rng: Rng): number {
  const step = Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
  return Math.round(step / 2 + rng.next() * (step / 2));
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
    return typeof code === 'string' ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mathRng: Rng = { next: () => Math.random() };

export function createRest(opts: RestOptions): HaRest {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  if (!opts.token) throw haError('auth', 'no Home Assistant token configured');
  const token = opts.token;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const policy: RetryPolicy = { ...DEFAULT_RETRY, ...opts.retry };
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? defaultSleep;
  const rng = opts.rng ?? mathRng;
  const auth = opts.auth ?? createAuthGate();

  async function attempt<T>(method: string, path: string, body: unknown, deadlineMs: number): Promise<T> {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, deadlineMs);
    const label = `${method} ${path}`;
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      const init: RequestInit = { method, headers, signal: ctrl.signal };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await doFetch(baseUrl + path, init);
      const text = await res.text();
      if (!res.ok) {
        const wait = retryAfterMs(res);
        throw haError(kindForStatus(res.status), `${label} answered HTTP ${res.status}: ${text.slice(0, 200)}`, {
          status: res.status,
          ...(wait === undefined ? {} : { retryAfterMs: wait }),
        });
      }
      if (!text) return null as T;
      try {
        return JSON.parse(text) as T;
      } catch (cause) {
        throw haError('protocol', `${label} returned something that is not JSON: ${text.slice(0, 120)}`, { cause });
      }
    } catch (err) {
      if (isHaError(err)) throw err;
      if (timedOut) throw haError('timeout', `${label} took longer than ${deadlineMs} ms`, { cause: err });
      throw haError('unreachable', `${label} could not reach ${baseUrl}: ${describe(err)}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  async function request<T>(method: string, path: string, body?: unknown, ro: RequestOptions = {}): Promise<T> {
    const idempotent = ro.idempotent ?? method === 'GET';
    const deadline = ro.timeoutMs ?? timeoutMs;
    for (let n = 0; ; n++) {
      try {
        return await auth.run(`${method} ${path}`, () => attempt<T>(method, path, body, deadline));
      } catch (err) {
        if (!idempotent || n >= policy.retries || !isHaError(err) || !err.retryable) throw err;
        await sleep(Math.min(policy.maxMs, Math.max(backoffMs(n, policy, rng), err.retryAfterMs ?? 0)));
      }
    }
  }

  const id = (entityId: string) => encodeURIComponent(entityId);

  return {
    baseUrl,
    auth,
    request,
    apiStatus: () => request('GET', '/api/'),
    config: (ro) => request('GET', '/api/config', undefined, ro),
    states: () => request('GET', '/api/states'),
    state: (entityId) => request('GET', `/api/states/${id(entityId)}`),
    callService: (domain, service, data = {}) => {
      if (!SLUG.test(domain) || !SLUG.test(service)) {
        return Promise.reject(haError('bad_request', `not a service name: ${domain}.${service}`));
      }
      return request<HaState[]>('POST', `/api/services/${domain}/${service}`, data);
    },
    forceState: (entityId, state, attributes = {}) =>
      request('POST', `/api/states/${id(entityId)}`, { state, attributes }),
    configEntries: (domain) =>
      request('GET', `/api/config/config_entries/entry${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`),
    reloadConfigEntry: (entryId) =>
      request('POST', `/api/config/config_entries/entry/${encodeURIComponent(entryId)}/reload`),
  };
}
