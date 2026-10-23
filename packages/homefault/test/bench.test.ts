// runBench: a trivial always-cant_tell agent and an oracle agent give exactly the expected metrics;
// the simulated person is as reliable as configured; agents can run on scenarios through the adapter.

import { describe, expect, it } from 'vitest';
import {
  CAUSE_IDS,
  generateScenario,
  metricsOf,
  percentile,
  runBench,
  scenarioHome,
  simulatedHuman,
  seededRng,
  type BenchAgent,
  type HumanAnswer,
  type Scenario,
} from '../src/index.ts';
import { loadIncidents } from '../src/incidents.ts';

const scenarios: Scenario[] = [...loadIncidents(), ...Array.from({ length: 50 }, (_, i) => generateScenario(i + 1))];
const truthById = new Map(scenarios.map((s) => [s.id, s.ground_truth.cause_id]));
const counter = (): (() => number) => {
  let t = 0;
  return () => (t += 5);
};

const cantTell: BenchAgent = { name: 'always-cant-tell', diagnose: () => ({ cause_id: 'unknown', level: 'cant_tell' }) };
const oracle: BenchAgent = {
  name: 'oracle',
  diagnose: (view) => ({ cause_id: truthById.get(view.id) ?? 'unknown', level: 'confirmed', confidence: 1, probes_used: 3 }),
};

describe('runBench', () => {
  it('an agent that always says cant_tell: abstains on everything, never wrong, never right', async () => {
    const r = await runBench(cantTell, scenarios, { timer: counter() });
    expect(r.agent).toBe('always-cant-tell');
    expect(r.metrics).toEqual({
      n: 70,
      top1: 0,
      top1_answered: null,
      confirmed: 0,
      false_confirmed: 0,
      confirmed_precision: null,
      abstention_rate: 1,
      errors: 0,
      probes_used: { total: 0, mean: 0 },
      disruptive_probes: { total: 0, mean: 0 },
      human_questions: { total: 0, mean: 0 },
      latency_ms: { mean: 5, p50: 5, p95: 5, max: 5 },
    });
    expect(Object.keys(r.per_cause).sort()).toEqual([...CAUSE_IDS].sort());
    expect(Object.values(r.per_cause).every((c) => c.top1 === 0 && c.abstained === c.n)).toBe(true);
  });

  it('an oracle: right every time, confirmed every time, no false confirmations', async () => {
    const r = await runBench(oracle, scenarios, { timer: counter() });
    expect(r.metrics).toMatchObject({
      n: 70,
      top1: 1,
      top1_answered: 1,
      confirmed: 70,
      false_confirmed: 0,
      confirmed_precision: 1,
      abstention_rate: 0,
      errors: 0,
      probes_used: { total: 210, mean: 3 },
      human_questions: { total: 0, mean: 0 },
    });
    expect(r.cases.every((c) => c.correct && !c.false_confirmed)).toBe(true);
  });

  it('confidently wrong: every wrong confirmation is counted', async () => {
    const wrong: BenchAgent = { name: 'always-hub', diagnose: () => ({ cause_id: 'hub_down', level: 'confirmed', confidence: 0.99 }) };
    const r = await runBench(wrong, scenarios);
    const hub = scenarios.filter((s) => s.ground_truth.cause_id === 'hub_down').length;
    expect(r.metrics.top1).toBeCloseTo(hub / 70, 4);
    expect(r.metrics.false_confirmed).toBe(70 - hub);
    expect(r.metrics.confirmed_precision).toBeCloseTo(hub / 70, 4);
    expect(r.per_cause.hub_down).toMatchObject({ top1: 1, false_confirmed: 0 });
  });

  it('a likely answer earns top-1 credit but is never a false confirmation', async () => {
    const hedger: BenchAgent = { name: 'hedger', diagnose: () => ({ cause_id: 'stale_duplicate', level: 'likely' }) };
    const r = await runBench(hedger, scenarios);
    expect(r.metrics.false_confirmed).toBe(0);
    expect(r.metrics.confirmed).toBe(0);
    expect(r.metrics.top1).toBeGreaterThan(0);
  });

  it('an agent that throws is an abstention with the error recorded', async () => {
    const broken: BenchAgent = {
      name: 'broken',
      diagnose: (view) => {
        if (view.id.startsWith('inc-')) throw new Error('model timed out');
        return { cause_id: 'unknown', level: 'cant_tell' };
      },
    };
    const r = await runBench(broken, scenarios);
    expect(r.metrics.errors).toBe(20);
    expect(r.metrics.abstention_rate).toBe(1);
    expect(r.cases.find((c) => c.error)?.error).toBe('model timed out');
  });

  it('agents never see the ground truth, the human truth or the source', async () => {
    const seen: string[] = [];
    const spy: BenchAgent = {
      name: 'spy',
      diagnose: (view) => {
        seen.push(...Object.keys(view));
        return { cause_id: 'unknown', level: 'cant_tell' };
      },
    };
    await runBench(spy, scenarios.slice(0, 3));
    expect(new Set(seen)).toEqual(new Set(['id', 'tz', 'now', 'symptom', 'home', 'events']));
  });

  it('counts human questions and the flashes they imply, and logs the answers', async () => {
    const asker: BenchAgent = {
      name: 'asker',
      diagnose: async (_view, ask) => {
        const blink = await ask({ kind: 'confirm_flash', text: "I'll flash it twice. Did it blink?" });
        const router = await ask({ kind: 'router_changed' });
        if (router === 'yes') return { cause_id: 'wifi_network_changed', level: 'likely' };
        return { cause_id: blink === 'yes' ? 'stale_duplicate' : 'device_power_lost', level: 'likely', probes_used: 2 };
      },
    };
    const r = await runBench(asker, scenarios, { humanReliability: 1 });
    expect(r.metrics.human_questions).toEqual({ total: 140, mean: 2 });
    expect(r.metrics.disruptive_probes).toEqual({ total: 70, mean: 1 });
    for (const c of r.cases) {
      const s = scenarios.find((x) => x.id === c.scenario_id) as Scenario;
      expect(c.human[0]?.answer).toBe(s.human_truth.confirm_flash ?? 'not sure');
      expect(c.human.every((h) => h.truthful)).toBe(true);
    }
    expect(r.per_cause.wifi_network_changed?.top1).toBe(1);
  });

  it('rejects a reliability outside 0.5 to 1', async () => {
    await expect(runBench(cantTell, scenarios, { humanReliability: 0.3 })).rejects.toThrowError(/humanReliability/);
  });

  it('is deterministic for a seed', async () => {
    const asker: BenchAgent = { name: 'a', diagnose: async (_v, ask) => ({ cause_id: (await ask({ kind: 'power_switch_check' })) === 'no' ? 'device_power_lost' : 'radio_link_weak', level: 'likely' }) };
    const a = await runBench(asker, scenarios, { humanReliability: 0.7, seed: 4, timer: counter() });
    const b = await runBench(asker, scenarios, { humanReliability: 0.7, seed: 4, timer: counter() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('simulated human', () => {
  it('answers truthfully with the configured probability', async () => {
    const s = scenarios.find((x) => x.human_truth.confirm_flash === 'yes') as Scenario;
    for (const reliability of [1, 0.9, 0.7, 0.5]) {
      const human = simulatedHuman(s, reliability, seededRng(123));
      const answers: HumanAnswer[] = [];
      for (let i = 0; i < 4000; i++) answers.push(await human.ask({ kind: 'confirm_flash' }));
      const yes = answers.filter((a) => a === 'yes').length / answers.length;
      expect(Math.abs(yes - reliability)).toBeLessThan(0.03);
      expect(human.log.filter((h) => !h.truthful).length).toBe(answers.filter((a) => a === 'no').length);
    }
  });

  it("says 'not sure' when the scenario does not know what the person would see", async () => {
    const s = scenarios.find((x) => x.human_truth.router_changed === undefined) as Scenario;
    const human = simulatedHuman(s, 0.9, seededRng(1));
    expect(await human.ask({ kind: 'router_changed' })).toBe('not sure');
  });
});

describe('metrics helpers', () => {
  it('nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  it('empty runs are all zeros', () => {
    expect(metricsOf([])).toMatchObject({ n: 0, top1: 0, top1_answered: null, abstention_rate: 0 });
  });
});

describe('running an agent on a scenario through the HomeAdapter', () => {
  it('a small rule-based agent can query the scenario home and act on it', async () => {
    const rules: BenchAgent = {
      name: 'rules',
      diagnose: async (view) => {
        const home = scenarioHome(view);
        const integrations = await home.integrations();
        if (integrations.some((i) => i.state === 'setup_error' && /auth|link/i.test(i.reason ?? ''))) return { cause_id: 'account_link_expired', level: 'likely', probes_used: 1 };
        if (integrations.some((i) => i.state === 'setup_retry')) return { cause_id: 'hub_down', level: 'likely', probes_used: 2 };
        const entities = await home.listEntities();
        if (entities.some((e) => e.restored)) return { cause_id: 'stale_duplicate', level: 'likely', probes_used: 3 };
        return { cause_id: 'unknown', level: 'cant_tell', probes_used: 3 };
      },
    };
    const r = await runBench(rules, scenarios);
    expect(r.per_cause.account_link_expired?.top1).toBeGreaterThan(0.8);
    expect(r.per_cause.hub_down?.top1).toBeGreaterThan(0.6);
    expect(r.metrics.false_confirmed).toBe(0);
  });

  it('the scenario home rejects commands to unavailable entities and applies the rest', async () => {
    const s = loadIncidents().find((x) => x.id.startsWith('inc-01')) as Scenario;
    const home = scenarioHome({ id: s.id, tz: s.tz, now: s.now, symptom: s.symptom, home: s.home, events: s.events });
    await expect(home.callService('light', 'turn_on', { entity_id: 'light.living_room_lights' })).rejects.toMatchObject({ code: 'entity_unavailable' });
    const { changed } = await home.callService('light', 'turn_on', { entity_id: 'light.living_room_lights_2' });
    expect(changed.map((e) => e.state)).toEqual(['on']);
    expect(home.writes().map((w) => w.type)).toEqual(['call_service', 'call_service', 'state']);
    await home.registryRemove('light.living_room_lights');
    expect(await home.getEntity('light.living_room_lights')).toBeNull();
    expect((await home.signals('light.living_room_lights_2')).flaps24h).toBe(0);
    expect((await home.cloudStatus('nobody')).status).toBe('unknown');
  });
});
