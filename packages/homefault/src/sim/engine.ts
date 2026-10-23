// The SimHome core. Physical truth (power, links, relays) is mutated by events; settle() derives what
// the hub should show for every entity and records the differences as Home Assistant shaped rows.
// Push integrations report at once, polled ones at their next poll, which is how a two second power
// blip can restart fourteen Zigbee and Matter devices while the Wi-Fi plugs never log a thing.

import type { HaContext, LogRow, StateRow } from '../logrows.ts';
import { rngFor, int, jitter } from '../rng.ts';
import { iso } from '../time.ts';
import { codedError, foldName, own, utf8Length } from '../util.ts';
import type { PowerOnBehavior } from '../types.ts';
import { automationReferences } from './blueprint.ts';
import type { AutomationAction, DeviceState, EntityState, Pending, SimState } from './model.ts';

export const SIM_ERROR = 'SimHomeError';
export const simError = (code: string, message: string) => codedError(SIM_ERROR, code, message);

const MAX_ACTUATIONS = 12;

export function tick(s: SimState): number {
  s.counter += 1;
  return s.counter;
}

export function newContext(s: SimState, userId?: string, parentId?: string): HaContext {
  const ctx: HaContext = { id: `ctx_${tick(s).toString(36).padStart(6, '0')}` };
  if (parentId) ctx.parent_id = parentId;
  if (userId) ctx.user_id = userId;
  return ctx;
}

/** A random stream for one decision, stable for this seed and counter value. */
export const rngNow = (s: SimState, purpose: string) => rngFor(s.seed, purpose, tick(s));

/** Bytes a row adds to a snapshot: its UTF-8 JSON plus one separator. */
export const rowSize = (row: LogRow): number => utf8Length(JSON.stringify(row)) + 1;

/** Drops the oldest rows until the log fits both its row cap and its byte budget (the newest row always stays). */
export function trimRows(s: SimState): void {
  let drop = 0;
  while (s.rows.length - drop > s.maxRows || (s.rowBytes > s.maxRowBytes && s.rows.length - drop > 1)) {
    s.rowBytes -= rowSize(s.rows[drop] as LogRow);
    drop++;
  }
  if (drop > 0) s.rows.splice(0, drop);
}

/** Inserts a row in time order (rows that share a time keep insertion order) and trims the oldest. */
export function appendRow(s: SimState, row: LogRow): void {
  if (!s.hub.online) return;
  const t = Date.parse(row.when);
  let i = s.rows.length;
  while (i > 0 && Date.parse((s.rows[i - 1] as LogRow).when) > t) i--;
  s.rows.splice(i, 0, row);
  s.rowBytes += rowSize(row);
  trimRows(s);
}

/** Changes a row already in the log and keeps the byte count right. */
function amendRow(s: SimState, row: LogRow, change: () => void): void {
  const kept = s.rows.includes(row);
  const before = kept ? rowSize(row) : 0;
  change();
  if (!kept) return;
  s.rowBytes += rowSize(row) - before;
  trimRows(s);
}

export function schedule(s: SimState, item: DistributiveOmit<Pending, 'n'>): void {
  const p = { ...item, n: tick(s) } as Pending;
  let i = s.pending.length;
  while (i > 0) {
    const prev = s.pending[i - 1] as Pending;
    if (prev.at < p.at || (prev.at === p.at && prev.n < p.n)) break;
    i--;
  }
  s.pending.splice(i, 0, p);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const deviceOf = (s: SimState, e: EntityState): DeviceState | undefined =>
  e.deviceId ? own(s.devices, e.deviceId) : undefined;

/** The device that carries the radio link: a power strip for its outlets, else the device itself. */
export const linkHolder = (s: SimState, d: DeviceState): DeviceState =>
  d.power.kind === 'mains' && d.power.parent ? (own(s.devices, d.power.parent) ?? d) : d;

/** Has power reaching it. With `ignoreBoot`, a parent strip that is still booting counts as powered. */
export function isPowered(s: SimState, d: DeviceState, ignoreBoot = false): boolean {
  if (!d.present) return false;
  if (d.power.kind === 'battery') return d.power.pct > 0;
  if (!(own(s.circuits, d.power.circuit)?.powered ?? false)) return false;
  if (d.power.wallSwitch === false) return false;
  if (d.power.parent) {
    const parent = own(s.devices, d.power.parent);
    if (!parent || !isPowered(s, parent, ignoreBoot)) return false;
    return ignoreBoot || parent.bootingUntil <= s.nowMs;
  }
  return true;
}

/** Can the hub reach the device right now? */
export function isLinked(s: SimState, d: DeviceState): boolean {
  const holder = linkHolder(s, d);
  if (!isPowered(s, d) || !isPowered(s, holder)) return false;
  if (holder.bootingUntil > s.nowMs || d.bootingUntil > s.nowMs) return false;
  if (holder.dropUntil > s.nowMs) return false;
  if ((own(s.integrations, d.integration)?.state ?? 'not_loaded') !== 'loaded') return false;
  if (d.transport === 'wifi') return holder.ssid === s.router.ssid;
  if (d.transport === 'cloud') return (own(s.cloud, d.vendor.toLowerCase())?.status ?? 'ok') === 'ok';
  return true;
}

/** Lit or running, as a person in the room would notice. */
export function isLit(s: SimState, d: DeviceState): boolean {
  if (d.output === null) return false;
  return isPowered(s, d) && d.bootingUntil <= s.nowMs && d.output;
}

function noteActuation(d: DeviceState, atMs: number): void {
  d.actuations.push(atMs);
  if (d.actuations.length > MAX_ACTUATIONS) d.actuations.splice(0, d.actuations.length - MAX_ACTUATIONS);
}

/** Records physical changes a person could see since the last call. */
function updateLit(s: SimState): void {
  for (const d of Object.values(s.devices)) {
    const lit = isLit(s, d);
    if (lit !== d.lit) {
      d.lit = lit;
      if (d.kind !== 'motion') noteActuation(d, s.nowMs);
    }
  }
}

const childrenOf = (s: SimState, deviceId: string): DeviceState[] =>
  Object.values(s.devices).filter((d) => d.power.kind === 'mains' && d.power.parent === deviceId);

/** The state the hub would show for an entity if it observed the house right now. */
export function derivedState(s: SimState, e: EntityState): string {
  if (e.restored) return 'unavailable';
  // Config selects keep their option: SimHome does not log availability for config entities.
  if (e.role === 'power_on') return e.value ?? e.state;
  if (e.role === 'automation' || e.role === 'template') return e.value ?? e.state;
  const d = deviceOf(s, e);
  if (!d) return e.state;
  if (!isLinked(s, d)) return 'unavailable';
  switch (d.kind) {
    case 'strip':
      return childrenOf(s, d.id).some((c) => c.output === true) ? 'on' : 'off';
    case 'thermostat':
      return e.value ?? 'heat';
    default:
      return d.output ? 'on' : 'off';
  }
}

export const inStateMachine = (e: EntityState): boolean => !e.registryOnly && !e.disabled;

/** Is the entity reachable right now (physical truth, not what the hub last showed)? */
export function isAvailableNow(s: SimState, e: EntityState): boolean {
  if (!s.hub.online || !inStateMachine(e)) return false;
  // A config select keeps showing its option, but writing it needs the device.
  if (e.role === 'power_on') {
    const d = deviceOf(s, e);
    return d !== undefined && isLinked(s, d);
  }
  return derivedState(s, e) !== 'unavailable';
}

function pollTick(s: SimState, e: EntityState, pollMs: number): number {
  let phase = 0;
  for (let i = 0; i < e.entityId.length; i++) phase = (phase * 31 + e.entityId.charCodeAt(i)) % pollMs;
  const since = ((s.nowMs - phase) % pollMs + pollMs) % pollMs;
  return s.nowMs + (pollMs - since);
}

/** Writes an observed state change: one state row, timestamps, and state triggers. */
export function observe(s: SimState, e: EntityState, next: string, ctx?: HaContext): void {
  if (!s.hub.online || e.state === next) return;
  const row: StateRow = { type: 'state', when: iso(s.nowMs), entity_id: e.entityId, state: next, old_state: e.state };
  if (ctx) row.context = ctx;
  const old = e.state;
  e.state = next;
  e.lastChanged = iso(s.nowMs);
  e.lastUpdated = e.lastChanged;
  appendRow(s, row);
  if (next !== 'unavailable') {
    const d = deviceOf(s, e);
    if (d) d.lastSeenMs = s.nowMs;
  } else if (old !== 'unavailable') {
    const d = deviceOf(s, e);
    if (d) d.lastSeenMs = s.nowMs;
  }
  fireStateTriggers(s, e.entityId, next);
}

export type SettleMode = 'command' | 'now' | 'jitter';

/**
 * Brings what the hub shows in line with the house. Entities on `focus` devices (the ones a command
 * touched) update at once with the command's context. Others follow the mode: 'now' reports push
 * integrations at once, 'jitter' adds the detection delay of a real radio network, and polled
 * integrations always wait for their next poll.
 */
export function settle(s: SimState, mode: SettleMode, focus?: ReadonlySet<string>, ctx?: HaContext): void {
  updateLit(s);
  if (!s.hub.online) return;
  for (const e of Object.values(s.entities)) {
    if (!inStateMachine(e)) continue;
    const next = derivedState(s, e);
    if (next === e.state) {
      e.missedPoll = false;
      continue;
    }
    const focused = focus !== undefined && e.deviceId !== null && focus.has(e.deviceId);
    const pollMs = own(s.integrations, e.integration)?.pollMs ?? 0;
    if (focused || mode === 'command') {
      observe(s, e, next, focused ? ctx : undefined);
    } else if (pollMs > 0) {
      scheduleObserve(s, e.entityId, pollTick(s, e, pollMs));
    } else if (mode === 'jitter') {
      scheduleObserve(s, e.entityId, s.nowMs + int(rngNow(s, 'detect'), 50, 250));
    } else {
      observe(s, e, next);
    }
  }
}

function scheduleObserve(s: SimState, entityId: string, at: number): void {
  if (s.pending.some((p) => p.kind === 'observe' && p.entityId === entityId)) return;
  schedule(s, { at, kind: 'observe', entityId });
}

const onCircuits = (s: SimState, d: DeviceState, circuits: ReadonlySet<string>): boolean => {
  if (d.power.kind !== 'mains') return false;
  if (circuits.has(d.power.circuit)) return true;
  const parent = d.power.parent ? own(s.devices, d.power.parent) : undefined;
  return parent ? onCircuits(s, parent, circuits) : false;
};

export function cutPower(s: SimState, circuits: readonly string[]): void {
  const set = new Set(circuits);
  for (const d of Object.values(s.devices)) {
    if (!onCircuits(s, d, set) || d.output === null) continue;
    if (isPowered(s, d) && d.bootingUntil <= s.nowMs) d.lastOutput = d.output;
  }
  for (const c of circuits) {
    const circuit = own(s.circuits, c);
    if (circuit) circuit.powered = false;
  }
  for (const d of Object.values(s.devices)) {
    if (onCircuits(s, d, set) && d.output !== null) d.output = false;
  }
  settle(s, 'jitter');
}

/** Boot timing after mains returns, in ms after the power comes back. */
export const BOOT_MS = {
  /** Zigbee bulbs rejoin first: they announce themselves as soon as they power up. */
  zigbeeLight: [300, 500],
  hueLight: [300, 700],
  plug: [800, 2400],
  other: [1000, 3000],
  /** Thread devices first re-attach to the mesh on their own ... */
  threadAttach: [1000, 1150],
  /** ... then the Matter controller restores their subscriptions one device at a time. */
  matterResubscribe: [330, 355],
} as const;

export function restorePower(s: SimState, circuits: readonly string[]): void {
  const set = new Set(circuits);
  for (const c of circuits) {
    const circuit = own(s.circuits, c);
    if (circuit) circuit.powered = true;
  }
  const rng = rngNow(s, 'boot');
  const thread: Array<{ d: DeviceState; attachedAt: number }> = [];
  for (const d of Object.values(s.devices)) {
    // Outlets boot with their strip.
    if (!onCircuits(s, d, set) || !isPowered(s, d, true) || (d.power.kind === 'mains' && d.power.parent)) continue;
    if (d.transport === 'thread') thread.push({ d, attachedAt: s.nowMs + int(rng, ...BOOT_MS.threadAttach) });
    else startBoot(s, d, s.nowMs + bootDelay(rng, d));
  }
  // One controller, one queue: Thread devices come back in a steady trickle, about a third of a second
  // apart, which is why a house-wide restart takes a few seconds rather than one.
  thread.sort((a, b) => a.attachedAt - b.attachedAt || (a.d.id < b.d.id ? -1 : 1));
  let ready = 0;
  for (const { d, attachedAt } of thread) {
    ready = Math.max(ready, attachedAt) + int(rng, ...BOOT_MS.matterResubscribe);
    startBoot(s, d, ready);
  }
  settle(s, 'jitter');
}

function startBoot(s: SimState, d: DeviceState, until: number): void {
  d.bootingUntil = until;
  for (const c of childrenOf(s, d.id)) c.bootingUntil = until;
  schedule(s, { at: until, kind: 'boot', deviceId: d.id });
}

/** How long a device that is not on Thread takes to come back after power returns, in ms. */
function bootDelay(rng: ReturnType<typeof rngNow>, d: DeviceState): number {
  if (d.kind === 'light' && d.integration === 'zigbee2mqtt') return int(rng, ...BOOT_MS.zigbeeLight);
  if (d.kind === 'light' || d.kind === 'light_group') return int(rng, ...BOOT_MS.hueLight);
  if (d.kind === 'plug' || d.kind === 'strip') return int(rng, ...BOOT_MS.plug);
  return int(rng, ...BOOT_MS.other);
}

export function bootOutput(behavior: PowerOnBehavior | null, last: boolean): boolean {
  switch (behavior) {
    case 'on':
      return true;
    case 'off':
      return false;
    case 'toggle':
      return !last;
    default:
      return last;
  }
}

function boot(s: SimState, d: DeviceState): void {
  if (d.bootingUntil > s.nowMs || !isPowered(s, d, true)) return;
  const booted = [d, ...childrenOf(s, d.id)];
  for (const x of booted) {
    x.bootingUntil = 0;
    x.bootMs = s.nowMs;
    if (x.output !== null && x.kind !== 'motion') x.output = bootOutput(x.powerOnBehavior, x.lastOutput);
  }
  if (d.integration === 'matter') {
    const primary = Object.values(s.entities).find((e) => e.deviceId === d.id && e.role === 'primary');
    appendRow(s, {
      type: 'device_event',
      when: iso(s.nowMs),
      ...(primary ? { entity_id: primary.entityId } : {}),
      event: 'boot_reason',
      data: { reason: 'PowerOnReboot', cluster: 'GeneralDiagnostics' },
    });
  }
  // A device that just rejoined reports itself (Zigbee device announce, a fresh Matter subscription), so a
  // push integration sees it at once and with no context. Polled integrations still wait for their poll.
  const push = booted.filter((x) => (own(s.integrations, x.integration)?.pollMs ?? 0) === 0);
  settle(s, 'jitter', new Set(push.map((x) => x.id)));
}

export type Origin = 'api' | 'voice' | 'resident' | 'automation';

export interface CommandResult {
  ok: boolean;
  /** Entities whose observed state changed. */
  changed: string[];
  error?: string;
}

const SERVICES: Readonly<Record<string, readonly string[]>> = {
  light: ['turn_on', 'turn_off', 'toggle'],
  switch: ['turn_on', 'turn_off', 'toggle'],
  climate: ['set_temperature', 'set_hvac_mode', 'turn_on', 'turn_off'],
  select: ['select_option'],
  automation: ['turn_on', 'turn_off', 'trigger'],
};

export const isKnownService = (domain: string, service: string): boolean =>
  own(SERVICES, domain)?.includes(service) ?? false;

/** Targets of a service call: entity_id as a string, a list, or a comma separated string. */
export function targetsOf(data: Record<string, unknown>): string[] {
  const raw = data.entity_id;
  if (typeof raw === 'string') return raw.split(',').map((x) => x.trim()).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  return [];
}

function setOutput(s: SimState, d: DeviceState, service: string): void {
  if (d.kind === 'strip') {
    const children = childrenOf(s, d.id);
    const anyOn = children.some((c) => c.output === true);
    const on = service === 'toggle' ? !anyOn : service === 'turn_on';
    for (const c of children) c.output = on;
    return;
  }
  if (d.output === null) return;
  d.output = service === 'toggle' ? !d.output : service === 'turn_on';
}

/** Two quick on/off changes a person can see: Home Assistant's light.turn_on with flash. */
function flash(s: SimState, d: DeviceState): void {
  noteActuation(d, s.nowMs);
  noteActuation(d, s.nowMs + 400);
}

/**
 * Runs one service call against one entity, honouring physical reality: a missing or unreachable
 * target fails, a working lamp changes (or blinks). Logs the call_service row first, like HA does.
 */
export function command(
  s: SimState,
  domain: string,
  service: string,
  entityId: string,
  data: Record<string, unknown>,
  ctx: HaContext,
  opts: { logCall: boolean },
): CommandResult {
  if (opts.logCall) {
    const row: LogRow = { type: 'call_service', when: iso(s.nowMs), domain, service, entity_ids: [entityId], context: ctx };
    const extra = Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'entity_id'));
    if (Object.keys(extra).length > 0) row.service_data = extra;
    appendRow(s, row);
  }
  const e = own(s.entities, entityId);
  if (!e || !inStateMachine(e)) return { ok: false, changed: [], error: `Entity ${entityId} not found` };
  if (!isAvailableNow(s, e)) {
    // The hub learns the device is gone when it tries to reach it.
    settle(s, 'command', e.deviceId ? new Set([e.deviceId]) : undefined);
    return { ok: false, changed: [], error: `Entity ${entityId} is unavailable` };
  }
  const before = snapshotStates(s);
  const d = deviceOf(s, e);
  const focus = new Set<string>();
  if (d) {
    focus.add(d.id);
    if (d.power.kind === 'mains' && d.power.parent) focus.add(d.power.parent);
    for (const c of childrenOf(s, d.id)) focus.add(c.id);
  }
  switch (e.role) {
    case 'power_on': {
      const option = String(data.option ?? '');
      const options = (e.attributes.options as string[] | undefined) ?? [];
      if (!options.includes(option)) return { ok: false, changed: [], error: `Option ${option} is not one of ${options.join(', ')}` };
      e.value = option;
      if (d) d.powerOnBehavior = option as PowerOnBehavior;
      observe(s, e, option, ctx);
      break;
    }
    case 'automation': {
      if (service === 'trigger') {
        runAutomation(s, entityId, 0, ctx);
        break;
      }
      e.value = service === 'turn_off' ? 'off' : 'on';
      observe(s, e, e.value, ctx);
      break;
    }
    default: {
      if (!d) break;
      if (e.domain === 'climate') {
        if (service === 'set_temperature' && typeof data.temperature === 'number') e.attributes.temperature = data.temperature;
        if (service === 'set_hvac_mode' && typeof data.hvac_mode === 'string') e.value = data.hvac_mode;
        if (service === 'turn_off') e.value = 'off';
        if (service === 'turn_on') e.value = 'heat';
        e.lastUpdated = iso(s.nowMs);
        break;
      }
      if (service === 'turn_on' && typeof data.flash === 'string') {
        flash(s, d);
        break;
      }
      setOutput(s, d, service);
    }
  }
  settle(s, 'command', focus, ctx);
  const changed = Object.keys(before).filter((id) => {
    const now = own(s.entities, id);
    return now !== undefined && now.state !== before[id];
  });
  return { ok: true, changed };
}

function snapshotStates(s: SimState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of Object.values(s.entities)) out[e.entityId] = e.state;
  return out;
}

/** The entity a spoken name reaches: the oldest registry entry whose name or alias folds to it. */
export function resolveSpoken(s: SimState, spoken: string): EntityState | undefined {
  const want = foldName(spoken);
  return Object.values(s.entities)
    .filter((e) => inStateMachine(e) && (e.domain === 'light' || e.domain === 'switch'))
    .filter((e) => foldName(e.name) === want || e.aliases.some((a) => foldName(a) === want))
    .sort((a, b) => a.createdMs - b.createdMs || a.entityId.localeCompare(b.entityId))[0];
}

function voiceCommand(s: SimState, name: string, service: string): void {
  const target = resolveSpoken(s, name);
  if (!target) return;
  const ctx = newContext(s, s.users.voice);
  const domain = target.domain;
  const result = command(s, domain, service, target.entityId, {}, ctx, { logCall: true });
  if (result.ok) return;
  // The resident gives up on voice and taps the copy that works in the app.
  const twin = Object.values(s.entities).find(
    (e) => e.entityId !== target.entityId && foldName(e.name) === foldName(name) && isAvailableNow(s, e),
  );
  if (twin) schedule(s, { at: s.nowMs + int(rngNow(s, 'retry'), 20_000, 40_000), kind: 'app', entityId: twin.entityId, service });
}

function appCommand(s: SimState, entityId: string, service: string): void {
  const e = own(s.entities, entityId);
  if (!e) return;
  command(s, e.domain, service, entityId, {}, newContext(s, s.users.resident), { logCall: true });
}

function runActions(s: SimState, actions: readonly AutomationAction[], ctx: HaContext): string | undefined {
  let error: string | undefined;
  for (const action of actions) {
    const [domain, service] = action.service.split('.') as [string, string];
    const result = command(s, domain, service, action.target, {}, ctx, { logCall: true });
    if (!result.ok && !error) error = result.error;
  }
  return error;
}

const automationEnabled = (s: SimState, automationId: string): boolean => {
  const e = own(s.entities, automationId);
  return e !== undefined && inStateMachine(e) && e.value === 'on';
};

function runAutomation(s: SimState, automationId: string, triggerIndex: number, parent?: HaContext): void {
  const def = own(s.automations, automationId);
  const trigger = def?.triggers[triggerIndex];
  if (!def || !trigger) return;
  const ctx = newContext(s, undefined, parent?.id);
  const source = trigger.kind === 'time' ? `time pattern ${trigger.at.slice(0, 5)}` : `state of ${trigger.entityId}`;
  const row: LogRow = { type: 'automation_triggered', when: iso(s.nowMs), entity_id: automationId, name: def.name, source, context: ctx };
  appendRow(s, row);
  const e = own(s.entities, automationId);
  if (e) e.attributes.last_triggered = iso(s.nowMs);
  const error = runActions(s, trigger.actions, ctx);
  if (error) amendRow(s, row, () => (row.error = error));
  if (trigger.kind === 'state' && trigger.thenActions.length > 0) {
    s.pending = s.pending.filter((p) => !(p.kind === 'auto_then' && p.automationId === automationId));
    schedule(s, { at: s.nowMs + trigger.thenAfterMs, kind: 'auto_then', automationId, trigger: triggerIndex, ctx: ctx.id });
  }
}

function fireStateTriggers(s: SimState, entityId: string, to: string): void {
  for (const def of Object.values(s.automations)) {
    def.triggers.forEach((t, i) => {
      if (t.kind !== 'state' || t.entityId !== entityId || t.to !== to) return;
      if (!automationEnabled(s, def.entityId)) return;
      if (t.condition && own(s.entities, t.condition.entityId)?.state !== t.condition.state) return;
      schedule(s, { at: s.nowMs, kind: 'auto_state', automationId: def.entityId, trigger: i });
    });
  }
}

/** Keeps automation attributes in sync after a registry change or a fault rewires them. */
export function refreshAutomationRefs(s: SimState): void {
  for (const def of Object.values(s.automations)) {
    const e = own(s.entities, def.entityId);
    if (e) e.attributes.references = automationReferences(def);
  }
}

/** Planner hook, run at every local midnight: the resident routine and fault processes plan the day. */
export type DayPlanner = (s: SimState) => void;

function execute(s: SimState, p: Pending, plan: DayPlanner): void {
  switch (p.kind) {
    case 'plan':
      plan(s);
      return;
    case 'voice':
      voiceCommand(s, p.name, p.service);
      return;
    case 'app':
      appCommand(s, p.entityId, p.service);
      return;
    case 'sweep': {
      let k = 0;
      const rng = rngNow(s, 'sweep');
      for (const id of p.entityIds) {
        if (own(s.entities, id)?.state !== 'on') continue;
        schedule(s, { at: s.nowMs + k * 5_000 + int(rng, 0, 3_000), kind: 'app', entityId: id, service: 'turn_off' });
        k++;
      }
      return;
    }
    case 'motion': {
      const e = own(s.entities, p.entityId);
      const d = e ? deviceOf(s, e) : undefined;
      if (!d || !isPowered(s, d)) return;
      d.output = p.on;
      settle(s, 'now');
      if (p.on) schedule(s, { at: s.nowMs + 90_000, kind: 'motion', entityId: p.entityId, on: false });
      return;
    }
    case 'auto_time':
      if (automationEnabled(s, p.automationId)) runAutomation(s, p.automationId, p.trigger);
      return;
    case 'auto_state':
      if (automationEnabled(s, p.automationId)) runAutomation(s, p.automationId, p.trigger);
      return;
    case 'auto_then': {
      const t = own(s.automations, p.automationId)?.triggers[p.trigger];
      if (!t || t.kind !== 'state' || !automationEnabled(s, p.automationId)) return;
      runActions(s, t.thenActions, { id: p.ctx });
      return;
    }
    case 'template': {
      const e = own(s.entities, p.entityId);
      if (!e) return;
      e.value = p.state;
      settle(s, 'now');
      return;
    }
    case 'drop': {
      const d = own(s.devices, p.deviceId);
      if (!d) return;
      d.dropUntil = Math.max(d.dropUntil, s.nowMs + p.durationMs);
      settle(s, 'now');
      schedule(s, { at: d.dropUntil, kind: 'settle' });
      return;
    }
    case 'settle':
      settle(s, 'now');
      return;
    case 'power':
      if (p.on) restorePower(s, p.circuits);
      else cutPower(s, p.circuits);
      return;
    case 'boot': {
      const d = own(s.devices, p.deviceId);
      if (d) boot(s, d);
      return;
    }
    case 'observe': {
      const e = own(s.entities, p.entityId);
      if (!e || !inStateMachine(e)) return;
      const next = derivedState(s, e);
      const pollMs = own(s.integrations, e.integration)?.pollMs ?? 0;
      // Polled integrations tolerate one missed poll before they call a device unavailable.
      if (pollMs > 0 && next === 'unavailable' && e.state !== 'unavailable' && !e.missedPoll) {
        e.missedPoll = true;
        schedule(s, { at: s.nowMs + pollMs, kind: 'observe', entityId: e.entityId });
        return;
      }
      e.missedPoll = false;
      observe(s, e, next);
      return;
    }
    case 'drain':
      drainBatteries(s);
      return;
  }
}

function drainBatteries(s: SimState): void {
  for (const d of Object.values(s.devices)) {
    if (d.power.kind !== 'battery') continue;
    d.power.pct = Math.max(0, Math.round((d.power.pct - d.power.drainPerDay) * 10) / 10);
    for (const e of Object.values(s.entities)) {
      if (e.deviceId === d.id && e.role === 'primary') e.attributes.battery = Math.floor(d.power.pct);
    }
  }
  settle(s, 'now');
}

/**
 * Runs every pending event up to targetMs, in time order, then parks the clock at targetMs. Advancing
 * in one step or in many gives the same house: nothing here depends on where the steps fall.
 */
export function runUntil(s: SimState, targetMs: number, plan: DayPlanner): void {
  if (targetMs < s.nowMs) return;
  for (;;) {
    const next = s.pending[0];
    if (!next || next.at > targetMs) break;
    s.pending.shift();
    if (next.at > s.nowMs) s.nowMs = next.at;
    execute(s, next, plan);
  }
  s.nowMs = targetMs;
}

/** Small deterministic network delay for one API round trip, in ms. */
export const apiLatency = (s: SimState): number => 12 + (Math.floor(s.nowMs / 1000) % 17) + jitter(rngFor(s.seed, 'lat', s.nowMs), 3);
