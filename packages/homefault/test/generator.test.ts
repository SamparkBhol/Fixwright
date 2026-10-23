// The generator: seeded, balanced, split into dev and held-out, with bounded noise, distractors and
// correlated failures; and every scenario carries the evidence for its cause when noise is off.

import { describe, expect, it } from 'vitest';
import {
  CAUSE_IDS,
  MAX_DROP_RATE,
  MAX_JITTER_MS,
  SPLITS,
  causeForSeed,
  checkEvidence,
  generateScenario,
  generateSet,
  seedsOf,
  splitOf,
  toHouseEvents,
  validateScenario,
  type CauseId,
  type Scenario,
} from '../src/index.ts';

const dev = generateSet('dev');
const heldout = generateSet('heldout');
const all = [...dev, ...heldout];

const countBy = <T extends string>(items: readonly T[]): Record<string, number> =>
  items.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x]: (acc[x] ?? 0) + 1 }), {});

describe('splits', () => {
  it('dev is seeds 1 to 500 and held-out 10001 to 10200, disjoint', () => {
    expect(SPLITS).toEqual({ dev: { from: 1, to: 500 }, heldout: { from: 10001, to: 10200 } });
    expect(seedsOf('dev')).toHaveLength(500);
    expect(seedsOf('heldout')).toHaveLength(200);
    expect(splitOf(1)).toBe('dev');
    expect(splitOf(500)).toBe('dev');
    expect(splitOf(501)).toBeNull();
    expect(splitOf(10200)).toBe('heldout');
    const ids = new Set(all.map((s) => s.id));
    expect(ids.size).toBe(700);
    expect(dev.every((s) => s.id.startsWith('gen-dev-'))).toBe(true);
    expect(heldout.every((s) => s.id.startsWith('gen-heldout-'))).toBe(true);
  });

  it('every cause appears equally often in both splits, and every block of ten holds each cause once', () => {
    const devCounts = countBy(dev.map((s) => s.ground_truth.cause_id));
    const heldCounts = countBy(heldout.map((s) => s.ground_truth.cause_id));
    for (const cause of CAUSE_IDS) {
      expect(devCounts[cause]).toBe(50);
      expect(heldCounts[cause]).toBe(20);
    }
    for (let block = 0; block < 50; block++) {
      const causes = new Set(Array.from({ length: 10 }, (_, i) => causeForSeed(1 + block * 10 + i)));
      expect(causes.size).toBe(10);
    }
  });

  it('the scenario id does not reveal the cause: consecutive blocks use different orders', () => {
    const orders = new Set(Array.from({ length: 20 }, (_, b) => Array.from({ length: 10 }, (_, i) => causeForSeed(1 + b * 10 + i)).join(',')));
    expect(orders.size).toBeGreaterThan(15);
  });
});

describe('noise', () => {
  it('drops between 0% and 15% of rows, jitters at most 1.5 s', () => {
    const rates = all.map((s) => s.noise.drop_rate);
    expect(Math.min(...rates)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...rates)).toBeLessThanOrEqual(MAX_DROP_RATE);
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    expect(mean).toBeGreaterThan(0.06);
    expect(mean).toBeLessThan(0.09);
    expect(rates.filter((r) => r < 0.05).length).toBeGreaterThan(150);
    expect(rates.filter((r) => r > 0.1).length).toBeGreaterThan(150);
    const jitters = all.map((s) => s.noise.jitter_ms);
    expect(Math.max(...jitters)).toBeLessThanOrEqual(MAX_JITTER_MS);
    expect(jitters.filter((j) => j === 0).length).toBeGreaterThan(70);
  });

  it('the measured share of dropped rows matches the declared drop rate', () => {
    let kept = 0;
    let total = 0;
    let declared = 0;
    for (const seed of seedsOf('dev').slice(0, 200)) {
      const noisy = generateScenario(seed);
      const clean = generateScenario(seed, { noise: false });
      kept += noisy.events.length;
      total += clean.events.length;
      declared += noisy.noise.drop_rate * clean.events.length;
    }
    const measured = 1 - kept / total;
    expect(Math.abs(measured - declared / total)).toBeLessThan(0.01);
  });

  it('jitter never pushes a row past the moment the person asks', () => {
    for (const s of all) {
      const now = Date.parse(s.now);
      expect(s.events.every((r) => Date.parse(r.when) <= now)).toBe(true);
    }
  });

  it('noise only touches the logs: the home is the same with and without it', () => {
    for (const seed of [3, 30, 300, 10003]) {
      const a = generateScenario(seed);
      const b = generateScenario(seed, { noise: false });
      expect(a.home).toEqual(b.home);
      expect(a.ground_truth).toEqual(b.ground_truth);
      expect(b.noise).toEqual({ jitter_ms: 0, drop_rate: 0 });
    }
  });
});

describe('scenarios', () => {
  it('all 700 validate against the format', () => {
    const bad = all.map((s) => ({ id: s.id, r: validateScenario(s) })).filter((x) => !x.r.ok);
    expect(bad).toEqual([]);
  });

  it('without noise, every scenario carries the evidence its cause needs and nothing contradictory', () => {
    const failures: string[] = [];
    for (const split of ['dev', 'heldout'] as const) {
      for (const seed of seedsOf(split)) {
        const s = generateScenario(seed, { noise: false });
        const r = checkEvidence(s);
        if (!r.supported) failures.push(`${s.id} ${r.cause_id}: ${[...r.missing, ...r.contradictions].join('; ')}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('with noise, a few scenarios lose evidence (the honest answer there is likely or cant_tell)', () => {
    const lost = all.filter((s) => !checkEvidence(s).supported);
    expect(lost.length).toBeLessThan(all.length * 0.05);
  });

  it('includes distractors and correlated failures', () => {
    const tags = all.flatMap((s) => s.tags ?? []);
    for (const t of ['distractor:blip', 'distractor:low_battery', 'distractor:old_ghost', 'distractor:ha_restart']) {
      expect(tags.filter((x) => x === t).length).toBeGreaterThan(30);
    }
    const hub = all.filter((s) => s.ground_truth.cause_id === 'hub_down');
    for (const s of hub) {
      const target = s.home.entities.find((e) => e.entityId === s.ground_truth.entity_ids[0]);
      const sameIntegration = s.home.entities.filter((e) => e.integration === target?.integration && !e.restored);
      expect(sameIntegration.length).toBeGreaterThanOrEqual(3);
      expect(sameIntegration.every((e) => e.state === 'unavailable')).toBe(true);
    }
    const restore = all.filter((s) => s.ground_truth.cause_id === 'power_on_default_on');
    for (const s of restore) expect(s.ground_truth.entity_ids.length).toBeGreaterThanOrEqual(3);
  });

  it('varies the house: time zones, sizes, integrations', () => {
    expect(new Set(all.map((s) => s.tz)).size).toBeGreaterThanOrEqual(6);
    const sizes = all.map((s) => s.home.entities.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeGreaterThan(10);
    expect(new Set(all.flatMap((s) => s.home.integrations.map((i) => i.integration)))).toEqual(
      new Set(['automation', 'ecobee', 'hue', 'kasa', 'matter', 'shelly', 'tuya', 'zigbee2mqtt']),
    );
  });

  it('every row maps to a HouseEvent and contexts resolve to users or automations', () => {
    const s = generateScenario(42, { noise: false });
    const events = toHouseEvents(s.events);
    expect(events.length).toBeGreaterThanOrEqual(s.events.length);
    expect(events.some((e) => e.context?.userId)).toBe(true);
    expect(events.some((e) => e.context?.automationId)).toBe(true);
  });

  it('a forced cause is honoured for any seed', () => {
    const forced: CauseId[] = ['dead_trigger', 'stale_duplicate'];
    for (const cause of forced) {
      const s: Scenario = generateScenario(9999, { cause });
      expect(s.ground_truth.cause_id).toBe(cause);
      expect(s.id).toBe('gen-custom-9999');
    }
  });
});
