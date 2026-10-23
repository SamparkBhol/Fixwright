// Ids and payloads reach SimHome from agents and HTTP bodies. Prototype keys must never read through to
// Object.prototype or write into it, every caller-supplied value is bounded, the log is bounded by bytes
// as well as rows, and every write takes one API round trip of virtual time.

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_ROW_BYTES,
  INPUT_LIMITS,
  SimHome,
  faultId,
  generateScenario,
  runBench,
  scenarioHome,
  toView,
  type SimSnapshot,
} from '../src/index.ts';

const PROTO_KEYS = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf'];
const KB256 = 256 * 1024;
const bytes = (x: unknown): number => new TextEncoder().encode(JSON.stringify(x)).length;
const prototypeNames = (): string[] => Object.getOwnPropertyNames(Object.prototype).sort();
const healthy = () => SimHome.create({ seed: 8, faults: 'none' });

describe('prototype keys never reach Object.prototype', () => {
  const pristine = prototypeNames();
  afterEach(() => {
    expect(prototypeNames()).toEqual(pristine);
    const probe = {} as Record<string, unknown>;
    for (const field of ['state', 'reason', 'name', 'restored', 'status', 'entryId', 'pollMs']) expect(probe[field]).toBeUndefined();
  });

  it.each(PROTO_KEYS)('adapter reads treat %s as an unknown entity', async (key) => {
    const home = healthy();
    expect(await home.getEntity(key)).toBeNull();
    await expect(home.signals(key)).rejects.toMatchObject({ code: 'not_found' });
    expect(() => home.physical(key)).toThrowError(expect.objectContaining({ code: 'not_found' }));
    expect(home.person({ kind: 'confirm_flash', entityId: key })).toBe('not sure');
    expect(home.resolveName(key)).toBeNull();
    expect((await home.cloudStatus(key)).status).toBe('unknown');
  });

  it.each(PROTO_KEYS)('adapter writes reject %s before touching anything', async (key) => {
    const home = healthy();
    const before = JSON.stringify(home.snapshot().rows);
    await expect(home.registryUpdate(key, { name: 'Pwned' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(home.registryRemove(key)).rejects.toMatchObject({ code: 'not_found' });
    await expect(home.reloadIntegration(key)).rejects.toMatchObject({ code: 'unknown_integration' });
    await expect(home.selectOption(key, 'previous')).rejects.toMatchObject({ code: 'not_found' });
    await expect(home.callService('light', 'turn_on', { entity_id: key })).rejects.toMatchObject({ code: 'not_found' });
    await expect(home.callService(key, 'turn_on', { entity_id: 'light.desk_lamp' })).rejects.toMatchObject({ code: 'unknown_service' });
    await expect(home.callService('light', key, { entity_id: 'light.desk_lamp' })).rejects.toMatchObject({ code: 'unknown_service' });
    expect(JSON.stringify(home.snapshot().rows)).toBe(before);
  });

  it.each(PROTO_KEYS)('god-view controls and fault options reject %s', (key) => {
    const home = healthy();
    expect(() => home.setWallSwitch(key, true)).toThrowError(expect.objectContaining({ code: 'not_found' }));
    expect(() => home.setCircuit(key, false)).toThrowError(expect.objectContaining({ code: 'bad_request' }));
    expect(() => home.powerCut({ circuits: [key] })).toThrowError(expect.objectContaining({ code: 'bad_request' }));
    expect(() => faultId(key)).toThrowError(expect.objectContaining({ code: 'unknown_fault' }));
    expect(() => home.inject('F3', { entity: key })).toThrowError(expect.objectContaining({ code: 'not_found' }));
    expect(() => home.inject('F7', { integration: key })).toThrowError(expect.objectContaining({ code: 'unknown_integration' }));
    expect(() => home.inject('F8', { integration: key })).toThrowError(expect.objectContaining({ code: 'unknown_integration' }));
    expect(() => home.inject('F4', { entity: key })).toThrowError(expect.objectContaining({ code: 'not_found' }));
    expect(home.activeFaults()).toEqual([]);
  });

  it('a JSON body with an own __proto__ key is refused, not merged', async () => {
    const home = healthy();
    const body = JSON.parse('{"entity_id": "light.desk_lamp", "__proto__": {"state": "pwned"}}') as Record<string, unknown>;
    await expect(home.callService('light', 'turn_on', body)).rejects.toMatchObject({ code: 'bad_request' });
    const opts = JSON.parse('{"__proto__": {"state": "pwned"}}') as Record<string, string>;
    expect(() => home.inject('F4', opts)).toThrowError(expect.objectContaining({ code: 'bad_request' }));
    expect(() => home.inject('F6', { vendor: '__proto__' })).toThrowError(expect.objectContaining({ code: 'bad_request' }));
    const patch = JSON.parse('{"__proto__": {"name": "pwned"}}') as { name?: string };
    const lamp = await home.registryUpdate('light.desk_lamp', patch);
    expect(lamp.name).toBe('Desk Lamp');
  });

  it('a snapshot still round-trips after all of the above', async () => {
    const home = healthy();
    for (const key of PROTO_KEYS) {
      await home.registryUpdate(key, { name: 'x' }).catch(() => undefined);
      await home.reloadIntegration(key).catch(() => undefined);
    }
    const text = JSON.stringify(home.snapshot());
    expect(JSON.stringify(SimHome.fromSnapshot(JSON.parse(text) as SimSnapshot).snapshot())).toBe(text);
  });

  it('the scenario adapter and the bench treat prototype keys as unknown too', async () => {
    const view = toView(generateScenario(5));
    const home = scenarioHome(view);
    for (const key of PROTO_KEYS) {
      expect(await home.getEntity(key)).toBeNull();
      await expect(home.signals(key)).rejects.toMatchObject({ code: 'not_found' });
    }
    const asksNonsense = {
      name: 'asks a prototype key',
      diagnose: async (_v: unknown, ask: (q: { kind: never }) => Promise<string>) => {
        await ask({ kind: '__proto__' as never });
        return { cause_id: 'hub_down', level: 'confirmed' as const };
      },
    };
    const result = await runBench(asksNonsense, [generateScenario(5)], { timer: () => 0 });
    expect(result.cases[0]?.error).toMatch(/Unknown question kind/);
    expect(result.metrics.false_confirmed).toBe(0);
  });
});

describe('caller input is bounded', () => {
  it('oversized or nested service data is refused and never logged', async () => {
    const home = healthy();
    const rows = home.rows().length;
    const huge = 'x'.repeat(300_000);
    await expect(home.callService('light', 'turn_on', { entity_id: 'light.desk_lamp', effect: huge })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(home.callService('light', 'turn_on', { entity_id: 'light.desk_lamp', extra: { nested: true } })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(home.callService('light', 'turn_on', { entity_id: huge })).rejects.toMatchObject({ code: 'not_found' });
    const many = Object.fromEntries(Array.from({ length: INPUT_LIMITS.dataFields + 1 }, (_, i) => [`field_${i}`, i]));
    await expect(home.callService('light', 'turn_on', { entity_id: 'light.desk_lamp', ...many })).rejects.toMatchObject({ code: 'bad_request' });
    const targets = Array.from({ length: INPUT_LIMITS.targets + 1 }, (_, i) => `light.lamp_${i}`);
    await expect(home.callService('light', 'turn_on', { entity_id: targets })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(home.selectOption('select.desk_lamp_power_on_behavior', huge)).rejects.toMatchObject({ code: 'invalid_option' });
    expect(home.rows().length).toBe(rows);
  });

  it('accepts the service data real callers send', async () => {
    const home = healthy();
    await home.callService('light', 'turn_on', { entity_id: 'light.desk_lamp', brightness_pct: 40, rgb_color: [255, 180, 90], transition: 2 });
    await home.callService('light', 'turn_on', { entity_id: 'light.bedroom_lamp', flash: 'short' });
    await home.callService('climate', 'set_temperature', { entity_id: 'climate.thermostat', temperature: 70 });
    const calls = home.rows().filter((r) => r.type === 'call_service' && r.context?.user_id === 'user_api');
    expect(calls.map((r) => (r.type === 'call_service' ? r.service_data : undefined))).toEqual([
      { brightness_pct: 40, rgb_color: [255, 180, 90], transition: 2 },
      { flash: 'short' },
      { temperature: 70 },
    ]);
  });

  it('names and aliases are checked and capped', async () => {
    const home = healthy();
    const long = 'L'.repeat(INPUT_LIMITS.name + 1);
    await expect(home.registryUpdate('light.desk_lamp', { name: long })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(home.registryUpdate('light.desk_lamp', { name: '   ' })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(home.registryUpdate('light.desk_lamp', { aliases: Array.from({ length: INPUT_LIMITS.aliases + 1 }, (_, i) => `a${i}`) })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(home.registryUpdate('light.desk_lamp', { disabled: 'yes' as unknown as boolean })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(home.registryUpdate('light.desk_lamp', { name: 'Desk\u0000Lamp' })).rejects.toMatchObject({ code: 'bad_request' });
    expect((await home.registryUpdate('light.desk_lamp', { name: '  Desk  ', aliases: [' Work Lamp '] })).aliases).toEqual(['Work Lamp']);
  });

  it('the snapshot stays under 256 KB even when every caller sends the largest values allowed', async () => {
    const home = SimHome.create({ seed: 9 });
    const entities = await home.listEntities();
    // Three-byte characters (the most UTF-8 bytes per UTF-16 unit), so the budget is tested in bytes.
    const name = (i: number) => `台所 ${i} `.padEnd(INPUT_LIMITS.name, '灯');
    for (const [i, e] of entities.entries()) {
      await home.registryUpdate(e.entityId, { name: name(i), aliases: Array.from({ length: INPUT_LIMITS.aliases }, (_, k) => name(1000 * i + k)) });
    }
    const lights = (await home.listEntities()).filter((e) => e.domain === 'light' && e.state !== 'unavailable').map((e) => e.entityId);
    const data = Object.fromEntries(Array.from({ length: INPUT_LIMITS.dataFields }, (_, k) => [`f${k}`, 'ü'.repeat(INPUT_LIMITS.text)]));
    for (let i = 0; i < 1500; i++) {
      await home.callService('light', i % 2 ? 'turn_off' : 'turn_on', { entity_id: lights, ...data });
      if (i % 100 === 0) home.advance(60_000);
    }
    const snap = home.snapshot();
    expect(bytes(snap)).toBeLessThan(KB256);
    expect(snap.rowBytes).toBeLessThanOrEqual(snap.maxRowBytes);
    // The running count is exact: the rows array serializes to rowBytes plus its closing bracket.
    expect(bytes(snap.rows)).toBe(snap.rowBytes + 1);
    const text = JSON.stringify(snap);
    expect(JSON.stringify(SimHome.fromSnapshot(JSON.parse(text) as SimSnapshot).snapshot())).toBe(text);
  });

  it('a smaller log budget keeps fewer rows, newest first', () => {
    const home = SimHome.create({ seed: 9, maxLogBytes: 20_000 });
    const snap = home.snapshot();
    expect(snap.rowBytes).toBeLessThanOrEqual(20_000);
    expect(bytes(snap.rows)).toBe(snap.rowBytes + 1);
    const full = SimHome.create({ seed: 9 }).snapshot().rows;
    expect(snap.rows).toEqual(full.slice(full.length - snap.rows.length));
    expect(() => SimHome.create({ maxLogBytes: -1 })).toThrowError(expect.objectContaining({ code: 'bad_request' }));
  });

  it('an older snapshot without a byte count is accepted and counted on restore', () => {
    const snap = SimHome.create({ seed: 4 }).snapshot() as Partial<SimSnapshot>;
    const rowBytes = snap.rowBytes;
    delete snap.rowBytes;
    delete snap.maxRowBytes;
    const restored = SimHome.fromSnapshot(snap as SimSnapshot).snapshot();
    expect(restored.rowBytes).toBe(rowBytes);
    expect(restored.maxRowBytes).toBe(DEFAULT_MAX_ROW_BYTES);
    expect(() => SimHome.fromSnapshot({ ...(snap as SimSnapshot), entities: [] as unknown as SimSnapshot['entities'] })).toThrowError(/Not a SimHome snapshot/);
  });
});

describe('every write is one API round trip of virtual time', () => {
  it('writes move the clock by 9 to 31 ms, reads do not', async () => {
    const home = healthy();
    const t0 = Date.parse(home.now());
    await home.listEntities();
    await home.getEntity('light.desk_lamp');
    await home.events({ since: home.now() });
    await home.signals('light.desk_lamp');
    expect(Date.parse(home.now())).toBe(t0);
    const steps: number[] = [];
    let last = t0;
    const tick = () => {
      const now = Date.parse(home.now());
      steps.push(now - last);
      last = now;
    };
    await home.callService('light', 'turn_on', { entity_id: 'light.desk_lamp' });
    tick();
    await home.registryUpdate('light.desk_lamp', { aliases: ['Work Lamp'] });
    tick();
    await home.selectOption('select.desk_lamp_power_on_behavior', 'previous');
    tick();
    await home.reloadIntegration('hue');
    tick();
    await home.callService('light', 'turn_on', { entity_id: 'light.nope' }).catch(() => undefined);
    tick();
    for (const step of steps) {
      expect(step).toBeGreaterThanOrEqual(9);
      expect(step).toBeLessThanOrEqual(31);
    }
  });

  it('a command and its state change share a timestamp; the next command gets a later one', async () => {
    const home = healthy();
    const since = home.now();
    await home.callService('light', 'turn_on', { entity_id: 'light.desk_lamp' });
    await home.callService('light', 'turn_off', { entity_id: 'light.desk_lamp' });
    const ev = await home.events({ since, entityIds: ['light.desk_lamp'] });
    expect(ev.map((e) => e.kind)).toEqual(['service_call', 'state', 'service_call', 'state']);
    expect(ev[0]?.ts).toBe(ev[1]?.ts);
    expect(ev[2]?.ts).toBe(ev[3]?.ts);
    expect(Date.parse(ev[2]?.ts ?? '')).toBeGreaterThan(Date.parse(ev[0]?.ts ?? ''));
    expect(Date.parse(home.now())).toBeGreaterThan(Date.parse(ev[3]?.ts ?? ''));
  });

  it('the same calls give the same times: latency is part of the deterministic simulation', async () => {
    const run = async () => {
      const home = SimHome.create({ seed: 77 });
      for (let i = 0; i < 20; i++) await home.callService('light', i % 2 ? 'turn_off' : 'turn_on', { entity_id: 'light.desk_lamp' });
      return JSON.stringify(home.snapshot());
    };
    expect(await run()).toBe(await run());
  });
});
