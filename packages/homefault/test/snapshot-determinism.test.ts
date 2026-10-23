// Snapshots are plain JSON that round-trip byte for byte, stay under 256 KB, and a restored house
// continues exactly as the original. Same seed, same events; different seed, different life.

import { describe, expect, it } from 'vitest';
import { SimHome, generateScenario, type SimSnapshot } from '../src/index.ts';

const KB256 = 256 * 1024;
const json = (x: unknown): string => JSON.stringify(x);

describe('snapshot', () => {
  it('round-trips byte-identically through JSON', () => {
    const home = SimHome.create({ seed: 11 });
    const text = json(home.snapshot());
    const restored = SimHome.fromSnapshot(JSON.parse(text) as SimSnapshot);
    expect(json(restored.snapshot())).toBe(text);
    const again = SimHome.create({ seed: 99, faults: 'none' });
    again.restore(JSON.parse(text) as SimSnapshot);
    expect(json(again.snapshot())).toBe(text);
  });

  it('a restored house continues exactly like the original', async () => {
    const original = SimHome.create({ seed: 12 });
    const copy = SimHome.fromSnapshot(JSON.parse(json(original.snapshot())) as SimSnapshot);
    for (const home of [original, copy]) {
      await home.callService('light', 'turn_on', { entity_id: 'light.desk_lamp' });
      home.inject('router_ssid_change');
      home.advance(36 * 3_600_000);
    }
    expect(json(copy.snapshot())).toBe(json(original.snapshot()));
  });

  it('snapshotting mid-run does not change the future', () => {
    const a = SimHome.create({ seed: 13 });
    const b = SimHome.create({ seed: 13 });
    a.advance(5 * 3_600_000);
    const mid = SimHome.fromSnapshot(JSON.parse(json(a.snapshot())) as SimSnapshot);
    mid.advance(19 * 3_600_000);
    b.advance(24 * 3_600_000);
    expect(json(mid.snapshot())).toBe(json(b.snapshot()));
  });

  it('stays under 256 KB at the start, and with a full log after three weeks of simulated life', () => {
    const home = SimHome.create({ seed: 14 });
    expect(new TextEncoder().encode(json(home.snapshot())).length).toBeLessThan(KB256);
    home.inject('dead_trigger');
    for (let day = 0; day < 21; day++) home.advance(24 * 3_600_000);
    const snap = home.snapshot();
    // The byte budget, not the row cap, is what fills up first in a lived-in house.
    expect(snap.rows.length).toBeGreaterThan(800);
    expect(snap.rows.length).toBeLessThanOrEqual(1000);
    expect(snap.rowBytes).toBeLessThanOrEqual(snap.maxRowBytes);
    expect(snap.maxRowBytes - snap.rowBytes).toBeLessThan(2_000);
    expect(new TextEncoder().encode(json(snap)).length).toBeLessThan(KB256);
  });

  it('a small row cap still applies when the byte budget is far away', () => {
    const home = SimHome.create({ seed: 14, maxRows: 50 });
    expect(home.rows()).toHaveLength(50);
  });

  it('rejects something that is not a snapshot', () => {
    expect(() => SimHome.fromSnapshot({ v: 2 } as unknown as SimSnapshot)).toThrowError(/Not a SimHome snapshot/);
  });
});

describe('determinism', () => {
  it('same seed, same house, same events', async () => {
    const a = SimHome.create({ seed: 21 });
    const b = SimHome.create({ seed: 21 });
    expect(json(await a.events({ since: '2026-01-01T00:00:00Z' }))).toBe(json(await b.events({ since: '2026-01-01T00:00:00Z' })));
    expect(json(a.snapshot())).toBe(json(b.snapshot()));
  });

  it('different seeds give different days but the same demo facts', async () => {
    const a = SimHome.create({ seed: 21 });
    const b = SimHome.create({ seed: 22 });
    expect(json(a.rows())).not.toBe(json(b.rows()));
    expect((await a.signals('switch.kitchen_plug')).flaps24h).toBe((await b.signals('switch.kitchen_plug')).flaps24h);
  });

  it('the generator gives the same scenario for the same seed', () => {
    expect(json(generateScenario(77))).toBe(json(generateScenario(77)));
    expect(json(generateScenario(10077))).toBe(json(generateScenario(10077)));
    expect(json(generateScenario(77))).not.toBe(json(generateScenario(78)));
  });

  it('a custom start time and time zone are honoured', () => {
    const home = SimHome.create({ seed: 3, tz: 'Asia/Kolkata', now: '2026-11-02T09:30:00' });
    expect(home.now()).toBe('2026-11-02T04:00:00.000Z');
    expect(home.tz).toBe('Asia/Kolkata');
    const iso = SimHome.create({ seed: 3, now: '2026-10-20T00:00:00Z', faults: 'none' });
    expect(iso.now()).toBe('2026-10-20T00:00:00.000Z');
  });
});
