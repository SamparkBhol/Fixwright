// The benchmark runner. Any agent that can read a scenario view and optionally ask the person in the
// room a yes/no question can be scored. The person is simulated from the scenario's human truth with a
// reliability knob: they give the wrong answer with probability 1 minus reliability, as real people do.

import { rngFor } from './rng.ts';
import { HUMAN_QUESTION_KINDS, toView, type HumanQuestionKind, type Scenario, type ScenarioView } from './scenario/types.ts';
import { CAUSE_IDS, type Rng } from './types.ts';

export type HumanAnswer = 'yes' | 'no' | 'not sure';

export interface HumanQuestion {
  kind: HumanQuestionKind;
  /** What the agent would say, for logs. */
  text?: string;
  entity_id?: string;
}

export type AskHuman = (q: HumanQuestion) => Promise<HumanAnswer>;

export type VerdictLevel = 'confirmed' | 'likely' | 'cant_tell';

export interface AgentVerdict {
  /** One of CAUSE_IDS, or anything else (e.g. 'unknown') when abstaining. */
  cause_id: string;
  level: VerdictLevel;
  confidence?: number;
  entity_ids?: string[];
  /** Probes the agent ran (passive and active). Reported by the agent. */
  probes_used?: number;
  /** Probes a person would notice (a flash, a power cycle). Default: one per confirm_flash question. */
  disruptive_probes?: number;
}

export interface BenchAgent {
  name: string;
  diagnose(view: ScenarioView, askHuman: AskHuman): Promise<AgentVerdict> | AgentVerdict;
}

export interface BenchOptions {
  /** Probability the simulated person answers truthfully, 0.5 to 1. Default 0.9. */
  humanReliability?: number;
  /** Seeds the simulated person. Default 1. */
  seed?: number;
  /** Monotonic ms clock for latency. Default: performance.now() where available, else latency is 0. */
  timer?: () => number;
  /** Called after each scenario, e.g. for progress output. */
  onCase?: (c: CaseResult) => void;
}

export interface HumanExchange {
  kind: HumanQuestionKind;
  answer: HumanAnswer;
  /** False when the simulated person got it wrong on purpose (reliability noise). */
  truthful: boolean;
}

export interface CaseResult {
  scenario_id: string;
  expected: string;
  got: string;
  level: VerdictLevel;
  confidence: number | null;
  correct: boolean;
  false_confirmed: boolean;
  abstained: boolean;
  probes_used: number;
  disruptive_probes: number;
  human_questions: number;
  human: HumanExchange[];
  latency_ms: number;
  error?: string;
}

export interface Summary {
  total: number;
  mean: number;
}

export interface BenchMetrics {
  n: number;
  /** Correct cause and not abstaining, over all scenarios. Abstaining earns no credit. */
  top1: number;
  /** Correct cause over the scenarios the agent did not abstain on. Null if it always abstained. */
  top1_answered: number | null;
  confirmed: number;
  /** Said confirmed and was wrong. The number that matters most for trust. */
  false_confirmed: number;
  /** Share of confirmed verdicts that were right. Null if nothing was confirmed. */
  confirmed_precision: number | null;
  /** Share of scenarios answered with cant_tell (or an agent error). */
  abstention_rate: number;
  errors: number;
  probes_used: Summary;
  disruptive_probes: Summary;
  human_questions: Summary;
  latency_ms: { mean: number; p50: number; p95: number; max: number };
}

export interface CauseBreakdown {
  n: number;
  top1: number;
  false_confirmed: number;
  abstained: number;
}

export interface BenchResult {
  agent: string;
  human_reliability: number;
  seed: number;
  metrics: BenchMetrics;
  per_cause: Record<string, CauseBreakdown>;
  cases: CaseResult[];
}

const flip = (a: 'yes' | 'no'): 'yes' | 'no' => (a === 'yes' ? 'no' : 'yes');

const isQuestionKind = (k: unknown): k is HumanQuestionKind => (HUMAN_QUESTION_KINDS as readonly unknown[]).includes(k);

/**
 * A person who answers from the scenario's human truth, wrong with probability 1 minus reliability. A
 * question with no recorded truth gets 'not sure'. A question kind outside HUMAN_QUESTION_KINDS is an
 * agent bug and throws, so it shows up as an error in the results instead of a silent guess.
 */
export function simulatedHuman(scenario: Scenario, reliability: number, rng: Rng): { ask: AskHuman; log: HumanExchange[] } {
  const log: HumanExchange[] = [];
  const ask: AskHuman = async (q) => {
    if (!isQuestionKind(q?.kind)) throw new TypeError(`Unknown question kind. Use one of ${HUMAN_QUESTION_KINDS.join(', ')}.`);
    const truth = Object.hasOwn(scenario.human_truth, q.kind) ? scenario.human_truth[q.kind] : undefined;
    if (truth !== 'yes' && truth !== 'no') {
      log.push({ kind: q.kind, answer: 'not sure', truthful: true });
      return 'not sure';
    }
    const truthful = rng.next() < reliability;
    const answer = truthful ? truth : flip(truth);
    log.push({ kind: q.kind, answer, truthful });
    return answer;
  };
  return { ask, log };
}

const round = (x: number, digits = 4): number => Math.round(x * 10 ** digits) / 10 ** digits;

/** Nearest-rank percentile. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] as number;
}

const summary = (values: readonly number[]): Summary => ({
  total: values.reduce((a, b) => a + b, 0),
  mean: values.length === 0 ? 0 : round(values.reduce((a, b) => a + b, 0) / values.length),
});

function defaultTimer(): () => number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? () => perf.now() : () => 0;
}

export function metricsOf(cases: readonly CaseResult[]): BenchMetrics {
  const n = cases.length;
  const correct = cases.filter((c) => c.correct).length;
  const abstained = cases.filter((c) => c.abstained).length;
  const answered = n - abstained;
  const confirmed = cases.filter((c) => c.level === 'confirmed' && !c.abstained).length;
  const falseConfirmed = cases.filter((c) => c.false_confirmed).length;
  const latencies = cases.map((c) => c.latency_ms);
  return {
    n,
    top1: n === 0 ? 0 : round(correct / n),
    top1_answered: answered === 0 ? null : round(correct / answered),
    confirmed,
    false_confirmed: falseConfirmed,
    confirmed_precision: confirmed === 0 ? null : round((confirmed - falseConfirmed) / confirmed),
    abstention_rate: n === 0 ? 0 : round(abstained / n),
    errors: cases.filter((c) => c.error !== undefined).length,
    probes_used: summary(cases.map((c) => c.probes_used)),
    disruptive_probes: summary(cases.map((c) => c.disruptive_probes)),
    human_questions: summary(cases.map((c) => c.human_questions)),
    latency_ms: {
      mean: summary(latencies).mean,
      p50: round(percentile(latencies, 50), 3),
      p95: round(percentile(latencies, 95), 3),
      max: round(latencies.length === 0 ? 0 : Math.max(...latencies), 3),
    },
  };
}

/**
 * Runs the agent on every scenario, one at a time, and scores it. The agent sees only the scenario
 * view (no title, source, ground truth or human truth).
 */
export async function runBench(agent: BenchAgent, scenarios: readonly Scenario[], opts: BenchOptions = {}): Promise<BenchResult> {
  const reliability = opts.humanReliability ?? 0.9;
  if (!(reliability >= 0.5 && reliability <= 1)) throw new RangeError('humanReliability must be between 0.5 and 1');
  const seed = opts.seed ?? 1;
  const timer = opts.timer ?? defaultTimer();
  const cases: CaseResult[] = [];

  for (const scenario of scenarios) {
    const human = simulatedHuman(scenario, reliability, rngFor('homefault-bench', seed, scenario.id));
    const view = toView(scenario);
    const started = timer();
    let verdict: AgentVerdict | undefined;
    let error: string | undefined;
    try {
      verdict = await agent.diagnose(view, human.ask);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const latency = Math.max(0, timer() - started);
    const level: VerdictLevel = verdict && ['confirmed', 'likely', 'cant_tell'].includes(verdict.level) ? verdict.level : 'cant_tell';
    const got = verdict?.cause_id ?? 'error';
    const abstained = error !== undefined || level === 'cant_tell';
    const correct = !abstained && got === scenario.ground_truth.cause_id;
    const flashes = human.log.filter((h) => h.kind === 'confirm_flash').length;
    const result: CaseResult = {
      scenario_id: scenario.id,
      expected: scenario.ground_truth.cause_id,
      got,
      level,
      confidence: typeof verdict?.confidence === 'number' ? verdict.confidence : null,
      correct,
      false_confirmed: !abstained && level === 'confirmed' && !correct,
      abstained,
      probes_used: verdict?.probes_used ?? 0,
      disruptive_probes: verdict?.disruptive_probes ?? flashes,
      human_questions: human.log.length,
      human: human.log,
      latency_ms: round(latency, 3),
    };
    if (error !== undefined) result.error = error;
    cases.push(result);
    opts.onCase?.(result);
  }

  const perCause: Record<string, CauseBreakdown> = {};
  for (const cause of CAUSE_IDS) {
    const these = cases.filter((c) => c.expected === cause);
    if (these.length === 0) continue;
    perCause[cause] = {
      n: these.length,
      top1: round(these.filter((c) => c.correct).length / these.length),
      false_confirmed: these.filter((c) => c.false_confirmed).length,
      abstained: these.filter((c) => c.abstained).length,
    };
  }
  return { agent: agent.name, human_reliability: reliability, seed, metrics: metricsOf(cases), per_cause: perCause, cases };
}
