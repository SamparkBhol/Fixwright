// Measured on seeds 1, 2 and 7, 1 to 60 days ahead at the same local time: a rebased demo house matches
// SimHome.create at the new time in every count, state and row, and differs only in when seeded events
// happen (routine jitter and Wi-Fi drops are seeded by the date) and in the ghost lamp's offline date
// (create pins it to 3 October, a rebase keeps its age).

import { describe, expect, it } from 'vitest';
import {
  DAY,
  DEMO_GHOST_SINCE_LOCAL,
  DEMO_NOW_LOCAL,
  HOUR,
  SimHome,
  isCodedError,
  localClock,
  localDayKey,
  parseLocal,
  rebaseSnapshot,
  type SimSnapshot,
} from '../src/index.ts';

const TZ = 'America/Los_Angeles';
const json = (x: unknown): string => JSON.stringify(x);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_NUMBERS = new Set(['nowMs', 'bootMs', 'lastSeenMs', 'dropUntil', 'bootingUntil', 'actuations', 'createdMs', 'since', 'at', 'offlineSince']);
const DAY_KEYS = new Set(['plannedThrough', 'plannedDay']);

/** 15:00 local on the demo day plus `days`, the same wall clock time the demo starts at. */
const demoTimeIn = (days: number): number =>
  parseLocal(`${new Date(Date.UTC(2026, 9, 15 + days)).toISOString().slice(0, 10)}T15:00:00`, TZ);

type Leaf = { path: string[]; a: unknown; b: unknown };

function leaves(a: unknown, b: unknown, path: string[] = [], out: Leaf[] = []): Leaf[] {
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) leaves((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], [...path, k], out);
  } else {
    out.push({ path, a, b });
  }
  return out;
}

const field = (path: string[]): string => [...path].reverse().find((p) => !/^\d+$/.test(p)) ?? '';

function expectShifted(before: SimSnapshot, after: SimSnapshot, delta: number): void {
  for (const { path, a, b } of leaves(before, after)) {
    const where = path.join('.');
    const name = field(path);
    if (typeof a === 'string' && ISO.test(a)) {
      expect(Date.parse(String(b)) - Date.parse(a), where).toBe(delta);
    } else if (typeof a === 'string' && DAY_KEY.test(a)) {
      expect(DAY_KEYS.has(name), where).toBe(true);
      expect(String(b), where).toMatch(DAY_KEY);
    } else if (typeof a === 'number' && TIME_NUMBERS.has(name) && !(a === 0 && (name === 'dropUntil' || name === 'bootingUntil'))) {
      expect((b as number) - a, where).toBe(delta);
    } else {
      expect(b, where).toEqual(a);
    }
  }
}

function withoutTimes(s: SimSnapshot) {
  const rows = s.rows.map(({ when: _when, context: _context, ...rest }) => json(rest)).sort();
  const pending = s.pending.map(({ at: _at, n: _n, ...rest }) => json(rest)).sort();
  const entities = Object.values(s.entities).map(({ lastChanged: _c, lastUpdated: _u, createdMs: _m, attributes, ...rest }) => {
    const { last_triggered: _t, ...attrs } = attributes;
    return json({ ...rest, attrs });
  });
  const devices = Object.values(s.devices).map(({ lastSeenMs: _l, actuations, dropUntil: _d, bootingUntil: _b, bootMs: _m, ...rest }) =>
    json({ ...rest, actuations: actuations.length }),
  );
  return {
    nowMs: s.nowMs,
    counter: s.counter,
    rowBytes: s.rowBytes,
    plannedThrough: s.plannedThrough,
    faults: Object.keys(s.faults).sort(),
    rows,
    pending,
    entities,
    devices,
  };
}

describe('rebaseSnapshot', () => {
  const demo = SimHome.create().snapshot();

  it('leaves a snapshot unchanged when the time stays the same', () => {
    expect(json(rebaseSnapshot(demo, demo.nowMs))).toBe(json(demo));
  });

  it('does not change the snapshot it was given', () => {
    const before = json(demo);
    rebaseSnapshot(demo, demo.nowMs + 3 * DAY);
    expect(json(demo)).toBe(before);
  });

  it('moves every timestamp by the same delta and nothing else', () => {
    const morning = SimHome.fromSnapshot(demo);
    morning.advance(16 * HOUR);
    for (const snap of [demo, morning.snapshot()]) {
      for (const delta of [2 * DAY, 2 * DAY + 7 * HOUR + 123, -5 * HOUR, 400 * DAY]) {
        const moved = rebaseSnapshot(snap, snap.nowMs + delta);
        expect(moved.nowMs).toBe(snap.nowMs + delta);
        expectShifted(snap, moved, delta);
      }
    }
  });

  it('keeps every local wall clock time for a delta of whole days', () => {
    const moved = rebaseSnapshot(demo, demo.nowMs + 7 * DAY);
    expect(moved.rows.map((r) => localClock(Date.parse(r.when), TZ))).toEqual(demo.rows.map((r) => localClock(Date.parse(r.when), TZ)));
    expect(moved.plannedThrough).toBe('2026-10-22');
    expect(localClock(moved.faults.power_restore_default_on!.since, TZ)).toBe('03:11:58');
  });

  it('round trips back to the original snapshot', () => {
    for (const delta of [DAY, 3 * DAY + 5 * HOUR, -9 * HOUR, 45 * DAY]) {
      expect(json(rebaseSnapshot(rebaseSnapshot(demo, demo.nowMs + delta), demo.nowMs))).toBe(json(demo));
    }
  });

  it('matches SimHome.create at the new time apart from when seeded events happen', () => {
    for (const seed of [1, 2]) {
      const original = SimHome.create({ seed }).snapshot();
      for (const days of [1, 7, 30]) {
        const at = demoTimeIn(days);
        const moved = rebaseSnapshot(original, at);
        const fresh = SimHome.create({ seed, now: at }).snapshot();
        expect(withoutTimes(moved)).toEqual(withoutTimes(fresh));
        expect(localClock(moved.faults.power_restore_default_on!.since, TZ)).toBe('03:11:58');
        expect(localClock(fresh.faults.power_restore_default_on!.since, TZ)).toBe('03:11:58');
        // The one planned difference: create dates the ghost lamp from 3 October, a rebase keeps its age.
        const ghostAge = original.nowMs - (original.faults.ghost_after_repair!.opts.offlineSince as number);
        expect(at - (moved.faults.ghost_after_repair!.opts.offlineSince as number)).toBe(ghostAge);
        expect(fresh.faults.ghost_after_repair!.opts.offlineSince).toBe(parseLocal(DEMO_GHOST_SINCE_LOCAL, TZ));
      }
    }
  });

  it('continues like the original until the next local midnight', () => {
    const delta = 7 * DAY;
    const original = SimHome.fromSnapshot(demo);
    const moved = SimHome.fromSnapshot(rebaseSnapshot(demo, demo.nowMs + delta));
    const toMidnight = parseLocal('2026-10-16T00:00:00', TZ) - demo.nowMs - 1;
    original.advance(toMidnight);
    moved.advance(toMidnight);
    expectShifted(original.snapshot(), moved.snapshot(), delta);
  });

  it('keeps planning new days whatever the delta', () => {
    for (const delta of [7 * HOUR, -7 * HOUR, 2 * DAY + 90_000]) {
      const home = SimHome.fromSnapshot(rebaseSnapshot(demo, demo.nowMs + delta));
      const start = home.snapshot().nowMs;
      home.advance(3 * DAY);
      const after = home.snapshot();
      expect(after.plannedThrough).toBe(localDayKey(after.nowMs, TZ));
      const lastDay = after.rows.filter((r) => Date.parse(r.when) > start + 2 * DAY && r.type === 'call_service');
      expect(lastDay.length).toBeGreaterThan(0);
    }
  });

  it('starts the demo house on any day at the demo clock', () => {
    const at = parseLocal(DEMO_NOW_LOCAL.replace('2026-10-15', '2026-10-23'), TZ);
    const home = SimHome.fromSnapshot(rebaseSnapshot(demo, at));
    expect(home.now()).toBe(new Date(at).toISOString());
    expect(localClock(at, TZ)).toBe('15:00:00');
  });

  it('refuses a time that is not whole epoch milliseconds', () => {
    for (const bad of [Number.NaN, 1.5, Number.POSITIVE_INFINITY, -1]) {
      let err: unknown;
      try {
        rebaseSnapshot(demo, bad);
      } catch (e) {
        err = e;
      }
      expect(isCodedError(err) && err.code).toBe('bad_request');
    }
  });
});
