// "Did the hallway lamp fix hold?" goes to the hallway lamp's repair even when a newer repair (the power on
// fix from an explanation) also touched the lamp, and a push that names the lamp finds the same repair.

import { describe, expect, it } from 'vitest';
import diagnoseFx from '@fixwright/protocol/fixtures/diagnose.json' with { type: 'json' };
import answerFx from '@fixwright/protocol/fixtures/diagnose_answer.json' with { type: 'json' };
import planFx from '@fixwright/protocol/fixtures/repair_plan.json' with { type: 'json' };
import applyFx from '@fixwright/protocol/fixtures/repair_apply.json' with { type: 'json' };
import explainFx from '@fixwright/protocol/fixtures/explain_event.json' with { type: 'json' };
import { applyResult, initialState, isToolRoute, MAX_REPAIRS, noRepairFor, REPLIES, repairForText, routeUtterance, type ConversationState } from '../src/index.ts';

const S0 = initialState();
const QUESTION = applyResult(S0, { tool: 'diagnose', arguments: { device: 'hallway lamp' }, structuredContent: diagnoseFx });
const VERDICT = applyResult(QUESTION, { tool: 'diagnose_answer', structuredContent: answerFx });
const PLAN = applyResult(VERDICT, { tool: 'repair_plan', arguments: { diagnosis_id: diagnoseFx.diagnosis_id }, structuredContent: planFx });
const LAMP_FIXED = applyResult(PLAN, { tool: 'repair_apply', arguments: { plan_id: planFx.plan_id, confirm_token: planFx.confirm_token }, structuredContent: applyFx });
const LAMP_REPAIR = applyFx.repair_id;

// The power on fix: offered by an explanation, so it has no single device; its steps name fourteen.
const POWER_PLAN = {
  ...planFx,
  ids: { ...planFx.ids, plan_id: 'pln_power0000000000001' },
  plan_id: 'pln_power0000000000001',
  confirm_token: 'ct_power_0000000000000000000001',
  diff_lines: ['Fourteen devices will remember whether they were on or off when power comes back.'],
};
const POWER_REPAIR = 'rep_power0000000000001';
const POWER_APPLY = {
  ...applyFx,
  ids: { ...applyFx.ids, plan_id: POWER_PLAN.plan_id, repair_id: POWER_REPAIR },
  repair_id: POWER_REPAIR,
  plan_id: POWER_PLAN.plan_id,
  steps: ['Desk Lamp', 'Hallway Lamp', 'Kettle Plug'].map((name, i) => ({ step: i + 1, label: `Set ${name} to remember its last state`, status: 'done', read_back: 'Set to previous' })),
};
const EXPLAINED = applyResult(LAMP_FIXED, { tool: 'explain_event', arguments: { question: 'Why did every plug turn on at 3 a.m.?' }, structuredContent: explainFx });
const POWER_PLANNED = applyResult(EXPLAINED, { tool: 'repair_plan', arguments: { issue_id: explainFx.suggested_fix!.issue_id }, structuredContent: POWER_PLAN });
const BOTH = applyResult(POWER_PLANNED, { tool: 'repair_apply', arguments: { plan_id: POWER_PLAN.plan_id, confirm_token: POWER_PLAN.confirm_token }, structuredContent: POWER_APPLY });

function statusId(say: string, state: ConversationState): string | null {
  const r = routeUtterance(say, state);
  return isToolRoute(r) && r.tool === 'repair_status' ? (r.arguments['repair_id'] as string) : null;
}

describe('repair memory', () => {
  it('remembers each applied repair with what it was about, newest last', () => {
    expect(PLAN.pendingPlan?.subject).toBe(diagnoseFx.target.name);
    expect(BOTH.repairs?.map((r) => r.repair_id)).toEqual([LAMP_REPAIR, POWER_REPAIR]);
    expect(BOTH.repairs?.[0]?.subject).toBe(diagnoseFx.target.name);
    expect(BOTH.repairs?.[1]?.subject).toBeNull();
    expect(BOTH.repairs?.[1]?.text).toContain('Set Kettle Plug to remember its last state');
    expect(BOTH.last.repair_id).toBe(POWER_REPAIR);
  });

  it('keeps at most MAX_REPAIRS, and a repeated id moves to the end', () => {
    let s: ConversationState = BOTH;
    for (let i = 0; i < MAX_REPAIRS + 2; i++) {
      const planId = `pln_more${String(i).padStart(14, '0')}`;
      const repairId = `rep_more${String(i).padStart(14, '0')}`;
      s = applyResult(s, { tool: 'repair_plan', structuredContent: { ...POWER_PLAN, plan_id: planId, ids: { plan_id: planId } } });
      s = applyResult(s, { tool: 'repair_apply', structuredContent: { ...POWER_APPLY, plan_id: planId, repair_id: repairId, ids: { plan_id: planId, repair_id: repairId } } });
    }
    expect(s.repairs).toHaveLength(MAX_REPAIRS);
    const again = applyResult(s, { tool: 'repair_apply', structuredContent: { ...POWER_APPLY, repair_id: 'rep_more00000000000003', ids: { repair_id: 'rep_more00000000000003' } } });
    expect(again.repairs?.at(-1)?.repair_id).toBe('rep_more00000000000003');
    expect(again.repairs).toHaveLength(MAX_REPAIRS);
  });

  it('a failed apply remembers nothing', () => {
    const s = applyResult(POWER_PLANNED, { tool: 'repair_apply', isError: true, structuredContent: { status: 'error' } });
    expect(s.repairs?.map((r) => r.repair_id)).toEqual([LAMP_REPAIR]);
  });
});

describe('status questions that name a device', () => {
  it.each([
    'Did the hallway lamp fix hold?',
    'did the hallway lamp repair work',
    'Is the hallway lamp fix holding?',
    'How is the hallway lamp fix doing?',
    'Did the fix on the hallway lamp hold?',
    'Alexa, ask Fixwright did the hallway lamp fix hold?',
    'status of the hallway lamp fix',
  ])('%s -> the hallway lamp repair, not the newer power fix', (say) => {
    expect(statusId(say, BOTH)).toBe(LAMP_REPAIR);
  });

  it('a device only the power fix touched goes to the power fix', () => {
    expect(statusId('Did the kettle plug fix hold?', BOTH)).toBe(POWER_REPAIR);
  });

  it('a device no repair touched gets a plain answer, not some other repair', () => {
    const r = routeUtterance('Did the garage door fix hold?', BOTH);
    expect(isToolRoute(r)).toBe(false);
    expect(r).toMatchObject({ reply: noRepairFor('garage door'), intent: 'status' });
    expect(noRepairFor('garage door')).not.toMatch(/[\u2013\u2014]/);
  });

  it('"did the fix hold?" and words that are not a device still mean the newest repair', () => {
    for (const say of ['Did the fix hold?', 'did my fix hold', 'did that fix hold', "did last night's fix hold", 'is the repair working']) {
      expect(statusId(say, BOTH), say).toBe(POWER_REPAIR);
    }
  });

  it('nothing repaired yet', () => {
    expect(routeUtterance('Did the hallway lamp fix hold?', S0)).toMatchObject({ reply: REPLIES.noRepairYet });
  });

  it('a state without the repair list (the server copy) falls back to the newest repair', () => {
    const { repairs: _drop, ...older } = BOTH;
    expect(statusId('Did the hallway lamp fix hold?', older)).toBe(POWER_REPAIR);
  });

  it('a yes that asks about a named fix is not consent to a waiting plan', () => {
    const r = routeUtterance('yes, did the hallway lamp fix hold?', POWER_PLANNED);
    expect(isToolRoute(r) && r.tool === 'repair_apply').toBe(false);
  });

  it('a diagnose of the device is still a diagnose', () => {
    const r = routeUtterance('Why is the hallway lamp not responding?', BOTH);
    expect(isToolRoute(r) && r.tool).toBe('diagnose');
  });
});

describe('repairForText (a push names its device)', () => {
  it('finds the repair whose subject the push names', () => {
    expect(repairForText('Hallway lamp answered all 9 commands overnight. Repair confirmed.', BOTH)).toBe(LAMP_REPAIR);
  });
  it('null when the push names no subject', () => {
    expect(repairForText('The power on settings held overnight. Repair confirmed.', BOTH)).toBeNull();
    expect(repairForText('Hallway lamp answered.', S0)).toBeNull();
  });
});
