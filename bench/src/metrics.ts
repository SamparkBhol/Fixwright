// Per-case rows and the metrics computed from them. Scoring follows homefault's runner exactly:
// correct = right cause and not abstaining; false_confirmed = said confirmed and was wrong; can't tell
// (and any error) is an abstention. Every rate carries a 95% Wilson interval.

import type { CaseResult, VerdictLevel } from 'homefault';
import type { FixwrightRecord } from './agents/fixwright.ts';
import type { LlmRecord } from './agents/llm.ts';
import type { SubsetName } from './sample.ts';
import { mean, percentile, rate, type Rate } from './stats.ts';

export const AGENT_NAMES = ['fixwright', 'b1', 'b2'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export interface CaseRow {
  agent: AgentName;
  scenario_id: string;
  set: SubsetName;
  expected: string;
  got: string;
  level: VerdictLevel;
  confidence: number | null;
  correct: boolean;
  false_confirmed: boolean;
  abstained: boolean;
  probes_used: number;
  disruptive_probes: number;
  /** Questions put to the person: observations and permission questions, re-asks included. */
  human_questions: number;
  latency_ms: number;
  /** LLM only: the answer was not a valid verdict (schema failure or the token cap). */
  invalid_output: boolean;
  /** LLM only: no answer from the server after the fallback and retries. Not the model's doing. */
  infra_error: boolean;
  error: string | null;
  fixwright?: FixwrightRecord;
  llm?: LlmRecord;
}

export function fixwrightRow(c: CaseResult, set: SubsetName, r: FixwrightRecord): CaseRow {
  return {
    agent: 'fixwright',
    scenario_id: c.scenario_id,
    set,
    expected: c.expected,
    got: c.got,
    level: c.level,
    confidence: c.confidence,
    correct: c.correct,
    false_confirmed: c.false_confirmed,
    abstained: c.abstained,
    probes_used: r.probes_used,
    disruptive_probes: r.disruptive_probes,
    human_questions: r.questions,
    latency_ms: c.latency_ms,
    invalid_output: false,
    infra_error: false,
    error: r.error_code ?? c.error ?? null,
    fixwright: r,
  };
}

export function llmRow(c: CaseResult, set: SubsetName, r: LlmRecord): CaseRow {
  return {
    agent: r.variant,
    scenario_id: c.scenario_id,
    set,
    expected: c.expected,
    got: c.got,
    level: c.level,
    confidence: c.confidence,
    correct: c.correct,
    false_confirmed: c.false_confirmed,
    abstained: c.abstained,
    probes_used: 0,
    disruptive_probes: 0,
    human_questions: 0,
    // A reused answer costs nothing now; report what the call it reuses took.
    latency_ms: r.path === 'reused' ? r.llm_wall_ms : c.latency_ms,
    invalid_output: r.outcome === 'invalid_output' || r.outcome === 'max_tokens',
    infra_error: r.outcome === 'infra_error',
    error: r.error ?? c.error ?? null,
    llm: r,
  };
}

export interface Total {
  total: number;
  mean: number;
}

export interface CauseMetrics {
  n: number;
  correct: number;
  top1: number;
  confirmed: number;
  false_confirmed: number;
  abstained: number;
}

export interface LlmExtras {
  paths: Record<'strands' | 'fetch_fallback' | 'reused' | 'failed', number>;
  outcomes: Record<'answer' | 'unknown' | 'invalid_output' | 'max_tokens' | 'infra_error', number>;
  /** Over calls actually made (not reused) that reported token usage. */
  prompt_tokens: { mean: number; max: number } | null;
  completion_tokens: { mean: number; max: number } | null;
  /** Wall time of calls actually made. */
  call_ms: { mean: number; p50: number; p95: number; max: number; total: number } | null;
  with_human_answers: number;
}

export interface FixwrightExtras {
  /** Cases per tool (diagnose, explain_event). */
  tools: Record<string, number>;
  /** Questions that asked for permission (a flash in quiet hours), included in human_questions. */
  permission_questions: number;
  /** Engine error codes and how often each stopped a diagnosis. */
  error_codes: Record<string, number>;
}

export interface AgentMetrics {
  n: number;
  answered: number;
  confirmed: number;
  top1: Rate;
  top1_answered: Rate;
  false_confirmed: { count: number; rate: Rate };
  abstention: Rate;
  confirmed_precision: Rate;
  invalid_outputs: { count: number; rate: Rate };
  infra_errors: number;
  errors: number;
  probes_used: Total;
  disruptive_probes: Total;
  human_questions: Total;
  latency_ms: { mean: number; p50: number; p95: number; max: number };
  per_cause: Record<string, CauseMetrics>;
  llm?: LlmExtras;
  fixwright?: FixwrightExtras;
}

const total = (values: readonly number[]): Total => ({ total: values.reduce((a, b) => a + b, 0), mean: mean(values) });
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

function fixwrightExtras(rows: readonly CaseRow[]): FixwrightExtras | undefined {
  const recs = rows.map((r) => r.fixwright).filter((r): r is FixwrightRecord => r !== undefined);
  if (recs.length === 0) return undefined;
  const tools: Record<string, number> = {};
  const codes: Record<string, number> = {};
  for (const r of recs) {
    tools[r.tool] = (tools[r.tool] ?? 0) + 1;
    if (r.error_code) codes[r.error_code] = (codes[r.error_code] ?? 0) + 1;
  }
  return { tools, permission_questions: recs.reduce((a, r) => a + r.consent_questions, 0), error_codes: codes };
}

function llmExtras(rows: readonly CaseRow[]): LlmExtras | undefined {
  const recs = rows.map((r) => r.llm).filter((r): r is LlmRecord => r !== undefined);
  if (recs.length === 0) return undefined;
  const paths = { strands: 0, fetch_fallback: 0, reused: 0, failed: 0 };
  const outcomes = { answer: 0, unknown: 0, invalid_output: 0, max_tokens: 0, infra_error: 0 };
  for (const r of recs) {
    paths[r.path]++;
    outcomes[r.outcome]++;
  }
  const made = recs.filter((r) => r.path !== 'reused');
  const stat = (xs: number[]) => (xs.length === 0 ? null : { mean: mean(xs), max: Math.max(...xs) });
  const walls = made.map((r) => r.llm_wall_ms);
  return {
    paths,
    outcomes,
    prompt_tokens: stat(made.map((r) => r.prompt_tokens).filter((x): x is number => x !== null)),
    completion_tokens: stat(made.map((r) => r.completion_tokens).filter((x): x is number => x !== null)),
    call_ms:
      walls.length === 0
        ? null
        : { mean: mean(walls), p50: percentile(walls, 50), p95: percentile(walls, 95), max: Math.max(...walls), total: walls.reduce((a, b) => a + b, 0) },
    with_human_answers: recs.filter((r) => r.human_answers > 0).length,
  };
}

export function computeMetrics(rows: readonly CaseRow[]): AgentMetrics {
  const n = rows.length;
  const correct = rows.filter((r) => r.correct).length;
  const abstained = rows.filter((r) => r.abstained).length;
  const answered = n - abstained;
  const confirmed = rows.filter((r) => r.level === 'confirmed' && !r.abstained).length;
  const falseConfirmed = rows.filter((r) => r.false_confirmed).length;
  const invalid = rows.filter((r) => r.invalid_output).length;
  const latencies = rows.map((r) => r.latency_ms);
  const perCause: Record<string, CauseMetrics> = {};
  for (const row of rows) {
    const m = (perCause[row.expected] ??= { n: 0, correct: 0, top1: 0, confirmed: 0, false_confirmed: 0, abstained: 0 });
    m.n++;
    if (row.correct) m.correct++;
    if (row.level === 'confirmed' && !row.abstained) m.confirmed++;
    if (row.false_confirmed) m.false_confirmed++;
    if (row.abstained) m.abstained++;
  }
  for (const m of Object.values(perCause)) m.top1 = Math.round((m.correct / m.n) * 10_000) / 10_000;
  const extras = llmExtras(rows);
  const fx = fixwrightExtras(rows);
  return {
    n,
    answered,
    confirmed,
    top1: rate(correct, n),
    top1_answered: rate(correct, answered),
    false_confirmed: { count: falseConfirmed, rate: rate(falseConfirmed, n) },
    abstention: rate(abstained, n),
    confirmed_precision: rate(confirmed - falseConfirmed, confirmed),
    invalid_outputs: { count: invalid, rate: rate(invalid, n) },
    infra_errors: rows.filter((r) => r.infra_error).length,
    errors: rows.filter((r) => r.error !== null).length,
    probes_used: total(rows.map((r) => r.probes_used)),
    disruptive_probes: total(rows.map((r) => r.disruptive_probes)),
    human_questions: total(rows.map((r) => r.human_questions)),
    latency_ms: {
      mean: r3(mean(latencies)),
      p50: r3(percentile(latencies, 50)),
      p95: r3(percentile(latencies, 95)),
      max: r3(latencies.length === 0 ? 0 : Math.max(...latencies)),
    },
    per_cause: perCause,
    ...(extras ? { llm: extras } : {}),
    ...(fx ? { fixwright: fx } : {}),
  };
}

/** Metrics overall and per subset, for one agent's rows. */
export function metricsBySet(rows: readonly CaseRow[]): { all: AgentMetrics; sets: Partial<Record<SubsetName, AgentMetrics>> } {
  const sets: Partial<Record<SubsetName, AgentMetrics>> = {};
  for (const set of ['dev', 'heldout', 'incidents'] as const) {
    const these = rows.filter((r) => r.set === set);
    if (these.length > 0) sets[set] = computeMetrics(these);
  }
  return { all: computeMetrics(rows), sets };
}
