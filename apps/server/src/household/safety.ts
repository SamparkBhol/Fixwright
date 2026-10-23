// Safety net drills for the demo house: two injected failures that show the repair loop failing safe on
// screen. They live here, beside the house, and not in homefault's fault
// library, so HomeTruth's scenarios and the benchmark never change. Both are one shot and SimHome only.
//
// - next_step_fails (S1): the next repair step is accepted but never lands, the way a command a device
//   dropped looks from the hub. Its read back mismatches, so the executor puts everything back.
// - overnight_relapse (S2): during the next jump to the morning, the repaired lamp loses power at 2:00 for
//   20 minutes (its wall switch is flipped off and on again). The 7:00 check sees it drop and reports
//   "acting up again" instead of confirming the repair.

import type { HomeAdapter } from '@fixwright/protocol';
import type { SimHome } from 'homefault';
import { getSetting, putSetting, type Db } from './db.ts';

export const SAFETY_DRILLS = [
  { id: 'next_step_fails', code: 'S1' },
  { id: 'overnight_relapse', code: 'S2' },
] as const;

export type SafetyDrill = (typeof SAFETY_DRILLS)[number]['id'];

const KEY = 'safety_drills';
/** When the relapse starts (household wall clock) and how long the lamp stays dark. */
export const RELAPSE_AT = '02:00';
export const RELAPSE_MS = 20 * 60_000;

/** The drill for an id or code ("next_step_fails", "S1"), or null for anything else. */
export function drillOf(idOrCode: string): SafetyDrill | null {
  const key = idOrCode.trim();
  return SAFETY_DRILLS.find((d) => d.id === key || d.code === key.toUpperCase())?.id ?? null;
}

export function armedDrills(db: Db): SafetyDrill[] {
  const stored = getSetting<string[]>(db, KEY) ?? [];
  return SAFETY_DRILLS.map((d) => d.id).filter((id) => stored.includes(id));
}

export function armDrill(db: Db, id: SafetyDrill): void {
  putSetting(db, KEY, [...new Set([...armedDrills(db), id])]);
}

/** Disarms a drill and says whether it was armed (each drill fires once). */
export function takeDrill(db: Db, id: SafetyDrill): boolean {
  const armed = armedDrills(db);
  if (!armed.includes(id)) return false;
  putSetting(
    db,
    KEY,
    armed.filter((d) => d !== id),
  );
  return true;
}

const WRITES: ReadonlySet<string> = new Set(['registryUpdate', 'registryRemove', 'selectOption', 'callService', 'reloadIntegration']);

/** The adapter with its next write accepted and dropped: nothing changes in the house, reads stay true. */
export function droppingNextWrite(adapter: HomeAdapter): HomeAdapter {
  let dropped = false;
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (typeof prop === 'string' && WRITES.has(prop)) {
        return async (...args: unknown[]) => {
          if (dropped) return fn.apply(target, args);
          dropped = true;
          return undefined;
        };
      }
      return fn.bind(target);
    },
  });
}

/** The device the newest repair with a pending morning check verifies, when it has a wall switch to flip. */
export function relapseTarget(db: Db, sim: SimHome): string | null {
  const rows = db.sql
    .exec<{ body: string }>(
      `SELECT p.body AS body FROM repairs r JOIN plans p ON p.plan_id = r.plan_id WHERE r.state = 'applied' AND r.next_check_at IS NOT NULL ORDER BY r.updated_ms DESC LIMIT 5`,
    )
    .toArray();
  for (const row of rows) {
    const plan = JSON.parse(row.body) as { verify?: { entity_ids?: unknown } };
    const ids = Array.isArray(plan.verify?.entity_ids) ? plan.verify.entity_ids.filter((x): x is string => typeof x === 'string') : [];
    const lamp = ids.find((id) => sim.physical(id).wallSwitch === 'on');
    if (lamp) return lamp;
  }
  return null;
}
