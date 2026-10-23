// Dependency-free validation of the scenario format. It enforces the same rules as
// schema/scenario.schema.json (test/schema.test.ts runs both over every incident and generated
// scenario and checks they agree), plus a few cross-field rules JSON Schema cannot express.

import { LOG_ROW_TYPES } from '../logrows.ts';
import { isValidTimeZone } from '../time.ts';
import { CAUSE_IDS } from '../types.ts';
import { HUMAN_QUESTION_KINDS, SCENARIO_FORMAT, type Scenario } from './types.ts';

export type ValidationResult = { ok: true; value: Scenario } | { ok: false; errors: string[] };

export const MAX_DROP_RATE = 0.15;
export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,79}$/;
export const ENTITY_ID_PATTERN = /^[a-z_]+\.[a-z0-9_]+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && ISO_UTC.test(v) && Number.isFinite(Date.parse(v));

interface StrOpts {
  optional?: boolean;
  nonEmpty?: boolean;
  max?: number;
  pattern?: RegExp;
}
interface NumOpts {
  optional?: boolean;
  min?: number;
  max?: number;
  integer?: boolean;
}

/** Collects errors with their JSON paths. */
function makeChecker() {
  const errors: string[] = [];
  const fail = (path: string, msg: string): void => {
    if (errors.length < 50) errors.push(`${path}: ${msg}`);
  };
  return {
    errors,
    fail,
    str(o: Obj, key: string, path: string, opts: StrOpts = {}): void {
      const v = o[key];
      if (v === undefined) {
        if (!opts.optional) fail(`${path}.${key}`, 'is required');
        return;
      }
      if (typeof v !== 'string') return fail(`${path}.${key}`, 'must be a string');
      if (opts.nonEmpty && v.trim() === '') fail(`${path}.${key}`, 'must not be empty');
      if (opts.max !== undefined && v.length > opts.max) fail(`${path}.${key}`, `must be at most ${opts.max} characters`);
      if (opts.pattern && !opts.pattern.test(v)) fail(`${path}.${key}`, `must match ${opts.pattern}`);
    },
    iso(o: Obj, key: string, path: string, optional = false): void {
      const v = o[key];
      if (v === undefined && optional) return;
      if (!isIso(v)) fail(`${path}.${key}`, 'must be an ISO 8601 UTC time ending in Z');
    },
    bool(o: Obj, key: string, path: string, optional = false): void {
      const v = o[key];
      if (v === undefined && optional) return;
      if (typeof v !== 'boolean') fail(`${path}.${key}`, 'must be a boolean');
    },
    num(o: Obj, key: string, path: string, opts: NumOpts = {}): void {
      const v = o[key];
      if (v === undefined) {
        if (!opts.optional) fail(`${path}.${key}`, 'is required');
        return;
      }
      if (typeof v !== 'number' || !Number.isFinite(v)) return fail(`${path}.${key}`, 'must be a number');
      if (opts.integer && !Number.isInteger(v)) fail(`${path}.${key}`, 'must be an integer');
      if (opts.min !== undefined && v < opts.min) fail(`${path}.${key}`, `must be at least ${opts.min}`);
      if (opts.max !== undefined && v > opts.max) fail(`${path}.${key}`, `must be at most ${opts.max}`);
    },
    oneOf(o: Obj, key: string, path: string, values: readonly string[], optional = false): void {
      const v = o[key];
      if (v === undefined && optional) return;
      if (typeof v !== 'string' || !values.includes(v)) fail(`${path}.${key}`, `must be one of ${values.join(', ')}`);
    },
    strArray(o: Obj, key: string, path: string, opts: { optional?: boolean; minItems?: number; pattern?: RegExp } = {}): void {
      const v = o[key];
      if (v === undefined) {
        if (!opts.optional) fail(`${path}.${key}`, 'is required');
        return;
      }
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return fail(`${path}.${key}`, 'must be an array of strings');
      if (opts.minItems !== undefined && v.length < opts.minItems) fail(`${path}.${key}`, `must have at least ${opts.minItems} item(s)`);
      const pattern = opts.pattern;
      if (pattern) v.forEach((x, i) => !pattern.test(x as string) && fail(`${path}.${key}[${i}]`, `must match ${pattern}`));
    },
    obj(o: Obj, key: string, path: string, optional = false): Obj | undefined {
      const v = o[key];
      if (v === undefined && optional) return undefined;
      if (!isObj(v)) {
        fail(`${path}.${key}`, 'must be an object');
        return undefined;
      }
      return v;
    },
    noExtra(o: Obj, allowed: readonly string[], path: string): void {
      for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${path}.${k}`, 'is not allowed');
    },
  };
}
type Checker = ReturnType<typeof makeChecker>;

const TRANSPORTS = ['zigbee', 'wifi', 'thread', 'cloud', 'virtual'] as const;
const INTEGRATION_STATES = ['loaded', 'setup_error', 'not_loaded', 'setup_retry'] as const;
const CLOUD_STATES = ['ok', 'degraded', 'outage', 'unknown'] as const;
const POWER_ON = ['previous', 'on', 'off', 'toggle'] as const;

function checkEntity(c: Checker, e: unknown, path: string): void {
  if (!isObj(e)) return c.fail(path, 'must be an object');
  c.noExtra(e, ['entityId', 'name', 'aliases', 'domain', 'area', 'deviceId', 'integration', 'transport', 'vendor', 'model', 'state', 'attributes', 'lastChanged', 'lastUpdated', 'restored', 'disabled', 'registryOnly'], path);
  c.str(e, 'entityId', path, { pattern: ENTITY_ID_PATTERN });
  c.str(e, 'name', path);
  c.strArray(e, 'aliases', path);
  c.str(e, 'domain', path, { nonEmpty: true });
  c.str(e, 'area', path, { optional: true });
  c.str(e, 'deviceId', path, { optional: true });
  c.str(e, 'integration', path, { nonEmpty: true });
  c.oneOf(e, 'transport', path, TRANSPORTS);
  c.str(e, 'vendor', path, { optional: true });
  c.str(e, 'model', path, { optional: true });
  c.str(e, 'state', path);
  c.obj(e, 'attributes', path);
  c.iso(e, 'lastChanged', path);
  c.iso(e, 'lastUpdated', path);
  c.bool(e, 'restored', path, true);
  c.bool(e, 'disabled', path, true);
  c.bool(e, 'registryOnly', path, true);
}

function checkContext(c: Checker, row: Obj, path: string): void {
  const ctx = c.obj(row, 'context', path, true);
  if (!ctx) return;
  c.noExtra(ctx, ['id', 'parent_id', 'user_id'], `${path}.context`);
  c.str(ctx, 'id', `${path}.context`, { nonEmpty: true });
  c.str(ctx, 'parent_id', `${path}.context`, { optional: true });
  c.str(ctx, 'user_id', `${path}.context`, { optional: true });
}

function checkRow(c: Checker, row: unknown, path: string): void {
  if (!isObj(row)) return c.fail(path, 'must be an object');
  c.oneOf(row, 'type', path, LOG_ROW_TYPES);
  c.iso(row, 'when', path);
  checkContext(c, row, path);
  switch (row.type) {
    case 'state':
      c.noExtra(row, ['type', 'when', 'entity_id', 'state', 'old_state', 'attributes', 'context'], path);
      c.str(row, 'entity_id', path, { pattern: ENTITY_ID_PATTERN });
      c.str(row, 'state', path);
      c.str(row, 'old_state', path, { optional: true });
      c.obj(row, 'attributes', path, true);
      break;
    case 'call_service':
      c.noExtra(row, ['type', 'when', 'domain', 'service', 'entity_ids', 'service_data', 'context'], path);
      c.str(row, 'domain', path, { nonEmpty: true });
      c.str(row, 'service', path, { nonEmpty: true });
      c.strArray(row, 'entity_ids', path, { pattern: ENTITY_ID_PATTERN });
      c.obj(row, 'service_data', path, true);
      break;
    case 'automation_triggered':
      c.noExtra(row, ['type', 'when', 'entity_id', 'name', 'source', 'error', 'context'], path);
      c.str(row, 'entity_id', path, { pattern: ENTITY_ID_PATTERN });
      c.str(row, 'name', path, { optional: true });
      c.str(row, 'source', path, { optional: true });
      c.str(row, 'error', path, { optional: true });
      break;
    case 'integration':
      c.noExtra(row, ['type', 'when', 'integration', 'state', 'old_state', 'reason', 'context'], path);
      c.str(row, 'integration', path, { nonEmpty: true });
      c.oneOf(row, 'state', path, INTEGRATION_STATES);
      c.str(row, 'old_state', path, { optional: true });
      c.str(row, 'reason', path, { optional: true });
      break;
    case 'registry':
      c.noExtra(row, ['type', 'when', 'action', 'entity_id', 'changes', 'context'], path);
      c.oneOf(row, 'action', path, ['create', 'update', 'remove']);
      c.str(row, 'entity_id', path, { pattern: ENTITY_ID_PATTERN });
      c.obj(row, 'changes', path, true);
      break;
    case 'device_event':
      c.noExtra(row, ['type', 'when', 'entity_id', 'event', 'data', 'context'], path);
      c.str(row, 'entity_id', path, { optional: true, pattern: ENTITY_ID_PATTERN });
      c.str(row, 'event', path, { nonEmpty: true });
      c.obj(row, 'data', path, true);
      break;
  }
}

function checkSignals(c: Checker, sig: unknown, path: string): void {
  if (!isObj(sig)) return c.fail(path, 'must be an object');
  c.noExtra(sig, ['linkQuality', 'rssi', 'lastSeen', 'batteryPct', 'uptimeS', 'powerOnBehavior', 'flaps24h'], path);
  c.num(sig, 'linkQuality', path, { optional: true, min: 0, max: 255 });
  c.num(sig, 'rssi', path, { optional: true, min: -120, max: 0 });
  c.iso(sig, 'lastSeen', path, true);
  c.num(sig, 'batteryPct', path, { optional: true, min: 0, max: 100 });
  c.num(sig, 'uptimeS', path, { optional: true, min: 0 });
  c.oneOf(sig, 'powerOnBehavior', path, POWER_ON, true);
  c.num(sig, 'flaps24h', path, { optional: true, min: 0, integer: true });
}

function checkHome(c: Checker, home: Obj): void {
  const p = 'home';
  c.noExtra(home, ['entities', 'integrations', 'hub', 'cloud', 'signals'], p);
  const entities = home.entities;
  if (!Array.isArray(entities)) c.fail(`${p}.entities`, 'must be an array');
  else entities.forEach((e, i) => checkEntity(c, e, `${p}.entities[${i}]`));
  const integrations = home.integrations;
  if (!Array.isArray(integrations)) c.fail(`${p}.integrations`, 'must be an array');
  else
    integrations.forEach((x, i) => {
      const path = `${p}.integrations[${i}]`;
      if (!isObj(x)) return c.fail(path, 'must be an object');
      c.noExtra(x, ['integration', 'state', 'reason', 'entryId'], path);
      c.str(x, 'integration', path, { nonEmpty: true });
      c.oneOf(x, 'state', path, INTEGRATION_STATES);
      c.str(x, 'reason', path, { optional: true });
      c.str(x, 'entryId', path, { optional: true });
    });
  const hub = c.obj(home, 'hub', p);
  if (hub) {
    c.noExtra(hub, ['reachable', 'latencyMs', 'version'], `${p}.hub`);
    c.bool(hub, 'reachable', `${p}.hub`);
    c.num(hub, 'latencyMs', `${p}.hub`, { optional: true, min: 0 });
    c.str(hub, 'version', `${p}.hub`, { optional: true });
  }
  const cloud = home.cloud;
  if (!Array.isArray(cloud)) c.fail(`${p}.cloud`, 'must be an array');
  else
    cloud.forEach((x, i) => {
      const path = `${p}.cloud[${i}]`;
      if (!isObj(x)) return c.fail(path, 'must be an object');
      c.noExtra(x, ['vendor', 'status', 'source', 'checkedAt'], path);
      c.str(x, 'vendor', path, { nonEmpty: true });
      c.oneOf(x, 'status', path, CLOUD_STATES);
      c.str(x, 'source', path);
      c.iso(x, 'checkedAt', path);
    });
  const signals = c.obj(home, 'signals', p);
  if (signals) for (const [id, sig] of Object.entries(signals)) checkSignals(c, sig, `${p}.signals.${id}`);
}

export function validateScenario(input: unknown): ValidationResult {
  const c = makeChecker();
  if (!isObj(input)) return { ok: false, errors: ['scenario: must be an object'] };
  const s = input;
  c.noExtra(s, ['$schema', 'format', 'id', 'title', 'kind', 'source', 'reconstructed', 'assumptions', 'tz', 'now', 'symptom', 'home', 'events', 'ground_truth', 'human_truth', 'noise', 'tags'], 'scenario');
  c.str(s, '$schema', 'scenario', { optional: true });
  if (s.format !== SCENARIO_FORMAT) c.fail('scenario.format', `must be "${SCENARIO_FORMAT}"`);
  c.str(s, 'id', 'scenario', { pattern: ID_PATTERN });
  c.str(s, 'title', 'scenario', { nonEmpty: true, max: 120 });
  c.oneOf(s, 'kind', 'scenario', ['incident', 'generated', 'twin']);
  const source = c.obj(s, 'source', 'scenario');
  if (source) {
    c.noExtra(source, ['url', 'date', 'quote', 'publisher', 'note'], 'source');
    c.str(source, 'url', 'source', { pattern: /^(https:\/\/|homefault:\/\/)\S+$/ });
    c.str(source, 'date', 'source', { pattern: DATE });
    c.str(source, 'quote', 'source', { optional: true, nonEmpty: true, max: 400 });
    c.str(source, 'publisher', 'source', { optional: true });
    c.str(source, 'note', 'source', { optional: true });
  }
  c.bool(s, 'reconstructed', 'scenario');
  c.strArray(s, 'assumptions', 'scenario');
  if (s.reconstructed === true && Array.isArray(s.assumptions) && s.assumptions.length === 0) {
    c.fail('scenario.assumptions', 'a reconstructed scenario must state its assumptions');
  }
  c.str(s, 'tz', 'scenario');
  if (typeof s.tz === 'string' && !isValidTimeZone(s.tz)) c.fail('scenario.tz', 'must be an IANA time zone');
  c.iso(s, 'now', 'scenario');
  const symptom = c.obj(s, 'symptom', 'scenario');
  if (symptom) {
    c.noExtra(symptom, ['text', 'device'], 'symptom');
    c.str(symptom, 'text', 'symptom', { nonEmpty: true, max: 300 });
    c.str(symptom, 'device', 'symptom', { optional: true, nonEmpty: true });
  }
  const home = c.obj(s, 'home', 'scenario');
  if (home) checkHome(c, home);
  if (!Array.isArray(s.events)) c.fail('scenario.events', 'must be an array');
  else {
    s.events.forEach((row, i) => checkRow(c, row, `events[${i}]`));
    const now = typeof s.now === 'string' ? Date.parse(s.now) : NaN;
    s.events.forEach((row, i) => {
      if (isObj(row) && typeof row.when === 'string' && Date.parse(row.when) > now) c.fail(`events[${i}].when`, 'is after scenario.now');
    });
  }
  const truth = c.obj(s, 'ground_truth', 'scenario');
  if (truth) {
    c.noExtra(truth, ['cause_id', 'entity_ids', 'explanation'], 'ground_truth');
    c.oneOf(truth, 'cause_id', 'ground_truth', CAUSE_IDS);
    c.strArray(truth, 'entity_ids', 'ground_truth', { minItems: 1, pattern: ENTITY_ID_PATTERN });
    c.str(truth, 'explanation', 'ground_truth', { optional: true });
  }
  const human = c.obj(s, 'human_truth', 'scenario');
  if (human) {
    c.noExtra(human, [...HUMAN_QUESTION_KINDS, 'notes'], 'human_truth');
    for (const k of HUMAN_QUESTION_KINDS) c.oneOf(human, k, 'human_truth', ['yes', 'no'], true);
    c.str(human, 'notes', 'human_truth', { optional: true });
  }
  const noise = c.obj(s, 'noise', 'scenario');
  if (noise) {
    c.noExtra(noise, ['jitter_ms', 'drop_rate'], 'noise');
    c.num(noise, 'jitter_ms', 'noise', { min: 0 });
    c.num(noise, 'drop_rate', 'noise', { min: 0, max: MAX_DROP_RATE });
  }
  c.strArray(s, 'tags', 'scenario', { optional: true });
  return c.errors.length === 0 ? { ok: true, value: s as unknown as Scenario } : { ok: false, errors: c.errors };
}

/** Like validateScenario, but throws with every problem listed. */
export function parseScenario(input: unknown): Scenario {
  const result = validateScenario(input);
  if (!result.ok) throw new Error(`Invalid scenario:\n${result.errors.join('\n')}`);
  return result.value;
}
