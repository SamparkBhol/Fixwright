// The household (tools, repair executor, due queue, demo controls) in process on node:sqlite, with the real
// engine and SimHome. Fast and deterministic; test/integration runs the same path through workerd.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { goldenPath, LINES, OUTAGE_WINDOW, valid, type Driver, type Reply } from '../support/golden.ts';
import { capToBytes, createHousehold, jsonBytes, STATE_CAP_BYTES, type Household } from '../../src/household/household.ts';
import { sqliteDb } from '../support/sqlite-db.ts';
import { clearTemplates, DEMO_TEMPLATE, demoHome } from '../../src/household/template.ts';
import { SimHome, type SimSnapshot } from 'homefault';
import { seedFor } from '../../src/lib/crypto.ts';
import { migrate, type Db } from '../../src/household/db.ts';
import { beginUndo } from '../../src/household/cas.ts';
import { recoverStuckRepairs } from '../../src/household/recovery.ts';
import type { EngineDeps } from '@fixwright/engine';

const SECRET = 'unit-test-secret-unit-test-secret-0001';
const DEMO_START = '2026-10-15T22:00:00.000Z';

interface Rig {
  household: Household;
  db: Db & { close(): void };
  received: { title: string | null; tags: string | null; body: string; topic: string }[];
  alarms: (number | null)[];
  ntfyDown: { value: boolean };
  realNow: { value: number };
}

function rig(id = 'hh_public', opts: { demoStart?: string; realNowMs?: number; db?: Db & { close(): void } } = {}): Rig {
  const db = opts.db ?? sqliteDb();
  const received: Rig['received'] = [];
  const alarms: (number | null)[] = [];
  const ntfyDown = { value: false };
  const realNow = { value: opts.realNowMs ?? Date.parse('2026-10-17T12:00:00.000Z') };
  const household = createHousehold(db, id, {
    secret: SECRET,
    ntfyBase: 'http://ntfy.test',
    demoStart: opts.demoStart ?? DEMO_START,
    allowHaLink: false,
    realNow: () => realNow.value,
    fetch: async (input, init) => {
      if (ntfyDown.value) throw new TypeError('fetch failed');
      const h = new Headers(init?.headers);
      received.push({ title: h.get('title'), tags: h.get('tags'), body: String(init?.body), topic: String(input).split('/').pop() ?? '' });
      return new Response('{}', { status: 200 });
    },
    setAlarm: async (at) => {
      alarms.push(at);
    },
  });
  return { household, db, received, alarms, ntfyDown, realNow };
}

function driver(r: Rig): Driver {
  return {
    async call(name, args) {
      return (await r.household.tool(name, args as never)) as Reply;
    },
    async nextMorning() {
      const out = await r.household.demo({ op: 'clock', to: 'next_morning' });
      expect(out.status).toBe(200);
      return out.body as never;
    },
    received: () => r.received,
  };
}

let r: Rig;
beforeEach(() => {
  r = rig();
});
afterEach(() => r.db.close());

describe('golden path in process', () => {
  it('runs the golden path end to end with every output valid', async () => {
    const out = await goldenPath(driver(r));
    expect(out.steps.length).toBeGreaterThan(5);
    // The morning check armed an alarm for 07:00 household time.
    expect(r.alarms.some((a) => a !== null)).toBe(true);
  });

  it('alarm() twice after the jump sends nothing more (idempotent handlers)', async () => {
    await goldenPath(driver(r));
    const before = r.received.length;
    expect((await r.household.alarm()).ran).toBe(0);
    expect((await r.household.alarm()).ran).toBe(0);
    expect(r.received.length).toBe(before);
  });
});

async function appliedLampRepair(d: Driver): Promise<string> {
  const dx = valid('diagnose', await d.call('diagnose', { symptom: "the hallway lamp isn't responding", device: 'hallway lamp' }));
  const q = dx['question'] as { question_id: string };
  await d.call('diagnose_answer', { diagnosis_id: dx['diagnosis_id'], question_id: q.question_id, answer: 'haan' });
  const plan = valid('repair_plan', await d.call('repair_plan', { diagnosis_id: dx['diagnosis_id'] }));
  const applied = valid('repair_apply', await d.call('repair_apply', { plan_id: plan['plan_id'], confirm_token: plan['confirm_token'] }));
  return applied['repair_id'] as string;
}

describe('simulated daytime clock (DEMO_START "15:00")', () => {
  // 03:00, 06:30 and 23:30 in Los Angeles on 15 October: hours that used to get "It's late, so I'll ask first".
  for (const real of ['2026-10-15T10:00:00.000Z', '2026-10-15T13:30:00.000Z', '2026-10-16T06:30:00.000Z']) {
    it(`a house built at ${real} starts at 15:00 that day and runs the golden path word for word`, async () => {
      const night = rig('hh_public', { demoStart: '15:00', realNowMs: Date.parse(real) });
      try {
        const s = await night.household.demo({ op: 'state' });
        expect(s.body['now']).toBe('2026-10-15T22:00:00.000Z');
        expect(s.body['clock']).toMatchObject({ simulated: true, starts_at: '15:00', tz: 'America/Los_Angeles', offset_ms: Date.parse('2026-10-15T22:00:00.000Z') - Date.parse(real) });
        expect(String((s.body['clock'] as { note: string }).note)).toMatch(/^Simulated clock\./);
        const golden = await goldenPath(driver(night));
        expect(golden.steps.length).toBeGreaterThan(5);
      } finally {
        night.db.close();
      }
    });
  }

  it('household time keeps running with real time after the anchor', async () => {
    const real = Date.parse('2026-10-16T06:30:00.000Z');
    const night = rig('hh_public', { demoStart: '15:00', realNowMs: real });
    try {
      await night.household.demo({ op: 'state' });
      night.realNow.value = real + 90_000;
      expect((await night.household.demo({ op: 'state' })).body['now']).toBe('2026-10-15T22:01:30.000Z');
    } finally {
      night.db.close();
    }
  });
});

describe('demo house template', () => {
  it('copies the prebuilt house with its own seed, and the copy runs the golden path', async () => {
    clearTemplates();
    const start = Date.parse(DEMO_START);
    const first = await demoHome(seedFor('hh_public'), 'America/Los_Angeles', start);
    expect(first.from).toBe('template');
    expect(JSON.parse(first.json)).toEqual(DEMO_TEMPLATE.snapshot);
    const id = 'hh_template_check';
    expect(seedFor(id)).not.toBe(1);
    const copy = await demoHome(seedFor(id), 'America/Los_Angeles', start);
    expect(copy.from).toBe('cache');
    expect(copy.aquarium).toEqual({ entity_id: 'switch.aquarium_filter', name: 'Aquarium Filter' });
    expect(copy.sim).toBeNull();
    const restored = SimHome.fromSnapshot(JSON.parse(copy.json) as SimSnapshot).snapshot();
    expect(restored.seed).toBe(seedFor(id));
    expect({ ...restored, seed: 1 }).toEqual(DEMO_TEMPLATE.snapshot);
    const other = rig(id);
    try {
      const golden = await goldenPath(driver(other));
      expect(golden.steps.length).toBeGreaterThan(5);
      expect((await other.household.demo({ op: 'state' })).body['protected']).toEqual([{ entity_id: 'switch.aquarium_filter', name: 'Aquarium Filter', reason: 'The fish need it running.' }]);
    } finally {
      other.db.close();
    }
  });
});

describe('due queue and pushes', () => {
  it('the morning check fires from alarm() once household time reaches 07:00, exactly once', async () => {
    // A private household: hh_public would start over after an hour of real time.
    r.db.close();
    r = rig('hh_private');
    const d = driver(r);
    const repairId = await appliedLampRepair(d);
    expect((await r.household.alarm()).ran).toBe(0);
    // Real time moves 16 hours and a second: household time just passes 07:00 the next morning.
    r.realNow.value += 16 * 3600_000 + 1000;
    const [first, second] = await Promise.all([r.household.alarm(), r.household.alarm()]);
    expect(first.ran + second.ran).toBe(1);
    expect(r.received.map((p) => p.body)).toEqual([LINES.morning]);
    expect((await r.household.alarm()).ran).toBe(0);
    const status = valid('repair_status', await d.call('repair_status', { repair_id: repairId }));
    expect(status['state']).toBe('confirmed');
  });

  it('a failed push is recorded and retried once', async () => {
    const d = driver(r);
    await appliedLampRepair(d);
    r.ntfyDown.value = true;
    const jump = await d.nextMorning();
    expect(jump.pushes).toEqual([expect.objectContaining({ message: LINES.morning, delivered: false })]);
    r.ntfyDown.value = false;
    r.realNow.value += 61_000;
    const retry = await r.household.alarm();
    expect(retry.pushes).toEqual([expect.objectContaining({ message: LINES.morning, delivered: true })]);
    expect(r.received.map((p) => p.body)).toEqual([LINES.morning]);
    const state = (await r.household.demo({ op: 'state' })).body as { pushes: { delivered: boolean; attempts: number }[] };
    expect(state.pushes[0]).toMatchObject({ delivered: true, attempts: 2 });
  });

  it('an undone repair is never checked or pushed', async () => {
    const d = driver(r);
    const repairId = await appliedLampRepair(d);
    valid('undo', await d.call('undo', { repair_id: repairId }));
    const jump = await d.nextMorning();
    expect(jump.pushes).toEqual([]);
  });
});

describe('demo controls', () => {
  it('injects faults by id or code, refuses unknown ones', async () => {
    const f = await r.household.demo({ op: 'fault', fault_id: 'F8' });
    expect(f.status).toBe(200);
    expect(f.body['active_faults']).toContain('hub_down');
    const bad = await r.household.demo({ op: 'fault', fault_id: 'F99' });
    expect(bad.status).toBe(400);
  });

  it('state is a capped god view of the simulated house', async () => {
    const s = await r.household.demo({ op: 'state' });
    expect(s.body['simulated']).toBe(true);
    expect(s.body['now']).toBe(DEMO_START);
    expect((s.body['active_faults'] as string[]).sort()).toEqual(['duplicate_spoken_name', 'ghost_after_repair', 'low_battery', 'power_restore_default_on', 'wifi_flapping']);
    expect(jsonBytes(s.body)).toBeLessThanOrEqual(STATE_CAP_BYTES);
    expect(s.body['truncated']).toBe(false);
    expect(s.body['protected']).toEqual([{ entity_id: 'switch.aquarium_filter', name: 'Aquarium Filter', reason: 'The fish need it running.' }]);
  });

  it('the state cap counts UTF-8 bytes, not UTF-16 units, and trims other lists once entities are gone', () => {
    // 3 bytes per character in UTF-8, 1 UTF-16 unit: under the cap by .length, over it on the wire.
    const entities = Array.from({ length: 40 }, (_, i) => ({ entity_id: `light.l${i}`, name: '€'.repeat(1000) }));
    const body: Record<string, unknown> = { entities, truncated: false };
    expect(JSON.stringify(body).length).toBeLessThan(STATE_CAP_BYTES);
    expect(jsonBytes(body)).toBeGreaterThan(STATE_CAP_BYTES);
    const size = capToBytes(body, [entities], STATE_CAP_BYTES);
    expect(size).toBeLessThanOrEqual(STATE_CAP_BYTES);
    expect(size).toBe(jsonBytes(body));
    expect(body['truncated']).toBe(true);
    expect(entities.length).toBeGreaterThan(0);

    const pushes = Array.from({ length: 10 }, () => ({ message: 'ü'.repeat(4000) }));
    const none: unknown[] = [];
    const other: Record<string, unknown> = { entities: none, pushes, truncated: false };
    expect(capToBytes(other, [none, pushes], 16 * 1024)).toBeLessThanOrEqual(16 * 1024);
    expect(pushes.length).toBeLessThan(10);
    expect(other['truncated']).toBe(true);
  });

  it('reset rebuilds the house and keeps the push topic; hh_public resets itself after an hour', async () => {
    const topic = ((await r.household.demo({ op: 'state' })).body['ntfy_topic']) as string;
    await r.household.demo({ op: 'fault', fault_id: 'F8' });
    const reset = await r.household.demo({ op: 'reset' });
    expect(reset.body['active_faults']).not.toContain('hub_down');
    expect((await r.household.demo({ op: 'state' })).body['ntfy_topic']).toBe(topic);
    await r.household.demo({ op: 'fault', fault_id: 'F8' });
    r.realNow.value += 61 * 60_000;
    const s = await r.household.demo({ op: 'state' });
    expect(s.body['active_faults']).not.toContain('hub_down');
  });

  it('clock jumps by milliseconds within limits', async () => {
    const ok = await r.household.demo({ op: 'clock', to: 3600_000 });
    expect(ok.body['now']).toBe('2026-10-15T23:00:00.000Z');
    expect((await r.household.demo({ op: 'clock', to: -5 })).status).toBe(400);
    expect((await r.household.demo({ op: 'clock', to: 'tomorrow' })).status).toBe(400);
  });

  it('link_ha is off unless ALLOW_HA_LINK=1', async () => {
    const out = await r.household.demo({ op: 'link_ha', base_url: 'http://127.0.0.1:1', token: 'x'.repeat(20) });
    expect(out.status).toBe(404);
  });
});

/** diagnose, "yes, it blinked", repair_plan: the hallway lamp plan, ready to apply. */
async function hallwayPlan(d: Driver): Promise<Record<string, unknown>> {
  const dx = valid('diagnose', await d.call('diagnose', { symptom: "the hallway lamp isn't responding", device: 'hallway lamp' }));
  const q = dx['question'] as { question_id: string };
  valid('diagnose_answer', await d.call('diagnose_answer', { diagnosis_id: dx['diagnosis_id'], question_id: q.question_id, answer: 'yes' }));
  return valid('repair_plan', await d.call('repair_plan', { diagnosis_id: dx['diagnosis_id'] }));
}

describe('repair executor', () => {
  it('rolls back when a read back does not match (hub down after the plan): no undo, nothing due', async () => {
    const d = driver(r);
    const plan = await hallwayPlan(d);
    expect((await r.household.demo({ op: 'fault', fault_id: 'F8' })).status).toBe(200);
    const out = valid('repair_apply', await d.call('repair_apply', { plan_id: plan['plan_id'], confirm_token: plan['confirm_token'] }));
    expect(out['state']).toBe('rolled_back');
    expect(out['undo_available']).toBe(false);
    expect(out['next_check_at']).toBeUndefined();
    expect(out['speech']).toBe("Something didn't check out, so I put everything back the way it was.");
    const statuses = (out['steps'] as { status: string }[]).map((s) => s.status);
    expect(statuses).toContain('failed');
    expect(statuses).not.toContain('done');
    const repairId = out['repair_id'] as string;
    const due = r.db.sql.exec(`SELECT COUNT(*) AS n FROM due WHERE ref_id = ?`, repairId).one()['n'];
    expect(due).toBe(0);
    const status = valid('repair_status', await d.call('repair_status', { repair_id: repairId }));
    expect(status['state']).toBe('rolled_back');
    expect(status['undo_available']).toBe(false);
    const undo = await d.call('undo', { repair_id: repairId });
    expect(undo.isError).toBe(true);
    expect((undo.structuredContent['problem'] as { code: string }).code).toBe('no_fix');
    // The plan is spent: a second apply with the same token is refused.
    const again = await d.call('repair_apply', { plan_id: plan['plan_id'], confirm_token: plan['confirm_token'] });
    expect((again.structuredContent['problem'] as { code: string }).code).toBe('plan_used');
  });
});

describe('safety net drills (demo house only, one shot each)', () => {
  const lampName = async (): Promise<string | undefined> => {
    const st = await r.household.demo({ op: 'state' });
    return (st.body['entities'] as { entity_id: string; name: string }[]).find((e) => e.entity_id === 'light.hallway_lamp_2')?.name;
  };

  it('S1: the next step does not stick, so the repair rolls back and changes nothing; the next try works', async () => {
    const d = driver(r);
    const plan = await hallwayPlan(d);
    const before = await lampName();
    const armed = await r.household.demo({ op: 'fault', fault_id: 'S1' });
    expect(armed.status).toBe(200);
    expect(armed.body['active_faults']).toContain('next_step_fails');
    const out = valid('repair_apply', await d.call('repair_apply', { plan_id: plan['plan_id'], confirm_token: plan['confirm_token'] }));
    expect(out['state']).toBe('rolled_back');
    expect(out['undo_available']).toBe(false);
    expect(out['speech']).toBe("Something didn't check out, so I put everything back the way it was.");
    expect((out['steps'] as { status: string }[])[0]?.status).toBe('failed');
    expect(await lampName()).toBe(before);
    // One shot: the drill is gone, and a fresh plan applies and reads back.
    expect((await r.household.demo({ op: 'state' })).body['active_faults']).not.toContain('next_step_fails');
    const again = await hallwayPlan(d);
    const ok = valid('repair_apply', await d.call('repair_apply', { plan_id: again['plan_id'], confirm_token: again['confirm_token'] }));
    expect(ok['state']).toBe('applied');
    expect(await lampName()).toBe('Hallway Lamp');
  });

  it('S2: the repaired lamp loses power overnight, so the 7:00 check reports it acting up again', async () => {
    const d = driver(r);
    const plan = await hallwayPlan(d);
    const applied = valid('repair_apply', await d.call('repair_apply', { plan_id: plan['plan_id'], confirm_token: plan['confirm_token'] }));
    expect(applied['state']).toBe('applied');
    expect((await r.household.demo({ op: 'fault', fault_id: 'overnight_relapse' })).body['active_faults']).toContain('overnight_relapse');
    const jump = await r.household.demo({ op: 'clock', to: 'next_morning' });
    expect(jump.status).toBe(200);
    expect(jump.body['relapse']).toBe('light.hallway_lamp_2 lost power at 02:00 for 20 minutes');
    const status = valid('repair_status', await d.call('repair_status', { repair_id: applied['repair_id'] }));
    expect(status['state']).toBe('regressed');
    const checks = status['checks'] as { result: string; detail: string }[];
    expect(checks.at(-1)?.result).toBe('fail');
    expect(checks.at(-1)?.detail).toBe('Hallway lamp missed 1 of 9 commands and went offline once overnight.');
    expect(r.received.at(-1)?.title).toBe('Repair needs a look');
    expect((await r.household.demo({ op: 'state' })).body['active_faults']).not.toContain('overnight_relapse');
  });

  it('an unknown id lists the drills next to the faults', async () => {
    const bad = await r.household.demo({ op: 'fault', fault_id: 'S9' });
    expect(bad.status).toBe(400);
    expect(String(bad.body['error'])).toContain('next_step_fails, overnight_relapse');
  });
});

/** explain_event for the 3 a.m. outage, repair_plan, repair_apply: the power on settings repair, applied. */
async function appliedPowerRepair(d: Driver): Promise<{ repairId: string; planId: string }> {
  const ex = valid('explain_event', await d.call('explain_event', { question: 'Why did every plug turn on at 3 a.m.?', ...OUTAGE_WINDOW }));
  const plan = valid('repair_plan', await d.call('repair_plan', { explanation_id: ex['explanation_id'] }));
  const out = valid('repair_apply', await d.call('repair_apply', { plan_id: plan['plan_id'], confirm_token: plan['confirm_token'] }));
  expect(out['state']).toBe('applied');
  return { repairId: out['repair_id'] as string, planId: plan['plan_id'] as string };
}

/** Puts a repair back the way an eviction mid apply leaves it: 'applying', nothing recorded, nothing due. */
function cutOffMidApply(db: Db, repairId: string): void {
  db.sql.exec(`UPDATE repairs SET state = 'applying', applied = '[]', checks = '[]', next_check_at = NULL, repaired_at = NULL, speech = '' WHERE repair_id = ?`, repairId);
  db.sql.exec(`DELETE FROM due WHERE ref_id = ?`, repairId);
}

const recoveryEvents = (db: Db): { status: string; step: number }[] =>
  db.sql
    .exec<{ body: string }>(`SELECT body FROM events WHERE kind = 'repair'`)
    .toArray()
    .map((e) => JSON.parse(e.body) as { data?: { phase?: string; status: string; step: number } })
    .filter((e) => e.data?.phase === 'recovery')
    .map((e) => ({ status: (e.data as { status: string }).status, step: (e.data as { step: number }).step }));

describe('recovery sweep: a repair cut off while applying is settled by read back when the object wakes', () => {
  it('every step ran and reads back: applied, with its undo and its morning check', async () => {
    const { repairId } = await appliedPowerRepair(driver(r));
    cutOffMidApply(r.db, repairId);
    expect((await driver(r).call('repair_status', { repair_id: repairId })).isError).toBe(true); // still "running" in this object
    const woke = rig('hh_public', { db: r.db });
    const st = valid('repair_status', await driver(woke).call('repair_status', { repair_id: repairId }));
    expect(st['state']).toBe('applied');
    expect(st['undo_available']).toBe(true);
    expect(typeof st['next_check_at']).toBe('string');
    expect((st['steps'] as { status: string }[]).every((s) => s.status === 'done')).toBe(true);
    expect(r.db.sql.exec(`SELECT COUNT(*) AS n FROM due WHERE kind = 'morning_check' AND ref_id = ?`, repairId).one()['n']).toBe(1);
    expect(recoveryEvents(r.db).length).toBe((st['steps'] as unknown[]).length);
    expect(recoveryEvents(r.db).every((e) => e.status === 'done')).toBe(true);
    // Settled once: undo works from here as usual.
    expect(valid('undo', await driver(woke).call('undo', { repair_id: repairId }))['state']).toBe('undone');
  });

  it('cut off before the last step (the flash check): rolled back, each inverse read back, no undo, nothing due', async () => {
    const d = driver(r);
    const plan = await hallwayPlan(d);
    const out = valid('repair_apply', await d.call('repair_apply', { plan_id: plan['plan_id'], confirm_token: plan['confirm_token'] }));
    expect(out['state']).toBe('applied');
    const repairId = out['repair_id'] as string;
    const steps = out['steps'] as { step: number }[];
    cutOffMidApply(r.db, repairId);
    r.db.sql.exec(`DELETE FROM step_claims WHERE key = ?`, `${plan['plan_id'] as string}:${steps.length}`);
    const woke = rig('hh_public', { db: r.db });
    const st = valid('repair_status', await driver(woke).call('repair_status', { repair_id: repairId }));
    expect(st['state']).toBe('rolled_back');
    expect(st['undo_available']).toBe(false);
    expect(st['next_check_at']).toBeUndefined();
    expect(st['speech']).toBe("Something didn't check out, so I put everything back the way it was.");
    const statuses = (st['steps'] as { status: string }[]).map((s) => s.status);
    expect(statuses.at(-1)).toBe('skipped');
    expect(statuses).toContain('rolled_back');
    expect(r.db.sql.exec(`SELECT COUNT(*) AS n FROM due WHERE ref_id = ?`, repairId).one()['n']).toBe(0);
    expect(recoveryEvents(r.db).filter((e) => e.status === 'rolled_back').length).toBe(statuses.filter((s) => s === 'rolled_back').length);
    // The plan stays spent.
    const again = await driver(woke).call('repair_apply', { plan_id: plan['plan_id'], confirm_token: plan['confirm_token'] });
    expect((again.structuredContent['problem'] as { code: string }).code).toBe('plan_used');
  });

  it('an undo cut off midway is run again and read back: undone', async () => {
    const { repairId } = await appliedPowerRepair(driver(r));
    expect(beginUndo(r.db, repairId, r.realNow.value).ok).toBe(true);
    const woke = rig('hh_public', { db: r.db });
    const st = valid('repair_status', await driver(woke).call('repair_status', { repair_id: repairId }));
    expect(st['state']).toBe('undone');
    expect(st['undo_available']).toBe(false);
    expect((st['steps'] as { status: string }[]).every((s) => s.status === 'done')).toBe(true);
  });

  it('waits while the hub does not answer, and changes nothing', async () => {
    const db = sqliteDb();
    try {
      migrate(db);
      db.sql.exec(`INSERT INTO repairs (repair_id, plan_id, state, epoch, steps, applied, checks, speech, updated_ms) VALUES ('rep_x', 'pln_x', 'applying', 1, '[]', '[]', '[]', '', 0)`);
      const deps = { adapter: { hubStatus: async () => ({ reachable: false }) } } as unknown as EngineDeps;
      const out = await recoverStuckRepairs(db, deps, () => 0);
      expect(out).toEqual({ recovered: [], deferred: true });
      expect(db.sql.exec(`SELECT state, epoch FROM repairs`).one()).toEqual({ state: 'applying', epoch: 1 });
    } finally {
      db.close();
    }
  });
});

describe('failures speak', () => {
  it('unknown sessions, plans and repairs come back as isError with a speech line', async () => {
    const d = driver(r);
    for (const [name, args, code] of [
      ['diagnose_answer', { diagnosis_id: 'dx_00000000000000000a', question_id: 'q_00000000000000000a', answer: 'yes' }, 'session_expired'],
      ['repair_apply', { plan_id: 'pln_00000000000000000a', confirm_token: 'x'.repeat(43) }, 'not_found'],
      ['repair_status', { repair_id: 'rep_00000000000000000a' }, 'not_found'],
      ['refresh_view', { ref_id: 'chk_00000000000000000a' }, 'not_found'],
    ] as const) {
      const out = await d.call(name, args);
      expect(out.isError, name).toBe(true);
      expect((out.structuredContent['problem'] as { code: string }).code, name).toBe(code);
      expect(typeof out.structuredContent['speech']).toBe('string');
    }
  });

  it('an expired plan is refused and changes nothing', async () => {
    const d = driver(r);
    const dx = valid('diagnose', await d.call('diagnose', { symptom: "the hallway lamp isn't responding", device: 'hallway lamp' }));
    const q = dx['question'] as { question_id: string };
    await d.call('diagnose_answer', { diagnosis_id: dx['diagnosis_id'], question_id: q.question_id, answer: 'yes' });
    const plan = valid('repair_plan', await d.call('repair_plan', { diagnosis_id: dx['diagnosis_id'] }));
    r.realNow.value += 6 * 60_000;
    const out = await d.call('repair_apply', { plan_id: plan['plan_id'], confirm_token: plan['confirm_token'] });
    expect((out.structuredContent['problem'] as { code: string }).code).toBe('plan_expired');
    expect(r.db.sql.exec(`SELECT COUNT(*) AS n FROM repairs`).one()['n']).toBe(0);
  });
});

describe('households are isolated', () => {
  it('two households keep separate houses, plans and ledgers', async () => {
    const other = rig('hh_other');
    try {
      await other.household.demo({ op: 'fault', fault_id: 'F8' });
      const mine = (await r.household.demo({ op: 'state' })).body;
      expect(mine['active_faults']).not.toContain('hub_down');
      const d = driver(r);
      const dx = valid('diagnose', await d.call('diagnose', { symptom: "the hallway lamp isn't responding", device: 'hallway lamp' }));
      const theirs = await driver(other).call('diagnose_answer', { diagnosis_id: dx['diagnosis_id'], question_id: (dx['question'] as { question_id: string }).question_id, answer: 'yes' });
      expect((theirs.structuredContent['problem'] as { code: string }).code).toBe('session_expired');
    } finally {
      other.db.close();
    }
  });
});
