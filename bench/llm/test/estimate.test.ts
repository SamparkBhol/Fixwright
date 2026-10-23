import { describe, expect, it } from 'vitest';
import { estimateCallMs, estimateRun, median } from '../src/estimate.ts';

describe('estimateCallMs', () => {
  it('adds prompt time, generation time and overhead', () => {
    // 1500 tokens at 100 tok/s = 15 s; 300 tokens at 20 tok/s = 15 s; plus 250 ms.
    expect(estimateCallMs({ promptTokens: 1500, outputTokens: 300, overheadMs: 250 }, { promptTokensPerSecond: 100, generationTokensPerSecond: 20 })).toBe(30_250);
  });

  it('rejects non-positive throughput', () => {
    expect(() => estimateCallMs({ promptTokens: 1, outputTokens: 1 }, { promptTokensPerSecond: 0, generationTokensPerSecond: 1 })).toThrow(RangeError);
  });
});

describe('estimateRun', () => {
  it('scales linearly with the number of calls', () => {
    const r = estimateRun(300, { promptTokens: 1500, outputTokens: 300 }, { promptTokensPerSecond: 100, generationTokensPerSecond: 20 });
    expect(r).toEqual({ calls: 300, perCallMs: 30_000, totalMs: 9_000_000, totalMinutes: 150 });
  });

  it('rejects a fractional call count', () => {
    expect(() => estimateRun(1.5, { promptTokens: 1, outputTokens: 1 }, { promptTokensPerSecond: 1, generationTokensPerSecond: 1 })).toThrow(RangeError);
  });
});

describe('median', () => {
  it('handles odd and even lengths without mutating input', () => {
    const xs = [3, 1, 2];
    expect(median(xs)).toBe(2);
    expect(xs).toEqual([3, 1, 2]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it('throws on an empty list', () => {
    expect(() => median([])).toThrow(RangeError);
  });
});
