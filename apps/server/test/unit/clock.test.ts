// The demo house clock: where a new house starts under DEMO_START, and how /health and /demo/state label it.

import { describe, expect, it } from 'vitest';
import { clockLabel, DEFAULT_DEMO_START, demoStartMs, TZ } from '../../src/household/clock.ts';
import { stateClock } from '../../src/household/household.ts';
import { parseConfig, type Env } from '../../src/env.ts';

const at = (iso: string): number => Date.parse(iso);

describe('demoStartMs', () => {
  it('"15:00" is 15:00 Los Angeles time on the current local date, at any real hour', () => {
    // 15 October 2026 is PDT (UTC-7): 15:00 local is 22:00 UTC.
    for (const real of ['2026-10-15T07:01:00.000Z', '2026-10-15T10:00:00.000Z', '2026-10-15T17:00:00.000Z', '2026-10-16T06:59:00.000Z']) {
      expect(new Date(demoStartMs('15:00', at(real), TZ)).toISOString(), real).toBe('2026-10-15T22:00:00.000Z');
    }
    // Just after local midnight it is the next day's afternoon.
    expect(new Date(demoStartMs('15:00', at('2026-10-16T07:01:00.000Z'), TZ)).toISOString()).toBe('2026-10-16T22:00:00.000Z');
  });

  it('follows daylight saving: after 1 November 15:00 local is 23:00 UTC', () => {
    expect(new Date(demoStartMs('15:00', at('2026-11-02T03:00:00.000Z'), TZ)).toISOString()).toBe('2026-11-01T23:00:00.000Z');
  });

  it('takes ISO instants as they are, "now" and anything unreadable as real time', () => {
    const real = at('2026-10-17T12:00:00.000Z');
    expect(demoStartMs('2026-10-15T22:00:00.000Z', real, TZ)).toBe(at('2026-10-15T22:00:00.000Z'));
    expect(demoStartMs('now', real, TZ)).toBe(real);
    expect(demoStartMs('25:99', real, TZ)).toBe(real);
    expect(demoStartMs('soon', real, TZ)).toBe(real);
  });
});

describe('clock labels', () => {
  it('labels HH:MM and ISO starts as simulated, "now" as real', () => {
    expect(clockLabel('15:00')).toEqual({
      simulated: true,
      starts_at: '15:00',
      tz: TZ,
      note: 'Simulated clock. Each new demo house starts at 15:00 America/Los_Angeles time on the day it is built, then runs with real time.',
    });
    expect(clockLabel('2026-10-15T22:00:00.000Z')).toMatchObject({ simulated: true, starts_at: '2026-10-15T22:00:00.000Z' });
    expect(clockLabel('now')).toMatchObject({ simulated: false, starts_at: 'now' });
  });

  it('/demo/state calls a jumped "now" house simulated and a linked Home Assistant real', () => {
    expect(stateClock(true, 'now', TZ, 0).simulated).toBe(false);
    expect(stateClock(true, 'now', TZ, 3600_000)).toMatchObject({ simulated: true, offset_ms: 3600_000 });
    expect(stateClock(false, '15:00', TZ, 0)).toMatchObject({ simulated: false, note: 'A linked Home Assistant runs on real time.' });
  });

  it('the deployed default is the 15:00 anchor', () => {
    expect(DEFAULT_DEMO_START).toBe('15:00');
    expect(parseConfig({} as Env).demoStart).toBe('15:00');
    expect(parseConfig({ DEMO_START: 'now' } as Env).demoStart).toBe('now');
  });
});
