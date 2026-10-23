// Verification for fixes Fixwright cannot make itself, and the next morning check:
//   * a guided verdict schedules a check only when a sensor can answer it, and only then promises one
//   * each check kind (comes_back, flaps, cloud_back, link_back) stays pending, passes or fails from real
//     home state, records its result in the ledger and cites it
//   * a plan with nothing to verify gets no morning check and never a "Repair confirmed"

import { describe, expect, it } from 'vitest';
import { ToolOutputs, type DiagnoseOutput } from '@fixwright/protocol';
import {
  answerDiagnosis,
  evaluateGuidedCheck,
  executePlan,
  isVerifiable,
  morningCheck,
  morningCheckAt,
  planRepair,
  runCheckup,
  startDiagnosis,
  type DiagnosisResult,
  type GuidedCheck,
} from '../src/index.ts';
import { addEntity, addEvent, type FakeHouse } from './support/fake-adapter.ts';
import { buildGoldenHouse, NOW, rig, TZ, type Rig } from './support/golden-house.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number): string => new Date(Date.parse(NOW) + ms).toISOString();
const NEXT_7AM = '2026-10-16T14:00:00.000Z'; // 07:00 on 16 Oct in Los Angeles

function valid(output: DiagnoseOutput): void {
  const r = ToolOutputs.diagnose.safeParse(output);
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues, null, 2)).toBe(true);
}

async function diagnose(r: Rig, symptom: string, answers: string[] = []): Promise<DiagnosisResult> {
  let res = await startDiagnosis({ symptom }, r.deps);
  for (const answer of answers) {
    if (res.output.status !== 'needs_answer') break;
    res = await answerDiagnosis(res.session, { diagnosis_id: res.session.diagnosis_id, question_id: res.output.question?.question_id ?? '', answer }, r.deps);
  }
  valid(res.output);
  return res;
}

function checkOf(res: DiagnosisResult): GuidedCheck {
  const check = res.session.guided_check;
  if (!check) throw new Error('expected a guided check');
  return check;
}

const notes = (r: Rig) => r.ledger.all().filter((e) => e.kind === 'note' && e.data?.['check'] === 'guided');

/** The study lamp lost power two hours ago; nothing else about it is wrong. */
function studyLampHouse(): FakeHouse {
  const house = buildGoldenHouse();
  const off = at(-2 * HOUR);
  addEntity(
    house,
    { entityId: 'light.study_lamp', name: 'Study Lamp', area: 'Study', deviceId: 'dev_study_lamp', integration: 'zigbee2mqtt', transport: 'zigbee', vendor: 'IKEA', state: 'unavailable', lastChanged: off, lastUpdated: off },
    { linkQuality: 140 },
  );
  addEvent(house, { ts: off, kind: 'availability', entityId: 'light.study_lamp', from: 'off', to: 'unavailable' });
  return house;
}

function comeBack(house: FakeHouse, id: string, ts: string, state = 'off'): void {
  const e = house.entities.get(id);
  if (!e) throw new Error(`no ${id}`);
  e.state = state;
  e.lastChanged = ts;
  addEvent(house, { ts, kind: 'availability', entityId: id, from: 'unavailable', to: state });
}

describe('device_power_lost: checks that the device comes back', () => {
  it('promises the check only because it schedules one', async () => {
    const r = rig(studyLampHouse());
    const res = await diagnose(r, "the study lamp isn't responding");
    expect(res.output.verdict).toMatchObject({ cause_id: 'device_power_lost', fix_available: false });
    expect(res.output.speech.endsWith("Switch the study lamp back on at the wall, and I'll check that it comes back.")).toBe(true);
    expect(checkOf(res)).toEqual({
      kind: 'comes_back',
      cause_id: 'device_power_lost',
      diagnosis_id: res.session.diagnosis_id,
      entity_ids: ['light.study_lamp'],
      name: 'study lamp',
      since: NOW,
      check_at: at(5 * MIN),
      every_ms: 5 * MIN,
      until: at(2 * HOUR),
    });
    expect(JSON.parse(JSON.stringify(res.session)).guided_check).toEqual(res.session.guided_check);
  });

  it('stays pending until the lamp is back, then passes citing the comeback row', async () => {
    const r = rig(studyLampHouse());
    const check = checkOf(await diagnose(r, "the study lamp isn't responding"));
    const early = await evaluateGuidedCheck(check, r.deps);
    expect(early).toEqual({ result: 'pending', detail: "Not settled yet. I'll check again soon.", speech: '', next_check_at: at(5 * MIN), evidence: [] });
    r.clock.set(at(5 * MIN));
    expect(await evaluateGuidedCheck(check, r.deps)).toMatchObject({ result: 'pending', next_check_at: at(10 * MIN) });
    expect(notes(r)).toHaveLength(0);

    comeBack(r.house, 'light.study_lamp', at(7 * MIN));
    r.clock.set(at(10 * MIN));
    const done = await evaluateGuidedCheck(check, r.deps);
    expect(done.result).toBe('pass');
    expect(done.speech).toBe('The study lamp is back online.');
    const row = r.ledger.all().find((e) => e.entityId === 'light.study_lamp' && e.from === 'unavailable');
    const [note] = notes(r);
    expect(note?.data).toMatchObject({ check_kind: 'comes_back', result: 'pass', diagnosis_id: check.diagnosis_id, back: ['light.study_lamp'] });
    expect(done.evidence).toEqual([row?.seq, note?.seq]);
  });

  it('fails plainly once the window closes with the lamp still offline', async () => {
    const r = rig(studyLampHouse());
    const check = checkOf(await diagnose(r, "the study lamp isn't responding"));
    r.clock.set(check.until);
    const late = await evaluateGuidedCheck(check, r.deps);
    expect(late.result).toBe('fail');
    expect(late.speech).toBe("The study lamp still hasn't come back. Ask me about it again when you're next to it.");
    expect(late.evidence).toEqual([notes(r)[0]?.seq]);
  });

  it('promises nothing when no sensor can tell (the online copy already reports on, the old copy never returns)', async () => {
    const r = rig();
    const res = await diagnose(r, "Why the hallway lamp keeps saying it's not responding", ['nahi', 'no']);
    expect(res.output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'device_power_lost' });
    expect(res.session.guided_check).toBeUndefined();
    expect(res.output.speech.endsWith('Switch the hallway lamp back on at the wall.')).toBe(true);
    await expect(planRepair({ kind: 'diagnosis', session: res.session }, r.deps)).rejects.toMatchObject({
      code: 'no_fix',
      speech: "I can't fix that one by myself. Switch the hallway lamp back on at the wall.",
    });
  });
});

describe('radio_link_weak: counts the drops the next morning', () => {
  it('schedules one check at the next 07:00 and passes a quiet night', async () => {
    const r = rig();
    const res = await diagnose(r, 'the kitchen plug keeps dropping off');
    expect(res.output.speech.endsWith("usually fixes this. I'll check on it tomorrow morning.")).toBe(true);
    const check = checkOf(res);
    expect(check).toMatchObject({ kind: 'flaps', entity_ids: ['switch.kitchen_plug'], check_at: NEXT_7AM, until: NEXT_7AM, every_ms: 0, baseline: 9 });
    expect(await evaluateGuidedCheck(check, r.deps)).toMatchObject({ result: 'pending', next_check_at: NEXT_7AM });
    r.clock.set(NEXT_7AM);
    const morning = await evaluateGuidedCheck(check, r.deps);
    expect(morning.result).toBe('pass');
    expect(morning.speech).toBe('The kitchen plug stayed connected since yesterday, after dropping off 9 times the day before.');
  });

  it('counts only the drops after the advice, and cites each one', async () => {
    const r = rig();
    const check = checkOf(await diagnose(r, 'the kitchen plug keeps dropping off'));
    for (const ts of ['2026-10-15T22:00:00.000Z', '2026-10-16T02:00:00.000Z', '2026-10-16T09:30:00.000Z']) {
      addEvent(r.house, { ts, kind: 'availability', entityId: 'switch.kitchen_plug', from: 'on', to: 'unavailable' });
      addEvent(r.house, { ts: new Date(Date.parse(ts) + 2 * MIN).toISOString(), kind: 'availability', entityId: 'switch.kitchen_plug', from: 'unavailable', to: 'on' });
    }
    r.clock.set(NEXT_7AM);
    const morning = await evaluateGuidedCheck(check, r.deps);
    expect(morning.result).toBe('fail');
    expect(morning.speech).toBe('The kitchen plug dropped off 3 times since yesterday. A plugged in repeater near it should help.');
    const drops = r.ledger.all().filter((e) => e.entityId === 'switch.kitchen_plug' && e.to === 'unavailable' && Date.parse(e.ts) > Date.parse(NOW));
    expect(drops).toHaveLength(3);
    for (const d of drops) expect(morning.evidence).toContain(d.seq);
  });
});

describe('vendor_cloud_outage and account_link_expired: recheck until it is back', () => {
  function thermostatRig(): Rig {
    const house = buildGoldenHouse();
    house.cloud.set('ecobee', 'outage');
    addEntity(house, { entityId: 'climate.thermostat', name: 'Thermostat', integration: 'ecobee', transport: 'cloud', vendor: 'ecobee', state: 'unavailable', lastChanged: '2026-10-15T16:50:00.000Z' });
    return rig(house);
  }

  it('passes when the status page reports ok, naming the device only if it is online', async () => {
    const r = thermostatRig();
    const check = checkOf(await diagnose(r, "the thermostat isn't responding"));
    expect(check).toMatchObject({ kind: 'cloud_back', vendor: 'ecobee', brand: 'Ecobee', check_at: at(15 * MIN), every_ms: 15 * MIN, until: at(24 * HOUR) });
    r.clock.set(at(15 * MIN));
    expect(await evaluateGuidedCheck(check, r.deps)).toMatchObject({ result: 'pending', next_check_at: at(30 * MIN) });
    r.house.cloud.set('ecobee', 'ok');
    comeBack(r.house, 'climate.thermostat', at(40 * MIN), 'heat');
    r.clock.set(at(45 * MIN));
    expect(await evaluateGuidedCheck(check, r.deps)).toMatchObject({ result: 'pass', speech: 'The Ecobee cloud is back, and the thermostat is online again.' });
  });

  it('stops after a day and says so', async () => {
    const r = thermostatRig();
    const check = checkOf(await diagnose(r, "the thermostat isn't responding"));
    r.clock.set(check.until);
    expect(await evaluateGuidedCheck(check, r.deps)).toMatchObject({
      result: 'fail',
      speech: "The Ecobee cloud still reports a problem, so I'll stop checking for now. Ask me any time.",
    });
  });

  it('checks the account link loads again after the person signs in', async () => {
    const house = buildGoldenHouse();
    const hue = house.integrations.find((i) => i.integration === 'hue');
    if (hue) Object.assign(hue, { state: 'setup_error', reason: 'auth token expired' });
    addEntity(house, { entityId: 'light.den_lamp', name: 'Den Lamp', area: 'Den', deviceId: 'dev_den', integration: 'hue', transport: 'zigbee', vendor: 'Philips Hue', state: 'unavailable', lastChanged: at(-HOUR) }, { linkQuality: 160 });
    const r = rig(house);
    const res = await diagnose(r, "the den lamp isn't responding", ['yes']);
    expect(res.output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'account_link_expired' });
    expect(res.output.speech.endsWith("Sign in to that account again from its app, and I'll check the link.")).toBe(true);
    const check = checkOf(res);
    expect(check).toMatchObject({ kind: 'link_back', integration: 'hue' });
    r.clock.set(check.check_at);
    expect((await evaluateGuidedCheck(check, r.deps)).result).toBe('pending');
    if (hue) {
      hue.state = 'loaded';
      delete hue.reason;
    }
    expect(await evaluateGuidedCheck(check, r.deps)).toMatchObject({ result: 'pass', speech: 'Your Hue account is linked again.' });
  });
});

describe('wifi_network_changed: checks which devices come back', () => {
  function routerRig(): Rig {
    const house = buildGoldenHouse();
    for (const id of ['switch.coffee_maker', 'switch.tv_plug', 'switch.garden_lights']) {
      const e = house.entities.get(id);
      if (e) Object.assign(e, { state: 'unavailable', lastChanged: at(-HOUR) });
      addEvent(house, { ts: at(-HOUR), kind: 'availability', entityId: id, from: 'on', to: 'unavailable' });
    }
    return rig(house);
  }

  it('watches the target and its offline Wi-Fi peers for a day', async () => {
    const r = routerRig();
    const res = await diagnose(r, "the coffee maker isn't responding", ['yes']);
    expect(res.output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'wifi_network_changed' });
    expect(res.output.speech.endsWith("set from its maker's app. I'll check that they come back.")).toBe(true);
    const check = checkOf(res);
    expect(check).toMatchObject({ kind: 'comes_back', until: at(24 * HOUR) });
    expect([...check.entity_ids].sort()).toEqual(['switch.coffee_maker', 'switch.garden_lights', 'switch.tv_plug']);

    comeBack(r.house, 'switch.coffee_maker', at(20 * MIN), 'on');
    comeBack(r.house, 'switch.tv_plug', at(25 * MIN), 'on');
    r.clock.set(at(30 * MIN));
    expect((await evaluateGuidedCheck(check, r.deps)).result).toBe('pending');
    r.clock.set(check.until);
    const late = await evaluateGuidedCheck(check, r.deps);
    expect(late.result).toBe('fail');
    expect(late.speech).toBe("One of the three devices still hasn't come back. Ask me again when you're next to it.");
    comeBack(r.house, 'switch.garden_lights', check.until, 'on');
    expect(await evaluateGuidedCheck(check, r.deps)).toMatchObject({ result: 'pass', speech: 'All three devices are back online.' });
  });
});

describe('next morning check never invents a pass', () => {
  it('schedules nothing and confirms nothing for a rename (name collision)', async () => {
    const r = rig();
    const ck = await runCheckup({}, r.deps);
    const finding = ck.output.findings.find((f) => f.kind === 'duplicate_name');
    const { plan } = await planRepair({ kind: 'issue', session: ck.session, issue_id: finding?.issue_id ?? '' }, r.deps);
    expect(isVerifiable(plan)).toBe(false);
    const applied = await executePlan(plan, r.deps);
    expect(applied.speech).toBe('Done. I made the change and checked it.');
    expect(morningCheckAt(plan, r.clock.nowMs(), TZ)).toBeUndefined();
    r.clock.set(NEXT_7AM);
    expect(await morningCheck(plan, NOW, r.deps)).toEqual({
      result: 'not_checked',
      detail: 'This fix has nothing a sensor can check.',
      speech: '',
      answered: 0,
      total: 0,
      evidence: [],
    });
  });

  it('schedules nothing for turning off an automation (dead trigger)', async () => {
    const house = buildGoldenHouse();
    addEntity(house, { entityId: 'automation.grow_light_schedule', name: 'Grow Light Schedule', integration: 'automation', transport: 'virtual', state: 'on', attributes: { id: 'grow', entity_ids: ['switch.grow_light_plug'] } });
    const r = rig(house);
    const ck = await runCheckup({ focus: 'automations' }, r.deps);
    const { plan } = await planRepair({ kind: 'issue', session: ck.session, issue_id: ck.output.findings[0]?.issue_id ?? '' }, r.deps);
    await executePlan(plan, r.deps);
    expect(morningCheckAt(plan, r.clock.nowMs(), TZ)).toBeUndefined();
    const check = await morningCheck(plan, NOW, r.deps);
    expect(check.result).toBe('not_checked');
    expect(check.speech).not.toContain('Repair confirmed');
  });

  it('schedules the check at the next 07:00 household time for plans a sensor can verify', async () => {
    const r = rig();
    const dx = await diagnose(r, "the hallway lamp isn't responding", ['yes']);
    const { plan } = await planRepair({ kind: 'diagnosis', session: dx.session }, r.deps);
    expect(isVerifiable(plan)).toBe(true);
    expect(morningCheckAt(plan, r.clock.nowMs(), TZ)).toBe(NEXT_7AM);
  });
});
