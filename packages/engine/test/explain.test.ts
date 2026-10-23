// Golden path step 5: explain_event names the power restore with
// numbers computed from the events, says it can't tell once the outage rows are gone, and names the
// automation when the changes carry its context.

import { describe, expect, it } from 'vitest';
import { ToolOutputs, type ExplainEventOutput } from '@fixwright/protocol';
import { answerDiagnosis, executePlan, explainEvent, planRepair, startDiagnosis } from '../src/index.ts';
import { addEntity, addEvent, emptyHouse, type FakeHouse } from './support/fake-adapter.ts';
import { buildGoldenHouse, rig, type Rig } from './support/golden-house.ts';

const QUESTION = 'Why did every plug turn on at 3 a.m.?';
const GOLDEN =
  'Power came back at 3:12. Fourteen devices restarted within four seconds. None of your automations fired. I can make them remember whether they were on or off. Do it?';

function valid(output: ExplainEventOutput): void {
  const r = ToolOutputs.explain_event.safeParse(output);
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues, null, 2)).toBe(true);
}

interface OutageOptions {
  count: number;
  integrations: string[];
  /** When power came back, UTC. */
  backAt: string;
  spacingMs: number;
}

/** A house where `count` plugs lose power together and come back on with no context. */
function outageHouse(o: OutageOptions): FakeHouse {
  const h = emptyHouse();
  h.integrations = o.integrations.map((integration) => ({ integration, state: 'loaded' as const }));
  const back = Date.parse(o.backAt);
  for (let i = 0; i < o.count; i++) {
    const id = `switch.plug_${i + 1}`;
    const integration = o.integrations[i % o.integrations.length] ?? 'kasa';
    addEntity(h, { entityId: id, name: `Plug ${i + 1}`, integration, transport: 'wifi', deviceId: `dev_${i}`, state: 'on' }, { powerOnBehavior: 'on' });
    addEntity(h, { entityId: `select.plug_${i + 1}_power_on_behavior`, name: `Plug ${i + 1} Power-on behavior`, deviceId: `dev_${i}`, integration, transport: 'wifi', state: 'on', attributes: { options: ['on', 'off', 'previous'] } });
    addEvent(h, { ts: new Date(back - 2000 + i * 10).toISOString(), kind: 'availability', entityId: id, from: 'off', to: 'unavailable' });
    addEvent(h, { ts: new Date(back + i * o.spacingMs).toISOString(), kind: 'availability', entityId: id, from: 'unavailable', to: 'off' });
    addEvent(h, { ts: new Date(back + i * o.spacingMs + 300).toISOString(), kind: 'state', entityId: id, from: 'off', to: 'on' });
  }
  return h;
}

describe('explain_event: power restore', () => {
  it('says the golden sentences, confirmed', async () => {
    const r = rig();
    const { output, session } = await explainEvent({ question: QUESTION }, r.deps);
    valid(output);
    expect(output.speech).toBe(GOLDEN);
    expect(output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'power_restore', label: 'Power came back on', fix_available: true });
    expect(output.verdict.claims.map((c) => c.text)).toEqual([
      'Power came back at 3:12.',
      'Fourteen devices restarted within four seconds.',
      'None of your automations fired.',
    ]);
    expect(output.suggested_fix?.label).toBe('Make them remember whether they were on or off');
    expect(output.ids.issue_id).toBe(output.suggested_fix?.issue_id);
    expect(session.suggested_fix?.entity_ids).toHaveLength(14);
    expect(session.window.label).toBe('around 3');
  });

  it('backs each claim with the right events', async () => {
    const r = rig();
    const { output } = await explainEvent({ question: QUESTION }, r.deps);
    const bySeq = new Map(r.ledger.all().map((e) => [e.seq, e]));
    const [back, restarted, none] = output.verdict.claims;
    expect(back?.evidence.map((s) => bySeq.get(s)?.ts)).toEqual(['2026-10-15T10:12:00.000Z']);
    const restartedEvents = (restarted?.evidence ?? []).map((s) => bySeq.get(s));
    expect(new Set(restartedEvents.map((e) => e?.entityId)).size).toBe(14);
    expect(restartedEvents.every((e) => e?.from === 'unavailable')).toBe(true);
    const onEvents = (none?.evidence ?? []).map((s) => bySeq.get(s));
    expect(onEvents.every((e) => e?.to === 'on' && e.context === undefined)).toBe(true);
  });

  it('builds a timeline in time order: out, back, restarted, on', async () => {
    const r = rig();
    const { output } = await explainEvent({ question: QUESTION }, r.deps);
    expect(output.timeline.map((t) => t.label)).toEqual([
      'Power went out',
      'Power came back',
      'Fourteen devices restarted within four seconds',
      'They came back on with no automation or app command',
    ]);
    expect(output.timeline[0]?.ts).toBe('2026-10-15T10:11:58.000Z');
  });

  it('computes the count, the span and the time from the events', async () => {
    const house = outageHouse({ count: 7, integrations: ['kasa', 'matter'], backAt: '2026-10-15T10:47:00.000Z', spacingMs: 900 });
    const r = rig(house);
    const { output } = await explainEvent({ question: 'why did all my plugs come on at 3 am' }, r.deps);
    valid(output);
    expect(output.verdict.level).toBe('confirmed');
    expect(output.speech).toBe(
      'Power came back at 3:47. Seven devices restarted within six seconds. None of your automations fired. I can make them remember whether they were on or off. Do it?',
    );
  });

  it('reads "last night" and then says a.m.', async () => {
    const r = rig();
    const { output } = await explainEvent({ question: 'What happened last night? Everything turned on.' }, r.deps);
    expect(output.verdict.claims[0]?.text).toBe('Power came back at 3:12 a.m.');
  });

  it('uses a mains power event as the evidence for the time when there is one', async () => {
    const r = rig(buildGoldenHouse({ powerEvents: true }));
    const { output } = await explainEvent({ question: QUESTION }, r.deps);
    const bySeq = new Map(r.ledger.all().map((e) => [e.seq, e]));
    expect(output.verdict.claims[0]?.evidence.map((s) => bySeq.get(s)?.kind)).toEqual(['power']);
    expect(output.verdict.confidence).toBeGreaterThan(0.98);
  });

  it('honours an explicit since and until', async () => {
    const r = rig();
    const { output } = await explainEvent({ question: 'why did that happen', since: '2026-10-15T03:00:00-07:00', until: '2026-10-15T04:00:00-07:00' }, r.deps);
    expect(output.verdict.cause_id).toBe('power_restore');
  });

  it('needs at least five devices and two integrations', async () => {
    const few = rig(outageHouse({ count: 4, integrations: ['kasa', 'matter'], backAt: '2026-10-15T10:12:00.000Z', spacingMs: 200 }));
    expect((await explainEvent({ question: QUESTION }, few.deps)).output.verdict.cause_id).not.toBe('power_restore');
    const oneHub = rig(outageHouse({ count: 9, integrations: ['kasa'], backAt: '2026-10-15T10:12:00.000Z', spacingMs: 200 }));
    expect((await explainEvent({ question: QUESTION }, oneHub.deps)).output.verdict.cause_id).not.toBe('power_restore');
  });

  it('only offers the fix for devices whose power on setting is on', async () => {
    const house = buildGoldenHouse();
    for (const [id, s] of house.signals) if (s.powerOnBehavior === 'on') house.signals.set(id, { ...s, powerOnBehavior: 'previous' });
    const r = rig(house);
    const { output } = await explainEvent({ question: QUESTION }, r.deps);
    valid(output);
    expect(output.suggested_fix).toBeUndefined();
    expect(output.speech).toBe('Power came back at 3:12. Fourteen devices restarted within four seconds. None of your automations fired.');
  });
});

describe('explain_event: SimHome and Matter shaped rows', () => {
  it('reads devices that come back already on, and Matter boot reasons as restarts', async () => {
    const h = emptyHouse();
    h.integrations = [
      { integration: 'zigbee2mqtt', state: 'loaded' },
      { integration: 'matter', state: 'loaded' },
    ];
    const back = Date.parse('2026-10-15T10:12:01.000Z');
    for (let i = 0; i < 6; i++) {
      const id = `light.lamp_${i + 1}`;
      const integration = i < 3 ? 'zigbee2mqtt' : 'matter';
      addEntity(h, { entityId: id, name: `Lamp ${i + 1}`, integration, transport: i < 3 ? 'zigbee' : 'thread', deviceId: `d${i}`, state: 'on' }, { powerOnBehavior: 'on' });
      addEntity(h, { entityId: `select.lamp_${i + 1}_power_on_behavior`, name: `Lamp ${i + 1} power on`, deviceId: `d${i}`, integration, transport: 'zigbee', state: 'on', attributes: { options: ['on', 'previous'] } });
      addEvent(h, { ts: new Date(back - 3000).toISOString(), kind: 'availability', entityId: id, from: 'off', to: 'unavailable' });
      if (integration === 'matter') {
        addEvent(h, { ts: new Date(back + i * 300 - 200).toISOString(), kind: 'power', entityId: id, data: { event: 'boot_reason', reason: 'PowerOnReboot', cluster: 'GeneralDiagnostics' } });
      }
      addEvent(h, { ts: new Date(back + i * 300).toISOString(), kind: 'availability', entityId: id, from: 'unavailable', to: 'on' });
    }
    const r = rig(h);
    const { output } = await explainEvent({ question: QUESTION }, r.deps);
    valid(output);
    expect(output.speech).toBe(
      'Power came back at 3:12. Six devices restarted within two seconds. None of your automations fired. I can make them remember whether they were on or off. Do it?',
    );
    expect(output.verdict.confidence).toBeGreaterThan(0.98);
  });
});

describe('explain_event: when it is not a power restore', () => {
  it("can't tell once the outage rows are gone, and says what it saw", async () => {
    const r = rig(buildGoldenHouse({ withoutOutage: true }));
    const { output } = await explainEvent({ question: QUESTION }, r.deps);
    valid(output);
    expect(output.verdict).toMatchObject({ level: 'cant_tell', cause_id: 'unknown', fix_available: false });
    expect(output.speech).toBe(
      'I see fourteen devices turned on at 3:12, but nothing in the log says why. If it happens again, ask me right away while the log is fresh.',
    );
    expect(output.suggested_fix).toBeUndefined();
  });

  it('names the automation and its trigger when the changes carry its context', async () => {
    const r = rig(buildGoldenHouse({ automationContext: 'night_lights' }));
    const { output } = await explainEvent({ question: QUESTION }, r.deps);
    valid(output);
    expect(output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'automation_trigger' });
    expect(output.speech).toBe('Your automation Night Lights switched fourteen devices at 3:12. It ran because of the time reaching 3:12 a.m.');
  });

  it('says someone used the app when the change carries a user', async () => {
    const r = rig();
    r.house.events.push({
      seq: 0,
      ts: '2026-10-15T14:02:10.000Z',
      kind: 'state',
      entityId: 'light.porch_light',
      from: 'on',
      to: 'off',
      source: 'home',
      context: { userId: 'household_member' },
    });
    const { output } = await explainEvent({ question: 'Why did the porch light go off at 7 a.m.?' }, r.deps);
    valid(output);
    expect(output.verdict.cause_id).toBe('user_action');
    expect(output.speech).toBe('Someone switched the porch light from the app at 7:02.');
  });

  it("says it can't tell when nothing happened in the window", async () => {
    const r = rig();
    const { output } = await explainEvent({ question: 'Why did the porch light turn on yesterday at 5 p.m.?' }, r.deps);
    valid(output);
    expect(output.verdict.level).toBe('cant_tell');
    expect(output.speech).toBe("I can't tell what happened. Nothing in the log explains it. If it happens again, ask me right away while the log is fresh.");
  });

  it('copies each home event into the ledger once, however often it is asked', async () => {
    const r = rig();
    await explainEvent({ question: QUESTION }, r.deps);
    const after1 = r.ledger.all().filter((e) => e.source === 'home').length;
    await explainEvent({ question: QUESTION }, r.deps);
    expect(r.ledger.all().filter((e) => e.source === 'home').length).toBe(after1);
  });
});

/** Golden path steps 1 to 3: diagnose the hallway lamp, answer yes, plan and apply the fix (flash test plus flash check). */
async function goldenSteps(r: Rig): Promise<void> {
  const dx = await startDiagnosis({ symptom: "Why the hallway lamp keeps saying it's not responding" }, r.deps);
  const q = dx.output.question;
  if (!q) throw new Error('expected the flash question');
  // The person takes a moment to answer and to say yes to the fix.
  r.clock.set(new Date(r.clock.nowMs() + 20_000).toISOString());
  const yes = await answerDiagnosis(dx.session, { diagnosis_id: dx.session.diagnosis_id, question_id: q.question_id, answer: 'yes' }, r.deps);
  r.clock.set(new Date(r.clock.nowMs() + 30_000).toISOString());
  const plan = await planRepair({ kind: 'diagnosis', session: yes.session }, r.deps);
  expect((await executePlan(plan.plan, r.deps)).state).toBe('applied');
}

describe("explain_event: Fixwright's own writes are not a person", () => {
  it('says it was its own flash test, not someone using the app', async () => {
    const r = rig();
    await startDiagnosis({ symptom: "the kitchen ceiling isn't responding" }, r.deps);
    expect(r.house.calls.length).toBeGreaterThan(0);
    const { output } = await explainEvent({ question: 'what happened this morning' }, r.deps);
    valid(output);
    expect(output.speech).toBe('That was me. I switched the kitchen ceiling at 10:20 to test it.');
    expect(output.speech).not.toMatch(/someone|app/i);
    expect(output.verdict).toMatchObject({ level: 'confirmed', label: 'Fixwright switched it' });
    // The claim cites the home rows and the probe row that made them.
    const cited = (output.verdict.claims[0]?.evidence ?? []).map((seq) => r.ledger.all().find((e) => e.seq === seq));
    expect(cited.some((e) => e?.kind === 'probe' && e.data?.['probe_id'] === 'flash_test')).toBe(true);
    expect(cited.filter((e) => e?.source === 'home').every((e) => e?.entityId === 'light.kitchen_ceiling')).toBe(true);
  });

  it('names the test and the repair check after golden steps 1 to 3', async () => {
    const r = rig();
    await goldenSteps(r);
    const { output } = await explainEvent({ question: 'why did the hallway lamp turn on just now?' }, r.deps);
    valid(output);
    expect(output.speech).toBe('That was me. I switched the hallway lamp at 10:20 to test it and to check the fix.');
  });

  it('still says someone used the app when a person switched it after the test', async () => {
    const r = rig();
    await startDiagnosis({ symptom: "the kitchen ceiling isn't responding" }, r.deps);
    r.clock.set('2026-10-15T17:26:00.000Z');
    addEvent(r.house, { ts: '2026-10-15T17:24:30.000Z', kind: 'state', entityId: 'light.kitchen_ceiling', from: 'off', to: 'on', context: { userId: 'household_member' } });
    const { output } = await explainEvent({ question: 'why did the kitchen ceiling turn on just now?' }, r.deps);
    valid(output);
    expect(output.verdict.cause_id).toBe('user_action');
    expect(output.speech).toBe('Someone switched the kitchen ceiling from the app at 10:24.');
  });

  it('"at 3" with no a.m. or p.m. skips an hour that holds only its own writes (the SimHome seed 1 repro)', async () => {
    // 15:30 household time: the flash test and the repair check land in the 3 p.m. hour.
    const r = rig(buildGoldenHouse(), {}, '2026-10-15T22:30:00.000Z');
    await goldenSteps(r);
    const { output } = await explainEvent({ question: 'Why did every plug turn on at 3?' }, r.deps);
    valid(output);
    expect(output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'power_restore' });
    expect(output.speech).toBe(
      'Power came back at 3:12 a.m. Fourteen devices restarted within four seconds. None of your automations fired. I can make them remember whether they were on or off. Do it?',
    );
  });

  it('"at 3" takes the most recent 3 o\'clock when a person did something in it', async () => {
    const r = rig(buildGoldenHouse(), {}, '2026-10-15T22:30:00.000Z');
    addEvent(r.house, { ts: '2026-10-15T22:05:00.000Z', kind: 'state', entityId: 'light.porch_light', from: 'off', to: 'on', context: { userId: 'household_member' } });
    const { output } = await explainEvent({ question: 'Why did the porch light turn on at 3?' }, r.deps);
    valid(output);
    expect(output.speech).toBe('Someone switched the porch light from the app at 3:05 p.m.');
  });
});

describe('explain_event: the device the question names', () => {
  it('says a named device was not part of the restore instead of telling the restore story', async () => {
    const r = rig();
    const { output } = await explainEvent({ question: 'why did the kitchen plug turn on at 3 a.m.?' }, r.deps);
    valid(output);
    expect(output.speech).toMatch(/^The kitchen plug wasn't one of the fourteen devices that restarted when power came back at 3:12\./);
    expect(output.speech).not.toMatch(/None of your automations fired|Do it\?/);
    expect(output.verdict.cause_id).not.toBe('power_restore');
    expect(output.suggested_fix).toBeUndefined();
  });

  it('says a named device was one of them when it was', async () => {
    const r = rig();
    const { output } = await explainEvent({ question: 'why did the porch light turn on at 3 a.m.?' }, r.deps);
    valid(output);
    expect(output.verdict.cause_id).toBe('power_restore');
    expect(output.speech).toBe(
      'Power came back at 3:12. Fourteen devices restarted within four seconds. The porch light was one of them. None of your automations fired. I can make them remember whether they were on or off. Do it?',
    );
  });

  it('does not read the hour as a device number, or "every plug" as one device', async () => {
    const h = buildGoldenHouse();
    addEntity(h, { entityId: 'switch.plug_3', name: 'Plug 3', integration: 'kasa', transport: 'wifi', state: 'off' });
    const r = rig(h);
    const { output } = await explainEvent({ question: 'why did all my plugs come on at 3 am' }, r.deps);
    expect(output.speech).toMatch(/^Power came back at 3:12\. Fourteen devices restarted within four seconds\. None/);
  });
});

describe('explain_event: device numbers, own writes and "at 3"', () => {
  /** The golden house plus Plug 3, which a person switched on from the app at 8:05 a.m. (not part of the restore). */
  function plugHouse() {
    const h = buildGoldenHouse();
    addEntity(h, { entityId: 'switch.plug_3', name: 'Plug 3', integration: 'kasa', transport: 'wifi', state: 'on' });
    addEvent(h, { ts: '2026-10-15T15:05:00.000Z', kind: 'state', entityId: 'switch.plug_3', from: 'off', to: 'on', context: { userId: 'household_member' } });
    return h;
  }

  it('"why did plug 3 turn on?" is about plug 3, not the restore', async () => {
    const r = rig(plugHouse());
    const { output } = await explainEvent({ question: 'why did plug 3 turn on?' }, r.deps);
    valid(output);
    expect(output.verdict.cause_id).toBe('user_action');
    expect(output.suggested_fix).toBeUndefined();
    expect(output.speech).toBe(
      "Plug 3 wasn't one of the fourteen devices that restarted when power came back at 3:12 a.m. Someone switched plug 3 from the app at 8:05 a.m.",
    );
  });

  it('"why did plug 3 turn on at 3 am?" reads the hour as the time and plug 3 as the device', async () => {
    const r = rig(plugHouse());
    const { output } = await explainEvent({ question: 'why did plug 3 turn on at 3 am?' }, r.deps);
    valid(output);
    expect(output.verdict.cause_id).not.toBe('power_restore');
    expect(output.suggested_fix).toBeUndefined();
    expect(output.speech).toMatch(/^Plug 3 wasn't one of the fourteen devices that restarted when power came back at 3:12\. I can't tell what happened\./);
  });

  it('"at 3" picks the hour of its own flash when the question names the device it flashed', async () => {
    const r = rig(buildGoldenHouse(), {}, '2026-10-15T22:30:00.000Z');
    await goldenSteps(r);
    const { output } = await explainEvent({ question: 'why did the hallway lamp turn on at 3?' }, r.deps);
    valid(output);
    expect(output.speech).toBe('That was me. I switched the hallway lamp at 3:30 p.m. to test it and to check the fix.');
  });

  it('"why did it blink?" is the latest change, even for a device that was part of the restore', async () => {
    const r = rig();
    await startDiagnosis({ symptom: "the porch light isn't responding" }, r.deps);
    expect(r.house.calls.some((c) => c.data['entity_id'] === 'light.porch_light')).toBe(true);
    const { output } = await explainEvent({ question: 'why did the porch light blink?' }, r.deps);
    valid(output);
    expect(output.speech).toBe('That was me. I switched the porch light at 10:20 a.m. to test it.');
    expect(output.suggested_fix).toBeUndefined();
    // Asked without "blink", the restore is still the story for that device.
    const restore = await explainEvent({ question: 'why did the porch light turn on at 3 a.m.?' }, r.deps);
    expect(restore.output.verdict.cause_id).toBe('power_restore');
  });

  it('"at 3" with nothing about the device in either hour takes the hour with something going on in the house', async () => {
    const h = buildGoldenHouse();
    addEntity(h, { entityId: 'switch.desk_fan', name: 'Desk Fan', integration: 'kasa', transport: 'wifi', state: 'off' });
    const r = rig(h, {}, '2026-10-15T22:30:00.000Z');
    const { output } = await explainEvent({ question: 'why did the desk fan turn on at 3?' }, r.deps);
    valid(output);
    // Before: the 3 p.m. hour, cut at 3:30 p.m., with "Nothing in the log explains it."
    expect(output.speech).toMatch(/^The desk fan wasn't one of the fourteen devices that restarted when power came back at 3:12 a\.m\./);
  });
});

describe('explain_event: numbered names, the next morning and a partial power fix', () => {
  /** The golden house plus Outlet 12, which a person switched on from the app at 12:05 a.m. (not part of the restore). */
  function outletHouse() {
    const h = buildGoldenHouse();
    addEntity(h, { entityId: 'switch.outlet_12', name: 'Outlet 12', integration: 'kasa', transport: 'wifi', state: 'on' });
    addEvent(h, { ts: '2026-10-15T07:05:00.000Z', kind: 'state', entityId: 'switch.outlet_12', from: 'off', to: 'on', context: { userId: 'household_member' } });
    return h;
  }

  it('"why did outlet 12 turn on?" keeps the 12 as part of the name', async () => {
    const r = rig(outletHouse());
    const { output } = await explainEvent({ question: 'why did outlet 12 turn on?' }, r.deps);
    valid(output);
    expect(output.verdict.cause_id).toBe('user_action');
    expect(output.suggested_fix).toBeUndefined();
    expect(output.speech).toBe(
      "Outlet 12 wasn't one of the fourteen devices that restarted when power came back at 3:12 a.m. Someone switched outlet 12 from the app at 12:05 a.m.",
    );
  });

  it('"why did outlet 12 turn on at 12?" reads the second 12 as the time', async () => {
    const r = rig(outletHouse());
    const { output, session } = await explainEvent({ question: 'why did outlet 12 turn on at 12?' }, r.deps);
    valid(output);
    expect(session.window.since).toBe('2026-10-15T07:00:00.000Z');
    expect(output.speech).toBe('Someone switched outlet 12 from the app at 12:05 a.m.');
  });

  it('"why did hallway lamp 2 turn on at 3 a.m.?" is about the numbered copy, not the restore as a whole', async () => {
    const h = buildGoldenHouse();
    const twin = h.entities.get('light.hallway_lamp_2');
    if (twin) twin.name = 'Hallway Lamp 2';
    // A person switched it on from the app at 3:40 a.m., after the restore (which it was not part of).
    addEvent(h, { ts: '2026-10-15T10:40:00.000Z', kind: 'state', entityId: 'light.hallway_lamp_2', from: 'off', to: 'on', context: { userId: 'household_member' } });
    const r = rig(h);
    const { output } = await explainEvent({ question: 'why did hallway lamp 2 turn on at 3 a.m.?' }, r.deps);
    valid(output);
    expect(output.verdict.cause_id).toBe('user_action');
    expect(output.suggested_fix).toBeUndefined();
    expect(output.speech).toBe(
      "Hallway lamp 2 wasn't one of the fourteen devices that restarted when power came back at 3:12. Someone switched hallway lamp 2 from the app at 3:40.",
    );
  });

  it('"at 3 a.m." asked the next morning, after a quiet night, still finds the outage night', async () => {
    const r = rig();
    await goldenSteps(r);
    r.clock.set('2026-10-16T14:00:00.000Z'); // 07:00 on 16 October in Los Angeles
    const { output, session } = await explainEvent({ question: QUESTION }, r.deps);
    valid(output);
    expect(session.window.since).toBe('2026-10-15T10:00:00.000Z');
    expect(output.speech).toBe(GOLDEN);
    // "at 3" with no a.m. or p.m. says which 3 o'clock it was.
    const at3 = await explainEvent({ question: 'Why did every plug turn on at 3?' }, r.deps);
    expect(at3.output.speech).toMatch(/^Power came back at 3:12 a\.m\. Fourteen devices restarted/);
  });

  it('"at 3 a.m." takes the most recent night when both nights had something', async () => {
    const h = buildGoldenHouse();
    // A person switched the porch light at 3:30 a.m. on 16 October, the night after the outage.
    addEvent(h, { ts: '2026-10-16T10:30:00.000Z', kind: 'state', entityId: 'light.porch_light', from: 'off', to: 'on', context: { userId: 'household_member' } });
    const r = rig(h, {}, '2026-10-16T14:00:00.000Z');
    const { output, session } = await explainEvent({ question: 'why did the porch light turn on at 3 a.m.?' }, r.deps);
    valid(output);
    expect(session.window.since).toBe('2026-10-16T10:00:00.000Z');
    expect(output.speech).toBe('Someone switched the porch light from the app at 3:30.');
  });

  it('nothing at 3 a.m. in the last 48 hours: the most recent 3 a.m., and an honest can\'t tell', async () => {
    const r = rig(buildGoldenHouse(), {}, '2026-10-17T14:00:00.000Z'); // 07:00 on 17 October: the outage is 52 hours back
    const { output, session } = await explainEvent({ question: QUESTION }, r.deps);
    valid(output);
    expect(session.window.since).toBe('2026-10-17T10:00:00.000Z');
    expect(output.verdict.level).toBe('cant_tell');
    expect(output.suggested_fix).toBeUndefined();
  });

  it('says how many of the restarted devices the fix covers when only some have a power on setting', async () => {
    const h = outageHouse({ count: 9, integrations: ['kasa', 'matter'], backAt: '2026-10-15T10:12:00.000Z', spacingMs: 100 });
    // Plugs 7 to 9 have no power on setting at all.
    for (const i of [7, 8, 9]) {
      h.entities.delete(`select.plug_${i}_power_on_behavior`);
      h.signals.set(`switch.plug_${i}`, {});
    }
    const r = rig(h);
    const { output, session } = await explainEvent({ question: QUESTION }, r.deps);
    valid(output);
    expect(output.speech).toBe(
      'Power came back at 3:12. Nine devices restarted within one second. None of your automations fired. Six of the nine can remember their last state. I can set those. Do it?',
    );
    const plan = await planRepair({ kind: 'explanation', session }, r.deps);
    expect(plan.plan.steps).toHaveLength(6);
  });

  it('counts only the settings the fix would change, and keeps the usual line when it covers every device', async () => {
    const h = outageHouse({ count: 9, integrations: ['kasa', 'matter'], backAt: '2026-10-15T10:12:00.000Z', spacingMs: 100 });
    // Plug 9 reports "on" but its select offers no option to remember the last state.
    const select = h.entities.get('select.plug_9_power_on_behavior');
    if (select) h.entities.set(select.entityId, { ...select, attributes: { options: ['on', 'off'] } });
    const partial = await explainEvent({ question: QUESTION }, rig(h).deps);
    expect(partial.output.speech).toMatch(/Eight of the nine can remember their last state\. I can set those\. Do it\?$/);
    const all = await explainEvent({ question: QUESTION }, rig(outageHouse({ count: 9, integrations: ['kasa', 'matter'], backAt: '2026-10-15T10:12:00.000Z', spacingMs: 100 })).deps);
    expect(all.output.speech).toMatch(/Nine devices restarted within one second\. None of your automations fired\. I can make them remember whether they were on or off\. Do it\?$/);
  });
});
