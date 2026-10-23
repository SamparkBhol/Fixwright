// Bindings and variables (wrangler.jsonc), and the parsed configuration the router works from. Parsing is
// pure and cached per env object, so a request pays for it once per isolate.

import type { HouseholdDO } from './household/do.ts';
import { DEFAULT_DEMO_START } from './household/clock.ts';
import type { RateLimitDO } from './ratelimit.ts';

export interface Env {
  HOUSEHOLD: DurableObjectNamespace<HouseholdDO>;
  RATE_LIMIT: DurableObjectNamespace<RateLimitDO>;
  ASSETS: Fetcher;
  ALLOWED_ORIGINS?: string;
  PUBLIC_HOSTNAMES?: string;
  NTFY_BASE?: string;
  ALLOW_HA_LINK?: string;
  DEMO_START?: string;
  RATE_MCP_PER_MIN?: string;
  RATE_DEMO_PER_MIN?: string;
  /** Secret. Signs household tokens and repair confirm tokens. */
  CONFIRM_SECRET?: string;
  /** Secret, optional. Key material for sealing stored Home Assistant tokens (falls back to CONFIRM_SECRET). */
  HA_TOKEN_KEY?: string;
}

export { VERSION, PROTOCOL_VERSION } from './version.ts';
export const MIN_SECRET_LENGTH = 32;
export const DEFAULT_NTFY_BASE = 'https://ntfy.sh';
export const DEFAULT_HOSTNAMES = 'localhost,127.0.0.1,fixwright.*.workers.dev';

export interface Config {
  /** Exact origins (scheme, host and port) allowed to call from another origin. */
  allowedOrigins: ReadonlySet<string>;
  /** Host name patterns; "*" stands for one DNS label. */
  hostPatterns: readonly RegExp[];
  ntfyBase: string;
  allowHaLink: boolean;
  demoStart: string;
  rateMcpPerMin: number;
  rateDemoPerMin: number;
  /** Null when missing or too short: routes that sign anything answer 503 instead of using a weak key. */
  secret: string | null;
  /** Key material for sealing stored Home Assistant tokens: HA_TOKEN_KEY when set (32+ characters), else the secret. */
  tokenKey: string | null;
}

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Keeps only well formed http(s) origins, normalized the way browsers send them. */
export function parseOrigins(value: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const item of list(value)) {
    try {
      const u = new URL(item);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === item.replace(/\/+$/, '')) out.add(u.origin);
    } catch {
      continue;
    }
  }
  return out;
}

/** "fixwright.*.workers.dev" -> /^fixwright\.[a-z0-9-]+\.workers\.dev$/ */
export function hostPattern(item: string): RegExp | null {
  const host = item.toLowerCase();
  if (!/^[a-z0-9*.[\]:-]+$/.test(host)) return null;
  const source = host
    .split('.')
    .map((label) => (label === '*' ? '[a-z0-9-]+' : label.replace(/[[\]]/g, (c) => `\\${c}`)))
    .join('\\.');
  return new RegExp(`^${source}$`);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 100_000 ? n : fallback;
}

function ntfyBase(value: string | undefined): string {
  try {
    const u = new URL(value ?? DEFAULT_NTFY_BASE);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return DEFAULT_NTFY_BASE;
    return u.href.replace(/\/+$/, '');
  } catch {
    return DEFAULT_NTFY_BASE;
  }
}

export function parseConfig(env: Env): Config {
  const secret = env.CONFIRM_SECRET && env.CONFIRM_SECRET.length >= MIN_SECRET_LENGTH ? env.CONFIRM_SECRET : null;
  const tokenKey = env.HA_TOKEN_KEY && env.HA_TOKEN_KEY.length >= MIN_SECRET_LENGTH ? env.HA_TOKEN_KEY : secret;
  return {
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS),
    hostPatterns: list(env.PUBLIC_HOSTNAMES ?? DEFAULT_HOSTNAMES)
      .map(hostPattern)
      .filter((r): r is RegExp => r !== null),
    ntfyBase: ntfyBase(env.NTFY_BASE),
    allowHaLink: env.ALLOW_HA_LINK === '1',
    demoStart: (env.DEMO_START ?? DEFAULT_DEMO_START).trim() || DEFAULT_DEMO_START,
    rateMcpPerMin: positiveInt(env.RATE_MCP_PER_MIN, 240),
    rateDemoPerMin: positiveInt(env.RATE_DEMO_PER_MIN, 30),
    secret,
    tokenKey,
  };
}

const cache = new WeakMap<object, Config>();

export function config(env: Env): Config {
  let c = cache.get(env);
  if (!c) {
    c = parseConfig(env);
    cache.set(env, c);
  }
  return c;
}
