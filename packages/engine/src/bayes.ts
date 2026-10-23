// Single fault Bayesian diagnosis: one cause explains the symptom. The posterior is a distribution over
// the applicable causes plus 'unknown', a catch all whose likelihoods sit between the typical cause and
// a flat guess, so evidence that fits no modelled cause shows up as doubt instead of false confidence.

import type { HumanReliability } from './types.ts';

export type Dist = Record<string, number>;

/** P(value | hypothesis) for each value a probe can report. */
export type Row = Readonly<Record<string, number>>;

export type LikelihoodFn = (hypothesis: string, value: string) => number;

export const UNKNOWN = 'unknown';

export function normalize(d: Dist): Dist {
  const total = Object.values(d).reduce((s, p) => s + p, 0);
  if (!(total > 0)) {
    const keys = Object.keys(d);
    return Object.fromEntries(keys.map((k) => [k, 1 / keys.length]));
  }
  return Object.fromEntries(Object.entries(d).map(([k, p]) => [k, p / total]));
}

export function bayesUpdate(d: Dist, value: string, lik: LikelihoodFn): Dist {
  return normalize(Object.fromEntries(Object.entries(d).map(([h, p]) => [h, p * lik(h, value)])));
}

export function entropy(d: Dist): number {
  let h = 0;
  for (const p of Object.values(d)) if (p > 0) h -= p * Math.log2(p);
  return h;
}

/** Expected drop in entropy (bits) from observing one of `values`. */
export function expectedInfoGain(d: Dist, values: readonly string[], lik: LikelihoodFn): number {
  const before = entropy(d);
  let after = 0;
  for (const v of values) {
    let pv = 0;
    const joint: Dist = {};
    for (const [h, p] of Object.entries(d)) {
      const j = p * lik(h, v);
      joint[h] = j;
      pv += j;
    }
    if (pv > 0) after += pv * entropy(normalize(joint));
  }
  return Math.max(0, before - after);
}

/** Every pair of values from two observations, for looking one probe ahead. */
export function jointValues(a: readonly string[], b: readonly string[]): string[] {
  return a.flatMap((x) => b.map((y) => `${x}\u0000${y}`));
}

export function jointLikelihood(a: LikelihoodFn, b: LikelihoodFn): LikelihoodFn {
  return (h, v) => {
    const [x = '', y = ''] = v.split('\u0000');
    return a(h, x) * b(h, y);
  };
}

/**
 * Likelihood for the catch all hypothesis: half the average of the modelled causes, half a flat guess.
 */
export function residualLikelihood(rows: readonly Row[], values: readonly string[], value: string): number {
  const mean = rows.length === 0 ? 1 / values.length : rows.reduce((s, r) => s + (r[value] ?? 0), 0) / rows.length;
  return 0.5 * mean + 0.5 * (1 / values.length);
}

/**
 * A person's yes or no as a noisy sensor of a true fact: P(yes | fact true) = sensitivity and
 * P(yes | fact false) = 1 minus specificity.
 */
export function answerLikelihood(pTrue: number, said: 'yes' | 'no', rel: HumanReliability): number {
  const pYes = pTrue * rel.sensitivity + (1 - pTrue) * (1 - rel.specificity);
  return said === 'yes' ? pYes : 1 - pYes;
}

export const DEFAULT_RELIABILITY: Required<HumanReliability> = {
  sensitivity: 0.92,
  specificity: 0.95,
  positives: 20,
  negatives: 20,
};

const clampRate = (x: number): number => Math.min(0.995, Math.max(0.6, x));

/**
 * Updates a household's reliability once sensor evidence shows what was really true. A yes to a true fact
 * (or a no to a false one) nudges the rate up; a contradicted answer nudges it down. Pseudo counts keep
 * one surprise from swinging the rates.
 */
export function updateHumanReliability(rel: HumanReliability, said: 'yes' | 'no', factWasTrue: boolean): Required<HumanReliability> {
  const positives = rel.positives ?? DEFAULT_RELIABILITY.positives;
  const negatives = rel.negatives ?? DEFAULT_RELIABILITY.negatives;
  if (factWasTrue) {
    const hit = said === 'yes' ? 1 : 0;
    return {
      sensitivity: clampRate((rel.sensitivity * positives + hit) / (positives + 1)),
      specificity: rel.specificity,
      positives: positives + 1,
      negatives,
    };
  }
  const hit = said === 'no' ? 1 : 0;
  return {
    sensitivity: rel.sensitivity,
    specificity: clampRate((rel.specificity * negatives + hit) / (negatives + 1)),
    positives,
    negatives: negatives + 1,
  };
}

export function ranked(d: Dist): [string, number][] {
  return Object.entries(d).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Rounds down to 3 decimals so rounded probabilities never sum past 1. */
export const floor3 = (p: number): number => Math.floor(p * 1000 + 1e-9) / 1000;
