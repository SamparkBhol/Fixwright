// Deterministic Clock and Rng implementations for tests, fixtures and simulations.
// Production code injects real ones (Date.now, crypto.getRandomValues) at the edge.

import type { Clock, Iso, Rng } from './types.ts';

/** mulberry32: a small, fast, seeded PRNG. Same seed, same sequence, in every runtime. */
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

export interface ManualClock extends Clock {
  /** Moves time forward (or back, with a negative value). */
  advance(ms: number): void;
  set(time: Iso | number): void;
}

const toMs = (time: Iso | number): number => {
  const ms = typeof time === 'number' ? time : Date.parse(time);
  if (!Number.isFinite(ms)) throw new RangeError(`not a valid time: ${String(time)}`);
  return ms;
};

/** A clock that only moves when told to. */
export function manualClock(start: Iso | number): ManualClock {
  let ms = toMs(start);
  return {
    now: () => new Date(ms).toISOString(),
    nowMs: () => ms,
    advance: (delta) => {
      ms += delta;
    },
    set: (time) => {
      ms = toMs(time);
    },
  };
}
