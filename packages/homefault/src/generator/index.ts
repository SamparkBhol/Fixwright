// The scenario generator: one seed, one broken home. Cause assignment is balanced in blocks of ten
// seeds and shuffled per block, so the seed does not give the cause away. The dev set is seeds 1 to 500,
// the held-out set seeds 10001 to 10200; tune on dev, report on held-out.

import type { LogRow } from '../logrows.ts';
import { sortRows } from '../logrows.ts';
import { between, chance, int, pick, rngFor, shuffle } from '../rng.ts';
import { SCENARIO_FORMAT, type Scenario } from '../scenario/types.ts';
import { atLocal, DAY, HOUR, iso } from '../time.ts';
import { MAX_DROP_RATE } from '../scenario/validate.ts';
import { CAUSE_IDS, type CauseId, type CloudStatus, type Rng } from '../types.ts';
import { distractors, STORYLINES } from './causes.ts';
import { everydayLife, homeEntities, homeSignals, initialWorld, sampleHouse, simulate, TIME_ZONES } from './world.ts';

export const GENERATOR_VERSION = 1;

export const SPLITS = {
  dev: { from: 1, to: 500 },
  heldout: { from: 10001, to: 10200 },
} as const;
export type Split = keyof typeof SPLITS;

/** Home Assistant's default recorder keeps 10 days; older rows are gone. */
const RETENTION_MS = 10 * DAY;
export const MAX_JITTER_MS = 1500;

export function splitOf(seed: number): Split | null {
  for (const [name, range] of Object.entries(SPLITS) as Array<[Split, { from: number; to: number }]>) {
    if (seed >= range.from && seed <= range.to) return name;
  }
  return null;
}

export function seedsOf(split: Split): number[] {
  const { from, to } = SPLITS[split];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Balanced: every block of ten consecutive seeds holds each cause once, in a seeded order. */
export function causeForSeed(seed: number): CauseId {
  const split = splitOf(seed);
  const base = split ? SPLITS[split].from : 0;
  const offset = seed - base;
  const block = Math.floor(offset / CAUSE_IDS.length);
  const order = shuffle(rngFor('homefault-generator', split ?? 'custom', block), CAUSE_IDS);
  return order[((offset % CAUSE_IDS.length) + CAUSE_IDS.length) % CAUSE_IDS.length] as CauseId;
}

export interface GenerateOptions {
  /** false: no jitter and no dropped rows (every scenario then carries its full evidence). */
  noise?: boolean;
  /** Force a cause instead of the balanced assignment. */
  cause?: CauseId;
}

/** Timing jitter keeps rows of one context together; dropped rows vanish independently. */
function applyNoise(rng: Rng, rows: readonly LogRow[], nowMs: number, jitterMs: number, dropRate: number): LogRow[] {
  const offsets = new Map<string, number>();
  const out: LogRow[] = [];
  for (const row of rows) {
    if (chance(rng, dropRate)) continue;
    const key = row.context?.id;
    let offset: number;
    if (key) {
      offset = offsets.get(key) ?? int(rng, -jitterMs, jitterMs);
      offsets.set(key, offset);
    } else {
      offset = int(rng, -jitterMs, jitterMs);
    }
    const t = Math.min(nowMs - 1, Date.parse(row.when) + offset);
    out.push({ ...row, when: iso(t) });
  }
  return out;
}

const LABEL: Readonly<Record<CauseId, string>> = {
  stale_duplicate: 'name points at an old copy',
  device_power_lost: 'device has no power',
  radio_link_weak: 'weak radio link',
  hub_down: 'hub or bridge offline',
  vendor_cloud_outage: 'vendor cloud outage',
  account_link_expired: 'account link expired',
  power_on_default_on: 'devices turn on after a power cut',
  name_collision: 'two devices share a name',
  dead_trigger: 'automation uses a removed device',
  wifi_network_changed: 'Wi-Fi network changed',
};

/** One scenario from one seed. Same seed, same scenario, byte for byte, in every runtime. */
export function generateScenario(seed: number, opts: GenerateOptions = {}): Scenario {
  if (!Number.isInteger(seed)) throw new RangeError('seed must be an integer');
  const split = splitOf(seed);
  const cause = opts.cause ?? causeForSeed(seed);
  const rng = rngFor('gen', seed, 'house');
  const tz = pick(rng, TIME_ZONES);
  const day = int(rng, 0, 281);
  const date = new Date(Date.UTC(2026, 0, 5 + day)).toISOString().slice(0, 10);
  const nowMs = atLocal(date, `${String(int(rng, 7, 22)).padStart(2, '0')}:${String(int(rng, 0, 59)).padStart(2, '0')}:${String(int(rng, 0, 59)).padStart(2, '0')}`, tz) + int(rng, 0, 999);
  const house = sampleHouse(rng, nowMs, tz, 48 * HOUR + int(rng, 0, 12) * HOUR);

  const story = STORYLINES[cause](rngFor('gen', seed, 'story'), house);
  const noise = distractors(rngFor('gen', seed, 'distractors'), house, cause, story);
  const world = initialWorld(rngFor('gen', seed, 'world'), house);
  let life = everydayLife(rngFor('gen', seed, 'life'), house, story.quiet);
  if (story.blackout) {
    const [a, b] = story.blackout;
    life = life.filter((it) => it.t < a || it.t > b);
  }
  const rows = simulate(house, world, [...life, ...story.intents, ...noise.intents]).filter((r) => Date.parse(r.when) >= nowMs - RETENTION_MS);

  const noisy = opts.noise !== false;
  const nrng = rngFor('gen', seed, 'noise');
  const jitterMs = noisy ? (chance(nrng, 0.2) ? 0 : int(nrng, 50, MAX_JITTER_MS)) : 0;
  const dropRate = noisy ? Math.round(between(nrng, 0, MAX_DROP_RATE) * 1000) / 1000 : 0;
  const events = sortRows(applyNoise(nrng, rows, nowMs, jitterMs, dropRate));

  const cloud: CloudStatus[] = [...house.cloud.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([vendor, status]) => ({ vendor, status, source: 'vendor status page', checkedAt: iso(nowMs) }));

  return {
    format: SCENARIO_FORMAT,
    id: `gen-${split ?? 'custom'}-${seed}`,
    title: `Generated (${split ?? 'custom'} ${seed}): ${LABEL[cause]}`,
    kind: 'generated',
    source: { url: `homefault://generator/v${GENERATOR_VERSION}/${seed}`, date: iso(nowMs).slice(0, 10), note: 'Generated by the homefault event-level generator.' },
    reconstructed: false,
    assumptions: [],
    tz,
    now: iso(nowMs),
    symptom: story.symptom,
    home: {
      entities: homeEntities(house, world),
      integrations: [...house.integrations.values()].sort((a, b) => a.integration.localeCompare(b.integration)),
      hub: { reachable: true, latencyMs: int(rngFor('gen', seed, 'hub'), 8, 40), version: '2026.9.4' },
      cloud,
      signals: homeSignals(house, world),
    },
    events,
    ground_truth: story.truth,
    human_truth: story.human,
    noise: { jitter_ms: jitterMs, drop_rate: dropRate },
    tags: ['generated', split ?? 'custom', cause, ...story.tags, ...noise.tags],
  };
}

export function generateSet(split: Split, opts: GenerateOptions = {}): Scenario[] {
  return seedsOf(split).map((seed) => generateScenario(seed, opts));
}

