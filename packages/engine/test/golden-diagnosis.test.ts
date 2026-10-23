// Golden path steps 1 and 2: passive probes pass for hub, signal
// and cloud, two causes remain with stale_duplicate leading, the flash question is asked, and the answer
// decides the verdict.

import { describe, expect, it } from 'vitest';
import { CONFIRM_THRESHOLD, ToolOutputs, type DiagnoseOutput } from '@fixwright/protocol';
import { answerDiagnosis, startDiagnosis, checkClaims, type DiagnosisSession } from '../src/index.ts';
import { buildGoldenHouse, rig, type Rig } from './support/golden-house.ts';
import { addEntity } from './support/fake-adapter.ts';

const SYMPTOM = "Why the hallway lamp keeps saying it's not responding";
const VERDICT = 'The lamp works. The name Hallway Lamp still points at an old copy of it that went offline on October 3.';

function valid(output: DiagnoseOutput): void {
  const r = ToolOutputs.diagnose.safeParse(output);
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues, null, 2)).toBe(true);
}

async function start(r: Rig = rig()) {
  const first = await startDiagnosis({ symptom: SYMPTOM }, r.deps);
  return { r, ...first };
}

async function answer(r: Rig, session: DiagnosisSession, output: DiagnoseOutput, said: string) {
  const question = output.question;
  if (!question) throw new Error('expected a question');
  return answerDiagnosis(session, { diagnosis_id: session.diagnosis_id, question_id: question.question_id, answer: said }, r.deps);
}

describe('golden diagnosis: the hallway lamp', () => {
  it('targets the spoken name, not the copy', async () => {
    const { output } = await start();
    valid(output);
    expect(output.target).toEqual({ entity_id: 'light.hallway_lamp', name: 'Hallway Lamp', guided: false });
  });

  it('runs the passive probes first: hub, signal and cloud pass', async () => {
    const { output } = await start();
    const byId = new Map(output.probes.map((p) => [p.probe_id, p]));
    expect(byId.get('hub_reachable')?.outcome).toBe('pass');
    expect(byId.get('link_quality')?.outcome).toBe('pass');
    expect(byId.get('cloud_status')?.outcome).toBe('pass');
    expect(byId.get('cloud_status')?.label).toBe('Hue cloud');
    expect(byId.get('entity_availability')?.outcome).toBe('fail');
    expect(byId.get('duplicate_name_scan')?.outcome).toBe('fail');
    const passiveIdx = output.probes.filter((p) => !p.disruptive).map((p) => output.probes.indexOf(p));
    const flashIdx = output.probes.findIndex((p) => p.probe_id === 'flash_test');
    expect(flashIdx).toBeGreaterThan(Math.max(...passiveIdx));
    expect(output.probes[flashIdx]?.disruptive).toBe(true);
    for (const p of output.probes) expect(p.evidence.length).toBeGreaterThan(0);
  });

  it('leaves two causes with stale_duplicate leading and asks the flash question', async () => {
    const { output, session } = await start();
    expect(output.status).toBe('needs_answer');
    const [first, second, third] = output.hypotheses;
    expect(first?.cause_id).toBe('stale_duplicate');
    expect(second?.cause_id).toBe('device_power_lost');
    expect(first?.p).toBeLessThan(CONFIRM_THRESHOLD);
    expect(second?.p).toBeGreaterThan(0.15);
    expect((first?.p ?? 0) + (second?.p ?? 0)).toBeGreaterThan(0.95);
    expect(third?.p ?? 0).toBeLessThan(0.05);
    expect(output.question?.text).toBe("I'll flash the hallway lamp twice. Did it blink?");
    expect(output.question?.action_performed).toBe('Flashed the online Hallway Lamp twice');
    expect(output.speech).toBe("Your hub is reachable, the signal is good and the Hue cloud is fine. I'll flash the hallway lamp twice. Did it blink?");
    const total = Object.values(session.posterior).reduce((s, p) => s + p, 0);
    expect(total).toBeCloseTo(1, 12);
  });

  it('says "the light maker\'s cloud" when the house describes the maker instead of naming a brand', async () => {
    const house = buildGoldenHouse();
    for (const e of house.entities.values()) if (e.vendor === 'Philips Hue') e.vendor = 'light maker';
    const { output } = await start(rig(house));
    valid(output);
    const cloud = output.probes.find((p) => p.probe_id === 'cloud_status');
    expect(cloud).toMatchObject({ outcome: 'pass', label: "Light maker's cloud", detail: "The light maker's cloud reports no problems." });
    expect(output.speech).toBe("Your hub is reachable, the signal is good and the light maker's cloud is fine. I'll flash the hallway lamp twice. Did it blink?");
  });

  it('flashes the online copy, not the old one', async () => {
    const { r } = await start();
    const flashed = r.house.calls.map((c) => c.data['entity_id']);
    expect(flashed).toHaveLength(4);
    expect(new Set(flashed)).toEqual(new Set(['light.hallway_lamp_2']));
    expect(r.house.entities.get('light.hallway_lamp_2')?.state).toBe('off');
  });
});

describe('golden diagnosis: the answer', () => {
  it.each(['yes', 'Yes, it blinked.', 'haan', 'jal raha hai'])('"%s" confirms the stale copy at about 94%%', async (said) => {
    const { r, session, output } = await start();
    const next = await answer(r, session, output, said);
    valid(next.output);
    expect(next.output.status).toBe('ok');
    const v = next.output.verdict;
    expect(v?.level).toBe('confirmed');
    expect(v?.cause_id).toBe('stale_duplicate');
    expect(v?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(v?.confidence).toBeLessThanOrEqual(0.97);
    expect(v?.claims.map((c) => c.text).join(' ')).toBe(VERDICT);
    expect(v?.fix_available).toBe(true);
    expect(next.output.speech).toBe(`${VERDICT} Want me to fix that?`);
    expect(next.output.hypotheses[0]?.p).toBe(v?.confidence);
    const blink = next.output.probes.at(-1);
    expect(blink).toMatchObject({ probe_id: 'confirm_flash', outcome: 'pass', label: 'You saw it blink', disruptive: false });
  });

  it('cites evidence that exists in the ledger for every claim', async () => {
    const { r, session, output } = await start();
    const next = await answer(r, session, output, 'yes');
    const claims = next.output.verdict?.claims ?? [];
    const { kept, dropped } = await checkClaims(
      claims.map((c) => ({ ...c, kind: 'fact' as const })),
      r.ledger,
    );
    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(2);
    const seqs = new Set(r.ledger.all().map((e) => e.seq));
    for (const c of claims) for (const s of c.evidence) expect(seqs.has(s)).toBe(true);
  });

  it('"no" leads elsewhere: power loss rises and the wall switch question follows', async () => {
    const { r, session, output } = await start();
    const next = await answer(r, session, output, "no, it didn't blink");
    valid(next.output);
    expect(next.output.verdict?.cause_id === 'stale_duplicate' && next.output.verdict.level === 'confirmed').toBe(false);
    expect(next.output.hypotheses[0]?.cause_id).toBe('device_power_lost');
    expect(next.output.status).toBe('needs_answer');
    expect(next.output.question?.text).toBe("Is the lamp's wall switch on?");
  });

  it('"no" then "the switch is off" confirms power loss with evidence', async () => {
    const { r, session, output } = await start();
    const second = await answer(r, session, output, 'nahi');
    const third = await answer(r, second.session, second.output, 'no');
    valid(third.output);
    expect(third.output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'device_power_lost', fix_available: false });
    // The online copy already reports on and the old copy never returns, so no sensor can confirm the
    // fix: the guidance promises no check (followup.test.ts covers a lamp that can be checked).
    expect(third.output.speech.endsWith('Switch the hallway lamp back on at the wall.')).toBe(true);
    expect(third.session.guided_check).toBeUndefined();
  });

  it('"no" and "no": the claims are about the lamp the person looked at, not the old copy', async () => {
    const { r, session, output } = await start();
    const second = await answer(r, session, output, 'no');
    const third = await answer(r, second.session, second.output, 'no');
    expect(third.output.verdict?.claims.map((c) => c.text)).toEqual([
      "The hallway lamp didn't respond when I tested it.",
      'Its wall switch is off.',
      'Your hub and its signal look fine.',
    ]);
    // The old copy went offline on 3 October because the lamp was paired again, not this power cut.
    expect(third.output.speech).not.toMatch(/October/);
    const noBlink = third.output.verdict?.claims[0]?.evidence ?? [];
    for (const seq of noBlink) expect(r.ledger.all().find((e) => e.seq === seq)?.entityId).toBe('light.hallway_lamp_2');
  });

  it('asks once more after an unclear answer, flashing again, then accepts the clear one', async () => {
    const { r, session, output } = await start();
    const unclear = await answer(r, session, output, 'not sure');
    valid(unclear.output);
    expect(unclear.output.status).toBe('needs_answer');
    expect(unclear.output.question?.text).toBe('I flashed it again. Just yes or no, did the hallway lamp blink?');
    expect(unclear.output.question?.question_id).not.toBe(output.question?.question_id);
    expect(unclear.output.question?.action_performed).toBe('Flashed the online Hallway Lamp twice again');
    expect(r.house.calls).toHaveLength(8);
    // The repeat flash shows on the stepper like any probe, with its ledger evidence.
    const again = unclear.output.probes.at(-1);
    expect(again).toMatchObject({ probe_id: 'flash_test', label: 'Flash test again', outcome: 'pass', disruptive: true, detail: 'Flashed the online copy twice again. It answered both times.' });
    expect(r.ledger.all().find((e) => e.seq === again?.evidence[0])?.data).toMatchObject({ probe_id: 'flash_test', repeat: true, commands: 4, answered: 4 });
    const done = await answer(r, unclear.session, unclear.output, 'yes');
    expect(done.output.verdict?.level).toBe('confirmed');
    expect(done.output.verdict?.claims[0]?.evidence).toContain(again?.evidence[0]);
  });

  it('a second unclear answer counts as no information', async () => {
    const { r, session, output } = await start();
    const once = await answer(r, session, output, 'maybe');
    const twice = await answer(r, once.session, once.output, 'pata nahi');
    valid(twice.output);
    expect(twice.output.probes.find((p) => p.probe_id === 'confirm_flash')?.outcome).toBe('unknown');
    expect(twice.output.verdict?.level === 'confirmed' && twice.output.verdict.cause_id === 'stale_duplicate').toBe(false);
  });

  it('rejects a stale question id and a foreign diagnosis id', async () => {
    const { r, session, output } = await start();
    const done = await answer(r, session, output, 'yes');
    await expect(answer(r, done.session, output, 'yes')).rejects.toMatchObject({ code: 'question_answered' });
    await expect(
      answerDiagnosis(session, { diagnosis_id: 'dx_00000000000000000000'.slice(0, 21), question_id: output.question?.question_id ?? '', answer: 'yes' }, r.deps),
    ).rejects.toMatchObject({ code: 'session_expired' });
  });

  it('sessions survive a JSON round trip (the server stores them as JSON)', async () => {
    const { r, session, output } = await start();
    const stored = JSON.parse(JSON.stringify(session)) as DiagnosisSession;
    const next = await answer(r, stored, output, 'yes');
    expect(next.output.verdict?.level).toBe('confirmed');
    expect(session.status).toBe('needs_answer');
  });
});

describe('quiet hours', () => {
  const lateNight = '2026-10-16T06:30:00.000Z'; // 23:30 in Los Angeles

  it('asks before flashing and flashes nothing until the person agrees', async () => {
    const r = rig(buildGoldenHouse(), {}, lateNight);
    const { output, session } = await startDiagnosis({ symptom: SYMPTOM }, r.deps);
    valid(output);
    expect(output.question?.text).toBe("It's late, so I'll ask first. Can I flash the hallway lamp twice to test it?");
    expect(output.probes.some((p) => p.disruptive)).toBe(false);
    expect(r.house.calls).toHaveLength(0);
    const yes = await answerDiagnosis(session, { diagnosis_id: session.diagnosis_id, question_id: output.question?.question_id ?? '', answer: 'ok, go ahead' }, r.deps);
    expect(r.house.calls).toHaveLength(4);
    expect(yes.output.question?.text).toBe("I'll flash the hallway lamp twice. Did it blink?");
  });

  it('a no keeps everything dark and moves to a question that needs no flash', async () => {
    const r = rig(buildGoldenHouse(), {}, lateNight);
    const { output, session } = await startDiagnosis({ symptom: SYMPTOM }, r.deps);
    const no = await answerDiagnosis(session, { diagnosis_id: session.diagnosis_id, question_id: output.question?.question_id ?? '', answer: 'no' }, r.deps);
    valid(no.output);
    expect(r.house.calls).toHaveLength(0);
    expect(no.output.speech.startsWith("Okay, I won't flash anything right now.")).toBe(true);
    expect(no.output.question?.text).toBe("Is the lamp's wall switch on?");
  });

  it('never repeats the flash when asking again once quiet hours begin, unless the person said yes', async () => {
    // 21:59 in Los Angeles: not quiet yet, so the first flash runs without asking.
    const r = rig(buildGoldenHouse(), {}, '2026-10-16T04:59:00.000Z');
    const { output, session } = await startDiagnosis({ symptom: SYMPTOM }, r.deps);
    expect(output.question?.text).toBe("I'll flash the hallway lamp twice. Did it blink?");
    expect(r.house.calls).toHaveLength(4);
    r.clock.set('2026-10-16T05:01:00.000Z'); // 22:01, quiet hours
    const unclear = await answerDiagnosis(session, { diagnosis_id: session.diagnosis_id, question_id: output.question?.question_id ?? '', answer: 'not sure' }, r.deps);
    valid(unclear.output);
    expect(r.house.calls).toHaveLength(4);
    expect(unclear.output.question?.text).toBe('Just yes or no, did the hallway lamp blink when I flashed it?');
    expect(unclear.output.probes.filter((p) => p.disruptive)).toHaveLength(1);
    const done = await answerDiagnosis(unclear.session, { diagnosis_id: session.diagnosis_id, question_id: unclear.output.question?.question_id ?? '', answer: 'haan' }, r.deps);
    expect(done.output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'stale_duplicate' });
    expect(r.house.calls).toHaveLength(4);
  });

  it('repeats the flash when asking again in quiet hours after the person agreed to flashing', async () => {
    const r = rig(buildGoldenHouse(), {}, lateNight);
    const first = await startDiagnosis({ symptom: SYMPTOM }, r.deps);
    const yes = await answerDiagnosis(first.session, { diagnosis_id: first.session.diagnosis_id, question_id: first.output.question?.question_id ?? '', answer: 'yes' }, r.deps);
    expect(r.house.calls).toHaveLength(4);
    const unclear = await answerDiagnosis(yes.session, { diagnosis_id: first.session.diagnosis_id, question_id: yes.output.question?.question_id ?? '', answer: 'hmm' }, r.deps);
    expect(r.house.calls).toHaveLength(8);
    expect(unclear.output.question?.text).toBe('I flashed it again. Just yes or no, did the hallway lamp blink?');
  });

  it('respects custom quiet hours', async () => {
    const r = rig(buildGoldenHouse(), { quietHours: { start: '09:00', end: '11:00' } });
    const { output } = await startDiagnosis({ symptom: SYMPTOM }, r.deps);
    expect(output.question?.text).toContain("It's late, so I'll ask first.");
  });
});

describe('the copy paired again has a numbered name (Hallway Lamp 2)', () => {
  it('still confirms the stale copy', async () => {
    const house = buildGoldenHouse();
    const twin = house.entities.get('light.hallway_lamp_2');
    if (twin) twin.name = 'Hallway Lamp 2';
    const r = rig(house);
    const { session, output } = await startDiagnosis({ symptom: SYMPTOM }, r.deps);
    expect(output.probes.find((p) => p.probe_id === 'duplicate_name_scan')?.detail).toContain('Hallway Lamp 2');
    const next = await answer(r, session, output, 'yes');
    expect(next.output.verdict?.claims.map((c) => c.text).join(' ')).toBe(VERDICT);
  });
});

describe('other targets', () => {
  it('diagnoses the flapping kitchen plug from passive evidence alone', async () => {
    const r = rig();
    const { output } = await startDiagnosis({ symptom: 'the kitchen plug keeps dropping off' }, r.deps);
    valid(output);
    expect(output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'radio_link_weak' });
    expect(output.verdict?.claims.map((c) => c.text)).toEqual([
      'The kitchen plug dropped off 9 times in the last day.',
      'Its Wi-Fi signal is weak, at -82 dBm.',
    ]);
    expect(r.house.calls).toHaveLength(0);
  });

  it('runs in guided mode when no device matches, asking instead of probing', async () => {
    const r = rig();
    const { output } = await startDiagnosis({ symptom: 'my bathroom fan stopped working' }, r.deps);
    valid(output);
    expect(output.target).toEqual({ name: 'bathroom fan', guided: true });
    expect(output.probes).toEqual([]);
    expect(output.speech.startsWith("I can't see the bathroom fan from here")).toBe(true);
    expect(output.question).toBeDefined();
  });

  it('refuses to guess between different devices', async () => {
    const r = rig();
    await expect(startDiagnosis({ symptom: 'the lamp is not working' }, r.deps)).rejects.toMatchObject({ code: 'ambiguous_device' });
  });

  it('diagnoses a hub that is down from passive evidence', async () => {
    const house = buildGoldenHouse();
    for (const e of house.entities.values()) if (e.integration === 'zigbee2mqtt') e.state = 'unavailable';
    const z2m = house.integrations.find((i) => i.integration === 'zigbee2mqtt');
    if (z2m) z2m.state = 'setup_retry';
    addEntity(house, { entityId: 'light.attic_light', name: 'Attic Light', integration: 'zigbee2mqtt', transport: 'zigbee', state: 'unavailable' });
    const r = rig(house);
    const { output } = await startDiagnosis({ symptom: "the attic light isn't responding" }, r.deps);
    valid(output);
    expect(output.verdict?.cause_id).toBe('hub_down');
    expect(output.verdict?.fix_available).toBe(true);
    expect(r.house.calls).toHaveLength(0);
  });

  it('finds an automation that points at a removed device', async () => {
    const house = buildGoldenHouse();
    addEntity(house, {
      entityId: 'automation.grow_light_schedule',
      name: 'Grow Light Schedule',
      integration: 'automation',
      transport: 'virtual',
      state: 'on',
      attributes: { id: 'grow', entity_ids: ['switch.grow_light_plug'] },
    });
    const r = rig(house);
    const { output } = await startDiagnosis({ symptom: "my grow light schedule automation didn't run" }, r.deps);
    valid(output);
    expect(output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'dead_trigger', fix_available: true });
    expect(output.speech).toBe('The automation Grow Light Schedule still uses a device that was removed. Want me to fix that?');
  });

  it('blames the power on setting for a light that turns on by itself', async () => {
    const r = rig();
    const { output } = await startDiagnosis({ symptom: 'the porch light keeps turning on by itself at night' }, r.deps);
    valid(output);
    expect(output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'power_on_default_on', fix_available: true });
    expect(output.speech).toBe('The porch light is set to switch on whenever power comes back. Want me to fix that?');
  });

  it("names the maker's cloud outage and promises nothing it cannot do at home", async () => {
    const house = buildGoldenHouse();
    house.cloud.set('ecobee', 'outage');
    addEntity(house, { entityId: 'climate.thermostat', name: 'Thermostat', integration: 'ecobee', transport: 'cloud', vendor: 'ecobee', state: 'unavailable', lastChanged: '2026-10-15T16:50:00.000Z' });
    const r = rig(house);
    const { output } = await startDiagnosis({ symptom: "the thermostat isn't responding" }, r.deps);
    valid(output);
    expect(output.verdict).toMatchObject({ level: 'confirmed', cause_id: 'vendor_cloud_outage', fix_available: false });
    expect(output.speech).toBe("The Ecobee cloud reports a problem right now. There's nothing to fix at home. I'll check again later and tell you when it's back.");
  });
});
