// Writes results/HOMETRUTH.txt, the plain text account of the full HomeTruth run, from the result files
// that run wrote. Nothing here is typed in by hand: every number is read from a result file or computed
// from its case rows with the same functions the runner uses (computeMetrics, evaluateKillSwitch).
//   node src/hometruth.ts            reads results/hometruth-*.json, writes results/HOMETRUTH.txt
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateKillSwitch, MIN_CONCLUSIVE_N, type Comparison, type KillSwitch } from './killswitch.ts';
import { computeMetrics, type AgentMetrics, type AgentName, type CaseRow } from './metrics.ts';
import type { Report } from './report.ts';
import type { SetName } from './sample.ts';
import type { Rate } from './stats.ts';

const RESULTS = join(fileURLToPath(new URL('..', import.meta.url)), 'results');
const FULL_SETS = ['dev', 'heldout', 'incidents', 'all'] as const satisfies readonly SetName[];

/** The result names the full run writes (scripts/hometruth-full.sh). */
export const HOMETRUTH_NAMES = {
  final: (set: SetName) => `hometruth-fixwright-${set}`,
  start: (set: SetName) => `hometruth-start-fixwright-${set}`,
  diagnoseOnly: 'hometruth-fixwright-all-diagnose-only',
  heldout: 'hometruth-heldout-b1b2-n100',
  incidents: 'hometruth-incidents-b1b2',
} as const;

export interface HometruthInput {
  writtenAt: string;
  /** Fixwright alone on every set, run after the baselines (the engine as it is at the end). */
  final: Record<(typeof FULL_SETS)[number], Report>;
  /** The same runs made before the baselines started, to show whether the engine changed meanwhile. */
  start: Partial<Record<SetName, Report>>;
  diagnoseOnly: Report | null;
  /** Fixwright, B1 and B2 on the stratified held-out sample, and on the incidents. */
  heldout: Report;
  incidents: Report;
}

const f3 = (x: number | null): string => (x === null ? 'n/a' : x.toFixed(3));
const f2 = (x: number): string => x.toFixed(2);
const ci = (r: Rate): string => (r.ci95 ? `95% CI ${f3(r.ci95[0])} to ${f3(r.ci95[1])}` : 'no interval');
const rateText = (r: Rate): string => `${f3(r.value)} (${r.k} of ${r.n}), ${ci(r)}`;
const secs = (ms: number): string => {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min ${s % 60} s` : `${(ms / 1000).toFixed(1)} s`;
};
/** Greedy word wrap for long prose lines, each line starting with indent. */
function wrap(text: string, indent: string, width = 104): string[] {
  const out: string[] = [];
  let line = indent;
  for (const word of text.split(' ')) {
    if (line.length > indent.length && line.length + 1 + word.length > width) {
      out.push(line);
      line = indent;
    }
    line += line.length > indent.length ? ` ${word}` : word;
  }
  if (line.length > indent.length) out.push(line);
  return out;
}
const AGENT_LABEL: Record<AgentName, string> = { fixwright: 'Fixwright', b1: 'B1', b2: 'B2' };

function agentLines(agent: AgentName, m: AgentMetrics, indent = '    '): string[] {
  const out = [
    `${indent}top1                 ${rateText(m.top1)}`,
    `${indent}false confirmations  ${m.false_confirmed.count}, rate ${rateText(m.false_confirmed.rate)}`,
    `${indent}abstention           ${rateText(m.abstention)}`,
    `${indent}confirmed precision  ${rateText(m.confirmed_precision)}`,
    `${indent}top1 when answering  ${rateText(m.top1_answered)}`,
  ];
  if (agent === 'fixwright') {
    out.push(`${indent}probes               mean ${f2(m.probes_used.mean)}, disruptive mean ${f2(m.disruptive_probes.mean)}; questions to the person mean ${f2(m.human_questions.mean)}`);
  } else {
    out.push(`${indent}invalid outputs      ${m.invalid_outputs.count} (counted as can't tell); infra failures ${m.infra_errors}`);
  }
  return out;
}

/** Fixwright, B1 and B2 on the scenarios of one baseline run (Fixwright as it ran next to them). */
function pairedBlock(title: string, rows: readonly CaseRow[]): string[] {
  const out = [title];
  const by = (a: AgentName) => rows.filter((r) => r.agent === a);
  for (const a of ['fixwright', 'b1', 'b2'] as const) {
    const rs = by(a);
    if (rs.length === 0) continue;
    out.push(`  ${AGENT_LABEL[a]} (n ${rs.length})`, ...agentLines(a, computeMetrics(rs)));
  }
  const causes = [...new Set(by('fixwright').map((r) => r.expected))].sort();
  out.push('  top1 per cause (correct of n): Fixwright, B1, B2');
  for (const c of causes) {
    const cell = (a: AgentName) => {
      const rs = by(a).filter((r) => r.expected === c);
      return `${rs.filter((r) => r.correct).length} of ${rs.length}`;
    };
    out.push(`    ${c.padEnd(22)} ${cell('fixwright').padEnd(9)} ${cell('b1').padEnd(9)} ${cell('b2')}`);
  }
  return out;
}

function comparisonLines(c: Comparison): string[] {
  const name = AGENT_LABEL[c.baseline];
  const line = (label: string, m: Comparison['top1'], only: string) => [
    `      ${label.padEnd(16)} Fixwright ${f3(m.fixwright.value)} [${ci(m.fixwright)}], ${name} ${f3(m.baseline.value)} [${ci(m.baseline)}]; matches: ${m.match ? 'yes' : 'no'}`,
    `      ${''.padEnd(16)} paired: ${only} Fixwright ${m.paired.b}, only ${name} ${m.paired.c}, exact McNemar p ${m.paired.p_mcnemar.toPrecision(3)}`,
  ];
  return [
    `    ${name} vs Fixwright on the same ${c.n} scenarios: ${c.matches ? 'matches on both' : 'does not match on both'}`,
    ...line('top1', c.top1, 'right only for'),
    ...line('false confirmed', c.false_confirmed, 'falsely confirmed only by'),
  ];
}

/** B1 and B2 rows whose call never got an answer from the LLM server (scored as can't tell). */
const unanswered = (rows: readonly CaseRow[]): number => rows.filter((r) => r.agent !== 'fixwright' && r.infra_error).length;

function killSwitchLines(label: string, k: KillSwitch, lost: number): string[] {
  const rule = k.conclusive ? (k.fires ? 'FIRES' : 'does not fire') : `not conclusive (the rule alone would say ${k.provisional_fires ? 'fires' : 'does not fire'})`;
  // An unanswered call is scored as can't tell, which lowers the baseline and so makes the switch less
  // likely to fire. A verdict resting on such rows is withheld rather than reported.
  const verdict = !k.evaluated ? 'not evaluated' : lost > 0 ? `WITHHELD: ${lost} baseline calls got no answer from the LLM server (the rows as they stand say: ${rule})` : rule;
  return [`  ${label}: ${verdict}`, ...k.comparisons.flatMap(comparisonLines)];
}

/** The lowest and highest generator seed in scenario ids like gen-heldout-10001, or null. */
function seedRange(ids: readonly string[]): [number, number] | null {
  const seeds = ids.map((id) => /-(\d+)$/.exec(id)?.[1]).filter((x): x is string => x !== undefined).map(Number);
  return seeds.length === ids.length && seeds.length > 0 ? [Math.min(...seeds), Math.max(...seeds)] : null;
}

/** Cases whose answer differs between two Fixwright runs on the same scenarios. */
function drift(a: readonly CaseRow[], b: readonly CaseRow[]): { compared: number; changed: number } {
  const byId = new Map(b.filter((r) => r.agent === 'fixwright').map((r) => [r.scenario_id, r]));
  let compared = 0;
  let changed = 0;
  for (const r of a) {
    if (r.agent !== 'fixwright') continue;
    const o = byId.get(r.scenario_id);
    if (!o) continue;
    compared++;
    if (o.got !== r.got || o.level !== r.level || o.human_questions !== r.human_questions) changed++;
  }
  return { compared, changed };
}

/** A flag's value on the llama-server command line recorded in a report, or '?'. */
function serverArg(r: Report, flag: string): string {
  const args = r.llm?.server.args ?? [];
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? '?') : '?';
}

function settingsLines(r: Report): string[] {
  const l = r.llm;
  if (!l) return ['  (no LLM settings recorded)'];
  const s = l.server;
  const g = l.generation;
  const argOf = (flag: string): string => serverArg(r, flag);
  return [
    `  Model: ${l.endpoint.model} (${s.model_file ?? '?'}, ${s.model_ftype ?? '?'}${s.n_params ? `, ${(s.n_params / 1e9).toFixed(1)} B parameters` : ''})`,
    `  Server: llama.cpp ${s.build_info ?? '?'}, CPU backend ${s.cpu_backend ?? '?'}, ${s.total_slots ?? '?'} slot, context ${s.n_ctx ?? '?'} tokens, threads ${argOf('--threads')}, batch threads ${argOf('--threads-batch')}`,
    `  Generation: temperature ${g.temperature}, seed ${g.seed}, max tokens ${g.maxTokens} (reasoning included), reasoning effort ${g.reasoningEffort}, cache_prompt ${g.cachePrompt}, one call at a time`,
    `  Client: Strands Agents SDK ${l.strands_sdk_version ?? '?'} (${l.strands_mode} mode, openai ${l.openai_sdk_version ?? '?'}); confirmed when confidence >= 0.9`,
    `  Server command line: ${(s.args ?? []).join(' ')}`,
  ];
}

function timingLines(label: string, r: Report): string[] {
  const out = [`  ${label}: ${r.started_at} to ${r.finished_at}, ${secs(r.duration_ms)} wall; load average ${f2(r.machine.start.load_average[0] ?? 0)} at start, ${f2(r.machine.end.load_average[0] ?? 0)} at end; ${r.config.resumed_cases} cases carried over from a checkpoint`];
  for (const a of ['b1', 'b2'] as const) {
    const x = r.metrics[a]?.all.llm;
    const c = r.llm?.counters[a];
    if (!x) continue;
    const made = x.paths.strands + x.paths.fetch_fallback + x.paths.failed;
    out.push(
      `    ${AGENT_LABEL[a]}: ${made} calls (Strands ${x.paths.strands}, fetch fallback ${x.paths.fetch_fallback}, failed ${x.paths.failed}), ${x.paths.reused} reused byte identical B1 requests` +
        (x.call_ms ? `; per call mean ${secs(x.call_ms.mean)}, p50 ${secs(x.call_ms.p50)}, p95 ${secs(x.call_ms.p95)}` : '') +
        (x.prompt_tokens ? `; prompt tokens mean ${Math.round(x.prompt_tokens.mean)}, max ${x.prompt_tokens.max}` : '') +
        (c ? `; ${c.prompt_tokens_cached} prompt tokens from cache` : ''),
    );
  }
  return out;
}

/** The whole HOMETRUTH.txt text. Pure: everything comes from the input reports. */
export function hometruthText(i: HometruthInput): string {
  const fw = (r: Report) => r.cases.filter((c) => c.agent === 'fixwright');
  const all = i.final.all.metrics.fixwright?.all;
  const pairedRows = [...i.heldout.cases, ...i.incidents.cases];
  const heldoutCauses = Object.entries(i.heldout.scenarios.by_cause).map(([c, k]) => `${c} ${k}`).join(', ');
  const explainFalse = fw(i.final.all).filter((r) => r.false_confirmed && r.fixwright?.tool === 'explain_event');
  const explainFalseCauses = [...new Set(explainFalse.map((r) => r.expected))].join(', ') || 'none';
  const dOnly = i.diagnoseOnly?.metrics.fixwright?.all;
  const threads = serverArg(i.heldout, '--threads');
  const gen = i.heldout.llm?.generation;
  const model = `${i.heldout.llm?.endpoint.model ?? '?'}${i.heldout.llm?.server.model_ftype ? `, ${i.heldout.llm.server.model_ftype}` : ''}`;
  const noise = Math.round((1 - i.heldout.config.human_reliability) * 100);
  const generated = i.final.dev.scenarios.run + i.final.heldout.scenarios.run;
  const causeCount = new Set([...Object.keys(i.final.dev.scenarios.by_cause), ...Object.keys(i.final.heldout.scenarios.by_cause)]).size;
  const seeds = seedRange(i.final.heldout.scenarios.ids);
  const incidentsN = i.final.incidents.scenarios.run;
  const lostHeldout = unanswered(i.heldout.cases);
  const lostIncidents = unanswered(i.incidents.cases);
  const lost = lostHeldout + lostIncidents;

  const lines: string[] = [
    'HomeTruth: the full benchmark run for Fixwright',
    `Written ${i.writtenAt} from the result files in bench/results. Every number below is read from those`,
    'files or computed from their case rows with the runner\'s own code (bench/src/hometruth.ts).',
    '',
    'WHAT RAN',
    `  Fixwright (the live product path: the assistant router, then @fixwright/engine) on every scenario:`,
    ...FULL_SETS.map((s) => `    ${s.padEnd(10)} ${i.final[s].scenarios.run} scenarios`),
    `  B1 (the LLM with the rendered logs and the symptom) and B2 (B1 plus the answers the person gave`,
    `  Fixwright) next to Fixwright on the same scenarios:`,
    `    held-out sample: ${i.heldout.scenarios.run} of ${i.heldout.scenarios.set_size}, stratified, seed ${i.heldout.config.seed} (${heldoutCauses})`,
    `    incidents: all ${i.incidents.scenarios.run}`,
    `  The simulated person answers truthfully with probability ${i.heldout.config.human_reliability} (seed ${i.heldout.config.human_seed}), the same for every agent.`,
    `  Machine: ${i.heldout.machine.start.cpu}, ${i.heldout.machine.start.vcpus} vCPUs, ${i.heldout.machine.start.total_mem_gib} GiB, Node ${i.heldout.machine.start.node}.`,
    `  Other builds ran on the same machine during the baseline runs, so llama.cpp was given ${threads} threads`,
    '  and wall times are those of a shared machine.',
    '',
    'MODEL AND SETTINGS (B1 AND B2)',
    ...settingsLines(i.heldout),
    ...(JSON.stringify(i.incidents.llm?.server.args) !== JSON.stringify(i.heldout.llm?.server.args) || JSON.stringify(i.incidents.llm?.generation) !== JSON.stringify(i.heldout.llm?.generation)
      ? ['  The incident run used different server settings:', ...settingsLines(i.incidents)]
      : ['  The incident run used the same server command line and generation settings.']),
    '',
    'FIXWRIGHT ON EVERY SET (run at the end, on the engine as it was then)',
  ];
  for (const s of FULL_SETS) {
    const m = i.final[s].metrics.fixwright?.all;
    if (m) lines.push(`  ${s} (n ${m.n})`, ...agentLines('fixwright', m));
  }
  if (all?.fixwright) {
    lines.push(`  Tools on all ${all.n}: ${Object.entries(all.fixwright.tools).map(([t, k]) => `${t} ${k}`).join(', ')}; engine stops ${Object.entries(all.fixwright.error_codes).map(([c, k]) => `${c} ${k}`).join(', ') || 'none'} (counted as abstentions).`);
  }
  if (dOnly) {
    lines.push(`  With the router off (diagnose loop for every symptom), all ${dOnly.n}: top1 ${rateText(dOnly.top1)}; false confirmations ${dOnly.false_confirmed.count}, rate ${rateText(dOnly.false_confirmed.rate)}.`);
  }
  lines.push(
    '',
    'FIXWRIGHT, B1 AND B2 ON THE SAME SCENARIOS',
    '  Fixwright here is the run made next to the baselines: its questions and answers are what B2 read.',
    '',
    ...pairedBlock(`Held-out sample (${i.heldout.scenarios.run} scenarios)`, i.heldout.cases),
    '',
    ...pairedBlock(`Incidents (${i.incidents.scenarios.run} reconstructed reports)`, i.incidents.cases),
    '',
    ...pairedBlock(`Both together (${i.heldout.scenarios.run + i.incidents.scenarios.run} scenarios)`, pairedRows),
    '',
    'KILL SWITCH (RULE SET BEFORE THE RUN)',
    ...wrap(`Rule: ${i.heldout.kill_switch.rule}`, '  '),
    `  The deciding set, fixed before the run: the held-out sample of ${i.heldout.scenarios.run}. Below ${MIN_CONCLUSIVE_N} paired scenarios the`,
    '  rule is not conclusive. The exact McNemar p values are a second opinion and not part of the rule.',
    ...killSwitchLines(`Held-out sample of ${i.heldout.scenarios.run} (the verdict)`, i.heldout.kill_switch, lostHeldout),
    ...killSwitchLines(`Incidents (${i.incidents.scenarios.run})`, i.incidents.kill_switch, lostIncidents),
    ...killSwitchLines(`Both together (${i.heldout.scenarios.run + i.incidents.scenarios.run})`, evaluateKillSwitch(pairedRows), lost),
    ...(lostHeldout > 0
      ? [
          `  Verdict: withheld. ${lostHeldout} B1 or B2 calls on the deciding set got no answer and are scored as can't tell,`,
          '  which pulls the baselines down. Rerun scripts/hometruth-full.sh: it resumes from the kept checkpoint',
          '  and retries only those calls.',
        ]
      : wrap(`Verdict: ${i.heldout.kill_switch.note}`, '  ')),
    '',
    'DID THE ENGINE CHANGE WHILE THE BASELINES RAN?',
  );
  for (const s of FULL_SETS) {
    const st = i.start[s];
    if (!st) continue;
    const d = drift(fw(st), fw(i.final[s]));
    lines.push(`  ${s}: ${d.changed} of ${d.compared} Fixwright answers differ between the run before the baselines (${st.started_at}) and the final run (${i.final[s].started_at}).`);
  }
  for (const [label, r] of [['held-out sample', i.heldout], ['incidents', i.incidents]] as const) {
    const d = drift(fw(r), fw(i.final.all));
    lines.push(`  ${label}: ${d.changed} of ${d.compared} Fixwright answers next to the baselines differ from the final run.`);
  }
  lines.push(
    '  An answer differs when the cause, the verdict level or the number of questions changed. Where any',
    '  differ, the comparison with B1 and B2 above still pairs each baseline with the Fixwright run it read.',
    '',
    'TIMINGS',
    ...timingLines('Incidents run', i.incidents),
    ...timingLines('Held-out run', i.heldout),
    `  Fixwright alone on all ${i.final.all.scenarios.run}: ${secs(i.final.all.agent_ms.fixwright ?? 0)} for the agent, ${secs(i.final.all.duration_ms)} for the run.`,
    '',
    'HONEST CAVEATS',
    `  Generated scenarios. The ${generated} dev and held-out scenarios come from homefault's generator, which uses`,
    `  the same ${causeCount} cause library as Fixwright's engine and was written by the same team. The held-out seeds`,
    `  (${seeds ? `${seeds[0]} to ${seeds[1]}` : 'see the held-out result file'}) were kept for reporting, but held-out smoke runs were seen during the build, so they`,
    `  are not untouched. The setup favours Fixwright: its probes are made for exactly these ${causeCount} causes.`,
    `  Reconstructed incidents. The ${incidentsN} incidents are hand reconstructions of dated public reports into Home`,
    '  Assistant shaped logs, with stated assumptions where a report names no cause. They are not recordings',
    `  of real homes, and ${incidentsN} is too few to decide anything on their own.`,
    ...(lost > 0
      ? [
          `  Unanswered calls. ${lost} B1 or B2 calls (held-out ${lostHeldout}, incidents ${lostIncidents}) got no answer from the LLM`,
          '  server after every retry. They are scored as can\'t tell, which lowers the baselines, so any verdict',
          '  resting on them is withheld above.',
        ]
      : ['  Unanswered calls. None: every B1 and B2 call got an answer from the LLM server.']),
    `  Simulated person. Answers come from each scenario's ground truth, wrong ${noise}% of the time, not from people.`,
    `  One model. B1 and B2 use one open weights model (${model}) on CPU with reasoning effort ${gen?.reasoningEffort ?? '?'}`,
    `  and a ${gen?.maxTokens ?? '?'} token cap, called once per scenario with no tools. A larger model, more reasoning or an LLM`,
    '  that can run probes may do better; this run does not measure that.',
    `  One seed. One stratified sample of ${i.heldout.scenarios.run} held-out scenarios, one person seed, one model seed.`,
    '  Lenient kill switch. Interval overlap counts as a match, so the switch fires whenever the data cannot',
    '  tell the agents apart. It stays off only when Fixwright leads by a gap larger than both intervals allow.',
    `  Router. The live product's router sends some questions to explain_event; on all ${all?.n ?? '?'} it produced ${explainFalse.length} of`,
    `  Fixwright's ${all?.false_confirmed.count ?? '?'} false confirmations (true causes: ${explainFalseCauses}).`,
    '  Threads. Answers were reproducible at temperature 0 with one slot and no prompt cache in bench/llm\'s',
    `  check; this run used ${threads} threads, and a different thread count can change floating point sums and so`,
    '  answers. Not measured here.',
    '',
    'WHAT THESE NUMBERS DO NOT SHOW',
    '  That Fixwright finds faults in real homes with real devices and real people.',
    '  Whether people answer "Did it blink?" as reliably as the simulated person.',
    '  Repairs: HomeTruth scores the diagnosis only, not the dry run, apply, read back or rollback.',
    '  Voice latency, Alexa+ integration, or how the answers sound.',
    '  How a frontier LLM, or an LLM agent with probe tools, would compare.',
    `  Whether the ${causeCount} causes cover the faults real homes have.`,
    '',
  );
  return lines.join('\n');
}

function readReport(name: string): Report {
  const path = join(RESULTS, `${name}.json`);
  if (!existsSync(path)) throw new Error(`Missing ${path}. Run scripts/hometruth-full.sh first.`);
  return JSON.parse(readFileSync(path, 'utf8')) as Report;
}

/** Reads the full run's result files and writes results/HOMETRUTH.txt. */
export function writeHometruth(now: Date = new Date()): string {
  const optional = (name: string): Report | null => (existsSync(join(RESULTS, `${name}.json`)) ? readReport(name) : null);
  const start: Partial<Record<SetName, Report>> = {};
  for (const s of FULL_SETS) {
    const r = optional(HOMETRUTH_NAMES.start(s));
    if (r) start[s] = r;
  }
  const text = hometruthText({
    writtenAt: now.toISOString(),
    final: { dev: readReport(HOMETRUTH_NAMES.final('dev')), heldout: readReport(HOMETRUTH_NAMES.final('heldout')), incidents: readReport(HOMETRUTH_NAMES.final('incidents')), all: readReport(HOMETRUTH_NAMES.final('all')) },
    start,
    diagnoseOnly: optional(HOMETRUTH_NAMES.diagnoseOnly),
    heldout: readReport(HOMETRUTH_NAMES.heldout),
    incidents: readReport(HOMETRUTH_NAMES.incidents),
  });
  const out = join(RESULTS, 'HOMETRUTH.txt');
  writeFileSync(out, text);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`Wrote ${writeHometruth()}\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
