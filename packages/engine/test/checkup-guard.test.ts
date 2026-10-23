// The checkup ranks its findings, most severe first, with the golden path
// titles; the protected load guard refuses the strip feeding the aquarium filter and offers the lamp.

import { describe, expect, it } from 'vitest';
import { ToolOutputs, type HomeCheckupOutput } from '@fixwright/protocol';
import { canFlash, houseView, inferTopology, protectedGuard, runCheckup, startDiagnosis } from '../src/index.ts';
import { addEntity } from './support/fake-adapter.ts';
import { buildGoldenHouse, FILTER, rig } from './support/golden-house.ts';

function valid(output: HomeCheckupOutput): void {
  const r = ToolOutputs.home_checkup.safeParse(output);
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues, null, 2)).toBe(true);
}

describe('home checkup', () => {
  it('finds five things in the untouched demo house, most severe first', async () => {
    const r = rig();
    const { output, session } = await runCheckup({}, r.deps);
    valid(output);
    expect(output.findings.map((f) => [f.severity, f.kind, f.title])).toEqual([
      ['high', 'duplicate_name', 'Two lights answer to Living Room Light'],
      ['high', 'ghost_entity', 'Old copy of Hallway Lamp still listed'],
      ['high', 'low_battery', 'Hall motion sensor battery at 6%'],
      ['medium', 'flapping', 'Kitchen plug dropped off Wi-Fi 9 times today'],
      ['medium', 'power_on_default', 'Fourteen devices turn on after a power cut'],
    ]);
    expect(output.speech).toBe(
      'I found five things. Two lights answer to Living Room Light. An old copy of Hallway Lamp is still in your device list. And the hall motion sensor battery is at 6%. There are two more on the screen.',
    );
    const dup = output.findings[0];
    expect(dup?.detail).toBe('A Hue group and a Zigbee light are both called Living Room Light, so a command can reach the wrong one.');
    expect(dup?.entity_ids).toEqual(['light.living_room_light', 'light.living_room_light_2']);
    expect(output.findings[3]?.detail).toBe('Its Wi-Fi signal is weak, at -82 dBm. Moving the plug or the router closer usually helps.');
    expect(session.findings.every((f) => f.evidence.length > 0)).toBe(true);
    const flapping = session.findings[3];
    const bySeq = new Map(r.ledger.all().map((e) => [e.seq, e]));
    expect(flapping?.evidence.filter((s) => bySeq.get(s)?.to === 'unavailable')).toHaveLength(9);
  });

  it('names no brand for a device whose maker is described instead of named', async () => {
    const house = buildGoldenHouse();
    for (const e of house.entities.values()) if (e.vendor === 'Philips Hue') e.vendor = 'light maker';
    const { output } = await runCheckup({}, rig(house).deps);
    valid(output);
    expect(output.findings[0]?.detail).toBe('A light group and a Zigbee light are both called Living Room Light, so a command can reach the wrong one.');
  });

  it('flags an essential load on a strip until it is protected', async () => {
    const r = rig(buildGoldenHouse(), { protected: [] });
    const { output } = await runCheckup({ focus: 'power strip' }, r.deps);
    valid(output);
    const load = output.findings.find((f) => f.kind === 'unprotected_load');
    expect(load).toMatchObject({ severity: 'high', title: 'Aquarium filter is not protected', action_label: 'Protect it', fixable: false });
    expect(load?.detail).toBe("It runs on outlet 2 of the Living Room Power Strip. Protect it and I'll never switch it off.");
  });

  it('narrows to a focus', async () => {
    const r = rig();
    const { output } = await runCheckup({ focus: 'batteries' }, r.deps);
    valid(output);
    expect(output.findings.map((f) => f.kind)).toEqual(['low_battery']);
    expect(output.speech).toBe('I found one thing. The hall motion sensor battery is at 6%.');
  });

  it('reports a failed sign in', async () => {
    const house = buildGoldenHouse();
    const hue = house.integrations.find((i) => i.integration === 'hue');
    if (hue) Object.assign(hue, { state: 'setup_error', reason: 'Authentication token expired' });
    const r = rig(house);
    const { output } = await runCheckup({}, r.deps);
    valid(output);
    expect(output.findings[0]).toMatchObject({ kind: 'integration_error', title: 'Hue needs you to sign in again', fixable: false });
  });

  it('says the home looks healthy when nothing is wrong', async () => {
    const house = buildGoldenHouse();
    for (const id of [...house.entities.keys()]) if (id !== 'light.porch_light') house.entities.delete(id);
    house.signals.clear();
    const r = rig(house);
    const { output } = await runCheckup({}, r.deps);
    valid(output);
    expect(output.findings).toEqual([]);
    expect(output.speech).toBe("Your home looks healthy. I didn't find anything that needs fixing.");
  });
});

describe('protected loads', () => {
  const house = buildGoldenHouse();
  const entities = [...house.entities.values()];
  const topology = inferTopology(entities);
  const get = (id: string) => {
    const e = house.entities.get(id);
    if (!e) throw new Error(id);
    return e;
  };

  it('infers the strip and what each outlet feeds', () => {
    expect(topology.strips).toEqual([
      {
        entity_id: 'switch.living_room_power_strip',
        name: 'Living Room Power Strip',
        outlets: [
          { entity_id: 'switch.living_room_power_strip_outlet_1', name: 'Reading Lamp', outlet: 1, load: 'Reading Lamp' },
          { entity_id: 'switch.living_room_power_strip_outlet_2', name: 'Aquarium Filter', outlet: 2, load: 'Aquarium Filter' },
        ],
      },
    ]);
  });

  it('refuses the strip and offers the reading lamp on it', () => {
    const d = protectedGuard('turn_off', get('switch.living_room_power_strip'), [FILTER], topology);
    expect(d).toEqual({
      allow: false,
      code: 'protected_load',
      blocked: [FILTER],
      alternative: { entity_id: 'switch.living_room_power_strip_outlet_1', name: 'Reading Lamp', label: 'Turn off the Reading Lamp on the same strip' },
      alternatives: [{ entity_id: 'switch.living_room_power_strip_outlet_1', name: 'Reading Lamp', label: 'Turn off the Reading Lamp on the same strip' }],
      speech: "That strip runs the aquarium filter, which you marked protected. I'll turn off the lamp on it instead.",
    });
  });

  it('refuses the protected outlet itself, also when toggling or flashing', () => {
    for (const action of ['turn_off', 'toggle', 'flash', 'power_cycle'] as const) {
      const d = protectedGuard(action, get('switch.living_room_power_strip_outlet_2'), [FILTER], topology);
      expect(d.allow).toBe(false);
      if (!d.allow) expect(d.speech).toBe("The aquarium filter is protected, so I'll leave it running.");
    }
  });

  it('allows turning things on, the unprotected outlet, and the strip when nothing on it is protected', () => {
    expect(protectedGuard('turn_on', get('switch.living_room_power_strip'), [FILTER], topology).allow).toBe(true);
    expect(protectedGuard('turn_off', get('switch.living_room_power_strip_outlet_1'), [FILTER], topology).allow).toBe(true);
    expect(protectedGuard('turn_off', get('switch.living_room_power_strip'), [], topology).allow).toBe(true);
    expect(protectedGuard('turn_off', get('switch.living_room_power_strip'), new Set([FILTER.entity_id]), topology).allow).toBe(false);
  });

  it('offers one outlet, a light that is on, when the strip has several', () => {
    const h = buildGoldenHouse();
    addEntity(h, { entityId: 'switch.living_room_power_strip_outlet_3', name: 'Phone Charger', deviceId: 'dev_strip', integration: 'kasa', transport: 'wifi', state: 'on', attributes: { outlet: 3 } });
    const all = [...h.entities.values()];
    const topo = inferTopology(all);
    const strip = h.entities.get('switch.living_room_power_strip');
    if (!strip) throw new Error('strip');
    const d = protectedGuard('turn_off', strip, [FILTER], topo, { states: all });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.alternative?.name).toBe('Reading Lamp');
      expect(d.alternatives.map((a) => a.name)).toEqual(['Reading Lamp', 'Phone Charger']);
      expect(d.speech).toBe("That strip runs the aquarium filter, which you marked protected. I'll turn off the lamp on it instead.");
    }
    const lampOff = all.map((e) => (e.entityId === 'switch.living_room_power_strip_outlet_1' ? { ...e, state: 'off' } : e));
    const d2 = protectedGuard('turn_off', strip, [FILTER], topo, { states: lampOff });
    if (!d2.allow) {
      expect(d2.alternative?.name).toBe('Phone Charger');
      expect(d2.speech).toBe("That strip runs the aquarium filter, which you marked protected. I'll turn off the phone charger on it instead.");
    }
  });

  it('knows a garage light from a garage door', () => {
    const h = buildGoldenHouse();
    const light = addEntity(h, { entityId: 'light.garage_light', name: 'Garage Light', integration: 'zigbee2mqtt', transport: 'zigbee', state: 'on' });
    const opener = addEntity(h, { entityId: 'switch.garage_door_opener', name: 'Garage Door Opener', integration: 'kasa', transport: 'wifi', state: 'off' });
    expect(protectedGuard('turn_off', light, [], topology).allow).toBe(true);
    expect(protectedGuard('turn_off', opener, [], topology)).toMatchObject({ allow: false, code: 'unsafe_device' });
  });

  it('never touches locks, garage doors or cameras', () => {
    const lock = addEntity(buildGoldenHouse(), { entityId: 'lock.back_door', name: 'Back Door', integration: 'matter', transport: 'thread', state: 'locked' });
    const garage = addEntity(buildGoldenHouse(), { entityId: 'cover.garage', name: 'Garage', integration: 'matter', transport: 'thread', state: 'closed', attributes: { device_class: 'garage' } });
    for (const e of [lock, garage]) {
      const d = protectedGuard('turn_on', e, [], topology);
      expect(d).toMatchObject({ allow: false, code: 'unsafe_device', speech: "I don't change locks, garage doors, alarms or cameras." });
    }
  });

  it('keeps the flash test off protected loads', async () => {
    const r = rig();
    expect(canFlash(get('switch.living_room_power_strip_outlet_2'), r.deps, houseView(entities))).toBe(false);
    expect(canFlash(get('switch.living_room_power_strip_outlet_1'), r.deps, houseView(entities))).toBe(true);
    await startDiagnosis({ symptom: "the aquarium filter isn't responding" }, r.deps);
    expect(r.house.calls).toEqual([]);
  });
});
