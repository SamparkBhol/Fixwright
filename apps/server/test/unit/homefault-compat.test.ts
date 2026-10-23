// homefault declares its own HomeAdapter instead of importing @fixwright/protocol, so the two can drift
// without any error until the server hands a SimHome to the engine. The type checks below fail
// `npm run check` the moment they stop matching in either direction.

import type * as P from '@fixwright/protocol';
import { SimHome, generateScenario, scenarioHome, toView, type HomeAdapter, type ScenarioHome } from 'homefault';
import type * as H from 'homefault';
import { describe, expect, it } from 'vitest';

type Assert<T extends true> = T;
type Assignable<A, B> = [A] extends [B] ? true : false;
type Same<A, B> = Assignable<A, B> extends true ? Assignable<B, A> : false;

export type Checks = [
  Assert<Assignable<SimHome, P.HomeAdapter>>,
  Assert<Assignable<ScenarioHome, P.HomeAdapter>>,
  Assert<Same<HomeAdapter, P.HomeAdapter>>,
  Assert<Same<H.Entity, P.Entity>>,
  Assert<Same<H.HouseEvent, P.HouseEvent>>,
  Assert<Same<H.Signals, P.Signals>>,
  Assert<Same<H.IntegrationStatus, P.IntegrationStatus>>,
  Assert<Same<H.CloudStatus, P.CloudStatus>>,
  Assert<Same<H.Clock, P.Clock>>,
  Assert<Same<H.Rng, P.Rng>>,
  Assert<Same<H.EventKind, P.EventKind>>,
  Assert<Same<H.CauseId, P.DiagnosisCauseId>>,
  Assert<Same<H.FindingKind, P.FindingKind>>,
];

async function useProtocolAdapter(adapter: P.HomeAdapter): Promise<number> {
  const entities = await adapter.listEntities();
  await adapter.events({ since: '2026-01-01T00:00:00Z' });
  return entities.length;
}

describe('homefault speaks the protocol adapter shape', () => {
  it('a SimHome works wherever the protocol expects a HomeAdapter', async () => {
    const home: P.HomeAdapter = SimHome.create({ seed: 1 });
    expect(home.kind).toBe('simhome');
    expect(await useProtocolAdapter(home)).toBeGreaterThan(30);
  });

  it('a scenario home works wherever the protocol expects a HomeAdapter', async () => {
    const adapter: P.HomeAdapter = scenarioHome(toView(generateScenario(1)));
    expect(await useProtocolAdapter(adapter)).toBeGreaterThan(5);
  });
});
