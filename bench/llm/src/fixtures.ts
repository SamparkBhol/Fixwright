import type { DiagnosisInput } from './prompt.ts';

/**
 * A small hand-written smart home log for the smoke test: the hallway lamp was re-paired and the
 * spoken name still points at the old, offline copy (cause stale_duplicate). Synthetic, no real home.
 */
export const HALLWAY_LAMP_CASE: DiagnosisInput & { expectedCause: string } = {
  expectedCause: 'stale_duplicate',
  symptom: "The hallway lamp keeps saying it's not responding.",
  log: `entities:
light.hallway_lamp      name="Hallway Lamp" integration=zigbee2mqtt state=unavailable restored=true last_changed=2026-10-03T21:14:05Z
light.hallway_lamp_2    name="Hallway Lamp" integration=zigbee2mqtt state=off last_changed=2026-10-14T19:02:11Z linkquality=168
light.porch             name="Porch Light" integration=hue state=on last_changed=2026-10-14T18:30:00Z
sensor.hall_motion_battery name="Hall Motion Battery" integration=zigbee2mqtt state=64
integrations:
zigbee2mqtt loaded; hue loaded; kasa loaded
hub: zigbee coordinator reachable latency_ms=12
cloud: hue ok (checked 2026-10-14T19:05:00Z)
logbook:
2026-10-03T21:14:05Z light.hallway_lamp on -> unavailable
2026-10-03T21:20:40Z zigbee2mqtt device_joined ieee=0x00178801 friendly_name=hallway_lamp_2
2026-10-03T21:21:02Z light.hallway_lamp_2 unavailable -> off
2026-10-14T18:59:58Z voice command "turn on Hallway Lamp" -> light.turn_on light.hallway_lamp -> error: entity unavailable
2026-10-14T19:01:40Z app user toggled light.hallway_lamp_2 off -> on
2026-10-14T19:02:11Z app user toggled light.hallway_lamp_2 on -> off
2026-10-14T19:04:30Z voice command "turn off Hallway Lamp" -> light.turn_off light.hallway_lamp -> error: entity unavailable
`,
};

const DISTRACTOR_ENTITIES = [
  'light.kitchen_ceiling',
  'switch.coffee_maker',
  'sensor.living_room_temperature',
  'binary_sensor.front_door',
  'light.bedroom_lamp',
  'fan.office_fan',
  'sensor.kitchen_plug_power',
  'light.porch',
] as const;

/**
 * A longer, deterministic log for throughput measurement: the hallway case plus routine distractor
 * rows, `rows` lines long. The measurement script trims it to an exact token count with /tokenize.
 */
export function longLog(rows: number): string {
  const lines: string[] = [HALLWAY_LAMP_CASE.log.trimEnd()];
  const start = Date.UTC(2026, 9, 14, 6, 0, 0);
  for (let i = 0; i < rows; i++) {
    const ts = new Date(start + i * 97_000).toISOString().replace('.000Z', 'Z');
    const entity = DISTRACTOR_ENTITIES[i % DISTRACTOR_ENTITIES.length];
    const value = entity.startsWith('sensor.') ? `${18 + (i % 7)}.${i % 10} -> ${18 + ((i + 1) % 7)}.${(i + 3) % 10}` : i % 2 === 0 ? 'off -> on' : 'on -> off';
    const ctx = i % 3 === 0 ? 'context=automation.morning_routine' : i % 3 === 1 ? 'context=user' : 'context=none';
    lines.push(`${ts} ${entity} ${value} ${ctx}`);
  }
  return lines.join('\n') + '\n';
}
