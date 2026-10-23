// Everything one household does, independent of the Durable Object API: tools, demo controls, the due
// queue and its alarm time. do.ts wires it to Cloudflare; tests and the CPU harness wire it to node:sqlite.

import { createHaAdapter, isHaError, type FetchLike } from '@fixwright/adapter-ha';
import { nextLocalTime } from '@fixwright/engine';
import type { ToolInputMap, ToolName } from '@fixwright/protocol';
import { FAULT_IDS, faultId } from 'homefault';
import { migrate, wipe, type Db } from './db.ts';
import { clockLabel, type ClockLabel } from './clock.ts';
import { alarmTime, runDue, type Push, type PushRecord } from './due.ts';
import { recoverStuckRepairs, stuckRepairs } from './recovery.ts';
import { createHouse, isPublic, PUBLIC_RESET_MS, type AdapterConfig, type House } from './house.ts';
import { armDrill, armedDrills, drillOf, RELAPSE_AT, RELAPSE_MS, relapseTarget, SAFETY_DRILLS, takeDrill } from './safety.ts';
import { MUTATING, runTool, type ToolReply } from './tools.ts';
import { seal, unseal } from '../lib/seal.ts';

export interface HouseholdConfig {
  secret: string;
  /** Key material for sealing the stored Home Assistant token (HA_TOKEN_KEY, else CONFIRM_SECRET). */
  tokenKey?: string;
  ntfyBase: string;
  demoStart: string;
  allowHaLink: boolean;
  realNow?: () => number;
  fetch?: typeof fetch;
  /** Wipes all storage (Durable Object deleteAll); defaults to deleting every table's rows. */
  wipeAll?: () => Promise<void>;
  /** Sets or clears the one alarm (real ms). */
  setAlarm: (atMs: number | null) => Promise<void>;
}

export type DemoOp =
  | { op: 'init' }
  | { op: 'fault'; fault_id: string }
  | { op: 'clock'; to: unknown }
  | { op: 'reset' }
  | { op: 'state' }
  | { op: 'link_ha'; base_url: string; token: string };

export interface DemoReply {
  status: number;
  body: Record<string, unknown>;
}

/** /demo/state answers at most this many bytes. */
export const STATE_CAP_BYTES = 64 * 1024;
/** A numeric /demo/clock jump moves at most this far (household time). */
export const MAX_JUMP_MS = 7 * 24 * 3600_000;

const utf8 = new TextEncoder();

/** Bytes of the JSON a route sends for `value` (UTF-8, as on the wire). */
export const jsonBytes = (value: unknown): number => utf8.encode(JSON.stringify(value)).byteLength;

/**
 * Shortens `lists` (arrays inside `body`, least important first) from the end until `body` serializes to at
 * most `capBytes` UTF-8 bytes, marking it truncated when anything went. Returns the final size.
 */
export function capToBytes(body: Record<string, unknown>, lists: readonly unknown[][], capBytes: number): number {
  let size = jsonBytes(body);
  for (const list of lists) {
    while (size > capBytes && list.length > 0) {
      list.length = Math.floor(list.length * 0.8);
      body['truncated'] = true;
      size = jsonBytes(body);
    }
  }
  return size;
}

/** What /demo/link-ha says when Home Assistant does not link: the kind of failure, never its text. */
export function linkError(err: unknown): string {
  if (!isHaError(err)) return 'Could not link Home Assistant.';
  switch (err.kind) {
    case 'auth':
      return 'Home Assistant did not accept that token.';
    case 'unreachable':
    case 'timeout':
      return 'Could not reach Home Assistant at that address.';
    default:
      return 'Home Assistant did not answer the way it should.';
  }
}

/** The clock line of /demo/state: how this house keeps time, and how far it is from real time. */
export function stateClock(simhome: boolean, demoStart: string, tz: string, offsetMs: number): ClockLabel & { offset_ms: number } {
  if (!simhome) return { simulated: false, starts_at: 'now', tz, note: 'A linked Home Assistant runs on real time.', offset_ms: 0 };
  const label = clockLabel(demoStart, tz);
  if (!label.simulated && offsetMs !== 0) return { ...label, simulated: true, note: 'Simulated clock. This house was moved in time with /demo/clock.', offset_ms: offsetMs };
  return { ...label, offset_ms: offsetMs };
}

export interface Household {
  tool<N extends ToolName>(name: N, input: ToolInputMap[N]): Promise<ToolReply>;
  demo(op: DemoOp): Promise<DemoReply>;
  alarm(): Promise<{ ran: number; pushes: Push[] }>;
}

export function createHousehold(db: Db, householdId: string, cfg: HouseholdConfig): Household {
  const realNow = cfg.realNow ?? Date.now;
  const fetchFn = cfg.fetch ?? ((input, init) => fetch(input, init));
  migrate(db);
  const tokenKey = cfg.tokenKey ?? cfg.secret;
  // Home Assistant calls never follow redirects: an allowed address cannot bounce the token somewhere else.
  const haFetch: FetchLike = (url, init) => fetchFn(url, { ...init, redirect: 'manual' });
  const house: House = createHouse(db, householdId, {
    demoStart: cfg.demoStart,
    realNow,
    haFetch,
    unsealToken: (sealed) => unseal(tokenKey, sealed, householdId),
  });
  const dueCtx = { db, house, ntfyBase: cfg.ntfyBase, realNow, fetch: fetchFn };

  const rearm = async (): Promise<void> => {
    await cfg.setAlarm(alarmTime(dueCtx));
  };

  const reset = async (adapter?: AdapterConfig): Promise<void> => {
    const topic = house.exists() ? house.info().ntfy_topic : undefined;
    house.forget();
    if (cfg.wipeAll) {
      await cfg.wipeAll();
      migrate(db);
    } else {
      wipe(db);
    }
    if (topic) db.sql.exec(`INSERT INTO settings (key, value) VALUES ('household', ?)`, JSON.stringify({ ntfy_topic: topic }));
    await house.build(adapter);
    await rearm();
  };

  /** Builds the house on first use; hh_public also starts over once an hour. */
  const ready = async (): Promise<void> => {
    if (!house.exists() || !house.info().id) {
      await reset();
      return;
    }
    if (isPublic(householdId) && realNow() - house.info().created_ms > PUBLIC_RESET_MS) await reset();
  };

  // A fresh object has no call in flight, so any repair still 'applying' or 'undoing' was cut off by an
  // eviction or redeploy: settle it once, on the first call, by reading the home back (recovery.ts).
  let recovery: Promise<void> | null = null;
  const recoverOnce = (): Promise<void> => {
    recovery ??= (async () => {
      if (!house.exists() || stuckRepairs(db).length === 0) return;
      const out = await recoverStuckRepairs(db, await house.deps(), realNow);
      if (out.deferred) {
        recovery = null;
        return;
      }
      house.persist();
      await rearm();
      for (const r of out.recovered) console.log(`[recovery] repair ${r.repair_id}: ${r.from} -> ${r.to}`);
    })().catch((err: unknown) => {
      recovery = null;
      console.error('[recovery] failed, will try again on the next call', err);
    });
    return recovery;
  };

  const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } finally {
      house.release();
    }
  };

  // Faults in the twin, then the safety net drills that are armed (they fire once, see safety.ts).
  const activeFaults = async (): Promise<string[]> => {
    const sim = await house.sim();
    return sim ? [...sim.activeFaults(), ...armedDrills(db)] : [];
  };

  const state = async (): Promise<Record<string, unknown>> => {
    const sim = await house.sim();
    const adapter = await house.adapter();
    const info = house.info();
    const entities = (await adapter.listEntities()).map((e) => ({
      entity_id: e.entityId,
      name: e.name,
      domain: e.domain,
      area: e.area ?? null,
      integration: e.integration,
      state: e.state,
      ...(e.restored ? { restored: true } : {}),
      ...(e.disabled ? { disabled: true } : {}),
      ...(sim ? { physical: sim.physical(e.entityId) } : {}),
    }));
    const repairs = db.sql
      .exec<{ repair_id: string; plan_id: string; state: string; next_check_at: string | null }>(`SELECT repair_id, plan_id, state, next_check_at FROM repairs ORDER BY updated_ms DESC LIMIT 20`)
      .toArray();
    const due = db.sql
      .exec<{ kind: string; ref_id: string; due_ms: number; status: string; attempts: number }>(`SELECT kind, ref_id, due_ms, status, attempts FROM due WHERE status != 'done' ORDER BY due_ms LIMIT 20`)
      .toArray()
      .map((d) => ({ kind: d.kind, ref_id: d.ref_id, due_at: new Date(d.due_ms).toISOString(), status: d.status, attempts: d.attempts }));
    const pushes = db.sql
      .exec<PushRecord & Record<string, string | number | null>>(`SELECT * FROM pushes ORDER BY id DESC LIMIT 10`)
      .toArray()
      .map((p) => ({ title: p.title, message: p.message, at: p.at, delivered: p.status === 'sent', attempts: p.attempts }));
    const ledger = db.sql.exec<{ n: number; last: number | null }>(`SELECT COUNT(*) AS n, MAX(seq) AS last FROM events`).one();
    const body: Record<string, unknown> = {
      now: new Date(house.nowMs()).toISOString(),
      clock: stateClock(adapter.kind === 'simhome', cfg.demoStart, info.tz, info.clock_offset_ms),
      simulated: adapter.kind === 'simhome',
      adapter: adapter.kind,
      household: isPublic(householdId) ? 'public' : 'private',
      tz: info.tz,
      ntfy_topic: info.ntfy_topic,
      active_faults: await activeFaults(),
      protected: house.protectedList(),
      repairs,
      due,
      pushes,
      ledger: { events: ledger.n, last_seq: ledger.last ?? 0 },
      entity_count: entities.length,
      entities,
      truncated: false,
    };
    capToBytes(body, [entities, pushes, due, repairs], STATE_CAP_BYTES);
    return body;
  };

  /**
   * The overnight relapse drill (safety.ts), when armed and the jump passes 2:00: the repaired lamp loses
   * power for 20 minutes on the way to `target`, so the morning check sees it drop. Says what it did.
   */
  const overnightRelapse = async (target: number): Promise<string | null> => {
    if (!armedDrills(db).includes('overnight_relapse')) return null;
    const sim = await house.sim();
    const at = nextLocalTime(house.nowMs(), house.info().tz, RELAPSE_AT);
    if (!sim || at + RELAPSE_MS > target) return null;
    await house.adapter();
    const lamp = relapseTarget(db, sim);
    if (!lamp) return null;
    takeDrill(db, 'overnight_relapse');
    await house.jumpTo(at);
    sim.setWallSwitch(lamp, false);
    await house.jumpTo(at + RELAPSE_MS);
    sim.setWallSwitch(lamp, true);
    house.persist();
    return `${lamp} lost power at ${RELAPSE_AT} for ${RELAPSE_MS / 60_000} minutes`;
  };

  const demo = async (op: DemoOp): Promise<DemoReply> => {
    if (op.op === 'reset') {
      const adapter = house.exists() ? house.adapterConfig() : undefined;
      await reset(adapter?.kind === 'home-assistant' ? adapter : undefined);
      return { status: 200, body: { ok: true, now: new Date(house.nowMs()).toISOString(), active_faults: await activeFaults() } };
    }
    await ready();
    await recoverOnce();
    switch (op.op) {
      case 'init':
        return { status: 200, body: { ok: true, ntfy_topic: house.info().ntfy_topic } };
      case 'state':
        return { status: 200, body: await state() };
      case 'fault': {
        const sim = await house.sim();
        if (!sim) return { status: 409, body: { ok: false, error: 'Faults are injected into the simulated home only.' } };
        const drill = drillOf(op.fault_id);
        if (drill) {
          armDrill(db, drill);
          return { status: 200, body: { ok: true, active_faults: await activeFaults(), now: new Date(house.nowMs()).toISOString() } };
        }
        let id: string;
        try {
          id = faultId(op.fault_id);
        } catch {
          const ids = [...FAULT_IDS, ...SAFETY_DRILLS.map((d) => d.id)];
          return { status: 400, body: { ok: false, error: `Unknown fault_id. Use one of ${ids.join(', ')}.`, active_faults: await activeFaults() } };
        }
        await house.adapter();
        sim.inject(id as (typeof FAULT_IDS)[number]);
        house.persist();
        return { status: 200, body: { ok: true, active_faults: await activeFaults(), now: new Date(house.nowMs()).toISOString() } };
      }
      case 'clock': {
        if (house.adapterConfig().kind !== 'simhome') return { status: 409, body: { ok: false, error: 'A linked Home Assistant runs on real time.' } };
        const now = house.nowMs();
        let target: number;
        if (op.to === 'next_morning') target = nextLocalTime(now, house.info().tz, '07:00');
        else if (typeof op.to === 'number' && Number.isFinite(op.to) && op.to > 0 && op.to <= MAX_JUMP_MS) target = now + op.to;
        else return { status: 400, body: { ok: false, error: `to must be "next_morning" or a number of milliseconds from 1 to ${MAX_JUMP_MS}.` } };
        const relapse = await overnightRelapse(target);
        await house.jumpTo(target);
        const { pushes } = await runDue(dueCtx);
        house.persist();
        await rearm();
        return { status: 200, body: { ok: true, now: new Date(house.nowMs()).toISOString(), pushes, ...(relapse ? { relapse } : {}) } };
      }
      case 'link_ha': {
        if (!cfg.allowHaLink) return { status: 404, body: { ok: false, error: 'Not found.' } };
        if (isPublic(householdId)) return { status: 403, body: { ok: false, error: 'The shared demo household cannot be linked. Create your own with POST /demo/household.' } };
        try {
          const ha = createHaAdapter({ baseUrl: op.base_url, token: op.token, fetch: haFetch });
          const hub = await ha.hubStatus().finally(() => ha.close());
          if (!hub.reachable) return { status: 502, body: { ok: false, error: 'Home Assistant did not answer as running.' } };
          const adapter: AdapterConfig = { kind: 'home-assistant', base_url: op.base_url, token_sealed: await seal(tokenKey, op.token, householdId) };
          await reset(adapter);
          return { status: 200, body: { ok: true, adapter: 'home-assistant', version: hub.version ?? null } };
        } catch (err) {
          // The upstream answer stays in the log; the caller gets a fixed line, never Home Assistant's text.
          console.error('[link_ha] failed', isHaError(err) ? `${err.kind}${err.status ? ` HTTP ${err.status}` : ''}` : err);
          return { status: 502, body: { ok: false, error: linkError(err) } };
        }
      }
    }
  };

  return {
    async tool(name, input) {
      return guarded(async () => {
        await ready();
        await recoverOnce();
        const reply = await runTool(name, input, { db, house, secret: cfg.secret, realNow });
        if (MUTATING.has(name)) house.persist();
        if (name === 'repair_apply' || name === 'undo' || name === 'diagnose' || name === 'diagnose_answer') await rearm();
        return reply;
      });
    },
    demo: (op) => guarded(() => demo(op)),
    async alarm() {
      return guarded(async () => {
        if (!house.exists()) return { ran: 0, pushes: [] };
        await recoverOnce();
        const out = await runDue(dueCtx);
        house.persist();
        await rearm();
        return out;
      });
    },
  };
}
