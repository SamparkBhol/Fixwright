// The default house: six areas, each on its own mains circuit, with the hub, the Zigbee coordinator,
// the Hue bridge, the Thread border router and the Wi-Fi router on a small UPS in the office.
// Devices come from six integrations: zigbee2mqtt, hue, kasa (Wi-Fi), matter (Thread), ecobee (cloud)
// and template/automation. Two Wi-Fi power strips (living room and office) feed three child outlets
// each. Fourteen lights and plugs ship with a power-on behavior of 'on', which is the factory default for
// many Zigbee and Matter bulbs and the root of fault F2.

import { iso } from '../time.ts';
import { clone } from '../util.ts';
import type { PowerOnBehavior, Transport } from '../types.ts';
import type {
  AreaId,
  AutomationDef,
  DeviceKind,
  DeviceState,
  EntityState,
  IntegrationState,
  SimState,
  TemplateDef,
} from './model.ts';
import { SNAPSHOT_VERSION } from './model.ts';

export const HOME_SSID = 'home-net';
export const HA_VERSION = '2026.9.4';
export const DEFAULT_MAX_ROWS = 1000;
/**
 * Log budget in bytes, about six days of a lived-in house. Every caller-supplied string is capped (names,
 * aliases, service data), so even with the longest names allowed on every entity the rest of the state
 * stays near 105 KB and a snapshot stays under 256 KB whatever callers send.
 */
export const DEFAULT_MAX_ROW_BYTES = 150_000;

interface Integ {
  transport: Transport;
  pollMs: number;
}

/**
 * How each integration sees changes. Push integrations report at once; polled ones only notice a change
 * that still holds at their next poll, so a two second power blip is invisible to them.
 */
export const INTEGRATIONS: Readonly<Record<string, Integ>> = {
  zigbee2mqtt: { transport: 'zigbee', pollMs: 0 },
  matter: { transport: 'thread', pollMs: 0 },
  hue: { transport: 'zigbee', pollMs: 60_000 },
  kasa: { transport: 'wifi', pollMs: 30_000 },
  ecobee: { transport: 'cloud', pollMs: 180_000 },
  template: { transport: 'virtual', pollMs: 0 },
  automation: { transport: 'virtual', pollMs: 0 },
};

interface DeviceSpec {
  id: string;
  name: string;
  kind: DeviceKind;
  area: AreaId;
  integration: keyof typeof INTEGRATIONS;
  vendor: string;
  model: string;
  entityId: string;
  domain: string;
  battery?: number;
  wallSwitch?: boolean;
  parent?: string;
  powerOn?: PowerOnBehavior;
  /** The integration exposes power-on behavior as a select entity. */
  powerOnSelect?: boolean;
  lqi?: number;
  rssi?: number;
  output?: boolean;
  attributes?: Record<string, unknown>;
  aliases?: string[];
}

const IKEA_BULB = { vendor: 'IKEA', model: 'TRADFRI LED bulb E26 806 lm' } as const;
/**
 * A bridge maker's bulb paired straight to the Zigbee coordinator. Its maker has a cloud status page. The
 * demo house describes this maker instead of naming a brand, so the demo video carries no trademark.
 */
const BRIDGE_BULB = { vendor: 'light maker', model: 'White A19 bulb (paired to Zigbee2MQTT)' } as const;

const z2mLight = (
  id: string,
  name: string,
  area: AreaId,
  entityId: string,
  lqi: number,
  make: { vendor: string; model: string } = IKEA_BULB,
): DeviceSpec => ({
  id,
  name,
  kind: 'light',
  area,
  integration: 'zigbee2mqtt',
  vendor: make.vendor,
  model: make.model,
  entityId,
  domain: 'light',
  wallSwitch: true,
  powerOn: 'on',
  powerOnSelect: true,
  lqi,
});

const z2mPlug = (id: string, name: string, area: AreaId, entityId: string, lqi: number): DeviceSpec => ({
  id,
  name,
  kind: 'plug',
  area,
  integration: 'zigbee2mqtt',
  vendor: 'IKEA',
  model: 'TRETAKT smart plug',
  entityId,
  domain: 'switch',
  powerOn: 'on',
  powerOnSelect: true,
  lqi,
});

const matterLight = (id: string, name: string, area: AreaId, entityId: string): DeviceSpec => ({
  id,
  name,
  kind: 'light',
  area,
  integration: 'matter',
  vendor: 'Nanoleaf',
  model: 'Essentials A19 (Matter over Thread)',
  entityId,
  domain: 'light',
  powerOn: 'on',
  powerOnSelect: true,
});

const matterPlug = (id: string, name: string, area: AreaId, entityId: string): DeviceSpec => ({
  id,
  name,
  kind: 'plug',
  area,
  integration: 'matter',
  vendor: 'Eve',
  model: 'Energy (Matter over Thread)',
  entityId,
  domain: 'switch',
  powerOn: 'on',
  powerOnSelect: true,
});

const kasaPlug = (id: string, name: string, area: AreaId, entityId: string, rssi: number, output: boolean): DeviceSpec => ({
  id,
  name,
  kind: 'plug',
  area,
  integration: 'kasa',
  vendor: 'TP-Link',
  model: 'Kasa EP10',
  entityId,
  domain: 'switch',
  powerOn: 'previous',
  rssi,
  output,
});

export const LIVING_ROOM_STRIP = 'switch.living_room_power_strip';
export const OFFICE_STRIP = 'switch.office_power_strip';

/** One child outlet of a Kasa KP303 strip: powered through the strip, reached through the strip's Wi-Fi link. */
const stripOutlet = (
  id: string,
  name: string,
  area: AreaId,
  entityId: string,
  parent: string,
  stripEntityId: string,
  outlet: number,
  output: boolean,
): DeviceSpec => ({
  id,
  name,
  kind: 'outlet',
  area,
  integration: 'kasa',
  vendor: 'TP-Link',
  model: `Kasa KP303 outlet ${outlet}`,
  entityId,
  domain: 'switch',
  parent,
  powerOn: 'previous',
  output,
  attributes: { outlet, power_strip: stripEntityId },
});

const DEVICES: readonly DeviceSpec[] = [
  z2mLight('dev_hallway_lamp', 'Hallway Lamp', 'hallway', 'light.hallway_lamp', 168, BRIDGE_BULB),
  matterLight('dev_porch_light', 'Porch Light', 'hallway', 'light.porch_light'),
  {
    id: 'dev_hall_motion',
    name: 'Hall Motion Sensor',
    kind: 'motion',
    area: 'hallway',
    integration: 'zigbee2mqtt',
    vendor: 'Aqara',
    model: 'Motion Sensor P1',
    entityId: 'binary_sensor.hall_motion',
    domain: 'binary_sensor',
    battery: 82,
    lqi: 142,
    output: false,
    attributes: { device_class: 'motion' },
  },
  {
    id: 'dev_thermostat',
    name: 'Thermostat',
    kind: 'thermostat',
    area: 'hallway',
    integration: 'ecobee',
    vendor: 'ecobee',
    model: 'Smart Thermostat Premium',
    entityId: 'climate.thermostat',
    domain: 'climate',
    attributes: { hvac_modes: ['off', 'heat', 'cool', 'heat_cool'], temperature: 68, current_temperature: 69 },
  },
  z2mLight('dev_floor_lamp', 'Floor Lamp', 'living_room', 'light.floor_lamp', 151),
  matterLight('dev_tv_backlight', 'TV Backlight', 'living_room', 'light.tv_backlight'),
  {
    id: 'dev_living_room_hue',
    name: 'Living Room Light',
    kind: 'light_group',
    area: 'living_room',
    integration: 'hue',
    vendor: 'light maker',
    model: 'Bridge room group (2 bulbs)',
    entityId: 'light.living_room_light',
    domain: 'light',
    powerOn: 'previous',
    attributes: { is_hue_group: true, lights: ['Sofa Lamp', 'Corner Lamp'] },
  },
  {
    id: 'dev_living_room_strip',
    name: 'Living Room Power Strip',
    kind: 'strip',
    area: 'living_room',
    integration: 'kasa',
    vendor: 'TP-Link',
    model: 'Kasa KP303',
    entityId: LIVING_ROOM_STRIP,
    domain: 'switch',
    powerOn: 'previous',
    rssi: -58,
    attributes: { outlets: 3 },
  },
  stripOutlet('dev_strip_outlet_1', 'Reading Lamp', 'living_room', 'switch.reading_lamp', 'dev_living_room_strip', LIVING_ROOM_STRIP, 1, false),
  stripOutlet('dev_strip_outlet_2', 'Aquarium Filter', 'living_room', 'switch.aquarium_filter', 'dev_living_room_strip', LIVING_ROOM_STRIP, 2, true),
  stripOutlet('dev_strip_outlet_3', 'Phone Charger', 'living_room', 'switch.phone_charger', 'dev_living_room_strip', LIVING_ROOM_STRIP, 3, true),
  kasaPlug('dev_kitchen_plug', 'Kitchen Plug', 'kitchen', 'switch.kitchen_plug', -61, false),
  z2mPlug('dev_kettle_plug', 'Kettle Plug', 'kitchen', 'switch.kettle_plug', 187),
  matterLight('dev_kitchen_counter', 'Kitchen Counter Light', 'kitchen', 'light.kitchen_counter'),
  matterLight('dev_kitchen_pendant', 'Kitchen Pendant', 'kitchen', 'light.kitchen_pendant'),
  z2mLight('dev_bedroom_lamp', 'Bedroom Lamp', 'bedroom', 'light.bedroom_lamp', 133),
  matterLight('dev_bedside_lamp', 'Bedside Lamp', 'bedroom', 'light.bedside_lamp'),
  matterPlug('dev_bedroom_fan', 'Bedroom Fan', 'bedroom', 'switch.bedroom_fan'),
  z2mLight('dev_desk_lamp', 'Desk Lamp', 'office', 'light.desk_lamp', 201),
  matterPlug('dev_monitor_plug', 'Monitor Plug', 'office', 'switch.monitor_plug'),
  {
    id: 'dev_office_strip',
    name: 'Office Power Strip',
    kind: 'strip',
    area: 'office',
    integration: 'kasa',
    vendor: 'TP-Link',
    model: 'Kasa KP303',
    entityId: OFFICE_STRIP,
    domain: 'switch',
    powerOn: 'previous',
    rssi: -55,
    attributes: { outlets: 3 },
  },
  stripOutlet('dev_office_outlet_1', 'Printer', 'office', 'switch.printer', 'dev_office_strip', OFFICE_STRIP, 1, false),
  stripOutlet('dev_office_outlet_2', 'Speakers', 'office', 'switch.speakers', 'dev_office_strip', OFFICE_STRIP, 2, true),
  stripOutlet('dev_office_outlet_3', 'Paper Shredder', 'office', 'switch.paper_shredder', 'dev_office_strip', OFFICE_STRIP, 3, false),
  z2mPlug('dev_workbench_plug', 'Workbench Plug', 'garage', 'switch.workbench_plug', 96),
  matterLight('dev_garage_light', 'Garage Light', 'garage', 'light.garage_light'),
  kasaPlug('dev_grow_light', 'Grow Light', 'garage', 'switch.grow_light', -66, true),
];

const AUTOMATIONS: readonly AutomationDef[] = [
  {
    entityId: 'automation.hallway_night_light',
    name: 'Hallway night light',
    triggers: [
      {
        kind: 'state',
        entityId: 'binary_sensor.hall_motion',
        to: 'on',
        condition: { entityId: 'binary_sensor.night_mode', state: 'on' },
        actions: [{ service: 'light.turn_on', target: 'light.hallway_lamp' }],
        thenAfterMs: 5 * 60_000,
        thenActions: [{ service: 'light.turn_off', target: 'light.hallway_lamp' }],
      },
    ],
  },
  {
    entityId: 'automation.morning_coffee',
    name: 'Morning coffee',
    triggers: [
      { kind: 'time', at: '06:30:00', actions: [{ service: 'switch.turn_on', target: 'switch.kitchen_plug' }] },
      { kind: 'time', at: '07:30:00', actions: [{ service: 'switch.turn_off', target: 'switch.kitchen_plug' }] },
    ],
  },
  {
    entityId: 'automation.grow_light_schedule',
    name: 'Grow light schedule',
    triggers: [
      { kind: 'time', at: '06:00:00', actions: [{ service: 'switch.turn_on', target: 'switch.grow_light' }] },
      { kind: 'time', at: '20:00:00', actions: [{ service: 'switch.turn_off', target: 'switch.grow_light' }] },
    ],
  },
  {
    entityId: 'automation.evening_lights',
    name: 'Evening lights',
    triggers: [
      { kind: 'time', at: '18:30:00', actions: [{ service: 'light.turn_on', target: 'light.living_room_light' }] },
      { kind: 'time', at: '23:15:00', actions: [{ service: 'light.turn_off', target: 'light.living_room_light' }] },
    ],
  },
];

const TEMPLATES: readonly TemplateDef[] = [
  {
    entityId: 'binary_sensor.night_mode',
    schedule: [
      { at: '07:00:00', state: 'off' },
      { at: '22:00:00', state: 'on' },
    ],
  },
];

/** Lights and plugs the resident switches off from the app each morning if they find them on. */
const MORNING_SWEEP: readonly string[] = [
  'light.porch_light',
  'light.floor_lamp',
  'light.tv_backlight',
  'light.living_room_light',
  'switch.kettle_plug',
  'light.kitchen_counter',
  'light.kitchen_pendant',
  'light.bedroom_lamp',
  'light.bedside_lamp',
  'switch.bedroom_fan',
  'light.desk_lamp',
  'switch.monitor_plug',
  'switch.workbench_plug',
  'light.garage_light',
];

export function automationReferences(def: AutomationDef): string[] {
  const refs = new Set<string>();
  for (const t of def.triggers) {
    for (const a of t.actions) refs.add(a.target);
    if (t.kind === 'state') {
      refs.add(t.entityId);
      if (t.condition) refs.add(t.condition.entityId);
      for (const a of t.thenActions) refs.add(a.target);
    }
  }
  return [...refs].sort();
}

export const powerOnSelectId = (primaryEntityId: string): string =>
  `select.${primaryEntityId.slice(primaryEntityId.indexOf('.') + 1)}_power_on_behavior`;

export const POWER_ON_OPTIONS: readonly PowerOnBehavior[] = ['off', 'on', 'toggle', 'previous'];

/**
 * Percent a coin cell sensor loses per day near the end of its life, applied at local midnight. Slow
 * enough that a battery read at 15:00 still reads the same the next morning, fast enough that a nearly
 * empty one dies within about two weeks.
 */
export const BATTERY_DRAIN_PER_DAY = 0.4;

function deviceState(spec: DeviceSpec, startMs: number): DeviceState {
  const power: DeviceState['power'] =
    spec.battery !== undefined
      ? { kind: 'battery', pct: spec.battery, drainPerDay: BATTERY_DRAIN_PER_DAY }
      : { kind: 'mains', circuit: spec.area, wallSwitch: spec.wallSwitch ?? null, parent: spec.parent ?? null };
  const hasOutput = spec.kind !== 'thermostat' && spec.kind !== 'strip';
  const output = hasOutput ? (spec.output ?? false) : null;
  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    area: spec.area,
    integration: spec.integration,
    transport: INTEGRATIONS[spec.integration]?.transport ?? 'virtual',
    vendor: spec.vendor,
    model: spec.model,
    present: true,
    power,
    output,
    lastOutput: output ?? false,
    powerOnBehavior: spec.powerOn ?? null,
    linkQuality: spec.lqi ?? null,
    rssi: spec.rssi ?? null,
    ssid: spec.integration === 'kasa' ? HOME_SSID : null,
    dropUntil: 0,
    bootingUntil: 0,
    bootMs: startMs - 9 * 24 * 3_600_000,
    lastSeenMs: startMs,
    lit: false,
    actuations: [],
  };
}

interface EntityInit {
  entityId: string;
  name: string;
  domain: string;
  area: AreaId | null;
  deviceId: string | null;
  integration: string;
  vendor?: string | null;
  model?: string | null;
  role: EntityState['role'];
  state: string;
  value?: string | null;
  attributes?: Record<string, unknown>;
  aliases?: string[];
}

export function makeEntity(init: EntityInit, atMs: number): EntityState {
  const at = iso(atMs);
  return {
    entityId: init.entityId,
    name: init.name,
    originalName: init.name,
    aliases: init.aliases ?? [],
    domain: init.domain,
    area: init.area,
    deviceId: init.deviceId,
    integration: init.integration,
    transport: INTEGRATIONS[init.integration]?.transport ?? 'virtual',
    vendor: init.vendor ?? null,
    model: init.model ?? null,
    role: init.role,
    state: init.state,
    value: init.value ?? null,
    attributes: { friendly_name: init.name, ...(init.attributes ?? {}) },
    lastChanged: at,
    lastUpdated: at,
    restored: false,
    disabled: false,
    registryOnly: false,
    createdMs: atMs,
    missedPoll: false,
  };
}

/** The select entity that exposes a device's power-on behavior (Zigbee2MQTT power_on_behavior, Matter StartUpOnOff). */
export function powerOnSelect(device: DeviceState, primaryEntityId: string, primaryName: string, atMs: number): EntityState {
  return makeEntity(
    {
      entityId: powerOnSelectId(primaryEntityId),
      name: `${primaryName} Power-on behavior`,
      domain: 'select',
      area: device.area,
      deviceId: device.id,
      integration: device.integration,
      vendor: device.vendor,
      model: device.model,
      role: 'power_on',
      state: device.powerOnBehavior ?? 'previous',
      value: device.powerOnBehavior ?? 'previous',
      attributes: {
        options: [...POWER_ON_OPTIONS],
        entity_category: 'config',
        source: device.integration === 'matter' ? 'StartUpOnOff' : 'power_on_behavior',
      },
    },
    atMs,
  );
}

function primaryState(spec: DeviceSpec): string {
  if (spec.kind === 'thermostat') return 'heat';
  if (spec.kind === 'strip') return 'on';
  return spec.output ? 'on' : 'off';
}

function integrationStates(): Record<string, IntegrationState> {
  const out: Record<string, IntegrationState> = {};
  for (const [name, integ] of Object.entries(INTEGRATIONS)) {
    out[name] = { state: 'loaded', reason: null, entryId: `entry_${name}`, pollMs: integ.pollMs };
  }
  return out;
}

export interface BlueprintOptions {
  seed: number;
  tz: string;
  startMs: number;
  maxRows?: number;
  maxRowBytes?: number;
}

/** A healthy default house at startMs: every device online, every integration loaded, no faults. */
export function buildHouse(opts: BlueprintOptions): SimState {
  const createdBase = opts.startMs - 400 * 24 * 3_600_000;
  const devices: SimState['devices'] = {};
  const entities: SimState['entities'] = {};
  let order = 0;
  const created = (): number => createdBase + order++ * 60_000;

  for (const spec of DEVICES) {
    const device = deviceState(spec, opts.startMs);
    devices[device.id] = device;
    const attributes: Record<string, unknown> = { ...(spec.attributes ?? {}) };
    if (spec.battery !== undefined) attributes.battery = spec.battery;
    const value = spec.kind === 'thermostat' ? 'heat' : null;
    const primary = makeEntity(
      {
        entityId: spec.entityId,
        name: spec.name,
        domain: spec.domain,
        area: spec.area,
        deviceId: device.id,
        integration: spec.integration,
        vendor: spec.vendor,
        model: spec.model,
        role: 'primary',
        state: primaryState(spec),
        value,
        attributes,
        aliases: spec.aliases ?? [],
      },
      created(),
    );
    primary.lastChanged = iso(opts.startMs - 3_600_000);
    primary.lastUpdated = primary.lastChanged;
    entities[primary.entityId] = primary;
    if (spec.powerOnSelect) {
      const select = powerOnSelect(device, spec.entityId, spec.name, created());
      entities[select.entityId] = select;
    }
  }

  const automations: SimState['automations'] = {};
  for (const def of AUTOMATIONS) {
    automations[def.entityId] = clone(def);
    entities[def.entityId] = makeEntity(
      {
        entityId: def.entityId,
        name: def.name,
        domain: 'automation',
        area: null,
        deviceId: null,
        integration: 'automation',
        role: 'automation',
        state: 'on',
        value: 'on',
        attributes: { id: def.entityId.slice('automation.'.length), mode: 'restart', references: automationReferences(def), last_triggered: null },
      },
      created(),
    );
  }

  const templates: SimState['templates'] = {};
  for (const def of TEMPLATES) {
    templates[def.entityId] = clone(def);
    entities[def.entityId] = makeEntity(
      {
        entityId: def.entityId,
        name: 'Night Mode',
        domain: 'binary_sensor',
        area: null,
        deviceId: null,
        integration: 'template',
        role: 'template',
        state: 'off',
        value: 'off',
      },
      created(),
    );
  }

  const circuits: SimState['circuits'] = { office_ups: { powered: true, ups: true } };
  for (const area of ['hallway', 'living_room', 'kitchen', 'bedroom', 'office', 'garage']) {
    circuits[area] = { powered: true, ups: false };
  }

  return {
    v: SNAPSHOT_VERSION,
    seed: opts.seed,
    tz: opts.tz,
    nowMs: opts.startMs,
    counter: 0,
    maxRows: opts.maxRows ?? DEFAULT_MAX_ROWS,
    maxRowBytes: opts.maxRowBytes ?? DEFAULT_MAX_ROW_BYTES,
    rowBytes: 0,
    hub: { online: true, version: HA_VERSION },
    router: { ssid: HOME_SSID },
    circuits,
    devices,
    entities,
    integrations: integrationStates(),
    cloud: { ecobee: { status: 'ok', since: opts.startMs }, hue: { status: 'ok', since: opts.startMs }, kasa: { status: 'ok', since: opts.startMs } },
    automations,
    templates,
    routine: { sweep: [...MORNING_SWEEP] },
    faults: {},
    rows: [],
    pending: [],
    plannedThrough: null,
    users: { resident: 'user_resident', voice: 'user_voice_assistant', api: 'user_api' },
  };
}
