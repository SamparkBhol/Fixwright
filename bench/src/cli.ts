// The HomeTruth command line. Parses flags, picks the scenarios, checks the LLM server settings before
// any baseline call, runs the agents with a per-case checkpoint, and writes results/<name>.json plus
// results/<name>.summary.txt. Everything with side effects (clock, LLM clients, server probes, output)
// is injectable so the whole path runs in tests without a model.

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_GENERATION, endpointFromEnv, type GenerationOptions, type LlmEndpoint } from '../llm/src/config.ts';
import type { StrandsJsonMode } from '../llm/src/strands-client.ts';
import type { FixwrightRouting } from './agents/fixwright.ts';
import type { LlmClients } from './agents/llm.ts';
import { fingerprintOf, openCheckpoint, readCheckpoint } from './checkpoint.ts';
import { counterDelta, installedVersion, machineInfo, serverCounters, serverInfo, type CounterDelta, type MachineInfo, type ServerCounters, type ServerInfo } from './meta.ts';
import { AGENT_NAMES, type AgentName, type CaseRow } from './metrics.ts';
import { buildReport, checkpointPathFor, writeReport, type LlmSettings, type Report, type RunConfig } from './report.ts';
import { runAgents } from './runner.ts';
import { loadSet, sampleScenarios, SET_NAMES, type SetName } from './sample.ts';

export const BENCH_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const USAGE = `HomeTruth benchmark runner

Usage: node src/run.ts [options]

  --agents LIST          comma list of fixwright, b1, b2 (default fixwright). Fixwright always runs
                         next to a baseline: it is the reference, and B2 reads the answers it got.
  --set NAME             dev | heldout | incidents | all (default heldout)
  --n N                  run N scenarios instead of the whole set
  --stratified           spread the N scenarios evenly over the ground truth causes
  --seed S               sampling seed (default 1)
  --ids LIST             run exactly these scenario ids (instead of --n)
  --human-reliability R  probability the simulated person answers truthfully (default 0.9)
  --human-seed S         seeds the simulated person (default 1)
  --fixwright-routing R  router (default): the assistant router picks diagnose or explain_event, as in
                         the live product; diagnose: always the diagnose loop
  --mode MODE            Strands JSON mode: json_schema (default) or structured_output
  --no-reuse             always call the model, even for a B2 request identical to its B1 request
  --out NAME|PATH        results/NAME.json, or a path ending in .json (default from set, agents, n)
  --resume               continue an interrupted run from its checkpoint
  --fresh                discard an existing checkpoint and start over
  --help

The LLM server is read from LLM_BASE_URL (or LLM_HOST, LLM_PORT), LLM_MODEL and LLM_API_KEY; start it
with bench/llm/start-llm.sh and stop it with bench/llm/stop-llm.sh.`;

export interface CliOptions {
  agents: AgentName[];
  set: SetName;
  n: number | null;
  stratified: boolean;
  seed: number;
  ids: string[] | null;
  humanReliability: number;
  humanSeed: number;
  fixwrightRouting: FixwrightRouting;
  mode: StrandsJsonMode;
  reuse: boolean;
  out: string;
  name: string;
  resume: boolean;
  fresh: boolean;
  help: boolean;
}

const intArg = (flag: string, v: string | undefined, fallback: number | null, min: number): number | null => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`${flag} needs an integer of at least ${min}, got "${v}"`);
  return n;
};

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Turns argv into options. Throws a plain message on bad input. */
export function parseCli(argv: readonly string[], cwd = process.cwd()): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      agents: { type: 'string' },
      set: { type: 'string' },
      n: { type: 'string' },
      stratified: { type: 'boolean' },
      seed: { type: 'string' },
      ids: { type: 'string' },
      'human-reliability': { type: 'string' },
      'human-seed': { type: 'string' },
      'fixwright-routing': { type: 'string' },
      mode: { type: 'string' },
      'no-reuse': { type: 'boolean' },
      out: { type: 'string' },
      resume: { type: 'boolean' },
      fresh: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const agentList = list(values.agents ?? 'fixwright');
  for (const a of agentList) if (!(AGENT_NAMES as readonly string[]).includes(a)) throw new Error(`Unknown agent "${a}". Use ${AGENT_NAMES.join(', ')}.`);
  const agents = AGENT_NAMES.filter((a) => agentList.includes(a));
  if (agents.length === 0) throw new Error('--agents needs at least one agent');
  const set = (values.set ?? 'heldout') as SetName;
  if (!(SET_NAMES as readonly string[]).includes(set)) throw new Error(`Unknown set "${set}". Use ${SET_NAMES.join(', ')}.`);
  const ids = values.ids !== undefined ? list(values.ids) : null;
  if (ids && ids.length === 0) throw new Error('--ids needs at least one scenario id');
  const n = intArg('--n', values.n, null, 1);
  if (ids && n !== null) throw new Error('Use --ids or --n, not both');
  if (values.stratified && n === null) throw new Error('--stratified needs --n');
  const humanReliability = values['human-reliability'] === undefined ? 0.9 : Number(values['human-reliability']);
  if (!(humanReliability >= 0.5 && humanReliability <= 1)) throw new Error('--human-reliability must be between 0.5 and 1');
  const mode = (values.mode ?? 'json_schema') as StrandsJsonMode;
  if (mode !== 'json_schema' && mode !== 'structured_output') throw new Error('--mode must be json_schema or structured_output');
  const fixwrightRouting = (values['fixwright-routing'] ?? 'router') as FixwrightRouting;
  if (fixwrightRouting !== 'router' && fixwrightRouting !== 'diagnose') throw new Error('--fixwright-routing must be router or diagnose');
  if (values.resume && values.fresh) throw new Error('Use --resume or --fresh, not both');
  const name = values.out ? (values.out.endsWith('.json') ? values.out.replace(/^.*\//, '').replace(/\.json$/, '') : values.out) : `${set}-${agents.join('+')}${n !== null ? `-n${n}` : ids ? `-ids${ids.length}` : ''}`;
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) throw new Error(`--out name "${name}" may use letters, digits and . _ + - only`);
  const out = values.out?.endsWith('.json') ? (isAbsolute(values.out) ? values.out : resolve(cwd, values.out)) : join(BENCH_ROOT, 'results', `${name}.json`);
  return {
    agents,
    set,
    n,
    stratified: values.stratified ?? false,
    seed: intArg('--seed', values.seed, 1, 0) as number,
    ids,
    humanReliability,
    humanSeed: intArg('--human-seed', values['human-seed'], 1, 0) as number,
    fixwrightRouting,
    mode,
    reuse: !(values['no-reuse'] ?? false),
    out,
    name,
    resume: values.resume ?? false,
    fresh: values.fresh ?? false,
    help: values.help ?? false,
  };
}

/** Side effects the CLI needs, injectable for tests. */
export interface CliDeps {
  env: Readonly<Record<string, string | undefined>>;
  gen: GenerationOptions;
  clients?: Partial<LlmClients>;
  serverInfo: (endpoint: LlmEndpoint) => Promise<ServerInfo>;
  serverCounters: (endpoint: LlmEndpoint) => Promise<ServerCounters | null>;
  machineInfo: () => MachineInfo;
  now: () => Date;
  timer: () => number;
  log: (line: string) => void;
  /** Called after every scored case (tests use it to simulate a crash). */
  onRow?: (row: CaseRow) => void;
  infraRetries?: number;
  retryDelayMs?: number;
}

export const DEFAULT_DEPS: CliDeps = {
  env: process.env,
  gen: DEFAULT_GENERATION,
  serverInfo: (e) => serverInfo(e),
  serverCounters: (e) => serverCounters(e),
  machineInfo,
  now: () => new Date(),
  timer: () => performance.now(),
  log: (line) => process.stderr.write(line + '\n'),
};

/** Why the settings would make baseline answers depend on call order, or null when they are sound. */
export function settingsProblem(server: ServerInfo, gen: GenerationOptions): string | null {
  if (!server.reachable) return `The LLM server is not reachable (${server.error ?? 'no answer'}). Start it with bench/llm/start-llm.sh.`;
  if (server.total_slots !== 1) return `The LLM server has ${server.total_slots ?? 'an unknown number of'} slots; the baselines need exactly one (batched requests changed answers in bench/llm results/repro_check_parallel2.json).`;
  if (gen.cachePrompt) return 'cache_prompt must be off for the baselines (prompt caching changed answers in bench/llm results/repro_check.json).';
  if (gen.temperature !== 0) return 'temperature must be 0 for the baselines.';
  return null;
}

const fmtMs = (x: number): string => (x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${x.toFixed(1)} ms`);

export interface CliResult {
  report: Report;
  files: { json: string; summary: string };
}

/** Runs the benchmark. Throws on bad settings; the caller turns that into an exit code. */
export async function runCli(opts: CliOptions, deps: CliDeps = DEFAULT_DEPS): Promise<CliResult> {
  const started = deps.now();
  const t0 = deps.timer();
  const machineStart = deps.machineInfo();
  const pool = loadSet(opts.set);
  let scenarios = pool;
  if (opts.ids) {
    const byId = new Map(pool.map((t) => [t.scenario.id, t]));
    const missing = opts.ids.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`Not in set ${opts.set}: ${missing.join(', ')}`);
    const wanted = new Set(opts.ids);
    scenarios = pool.filter((t) => wanted.has(t.scenario.id));
  } else if (opts.n !== null) {
    scenarios = sampleScenarios(pool, { n: opts.n, stratified: opts.stratified, seed: opts.seed });
  }

  const llmAgents = opts.agents.filter((a): a is 'b1' | 'b2' => a !== 'fixwright');
  const endpoint = endpointFromEnv(deps.env);
  const { timeoutMs: _t, ...answerSettings } = deps.gen;
  // What decides every answer: the agents' rows are only comparable within one of these.
  const identity = {
    scenario_ids: scenarios.map((t) => t.scenario.id),
    human_reliability: opts.humanReliability,
    human_seed: opts.humanSeed,
    fixwright_routing: opts.fixwrightRouting,
    endpoint: { base_url: endpoint.baseUrl, model: endpoint.model },
    generation: answerSettings,
    strands_mode: opts.mode,
    reuse: opts.reuse,
  };
  const fingerprint = fingerprintOf(identity);
  const checkpointPath = checkpointPathFor(opts.out);
  let carried: CaseRow[] = [];
  if (existsSync(checkpointPath)) {
    if (opts.resume) carried = readCheckpoint(checkpointPath, fingerprint);
    else if (!opts.fresh) throw new Error(`An interrupted run left a checkpoint at ${checkpointPath}. Pass --resume to continue it or --fresh to discard it.`);
  } else if (opts.resume) {
    deps.log(`No checkpoint at ${checkpointPath}; starting from the beginning.`);
  }

  let server: ServerInfo | null = null;
  if (llmAgents.length > 0) {
    server = await deps.serverInfo(endpoint);
    const problem = settingsProblem(server, deps.gen);
    if (problem) throw new Error(problem);
    deps.log(`LLM server: ${server.model_file ?? endpoint.model}, llama.cpp ${server.build_info ?? '?'}, ${server.total_slots} slot, context ${server.n_ctx ?? '?'}`);
  }

  deps.log(`HomeTruth: ${scenarios.length} of ${pool.length} scenarios from ${opts.set}; agents ${[...new Set(['fixwright', ...opts.agents])].join(', ')}${carried.length > 0 ? `; ${carried.length} checkpointed baseline cases` : ''}`);
  const checkpoint = llmAgents.length > 0 ? openCheckpoint(checkpointPath, fingerprint, identity, carried) : null;
  const before: Partial<Record<'b1' | 'b2', ServerCounters | null>> = {};
  const counters: Partial<Record<'b1' | 'b2', CounterDelta>> = {};

  const result = await runAgents({
    agents: opts.agents,
    scenarios,
    humanReliability: opts.humanReliability,
    humanSeed: opts.humanSeed,
    fixwrightRouting: opts.fixwrightRouting,
    endpoint,
    gen: deps.gen,
    mode: opts.mode,
    reuse: opts.reuse,
    done: carried,
    timer: deps.timer,
    ...(deps.clients ? { clients: deps.clients } : {}),
    ...(deps.infraRetries !== undefined ? { infraRetries: deps.infraRetries } : {}),
    ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {}),
    onRow: (row, p) => {
      if (row.agent !== 'fixwright') {
        checkpoint?.append(row);
        const l = row.llm;
        deps.log(`[${row.agent} ${p.index + 1}/${p.total}] ${row.scenario_id} expected ${row.expected}, got ${row.got} (${row.level}${row.confidence !== null ? ` ${row.confidence}` : ''}) ${fmtMs(row.latency_ms)} ${l?.path ?? ''}${l?.outcome && l.outcome !== 'answer' ? ` ${l.outcome}` : ''}`);
      } else if (p.index + 1 === p.total) {
        deps.log(`[fixwright] ${p.total} scenarios scored`);
      }
      deps.onRow?.(row);
    },
    onAgentStart: async (agent) => {
      before[agent] = await deps.serverCounters(endpoint);
    },
    onAgentEnd: async (agent) => {
      const after = await deps.serverCounters(endpoint);
      const b = before[agent];
      if (b && after) counters[agent] = counterDelta(b, after);
    },
  });

  const finished = deps.now();
  const config: RunConfig = {
    agents: opts.agents,
    set: opts.set,
    n: opts.n,
    stratified: opts.stratified,
    seed: opts.seed,
    ids: opts.ids,
    human_reliability: opts.humanReliability,
    human_seed: opts.humanSeed,
    fixwright_routing: opts.fixwrightRouting,
    reuse_identical_requests: opts.reuse,
    resumed_cases: result.resumed,
  };
  const llm: LlmSettings | null =
    llmAgents.length > 0 && server
      ? {
          endpoint: { base_url: endpoint.baseUrl, model: endpoint.model },
          generation: deps.gen,
          strands_mode: opts.mode,
          strands_sdk_version: installedVersion('@strands-agents/sdk'),
          openai_sdk_version: installedVersion('openai'),
          one_call_at_a_time: true,
          server,
          counters,
        }
      : null;
  const report = buildReport({
    name: opts.name,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: Math.round(deps.timer() - t0),
    command: ['node', 'src/run.ts', ...commandArgs(opts)],
    machine: { start: machineStart, end: deps.machineInfo() },
    config,
    setSize: pool.length,
    scenarios,
    llm,
    agentMs: result.agent_ms,
    rows: result.rows,
  });
  const files = writeReport(opts.out, report);
  const infra = result.rows.filter((r) => r.infra_error).length;
  if (infra > 0 && checkpoint) {
    // Keep the checkpoint: a later --resume reuses every answered case and retries only these.
    deps.log(`${infra} cases got no answer from the server; kept ${checkpointPath}. Rerun with --resume to retry them.`);
  } else {
    checkpoint?.remove();
  }
  return { report, files };
}

/** The flags that reproduce a run (minus --resume and --fresh, which only steer the checkpoint). */
export function commandArgs(o: CliOptions): string[] {
  const args = ['--agents', o.agents.join(','), '--set', o.set];
  if (o.ids) args.push('--ids', o.ids.join(','));
  if (o.n !== null) args.push('--n', String(o.n));
  if (o.stratified) args.push('--stratified');
  args.push('--seed', String(o.seed), '--human-reliability', String(o.humanReliability), '--human-seed', String(o.humanSeed));
  if (o.fixwrightRouting !== 'router') args.push('--fixwright-routing', o.fixwrightRouting);
  if (o.mode !== 'json_schema') args.push('--mode', o.mode);
  if (!o.reuse) args.push('--no-reuse');
  args.push('--out', o.out === join(BENCH_ROOT, 'results', `${o.name}.json`) ? o.name : o.out);
  return args;
}
