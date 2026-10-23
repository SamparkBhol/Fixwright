// Small helpers every tool output needs.

import type { HomeAdapter, SourceInfo } from '@fixwright/protocol';
import type { HouseView } from './house.ts';

/** Which home an answer came from. SimHome answers are always labelled simulated. */
export function sourceOf(adapter: Pick<HomeAdapter, 'kind'>): SourceInfo {
  return { adapter: adapter.kind, simulated: adapter.kind === 'simhome' };
}

/** Names of things in the house (devices, aliases, areas): framing text may not mention them. */
export function houseWords(house: HouseView): string[] {
  const words = new Set<string>();
  for (const e of house.all) {
    words.add(e.name);
    for (const a of e.aliases) words.add(a);
    if (e.area) words.add(e.area);
  }
  return [...words].filter((w) => w.trim().length > 2);
}

/** Deep copy of a plain JSON value (sessions, plans, verdicts). */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
