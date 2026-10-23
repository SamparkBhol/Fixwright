// schema/scenario.schema.json is a real JSON Schema (2020-12) that accepts every incident, generated
// and twin scenario, and agrees with the dependency-free validator on valid and broken input.

import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { SimHome, generateScenario, scenarioFromSimHome, validateScenario, type Scenario } from '../src/index.ts';
import { loadIncidents } from '../src/incidents.ts';

const schema = JSON.parse(readFileSync(new URL('../schema/scenario.schema.json', import.meta.url), 'utf8')) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const schemaValid = ajv.compile(schema);

const both = (x: unknown): { schema: boolean; ours: boolean } => ({ schema: schemaValid(x) === true, ours: validateScenario(x).ok });

const twin = await scenarioFromSimHome(SimHome.create({ seed: 8 }), {
  id: 'twin-demo-house',
  title: 'Demo house',
  symptom: { text: 'Why does the hallway lamp keep saying it is not responding?', device: 'Hallway Lamp' },
  ground_truth: { cause_id: 'stale_duplicate', entity_ids: ['light.hallway_lamp', 'light.hallway_lamp_2'] },
  human_truth: { confirm_flash: 'yes' },
});

const samples: Scenario[] = [...loadIncidents(), twin, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10001, 10002].map((seed) => generateScenario(seed))];

describe('scenario JSON Schema', () => {
  it('compiles in strict mode', () => {
    expect(typeof schemaValid).toBe('function');
  });

  it.each(samples.map((s) => [s.id, s] as const))('accepts %s', (_id, s) => {
    const ok = schemaValid(s);
    expect(ok, JSON.stringify(schemaValid.errors?.slice(0, 3))).toBe(true);
    expect(validateScenario(s).ok).toBe(true);
  });

  const base = generateScenario(5);
  const mutations: Array<[string, (s: Record<string, unknown>) => void]> = [
    ['missing ground truth', (s) => delete s.ground_truth],
    ['unknown cause', (s) => ((s.ground_truth as Record<string, unknown>).cause_id = 'gremlins')],
    ['drop rate above 15%', (s) => ((s.noise as Record<string, unknown>).drop_rate = 0.2)],
    ['negative jitter', (s) => ((s.noise as Record<string, unknown>).jitter_ms = -1)],
    ['bad format tag', (s) => (s.format = 'homefault.scenario/2')],
    ['extra top level field', (s) => (s.extra = true)],
    ['reconstructed without assumptions', (s) => ((s.reconstructed = true), (s.assumptions = []))],
    ['non UTC time', (s) => (s.now = '2026-10-15T15:00:00-07:00')],
    ['bad entity id', (s) => (((s.home as { entities: Array<Record<string, unknown>> }).entities[0] as Record<string, unknown>).entityId = 'Hallway Lamp')],
    ['bad transport', (s) => (((s.home as { entities: Array<Record<string, unknown>> }).entities[0] as Record<string, unknown>).transport = 'carrier pigeon')],
    ['unknown row type', (s) => (s.events as unknown[]).push({ type: 'gossip', when: '2026-01-01T00:00:00Z' })],
    ['state row without entity', (s) => (s.events as unknown[]).push({ type: 'state', when: '2026-01-01T00:00:00Z', state: 'on' })],
    ['yes/no answer that is neither', (s) => ((s.human_truth as Record<string, unknown>).confirm_flash = 'maybe')],
    [
      'LQI out of range',
      (s) => {
        const signals = (s.home as { signals: Record<string, Record<string, unknown>> }).signals;
        (signals[Object.keys(signals)[0] as string] as Record<string, unknown>).linkQuality = 300;
      },
    ],
    ['empty symptom', (s) => ((s.symptom as Record<string, unknown>).text = '   ')],
    ['source url not https', (s) => ((s.source as Record<string, unknown>).url = 'http://example.com')],
  ];

  it.each(mutations)('both validators reject: %s', (_name, mutate) => {
    const s = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    mutate(s);
    expect(both(s)).toEqual({ schema: false, ours: false });
  });

  it('both accept the unmutated base', () => {
    expect(both(JSON.parse(JSON.stringify(base)))).toEqual({ schema: true, ours: true });
  });
});
