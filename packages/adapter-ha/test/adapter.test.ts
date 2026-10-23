import { describe, expect, it } from 'vitest';
import { EntitySchema, HouseEventSchema, manualClock, seededRng, speechProblems, type HomeAdapter } from '@fixwright/protocol';
import { createHaAdapter, targetEntityIds, type HaAdapterConfig } from '../src/adapter.ts';
import { isHaError, toProtocolError, type HaError } from '../src/errors.ts';
import { addEntity, fakeConnector, fakeFetch, fakeHome, haState, type FakeHome } from './fake-ha.ts';

const START = '2026-10-15T10:10:00.000Z';

function setupHome(): FakeHome {
  const home = fakeHome();
  home.areas = [{ area_id: 'hallway', name: 'Hallway' }];
  home.devices = [
    {
      id: 'dev-lamp',
      name: 'Hallway Lamp',
      name_by_user: null,
      manufacturer: 'Signify',
      model: 'LWB010',
      area_id: 'hallway',
      config_entries: ['e-hue'],
      connections: [],
      identifiers: [['hue', 'abc']],
      via_device_id: null,
      disabled_by: null,
    },
  ];
  addEntity(home, haState('light.hallway_lamp', 'off', { friendly_name: 'Hallway Lamp', supported_color_modes: ['onoff'] }), {
    platform: 'hue',
    device_id: 'dev-lamp',
    original_name: 'Hallway Lamp',
    aliases: [null, 'hall lamp'],
  });
  addEntity(home, haState('select.hallway_lamp_power_on_behavior', 'on', { options: ['off', 'on', 'toggle', 'previous'], friendly_name: 'Hallway Lamp Power On Behavior' }), {
    platform: 'hue',
    device_id: 'dev-lamp',
    original_name: 'Power on behavior',
    translation_key: 'power_on_behavior',
  });
  addEntity(home, haState('light.hallway_lamp_old_pairing', 'unavailable', { restored: true, friendly_name: 'Hallway Lamp' }), {
    platform: 'hue',
    original_name: 'Hallway Lamp',
  });
  addEntity(home, undefined, { entity_id: 'switch.retired_plug', platform: 'tplink', disabled_by: 'user', original_name: 'Retired Plug' });
  addEntity(home, haState('lock.front_door', 'locked', { friendly_name: 'Front Door' }), { platform: 'august' });
  addEntity(home, haState('cover.garage', 'closed', { device_class: 'garage', friendly_name: 'Garage' }), { platform: 'myq' });
  addEntity(home, haState('cover.blind', 'open', { device_class: 'blind', friendly_name: 'Blind' }), { platform: 'somfy' });
  addEntity(home, haState('input_select.mode', 'home', { options: ['home', 'away'], friendly_name: 'Mode' }), { platform: 'input_select' });
  home.configEntries = [
    { entry_id: 'e-hue', domain: 'hue', title: 'Hue Bridge', source: 'user', state: 'loaded' },
    { entry_id: 'e-ecobee', domain: 'ecobee', title: 'ecobee', source: 'user', state: 'setup_error', reason: null },
  ];
  home.flows = [{ flow_id: 'f1', handler: 'ecobee', context: { source: 'reauth', entry_id: 'e-ecobee' } }];
  home.manifests = [
    { domain: 'hue', iot_class: 'local_push', integration_type: 'hub' },
    { domain: 'ecobee', iot_class: 'cloud_polling', integration_type: 'hub' },
    { domain: 'template', iot_class: 'local_push', integration_type: 'helper' },
  ];
  return home;
}

function adapterFor(home: FakeHome, over: Partial<HaAdapterConfig> = {}) {
  const clock = manualClock(START);
  const adapter = createHaAdapter({
    baseUrl: 'http://ha.local:8123',
    token: home.token,
    fetch: fakeFetch(home),
    connector: fakeConnector(home),
    clock,
    rng: seededRng(1),
    sleep: async (ms) => clock.advance(ms),
    readBackTimeoutMs: 1000,
    ...over,
  });
  return { adapter, clock };
}

async function failure(p: Promise<unknown>): Promise<HaError> {
  try {
    await p;
  } catch (err) {
    if (isHaError(err)) return err;
    throw err;
  }
  throw new Error('expected a failure');
}

describe('createHaAdapter', () => {
  it('implements HomeAdapter as home-assistant with an injectable clock', () => {
    const { adapter, clock } = adapterFor(setupHome());
    const asHome: HomeAdapter = adapter;
    expect(asHome.kind).toBe('home-assistant');
    expect(adapter.now()).toBe(START);
    clock.advance(1500);
    expect(adapter.now()).toBe('2026-10-15T10:10:01.500Z');
  });

  it('lists entities from states plus registry, with registry-only entries, aliases and areas', async () => {
    const { adapter } = adapterFor(setupHome());
    const list = await adapter.listEntities();
    expect(list.every((e) => EntitySchema.safeParse(e).success)).toBe(true);
    const lamp = list.find((e) => e.entityId === 'light.hallway_lamp');
    expect(lamp).toMatchObject({ name: 'Hallway Lamp', aliases: ['hall lamp'], area: 'Hallway', vendor: 'Signify', transport: 'zigbee', integration: 'hue' });
    expect(list.find((e) => e.entityId === 'light.hallway_lamp_old_pairing')).toMatchObject({ restored: true, state: 'unavailable' });
    expect(list.find((e) => e.entityId === 'switch.retired_plug')).toMatchObject({ registryOnly: true, disabled: true, transport: 'wifi' });
    adapter.close();
  });

  it('gets one entity, or null when Home Assistant knows nothing about it', async () => {
    const { adapter } = adapterFor(setupHome());
    expect((await adapter.getEntity('light.hallway_lamp'))?.name).toBe('Hallway Lamp');
    expect((await adapter.getEntity('switch.retired_plug'))?.registryOnly).toBe(true);
    expect(await adapter.getEntity('light.nope')).toBeNull();
    adapter.close();
  });

  it('calls a service and returns the changed entities, mapped', async () => {
    const home = setupHome();
    const { adapter } = adapterFor(home);
    const { changed } = await adapter.callService('light', 'turn_on', { entity_id: 'light.hallway_lamp' });
    expect(changed.map((e) => `${e.entityId}=${e.state}`)).toEqual(['light.hallway_lamp=on']);
    expect(changed[0]?.area).toBe('Hallway');
    expect((await adapter.callService('light', 'turn_on', { entity_id: 'light.hallway_lamp' })).changed).toEqual([]);
    adapter.close();
  });

  it('refuses a lock and a garage door before anything is sent (every other shape: guard.test.ts)', async () => {
    const home = setupHome();
    const { adapter } = adapterFor(home);
    expect((await failure(adapter.callService('lock', 'unlock', { entity_id: 'lock.front_door' }))).kind).toBe('refused');
    const garage = await failure(adapter.callService('cover', 'open_cover', { entity_id: 'cover.garage' }));
    expect(garage.kind).toBe('refused');
    expect(garage.message).toMatch(/garage/);
    expect(home.log.filter((l) => l.startsWith('POST /api/services'))).toEqual([]);
    const blind = await adapter.callService('cover', 'close_cover', { entity_id: 'cover.blind' });
    expect(blind.changed.map((e) => `${e.entityId}=${e.state}`)).toEqual(['cover.blind=closed']);
    adapter.close();
  });

  it('can be told to allow other domains', async () => {
    const home = setupHome();
    const { adapter } = adapterFor(home, { denyDomains: [], allowGarageCovers: true });
    const { changed } = await adapter.callService('cover', 'open_cover', { entity_id: 'cover.garage' });
    expect(changed.map((e) => e.state)).toEqual(['open']);
    adapter.close();
  });

  it('reads entity_id from every shape a service call allows', () => {
    expect(targetEntityIds({ entity_id: 'light.a, light.b' })).toEqual(['light.a', 'light.b']);
    expect(targetEntityIds({ entity_id: ['light.a'], target: { entity_id: 'light.c' } })).toEqual(['light.a', 'light.c']);
    expect(targetEntityIds({})).toEqual([]);
  });

  it('merges logbook and history into events for a window', async () => {
    const home = setupHome();
    const t = (s: number) => Date.parse(START) / 1000 + s;
    home.history = {
      'light.hallway_lamp': [
        { s: 'off', lu: t(0) },
        { s: 'unavailable', lu: t(10) },
        { s: 'on', lu: t(12) },
      ],
    };
    home.logbook = [
      { when: t(10), entity_id: 'light.hallway_lamp', state: 'unavailable' },
      { when: t(12), entity_id: 'light.hallway_lamp', state: 'on', context_event_type: 'automation_triggered', context_domain: 'automation', context_entity_id: 'automation.wake' },
    ];
    const { adapter } = adapterFor(home);
    const since = START;
    const until = new Date(Date.parse(START) + 60_000).toISOString();
    const events = await adapter.events({ since, until, entityIds: ['light.hallway_lamp'] });
    expect(events.every((e) => HouseEventSchema.safeParse(e).success)).toBe(true);
    expect(events.map((e) => `${e.kind}:${e.from}->${e.to}:${e.context?.automationId ?? '-'}`)).toEqual([
      'availability:off->unavailable:-',
      'availability:unavailable->on:automation.wake',
    ]);
    const all = await adapter.events({ since, until });
    expect(all).toHaveLength(2);
    expect(home.log).toContain('ws history/history_during_period');
    const bad = await failure(adapter.events({ since: 'yesterday' }));
    expect(bad.kind).toBe('bad_request');
    const backwards = await failure(adapter.events({ since: until, until: since }));
    expect(backwards.kind).toBe('bad_request');
    adapter.close();
  });

  it('reads signals from attributes, the power on select on the same device, and flaps', async () => {
    const home = setupHome();
    home.states.set('light.hallway_lamp', haState('light.hallway_lamp', 'on', { friendly_name: 'Hallway Lamp', linkquality: 61 }));
    const now = Date.parse(START) / 1000;
    home.history['light.hallway_lamp'] = [
      { s: 'on', lu: now - 86_000 },
      { s: 'unavailable', lu: now - 5000 },
      { s: 'on', lu: now - 4000 },
      { s: 'unavailable', lu: now - 3000 },
      { s: 'on', lu: now - 2000 },
    ];
    const { adapter } = adapterFor(home);
    expect(await adapter.signals('light.hallway_lamp')).toEqual({ linkQuality: 61, powerOnBehavior: 'on', flaps24h: 2 });
    const missing = await failure(adapter.signals('light.nope'));
    expect(missing.kind).toBe('not_found');
    adapter.close();
  });

  it('reports integrations, with an expired cloud link as auth', async () => {
    const { adapter } = adapterFor(setupHome());
    const out = await adapter.integrations();
    expect(out).toEqual([
      { integration: 'hue', entryId: 'e-hue', state: 'loaded' },
      { integration: 'ecobee', entryId: 'e-ecobee', state: 'setup_error', reason: 'auth: Home Assistant asks to sign in to this integration again' },
    ]);
    adapter.close();
  });

  it('reports hub status: reachable with latency and version, unreachable, or an auth failure', async () => {
    const home = setupHome();
    const { adapter } = adapterFor(home);
    expect(await adapter.hubStatus()).toEqual({ reachable: true, latencyMs: 0, version: '2026.9.4' });
    home.coreState = 'NOT_RUNNING';
    expect((await adapter.hubStatus()).reachable).toBe(false);
    const down = adapterFor(home, { fetch: () => Promise.reject(new TypeError('fetch failed')) }).adapter;
    expect(await down.hubStatus()).toEqual({ reachable: false });
    const wrong = adapterFor(home, { token: 'expired' }).adapter;
    const err = await failure(wrong.hubStatus());
    expect(err.kind).toBe('auth');
    adapter.close();
  });

  it('says vendor cloud status is unknown unless Home Assistant shows it', async () => {
    const home = setupHome();
    const { adapter } = adapterFor(home);
    expect(await adapter.cloudStatus('hue')).toEqual({ vendor: 'hue', status: 'unknown', source: 'not available from Home Assistant', checkedAt: START });
    home.configEntries[1] = { ...home.configEntries[1]!, state: 'setup_retry', reason: 'Connection timed out' };
    const ecobee = await adapter.cloudStatus('ecobee');
    expect(ecobee.status).toBe('degraded');
    adapter.close();
  });

  it('renames through the registry and waits until the state machine shows the new name', async () => {
    const home = setupHome();
    home.renameLagReads = 3;
    const { adapter } = adapterFor(home);
    const lamp = await adapter.registryUpdate('light.hallway_lamp_old_pairing', { name: 'Hallway Lamp (old)' });
    expect(lamp.name).toBe('Hallway Lamp (old)');
    expect(home.entries.get('light.hallway_lamp_old_pairing')?.name).toBe('Hallway Lamp (old)');
    const reset = await adapter.registryUpdate('light.hallway_lamp_old_pairing', { name: null });
    expect(reset.name).toBe('Hallway Lamp');
    adapter.close();
  });

  it('returns what Home Assistant shows when an integration names entities its own way', async () => {
    const home = setupHome();
    home.renameLagReads = 1_000_000; // the state machine never shows the predicted name
    const { adapter } = adapterFor(home, { readBackTimeoutMs: 200 });
    const lamp = await adapter.registryUpdate('light.hallway_lamp', { name: 'Desk Lamp' });
    expect(home.entries.get('light.hallway_lamp')?.name).toBe('Desk Lamp');
    expect(lamp.name).toBe('Hallway Lamp');
    adapter.close();
  });

  it('writes aliases while keeping Home Assistant computed-name alias', async () => {
    const home = setupHome();
    const { adapter } = adapterFor(home);
    const lamp = await adapter.registryUpdate('light.hallway_lamp', { aliases: ['hall light', 'lamp by the door'] });
    expect(lamp.aliases).toEqual(['hall light', 'lamp by the door']);
    expect(home.entries.get('light.hallway_lamp')?.aliases).toEqual([null, 'hall light', 'lamp by the door']);
    adapter.close();
  });

  it('disables an entity and returns it as registry-only', async () => {
    const home = setupHome();
    const { adapter } = adapterFor(home);
    const off = await adapter.registryUpdate('light.hallway_lamp_old_pairing', { disabled: true });
    expect(off).toMatchObject({ disabled: true, registryOnly: true });
    adapter.close();
  });

  it('fails with a readback error when the hub acknowledges a write but never applies it', async () => {
    const home = setupHome();
    home.applyRegistryWrites = false;
    const { adapter } = adapterFor(home);
    const err = await failure(adapter.registryUpdate('light.hallway_lamp', { name: 'Desk Lamp' }));
    expect(err.kind).toBe('readback');
    const missing = await failure(adapter.registryUpdate('light.nope', { name: 'x' }));
    expect(missing.kind).toBe('not_found');
    adapter.close();
  });

  it('removes a registry entry and reads back that state and entry are gone', async () => {
    const home = setupHome();
    const { adapter } = adapterFor(home);
    await adapter.registryRemove('light.hallway_lamp_old_pairing');
    expect(await adapter.getEntity('light.hallway_lamp_old_pairing')).toBeNull();
    const again = await failure(adapter.registryRemove('light.hallway_lamp_old_pairing'));
    expect(again.kind).toBe('not_found');
    adapter.close();
  });

  it('reloads a config entry and checks it loaded again', async () => {
    const home = setupHome();
    home.configEntries[0]!.state = 'setup_retry';
    const { adapter } = adapterFor(home);
    await adapter.reloadIntegration('hue');
    expect(home.configEntries[0]?.state).toBe('loaded');
    expect(home.log).toContain('POST /api/config/config_entries/entry/e-hue/reload');
    adapter.close();
  });

  it('says plainly when an integration only reloads with a restart, without blaming a lock', async () => {
    const home = setupHome();
    home.restartOnly = ['e-hue'];
    const { adapter } = adapterFor(home);
    const err = await failure(adapter.reloadIntegration('hue'));
    expect(err.kind).toBe('unsupported');
    const spoken = toProtocolError(err);
    expect(spoken.code).toBe('no_fix');
    expect(spoken.speech).toMatch(/restart/);
    expect(spoken.speech).not.toMatch(/lock|garage/);
    expect(speechProblems(spoken.speech)).toEqual([]);
    adapter.close();
  });

  it('reports a reload that ends in an error state', async () => {
    const home = setupHome();
    home.reloadResult['e-hue'] = 'setup_error';
    const { adapter } = adapterFor(home);
    const err = await failure(adapter.reloadIntegration('hue'));
    expect(err.kind).toBe('readback');
    expect(err.message).toMatch(/setup_error/);
    adapter.close();
  });

  it('reloads YAML integrations through their reload service, and says when there is none', async () => {
    const home = setupHome();
    const { adapter } = adapterFor(home);
    await adapter.reloadIntegration('template');
    expect(home.log).toContain('POST /api/services/template/reload');
    const err = await failure(adapter.reloadIntegration('made_up'));
    expect(err.kind).toBe('not_found');
    adapter.close();
  });

  it('selects an option and reads it back; refuses unknown options and non-selects', async () => {
    const home = setupHome();
    const { adapter } = adapterFor(home);
    const sel = await adapter.selectOption('select.hallway_lamp_power_on_behavior', 'previous');
    expect(sel.state).toBe('previous');
    expect(home.states.get('select.hallway_lamp_power_on_behavior')?.state).toBe('previous');
    const posts = home.log.filter((l) => l === 'POST /api/services/select/select_option').length;
    await adapter.selectOption('select.hallway_lamp_power_on_behavior', 'previous');
    expect(home.log.filter((l) => l === 'POST /api/services/select/select_option').length).toBe(posts);
    expect((await adapter.selectOption('input_select.mode', 'away')).state).toBe('away');
    expect((await failure(adapter.selectOption('select.hallway_lamp_power_on_behavior', 'sometimes'))).kind).toBe('bad_request');
    expect((await failure(adapter.selectOption('light.hallway_lamp', 'on'))).kind).toBe('bad_request');
    adapter.close();
  });

  it('reopens the websocket after it drops, once, even when several reads find it closed together', async () => {
    const home = setupHome();
    const { adapter } = adapterFor(home, { registryCacheMs: 0 });
    await adapter.listEntities();
    home.sockets[0]?.close();
    await new Promise((r) => setTimeout(r, 5));
    await Promise.all([adapter.listEntities(), adapter.getEntity('light.hallway_lamp'), adapter.integrations()]);
    expect(home.log.filter((l) => l.startsWith('ws connect'))).toHaveLength(2);
    adapter.close();
  });

  it('replaces a half-open websocket that stops answering, instead of waiting out every retry', async () => {
    const home = setupHome();
    const { adapter } = adapterFor(home, { timeoutMs: 30, connector: fakeConnector(home, { silent: ['config/area_registry/list', 'ping'] }) });
    const err = await failure(adapter.listEntities());
    expect(err.kind).toBe('timeout');
    expect(home.log.filter((l) => l.startsWith('ws connect')).length).toBeGreaterThan(1);
    adapter.close();
  });

  it('reports a wrong token on the websocket as auth, with one login attempt for concurrent callers', async () => {
    const home = setupHome();
    const { adapter, clock } = adapterFor(home, { connector: fakeConnector(home, { rejectAuth: true }) });
    // listEntities asks three registries at once; all three wait on the same failed handshake.
    const err = await failure(adapter.listEntities());
    expect(err.kind).toBe('auth');
    expect(home.log.filter((l) => l.startsWith('ws connect'))).toHaveLength(1);
    // Within the hold, calls fail at once and send nothing, REST included.
    const sent = home.log.length;
    const both = await Promise.all([failure(adapter.getEntity('light.hallway_lamp')), failure(adapter.events({ since: START, entityIds: ['light.hallway_lamp'] }))]);
    expect(both.map((e) => e.kind)).toEqual(['auth', 'auth']);
    expect(both[0]?.message).toMatch(/was not sent/);
    expect(home.log.length).toBe(sent);
    // After the hold a call is a new attempt (the token may have been fixed), again shared.
    clock.advance(30_001);
    expect((await failure(adapter.getEntity('light.hallway_lamp'))).kind).toBe('auth');
    expect(home.log.filter((l) => l.startsWith('ws connect'))).toHaveLength(2);
  });

  it('spends one rejected login on a wrong token, however many calls start at once', async () => {
    const home = setupHome();
    const { adapter, clock } = adapterFor(home, { token: 'revoked-token', authHoldMs: 10_000 });
    const errors = await Promise.all([
      failure(adapter.listEntities()),
      failure(adapter.signals('light.hallway_lamp')),
      failure(adapter.integrations()),
      failure(adapter.events({ since: START })),
      failure(adapter.callService('light', 'turn_on', { entity_id: 'light.hallway_lamp' })),
    ]);
    expect(errors.map((e) => e.kind)).toEqual(['auth', 'auth', 'auth', 'auth', 'auth']);
    // One REST request reached the hub; nothing else was sent, the websocket login included.
    expect(home.log).toEqual(['GET /api/states']);
    expect(toProtocolError(errors[4]).code).toBe('adapter_error');
    clock.advance(10_001);
    await failure(adapter.hubStatus());
    expect(home.log).toEqual(['GET /api/states', 'GET /api/config']);
  });

  it('does not queue calls behind each other when the hub is down', async () => {
    const home = setupHome();
    let fetches = 0;
    const { adapter } = adapterFor(home, {
      retry: { retries: 0 },
      fetch: () => {
        fetches++;
        return Promise.reject(new TypeError('fetch failed'));
      },
    });
    const errors = await Promise.all([failure(adapter.rest.states()), failure(adapter.rest.config()), failure(adapter.rest.state('light.x'))]);
    expect(errors.map((e) => e.kind)).toEqual(['unreachable', 'unreachable', 'unreachable']);
    expect(fetches).toBe(3);
  });

  it('retries a handshake that could not connect, even for a write, because nothing was sent', async () => {
    const home = setupHome();
    const real = fakeConnector(home);
    let refusals = 1;
    const flaky = (url: string) => {
      if (refusals-- > 0) throw new TypeError('connect ECONNREFUSED');
      return real(url);
    };
    const { adapter } = adapterFor(home, { connector: flaky });
    await adapter.registryRemove('light.hallway_lamp_old_pairing');
    expect(home.entries.has('light.hallway_lamp_old_pairing')).toBe(false);
    adapter.close();
  });

  it('does not keep a socket whose handshake finished after close()', async () => {
    const home = setupHome();
    const { adapter } = adapterFor(home);
    const pending = adapter.socket();
    adapter.close();
    const s = await pending;
    expect(s.isOpen).toBe(false);
    expect((await adapter.socket()).isOpen).toBe(true);
    expect(home.log.filter((l) => l.startsWith('ws connect'))).toHaveLength(2);
    adapter.close();
  });

  it('reads signals with scoped requests: one shared registry index, the device siblings, no full state dump', async () => {
    const home = setupHome();
    home.states.set('light.hallway_lamp', haState('light.hallway_lamp', 'on', { friendly_name: 'Hallway Lamp', linkquality: 61 }));
    const { adapter } = adapterFor(home);
    const all = await Promise.all([adapter.signals('light.hallway_lamp'), adapter.signals('select.hallway_lamp_power_on_behavior'), adapter.signals('light.hallway_lamp')]);
    expect(all[0]).toMatchObject({ linkQuality: 61, powerOnBehavior: 'on' });
    expect(home.log.filter((l) => l === 'ws config/entity_registry/list')).toHaveLength(1);
    expect(home.log).not.toContain('GET /api/states');
    expect(home.getEntriesCalls).toEqual([]);
    // Without a device, related entities are found by name in one read of the state machine.
    addEntity(home, haState('sensor.porch_battery', '41', { unit_of_measurement: '%' }), null);
    addEntity(home, haState('light.porch', 'on', {}), { platform: 'template' });
    await adapter.signals('light.porch');
    expect(await adapter.signals('light.porch')).toMatchObject({ batteryPct: 41 });
    expect(home.log.filter((l) => l === 'GET /api/states')).toHaveLength(2);
    // The adapter's own registry writes clear the index.
    await adapter.registryUpdate('light.hallway_lamp', { aliases: ['hall lamp'] });
    await adapter.signals('light.hallway_lamp');
    expect(home.log.filter((l) => l === 'ws config/entity_registry/list')).toHaveLength(2);
    adapter.close();
  });

  it('reads cloud status without the whole entity registry', async () => {
    const home = setupHome();
    const { adapter } = adapterFor(home);
    await adapter.cloudStatus('ecobee');
    expect(home.getEntriesCalls).toEqual([]);
    expect(home.log).not.toContain('ws config/entity_registry/list');
    addEntity(home, haState('binary_sensor.ecobee_cloud', 'off', { device_class: 'connectivity', friendly_name: 'ecobee cloud connection' }), { platform: 'ecobee' });
    expect(await adapter.cloudStatus('ecobee')).toMatchObject({ status: 'outage' });
    expect(home.getEntriesCalls).toEqual([['binary_sensor.ecobee_cloud']]);
    adapter.close();
  });

  it('lists the entities each automation refers to, missing ones included (dead trigger evidence)', async () => {
    const home = setupHome();
    addEntity(home, haState('automation.grow_light', 'on', { friendly_name: 'Grow light schedule', id: 'grow' }), { platform: 'automation' });
    home.related['automation.grow_light'] = { entity: ['switch.grow_light_plug', 'Light.Hallway_Lamp'], area: ['hallway'] };
    const { adapter } = adapterFor(home);
    const list = await adapter.listEntities();
    const auto = list.find((e) => e.entityId === 'automation.grow_light');
    expect(auto?.attributes['references']).toEqual(['light.hallway_lamp', 'switch.grow_light_plug']);
    expect(list.some((e) => e.entityId === 'switch.grow_light_plug')).toBe(false);
    expect(EntitySchema.safeParse(auto).success).toBe(true);
    expect((await adapter.getEntity('automation.grow_light'))?.attributes['references']).toEqual(['light.hallway_lamp', 'switch.grow_light_plug']);
    // Cached for registryCacheMs: three reads, one search.
    expect(home.log.filter((l) => l === 'ws search/related')).toHaveLength(1);
    expect(list.find((e) => e.entityId === 'light.hallway_lamp')?.attributes['references']).toBeUndefined();
    adapter.close();
  });

  it('still lists automations when the hub has no search integration, without references', async () => {
    const home = setupHome();
    home.searchLoaded = false;
    addEntity(home, haState('automation.grow_light', 'on', { friendly_name: 'Grow light schedule' }), { platform: 'automation' });
    const { adapter } = adapterFor(home);
    const auto = (await adapter.listEntities()).find((e) => e.entityId === 'automation.grow_light');
    expect(auto?.state).toBe('on');
    expect(auto?.attributes['references']).toBeUndefined();
    adapter.close();
  });

  it('keeps battery levels of sensors whose device class says battery, whatever their id', async () => {
    const home = setupHome();
    const t = (s: number) => Date.parse(START) / 1000 + s;
    addEntity(home, haState('sensor.door_sensor_power', '40', { device_class: 'battery', unit_of_measurement: '%' }), null);
    addEntity(home, haState('sensor.kitchen_power', '120', { device_class: 'power', unit_of_measurement: 'W' }), null);
    home.history = {
      'sensor.door_sensor_power': [
        { s: '42', lu: t(0) },
        { s: '41', lu: t(10) },
      ],
      'sensor.kitchen_power': [
        { s: '100', lu: t(0) },
        { s: '120', lu: t(10) },
      ],
    };
    const { adapter } = adapterFor(home);
    const until = new Date(Date.parse(START) + 60_000).toISOString();
    for (const q of [{ since: START, until }, { since: START, until, entityIds: ['sensor.door_sensor_power', 'sensor.kitchen_power'] }]) {
      const events = await adapter.events(q);
      expect(events.map((e) => `${e.entityId}:${e.from}->${e.to}`)).toEqual(['sensor.door_sensor_power:42->41']);
    }
    // A scoped query reads its sensors' states only, not the whole state machine.
    expect(home.log.filter((l) => l === 'GET /api/states')).toHaveLength(1);
    adapter.close();
  });

  it('refuses to set an option on a select named like a lock', async () => {
    const home = setupHome();
    addEntity(home, haState('select.front_door_lock_mode', 'auto', { options: ['auto', 'manual'], friendly_name: 'Front door lock mode' }), null);
    const { adapter } = adapterFor(home);
    expect((await failure(adapter.selectOption('select.front_door_lock_mode', 'manual'))).kind).toBe('refused');
    expect(home.states.get('select.front_door_lock_mode')?.state).toBe('auto');
    adapter.close();
  });

  it('caches device and area registries for registryCacheMs', async () => {
    const home = setupHome();
    const { adapter, clock } = adapterFor(home, { registryCacheMs: 10_000 });
    await adapter.listEntities();
    await adapter.listEntities();
    expect(home.log.filter((l) => l === 'ws config/device_registry/list')).toHaveLength(1);
    clock.advance(10_001);
    await adapter.listEntities();
    expect(home.log.filter((l) => l === 'ws config/device_registry/list')).toHaveLength(2);
    adapter.close();
  });
});
