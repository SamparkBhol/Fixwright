// Integration tests against a live Home Assistant 2026.9.4 running the fixture config.
// Run with scripts/integration.sh (starts HA, runs these, stops HA), or by hand:
//   eval "$(scripts/ha-local.sh env)" && npx vitest run --tags-filter integration
// Without HA_URL and HA_TOKEN every test here is skipped (tag 'integration', see vitest.config.ts).
// Each test also records how long the adapter call took; the numbers are written to
// $HA_RESULTS_DIR/integration-timings.json (default .runtime/results) at the end.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloudStatusSchema, EntitySchema, HouseEventSchema, IntegrationStatusSchema, SignalsSchema } from '@fixwright/protocol';
import { causeOf, createHaAdapter, expectedFriendlyName, isHaError, toProtocolError, type HaAdapter } from '../../src/index.ts';
import type { HaDeviceEntry, HaEntityEntry } from '../../src/ha-types.ts';
import {
  BRIDGE,
  CIRCUIT,
  DEAD_TRIGGER,
  ROUTINE_SCRIPT,
  available,
  bridgeDown,
  bridgeUp,
  duplicateName,
  ghost,
  powerCut,
  powerOnSelect,
  setPowerOnBehavior,
  setup,
  unavailable,
  unghost,
  waitForState,
  type Fixture,
} from '../../fixtures/home-assistant/inject.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const URL_ = process.env['HA_URL'] ?? '';
const TOKEN = process.env['HA_TOKEN'] ?? '';
const CONFIG_DIR = process.env['HA_CONFIG_DIR'];
const RESULTS_DIR = process.env['HA_RESULTS_DIR'] ?? join(PKG, '.runtime', 'results');
/** Home Assistant's own log, when this machine can read it (ha-local.sh and CI both set it). */
const LOG_FILE = process.env['HA_LOG_FILE'];

const timings: Record<string, number[]> = {};
const counts: Record<string, number> = {};
/** Rejected logins Home Assistant has logged so far (http/ban.py process_wrong_login), or undefined. */
const rejectedLogins = (): number | undefined =>
  LOG_FILE && existsSync(LOG_FILE) ? (readFileSync(LOG_FILE, 'utf8').match(/Login attempt or request with invalid authentication/g) ?? []).length : undefined;
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    (timings[label] ??= []).push(Math.round((performance.now() - t0) * 10) / 10);
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The recorder writes rows once a second (commit_interval 1); wait before reading logbook or history. */
const recorderFlush = () => sleep(1600);

describe('HaAdapter against Home Assistant 2026.9.4', { tags: ['integration'] }, () => {
  let adapter: HaAdapter;
  let fx: Fixture;

  beforeAll(async () => {
    adapter = createHaAdapter({ baseUrl: URL_, token: TOKEN });
    fx = { adapter, configDir: CONFIG_DIR };
    await setup(fx);
  });

  afterAll(() => {
    adapter?.close();
    const summary = Object.fromEntries(
      Object.entries(timings).map(([k, v]) => {
        const s = [...v].sort((a, b) => a - b);
        return [k, { n: s.length, min: s[0], p50: s[Math.floor((s.length - 1) / 2)], max: s[s.length - 1] }];
      }),
    );
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(
      join(RESULTS_DIR, 'integration-timings.json'),
      `${JSON.stringify({ measured_at: new Date().toISOString(), ha_url: URL_, unit: 'ms', timings: summary, counts }, null, 2)}\n`,
    );
    console.log(`integration timings (ms): ${JSON.stringify(summary)}`);
  });

  it('reaches the hub and reports its version and latency', async () => {
    const hub = await timed('hubStatus', () => adapter.hubStatus());
    expect(hub.reachable).toBe(true);
    expect(hub.version).toBe('2026.9.4');
    expect(hub.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('maps every entity: states, registry, devices and areas, all schema valid', async () => {
    const list = await timed('listEntities', () => adapter.listEntities());
    expect(list.length).toBeGreaterThan(100);
    for (const e of list) expect(EntitySchema.safeParse(e).success, e.entityId).toBe(true);
    const byId = new Map(list.map((e) => [e.entityId, e]));
    for (const id of CIRCUIT.devices) {
      expect(byId.get(id), id).toMatchObject({ area: 'Hallway', integration: 'template', state: 'off' });
    }
    expect(byId.get('light.hallway_lamp')?.transport).toBe('zigbee');
    expect(byId.get('switch.hallway_smart_plug')?.transport).toBe('wifi');
    expect(byId.get(CIRCUIT.group)?.integration).toBe('group');
    const bed = byId.get('light.bed_light');
    expect(bed?.integration).toBe('demo');
    expect(bed?.deviceId).toBeTruthy();
    // F1 shape: two entities answer to "Hallway Lamp", the old copy never responds.
    const named = list.filter((e) => e.name.toLowerCase() === 'hallway lamp');
    expect(named.map((e) => `${e.entityId}:${e.state}`).sort()).toEqual(['light.hallway_lamp:off', 'light.hallway_lamp_old_pairing:unavailable']);
  });

  it.skipIf(!CONFIG_DIR)('maps a restored ghost, removes it from the registry, and puts it back', async () => {
    await timed('inject ghost (template reload)', () => ghost(fx));
    const g = await timed('getEntity', () => adapter.getEntity(CIRCUIT.ghost));
    expect(g).toMatchObject({ entityId: CIRCUIT.ghost, name: 'Hallway Lamp', state: 'unavailable', restored: true, area: 'Hallway' });
    expect(g?.registryOnly).toBeUndefined();
    const listed = (await adapter.listEntities()).find((e) => e.entityId === CIRCUIT.ghost);
    expect(listed?.restored).toBe(true);
    // The F1 repair: retire the restored copy, read back that it is gone.
    await timed('registryRemove', () => adapter.registryRemove(CIRCUIT.ghost));
    expect(await adapter.getEntity(CIRCUIT.ghost)).toBeNull();
    const err = await adapter.registryRemove(CIRCUIT.ghost).catch((e: unknown) => e);
    expect(isHaError(err) && err.kind).toBe('not_found');
    await timed('inject unghost (template reload)', () => unghost(fx));
    const back = await adapter.getEntity(CIRCUIT.ghost);
    expect(back).toMatchObject({ state: 'unavailable', name: 'Hallway Lamp' });
    expect(back?.restored).toBeUndefined();
  });

  it('renames through the registry and reads the new name back from registry and state', async () => {
    const renamed = await timed('registryUpdate name', () => adapter.registryUpdate(CIRCUIT.ghost, { name: 'Hallway Lamp (old copy)' }));
    expect(renamed.name).toBe('Hallway Lamp (old copy)');
    const raw = await adapter.rest.state(CIRCUIT.ghost);
    expect(raw.attributes['friendly_name']).toBe('Hallway Lamp (old copy)');
    const socket = await adapter.socket();
    const entry = await socket.command<{ name: string | null }>('config/entity_registry/get', { entity_id: CIRCUIT.ghost });
    expect(entry.name).toBe('Hallway Lamp (old copy)');
    const names = (await adapter.listEntities()).filter((e) => e.name.toLowerCase() === 'hallway lamp');
    expect(names.map((e) => e.entityId)).toEqual(['light.hallway_lamp']);

    const aliased = await timed('registryUpdate aliases', () => adapter.registryUpdate(CIRCUIT.lamp, { aliases: ['hall lamp', 'lamp by the door'] }));
    expect(aliased.aliases).toEqual(['hall lamp', 'lamp by the door']);

    const reset = await timed('registryUpdate name', () => adapter.registryUpdate(CIRCUIT.ghost, { name: null }));
    expect(reset.name).toBe('Hallway Lamp');
    await adapter.registryUpdate(CIRCUIT.lamp, { aliases: [] });
  });

  it('disables an entity (registry only) and brings it back with a template reload', async () => {
    const off = await timed('registryUpdate disable', () => adapter.registryUpdate(CIRCUIT.ghost, { disabled: true }));
    expect(off).toMatchObject({ disabled: true, registryOnly: true });
    expect((await adapter.listEntities()).find((e) => e.entityId === CIRCUIT.ghost)?.registryOnly).toBe(true);
    const on = await adapter.registryUpdate(CIRCUIT.ghost, { disabled: false });
    expect(on.disabled).toBe(false);
    await timed('reloadIntegration template', () => adapter.reloadIntegration('template'));
    await waitForState(fx, CIRCUIT.ghost, (s) => s?.state === 'unavailable');
    for (const d of CIRCUIT.devices) await waitForState(fx, d, (s) => !!s && s.state !== 'unavailable');
    expect((await adapter.getEntity(CIRCUIT.ghost))?.registryOnly).toBeUndefined();
  });

  it('tells automation, user and no-context changes apart on a power cut and restore at a given time', async () => {
    await setup(fx);
    await sleep(1100);
    const since = new Date().toISOString();
    const at = Date.now() + 800;
    const cut = await timed('inject power cut', () => powerCut(fx, { at, holdMs: 1500 }));
    expect(Date.parse(cut.breakerOffAt)).toBeGreaterThanOrEqual(at - 5);
    // Real bulbs with power on behavior "on": every device came back on.
    expect([...cut.devicesOnAfter].sort()).toEqual([...CIRCUIT.devices].sort());
    // The plug's uptime is sampled once a second: wait for its first reading after power came back, so a
    // busy machine cannot push it past the window read below.
    await waitForState(fx, CIRCUIT.plugUptime, (st) => !!st && /^\d+$/.test(st.state) && Date.parse(st.last_changed) >= Date.parse(cut.mainsOnAt));
    await recorderFlush();
    const events = await timed('events (all entities)', () => adapter.events({ since }));
    for (const e of events) expect(HouseEventSchema.safeParse(e).success).toBe(true);

    const breaker = events.filter((e) => e.entityId === CIRCUIT.breaker);
    expect(breaker.map((e) => `${e.to}:${causeOf(e.context)}:${e.context?.service}`)).toEqual([
      'off:user:input_boolean.turn_off',
      'on:user:input_boolean.turn_on',
    ]);
    for (const id of CIRCUIT.devices) {
      const own = events.filter((e) => e.entityId === id);
      expect(own.map((e) => `${e.kind}:${e.from}->${e.to}:${causeOf(e.context)}`), id).toEqual([
        'availability:off->unavailable:none',
        'availability:unavailable->on:none',
      ]);
    }
    const run = events.find((e) => e.kind === 'automation_run' && e.entityId === CIRCUIT.restoreAutomation);
    expect(run?.context?.automationId).toBe(CIRCUIT.restoreAutomation);
    const log = events.find((e) => e.entityId === CIRCUIT.restoreLog);
    expect(causeOf(log?.context)).toBe('automation');

    // F2 shape for the engine: the devices restart within a second, across two integrations.
    const circuit = new Set<string>([...CIRCUIT.devices, CIRCUIT.group]);
    const backTimes = events.filter((e) => e.kind === 'availability' && e.from === 'unavailable' && circuit.has(e.entityId ?? '')).map((e) => Date.parse(e.ts));
    expect(backTimes).toHaveLength(7);
    expect(Math.max(...backTimes) - Math.min(...backTimes)).toBeLessThan(1000);
    // The plug reports its own restart too: its uptime starts again from zero, which counts as restart evidence.
    const uptime = events.filter((e) => e.entityId === CIRCUIT.plugUptime);
    const reset = uptime.find((e) => e.data?.['uptime_reset'] === true);
    expect(reset, JSON.stringify(uptime)).toMatchObject({ from: 'unavailable' });
    expect(Number(reset?.to)).toBeLessThan(5);
    expect(uptime.filter((e) => e.from !== undefined && /^\d+$/.test(e.from) && /^\d+$/.test(e.to ?? '')).every((e) => e.data?.['uptime_reset'] === true)).toBe(true);
    const integrations = new Set(
      (await adapter.listEntities())
        .filter((e) => events.some((ev) => ev.entityId === e.entityId && ev.from === 'unavailable'))
        .map((e) => e.integration),
    );
    expect([...integrations].sort()).toEqual(['group', 'template']);

    const scoped = await timed('events (circuit only)', () => adapter.events({ since, entityIds: [...CIRCUIT.devices] }));
    expect(scoped.filter((e) => e.kind === 'availability')).toHaveLength(12);
    (timings['mains back to devices back'] ??= []).push(Math.max(...cut.devicesBackAt.map((t) => Date.parse(t))) - Date.parse(cut.mainsOnAt));
  });

  it('sets the power on behavior with read-back, and the next power cut leaves every device as it was', async () => {
    const sel = await timed('selectOption', () => adapter.selectOption(powerOnSelect(CIRCUIT.lamp), 'previous'));
    expect(sel.state).toBe('previous');
    expect((await adapter.rest.state('input_select.hallway_lamp_power_on_behavior_store')).state).toBe('previous');
    expect((await timed('signals', () => adapter.signals(CIRCUIT.lamp))).powerOnBehavior).toBe('previous');
    await setPowerOnBehavior(fx, 'previous');
    await setup(fx);
    const cut = await powerCut(fx, { holdMs: 1000 });
    expect(cut.devicesOnAfter).toEqual([]);
    for (const id of CIRCUIT.devices) expect((await adapter.getEntity(id))?.state, id).toBe('off');
    const bad = await adapter.selectOption(powerOnSelect(CIRCUIT.lamp), 'sometimes').catch((e: unknown) => e);
    expect(isHaError(bad) && bad.kind).toBe('bad_request');
    await setPowerOnBehavior(fx, 'on');
  });

  it('reloads a bridge integration whose lights went unavailable for real, and they come back', async () => {
    const since = new Date().toISOString();
    await timed('inject bridge down', () => bridgeDown(fx));
    await bridgeUp(fx);
    // The link is back, but the integration still reports its lights unavailable (not a forced state).
    for (const id of BRIDGE.lights) expect(await adapter.getEntity(id), id).toMatchObject({ state: 'unavailable', integration: BRIDGE.integration, transport: 'zigbee' });
    expect((await adapter.integrations()).find((i) => i.integration === BRIDGE.integration)?.state).toBe('loaded');
    await timed('reloadIntegration bridge', () => adapter.reloadIntegration(BRIDGE.integration));
    for (const id of BRIDGE.lights) expect((await adapter.getEntity(id))?.state, id).toBe('off');
    await recorderFlush();
    const events = await adapter.events({ since, entityIds: [...BRIDGE.lights] });
    for (const id of BRIDGE.lights) {
      expect(events.filter((e) => e.entityId === id).map((e) => `${e.kind}:${e.from}->${e.to}`), id).toEqual([
        'availability:off->unavailable',
        'availability:unavailable->off',
      ]);
    }
  });

  it('reports a bridge that is still down after a reload as setup_retry, then recovers once it answers', async () => {
    await bridgeDown(fx);
    const err = await adapter.reloadIntegration(BRIDGE.integration).catch((e: unknown) => e);
    expect(isHaError(err) && err.kind).toBe('readback');
    expect(isHaError(err) && err.message).toMatch(/setup_retry/);
    expect(toProtocolError(err).code).toBe('adapter_error');
    const status = (await adapter.integrations()).find((i) => i.integration === BRIDGE.integration);
    expect(status).toMatchObject({ state: 'setup_retry', reason: 'the bridge does not answer on the network' });
    // The hub_down shape: the entry is retrying and every entity behind it is a restored ghost for now.
    for (const id of BRIDGE.lights) expect(await adapter.getEntity(id), id).toMatchObject({ state: 'unavailable', restored: true });
    await bridgeUp(fx);
    await adapter.reloadIntegration(BRIDGE.integration);
    expect((await adapter.integrations()).find((i) => i.integration === BRIDGE.integration)?.state).toBe('loaded');
    for (const id of BRIDGE.lights) expect((await adapter.getEntity(id))?.state, id).toBe('off');
  });

  it('brings a forced unavailable entity back with a demo config entry reload', async () => {
    expect(await unavailable(fx, 'light.bed_light')).toBe('forced');
    expect((await adapter.getEntity('light.bed_light'))?.state).toBe('unavailable');
    await timed('reloadIntegration demo', () => adapter.reloadIntegration('demo'));
    expect((await adapter.getEntity('light.bed_light'))?.state).not.toBe('unavailable');
    expect((await adapter.integrations()).find((i) => i.integration === 'demo')?.state).toBe('loaded');
    // The other way back from a forced state: Home Assistant rewrites the entity's real state.
    await unavailable(fx, 'light.ceiling_lights');
    await available(fx, 'light.ceiling_lights');
    expect((await adapter.getEntity('light.ceiling_lights'))?.state).not.toBe('unavailable');
  });

  it('makes two entities answer to one spoken name (duplicate injection), and undoes it', async () => {
    const previous = await timed('inject duplicate name', () => duplicateName(fx, 'light.landing_light', 'Hallway Lamp'));
    expect(previous).toBeNull();
    const named = (await adapter.listEntities()).filter((e) => e.name.toLowerCase() === 'hallway lamp').map((e) => e.entityId);
    expect(named.sort()).toEqual(['light.hallway_lamp', 'light.hallway_lamp_old_pairing', 'light.landing_light']);
    const undone = await adapter.registryUpdate('light.landing_light', { name: previous });
    expect(undone.name).toBe('Landing Light');
  });

  it('predicts the friendly name Home Assistant shows for every entity, legacy names on devices included', async () => {
    const socket = await adapter.socket();
    const ids = (await socket.command<Array<{ entity_id: string }>>('config/entity_registry/list')).map((e) => e.entity_id);
    const entries = await socket.command<Record<string, HaEntityEntry | null>>('config/entity_registry/get_entries', { entity_ids: ids });
    const devices = new Map((await socket.command<HaDeviceEntry[]>('config/device_registry/list')).map((d) => [d.id, d]));
    const states = new Map((await adapter.rest.states()).map((st) => [st.entity_id, st]));
    let checked = 0;
    let legacyOnDevice = 0;
    for (const entry of Object.values(entries)) {
      const state = entry ? states.get(entry.entity_id) : undefined;
      if (!entry || !state) continue;
      const device = entry.device_id ? devices.get(entry.device_id) : undefined;
      if (device && !entry.has_entity_name) legacyOnDevice++;
      expect(expectedFriendlyName(entry, device), entry.entity_id).toBe(state.attributes['friendly_name']);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
    expect(legacyOnDevice).toBeGreaterThanOrEqual(2);
    expect(states.get('sensor.hallway_bridge_firmware_version')?.attributes['friendly_name']).toBe('Hallway Bridge Firmware version');
  });

  it('refuses every way a call can reach the garage door or the lock, and neither moves', async () => {
    const socket = await adapter.socket();
    const find = async <T extends { name: string }>(list: string, create: string, name: string, extra: Record<string, unknown> = {}) =>
      (await socket.command<T[]>(list)).find((x) => x.name === name) ?? (await socket.command<T>(create, { name, ...extra }));
    const floor = await find<{ floor_id: string; name: string }>('config/floor_registry/list', 'config/floor_registry/create', 'Ground floor');
    const area = await find<{ area_id: string; name: string }>('config/area_registry/list', 'config/area_registry/create', 'Garage', { floor_id: floor.floor_id });
    const label = await find<{ label_id: string; name: string }>('config/label_registry/list', 'config/label_registry/create', 'Outside');
    await socket.command('config/entity_registry/update', { entity_id: 'cover.garage_door', area_id: area.area_id, labels: [label.label_id] });
    const { device_id: garageDevice } = await socket.command<{ device_id: string }>('config/entity_registry/get', { entity_id: 'cover.garage_door' });
    const before = await Promise.all(['cover.garage_door', 'lock.front_door'].map((id) => adapter.rest.state(id)));
    const shapes: Array<[string, string, Record<string, unknown>]> = [
      ['homeassistant', 'toggle', { area_id: area.area_id }],
      ['homeassistant', 'toggle', { device_id: garageDevice }],
      ['homeassistant', 'toggle', { target: { floor_id: floor.floor_id } }],
      ['homeassistant', 'toggle', { label_id: label.label_id }],
      ['homeassistant', 'turn_off', { entity_id: 'all' }],
      ['cover', 'open_cover', { entity_id: 'all' }],
      ['lock', 'unlock', { entity_id: 'lock.front_door' }],
      ['homeassistant', 'turn_off', { entity_id: 'lock.front_door' }],
      ['cover', 'open_cover', { entity_id: 'cover.garage_door' }],
    ];
    for (const [domain, service, data] of shapes) {
      const err = await timed('callService refused', () => adapter.callService(domain, service, data)).catch((e: unknown) => e);
      expect(isHaError(err) && `${err.kind}/${err.refusal}`, `${domain}.${service} ${JSON.stringify(data)}`).toBe('refused/unsafe_device');
    }
    // Mixed case reaches the same devices (Home Assistant lower cases ids and service names). The second
    // adapter has the name rule off, so only the domain and device class rules stand between the call
    // and the garage door.
    const byClass = createHaAdapter({ baseUrl: URL_, token: TOKEN, unsafeNames: null });
    const mixed: Array<[HaAdapter, string, string, Record<string, unknown>]> = [
      [adapter, 'scene', 'apply', { entities: { 'LOCK.FRONT_DOOR': 'unlocked' } }],
      [adapter, 'LOCK', 'Unlock', { entity_id: 'lock.front_door' }],
      [adapter, 'homeassistant', 'turn_off', { entity_id: 'Lock.Front_Door' }],
      [byClass, 'cover', 'open_cover', { entity_id: 'COVER.GARAGE_DOOR' }],
      [byClass, 'homeassistant', 'toggle', { entity_id: 'Cover.garage_door' }],
      [byClass, 'Cover', 'OPEN_COVER', { target: { entity_id: ['cover.GARAGE_door'] } }],
    ];
    for (const [ha, domain, service, data] of mixed) {
      const err = await ha.callService(domain, service, data).catch((e: unknown) => e);
      expect(isHaError(err) && `${err.kind}/${err.refusal}`, `${domain}.${service} ${JSON.stringify(data)}`).toBe('refused/unsafe_device');
    }
    byClass.close();
    // Calls whose reach the guard cannot see: integration services (the MQTT shape that opens a
    // Zigbee2MQTT garage opener, even with a harmless entity added; a notification), a script started
    // through the generic domain, a call with no target. The fixture has no MQTT, so a refusal rather
    // than a 400 is what proves the guard; the notification and the script are checked as not done.
    const porchBefore = await adapter.rest.state('light.porch_light');
    const unchecked: Array<[string, string, Record<string, unknown>]> = [
      ['mqtt', 'publish', { entity_id: 'light.porch_light', topic: 'zigbee2mqtt/garage_opener/set', payload: '{"state":"OPEN"}' }],
      ['persistent_notification', 'create', { notification_id: 'fixwright_guard_probe', message: 'guard probe' }],
      ['homeassistant', 'turn_on', { entity_id: ROUTINE_SCRIPT.toUpperCase() }],
      ['input_boolean', 'turn_on', {}],
    ];
    for (const [domain, service, data] of unchecked) {
      const err = await timed('callService refused', () => adapter.callService(domain, service, data)).catch((e: unknown) => e);
      expect(isHaError(err) && `${err.kind}/${err.refusal}`, `${domain}.${service} ${JSON.stringify(data)}`).toBe('refused/unverified');
    }
    const notes = await socket.command<Array<{ notification_id: string }>>('persistent_notification/get');
    expect(notes.map((n) => n.notification_id)).not.toContain('fixwright_guard_probe');
    const porchAfter = await adapter.rest.state('light.porch_light');
    expect(`${porchAfter.state}@${porchAfter.last_changed}`).toBe(`${porchBefore.state}@${porchBefore.last_changed}`);
    const after = await Promise.all(['cover.garage_door', 'lock.front_door'].map((id) => adapter.rest.state(id)));
    expect(after.map((st) => `${st.state}@${st.last_changed}`)).toEqual(before.map((st) => `${st.state}@${st.last_changed}`));
    // A safe call on an area still goes through.
    const hall = (await socket.command<Array<{ area_id: string; name: string }>>('config/area_registry/list')).find((a) => a.name === CIRCUIT.area);
    await adapter.callService('light', 'turn_off', { area_id: hall?.area_id });
  });

  it('lists what each automation refers to, including a plug that no longer exists (dead trigger)', async () => {
    const list = await timed('listEntities', () => adapter.listEntities());
    const ids = new Set(list.map((e) => e.entityId));
    const grow = list.find((e) => e.entityId === DEAD_TRIGGER.automation);
    expect(grow?.attributes['references']).toEqual([DEAD_TRIGGER.missing]);
    expect(ids.has(DEAD_TRIGGER.missing)).toBe(false);
    const restore = await timed('getEntity automation', () => adapter.getEntity(CIRCUIT.restoreAutomation));
    expect(restore?.attributes['references']).toEqual([CIRCUIT.mains, CIRCUIT.restoreLog].sort());
    expect(EntitySchema.safeParse(grow).success).toBe(true);
  });

  it('sees a real radio dropout as unavailable and counts it as a flap', async () => {
    expect(await unavailable(fx, 'light.porch_light')).toBe('link');
    expect((await adapter.getEntity('light.porch_light'))?.state).toBe('unavailable');
    await available(fx, 'light.porch_light');
    await recorderFlush();
    const sig = await adapter.signals('light.porch_light');
    expect(sig.flaps24h).toBeGreaterThanOrEqual(1);
    expect(sig.linkQuality).toBe(38);
  });

  it('reads signals, integrations and cloud status', async () => {
    const lamp = await adapter.signals(CIRCUIT.lamp);
    expect(lamp).toMatchObject({ linkQuality: 148, powerOnBehavior: 'on' });
    expect(SignalsSchema.safeParse(lamp).success).toBe(true);
    expect((await adapter.signals('switch.hallway_smart_plug')).rssi).toBe(-61);
    expect((await adapter.signals('binary_sensor.hall_motion')).batteryPct).toBe(64);
    const ints = await timed('integrations', () => adapter.integrations());
    expect(ints.every((i) => IntegrationStatusSchema.safeParse(i).success)).toBe(true);
    expect(ints.find((i) => i.integration === 'demo')?.state).toBe('loaded');
    const cloud = await timed('cloudStatus', () => adapter.cloudStatus('ecobee'));
    expect(cloud).toMatchObject({ vendor: 'ecobee', status: 'unknown', source: 'not available from Home Assistant' });
    expect(CloudStatusSchema.safeParse(cloud).success).toBe(true);
  });

  it('flashes the lamp with read-back each time, and refuses a lock', async () => {
    for (const service of ['turn_on', 'turn_off', 'turn_on', 'turn_off']) {
      const { changed } = await timed('callService (flash step)', () => adapter.callService('light', service, { entity_id: CIRCUIT.lamp }));
      expect(changed.find((e) => e.entityId === CIRCUIT.lamp)?.state).toBe(service === 'turn_on' ? 'on' : 'off');
      expect((await adapter.getEntity(CIRCUIT.lamp))?.state).toBe(service === 'turn_on' ? 'on' : 'off');
    }
    const refused = await adapter.callService('lock', 'unlock', { entity_id: 'lock.front_door' }).catch((e: unknown) => e);
    expect(isHaError(refused) && refused.kind).toBe('refused');
    expect((await adapter.rest.state('lock.front_door')).state).toBe('locked');
    const garage = await adapter.callService('cover', 'open_cover', { entity_id: 'cover.garage_door' }).catch((e: unknown) => e);
    expect(isHaError(garage) && garage.kind).toBe('refused');
  });

  it('reports a wrong token as auth, spending one rejected login however many calls start at once', async () => {
    const loginsBefore = rejectedLogins();
    const wrong = createHaAdapter({ baseUrl: URL_, token: 'not-a-token', retry: { retries: 0 } });
    // The engine's checkup shape: many reads at once, REST and websocket alike.
    const first = await Promise.all(
      [wrong.listEntities(), wrong.signals(CIRCUIT.lamp), wrong.integrations(), wrong.events({ since: new Date(Date.now() - 60_000).toISOString() }), wrong.hubStatus()].map(
        (p) => p.catch((e: unknown) => e),
      ),
    );
    expect(first.map((e) => isHaError(e) && e.kind)).toEqual(['auth', 'auth', 'auth', 'auth', 'auth']);
    // Within the hold nothing more is sent.
    const again = await wrong.getEntity(CIRCUIT.lamp).catch((e: unknown) => e);
    expect(isHaError(again) && again.kind).toBe('auth');
    wrong.close();
    if (loginsBefore !== undefined) {
      await sleep(500); // Home Assistant writes its log from a queue
      const spent = (rejectedLogins() ?? 0) - loginsBefore;
      counts['rejected logins for 6 calls with a wrong token'] = spent;
      expect(spent).toBe(1);
    }
    const nowhere = createHaAdapter({ baseUrl: 'http://127.0.0.1:8749', token: TOKEN, retry: { retries: 0 }, timeoutMs: 2000 });
    expect(await nowhere.hubStatus()).toEqual({ reachable: false });
    const missing = await adapter.rest.state('light.does_not_exist').catch((e: unknown) => e);
    expect(isHaError(missing) && missing.kind).toBe('not_found');
  });
});
