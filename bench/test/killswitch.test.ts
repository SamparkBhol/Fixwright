import { describe, expect, it } from 'vitest';
import { evaluateKillSwitch, MIN_CONCLUSIVE_N } from '../src/killswitch.ts';
import { computeMetrics, type AgentName, type CaseRow } from '../src/metrics.ts';

/** Synthetic rows: `right` correct answers, `falseConf` confirmed wrong ones, the rest abstentions. */
function rows(agent: AgentName, n: number, right: number, falseConf: number): CaseRow[] {
  return Array.from({ length: n }, (_, i): CaseRow => {
    const correct = i < right;
    const fc = !correct && i < right + falseConf;
    const abstained = !correct && !fc;
    return {
      agent,
      scenario_id: `s${i}`,
      set: 'heldout',
      expected: 'hub_down',
      got: correct ? 'hub_down' : fc ? 'stale_duplicate' : 'unknown',
      level: abstained ? 'cant_tell' : 'confirmed',
      confidence: abstained ? null : 0.95,
      correct,
      false_confirmed: fc,
      abstained,
      probes_used: 0,
      disruptive_probes: 0,
      human_questions: 0,
      latency_ms: i,
      invalid_output: false,
      infra_error: false,
      error: null,
    };
  });
}

describe('computeMetrics', () => {
  it('counts rates with intervals and keeps abstentions out of confirmed precision', () => {
    const m = computeMetrics(rows('b1', 50, 30, 5));
    expect(m.top1).toMatchObject({ k: 30, n: 50, value: 0.6 });
    expect(m.false_confirmed.count).toBe(5);
    expect(m.abstention).toMatchObject({ k: 15, n: 50 });
    expect(m.confirmed_precision).toMatchObject({ k: 30, n: 35 });
    expect(m.top1_answered).toMatchObject({ k: 30, n: 35 });
    expect(m.latency_ms).toMatchObject({ p50: 24, p95: 47, max: 49 });
  });
});

describe('evaluateKillSwitch', () => {
  it('is not evaluated without a baseline', () => {
    const k = evaluateKillSwitch(rows('fixwright', 40, 30, 0));
    expect(k).toMatchObject({ evaluated: false, fires: null });
  });

  it('does not fire when the baseline is clearly worse on false confirmations', () => {
    const k = evaluateKillSwitch([...rows('fixwright', 200, 160, 0), ...rows('b1', 200, 150, 40)]);
    expect(k.evaluated).toBe(true);
    expect(k.comparisons[0]?.conclusive).toBe(true);
    expect(k.comparisons[0]?.top1.match).toBe(true);
    expect(k.comparisons[0]?.false_confirmed.match).toBe(false);
    expect(k.comparisons[0]?.false_confirmed.paired).toMatchObject({ b: 0, c: 40 });
    expect(k.fires).toBe(false);
    expect(k.conclusive).toBe(true);
    expect(k.note).toMatch(/^Does not fire/);
  });

  it('fires when a baseline cannot be told apart on both metrics', () => {
    const k = evaluateKillSwitch([...rows('fixwright', 100, 70, 1), ...rows('b1', 100, 30, 30), ...rows('b2', 100, 68, 2)]);
    expect(k.comparisons.map((c) => [c.baseline, c.matches])).toEqual([
      ['b1', false],
      ['b2', true],
    ]);
    expect(k.fires).toBe(true);
    expect(k.note).toMatch(/^Fires/);
  });

  it('says a small run is not conclusive, and compares only paired scenarios', () => {
    const k = evaluateKillSwitch([...rows('fixwright', 200, 160, 0), ...rows('b1', 6, 3, 2)]);
    expect(k.comparisons[0]?.n).toBe(6);
    expect(k.comparisons[0]?.top1.fixwright.n).toBe(6);
    expect(k.conclusive).toBe(false);
    expect(6).toBeLessThan(MIN_CONCLUSIVE_N);
    expect(k.note).toMatch(/^Not conclusive: only 6 paired scenarios/);
    expect(k.fires).toBeNull();
    expect(typeof k.provisional_fires).toBe('boolean');
  });
});
