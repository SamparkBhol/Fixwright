// Runs the HomeTruth agents on one scenario list and returns per-case rows. Fixwright always runs first
// when a baseline runs: it is the reference for the kill switch and the source of the answers B2 gets.
// Scoring and the simulated person come from homefault's runBench, so every agent is scored the same way
// and the person's answers depend only on (seed, scenario id), never on run order or sample.

import { runBench, toView, type CaseResult } from 'homefault';
import type { GenerationOptions, LlmEndpoint } from '../llm/src/config.ts';
import type { StrandsJsonMode } from '../llm/src/strands-client.ts';
import { fixwrightAgent, type FixwrightRecord, type FixwrightRouting } from './agents/fixwright.ts';
import { baselineInput, llmAgent, requestKey, type CallCache, type LlmClients, type LlmRecord, type QA } from './agents/llm.ts';
import { fixwrightRow, llmRow, type AgentName, type CaseRow } from './metrics.ts';
import type { TaggedScenario } from './sample.ts';

export interface RunOptions {
  agents: readonly AgentName[];
  scenarios: readonly TaggedScenario[];
  humanReliability: number;
  /** Seeds the simulated person (and Fixwright's id generator). */
  humanSeed: number;
  /** How Fixwright picks its tool. Default 'router' (the live product's path). */
  fixwrightRouting?: FixwrightRouting;
  endpoint: LlmEndpoint;
  gen: GenerationOptions;
  mode: StrandsJsonMode;
  /** Reuse a B1 answer for a byte-identical B2 request (no human answers). */
  reuse: boolean;
  clients?: Partial<LlmClients>;
  /** Rows from an interrupted run (checkpoint). Baseline rows whose request is unchanged are reused. */
  done?: readonly CaseRow[];
  infraRetries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  timer?: () => number;
  onRow?: (row: CaseRow, progress: { agent: AgentName; index: number; total: number }) => void;
  /** Called around each baseline (for server counters). */
  onAgentStart?: (agent: 'b1' | 'b2') => Promise<void> | void;
  onAgentEnd?: (agent: 'b1' | 'b2') => Promise<void> | void;
}

export interface RunResult {
  rows: CaseRow[];
  /** Wall time per agent for this invocation, in ms (resumed cases excluded). */
  agent_ms: Partial<Record<AgentName, number>>;
  /** Baseline rows taken from `done` instead of being run again. */
  resumed: number;
}

/** The answers Fixwright got from the person, as B2 reads them. Permission questions carry no fact and are left out. */
export function observedAnswers(r: FixwrightRecord | undefined): QA[] {
  return (r?.exchanges ?? []).filter((e) => e.kind === 'observe').map((e) => ({ question: e.text, answer: e.answer }));
}

export async function runAgents(opts: RunOptions): Promise<RunResult> {
  const timer = opts.timer ?? (() => performance.now());
  const setOf = new Map(opts.scenarios.map((t) => [t.scenario.id, t.set]));
  const scenarios = opts.scenarios.map((t) => t.scenario);
  const llmAgents = opts.agents.filter((a): a is 'b1' | 'b2' => a === 'b1' || a === 'b2');
  const rows: CaseRow[] = [];
  const agentMs: Partial<Record<AgentName, number>> = {};
  const benchOpts = { humanReliability: opts.humanReliability, seed: opts.humanSeed, timer };

  // Fixwright: fast and deterministic, so it always runs in full.
  const fwRecords = new Map<string, FixwrightRecord>();
  if (opts.agents.includes('fixwright') || llmAgents.length > 0) {
    const started = timer();
    let index = 0;
    await runBench(fixwrightAgent({ seed: opts.humanSeed, routing: opts.fixwrightRouting ?? 'router', onRecord: (r) => fwRecords.set(r.scenario_id, r) }), scenarios, {
      ...benchOpts,
      onCase: (c: CaseResult) => {
        const row = fixwrightRow(c, setOf.get(c.scenario_id) ?? 'dev', fwRecords.get(c.scenario_id) as FixwrightRecord);
        rows.push(row);
        opts.onRow?.(row, { agent: 'fixwright', index: index++, total: scenarios.length });
      },
    });
    agentMs.fixwright = Math.round(timer() - started);
  }

  const cache: CallCache | undefined = opts.reuse ? new Map() : undefined;
  const viewOf = new Map(scenarios.map((s) => [s.id, toView(s)]));
  const requestFor = (variant: 'b1' | 'b2', id: string) => {
    const view = viewOf.get(id);
    if (!view) return undefined;
    const answers = variant === 'b2' ? observedAnswers(fwRecords.get(id)) : [];
    return requestKey(baselineInput(view, answers), opts.endpoint, opts.gen, opts.mode);
  };
  // A checkpoint row is reused only if the request it answered is byte for byte the request this run
  // would send now (same rendered log, same answers from the person, same settings).
  const done = new Map<string, CaseRow>();
  let resumed = 0;
  for (const row of opts.done ?? []) {
    if ((row.agent !== 'b1' && row.agent !== 'b2') || !llmAgents.includes(row.agent) || !row.llm || row.infra_error) continue;
    if (requestFor(row.agent, row.scenario_id)?.sha !== row.llm.prompt_sha256) continue;
    done.set(`${row.agent}|${row.scenario_id}`, row);
  }

  for (const variant of llmAgents) {
    const reusedRows = scenarios.map((s) => done.get(`${variant}|${s.id}`)).filter((r): r is CaseRow => r !== undefined);
    resumed += reusedRows.length;
    // Earlier B1 answers can still be reused by B2 after a resume, if the request is the same.
    if (cache && variant === 'b1') {
      for (const row of reusedRows) {
        const key = requestFor('b1', row.scenario_id);
        if (key && row.llm) cache.set(key.key, { variant: 'b1', record: row.llm });
      }
    }
    rows.push(...reusedRows);
    const todo = scenarios.filter((s) => !done.has(`${variant}|${s.id}`));
    const records = new Map<string, LlmRecord>();
    const agent = llmAgent({
      variant,
      endpoint: opts.endpoint,
      gen: opts.gen,
      mode: opts.mode,
      ...(variant === 'b2' ? { answersFor: (id: string) => observedAnswers(fwRecords.get(id)) } : {}),
      ...(opts.clients ? { clients: opts.clients } : {}),
      ...(cache ? { cache } : {}),
      ...(opts.infraRetries !== undefined ? { infraRetries: opts.infraRetries } : {}),
      ...(opts.retryDelayMs !== undefined ? { retryDelayMs: opts.retryDelayMs } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      onRecord: (r) => records.set(r.scenario_id, r),
    });
    await opts.onAgentStart?.(variant);
    const started = timer();
    let index = reusedRows.length;
    await runBench(agent, todo, {
      ...benchOpts,
      onCase: (c: CaseResult) => {
        const row = llmRow(c, setOf.get(c.scenario_id) ?? 'dev', records.get(c.scenario_id) as LlmRecord);
        rows.push(row);
        opts.onRow?.(row, { agent: variant, index: index++, total: scenarios.length });
      },
    });
    agentMs[variant] = Math.round(timer() - started);
    await opts.onAgentEnd?.(variant);
  }

  const order = new Map(scenarios.map((s, i) => [s.id, i]));
  const agentOrder = (a: AgentName) => ['fixwright', 'b1', 'b2'].indexOf(a);
  rows.sort((a, b) => agentOrder(a.agent) - agentOrder(b.agent) || (order.get(a.scenario_id) ?? 0) - (order.get(b.scenario_id) ?? 0));
  return { rows, agent_ms: agentMs, resumed };
}

