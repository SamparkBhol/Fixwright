// Small, pure statistics for the HomeTruth report: Wilson score intervals for rates, nearest-rank
// percentiles, and an exact McNemar test for paired comparisons (two agents on the same scenarios).

/** z for a two-sided 95% interval. */
export const Z95 = 1.959963984540054;

export interface Rate {
  /** Successes. */
  k: number;
  n: number;
  /** k / n, or null when n is 0. */
  value: number | null;
  /** 95% Wilson score interval, or null when n is 0. */
  ci95: [number, number] | null;
}

const round = (x: number, digits = 4): number => Math.round(x * 10 ** digits) / 10 ** digits;

/**
 * Wilson score interval for k successes in n trials. Unlike the normal approximation it stays inside
 * [0, 1] and is sensible at k = 0 and k = n, which matters for counts like false confirmations.
 */
export function wilson(k: number, n: number, z = Z95): [number, number] | null {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) throw new RangeError(`wilson needs integers 0 <= k <= n, got k=${k} n=${n}`);
  if (n === 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // Exact ends: at k = 0 the lower bound is 0 and at k = n the upper bound is 1.
  const lo = k === 0 ? 0 : Math.max(0, center - half);
  const hi = k === n ? 1 : Math.min(1, center + half);
  return [round(lo), round(hi)];
}

export function rate(k: number, n: number): Rate {
  return { k, n, value: n === 0 ? null : round(k / n), ci95: wilson(k, n) };
}

/** Nearest-rank percentile (the same definition homefault's runner uses). 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (!(p >= 0 && p <= 100)) throw new RangeError('p must be within 0 and 100');
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] as number;
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : round(values.reduce((a, b) => a + b, 0) / values.length);
}

/** Do two closed intervals share at least one point? */
export function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * Exact two-sided McNemar test on discordant pairs: `b` cases where only the first agent had the
 * property, `c` where only the second did. Returns the binomial p-value (1 when there are no
 * discordant pairs).
 */
export function mcnemarExact(b: number, c: number): number {
  if (!Number.isInteger(b) || !Number.isInteger(c) || b < 0 || c < 0) throw new RangeError('mcnemarExact needs non-negative integers');
  const n = b + c;
  if (n === 0) return 1;
  const m = Math.min(b, c);
  // Sum of C(n, i) / 2^n for i <= m, in log space so large n cannot overflow.
  let logC = 0;
  let tail = 0;
  for (let i = 0; i <= m; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logC - n * Math.LN2);
  }
  return round(Math.min(1, 2 * tail), 6);
}
