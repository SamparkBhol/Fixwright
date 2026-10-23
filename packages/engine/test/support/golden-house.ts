// The golden path house, built on the FakeAdapter:
//   F1 two "Hallway Lamp" entities: the old copy unavailable and restored since 3 Oct, the copy paired again online (Hue, Zigbee, good LQI)
//   F2 a power cut last night from 03:11:58 to 03:12:00: 14 devices across zigbee2mqtt, kasa and matter came back and turned on
//      within 4 s with no context, all with power_on_behavior 'on'
//   F3 "Living Room Light" twice: a Hue group and a Zigbee bulb
//   F4 the kitchen plug dropped off Wi-Fi 9 times today, RSSI -82
//   F5 the hall motion sensor battery at 6%
//   plus the living room power strip: outlet 1 a reading lamp, outlet 2 the aquarium filter.
// Household time is America/Los_Angeles; "now" is 15 Oct 2026 10:20 PDT.

import { manualClock, type ManualClock, type ProtectedDevice } from '@fixwright/protocol';
import { createMemoryLedger, defaultSettings, type EngineDeps, type EngineSettings, type MemoryLedger } from '../../src/index.ts';
import { addEntity, addEvent, createFakeAdapter, emptyHouse, type FakeAdapter, type FakeHouse } from './fake-adapter.ts';
import { seededRng } from '@fixwright/protocol';

export const NOW = '2026-10-15T17:20:00.000Z';
export const TZ = 'America/Los_Angeles';
export const OLD_COPY_OFFLINE = '2026-10-03T18:42:10.000Z';
export const REPAIRED_AT = '2026-10-03T18:47:31.000Z';
export const OUTAGE_START = '2026-10-15T10:11:58.000Z';
export const POWER_BACK = '2026-10-15T10:12:00.000Z';

export const FILTER: ProtectedDevice = {
  entity_id: 'switch.living_room_power_strip_outlet_2',
  name: 'Aquarium Filter',
  reason: 'The fish need it running.',
};

const at = (iso: string, plusMs: number): string => new Date(Date.parse(iso) + plusMs).toISOString();

/** The 14 devices of F2, across three integrations. */
export const F2_DEVICES: ReadonlyArray<{ id: string; name: string; integration: string; transport: 'zigbee' | 'wifi' | 'thread'; area: string }> = [
  { id: 'light.kitchen_ceiling', name: 'Kitchen Ceiling', integration: 'zigbee2mqtt', transport: 'zigbee', area: 'Kitchen' },
  { id: 'light.bedroom_lamp', name: 'Bedroom Lamp', integration: 'zigbee2mqtt', transport: 'zigbee', area: 'Bedroom' },
  { id: 'light.office_lamp', name: 'Office Lamp', integration: 'zigbee2mqtt', transport: 'zigbee', area: 'Office' },
  { id: 'light.porch_light', name: 'Porch Light', integration: 'zigbee2mqtt', transport: 'zigbee', area: 'Porch' },
  { id: 'switch.office_heater_plug', name: 'Office Heater Plug', integration: 'zigbee2mqtt', transport: 'zigbee', area: 'Office' },
  { id: 'light.dining_pendant', name: 'Dining Pendant', integration: 'zigbee2mqtt', transport: 'zigbee', area: 'Dining Room' },
  { id: 'switch.tv_plug', name: 'TV Plug', integration: 'kasa', transport: 'wifi', area: 'Living Room' },
  { id: 'switch.coffee_maker', name: 'Coffee Maker', integration: 'kasa', transport: 'wifi', area: 'Kitchen' },
  { id: 'switch.bedroom_fan_plug', name: 'Bedroom Fan Plug', integration: 'kasa', transport: 'wifi', area: 'Bedroom' },
  { id: 'switch.garden_lights', name: 'Garden Lights', integration: 'kasa', transport: 'wifi', area: 'Garden' },
  { id: 'switch.desk_plug', name: 'Desk Plug', integration: 'matter', transport: 'thread', area: 'Office' },
  { id: 'light.nursery_lamp', name: 'Nursery Lamp', integration: 'matter', transport: 'thread', area: 'Nursery' },
  { id: 'switch.patio_heater_plug', name: 'Patio Heater Plug', integration: 'matter', transport: 'thread', area: 'Patio' },
  { id: 'light.stairs_light', name: 'Stairs Light', integration: 'matter', transport: 'thread', area: 'Stairs' },
];

export interface GoldenOptions {
  /** Leave out the F2 unavailable and comeback rows (only the on transitions remain). */
  withoutOutage?: boolean;
  /** The F2 on transitions carry this automation's context. */
  automationContext?: string;
  /** Add mains power events (a SimHome circuit model reports them; Home Assistant usually does not). */
  powerEvents?: boolean;
}

export function buildGoldenHouse(opts: GoldenOptions = {}): FakeHouse {
  const h = emptyHouse();
  h.integrations = [
    { integration: 'hue', state: 'loaded', entryId: 'entry_hue' },
    { integration: 'zigbee2mqtt', state: 'loaded', entryId: 'entry_z2m' },
    { integration: 'kasa', state: 'loaded', entryId: 'entry_kasa' },
    { integration: 'matter', state: 'loaded', entryId: 'entry_matter' },
    { integration: 'template', state: 'loaded', entryId: 'entry_template' },
  ];

  // F1: the hallway lamp was paired again on 3 Oct; the old copy keeps the name.
  addEntity(h, {
    entityId: 'light.hallway_lamp',
    name: 'Hallway Lamp',
    area: 'Hallway',
    deviceId: 'dev_hallway_lamp_old',
    integration: 'hue',
    transport: 'zigbee',
    vendor: 'Philips Hue',
    model: 'LCA001',
    state: 'unavailable',
    restored: true,
    attributes: { restored: true },
    lastChanged: OLD_COPY_OFFLINE,
    lastUpdated: OLD_COPY_OFFLINE,
  });
  addEntity(
    h,
    {
      entityId: 'light.hallway_lamp_2',
      name: 'Hallway Lamp',
      area: 'Hallway',
      deviceId: 'dev_hallway_lamp',
      integration: 'hue',
      transport: 'zigbee',
      vendor: 'Philips Hue',
      model: 'LCA001',
      state: 'off',
      lastChanged: '2026-10-15T06:30:00.000Z',
      lastUpdated: '2026-10-15T06:30:00.000Z',
    },
    { linkQuality: 178, lastSeen: '2026-10-15T17:19:30.000Z' },
  );
  addEvent(h, { ts: at(OLD_COPY_OFFLINE, -3_600_000), kind: 'state', entityId: 'light.hallway_lamp', from: 'off', to: 'on', context: { userId: 'household_member' } });
  addEvent(h, { ts: OLD_COPY_OFFLINE, kind: 'availability', entityId: 'light.hallway_lamp', from: 'on', to: 'unavailable' });
  addEvent(h, { ts: REPAIRED_AT, kind: 'availability', entityId: 'light.hallway_lamp_2', from: 'unavailable', to: 'off' });

  // F2: the 14 devices and their power on behaviour selects.
  F2_DEVICES.forEach((d, i) => {
    const deviceId = `dev_${d.id.split('.')[1]}`;
    addEntity(
      h,
      { entityId: d.id, name: d.name, area: d.area, deviceId, integration: d.integration, transport: d.transport, state: 'on', lastChanged: at(POWER_BACK, i * 250 + 400) },
      { powerOnBehavior: 'on', ...(d.transport === 'wifi' ? { rssi: -58 } : { linkQuality: 150 }) },
    );
    addEntity(h, {
      entityId: `select.${d.id.split('.')[1]}_power_on_behavior`,
      name: `${d.name} Power-on behavior`,
      deviceId,
      integration: d.integration,
      transport: d.transport,
      state: 'on',
      attributes: { options: ['off', 'on', 'toggle', 'previous'] },
    });
    if (!opts.withoutOutage) {
      addEvent(h, { ts: at(OUTAGE_START, i * 15), kind: 'availability', entityId: d.id, from: 'off', to: 'unavailable' });
      addEvent(h, { ts: at(POWER_BACK, i * 250), kind: 'availability', entityId: d.id, from: 'unavailable', to: 'off' });
    }
    addEvent(h, {
      ts: at(POWER_BACK, i * 250 + 400),
      kind: 'state',
      entityId: d.id,
      from: 'off',
      to: 'on',
      ...(opts.automationContext ? { context: { automationId: opts.automationContext } } : {}),
    });
  });
  if (opts.powerEvents) {
    addEvent(h, { ts: OUTAGE_START, kind: 'power', from: 'on', to: 'off', data: { circuit: 'mains' } });
    addEvent(h, { ts: POWER_BACK, kind: 'power', from: 'off', to: 'on', data: { circuit: 'mains' } });
  }
  if (opts.automationContext) {
    addEvent(h, {
      ts: at(POWER_BACK, 100),
      kind: 'automation_run',
      entityId: 'automation.night_lights',
      context: { automationId: opts.automationContext },
      data: { trigger: 'the time reaching 3:12 a.m.' },
    });
  }
  addEntity(h, {
    entityId: 'automation.night_lights',
    name: 'Night Lights',
    integration: 'automation',
    transport: 'virtual',
    state: 'on',
    attributes: { id: 'night_lights', entity_ids: ['light.porch_light', 'light.stairs_light'] },
  });

  // F3: a Hue group and a Zigbee bulb share a name.
  addEntity(h, {
    entityId: 'light.living_room_light',
    name: 'Living Room Light',
    area: 'Living Room',
    deviceId: 'dev_hue_room_living',
    integration: 'hue',
    transport: 'zigbee',
    vendor: 'Philips Hue',
    model: 'Room',
    state: 'on',
    attributes: { is_hue_group: true },
  });
  addEntity(
    h,
    {
      entityId: 'light.living_room_light_2',
      name: 'Living Room Light',
      area: 'Living Room',
      deviceId: 'dev_living_bulb',
      integration: 'zigbee2mqtt',
      transport: 'zigbee',
      vendor: 'IKEA',
      state: 'on',
    },
    { linkQuality: 120 },
  );

  // F4: the kitchen plug dropped off Wi-Fi 9 times today.
  addEntity(
    h,
    {
      entityId: 'switch.kitchen_plug',
      name: 'Kitchen Plug',
      area: 'Kitchen',
      deviceId: 'dev_kitchen_plug',
      integration: 'kasa',
      transport: 'wifi',
      vendor: 'TP-Link Kasa',
      state: 'on',
    },
    { rssi: -82, flaps24h: 9 },
  );
  for (let k = 0; k < 9; k++) {
    const drop = at('2026-10-15T08:00:00.000Z', k * 55 * 60_000);
    addEvent(h, { ts: drop, kind: 'availability', entityId: 'switch.kitchen_plug', from: 'on', to: 'unavailable' });
    addEvent(h, { ts: at(drop, 120_000), kind: 'availability', entityId: 'switch.kitchen_plug', from: 'unavailable', to: 'on' });
  }

  // F5: hall motion sensor battery at 6%.
  addEntity(
    h,
    {
      entityId: 'binary_sensor.hall_motion',
      name: 'Hall Motion Sensor',
      area: 'Hallway',
      deviceId: 'dev_hall_motion',
      integration: 'zigbee2mqtt',
      transport: 'zigbee',
      vendor: 'Aqara',
      state: 'off',
      attributes: { device_class: 'motion' },
    },
    { batteryPct: 6, linkQuality: 96 },
  );
  addEntity(h, {
    entityId: 'sensor.hall_motion_battery',
    name: 'Hall Motion Sensor Battery',
    area: 'Hallway',
    deviceId: 'dev_hall_motion',
    integration: 'zigbee2mqtt',
    transport: 'zigbee',
    state: '6',
    attributes: { device_class: 'battery', unit_of_measurement: '%' },
  });

  // The living room power strip.
  addEntity(h, {
    entityId: 'switch.living_room_power_strip',
    name: 'Living Room Power Strip',
    area: 'Living Room',
    deviceId: 'dev_strip',
    integration: 'kasa',
    transport: 'wifi',
    vendor: 'TP-Link Kasa',
    state: 'on',
  }, { rssi: -61 });
  addEntity(h, {
    entityId: 'switch.living_room_power_strip_outlet_1',
    name: 'Reading Lamp',
    area: 'Living Room',
    deviceId: 'dev_strip',
    integration: 'kasa',
    transport: 'wifi',
    vendor: 'TP-Link Kasa',
    state: 'on',
    attributes: { outlet: 1 },
  });
  addEntity(h, {
    entityId: 'switch.living_room_power_strip_outlet_2',
    name: 'Aquarium Filter',
    area: 'Living Room',
    deviceId: 'dev_strip',
    integration: 'kasa',
    transport: 'wifi',
    vendor: 'TP-Link Kasa',
    state: 'on',
    attributes: { outlet: 2 },
  });
  return h;
}

export interface Rig {
  house: FakeHouse;
  adapter: FakeAdapter;
  clock: ManualClock;
  ledger: MemoryLedger;
  deps: EngineDeps;
}

export function rig(house: FakeHouse = buildGoldenHouse(), settings: Partial<EngineSettings> = {}, now: string = NOW, seed = 7): Rig {
  const clock = manualClock(now);
  const adapter = createFakeAdapter(house, clock);
  const ledger = createMemoryLedger();
  const deps: EngineDeps = {
    adapter,
    ledger,
    clock,
    rng: seededRng(seed),
    settings: defaultSettings({ tz: TZ, protected: [FILTER], ...settings }),
  };
  return { house, adapter, clock, ledger, deps };
}
