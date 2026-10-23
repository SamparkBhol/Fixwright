// Authoring kit for hand-written incident scenarios. An incident is written as a short list of devices
// and a timeline of what happened, in household time; buildIncident() runs the timeline and produces a
// complete scenario (home, raw logs, signals) that validates against schema/scenario.schema.json.

import type { HaContext, LogRow } from '../src/logrows.ts';
import { sortRows } from '../src/logrows.ts';
import { iso, parseLocal } from '../src/time.ts';
import { SCENARIO_FORMAT, type GroundTruth, type HumanTruth, type Scenario, type ScenarioSource } from '../src/scenario/types.ts';
import type { CloudStatus, Entity, IntegrationStatus, Signals, Transport } from '../src/types.ts';

const TRANSPORT: Readonly<Record<string, Transport>> = {
  zigbee2mqtt: 'zigbee',
  hue: 'zigbee',
  matter: 'thread',
  kasa: 'wifi',
  shelly: 'wifi',
  sengled: 'wifi',
  amazon_basics: 'wifi',
  amazon_smart_plug: 'wifi',
  govee: 'cloud',
  tuya: 'cloud',
  gree: 'cloud',
  ecobee: 'cloud',
  harmony: 'cloud',
  openhab: 'cloud',
  hue_cloud: 'cloud',
  automation: 'virtual',
};

export interface DeviceDef {
  id: string;
  name: string;
  integration: string;
  area?: string;
  /** Initial state at the start of the timeline. Default 'off'. */
  state?: string;
  /** Local time the initial state began. Default: three days before `now`. */
  since?: string;
  vendor?: string;
  model?: string;
  deviceId?: string;
  restored?: boolean;
  signals?: Signals;
  attributes?: Record<string, unknown>;
}

export interface AutomationDef {
  id: string;
  name: string;
  references: string[];
}

type By = 'voice' | 'app';
export type Step =
  | ['cmd', string, string, 'turn_on' | 'turn_off', By]
  | ['down', string, string]
  | ['up', string, string, string?]
  | ['set', string, string, string]
  | ['auto', string, string, 'turn_on' | 'turn_off', string[], By?]
  | ['integration', string, string, IntegrationStatus['state'], string?]
  | ['registry', string, 'create' | 'update' | 'remove', string, Record<string, unknown>?]
  | ['boot', string, string];

export interface IncidentSpec {
  n: number;
  slug: string;
  title: string;
  source: ScenarioSource & { quote: string; publisher: string };
  assumptions: string[];
  tz: string;
  now: string;
  symptom: { text: string; device?: string };
  devices: DeviceDef[];
  automations?: AutomationDef[];
  /** Final integration states that differ from loaded. */
  integrations?: Array<{ integration: string; state: IntegrationStatus['state']; reason?: string }>;
  cloud?: Array<{ vendor: string; status: CloudStatus['status'] }>;
  /** Entities removed from the registry: they do not appear in the home. */
  removed?: string[];
  steps: Step[];
  truth: GroundTruth;
  human: HumanTruth;
  tags?: string[];
}

export const COMMON_ASSUMPTIONS = [
  'The home is reconstructed as Home Assistant shaped logs in the homefault format; the person in the report used the Alexa app and vendor apps, not Home Assistant.',
  'Entity ids, device brands the report does not name, other rooms, and every time the report does not give are invented to make a complete home.',
];

const objectId = (entityId: string): string => entityId.slice(entityId.indexOf('.') + 1);

export function buildIncident(spec: IncidentSpec): Scenario {
  const tz = spec.tz;
  const t = (local: string): number => parseLocal(local, tz);
  const nowMs = t(spec.now);
  const removed = new Set(spec.removed ?? []);
  const state = new Map<string, string>();
  const changed = new Map<string, number>();
  const down = new Set<string>();
  const before = new Map<string, string>();
  const rows: LogRow[] = [];
  let k = 0;
  const ctx = (user?: string, parent?: string): HaContext => ({ id: `ctx_i${String(spec.n).padStart(2, '0')}_${(++k).toString(36)}`, ...(parent ? { parent_id: parent } : {}), ...(user ? { user_id: user } : {}) });

  for (const d of spec.devices) {
    const initial = d.restored ? 'unavailable' : (d.state ?? 'off');
    state.set(d.id, initial);
    changed.set(d.id, d.since ? t(d.since) : nowMs - 3 * 86_400_000);
    if (initial === 'unavailable') down.add(d.id);
  }
  for (const a of spec.automations ?? []) {
    state.set(a.id, 'on');
    changed.set(a.id, nowMs - 30 * 86_400_000);
  }
  const gone = new Set<string>();

  const set = (ms: number, id: string, to: string, c?: HaContext): void => {
    const from = state.get(id);
    if (from === to) return;
    rows.push({ type: 'state', when: iso(ms), entity_id: id, state: to, ...(from !== undefined ? { old_state: from } : {}), ...(c ? { context: c } : {}) });
    state.set(id, to);
    changed.set(id, ms);
  };
  const act = (ms: number, id: string, service: 'turn_on' | 'turn_off', c: HaContext): string | undefined => {
    rows.push({ type: 'call_service', when: iso(ms), domain: id.slice(0, id.indexOf('.')), service, entity_ids: [id], context: c });
    if (gone.has(id) || !state.has(id)) return `Entity ${id} not found`;
    if (down.has(id)) return undefined;
    set(ms + 40, id, service === 'turn_on' ? 'on' : 'off', c);
    return undefined;
  };

  const steps = [...spec.steps].sort((a, b) => t(a[1]) - t(b[1]));
  for (const step of steps) {
    const ms = t(step[1]);
    if (ms > nowMs) throw new Error(`incident ${spec.n}: step at ${step[1]} is after now`);
    switch (step[0]) {
      case 'cmd':
        act(ms, step[2], step[3], ctx(step[4] === 'voice' ? 'user_voice_assistant' : 'user_resident'));
        break;
      case 'down':
        if (!down.has(step[2])) {
          before.set(step[2], state.get(step[2]) ?? 'off');
          down.add(step[2]);
          set(ms, step[2], 'unavailable');
        }
        break;
      case 'up':
        if (down.has(step[2])) {
          down.delete(step[2]);
          set(ms, step[2], step[3] ?? before.get(step[2]) ?? 'off', ctx());
        }
        break;
      case 'set':
        set(ms, step[2], step[3], ctx());
        break;
      case 'auto': {
        const name = spec.automations?.find((a) => a.id === step[2])?.name;
        const c = ctx(step[5] === 'app' ? 'user_resident' : undefined);
        const row: LogRow = { type: 'automation_triggered', when: iso(ms), entity_id: step[2], ...(name ? { name } : {}), source: step[5] ? 'manual trigger' : 'time pattern', context: c };
        rows.push(row);
        let error: string | undefined;
        for (const target of step[4]) error = act(ms + 20, target, step[3], c) ?? error;
        if (error) row.error = error;
        break;
      }
      case 'integration':
        rows.push({ type: 'integration', when: iso(ms), integration: step[2], state: step[3], old_state: 'loaded', ...(step[4] ? { reason: step[4] } : {}) });
        break;
      case 'registry':
        rows.push({ type: 'registry', when: iso(ms), action: step[2], entity_id: step[3], ...(step[4] ? { changes: step[4] } : {}) });
        if (step[2] === 'remove') gone.add(step[3]);
        break;
      case 'boot':
        rows.push({ type: 'device_event', when: iso(ms), entity_id: step[2], event: 'boot_reason', data: { reason: 'PowerOnReboot' } });
        break;
    }
  }

  const entities: Entity[] = [];
  const signals: Record<string, Signals> = {};
  for (const d of spec.devices) {
    if (removed.has(d.id)) continue;
    const when = iso(changed.get(d.id) ?? nowMs);
    const transport = TRANSPORT[d.integration] ?? 'wifi';
    const e: Entity = {
      entityId: d.id,
      name: d.name,
      aliases: [],
      domain: d.id.slice(0, d.id.indexOf('.')),
      deviceId: d.deviceId ?? `dev_${objectId(d.id)}`,
      integration: d.integration,
      transport,
      state: state.get(d.id) ?? 'off',
      attributes: { friendly_name: d.name, ...(d.restored ? { restored: true } : {}), ...(d.attributes ?? {}) },
      lastChanged: when,
      lastUpdated: when,
    };
    if (d.area) e.area = d.area;
    if (d.vendor) e.vendor = d.vendor;
    if (d.model) e.model = d.model;
    if (d.restored) e.restored = true;
    entities.push(e);
    const sig: Signals = { ...(d.signals ?? {}) };
    sig.lastSeen ??= down.has(d.id) || d.restored ? when : iso(nowMs);
    signals[d.id] = sig;
  }
  for (const a of spec.automations ?? []) {
    const when = iso(changed.get(a.id) ?? nowMs);
    entities.push({
      entityId: a.id,
      name: a.name,
      aliases: [],
      domain: 'automation',
      integration: 'automation',
      transport: 'virtual',
      state: state.get(a.id) ?? 'on',
      attributes: { friendly_name: a.name, references: [...a.references].sort() },
      lastChanged: when,
      lastUpdated: when,
    });
  }
  entities.sort((a, b) => a.entityId.localeCompare(b.entityId));

  const integrationNames = new Set([...spec.devices.map((d) => d.integration), ...((spec.automations ?? []).length > 0 ? ['automation'] : [])]);
  const integrations: IntegrationStatus[] = [...integrationNames].sort().map((integration) => {
    const o = spec.integrations?.find((x) => x.integration === integration);
    return { integration, state: o?.state ?? 'loaded', entryId: `entry_${integration}`, ...(o?.reason ? { reason: o.reason } : {}) };
  });
  const cloud: CloudStatus[] = (spec.cloud ?? []).map((c) => ({ vendor: c.vendor, status: c.status, source: 'vendor status page (reconstructed)', checkedAt: iso(nowMs) }));

  return {
    format: SCENARIO_FORMAT,
    id: `inc-${String(spec.n).padStart(2, '0')}-${spec.slug}`,
    title: spec.title,
    kind: 'incident',
    source: spec.source,
    reconstructed: true,
    assumptions: [...COMMON_ASSUMPTIONS, ...spec.assumptions],
    tz,
    now: iso(nowMs),
    symptom: spec.symptom,
    home: { entities, integrations, hub: { reachable: true, latencyMs: 21, version: '2026.9.4' }, cloud, signals },
    events: sortRows(rows),
    ground_truth: spec.truth,
    human_truth: spec.human,
    noise: { jitter_ms: 0, drop_rate: 0 },
    tags: ['incident', spec.truth.cause_id, ...(spec.tags ?? [])],
  };
}
