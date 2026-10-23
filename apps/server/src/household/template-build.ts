// How the demo house template is made. scripts/build-template.ts runs this once at build time and writes
// demo-template.json; the Worker only copies and rebases that snapshot. Kept apart from template.ts, which
// imports the JSON, so the build script runs even when the JSON is missing or stale.

import type { Entity } from '@fixwright/protocol';
import { SimHome, type SimSnapshot } from 'homefault';

/** hh_public's seed (lib/crypto.ts seedFor): the house the demo script was written on. */
export const TEMPLATE_SEED = 1;
/** 15:00 in Los Angeles on 15 October 2026, the demo script's afternoon and the e2e and video DEMO_START. */
export const TEMPLATE_START = '2026-10-15T22:00:00.000Z';
export const TEMPLATE_TZ = 'America/Los_Angeles';

export interface ProtectedPick {
  entity_id: string;
  name: string;
}

export interface DemoTemplate {
  seed: number;
  tz: string;
  start: string;
  /** The aquarium filter, protected from the start so the strip refusal works on the first try. */
  aquarium: ProtectedPick | null;
  snapshot: SimSnapshot;
}

const isAquarium = (e: Entity): boolean => /aquarium/i.test(e.name) || /aquarium/i.test(String(e.attributes['load'] ?? ''));

export async function aquariumOf(sim: SimHome): Promise<ProtectedPick | null> {
  const filter = (await sim.listEntities()).find(isAquarium);
  return filter ? { entity_id: filter.entityId, name: filter.name } : null;
}

export async function buildTemplate(seed: number = TEMPLATE_SEED, tz: string = TEMPLATE_TZ, startMs: number = Date.parse(TEMPLATE_START)): Promise<{ template: DemoTemplate; sim: SimHome }> {
  const sim = SimHome.create({ seed, tz, now: startMs });
  return { template: { seed, tz, start: new Date(startMs).toISOString(), aquarium: await aquariumOf(sim), snapshot: sim.snapshot() }, sim };
}
