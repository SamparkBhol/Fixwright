import { describe, expect, it } from 'vitest';
import {
  ID_PATTERN,
  ID_PREFIXES,
  MAX_ID_TIME_MS,
  createIdFactory,
  idPrefix,
  idTimeMs,
  isId,
  manualClock,
  newId,
  seededRng,
  type IdPrefix,
  type Rng,
} from '../src/index.ts';

const T0 = '2026-10-15T17:20:04.000Z';
const constRng = (v: number): Rng => ({ next: () => v });

describe('newId', () => {
  it('has the format <prefix>_<10 time chars><8 random chars> in lower case Crockford base32', () => {
    for (const prefix of ID_PREFIXES) {
      const id = newId(prefix, manualClock(T0), seededRng(1));
      expect(id).toMatch(new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{18}$`));
      expect(id.length).toBe(prefix.length + 19);
      expect(ID_PATTERN.test(id)).toBe(true);
      expect(isId(id, prefix)).toBe(true);
      expect(idPrefix(id)).toBe(prefix);
    }
  });

  it('encodes the clock time, which reads back exactly', () => {
    const id = newId('dx', manualClock(T0), seededRng(7));
    expect(idTimeMs(id)).toBe(Date.parse(T0));
    expect(newId('dx', manualClock(0), constRng(0))).toBe('dx_000000000000000000');
    expect(newId('dx', manualClock(MAX_ID_TIME_MS), constRng(0.999999))).toBe('dx_zzzzzzzzzzzzzzzzzz');
  });

  it('sorts in time order as plain strings, across the whole demo week', () => {
    const clock = manualClock(T0);
    const rng = seededRng(42);
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) {
      ids.push(newId('rep', clock, rng));
      clock.advance(1 + Math.floor(rng.next() * 3_600_000));
    }
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is deterministic for the same clock and seed', () => {
    expect(newId('pln', manualClock(T0), seededRng(3))).toBe(newId('pln', manualClock(T0), seededRng(3)));
    expect(newId('pln', manualClock(T0), seededRng(3))).not.toBe(newId('pln', manualClock(T0), seededRng(4)));
  });

  it('refuses unknown prefixes, bad clocks and bad rngs', () => {
    expect(() => newId('xx' as IdPrefix, manualClock(T0), seededRng(1))).toThrow(/unknown id prefix/);
    expect(() => newId('dx', manualClock(-1), seededRng(1))).toThrow(RangeError);
    expect(() => newId('dx', { now: () => '', nowMs: () => Number.NaN }, seededRng(1))).toThrow(RangeError);
    expect(() => newId('dx', manualClock(MAX_ID_TIME_MS + 1), seededRng(1))).toThrow(/beyond/);
    expect(() => newId('dx', manualClock(T0), constRng(1))).toThrow(/\[0, 1\)/);
    expect(() => newId('dx', manualClock(T0), constRng(-0.1))).toThrow(RangeError);
  });
});

describe('createIdFactory (monotonic)', () => {
  it('strictly increases within the same millisecond and when the clock steps back', () => {
    const clock = manualClock(T0);
    const mint = createIdFactory(clock, seededRng(9));
    const bodies: string[] = [];
    for (let i = 0; i < 200; i++) bodies.push(mint('q').slice(2));
    clock.advance(-5_000);
    for (let i = 0; i < 50; i++) bodies.push(mint('q').slice(2));
    clock.advance(60_000);
    for (let i = 0; i < 50; i++) bodies.push(mint('q').slice(2));
    for (let i = 1; i < bodies.length; i++) expect(bodies[i]! > bodies[i - 1]!, `index ${i}`).toBe(true);
  });

  it('borrows the next millisecond when the random part wraps', () => {
    const mint = createIdFactory(manualClock(T0), constRng(0.999999));
    const first = mint('dx');
    const second = mint('dx');
    expect(first.endsWith('zzzzzzzz')).toBe(true);
    expect(idTimeMs(second)).toBe(Date.parse(T0) + 1);
    expect(second > first).toBe(true);
  });
});

describe('id helpers', () => {
  it('reject malformed ids', () => {
    for (const bad of ['dx_', 'dx_0123', 'DX_01m50980d03sy1gk7c', 'dx_01m50980d03sy1gk7i', 'zz_01m50980d03sy1gk7c', 42, null]) {
      expect(isId(bad), String(bad)).toBe(false);
    }
    expect(isId('dx_01m50980d03sy1gk7c', 'pln')).toBe(false);
    expect(idTimeMs('nope')).toBeNull();
    expect(idPrefix('hh_public')).toBeNull();
  });
});

describe('seededRng and manualClock', () => {
  it('seededRng repeats per seed and stays in [0, 1)', () => {
    const a = seededRng(123);
    const b = seededRng(123);
    for (let i = 0; i < 1000; i++) {
      const x = a.next();
      expect(x).toBe(b.next());
      expect(x >= 0 && x < 1).toBe(true);
    }
  });

  it('manualClock only moves when told', () => {
    const c = manualClock(T0);
    expect(c.now()).toBe(T0);
    c.advance(1500);
    expect(c.now()).toBe('2026-10-15T17:20:05.500Z');
    c.set('2026-10-16T14:00:00.000Z');
    expect(c.nowMs()).toBe(Date.parse('2026-10-16T14:00:00.000Z'));
    expect(() => manualClock('soon')).toThrow(RangeError);
  });
});
