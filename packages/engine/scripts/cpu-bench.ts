// Measures engine CPU per tool step on the golden house in Node, to check it fits the Workers CPU budget
// (10 ms per request on the Free plan). The FakeAdapter answers from memory, so the time measured is the
// engine's own work plus a trivial adapter. Each run uses a fresh house and ledger; 20 warmup runs first.
// The first request in a fresh process is measured separately, in child processes, with and without
// warmUp() at startup (what a Worker would run at module scope).
// Usage: node scripts/cpu-bench.ts [runs]   (writes BENCH_CPU.json next to package.json)

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { answerDiagnosis, explainEvent, planRepair, runCheckup, startDiagnosis, warmUp } from '../src/index.ts';
import { rig } from '../test/support/golden-house.ts';

const FIRST_MODE = process.argv[2] === '--first' ? (process.argv[3] ?? 'cold') : undefined;
const RUNS = FIRST_MODE ? 0 : Number(process.argv[2] ?? 200);
const CHILDREN = 5;
const WARMUP = 20;
const SYMPTOM = "Why the hallway lamp keeps saying it's not responding";

type Step = 'diagnose' | 'diagnose_answer' | 'repair_plan' | 'explain_event' | 'home_checkup';

async function measure<T>(fn: () => Promise<T>): Promise<{ cpuMs: number; wallMs: number; value: T }> {
  const c0 = process.cpuUsage();
  const w0 = performance.now();
  const value = await fn();
  const wallMs = performance.now() - w0;
  const c = process.cpuUsage(c0);
  return { cpuMs: (c.user + c.system) / 1000, wallMs, value };
}

async function once(): Promise<Record<Step, { cpuMs: number; wallMs: number }>> {
  const r = rig();
  const dx = await measure(() => startDiagnosis({ symptom: SYMPTOM }, r.deps));
  const q = dx.value.output.question?.question_id ?? '';
  const ans = await measure(() => answerDiagnosis(dx.value.session, { diagnosis_id: dx.value.session.diagnosis_id, question_id: q, answer: 'yes' }, r.deps));
  const plan = await measure(() => planRepair({ kind: 'diagnosis', session: ans.value.session }, r.deps));
  const ex = await measure(() => explainEvent({ question: 'Why did every plug turn on at 3 a.m.?' }, r.deps));
  const ck = await measure(() => runCheckup({}, r.deps));
  if (ans.value.output.verdict?.level !== 'confirmed') throw new Error('golden diagnosis did not confirm');
  const pick = (m: { cpuMs: number; wallMs: number }) => ({ cpuMs: m.cpuMs, wallMs: m.wallMs });
  return { diagnose: pick(dx), diagnose_answer: pick(ans), repair_plan: pick(plan), explain_event: pick(ex), home_checkup: pick(ck) };
}

const cpuNow = (): number => {
  const c = process.cpuUsage();
  return (c.user + c.system) / 1000;
};

if (FIRST_MODE) {
  // Child process: one first request in a fresh process, optionally after warmUp().
  const w0 = cpuNow();
  if (FIRST_MODE === 'warm') await warmUp('America/Los_Angeles');
  const warmupMs = cpuNow() - w0;
  const run = await once();
  console.log(JSON.stringify({ warmup_cpu_ms: warmupMs, ...Object.fromEntries(Object.entries(run).map(([k, v]) => [k, v.cpuMs])) }));
  process.exit(0);
}

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
};
const round = (x: number): number => Math.round(x * 1000) / 1000;

const cold = await once();
for (let i = 0; i < WARMUP; i++) await once();
const samples: Record<Step, { cpu: number[]; wall: number[] }> = {
  diagnose: { cpu: [], wall: [] },
  diagnose_answer: { cpu: [], wall: [] },
  repair_plan: { cpu: [], wall: [] },
  explain_event: { cpu: [], wall: [] },
  home_checkup: { cpu: [], wall: [] },
};
for (let i = 0; i < RUNS; i++) {
  const run = await once();
  for (const step of Object.keys(samples) as Step[]) {
    samples[step].cpu.push(run[step].cpuMs);
    samples[step].wall.push(run[step].wallMs);
  }
}

const self = fileURLToPath(import.meta.url);
function firstRequests(mode: 'cold' | 'warm'): Record<string, number> {
  const rows = Array.from({ length: CHILDREN }, () => JSON.parse(execFileSync(process.execPath, [self, '--first', mode], { encoding: 'utf8' })) as Record<string, number>);
  const keys = Object.keys(rows[0] ?? {});
  return Object.fromEntries(keys.map((k) => [`${k}_median`, round(quantile(rows.map((r) => r[k] ?? NaN), 0.5))]));
}
const firstRequest = { processes_per_mode: CHILDREN, without_warmup: firstRequests('cold'), after_warmup: firstRequests('warm') };

const steps = Object.fromEntries(
  (Object.keys(samples) as Step[]).map((step) => [
    step,
    {
      cpu_ms_median: round(quantile(samples[step].cpu, 0.5)),
      cpu_ms_p95: round(quantile(samples[step].cpu, 0.95)),
      cpu_ms_max: round(Math.max(...samples[step].cpu)),
      wall_ms_median: round(quantile(samples[step].wall, 0.5)),
      wall_ms_p95: round(quantile(samples[step].wall, 0.95)),
      cold_first_run_cpu_ms: round(cold[step].cpuMs),
    },
  ]),
);

const result = {
  measured_at: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  runs: RUNS,
  warmup_runs: WARMUP,
  house: 'golden house (F1 to F5 plus power strip), FakeAdapter in memory',
  budget_ms: 10,
  steps,
  first_request_in_fresh_process: firstRequest,
};
writeFileSync(new URL('../BENCH_CPU.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
