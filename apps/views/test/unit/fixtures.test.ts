// Regenerate with node scripts/write-fixtures.ts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ToolOutputs, speechProblems } from '@fixwright/protocol';
import { describe, expect, test } from 'vitest';
import { FIXTURE_TOOL, viewFixtures, type ViewFixtures } from '../../scripts/view-fixtures.ts';
import { VIEW_FIXTURES, fixture, fixtureNames } from './load.ts';

const built = viewFixtures();
const names = Object.keys(FIXTURE_TOOL) as (keyof ViewFixtures)[];

describe('view fixtures', () => {
  test('one file per builder entry, nothing else', () => {
    expect(fixtureNames('views')).toEqual(names.map((n) => `views/${n}`).sort());
  });

  test.each(names)('%s matches its protocol schema and the builder', (name) => {
    const onDisk = JSON.parse(readFileSync(path.join(VIEW_FIXTURES, `${name}.json`), 'utf8')) as unknown;
    expect(ToolOutputs[FIXTURE_TOOL[name]].safeParse(onDisk).success).toBe(true);
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(built[name])));
    const speech = (onDisk as { speech: string }).speech;
    expect(speechProblems(speech)).toEqual([]);
    expect((onDisk as { source: { simulated: boolean } }).source.simulated).toBe(true);
  });

  test('plans and applies chain by plan id, as the harness router expects', () => {
    for (const kind of ['rename', 'power_on'] as const) {
      const plan = fixture<{ plan_id: string; ids: Record<string, string> }>(`views/repair_plan_${kind}`);
      const apply = fixture<{ plan_id: string; ids: Record<string, string> }>(`views/repair_apply_${kind}`);
      expect(apply.plan_id).toBe(plan.plan_id);
      expect(apply.ids.plan_id).toBe(plan.plan_id);
    }
  });

  test('every fixable finding has a plan, and no finding that is not fixable has one (the engine says no_fix)', () => {
    const checkup = fixture<{ findings: { issue_id: string; action_label?: string; fixable: boolean }[] }>('protocol/home_checkup');
    const plans = ['rename', 'power_on'].map((k) => fixture<{ ids: { issue_id?: string; explanation_id?: string } }>(`views/repair_plan_${k}`).ids);
    const planned = plans.map((p) => p.issue_id);
    for (const f of checkup.findings) {
      if (f.fixable) expect(planned).toContain(f.issue_id);
      else expect(planned).not.toContain(f.issue_id);
    }
    expect(plans.map((p) => p.explanation_id)).toContain(fixture<{ explanation_id: string }>('protocol/explain_event').explanation_id);
  });

  test('the retried apply has the engine executor shape: the step that already ran is skipped, Already applied', () => {
    const r = fixture<{ steps: { step: number; status: string; read_back?: string }[] }>('views/repair_apply_retried');
    expect(r.steps.map((s) => [s.status, s.read_back])).toEqual([
      ['skipped', 'Already applied'],
      ['done', 'Old copy is gone from the device list'],
      ['done', 'It answered both times'],
    ]);
  });

  test('the power on fix has the engine shape: 14 devices, one step, diff row and read back each', () => {
    const plan = fixture<{ steps: { label: string }[]; diff: unknown[]; diff_lines: string[] }>('views/repair_plan_power_on');
    const apply = fixture<{ steps: { status: string; read_back?: string }[]; next_check_at?: string }>('views/repair_apply_power_on');
    expect(plan.steps).toHaveLength(14);
    expect(plan.diff).toHaveLength(14);
    expect(plan.diff_lines).toEqual(['Fourteen devices will remember whether they were on or off when power comes back.']);
    expect(apply.steps.every((s) => s.status === 'done' && s.read_back === 'Set to previous')).toBe(true);
    expect(apply.next_check_at).toBe('2026-10-16T14:00:00.000Z');
  });
});
