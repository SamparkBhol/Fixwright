// Freezes a SimHome into a scenario: the home as its adapter reports it, plus its raw logs.
// Used to put the demo house (and any injected fault) into the same benchmark as the incidents.

import type { SimHome } from '../sim/simhome.ts';
import { FAULTS, type FaultId } from '../faults.ts';
import type { Signals } from '../types.ts';
import { SCENARIO_FORMAT, type GroundTruth, type HumanTruth, type Scenario } from './types.ts';

export interface TwinMeta {
  id: string;
  title: string;
  symptom: { text: string; device?: string };
  ground_truth: GroundTruth;
  human_truth: HumanTruth;
  tags?: string[];
}

const CLOUD_VENDORS = ['ecobee', 'hue', 'kasa'];

export async function scenarioFromSimHome(home: SimHome, meta: TwinMeta): Promise<Scenario> {
  const entities = await home.listEntities();
  const signals: Record<string, Signals> = {};
  for (const e of entities) {
    if (e.registryOnly) continue;
    const { flaps24h: _ignored, ...rest } = await home.signals(e.entityId);
    if (Object.keys(rest).length > 0) signals[e.entityId] = rest;
  }
  const faults = home.activeFaults();
  const sources = faults.flatMap((f: FaultId) => FAULTS[f].sources);
  return {
    format: SCENARIO_FORMAT,
    id: meta.id,
    title: meta.title,
    kind: 'twin',
    source: {
      url: 'homefault://simhome',
      date: home.now().slice(0, 10),
      note: `SimHome seed ${home.seed}, faults ${faults.join(', ') || 'none'}${sources[0] ? `, modelled on ${sources[0].url}` : ''}`,
    },
    reconstructed: false,
    assumptions: [],
    tz: home.tz,
    now: home.now(),
    symptom: meta.symptom,
    home: {
      entities,
      integrations: await home.integrations(),
      hub: await home.hubStatus(),
      cloud: await Promise.all(CLOUD_VENDORS.map((v) => home.cloudStatus(v))),
      signals,
    },
    events: home.rows(),
    ground_truth: meta.ground_truth,
    human_truth: meta.human_truth,
    noise: { jitter_ms: 0, drop_rate: 0 },
    ...(meta.tags ? { tags: meta.tags } : {}),
  };
}
