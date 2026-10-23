import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import {
  EntitySchema,
  HouseEventSchema,
  OutputBaseSchema,
  ProblemOutputSchema,
  SignalsSchema,
  TOOL_NAMES,
  ToolInputs,
  ToolOutputs,
  VerdictSchema,
  type ToolName,
} from '../src/index.ts';
import { goldenFixtures } from '../scripts/golden.ts';

const golden = goldenFixtures();
// Loose on purpose: tests reach deep into copies to break one field at a time.
type Json = Record<string, any>;

/** A deep copy of a golden fixture with `mutate` applied. */
function variant(tool: ToolName | 'problem', mutate: (o: Json) => void): unknown {
  const copy = structuredClone(golden[tool]) as Json;
  mutate(copy);
  return copy;
}

function rejects(tool: ToolName, mutate: (o: Json) => void, messagePart?: string): void {
  const result = ToolOutputs[tool].safeParse(variant(tool, mutate));
  expect(result.success).toBe(false);
  if (messagePart && !result.success) {
    expect(result.error.issues.map((i) => i.message).join(' | ')).toContain(messagePart);
  }
}

describe('output schemas reject broken outputs', () => {
  it.each(TOOL_NAMES)('%s without speech', (tool) => rejects(tool, (o) => delete o['speech']));

  it.each(TOOL_NAMES.filter((t) => t !== 'refresh_view'))('%s with an unknown extra field (outputs are strict)', (tool) =>
    rejects(tool, (o) => (o['debug'] = true)),
  );

  it('speech with a pipe, markup, an id, a tool name or over 30 seconds', () => {
    rejects('diagnose', (o) => (o['speech'] = 'Hub ok | signal ok'), 'speech has a pipe');
    rejects('diagnose', (o) => (o['speech'] = 'The **lamp** works.'), 'speech has markup');
    rejects('diagnose', (o) => (o['speech'] = `Saved as ${golden.diagnose.diagnosis_id}.`), 'speech has an id');
    rejects('diagnose', (o) => (o['speech'] = 'Now call repair_plan.'), 'speech has a tool name');
    rejects('diagnose', (o) => (o['speech'] = 'word '.repeat(80).trim()), 'speech is too long');
  });

  it('wrong view or status for the tool', () => {
    rejects('home_checkup', (o) => (o['view'] = 'stepper'));
    rejects('repair_plan', (o) => (o['status'] = 'ok'));
    rejects('protect_device', (o) => (o['view'] = 'carousel'));
  });

  it('ids that do not chain', () => {
    rejects('diagnose', (o) => (o['ids'] = {}), 'ids.diagnosis_id must equal diagnosis_id');
    rejects('repair_apply', (o) => (o['ids']['plan_id'] = golden.repair_plan.plan_id.replace(/.$/, '0')), 'ids.plan_id does not match');
    rejects('diagnose', (o) => (o['diagnosis_id'] = 'dx_123'), 'expected a dx_ id');
    rejects('diagnose', (o) => (o['ids']['plan_id'] = o['diagnosis_id']), 'expected a pln_ id');
  });

  it('diagnosis rules: question only while waiting, verdict only when done, top 3 sorted hypotheses', () => {
    rejects('diagnose', (o) => delete o['question'], 'question is present exactly when status is needs_answer');
    rejects('diagnose_answer', (o) => delete o['verdict'], 'verdict is present exactly when status is ok');
    rejects('diagnose_answer', (o) => (o['question'] = golden.diagnose.question), 'question is present exactly');
    rejects('diagnose', (o) => o['hypotheses'].push({ cause_id: 'hub_down', label: 'Hub or bridge offline', p: 0.01 }));
    rejects('diagnose', (o) => (o['hypotheses'][0]['p'] = 0.7), 'more than 1');
    rejects('diagnose', (o) => o['hypotheses'].reverse(), 'most likely first');
    rejects('diagnose', (o) => (o['hypotheses'][1]['cause_id'] = 'stale_duplicate'), 'duplicate');
    rejects('diagnose', (o) => (o['hypotheses'][0]['cause_id'] = 'gremlins'));
    rejects('diagnose', (o) => (o['question']['expects'] = 'choice'), 'at least two choices');
  });

  it('verdict rules: confirmed needs confidence 0.9 and evidence', () => {
    const v = golden.diagnose_answer.verdict!;
    expect(VerdictSchema.safeParse(v).success).toBe(true);
    expect(VerdictSchema.safeParse({ ...v, confidence: 0.8 }).success).toBe(false);
    expect(VerdictSchema.safeParse({ ...v, level: 'likely', confidence: 0.8 }).success).toBe(true);
    expect(VerdictSchema.safeParse({ ...v, claims: [{ text: 'Here is what I found.', evidence: [] }] }).success).toBe(false);
    expect(VerdictSchema.safeParse({ ...v, confidence: 1.2, level: 'likely' }).success).toBe(false);
  });

  it('checkup rules: at most 5 findings, most severe first', () => {
    rejects('home_checkup', (o) => o['findings'].reverse(), 'most severe first');
    rejects('home_checkup', (o) => {
      const f = o['findings'][2];
      for (let i = 0; i < 3; i++) o['findings'].push({ ...f, issue_id: f.issue_id.replace(/.$/, String(i)) });
    });
    rejects('home_checkup', (o) => (o['findings'][1]['issue_id'] = o['findings'][0]['issue_id']), 'duplicate');
    rejects('home_checkup', (o) => (o['findings'][0]['entity_ids'] = ['Living Room Light']), 'entity id');
  });

  it('plan and repair rules', () => {
    rejects('repair_plan', (o) => (o['steps'][0]['status'] = 'done'), 'every step of a plan is pending');
    rejects('repair_plan', (o) => (o['steps'][1]['step'] = 5), 'numbered from 1');
    rejects('repair_plan', (o) => (o['steps'] = []));
    rejects('repair_apply', (o) => (o['steps'][2]['status'] = 'failed'), 'every step done or skipped');
    rejects('repair_apply', (o) => (o['state'] = 'rolled_back'), 'nothing to undo');
    rejects('repair_status', (o) => o['checks'].unshift({ at: '2026-10-17T14:00:00.000Z', result: 'pass', detail: 'x' }), 'time order');
    rejects('undo', (o) => (o['undo_available'] = true));
    rejects('undo', (o) => (o['state'] = 'applied'));
    rejects('explain_event', (o) => o['timeline'].reverse(), 'time order');
    rejects('explain_event', (o) => (o['timeline'][0]['ts'] = '2026-10-16T03:11:58-07:00'), 'ISO 8601 UTC');
  });

  it('switch rules: ok switches something, a refusal may only switch the offered alternative', () => {
    rejects('switch_device', (o) => {
      o['status'] = 'ok';
      delete o['switched'];
    }, 'status ok means a device was switched');
    rejects('switch_device', (o) => delete o['alternative'], 'only the offered alternative');
    const refusedOnly = variant('switch_device', (o) => delete o['switched']);
    expect(ToolOutputs.switch_device.safeParse(refusedOnly).success).toBe(true);
  });

  it('refresh_view accepts any output with valid shared fields', () => {
    for (const tool of TOOL_NAMES) expect(ToolOutputs.refresh_view.safeParse(golden[tool]).success).toBe(true);
    expect(OutputBaseSchema.safeParse({ speech: 'Hi.', status: 'done', ids: {}, source: golden.diagnose.source }).success).toBe(false);
  });

  it('problem outputs are error or refused with a known code', () => {
    expect(ProblemOutputSchema.safeParse(golden.problem).success).toBe(true);
    expect(ProblemOutputSchema.safeParse(variant('problem', (o) => (o['status'] = 'ok'))).success).toBe(false);
    expect(ProblemOutputSchema.safeParse(variant('problem', (o) => (o['problem']['code'] = 'oops'))).success).toBe(false);
  });
});

describe('input schemas', () => {
  const ok = (tool: ToolName, input: unknown) => expect(ToolInputs[tool].safeParse(input).success, JSON.stringify(input)).toBe(true);
  const bad = (tool: ToolName, input: unknown) => expect(ToolInputs[tool].safeParse(input).success, JSON.stringify(input)).toBe(false);
  const { diagnosis_id } = golden.diagnose;
  const question_id = golden.diagnose.question!.question_id;

  it('accept the golden path calls', () => {
    ok('home_checkup', {});
    ok('home_checkup', { focus: 'kitchen' });
    ok('diagnose', { symptom: "the hallway lamp keeps saying it's not responding", device: 'hallway lamp' });
    ok('diagnose_answer', { diagnosis_id, question_id, answer: 'Yes, it blinked.' });
    ok('explain_event', { question: 'Why did every plug turn on at 3 a.m.?' });
    ok('explain_event', { question: 'What happened?', since: '2026-10-16T03:00:00-07:00', until: '2026-10-16T10:59:59Z' });
    ok('repair_plan', { diagnosis_id });
    ok('repair_plan', { issue_id: golden.explain_event.suggested_fix!.issue_id });
    ok('repair_apply', { plan_id: golden.repair_plan.plan_id, confirm_token: golden.repair_plan.confirm_token });
    ok('repair_status', { repair_id: golden.repair_apply.repair_id });
    ok('undo', { repair_id: golden.repair_apply.repair_id });
    ok('protect_device', { device: 'aquarium filter', reason: 'the fish need it' });
    ok('switch_device', { device: 'living room power strip', on: false });
    ok('refresh_view', { ref_id: golden.repair_apply.repair_id });
  });

  it('reject missing, empty or malformed fields', () => {
    bad('diagnose', {});
    bad('diagnose', { symptom: '   ' });
    bad('diagnose_answer', { diagnosis_id, question_id, answer: '' });
    bad('diagnose_answer', { diagnosis_id: 'dx_nope', question_id, answer: 'yes' });
    bad('explain_event', { question: 'x', since: 'yesterday' });
    bad('explain_event', { question: 'x', since: '2026-10-16T10:00:00Z', until: '2026-10-16T09:00:00Z' });
    bad('repair_apply', { plan_id: golden.repair_plan.plan_id, confirm_token: 'short' });
    bad('switch_device', { device: 'lamp', on: 'off' });
    bad('refresh_view', { ref_id: question_id });
  });

  it('repair_plan takes exactly one source id', () => {
    bad('repair_plan', {});
    bad('repair_plan', { diagnosis_id, issue_id: golden.home_checkup.findings[0]!.issue_id });
    const r = ToolInputs.repair_plan.safeParse({});
    expect(r.success ? '' : r.error.issues[0]?.message).toBe('Give exactly one of diagnosis_id, issue_id or explanation_id.');
  });

  it('strip unknown keys and trim text', () => {
    const r = ToolInputs.diagnose.parse({ symptom: '  lamp is dead  ', room: 'hall' });
    expect(r).toEqual({ symptom: 'lamp is dead' });
  });
});

describe('JSON Schema for hosts', () => {
  it.each(TOOL_NAMES)('%s input and output convert to object schemas; every input field is described', (tool) => {
    const input = z.toJSONSchema(ToolInputs[tool], { io: 'input' }) as { type: string; properties: Record<string, { description?: string }> };
    const output = z.toJSONSchema(ToolOutputs[tool], { io: 'output' }) as { type: string };
    expect(input.type).toBe('object');
    expect(output.type).toBe('object');
    for (const [key, prop] of Object.entries(input.properties)) {
      expect(prop.description, `${tool}.${key}`).toMatch(/\w{3,}.*\w/);
    }
  });

  it('works through the Standard Schema JSON hook the MCP SDK uses', () => {
    const std = ToolInputs.diagnose['~standard'] as unknown as {
      jsonSchema: { input: (o: { target: string }) => { required?: string[] } };
    };
    expect(std.jsonSchema.input({ target: 'draft-2020-12' }).required).toEqual(['symptom']);
  });
});

describe('core model schemas', () => {
  const entity = {
    entityId: 'light.hallway_lamp',
    name: 'Hallway Lamp',
    aliases: [],
    domain: 'light',
    integration: 'hue',
    transport: 'zigbee',
    state: 'unavailable',
    attributes: { friendly_name: 'Hallway Lamp' },
    lastChanged: '2026-10-03T16:41:07.000Z',
    lastUpdated: '2026-10-03T16:41:07.000Z',
    restored: true,
  };

  it('Entity accepts adapter extras (stripped) and rejects bad ids, transports and local times', () => {
    expect(EntitySchema.parse({ ...entity, parentId: 'x' })).not.toHaveProperty('parentId');
    expect(EntitySchema.safeParse({ ...entity, entityId: 'Hallway Lamp' }).success).toBe(false);
    expect(EntitySchema.safeParse({ ...entity, transport: 'bluetooth' }).success).toBe(false);
    expect(EntitySchema.safeParse({ ...entity, lastChanged: '2026-10-03 16:41' }).success).toBe(false);
  });

  it('HouseEvent and Signals', () => {
    const event = { seq: 0, ts: '2026-10-16T10:12:00.000Z', kind: 'power', source: 'home', context: { automationId: 'automation.x' } };
    expect(HouseEventSchema.safeParse(event).success).toBe(true);
    expect(HouseEventSchema.safeParse({ ...event, seq: -1 }).success).toBe(false);
    expect(HouseEventSchema.safeParse({ ...event, kind: 'magic' }).success).toBe(false);
    expect(SignalsSchema.safeParse({ linkQuality: 182, rssi: -82, batteryPct: 6, powerOnBehavior: 'on', flaps24h: 9 }).success).toBe(true);
    expect(SignalsSchema.safeParse({ linkQuality: 300 }).success).toBe(false);
    expect(SignalsSchema.safeParse({ powerOnBehavior: 'sometimes' }).success).toBe(false);
  });
});
