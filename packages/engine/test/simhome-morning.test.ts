// The golden path in its real order on homefault's SimHome twin. After step 4's jump to 07:00
// the next morning, "Why did every plug turn on at 3 a.m.?" (no date) must still find the outage night,
// because the night just past was quiet. homefault is imported by path, as in scripts/simhome-sweep.ts,
// so the engine keeps no package dependency on it.

import { describe, expect, it } from 'vitest';
import { ToolOutputs, seededRng, type HomeAdapter } from '@fixwright/protocol';
import {
  answerDiagnosis,
  createMemoryLedger,
  defaultSettings,
  executePlan,
  explainEvent,
  morningCheck,
  morningCheckAt,
  planRepair,
  startDiagnosis,
  type EngineDeps,
} from '../src/index.ts';

interface Sim extends HomeAdapter {
  advanceTo(time: string | number): void;
}
interface SimHomeModule {
  SimHome: { create(opts: { seed: number }): Sim };
}

const TZ = 'America/Los_Angeles';
const EXPLAIN =
  'Power came back at 3:12. Fourteen devices restarted within four seconds. None of your automations fired. I can make them remember whether they were on or off. Do it?';

async function simhome(seed: number): Promise<{ sim: Sim; deps: EngineDeps }> {
  const path = new URL('../../homefault/src/index.ts', import.meta.url).href;
  const { SimHome } = (await import(path)) as SimHomeModule;
  const sim = SimHome.create({ seed });
  return {
    sim,
    deps: {
      adapter: sim,
      ledger: createMemoryLedger(),
      clock: { now: () => sim.now(), nowMs: () => Date.parse(sim.now()) },
      rng: seededRng(seed),
      settings: defaultSettings({ tz: TZ }),
    },
  };
}

describe('SimHome: "at 3 a.m." after the next morning jump', () => {
  it.each([1, 2, 3])('seed %i: steps 1 to 4, then step 5 still tells the 3:12 restore', async (seed) => {
    const { sim, deps } = await simhome(seed);
    const dx = await startDiagnosis({ symptom: "Why the hallway lamp keeps saying it's not responding" }, deps);
    const q = dx.output.question;
    if (!q) throw new Error('expected the flash question');
    const yes = await answerDiagnosis(dx.session, { diagnosis_id: dx.session.diagnosis_id, question_id: q.question_id, answer: 'Yes, it blinked.' }, deps);
    const plan = await planRepair({ kind: 'diagnosis', session: yes.session }, deps);
    expect((await executePlan(plan.plan, deps)).state).toBe('applied');
    const repairedAt = sim.now();
    const at = morningCheckAt(plan.plan, Date.parse(repairedAt), TZ);
    if (at === undefined) throw new Error('expected a morning check time');
    sim.advanceTo(at);
    expect(new Date(sim.now()).getUTCHours()).toBe(14); // 07:00 Pacific daylight time
    expect((await morningCheck(plan.plan, repairedAt, deps)).result).toBe('pass');
    // The night just past was quiet, so "at 3 a.m." is the outage night, word for word.
    const ex = await explainEvent({ question: 'Why did every plug turn on at 3 a.m.?' }, deps);
    expect(ToolOutputs.explain_event.safeParse(ex.output).success).toBe(true);
    expect(ex.session.window.since).toBe('2026-10-15T10:00:00.000Z');
    expect(ex.output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'power_restore', fix_available: true });
    expect(ex.output.speech).toBe(EXPLAIN);
    // "at 3" says which 3 o'clock it was.
    const at3 = await explainEvent({ question: 'Why did every plug turn on at 3?' }, deps);
    expect(at3.output.speech).toBe(EXPLAIN.replace('at 3:12.', 'at 3:12 a.m.'));
    // The fix still covers all fourteen.
    const fix = await planRepair({ kind: 'explanation', session: ex.session }, deps);
    expect(fix.plan.steps).toHaveLength(14);
  });
});
