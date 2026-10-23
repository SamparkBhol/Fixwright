// The LLM-only baselines. B1 reads the raw logs and the symptom. B2 reads the same plus the
// answers the person gave Fixwright in that scenario (recorded by running Fixwright first), so the only
// difference from Fixwright is who reasons over the evidence. One call per scenario through the Strands
// Agents SDK (bench/llm strandsVerdict); the plain fetch client runs only when the Strands call itself
// fails (no answer from the server), never to give the model a second try at an answer it already gave.
// Scoring: confidence >= 0.9 is confirmed, below is likely, 'unknown' is can't tell; an answer that is
// not a valid verdict (schema failure or the token cap) is can't tell and counted as an invalid output.

import { createHash } from 'node:crypto';
import type { AgentVerdict, BenchAgent, ScenarioView } from 'homefault';
import type { GenerationOptions, LlmEndpoint } from '../../llm/src/config.ts';
import { fetchVerdict, type FailureKind, type VerdictCall } from '../../llm/src/fetch-client.ts';
import { diagnosisMessages, type ChatMessage, type DiagnosisInput } from '../../llm/src/prompt.ts';
import { strandsVerdict, type StrandsJsonMode } from '../../llm/src/strands-client.ts';
import { isConfirmed, type LlmVerdict } from '../../llm/src/verdict.ts';
import { renderScenarioLog } from '../render.ts';

export type LlmVariant = 'b1' | 'b2';

export interface QA {
  question: string;
  answer: string;
}

/** Which client produced the answer. */
export type LlmPath = 'strands' | 'fetch_fallback' | 'reused' | 'failed';

/** How the call ended, from the bench's point of view. */
export type LlmOutcome = 'answer' | 'unknown' | 'invalid_output' | 'max_tokens' | 'infra_error';

export interface AttemptLog {
  client: 'strands' | 'fetch';
  ok: boolean;
  kind?: FailureKind;
  error?: string;
  wall_ms: number;
}

export interface LlmRecord {
  scenario_id: string;
  variant: LlmVariant;
  path: LlmPath;
  /** For path 'reused': the agent whose identical call was reused. */
  reused_from?: LlmVariant;
  outcome: LlmOutcome;
  verdict: LlmVerdict | null;
  /** What the bench scored. */
  scored: { cause_id: string; level: 'confirmed' | 'likely' | 'cant_tell'; confidence: number | null };
  /** Every client call made for this case, in order. */
  attempts: AttemptLog[];
  error: string | null;
  /** sha256 of the exact chat messages sent (system and user). */
  prompt_sha256: string;
  prompt_chars: number;
  human_answers: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** Wall time of the client call(s) that produced the answer. */
  llm_wall_ms: number;
  /** The model's final text (the JSON answer), kept for audits. */
  text: string | null;
}

export interface LlmClients {
  strands: (endpoint: LlmEndpoint, input: DiagnosisInput, gen: GenerationOptions, mode: StrandsJsonMode) => Promise<VerdictCall>;
  fetch: (endpoint: LlmEndpoint, messages: readonly ChatMessage[], gen: GenerationOptions) => Promise<VerdictCall>;
}

export const DEFAULT_CLIENTS: LlmClients = {
  strands: (endpoint, input, gen, mode) => strandsVerdict(endpoint, input, gen, mode),
  fetch: (endpoint, messages, gen) => fetchVerdict(endpoint, messages, gen),
};

/** Calls whose answers can be reused by another baseline with a byte-identical request. */
export type CallCache = Map<string, { variant: LlmVariant; record: LlmRecord }>;

export interface LlmAgentOptions {
  variant: LlmVariant;
  endpoint: LlmEndpoint;
  gen: GenerationOptions;
  mode?: StrandsJsonMode;
  /** B2 only: the answers Fixwright received in that scenario (observations, in order). */
  answersFor?: (scenarioId: string) => readonly QA[];
  clients?: Partial<LlmClients>;
  /**
   * Shared between B1 and B2 of one run. A B2 request with no answers is byte for byte the B1 request;
   * with temperature 0, cache_prompt off and one slot the server returns the same text for the same
   * request (bench/llm results/repro_check.json), so the earlier call is reused and marked 'reused'.
   */
  cache?: CallCache;
  /** Whole retries (Strands, then fetch) after both clients failed for infrastructure reasons. Default 1. */
  infraRetries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRecord?: (r: LlmRecord) => void;
}

const INFRA: ReadonlySet<FailureKind> = new Set(['server_error', 'request_failed']);

/** The exact input a baseline gets for a scenario. */
export function baselineInput(view: ScenarioView, answers: readonly QA[] = []): DiagnosisInput {
  return { symptom: view.symptom.text, log: renderScenarioLog(view), ...(answers.length > 0 ? { humanAnswers: [...answers] } : {}) };
}

/** Identity of a request: the messages plus every setting that can change the answer. */
export function requestKey(input: DiagnosisInput, endpoint: LlmEndpoint, gen: GenerationOptions, mode: StrandsJsonMode): { key: string; sha: string; chars: number } {
  const messages = diagnosisMessages(input);
  const body = JSON.stringify(messages);
  const sha = createHash('sha256').update(body).digest('hex');
  const { timeoutMs: _timeout, ...answerSettings } = gen;
  return { key: `${sha}|${endpoint.baseUrl}|${endpoint.model}|${mode}|${JSON.stringify(answerSettings)}`, sha, chars: body.length };
}

/** Bench scoring of one finished call. */
export function scoreCall(call: VerdictCall): { outcome: LlmOutcome; scored: LlmRecord['scored'] } {
  if (!call.ok) {
    const outcome: LlmOutcome = call.kind === 'max_tokens' ? 'max_tokens' : call.kind === 'invalid_output' ? 'invalid_output' : 'infra_error';
    return { outcome, scored: { cause_id: outcome === 'infra_error' ? 'infra_error' : 'invalid_output', level: 'cant_tell', confidence: null } };
  }
  const v = call.verdict;
  if (v.cause_id === 'unknown') return { outcome: 'unknown', scored: { cause_id: 'unknown', level: 'cant_tell', confidence: v.confidence } };
  return { outcome: 'answer', scored: { cause_id: v.cause_id, level: isConfirmed(v) ? 'confirmed' : 'likely', confidence: v.confidence } };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Strands first; fetch only when Strands got no answer from the server. Infra failures retry whole. */
async function callWithFallback(
  input: DiagnosisInput,
  opts: LlmAgentOptions,
  clients: LlmClients,
): Promise<{ call: VerdictCall; path: LlmPath; attempts: AttemptLog[]; wallMs: number }> {
  const mode = opts.mode ?? 'json_schema';
  const attempts: AttemptLog[] = [];
  const log = (client: AttemptLog['client'], c: VerdictCall) =>
    attempts.push({ client, ok: c.ok, ...(c.ok ? {} : { kind: c.kind, error: c.error }), wall_ms: c.stats.wallMs });
  const retries = opts.infraRetries ?? 1;
  let last: VerdictCall | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await (opts.sleep ?? defaultSleep)(opts.retryDelayMs ?? 15_000);
    const s = await clients.strands(opts.endpoint, input, opts.gen, mode);
    log('strands', s);
    if (s.ok || !INFRA.has(s.kind)) return { call: s, path: 'strands', attempts, wallMs: s.stats.wallMs };
    const f = await clients.fetch(opts.endpoint, diagnosisMessages(input), opts.gen);
    log('fetch', f);
    if (f.ok || !INFRA.has(f.kind)) return { call: f, path: 'fetch_fallback', attempts, wallMs: f.stats.wallMs };
    last = f;
  }
  return { call: last as VerdictCall, path: 'failed', attempts, wallMs: attempts.reduce((a, b) => a + b.wall_ms, 0) };
}

export function toAgentVerdict(r: LlmRecord): AgentVerdict {
  return { cause_id: r.scored.cause_id, level: r.scored.level, ...(r.scored.confidence !== null ? { confidence: r.scored.confidence } : {}), probes_used: 0, disruptive_probes: 0 };
}

/** One baseline call for one scenario, with its record. Never throws for a client failure. */
export async function runBaseline(view: ScenarioView, opts: LlmAgentOptions): Promise<LlmRecord> {
  const clients: LlmClients = { ...DEFAULT_CLIENTS, ...opts.clients };
  const mode = opts.mode ?? 'json_schema';
  const answers = opts.variant === 'b2' ? [...(opts.answersFor?.(view.id) ?? [])] : [];
  const input = baselineInput(view, answers);
  const req = requestKey(input, opts.endpoint, opts.gen, mode);
  const base = { scenario_id: view.id, variant: opts.variant, prompt_sha256: req.sha, prompt_chars: req.chars, human_answers: answers.length };

  const cached = opts.cache?.get(req.key);
  if (cached && cached.variant !== opts.variant) {
    const r = cached.record;
    return { ...r, ...base, path: 'reused', reused_from: cached.variant, attempts: [] };
  }

  const { call, path, attempts, wallMs } = await callWithFallback(input, opts, clients);
  const { outcome, scored } = scoreCall(call);
  const record: LlmRecord = {
    ...base,
    path,
    outcome,
    verdict: call.ok ? call.verdict : null,
    scored,
    attempts,
    error: call.ok ? null : `${call.kind}: ${call.error}`,
    prompt_tokens: call.stats.promptTokens,
    completion_tokens: call.stats.completionTokens,
    llm_wall_ms: wallMs,
    text: call.text,
  };
  if (outcome !== 'infra_error') opts.cache?.set(req.key, { variant: opts.variant, record });
  return record;
}

/** A homefault BenchAgent for B1 or B2. It never asks the person anything. */
export function llmAgent(opts: LlmAgentOptions): BenchAgent {
  if (opts.variant === 'b2' && !opts.answersFor) throw new Error('B2 needs answersFor: run Fixwright first and pass the answers it received');
  return {
    name: opts.variant,
    async diagnose(view) {
      const record = await runBaseline(view, opts);
      opts.onRecord?.(record);
      return toAgentVerdict(record);
    },
  };
}
