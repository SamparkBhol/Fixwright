import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EntitySchema, HouseEventSchema, IntegrationStatusSchema, SignalsSchema, CloudStatusSchema } from '@fixwright/protocol';
import type { HaConfigEntry, HaDeviceEntry, HaEntityEntry, HaHistoryPoint, HaState, LogbookRow } from '../src/ha-types.ts';
import {
  buildEntities,
  causeOf,
  CLOUD_UNKNOWN_SOURCE,
  cloudStatusFrom,
  contextFromRow,
  countFlaps,
  expectedFriendlyName,
  historyTransitions,
  inferTransport,
  isBatterySensor,
  isUptimeSensor,
  mergeEvents,
  nameFromEntityId,
  normalizePowerOn,
  reauthEntries,
  relatedEntityIds,
  signalsFrom,
  toEntity,
  toIntegrationStatus,
  toIso,
  uptimeResets,
  type Registries,
} from '../src/map.ts';
import { haEntry, haState } from './fake-ha.ts';

const recorded = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/recorded/${name}.json`, import.meta.url), 'utf8')) as T;
const powerCut = recorded<{ since: string; until: string; logbook: LogbookRow[]; history: Record<string, HaHistoryPoint[]> }>('power-cut');
const registry = recorded<{ entries: Record<string, HaEntityEntry>; devices: HaDeviceEntry[]; areas: Array<{ area_id: string; name: string }> }>('registry');
const states = recorded<{ states: HaState[]; config_entries: HaConfigEntry[] }>('states');

const NOW = '2026-10-15T12:00:00.000Z';
const CIRCUIT = ['light.hallway_lamp', 'light.porch_light', 'light.landing_light', 'light.stair_light', 'light.entry_light', 'switch.hallway_smart_plug'];

function regs(entries: HaEntityEntry[] = [], devices: HaDeviceEntry[] = [], over: Partial<Registries> = {}): Registries {
  return {
    entries: new Map(entries.map((e) => [e.entity_id, e])),
    devices: new Map(devices.map((d) => [d.id, d])),
    areas: new Map(registry.areas.map((a) => [a.area_id, a])),
    manifests: new Map(),
    ...over,
  };
}

const device = (over: Partial<HaDeviceEntry> = {}): HaDeviceEntry => ({
  id: 'dev1',
  name: 'Hue white lamp',
  name_by_user: null,
  manufacturer: 'Signify',
  model: 'LWB010',
  area_id: 'living_room',
  config_entries: [],
  connections: [],
  identifiers: [],
  via_device_id: null,
  disabled_by: null,
  ...over,
});

describe('time', () => {
  it('turns websocket seconds and REST offsets into the protocol ISO form', () => {
    expect(toIso(1792064655.513146)).toBe('2026-10-15T11:44:15.513Z');
    expect(toIso('2026-10-15T11:44:15.513146+00:00')).toBe('2026-10-15T11:44:15.513Z');
    expect(toIso('2026-10-15T04:44:15-07:00')).toBe('2026-10-15T11:44:15.000Z');
    expect(toIso('garbage')).toBeUndefined();
    expect(toIso(null)).toBeUndefined();
  });
});

describe('entities (recorded 2026.9.4 registry and states)', () => {
  const entries = Object.values(registry.entries);
  const reg = regs(entries, registry.devices);
  const all = buildEntities(states.states, reg, NOW);
  const byId = new Map(all.map((e) => [e.entityId, e]));

  it('maps every recorded state to a schema-valid Entity', () => {
    expect(all.length).toBe(states.states.length);
    for (const e of all) expect(EntitySchema.safeParse(e).success, e.entityId).toBe(true);
  });

  it('maps the live lamp: spoken name, area from the registry, simulated Zigbee from linkquality', () => {
    const lamp = byId.get('light.hallway_lamp');
    expect(lamp).toMatchObject({
      name: 'Hallway Lamp',
      aliases: [],
      domain: 'light',
      area: 'Hallway',
      integration: 'template',
      transport: 'zigbee',
      disabled: false,
    });
    expect(lamp?.lastChanged).toMatch(/Z$/);
    expect(lamp?.registryOnly).toBeUndefined();
  });

  it('maps the old pairing under the same spoken name, unavailable', () => {
    const ghost = byId.get('light.hallway_lamp_old_pairing');
    expect(ghost).toMatchObject({ name: 'Hallway Lamp', state: 'unavailable', area: 'Hallway' });
  });

  it('marks a restored ghost and a registry-only entity', () => {
    const entry = haEntry('light.ghost', { original_name: 'Hallway Lamp', modified_at: 1792064000 });
    const restored = toEntity({ entityId: 'light.ghost', state: haState('light.ghost', 'unavailable', { restored: true, friendly_name: 'Hallway Lamp' }), entry, fallbackIso: NOW });
    expect(restored.restored).toBe(true);
    expect(restored.registryOnly).toBeUndefined();
    const disabledEntry = haEntry('light.off', { original_name: 'Old Lamp', disabled_by: 'user', modified_at: 1792064000 });
    const registryOnly = toEntity({ entityId: 'light.off', entry: disabledEntry, fallbackIso: NOW });
    expect(registryOnly).toMatchObject({ registryOnly: true, disabled: true, state: 'unavailable', name: 'Old Lamp' });
    expect(registryOnly.lastChanged).toBe(new Date(1792064000 * 1000).toISOString());
    expect(EntitySchema.safeParse(registryOnly).success).toBe(true);
  });

  it('includes registry entries without a state when listing', () => {
    const extra = haEntry('switch.disabled_plug', { disabled_by: 'user', original_name: 'Disabled Plug' });
    const list = buildEntities(states.states, regs([...entries, extra], registry.devices), NOW);
    expect(list.find((e) => e.entityId === 'switch.disabled_plug')).toMatchObject({ registryOnly: true, disabled: true });
  });

  it('takes aliases from the registry, leaving out the computed-name placeholder', () => {
    const entry = haEntry('light.a', { aliases: [null, 'hall lamp', ' ', 'the big lamp'] });
    expect(toEntity({ entityId: 'light.a', entry, fallbackIso: NOW }).aliases).toEqual(['hall lamp', 'the big lamp']);
  });

  it('uses device vendor, model and the device area when the entity has none', () => {
    const d = device();
    const entry = haEntry('light.hue_1', { platform: 'hue', device_id: 'dev1', has_entity_name: true, original_name: null });
    const e = buildEntities([haState('light.hue_1', 'on', { friendly_name: 'Hue white lamp' })], regs([entry], [d]), NOW)[0];
    expect(e).toMatchObject({ vendor: 'Signify', model: 'LWB010', area: 'Living Room', deviceId: 'dev1', integration: 'hue', transport: 'zigbee' });
  });

  it('names Zigbee2MQTT devices as such and falls back to the entity id for a name', () => {
    const d = device({ identifiers: [['mqtt', 'zigbee2mqtt_0x00158d0001a2b3c4']] });
    const entry = haEntry('light.z', { platform: 'mqtt', device_id: 'dev1' });
    const e = toEntity({ entityId: 'light.z', entry, device: d, fallbackIso: NOW });
    expect(e.integration).toBe('zigbee2mqtt');
    expect(e.transport).toBe('zigbee');
    expect(nameFromEntityId('light.porch_light_2')).toBe('Porch Light 2');
  });
});

describe('expectedFriendlyName', () => {
  it('follows Home Assistant: an override wins, else device name plus entity name', () => {
    expect(expectedFriendlyName(haEntry('light.a', { name: 'Desk', original_name: 'Light' }), device())).toBe('Desk');
    expect(expectedFriendlyName(haEntry('light.a', { original_name: 'Light', has_entity_name: true }), device())).toBe('Hue white lamp Light');
    expect(expectedFriendlyName(haEntry('light.a', { original_name: null, has_entity_name: true }), device({ name_by_user: 'Desk Lamp' }))).toBe('Desk Lamp');
    expect(expectedFriendlyName(haEntry('light.a', { original_name: 'Hallway Lamp' }), undefined)).toBe('Hallway Lamp');
    expect(expectedFriendlyName(haEntry('light.a'), undefined)).toBeUndefined();
  });

  it('predicts every recorded friendly name, including legacy entities on a device (registry sends "Signal")', () => {
    const devices = new Map(registry.devices.map((d) => [d.id, d]));
    const byId = new Map(states.states.map((st) => [st.entity_id, st]));
    const checked = Object.values(registry.entries).filter((e) => byId.has(e.entity_id));
    for (const e of checked) {
      const dev = e.device_id ? devices.get(e.device_id) : undefined;
      expect(expectedFriendlyName(e, dev), e.entity_id).toBe(byId.get(e.entity_id)?.attributes['friendly_name']);
    }
    expect(checked.filter((e) => e.device_id && !e.has_entity_name).map((e) => e.entity_id).sort()).toEqual([
      'sensor.hallway_bridge_firmware_version',
      'sensor.hallway_bridge_signal',
    ]);
  });

  it('prefixes legacy entities on a device too, as 2026.9 does with the unprefixed name the registry API sends', () => {
    // has_entity_name false, original_name "Hue white lamp Battery" stored, API sends "Battery".
    expect(expectedFriendlyName(haEntry('sensor.b', { original_name: 'Battery', has_entity_name: false }), device())).toBe('Hue white lamp Battery');
    // A legacy entity named exactly like its device: the stripped name is "" and the device name stays.
    expect(expectedFriendlyName(haEntry('light.a', { original_name: '', has_entity_name: false }), device())).toBe('Hue white lamp');
  });
});

describe('inferTransport', () => {
  const base = { entityId: 'light.x', integration: 'unknown_thing' };
  it('prefers hints, then radio connections, then integration tables', () => {
    expect(inferTransport({ ...base, hints: { 'light.x': 'thread' } })).toBe('thread');
    expect(inferTransport({ ...base, hints: { unknown_thing: 'cloud' } })).toBe('cloud');
    expect(inferTransport({ ...base, device: device({ connections: [['zigbee', '00:11']] }) })).toBe('zigbee');
    expect(inferTransport({ ...base, integration: 'zha' })).toBe('zigbee');
    expect(inferTransport({ ...base, integration: 'matter' })).toBe('thread');
    expect(inferTransport({ ...base, integration: 'tplink' })).toBe('wifi');
    expect(inferTransport({ ...base, integration: 'ecobee' })).toBe('cloud');
  });
  it('reads what the entity reports, then the manifest', () => {
    expect(inferTransport({ ...base, attributes: { linkquality: 80 } })).toBe('zigbee');
    expect(inferTransport({ ...base, attributes: { rssi: -70 } })).toBe('wifi');
    expect(inferTransport({ ...base, manifest: { iotClass: 'cloud_polling' } })).toBe('cloud');
    expect(inferTransport({ ...base, manifest: { iotClass: 'local_push', integrationType: 'helper' } })).toBe('virtual');
    expect(inferTransport({ ...base, integration: 'template' })).toBe('virtual');
  });
  it('maps unknown local devices to wifi and unknown device-less entities to virtual', () => {
    expect(inferTransport({ ...base, device: device({ connections: [['mac', 'aa:bb']] }) })).toBe('wifi');
    expect(inferTransport({ ...base, device: device() })).toBe('wifi');
    expect(inferTransport(base)).toBe('virtual');
  });
});

describe('integrations', () => {
  const entry = (over: Partial<HaConfigEntry>): HaConfigEntry => ({ entry_id: 'e1', domain: 'hue', title: 'Hue', source: 'user', state: 'loaded', reason: null, disabled_by: null, ...over });
  it('maps config entry states', () => {
    const none = new Set<string>();
    expect(toIntegrationStatus(entry({}), none)).toEqual({ integration: 'hue', entryId: 'e1', state: 'loaded' });
    expect(toIntegrationStatus(entry({ state: 'setup_retry', reason: 'Bridge unreachable' }), none)).toMatchObject({ state: 'setup_retry', reason: 'Bridge unreachable' });
    expect(toIntegrationStatus(entry({ state: 'migration_error' }), none)).toMatchObject({ state: 'setup_error', reason: 'migration_error' });
    expect(toIntegrationStatus(entry({ state: 'setup_in_progress' }), none)).toMatchObject({ state: 'not_loaded' });
    expect(toIntegrationStatus(entry({ disabled_by: 'user', state: 'not_loaded' }), none)).toMatchObject({ state: 'not_loaded', reason: 'disabled by user' });
  });
  it('flags expired links as auth, from a reauth flow or the failure reason', () => {
    const flows = reauthEntries([
      { flow_id: 'f1', handler: 'hue', context: { source: 'reauth', entry_id: 'e1' } },
      { flow_id: 'f2', handler: 'met', context: { source: 'user' } },
    ]);
    expect([...flows]).toEqual(['e1']);
    const viaFlow = toIntegrationStatus(entry({ state: 'setup_error', reason: null }), flows);
    expect(viaFlow.state).toBe('setup_error');
    expect(viaFlow.reason).toMatch(/^auth: /);
    const viaReason = toIntegrationStatus(entry({ entry_id: 'e2', state: 'setup_error', reason: 'Invalid authentication' }), new Set());
    expect(viaReason.reason).toBe('auth: Invalid authentication');
    expect(IntegrationStatusSchema.safeParse(viaReason).success).toBe(true);
  });
  it('maps the recorded config entries', () => {
    const out = states.config_entries.map((e) => toIntegrationStatus(e, new Set()));
    expect(out.every((s) => IntegrationStatusSchema.safeParse(s).success)).toBe(true);
    expect(out.find((s) => s.integration === 'demo')?.state).toBe('loaded');
  });
});

describe('cloudStatusFrom', () => {
  const input = { vendor: 'ecobee', checkedAt: NOW, states: [] as HaState[], entries: [] as HaConfigEntry[], registry: new Map(), devices: new Map(), cloudDomains: new Set(['ecobee']) };
  it('says unknown, plainly, when nothing in Home Assistant speaks to the vendor cloud', () => {
    const out = cloudStatusFrom(input);
    expect(out).toEqual({ vendor: 'ecobee', status: 'unknown', source: CLOUD_UNKNOWN_SOURCE, checkedAt: NOW });
    expect(out.source).toBe('not available from Home Assistant');
    expect(CloudStatusSchema.safeParse(out).success).toBe(true);
  });
  it('reads a cloud connectivity sensor an integration exposes', () => {
    const sensor = haState('binary_sensor.ecobee_cloud_connection', 'off', { device_class: 'connectivity', friendly_name: 'Ecobee cloud connection' });
    expect(cloudStatusFrom({ ...input, states: [sensor] }).status).toBe('outage');
    expect(cloudStatusFrom({ ...input, states: [{ ...sensor, state: 'on' }] }).status).toBe('ok');
    const other = haState('binary_sensor.router_cloud', 'off', { device_class: 'connectivity' });
    expect(cloudStatusFrom({ ...input, states: [other] }).status).toBe('unknown');
  });
  it('treats a cloud integration stuck retrying as degraded', () => {
    const retry: HaConfigEntry = { entry_id: 'e', domain: 'ecobee', title: 'ecobee', source: 'user', state: 'setup_retry', reason: 'Timeout' };
    const out = cloudStatusFrom({ ...input, entries: [retry] });
    expect(out.status).toBe('degraded');
    expect(out.source).toMatch(/retrying the ecobee cloud integration: Timeout/);
    expect(cloudStatusFrom({ ...input, entries: [retry], cloudDomains: new Set() }).status).toBe('unknown');
  });
});

describe('signals', () => {
  it('reads Zigbee2MQTT style attributes on the entity', () => {
    const s = signalsFrom({ state: haState('light.a', 'on', { linkquality: 148, battery: 87, last_seen: '2026-10-15T11:00:00+00:00', power_on_behavior: 'previous' }), related: [] });
    expect(s).toEqual({ linkQuality: 148, batteryPct: 87, lastSeen: '2026-10-15T11:00:00.000Z', powerOnBehavior: 'previous' });
  });
  it('reads related sensors and the power on select, by device or by name', () => {
    const related = [
      { state: haState('select.lamp_power_on_behavior', 'on', { options: ['off', 'on', 'toggle', 'previous'] }) },
      { state: haState('sensor.lamp_linkquality', '54') },
      { state: haState('sensor.lamp_battery', '12', { device_class: 'battery', unit_of_measurement: '%' }) },
      { state: haState('sensor.lamp_last_seen', '2026-10-15T09:00:00+00:00') },
      { state: haState('sensor.plug_wifi', '-71', { device_class: 'signal_strength', unit_of_measurement: 'dBm' }) },
      { state: haState('sensor.lamp_uptime', '2', { unit_of_measurement: 'h' }) },
    ];
    const s = signalsFrom({ state: haState('light.lamp', 'on'), related, flaps24h: 3 });
    expect(s).toEqual({ linkQuality: 54, rssi: -71, batteryPct: 12, lastSeen: '2026-10-15T09:00:00.000Z', uptimeS: 7200, powerOnBehavior: 'on', flaps24h: 3 });
    expect(SignalsSchema.safeParse(s).success).toBe(true);
  });
  it('reads a ZHA start up select by translation key', () => {
    const entry = haEntry('select.bulb_start_up_behavior', { translation_key: 'start_up_on_off' });
    const s = signalsFrom({ related: [{ state: haState('select.bulb_some_select', 'PreviousValue'), entry }] });
    expect(s.powerOnBehavior).toBe('previous');
  });
  it('drops out of range or unavailable values instead of clamping them', () => {
    const s = signalsFrom({
      state: haState('light.a', 'on', { linkquality: 300, rssi: 40, battery: -5 }),
      related: [{ state: haState('sensor.a_battery', 'unavailable', { device_class: 'battery' }) }],
    });
    expect(s).toEqual({});
  });
  it('accepts last_seen as epoch milliseconds', () => {
    expect(signalsFrom({ state: haState('light.a', 'on', { last_seen: 1792058400000 }), related: [] }).lastSeen).toBe('2026-10-15T10:00:00.000Z');
  });
  it('normalizes power on spellings', () => {
    expect(normalizePowerOn('PreviousValue')).toBe('previous');
    expect(normalizePowerOn('Toggle')).toBe('toggle');
    expect(normalizePowerOn('OFF')).toBe('off');
    expect(normalizePowerOn('custom')).toBeUndefined();
    expect(normalizePowerOn(3)).toBeUndefined();
  });
  it('finds related entities on the same device, else by Zigbee2MQTT naming', () => {
    const entries = new Map([
      ['light.a', haEntry('light.a', { device_id: 'd1' })],
      ['sensor.a_battery', haEntry('sensor.a_battery', { device_id: 'd1' })],
      ['sensor.other', haEntry('sensor.other', { device_id: 'd2' })],
    ]);
    expect(relatedEntityIds('light.a', { entries }, [])).toEqual(['sensor.a_battery']);
    const ids = ['select.hallway_lamp_power_on_behavior', 'sensor.hallway_lamp_linkquality', 'select.hallway_lamp_old_pairing_power_on_behavior', 'light.hallway_lamp'];
    expect(relatedEntityIds('light.hallway_lamp', { entries: new Map() }, ids).sort()).toEqual(['select.hallway_lamp_power_on_behavior', 'sensor.hallway_lamp_linkquality']);
  });
  it('counts flaps as transitions into unavailable', () => {
    const pts: HaHistoryPoint[] = ['on', 'unavailable', 'unavailable', 'on', 'unavailable', 'off'].map((s, i) => ({ s, lu: 1792058400 + i }));
    expect(countFlaps(pts)).toBe(2);
    expect(countFlaps([{ s: 'unavailable', lu: 1 }])).toBe(0);
  });
});

describe('logbook context', () => {
  it('maps a user service call', () => {
    const ctx = contextFromRow({ when: 1, context_user_id: 'u1', context_domain: 'light', context_service: 'turn_on', context_event_type: 'call_service' });
    expect(ctx).toEqual({ userId: 'u1', service: 'light.turn_on', eventType: 'call_service' });
    expect(causeOf(ctx)).toBe('user');
  });
  it('maps an automation, even when the person who triggered it is attached', () => {
    const ctx = contextFromRow({ when: 1, context_event_type: 'automation_triggered', context_domain: 'automation', context_entity_id: 'automation.night', context_user_id: 'u1' });
    expect(ctx).toMatchObject({ automationId: 'automation.night', userId: 'u1' });
    expect(causeOf(ctx)).toBe('automation');
  });
  it('maps a script, and leaves a state-change origin with no cause', () => {
    expect(contextFromRow({ when: 1, context_event_type: 'script_started', context_entity_id: 'script.flash' })).toMatchObject({ service: 'script.flash' });
    expect(causeOf({ service: 'script.flash' })).toBe('service');
    expect(contextFromRow({ when: 1, context_entity_id: 'binary_sensor.mains', context_state: 'off' })).toBeUndefined();
    expect(causeOf(undefined)).toBe('none');
  });
});

describe('events from the recorded power cut and restore', () => {
  const sinceMs = Date.parse(powerCut.since);
  const untilMs = Date.parse(powerCut.until);
  const transitions = historyTransitions(powerCut.history, sinceMs);
  const events = mergeEvents(transitions, powerCut.logbook, { sinceMs, untilMs, numericChanges: 'drop' });

  it('produces schema-valid events in time order', () => {
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(HouseEventSchema.safeParse(e).success).toBe(true);
    const ts = events.map((e) => e.ts);
    expect([...ts].sort()).toEqual(ts);
    expect(events.every((e) => e.seq === 0 && e.source === 'home')).toBe(true);
  });

  it('treats the first history point as the baseline, not a change', () => {
    expect(transitions.filter((t) => t.entityId === 'light.hallway_lamp').map((t) => `${t.from}->${t.to}`)).toEqual(['off->unavailable', 'unavailable->on']);
  });

  it('attributes the breaker to the person, with the service they called', () => {
    const breaker = events.filter((e) => e.entityId === 'input_boolean.hallway_mains');
    expect(breaker.map((e) => `${e.from}->${e.to}:${causeOf(e.context)}:${e.context?.service}`)).toEqual([
      'on->off:user:input_boolean.turn_off',
      'off->on:user:input_boolean.turn_on',
    ]);
  });

  it('shows all six devices going unavailable and coming back on with no context at all', () => {
    for (const id of CIRCUIT) {
      const own = events.filter((e) => e.entityId === id);
      expect(own.map((e) => `${e.kind}:${e.from}->${e.to}`), id).toEqual(['availability:off->unavailable', 'availability:unavailable->on']);
      expect(own.every((e) => causeOf(e.context) === 'none'), id).toBe(true);
      expect(own[1]?.data?.['contextEntityId']).toBe('binary_sensor.hallway_mains_power');
    }
  });

  it('shows the restore log automation run and its write as automation', () => {
    const run = events.find((e) => e.kind === 'automation_run');
    expect(run).toMatchObject({ entityId: 'automation.hallway_power_restore_log', context: { automationId: 'automation.hallway_power_restore_log' } });
    expect(run?.data?.['trigger']).toBe('state of binary_sensor.hallway_mains_power');
    const log = events.find((e) => e.entityId === 'input_datetime.hallway_last_power_restore');
    expect(causeOf(log?.context)).toBe('automation');
  });

  it('includes sensors from history even though the logbook leaves them out, and drops numeric wiggles', () => {
    const plug = events.filter((e) => e.entityId === 'sensor.hallway_plug_power');
    expect(plug.map((e) => `${e.from}->${e.to}`)).toEqual(['0.4->unavailable', 'unavailable->7.5']);
    const wiggle = mergeEvents([{ entityId: 'sensor.p', t: sinceMs + 5, from: '0.4', to: '7.5' }], [], { sinceMs, untilMs, numericChanges: 'drop' });
    expect(wiggle).toEqual([]);
    const kept = mergeEvents([{ entityId: 'sensor.p', t: sinceMs + 5, from: '0.4', to: '7.5' }], [], { sinceMs, untilMs, numericChanges: 'keep' });
    expect(kept).toHaveLength(1);
  });

  it('marks the plug restarting after the recorded power cut as an uptime reset, and drops its ticks', () => {
    const plug = events.filter((e) => e.entityId === 'sensor.hallway_smart_plug_uptime');
    expect(plug.map((e) => `${e.from}->${e.to}:${e.data?.['uptime_reset'] === true ? 'reset' : '-'}`)).toEqual(['6->unavailable:-', 'unavailable->1:reset']);
  });

  it('keeps battery levels and marks uptime resets as restarts, also across an unavailable gap', () => {
    const t = (s: number) => sinceMs + s * 1000;
    const tr = (entityId: string, s: number, from: string, to: string) => ({ entityId, t: t(s), from, to });
    const out = mergeEvents(
      [
        tr('sensor.plug_uptime', 1, '4000', '4001'),
        tr('sensor.plug_uptime', 2, '4001', '3'),
        tr('sensor.plug_uptime', 3, '3', 'unavailable'),
        tr('sensor.plug_uptime', 4, 'unavailable', '1'),
        tr('sensor.motion_battery', 5, '15', '14'),
        tr('sensor.plug_power', 6, '0.4', '7.5'),
      ],
      [],
      { sinceMs, untilMs: t(60), numericChanges: 'drop' },
    );
    expect(out.map((e) => `${e.entityId}:${e.from}->${e.to}:${e.data?.['uptime_reset'] === true ? 'reset' : '-'}`)).toEqual([
      'sensor.plug_uptime:4001->3:reset',
      'sensor.plug_uptime:3->unavailable:-',
      'sensor.plug_uptime:unavailable->1:reset',
      'sensor.motion_battery:15->14:-',
    ]);
    const all = mergeEvents([tr('sensor.plug_uptime', 1, '4000', '4001'), tr('sensor.plug_uptime', 2, '4001', '3')], [], { sinceMs, untilMs, numericChanges: 'keep' });
    expect(all.map((e) => e.data?.['uptime_reset'] ?? false)).toEqual([false, true]);
    // A battery sensor known by its device class, whatever its id.
    const byClass = mergeEvents([tr('sensor.door_power_level', 1, '30', '29'), tr('sensor.plug_power', 2, '0.4', '7.5')], [], {
      sinceMs,
      untilMs,
      numericChanges: 'drop',
      batteryIds: new Set(['sensor.door_power_level']),
    });
    expect(byClass.map((e) => e.entityId)).toEqual(['sensor.door_power_level']);
  });

  it('reads a boot timestamp that jumps forward as a restart, and small drift as nothing', () => {
    const boot = (iso: string) => iso;
    const out = uptimeResets([
      { entityId: 'sensor.plug_last_restart', t: 1, from: boot('2026-10-14T03:00:00+00:00'), to: boot('2026-10-14T03:00:20+00:00') },
      { entityId: 'sensor.plug_last_restart', t: 2, from: boot('2026-10-14T03:00:20+00:00'), to: boot('2026-10-15T03:12:01+00:00') },
      { entityId: 'sensor.temperature', t: 3, from: '30', to: '2' },
    ]);
    expect([...out].map((x) => x.t)).toEqual([2]);
    expect(isUptimeSensor('sensor.esp_uptime')).toBe(true);
    expect(isUptimeSensor('binary_sensor.uptime')).toBe(false);
    expect(isBatterySensor('sensor.hall_motion_battery')).toBe(true);
  });

  it('keeps logbook rows that history did not cover, and Home Assistant start rows', () => {
    const rows: LogbookRow[] = [
      { when: (sinceMs + 10) / 1000, entity_id: 'light.not_queried', state: 'on', context_user_id: 'u1', context_event_type: 'call_service', context_domain: 'light', context_service: 'turn_on' },
      { when: (sinceMs + 20) / 1000, name: 'Home Assistant', message: 'started', domain: 'homeassistant' },
      { when: (sinceMs - 60_000) / 1000, entity_id: 'light.too_early', state: 'on' },
    ];
    const out = mergeEvents([], rows, { sinceMs, untilMs, numericChanges: 'drop' });
    expect(out.map((e) => e.kind)).toEqual(['state', 'integration']);
    expect(out[0]).toMatchObject({ entityId: 'light.not_queried', to: 'on', context: { userId: 'u1', service: 'light.turn_on' } });
    expect(out[1]?.data).toMatchObject({ integration: 'homeassistant', message: 'started' });
  });

  it('reads REST style history too (full keys, ISO times)', () => {
    const rest: Record<string, HaHistoryPoint[]> = {
      'light.bed_light': [
        { entity_id: 'light.bed_light', state: 'off', last_changed: '2026-10-15T10:00:00+00:00', last_updated: '2026-10-15T10:00:00+00:00' },
        { state: 'on', last_changed: '2026-10-15T10:00:01.5+00:00' },
      ],
    };
    expect(historyTransitions(rest, Date.parse('2026-10-15T10:00:00Z'))).toEqual([
      { entityId: 'light.bed_light', t: Date.parse('2026-10-15T10:00:01.5Z'), from: 'off', to: 'on' },
    ]);
  });
});
