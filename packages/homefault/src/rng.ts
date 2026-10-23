// Seeded randomness. Every random choice in homefault flows from a seed through these helpers, so the
// same seed gives the same house, the same events and the same benchmark in Node, workerd and browsers.

import type { Rng } from './types.ts';

/** mulberry32: small, fast and identical in every JavaScript runtime. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** FNV-1a over the joined parts: a stable 32-bit seed for "this seed, this purpose, this key". */
export function hashSeed(...parts: ReadonlyArray<string | number>): number {
  let h = 0x811c9dc5;
  const text = parts.join('␟');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** An Rng for one purpose, independent of every other stream drawn from the same seed. */
export function rngFor(...parts: ReadonlyArray<string | number>): Rng {
  return seededRng(hashSeed(...parts));
}

/** Integer in [lo, hi], both inclusive. */
export function int(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng.next() * (hi - lo + 1));
}

/** Float in [lo, hi). */
export function between(rng: Rng, lo: number, hi: number): number {
  return lo + rng.next() * (hi - lo);
}

export function chance(rng: Rng, p: number): boolean {
  return rng.next() < p;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new RangeError('pick from an empty list');
  return items[Math.floor(rng.next() * items.length)] as T;
}

/** Fisher-Yates on a copy. */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** k distinct items, in random order. */
export function sample<T>(rng: Rng, items: readonly T[], k: number): T[] {
  return shuffle(rng, items).slice(0, Math.max(0, Math.min(k, items.length)));
}

/** Roughly normal noise (sum of three uniforms), mean 0, clipped to [-limit, limit]. */
export function jitter(rng: Rng, limit: number): number {
  if (limit <= 0) return 0;
  const u = (rng.next() + rng.next() + rng.next()) / 3 - 0.5;
  return Math.round(Math.max(-limit, Math.min(limit, u * 2 * limit)));
}
