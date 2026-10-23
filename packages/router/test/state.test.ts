// The conversation state machine: what each tool result leaves behind, including failures.

import { describe, expect, it } from 'vitest';
import diagnoseFx from '@fixwright/protocol/fixtures/diagnose.json' with { type: 'json' };
import answerFx from '@fixwright/protocol/fixtures/diagnose_answer.json' with { type: 'json' };
import planFx from '@fixwright/protocol/fixtures/repair_plan.json' with { type: 'json' };
import applyFx from '@fixwright/protocol/fixtures/repair_apply.json' with { type: 'json' };
import explainFx from '@fixwright/protocol/fixtures/explain_event.json' with { type: 'json' };
import checkupFx from '@fixwright/protocol/fixtures/home_checkup.json' with { type: 'json' };
import switchFx from '@fixwright/protocol/fixtures/switch_device.json' with { type: 'json' };
import problemFx from '@fixwright/protocol/fixtures/problem.json' with { type: 'json' };
import { applyResult, initialState, isToolRoute, routeUtterance, type ConversationState } from '../src/index.ts';

const S0 = initialState();

describe('applyResult', () => {
  it('diagnose with a question sets the pending question and the device', () => {
    const s = applyResult(S0, { tool: 'diagnose', structuredContent: diagnoseFx });
    expect(s.pendingQuestion).toEqual({
      diagnosis_id: diagnoseFx.diagnosis_id,
      question_id: diagnoseFx.question!.question_id,
      text: "I'll flash the hallway lamp twice. Did it blink?",
    });
    expect(s.pendingOffer).toBeNull();
    expect(s.lastDevice).toBe('Hallway Lamp');
    expect(s.last.diagnosis_id).toBe(diagnoseFx.diagnosis_id);
    expect(s.turn).toBe(1);
  });

  it('a verdict with a fix clears the question and offers the fix', () => {
    const q = applyResult(S0, { tool: 'diagnose', structuredContent: diagnoseFx });
    const s = applyResult(q, { tool: 'diagnose_answer', structuredContent: answerFx });
    expect(s.pendingQuestion).toBeNull();
    expect(s.pendingOffer).toEqual({ kind: 'diagnosis', id: answerFx.diagnosis_id, label: 'Name points at an old copy' });
  });

  it('a verdict without a fix offers nothing', () => {
    const noFix = { ...answerFx, verdict: { ...answerFx.verdict, fix_available: false } };
    const s = applyResult(S0, { tool: 'diagnose_answer', structuredContent: noFix });
    expect(s.pendingOffer).toBeNull();
  });

  it('a plan replaces the offer with a pending plan that carries the diff lines', () => {
    const v = applyResult(S0, { tool: 'diagnose_answer', structuredContent: answerFx });
    const s = applyResult(v, { tool: 'repair_plan', structuredContent: planFx });
    expect(s.pendingOffer).toBeNull();
    expect(s.pendingPlan).toEqual({
      plan_id: planFx.plan_id,
      confirm_token: planFx.confirm_token,
      expires_at: planFx.expires_at,
      diff_lines: planFx.diff_lines,
    });
    expect(s.last.plan_id).toBe(planFx.plan_id);
  });

  it('applying clears the plan and remembers the repair id', () => {
    const p = applyResult(S0, { tool: 'repair_plan', structuredContent: planFx });
    const s = applyResult(p, { tool: 'repair_apply', structuredContent: applyFx });
    expect(s.pendingPlan).toBeNull();
    expect(s.last.repair_id).toBe(applyFx.repair_id);
  });

  it('a failed apply (expired, used or mismatched) drops the plan so the next yes cannot reuse it', () => {
    const p = applyResult(S0, { tool: 'repair_plan', structuredContent: planFx });
    for (const code of ['plan_expired', 'plan_used', 'token_mismatch']) {
      const problem = { ...problemFx, status: 'refused', problem: { code, retryable: false } };
      const s = applyResult(p, { tool: 'repair_apply', isError: true, structuredContent: problem });
      expect(s.pendingPlan, code).toBeNull();
    }
  });

  it('a retryable apply failure keeps the plan so the person can say yes again', () => {
    const p = applyResult(S0, { tool: 'repair_plan', structuredContent: planFx });
    const s = applyResult(p, { tool: 'repair_apply', isError: true, structuredContent: problemFx });
    expect(s.pendingPlan?.plan_id).toBe(planFx.plan_id);
  });

  it('an answer the server already took clears the question', () => {
    const q = applyResult(S0, { tool: 'diagnose', structuredContent: diagnoseFx });
    const problem = { ...problemFx, status: 'refused', problem: { code: 'question_answered', retryable: false } };
    const s = applyResult(q, { tool: 'diagnose_answer', isError: true, structuredContent: problem });
    expect(s.pendingQuestion).toBeNull();
  });

  it('a hub error during an answer keeps the question for a retry', () => {
    const q = applyResult(S0, { tool: 'diagnose', structuredContent: diagnoseFx });
    const s = applyResult(q, { tool: 'diagnose_answer', isError: true, structuredContent: problemFx });
    expect(s.pendingQuestion?.question_id).toBe(diagnoseFx.question!.question_id);
  });

  it('explain_event offers its suggested fix by issue id', () => {
    const s = applyResult(S0, { tool: 'explain_event', structuredContent: explainFx });
    expect(s.pendingOffer).toEqual({ kind: 'issue', id: explainFx.suggested_fix!.issue_id, label: explainFx.suggested_fix!.label });
    expect(s.last.explanation_id).toBe(explainFx.explanation_id);
  });

  it('a checkup keeps its findings and drops anything pending', () => {
    const q = applyResult(S0, { tool: 'diagnose', structuredContent: diagnoseFx });
    const s = applyResult(q, { tool: 'home_checkup', structuredContent: checkupFx });
    expect(s.pendingQuestion).toBeNull();
    expect(s.findings.map((f) => f.fixable)).toEqual([true, false, false]);
    expect(s.last.checkup_id).toBe(checkupFx.checkup_id);
  });

  it('switch_device remembers the device that actually switched', () => {
    const s = applyResult(S0, { tool: 'switch_device', arguments: { device: 'living room power strip', on: false }, structuredContent: switchFx });
    expect(s.lastDevice).toBe('Floor Lamp');
  });

  it('ignores junk structuredContent without throwing', () => {
    for (const junk of [null, 42, 'text', [], { status: 'ok', ids: 'nope' }]) {
      expect(() => applyResult(S0, { tool: 'diagnose', structuredContent: junk })).not.toThrow();
    }
  });

  it('round trips through JSON unchanged', () => {
    const s = applyResult(applyResult(S0, { tool: 'diagnose', structuredContent: diagnoseFx }), { tool: 'home_checkup', structuredContent: checkupFx });
    expect(JSON.parse(JSON.stringify(s)) as ConversationState).toEqual(s);
  });
});

describe('golden path as one conversation', () => {
  it('routes every turn and chains the ids', () => {
    const results: Record<string, unknown> = {
      diagnose: diagnoseFx,
      diagnose_answer: answerFx,
      repair_plan: planFx,
      repair_apply: applyFx,
      explain_event: explainFx,
      home_checkup: checkupFx,
      switch_device: switchFx,
    };
    const turns: Array<[string, string]> = [
      ["Alexa, ask Fixwright why the hallway lamp keeps saying it's not responding.", 'diagnose'],
      ['Yes, it blinked.', 'diagnose_answer'],
      ['Yes.', 'repair_plan'],
      ['Yes.', 'repair_apply'],
      ['Why did every plug turn on at 3 a.m.?', 'explain_event'],
      ['Yes.', 'repair_plan'],
      ['Give my house a checkup.', 'home_checkup'],
      ['Turn off the living room power strip.', 'switch_device'],
    ];
    let state = initialState();
    const called: string[] = [];
    for (const [say, want] of turns) {
      const route = routeUtterance(say, state);
      expect(isToolRoute(route), say).toBe(true);
      if (!isToolRoute(route)) return;
      called.push(route.tool);
      expect(route.tool, say).toBe(want);
      state = applyResult(state, { tool: route.tool, arguments: route.arguments, structuredContent: results[route.tool] });
    }
    expect(called).toEqual(turns.map(([, t]) => t));
    expect(state.last.repair_id).toBe(applyFx.repair_id);
  });
});
