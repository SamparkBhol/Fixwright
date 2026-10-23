// Small WebCrypto helpers shared by the Worker and the HouseholdDO. Only `crypto.subtle` and
// `crypto.getRandomValues`, so the same code runs in workerd and in Node 22 (tests, CPU harness).

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of base64url; throws on characters outside the alphabet. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

/** Lower case Crockford base32 of the given bytes (5 bits per character, leftover bits dropped). */
export function base32(bytes: Uint8Array, length: number): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += BASE32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

export function randomBase32(length: number): string {
  return base32(crypto.getRandomValues(new Uint8Array(Math.ceil((length * 5) / 8))), length);
}

const pool = new Uint32Array(256);
let poolAt = pool.length;

/** A crypto backed Rng for the engine (plans and ids draw from it), refilled 256 values at a time. */
export const cryptoRng = {
  next(): number {
    if (poolAt >= pool.length) {
      crypto.getRandomValues(pool);
      poolAt = 0;
    }
    return (pool[poolAt++] as number) / 2 ** 32;
  },
};

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, key);
  }
  return key;
}

export async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(message)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Compares two strings in time that depends only on their lengths. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The message a confirm token signs. Changing any part (another plan, an edited plan, a new expiry) breaks it. */
export const confirmMessage = (planId: string, planHash: string, expiresAt: string): string => `${planId}|${planHash}|${expiresAt}`;

/** confirm_token = base64url(HMAC-SHA256(CONFIRM_SECRET, plan_id|plan_hash|expires_at)). */
export async function signConfirmToken(secret: string, planId: string, planHash: string, expiresAt: string): Promise<string> {
  return base64url(await hmacSha256(secret, confirmMessage(planId, planHash, expiresAt)));
}

export async function verifyConfirmToken(secret: string, token: string, planId: string, planHash: string, expiresAt: string): Promise<boolean> {
  const expected = await signConfirmToken(secret, planId, planHash, expiresAt);
  return timingSafeEqual(expected, token);
}

/** Stable JSON (sorted keys) so the same plan always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const PUBLIC_HOUSEHOLD = 'hh_public';
const HH_RANDOM = 20;
const HH_SIG = 12;
const HH_TOKEN = new RegExp(`^hh_[0-9a-hjkmnp-tv-z]{${HH_RANDOM + HH_SIG}}$`);

async function householdSig(secret: string, random: string): Promise<string> {
  return base32(await hmacSha256(secret, `household|${random}`), HH_SIG);
}

/** hh_<20 random base32><12 base32 of an HMAC over them>: 100 random bits, checked without storage. */
export async function issueHouseholdToken(secret: string): Promise<string> {
  const random = randomBase32(HH_RANDOM);
  return `hh_${random}${await householdSig(secret, random)}`;
}

/** True for hh_public and for tokens this server issued. Anything else never reaches a Durable Object. */
export async function verifyHouseholdToken(secret: string, token: string): Promise<boolean> {
  if (token === PUBLIC_HOUSEHOLD) return true;
  if (!HH_TOKEN.test(token)) return false;
  const random = token.slice(3, 3 + HH_RANDOM);
  return timingSafeEqual(await householdSig(secret, random), token.slice(3 + HH_RANDOM));
}

/** A seed for the household's SimHome: hh_public gets seed 1 (the demo script's), others 1 to 500. */
export function seedFor(household: string): number {
  if (household === PUBLIC_HOUSEHOLD) return 1;
  let h = 0x811c9dc5;
  for (let i = 0; i < household.length; i++) {
    h ^= household.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 1 + (h % 500);
}
