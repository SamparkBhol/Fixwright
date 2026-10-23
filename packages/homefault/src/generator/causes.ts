// One storyline per cause: what physically goes wrong, when, and what the person would see. Each
// storyline edits the sampled house and returns the intents that play the failure out. The everyday
// life around it, the distractors and the log noise are added afterwards by the generator.

import { between, chance, int, pick, sample } from '../rng.ts';
import type { GroundTruth, HumanTruth } from '../scenario/types.ts';
import { atLocal, HOUR, iso, localDayKey, localParts, MINUTE } from '../time.ts';
import type { CauseId, Entity, Rng } from '../types.ts';
import { addDevice, ensureIntegration, references, uniqueEntityId, type GenDevice, type GenHouse, type Intent } from './world.ts';

const DAY = 24 * HOUR;

export interface Story {
  intents: Intent[];
  /** Everyday intents inside this window are dropped (nothing else happened then). */
  blackout?: [number, number];
  /** Entities that get no everyday use (their story is told by the intents). */
  quiet: Set<string>;
  symptom: { text: string; device?: string };
  truth: GroundTruth;
  human: HumanTruth;
  tags: string[];
}

export type Storyline = (rng: Rng, house: GenHouse) => Story;

const switchables = (house: GenHouse, integrations?: readonly string[]): GenDevice[] =>
  house.devices.filter((d) => (d.kind === 'light' || d.kind === 'plug') && (!integrations || integrations.includes(d.integration)));

function ensureSwitchable(rng: Rng, house: GenHouse, integrations: readonly string[], min = 1): GenDevice[] {
  const kind = (): 'light' | 'plug' => (chance(rng, 0.6) ? 'light' : 'plug');
  while (switchables(house, integrations).length < min) {
    addDevice(rng, house, { kind: kind(), room: pick(rng, house.rooms), integration: pick(rng, integrations) });
  }
  return switchables(house, integrations);
}

/** A few failed attempts to use a device after it broke: by voice, then maybe from the app. */
function attempts(rng: Rng, house: GenHouse, entityId: string, fromMs: number, count: number): Intent[] {
  const out: Intent[] = [];
  const span = Math.max(MINUTE, house.nowMs - fromMs - 2 * MINUTE);
  for (let i = 0; i < count; i++) {
    const t = fromMs + Math.floor(rng.next() * span);
    out.push({ t, kind: 'cmd', entityId, service: chance(rng, 0.6) ? 'turn_on' : 'turn_off', by: chance(rng, 0.7) ? 'voice' : 'app', user: pick(rng, house.users) });
  }
  out.push({ t: house.nowMs - int(rng, 1, 4) * MINUTE, kind: 'cmd', entityId, service: 'turn_on', by: 'voice', user: pick(rng, house.users) });
  return out;
}

const pickText = (rng: Rng, templates: readonly string[], name: string): string => pick(rng, templates).replace('{name}', name);

const NOT_RESPONDING = [
  'Why does the {name} keep saying it is not responding?',
  'The {name} is not responding.',
  '{name} says device is unresponsive. It worked yesterday.',
  'Alexa says the {name} is not responding, can you check it?',
  'What is wrong with the {name}?',
];

const staleDuplicate: Storyline = (rng, house) => {
  const target = pick(rng, ensureSwitchable(rng, house, ['zigbee2mqtt', 'hue', 'matter']));
  const offlineSince = house.nowMs - int(rng, 2, 40) * DAY - int(rng, 0, 23) * HOUR;
  const oldId = target.entityId;
  // The live device is re-paired under a new entity id; the old one stays behind, restored.
  target.entityId = uniqueEntityId(house, target.domain, target.name);
  const variants = [target.name, target.name.toLowerCase(), target.name.replace(/ /g, '  ')];
  const ghost: Entity = {
    entityId: oldId,
    name: pick(rng, variants),
    aliases: [],
    domain: target.domain,
    area: target.room.toLowerCase().replace(/ /g, '_'),
    deviceId: `${target.deviceId}_old`,
    integration: target.integration,
    transport: target.transport,
    vendor: target.vendor,
    model: target.model,
    state: 'unavailable',
    attributes: { friendly_name: target.name, restored: true },
    lastChanged: iso(offlineSince),
    lastUpdated: iso(offlineSince),
    restored: true,
  };
  house.ghosts.push(ghost);
  for (const a of house.automations) a.targets = a.targets.map((t) => (t === oldId ? target.entityId : t));
  const intents: Intent[] = [];
  intents.push({ t: offlineSince + 5 * MINUTE, kind: 'row', row: { type: 'registry', when: iso(offlineSince + 5 * MINUTE), action: 'create', entity_id: target.entityId, changes: { name: target.name } } });
  // Voice reaches the old copy and nothing happens; the app works on the new one.
  for (let i = int(rng, 2, 5); i > 0; i--) {
    const t = house.startMs + Math.floor(rng.next() * (house.nowMs - house.startMs - 10 * MINUTE));
    const service = chance(rng, 0.5) ? 'turn_on' : 'turn_off';
    intents.push({ t, kind: 'cmd', entityId: oldId, service, by: 'voice', user: pick(rng, house.users) });
    if (chance(rng, 0.6)) intents.push({ t: t + int(rng, 15, 50) * 1000, kind: 'cmd', entityId: target.entityId, service, by: 'app', user: pick(rng, house.users) });
  }
  return {
    intents,
    quiet: new Set(),
    symptom: { text: pickText(rng, NOT_RESPONDING, target.name), device: target.name },
    truth: { cause_id: 'stale_duplicate', entity_ids: [oldId, target.entityId], explanation: `The name ${target.name} still reaches an old copy left behind when the device was paired again.` },
    human: { confirm_flash: 'yes', power_switch_check: 'yes' },
    tags: [`ghost_days:${Math.floor((house.nowMs - offlineSince) / DAY)}`],
  };
};

const devicePowerLost: Storyline = (rng, house) => {
  const target = pick(rng, ensureSwitchable(rng, house, ['zigbee2mqtt', 'hue', 'matter', 'kasa', 'shelly'], 2));
  const since = house.nowMs - int(rng, 20, 30 * 60) * MINUTE;
  const intents: Intent[] = [{ t: since, kind: 'down', entityId: target.entityId }];
  const tags: string[] = [];
  if (chance(rng, 0.3)) {
    // An unrelated earlier blip, the kind that makes a weak link look plausible.
    const t = house.startMs + Math.floor(rng.next() * Math.max(MINUTE, since - house.startMs - 30 * MINUTE));
    if (t < since - 10 * MINUTE) {
      intents.push({ t, kind: 'down', entityId: target.entityId }, { t: t + int(rng, 1, 4) * MINUTE, kind: 'up', entityId: target.entityId });
      tags.push('earlier_blip');
    }
  }
  intents.push(...attempts(rng, house, target.entityId, since, int(rng, 1, 3)));
  const wall = chance(rng, 0.5);
  return {
    intents,
    quiet: new Set([target.entityId]),
    symptom: { text: pickText(rng, [...NOT_RESPONDING, 'The {name} stopped working.'], target.name), device: target.name },
    truth: { cause_id: 'device_power_lost', entity_ids: [target.entityId], explanation: wall ? 'Someone switched it off at the wall switch.' : 'It was unplugged.' },
    human: { power_switch_check: 'no', confirm_flash: 'no', router_changed: 'no', notes: wall ? 'The wall switch is off.' : 'The plug is not in the socket.' },
    tags: [...tags, wall ? 'wall_switch' : 'unplugged'],
  };
};

const radioLinkWeak: Storyline = (rng, house) => {
  const zigbee = chance(rng, 0.5);
  const target = pick(rng, ensureSwitchable(rng, house, zigbee ? ['zigbee2mqtt'] : ['kasa', 'shelly']));
  if (zigbee) target.lqi = int(rng, 6, 45);
  else target.rssi = int(rng, -88, -77);
  const intents: Intent[] = [];
  const drops = int(rng, 5, 14);
  const stillDown = chance(rng, 0.3);
  let t = house.nowMs - DAY + int(rng, 5, 60) * MINUTE;
  const step = (DAY - 2 * HOUR) / drops;
  for (let i = 0; i < drops; i++) {
    const at = Math.floor(t + rng.next() * step * 0.6);
    intents.push({ t: at, kind: 'down', entityId: target.entityId });
    const last = i === drops - 1;
    if (!(last && stillDown)) intents.push({ t: at + int(rng, 1, 6) * MINUTE, kind: 'up', entityId: target.entityId });
    t += step;
  }
  for (let i = int(rng, 0, 3); i > 0; i--) {
    const at = house.startMs + Math.floor(rng.next() * (house.nowMs - DAY - house.startMs));
    if (at > house.startMs) intents.push({ t: at, kind: 'down', entityId: target.entityId }, { t: at + int(rng, 1, 5) * MINUTE, kind: 'up', entityId: target.entityId });
  }
  intents.push(...attempts(rng, house, target.entityId, house.nowMs - 6 * HOUR, int(rng, 1, 3)));
  return {
    intents,
    quiet: new Set(),
    symptom: { text: pickText(rng, ['The {name} keeps dropping off.', 'Sometimes the {name} works and sometimes it says it is not responding.', ...NOT_RESPONDING], target.name), device: target.name },
    truth: { cause_id: 'radio_link_weak', entity_ids: [target.entityId], explanation: zigbee ? 'Too far from the Zigbee mesh: link quality is very low.' : 'At the edge of Wi-Fi coverage: the signal is very weak.' },
    human: { power_switch_check: 'yes', confirm_flash: stillDown ? 'no' : 'yes', router_changed: 'no' },
    tags: [zigbee ? 'zigbee' : 'wifi', `drops:${drops}`, ...(stillDown ? ['down_now'] : [])],
  };
};

const hubDown: Storyline = (rng, house) => {
  const integration = chance(rng, 0.6) ? 'zigbee2mqtt' : 'hue';
  const devices = ensureSwitchable(rng, house, [integration], 3);
  const all = house.devices.filter((d) => d.integration === integration);
  const since = house.nowMs - int(rng, 10, 20 * 60) * MINUTE;
  const reason = integration === 'zigbee2mqtt' ? pick(rng, ['Bridge offline: the Zigbee coordinator is not responding', 'Zigbee2MQTT bridge state: offline']) : pick(rng, ['Cannot reach the Hue bridge', 'Hue bridge did not respond, retrying']);
  house.integrations.set(integration, { integration, state: 'setup_retry', reason, entryId: `entry_${integration}` });
  const intents: Intent[] = [{ t: since, kind: 'row', row: { type: 'integration', when: iso(since), integration, state: 'setup_retry', old_state: 'loaded', reason } }];
  for (const d of all) intents.push({ t: since + int(rng, 0, 3000), kind: 'down', entityId: d.entityId });
  const target = pick(rng, devices);
  intents.push(...attempts(rng, house, target.entityId, since, int(rng, 1, 2)));
  return {
    intents,
    quiet: new Set(all.map((d) => d.entityId)),
    symptom: { text: pickText(rng, NOT_RESPONDING, target.name), device: target.name },
    truth: { cause_id: 'hub_down', entity_ids: [target.entityId], explanation: `The ${integration === 'hue' ? 'Hue bridge' : 'Zigbee coordinator'} stopped responding, taking every device on it offline.` },
    human: { power_switch_check: 'yes', confirm_flash: 'no', router_changed: 'no' },
    tags: [integration, `devices:${all.length}`],
  };
};

const vendorCloudOutage: Storyline = (rng, house) => {
  const integration = chance(rng, 0.5) ? 'ecobee' : 'tuya';
  if (!house.devices.some((d) => d.integration === integration)) {
    addDevice(rng, house, integration === 'ecobee' ? { kind: 'thermostat', room: pick(rng, house.rooms), integration, name: 'Thermostat' } : { kind: 'plug', room: pick(rng, house.rooms), integration });
  }
  const devices = house.devices.filter((d) => d.integration === integration);
  const since = house.nowMs - int(rng, 5, 6 * 60) * MINUTE;
  house.cloud.set(integration, chance(rng, 0.5) ? 'outage' : 'degraded');
  const intents: Intent[] = [];
  const shown = chance(rng, 0.7);
  for (const d of devices) intents.push(shown ? { t: since + int(rng, 1, 5) * MINUTE, kind: 'down', entityId: d.entityId } : { t: since, kind: 'stuck', entityId: d.entityId });
  const target = pick(rng, devices);
  intents.push(...attempts(rng, house, target.entityId, since + 6 * MINUTE, int(rng, 1, 3)));
  return {
    intents,
    quiet: new Set(devices.map((d) => d.entityId)),
    symptom: { text: target.kind === 'thermostat' ? pick(rng, ['The thermostat will not change temperature.', 'Why is the thermostat not responding?']) : pickText(rng, NOT_RESPONDING, target.name), device: target.name },
    truth: { cause_id: 'vendor_cloud_outage', entity_ids: [target.entityId], explanation: `The ${target.vendor} cloud is having problems.` },
    human: { router_changed: 'no', power_switch_check: 'yes' },
    tags: [integration, shown ? 'unavailable' : 'silent_failure'],
  };
};

const accountLinkExpired: Storyline = (rng, house) => {
  const integration = pick(rng, ['hue', 'tuya', 'ecobee']);
  if (!house.devices.some((d) => d.integration === integration)) {
    addDevice(rng, house, integration === 'ecobee' ? { kind: 'thermostat', room: pick(rng, house.rooms), integration, name: 'Thermostat' } : { kind: integration === 'hue' ? 'light' : 'plug', room: pick(rng, house.rooms), integration });
  }
  const devices = house.devices.filter((d) => d.integration === integration);
  const since = house.nowMs - int(rng, 30, 3 * 24 * 60) * MINUTE;
  const reason = pick(rng, ['invalid_auth: refresh token expired', 'Authentication failed. Sign in again to relink your account.', 'Reauthentication required: the account link expired', 'Unauthorized: credentials no longer valid']);
  house.integrations.set(integration, { integration, state: 'setup_error', reason, entryId: `entry_${integration}` });
  const intents: Intent[] = [{ t: since, kind: 'row', row: { type: 'integration', when: iso(since), integration, state: 'setup_error', old_state: 'loaded', reason } }];
  for (const d of devices) intents.push({ t: since + int(rng, 0, 2000), kind: 'down', entityId: d.entityId });
  const target = pick(rng, devices);
  intents.push(...attempts(rng, house, target.entityId, Math.max(since, house.startMs) + MINUTE, int(rng, 1, 2)));
  return {
    intents,
    quiet: new Set(devices.map((d) => d.entityId)),
    symptom: { text: pickText(rng, NOT_RESPONDING, target.name), device: target.name },
    truth: { cause_id: 'account_link_expired', entity_ids: [target.entityId], explanation: `The link to the ${integration} account expired.` },
    human: { power_switch_check: 'yes', router_changed: 'no' },
    tags: [integration],
  };
};

const powerOnDefaultOn: Storyline = (rng, house) => {
  const pushDevices = ensureSwitchable(rng, house, ['zigbee2mqtt', 'matter'], 5);
  if (!pushDevices.some((d) => d.integration === 'matter')) addDevice(rng, house, { kind: 'light', room: pick(rng, house.rooms), integration: 'matter', powerOn: 'on' });
  if (!pushDevices.some((d) => d.integration === 'zigbee2mqtt')) addDevice(rng, house, { kind: 'light', room: pick(rng, house.rooms), integration: 'zigbee2mqtt', powerOn: 'on' });
  const restart = switchables(house, ['zigbee2mqtt', 'matter']);
  const turnOn = sample(rng, restart, Math.max(3, Math.ceil(restart.length * between(rng, 0.5, 1))));
  for (const d of restart) d.powerOn = turnOn.includes(d) ? 'on' : chance(rng, 0.8) ? 'previous' : 'off';
  const night = localDayKey(house.nowMs, house.tz);
  const p = localParts(house.nowMs, house.tz);
  let outage = atLocal(night, `0${int(rng, 1, 4)}:${String(int(rng, 0, 59)).padStart(2, '0')}:${String(int(rng, 0, 59)).padStart(2, '0')}`, house.tz);
  if (outage > house.nowMs - HOUR || p.hour < 6) outage -= DAY;
  const duration = int(rng, 1, 30) * 1000;
  const intents: Intent[] = [];
  for (const d of restart) {
    intents.push({ t: outage + int(rng, 50, 900), kind: 'down', entityId: d.entityId });
    const back = outage + duration + int(rng, 300, 3500);
    intents.push({ t: back, kind: 'up', entityId: d.entityId, ...(d.powerOn === 'on' ? { to: 'on' } : d.powerOn === 'off' ? { to: 'off' } : {}) });
    if (d.integration === 'matter') intents.push({ t: back - 100, kind: 'row', row: { type: 'device_event', when: iso(back - 100), entity_id: d.entityId, event: 'boot_reason', data: { reason: 'PowerOnReboot' } } });
    d.bootMs = back;
  }
  const hour = localParts(outage, house.tz).hour;
  const when = hour === 0 ? 'midnight' : `${hour} a.m.`;
  return {
    intents,
    blackout: [outage - 5 * MINUTE, outage + duration + 5 * MINUTE],
    // Everyone was asleep: no one touches the devices between the outage and the question.
    quiet: new Set(restart.map((d) => d.entityId)),
    symptom: { text: pick(rng, [`Why did every light turn on at ${when}?`, `Why did the plugs all turn on at ${when} last night?`, `Something turned my lights on around ${when}. What was it?`]) },
    truth: { cause_id: 'power_on_default_on', entity_ids: turnOn.map((d) => d.entityId).sort(), explanation: 'Power dropped for a moment and came back; devices set to start on switched themselves on.' },
    human: { power_switch_check: 'yes', notes: 'The lights were on when they woke up. Nobody switched them on.' },
    tags: [`restarted:${restart.length}`, `turned_on:${turnOn.length}`, `outage_s:${duration / 1000}`],
  };
};

const nameCollision: Storyline = (rng, house) => {
  const lights = ensureSwitchable(rng, house, ['zigbee2mqtt', 'hue', 'matter'], 2);
  const [a, b] = sample(rng, lights, 2) as [GenDevice, GenDevice];
  const shared = chance(rng, 0.5) ? a.name : `${a.room} Light`;
  a.name = shared;
  b.name = chance(rng, 0.3) ? shared.toLowerCase() : shared;
  const intents: Intent[] = [];
  for (let i = int(rng, 1, 3); i > 0; i--) {
    const t = house.nowMs - int(rng, 30, 36 * 60) * MINUTE;
    const service = chance(rng, 0.5) ? 'turn_off' : 'turn_on';
    intents.push({ t, kind: 'cmd', entityId: a.entityId, service, by: 'voice', user: pick(rng, house.users) });
    intents.push({ t: t + int(rng, 20, 90) * 1000, kind: 'cmd', entityId: b.entityId, service, by: 'app', user: pick(rng, house.users) });
  }
  return {
    intents,
    quiet: new Set(),
    symptom: { text: pickText(rng, ['When I say turn off the {name}, the wrong light turns off.', 'The {name} does nothing when I ask, but another light reacts.'], shared), device: shared },
    truth: { cause_id: 'name_collision', entity_ids: [a.entityId, b.entityId], explanation: `Two different devices are both called ${shared}.` },
    human: { power_switch_check: 'yes' },
    tags: [a.room === b.room ? 'same_room' : 'different_rooms'],
  };
};

const deadTrigger: Storyline = (rng, house) => {
  const devices = ensureSwitchable(rng, house, ['zigbee2mqtt', 'kasa', 'shelly', 'matter', 'hue'], 2);
  const removedDevice = pick(rng, devices);
  const name = pick(rng, ['Grow light schedule', 'Fountain timer', 'Porch light at dusk', 'Morning heater', 'Night fan']);
  const at = `0${int(rng, 6, 8)}:${String(int(rng, 0, 5) * 10).padStart(2, '0')}`;
  const auto = { entityId: `automation.${name.toLowerCase().replace(/ /g, '_')}`, name, times: [at], targets: [removedDevice.entityId], service: 'turn_on' as const };
  house.automations = house.automations.filter((a) => a.entityId !== auto.entityId);
  house.automations.push(auto);
  const removedAt = house.nowMs - int(rng, 1, 10) * DAY - int(rng, 0, 20) * HOUR;
  house.removed.add(removedDevice.entityId);
  const intents: Intent[] = [
    { t: removedAt, kind: 'remove', entityId: removedDevice.entityId },
    { t: removedAt, kind: 'row', row: { type: 'registry', when: iso(removedAt), action: 'remove', entity_id: removedDevice.entityId } },
  ];
  if (chance(rng, 0.5)) {
    // The owner replaced it with a new plug under a similar name, but never updated the automation.
    addDevice(rng, house, { kind: removedDevice.kind, room: removedDevice.room, integration: removedDevice.integration, name: `${removedDevice.name} 2` });
  }
  return {
    intents,
    quiet: new Set([removedDevice.entityId]),
    symptom: { text: pick(rng, [`My ${name} automation stopped working.`, `Why did the ${name.toLowerCase()} not run this morning?`]) },
    truth: { cause_id: 'dead_trigger', entity_ids: [auto.entityId, removedDevice.entityId], explanation: `${name} still targets a device that was removed.` },
    human: { notes: 'Nothing happens at the scheduled time.' },
    tags: [`refs:${references(auto).length}`],
  };
};

const wifiNetworkChanged: Storyline = (rng, house) => {
  ensureSwitchable(rng, house, ['kasa', 'shelly'], 2);
  const wifi = house.devices.filter((d) => d.transport === 'wifi');
  const since = house.nowMs - int(rng, 15, 2 * 24 * 60) * MINUTE;
  const intents: Intent[] = wifi.map((d) => ({ t: since + int(rng, 0, 90) * 1000, kind: 'down' as const, entityId: d.entityId }));
  const target = pick(rng, wifi);
  intents.push(...attempts(rng, house, target.entityId, since + 2 * MINUTE, int(rng, 1, 3)));
  return {
    intents,
    quiet: new Set(wifi.map((d) => d.entityId)),
    symptom: { text: pick(rng, ['All my smart plugs stopped working.', `The ${target.name} says it is offline.`, ...NOT_RESPONDING.map((x) => x.replace('{name}', target.name))]), device: target.name },
    truth: { cause_id: 'wifi_network_changed', entity_ids: wifi.map((d) => d.entityId).sort(), explanation: 'A new router (or a renamed network) left the Wi-Fi devices looking for the old one.' },
    human: { router_changed: 'yes', power_switch_check: 'yes', confirm_flash: 'no' },
    tags: [`wifi_devices:${wifi.length}`],
  };
};

export const STORYLINES: Readonly<Record<CauseId, Storyline>> = {
  stale_duplicate: staleDuplicate,
  device_power_lost: devicePowerLost,
  radio_link_weak: radioLinkWeak,
  hub_down: hubDown,
  vendor_cloud_outage: vendorCloudOutage,
  account_link_expired: accountLinkExpired,
  power_on_default_on: powerOnDefaultOn,
  name_collision: nameCollision,
  dead_trigger: deadTrigger,
  wifi_network_changed: wifiNetworkChanged,
};

/** True but irrelevant things a careless agent will latch onto. */
export function distractors(rng: Rng, house: GenHouse, cause: CauseId, story: Story): { intents: Intent[]; tags: string[] } {
  const intents: Intent[] = [];
  const tags: string[] = [];
  const truth = story.truth.entity_ids;
  // Never touch a device the story is using: a distractor must not undo the fault.
  const untouchable = (id: string): boolean => truth.includes(id) || story.quiet.has(id) || house.removed.has(id);
  const others = house.devices.filter((d) => !untouchable(d.entityId));
  const flappy = others.filter((d) => d.mains && d.kind !== 'thermostat');
  if (flappy.length > 0 && chance(rng, 0.5)) {
    const d = pick(rng, flappy);
    for (let i = int(rng, 1, 2); i > 0; i--) {
      const t = house.startMs + Math.floor(rng.next() * (house.nowMs - house.startMs - 20 * MINUTE));
      intents.push({ t, kind: 'down', entityId: d.entityId }, { t: t + int(rng, 1, 3) * MINUTE, kind: 'up', entityId: d.entityId });
    }
    tags.push('distractor:blip');
  }
  const sensors = others.filter((d) => d.battery !== undefined);
  if (sensors.length > 0 && chance(rng, 0.3) && cause !== 'device_power_lost') {
    pick(rng, sensors).battery = int(rng, 3, 14);
    tags.push('distractor:low_battery');
  }
  if (chance(rng, 0.2) && cause !== 'stale_duplicate' && cause !== 'name_collision') {
    const d = pick(rng, others.length > 0 ? others : house.devices);
    const since = house.nowMs - int(rng, 30, 200) * DAY;
    house.ghosts.push({
      entityId: uniqueEntityId(house, d.domain, `Old ${d.name}`),
      name: `Old ${d.name}`,
      aliases: [],
      domain: d.domain,
      integration: d.integration,
      transport: d.transport,
      state: 'unavailable',
      attributes: { friendly_name: `Old ${d.name}`, restored: true },
      lastChanged: iso(since),
      lastUpdated: iso(since),
      restored: true,
    });
    tags.push('distractor:old_ghost');
  }
  if (chance(rng, 0.25) && cause !== 'power_on_default_on') {
    // Home Assistant restarted: every entity blinks unavailable for a few seconds, with integration rows.
    const t = house.startMs + Math.floor(rng.next() * (house.nowMs - house.startMs - 2 * HOUR));
    for (const integ of house.integrations.keys()) {
      intents.push({ t: t + 9000, kind: 'row', row: { type: 'integration', when: iso(t + 9000), integration: integ, state: 'loaded', old_state: 'not_loaded' } });
    }
    for (const d of others) {
      intents.push({ t: t + int(rng, 0, 500), kind: 'down', entityId: d.entityId }, { t: t + int(rng, 8000, 15000), kind: 'up', entityId: d.entityId });
    }
    tags.push('distractor:ha_restart');
  }
  ensureIntegration(house, 'automation');
  return { intents, tags };
}
