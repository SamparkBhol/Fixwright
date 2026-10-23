// The golden path end to end on one house: diagnose, answer, plan, apply and read back, the next morning
// check, explain the 3 a.m. power restore, fix it, run a checkup, and refuse the protected strip. The
// server's job (persisting sessions, tokens, alarms) is played by the test.

import { describe, expect, it } from 'vitest';
import { ToolOutputs } from '@fixwright/protocol';
import {
  answerDiagnosis,
  executePlan,
  explainEvent,
  inferTopology,
  morningCheck,
  planRepair,
  protectedGuard,
  runCheckup,
  startDiagnosis,
} from '../src/index.ts';
import { addEvent } from './support/fake-adapter.ts';
import { rig } from './support/golden-house.ts';

describe('golden path', () => {
  it('runs from "not responding" to the refused power strip', async () => {
    const r = rig();
    const { deps, house } = r;

    const dx = await startDiagnosis({ symptom: "Why the hallway lamp keeps saying it's not responding" }, deps);
    expect(ToolOutputs.diagnose.safeParse(dx.output).success).toBe(true);
    expect(dx.output.question?.text).toBe("I'll flash the hallway lamp twice. Did it blink?");

    const yes = await answerDiagnosis(dx.session, { diagnosis_id: dx.session.diagnosis_id, question_id: dx.output.question?.question_id ?? '', answer: 'Yes, it blinked.' }, deps);
    expect(yes.output.verdict?.level).toBe('confirmed');
    expect(yes.output.speech).toBe(
      'The lamp works. The name Hallway Lamp still points at an old copy of it that went offline on October 3. Want me to fix that?',
    );

    const plan = await planRepair({ kind: 'diagnosis', session: yes.session }, deps);
    expect(ToolOutputs.repair_plan.safeParse(plan.output).success).toBe(true);
    expect(plan.output.ids.diagnosis_id).toBe(dx.session.diagnosis_id);
    expect(plan.output.diff_lines).toEqual([
      'Hallway Lamp will point to the lamp that is online.',
      'The old copy, offline since October 3, is retired.',
    ]);
    const applied = await executePlan(plan.plan, deps);
    expect(applied.state).toBe('applied');
    expect(applied.speech).toBe("Done. I switched it on and off, it answered both times. I'll check on it again tomorrow morning.");
    expect(applied.steps.every((s) => s.status === 'done')).toBe(true);
    expect(house.entities.get('light.hallway_lamp')?.disabled).toBe(true);
    const repairedAt = deps.clock.now();

    for (let i = 0; i < 9; i++) {
      const t = Date.parse('2026-10-16T02:00:00.000Z') + i * 40 * 60_000;
      const want = i % 2 === 0 ? 'on' : 'off';
      addEvent(house, { ts: new Date(t).toISOString(), kind: 'service_call', entityId: 'light.hallway_lamp_2', data: { service: `light.turn_${want}` }, context: { userId: 'household_member' } });
      addEvent(house, { ts: new Date(t + 600).toISOString(), kind: 'state', entityId: 'light.hallway_lamp_2', from: want === 'on' ? 'off' : 'on', to: want, context: { userId: 'household_member' } });
    }
    r.clock.set('2026-10-16T14:00:00.000Z'); // 07:00 in Los Angeles
    const morning = await morningCheck(plan.plan, repairedAt, deps);
    expect(morning).toMatchObject({ result: 'pass', answered: 9, total: 9 });
    expect(morning.speech).toBe('Hallway lamp answered all 9 commands overnight. Repair confirmed.');
    expect(morning.detail).toBe('Hallway lamp answered all 9 commands overnight.');

    // Back to the morning after the 3:12 restore, when "at 3 a.m." means that night.
    r.clock.set('2026-10-15T17:30:00.000Z');
    const ex = await explainEvent({ question: 'Why did every plug turn on at 3 a.m.?' }, deps);
    expect(ex.output.speech).toBe(
      'Power came back at 3:12. Fourteen devices restarted within four seconds. None of your automations fired. I can make them remember whether they were on or off. Do it?',
    );
    const powerPlan = await planRepair({ kind: 'issue', session: ex.session, issue_id: ex.output.suggested_fix?.issue_id ?? '' }, deps);
    expect(powerPlan.output.ids).toMatchObject({ explanation_id: ex.output.explanation_id, issue_id: ex.output.suggested_fix?.issue_id });
    const powerApplied = await executePlan(powerPlan.plan, deps);
    expect(powerApplied.state).toBe('applied');
    expect(powerApplied.steps).toHaveLength(14);
    expect(powerApplied.steps.every((s) => s.read_back === 'Set to previous')).toBe(true);

    const ck = await runCheckup({}, deps);
    expect(ToolOutputs.home_checkup.safeParse(ck.output).success).toBe(true);
    expect(ck.output.findings.map((f) => f.title)).toEqual([
      'Two lights answer to Living Room Light',
      'Hall motion sensor battery at 6%',
      'Kitchen plug dropped off Wi-Fi 9 times today',
    ]);
    expect(ck.output.speech).toBe(
      'I found three things. Two lights answer to Living Room Light. The hall motion sensor battery is at 6%. And the kitchen plug dropped off Wi-Fi 9 times today.',
    );

    const strip = house.entities.get('switch.living_room_power_strip');
    if (!strip) throw new Error('strip missing');
    const decision = protectedGuard('turn_off', strip, deps.settings.protected, inferTopology([...house.entities.values()]));
    expect(decision).toMatchObject({
      allow: false,
      code: 'protected_load',
      alternative: { entity_id: 'switch.living_room_power_strip_outlet_1', name: 'Reading Lamp' },
      speech: "That strip runs the aquarium filter, which you marked protected. I'll turn off the lamp on it instead.",
    });
  });
});
