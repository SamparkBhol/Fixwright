// Fault injection for the Home Assistant fixture (fixtures/home-assistant/config). Every fault is made
// with Home Assistant's own mechanisms, never a cosmetic state, unless the name says "forced":
//   unavailable   the porch bulb drops off its radio mesh (availability template), or any entity forced
//   ghost         the old pairing's YAML disappears and templates reload: registry kept, restored=true
//   duplicate     a registry rename makes two entities answer to one spoken name
//   power cut     the hallway breaker goes off and on again, optionally at a given time
//   power on      every circuit device's power on behavior select is set and read back
//   bridge down   the simulated bridge loses its network link: its lights go unavailable, set by the
//                 integration itself, and stay so until its config entry is reloaded (bridge up only
//                 restores the link)
// Importable (an agent's integration tests can use it) and runnable from the repository root:
//   node fixtures/home-assistant/inject.ts setup | unavailable [entity] | available [entity] | ghost | unghost
//        | duplicate <entity> <name> | power-cut [--at <ISO>] [--hold <ms>] | power-on <option> [entity...]
//        | bridge-down | bridge-up
// Credentials: HA_URL and HA_TOKEN, else HA_SECRETS (default .secrets/ha.json). Ghost needs HA_CONFIG_DIR.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHaClient, type HaClient, type HaEvent, type HaState, type StateChangedData } from './ha-client.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CIRCUIT = {
  breaker: 'input_boolean.hallway_mains',
  mains: 'binary_sensor.hallway_mains_power',
  porchLink: 'input_boolean.porch_light_link',
  lamp: 'light.hallway_lamp',
  ghost: 'light.hallway_lamp_old_pairing',
  group: 'light.hallway_lights',
  powerSensor: 'sensor.hallway_plug_power',
  plugUptime: 'sensor.hallway_smart_plug_uptime',
  restoreLog: 'input_datetime.hallway_last_power_restore',
  restoreAutomation: 'automation.hallway_power_restore_log',
  /** The six devices on the circuit, each with a power on behavior select. */
  devices: [
    'light.hallway_lamp',
    'light.porch_light',
    'light.landing_light',
    'light.stair_light',
    'light.entry_light',
    'switch.hallway_smart_plug',
  ],
  area: 'Hallway',
} as const;

/** F9 shape: an automation that still refers to a plug removed from the house. */
export const DEAD_TRIGGER = { automation: 'automation.grow_light_schedule', missing: 'switch.grow_light_plug' } as const;
/** A script the guard must never start; it would turn the porch light on. */
export const ROUTINE_SCRIPT = 'script.evening_routine';

export const powerOnSelect = (deviceId: string): string => `select.${deviceId.split('.')[1]}_power_on_behavior`;

/** The simulated bridge (custom_components/homefault_bridge): one config entry, two lights behind it. */
export const BRIDGE = {
  integration: 'homefault_bridge',
  link: 'input_boolean.homefault_bridge_link',
  lights: ['light.bridge_lamp', 'light.bridge_spot'],
} as const;

export interface Fixture {
  adapter: HaClient;
  /** The live config dir Home Assistant runs from (needed only for ghost and unghost). */
  configDir?: string | undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls Home Assistant until `check` holds for the entity's raw state (or its absence). */
export async function waitForState(fx: Fixture, entityId: string, check: (s: HaState | undefined) => boolean, timeoutMs = 8000): Promise<HaState | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let s: HaState | undefined;
    try {
      s = await fx.adapter.rest.state(entityId);
    } catch {
      s = undefined;
    }
    if (check(s)) return s;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting on ${entityId} (now ${s?.state ?? 'absent'})`);
    await sleep(50);
  }
}

/** Records state_changed events so callers can wait for the exact Home Assistant timestamps. */
export async function recordStates(fx: Fixture) {
  const events: Array<HaEvent<StateChangedData>> = [];
  const waiters: Array<{ pred: (e: HaEvent<StateChangedData>) => boolean; resolve: (e: HaEvent<StateChangedData>) => void; from: number }> = [];
  const socket = await fx.adapter.socket();
  const unsubscribe = await socket.subscribeEvents<StateChangedData>('state_changed', (e) => {
    events.push(e);
    for (const w of [...waiters]) {
      if (events.length - 1 >= w.from && w.pred(e)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(e);
      }
    }
  });
  return {
    events,
    mark: () => events.length,
    waitFor(pred: (e: HaEvent<StateChangedData>) => boolean, from: number, timeoutMs = 8000, label = 'state change') {
      const hit = events.slice(from).find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise<HaEvent<StateChangedData>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)), timeoutMs);
        waiters.push({ pred, from, resolve: (e) => (clearTimeout(timer), resolve(e)) });
      });
    },
    stop: unsubscribe,
  };
}

const to = (entityId: string, test: (state: string) => boolean) => (e: HaEvent<StateChangedData>) =>
  e.data.entity_id === entityId && !!e.data.new_state && test(e.data.new_state.state);

/**
 * Brings a freshly onboarded fixture to its baseline: a Hallway area holding the circuit, mains on,
 * and every circuit device off by an explicit command (so a later power restore applies the power on
 * behavior the way real bulbs do).
 */
export async function setup(fx: Fixture): Promise<Record<string, unknown>> {
  const socket = await fx.adapter.socket();
  const areas = await socket.command<Array<{ area_id: string; name: string }>>('config/area_registry/list');
  const area =
    areas.find((a) => a.name === CIRCUIT.area) ??
    (await socket.command<{ area_id: string; name: string }>('config/area_registry/create', { name: CIRCUIT.area }));
  const inArea = [...CIRCUIT.devices, CIRCUIT.ghost, CIRCUIT.group, CIRCUIT.mains, CIRCUIT.powerSensor, ...CIRCUIT.devices.map(powerOnSelect)];
  for (const id of inArea) await socket.command('config/entity_registry/update', { entity_id: id, area_id: area.area_id });
  await waitForState(fx, CIRCUIT.mains, (s) => s?.state === 'on');
  const lights = CIRCUIT.devices.filter((d) => d.startsWith('light.'));
  await fx.adapter.callService('light', 'turn_off', { entity_id: lights });
  await fx.adapter.callService('switch', 'turn_off', { entity_id: 'switch.hallway_smart_plug' });
  for (const d of CIRCUIT.devices) await waitForState(fx, d, (s) => s?.state === 'off');
  return { area: area.area_id, devices_off: CIRCUIT.devices.length };
}

/** The porch bulb leaves its mesh (real unavailability); any other entity gets a forced state. */
export async function unavailable(fx: Fixture, entityId: string = 'light.porch_light'): Promise<'link' | 'forced'> {
  if (entityId === 'light.porch_light') {
    await fx.adapter.callService('input_boolean', 'turn_off', { entity_id: CIRCUIT.porchLink });
    await waitForState(fx, entityId, (s) => s?.state === 'unavailable');
    return 'link';
  }
  const current = await fx.adapter.rest.state(entityId);
  await fx.adapter.rest.forceState(entityId, 'unavailable', current.attributes);
  return 'forced';
}

export async function available(fx: Fixture, entityId: string = 'light.porch_light'): Promise<void> {
  if (entityId === 'light.porch_light') {
    await fx.adapter.callService('input_boolean', 'turn_on', { entity_id: CIRCUIT.porchLink });
  } else {
    await fx.adapter.callService('homeassistant', 'update_entity', { entity_id: entityId });
  }
  await waitForState(fx, entityId, (s) => !!s && s.state !== 'unavailable');
}

function templatesDir(fx: Fixture): string {
  if (!fx.configDir) throw new Error('ghost injection edits the config dir; set HA_CONFIG_DIR');
  return join(fx.configDir, 'templates');
}

/** Real orphan: the integration stops providing the old pairing, the registry keeps it (restored=true). */
export async function ghost(fx: Fixture): Promise<void> {
  const dir = templatesDir(fx);
  if (existsSync(join(dir, 'old_pairing.yaml'))) renameSync(join(dir, 'old_pairing.yaml'), join(dir, 'old_pairing.yaml.off'));
  await fx.adapter.reloadIntegration('template');
  await waitForState(fx, CIRCUIT.ghost, (s) => s?.attributes['restored'] === true);
  for (const d of CIRCUIT.devices) await waitForState(fx, d, (s) => !!s && s.state !== 'unavailable');
}

/** Puts the old pairing's YAML back (re-creating it if the registry entry was removed). */
export async function unghost(fx: Fixture): Promise<void> {
  const dir = templatesDir(fx);
  if (existsSync(join(dir, 'old_pairing.yaml.off'))) renameSync(join(dir, 'old_pairing.yaml.off'), join(dir, 'old_pairing.yaml'));
  await fx.adapter.reloadIntegration('template');
  await waitForState(fx, CIRCUIT.ghost, (s) => !!s && s.attributes['restored'] !== true);
  for (const d of CIRCUIT.devices) await waitForState(fx, d, (s) => !!s && s.state !== 'unavailable');
}

/** Gives `entityId` the spoken name `name`. Returns the previous registry name for undo. */
export async function duplicateName(fx: Fixture, entityId: string, name: string): Promise<string | null> {
  const socket = await fx.adapter.socket();
  const before = await socket.command<{ name: string | null }>('config/entity_registry/get', { entity_id: entityId });
  await fx.adapter.registryUpdate(entityId, { name });
  return before.name;
}

export interface PowerCutResult {
  /** Home Assistant's own timestamps (ISO, UTC). */
  breakerOffAt: string;
  mainsOffAt: string;
  breakerOnAt: string;
  mainsOnAt: string;
  devicesBackAt: string[];
  devicesOnAfter: string[];
}

/**
 * Cuts the hallway breaker at `at` (now if omitted), holds it off for `holdMs`, restores it, and waits
 * until every circuit device is back. Devices whose power on behavior is "on" come back on, with no
 * user, service or automation context: the F2 shape.
 */
export async function powerCut(fx: Fixture, opts: { at?: string | number; holdMs?: number } = {}): Promise<PowerCutResult> {
  const holdMs = opts.holdMs ?? 2000;
  if (opts.at !== undefined) {
    const atMs = typeof opts.at === 'number' ? opts.at : Date.parse(opts.at);
    if (!Number.isFinite(atMs)) throw new Error(`not a time: ${String(opts.at)}`);
    const wait = atMs - Date.now();
    if (wait > 86_400_000) throw new Error('power cuts can be scheduled at most 24 hours ahead');
    if (wait > 0) await sleep(wait);
  }
  const rec = await recordStates(fx);
  try {
    let mark = rec.mark();
    await fx.adapter.callService('input_boolean', 'turn_off', { entity_id: CIRCUIT.breaker });
    const breakerOff = await rec.waitFor(to(CIRCUIT.breaker, (s) => s === 'off'), mark, 5000, 'breaker off');
    const mainsOff = await rec.waitFor(to(CIRCUIT.mains, (s) => s === 'off'), mark, 5000, 'mains off');
    await Promise.all(CIRCUIT.devices.map((d) => rec.waitFor(to(d, (s) => s === 'unavailable'), mark, 5000, `${d} unavailable`)));
    await sleep(holdMs);
    mark = rec.mark();
    await fx.adapter.callService('input_boolean', 'turn_on', { entity_id: CIRCUIT.breaker });
    const breakerOn = await rec.waitFor(to(CIRCUIT.breaker, (s) => s === 'on'), mark, 5000, 'breaker on');
    const mainsOn = await rec.waitFor(to(CIRCUIT.mains, (s) => s === 'on'), mark, 5000, 'mains on');
    const back = await Promise.all(CIRCUIT.devices.map((d) => rec.waitFor(to(d, (s) => s !== 'unavailable'), mark, 5000, `${d} back`)));
    return {
      breakerOffAt: new Date(breakerOff.data.new_state?.last_changed ?? '').toISOString(),
      mainsOffAt: new Date(mainsOff.data.new_state?.last_changed ?? '').toISOString(),
      breakerOnAt: new Date(breakerOn.data.new_state?.last_changed ?? '').toISOString(),
      mainsOnAt: new Date(mainsOn.data.new_state?.last_changed ?? '').toISOString(),
      devicesBackAt: back.map((e) => new Date(e.data.new_state?.last_changed ?? '').toISOString()),
      devicesOnAfter: back.filter((e) => e.data.new_state?.state === 'on').map((e) => e.data.entity_id),
    };
  } finally {
    await rec.stop();
  }
}

/** The bridge stops answering: its lights become unavailable (the integration sets that itself). */
export async function bridgeDown(fx: Fixture): Promise<void> {
  await fx.adapter.callService('input_boolean', 'turn_off', { entity_id: BRIDGE.link });
  for (const id of BRIDGE.lights) await waitForState(fx, id, (s) => s?.state === 'unavailable');
}

/**
 * The bridge answers again. Its lights stay unavailable: like a real bridge integration with a dead
 * connection, only a reload of its config entry brings them back.
 */
export async function bridgeUp(fx: Fixture): Promise<void> {
  await fx.adapter.callService('input_boolean', 'turn_on', { entity_id: BRIDGE.link });
  await waitForState(fx, BRIDGE.link, (s) => s?.state === 'on');
}

/** Sets the power on behavior of the given circuit devices (all six by default), each read back. */
export async function setPowerOnBehavior(fx: Fixture, option: string, deviceIds: readonly string[] = CIRCUIT.devices): Promise<void> {
  for (const d of deviceIds) await fx.adapter.selectOption(powerOnSelect(d), option);
}

function credentials(): { url: string; token: string } {
  const url = process.env['HA_URL'];
  const token = process.env['HA_TOKEN'];
  if (url && token) return { url, token };
  const file = process.env['HA_SECRETS'] ?? join(PKG, '.secrets', 'ha.json');
  const s = JSON.parse(readFileSync(file, 'utf8')) as { url: string; token: string };
  return { url: s.url, token: s.token };
}

async function cli(argv: string[]): Promise<unknown> {
  const { url, token } = credentials();
  const fx: Fixture = { adapter: createHaClient({ baseUrl: url, token }), configDir: process.env['HA_CONFIG_DIR'] };
  const [cmd, ...args] = argv;
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  try {
    switch (cmd) {
      case 'setup':
        return await setup(fx);
      case 'unavailable':
        return { mode: await unavailable(fx, args[0]) };
      case 'available':
        await available(fx, args[0]);
        return { ok: true };
      case 'ghost':
        await ghost(fx);
        return { ok: true };
      case 'unghost':
        await unghost(fx);
        return { ok: true };
      case 'duplicate': {
        const [entityId, ...name] = args;
        if (!entityId || name.length === 0) throw new Error('usage: duplicate <entity> <name>');
        return { previous: await duplicateName(fx, entityId, name.join(' ')) };
      }
      case 'power-cut': {
        const hold = flag('--hold');
        const at = flag('--at');
        return await powerCut(fx, { ...(at ? { at } : {}), ...(hold ? { holdMs: Number(hold) } : {}) });
      }
      case 'bridge-down':
        await bridgeDown(fx);
        return { ok: true };
      case 'bridge-up':
        await bridgeUp(fx);
        return { ok: true };
      case 'power-on': {
        const [option, ...devices] = args;
        if (!option) throw new Error('usage: power-on <off|on|toggle|previous> [entity...]');
        await setPowerOnBehavior(fx, option, devices.length ? devices : CIRCUIT.devices);
        return { ok: true };
      }
      default:
        throw new Error(`unknown command ${String(cmd)}`);
    }
  } finally {
    fx.adapter.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli(process.argv.slice(2)).then(
    (out) => console.log(JSON.stringify({ inject: process.argv[2], ...((out as object) ?? {}) })),
    (err: unknown) => {
      console.error('inject failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
