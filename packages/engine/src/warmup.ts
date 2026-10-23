// First use is the expensive part: Intl time zone data and V8 compiling each engine path. BENCH_CPU.json
// (Node 22.22.1, median of 5 fresh processes) measured warmUp() at 32.761 ms of CPU. After it the first
// diagnose took 6.445 ms; without it, 12.857 ms, over the Workers budget of 10 ms per request. Called at
// module scope, the cost counts against the startup limit instead of a request. Workers refuse I/O, timers and
// random values in global scope, so warmUp() uses only a tiny in memory house, a fixed clock and a seeded
// generator, and never touches a real home.

import type { Clock, Entity, HomeAdapter, HouseEvent, Rng } from '@fixwright/protocol';
import { checkClaims } from './claims.ts';
import { runCheckup } from './checkup.ts';
import { answerDiagnosis, startDiagnosis } from './diagnose.ts';
import { executePlan } from './executor.ts';
import { explainEvent } from './explain.ts';
import { createMemoryLedger } from './ledger.ts';
import { planRepair } from './planner.ts';
import { defaultSettings, DEFAULT_TZ } from './settings.ts';
import type { EngineDeps } from './types.ts';

const T0 = Date.parse('2026-10-15T17:20:00.000Z');
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function entity(entityId: string, name: string, state: string, extra: Partial<Entity> = {}): Entity {
  return {
    entityId,
    name,
    aliases: [],
    domain: entityId.split('.')[0] ?? 'light',
    integration: 'zigbee2mqtt',
    transport: 'zigbee',
    state,
    attributes: {},
    lastChanged: at(-12 * 86_400_000),
    lastUpdated: at(-12 * 86_400_000),
    ...extra,
  };
}

function tinyHouse(clock: Clock): HomeAdapter {
  const entities = new Map<string, Entity>();
  const add = (e: Entity): void => {
    entities.set(e.entityId, e);
  };
  add(entity('light.warm_lamp', 'Warm Lamp', 'unavailable', { restored: true, vendor: 'Warm', deviceId: 'old' }));
  add(entity('light.warm_lamp_2', 'Warm Lamp', 'off', { vendor: 'Warm', deviceId: 'new' }));
  const events: HouseEvent[] = [{ seq: 0, ts: at(-12 * 86_400_000), kind: 'availability', entityId: 'light.warm_lamp', from: 'on', to: 'unavailable', source: 'home' }];
  for (let i = 0; i < 5; i++) {
    const id = `switch.warm_plug_${i}`;
    add(entity(id, `Warm Plug ${i}`, 'on', { integration: i % 2 === 0 ? 'kasa' : 'matter', transport: 'wifi', deviceId: `p${i}` }));
    add(entity(`select.warm_plug_${i}_power_on_behavior`, `Warm Plug ${i} power on`, 'on', { deviceId: `p${i}`, attributes: { options: ['on', 'previous'] } }));
    events.push({ seq: 0, ts: at(-7 * 3_600_000 + i * 300), kind: 'availability', entityId: id, from: 'unavailable', to: 'off', source: 'home' });
    events.push({ seq: 0, ts: at(-7 * 3_600_000 + i * 300 + 200), kind: 'state', entityId: id, from: 'off', to: 'on', source: 'home' });
  }
  const copy = (e: Entity): Entity => ({ ...e, attributes: { ...e.attributes } });
  return {
    kind: 'simhome',
    listEntities: async () => [...entities.values()].map(copy),
    getEntity: async (id) => {
      const e = entities.get(id);
      return e ? copy(e) : null;
    },
    callService: async (_domain, service, data) => {
      const e = entities.get(String(data['entity_id']));
      if (e && e.state !== 'unavailable') e.state = service === 'turn_on' ? 'on' : 'off';
      return { changed: e ? [copy(e)] : [] };
    },
    events: async (q) => events.filter((e) => e.ts >= q.since && (q.until === undefined || e.ts <= q.until)),
    signals: async (id) => (id.startsWith('switch.') ? { powerOnBehavior: 'on', rssi: -60 } : { linkQuality: 150 }),
    integrations: async () => [{ integration: 'zigbee2mqtt', state: 'loaded' }],
    hubStatus: async () => ({ reachable: true }),
    cloudStatus: async (vendor) => ({ vendor, status: 'ok', source: 'warm up', checkedAt: clock.now() }),
    registryUpdate: async (id, patch) => {
      const e = entities.get(id) as Entity;
      if (patch.disabled !== undefined) e.disabled = patch.disabled;
      if (typeof patch.name === 'string') e.name = patch.name;
      return copy(e);
    },
    registryRemove: async (id) => {
      entities.delete(id);
    },
    reloadIntegration: async () => undefined,
    selectOption: async (id, option) => {
      const e = entities.get(id) as Entity;
      e.state = option;
      return copy(e);
    },
    now: () => clock.now(),
  };
}

/** Safe to await at module scope in a Worker: it only resolves promises, with no I/O, timers or randomness. */
export async function warmUp(tz: string = DEFAULT_TZ): Promise<void> {
  let ms = T0;
  const clock: Clock = { now: () => new Date(ms).toISOString(), nowMs: () => ms };
  let seed = 1;
  const rng: Rng = {
    next: () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    },
  };
  const deps: EngineDeps = { adapter: tinyHouse(clock), ledger: createMemoryLedger(), clock, rng, settings: defaultSettings({ tz }) };
  const dx = await startDiagnosis({ symptom: "the warm lamp isn't responding" }, deps);
  const q = dx.output.question;
  const done = q ? await answerDiagnosis(dx.session, { diagnosis_id: dx.session.diagnosis_id, question_id: q.question_id, answer: 'yes' }, deps) : dx;
  ms += 1000;
  const ex = await explainEvent({ question: 'why did the plugs turn on at 10 a.m.' }, deps);
  await runCheckup({}, deps);
  if (done.session.verdict?.fix_available) await executePlan((await planRepair({ kind: 'diagnosis', session: done.session }, deps)).plan, deps);
  if (ex.session.suggested_fix) await planRepair({ kind: 'explanation', session: ex.session }, deps);
  await checkClaims([{ text: 'Want me to fix that?', evidence: [], kind: 'framing' }], deps.ledger);
}
