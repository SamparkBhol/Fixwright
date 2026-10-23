// Scenario sets and seeded sampling. A stratified sample spreads N scenarios over the ground truth
// causes as evenly as possible (counts differ by at most one where the set allows), so a small sample
// still covers many causes. Same set, N and seed: the same scenario ids, in the set's own order.

import { CAUSE_IDS, generateSet, rngFor, type Rng, type Scenario } from 'homefault';
import { loadIncidents } from 'homefault/incidents';

export const SET_NAMES = ['dev', 'heldout', 'incidents', 'all'] as const;
export type SetName = (typeof SET_NAMES)[number];
export type SubsetName = Exclude<SetName, 'all'>;

export interface TaggedScenario {
  set: SubsetName;
  scenario: Scenario;
}

/** dev and heldout come from homefault's generator (seeds 1 to 500, 10001 to 10200); incidents are the 20 reconstructed reports. */
export function loadSet(name: SetName): TaggedScenario[] {
  const tag = (set: SubsetName, list: Scenario[]): TaggedScenario[] => list.map((scenario) => ({ set, scenario }));
  switch (name) {
    case 'dev':
      return tag('dev', generateSet('dev'));
    case 'heldout':
      return tag('heldout', generateSet('heldout'));
    case 'incidents':
      return tag('incidents', loadIncidents());
    case 'all':
      return [...loadSet('dev'), ...loadSet('heldout'), ...loadSet('incidents')];
  }
}

/** Fisher-Yates on a copy. */
function shuffled<T>(rng: Rng, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export interface SampleOptions {
  n?: number;
  stratified?: boolean;
  seed: number;
}

/**
 * Picks the scenarios to run. No n: the whole list. Stratified: round robin over the causes in a seeded
 * order, a seeded pick inside each cause. Not stratified: a seeded simple random sample. The result keeps
 * the input's order, so reports read the same whatever the seed.
 */
export function sampleScenarios<T extends { scenario: Pick<Scenario, 'id' | 'ground_truth'> }>(items: readonly T[], opts: SampleOptions): T[] {
  const { n, seed } = opts;
  if (n === undefined || n >= items.length) return [...items];
  if (!Number.isInteger(n) || n < 1) throw new RangeError('n must be a positive integer');
  let picked: T[];
  if (opts.stratified) {
    const byCause = new Map<string, T[]>();
    for (const item of items) {
      const cause = item.scenario.ground_truth.cause_id;
      byCause.set(cause, [...(byCause.get(cause) ?? []), item]);
    }
    // A fixed cause order first (the library's, then any others sorted), so the input order cannot matter.
    const known = CAUSE_IDS.filter((c) => byCause.has(c));
    const others = [...byCause.keys()].filter((c) => !(CAUSE_IDS as readonly string[]).includes(c)).sort();
    const causes = shuffled(rngFor('hometruth-sample', seed, 'causes'), [...known, ...others]);
    const queues = causes.map((c) =>
      shuffled(
        rngFor('hometruth-sample', seed, c),
        [...(byCause.get(c) ?? [])].sort((a, b) => a.scenario.id.localeCompare(b.scenario.id)),
      ),
    );
    picked = [];
    for (let round = 0; picked.length < n; round++) {
      for (const q of queues) {
        const item = q[round];
        if (item !== undefined && picked.length < n) picked.push(item);
      }
    }
  } else {
    const sorted = [...items].sort((a, b) => a.scenario.id.localeCompare(b.scenario.id));
    picked = shuffled(rngFor('hometruth-sample', seed, 'simple'), sorted).slice(0, n);
  }
  const chosen = new Set(picked);
  return items.filter((item) => chosen.has(item));
}
