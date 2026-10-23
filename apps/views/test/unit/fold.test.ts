import type { RepairStepStatus } from '@fixwright/protocol';
import { describe, expect, test } from 'vitest';
import { FOLD_KEEP, FOLD_MIN, foldLabel, foldMode, hiddenSteps, type FoldStep } from '../../src/ui/fold.ts';

const steps = (statuses: RepairStepStatus[], readBack = true): FoldStep[] => statuses.map((status) => ({ status, readBack }));
const many = (n: number, status: RepairStepStatus, readBack = true) => steps(Array.from({ length: n }, () => status), readBack);

describe('hiddenSteps', () => {
  test('short lists never fold', () => {
    expect(hiddenSteps(many(FOLD_MIN - 1, 'done'), 1)).toEqual([]);
  });

  test('a 14 step repair keeps the first steps and folds the rest from the end', () => {
    expect(hiddenSteps(many(14, 'done'), FOLD_KEEP)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(hiddenSteps(many(14, 'pending'), 1)).toHaveLength(13);
  });

  test('steps that failed or were put back always stay in view', () => {
    const list = steps(['done', 'done', 'done', 'done', 'done', 'rolled_back', 'failed', 'skipped']);
    const hidden = hiddenSteps(list, 3);
    expect(hidden).not.toContain(5);
    expect(hidden).not.toContain(6);
    expect(hidden).toEqual([1, 2, 3, 4, 7]);
  });

  test('folding a single step saves nothing, so it does not happen', () => {
    expect(hiddenSteps(many(5, 'done'), 4)).toEqual([]);
    expect(hiddenSteps(many(5, 'done'), 3)).toEqual([3, 4]);
  });
});

describe('foldLabel', () => {
  test('says how the folded steps went', () => {
    expect(foldLabel(many(11, 'done'))).toBe('11 more steps, all read back');
    expect(foldLabel(many(11, 'done', false))).toBe('11 more steps, all done');
    expect(foldLabel(many(11, 'pending'))).toBe('11 more steps');
    expect(foldLabel(many(2, 'skipped'))).toBe('2 more steps, all skipped');
    expect(foldLabel(steps(['done', 'skipped', 'done', 'pending']))).toBe('4 more steps: 2 done, 1 skipped, 1 to do');
    expect(foldLabel(many(1, 'pending'))).toBe('1 more step');
  });
});

describe('foldMode', () => {
  test('fit on fixed landscape screens, keep where the height is open, none in fullscreen', () => {
    expect(foldMode({ displayMode: 'inline', orientation: 'landscape', height: 800 })).toBe('fit');
    expect(foldMode({ displayMode: 'inline', orientation: 'portrait', height: 844 })).toBe('keep');
    expect(foldMode({ displayMode: 'inline', orientation: 'portrait', height: null })).toBe('keep');
    expect(foldMode({ displayMode: 'inline', orientation: 'landscape', height: null })).toBe('keep');
    expect(foldMode({ displayMode: 'fullscreen', orientation: 'landscape', height: 800 })).toBe('none');
  });
});
