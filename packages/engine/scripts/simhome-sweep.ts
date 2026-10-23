// SimHome golden sweep: runs the golden path on homefault's SimHome twin for many seeds, then replays the
// cases that once went wrong (own writes, "at 3", battery devices, two faults, the next morning), checking
// every output against its protocol schema and every finished diagnosis against
// test/support/verdict-invariants.ts. Prints a tally; exits 1 on any violation.
// Not part of `npm run check` (homefault is imported dynamically, like scripts/simhome-smoke.ts).
// Usage: node scripts/simhome-sweep.ts [firstSeed] [lastSeed]   (default 1 to 200)

import { ToolOutputs, seededRng, type DiagnoseOutput, type HomeAdapter, type ProtectedDevice } from '@fixwright/protocol';
import {
  answerDiagnosis,
  createMemoryLedger,
  defaultSettings,
  executePlan,
  explainEvent,
  inferTopology,
  morningCheck,
  morningCheckAt,
  planRepair,
  protectedGuard,
  runCheckup,
  startDiagnosis,
  type DiagnosisSession,
  type EngineDeps,
  type MemoryLedger,
} from '../src/index.ts';
import { emptyStats, verdictProblems } from '../test/support/verdict-invariants.ts';

interface Sim extends HomeAdapter {
  advanceTo(time: string | number): void;
}
interface SimHomeModule {
  SimHome: { create(opts: { seed: number }): Sim };
}

const TZ = 'America/Los_Angeles';
const SPEC = {
  ask: "I'll flash the hallway lamp twice. Did it blink?",
  verdict: 'The lamp works. The name Hallway Lamp still points at an old copy of it that went offline on October 3.',
  explain: 'Power came back at 3:12. Fourteen devices restarted within four seconds. None of your automations fired. I can make them remember whether they were on or off. Do it?',
  cards: ['Two lights answer to Living Room Light', 'Hall motion sensor battery at 6%', 'Kitchen plug dropped off Wi-Fi 9 times today'],
  guard: "That strip runs the aquarium filter, which you marked protected. I'll turn off the lamp on it instead.",
  morning: /^Hallway lamp (answered all \d+ commands overnight|answered both commands it got overnight|answered the one command it got overnight|stayed online all night)\. Repair confirmed\.$/,
};

const first = Number(process.argv[2] ?? 1);
const last = Number(process.argv[3] ?? 200);
const path = new URL('../../homefault/src/index.ts', import.meta.url).href;
const { SimHome } = (await import(path)) as SimHomeModule;

async function rig(seed: number): Promise<{ sim: Sim; deps: EngineDeps & { ledger: MemoryLedger } }> {
  const sim = SimHome.create({ seed });
  // The person marked the aquarium filter protected.
  const filter = (await sim.listEntities()).find((e) => /aquarium/i.test(e.name));
  const guarded: ProtectedDevice[] = filter ? [{ entity_id: filter.entityId, name: filter.name, reason: 'The fish need it running.' }] : [];
  return {
    sim,
    deps: {
      adapter: sim,
      ledger: createMemoryLedger(),
      clock: { now: () => sim.now(), nowMs: () => Date.parse(sim.now()) },
      rng: seededRng(seed),
      settings: defaultSettings({ tz: TZ, protected: guarded }),
    },
  };
}

const tally = {
  seeds: 0,
  spec: { ask: 0, confirmed: 0, verdict: 0, repaired: 0, explain: 0, powerFix: 0, cards: 0, guard: 0, morning: 0 },
  ownWritesAndBattery: { someoneAfterOwnWrites: 0, ownWriteNamed: 0, at3RestoreStory: 0, batteryWallSwitch: 0, batteryClaimed: 0, deadTriggerNamed: 0, staleForTurnsOn: 0 },
  subjectAndBlink: { blinkOwnWrite: 0, blinkRestoreOrFix: 0, lampAt3Own: 0, kitchenPlugAt3am: 0, turnsOnPowerOnNamed: 0, turnsOnFixPlanned: 0, turnsOnCantTell: 0 },
  // The golden path in its real order (steps 1 to 4, the 07:00 jump, then step 5), and the two fault house answering no.
  roundD: { morningPass: 0, at3amAfterMorning: 0, at3AfterMorning: 0, powerFix14AfterMorning: 0, turnsOnNoPowerOnNamed: 0, turnsOnNoCantTell: 0 },
  diagnoses: 0,
  invalidOutputs: 0,
  verdicts: emptyStats(),
};
const problems: string[] = [];
const valid = (seed: number, tool: keyof typeof ToolOutputs, out: unknown): void => {
  if (!ToolOutputs[tool].safeParse(out).success) {
    tally.invalidOutputs++;
    problems.push(`seed ${seed}: ${tool} output invalid`);
  }
};

async function converse(seed: number, deps: EngineDeps & { ledger: MemoryLedger }, symptom: string, answer: string) {
  let r = await startDiagnosis({ symptom }, deps);
  valid(seed, 'diagnose', r.output);
  const asked: string[] = [];
  for (let i = 0; i < 8 && r.output.question; i++) {
    asked.push(r.output.question.text);
    r = await answerDiagnosis(r.session, { diagnosis_id: r.session.diagnosis_id, question_id: r.output.question.question_id, answer }, deps);
    valid(seed, 'diagnose_answer', r.output);
  }
  await check(seed, symptom, r.output, r.session, deps);
  return { ...r, asked };
}

async function check(seed: number, symptom: string, output: DiagnoseOutput, session: DiagnosisSession, deps: EngineDeps & { ledger: MemoryLedger }) {
  tally.diagnoses++;
  for (const p of await verdictProblems(output, session, deps.ledger.all(), deps, tally.verdicts)) problems.push(`seed ${seed} "${symptom}": ${p}`);
}

for (let seed = first; seed <= last; seed++) {
  tally.seeds++;
  const { sim, deps } = await rig(seed);
  const dx = await startDiagnosis({ symptom: "Why the hallway lamp keeps saying it's not responding" }, deps);
  valid(seed, 'diagnose', dx.output);
  if (dx.output.question?.text === SPEC.ask) tally.spec.ask++;
  let repairedAt: string | undefined;
  let lampPlan: Awaited<ReturnType<typeof planRepair>>['plan'] | undefined;
  if (dx.output.question) {
    const yes = await answerDiagnosis(dx.session, { diagnosis_id: dx.session.diagnosis_id, question_id: dx.output.question.question_id, answer: 'Yes, it blinked.' }, deps);
    valid(seed, 'diagnose_answer', yes.output);
    await check(seed, 'golden', yes.output, yes.session, deps);
    if (yes.output.verdict?.level === 'confirmed' && yes.output.verdict.cause_id === 'stale_duplicate') tally.spec.confirmed++;
    if (yes.output.speech.startsWith(SPEC.verdict)) tally.spec.verdict++;
    if (yes.output.verdict?.fix_available) {
      const plan = await planRepair({ kind: 'diagnosis', session: yes.session }, deps);
      valid(seed, 'repair_plan', plan.output);
      const applied = await executePlan(plan.plan, deps);
      if (applied.state === 'applied') tally.spec.repaired++;
      lampPlan = plan.plan;
      repairedAt = sim.now();
    }
  }
  // Right after Fixwright's own flash and flash check, nobody "used the app".
  for (const q of ['Why did every plug turn on at 3?', 'why did the hallway lamp turn on just now?']) {
    const ex = await explainEvent({ question: q }, deps);
    valid(seed, 'explain_event', ex.output);
    if (/someone/i.test(ex.output.speech)) {
      tally.ownWritesAndBattery.someoneAfterOwnWrites++;
      problems.push(`seed ${seed} "${q}": ${ex.output.speech}`);
    }
    if (ex.session.detector === 'fixwright') tally.ownWritesAndBattery.ownWriteNamed++;
    if (q.endsWith('at 3?') && ex.session.detector === 'power_restore') tally.ownWritesAndBattery.at3RestoreStory++;
  }
  // Own writes in other wordings, and "at 3" for a device with nothing at 3 p.m.
  {
    const blink = await explainEvent({ question: 'why did the hallway lamp blink?' }, deps);
    valid(seed, 'explain_event', blink.output);
    if (blink.session.detector === 'fixwright') tally.subjectAndBlink.blinkOwnWrite++;
    if (blink.session.detector === 'power_restore' || blink.output.suggested_fix) {
      tally.subjectAndBlink.blinkRestoreOrFix++;
      problems.push(`seed ${seed} blink: ${blink.output.speech}`);
    }
    const lamp = await explainEvent({ question: 'why did the hallway lamp turn on at 3?' }, deps);
    valid(seed, 'explain_event', lamp.output);
    if (lamp.session.detector === 'fixwright') tally.subjectAndBlink.lampAt3Own++;
    const plug = await explainEvent({ question: 'why did the kitchen plug turn on at 3?' }, deps);
    valid(seed, 'explain_event', plug.output);
    // 3 a.m. Pacific daylight time is 10:00 UTC.
    if (new Date(plug.session.window.since).getUTCHours() === 10) tally.subjectAndBlink.kitchenPlugAt3am++;
  }
  const ex = await explainEvent({ question: 'Why did every plug turn on at 3 a.m.?' }, deps);
  valid(seed, 'explain_event', ex.output);
  if (ex.output.speech === SPEC.explain && ex.output.verdict.level === 'confirmed') tally.spec.explain++;
  if (ex.session.suggested_fix) {
    const plan = await planRepair({ kind: 'explanation', session: ex.session }, deps);
    valid(seed, 'repair_plan', plan.output);
    if ((await executePlan(plan.plan, deps)).state === 'applied') tally.spec.powerFix++;
  }
  const ck = await runCheckup({}, deps);
  valid(seed, 'home_checkup', ck.output);
  const titles = ck.output.findings.map((f) => f.title);
  if (SPEC.cards.every((c) => titles.includes(c))) tally.spec.cards++;
  const all = await sim.listEntities();
  const strip = all.find((e) => e.entityId === 'switch.living_room_power_strip');
  if (strip) {
    const d = protectedGuard('turn_off', strip, deps.settings.protected, inferTopology(all), { states: all });
    if (!d.allow && d.speech === SPEC.guard) tally.spec.guard++;
  }
  // The 07:00 jump of step 4 runs last: explain and the checkup come before it here, and
  // the real order is replayed further down.
  if (lampPlan && repairedAt) {
    const at = morningCheckAt(lampPlan, Date.parse(repairedAt), TZ);
    if (at) {
      sim.advanceTo(at);
      const mc = await morningCheck(lampPlan, repairedAt, deps);
      if (mc.result === 'pass' && SPEC.morning.test(mc.speech)) tally.spec.morning++;
      else problems.push(`seed ${seed} morning check: ${mc.result} "${mc.speech}"`);
    }
  }

  // A battery sensor, an automation with a removed device and a lamp that turns on by itself, each on a fresh house.
  {
    const r = await rig(seed);
    const out = await converse(seed, r.deps, "the hall motion sensor isn't working", 'yes');
    if (out.asked.some((q) => /wall|plugged/i.test(q))) tally.ownWritesAndBattery.batteryWallSwitch++;
    if (/battery/.test(out.output.speech)) tally.ownWritesAndBattery.batteryClaimed++;
  }
  {
    const r = await rig(seed);
    const out = await converse(seed, r.deps, "the night lights automation doesn't work", 'yes');
    const passed = out.output.probes.some((p) => p.probe_id === 'registry_scan' && p.outcome === 'pass');
    if (passed && /an automation using a removed device/.test(out.output.speech)) tally.ownWritesAndBattery.deadTriggerNamed++;
  }
  {
    const r = await rig(seed);
    const out = await converse(seed, r.deps, 'the hallway lamp keeps turning on by itself', 'yes');
    const v = out.output.verdict;
    if (v?.cause_id === 'stale_duplicate' && v.level !== 'cant_tell') tally.ownWritesAndBattery.staleForTurnsOn++;
    if (v?.cause_id === 'power_on_default_on' && v.level !== 'cant_tell') tally.subjectAndBlink.turnsOnPowerOnNamed++;
    if (v?.cause_id === 'power_on_default_on' && v.fix_available) {
      const plan = await planRepair({ kind: 'diagnosis', session: out.session }, r.deps);
      if ((await executePlan(plan.plan, r.deps)).state === 'applied') tally.subjectAndBlink.turnsOnFixPlanned++;
    }
    if (v?.level === 'cant_tell') tally.subjectAndBlink.turnsOnCantTell++;
  }
  // The same complaint answering no (a power problem and an old copy are both set aside).
  {
    const r = await rig(seed);
    const out = await converse(seed, r.deps, 'the hallway lamp keeps turning on by itself', 'no');
    const v = out.output.verdict;
    if (v?.cause_id === 'power_on_default_on' && v.level !== 'cant_tell') tally.roundD.turnsOnNoPowerOnNamed++;
    if (v?.level === 'cant_tell') tally.roundD.turnsOnNoCantTell++;
  }
  // Real order: after step 4's jump to 07:00, "at 3 a.m." (no date) still finds the outage night.
  {
    const { sim: s2, deps: d2 } = await rig(seed);
    const dx2 = await startDiagnosis({ symptom: "Why the hallway lamp keeps saying it's not responding" }, d2);
    const q2 = dx2.output.question;
    if (q2) {
      const yes2 = await answerDiagnosis(dx2.session, { diagnosis_id: dx2.session.diagnosis_id, question_id: q2.question_id, answer: 'Yes, it blinked.' }, d2);
      const plan2 = await planRepair({ kind: 'diagnosis', session: yes2.session }, d2);
      await executePlan(plan2.plan, d2);
      const fixedAt = s2.now();
      const at2 = morningCheckAt(plan2.plan, Date.parse(fixedAt), TZ);
      if (at2) {
        s2.advanceTo(at2);
        if ((await morningCheck(plan2.plan, fixedAt, d2)).result === 'pass') tally.roundD.morningPass++;
        const ex2 = await explainEvent({ question: 'Why did every plug turn on at 3 a.m.?' }, d2);
        valid(seed, 'explain_event', ex2.output);
        if (ex2.output.speech === SPEC.explain && ex2.output.verdict.level === 'confirmed') tally.roundD.at3amAfterMorning++;
        else problems.push(`seed ${seed} at 3 a.m. after the morning jump: ${ex2.output.speech}`);
        const at3 = await explainEvent({ question: 'Why did every plug turn on at 3?' }, d2);
        valid(seed, 'explain_event', at3.output);
        if (at3.output.speech === SPEC.explain.replace('at 3:12.', 'at 3:12 a.m.')) tally.roundD.at3AfterMorning++;
        else problems.push(`seed ${seed} at 3 after the morning jump: ${at3.output.speech}`);
        if (ex2.session.suggested_fix) {
          const fix2 = await planRepair({ kind: 'explanation', session: ex2.session }, d2);
          if (fix2.plan.steps.length === 14) tally.roundD.powerFix14AfterMorning++;
        }
      }
    }
  }
}

console.log(JSON.stringify(tally, null, 1));
if (problems.length > 0) {
  console.log(`${problems.length} problems:`);
  for (const p of problems.slice(0, 40)) console.log(`  ${p}`);
  process.exitCode = 1;
}
