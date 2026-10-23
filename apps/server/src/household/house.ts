// One household's home: the SimHome twin (persisted as a snapshot, on virtual time = real time + clock
// offset) or a linked Home Assistant, plus the settings the engine needs. No Durable Object API here, so
// the CPU harness and tests can run it on node:sqlite.

import { createHaAdapter, type FetchLike, type HaAdapter } from '@fixwright/adapter-ha';
import { DEFAULT_RELIABILITY, defaultSettings, type EngineDeps, type EngineSettings, type HumanReliability, type QuietHours } from '@fixwright/engine';
import { protocolError, type Clock, type HomeAdapter, type ProtectedDevice, type ProtocolError } from '@fixwright/protocol';
import { SimHome, type SimSnapshot } from 'homefault';
import { cryptoRng, PUBLIC_HOUSEHOLD, randomBase32, seedFor } from '../lib/crypto.ts';
import { demoStartMs, TZ } from './clock.ts';
import { getSetting, putSetting, type Db } from './db.ts';
import { demoHome } from './template.ts';
import { sqlLedger, type SqlLedger } from './ledger.ts';

export { TZ, demoStartMs } from './clock.ts';
/** hh_public starts over this often (and on demand), so a judge never inherits someone else's mess. */
export const PUBLIC_RESET_MS = 60 * 60 * 1000;

export interface HouseholdInfo {
  id: string;
  seed: number;
  tz: string;
  ntfy_topic: string;
  /** Household time minus real time, for SimHome. 0 for Home Assistant. */
  clock_offset_ms: number;
  /** Real time the house was (re)built. */
  created_ms: number;
}

/** What storage keeps about the adapter. The Home Assistant token is only ever stored sealed (lib/seal.ts). */
export type AdapterConfig = { kind: 'simhome' } | { kind: 'home-assistant'; base_url: string; token_sealed: string };

export interface HouseConfig {
  demoStart: string;
  /** Real time, injectable for tests and the CPU harness. */
  realNow: () => number;
  /** Opens a sealed Home Assistant token (null when it no longer opens, e.g. the key changed). */
  unsealToken?: (sealed: string) => Promise<string | null>;
  /** fetch for the Home Assistant adapter (redirects are never followed). */
  haFetch?: FetchLike;
}

/** The household's stored Home Assistant link no longer opens: the person links it again. */
function relinkNeeded(): Error & ProtocolError {
  const p = protocolError('adapter_error', 'stored Home Assistant token does not open', "I can't use the saved Home Assistant link any more. Please link it again in the Fixwright settings.");
  return Object.assign(new Error(p.message), p);
}

/** The aquarium filter is protected from the start, so the strip refusal works on first try. */
export const DEMO_PROTECTED_REASON = 'The fish need it running.';

export interface House {
  info(): HouseholdInfo;
  adapterConfig(): AdapterConfig;
  /** Household time now (virtual for SimHome), never behind what the twin has already lived through. */
  nowMs(): number;
  /** The live adapter, with SimHome advanced to household time. */
  adapter(): Promise<HomeAdapter>;
  sim(): Promise<SimHome | null>;
  /** Writes the SimHome snapshot (call after anything that changed the house). */
  persist(): void;
  deps(): Promise<EngineDeps>;
  protectedList(): ProtectedDevice[];
  setProtected(p: ProtectedDevice, on: boolean): void;
  reliability(): HumanReliability;
  setReliability(r: HumanReliability): void;
  /** Moves household time (SimHome only): sets the offset so that household now is `targetMs`. */
  jumpTo(targetMs: number): Promise<void>;
  /** Builds a fresh house (first use, reset). Keeps the push topic when there was one. */
  build(adapter?: AdapterConfig): Promise<void>;
  exists(): boolean;
  /** Drops in memory state (after storage was wiped). */
  forget(): void;
  /** The household ledger (one per object, mirrored in memory). */
  ledger(): SqlLedger;
  /** End of an operation: write the ledger's new events and close the Home Assistant websocket. */
  release(): void;
}

export function createHouse(db: Db, household: string, cfg: HouseConfig): House {
  let sim: SimHome | null = null;
  let ha: HaAdapter | null = null;
  let cachedInfo: HouseholdInfo | undefined;
  const ledger = sqlLedger(db);
  let baseSettings: EngineSettings | undefined;

  const info = (): HouseholdInfo => {
    cachedInfo ??= getSetting<HouseholdInfo>(db, 'household');
    if (!cachedInfo) throw new Error(`household ${household} is not built`);
    return cachedInfo;
  };
  const adapterConfig = (): AdapterConfig => getSetting<AdapterConfig>(db, 'adapter') ?? { kind: 'simhome' };

  const loadSim = (): SimHome => {
    if (sim) return sim;
    const row = db.sql.exec<{ snapshot: string }>(`SELECT snapshot FROM sim WHERE id = 1`).toArray()[0];
    if (!row) throw new Error(`household ${household} has no simulated home`);
    sim = SimHome.fromSnapshot(JSON.parse(row.snapshot) as SimSnapshot);
    return sim;
  };

  const writeSnapshot = (json: string): void => {
    db.sql.exec(
      `INSERT INTO sim (id, snapshot, saved_ms) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot, saved_ms = excluded.saved_ms`,
      json,
      cfg.realNow(),
    );
  };

  const persist = (): void => {
    if (sim) writeSnapshot(JSON.stringify(sim.snapshot()));
  };

  const nowMs = (): number => {
    const target = cfg.realNow() + info().clock_offset_ms;
    return sim ? Math.max(target, Date.parse(sim.now())) : target;
  };

  const house: House = {
    info,
    adapterConfig,
    nowMs,
    async sim() {
      return adapterConfig().kind === 'simhome' ? loadSim() : null;
    },
    async adapter() {
      const a = adapterConfig();
      if (a.kind === 'home-assistant') {
        if (!ha) {
          const token = cfg.unsealToken ? await cfg.unsealToken(a.token_sealed) : null;
          if (!token) throw relinkNeeded();
          ha = createHaAdapter({ baseUrl: a.base_url, token, ...(cfg.haFetch ? { fetch: cfg.haFetch } : {}) });
        }
        return ha;
      }
      const s = loadSim();
      s.advanceTo(cfg.realNow() + info().clock_offset_ms);
      return s;
    },
    persist,
    async deps() {
      const adapter = await house.adapter();
      const clock: Clock =
        adapter.kind === 'simhome'
          ? { now: () => adapter.now(), nowMs: () => Date.parse(adapter.now()) }
          : { now: () => new Date(cfg.realNow()).toISOString(), nowMs: () => cfg.realNow() };
      // defaultSettings validates the time zone and quiet hours; do that once per object, not per call.
      baseSettings ??= defaultSettings({ tz: info().tz, ...(getSetting<QuietHours>(db, 'quiet_hours') ? { quietHours: getSetting<QuietHours>(db, 'quiet_hours') as QuietHours } : {}) });
      const settings: EngineSettings = { ...baseSettings, protected: house.protectedList(), humanReliability: house.reliability() };
      return { adapter, ledger, clock, rng: cryptoRng, settings };
    },
    protectedList() {
      return db.sql
        .exec<{ entity_id: string; name: string; reason: string }>(`SELECT entity_id, name, reason FROM protected ORDER BY at_ms, entity_id`)
        .toArray()
        .map((r) => ({ entity_id: r.entity_id, name: r.name, reason: r.reason }));
    },
    setProtected(p, on) {
      if (on) {
        db.sql.exec(
          `INSERT INTO protected (entity_id, name, reason, at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(entity_id) DO UPDATE SET name = excluded.name, reason = excluded.reason`,
          p.entity_id,
          p.name,
          p.reason,
          cfg.realNow(),
        );
      } else {
        db.sql.exec(`DELETE FROM protected WHERE entity_id = ?`, p.entity_id);
      }
    },
    reliability() {
      return getSetting<HumanReliability>(db, 'reliability') ?? { ...DEFAULT_RELIABILITY };
    },
    setReliability(r) {
      putSetting(db, 'reliability', r);
    },
    async jumpTo(targetMs) {
      const i = info();
      const next = { ...i, clock_offset_ms: i.clock_offset_ms + (targetMs - nowMs()) };
      putSetting(db, 'household', next);
      cachedInfo = next;
      const s = await house.sim();
      if (s) {
        s.advanceTo(targetMs);
        persist();
      }
    },
    async build(adapter = { kind: 'simhome' }) {
      const previous = getSetting<HouseholdInfo>(db, 'household');
      const realNow = cfg.realNow();
      const seed = seedFor(household);
      const startMs = adapter.kind === 'simhome' ? demoStartMs(cfg.demoStart, realNow, TZ) : realNow;
      const next: HouseholdInfo = {
        id: household,
        seed,
        tz: TZ,
        ntfy_topic: previous?.ntfy_topic ?? `fixwright-${randomBase32(20)}`,
        clock_offset_ms: startMs - realNow,
        created_ms: realNow,
      };
      putSetting(db, 'household', next);
      putSetting(db, 'adapter', adapter);
      cachedInfo = next;
      ha?.close();
      ha = null;
      if (adapter.kind === 'simhome') {
        const home = await demoHome(seed, TZ, startMs);
        sim = home.sim;
        writeSnapshot(home.json);
        if (home.aquarium) house.setProtected({ ...home.aquarium, reason: DEMO_PROTECTED_REASON }, true);
      } else {
        sim = null;
        db.sql.exec(`DELETE FROM sim`);
      }
    },
    exists() {
      return getSetting<HouseholdInfo>(db, 'household') !== undefined;
    },
    forget() {
      ha?.close();
      sim = null;
      ha = null;
      cachedInfo = undefined;
      baseSettings = undefined;
      ledger.reset();
    },
    ledger: () => ledger,
    release() {
      ledger.flush();
      ha?.close();
    },
  };
  return house;
}

export const isPublic = (household: string): boolean => household === PUBLIC_HOUSEHOLD;
