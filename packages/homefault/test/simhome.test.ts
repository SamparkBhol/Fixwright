// SimHome as a HomeAdapter: reads, writes with real effects, physical truth and the simulated person.

import { describe, expect, it } from 'vitest';
import { SimHome, SIM_ERROR, isCodedError, type SimHomeOptions } from '../src/index.ts';

const healthy = (opts: SimHomeOptions = {}) => SimHome.create({ seed: 5, faults: 'none', ...opts });

describe('SimHome adapter reads', () => {
  it('lists entities sorted, gets one, returns null for unknown ids', async () => {
    const home = healthy();
    const all = await home.listEntities();
    expect(all.map((e) => e.entityId)).toEqual([...all.map((e) => e.entityId)].sort());
    expect(await home.getEntity('light.desk_lamp')).toMatchObject({ name: 'Desk Lamp', domain: 'light', integration: 'zigbee2mqtt', transport: 'zigbee', area: 'office' });
    expect(await home.getEntity('light.nope')).toBeNull();
  });

  it('a healthy house: every integration loaded, hub reachable, clouds ok, nothing unavailable', async () => {
    const home = healthy();
    expect((await home.integrations()).every((i) => i.state === 'loaded')).toBe(true);
    expect(await home.hubStatus()).toMatchObject({ reachable: true, version: '2026.9.4' });
    expect((await home.cloudStatus('ecobee')).status).toBe('ok');
    expect((await home.cloudStatus('TP-Link')).status).toBe('ok');
    expect((await home.cloudStatus('Acme Cloud')).status).toBe('unknown');
    expect((await home.listEntities()).filter((e) => e.state === 'unavailable')).toEqual([]);
  });

  it('events filter by window and entity, carry contexts, and use seq 0 for the ledger', async () => {
    const home = healthy();
    const all = await home.events({ since: '2026-10-14T00:00:00Z' });
    expect(all.length).toBeGreaterThan(20);
    expect(all.every((e) => e.seq === 0 && e.source === 'home')).toBe(true);
    const ts = all.map((e) => Date.parse(e.ts));
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    const lamp = await home.events({ since: '2026-10-14T00:00:00Z', entityIds: ['light.hallway_lamp'] });
    expect(lamp.length).toBeGreaterThan(0);
    expect(lamp.every((e) => e.entityId === 'light.hallway_lamp')).toBe(true);
    const runs = all.filter((e) => e.kind === 'automation_run');
    expect(runs.length).toBeGreaterThan(0);
    const byAutomation = all.filter((e) => e.kind === 'state' && e.context?.automationId);
    expect(byAutomation.length).toBeGreaterThan(0);
    expect(byAutomation.every((e) => e.context?.eventType === 'automation_triggered')).toBe(true);
    await expect(home.events({ since: 'yesterday' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('signals per transport: Zigbee LQI, Wi-Fi RSSI, battery, Matter uptime, power-on behavior', async () => {
    const home = healthy();
    expect(await home.signals('light.desk_lamp')).toMatchObject({ linkQuality: 201, powerOnBehavior: 'on', flaps24h: 0 });
    expect(await home.signals('switch.kitchen_plug')).toMatchObject({ rssi: -61, flaps24h: 0 });
    expect((await home.signals('switch.kitchen_plug')).powerOnBehavior).toBeUndefined();
    expect((await home.signals('binary_sensor.hall_motion')).batteryPct).toBeGreaterThan(15);
    expect((await home.signals('light.garage_light')).uptimeS).toBeGreaterThan(0);
    expect((await home.signals('switch.aquarium_filter')).rssi).toBe(-58);
    await expect(home.signals('light.nope')).rejects.toMatchObject({ code: 'not_found', name: SIM_ERROR });
  });

  it('automations expose the entities they reference', async () => {
    const home = healthy();
    expect((await home.getEntity('automation.grow_light_schedule'))?.attributes.references).toEqual(['switch.grow_light']);
  });
});

describe('SimHome writes honour physical reality', () => {
  it('turning a lamp on changes state, logs call and state with one context, and lights it', async () => {
    const home = healthy();
    const since = home.now();
    const { changed } = await home.callService('light', 'turn_on', { entity_id: 'light.desk_lamp' });
    expect(changed.map((e) => [e.entityId, e.state])).toEqual([['light.desk_lamp', 'on']]);
    expect(home.physical('light.desk_lamp').output).toBe('on');
    const ev = await home.events({ since, entityIds: ['light.desk_lamp'] });
    expect(ev.map((e) => e.kind)).toEqual(['service_call', 'state']);
    expect(ev[1]?.context).toMatchObject({ userId: 'user_api', service: 'light.turn_on', eventType: 'call_service' });
  });

  it('an unavailable entity rejects; a missing one is not_found; a wrong domain is a bad request', async () => {
    const home = healthy();
    home.inject('hub_down');
    await expect(home.callService('light', 'turn_on', { entity_id: 'light.desk_lamp' })).rejects.toMatchObject({ code: 'entity_unavailable' });
    await expect(home.callService('light', 'turn_on', { entity_id: 'light.nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(home.callService('switch', 'turn_on', { entity_id: 'light.porch_light' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(home.callService('light', 'explode', { entity_id: 'light.porch_light' })).rejects.toMatchObject({ code: 'unknown_service' });
    await expect(home.callService('light', 'turn_on', {})).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('a flash blinks a working lamp without changing its state', async () => {
    const home = healthy();
    const since = home.now();
    const { changed } = await home.callService('light', 'turn_on', { entity_id: 'light.bedroom_lamp', flash: 'short' });
    expect(changed).toEqual([]);
    expect(home.physical('light.bedroom_lamp').recentActuations.filter((t) => t >= since).length).toBe(2);
    expect(home.person({ kind: 'confirm_flash', name: 'Bedroom Lamp', since })).toBe('yes');
    expect(home.person({ kind: 'confirm_flash', name: 'Desk Lamp', since })).toBe('no');
    expect(home.person({ kind: 'confirm_flash', name: 'Nothing Here', since })).toBe('not sure');
  });

  it('turning the strip off cuts every outlet; an outlet alone leaves the others running', async () => {
    const home = healthy();
    await home.callService('switch', 'turn_off', { entity_id: 'switch.phone_charger' });
    expect(home.physical('switch.aquarium_filter').output).toBe('on');
    expect((await home.getEntity('switch.living_room_power_strip'))?.state).toBe('on');
    expect(home.physical('switch.reading_lamp').output).toBe('on');
    const { changed } = await home.callService('switch', 'turn_off', { entity_id: 'switch.living_room_power_strip' });
    expect(changed.map((e) => e.entityId).sort()).toEqual(['switch.aquarium_filter', 'switch.living_room_power_strip', 'switch.reading_lamp']);
    expect(home.physical('switch.aquarium_filter').output).toBe('off');
    expect(home.physical('switch.reading_lamp').output).toBe('off');
  });

  it('registryUpdate renames (name: null restores), sets aliases and disables', async () => {
    const home = healthy();
    expect((await home.registryUpdate('light.floor_lamp', { name: 'Reading Corner' })).name).toBe('Reading Corner');
    expect(home.resolveName('reading corner')?.entityId).toBe('light.floor_lamp');
    expect((await home.registryUpdate('light.floor_lamp', { name: null })).name).toBe('Floor Lamp');
    expect((await home.registryUpdate('light.floor_lamp', { aliases: ['Big Lamp'] })).aliases).toEqual(['Big Lamp']);
    expect(home.resolveName('big lamp')?.entityId).toBe('light.floor_lamp');
    const disabled = await home.registryUpdate('light.floor_lamp', { disabled: true });
    expect(disabled).toMatchObject({ disabled: true, registryOnly: true });
    await expect(home.callService('light', 'turn_on', { entity_id: 'light.floor_lamp' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await home.registryUpdate('light.floor_lamp', { disabled: false })).state).toBe('off');
  });

  it('registryRemove retires old copies but refuses entities their integration still provides', async () => {
    const home = SimHome.create({ seed: 5 });
    await expect(home.registryRemove('light.hallway_lamp_2')).rejects.toMatchObject({ code: 'entity_still_provided' });
    const before = home.now();
    await home.registryRemove('light.hallway_lamp');
    expect(await home.getEntity('light.hallway_lamp')).toBeNull();
    const rows = home.rows({ since: before });
    expect(rows.some((r) => r.type === 'registry' && r.action === 'remove' && r.entity_id === 'light.hallway_lamp')).toBe(true);
  });

  it('reloadIntegration restarts a hung coordinator, but not an expired account link', async () => {
    const home = healthy();
    home.inject('F8');
    expect((await home.integrations()).find((i) => i.integration === 'zigbee2mqtt')?.state).toBe('setup_retry');
    await home.reloadIntegration('zigbee2mqtt');
    expect((await home.integrations()).find((i) => i.integration === 'zigbee2mqtt')?.state).toBe('loaded');
    expect((await home.getEntity('light.desk_lamp'))?.state).not.toBe('unavailable');
    expect(home.activeFaults()).not.toContain('hub_down');
    home.inject('F7');
    await home.reloadIntegration('hue');
    expect((await home.integrations()).find((i) => i.integration === 'hue')?.state).toBe('setup_error');
    await expect(home.reloadIntegration('nope')).rejects.toMatchObject({ code: 'unknown_integration' });
  });

  it('a hard coordinator failure survives a reload', async () => {
    const home = healthy();
    home.inject('hub_down', { hard: true });
    await home.reloadIntegration('zigbee2mqtt');
    expect((await home.integrations()).find((i) => i.integration === 'zigbee2mqtt')?.state).toBe('setup_retry');
  });

  it('selectOption changes power-on behavior, rejects unknown options and offline devices', async () => {
    const home = healthy();
    const sel = await home.selectOption('select.desk_lamp_power_on_behavior', 'previous');
    expect(sel.state).toBe('previous');
    expect((await home.signals('light.desk_lamp')).powerOnBehavior).toBe('previous');
    await expect(home.selectOption('select.desk_lamp_power_on_behavior', 'sometimes')).rejects.toMatchObject({ code: 'invalid_option' });
    await expect(home.selectOption('light.desk_lamp', 'on')).rejects.toMatchObject({ code: 'bad_request' });
    home.inject('hub_down');
    await expect(home.selectOption('select.desk_lamp_power_on_behavior', 'on')).rejects.toMatchObject({ code: 'entity_unavailable' });
  });

  it('a wall switch cuts a lamp; the person says the switch is off; turning it back on restores it', async () => {
    const home = healthy();
    home.setWallSwitch('light.bedroom_lamp', false);
    expect((await home.getEntity('light.bedroom_lamp'))?.state).toBe('unavailable');
    expect(home.person({ kind: 'power_switch_check', name: 'Bedroom Lamp' })).toBe('no');
    expect(home.physical('light.bedroom_lamp')).toMatchObject({ powered: false, wallSwitch: 'off', exists: true });
    home.setWallSwitch('light.bedroom_lamp', true);
    expect((await home.getEntity('light.bedroom_lamp'))?.state).not.toBe('unavailable');
    expect(home.person({ kind: 'power_switch_check', name: 'Bedroom Lamp' })).toBe('yes');
    expect(() => home.setWallSwitch('switch.kitchen_plug', false)).toThrowError(/no wall switch/);
  });

  it('a circuit cut takes that area offline; the hub on its UPS keeps logging', async () => {
    const home = healthy();
    home.setCircuit('garage', false);
    home.advance(2000);
    expect((await home.getEntity('light.garage_light'))?.state).toBe('unavailable');
    expect((await home.getEntity('light.desk_lamp'))?.state).not.toBe('unavailable');
    home.setCircuit('garage', true);
    home.advance(10_000);
    expect((await home.getEntity('light.garage_light'))?.state).not.toBe('unavailable');
  });

  it('an unreachable hub fails every adapter call except hubStatus and cloudStatus', async () => {
    const home = healthy();
    home.setHubOnline(false);
    expect(await home.hubStatus()).toEqual({ reachable: false });
    await expect(home.listEntities()).rejects.toMatchObject({ code: 'hub_unreachable' });
    expect((await home.cloudStatus('ecobee')).status).toBe('ok');
    home.setHubOnline(true);
    expect((await home.listEntities()).length).toBeGreaterThan(30);
  });

  it('time only moves forward and only when told', () => {
    const home = healthy();
    const t0 = home.now();
    home.advanceTo('2026-10-15T12:00:00');
    expect(home.now()).toBe(t0);
    home.advance(60_000);
    expect(Date.parse(home.now()) - Date.parse(t0)).toBe(60_000);
    expect(() => home.advance(-1)).toThrowError(/non-negative/);
  });

  it('errors carry stable codes', async () => {
    const home = healthy();
    try {
      await home.getEntity('x');
      await home.signals('light.none');
    } catch (e) {
      expect(isCodedError(e)).toBe(true);
    }
    expect(() => home.inject('F99' as never)).toThrowError(/Unknown fault/);
    expect(() => SimHome.create({ tz: 'Mars/Olympus' })).toThrowError(/time zone/);
  });
});
