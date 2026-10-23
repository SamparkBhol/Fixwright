// The result file (JSON, every case and every setting) and its plain text summary. The summary states
// the sample sizes, the model and its settings, the date, the measured metrics with 95% intervals, the
// timings needed to size a longer run, and the kill switch evaluation. Nothing in either file
// is typed in by hand: every number comes from the run.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GenerationOptions, LlmEndpoint } from '../llm/src/config.ts';
import type { FixwrightRouting } from './agents/fixwright.ts';
import type { StrandsJsonMode } from '../llm/src/strands-client.ts';
import { evaluateKillSwitch, type Comparison, type KillSwitch } from './killswitch.ts';
import type { CounterDelta, MachineInfo, ServerInfo } from './meta.ts';
import { AGENT_NAMES, metricsBySet, type AgentMetrics, type AgentName, type CaseRow } from './metrics.ts';
import type { SetName, SubsetName, TaggedScenario } from './sample.ts';
import type { Rate } from './stats.ts';

export const RESULT_FORMAT = 'hometruth.results/1';

export const AGENT_DESCRIPTIONS: Record<AgentName, string> = {
  fixwright:
    '@fixwright/engine on scenarioHome(view). The assistant router (@fixwright/router) picks the tool as the live product does: explain_event for questions about something the home did, else the diagnose loop (startDiagnosis, then answerDiagnosis for each question). The simulated person answers its questions; permission questions are granted.',
  b1: 'LLM only: the rendered logs and the symptom, one call through the Strands Agents SDK; the fetch client only if Strands gets no answer.',
  b2: 'LLM only: the same as B1 plus the answers the person gave Fixwright in the same scenario (questions as Fixwright asked them).',
};

const FIXWRIGHT_DIAGNOSE_ONLY =
  '@fixwright/engine diagnosis loop only (startDiagnosis, then answerDiagnosis for each question) on scenarioHome(view), router off; the simulated person answers its questions; permission questions are granted.';

export interface RunConfig {
  agents: AgentName[];
  set: SetName;
  n: number | null;
  stratified: boolean;
  seed: number;
  ids: string[] | null;
  human_reliability: number;
  human_seed: number;
  fixwright_routing: FixwrightRouting;
  reuse_identical_requests: boolean;
  resumed_cases: number;
}

export interface LlmSettings {
  endpoint: { base_url: string; model: string };
  generation: GenerationOptions;
  strands_mode: StrandsJsonMode;
  strands_sdk_version: string | null;
  openai_sdk_version: string | null;
  one_call_at_a_time: true;
  server: ServerInfo;
  /** Server counters over each baseline's calls (resumed cases excluded). */
  counters: Partial<Record<'b1' | 'b2', CounterDelta>>;
}

export interface Report {
  format: typeof RESULT_FORMAT;
  name: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  command: string[];
  machine: { start: MachineInfo; end: MachineInfo };
  config: RunConfig;
  scenarios: {
    set_size: number;
    run: number;
    by_set: Partial<Record<SubsetName, number>>;
    by_cause: Record<string, number>;
    ids: string[];
  };
  agents: Partial<Record<AgentName, string>>;
  llm: LlmSettings | null;
  agent_ms: Partial<Record<AgentName, number>>;
  metrics: Partial<Record<AgentName, { all: AgentMetrics; sets: Partial<Record<SubsetName, AgentMetrics>> }>>;
  kill_switch: KillSwitch;
  cases: CaseRow[];
}

export interface ReportInput {
  name: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  command: string[];
  machine: { start: MachineInfo; end: MachineInfo };
  config: RunConfig;
  setSize: number;
  scenarios: readonly TaggedScenario[];
  llm: LlmSettings | null;
  agentMs: Partial<Record<AgentName, number>>;
  rows: CaseRow[];
}

export function buildReport(input: ReportInput): Report {
  const bySet: Partial<Record<SubsetName, number>> = {};
  const byCause: Record<string, number> = {};
  for (const t of input.scenarios) {
    bySet[t.set] = (bySet[t.set] ?? 0) + 1;
    const c = t.scenario.ground_truth.cause_id;
    byCause[c] = (byCause[c] ?? 0) + 1;
  }
  const ran = AGENT_NAMES.filter((a) => input.rows.some((r) => r.agent === a));
  const metrics: Report['metrics'] = {};
  const agents: Report['agents'] = {};
  for (const a of ran) {
    metrics[a] = metricsBySet(input.rows.filter((r) => r.agent === a));
    agents[a] = a === 'fixwright' && input.config.fixwright_routing === 'diagnose' ? FIXWRIGHT_DIAGNOSE_ONLY : AGENT_DESCRIPTIONS[a];
  }
  return {
    format: RESULT_FORMAT,
    name: input.name,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    duration_ms: input.durationMs,
    command: input.command,
    machine: input.machine,
    config: input.config,
    scenarios: {
      set_size: input.setSize,
      run: input.scenarios.length,
      by_set: bySet,
      by_cause: Object.fromEntries(Object.entries(byCause).sort(([a], [b]) => a.localeCompare(b))),
      ids: input.scenarios.map((t) => t.scenario.id),
    },
    agents,
    llm: input.llm,
    agent_ms: input.agentMs,
    metrics,
    kill_switch: evaluateKillSwitch(input.rows),
    cases: input.rows,
  };
}

// Plain text summary ---------------------------------------------------------------------------

const f3 = (x: number | null): string => (x === null ? 'n/a' : x.toFixed(3));
const f2 = (x: number): string => String(Math.round(x * 100) / 100);
const ci = (r: Rate): string => (r.ci95 ? `95% CI ${r.ci95[0].toFixed(3)} to ${r.ci95[1].toFixed(3)}` : 'no interval (n is 0)');
const rateLine = (r: Rate): string => `${f3(r.value)} (${r.k} of ${r.n}), ${ci(r)}`;
const ms = (x: number): string => (x >= 10_000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x * 1000) / 1000} ms`);

function duration(msTotal: number): string {
  if (msTotal < 10_000) return `${(msTotal / 1000).toFixed(2)} s`;
  const s = Math.round(msTotal / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h} h ${m} min ${sec} s` : m > 0 ? `${m} min ${sec} s` : `${sec} s`;
}

function agentBlock(name: AgentName, m: AgentMetrics, indent = '  '): string[] {
  const lines = [
    `${indent}top1                 ${rateLine(m.top1)}`,
    `${indent}false confirmations  ${m.false_confirmed.count}, rate ${rateLine(m.false_confirmed.rate)}`,
    `${indent}abstention           ${rateLine(m.abstention)}`,
    `${indent}confirmed precision  ${rateLine(m.confirmed_precision)}`,
    `${indent}top1 when answering  ${rateLine(m.top1_answered)}`,
  ];
  if (name !== 'fixwright') {
    lines.push(`${indent}invalid outputs      ${m.invalid_outputs.count}, rate ${rateLine(m.invalid_outputs.rate)}`);
    lines.push(`${indent}infra failures       ${m.infra_errors} (no answer from the server after fallback and retry; counted as abstentions)`);
  } else {
    lines.push(`${indent}probes               mean ${f2(m.probes_used.mean)} (total ${m.probes_used.total}); disruptive mean ${f2(m.disruptive_probes.mean)} (total ${m.disruptive_probes.total})`);
    const fx = m.fixwright;
    lines.push(`${indent}questions to person  mean ${f2(m.human_questions.mean)} (total ${m.human_questions.total}${fx ? `, of which ${fx.permission_questions} permission questions` : ''})`);
    if (fx) lines.push(`${indent}tool used            ${Object.entries(fx.tools).map(([t, k]) => `${t} ${k}`).join(', ')}`);
    const codes = fx ? Object.entries(fx.error_codes) : [];
    lines.push(`${indent}engine errors        ${m.errors}${codes.length > 0 ? ` (${codes.map(([c, k]) => `${c} ${k}`).join(', ')}; counted as abstentions)` : ''}`);
  }
  const reused = m.llm?.paths.reused ?? 0;
  const reusedNote = reused > 0 ? ` (includes ${reused} reused cases, each carrying the wall time of the B1 call it reused)` : '';
  lines.push(`${indent}latency per case     p50 ${ms(m.latency_ms.p50)}, p95 ${ms(m.latency_ms.p95)}, max ${ms(m.latency_ms.max)}${reusedNote}`);
  return lines;
}

function perCauseLines(m: AgentMetrics): string[] {
  const lines = ['  per cause (n, correct, confirmed, false confirmations, abstained):'];
  for (const [cause, c] of Object.entries(m.per_cause).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`    ${cause.padEnd(22)} n ${String(c.n).padStart(3)}  correct ${String(c.correct).padStart(3)}  confirmed ${String(c.confirmed).padStart(3)}  false ${String(c.false_confirmed).padStart(2)}  abstained ${String(c.abstained).padStart(3)}`);
  }
  return lines;
}

function comparisonLines(c: Comparison): string[] {
  const name = c.baseline.toUpperCase();
  const yn = (b: boolean) => (b ? 'yes' : 'no');
  return [
    `  ${name} vs Fixwright on the same ${c.n} scenarios${c.conclusive ? '' : ' (too few to conclude)'}:`,
    `    top1             Fixwright ${f3(c.top1.fixwright.value)} [${ci(c.top1.fixwright)}], ${name} ${f3(c.top1.baseline.value)} [${ci(c.top1.baseline)}]; matches: ${yn(c.top1.match)}`,
    `                     paired: Fixwright right and ${name} wrong ${c.top1.paired.b}, the reverse ${c.top1.paired.c}, exact McNemar p ${c.top1.paired.p_mcnemar}`,
    `    false confirmed  Fixwright ${f3(c.false_confirmed.fixwright.value)} [${ci(c.false_confirmed.fixwright)}], ${name} ${f3(c.false_confirmed.baseline.value)} [${ci(c.false_confirmed.baseline)}]; matches: ${yn(c.false_confirmed.match)}`,
    `                     paired: only Fixwright falsely confirmed ${c.false_confirmed.paired.b}, only ${name} ${c.false_confirmed.paired.c}, exact McNemar p ${c.false_confirmed.paired.p_mcnemar}`,
    `    ${name} matches Fixwright on both: ${yn(c.matches)}`,
  ];
}

export function summaryText(r: Report): string {
  const out: string[] = [];
  out.push(`HomeTruth benchmark: ${r.name}`);
  out.push(`Date: ${r.started_at} to ${r.finished_at} (UTC), ${duration(r.duration_ms)}`);
  const m0 = r.machine.start;
  out.push(`Machine: ${m0.cpu}, ${m0.vcpus} vCPUs, ${m0.total_mem_gib} GiB, Node ${m0.node}; load average ${m0.load_average[0]} at start, ${r.machine.end.load_average[0]} at end`);
  out.push(`Command: ${r.command.join(' ')}`);
  out.push('');

  out.push('Scenarios');
  const c = r.config;
  const sampling = c.ids
    ? `the ${c.ids.length} scenarios named with --ids`
    : c.n === null
      ? `all ${r.scenarios.set_size}`
      : `${c.stratified ? 'a stratified' : 'a simple random'} sample of ${r.scenarios.run} out of ${r.scenarios.set_size} (seed ${c.seed})`;
  out.push(`  Set: ${c.set}, ${sampling}`);
  out.push(`  By subset: ${Object.entries(r.scenarios.by_set).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  out.push(`  By cause: ${Object.entries(r.scenarios.by_cause).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (r.scenarios.ids.length <= 30) out.push(`  Ids: ${r.scenarios.ids.join(', ')}`);
  out.push(`  Simulated person: truthful with probability ${c.human_reliability} (seed ${c.human_seed}); "not sure" when the scenario does not say.`);
  if (c.resumed_cases > 0) out.push(`  Resumed: ${c.resumed_cases} baseline cases were taken from the interrupted run's checkpoint.`);
  out.push('');

  out.push('Agents');
  for (const [a, d] of Object.entries(r.agents)) out.push(`  ${a}: ${d}`);
  out.push('');

  if (r.llm) {
    const l = r.llm;
    const g = l.generation;
    const s = l.server;
    out.push('Model and settings (B1 and B2)');
    out.push(`  Model: ${l.endpoint.model}${s.model_file ? ` (${s.model_file}, ${s.model_ftype ?? 'format unknown'}${s.n_params ? `, ${(s.n_params / 1e9).toFixed(1)} B parameters` : ''})` : ''}, served by llama.cpp ${s.build_info ?? '(build unknown)'} at ${l.endpoint.base_url}`);
    out.push(`  Server: ${s.total_slots ?? '?'} slot(s), context ${s.n_ctx ?? '?'} tokens${s.cpu_backend ? `, CPU backend ${s.cpu_backend}` : ''}${s.peak_rss_mib ? `, peak RSS ${s.peak_rss_mib} MiB` : ''}`);
    if (s.args) out.push(`  Server command line: llama-server ${s.args.join(' ')}`);
    out.push(`  Generation: temperature ${g.temperature}, seed ${g.seed}, max tokens ${g.maxTokens} (reasoning included), reasoning effort ${g.reasoningEffort}, cache_prompt ${g.cachePrompt}, timeout ${g.timeoutMs} ms, one call at a time`);
    out.push(`  Client: Strands Agents SDK ${l.strands_sdk_version ?? '?'} (${l.strands_mode} mode, OpenAI chat provider, openai ${l.openai_sdk_version ?? '?'}); fetch fallback only when Strands gets no answer`);
    out.push('  Output: JSON {cause_id, confidence, explanation}; cause_id is one of the 10 causes or unknown. Confirmed when confidence >= 0.9, likely below, unknown is can\'t tell; an invalid answer is can\'t tell and counted as invalid.');
    out.push('');
  }

  out.push('Results');
  for (const a of AGENT_NAMES) {
    const m = r.metrics[a];
    if (!m) continue;
    out.push(`${a} (n ${m.all.n})`);
    out.push(...agentBlock(a, m.all));
    const sets = Object.entries(m.sets) as [SubsetName, AgentMetrics][];
    if (sets.length > 1) {
      for (const [set, sm] of sets) out.push(`  ${set} (n ${sm.n}): top1 ${rateLine(sm.top1)}; false confirmations ${sm.false_confirmed.count}; abstention ${f3(sm.abstention.value)}`);
    }
    out.push(...perCauseLines(m.all));
    out.push('');
  }

  out.push('Kill switch (rule set before the run)');
  out.push(`  Rule: ${r.kill_switch.rule}`);
  for (const comp of r.kill_switch.comparisons) out.push(...comparisonLines(comp));
  out.push(`  Result: ${r.kill_switch.note}`);
  out.push('');

  out.push('Timings (for sizing a longer run)');
  for (const [a, t] of Object.entries(r.agent_ms)) out.push(`  ${a}: ${duration(t)} wall for this run`);
  for (const v of ['b1', 'b2'] as const) {
    const x = r.metrics[v]?.all.llm;
    if (!x) continue;
    const made = x.paths.strands + x.paths.fetch_fallback + x.paths.failed;
    out.push(`  ${v.toUpperCase()}: ${made} calls made (Strands ${x.paths.strands}, fetch fallback ${x.paths.fetch_fallback}, failed ${x.paths.failed}), ${x.paths.reused} reused from an identical request; ${x.with_human_answers} with answers from the person`);
    if (x.call_ms) out.push(`    per call: mean ${ms(x.call_ms.mean)}, p50 ${ms(x.call_ms.p50)}, p95 ${ms(x.call_ms.p95)}, max ${ms(x.call_ms.max)}`);
    if (x.prompt_tokens) out.push(`    prompt tokens: mean ${Math.round(x.prompt_tokens.mean)}, max ${x.prompt_tokens.max}`);
    if (x.completion_tokens) out.push(`    completion tokens (reasoning included): mean ${Math.round(x.completion_tokens.mean)}, max ${x.completion_tokens.max}`);
    const d = r.llm?.counters[v];
    if (d) out.push(`    server counters: ${d.prompt_tokens} prompt tokens at ${d.prompt_tok_per_s ?? '?'} tok/s, ${d.predicted_tokens} generated at ${d.predicted_tok_per_s ?? '?'} tok/s, ${d.prompt_tokens_cached} prompt tokens from cache`);
  }
  out.push('');
  out.push('Every number above comes from this run; the cases and settings are in the JSON file next to this one.');
  return out.join('\n') + '\n';
}

export function writeReport(jsonPath: string, report: Report): { json: string; summary: string } {
  mkdirSync(dirname(jsonPath), { recursive: true });
  const summaryPath = summaryPathFor(jsonPath);
  writeFileSync(jsonPath, JSON.stringify(report, null, 1) + '\n');
  writeFileSync(summaryPath, summaryText(report));
  return { json: jsonPath, summary: summaryPath };
}

export function summaryPathFor(jsonPath: string): string {
  return jsonPath.replace(/\.json$/, '') + '.summary.txt';
}

export function checkpointPathFor(jsonPath: string): string {
  return jsonPath.replace(/\.json$/, '') + '.partial.jsonl';
}

export type { LlmEndpoint };
