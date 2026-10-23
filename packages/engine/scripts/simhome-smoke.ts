// Runs the golden path against homefault's SimHome twin and prints each spoken line, so
// the engine's reading of real SimHome data can be checked by eye. Not part of `npm run check`: homefault
// is built in parallel, so it is imported dynamically and only its HomeAdapter shape is relied on.
// Usage: node scripts/simhome-smoke.ts [seed]

import { ToolOutputs, seededRng, type HomeAdapter, type ProtectedDevice } from '@fixwright/protocol';
import {
  answerDiagnosis,
  createMemoryLedger,
  defaultSettings,
  executePlan,
  explainEvent,
  inferTopology,
  planRepair,
  protectedGuard,
  runCheckup,
  startDiagnosis,
  type EngineDeps,
} from '../src/index.ts';

interface SimHomeModule {
  SimHome: { create(opts: { seed: number }): HomeAdapter };
}

const seed = Number(process.argv[2] ?? 1);
const path = new URL('../../homefault/src/index.ts', import.meta.url).href;
const { SimHome } = (await import(path)) as SimHomeModule;
const adapter = SimHome.create({ seed });
const entities = await adapter.listEntities();
const filter = entities.find((e) => /aquarium/i.test(e.name));
const guarded: ProtectedDevice[] = filter ? [{ entity_id: filter.entityId, name: filter.name, reason: 'The fish need it running.' }] : [];
const deps: EngineDeps = {
  adapter,
  ledger: createMemoryLedger(),
  clock: { now: () => adapter.now(), nowMs: () => Date.parse(adapter.now()) },
  rng: seededRng(seed),
  settings: defaultSettings({ tz: 'America/Los_Angeles', protected: guarded }),
};
const ok = (tool: keyof typeof ToolOutputs, out: unknown): string => (ToolOutputs[tool].safeParse(out).success ? 'valid' : 'INVALID');

console.log(`SimHome seed ${seed}, now ${adapter.now()}`);
const dx = await startDiagnosis({ symptom: "Why the hallway lamp keeps saying it's not responding" }, deps);
console.log(`1 diagnose (${ok('diagnose', dx.output)}): ${dx.output.speech}`);
console.log(`  probes: ${dx.output.probes.map((p) => `${p.probe_id} ${p.outcome}`).join(', ')}`);
console.log(`  hypotheses: ${dx.output.hypotheses.map((h) => `${h.cause_id} ${h.p}`).join(', ')}`);
if (dx.output.question) {
  const yes = await answerDiagnosis(dx.session, { diagnosis_id: dx.session.diagnosis_id, question_id: dx.output.question.question_id, answer: 'Yes, it blinked.' }, deps);
  console.log(`2 diagnose_answer (${ok('diagnose_answer', yes.output)}): ${yes.output.speech} [${yes.output.verdict?.level} ${yes.output.verdict?.confidence}]`);
  if (yes.output.verdict?.fix_available) {
    const plan = await planRepair({ kind: 'diagnosis', session: yes.session }, deps);
    console.log(`3 repair_plan (${ok('repair_plan', plan.output)}): ${plan.output.speech}`);
    const applied = await executePlan(plan.plan, deps);
    console.log(`  repair_apply ${applied.state}: ${applied.speech}`);
  }
}
const ex = await explainEvent({ question: 'Why did every plug turn on at 3 a.m.?' }, deps);
console.log(`5 explain_event (${ok('explain_event', ex.output)}): ${ex.output.speech} [${ex.output.verdict.level}]`);
if (ex.session.suggested_fix) {
  const plan = await planRepair({ kind: 'explanation', session: ex.session }, deps);
  const applied = await executePlan(plan.plan, deps);
  console.log(`  repair ${plan.plan.steps.length} steps, ${applied.state}: ${applied.speech}`);
}
const ck = await runCheckup({}, deps);
console.log(`6 home_checkup (${ok('home_checkup', ck.output)}): ${ck.output.speech}`);
for (const f of ck.output.findings) console.log(`  ${f.severity} ${f.kind}: ${f.title}`);
const all = await adapter.listEntities();
const strip = all.find((e) => e.entityId === 'switch.living_room_power_strip');
if (strip) {
  const d = protectedGuard('turn_off', strip, deps.settings.protected, inferTopology(all), { states: all });
  console.log(`7 switch_device: ${d.allow ? 'allowed' : d.speech}`);
}
