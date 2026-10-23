import type { RepairApplyOutput } from '@fixwright/protocol';
import { describe, expect, test } from 'vitest';
import { asDeclined, beginAction, cancelPlan, dueRefresh, finishAction, fromHost, isResend, screenKey, startFlow, type PanelPayload } from '../../src/ui/flow.ts';
import { DECLINED_NOTE, UNREADABLE_PROBLEM, classifyPayload, isDeclineMessage, type ToolOutcome } from '../../src/ui/payload.ts';
import { fixture } from './load.ts';

const ACCEPTS = ['diagnosis', 'explanation', 'plan', 'repair'] as const;
const ok = (name: string): ToolOutcome => ({ ok: true, payload: classifyPayload(fixture(name)) as PanelPayload });
const start = (name: string) => startFlow(classifyPayload(fixture(name)) as PanelPayload);

describe('flow', () => {
  test('golden path', () => {
    let f = start('protocol/diagnose');
    expect(f.subject).toBe('Hallway Lamp');

    f = beginAction(f, 'answer-yes');
    expect(f.pending).toBe('answer-yes');
    f = finishAction(f, 'answer-yes', ok('protocol/diagnose_answer'), ACCEPTS);
    expect(f.screen.kind).toBe('diagnosis');
    expect(f.pending).toBeNull();
    expect(f.barsFrom).toEqual({ stale_duplicate: 55, device_power_lost: 38, something_else: 7 });

    const verdict = f.screen;
    f = finishAction(beginAction(f, 'plan'), 'plan', ok('protocol/repair_plan'), ACCEPTS);
    expect(f.screen.kind).toBe('plan');
    expect(f.back).toBe(verdict);
    expect(f.subject).toBe('Hallway Lamp');

    const back = cancelPlan(f);
    expect(back.screen).toBe(verdict);
    expect(back.back).toBeNull();

    f = finishAction(beginAction(f, 'apply'), 'apply', ok('protocol/repair_apply'), ACCEPTS);
    expect(f.screen.kind).toBe('repair');
    expect(f.back).toBeNull();
    expect(f.subject).toBe('Hallway Lamp');

    f = finishAction(beginAction(f, 'undo'), 'undo', ok('protocol/undo'), ACCEPTS);
    expect(f.screen.kind === 'repair' && f.screen.data.state).toBe('undone');
  });

  test('a failed action keeps the screen, shows the problem and frees the buttons', () => {
    const f0 = start('protocol/diagnose');
    const f = finishAction(beginAction(f0, 'answer-yes'), 'answer-yes', { ok: false, problem: { speech: 'Try again in a minute.', retryable: true } }, ACCEPTS);
    expect(f.screen).toBe(f0.screen);
    expect(f).toMatchObject({ pending: null, error: 'Try again in a minute.' });
    expect(beginAction(f, 'answer-yes').error).toBeNull();
  });

  test('a payload this view does not render is reported, not shown', () => {
    const f0 = start('protocol/repair_apply');
    const f = finishAction(beginAction(f0, 'undo'), 'undo', ok('protocol/diagnose'), ['repair']);
    expect(f).toMatchObject({ screen: f0.screen, error: UNREADABLE_PROBLEM });
  });

  test('cancel without a way back changes nothing', () => {
    const f = start('protocol/repair_plan');
    expect(cancelPlan(f)).toBe(f);
  });

  test('a declined approval is a calm note, not an error, and the screen stays', () => {
    const plan = start('protocol/repair_plan');
    const declined = asDeclined({ ok: false, problem: { speech: "That didn't go through.", retryable: true } });
    expect(declined).toEqual({ ok: false, problem: { speech: DECLINED_NOTE, retryable: true, declined: true } });
    const f = finishAction(beginAction(plan, 'apply'), 'apply', declined, ACCEPTS);
    expect(f).toMatchObject({ screen: plan.screen, pending: null, error: null, notice: DECLINED_NOTE });
    expect(beginAction(f, 'apply').notice).toBeNull();
    expect(asDeclined(ok('protocol/repair_apply')).ok).toBe(true);
    expect(isDeclineMessage(`MCP error -32603: ${DECLINED_NOTE}`)).toBe(true);
    expect(isDeclineMessage('The person declined this action')).toBe(false);
  });

  test('the host resending the showing screen is recognised exactly; a newer version is not a resend', () => {
    let f = start('protocol/diagnose');
    f = finishAction(beginAction(f, 'answer-yes'), 'answer-yes', ok('protocol/diagnose_answer'), ACCEPTS);
    f = finishAction(beginAction(f, 'plan'), 'plan', ok('protocol/repair_plan'), ACCEPTS);
    const plan = fixture<Record<string, unknown>>('protocol/repair_plan');
    expect(isResend(f, classifyPayload(plan) as PanelPayload)).toBe(true);
    expect(isResend(f, classifyPayload({ ...plan, expires_at: '2026-10-15T17:40:00.000Z' }) as PanelPayload)).toBe(false);
    expect(isResend(null, classifyPayload(plan) as PanelPayload)).toBe(false);
  });

  test('fromHost: a newer version of the same plan keeps Not now and the device name; another screen starts over', () => {
    let f = start('protocol/diagnose');
    f = finishAction(beginAction(f, 'answer-yes'), 'answer-yes', ok('protocol/diagnose_answer'), ACCEPTS);
    const verdict = f.screen;
    f = finishAction(beginAction(f, 'plan'), 'plan', ok('protocol/repair_plan'), ACCEPTS);
    const plan = fixture<Record<string, unknown>>('protocol/repair_plan');
    const newer = classifyPayload({ ...plan, expires_at: '2026-10-15T17:40:00.000Z' }) as PanelPayload;
    const g = fromHost(beginAction(f, 'apply'), newer);
    expect(g).toMatchObject({ back: verdict, subject: 'Hallway Lamp', pending: null, error: null, notice: null });
    expect(screenKey(g.screen)).toBe(screenKey(f.screen));
    const other = fromHost(f, classifyPayload(fixture('views/repair_plan_rename')) as PanelPayload);
    expect(other).toMatchObject({ back: null, pending: null });
    expect(other.subject).toBeUndefined();
    expect(fromHost(null, newer).back).toBeNull();
  });

  test('fromHost: a newer result for the same diagnosis moves the bars from the old values', () => {
    const f = start('protocol/diagnose');
    const dx = fixture<Record<string, unknown>>('protocol/diagnose_answer');
    const g = fromHost(f, classifyPayload({ ...dx, diagnosis_id: (f.screen.data as { diagnosis_id: string }).diagnosis_id }) as PanelPayload);
    expect(g.barsFrom).toEqual({ stale_duplicate: 55, device_power_lost: 38, something_else: 7 });
  });

  test('dueRefresh asks for the next check result only once it is due', () => {
    const f = start('protocol/repair_apply');
    const r = fixture<RepairApplyOutput>('protocol/repair_apply');
    const due = Date.parse(r.next_check_at as string);
    expect(dueRefresh(f, due - 1)).toBeNull();
    expect(dueRefresh(f, due)).toEqual({ name: 'refresh_view', arguments: { ref_id: r.repair_id } });
    expect(dueRefresh(start('protocol/repair_status'), due + 1)).toBeNull();
    expect(dueRefresh(start('protocol/diagnose'), due + 1)).toBeNull();
    expect(dueRefresh(null, due)).toBeNull();
  });
});
