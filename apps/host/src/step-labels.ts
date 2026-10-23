// Clearer step labels for two devices that share one name. A plan's step only says "Set Living Room Light
// to remember its last state", which is ambiguous in a home where a Hue group and a Zigbee bulb are both
// called Living Room Light. The host knows the home's devices (here from /demo/state, its stand in for the
// assistant's own device list) and the plan's exact changes (its diff rows), so it can say which one:
// "Set Living Room Light (the Floor Lamp) to remember its last state". The views get these through the
// dev.fixwright/stepLabels host context key. Pure.

export interface HomeEntity {
  entity_id: string;
  name: string;
  domain: string;
  area: string | null;
  integration: string | null;
  /** The physical device behind the entity, and that device's own name (it differs after a rename). */
  deviceId: string | null;
  deviceName: string | null;
  /** False for an old pairing or a removed device: it answers to nothing, so it shares no name. */
  exists: boolean;
}

export interface PlanSteps {
  plan_id: string;
  /** The entity each change touches, in the plan's order. */
  entityIds: string[];
  labels: string[];
}

/** Entities that are settings or readings of a device rather than the device a person names. */
const NOT_A_DEVICE = new Set(['select', 'sensor', 'binary_sensor', 'automation', 'number', 'button', 'update', 'script', 'scene']);

const INTEGRATIONS: Record<string, string> = { hue: 'Hue', zigbee2mqtt: 'Zigbee', zha: 'Zigbee', kasa: 'Kasa', matter: 'Matter', tplink: 'Kasa', shelly: 'Shelly', ecobee: 'ecobee' };

const MAX_ENTITIES = 2000;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The home's entities from a /demo/state body, or null when the body has none. */
export function readHome(body: unknown): HomeEntity[] | null {
  const list = (body as { entities?: unknown } | null)?.entities;
  if (!Array.isArray(list)) return null;
  const out: HomeEntity[] = [];
  for (const raw of list.slice(0, MAX_ENTITIES)) {
    const e = raw as Record<string, unknown> | null;
    const id = str(e?.['entity_id']);
    const name = str(e?.['name']);
    if (!e || !id || !name) continue;
    const physical = (e['physical'] ?? null) as Record<string, unknown> | null;
    out.push({
      entity_id: id,
      name,
      domain: str(e['domain']) ?? id.split('.')[0] ?? '',
      area: str(e['area']),
      integration: str(e['integration']),
      deviceId: str(physical?.['deviceId']),
      deviceName: str(physical?.['name']),
      exists: physical?.['exists'] !== false,
    });
  }
  return out;
}

const key = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');
const human = (slug: string): string => slug.replace(/_/g, ' ');

/** The device a person would name for an entity: itself, or the device entity its setting belongs to. */
function deviceEntity(e: HomeEntity, home: readonly HomeEntity[]): HomeEntity | null {
  if (!NOT_A_DEVICE.has(e.domain)) return e;
  if (!e.deviceId) return null;
  return home.find((x) => x.deviceId === e.deviceId && !NOT_A_DEVICE.has(x.domain) && x.exists) ?? null;
}

/** What tells this device apart from the others with its name: its room, its own name, or its hub. */
function note(target: HomeEntity, others: readonly HomeEntity[]): string {
  if (target.area && others.every((o) => o.area && o.area !== target.area)) return `in the ${human(target.area)}`;
  if (target.deviceName && key(target.deviceName) !== key(target.name)) return `the ${target.deviceName}`;
  const hub = target.integration ? INTEGRATIONS[target.integration] : undefined;
  if (hub && others.every((o) => o.integration !== target.integration)) return `the ${hub} one`;
  return target.entity_id;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Clearer labels for one plan, keyed `${plan_id}|${label}`: for each step with that label, in step order,
 * the label with the device told apart. Only labels that name a shared name get an entry.
 */
export function clearerLabels(plan: PlanSteps, home: readonly HomeEntity[]): Record<string, string[]> {
  const devices = home.filter((e) => e.exists && !NOT_A_DEVICE.has(e.domain));
  const byName = new Map<string, HomeEntity[]>();
  for (const e of devices) byName.set(key(e.name), [...(byName.get(key(e.name)) ?? []), e]);

  // The plan's changes on devices whose name another device shares, in plan order.
  const queue = new Map<string, HomeEntity[]>();
  for (const id of plan.entityIds) {
    const e = home.find((x) => x.entity_id === id);
    const d = e ? deviceEntity(e, home) : null;
    if (!d || (byName.get(key(d.name))?.length ?? 0) < 2) continue;
    queue.set(key(d.name), [...(queue.get(key(d.name)) ?? []), d]);
  }
  if (queue.size === 0) return {};

  const out: Record<string, string[]> = {};
  for (const label of plan.labels) {
    let next = label;
    for (const [name, targets] of queue) {
      const re = new RegExp(`\\b(${escape(name)})\\b`, 'i');
      const m = re.exec(label);
      const target = m ? targets.shift() : undefined;
      if (!m || !target) continue;
      const others = (byName.get(name) ?? []).filter((o) => o.entity_id !== target.entity_id);
      next = label.replace(re, `$1 (${note(target, others)})`);
      break;
    }
    const k = `${plan.plan_id}|${label}`;
    out[k] = [...(out[k] ?? []), next];
  }
  for (const k of Object.keys(out)) if (out[k]?.every((l) => l === k.slice(k.indexOf('|') + 1))) delete out[k];
  return out;
}
