// Measures the running llama-server: prompt processing and generation speed on an exact
// 1,500-token prompt with a forced 300-token answer, peak RSS of the server process, and a few
// real diagnosis calls. Then estimates the wall time of a 300-call benchmark run.
//
// Usage (server must be up: ./start-llm.sh):
//   node bench/llm/measure_llm.ts [--runs 3] [--calls 3] [--concurrency 1] [--out bench/llm/results/llm_measure.json]
// --concurrency N sends N requests at once per run (start the server with LLM_PARALLEL=N) to see
// whether parallel slots shorten a benchmark run.
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_GENERATION, endpointFromEnv, serverRoot, type LlmEndpoint } from './src/config.ts';
import { estimateRun, median, round1 } from './src/estimate.ts';
import { fetchVerdict, type ServerTimings } from './src/fetch-client.ts';
import { HALLWAY_LAMP_CASE, longLog } from './src/fixtures.ts';
import { commandLineOf, cpuBackend, DEFAULT_RUN_DIR, ggmlLibrariesOf, memoryOf, pidFileFor, readServerPid } from './src/proc.ts';
import { diagnosisMessages } from './src/prompt.ts';

const PROMPT_TOKENS = 1500;
const ANSWER_TOKENS = 300;
const BENCH_CALLS = 300;

const here = dirname(fileURLToPath(import.meta.url));

/** The key only matters when the server was started with LLM_API_KEY set; otherwise llama-server ignores it. */
function authHeaders(endpoint: LlmEndpoint): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` };
}

async function postJson<T>(endpoint: LlmEndpoint, path: string, body: unknown, timeoutMs = 600_000): Promise<T> {
  const url = `${serverRoot(endpoint)}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(endpoint),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      runs: { type: 'string', default: '3' },
      calls: { type: 'string', default: '3' },
      concurrency: { type: 'string', default: '1' },
      out: { type: 'string', default: resolve(here, 'results/llm_measure.json') },
      // Same file start-llm.sh writes for this port (llm-config.sh: llama-server-$LLM_PORT.pid).
      'pid-file': { type: 'string' },
    },
  });
  const runs = Number(values.runs);
  const calls = Number(values.calls);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  if (!Number.isInteger(calls) || calls < 0) throw new Error('--calls must be a non-negative integer');
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer');
  const endpoint = endpointFromEnv(process.env);
  const root = serverRoot(endpoint);
  const pid = readServerPid(values['pid-file'] ?? pidFileFor(endpoint, process.env.LLM_RUN_DIR ?? DEFAULT_RUN_DIR));
  const loadStart = loadavg()[0];
  const props = (await (await fetch(`${root}/props`, { headers: authHeaders(endpoint) })).json()) as {
    build_info?: string;
    total_slots?: number;
    default_generation_settings?: { n_ctx?: number };
  };
  if ((props.total_slots ?? 1) < concurrency) {
    throw new Error(`server has ${props.total_slots} slot(s); restart it with LLM_PARALLEL=${concurrency}`);
  }

  // Exact 1,500-token prompt: tokenize a long synthetic log and cut it to the first 1,500 ids.
  const { tokens } = await postJson<{ tokens: number[] }>(endpoint, '/tokenize', { content: longLog(260) });
  if (tokens.length < PROMPT_TOKENS) throw new Error(`synthetic log has only ${tokens.length} tokens`);
  const prompt = tokens.slice(0, PROMPT_TOKENS);

  // Warm-up so page faults of the memory-mapped weights are not billed to the first run.
  await postJson(endpoint, '/completion', { prompt: prompt.slice(0, 64), n_predict: 8, cache_prompt: false });

  const oneRequest = async (): Promise<ServerTimings> => {
    const r = await postJson<{ timings: ServerTimings }>(endpoint, '/completion', {
      prompt,
      n_predict: ANSWER_TOKENS,
      ignore_eos: true,
      cache_prompt: false,
      temperature: 0,
      seed: 42,
    });
    if (r.timings.prompt_n !== PROMPT_TOKENS || r.timings.predicted_n !== ANSWER_TOKENS) {
      throw new Error(`unexpected token counts: prompt ${r.timings.prompt_n}, predicted ${r.timings.predicted_n}`);
    }
    return r.timings;
  };
  const raw: ServerTimings[] = [];
  const roundWallMs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    const round = await Promise.all(Array.from({ length: concurrency }, oneRequest));
    roundWallMs.push(Math.round(performance.now() - started));
    raw.push(...round);
    const per = round.map((t) => `pp ${round1(t.prompt_per_second)}, tg ${round1(t.predicted_per_second)}`).join(' | ');
    console.log(`run ${i + 1}: ${per} tok/s; ${concurrency} request(s) done in ${roundWallMs.at(-1)} ms`);
  }
  const pp = median(raw.map((t) => t.prompt_per_second));
  const tg = median(raw.map((t) => t.predicted_per_second));
  const throughput = { promptTokensPerSecond: pp, generationTokensPerSecond: tg };
  const medianRoundMs = median(roundWallMs);
  const rounds = Math.ceil(BENCH_CALLS / concurrency);

  // Real diagnosis calls through the chat API (template, reasoning at low effort, JSON grammar).
  const real = [];
  for (let i = 0; i < calls; i++) {
    // Cold calls (cachePrompt false, the benchmark default): every call pays for its whole prompt.
    const r = await fetchVerdict(endpoint, diagnosisMessages(HALLWAY_LAMP_CASE), { ...DEFAULT_GENERATION, cachePrompt: false });
    real.push({
      ok: r.ok,
      wall_ms: r.stats.wallMs,
      prompt_tokens: r.stats.promptTokens,
      completion_tokens: r.stats.completionTokens,
      server_prompt_ms: r.stats.timings ? Math.round(r.stats.timings.prompt_ms) : null,
      server_predicted_ms: r.stats.timings ? Math.round(r.stats.timings.predicted_ms) : null,
      reasoning_chars: r.reasoning?.length ?? 0,
      cause_id: r.ok ? r.verdict.cause_id : null,
    });
    console.log(`diagnosis call ${i + 1}: ${r.ok ? 'parsed' : 'FAILED'} in ${r.stats.wallMs} ms, ${r.stats.promptTokens} in / ${r.stats.completionTokens} out`);
  }
  const memory = memoryOf(pid);
  const loadEnd = loadavg()[0];

  const synthetic = estimateRun(BENCH_CALLS, { promptTokens: PROMPT_TOKENS, outputTokens: ANSWER_TOKENS }, throughput);
  const realMedianMs = real.length > 0 ? median(real.map((r) => r.wall_ms)) : null;
  const report = {
    generated_at: new Date().toISOString(),
    server: {
      pid,
      build_info: props.build_info ?? null,
      n_ctx: props.default_generation_settings?.n_ctx ?? null,
      argv: commandLineOf(pid).slice(1),
      // Which per-ISA CPU backend llama.cpp mapped (from /proc/<pid>/maps), plus every ggml library.
      cpu_backend: cpuBackend(ggmlLibrariesOf(pid)),
      ggml_libraries: ggmlLibrariesOf(pid),
    },
    host: {
      cpu: cpus()[0]?.model ?? 'unknown',
      logical_cpus: cpus().length,
      // The VM is shared with other build jobs; a high load average means the numbers are pessimistic.
      loadavg_1m_start: round1(loadStart),
      loadavg_1m_end: round1(loadEnd),
    },
    method: `${runs} runs of ${concurrency} concurrent /completion request(s) with an exact ${PROMPT_TOKENS}-token prompt, ${ANSWER_TOKENS} forced tokens (ignore_eos), cache_prompt false, after one warm-up; medians reported. Per-request speeds are per slot.`,
    concurrency,
    throughput: {
      prompt_tokens_per_second: round1(pp),
      generation_tokens_per_second: round1(tg),
      requests: raw.map((t) => ({ prompt_per_second: round1(t.prompt_per_second), predicted_per_second: round1(t.predicted_per_second), prompt_ms: Math.round(t.prompt_ms), predicted_ms: Math.round(t.predicted_ms) })),
      round_wall_ms: roundWallMs,
    },
    memory,
    diagnosis_calls: { median_wall_ms: realMedianMs, calls: real },
    estimate_300_calls: {
      synthetic_1500_in_300_out: concurrency === 1 ? synthetic : null,
      measured_rounds_1500_in_300_out: { calls: BENCH_CALLS, concurrency, rounds, medianRoundMs, totalMinutes: round1((rounds * medianRoundMs) / 60_000) },
      measured_diagnosis_call:
        realMedianMs === null ? null : { calls: BENCH_CALLS, perCallMs: realMedianMs, totalMinutes: round1((realMedianMs * BENCH_CALLS) / 60_000) },
      note: 'synthetic = 300 x (1500/pp + 300/tg) from server timings; measured_rounds = ceil(300/concurrency) x median wall time of a round, HTTP included; measured_diagnosis_call = 300 x median cold call on the small smoke log.',
    },
  };
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n');
  console.log(`\npp ${report.throughput.prompt_tokens_per_second} tok/s, tg ${report.throughput.generation_tokens_per_second} tok/s, peak RSS ${memory.peak_rss_mib} MiB`);
  console.log(`300 calls at 1500 in / 300 out, concurrency ${concurrency}: ${round1((rounds * medianRoundMs) / 60_000)} min from round wall time${concurrency === 1 ? `, ${synthetic.totalMinutes} min from server timings` : ''}`);
  console.log(`Report: ${values.out}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
