// Clearer step labels when two devices share a name, from the home's device list and a plan's changes.
import { describe, expect, it } from 'vitest';
import { clearerLabels, readHome, type HomeEntity } from '../../src/step-labels.ts';

// The demo house as /demo/state lists it (abridged): a Zigbee floor lamp bulb renamed to Living Room Light
// next to the Hue group of the same name, and the hallway lamp's old copy that no longer exists.
const STATE = {
  entities: [
    { entity_id: 'light.floor_lamp', name: 'Living Room Light', domain: 'light', area: 'living_room', integration: 'zigbee2mqtt', state: 'on', physical: { deviceId: 'dev_floor_lamp', name: 'Floor Lamp', exists: true } },
    { entity_id: 'select.floor_lamp_power_on_behavior', name: 'Living Room Light Power-on behavior', domain: 'select', area: 'living_room', integration: 'zigbee2mqtt', state: 'on', physical: { deviceId: 'dev_floor_lamp', name: 'Floor Lamp', exists: true } },
    { entity_id: 'light.living_room_light', name: 'Living Room Light', domain: 'light', area: 'living_room', integration: 'hue', state: 'on', physical: { deviceId: 'dev_living_room_hue', name: 'Living Room Light', exists: true } },
    { entity_id: 'select.living_room_light_power_on_behavior', name: 'Living Room Light Power-on behavior', domain: 'select', area: 'living_room', integration: 'hue', state: 'on', physical: { deviceId: 'dev_living_room_hue', name: 'Living Room Light', exists: true } },
    { entity_id: 'light.hallway_lamp', name: 'Hallway Lamp', domain: 'light', area: 'hallway', integration: 'zigbee2mqtt', state: 'unavailable', physical: { deviceId: 'dev_hallway_lamp', name: 'Hallway Lamp', exists: false } },
    { entity_id: 'light.hallway_lamp_2', name: 'Hallway Lamp', domain: 'light', area: 'hallway', integration: 'zigbee2mqtt', state: 'off', physical: { deviceId: 'dev_hallway_lamp_repaired', name: 'Hallway Lamp', exists: true } },
    { entity_id: 'select.hallway_lamp_2_power_on_behavior', name: 'Hallway Lamp Power-on behavior', domain: 'select', area: 'hallway', integration: 'zigbee2mqtt', state: 'on', physical: { deviceId: 'dev_hallway_lamp_repaired', name: 'Hallway Lamp', exists: true } },
    { entity_id: 'switch.kettle_plug', name: 'Kettle Plug', domain: 'switch', area: 'kitchen', integration: 'kasa', state: 'off', physical: { deviceId: 'dev_kettle', name: 'Kettle Plug', exists: true } },
    { entity_id: 'select.kettle_plug_power_on_behavior', name: 'Kettle Plug Power-on behavior', domain: 'select', area: 'kitchen', integration: 'kasa', state: 'on', physical: { deviceId: 'dev_kettle', name: 'Kettle Plug', exists: true } },
    { name: 'no id' },
  ],
};
const HOME = readHome(STATE) as HomeEntity[];
const label = (name: string) => `Set ${name} to remember its last state`;

describe('readHome', () => {
  it('reads the entities and skips malformed rows', () => {
    expect(HOME).toHaveLength(9);
    expect(HOME[0]).toEqual({ entity_id: 'light.floor_lamp', name: 'Living Room Light', domain: 'light', area: 'living_room', integration: 'zigbee2mqtt', deviceId: 'dev_floor_lamp', deviceName: 'Floor Lamp', exists: true });
    expect(readHome({})).toBeNull();
    expect(readHome(null)).toBeNull();
  });
});

describe('clearerLabels', () => {
  it('names the floor lamp behind a Living Room Light step; other steps stay as they are', () => {
    const plan = {
      plan_id: 'pln_power',
      entityIds: ['select.hallway_lamp_2_power_on_behavior', 'select.floor_lamp_power_on_behavior', 'select.kettle_plug_power_on_behavior'],
      labels: [label('Hallway Lamp'), label('Living Room Light'), label('Kettle Plug')],
    };
    expect(clearerLabels(plan, HOME)).toEqual({
      [`pln_power|${label('Living Room Light')}`]: [label('Living Room Light (the Floor Lamp)')],
    });
  });

  it('the old hallway copy no longer exists, so the hallway lamp shares no name', () => {
    const plan = { plan_id: 'p', entityIds: ['select.hallway_lamp_2_power_on_behavior'], labels: [label('Hallway Lamp')] };
    expect(clearerLabels(plan, HOME)).toEqual({});
  });

  it('both lights in one plan: each step says which, in step order', () => {
    const plan = {
      plan_id: 'p2',
      entityIds: ['select.living_room_light_power_on_behavior', 'select.floor_lamp_power_on_behavior'],
      labels: [label('Living Room Light'), label('Living Room Light')],
    };
    expect(clearerLabels(plan, HOME)).toEqual({
      [`p2|${label('Living Room Light')}`]: [label('Living Room Light (the Hue one)'), label('Living Room Light (the Floor Lamp)')],
    });
  });

  it('devices in different rooms are told apart by room', () => {
    const home: HomeEntity[] = [
      { entity_id: 'light.a', name: 'Lamp', domain: 'light', area: 'bedroom', integration: 'hue', deviceId: 'a', deviceName: 'Lamp', exists: true },
      { entity_id: 'light.b', name: 'Lamp', domain: 'light', area: 'living_room', integration: 'hue', deviceId: 'b', deviceName: 'Lamp', exists: true },
    ];
    expect(clearerLabels({ plan_id: 'p', entityIds: ['light.b'], labels: ['Turn Lamp off'] }, home)).toEqual({ 'p|Turn Lamp off': ['Turn Lamp (in the living room) off'] });
  });

  it('nothing known about the home: no labels', () => {
    expect(clearerLabels({ plan_id: 'p', entityIds: ['select.floor_lamp_power_on_behavior'], labels: [label('Living Room Light')] }, [])).toEqual({});
  });
});
