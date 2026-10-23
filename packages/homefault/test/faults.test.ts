// Every fault (F1 to F10) produces the evidence its ground-truth cause needs and nothing that
// contradicts it, read through the same adapter an agent uses.

import { describe, expect, it } from 'vitest';
import {
  CAUSE_IDS,
  FAULTS,
  FAULT_CODES,
  FAULT_IDS,
  SimHome,
  checkEvidence,
  faultId,
  scenarioFromSimHome,
  validateScenario,
  type FaultId,
  type FaultOptions,
} from '../src/index.ts';

const DAY = 86_400_000;

/** How to set each fault up so its evidence is in the logs, and the entity a person would ask about. */
const SETUP: Readonly<Record<FaultId, { opts?: FaultOptions; runMs?: number; symptomOf: string }>> = {
  ghost_after_repair: { opts: { offlineSince: Date.parse('2026-10-03T18:42:10-07:00') }, symptomOf: 'light.hallway_lamp' },
  power_restore_default_on: { symptomOf: 'light.desk_lamp' },
  duplicate_spoken_name: { symptomOf: 'light.living_room_light' },
  wifi_flapping: { runMs: DAY, symptomOf: 'switch.kitchen_plug' },
  low_battery: { symptomOf: 'binary_sensor.hall_motion' },
  vendor_cloud_outage: { symptomOf: 'climate.thermostat' },
  account_link_expired: { symptomOf: 'light.living_room_light' },
  hub_down: { symptomOf: 'light.desk_lamp' },
  dead_trigger: { runMs: DAY, symptomOf: 'automation.grow_light_schedule' },
  router_ssid_change: { symptomOf: 'switch.kitchen_plug' },
};

async function faultScenario(id: FaultId) {
  const home = SimHome.create({ seed: 31, faults: 'none' });
  const setup = SETUP[id];
  home.inject(id, setup.opts);
  if (setup.runMs) home.advance(setup.runMs);
  const entities = new Set((await home.listEntities()).map((e) => e.entityId));
  const truthIds = FAULTS[id].entity_ids.map((x) => (x === 'light.hallway_lamp' && id !== 'ghost_after_repair' && !entities.has(x) ? 'light.hallway_lamp_2' : x));
  const scenario = await scenarioFromSimHome(home, {
    id: `twin-${id.replace(/_/g, '-')}`,
    title: FAULTS[id].title,
    symptom: { text: `Something is wrong with ${setup.symptomOf}` },
    ground_truth: { cause_id: FAULTS[id].cause_id, entity_ids: truthIds },
    human_truth: FAULTS[id].human,
  });
  return { home, scenario };
}

describe('fault catalog', () => {
  it('has ten faults F1 to F10, each with a cause from the library', () => {
    expect(FAULT_IDS.map((id) => FAULTS[id].code)).toEqual([...FAULT_CODES]);
    for (const id of FAULT_IDS) {
      expect(CAUSE_IDS).toContain(FAULTS[id].cause_id);
      expect(FAULTS[id].description.length).toBeGreaterThan(40);
      expect(faultId(FAULTS[id].code)).toBe(id);
      for (const src of FAULTS[id].sources) {
        expect(src.url).toMatch(/^https:\/\/(www\.reddit\.com\/r\/[a-z]+\/comments\/[a-z0-9]+\/|www\.theverge\.com\/)/);
        expect(src.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      if (FAULTS[id].sources.length === 0) expect(FAULTS[id].source_note).toBeTruthy();
    }
  });

  it('carries the dated public reports each fault was modelled on', () => {
    const urls = (id: FaultId) => FAULTS[id].sources.map((s) => `${s.url} ${s.date}`);
    expect(urls('ghost_after_repair')).toEqual([
      'https://www.reddit.com/r/alexa/comments/1wbmeqx/ 2026-09-09',
      'https://www.theverge.com/tech/1007565/amazon-alexa-plus-review-one-year-echo-show-dot-max 2026-10-08',
    ]);
    expect(urls('power_restore_default_on')).toEqual(['https://www.reddit.com/r/alexa/comments/1wo3p68/ 2026-09-23']);
    expect(FAULTS.dead_trigger.sources[0]?.url).toBe('https://www.reddit.com/r/alexa/comments/1sw9b83/');
    expect(urls('router_ssid_change')[0]).toBe('https://www.reddit.com/r/alexa/comments/1x25meq/ 2026-10-10');
    expect(FAULTS.ghost_after_repair.cause_id).toBe('stale_duplicate');
    expect(FAULTS.power_restore_default_on.cause_id).toBe('power_on_default_on');
    expect(FAULTS.duplicate_spoken_name.cause_id).toBe('name_collision');
    expect(FAULTS.wifi_flapping.cause_id).toBe('radio_link_weak');
    expect(FAULTS.vendor_cloud_outage.cause_id).toBe('vendor_cloud_outage');
    expect(FAULTS.account_link_expired.cause_id).toBe('account_link_expired');
    expect(FAULTS.hub_down.cause_id).toBe('hub_down');
    expect(FAULTS.dead_trigger.cause_id).toBe('dead_trigger');
    expect(FAULTS.router_ssid_change.cause_id).toBe('wifi_network_changed');
  });
});

describe.each(FAULT_IDS)('fault %s', (id) => {
  it('produces the evidence its cause needs, and nothing contradictory', async () => {
    const { scenario } = await faultScenario(id);
    expect(validateScenario(scenario)).toMatchObject({ ok: true });
    const report = checkEvidence(scenario);
    expect(report.missing, report.missing.join('; ')).toEqual([]);
    expect(report.contradictions, report.contradictions.join('; ')).toEqual([]);
    expect(report.supported).toBe(true);
  });

  it('can be cleared, and the house is healthy again', async () => {
    const home = SimHome.create({ seed: 32, faults: 'none' });
    home.inject(id, SETUP[id].opts);
    expect(home.activeFaults()).toEqual([id]);
    home.clear(id);
    home.advance(10 * 60_000);
    expect(home.activeFaults()).toEqual([]);
    const integrations = await home.integrations();
    expect(integrations.every((i) => i.state === 'loaded')).toBe(true);
    const entities = await home.listEntities();
    expect(entities.filter((e) => e.state === 'unavailable' && !e.restored)).toEqual([]);
    expect(entities.filter((e) => e.restored)).toEqual([]);
  });
});

describe('fault specifics', () => {
  it('F2 at runtime: outage, restart, and the clock moved through it', async () => {
    const home = SimHome.create({ seed: 33, faults: 'none' });
    const t0 = home.now();
    const report = home.inject('F2');
    expect(Date.parse(report.at) - Date.parse(t0)).toBe(6000);
    const ev = await home.events({ since: t0 });
    expect(ev.filter((e) => e.kind === 'availability' && e.to === 'on')).toHaveLength(14);
  });

  it('F4 keeps flapping on the following days until cleared', async () => {
    const home = SimHome.create({ seed: 34, faults: 'none' });
    home.inject('wifi_flapping');
    home.advance(2 * DAY);
    const flaps = (await home.signals('switch.kitchen_plug')).flaps24h ?? 0;
    expect(flaps).toBeGreaterThanOrEqual(10);
    expect(flaps).toBeLessThanOrEqual(17);
    home.clear('wifi_flapping');
    home.advance(2 * DAY);
    expect((await home.signals('switch.kitchen_plug')).flaps24h).toBe(0);
  });

  it('F5 drains to zero and the sensor goes offline', async () => {
    const home = SimHome.create({ seed: 35, faults: 'none' });
    home.inject('low_battery', { pct: 1 });
    expect((await home.signals('binary_sensor.hall_motion')).batteryPct).toBe(1);
    home.advance(DAY);
    expect(home.physical('binary_sensor.hall_motion').batteryPct).toBe(0);
    expect((await home.getEntity('binary_sensor.hall_motion'))?.state).not.toBe('unavailable');
    home.advance(2 * DAY);
    expect((await home.getEntity('binary_sensor.hall_motion'))?.state).toBe('unavailable');
    expect(home.physical('binary_sensor.hall_motion').batteryPct).toBe(0);
  });

  it('F9 makes the grow light automation fail at its next run', async () => {
    const home = SimHome.create({ seed: 36, faults: 'none' });
    home.inject('dead_trigger');
    const t0 = home.now();
    home.advance(DAY);
    const runs = (await home.events({ since: t0, entityIds: ['automation.grow_light_schedule'] })).filter((e) => e.kind === 'automation_run');
    expect(runs.length).toBe(2);
    expect(runs.every((r) => String(r.data?.error).includes('switch.grow_light'))).toBe(true);
  });

  it('injecting an active fault again changes nothing (pressing "break" twice is safe)', () => {
    const home = SimHome.create({ seed: 38 });
    const before = JSON.stringify(home.snapshot());
    home.inject('F4');
    home.inject('ghost_after_repair');
    expect(JSON.stringify(home.snapshot())).toBe(before);
  });

  it('F10 leaves the plugs physically where they were: the aquarium filter keeps running', async () => {
    const home = SimHome.create({ seed: 37, faults: 'none' });
    home.inject('router_ssid_change');
    expect((await home.getEntity('switch.aquarium_filter'))?.state).toBe('unavailable');
    expect(home.physical('switch.aquarium_filter')).toMatchObject({ output: 'on', powered: true, linked: false });
    expect(home.person({ kind: 'router_changed' })).toBe('yes');
  });
});
