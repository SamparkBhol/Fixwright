import { describe, expect, it } from 'vitest';
import { CAUSE_IDS } from 'homefault';
import { loadSet, sampleScenarios, type TaggedScenario } from '../src/sample.ts';

const heldout = loadSet('heldout');
const incidents = loadSet('incidents');
const ids = (xs: readonly TaggedScenario[]) => xs.map((t) => t.scenario.id);
const countByCause = (xs: readonly TaggedScenario[]) => {
  const m = new Map<string, number>();
  for (const t of xs) m.set(t.scenario.ground_truth.cause_id, (m.get(t.scenario.ground_truth.cause_id) ?? 0) + 1);
  return m;
};

describe('loadSet', () => {
  it('loads the documented set sizes and tags each scenario with its set', () => {
    expect(heldout).toHaveLength(200);
    expect(incidents).toHaveLength(20);
    expect(new Set(heldout.map((t) => t.set))).toEqual(new Set(['heldout']));
    const all = loadSet('all');
    expect(all).toHaveLength(720);
    expect(new Set(ids(all)).size).toBe(720);
  });
});

describe('sampleScenarios', () => {
  it('stratified: same set, n and seed give the same ids, in the set order', () => {
    const a = sampleScenarios(heldout, { n: 6, stratified: true, seed: 1 });
    const b = sampleScenarios(heldout, { n: 6, stratified: true, seed: 1 });
    expect(ids(a)).toEqual(ids(b));
    const order = new Map(ids(heldout).map((id, i) => [id, i]));
    const pos = ids(a).map((id) => order.get(id) as number);
    expect(pos).toEqual([...pos].sort((x, y) => x - y));
  });

  it('stratified: the input order does not change the pick', () => {
    const reversed = [...heldout].reverse();
    const a = sampleScenarios(heldout, { n: 13, stratified: true, seed: 7 });
    const b = sampleScenarios(reversed, { n: 13, stratified: true, seed: 7 });
    expect(new Set(ids(a))).toEqual(new Set(ids(b)));
  });

  it('stratified: n below the cause count covers n distinct causes; larger n stays balanced within one', () => {
    const six = sampleScenarios(heldout, { n: 6, stratified: true, seed: 1 });
    expect(countByCause(six).size).toBe(6);
    for (const n of [10, 25, 37]) {
      const counts = [...countByCause(sampleScenarios(heldout, { n, stratified: true, seed: 3 })).values()];
      expect(counts.reduce((a, b) => a + b, 0)).toBe(n);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      if (n >= CAUSE_IDS.length) expect(counts).toHaveLength(CAUSE_IDS.length);
    }
  });

  it('stratified: on an unbalanced set every cause still gets its share where it can', () => {
    // Incidents have 1 to 3 per cause; 10 picks cover all 10 causes once.
    const ten = sampleScenarios(incidents, { n: 10, stratified: true, seed: 2 });
    expect([...countByCause(ten).values()]).toEqual(Array(10).fill(1));
    const all = sampleScenarios(incidents, { n: 19, stratified: true, seed: 2 });
    expect(all).toHaveLength(19);
  });

  it('different seeds give different samples', () => {
    const a = ids(sampleScenarios(heldout, { n: 20, stratified: true, seed: 1 }));
    const b = ids(sampleScenarios(heldout, { n: 20, stratified: true, seed: 2 }));
    expect(a).not.toEqual(b);
  });

  it('simple random sampling is seeded too', () => {
    const a = ids(sampleScenarios(heldout, { n: 15, seed: 4 }));
    expect(ids(sampleScenarios(heldout, { n: 15, seed: 4 }))).toEqual(a);
    expect(new Set(a).size).toBe(15);
  });

  it('no n or n at least the set size returns the whole list; bad n is rejected', () => {
    expect(sampleScenarios(incidents, { seed: 1 })).toHaveLength(20);
    expect(sampleScenarios(incidents, { n: 50, stratified: true, seed: 1 })).toHaveLength(20);
    expect(() => sampleScenarios(incidents, { n: 0, seed: 1 })).toThrow(RangeError);
    expect(() => sampleScenarios(incidents, { n: 2.5, seed: 1 })).toThrow(RangeError);
  });
});
