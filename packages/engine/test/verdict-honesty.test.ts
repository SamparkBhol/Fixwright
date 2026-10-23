// "Finds the real fault. Proves it." A verdict names a cause only when an observed fault points at
// it, a likely verdict says that cause out loud, a device that works when tested gets an honest can't tell,
// and a fix is offered only when the planner can build one. Ends with a sweep of the golden
// house: every switchable device, four ways of complaining, four answer patterns.

import { describe, expect, it } from 'vitest';
import { ToolOutputs, type DiagnoseOutput, type Entity } from '@fixwright/protocol';
import { answerDiagnosis, CAUSE_SPOKEN, classifySymptom, houseView, NAME_FLOOR, planRepair, powerOnSelect, startDiagnosis, SWITCHABLE_DOMAINS, type DiagnosisSession } from '../src/index.ts';
import { addEntity, addEvent } from './support/fake-adapter.ts';
import { buildGoldenHouse, rig, type Rig } from './support/golden-house.ts';
import { emptyStats, verdictProblems } from './support/verdict-invariants.ts';

async function converse(r: Rig, symptom: string, answers: readonly string[]) {
  let res = await startDiagnosis({ symptom }, r.deps);
  const asked: string[] = [];
  for (let i = 0; i < 8 && res.output.status === 'needs_answer'; i++) {
    const q = res.output.question;
    if (!q) throw new Error('needs_answer without a question');
    asked.push(q.text);
    res = await answerDiagnosis(res.session, { diagnosis_id: res.session.diagnosis_id, question_id: q.question_id, answer: answers[i % answers.length] ?? 'yes' }, r.deps);
    expect(ToolOutputs.diagnose_answer.safeParse(res.output).success).toBe(true);
  }
  return { ...res, asked };
}

async function holds(r: Rig, output: DiagnoseOutput, session: DiagnosisSession): Promise<void> {
  expect(await verdictProblems(output, session, r.ledger.all(), r.deps)).toEqual([]);
}

describe('a device that works when tested', () => {
  it('"the kitchen ceiling isn\'t responding", it blinked, the switch is on: can\'t tell, no fix, no false repair', async () => {
    const r = rig();
    const { output, session, asked } = await converse(r, "the kitchen ceiling isn't responding", ['yes', 'yes']);
    expect(asked).toEqual(["I'll flash the kitchen ceiling twice. Did it blink?", "Is the light's wall switch on?"]);
    // A power on setting cannot make a light ignore commands, so it is not even a hypothesis.
    expect(session.causes).not.toContain('power_on_default_on');
    expect(output.probes.map((p) => p.probe_id)).not.toContain('power_on_setting');
    expect(output.verdict).toMatchObject({ level: 'cant_tell', cause_id: 'unknown', fix_available: false });
    expect(output.verdict?.claims.map((c) => c.text)).toEqual(['The kitchen ceiling worked when I tested it just now.']);
    expect(output.speech).toBe(
      "The kitchen ceiling worked when I tested it just now. So I can't tell what went wrong before. If it happens again, ask me right away and I'll test it while it's happening.",
    );
    // The claim cites the flash and the person's yes, both about this light.
    const cited = (output.verdict?.claims[0]?.evidence ?? []).map((seq) => r.ledger.all().find((e) => e.seq === seq));
    expect(cited.map((e) => e?.data?.['probe_id'])).toEqual(expect.arrayContaining(['flash_test', 'confirm_flash']));
    expect(cited.every((e) => e?.entityId === 'light.kitchen_ceiling')).toBe(true);
    expect(session.guided_check).toBeUndefined();
    await expect(planRepair({ kind: 'diagnosis', session }, r.deps)).rejects.toMatchObject({ code: 'no_fix' });
    await holds(r, output, session);
  });

  it('the same light "keeps turning on by itself": the setting is read and the fix is real', async () => {
    const r = rig();
    const { output, session } = await converse(r, 'the kitchen ceiling keeps turning on by itself', ['yes']);
    expect(output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'power_on_default_on', fix_available: true });
    expect(output.speech).toBe('The kitchen ceiling is set to switch on whenever power comes back. Want me to fix that?');
    const setting = output.probes.find((p) => p.probe_id === 'power_on_setting');
    expect(setting).toMatchObject({ outcome: 'fail' });
    expect(output.verdict?.claims[0]?.evidence).toEqual(expect.arrayContaining(setting?.evidence ?? [-1]));
    const plan = await planRepair({ kind: 'diagnosis', session }, r.deps);
    expect(plan.plan.steps.map((s) => s.op)).toEqual([{ kind: 'select_option', entity_id: 'select.kitchen_ceiling_power_on_behavior', option: 'previous' }]);
    await holds(r, output, session);
  });

  it('a lamp with no power on setting to read never gets that cause', async () => {
    const r = rig();
    const { output, session } = await converse(r, 'the reading lamp keeps turning on by itself', ['yes', 'yes']);
    expect(session.causes).not.toContain('power_on_default_on');
    expect(output.verdict?.cause_id).not.toBe('power_on_default_on');
    await holds(r, output, session);
  });

  it('a setting that can be read but not changed is named, with guidance instead of a fix', async () => {
    const house = buildGoldenHouse();
    addEntity(house, { entityId: 'light.study_lamp', name: 'Study Lamp', area: 'Study', deviceId: 'dev_study', integration: 'kasa', transport: 'wifi', vendor: 'TP-Link Kasa', state: 'off' }, { rssi: -55, powerOnBehavior: 'on' });
    const r = rig(house);
    const { output, session } = await converse(r, 'the study lamp keeps turning on by itself', ['yes', 'yes']);
    expect(output.verdict).toMatchObject({ cause_id: 'power_on_default_on', fix_available: false });
    expect(output.verdict?.claims.map((c) => c.text)).toContain('The study lamp is set to switch on whenever power comes back.');
    expect(output.speech.endsWith("You can set the study lamp to remember whether it was on or off from its maker's app.")).toBe(true);
    expect(output.speech).not.toContain('Want me to fix that?');
    await expect(planRepair({ kind: 'diagnosis', session }, r.deps)).rejects.toMatchObject({
      code: 'no_fix',
      speech: "I can't fix that one by myself. You can set the study lamp to remember whether it was on or off from its maker's app.",
    });
    await holds(r, output, session);
  });

  it('reads the setting from its select when the adapter reports no signal (the Home Assistant shape)', async () => {
    const house = buildGoldenHouse();
    house.signals.set('light.porch_light', { linkQuality: 150 });
    const r = rig(house);
    const { output, session } = await converse(r, 'the porch light keeps turning on by itself', ['yes']);
    expect(output.probes.find((p) => p.probe_id === 'power_on_setting')).toMatchObject({ outcome: 'fail', detail: 'Porch Light is set to switch on when power comes back.' });
    expect(output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'power_on_default_on', fix_available: true });
    await holds(r, output, session);
  });

  it('a likely verdict says what it is', async () => {
    const r = rig();
    const { output, session } = await converse(r, "the kitchen ceiling isn't responding", ['yes', 'no']);
    expect(output.verdict).toMatchObject({ level: 'likely', cause_id: 'device_power_lost', fix_available: false });
    expect(output.speech).toBe(
      "The kitchen ceiling's wall switch is off. Your hub and its signal look fine. It's most likely a power problem, but I'm not certain. Switch the kitchen ceiling back on at the wall.",
    );
    await holds(r, output, session);
  });

  it('does not name a real fault that cannot cause the complaint (an old copy does not switch a lamp on)', async () => {
    const r = rig();
    const { output, session } = await converse(r, 'the hallway lamp keeps turning on by itself', ['yes', 'yes']);
    expect(output.verdict).toMatchObject({ level: 'cant_tell', fix_available: false });
    expect(output.verdict?.cause_id).not.toBe('stale_duplicate');
    expect(output.speech).toBe(
      "The hallway lamp worked when I tested it just now. I did find an old copy of the device, but that wouldn't switch it on by itself. So I can't tell what went wrong before. If it happens again, ask me right away and I'll test it while it's happening.",
    );
    await expect(planRepair({ kind: 'diagnosis', session }, r.deps)).rejects.toThrow();
    await holds(r, output, session);
  });

  it('never offers to flash a strip that feeds a protected load, even as the settle line', async () => {
    const r = rig();
    const { output, session } = await converse(r, "the living room power strip isn't responding", ['yes', 'no']);
    expect(r.house.calls).toHaveLength(0);
    expect(output.speech).not.toMatch(/flash/i);
    expect(output.verdict?.level).toBe('cant_tell');
    await holds(r, output, session);
  });

  it('"won\'t turn on" is a device ignoring commands, not one switching on by itself', () => {
    expect(classifySymptom("the porch light won't turn on")).toBe('unresponsive');
    expect(classifySymptom('The TV will not turn on.')).toBe('unresponsive');
    expect(classifySymptom("the plug doesn't respond")).toBe('unresponsive');
    expect(classifySymptom("it keeps turning on by itself and won't turn off")).toBe('unexpected_on');
    expect(classifySymptom('the lights came on at 3')).toBe('unexpected_on');
  });
});

describe('battery devices and ruled out causes', () => {
  it('reads the battery of a battery device instead of asking about a wall switch', async () => {
    const r = rig();
    const { output, session, asked } = await converse(r, "the hall motion sensor isn't working", ['yes']);
    expect(asked).toEqual([]);
    expect(output.speech).not.toMatch(/wall|plugged/i);
    expect(output.probes.find((p) => p.probe_id === 'battery_level')).toMatchObject({ outcome: 'fail', detail: 'The battery is at 6%.' });
    expect(output.probes.some((p) => p.probe_id === 'power_switch_check')).toBe(false);
    expect(output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'device_power_lost', fix_available: false });
    expect(output.speech).toBe("The hall motion sensor's battery is down to 6%. Your hub and its signal look fine. Put a fresh battery in the hall motion sensor.");
    const cited = (output.verdict?.claims[0]?.evidence ?? []).map((seq) => r.ledger.all().find((e) => e.seq === seq));
    expect(cited[0]?.data).toMatchObject({ probe_id: 'battery_level', value: 'low', battery_pct: 6 });
    await holds(r, output, session);
  });

  it('says a flat battery when the verdict is only likely', async () => {
    const house = buildGoldenHouse();
    house.signals.set('binary_sensor.hall_motion', { batteryPct: 6, linkQuality: 40 });
    const r = rig(house);
    const { output, session } = await converse(r, "the hall motion sensor isn't working", ['yes']);
    if (output.verdict?.level === 'likely') expect(output.speech).toContain("It's most likely a flat battery, but I'm not certain.");
    expect(output.speech).not.toMatch(/wall switch|plugged in/i);
    await holds(r, output, session);
  });

  it('a battery that is fine is not blamed, and there is still no wall switch question', async () => {
    const house = buildGoldenHouse();
    house.signals.set('binary_sensor.hall_motion', { batteryPct: 80, linkQuality: 96 });
    const r = rig(house);
    const { output, session, asked } = await converse(r, "the hall motion sensor isn't working", ['yes']);
    expect(asked.join(' ')).not.toMatch(/wall|plugged/i);
    expect(output.probes.find((p) => p.probe_id === 'battery_level')).toMatchObject({ outcome: 'pass' });
    expect(output.verdict?.cause_id).not.toBe('device_power_lost');
    expect(output.speech).not.toMatch(/battery|power problem/i);
    await holds(r, output, session);
  });

  it('never names a dead trigger once every device the automation uses is there', async () => {
    const r = rig();
    const { output, session } = await converse(r, "the night lights automation doesn't work", ['yes']);
    expect(output.probes.find((p) => p.probe_id === 'registry_scan')).toMatchObject({ outcome: 'pass' });
    expect(output.verdict?.level).toBe('cant_tell');
    expect(output.verdict?.cause_id).not.toBe('dead_trigger');
    expect(output.speech).not.toContain('an automation using a removed device');
    expect(output.speech).toBe(
      "Every device Night Lights uses still exists. So I can't tell what went wrong before. If it happens again, ask me right away and I'll test it while it's happening.",
    );
    await holds(r, output, session);
  });

  it('still names a dead trigger when the automation uses a removed device', async () => {
    const house = buildGoldenHouse();
    const auto = house.entities.get('automation.night_lights');
    if (!auto) throw new Error('golden house has Night Lights');
    house.entities.set(auto.entityId, { ...auto, attributes: { ...auto.attributes, entity_ids: ['light.porch_light', 'light.gone_light'] } });
    const r = rig(house);
    const { output, session } = await converse(r, "the night lights automation doesn't work", ['yes']);
    expect(output.verdict).toMatchObject({ cause_id: 'dead_trigger' });
    expect(output.verdict?.level).not.toBe('cant_tell');
    await holds(r, output, session);
  });
});

describe('two faults, battery guidance and honest can\'t tell lines', () => {
  /** The golden house, with the online hallway lamp also set to switch on when power comes back. */
  function twoFaultHouse() {
    const house = buildGoldenHouse();
    house.signals.set('light.hallway_lamp_2', { linkQuality: 178, powerOnBehavior: 'on' });
    addEntity(house, {
      entityId: 'select.hallway_lamp_2_power_on_behavior',
      name: 'Hallway Lamp Power-on behavior',
      deviceId: 'dev_hallway_lamp',
      integration: 'hue',
      transport: 'zigbee',
      state: 'on',
      attributes: { options: ['off', 'on', 'toggle', 'previous'] },
    });
    return house;
  }

  it('names the fault that fits once the old copy is set aside, and fixes that one', async () => {
    const r = rig(twoFaultHouse());
    const { output, session } = await converse(r, 'the hallway lamp keeps turning on by itself', ['yes', 'yes']);
    expect(output.verdict).toMatchObject({ cause_id: 'power_on_default_on', fix_available: true });
    expect(['likely', 'confirmed']).toContain(output.verdict?.level);
    // The single fault posterior still puts the old copy on top: it is what was set aside.
    expect(Object.entries(session.posterior).sort((a, b) => b[1] - a[1])[0]?.[0]).toBe('stale_duplicate');
    expect(output.speech).toMatch(/^The hallway lamp is set to switch on whenever power comes back\. I also found an old copy of the device, but that wouldn't switch it on by itself\./);
    expect(output.speech).toMatch(/Want me to fix that\?$/);
    const plan = await planRepair({ kind: 'diagnosis', session }, r.deps);
    expect(plan.plan.steps.map((s) => s.op)).toEqual([{ kind: 'select_option', entity_id: 'select.hallway_lamp_2_power_on_behavior', option: 'previous' }]);
    // The old copy has no setting that matters, so the plan does not say it can't change it.
    expect(JSON.stringify(plan.output)).not.toMatch(/can't change/);
    await holds(r, output, session);
  });

  it("an old copy does not own the new copy's power on select", async () => {
    const view = houseView([...twoFaultHouse().entities.values()]);
    const select = (id: string) => powerOnSelect(view.byId.get(id) as Entity, view)?.entityId;
    expect(select('light.hallway_lamp')).toBeUndefined();
    expect(select('light.hallway_lamp_2')).toBe('select.hallway_lamp_2_power_on_behavior');
    expect(select('light.porch_light')).toBe('select.porch_light_power_on_behavior');
  });

  it('a failed reading of another fault no longer rules out the cause whose own probe failed', async () => {
    const r = rig(twoFaultHouse());
    const { output } = await converse(r, 'the hallway lamp keeps turning on by itself', ['yes', 'yes']);
    // entity_availability came out offline (the old copy), which is all but impossible under a single power on fault.
    expect(output.probes.find((p) => p.probe_id === 'entity_availability')).toMatchObject({ outcome: 'fail' });
    expect(output.speech).not.toMatch(/I can't tell/);
  });

  it('asks for a fresh battery only when the battery reads low', async () => {
    const house = buildGoldenHouse();
    house.signals.set('binary_sensor.hall_motion', { batteryPct: 80, linkQuality: 96 });
    const sensor = house.entities.get('sensor.hall_motion_battery');
    if (sensor) house.entities.set(sensor.entityId, { ...sensor, state: '80' });
    const motion = house.entities.get('binary_sensor.hall_motion');
    if (motion) house.entities.set(motion.entityId, { ...motion, state: 'unavailable' });
    addEvent(house, { ts: '2026-10-15T09:00:00.000Z', kind: 'availability', entityId: 'binary_sensor.hall_motion', from: 'off', to: 'unavailable' });
    const r = rig(house);
    const { output, session, asked } = await converse(r, "the hall motion sensor isn't working", ['yes']);
    expect(output.probes.find((p) => p.probe_id === 'battery_level')).toMatchObject({ outcome: 'pass' });
    expect(asked.join(' ')).not.toMatch(/wall|plugged/i);
    expect(output.speech).not.toMatch(/fresh battery|flat battery/i);
    if (output.verdict?.cause_id === 'device_power_lost' && output.verdict.level !== 'cant_tell') {
      expect(output.speech).toMatch(/Check that the battery in the hall motion sensor is seated properly/);
    }
    await holds(r, output, session);
  });

  it('a can\'t tell line names no cause with a tiny share of the posterior', async () => {
    const r = rig();
    const { output, session } = await converse(r, 'the hallway lamp keeps turning on by itself', ['no', 'no']);
    // Before: "It's most likely something I can't see from here or an old copy of the device", at 0.006 and 0.024.
    expect(output.speech).toBe(
      "I did find a power problem, but that wouldn't switch it on by itself. I can't tell yet. If it happens again, ask me right away and I'll test it while it's happening.",
    );
    for (const [c, p] of Object.entries(session.posterior)) if (p < NAME_FLOOR) expect(output.speech).not.toContain(CAUSE_SPOKEN[c] ?? '\u0000');
    await holds(r, output, session);
  });
});

describe('two faults: a cause is ruled out only by its own probe', () => {
  /** The golden house, with the online hallway lamp also set to switch on when power comes back. */
  function twoFaultHouse(powerOn: 'on' | 'previous' = 'on') {
    const house = buildGoldenHouse();
    house.signals.set('light.hallway_lamp_2', { linkQuality: 178, powerOnBehavior: powerOn });
    addEntity(house, {
      entityId: 'select.hallway_lamp_2_power_on_behavior',
      name: 'Hallway Lamp Power-on behavior',
      deviceId: 'dev_hallway_lamp',
      integration: 'hue',
      transport: 'zigbee',
      state: powerOn,
      attributes: { options: ['off', 'on', 'toggle', 'previous'] },
    });
    return house;
  }
  const PATTERNS: string[][] = [['yes'], ['no'], ['yes', 'no'], ['no', 'yes']];

  it.each(PATTERNS)('names the power on setting whatever the answers [%s]', async (...answers) => {
    const r = rig(twoFaultHouse());
    const { output, session } = await converse(r, 'the hallway lamp keeps turning on by itself', answers);
    // Its own probe failed: the setting is "on".
    expect(output.probes.find((p) => p.probe_id === 'power_on_setting')).toMatchObject({ outcome: 'fail' });
    expect(output.verdict).toMatchObject({ cause_id: 'power_on_default_on', fix_available: true });
    expect(['likely', 'confirmed']).toContain(output.verdict?.level);
    // Before: [yes, no] and [no, yes] ended in "I can't tell", because the old copy (or the power problem)
    // on top was below the likely bar, and only one unfit fault was set aside.
    expect(output.speech).toMatch(/^The hallway lamp is set to switch on whenever power comes back\. I also found (an old copy of the device|a power problem), but that wouldn't switch it on by itself\./);
    await holds(r, output, session);
  });

  it.each(PATTERNS)('a setting that already remembers rules the cause out by its own probe [%s]', async (...answers) => {
    const r = rig(twoFaultHouse('previous'));
    const { output, session } = await converse(r, 'the hallway lamp keeps turning on by itself', answers);
    expect(output.probes.find((p) => p.probe_id === 'power_on_setting')).toMatchObject({ outcome: 'pass' });
    expect(output.verdict?.cause_id).not.toBe('power_on_default_on');
    expect(output.verdict?.level).toBe('cant_tell');
    expect(output.speech).not.toMatch(/switch on whenever power comes back|power on setting/);
    await holds(r, output, session);
  });

  it("another probe's clean reading does not rule out a cause the person's answer shows", async () => {
    // The living room light: two lights share its name (one fault), and the person says its wall switch is
    // off (a second). It reads online, which alone is all but impossible under a power problem.
    const r = rig();
    const { output, session } = await converse(r, "the living room light isn't responding", ['no']);
    expect(output.probes.find((p) => p.probe_id === 'entity_availability')).toMatchObject({ outcome: 'pass' });
    expect(output.probes.find((p) => p.probe_id === 'power_switch_check')).toMatchObject({ outcome: 'fail' });
    expect(output.verdict).toMatchObject({ level: 'cant_tell', cause_id: 'device_power_lost' });
    expect(output.speech).toBe(
      "I can't tell yet. It's most likely a power problem or two devices sharing a name. If it happens again, ask me right away and I'll test it while it's happening.",
    );
    await holds(r, output, session);
  });
});

describe('a sweep of the golden house', () => {
  const PHRASES = ["the {} isn't responding", 'the {} keeps turning on by itself', "the {} doesn't work", 'something is wrong with the {}'];
  const PATTERNS = [['yes'], ['no'], ['yes', 'no'], ['no', 'yes']];

  it('every verdict is backed, spoken and fixable as offered', async () => {
    const devices = [...buildGoldenHouse().entities.values()].filter((e) => SWITCHABLE_DOMAINS.has(e.domain) && e.disabled !== true);
    const stats = emptyStats();
    const problems: string[] = [];
    let verdicts = 0;
    for (const d of devices) {
      for (const phrase of PHRASES) {
        for (const pattern of PATTERNS) {
          const r = rig();
          const symptom = phrase.replace('{}', d.name.toLowerCase());
          const { output, session } = await converse(r, symptom, pattern);
          expect(output.status).toBe('ok');
          verdicts++;
          for (const p of await verdictProblems(output, session, r.ledger.all(), r.deps, stats)) problems.push(`${symptom} [${pattern.join(', ')}]: ${p}`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(verdicts).toBe(devices.length * PHRASES.length * PATTERNS.length);
    // The sweep reaches every kind of ending, so the rules above were really exercised.
    expect(stats.likely).toBeGreaterThan(20);
    expect(stats.confirmed).toBeGreaterThan(100);
    expect(stats.worksNow).toBeGreaterThan(20);
    expect(stats.fixesPlanned).toBeGreaterThan(100);
    console.info(`golden sweep: ${verdicts} verdicts ${JSON.stringify(stats)}`);
  }, 60_000);
});
