// Records real Home Assistant payloads around one power cut and restore into test/fixtures/recorded/,
// so the unit tests replay genuine 2026.9.4 shapes (websocket logbook rows, compressed history, registry
// entries) instead of hand written guesses. Needs a running fixture: scripts/ha-local.sh start.
// The ids inside are random ids of a throwaway local instance.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHaAdapter } from '../src/index.ts';
import { BRIDGE, CIRCUIT, powerCut, setup } from '../fixtures/home-assistant/inject.ts';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(PKG, 'test', 'fixtures', 'recorded');
const secrets = JSON.parse(readFileSync(process.env['HA_SECRETS'] ?? join(PKG, '.secrets', 'ha.json'), 'utf8')) as { url: string; token: string };
const adapter = createHaAdapter({ baseUrl: secrets.url, token: secrets.token });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

try {
  const socket = await adapter.socket();
  await setup({ adapter }); // every circuit device off by command, so the restore shows the F2 shape
  await sleep(1200);
  const since = new Date().toISOString();
  const cut = await powerCut({ adapter }, { holdMs: 1500 });
  await sleep(1500); // recorder commit_interval is 1 s
  const until = new Date().toISOString();
  const ids = [...CIRCUIT.devices, CIRCUIT.breaker, CIRCUIT.mains, CIRCUIT.group, CIRCUIT.powerSensor, CIRCUIT.plugUptime, CIRCUIT.restoreLog];
  // Legacy named entities on a device (has_entity_name false), for the friendly name prediction.
  const bridgeIds = [...BRIDGE.lights, 'sensor.hallway_bridge_signal', 'sensor.hallway_bridge_firmware_version'];
  const logbook = await socket.command('logbook/get_events', { start_time: since, end_time: until });
  const history = await socket.command('history/history_during_period', {
    start_time: since,
    end_time: until,
    entity_ids: ids,
    include_start_time_state: true,
    significant_changes_only: false,
    minimal_response: true,
    no_attributes: true,
  });
  const registry = await socket.command('config/entity_registry/get_entries', {
    entity_ids: [CIRCUIT.lamp, CIRCUIT.ghost, 'light.bed_light', CIRCUIT.group, 'select.hallway_lamp_power_on_behavior', ...bridgeIds],
  });
  const devices = await socket.command<Array<{ id: string; name: string | null }>>('config/device_registry/list');
  const areas = await socket.command('config/area_registry/list');
  const states = await adapter.rest.states();
  const pick = new Set([...ids, ...bridgeIds, CIRCUIT.ghost, 'light.bed_light', 'select.hallway_lamp_power_on_behavior', 'binary_sensor.hall_motion', 'sensor.hall_motion_battery']);
  const entries = await adapter.rest.configEntries();
  mkdirSync(OUT, { recursive: true });
  const write = (name: string, data: unknown) => writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
  write('power-cut', { recorded_with: 'Home Assistant 2026.9.4', since, until, cut, logbook, history });
  write('registry', { recorded_with: 'Home Assistant 2026.9.4', entries: registry, devices: devices.filter((d) => ['Bed Light', 'Hallway Bridge', 'Bridge Lamp', 'Bridge Spot'].includes(d.name ?? '')), areas });
  write('states', { recorded_with: 'Home Assistant 2026.9.4', states: states.filter((s) => pick.has(s.entity_id)), config_entries: entries });
  console.log(JSON.stringify({ recorded: OUT, logbook_rows: (logbook as unknown[]).length }));
} finally {
  adapter.close();
}
