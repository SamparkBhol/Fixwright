import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CAUSE_LABELS,
  ProblemOutputSchema,
  TOOL_NAMES,
  ToolOutputs,
  identifyOutput,
  idTimeMs,
  speechProblems,
  type ToolName,
} from '../src/index.ts';
import { fixtureJson, goldenFixtures } from '../scripts/golden.ts';

const dir = new URL('../fixtures/', import.meta.url);
const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8'));
const golden = goldenFixtures();

describe('fixture files', () => {
  it('exist for every tool output plus the problem output, and nothing else', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    expect(files).toEqual([...TOOL_NAMES, 'problem'].map((n) => `${n}.json`).sort());
  });

  it.each(TOOL_NAMES)('%s.json validates against its output schema', (tool) => {
    const result = ToolOutputs[tool].safeParse(load(tool));
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(true);
  });

  it('problem.json validates against the problem schema', () => {
    expect(ProblemOutputSchema.safeParse(load('problem')).success).toBe(true);
  });

  it.each([...TOOL_NAMES, 'problem' as const])('%s.json is exactly what scripts/golden.ts builds (run npm run fixtures)', (name) => {
    const text = readFileSync(new URL(`${name}.json`, dir), 'utf8');
    expect(text).toBe(fixtureJson(golden[name]));
  });

  it.each([...TOOL_NAMES, 'problem' as const])('%s speech is speech safe', (name) => {
    expect(speechProblems(golden[name].speech)).toEqual([]);
  });

  it('every view tool fixture is identified as its own tool', () => {
    const expected: Partial<Record<ToolName, string>> = { diagnose_answer: 'diagnose', refresh_view: 'repair_status' };
    for (const tool of TOOL_NAMES) {
      expect(identifyOutput(load(tool))?.tool, tool).toBe(expected[tool] ?? tool);
    }
    expect(identifyOutput(load('problem'))).toBeNull();
  });
});

describe('golden path', () => {
  it('step 1: diagnose asks the flash question with two causes clearly ahead', () => {
    const d = golden.diagnose;
    expect(d.status).toBe('needs_answer');
    expect(d.question?.text).toBe("I'll flash the hallway lamp twice. Did it blink?");
    expect(d.speech.endsWith("I'll flash the hallway lamp twice. Did it blink?")).toBe(true);
    const outcomes = Object.fromEntries(d.probes.map((p) => [p.probe_id, p.outcome]));
    expect(outcomes).toMatchObject({ hub_reachable: 'pass', link_quality: 'pass', cloud_status: 'pass' });
    expect(d.hypotheses.length).toBe(3);
    expect(d.hypotheses.filter((h) => h.p >= 0.3).length).toBe(2);
    expect(d.verdict).toBeUndefined();
  });

  it('step 2: the answer lifts the top cause to 94% and confirms with evidence', () => {
    const d = golden.diagnose_answer;
    expect(d.hypotheses[0]).toMatchObject({ cause_id: 'stale_duplicate', p: 0.94 });
    expect(d.verdict).toMatchObject({ level: 'confirmed', cause_id: 'stale_duplicate', confidence: 0.94, fix_available: true });
    expect(d.verdict?.label).toBe(CAUSE_LABELS.stale_duplicate.label);
    expect(d.speech).toContain('The lamp works. The name Hallway Lamp still points at an old copy of it that went offline on October 3.');
    expect(d.verdict?.claims.every((c) => c.evidence.length > 0)).toBe(true);
  });

  it('step 3: plan is a dry run of pending steps, apply reads every step back', () => {
    expect(golden.repair_plan.steps.every((s) => s.status === 'pending')).toBe(true);
    expect(golden.repair_plan.diff_lines).toContain('The old copy, offline since October 3, is retired.');
    expect(golden.repair_apply.state).toBe('applied');
    expect(golden.repair_apply.steps.every((s) => s.status === 'done' && s.read_back)).toBe(true);
    expect(golden.repair_apply.speech).toContain('I switched it on and off, it answered both times.');
    expect(golden.repair_apply.undo_available).toBe(true);
  });

  it('step 4: the next morning check runs at 07:00 household time and confirms the repair', () => {
    expect(golden.repair_apply.next_check_at).toBe('2026-10-16T14:00:00.000Z'); // 07:00 PDT
    expect(golden.repair_status.state).toBe('confirmed');
    expect(golden.repair_status.checks[0]?.detail).toBe('Hallway lamp answered all 9 commands overnight.');
    expect(golden.repair_status.speech).toBe('Hallway lamp answered all 9 commands overnight. Repair confirmed.');
  });

  it('step 5: the 3 a.m. explanation is confirmed with three evidenced claims and a fix', () => {
    const e = golden.explain_event;
    expect(e.verdict.claims.map((c) => c.text)).toEqual([
      'Power came back at 3:12.',
      'Fourteen devices restarted within four seconds.',
      'None of your automations fired.',
    ]);
    expect(e.verdict.claims[1]?.evidence.length).toBe(14);
    expect(e.suggested_fix?.issue_id).toBe(e.ids.issue_id);
    expect(e.timeline[1]?.ts).toBe('2026-10-16T10:12:00.000Z'); // 03:12:00 PDT
  });

  it('step 6: the checkup shows the three findings from the demo', () => {
    expect(golden.home_checkup.findings.map((f) => f.title)).toEqual([
      'Two lights answer to Living Room Light',
      'Hall motion sensor battery at 6%',
      'Kitchen plug dropped off Wi-Fi 9 times today',
    ]);
  });

  it('step 7: turning off the strip is refused because of the protected aquarium filter', () => {
    expect(golden.switch_device.status).toBe('refused');
    expect(golden.switch_device.speech).toBe("That strip runs the aquarium filter, which you marked protected. I'll turn off the lamp on it instead.");
    expect(golden.protect_device.protected.map((p) => p.name)).toContain('Aquarium Filter');
    expect(golden.switch_device.alternative?.entity_id).not.toBe(golden.protect_device.protected[0]?.entity_id);
  });

  it('ids chain from one call to the next and encode when they were made', () => {
    const dx = golden.diagnose.diagnosis_id;
    expect(golden.diagnose_answer.diagnosis_id).toBe(dx);
    expect(golden.diagnose_answer.ids.diagnosis_id).toBe(dx);
    expect(golden.repair_plan.ids.diagnosis_id).toBe(dx);
    expect(golden.repair_apply.plan_id).toBe(golden.repair_plan.plan_id);
    expect(golden.repair_status.repair_id).toBe(golden.repair_apply.repair_id);
    expect(golden.undo.repair_id).toBe(golden.repair_apply.repair_id);
    expect(golden.refresh_view['repair_id']).toBe(golden.repair_apply.repair_id);
    expect(idTimeMs(dx)).toBe(Date.parse('2026-10-15T17:20:04.000Z'));
    expect(idTimeMs(golden.repair_apply.repair_id)! > idTimeMs(golden.repair_plan.plan_id)!).toBe(true);
  });

  it('is deterministic', () => {
    expect(goldenFixtures()).toEqual(golden);
  });
});
