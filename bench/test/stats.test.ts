import { describe, expect, it } from 'vitest';
import { mcnemarExact, mean, overlaps, percentile, rate, wilson, Z95 } from '../src/stats.ts';

const z2 = Z95 * Z95;

describe('wilson', () => {
  it('matches the closed forms at the ends: k = 0 gives [0, z²/(n+z²)], k = n gives [n/(n+z²), 1]', () => {
    for (const n of [1, 6, 10, 200, 720]) {
      const lo0 = wilson(0, n) as [number, number];
      expect(lo0[0]).toBe(0);
      expect(lo0[1]).toBeCloseTo(z2 / (n + z2), 4);
      const hiN = wilson(n, n) as [number, number];
      expect(hiN[0]).toBeCloseTo(n / (n + z2), 4);
      expect(hiN[1]).toBe(1);
    }
    // n = 10: the textbook values 0.2775 and 0.7225.
    expect(wilson(0, 10)).toEqual([0, 0.2775]);
    expect(wilson(10, 10)).toEqual([0.7225, 1]);
  });

  it('is centred on (k + z²/2) / (n + z²) with the Wilson half width', () => {
    const cases: [number, number][] = [
      [5, 10],
      [1, 10],
      [16, 20],
      [151, 200],
      [7, 200],
    ];
    for (const [k, n] of cases) {
      const p = k / n;
      const center = (k + z2 / 2) / (n + z2);
      const half = ((Z95 * Math.sqrt(n)) / (n + z2)) * Math.sqrt(p * (1 - p) + z2 / (4 * n));
      const [lo, hi] = wilson(k, n) as [number, number];
      expect(lo).toBeCloseTo(center - half, 4);
      expect(hi).toBeCloseTo(center + half, 4);
      expect(lo).toBeLessThanOrEqual(p);
      expect(hi).toBeGreaterThanOrEqual(p);
    }
    expect(wilson(5, 10)).toEqual([0.2366, 0.7634]);
  });

  it('is symmetric: the interval for k of n mirrors the one for n - k', () => {
    for (const [k, n] of [
      [3, 17],
      [40, 200],
      [1, 6],
    ] as const) {
      const [a, b] = wilson(k, n) as [number, number];
      const [c, d] = wilson(n - k, n) as [number, number];
      expect(a).toBeCloseTo(1 - d, 4);
      expect(b).toBeCloseTo(1 - c, 4);
    }
  });

  it('narrows as n grows at the same rate', () => {
    const width = (k: number, n: number) => {
      const [lo, hi] = wilson(k, n) as [number, number];
      return hi - lo;
    };
    expect(width(8, 10)).toBeGreaterThan(width(80, 100));
    expect(width(80, 100)).toBeGreaterThan(width(800, 1000));
  });

  it('returns null for n = 0 and rejects impossible counts', () => {
    expect(wilson(0, 0)).toBeNull();
    expect(() => wilson(3, 2)).toThrow(RangeError);
    expect(() => wilson(-1, 2)).toThrow(RangeError);
    expect(() => wilson(1.5, 2)).toThrow(RangeError);
  });

  it('rate() carries k, n, the value and the interval', () => {
    expect(rate(16, 20)).toEqual({ k: 16, n: 20, value: 0.8, ci95: wilson(16, 20) });
    expect(rate(0, 0)).toEqual({ k: 0, n: 0, value: null, ci95: null });
  });
});

describe('percentile, mean, overlaps', () => {
  it('uses the nearest rank definition', () => {
    const xs = [5, 1, 4, 2, 3];
    expect(percentile(xs, 50)).toBe(3);
    expect(percentile(xs, 95)).toBe(5);
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile([], 50)).toBe(0);
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95)).toBe(19);
    expect(() => percentile(xs, 101)).toThrow(RangeError);
  });

  it('means and interval overlap', () => {
    expect(mean([1, 2, 4])).toBe(2.3333);
    expect(mean([])).toBe(0);
    expect(overlaps([0, 0.2], [0.2, 0.5])).toBe(true);
    expect(overlaps([0, 0.19], [0.2, 0.5])).toBe(false);
  });
});

describe('mcnemarExact', () => {
  it('is the two sided binomial tail on the discordant pairs', () => {
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(1, 1)).toBe(1);
    // 0 vs 5: 2 * (1/2)^5
    expect(mcnemarExact(0, 5)).toBe(0.0625);
    // 1 vs 9: 2 * (1 + 10) / 1024
    expect(mcnemarExact(1, 9)).toBeCloseTo(22 / 1024, 6);
    expect(mcnemarExact(9, 1)).toBe(mcnemarExact(1, 9));
    // Large n stays finite (log space) and rounds to 6 digits.
    expect(Number.isFinite(mcnemarExact(400, 600))).toBe(true);
    expect(mcnemarExact(400, 600)).toBeLessThan(1e-6);
    expect(mcnemarExact(480, 520)).toBeCloseTo(0.2179, 3);
  });
});
