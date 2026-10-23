// The golden path as one script, run two ways: in process on node:sqlite (test/unit) and
// through the real Worker under wrangler dev with the MCP client (test/integration). Every tool result is
// checked against its protocol output schema.

import { expect } from 'vitest';
import { ToolOutputs, type ToolName } from '@fixwright/protocol';

export interface Reply {
  structuredContent: Record<string, unknown>;
  isError: boolean;
  text?: string;
}

export interface Driver {
  call(name: ToolName, args: Record<string, unknown>): Promise<Reply>;
  /** POST /demo/clock {to:'next_morning'} */
  nextMorning(): Promise<{ now: string; pushes: { title: string; message: string; at: string; delivered?: boolean }[] }>;
  /** Pushes the ntfy mock received, in order. */
  received(): { title: string | null; tags: string | null; body: string; topic: string }[];
}

export const LINES = {
  diagnose: "Your hub is reachable, the signal is good and the light maker's cloud is fine. I'll flash the hallway lamp twice. Did it blink?",
  question: "I'll flash the hallway lamp twice. Did it blink?",
  verdict: 'The lamp works. The name Hallway Lamp still points at an old copy of it that went offline on October 3.',
  applied: 'I switched it on and off, it answered both times.',
  morning: 'Hallway lamp answered all 9 commands overnight. Repair confirmed.',
  explain: 'Power came back at 3:12. Fourteen devices restarted within four seconds. None of your automations fired.',
  refusal: "That strip runs the aquarium filter, which you marked protected. I'll turn off the lamp on it instead.",
} as const;

/** The night of the outage, 03:00 to 03:59 on 15 October in Los Angeles. */
export const OUTAGE_WINDOW = { since: '2026-10-15T10:00:00.000Z', until: '2026-10-15T10:59:59.999Z' };

export function valid(tool: ToolName, r: Reply): Record<string, unknown> {
  expect(r.isError, `${tool}: ${JSON.stringify(r.structuredContent).slice(0, 400)}`).toBe(false);
  const parsed = ToolOutputs[tool].safeParse(r.structuredContent);
  expect(parsed.success, `${tool} output: ${parsed.success ? '' : JSON.stringify(parsed.error.issues).slice(0, 600)}`).toBe(true);
  if (r.text !== undefined) expect(r.text).toBe(r.structuredContent['speech']);
  return r.structuredContent;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface GoldenResult {
  diagnosisId: string;
  repairId: string;
  powerRepairId: string;
  steps: string[];
}

/** Runs the golden path and returns the ids it made. `racer` sends the apply twice at once. */
export async function goldenPath(d: Driver): Promise<GoldenResult> {
  const steps: string[] = [];
  // 1. diagnose: three passive probes pass, two causes remain, the flash question.
  const dx = valid('diagnose', await d.call('diagnose', { symptom: "why the hallway lamp keeps saying it's not responding", device: 'hallway lamp' }));
  expect(dx['status']).toBe('needs_answer');
  expect(dx['speech']).toBe(LINES.diagnose);
  const question = dx['question'] as { question_id: string; text: string };
  expect(question.text).toBe(LINES.question);
  expect((dx['hypotheses'] as unknown[]).length).toBeGreaterThanOrEqual(2);
  const diagnosisId = str(dx['diagnosis_id']);
  steps.push(`diagnose: ${str(dx['speech'])}`);

  // 2. "Yes, it blinked." -> confirmed stale_duplicate with the exact verdict line.
  const ans = valid('diagnose_answer', await d.call('diagnose_answer', { diagnosis_id: diagnosisId, question_id: question.question_id, answer: 'Yes, it blinked.' }));
  const verdict = ans['verdict'] as { level: string; cause_id: string; confidence: number; fix_available: boolean };
  expect(verdict.level).toBe('confirmed');
  expect(verdict.cause_id).toBe('stale_duplicate');
  expect(verdict.confidence).toBeGreaterThanOrEqual(0.9);
  expect(str(ans['speech'])).toContain(LINES.verdict);
  steps.push(`diagnose_answer: ${str(ans['speech'])} (${verdict.confidence})`);

  // 3. repair_plan -> dry run diff and a signed token; repair_apply -> applied with read back.
  const plan = valid('repair_plan', await d.call('repair_plan', { diagnosis_id: diagnosisId }));
  expect(plan['status']).toBe('needs_confirmation');
  expect((plan['diff'] as unknown[]).length).toBeGreaterThan(0);
  const token = str(plan['confirm_token']);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  steps.push(`repair_plan: ${(plan['diff_lines'] as string[]).join(' ')}`);

  const apply = { plan_id: str(plan['plan_id']), confirm_token: token };
  // Two simultaneous applies with one token: exactly one applies.
  const [a, b] = await Promise.all([d.call('repair_apply', apply), d.call('repair_apply', apply)]);
  const winners = [a, b].filter((r) => !r.isError);
  const losers = [a, b].filter((r) => r.isError);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect((losers[0]?.structuredContent['problem'] as { code: string }).code).toBe('plan_used');
  const applied = valid('repair_apply', winners[0] as Reply);
  expect(applied['state']).toBe('applied');
  expect(str(applied['speech'])).toContain(LINES.applied);
  expect(applied['undo_available']).toBe(true);
  for (const s of applied['steps'] as { status: string; read_back?: string }[]) {
    expect(s.status).toBe('done');
    expect(s.read_back).toBeTruthy();
  }
  const repairId = str(applied['repair_id']);
  steps.push(`repair_apply: ${str(applied['speech'])} next check ${str(applied['next_check_at'])}`);

  // Token reuse later is refused too, and a wrong token never applies.
  const reuse = await d.call('repair_apply', apply);
  expect(reuse.isError).toBe(true);
  expect((reuse.structuredContent['problem'] as { code: string }).code).toBe('plan_used');
  const forged = await d.call('repair_apply', { plan_id: apply.plan_id, confirm_token: `${token.slice(0, 40)}AAA` });
  expect((forged.structuredContent['problem'] as { code: string }).code).toBe('token_mismatch');

  // 4. Next morning: the push, word for word.
  const jump = await d.nextMorning();
  expect(jump.now).toMatch(/T14:00:00\.\d{3}Z$/);
  expect(jump.pushes.map((p) => p.message)).toEqual([LINES.morning]);
  const pushed = d.received();
  expect(pushed.at(-1)?.body).toBe(LINES.morning);
  expect(pushed.at(-1)?.title).toBe('Repair confirmed');
  steps.push(`next_morning push: ${pushed.at(-1)?.body}`);

  const status = valid('repair_status', await d.call('repair_status', { repair_id: repairId }));
  expect(status['state']).toBe('confirmed');
  expect(status['speech']).toBe(LINES.morning);
  expect((status['checks'] as { result: string }[]).map((c) => c.result)).toEqual(['pass']);

  // 5. "Why did every plug turn on at 3 a.m.?" (the night before the jump).
  const ex = valid('explain_event', await d.call('explain_event', { question: 'Why did every plug turn on at 3 a.m.?', ...OUTAGE_WINDOW }));
  const exVerdict = ex['verdict'] as { level: string; cause_id: string };
  expect(exVerdict.level).toBe('confirmed');
  expect(exVerdict.cause_id).toBe('power_restore');
  expect(str(ex['speech'])).toContain(LINES.explain);
  steps.push(`explain_event: ${str(ex['speech'])}`);

  const plan2 = valid('repair_plan', await d.call('repair_plan', { explanation_id: str(ex['explanation_id']) }));
  const apply2 = valid('repair_apply', await d.call('repair_apply', { plan_id: str(plan2['plan_id']), confirm_token: str(plan2['confirm_token']) }));
  expect(apply2['state']).toBe('applied');
  const powerRepairId = str(apply2['repair_id']);
  steps.push(`power on repair: ${(plan2['steps'] as unknown[]).length} steps, ${str(apply2['speech'])}`);

  // 6. Checkup: the three demo findings.
  const ck = valid('home_checkup', await d.call('home_checkup', {}));
  const titles = (ck['findings'] as { title: string }[]).map((f) => f.title);
  expect(titles).toHaveLength(3);
  expect(titles[0]).toBe('Two lights answer to Living Room Light');
  expect(titles).toContain('Hall motion sensor battery at 6%');
  expect(titles.some((t) => t.startsWith('Kitchen plug dropped off Wi-Fi 9 times'))).toBe(true);
  steps.push(`home_checkup: ${titles.join(' | ')}`);

  // 7. The strip is refused; the reading lamp goes off instead.
  const sw = valid('switch_device', await d.call('switch_device', { device: 'living room power strip', on: false }));
  expect(sw['status']).toBe('refused');
  expect(sw['speech']).toBe(LINES.refusal);
  expect((sw['alternative'] as { entity_id: string }).entity_id).toBe('switch.reading_lamp');
  expect(sw['switched']).toEqual({ entity_id: 'switch.reading_lamp', name: 'Reading Lamp', state: 'off' });
  steps.push(`switch_device: ${str(sw['speech'])}`);

  // protect_device: unprotect and protect the filter again.
  const off = valid('protect_device', await d.call('protect_device', { device: 'aquarium filter', protect: false }));
  expect(off['protected']).toEqual([]);
  const on = valid('protect_device', await d.call('protect_device', { device: 'aquarium filter', reason: 'The fish need it running.' }));
  expect(on['speech']).toBe("Done. I'll never switch off the aquarium filter, even through its power strip.");
  expect(on['protected']).toEqual([{ entity_id: 'switch.aquarium_filter', name: 'Aquarium Filter', reason: 'The fish need it running.' }]);

  // undo: the power on repair goes back, read back step by step.
  const undo = valid('undo', await d.call('undo', { repair_id: powerRepairId }));
  expect(undo['state']).toBe('undone');
  expect((undo['steps'] as { status: string }[]).every((s) => s.status === 'done')).toBe(true);
  steps.push(`undo: ${str(undo['speech'])}`);
  const again = await d.call('undo', { repair_id: powerRepairId });
  expect(again.isError).toBe(true);
  // The confirmed lamp repair removed its old copy after the check, so it offers no undo.
  const confirmedUndo = await d.call('undo', { repair_id: repairId });
  expect(confirmedUndo.isError).toBe(true);

  // refresh_view: a repair id gives its current status.
  const refreshed = valid('refresh_view', await d.call('refresh_view', { ref_id: repairId }));
  expect(refreshed['state']).toBe('confirmed');
  expect(ToolOutputs.repair_status.safeParse(refreshed).success).toBe(true);
  const refreshedDx = valid('refresh_view', await d.call('refresh_view', { ref_id: diagnosisId }));
  expect(ToolOutputs.diagnose.safeParse(refreshedDx).success).toBe(true);

  return { diagnosisId, repairId, powerRepairId, steps };
}
