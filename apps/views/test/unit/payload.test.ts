import { describe, expect, test } from 'vitest';
import { FALLBACK_PROBLEM, UNREADABLE_PROBLEM, classifyPayload, readToolResult, type PayloadKind } from '../../src/ui/payload.ts';
import { fixture, fixtureNames } from './load.ts';

const KIND_BY_TOOL: Record<string, PayloadKind | null> = {
  diagnose: 'diagnosis',
  diagnose_answer: 'diagnosis',
  explain_event: 'explanation',
  repair_plan: 'plan',
  repair_apply: 'repair',
  repair_status: 'repair',
  undo: 'repair',
  refresh_view: 'repair',
  home_checkup: 'checkup',
  protect_device: null,
  switch_device: null,
  problem: null,
};

describe('classifyPayload', () => {
  test.each(fixtureNames('protocol'))('%s', (name) => {
    const tool = name.split('/')[1] as string;
    expect(classifyPayload(fixture(name))?.kind ?? null).toBe(KIND_BY_TOOL[tool]);
  });

  test.each(fixtureNames('views'))('%s', (name) => {
    const file = name.split('/')[1] as string;
    const expected = file.startsWith('diagnose') ? 'diagnosis' : file.startsWith('home_checkup') ? 'checkup' : file.startsWith('repair_plan') ? 'plan' : 'repair';
    expect(classifyPayload(fixture(name))?.kind).toBe(expected);
  });

  test('rejects payloads with the right ids but broken fields', () => {
    const d = fixture('protocol/diagnose');
    expect(classifyPayload({ ...d, hypotheses: [{ cause_id: 'x', label: 'y', p: 'high' }] })).toBeNull();
    expect(classifyPayload({ ...d, probes: [{ ...(d.probes as object[])[0], outcome: 'maybe' }] })).toBeNull();
    const r = fixture('protocol/repair_apply');
    expect(classifyPayload({ ...r, state: 'exploded' })).toBeNull();
    expect(classifyPayload({ ...r, steps: [{ step: 1, label: 'x', status: 'pending', read_back: 5 }] })).toBeNull();
    expect(classifyPayload(null)).toBeNull();
    expect(classifyPayload([1, 2])).toBeNull();
    expect(classifyPayload({ speech: 'x' })).toBeNull();
  });
});

describe('readToolResult', () => {
  test('a normal result becomes a payload', () => {
    const out = readToolResult({ structuredContent: fixture('protocol/diagnose'), content: [] });
    expect(out.ok && out.payload.kind).toBe('diagnosis');
  });

  test('a ProblemOutput keeps its speech and retry hint', () => {
    const out = readToolResult({ isError: true, structuredContent: fixture('protocol/problem') });
    expect(out).toEqual({ ok: false, problem: { speech: "I couldn't reach your hub just now. Try again in a minute.", retryable: true } });
  });

  test('an error with only text content uses that text', () => {
    const out = readToolResult({ isError: true, content: [{ type: 'text', text: 'That plan has expired. Ask me for the fix again.' }] });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.problem.speech).toBe('That plan has expired. Ask me for the fix again.');
  });

  test('an error with nothing to say gets the fallback line', () => {
    expect(readToolResult({ isError: true })).toEqual({ ok: false, problem: { speech: FALLBACK_PROBLEM, retryable: true } });
  });

  test('an unknown shape is not rendered', () => {
    expect(readToolResult({ structuredContent: { speech: 'hi', status: 'ok', ids: {}, source: { adapter: 'simhome', simulated: true } } })).toEqual({
      ok: false,
      problem: { speech: UNREADABLE_PROBLEM, retryable: false },
    });
  });
});
