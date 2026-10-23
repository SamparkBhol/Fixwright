import type { DiagnoseOutput, ExplainEventOutput, RepairApplyOutput, RepairPlanOutput, RepairStatusOutput, UndoOutput } from '@fixwright/protocol';
import { describe, expect, test } from 'vitest';
import { apportion, barShares, diagnosisPanel, explanationPanel, planPanel, repairChip, repairPanel } from '../../src/ui/screens.ts';
import type { BlockVM } from '../../src/ui/vm.ts';
import { T, fixture } from './load.ts';

const NBSP = ' ';
const block = <K extends BlockVM['type']>(blocks: BlockVM[], type: K) => blocks.find((b) => b.type === type) as Extract<BlockVM, { type: K }>;

describe('diagnosis', () => {
  const asking = fixture<DiagnoseOutput>('protocol/diagnose');
  const confirmed = fixture<DiagnoseOutput>('protocol/diagnose_answer');

  test('asking: the question with Yes and No that answer through diagnose_answer', () => {
    const vm = diagnosisPanel(asking);
    expect(vm).toMatchObject({ screen: 'diagnosis', eyebrow: 'Diagnosis', title: 'Hallway Lamp', simulated: true, chip: { label: 'Needs you', tone: 'info' } });
    expect(vm.decision.text).toBe("I'll flash the hallway lamp twice. Did it blink?");
    expect(vm.decision.emphasis).toBe('hero');
    expect(vm.decision.actions.map((a) => [a.label, a.style, a.tool])).toEqual([
      ['Yes', 'primary', { name: 'diagnose_answer', arguments: { diagnosis_id: asking.diagnosis_id, question_id: asking.question?.question_id, answer: 'yes' } }],
      ['No', 'secondary', { name: 'diagnose_answer', arguments: { diagnosis_id: asking.diagnosis_id, question_id: asking.question?.question_id, answer: 'no' } }],
    ]);
  });

  test('asking: probes become chips and hypotheses become bars, leader first', () => {
    const vm = diagnosisPanel(asking);
    expect(vm.strip?.items.map((p) => [p.label, p.outcome])).toEqual([
      ['Hub', 'pass'],
      ['Signal', 'pass'],
      ['Hue cloud', 'pass'],
      ['Availability', 'fail'],
      ['Names', 'fail'],
      ['Flash test', 'pass'],
    ]);
    const bars = block(vm.main, 'bars');
    expect(bars.items.map((b) => [b.label, b.pct, b.lead, b.tone])).toEqual([
      ['Name points at an old copy', 55, true, 'info'],
      ['Device has no power', 38, false, 'neutral'],
      // Three bars at most: the third cause (4%) and the 3% the list leaves out are "Something else", so
      // the bars add up to 100.
      ['Something else', 7, false, 'neutral'],
    ]);
  });

  test('confirmed: 94%, the verdict chip, the claims and a dry run first', () => {
    const vm = diagnosisPanel(confirmed);
    expect(vm.chip).toEqual({ label: 'Confirmed', tone: 'pass', icon: 'check' });
    expect(block(vm.main, 'bars').items[0]).toMatchObject({ pct: 94, tone: 'pass', lead: true });
    expect(vm.decision.text).toBe('The lamp works. The name Hallway Lamp still points at an old copy of it that went offline on October 3.');
    expect(vm.decision.actions).toEqual([
      { id: 'plan', label: 'Show the fix', pendingLabel: 'Planning', style: 'primary', tool: { name: 'repair_plan', arguments: { diagnosis_id: confirmed.diagnosis_id } } },
    ]);
    expect(vm.strip?.items.find((p) => p.label === 'You saw it blink')?.human).toBe(true);
    expect(block(vm.details, 'claims').items.map((c) => c.evidence)).toEqual([2, 3]);
  });

  test("likely and can't tell", () => {
    const likely = diagnosisPanel(fixture<DiagnoseOutput>('views/diagnose_likely'));
    expect(likely.chip.label).toBe('Likely');
    expect(likely.decision.lead).toBeUndefined();
    const unsure = diagnosisPanel(fixture<DiagnoseOutput>('views/diagnose_cant_tell'));
    expect(unsure).toMatchObject({ eyebrow: 'Guided check', chip: { label: "Can't tell", tone: 'neutral' } });
    expect(unsure.decision).toMatchObject({ actions: [] });
    expect(unsure.decision.lead).toBeUndefined();
  });

  test("can't tell is not a dead end when the host takes words: Check again asks the conversation", () => {
    const unsure = diagnosisPanel(fixture<DiagnoseOutput>('views/diagnose_cant_tell'), { canAsk: true });
    expect(unsure.decision.actions).toEqual([{ id: 'check-again', label: 'Check again', pendingLabel: 'Checking', style: 'primary', ask: 'Check the Porch Plug again.' }]);
    const likely = diagnosisPanel(fixture<DiagnoseOutput>('views/diagnose_likely'), { canAsk: true });
    expect(likely.decision.actions.map((a) => a.id)).not.toContain('check-again');
  });

  test('a share that rounds to 0% is left out of the bars, the rest still adds up to 100', () => {
    const d: DiagnoseOutput = {
      ...asking,
      hypotheses: [
        { cause_id: 'stale_duplicate', label: 'Name points at an old copy', p: 0.62 },
        { cause_id: 'device_power_lost', label: 'Device has no power', p: 0.375 },
        { cause_id: 'name_collision', label: 'Two devices share a name', p: 0.002 },
        { cause_id: 'unknown', label: "Can't tell yet", p: 0.003 },
      ],
    };
    expect(block(diagnosisPanel(d).main, 'bars').items.map((b) => [b.label, b.pct])).toEqual([
      ['Name points at an old copy', 62],
      ['Device has no power', 38],
    ]);
    const flat: DiagnoseOutput = { ...d, hypotheses: [{ cause_id: 'unknown', label: "Can't tell yet", p: 0.001 }] };
    expect(block(diagnosisPanel(flat).main, 'bars').items.map((b) => [b.label, b.pct, b.lead])).toEqual([['Something else', 100, true]]);
  });

  test('the step 3 verdict: 94%, 5% and 1% add up to 100, and the residual is "Something else"', () => {
    const d: DiagnoseOutput = {
      ...confirmed,
      hypotheses: [
        { cause_id: 'stale_duplicate', label: 'Name points at an old copy', p: 0.945 },
        { cause_id: 'device_power_lost', label: 'Device has no power', p: 0.048 },
        { cause_id: 'unknown', label: "Can't tell yet", p: 0.007 },
      ],
    };
    const items = block(diagnosisPanel(d).main, 'bars').items;
    expect(items.map((b) => [b.key, b.label, b.pct])).toEqual([
      ['stale_duplicate', 'Name points at an old copy', 94],
      ['device_power_lost', 'Device has no power', 5],
      ['something_else', 'Something else', 1],
    ]);
    expect(items.reduce((sum, b) => sum + b.pct, 0)).toBe(100);
  });

  test('apportion: always 100 in whole percents, largest remainders first, ties to the earlier share', () => {
    const lists = [
      [0.333, 0.333, 0.333],
      [0.5, 0.25, 0.125, 0.125],
      [0.945, 0.048, 0.007],
      [0.62, 0.37],
      [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
      [0.999],
      [0.6, 0.6], // more than 1: scaled down, no residual
    ];
    for (const ps of lists) {
      const out = apportion(ps.map((p, i) => ({ cause_id: `c${i}`, p })));
      expect(out.reduce((sum, b) => sum + b.pct, 0), JSON.stringify(ps)).toBe(100);
      expect(out.every((b) => Number.isInteger(b.pct) && b.pct >= 0)).toBe(true);
    }
    expect(apportion([{ cause_id: 'a', p: 0.333 }, { cause_id: 'b', p: 0.333 }, { cause_id: 'c', p: 0.333 }]).map((b) => b.pct)).toEqual([34, 33, 33, 0]);
    expect(apportion([{ cause_id: 'a', p: 0.6 }, { cause_id: 'b', p: 0.6 }]).map((b) => b.pct)).toEqual([50, 50, 0]);
    expect(apportion([{ cause_id: 'a', p: Number.NaN }, { cause_id: 'unknown', p: 0.4 }]).map((b) => [b.key, b.pct])).toEqual([
      ['a', 0],
      ['something_else', 100],
    ]);
    expect(apportion([])).toEqual([]);
  });

  test('barShares: at most three bars, smaller causes fold into "Something else"', () => {
    const hyps = [
      { cause_id: 'a', p: 0.5 },
      { cause_id: 'b', p: 0.3 },
      { cause_id: 'c', p: 0.12 },
      { cause_id: 'unknown', p: 0.05 },
    ];
    expect(barShares(hyps)).toEqual([
      { key: 'a', pct: 50 },
      { key: 'b', pct: 30 },
      { key: 'something_else', pct: 20 },
    ]);
    expect(barShares([{ cause_id: 'a', p: 0.945 }, { cause_id: 'b', p: 0.048 }, { cause_id: 'unknown', p: 0.007 }]).map((b) => b.pct)).toEqual([94, 5, 1]);
  });

  test('a multiple choice question offers its choices', () => {
    const d = { ...asking, question: { question_id: 'q_x', text: 'Which one?', expects: 'choice' as const, choices: ['The lamp', 'The fan'] } };
    expect(diagnosisPanel(d).decision.actions.map((a) => [a.label, a.tool?.arguments.answer])).toEqual([
      ['The lamp', 'The lamp'],
      ['The fan', 'The fan'],
    ]);
  });
});

describe('explanation', () => {
  const e = fixture<ExplainEventOutput>('protocol/explain_event');
  test('timeline in household time and a fix offer that plans by explanation id', () => {
    const vm = explanationPanel(e, T);
    expect(vm).toMatchObject({ eyebrow: 'What happened', title: 'Power came back on', chip: { label: 'Confirmed' } });
    expect(block(vm.main, 'timeline').items.map((i) => i.time)).toEqual([`3:11:58${NBSP}AM`, `3:12:00${NBSP}AM`, `3:12:00${NBSP}AM`, `3:12:04${NBSP}AM`]);
    expect(vm.decision.actions[0]?.tool).toEqual({ name: 'repair_plan', arguments: { explanation_id: e.explanation_id } });
    expect(block(vm.details, 'claims').items.map((c) => c.evidence)).toEqual([1, 14, 14]);
  });

  test('without a suggested fix the claims carry the card', () => {
    const { suggested_fix: _drop, ...rest } = e;
    const vm = explanationPanel(rest, T);
    expect(vm.decision.actions).toEqual([]);
    expect(vm.decision.text).toBe('Power came back at 3:12. Fourteen devices restarted within four seconds. None of your automations fired.');
  });
});

describe('plan', () => {
  const p = fixture<RepairPlanOutput>('protocol/repair_plan');
  test('the dry run, pending steps, and Fix it with the confirm token', () => {
    const vm = planPanel(p, T, { subject: 'Hallway Lamp', canCancel: true });
    expect(vm).toMatchObject({ title: 'Hallway Lamp', chip: { label: 'Nothing changed yet' } });
    expect(block(vm.main, 'diff').lines).toEqual(p.diff_lines);
    expect(block(vm.main, 'steps').items.every((s) => s.status === 'pending')).toBe(true);
    expect(vm.decision.actions.map((a) => [a.label, a.tool ?? a.local])).toEqual([
      ['Fix it', { name: 'repair_apply', arguments: { plan_id: p.plan_id, confirm_token: p.confirm_token } }],
      ['Not now', 'cancel'],
    ]);
    expect(vm.decision.note).toBe(`Good until${NBSP}10:25${NBSP}AM.`);
    expect(block(vm.details, 'changes').rows[0]).toMatchObject({ entity: 'light.hallway_lamp_2', from: 'Hallway Lamp 2', to: 'Hallway Lamp' });
  });

  test('no way back when the plan came on its own; protected devices are listed', () => {
    const vm = planPanel(fixture<RepairPlanOutput>('views/repair_plan_protected'), T, { canCancel: false });
    expect(vm.title).toBe('Ready to fix');
    expect(vm.decision.actions.map((a) => a.label)).toEqual(['Fix it']);
    expect(block(vm.main, 'diff').conflicts).toEqual(['Aquarium Filter is protected, so I will leave it as it is.']);
  });

  test('the power on fix keeps all 14 steps in the model (the view folds them, never the data)', () => {
    const p14 = fixture<RepairPlanOutput>('views/repair_plan_power_on');
    const steps = block(planPanel(p14, T, { canCancel: true }).main, 'steps').items;
    expect(steps).toHaveLength(14);
    expect(steps[13]).toMatchObject({ n: 14, label: 'Set Stairs Light to remember its last state', status: 'pending' });
  });
});

describe('repair', () => {
  test('applied: read back per step, next check, Undo', () => {
    const r = fixture<RepairApplyOutput>('protocol/repair_apply');
    const vm = repairPanel(r, T);
    expect(vm).toMatchObject({ title: 'Fixed and checked', chip: { label: '3 of 3 read back', tone: 'pass' } });
    expect(block(vm.main, 'steps').items.map((s) => s.readBack)).toEqual(['Name reads Hallway Lamp', 'Old copy is gone from the device list', 'It answered both times']);
    expect(vm.decision).toMatchObject({ lead: 'Next check', text: `Tomorrow at 7:00${NBSP}AM`, emphasis: 'hero' });
    expect(vm.decision.actions).toEqual([{ id: 'undo', label: 'Undo', pendingLabel: 'Undoing', style: 'secondary', tool: { name: 'undo', arguments: { repair_id: r.repair_id } } }]);
  });

  test('inside a flow the title names the device and the chip states the outcome', () => {
    const vm = repairPanel(fixture<RepairApplyOutput>('protocol/repair_apply'), T, { subject: 'Hallway Lamp' });
    expect(vm.title).toBe('Hallway Lamp');
    expect(vm.chip.label).toBe('Fixed');
  });

  test('confirmed and regressed show how the next check went', () => {
    const now = { ...T, nowMs: Date.parse('2026-10-16T14:05:00.000Z') };
    const ok = repairPanel(fixture<RepairStatusOutput>('protocol/repair_status'), now);
    expect(ok.decision).toMatchObject({ lead: 'The fix held', text: 'Hallway lamp answered all 9 commands overnight.', note: `Today at 7:00${NBSP}AM.` });
    expect(ok.chip.label).toBe('Check passed');
    const bad = repairPanel(fixture<RepairStatusOutput>('views/repair_regressed'), now);
    expect(bad).toMatchObject({ title: "It's acting up again", chip: { label: 'Check failed', tone: 'fail' } });
    expect(bad.decision.lead).toBe("The fix didn't hold");
    expect(bad.decision.actions.map((a) => a.id)).toEqual(['undo']);
  });

  test('a failed morning check offers a next step first: Diagnose', () => {
    const now = { ...T, nowMs: Date.parse('2026-10-16T14:05:00.000Z') };
    const regressed = fixture<RepairStatusOutput>('views/repair_regressed');
    const named = repairPanel(regressed, now, { subject: 'Hallway Lamp', canAsk: true });
    expect(named.decision.actions.map((a) => [a.id, a.label, a.style, a.ask ?? null])).toEqual([
      ['look-again', 'Diagnose', 'primary', 'Look at the Hallway Lamp again.'],
      ['undo', 'Undo', 'secondary', null],
    ]);
    expect(repairPanel(regressed, now, { canAsk: true }).decision.actions[0]?.ask).toBe('Why is it acting up again?');
  });

  test('rolled back, undone: no Undo offered', () => {
    const rb = repairPanel(fixture<RepairApplyOutput>('views/repair_rolled_back'), T);
    expect(rb.decision.actions).toEqual([]);
    expect(block(rb.main, 'steps').items.map((s) => s.status)).toEqual(['rolled_back', 'failed', 'skipped']);
    const undone = repairPanel(fixture<UndoOutput>('protocol/undo'), T);
    expect(undone).toMatchObject({ title: 'Back as it was', chip: { label: '2 of 2 reversed' } });
    expect(undone.decision.actions).toEqual([]);
  });

  test('a retried repair with a skipped step does not claim every step read back, and still shows its evidence', () => {
    const g = fixture<RepairApplyOutput>('views/repair_apply_retried');
    // On its own card the title already says Fixed.
    expect(repairChip(g, false)).toEqual({ label: '2 read back, 1 skipped', tone: 'pass', icon: 'check' });
    expect(repairChip(g, true).label).toBe('Fixed');
    const failedStep = { ...g, steps: g.steps.map((s, i) => (i === 1 ? { ...s, status: 'failed' as const } : s)) };
    expect(repairChip(failedStep, false).label).toBe('Fixed');
    expect(block(repairPanel(g, T).main, 'steps').items.map((s) => [s.status, s.readBack])).toEqual([
      ['skipped', 'Already applied'],
      ['done', 'Old copy is gone from the device list'],
      ['done', 'It answered both times'],
    ]);
  });
});

describe('which house a result came from', () => {
  const applied = fixture<RepairApplyOutput>('protocol/repair_apply');

  test('the simulated home is tagged as simulated and names no hub', () => {
    const vm = repairPanel(applied, T);
    expect(vm.simulated).toBe(true);
    expect(vm.hub).toBeUndefined();
  });

  test('a repair that ran on a real Home Assistant says so, and is not called simulated', () => {
    const live = { ...applied, source: { adapter: 'home-assistant' as const, simulated: false } };
    const vm = repairPanel(live, T);
    expect(vm.simulated).toBe(false);
    expect(vm.hub).toBe('Real Home Assistant');
    expect(diagnosisPanel({ ...fixture<DiagnoseOutput>('protocol/diagnose'), source: live.source }).hub).toBe('Real Home Assistant');
  });

  test("the host's own words for its hub win: its test hub runs demo devices", () => {
    const live = { ...applied, source: { adapter: 'home-assistant' as const, simulated: false } };
    const hints = { focus: null, labels: {}, hubLabel: 'Real Home Assistant, demo devices' };
    expect(repairPanel(live, T, { hints }).hub).toBe('Real Home Assistant, demo devices');
    expect(diagnosisPanel({ ...fixture<DiagnoseOutput>('protocol/diagnose'), source: live.source }, { hubLabel: hints.hubLabel }).hub).toBe('Real Home Assistant, demo devices');
    expect(repairPanel(applied, T, { hints }).hub).toBeUndefined();
  });
});
