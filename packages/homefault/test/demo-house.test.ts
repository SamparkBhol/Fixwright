// The default demo house must carry exactly the numbers the README promises.
// Every number here is read back from the simulation, for several seeds.

import { describe, expect, it } from 'vitest';
import {
  AREAS,
  DEFAULT_ON_ENTITIES,
  SimHome,
  localClock,
  localDayKey,
  restartClusters,
  type HouseEvent,
} from '../src/index.ts';

const SEEDS = [1, 2, 3, 7, 42, 1234];
const TZ = 'America/Los_Angeles';
const local = (ts: string): string => localClock(Date.parse(ts), TZ);
const OUTAGE_HOUR = { since: '2026-10-15T10:00:00.000Z', until: '2026-10-15T10:59:59.999Z' };
const POWER_BACK = Date.parse('2026-10-15T10:12:00.000Z');

/**
 * How a diagnosis engine measures a restart: each device's first sign of coming back (back from
 * unavailable, or a boot reason of power on), then first device to last device.
 */
function restartSpan(events: readonly HouseEvent[], deviceOf: ReadonlyMap<string, string>): { devices: number; spanMs: number } {
  const firstBack = new Map<string, number>();
  for (const e of events) {
    const back = (e.kind === 'availability' && e.from === 'unavailable' && e.to !== 'unavailable') || (e.kind === 'power' && e.data?.reason === 'PowerOnReboot');
    if (!back || !e.entityId) continue;
    const device = deviceOf.get(e.entityId) ?? e.entityId;
    const t = Date.parse(e.ts);
    firstBack.set(device, Math.min(t, firstBack.get(device) ?? t));
  }
  const times = [...firstBack.values()];
  return { devices: times.length, spanMs: Math.max(...times) - Math.min(...times) };
}

async function spanOf(home: SimHome): Promise<{ devices: number; spanMs: number }> {
  const deviceOf = new Map((await home.listEntities()).flatMap((e) => (e.deviceId ? [[e.entityId, e.deviceId] as const] : [])));
  return restartSpan(await home.events(OUTAGE_HOUR), deviceOf);
}

/** The engine's flash test and repair read-back: switch to the other state and back, reading back each time. */
async function flashAndReadBack(home: SimHome, entityId: string, times: number): Promise<void> {
  const initial = (await home.getEntity(entityId))?.state ?? 'off';
  const other = initial === 'on' ? 'off' : 'on';
  for (let i = 0; i < times; i++) {
    for (const want of [other, initial]) {
      await home.callService('light', want === 'on' ? 'turn_on' : 'turn_off', { entity_id: entityId });
      expect((await home.getEntity(entityId))?.state).toBe(want);
    }
  }
}

describe.each(SEEDS)('demo house, seed %i', (seed) => {
  it('starts at 2026-10-15 15:00 household time with the five demo faults', () => {
    const home = SimHome.create({ seed });
    expect(home.now()).toBe('2026-10-15T22:00:00.000Z');
    expect(home.tz).toBe(TZ);
    expect(home.activeFaults()).toEqual(['ghost_after_repair', 'power_restore_default_on', 'duplicate_spoken_name', 'wifi_flapping', 'low_battery']);
  });

  it('has about 30 devices in six areas across the six integrations', async () => {
    const home = SimHome.create({ seed });
    const entities = await home.listEntities();
    const devices = new Set(entities.map((e) => e.deviceId).filter(Boolean));
    expect(devices.size).toBeGreaterThanOrEqual(22);
    expect(devices.size).toBeLessThanOrEqual(32);
    expect(new Set(entities.map((e) => e.area).filter(Boolean))).toEqual(new Set(Object.keys(AREAS)));
    expect(new Set(entities.map((e) => e.integration))).toEqual(new Set(['zigbee2mqtt', 'hue', 'kasa', 'matter', 'ecobee', 'template', 'automation']));
  });

  it('F1: Hallway Lamp reaches an old copy offline since 3 October while the re-paired lamp is online', async () => {
    const home = SimHome.create({ seed });
    const lamps = (await home.listEntities()).filter((e) => e.name === 'Hallway Lamp');
    expect(lamps.map((e) => e.entityId).sort()).toEqual(['light.hallway_lamp', 'light.hallway_lamp_2']);
    const ghost = lamps.find((e) => e.entityId === 'light.hallway_lamp');
    expect(ghost?.restored).toBe(true);
    expect(ghost?.state).toBe('unavailable');
    expect(localDayKey(Date.parse(ghost?.lastChanged ?? ''), TZ)).toBe('2026-10-03');
    expect(lamps.find((e) => e.entityId === 'light.hallway_lamp_2')?.state).not.toBe('unavailable');
    expect(home.resolveName('hallway lamp')?.entityId).toBe('light.hallway_lamp');
  });

  it('F1: the hallway lamp is a bridge maker bulb on Zigbee2MQTT, so its maker cloud has a status (and it is fine)', async () => {
    const home = SimHome.create({ seed });
    const lamp = await home.getEntity('light.hallway_lamp_2');
    expect(lamp).toMatchObject({ integration: 'zigbee2mqtt', vendor: 'light maker' });
    expect((await home.cloudStatus(lamp?.vendor ?? '')).status).toBe('ok');
    expect((await home.signals('light.hallway_lamp_2')).linkQuality).toBe(168);
  });

  it('F2: power out at 03:11:58, back at 03:12:00, 14 devices back on within 4 s, no automation, user or service', async () => {
    const home = SimHome.create({ seed });
    const hour = await home.events({ since: '2026-10-15T10:00:00.000Z', until: '2026-10-15T10:59:59.999Z' });
    const down = hour.filter((e) => e.kind === 'availability' && e.to === 'unavailable');
    const back = hour.filter((e) => e.kind === 'availability' && e.from === 'unavailable');
    expect(down).toHaveLength(14);
    expect(new Set(down.map((e) => local(e.ts)))).toEqual(new Set(['03:11:58']));
    expect(back).toHaveLength(14);
    expect(back.every((e) => e.to === 'on')).toBe(true);
    const first = Math.min(...back.map((e) => Date.parse(e.ts)));
    const last = Math.max(...back.map((e) => Date.parse(e.ts)));
    expect(local(new Date(first).toISOString())).toBe('03:12:00');
    expect(last - POWER_BACK).toBeLessThan(4000);
    expect(back.every((e) => e.context === undefined)).toBe(true);
    expect(hour.filter((e) => e.kind === 'automation_run' || e.kind === 'service_call')).toEqual([]);
    expect(new Set(back.map((e) => e.entityId?.split('.')[0]))).toEqual(new Set(['light', 'switch']));
    const entities = await home.listEntities();
    const integrations = new Set(back.map((e) => entities.find((x) => x.entityId === e.entityId)?.integration));
    expect(integrations).toEqual(new Set(['zigbee2mqtt', 'matter']));
    const clusters = restartClusters(hour);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(14);
    expect(hour.filter((e: HouseEvent) => e.kind === 'power' && e.data?.reason === 'PowerOnReboot')).toHaveLength(8);
  });

  it('F2: fourteen devices restart over more than three and at most four seconds, so it is "within four seconds"', async () => {
    const home = SimHome.create({ seed });
    const { devices, spanMs } = await spanOf(home);
    expect(devices).toBe(14);
    expect(spanMs).toBeGreaterThan(3000);
    expect(spanMs).toBeLessThanOrEqual(4000);
    expect(Math.ceil(spanMs / 1000)).toBe(4);
  });

  it('F2: the fourteen are the lights and plugs whose power-on behavior is on', async () => {
    const home = SimHome.create({ seed });
    const back = (await home.events({ since: '2026-10-15T10:00:00.000Z', until: '2026-10-15T10:59:59.999Z' })).filter((e) => e.kind === 'availability' && e.to === 'on');
    const expected = DEFAULT_ON_ENTITIES.map((id) => (id === 'light.hallway_lamp' ? 'light.hallway_lamp_2' : id)).sort();
    expect(back.map((e) => e.entityId).sort()).toEqual(expected);
    for (const id of expected) expect((await home.signals(id)).powerOnBehavior).toBe('on');
  });

  it('F3: two different online lights answer to Living Room Light', async () => {
    const home = SimHome.create({ seed });
    const named = (await home.listEntities()).filter((e) => e.name === 'Living Room Light');
    expect(named.map((e) => e.entityId).sort()).toEqual(['light.floor_lamp', 'light.living_room_light']);
    expect(new Set(named.map((e) => e.integration))).toEqual(new Set(['hue', 'zigbee2mqtt']));
    expect(named.every((e) => e.state !== 'unavailable' && !e.restored)).toBe(true);
  });

  it('F4: the kitchen plug dropped off Wi-Fi 9 times today, RSSI -82', async () => {
    const home = SimHome.create({ seed });
    const sig = await home.signals('switch.kitchen_plug');
    expect(sig.flaps24h).toBe(9);
    expect(sig.rssi).toBe(-82);
    const today = await home.events({ since: '2026-10-15T07:00:00.000Z', entityIds: ['switch.kitchen_plug'] });
    expect(today.filter((e) => e.kind === 'availability' && e.to === 'unavailable')).toHaveLength(9);
  });

  it('F5: the hall motion sensor battery is at 6%', async () => {
    const home = SimHome.create({ seed });
    expect((await home.signals('binary_sensor.hall_motion')).batteryPct).toBe(6);
    expect((await home.getEntity('binary_sensor.hall_motion'))?.attributes.battery).toBe(6);
  });

  it('two power strips feed three child outlets each', async () => {
    const home = SimHome.create({ seed });
    const outlets = (await home.listEntities()).filter((e) => typeof e.attributes.power_strip === 'string');
    const byStrip = new Map<string, number[]>();
    for (const o of outlets) byStrip.set(String(o.attributes.power_strip), [...(byStrip.get(String(o.attributes.power_strip)) ?? []), Number(o.attributes.outlet)].sort());
    expect(Object.fromEntries(byStrip)).toEqual({ 'switch.living_room_power_strip': [1, 2, 3], 'switch.office_power_strip': [1, 2, 3] });
  });

  it('the aquarium filter runs on outlet 2 of the living room strip, a reading lamp on outlet 1', async () => {
    const home = SimHome.create({ seed });
    const filter = await home.getEntity('switch.aquarium_filter');
    const lamp = await home.getEntity('switch.reading_lamp');
    expect(filter?.attributes).toMatchObject({ outlet: 2, power_strip: 'switch.living_room_power_strip' });
    expect(lamp?.attributes).toMatchObject({ outlet: 1, power_strip: 'switch.living_room_power_strip' });
    expect(filter?.state).toBe('on');
    expect(home.physical('switch.aquarium_filter').output).toBe('on');
  });

  it('golden path: flash the online copy, the person sees it blink, the old copy rejects', async () => {
    const home = SimHome.create({ seed });
    const asked = home.now();
    await home.callService('light', 'turn_on', { entity_id: 'light.hallway_lamp_2' });
    await home.callService('light', 'turn_off', { entity_id: 'light.hallway_lamp_2' });
    await expect(home.callService('light', 'turn_on', { entity_id: 'light.hallway_lamp' })).rejects.toMatchObject({ code: 'entity_unavailable' });
    expect(home.person({ kind: 'confirm_flash', name: 'Hallway Lamp', since: asked })).toBe('yes');
    expect(home.person({ kind: 'confirm_flash', entityId: 'light.hallway_lamp', since: asked })).toBe('yes');
    expect(home.physical('light.hallway_lamp').exists).toBe(false);
  });

  it('golden path: the flash, the repair and its read-back at 15:00, then all 9 overnight commands answered', async () => {
    const home = SimHome.create({ seed });
    const lamp = 'light.hallway_lamp_2';
    const start = home.now();
    // The repair a diagnosis engine runs: flash the online copy, rename, retire the old copy, read back on and off.
    await flashAndReadBack(home, lamp, 2);
    expect(home.person({ kind: 'confirm_flash', name: 'Hallway Lamp', since: start })).toBe('yes');
    await home.registryUpdate(lamp, { name: 'Hallway Lamp' });
    await home.registryRemove('light.hallway_lamp');
    await flashAndReadBack(home, lamp, 1);
    const repairedAt = home.now();
    expect(home.resolveName('Hallway Lamp')?.entityId).toBe(lamp);
    // Every write took its own round trip: the eight commands of the flash and read-back all sit before repairedAt.
    const ours = home.rows({ since: start }).filter((r) => r.type === 'call_service' && r.context?.user_id === 'user_api');
    expect(ours).toHaveLength(6);
    expect(new Set(ours.map((r) => r.when)).size).toBe(6);
    expect(ours.every((r) => Date.parse(r.when) < Date.parse(repairedAt))).toBe(true);

    // Next morning at 07:00, counted the way a morning check counts (since is inclusive).
    home.advanceTo('2026-10-16T07:00:00');
    expect(home.now()).toBe('2026-10-16T14:00:00.000Z');
    const night = await home.events({ since: repairedAt, entityIds: [lamp] });
    const calls = night.filter((e) => e.kind === 'service_call');
    expect(calls).toHaveLength(9);
    for (const c of calls) {
      const want = String(c.data?.service).endsWith('turn_on') ? 'on' : 'off';
      const reply = night.find((e) => e.kind === 'state' && e.to === want && Date.parse(e.ts) - Date.parse(c.ts) >= 0 && Date.parse(e.ts) - Date.parse(c.ts) <= 10_000);
      expect(reply, `${c.ts} ${String(c.data?.service)}`).toBeDefined();
    }
    expect(night.filter((e) => e.to === 'unavailable')).toEqual([]);
  });

  it('after the repair and the jump to 07:00, the checkup numbers and the lamp on the strip still hold', async () => {
    const home = SimHome.create({ seed });
    expect((await home.getEntity('switch.reading_lamp'))?.state).toBe('on');
    expect(home.physical('switch.reading_lamp').output).toBe('on');
    for (const at of ['2026-10-15T20:00:00', '2026-10-15T23:59:00', '2026-10-16T03:30:00', '2026-10-16T07:00:00', '2026-10-16T08:55:00']) {
      home.advanceTo(at);
      expect((await home.signals('switch.kitchen_plug')).flaps24h, at).toBe(9);
    }
    const fresh = SimHome.create({ seed });
    fresh.advanceTo('2026-10-16T07:00:00');
    expect((await fresh.signals('switch.kitchen_plug')).flaps24h).toBe(9);
    expect((await fresh.signals('switch.kitchen_plug')).rssi).toBe(-82);
    expect((await fresh.signals('binary_sensor.hall_motion')).batteryPct).toBe(6);
    expect((await fresh.getEntity('switch.reading_lamp'))?.state).toBe('on');
    expect(fresh.physical('switch.reading_lamp').output).toBe('on');
    expect((await fresh.listEntities()).filter((e) => e.name === 'Living Room Light')).toHaveLength(2);
    // The outage belongs to the night before the demo. At 07:00 on 16 October the latest 3 a.m. hour is
    // quiet, so "at 3 a.m." must be asked before the jump or with that night's window (see README).
    const lastNight = await fresh.events({ since: '2026-10-16T10:00:00.000Z', until: '2026-10-16T10:59:59.999Z' });
    expect(lastNight.filter((e) => e.kind === 'availability')).toEqual([]);
    expect((await fresh.events(OUTAGE_HOUR)).filter((e) => e.kind === 'availability')).toHaveLength(28);
  });

  it('golden path: power-on behavior set to previous, the next outage turns nothing on', async () => {
    const home = SimHome.create({ seed });
    for (const e of await home.listEntities()) {
      if (e.domain === 'select' && e.state === 'on') await home.selectOption(e.entityId, 'previous');
    }
    const before = home.now();
    home.powerCut();
    const after = await home.events({ since: before });
    expect(after.filter((e) => e.kind === 'availability' && e.from === 'unavailable')).toHaveLength(14);
    expect(after.filter((e) => e.kind === 'availability' && e.to === 'on')).toHaveLength(0);
  });

  it('golden path: switching off the strip would cut the aquarium filter; the lamp outlet alone does not', async () => {
    const home = SimHome.create({ seed });
    await home.callService('switch', 'turn_off', { entity_id: 'switch.reading_lamp' });
    expect(home.physical('switch.aquarium_filter').output).toBe('on');
    await home.callService('switch', 'turn_off', { entity_id: 'switch.living_room_power_strip' });
    expect(home.physical('switch.aquarium_filter').output).toBe('off');
  });
});

describe('demo house restart span across many seeds', () => {
  it('seeds 1 to 60: fourteen devices, span over 3 s and at most 4 s, all back within 4 s of power', async () => {
    const spans: number[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const home = SimHome.create({ seed });
      const { devices, spanMs } = await spanOf(home);
      expect(devices, `seed ${seed}`).toBe(14);
      spans.push(spanMs);
      const back = (await home.events(OUTAGE_HOUR)).filter((e) => e.kind === 'availability' && e.from === 'unavailable');
      expect(Math.max(...back.map((e) => Date.parse(e.ts))) - POWER_BACK, `seed ${seed}`).toBeLessThan(4000);
    }
    expect(Math.min(...spans)).toBeGreaterThan(3000);
    expect(Math.max(...spans)).toBeLessThanOrEqual(4000);
  });
});
