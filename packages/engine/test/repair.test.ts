// Plans carry an inverse for every change, a diff and plain diff lines;
// the executor reads every step back, rolls back on a mismatch, runs each idempotency key once, and undo
// puts the house back.

import { describe, expect, it } from 'vitest';
import { ToolOutputs, type RepairPlanOutput } from '@fixwright/protocol';
import {
  answerDiagnosis,
  executePlan,
  explainEvent,
  morningCheck,
  planRepair,
  runCheckup,
  startDiagnosis,
  undoPlan,
  type CheckupSession,
  type DiagnosisSession,
  type RepairPlan,
} from '../src/index.ts';
import { addEntity, addEvent } from './support/fake-adapter.ts';
import { buildGoldenHouse, rig, type Rig } from './support/golden-house.ts';

function valid(output: RepairPlanOutput): void {
  const r = ToolOutputs.repair_plan.safeParse(output);
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues, null, 2)).toBe(true);
}

async function confirmedLamp(r: Rig): Promise<DiagnosisSession> {
  const dx = await startDiagnosis({ symptom: "the hallway lamp isn't responding" }, r.deps);
  const yes = await answerDiagnosis(dx.session, { diagnosis_id: dx.session.diagnosis_id, question_id: dx.output.question?.question_id ?? '', answer: 'yes' }, r.deps);
  return yes.session;
}

async function powerPlan(r: Rig): Promise<RepairPlan> {
  const ex = await explainEvent({ question: 'Why did every plug turn on at 3 a.m.?' }, r.deps);
  return (await planRepair({ kind: 'explanation', session: ex.session }, r.deps)).plan;
}

describe('stale_duplicate plan', () => {
  it('retires the old copy with an inverse, then checks the lamp answers', async () => {
    const r = rig();
    const { plan, output } = await planRepair({ kind: 'diagnosis', session: await confirmedLamp(r) }, r.deps);
    valid(output);
    expect(output.speech).toBe(
      "Here's the fix. Hallway Lamp will point to the lamp that is online. The old copy, offline since October 3, is retired. Shall I go ahead?",
    );
    expect(plan.steps.map((s) => s.label)).toEqual(['Retire the old copy', 'Switch it on and off to check it answers']);
    expect(plan.steps[0]).toMatchObject({
      op: { kind: 'registry_update', entity_id: 'light.hallway_lamp', patch: { disabled: true } },
      expect: { kind: 'disabled', entity_id: 'light.hallway_lamp', equals: true },
      inverse: { op: { kind: 'registry_update', entity_id: 'light.hallway_lamp', patch: { disabled: false } }, label: 'Bring back the old copy' },
      idempotency_key: `${plan.plan_id}:1`,
    });
    expect(plan.steps[1]).toMatchObject({ op: { kind: 'flash_check', entity_id: 'light.hallway_lamp_2', times: 2 }, inverse: null });
    expect(output.diff).toEqual([{ entity_id: 'light.hallway_lamp', field: 'registry', from: 'kept, offline since October 3', to: 'retired' }]);
    expect(plan.follow_up).toEqual([{ kind: 'registry_remove', entity_id: 'light.hallway_lamp' }]);
    expect(plan.verify).toEqual({ kind: 'commands_answered', entity_ids: ['light.hallway_lamp_2'], name: 'Hallway Lamp' });
    expect(output.confirm_token).toMatch(/^[0-9a-hjkmnp-tv-z]{32}$/);
    expect(Date.parse(output.expires_at) - Date.parse(plan.created_at)).toBe(5 * 60_000);
    expect(r.house.entities.get('light.hallway_lamp')?.disabled).toBeUndefined();
  });

  it('renames the online copy first when it carries a numbered name', async () => {
    const house = buildGoldenHouse();
    const twin = house.entities.get('light.hallway_lamp_2');
    if (twin) twin.name = 'Hallway Lamp 2';
    const old = house.entities.get('light.hallway_lamp');
    if (old) old.aliases = ['hall light'];
    const r = rig(house);
    const { plan, output } = await planRepair({ kind: 'diagnosis', session: await confirmedLamp(r) }, r.deps);
    valid(output);
    expect(plan.steps.map((s) => s.label)).toEqual([
      'Give the online lamp the name Hallway Lamp',
      'Retire the old copy',
      'Switch it on and off to check it answers',
    ]);
    expect(plan.steps[0]?.op).toEqual({ kind: 'registry_update', entity_id: 'light.hallway_lamp_2', patch: { name: 'Hallway Lamp', aliases: ['hall light'] } });
    expect(plan.steps[0]?.inverse?.op).toEqual({ kind: 'registry_update', entity_id: 'light.hallway_lamp_2', patch: { name: 'Hallway Lamp 2', aliases: [] } });
    expect(output.diff[0]).toEqual({ entity_id: 'light.hallway_lamp_2', field: 'name', from: 'Hallway Lamp 2', to: 'Hallway Lamp' });

    const applied = await executePlan(plan, r.deps);
    expect(applied.state).toBe('applied');
    expect(applied.steps.map((s) => s.read_back)).toEqual(['Name reads Hallway Lamp', 'Old copy is retired', 'It answered both times']);
    expect(r.house.entities.get('light.hallway_lamp_2')?.name).toBe('Hallway Lamp');

    const undone = await undoPlan(plan, applied.applied, r.deps);
    expect(undone.ok).toBe(true);
    expect(undone.steps.map((s) => s.label)).toEqual(['Bring back the old copy', 'Give it its old name back, Hallway Lamp 2']);
    expect(undone.speech).toBe('Undone. Hallway Lamp is back the way it was before the fix.');
    expect(r.house.entities.get('light.hallway_lamp_2')?.name).toBe('Hallway Lamp 2');
    expect(r.house.entities.get('light.hallway_lamp')?.disabled).toBe(false);
    expect(ToolOutputs.undo.safeParse({
      speech: undone.speech, status: 'ok', view: 'repair_card', ids: { repair_id: 'rep_01m5098trrwqn6nph9', plan_id: plan.plan_id },
      source: { adapter: 'simhome', simulated: true }, repair_id: 'rep_01m5098trrwqn6nph9', plan_id: plan.plan_id, state: 'undone', steps: undone.steps, undo_available: false,
    }).success).toBe(true);
  });

  it("keeps the old copy's other names when both copies already share the name", async () => {
    const house = buildGoldenHouse();
    const old = house.entities.get('light.hallway_lamp');
    if (old) old.aliases = ['hall light', 'Hallway Lamp'];
    const r = rig(house);
    const { plan, output } = await planRepair({ kind: 'diagnosis', session: await confirmedLamp(r) }, r.deps);
    valid(output);
    expect(plan.steps.map((s) => s.label)).toEqual(['Let the online lamp answer to hall light too', 'Retire the old copy', 'Switch it on and off to check it answers']);
    expect(plan.steps[0]).toMatchObject({
      op: { kind: 'registry_update', entity_id: 'light.hallway_lamp_2', patch: { aliases: ['hall light'] } },
      expect: { kind: 'aliases', entity_id: 'light.hallway_lamp_2', equals: ['hall light'] },
      inverse: { op: { kind: 'registry_update', entity_id: 'light.hallway_lamp_2', patch: { aliases: [] } }, expect: { kind: 'aliases', equals: [] } },
    });
    expect(output.diff[0]).toEqual({ entity_id: 'light.hallway_lamp_2', field: 'aliases', from: 'none', to: 'hall light' });
    expect(output.diff_lines).toEqual([
      'Hallway Lamp will point to the lamp that is online.',
      'The lamp that is online will also answer to hall light.',
      'The old copy, offline since October 3, is retired.',
    ]);
    const applied = await executePlan(plan, r.deps);
    expect(applied.steps.map((s) => s.read_back)).toEqual(['Also answers to hall light', 'Old copy is retired', 'It answered both times']);
    expect(r.house.entities.get('light.hallway_lamp_2')?.aliases).toEqual(['hall light']);
    const undone = await undoPlan(plan, applied.applied, r.deps);
    expect(undone.steps.map((s) => [s.label, s.read_back])).toEqual([
      ['Bring back the old copy', 'Old copy is back in the device list'],
      ['Take the old names off the online lamp', 'Names are as they were'],
    ]);
    expect(r.house.entities.get('light.hallway_lamp_2')?.aliases).toEqual([]);
  });

  it('rolls everything back when a read back fails', async () => {
    const r = rig();
    const { plan } = await planRepair({ kind: 'diagnosis', session: await confirmedLamp(r) }, r.deps);
    r.house.deaf.add('light.hallway_lamp_2');
    const result = await executePlan(plan, r.deps);
    expect(result.state).toBe('rolled_back');
    expect(result.steps.map((s) => s.status)).toEqual(['rolled_back', 'failed']);
    expect(result.speech).toBe("Something didn't check out, so I put everything back the way it was.");
    expect(r.house.entities.get('light.hallway_lamp')?.disabled).toBe(false);
    const repairs = r.ledger.all().filter((e) => e.kind === 'repair');
    expect(repairs.map((e) => [e.data?.['phase'], e.data?.['status']])).toEqual([
      ['apply', 'done'],
      ['apply', 'failed'],
      ['rollback', 'rolled_back'],
    ]);
  });

  it('runs each idempotency key at most once', async () => {
    const r = rig();
    const { plan } = await planRepair({ kind: 'diagnosis', session: await confirmedLamp(r) }, r.deps);
    const seen = new Set<string>();
    const claim = (key: string): boolean => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    };
    const first = await executePlan(plan, r.deps, { claim });
    const callsAfterFirst = r.house.calls.length;
    const again = await executePlan(plan, r.deps, { claim });
    expect(first.state).toBe('applied');
    expect(again.steps.every((s) => s.status === 'skipped')).toBe(true);
    expect(r.house.calls.length).toBe(callsAfterFirst);
  });

  it('reports a missed command in the morning', async () => {
    const r = rig();
    const { plan } = await planRepair({ kind: 'diagnosis', session: await confirmedLamp(r) }, r.deps);
    await executePlan(plan, r.deps);
    const since = r.deps.clock.now();
    addEvent(r.house, { ts: '2026-10-16T03:00:00.000Z', kind: 'service_call', entityId: 'light.hallway_lamp_2', data: { service: 'light.turn_on' } });
    addEvent(r.house, { ts: '2026-10-16T04:00:00.000Z', kind: 'service_call', entityId: 'light.hallway_lamp_2', data: { service: 'light.turn_off' } });
    addEvent(r.house, { ts: '2026-10-16T04:00:00.500Z', kind: 'state', entityId: 'light.hallway_lamp_2', from: 'on', to: 'off' });
    r.clock.set('2026-10-16T14:00:00.000Z');
    const check = await morningCheck(plan, since, r.deps);
    expect(check).toMatchObject({ result: 'fail', answered: 1, total: 2 });
    expect(check.speech).toBe("Hallway lamp missed 1 of 2 commands overnight. I'll take another look.");
  });

  it('never says "missed 0" when every command was answered but the lamp dropped off', async () => {
    const r = rig();
    const { plan } = await planRepair({ kind: 'diagnosis', session: await confirmedLamp(r) }, r.deps);
    await executePlan(plan, r.deps);
    const since = r.deps.clock.now();
    addEvent(r.house, { ts: '2026-10-16T03:00:00.000Z', kind: 'service_call', entityId: 'light.hallway_lamp_2', data: { service: 'light.turn_on' } });
    addEvent(r.house, { ts: '2026-10-16T03:00:00.400Z', kind: 'state', entityId: 'light.hallway_lamp_2', from: 'off', to: 'on' });
    addEvent(r.house, { ts: '2026-10-16T04:00:00.000Z', kind: 'service_call', entityId: 'light.hallway_lamp_2', data: { service: 'light.turn_off' } });
    addEvent(r.house, { ts: '2026-10-16T04:00:00.400Z', kind: 'state', entityId: 'light.hallway_lamp_2', from: 'on', to: 'off' });
    addEvent(r.house, { ts: '2026-10-16T05:00:00.000Z', kind: 'availability', entityId: 'light.hallway_lamp_2', from: 'off', to: 'unavailable' });
    addEvent(r.house, { ts: '2026-10-16T05:03:00.000Z', kind: 'availability', entityId: 'light.hallway_lamp_2', from: 'unavailable', to: 'off' });
    r.clock.set('2026-10-16T14:00:00.000Z');
    const check = await morningCheck(plan, since, r.deps);
    expect(check).toMatchObject({ result: 'fail', answered: 2, total: 2 });
    expect(check.speech).toBe("Hallway lamp answered both commands it got overnight, but went offline once. I'll take another look.");
    expect(check.speech).not.toMatch(/missed 0/);
    expect(check.detail).toBe('Hallway lamp answered both commands it got overnight, but went offline once.');
    const offline = r.ledger.all().find((e) => e.to === 'unavailable' && e.entityId === 'light.hallway_lamp_2' && e.ts === '2026-10-16T05:00:00.000Z');
    expect(check.evidence).toContain(offline?.seq);
  });

  it('says both when commands were missed and the lamp dropped off', async () => {
    const r = rig();
    const { plan } = await planRepair({ kind: 'diagnosis', session: await confirmedLamp(r) }, r.deps);
    await executePlan(plan, r.deps);
    const since = r.deps.clock.now();
    addEvent(r.house, { ts: '2026-10-16T03:00:00.000Z', kind: 'service_call', entityId: 'light.hallway_lamp_2', data: { service: 'light.turn_on' } });
    addEvent(r.house, { ts: '2026-10-16T05:00:00.000Z', kind: 'availability', entityId: 'light.hallway_lamp_2', from: 'off', to: 'unavailable' });
    addEvent(r.house, { ts: '2026-10-16T05:03:00.000Z', kind: 'availability', entityId: 'light.hallway_lamp_2', from: 'unavailable', to: 'off' });
    r.clock.set('2026-10-16T14:00:00.000Z');
    const check = await morningCheck(plan, since, r.deps);
    expect(check.speech).toBe("Hallway lamp missed the one command it got and went offline once overnight. I'll take another look.");
  });

  it('passes a quiet night when the lamp stayed online, citing the states it read', async () => {
    const r = rig();
    const { plan } = await planRepair({ kind: 'diagnosis', session: await confirmedLamp(r) }, r.deps);
    await executePlan(plan, r.deps);
    const since = r.deps.clock.now();
    r.clock.set('2026-10-16T14:00:00.000Z');
    const check = await morningCheck(plan, since, r.deps);
    expect(check.speech).toBe('Hallway lamp stayed online all night. Repair confirmed.');
    expect(check.evidence).toHaveLength(1);
    const note = r.ledger.all().find((e) => e.seq === check.evidence[0]);
    expect(note).toMatchObject({ kind: 'note', source: 'fixwright', ts: '2026-10-16T14:00:00.000Z', entityId: 'light.hallway_lamp_2' });
    expect(note?.data).toMatchObject({ check: 'morning', plan_id: plan.plan_id, result: 'pass', commands: 0, offline_events: 0, states: { 'light.hallway_lamp_2': 'off' } });
  });

  it('cites the commands, the replies and its own note when commands were answered', async () => {
    const r = rig();
    const { plan } = await planRepair({ kind: 'diagnosis', session: await confirmedLamp(r) }, r.deps);
    await executePlan(plan, r.deps);
    const since = r.deps.clock.now();
    addEvent(r.house, { ts: '2026-10-16T03:00:00.000Z', kind: 'service_call', entityId: 'light.hallway_lamp_2', data: { service: 'light.turn_on' } });
    addEvent(r.house, { ts: '2026-10-16T03:00:00.400Z', kind: 'state', entityId: 'light.hallway_lamp_2', from: 'off', to: 'on' });
    r.clock.set('2026-10-16T14:00:00.000Z');
    const check = await morningCheck(plan, since, r.deps);
    expect(check).toMatchObject({ result: 'pass', answered: 1, total: 1, speech: 'Hallway lamp answered the one command it got overnight. Repair confirmed.' });
    const kinds = check.evidence.map((seq) => r.ledger.all().find((e) => e.seq === seq)?.kind);
    expect(kinds).toEqual(['service_call', 'state', 'note']);
  });
});

describe('power_on_default_on plan', () => {
  it('plans each setting once, even when two of its devices share it', async () => {
    const r = rig();
    // A second entity on the porch light's device (a light and its switch, as some bridges expose them).
    addEntity(r.house, { entityId: 'switch.porch_light_relay', name: 'Porch Light Relay', deviceId: 'dev_porch_light', integration: 'zigbee2mqtt', transport: 'zigbee', state: 'on' });
    const ex = await explainEvent({ question: 'Why did every plug turn on at 3 a.m.?' }, r.deps);
    const fix = ex.session.suggested_fix;
    if (!fix) throw new Error('expected the power on fix');
    const session = { ...ex.session, suggested_fix: { ...fix, entity_ids: [...fix.entity_ids, 'switch.porch_light_relay'] } };
    const plan = (await planRepair({ kind: 'explanation', session }, r.deps)).plan;
    const selects = plan.steps.map((st) => (st.op.kind === 'select_option' ? st.op.entity_id : ''));
    expect(selects).toHaveLength(14);
    expect(new Set(selects).size).toBe(14);
  });

  it('sets every select to previous, each with an inverse back to on', async () => {
    const r = rig();
    const plan = await powerPlan(r);
    expect(plan.cause_id).toBe('power_on_default_on');
    expect(plan.steps).toHaveLength(14);
    for (const s of plan.steps) {
      expect(s.op).toMatchObject({ kind: 'select_option', option: 'previous' });
      expect(s.op.kind === 'select_option' && s.op.entity_id.endsWith('_power_on_behavior')).toBe(true);
      expect(s.inverse?.op).toMatchObject({ kind: 'select_option', option: 'on' });
      expect(s.expect).toMatchObject({ kind: 'state', equals: 'previous' });
    }
    expect(plan.diff).toHaveLength(14);
    expect(plan.diff[0]).toEqual({ entity_id: 'select.kitchen_ceiling_power_on_behavior', field: 'power on behavior', from: 'on', to: 'previous' });
    expect(plan.diff_lines).toEqual(['Fourteen devices will remember whether they were on or off when power comes back.']);
  });

  it('applies and reads back, holds overnight, and undoes cleanly', async () => {
    const r = rig();
    const plan = await powerPlan(r);
    const applied = await executePlan(plan, r.deps);
    expect(applied.state).toBe('applied');
    expect(applied.speech).toBe("Done. I made fourteen changes and checked each one. I'll check on them again tomorrow morning.");
    expect([...r.house.signals.values()].filter((s) => s.powerOnBehavior === 'previous')).toHaveLength(14);
    const check = await morningCheck(plan, r.deps.clock.now(), r.deps);
    expect(check.speech).toBe('The power on settings held overnight. Repair confirmed.');
    // The pass cites the note recording all fourteen settings as read.
    expect(check.evidence).toHaveLength(1);
    const note = r.ledger.all().find((e) => e.seq === check.evidence[0]);
    expect(note?.data).toMatchObject({ check: 'morning', result: 'pass', verify: 'setting_holds', held: 14, total: 14 });
    expect(Object.values(note?.data?.['observed'] as Record<string, string>)).toEqual(Array(14).fill('previous'));
    const undone = await undoPlan(plan, applied.applied, r.deps);
    expect(undone.ok).toBe(true);
    expect(undone.speech).toBe('Undone. Those fourteen power on settings are back the way they were.');
    expect(undone.steps).toHaveLength(14);
    expect([...r.house.entities.values()].filter((e) => e.entityId.endsWith('_power_on_behavior') && e.state === 'on')).toHaveLength(14);
  });

  it('one setting is spoken as one, and a setting that changed back is counted and cited', async () => {
    const r = rig();
    const dx = await startDiagnosis({ symptom: 'the porch light keeps turning on by itself at night' }, r.deps);
    const { plan } = await planRepair({ kind: 'diagnosis', session: dx.session }, r.deps);
    await executePlan(plan, r.deps);
    expect((await morningCheck(plan, r.deps.clock.now(), r.deps)).speech).toBe('The power on setting held overnight. Repair confirmed.');
    await r.adapter.selectOption('select.porch_light_power_on_behavior', 'on');
    const failed = await morningCheck(plan, r.deps.clock.now(), r.deps);
    expect(failed).toMatchObject({ result: 'fail', answered: 0, total: 1, speech: "The power on setting changed back overnight. I'll take another look." });
    expect(r.ledger.all().find((e) => e.seq === failed.evidence[0])?.data).toMatchObject({ result: 'fail', observed: { 'select.porch_light_power_on_behavior': 'on' } });

    const r14 = rig();
    const plan14 = await powerPlan(r14);
    await executePlan(plan14, r14.deps);
    await r14.adapter.selectOption('select.tv_plug_power_on_behavior', 'on');
    expect((await morningCheck(plan14, r14.deps.clock.now(), r14.deps)).speech).toBe(
      "One of the fourteen power on settings changed back overnight. I'll take another look.",
    );
  });

  it('lists devices it cannot change and plans the rest', async () => {
    const house = buildGoldenHouse();
    house.entities.delete('select.tv_plug_power_on_behavior');
    const r = rig(house);
    const plan = await powerPlan(r);
    expect(plan.steps).toHaveLength(13);
    expect(plan.diff_lines).toEqual([
      'Thirteen devices will remember whether they were on or off when power comes back.',
      "I can't change the TV plug from here.",
    ]);
  });
});

describe('safety inside a plan', () => {
  it('skips a garage door opener in a power on plan and says so, keeping the rest', async () => {
    const house = buildGoldenHouse();
    addEntity(house, { entityId: 'switch.garage_door_opener', name: 'Garage Door Opener', deviceId: 'dev_gdo', integration: 'kasa', transport: 'wifi', state: 'off' }, { powerOnBehavior: 'on' });
    addEntity(house, { entityId: 'select.garage_door_opener_power_on_behavior', name: 'Garage Door Opener power on', deviceId: 'dev_gdo', integration: 'kasa', transport: 'wifi', state: 'on', attributes: { options: ['on', 'previous'] } });
    const r = rig(house);
    const ck = await runCheckup({ focus: 'power' }, r.deps);
    const finding = ck.output.findings.find((f) => f.kind === 'power_on_default');
    const { plan, output } = await planRepair({ kind: 'issue', session: ck.session, issue_id: finding?.issue_id ?? '' }, r.deps);
    valid(output);
    expect(plan.steps).toHaveLength(14);
    expect(plan.steps.some((s) => s.op.kind === 'select_option' && s.op.entity_id.startsWith('select.garage_door'))).toBe(false);
    expect(output.protected_conflicts).toEqual(["I'll leave the garage door opener alone."]);
  });
});

describe('plans from checkup findings', () => {
  it('renames the Hue group for the duplicate name', async () => {
    const r = rig();
    const ck = await runCheckup({}, r.deps);
    const finding = ck.output.findings.find((f) => f.kind === 'duplicate_name');
    const { plan, output } = await planRepair({ kind: 'issue', session: ck.session, issue_id: finding?.issue_id ?? '' }, r.deps);
    valid(output);
    expect(plan.cause_id).toBe('name_collision');
    expect(plan.steps.map((s) => s.label)).toEqual(['Rename the Hue group to Living Room Light Group']);
    expect(output.diff_lines).toEqual(['The Hue group will be called Living Room Light Group, so Living Room Light means one device.']);
    expect(plan.steps[0]?.inverse?.op).toEqual({ kind: 'registry_update', entity_id: 'light.living_room_light', patch: { name: 'Living Room Light' } });
    expect((await executePlan(plan, r.deps)).state).toBe('applied');
    expect(r.house.entities.get('light.living_room_light')?.name).toBe('Living Room Light Group');
  });

  it('turns off an automation that points at a removed device, with consent and an inverse', async () => {
    const house = buildGoldenHouse();
    addEntity(house, {
      entityId: 'automation.grow_light_schedule',
      name: 'Grow Light Schedule',
      integration: 'automation',
      transport: 'virtual',
      state: 'on',
      attributes: { id: 'grow_light_schedule', entity_ids: ['switch.grow_light_plug'] },
    });
    const r = rig(house);
    const ck = await runCheckup({ focus: 'automations' }, r.deps);
    expect(ck.output.findings.map((f) => f.title)).toEqual(['Grow Light Schedule uses a removed device']);
    const { plan } = await planRepair({ kind: 'issue', session: ck.session, issue_id: ck.output.findings[0]?.issue_id ?? '' }, r.deps);
    expect(plan.steps[0]).toMatchObject({
      op: { kind: 'call_service', domain: 'automation', service: 'turn_off', entity_id: 'automation.grow_light_schedule' },
      inverse: { op: { kind: 'call_service', service: 'turn_on' } },
    });
  });

  it('refuses findings it cannot fix and unknown issue ids', async () => {
    const r = rig();
    const ck = await runCheckup({}, r.deps);
    const battery = ck.output.findings.find((f) => f.kind === 'low_battery');
    await expect(planRepair({ kind: 'issue', session: ck.session, issue_id: battery?.issue_id ?? '' }, r.deps)).rejects.toMatchObject({ code: 'no_fix' });
    await expect(planRepair({ kind: 'issue', session: ck.session, issue_id: 'iss_000000000000000000' }, r.deps)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('never plans on a lock', async () => {
    const r = rig();
    addEntity(r.house, { entityId: 'lock.front_door', name: 'Front Door', integration: 'matter', transport: 'thread', state: 'locked' });
    addEntity(r.house, { entityId: 'lock.front_door_2', name: 'Front Door', integration: 'matter', transport: 'thread', state: 'locked' });
    const session: CheckupSession = {
      type: 'checkup',
      version: 1,
      checkup_id: 'chk_01m5098trrwqn6nph9',
      created_at: '2026-10-15T17:20:00.000Z',
      findings: [
        {
          finding: { issue_id: 'iss_01m5098trrwqn6nph9', kind: 'duplicate_name', severity: 'high', title: 'Two locks answer to Front Door', detail: '', entity_ids: ['lock.front_door', 'lock.front_door_2'], fixable: true },
          evidence: [],
          repair: { cause_id: 'name_collision', entity_ids: ['lock.front_door', 'lock.front_door_2'] },
        },
      ],
    };
    await expect(planRepair({ kind: 'issue', session, issue_id: 'iss_01m5098trrwqn6nph9' }, r.deps)).rejects.toMatchObject({ code: 'unsafe_device' });
  });
});

describe('diagnoses without an automatic fix', () => {
  it('says what the person can do instead', async () => {
    const r = rig();
    const dx = await startDiagnosis({ symptom: 'the kitchen plug keeps dropping off' }, r.deps);
    await expect(planRepair({ kind: 'diagnosis', session: dx.session }, r.deps)).rejects.toMatchObject({
      code: 'no_fix',
      speech:
        "I can't fix that one by myself. Moving the kitchen plug closer to the hub or router, or adding a plugged in repeater nearby, usually fixes this. I'll check on it tomorrow morning.",
    });
    expect(dx.session.guided_check?.kind).toBe('flaps');
  });
});

describe('undo speech for every plan kind', () => {
  async function applyAndUndo(r: Rig, plan: RepairPlan): Promise<string> {
    const applied = await executePlan(plan, r.deps);
    expect(applied.state).toBe('applied');
    const undone = await undoPlan(plan, applied.applied, r.deps);
    expect(undone.ok).toBe(true);
    expect(ToolOutputs.undo.safeParse({
      speech: undone.speech, status: 'ok', view: 'repair_card', ids: { repair_id: 'rep_01m5098trrwqn6nph9', plan_id: plan.plan_id },
      source: { adapter: 'simhome', simulated: true }, repair_id: 'rep_01m5098trrwqn6nph9', plan_id: plan.plan_id, state: 'undone', steps: undone.steps, undo_available: false,
    }).success).toBe(true);
    return undone.speech;
  }

  it('stale duplicate names the device', async () => {
    const r = rig();
    const { plan } = await planRepair({ kind: 'diagnosis', session: await confirmedLamp(r) }, r.deps);
    expect(await applyAndUndo(r, plan)).toBe('Undone. Hallway Lamp is back the way it was before the fix.');
  });

  it('a single power on setting is one setting', async () => {
    const r = rig();
    const dx = await startDiagnosis({ symptom: 'the porch light keeps turning on by itself at night' }, r.deps);
    const { plan } = await planRepair({ kind: 'diagnosis', session: dx.session }, r.deps);
    expect(plan.steps).toHaveLength(1);
    expect(await applyAndUndo(r, plan)).toBe('Undone. That power on setting is back the way it was.');
  });

  it('fourteen power on settings are counted', async () => {
    const r = rig();
    expect(await applyAndUndo(r, await powerPlan(r))).toBe('Undone. Those fourteen power on settings are back the way they were.');
  });

  it('a rename names the device', async () => {
    const r = rig();
    const ck = await runCheckup({}, r.deps);
    const finding = ck.output.findings.find((f) => f.kind === 'duplicate_name');
    const { plan } = await planRepair({ kind: 'issue', session: ck.session, issue_id: finding?.issue_id ?? '' }, r.deps);
    expect(await applyAndUndo(r, plan)).toBe('Undone. Living Room Light is back the way it was before the fix.');
  });

  it('a dead trigger names the automation', async () => {
    const house = buildGoldenHouse();
    addEntity(house, { entityId: 'automation.grow_light_schedule', name: 'Grow Light Schedule', integration: 'automation', transport: 'virtual', state: 'on', attributes: { id: 'grow', entity_ids: ['switch.grow_light_plug'] } });
    const r = rig(house);
    const ck = await runCheckup({ focus: 'automations' }, r.deps);
    const { plan } = await planRepair({ kind: 'issue', session: ck.session, issue_id: ck.output.findings[0]?.issue_id ?? '' }, r.deps);
    expect(await applyAndUndo(r, plan)).toBe('Undone. Grow Light Schedule is back the way it was before the fix.');
    expect(r.house.entities.get('automation.grow_light_schedule')?.state).toBe('on');
  });

  it('reconnecting a hub has nothing to undo, and says so', async () => {
    const house = buildGoldenHouse();
    for (const e of house.entities.values()) if (e.integration === 'zigbee2mqtt') e.state = 'unavailable';
    const z2m = house.integrations.find((i) => i.integration === 'zigbee2mqtt');
    if (z2m) z2m.state = 'setup_retry';
    addEntity(house, { entityId: 'light.attic_light', name: 'Attic Light', integration: 'zigbee2mqtt', transport: 'zigbee', state: 'unavailable' });
    const r = rig(house);
    const dx = await startDiagnosis({ symptom: "the attic light isn't responding" }, r.deps);
    const { plan } = await planRepair({ kind: 'diagnosis', session: dx.session }, r.deps);
    expect(plan.cause_id).toBe('hub_down');
    expect(await applyAndUndo(r, plan)).toBe("There's nothing to undo. That fix didn't change any settings.");
  });
});
