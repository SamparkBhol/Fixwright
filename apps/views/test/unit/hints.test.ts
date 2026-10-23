import type { RepairApplyOutput, RepairPlanOutput } from '@fixwright/protocol';
import { describe, expect, test } from 'vitest';
import { FOCUS_KEY, HUB_LABEL_KEY, NO_HINTS, readHints, STEP_LABELS_KEY } from '../../src/ui/context.ts';
import { focusRanker, planPanel, repairPanel, stepsBlock } from '../../src/ui/screens.ts';
import type { BlockVM } from '../../src/ui/vm.ts';
import { T, fixture } from './load.ts';

const block = <K extends BlockVM['type']>(blocks: BlockVM[], type: K) => blocks.find((b) => b.type === type) as Extract<BlockVM, { type: K }>;
const power = fixture<RepairApplyOutput>('views/repair_apply_power_on');
const PLUGS = ['Office Heater Plug', 'TV Plug', 'Bedroom Fan Plug', 'Desk Plug', 'Patio Heater Plug'];
const nameOf = (label: string) => label.replace(/^Set /, '').replace(/ to remember its last state$/, '');

describe('readHints', () => {
  test('reads both keys and ignores anything malformed', () => {
    expect(readHints(undefined)).toEqual(NO_HINTS);
    expect(readHints({ [FOCUS_KEY]: '  Why did every plug turn on at 3 a.m.?  ' }).focus).toBe('Why did every plug turn on at 3 a.m.?');
    expect(readHints({ [FOCUS_KEY]: 42, [STEP_LABELS_KEY]: ['x'] })).toEqual(NO_HINTS);
    expect(readHints({ [STEP_LABELS_KEY]: { 'pln_1|A': ['A (the bulb)', 7, ''], 'pln_1|B': 'no', 'pln_1|C': [] } }).labels).toEqual({ 'pln_1|A': ['A (the bulb)'] });
    expect(readHints({ [FOCUS_KEY]: 'x'.repeat(500) }).focus).toHaveLength(300);
    expect(readHints({ [HUB_LABEL_KEY]: '  Real Home Assistant, demo devices ' }).hubLabel).toBe('Real Home Assistant, demo devices');
    expect(readHints({ [HUB_LABEL_KEY]: 7 })).toEqual(NO_HINTS);
    expect(readHints({ [HUB_LABEL_KEY]: 'y'.repeat(100) }).hubLabel).toHaveLength(48);
  });
});

describe('focusRanker', () => {
  test('a named device first, then devices of the kind named, then the rest', () => {
    const rank = focusRanker('Did the hallway lamp fix hold?');
    expect(rank?.('Set Hallway Lamp to remember its last state')).toBe(0);
    expect(rank?.('Set Desk Lamp to remember its last state')).toBe(1);
    expect(rank?.('Set Kettle Plug to remember its last state')).toBe(2);
    expect(focusRanker('Why did every plug turn on at 3 a.m.?')?.('Set TV Plug to remember its last state')).toBe(1);
    expect(focusRanker('Why did all the switches flip?')?.('Turn the Porch Switch off')).toBe(1);
  });
  test('words that name no kind of device leave the order alone', () => {
    expect(focusRanker('Give my house a checkup.')).toBeNull();
    expect(focusRanker(null)).toBeNull();
  });
});

describe('steps on a finished repair', () => {
  test('"every plug": the plugs come first, each group in step order', () => {
    const vm = repairPanel(power, T, { hints: { focus: 'Why did every plug turn on at 3 a.m.?', labels: {} } });
    const names = block(vm.main, 'steps').items.map((s) => nameOf(s.label));
    expect(names.slice(0, PLUGS.length)).toEqual(PLUGS);
    expect(names).toHaveLength(14);
    const rest = block(vm.main, 'steps').items.slice(PLUGS.length).map((s) => s.n);
    expect(rest).toEqual([...rest].sort((a, b) => a - b));
  });

  test('no hints: step order, as before', () => {
    const items = block(repairPanel(power, T).main, 'steps').items;
    expect(items.map((s) => s.n)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });

  test('a plan keeps step order (its numbers are the order the fix runs in)', () => {
    const plan = fixture<RepairPlanOutput>('views/repair_plan_power_on');
    const vm = planPanel(plan, T, { canCancel: false, hints: { focus: 'Why did every plug turn on at 3 a.m.?', labels: {} } });
    expect(block(vm.main, 'steps').items.map((s) => s.n)).toEqual(Array.from({ length: plan.steps.length }, (_, i) => i + 1));
  });

  test('a repair that stopped partway keeps step order', () => {
    const steps = power.steps.map((s, i) => (i > 5 ? { ...s, status: 'failed' as const } : s));
    const items = stepsBlock(steps, 'Each step', { planId: power.plan_id, hints: { focus: 'every plug', labels: {} } }).items;
    expect(items.map((s) => s.n)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });
});

describe('clearer labels for a shared name', () => {
  const steps = [
    { step: 1, label: 'Set Living Room Light to remember its last state', status: 'done' as const, read_back: 'Set to previous' },
    { step: 2, label: 'Set Desk Lamp to remember its last state', status: 'done' as const, read_back: 'Set to previous' },
    { step: 3, label: 'Set Living Room Light to remember its last state', status: 'done' as const, read_back: 'Set to previous' },
  ];
  const key = 'pln_x|Set Living Room Light to remember its last state';
  const hints = { focus: null, labels: { [key]: ['Set Living Room Light (the Floor Lamp) to remember its last state', 'Set Living Room Light (the Hue group) to remember its last state'] } };

  test('each step with the shared label gets its own clearer label, in step order', () => {
    expect(stepsBlock(steps, 'Steps', { planId: 'pln_x', hints }).items.map((s) => s.label)).toEqual([
      'Set Living Room Light (the Floor Lamp) to remember its last state',
      'Set Desk Lamp to remember its last state',
      'Set Living Room Light (the Hue group) to remember its last state',
    ]);
  });

  test('labels for another plan are not used', () => {
    expect(stepsBlock(steps, 'Steps', { planId: 'pln_y', hints }).items.map((s) => s.label)).toEqual(steps.map((s) => s.label));
  });
});
