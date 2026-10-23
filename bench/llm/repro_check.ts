// Order check: does a baseline answer depend on what the server answered before? Sends the B1 request
// (log only), then the B2 request (same log plus a human answer, so it shares B1's long prefix, as the
// bench will order them), then B1 again, then B1 through Strands. It does this with cache_prompt off
// (the default) and on, and compares answers token for token. It also measures how many prompt tokens
// two different scenarios share, which is all that cache_prompt could save across a benchmark run.
// On a server with two or more slots (LLM_PARALLEL=2) it also sends B1 alone, then B1 and B2 at the
// same time, to see whether batching two requests together changes B1's answer.
//
// Usage (server must be up: ./start-llm.sh):
//   node bench/llm/repro_check.ts [--out bench/llm/results/repro_check.json]
// Exit code 0 only if every default (cache_prompt off) call parsed, B1 gave the same text both times,
// and (with two slots) batching did not change an answer.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_GENERATION, endpointFromEnv, serverRoot, type GenerationOptions, type LlmEndpoint } from './src/config.ts';
import { round1 } from './src/estimate.ts';
import { fetchVerdict, type VerdictCall } from './src/fetch-client.ts';
import { HALLWAY_LAMP_CASE } from './src/fixtures.ts';
import { commandLineOf, cpuBackend, DEFAULT_RUN_DIR, ggmlLibrariesOf, pidFileFor, readServerPid } from './src/proc.ts';
import { diagnosisMessages, type ChatMessage, type DiagnosisInput } from './src/prompt.ts';
import { strandsVerdict } from './src/strands-client.ts';

const here = dirname(fileURLToPath(import.meta.url));

const B1: DiagnosisInput = HALLWAY_LAMP_CASE;
const B2: DiagnosisInput = {
  ...HALLWAY_LAMP_CASE,
  humanAnswers: [{ question: "I'll flash the hallway lamp twice. Did it blink?", answer: 'Yes, it blinked.' }],
};
/** A different scenario, used only to measure the prompt prefix two scenarios share. */
const OTHER: DiagnosisInput = { ...HALLWAY_LAMP_CASE, symptom: 'Why did every plug turn on at 3 a.m.?' };

type Step = { label: string; input: DiagnosisInput; client: 'fetch' | 'strands:json_schema' };
const SEQUENCE: readonly Step[] = [
  { label: 'B1 first', input: B1, client: 'fetch' },
  { label: 'B2 (shares the B1 prefix)', input: B2, client: 'fetch' },
  { label: 'B1 again', input: B1, client: 'fetch' },
  { label: 'B1 through Strands', input: B1, client: 'strands:json_schema' },
];

interface Row {
  phase: 'cache_prompt_off' | 'cache_prompt_on' | 'two_slots_concurrent';
  step: number;
  label: string;
  client: Step['client'];
  ok: boolean;
  failure: string | null;
  cause_id: string | null;
  confidence: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  /** Prompt tokens llama-server reused from the slot (fetch only; Strands does not expose timings). */
  cache_n: number | null;
  /** Prompt tokens the server actually evaluated for this call (fetch only). */
  prompt_n: number | null;
  prompt_ms: number | null;
  wall_ms: number;
  /** sha256 of the answer text, to compare answers exactly without storing them twice. */
  text_sha256: string | null;
  text: string | null;
}

function sha(text: string | null): string | null {
  return text === null ? null : createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function postJson<T>(endpoint: LlmEndpoint, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${serverRoot(endpoint)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** Tokens of the fully rendered chat prompt (template, reasoning effort and all). */
async function renderedTokens(endpoint: LlmEndpoint, messages: readonly ChatMessage[]): Promise<number[]> {
  const { prompt } = await postJson<{ prompt: string }>(endpoint, '/apply-template', {
    messages,
    chat_template_kwargs: { reasoning_effort: DEFAULT_GENERATION.reasoningEffort },
  });
  const { tokens } = await postJson<{ tokens: number[] }>(endpoint, '/tokenize', { content: prompt, add_special: false });
  return tokens;
}

function commonPrefix(a: readonly number[], b: readonly number[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

async function callOnce(endpoint: LlmEndpoint, step: Step, gen: GenerationOptions): Promise<VerdictCall> {
  return step.client === 'fetch'
    ? fetchVerdict(endpoint, diagnosisMessages(step.input), gen)
    : strandsVerdict(endpoint, step.input, gen, 'json_schema');
}

function toRow(phase: Row['phase'], step: number, s: Step, r: VerdictCall): Row {
  const t = r.stats.timings;
  return {
    phase,
    step,
    label: s.label,
    client: s.client,
    ok: r.ok,
    failure: r.ok ? null : `${r.kind}: ${r.error}`,
    cause_id: r.ok ? r.verdict.cause_id : null,
    confidence: r.ok ? r.verdict.confidence : null,
    prompt_tokens: r.stats.promptTokens,
    completion_tokens: r.stats.completionTokens,
    cache_n: t?.cache_n ?? null,
    prompt_n: t?.prompt_n ?? null,
    prompt_ms: t ? Math.round(t.prompt_ms) : null,
    wall_ms: r.stats.wallMs,
    text_sha256: sha(r.text),
    text: r.text,
  };
}

function sameAnswer(a: Row | undefined, b: Row | undefined): boolean {
  return a !== undefined && b !== undefined && a.ok && b.ok && a.text_sha256 === b.text_sha256 && a.completion_tokens === b.completion_tokens;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { out: { type: 'string', default: resolve(here, 'results/repro_check.json') } } });
  const endpoint = endpointFromEnv(process.env);
  const pid = readServerPid(pidFileFor(endpoint, process.env.LLM_RUN_DIR ?? DEFAULT_RUN_DIR));
  const props = (await (await fetch(`${serverRoot(endpoint)}/props`, { headers: { authorization: `Bearer ${endpoint.apiKey}` } })).json()) as {
    build_info?: string;
    total_slots?: number;
  };
  const slots = props.total_slots ?? 1;
  const libraries = ggmlLibrariesOf(pid);
  const loadStart = loadavg()[0];

  const b1Tokens = await renderedTokens(endpoint, diagnosisMessages(B1));
  const b2Tokens = await renderedTokens(endpoint, diagnosisMessages(B2));
  const otherTokens = await renderedTokens(endpoint, diagnosisMessages(OTHER));

  const rows: Row[] = [];
  for (const [phase, cachePrompt] of [
    ['cache_prompt_off', false],
    ['cache_prompt_on', true],
  ] as const) {
    const gen = { ...DEFAULT_GENERATION, cachePrompt };
    for (const [i, step] of SEQUENCE.entries()) {
      const row = toRow(phase, i + 1, step, await callOnce(endpoint, step, gen));
      rows.push(row);
      console.log(
        `[${phase} ${i + 1}] ${step.label} via ${step.client}: ${row.ok ? `${row.cause_id} ${row.confidence}` : row.failure}` +
          ` (${row.completion_tokens ?? '?'} out, cache_n ${row.cache_n ?? '-'}, ${row.wall_ms} ms, text ${row.text_sha256})`,
      );
    }
  }

  if (slots >= 2) {
    // Cache off, as in the benchmark. Step 1: B1 alone. Step 2: B1 and B2 sent together, so the server
    // batches both sequences into the same forward passes.
    const alone = toRow('two_slots_concurrent', 1, SEQUENCE[0]!, await callOnce(endpoint, SEQUENCE[0]!, DEFAULT_GENERATION));
    const [b1, b2] = await Promise.all([callOnce(endpoint, SEQUENCE[0]!, DEFAULT_GENERATION), callOnce(endpoint, SEQUENCE[1]!, DEFAULT_GENERATION)]);
    rows.push(alone, toRow('two_slots_concurrent', 2, { ...SEQUENCE[0]!, label: 'B1 while B2 runs' }, b1), toRow('two_slots_concurrent', 3, { ...SEQUENCE[1]!, label: 'B2 while B1 runs' }, b2));
    for (const row of rows.slice(-3)) {
      console.log(`[two_slots ${row.step}] ${row.label}: ${row.ok ? `${row.cause_id} ${row.confidence}` : row.failure} (${row.completion_tokens ?? '?'} out, ${row.wall_ms} ms, text ${row.text_sha256})`);
    }
  }

  const pick = (phase: Row['phase'], step: number) => rows.find((r) => r.phase === phase && r.step === step);
  const off = rows.filter((r) => r.phase === 'cache_prompt_off');
  const offAndConcurrent = rows.filter((r) => r.phase !== 'cache_prompt_on');
  const coldPp = off.filter((r) => r.prompt_n && r.prompt_ms).map((r) => (r.prompt_n! / r.prompt_ms!) * 1000);
  const ppThisRun = coldPp.length > 0 ? coldPp.reduce((s, v) => s + v, 0) / coldPp.length : null;
  const sharedAcrossScenarios = commonPrefix(b1Tokens, otherTokens);
  const checks = {
    off_all_parsed: off.every((r) => r.ok),
    off_b1_same_before_and_after_b2: sameAnswer(pick('cache_prompt_off', 1), pick('cache_prompt_off', 3)),
    off_strands_same_text_as_fetch: sameAnswer(pick('cache_prompt_off', 1), pick('cache_prompt_off', 4)),
    on_b1_same_before_and_after_b2: sameAnswer(pick('cache_prompt_on', 1), pick('cache_prompt_on', 3)),
    on_b1_same_as_off: sameAnswer(pick('cache_prompt_off', 1), pick('cache_prompt_on', 1)),
    /** null on a one-slot server, where requests never share a batch. */
    two_slots_b1_same_alone_and_batched: slots >= 2 ? sameAnswer(pick('two_slots_concurrent', 1), pick('two_slots_concurrent', 2)) : null,
    two_slots_b2_same_as_sequential: slots >= 2 ? sameAnswer(pick('cache_prompt_off', 2), pick('two_slots_concurrent', 3)) : null,
    cause_ids_off: off.filter((r) => r.label.startsWith('B1')).map((r) => r.cause_id),
    cause_ids_on: rows.filter((r) => r.phase === 'cache_prompt_on' && r.label.startsWith('B1')).map((r) => r.cause_id),
  };
  // The default must be order independent; with two slots, batching must not change answers either.
  const failures = [
    offAndConcurrent.every((r) => r.ok) ? null : 'a call with the default settings did not parse',
    checks.off_b1_same_before_and_after_b2 ? null : 'B1 changed after B2 ran (order dependent)',
    checks.two_slots_b1_same_alone_and_batched === false ? 'batching B1 together with B2 changed B1' : null,
    checks.two_slots_b2_same_as_sequential === false ? 'batching B2 together with B1 changed B2' : null,
  ].filter((f): f is string => f !== null);
  const passed = failures.length === 0;

  const report = {
    generated_at: new Date().toISOString(),
    endpoint: endpoint.baseUrl,
    server: { pid, build_info: props.build_info ?? null, total_slots: slots, argv: commandLineOf(pid).slice(1), cpu_backend: cpuBackend(libraries), ggml_libraries: libraries },
    host: { loadavg_1m_start: round1(loadStart), loadavg_1m_end: round1(loadavg()[0]) },
    generation: DEFAULT_GENERATION,
    method:
      'Per phase, four calls in this order: B1 (fetch), B2 (fetch; same log plus one human answer), B1 again (fetch), B1 through Strands json_schema. ' +
      'Phase cache_prompt_off first, then cache_prompt_on on the same server; with two or more slots, then two_slots_concurrent (cache off): B1 alone, then B1 and B2 at the same time. ' +
      'Two answers are the same when their text sha256 and output token count match.',
    prompt_sharing: {
      rendered_prompt_tokens: { b1: b1Tokens.length, b2: b2Tokens.length, other_scenario: otherTokens.length },
      b1_b2_shared_prefix_tokens: commonPrefix(b1Tokens, b2Tokens),
      shared_prefix_tokens_across_scenarios: sharedAcrossScenarios,
      prompt_tokens_per_second_this_run: ppThisRun === null ? null : round1(ppThisRun),
      most_cache_prompt_could_save_per_call_ms: ppThisRun === null ? null : Math.round((sharedAcrossScenarios / ppThisRun) * 1000),
      note: 'Across different scenarios only the shared prefix (system prompt and template header) could be reused; this is the most cache_prompt true could save per call.',
    },
    checks,
    passed,
    failures,
    rows,
  };
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nchecks: ${JSON.stringify(checks)}`);
  console.log(`shared prefix across scenarios: ${sharedAcrossScenarios} tokens, about ${report.prompt_sharing.most_cache_prompt_could_save_per_call_ms} ms per call`);
  console.log(`${passed ? 'PASS: answers do not depend on call order' : `FAIL: ${failures.join('; ')}`}. Report: ${values.out}`);
  return passed ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
