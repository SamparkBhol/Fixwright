// Ids look like `<prefix>_<10 char time base32><8 char random base32>`.
// Crockford base32 in lower case (no i, l, o, u), so ids sort by creation time as plain strings.

import type { Clock, Rng } from './types.ts';

export const ID_PREFIXES = ['chk', 'iss', 'dx', 'q', 'exp', 'pln', 'rep', 'hh'] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

/** What each prefix names, for docs and error messages. */
export const ID_PREFIX_MEANING: Readonly<Record<IdPrefix, string>> = {
  chk: 'checkup',
  iss: 'issue',
  dx: 'diagnosis',
  q: 'question',
  exp: 'explanation',
  pln: 'plan',
  rep: 'repair',
  hh: 'household',
};

export const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const TIME_LEN = 10;
const RAND_LEN = 8;
const BASE = 32;
/** Largest time the 10 char field can hold (2^50 minus 1 ms, about the year 37648). */
export const MAX_ID_TIME_MS = BASE ** TIME_LEN - 1;

const BODY = `[0-9a-hjkmnp-tv-z]{${TIME_LEN + RAND_LEN}}`;
/** Matches any well formed id and captures the prefix. */
export const ID_PATTERN = new RegExp(`^(${ID_PREFIXES.join('|')})_${BODY}$`);

/** Regex source for one prefix, e.g. for a zod string pattern. */
export function idPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_${BODY}$`);
}

export function isId(value: unknown, prefix?: IdPrefix): value is string {
  if (typeof value !== 'string') return false;
  const m = ID_PATTERN.exec(value);
  return m !== null && (prefix === undefined || m[1] === prefix);
}

/** The prefix of a well formed id, or null. */
export function idPrefix(value: string): IdPrefix | null {
  const m = ID_PATTERN.exec(value);
  return m ? (m[1] as IdPrefix) : null;
}

function encodeTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`id clock must give a time of 0 or later, got ${ms}`);
  let v = Math.floor(ms);
  if (v > MAX_ID_TIME_MS) throw new RangeError(`id clock time ${ms} is beyond the id range`);
  let out = '';
  for (let i = 0; i < TIME_LEN; i++) {
    out = ID_ALPHABET.charAt(v % BASE) + out;
    v = Math.floor(v / BASE);
  }
  return out;
}

function randomDigits(rng: Rng): number[] {
  const digits: number[] = [];
  for (let i = 0; i < RAND_LEN; i++) {
    const r = rng.next();
    if (!(r >= 0 && r < 1)) throw new RangeError(`rng.next() must return a number in [0, 1), got ${r}`);
    digits.push(Math.floor(r * BASE));
  }
  return digits;
}

const digitsToString = (digits: readonly number[]): string => digits.map((d) => ID_ALPHABET.charAt(d)).join('');

function assertPrefix(prefix: string): asserts prefix is IdPrefix {
  if (!(ID_PREFIXES as readonly string[]).includes(prefix)) {
    throw new RangeError(`unknown id prefix "${prefix}"; expected one of ${ID_PREFIXES.join(', ')}`);
  }
}

/**
 * A new id from the injected clock and rng. Ids from later milliseconds always sort after earlier
 * ones. Within one millisecond the order is random; use createIdFactory when that matters.
 */
export function newId(prefix: IdPrefix, clock: Clock, rng: Rng): string {
  assertPrefix(prefix);
  return `${prefix}_${encodeTime(clock.nowMs())}${digitsToString(randomDigits(rng))}`;
}

/**
 * An id minter whose ids strictly increase (compared after the prefix), even when the clock stalls
 * or steps back: it then reuses the last time and increments the random part, like monotonic ULIDs.
 */
export function createIdFactory(clock: Clock, rng: Rng): (prefix: IdPrefix) => string {
  let lastMs = -1;
  let lastDigits: number[] = [];
  return (prefix) => {
    assertPrefix(prefix);
    const nowMs = Math.floor(clock.nowMs());
    encodeTime(nowMs);
    if (nowMs > lastMs) {
      lastMs = nowMs;
      lastDigits = randomDigits(rng);
    } else {
      lastDigits = increment(lastDigits);
      if (lastDigits.every((d) => d === 0)) lastMs += 1; // random part wrapped: borrow the next millisecond
    }
    return `${prefix}_${encodeTime(lastMs)}${digitsToString(lastDigits)}`;
  };
}

function increment(digits: readonly number[]): number[] {
  const out = [...digits];
  for (let i = out.length - 1; i >= 0; i--) {
    const d = (out[i] ?? 0) + 1;
    if (d < BASE) {
      out[i] = d;
      return out;
    }
    out[i] = 0;
  }
  return out;
}

/** The creation time encoded in an id, in epoch ms, or null if the id is malformed. */
export function idTimeMs(id: string): number | null {
  if (!ID_PATTERN.test(id)) return null;
  const body = id.slice(id.indexOf('_') + 1, id.indexOf('_') + 1 + TIME_LEN);
  let v = 0;
  for (const ch of body) v = v * BASE + ID_ALPHABET.indexOf(ch);
  return v;
}
