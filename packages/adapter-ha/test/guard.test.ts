import { describe, expect, it } from 'vitest';
import { manualClock, seededRng, speechProblems } from '@fixwright/protocol';
import { createHaAdapter } from '../src/adapter.ts';
import { isHaError, toProtocolError, UNVERIFIED_SPEECH, type HaError } from '../src/errors.ts';
import {
  DEFAULT_DENY_DOMAINS,
  DEFAULT_UNSAFE_NAMES,
  entityRefusal,
  forwardedTo,
  isValidEntityId,
  normalizeEntityId,
  reachRefusal,
  resolveIndirect,
  serviceRefusal,
  serviceTarget,
  type GuardPolicy,
} from '../src/guard.ts';
import type { HaDeviceEntry } from '../src/ha-types.ts';
import { addEntity, fakeConnector, fakeFetch, fakeHome, haState, type FakeHome } from './fake-ha.ts';

const policy: GuardPolicy = {
  denyDomains: new Set(DEFAULT_DENY_DOMAINS),
  allowGarageCovers: false,
  unsafeNames: DEFAULT_UNSAFE_NAMES,
  allowServices: new Set(),
};

function device(id: string, over: Partial<HaDeviceEntry> = {}): HaDeviceEntry {
  return {
    id,
    name: id,
    name_by_user: null,
    manufacturer: null,
    model: null,
    area_id: null,
    config_entries: [],
    connections: [],
    identifiers: [],
    via_device_id: null,
    disabled_by: null,
    ...over,
  };
}

describe('serviceTarget', () => {
  it('reads every target key at the top level and under target, as strings, comma lists or arrays', () => {
    const t = serviceTarget({
      entity_id: 'light.a, light.b',
      area_id: 'garage',
      target: { entity_id: ['light.c'], device_id: 'd1', floor_id: ['ground'], label_id: 'outside', area_id: 'none' },
    });
    expect(t).toEqual({
      entityIds: ['light.a', 'light.b', 'light.c'],
      invalidIds: [],
      deviceIds: ['d1'],
      areaIds: ['garage'],
      floorIds: ['ground'],
      labelIds: ['outside'],
      matchAll: false,
    });
  });

  it('notices entity_id "all" and the entities a scene call names as data', () => {
    expect(serviceTarget({ entity_id: 'all' })).toMatchObject({ entityIds: [], matchAll: true });
    expect(serviceTarget({ entities: { 'lock.front_door': 'unlocked' } }).entityIds).toEqual(['lock.front_door']);
    expect(serviceTarget({ scene_id: 'x', snapshot_entities: ['cover.garage'] }).entityIds).toEqual(['cover.garage']);
  });

  // Home Assistant lower cases every entity id it is given (cv.entity_id), so the guard must too.
  it('reads entity ids the way Home Assistant does: lower cased, in every place they can appear', () => {
    expect(serviceTarget({ entity_id: 'LOCK.FRONT_DOOR' }).entityIds).toEqual(['lock.front_door']);
    expect(serviceTarget({ entity_id: ' Cover.Big_Door , light.A' }).entityIds).toEqual(['cover.big_door', 'light.a']);
    expect(serviceTarget({ target: { entity_id: ['COVER.GARAGE'] } }).entityIds).toEqual(['cover.garage']);
    expect(serviceTarget({ entities: { 'LOCK.FRONT_DOOR': 'unlocked' } }).entityIds).toEqual(['lock.front_door']);
    expect(serviceTarget({ snapshot_entities: 'Lock.Back_Door' }).entityIds).toEqual(['lock.back_door']);
    expect(serviceTarget({ entity_id: 'ALL' })).toMatchObject({ entityIds: [], matchAll: true });
    expect(serviceTarget({ target: { entity_id: 'All' } }).matchAll).toBe(true);
    expect(serviceTarget({ entity_id: 'None' })).toMatchObject({ entityIds: [], matchAll: false, invalidIds: [] });
    // The Kelvin sign lower cases to an ASCII k in Python and in JavaScript alike.
    expect(serviceTarget({ entity_id: 'LOC\u212A.FRONT_DOOR' }).entityIds).toEqual(['lock.front_door']);
    expect(normalizeEntityId('  SWITCH.Plug ')).toBe('switch.plug');
  });

  it('collects values Home Assistant would reject as invalid instead of dropping them', () => {
    const t = serviceTarget({ entity_id: ['light.ok', 'light.two words', 'lock', 7], target: { entity_id: { x: 1 } }, area_id: [3] });
    expect(t.entityIds).toEqual(['light.ok']);
    expect(t.invalidIds.sort()).toEqual(['3', '7', 'light.two words', 'lock', '{"x":1}']);
    expect(['light.a__b', '_light.a', 'light._a', 'light.a_', 'light.', '.a'].filter(isValidEntityId)).toEqual([]);
    expect(['light.a_b', 'light.lamp_2', 'light.lamp\u0663', 'sensor.x1'].every(isValidEntityId)).toBe(true);
  });
});

describe('serviceRefusal', () => {
  it('refuses denied domains as unsafe, and services that run unknown actions or stop the hub as unverified', () => {
    expect(serviceRefusal('lock', 'unlock', policy)?.refusal).toBe('unsafe_device');
    expect(serviceRefusal('siren', 'turn_on', policy)?.refusal).toBe('unsafe_device');
    expect(serviceRefusal('script', 'turn_on', policy)?.refusal).toBe('unverified');
    expect(serviceRefusal('script', 'open_everything', policy)?.refusal).toBe('unverified');
    expect(serviceRefusal('automation', 'trigger', policy)?.refusal).toBe('unverified');
    expect(serviceRefusal('homeassistant', 'restart', policy)?.refusal).toBe('unverified');
    expect(serviceRefusal('shell_command', 'anything', policy)?.refusal).toBe('unverified');
    expect(serviceRefusal('script', 'turn_off', policy)).toBeUndefined();
    expect(serviceRefusal('automation', 'turn_off', policy)).toBeUndefined();
    expect(serviceRefusal('homeassistant', 'toggle', policy)).toBeUndefined();
    expect(serviceRefusal('light', 'turn_on', policy)).toBeUndefined();
  });

  it('refuses integration services, which can reach a device whatever entity they name, unless allowed', () => {
    for (const [domain, service] of [
      ['mqtt', 'publish'],
      ['zha', 'issue_zigbee_cluster_command'],
      ['zwave_js', 'set_value'],
      ['knx', 'send'],
      ['modbus', 'write_register'],
      ['esphome', 'garage_open'],
      ['hassio', 'addon_stdin'],
      ['persistent_notification', 'create'],
      ['remote', 'send_command'],
      ['remote', 'learn_command'],
    ] as const) {
      expect(serviceRefusal(domain, service, policy)?.refusal, `${domain}.${service}`).toBe('unverified');
    }
    expect(serviceRefusal('remote', 'turn_on', policy)).toBeUndefined();
    const allowing = { ...policy, allowServices: new Set(['hue.activate_scene', 'script.turn_on']) };
    expect(serviceRefusal('hue', 'activate_scene', allowing)).toBeUndefined();
    expect(serviceRefusal('script', 'turn_on', allowing)).toBeUndefined();
    // An allowed service never makes a denied domain safe.
    expect(serviceRefusal('lock', 'unlock', { ...policy, allowServices: new Set(['lock.unlock']) })?.refusal).toBe('unsafe_device');
  });
});

describe('reachRefusal', () => {
  it('refuses calls that reach no entity, except reloads of entity domains and allowed services', () => {
    expect(reachRefusal('light', 'turn_on', 1, policy)).toBeUndefined();
    expect(reachRefusal('light', 'turn_on', 0, policy)?.refusal).toBe('unverified');
    expect(reachRefusal('conversation', 'process', 0, policy)?.refusal).toBe('unverified');
    expect(reachRefusal('device_tracker', 'see', 0, policy)?.refusal).toBe('unverified');
    expect(reachRefusal('notify', 'mobile_app_phone', 0, policy)?.refusal).toBe('unverified');
    expect(reachRefusal('automation', 'reload', 0, policy)).toBeUndefined();
    expect(reachRefusal('mqtt', 'reload', 0, policy)?.refusal).toBe('unverified');
    expect(reachRefusal('notify', 'mobile_app_phone', 0, { ...policy, allowServices: new Set(['notify.mobile_app_phone']) })).toBeUndefined();
  });
});

describe('resolveIndirect', () => {
  const devices = [
    device('hub', { area_id: 'utility' }),
    device('opener', { area_id: 'garage', via_device_id: 'hub', labels: ['outside'] }),
    device('lamp', { area_id: 'hall' }),
  ];
  const areas = [
    { area_id: 'garage', name: 'Garage', floor_id: 'ground' },
    { area_id: 'hall', name: 'Hall', floor_id: 'first', labels: ['inside'] },
    { area_id: 'utility', name: 'Utility', floor_id: null },
  ];
  const entries = [
    { entity_id: 'cover.garage_door', device_id: 'opener', area_id: null },
    { entity_id: 'sensor.opener_signal', device_id: 'opener', area_id: 'utility' },
    { entity_id: 'light.hall', device_id: 'lamp', area_id: null },
    { entity_id: 'switch.porch', device_id: null, area_id: 'garage', labels: ['porch'] },
  ];
  const reg = { entries, devices, areas };
  const resolve = (data: Record<string, unknown>) => [...resolveIndirect(serviceTarget(data), reg).entityIds].sort();

  it('follows areas to devices, devices to entities, and floors and labels to both', () => {
    expect(resolve({ area_id: 'garage' })).toEqual(['cover.garage_door', 'sensor.opener_signal', 'switch.porch']);
    expect(resolve({ floor_id: 'ground' })).toEqual(['cover.garage_door', 'sensor.opener_signal', 'switch.porch']);
    expect(resolve({ label_id: 'outside' })).toEqual(['cover.garage_door', 'sensor.opener_signal']);
    expect(resolve({ label_id: 'inside' })).toEqual(['light.hall']);
    expect(resolve({ label_id: 'porch' })).toEqual(['switch.porch']);
  });

  it('includes child devices of a targeted device, and reports device ids it does not know', () => {
    expect(resolve({ device_id: 'hub' })).toEqual(['cover.garage_door', 'sensor.opener_signal']);
    expect(resolveIndirect(serviceTarget({ device_id: ['lamp', 'gone'] }), reg).unknownDevices).toEqual(['gone']);
  });

  it('matches area, device, floor and label ids in any case (wider than Home Assistant, never narrower)', () => {
    expect(resolve({ area_id: 'GARAGE' })).toEqual(['cover.garage_door', 'sensor.opener_signal', 'switch.porch']);
    expect(resolve({ floor_id: 'Ground' })).toEqual(['cover.garage_door', 'sensor.opener_signal', 'switch.porch']);
    expect(resolve({ label_id: 'OUTSIDE' })).toEqual(['cover.garage_door', 'sensor.opener_signal']);
    expect(resolve({ device_id: 'HUB' })).toEqual(['cover.garage_door', 'sensor.opener_signal']);
    expect(resolveIndirect(serviceTarget({ device_id: 'HUB' }), reg).unknownDevices).toEqual([]);
  });
});

describe('entityRefusal and forwardedTo', () => {
  it('refuses denied domains, garage, gate and door covers, and things named like them', () => {
    expect(entityRefusal('camera.porch', undefined, policy)?.refusal).toBe('unsafe_device');
    expect(entityRefusal('cover.x', haState('cover.x', 'closed', { device_class: 'gate' }), policy)?.message).toMatch(/gate/);
    expect(entityRefusal('cover.blind', haState('cover.blind', 'open', { device_class: 'blind' }), policy)).toBeUndefined();
    expect(entityRefusal('switch.relay_2', haState('switch.relay_2', 'off', { friendly_name: 'Garage Door Opener' }), policy)).toBeDefined();
    expect(entityRefusal('switch.front_doorbell_chime', undefined, policy)).toBeDefined();
    expect(entityRefusal('light.clock_light', haState('light.clock_light', 'on', { friendly_name: 'Clock light' }), policy)).toBeUndefined();
    expect(entityRefusal('switch.relay_2', haState('switch.relay_2', 'off', { friendly_name: 'Garage Door Opener' }), { ...policy, unsafeNames: null })).toBeUndefined();
  });

  it('refuses mixed case ids like their lower case form', () => {
    expect(entityRefusal('LOCK.FRONT_DOOR', undefined, policy)?.refusal).toBe('unsafe_device');
    const noNames = { ...policy, unsafeNames: null };
    expect(entityRefusal('COVER.BIG_DOOR', haState('cover.big_door', 'closed', { device_class: 'garage', friendly_name: 'Big Door' }), noNames)?.refusal).toBe(
      'unsafe_device',
    );
  });

  it('refuses a script or an integration scene that the call would start', () => {
    const on = { domain: 'homeassistant', service: 'turn_on' };
    expect(entityRefusal('script.open_up', haState('script.open_up', 'off', { friendly_name: 'Open up' }), policy, on)?.refusal).toBe('unverified');
    expect(entityRefusal('script.open_up', undefined, policy, { domain: 'homeassistant', service: 'turn_off' })).toBeUndefined();
    // light.turn_on on an area never runs the scripts in it.
    expect(entityRefusal('script.open_up', undefined, policy, { domain: 'light', service: 'turn_on' })).toBeUndefined();
    expect(entityRefusal('scene.away', haState('scene.away', 'unknown', { friendly_name: 'Away' }), policy, { domain: 'scene', service: 'turn_on' })?.refusal).toBe(
      'unverified',
    );
    const listed = haState('scene.dinner', 'unknown', { entity_id: ['light.table'], friendly_name: 'Dinner' });
    expect(entityRefusal('scene.dinner', listed, policy, { domain: 'scene', service: 'turn_on' })).toBeUndefined();
    expect(entityRefusal('script.open_up', undefined, { ...policy, allowServices: new Set(['homeassistant.turn_on']) }, on)).toBeUndefined();
  });

  it('lists the members a group or scene forwards to', () => {
    expect(forwardedTo(haState('group.x', 'on', { entity_id: ['cover.a', 'light.b', 3] }))).toEqual(['cover.a', 'light.b']);
    expect(forwardedTo(haState('group.y', 'on', { entity_id: ['Lock.Front', 'not an id'] }))).toEqual(['lock.front']);
    expect(forwardedTo(haState('light.y', 'on', {}))).toEqual([]);
    expect(forwardedTo(undefined)).toEqual([]);
  });
});

function guardHome(): FakeHome {
  const home = fakeHome();
  home.areas = [
    { area_id: 'garage', name: 'Garage', floor_id: 'ground' },
    { area_id: 'hallway', name: 'Hallway', floor_id: 'first' },
  ];
  home.devices = [
    device('dev-hub', { area_id: null }),
    device('dev-garage', { area_id: 'garage', via_device_id: 'dev-hub', labels: ['outside'] }),
    device('dev-lamp', { area_id: 'hallway' }),
  ];
  addEntity(home, haState('cover.garage', 'closed', { device_class: 'garage', friendly_name: 'Garage' }), { platform: 'myq', device_id: 'dev-garage' });
  addEntity(home, haState('light.hallway_lamp', 'off', { friendly_name: 'Hallway Lamp' }), { platform: 'hue', device_id: 'dev-lamp' });
  addEntity(home, haState('lock.front_door', 'locked', { friendly_name: 'Front Door' }), { platform: 'august' });
  addEntity(home, haState('cover.blind', 'open', { device_class: 'blind', friendly_name: 'Blind' }), { platform: 'somfy' });
  addEntity(home, haState('cover.all_covers', 'open', { entity_id: ['cover.blind', 'cover.garage'], friendly_name: 'All covers' }), { platform: 'group' });
  addEntity(home, haState('group.outside', 'on', { entity_id: ['cover.all_covers'], friendly_name: 'Outside' }), null);
  addEntity(home, haState('scene.leaving', 'unknown', { entity_id: ['light.hallway_lamp', 'lock.front_door'], friendly_name: 'Leaving' }), { platform: 'homeassistant' });
  addEntity(home, haState('switch.relay_2', 'off', { friendly_name: 'Garage Door Opener' }), { platform: 'shelly' });
  addEntity(home, haState('script.morning', 'off', { friendly_name: 'Morning' }), { platform: 'script' });
  return home;
}

function guardAdapter(home: FakeHome) {
  const clock = manualClock('2026-10-15T10:10:00.000Z');
  return createHaAdapter({
    baseUrl: 'http://ha.local:8123',
    token: home.token,
    fetch: fakeFetch(home),
    connector: fakeConnector(home),
    clock,
    rng: seededRng(3),
    sleep: async (ms) => clock.advance(ms),
  });
}

async function refusal(p: Promise<unknown>): Promise<HaError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isHaError(err)) throw new Error(`expected a refusal, got ${String(err)}`);
  expect(err.kind).toBe('refused');
  return err;
}

describe('HaAdapter.callService guard', () => {
  it('refuses every way a call can reach a lock or a garage door, before anything is sent', async () => {
    const home = guardHome();
    const ha = guardAdapter(home);
    const unsafe: Array<[string, string, Record<string, unknown>]> = [
      ['lock', 'unlock', { entity_id: 'lock.front_door' }],
      ['homeassistant', 'turn_off', { target: { entity_id: ['lock.front_door'] } }],
      ['cover', 'open_cover', { entity_id: 'cover.garage' }],
      // The shapes an earlier version let through: area and device targets on the generic domain.
      ['homeassistant', 'toggle', { area_id: 'garage' }],
      ['homeassistant', 'toggle', { device_id: 'dev-garage' }],
      ['homeassistant', 'toggle', { device_id: 'dev-hub' }],
      ['homeassistant', 'turn_on', { target: { floor_id: 'ground' } }],
      ['homeassistant', 'turn_on', { label_id: 'outside' }],
      ['homeassistant', 'turn_off', { entity_id: 'all' }],
      ['cover', 'open_cover', { entity_id: 'all' }],
      ['cover', 'close_cover', { entity_id: 'cover.all_covers' }],
      ['homeassistant', 'turn_on', { entity_id: 'group.outside' }],
      ['scene', 'turn_on', { entity_id: 'scene.leaving' }],
      ['scene', 'apply', { entities: { 'lock.front_door': 'unlocked' } }],
      ['switch', 'turn_on', { entity_id: 'switch.relay_2' }],
      // Mixed case: Home Assistant lower cases ids and service names, so these reach the same devices.
      ['scene', 'apply', { entities: { 'LOCK.FRONT_DOOR': 'unlocked' } }],
      ['scene', 'create', { scene_id: 'x', snapshot_entities: ['Lock.Front_Door'] }],
      ['homeassistant', 'turn_off', { entity_id: 'LOCK.front_door' }],
      ['LOCK', 'Unlock', { entity_id: 'lock.front_door' }],
      [' Lock ', 'unlock', {}],
      ['homeassistant', 'turn_off', { entity_id: 'ALL' }],
    ];
    for (const [domain, service, data] of unsafe) {
      const err = await refusal(ha.callService(domain, service, data));
      expect(err.refusal, `${domain}.${service} ${JSON.stringify(data)}`).toBe('unsafe_device');
    }
    expect(home.log.filter((l) => l.startsWith('POST /api/services'))).toEqual([]);
    ha.close();
  });

  it('refuses a mixed case garage cover by its device class alone, with the name rule off', async () => {
    const home = guardHome();
    // An ordinary id and name, as in many real homes: only the device class says garage.
    addEntity(home, haState('cover.big_door', 'closed', { device_class: 'garage', friendly_name: 'Big Door' }), { platform: 'myq' });
    const ha = createHaAdapter({
      baseUrl: 'http://ha.local:8123',
      token: home.token,
      fetch: fakeFetch(home),
      connector: fakeConnector(home),
      unsafeNames: null,
    });
    for (const [domain, service, data] of [
      ['cover', 'open_cover', { entity_id: 'COVER.BIG_DOOR' }],
      ['homeassistant', 'toggle', { entity_id: 'Cover.big_door' }],
      ['COVER', 'OPEN_COVER', { target: { entity_id: ['cover.BIG_door'] } }],
    ] as const) {
      expect((await refusal(ha.callService(domain, service, data))).refusal, `${domain}.${service}`).toBe('unsafe_device');
    }
    expect(home.states.get('cover.big_door')?.state).toBe('closed');
    expect(home.log.filter((l) => l.startsWith('POST /api/services'))).toEqual([]);
    ha.close();
  });

  it('refuses calls whose reach it cannot check, with its own spoken line', async () => {
    const home = guardHome();
    const ha = guardAdapter(home);
    const unchecked: Array<[string, string, Record<string, unknown>]> = [
      ['script', 'turn_on', { entity_id: 'script.morning' }],
      ['script', 'morning', {}],
      ['automation', 'trigger', { entity_id: 'automation.x' }],
      ['homeassistant', 'restart', {}],
      ['homeassistant', 'toggle', { device_id: 'not-a-device' }],
      ['cover', 'open_cover', {}],
      // Integration services address devices directly, whatever entity they name.
      ['mqtt', 'publish', { topic: 'zigbee2mqtt/garage_opener/set', payload: '{"state":"OPEN"}' }],
      ['mqtt', 'publish', { entity_id: 'light.hallway_lamp', topic: 'zigbee2mqtt/garage_opener/set', payload: '{"state":"OPEN"}' }],
      ['zha', 'issue_zigbee_cluster_command', { ieee: '00:11:22:33:44:55:66:77', endpoint_id: 1, cluster_id: 257, command: 1 }],
      ['zwave_js', 'set_value', { entity_id: 'light.hallway_lamp', command_class: 98, property: 'targetMode', value: 0 }],
      ['knx', 'send', { address: '1/2/3', payload: 1 }],
      ['esphome', 'garage_open', {}],
      ['remote', 'send_command', { entity_id: 'light.hallway_lamp', command: 'open' }],
      // Calls that reach no entity at all.
      ['light', 'turn_on', {}],
      ['light', 'turn_on', { entity_id: 'none' }],
      ['conversation', 'process', { text: 'open the garage door' }],
      ['device_tracker', 'see', { dev_id: 'phone', location_name: 'home' }],
      // A script reached through the generic domain runs; ids Home Assistant would reject are not guessed at.
      ['homeassistant', 'turn_on', { entity_id: 'script.morning' }],
      ['homeassistant', 'turn_on', { area_id: 'hallway', entity_id: 'SCRIPT.MORNING' }],
      ['light', 'turn_on', { entity_id: 'light.hallway lamp' }],
      ['light', 'turn_on', { entity_id: ['light.hallway_lamp', 7] }],
    ];
    for (const [domain, service, data] of unchecked) {
      const err = await refusal(ha.callService(domain, service, data));
      expect(err.refusal, `${domain}.${service}`).toBe('unverified');
      const spoken = toProtocolError(err);
      expect(spoken.code).toBe('unsafe_device');
      expect(spoken.speech).toBe(UNVERIFIED_SPEECH);
      expect(speechProblems(spoken.speech)).toEqual([]);
    }
    expect(home.log.filter((l) => l.startsWith('POST /api/services'))).toEqual([]);
    ha.close();
  });

  it('lets an allowed integration service through, still checking the entities it names', async () => {
    const home = guardHome();
    const ha = createHaAdapter({
      baseUrl: 'http://ha.local:8123',
      token: home.token,
      fetch: fakeFetch(home),
      connector: fakeConnector(home),
      allowServices: ['hue.activate_scene'],
    });
    // Sent: the fake hub has no such service and answers 400, which is not a refusal.
    const sent = await ha.callService('hue', 'activate_scene', { entity_id: 'light.hallway_lamp' }).catch((e: unknown) => e);
    expect(isHaError(sent) && sent.kind).toBe('bad_request');
    expect(home.log).toContain('POST /api/services/hue/activate_scene');
    expect((await refusal(ha.callService('hue', 'activate_scene', { entity_id: 'lock.front_door' }))).refusal).toBe('unsafe_device');
    ha.close();
  });

  it('lets safe calls through, area targets included, with one state read per entity it checks', async () => {
    const home = guardHome();
    const ha = guardAdapter(home);
    await ha.callService('light', 'turn_on', { area_id: 'hallway' });
    await ha.callService('cover', 'close_cover', { entity_id: 'cover.blind' });
    await ha.callService('script', 'turn_off', { entity_id: 'script.morning' });
    await ha.callService('Light', 'TURN_OFF', { entity_id: 'LIGHT.HALLWAY_LAMP' });
    expect(home.log.filter((l) => l.startsWith('POST /api/services'))).toEqual([
      'POST /api/services/light/turn_on',
      'POST /api/services/cover/close_cover',
      'POST /api/services/script/turn_off',
      'POST /api/services/light/turn_off',
    ]);
    home.log.length = 0;
    const { changed } = await ha.callService('light', 'turn_on', { entity_id: 'light.hallway_lamp' });
    expect(changed.map((e) => e.state)).toEqual(['on']);
    expect(home.log.filter((l) => l.startsWith('GET'))).toEqual(['GET /api/states/light.hallway_lamp']);
    ha.close();
  });

  it('reads the whole state machine once instead of many single reads', async () => {
    const home = guardHome();
    const many = Array.from({ length: 13 }, (_, i) => `light.extra_${i}`);
    for (const id of many) addEntity(home, haState(id, 'off', { friendly_name: `Extra ${id.slice(-2)}` }), { platform: 'hue' });
    const ha = guardAdapter(home);
    await ha.callService('light', 'turn_off', { entity_id: many });
    await ha.callService('light', 'turn_off', { entity_id: 'all' });
    expect(home.log.filter((l) => l.startsWith('GET'))).toEqual(['GET /api/states', 'GET /api/states']);
    ha.close();
  });
});
