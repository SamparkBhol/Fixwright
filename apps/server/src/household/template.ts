// SimHome.create simulates a whole day of the house (23.6 ms for the first house of a fresh Node process,
// HOUSEHOLD_CPU.json), over the Free plan's 10 ms per invocation. So a new demo house is the prebuilt
// template (demo-template.json, written at build time by scripts/build-template.ts) moved to its start time
// with rebaseSnapshot, and it takes its own seed for everything that happens afterwards (routine, dropoffs,
// latency). One rebase per start time is cached per isolate, so later houses on the same day are a string
// copy.
//
// A rebase moves every instant by one delta, so it keeps local times (the 3:11 a.m. outage) only when the
// start is at the template's local time of day. Any other start builds its house with SimHome.create.

import { localTime } from '@fixwright/engine';
import { rebaseSnapshot, SimHome, SNAPSHOT_VERSION, type SimSnapshot } from 'homefault';
import prebuilt from './demo-template.json' with { type: 'json' };
import { aquariumOf, TEMPLATE_SEED, type DemoTemplate, type ProtectedPick } from './template-build.ts';

export { TEMPLATE_SEED, type ProtectedPick } from './template-build.ts';

export const DEMO_TEMPLATE = prebuilt as unknown as DemoTemplate;
/** Start times kept per isolate (a day boundary or a DEMO_START change adds one). */
export const MAX_TEMPLATES = 4;

interface Cached {
  /** The snapshot JSON without its seed and opening brace: `{"seed":N,` + tail is a whole snapshot. */
  tail: string;
  aquarium: ProtectedPick | null;
}

const cache = new Map<string, Cached>();

export interface DemoHome {
  /** The house as SimHome snapshot JSON, ready to store. */
  json: string;
  /**
   * The live SimHome when this call had to create one for seed TEMPLATE_SEED; otherwise null, and the
   * household loads it from storage when a tool first needs it, so creating a household never parses it.
   */
  sim: SimHome | null;
  aquarium: ProtectedPick | null;
  from: 'cache' | 'template' | 'create';
}

const templateStartMs = Date.parse(DEMO_TEMPLATE.start);

/** True when rebasing the template to startMs keeps every local time of day. */
export function rebasable(startMs: number, tz: string): boolean {
  if (tz !== DEMO_TEMPLATE.tz || DEMO_TEMPLATE.snapshot.v !== SNAPSHOT_VERSION) return false;
  if (startMs === templateStartMs) return true;
  if (((startMs % 1000) + 1000) % 1000 !== templateStartMs % 1000) return false;
  const a = localTime(startMs, tz);
  const b = localTime(templateStartMs, tz);
  return a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

const withSeed = (c: Cached, seed: number): string => `{"seed":${seed},${c.tail}`;

function remember(key: string, snapshot: SimSnapshot, aquarium: ProtectedPick | null): Cached {
  const { seed: _seed, ...rest } = snapshot;
  const c: Cached = { tail: JSON.stringify(rest).slice(1), aquarium };
  if (cache.size >= MAX_TEMPLATES) cache.delete(cache.keys().next().value as string);
  cache.set(key, c);
  return c;
}

/** A demo house for `seed` starting at household time `startMs`. */
export async function demoHome(seed: number, tz: string, startMs: number): Promise<DemoHome> {
  if (!Number.isInteger(seed)) throw new Error('seed must be an integer');
  const key = `${tz}|${startMs}`;
  const cached = cache.get(key);
  if (cached) return { json: withSeed(cached, seed), sim: null, aquarium: cached.aquarium, from: 'cache' };
  if (rebasable(startMs, tz)) {
    const c = remember(key, rebaseSnapshot(DEMO_TEMPLATE.snapshot, startMs), DEMO_TEMPLATE.aquarium);
    return { json: withSeed(c, seed), sim: null, aquarium: c.aquarium, from: 'template' };
  }
  const built = SimHome.create({ seed: TEMPLATE_SEED, tz, now: startMs });
  const c = remember(key, built.snapshot(), await aquariumOf(built));
  return { json: withSeed(c, seed), sim: seed === TEMPLATE_SEED ? built : null, aquarium: c.aquarium, from: 'create' };
}

/**
 * One rebase and copy at module scope, so the JIT work of the first house counts against startup instead of
 * the first household call (HOUSEHOLD_CPU.json).
 */
export function warmTemplate(): void {
  const { seed: _seed, ...rest } = rebaseSnapshot(DEMO_TEMPLATE.snapshot, templateStartMs + 86_400_000);
  JSON.stringify(rest);
}

/** For tests and the CPU harness: the next house of every start time is rebased or created again. */
export function clearTemplates(): void {
  cache.clear();
}
