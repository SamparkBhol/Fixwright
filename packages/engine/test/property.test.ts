// 200 random seeded houses, symptoms and answers. Whatever happens:
//   * every output validates against the protocol schema
//   * 'confirmed' or 'likely' only when every claim cites ledger events about the device being diagnosed,
//     and at least one cites a fault this diagnosis observed; a likely verdict says its cause; a fix is
//     offered only when planRepair builds it (see support/verdict-invariants.ts)
//   * no disruptive probe during quiet hours unless the person said yes first, checked two ways: on the
//     probes the output reports, and on every switching command the adapter actually received (so a
//     flash that is not reported as a probe still counts); no switching at all after a consent no
//   * the posterior always sums to 1
// The clock moves on between answers and some diagnoses start minutes before quiet hours begin, so a
// conversation can cross into them (asking again must not repeat the flash once quiet hours begin).
// plus explain_event and home_checkup outputs validate on the same houses.

import { describe, expect, it } from 'vitest';
import {
  CONFIRM_THRESHOLD,
  ToolOutputs,
  manualClock,
  seededRng,
  type DiagnoseOutput,
  type Entity,
  type HouseEvent,
  type ManualClock,
  type Rng,
  type Transport,
} from '@fixwright/protocol';
import {
  answerDiagnosis,
  createMemoryLedger,
  defaultSettings,
  explainEvent,
  inQuietHours,
  isEngineError,
  runCheckup,
  startDiagnosis,
  type DiagnosisSession,
  type EngineDeps,
} from '../src/index.ts';
import { addEntity, addEvent, createFakeAdapter, emptyHouse, type FakeHouse } from './support/fake-adapter.ts';
import { emptyStats, verdictProblems, type VerdictStats } from './support/verdict-invariants.ts';

const CASES = 200;
const TZ = 'America/Los_Angeles';


const pick = <T,>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng.next() * items.length)] as T;
const chance = (rng: Rng, p: number): boolean => rng.next() < p;
const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng.next() * (hi - lo + 1));

const INTEGRATIONS: ReadonlyArray<[string, Transport, string]> = [
  ['hue', 'zigbee', 'Philips Hue'],
  ['zigbee2mqtt', 'zigbee', 'IKEA'],
  ['kasa', 'wifi', 'TP-Link Kasa'],
  ['matter', 'thread', 'Eve'],
  ['ecobee', 'cloud', 'ecobee'],
];
const AREAS = ['Hallway', 'Kitchen', 'Bedroom', 'Office', 'Porch', 'Garden', 'Nursery', 'Den'];
const KINDS: ReadonlyArray<[string, string]> = [
  ['light', 'Lamp'],
  ['light', 'Light'],
  ['switch', 'Plug'],
  ['fan', 'Fan'],
  ['switch', 'Heater Plug'],
];
const SYMPTOMS = [
  "the {} isn't responding",
  'the {} keeps turning on by itself',
  "why doesn't the {} work",
  'the wrong light turns on when I say {}',
  'the {} keeps dropping off',
  'something is wrong with the {}',
  "the {} won't turn on",
];
const ANSWERS = ['yes', 'no', 'haan', 'nahi', 'maybe', 'jal raha hai', 'not sure', 'ok', 'it did', "didn't blink", 'band hai', 'what'];

interface Case {
  house: FakeHouse;
  now: number;
  symptom: string;
  rng: Rng;
}

/** 21:50 on 15 Oct in Los Angeles: quiet hours begin ten minutes later. */
const BEFORE_QUIET = Date.parse('2026-10-16T04:50:00.000Z');

function randomCase(seed: number): Case {
  const rng = seededRng(seed);
  const now = chance(rng, 0.15)
    ? BEFORE_QUIET + int(rng, 0, 9) * 60_000
    : Date.parse('2026-10-15T00:00:00.000Z') + int(rng, 0, 47) * 3_600_000 + int(rng, 0, 59) * 60_000;
  const h = emptyHouse();
  h.hub.reachable = !chance(rng, 0.08);
  for (const [integration] of INTEGRATIONS) {
    const r = rng.next();
    h.integrations.push(
      r < 0.85 ? { integration, state: 'loaded' } : r < 0.93 ? { integration, state: 'setup_error', reason: 'auth token expired' } : { integration, state: 'setup_retry' },
    );
  }
  for (const [, , vendor] of INTEGRATIONS) if (chance(rng, 0.1)) h.cloud.set(vendor, pick(rng, ['degraded', 'outage', 'unknown'] as const));
  const names: string[] = [];
  const n = int(rng, 3, 14);
  for (let i = 0; i < n; i++) {
    const [domain, noun] = pick(rng, KINDS);
    const [integration, transport, vendor] = pick(rng, INTEGRATIONS);
    const name = names.length > 0 && chance(rng, 0.2) ? pick(rng, names) : `${pick(rng, AREAS)} ${noun}`;
    names.push(name);
    const offline = chance(rng, 0.35);
    const lastChanged = new Date(now - int(rng, 1, 20 * 24) * 3_600_000).toISOString();
    const entityId = `${domain}.${name.toLowerCase().replace(/ /g, '_')}_${i}`;
    const e = addEntity(
      h,
      {
        entityId,
        name,
        area: name.split(' ')[0] ?? 'Den',
        deviceId: `dev_${i}`,
        integration,
        transport,
        vendor,
        state: offline ? 'unavailable' : pick(rng, ['on', 'off']),
        lastChanged,
        lastUpdated: lastChanged,
        ...(offline && chance(rng, 0.5) ? { restored: true } : {}),
      },
      {
        ...(transport === 'wifi' ? { rssi: int(rng, -90, -45) } : chance(rng, 0.8) ? { linkQuality: int(rng, 10, 255) } : {}),
        ...(chance(rng, 0.2) ? { flaps24h: int(rng, 0, 15) } : {}),
        ...(chance(rng, 0.3) ? { powerOnBehavior: pick(rng, ['on', 'previous', 'off'] as const) } : {}),
        ...(chance(rng, 0.15) ? { batteryPct: int(rng, 1, 100) } : {}),
      },
    );
    // Some devices have a power on select the planner can change (sometimes without a 'previous' option),
    // some only report the setting, most have neither.
    if (domain !== 'fan' && chance(rng, 0.3)) {
      addEntity(h, {
        entityId: `select.${entityId.split('.')[1]}_power_on_behavior`,
        name: `${name} Power-on behavior`,
        deviceId: `dev_${i}`,
        integration,
        transport,
        state: pick(rng, ['on', 'on', 'previous', 'off']),
        attributes: { options: chance(rng, 0.85) ? ['off', 'on', 'toggle', 'previous'] : ['off', 'on'] },
      });
    }
    if (offline) addEvent(h, { ts: lastChanged, kind: 'availability', entityId: e.entityId, from: 'on', to: 'unavailable' });
    if (chance(rng, 0.3)) {
      const t = now - int(rng, 1, 20) * 3_600_000;
      addEvent(h, { ts: new Date(t).toISOString(), kind: 'state', entityId: e.entityId, from: 'off', to: 'on', ...(chance(rng, 0.5) ? { context: { automationId: 'evening' } } : {}) });
    }
  }
  if (chance(rng, 0.3)) {
    const back = now - int(rng, 1, 30) * 3_600_000;
    for (const e of [...h.entities.values()].slice(0, int(rng, 3, 8))) {
      addEvent(h, { ts: new Date(back + int(rng, 0, 9000)).toISOString(), kind: 'availability', entityId: e.entityId, from: 'unavailable', to: 'off' });
      addEvent(h, { ts: new Date(back + int(rng, 9000, 15000)).toISOString(), kind: 'state', entityId: e.entityId, from: 'off', to: 'on' });
    }
  }
  if (chance(rng, 0.2)) addEntity(h, { entityId: 'automation.evening', name: 'Evening', integration: 'automation', transport: 'virtual', state: 'on', attributes: { id: 'evening', entity_ids: ['switch.missing_plug'] } });
  const target = chance(rng, 0.85) ? pick(rng, names) : pick(rng, ['garage heater', 'bathroom fan', 'tv']);
  return { house: h, now, symptom: pick(rng, SYMPTOMS).replace('{}', target.toLowerCase()), rng };
}

function depsFor(c: Case, seed: number): { deps: EngineDeps; ledger: ReturnType<typeof createMemoryLedger>; clock: ManualClock } {
  const clock = manualClock(c.now);
  const ledger = createMemoryLedger();
  const entities = [...c.house.entities.values()];
  const protectedOne: Entity | undefined = entities.find((e) => e.domain === 'switch' && seed % 3 === 0);
  return {
    ledger,
    clock,
    deps: {
      adapter: createFakeAdapter(c.house, clock),
      ledger,
      clock,
      rng: seededRng(seed * 7919),
      settings: defaultSettings({ tz: TZ, protected: protectedOne ? [{ entity_id: protectedOne.entityId, name: protectedOne.name, reason: '' }] : [] }),
    },
  };
}

interface Tally {
  diagnoses: number;
  confirmed: number;
  questions: number;
  ambiguous: number;
  quietConsents: number;
  /** Switching commands sent during quiet hours (each checked against a recorded yes). */
  quietCommands: number;
  /** Conversations that started before quiet hours and were still going once they began. */
  crossedIntoQuiet: number;
  /** Repeat flashes before asking again, reported as probes. */
  repeatFlashes: number;
  verdicts: VerdictStats;
}

function checkOutput(output: DiagnoseOutput, session: DiagnosisSession, ledger: { all(): HouseEvent[] }, quietSince: (ms: number) => boolean, tally: Tally): void {
  const parsed = ToolOutputs.diagnose.safeParse(output);
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);

  const total = Object.values(session.posterior).reduce((s, p) => s + p, 0);
  expect(Math.abs(total - 1)).toBeLessThan(1e-9);
  expect(Object.values(session.posterior).every((p) => p >= 0 && Number.isFinite(p))).toBe(true);

  const events = ledger.all();
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  if (output.verdict?.level === 'confirmed') {
    tally.confirmed++;
    expect(output.verdict.confidence).toBeGreaterThanOrEqual(CONFIRM_THRESHOLD);
  }
  if (output.verdict !== undefined && output.verdict.level !== 'cant_tell') {
    expect(output.verdict.claims.length).toBeGreaterThan(0);
    const about = new Set([...session.entities.group, ...(session.entities.dut ? [session.entities.dut] : [])]);
    for (const claim of output.verdict.claims) {
      expect(claim.evidence.length).toBeGreaterThan(0);
      for (const seq of claim.evidence) {
        const e = bySeq.get(seq);
        expect(e, `claim "${claim.text}" cites missing seq ${seq}`).toBeDefined();
        const own = e?.data?.['diagnosis_id'] === session.diagnosis_id;
        const listed = Array.isArray(e?.data?.['entity_ids']) ? (e?.data?.['entity_ids'] as string[]) : [];
        const relevant = own || (e?.entityId !== undefined && about.has(e.entityId)) || listed.some((id) => about.has(id));
        expect(relevant, `claim "${claim.text}" cites seq ${seq}, unrelated to the diagnosis`).toBe(true);
      }
    }
  }

  // Disruptive probes in quiet hours need a yes to the consent question recorded before them.
  for (const p of output.probes) {
    if (!p.disruptive || !quietSince(Date.parse(p.at))) continue;
    const consent = events.find(
      (e) => e.kind === 'human_answer' && e.data?.['diagnosis_id'] === session.diagnosis_id && e.data?.['probe_id'] === 'flash_test_consent' && e.data?.['parsed'] === 'yes',
    );
    expect(consent, `disruptive ${p.probe_id} at ${p.at} in quiet hours without consent`).toBeDefined();
    expect(Date.parse(consent?.ts ?? '')).toBeLessThanOrEqual(Date.parse(p.at));
    tally.quietConsents++;
  }
}

/** Every switching command the adapter got during quiet hours must follow a yes to the consent question. */
function checkCommands(c: Case, session: DiagnosisSession, ledger: { all(): HouseEvent[] }, quiet: (ms: number) => boolean, tally: Tally): void {
  const consents = ledger
    .all()
    .filter((e) => e.kind === 'human_answer' && e.data?.['diagnosis_id'] === session.diagnosis_id && e.data?.['probe_id'] === 'flash_test_consent');
  for (const call of c.house.calls) {
    const ms = Date.parse(call.at);
    if (!quiet(ms)) continue;
    const yes = consents.find((e) => e.data?.['parsed'] === 'yes' && Date.parse(e.ts) <= ms);
    expect(yes, `${call.domain}.${call.service} at ${call.at} in quiet hours without a yes`).toBeDefined();
    const no = consents.find((e) => e.data?.['parsed'] === 'no' && Date.parse(e.ts) <= ms);
    expect(no, `${call.domain}.${call.service} at ${call.at} after a consent no`).toBeUndefined();
  }
}

describe(`property: ${CASES} random seeded houses`, () => {
  it('never confirms without evidence, never disturbs quiet hours unasked, and keeps the posterior normalised', async () => {
    const tally: Tally = {
      diagnoses: 0,
      confirmed: 0,
      questions: 0,
      ambiguous: 0,
      quietConsents: 0,
      quietCommands: 0,
      crossedIntoQuiet: 0,
      repeatFlashes: 0,
      verdicts: emptyStats(),
    };
    for (let seed = 1; seed <= CASES; seed++) {
      const c = randomCase(seed);
      const { deps, ledger, clock } = depsFor(c, seed);
      const quiet = (ms: number): boolean => inQuietHours(ms, TZ, deps.settings.quietHours);
      const callsBefore = (): number => c.house.calls.length;
      let result;
      try {
        result = await startDiagnosis({ symptom: c.symptom }, deps);
      } catch (err) {
        expect(isEngineError(err) && err.code === 'ambiguous_device', String(err)).toBe(true);
        tally.ambiguous++;
        continue;
      }
      tally.diagnoses++;
      if (quiet(c.now)) expect(callsBefore()).toBe(0);
      checkOutput(result.output, result.session, ledger, quiet, tally);
      const startedQuiet = quiet(c.now);
      let crossed = false;
      for (let turn = 0; turn < 8 && result.output.status === 'needs_answer'; turn++) {
        tally.questions++;
        const question = result.output.question;
        if (!question) throw new Error('needs_answer without a question');
        // People take a moment to answer; sometimes long enough for quiet hours to begin.
        clock.advance(int(c.rng, 0, 4) * 60_000 + int(c.rng, 0, 59) * 1000);
        if (!startedQuiet && quiet(clock.nowMs())) crossed = true;
        const consentAsked = result.session.pending?.kind === 'consent';
        const calls = callsBefore();
        const said = pick(c.rng, ANSWERS);
        result = await answerDiagnosis(JSON.parse(JSON.stringify(result.session)) as DiagnosisSession, { diagnosis_id: result.session.diagnosis_id, question_id: question.question_id, answer: said }, deps);
        if (quiet(clock.nowMs()) && consentAsked && result.session.consent.disruptive !== 'granted') expect(callsBefore()).toBe(calls);
        checkOutput(result.output, result.session, ledger, quiet, tally);
      }
      if (crossed) tally.crossedIntoQuiet++;
      tally.repeatFlashes += result.output.probes.filter((p) => p.label === 'Flash test again').length;
      tally.quietCommands += c.house.calls.filter((call) => quiet(Date.parse(call.at))).length;
      checkCommands(c, result.session, ledger, quiet, tally);
      expect(result.output.status === 'ok' || result.session.questions_asked > 0).toBe(true);
      const callsBeforePlan = c.house.calls.length;
      expect(await verdictProblems(result.output, result.session, ledger.all(), deps, tally.verdicts), `seed ${seed}: ${c.symptom}`).toEqual([]);
      expect(c.house.calls.length).toBe(callsBeforePlan);

      const ex = await explainEvent({ question: pick(c.rng, ['why did everything turn on last night', 'why did the lights come on at 3 a.m.', 'what happened today']) }, deps);
      const exParsed = ToolOutputs.explain_event.safeParse(ex.output);
      expect(exParsed.success, exParsed.success ? '' : JSON.stringify(exParsed.error.issues)).toBe(true);
      const ck = await runCheckup({}, deps);
      const ckParsed = ToolOutputs.home_checkup.safeParse(ck.output);
      expect(ckParsed.success, ckParsed.success ? '' : JSON.stringify(ckParsed.error.issues)).toBe(true);
    }
    // The generator must actually reach the interesting paths, or the properties prove little.
    expect(tally.diagnoses).toBeGreaterThan(CASES * 0.5);
    expect(tally.confirmed).toBeGreaterThan(10);
    expect(tally.questions).toBeGreaterThan(50);
    expect(tally.crossedIntoQuiet).toBeGreaterThan(3);
    expect(tally.repeatFlashes).toBeGreaterThan(3);
    expect(tally.quietCommands).toBeGreaterThan(10);
    expect(tally.verdicts.likely).toBeGreaterThan(5);
    expect(tally.verdicts.worksNow).toBeGreaterThan(5);
    expect(tally.verdicts.fixesPlanned).toBeGreaterThan(10);
    console.info(`property tally: ${JSON.stringify(tally)}`);
  }, 60_000);
});


