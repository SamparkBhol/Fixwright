# bench/llm: local open-weights LLM for the HomeTruth baselines

This folder runs **gpt-oss-20b** on **llama.cpp** as a local OpenAI-compatible server on
`127.0.0.1:8771`, and proves that the **Strands Agents TypeScript SDK** (`@strands-agents/sdk` 1.19.0)
can call it and get back a diagnosis JSON `{cause_id, confidence, explanation}` that parses and
validates. A plain `fetch` client asks the same question for comparison. The HomeTruth benchmark
uses these clients for its LLM-only baselines B1 and B2.

**For the bench, in one line:** call `strandsVerdict(endpoint, input, DEFAULT_GENERATION, 'json_schema')`
once per scenario, one call at a time, against a one-slot server. With those settings the same
request gives the same answer whatever ran before it. Prompt caching and batched concurrent
requests both changed answers in measured runs (see "Reproducible answers" below).

## Why local

- **Free and reproducible.** No API key, no per-token bill, no rate limit. Anyone can rerun the
  baseline with the same pinned binary, the same model file (checked by sha256) and greedy decoding.
- **Fair.** An open-weights model with published weights and license is a baseline judges can audit.
- **Offline.** After `fetch-llm.sh`, nothing leaves the machine.

## Versions (all pinned)

| Piece | Pin | Why this one |
| --- | --- | --- |
| llama.cpp | stable release **v0.5.0** (published 2026-09-23), prebuilt `llama-b11146-bin-ubuntu-x64.tar.gz`, commit `7fe450e19` | Newest stable release at least 14 days old on 15 Oct 2026. The project now marks its `bNNNN` nightly builds as prereleases; v0.5.0 points at nightly **b11146** for its binaries. Archive sha256 `c150306eb16b5ab696f76a8bdf810c35fd98a24e82158742e6fa28f420ff8410` (matches the GitHub asset digest). |
| CPU build | `ubuntu-x64` (CPU, backend picked at run time) | The VM is an AMD Ryzen 9 5950X (Zen 3): AVX2, FMA, F16C, no AVX-512. The build ships one CPU backend per instruction set level; the running server maps `libggml-cpu-haswell.so` (the AVX2 one), read from `/proc/<pid>/maps` and saved as `server.cpu_backend` in `results/repro_check.json` and `results/llm_measure_parallel2.json`. Its newest required glibc symbol is 2.34; the VM has 2.36. No source build was needed. |
| Model | `ggml-org/gpt-oss-20b-GGUF` at revision `ef9b12f2ff56c69cf32153a02784e7a3c88bf524`, file `gpt-oss-20b-MXFP4.gguf` | The ggml-org MXFP4 file, ungated. **12,109,566,624 bytes**, sha256 `27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901`, both checked against the Hugging Face LFS metadata after download. |
| License | gpt-oss-20b: **Apache-2.0**. llama.cpp: MIT. | Both allow use in an MIT project. Weights and binaries stay in `.cache/llm`, outside the repo, and are never committed. |
| Node | `@strands-agents/sdk` 1.19.0, `openai` 6.49.0 (peer of the Strands OpenAI provider), `zod` 4.6.5, `@fixwright/protocol` and `homefault` (workspace) | All already in `bench/package.json`. This module installed nothing extra. |

Big files live in `$LLM_HOME` (workspace cache, outside the repo):
`llama.cpp/llama-b11146/` (binaries), `models/` (GGUF plus a `.verified` checksum marker),
`run/` (per port: `llama-server-<port>.pid`, `.log`, and `.key` while a keyed server runs),
`dl/` (the downloaded archive).

## Files

| File | What it does |
| --- | --- |
| `fetch-llm.sh` | Downloads the pinned llama.cpp build and the GGUF, verifies size and sha256. Rerunnable; verified files are skipped. |
| `start-llm.sh` | Starts `llama-server` detached on 127.0.0.1:8771, waits until `/health` is 200. Idempotent; refuses if the port is taken by something else. |
| `stop-llm.sh` | Stops the server. Signals only the pid in this port's pid file, and only after checking it runs our binary on our port. |
| `health-llm.sh` | Liveness (`/health`, `/v1/models`, RSS). `--deep` also asks for a tiny schema-constrained JSON answer. Exit 0 healthy, 1 down. |
| `llm-config.sh` | Every path, pin and server setting in one place; each setting can be overridden from the environment. |
| `strands_smoke.ts` | The Strands proof: both Strands JSON modes plus the fetch client on a small smart home log; asserts the answers parse. |
| `repro_check.ts` | Order check: the same request before and after another one, with prompt caching off and on, and (on a two-slot server) batched with another request. Exit 0 only if the default settings are order independent. |
| `measure_llm.ts` | Speed on an exact 1,500-token prompt with a forced 300-token answer, peak RSS, cold diagnosis calls, 300-call estimate, loaded CPU backend. `--concurrency N` for parallel slots. |
| `src/` | Reusable clients for the bench (API below). |
| `test/` | Vitest: 45 offline tests plus 3 live tests behind `FIXWRIGHT_LLM_LIVE=1`. |
| `results/` | Raw JSON from every measured run quoted in this README. |

## How to run

Every script reads its settings from `llm-config.sh`, which also sources `tools/buildenv.sh` from the folder that
holds the checkout when that file exists.

```sh
cd fixwright
bench/llm/fetch-llm.sh                     # once: about 12 GB download, checksum verified
bench/llm/start-llm.sh                     # healthy in about 17 s
bench/llm/health-llm.sh --deep             # UP plus a JSON round trip
node bench/llm/strands_smoke.ts --runs 2   # Strands + fetch, writes results/strands_smoke.json
node bench/llm/repro_check.ts              # order check, writes results/repro_check.json
node bench/llm/measure_llm.ts              # speed, RSS, estimate, writes results/llm_measure.json
bench/llm/stop-llm.sh                      # always stop it when done
```

Node 22.18 or newer runs the `.ts` files directly (type stripping). Overrides, for example a second
slot: `LLM_PARALLEL=2 LLM_CTX=32768 bench/llm/start-llm.sh` (16k context per slot), then
`node bench/llm/measure_llm.ts --concurrency 2`. Each port gets its own pid file and log, so a test
server on another port (`LLM_PORT=8772`) cannot touch the one on 8771. Client side: `LLM_BASE_URL`
(or `LLM_HOST`, `LLM_PORT`), `LLM_MODEL`, `LLM_API_KEY`.

Optional API key: `LLM_API_KEY=<secret> bench/llm/start-llm.sh` makes the server require
`Authorization: Bearer <secret>` on every call except `/health`. The key goes to llama-server through a
mode 600 file (`--api-key-file`), never the command line. Set the same `LLM_API_KEY` for the health
script, the clients and the measurement scripts. Checked: no key and a wrong key get HTTP 401, the
health script says so, both clients report it as `server_error` (HTTP 401), and the live tests and
`measure_llm.ts` pass with the key set.

Tests: `npm run check` in `bench/` runs this folder's tests and, through `test/typecheck.test.ts`, also
typechecks this folder (bench's own `tsc` step covers only `bench/src`, `test` and `scripts`). To
typecheck by hand, pass an absolute path: `npx tsc -p "$PWD/bench/llm/tsconfig.json"` from the
fixwright root. (`npx` runs from the workspace root, so `npx tsc -p tsconfig.json` inside this folder
silently checks `bench/tsconfig.json` instead.) Live tests: start the server, then
`cd bench && FIXWRIGHT_LLM_LIVE=1 npx vitest run llm/test/live.test.ts`.

## Server settings and why

| Flag | Value | Reason |
| --- | --- | --- |
| `--ctx-size`, `--parallel` | 16384, 1 | 16k context for long incident logs. One slot: requests never share a batch, which keeps answers reproducible (two slots changed answers, see below) and per-call timing clean. |
| `--threads`, `--threads-batch` | 8, 10 | From the llama-bench sweep below. Generation is flat from 6 to 12 threads; 16 threads made it collapse. |
| `--flash-attn` | on | Prompt processing 74.7 tok/s with it, 61.3 without (8 threads, same sweep). |
| `--jinja --reasoning-format auto` | | gpt-oss chat template; its reasoning goes to `reasoning_content`, the answer to `content`. The Strands chat adapter reads only `content`, so reasoning never leaks into the parsed answer. |
| `--reasoning-effort` | low | Server default. Checked with `/apply-template`: the rendered prompt says `Reasoning: low`; a request can override it with `chat_template_kwargs.reasoning_effort` (checked: `Reasoning: high`) or top level `reasoning_effort` (checked: `Reasoning: medium`). The clients send `low` explicitly. |
| `--load-mode` | none | Reads the GGUF into private memory: peak RSS 12.2 GiB instead of 21.4 GiB with mmap, at the same speed; start takes about 17 s instead of about 9 s. |
| `--cache-ram` | 2048 | Caps the host prompt cache at 2 GiB (default 8 GiB) on a shared VM. |
| `--cors-origins` | localhost | Already bound to loopback; this also stops a page on another origin from calling it (checked: foreign `Origin` gets no allow header, `http://localhost:5173` is reflected). |
| `--api-key-file` | only with `LLM_API_KEY` | Optional hardening, see above. |
| `--metrics --no-webui` | | Prometheus metrics on, bundled web UI off. |

JSON mode: both clients send `response_format: {type: 'json_schema', json_schema: {strict: true, schema}}`
and llama-server compiles the schema into a grammar, so the final answer can only be that JSON.
`health-llm.sh --deep` exercises exactly this path.

## API for the bench (`src/`)

```ts
// config.ts
interface LlmEndpoint { baseUrl: string; model: string; apiKey: string }
interface GenerationOptions { temperature: number; maxTokens: number; seed: number;
  reasoningEffort: 'low' | 'medium' | 'high'; timeoutMs: number; cachePrompt: boolean }
DEFAULT_ENDPOINT   // http://127.0.0.1:8771/v1, model 'gpt-oss-20b'
DEFAULT_GENERATION // temperature 0, maxTokens 1024 (reasoning included), seed 42, low, 180 s, cachePrompt false
endpointFromEnv(env): LlmEndpoint; serverRoot(endpoint): string

// verdict.ts
LLM_CAUSE_IDS      // [...DIAGNOSIS_CAUSE_IDS from @fixwright/protocol, 'unknown']; type LlmCauseId
interface LlmVerdict { cause_id: string; confidence: number; explanation: string }
verdictSchema(causeIds?)      // zod, strict, cause_id is an enum
verdictJsonSchema(causeIds?)  // JSON Schema for response_format
parseVerdict(text, causeIds?): { ok: true; verdict } | { ok: false; error }   // never throws
validateVerdict(value, causeIds?); isConfirmed(v) // confidence >= 0.9 (CONFIRMED_THRESHOLD)

// prompt.ts
interface DiagnosisInput { symptom: string; log: string; humanAnswers?: { question: string; answer: string }[] }  // humanAnswers = B2
systemPrompt(); userPrompt(input); diagnosisMessages(input)

// strands-client.ts
type StrandsJsonMode = 'json_schema' | 'structured_output'
createLocalModel(endpoint, gen, mode, opts?): OpenAIModel
strandsVerdict(endpoint, input, gen, mode, opts?): Promise<VerdictCall>   // fresh Agent per call, never throws
failureFromError(err, wallMs): VerdictCall   // maps Strands and OpenAI SDK errors onto FailureKind

// fetch-client.ts
buildChatRequest(endpoint, messages, gen, causeIds?); fetchVerdict(endpoint, messages, gen, opts?): Promise<VerdictCall>
type VerdictCall = { ok: true; verdict; text; reasoning; stats }
                 | { ok: false; kind: FailureKind; error; text; reasoning; stats }
type FailureKind = 'max_tokens' | 'invalid_output' | 'server_error' | 'request_failed'
MAX_TOKENS_ERROR   // 'hit max_tokens before the answer finished', the same text from both clients
// stats: { wallMs, promptTokens, completionTokens, timings (llama-server per-request timings, fetch only) }

// estimate.ts
estimateCallMs(shape, throughput); estimateRun(calls, shape, throughput); median(values)

// proc.ts (Linux, for the measurement scripts)
pidFileFor(endpoint, runDir?); readServerPid(file); memoryOf(pid); ggmlLibrariesOf(pid); cpuBackend(libs)
```

Failure kinds mean the same thing for both clients, so the bench never matches error strings.
`max_tokens` (the model spent its whole budget, reasoning included, before the answer ended) and
`invalid_output` (the model finished but the answer is not a valid verdict) are the model's doing and
count against a baseline. `server_error` (HTTP error, unusable body, prompt longer than the context) and
`request_failed` (no answer: connection refused, timeout) are infrastructure: fix and rerun the call.
Strands does not return a result when the token cap is hit; it throws `MaxTokensError`, which
`strandsVerdict` turns into `max_tokens` with the partial text and the token usage, like the fetch client.

`LLM_CAUSE_IDS` is derived from the protocol list, never copied. A test checks that it equals the
protocol's `DIAGNOSIS_CAUSE_IDS` plus `'unknown'` and covers every homefault ground truth cause, and
the prompt's hint table is typed by it, so a cause added to the protocol fails the typecheck until it
gets a hint. The system prompt text is byte-identical to the one used for the measured runs.

How Strands reaches llama.cpp (read from the SDK's own types in
`node_modules/@strands-agents/sdk/dist/src/models/openai/types.d.ts`): the provider is
`OpenAIModel` from `@strands-agents/sdk/models/openai`. It defaults to the OpenAI Responses API, but
llama-server serves Chat Completions, so `api: 'chat'` is required. `clientConfig.baseURL` points the
bundled OpenAI client at `http://127.0.0.1:8771/v1`; llama.cpp-specific fields (`seed`, `cache_prompt`,
`chat_template_kwargs`, `response_format`) ride in `params`, which the provider spreads into the
request body. `retryStrategy: null` so a failed call is reported, not silently retried.

The two Strands modes:
- `json_schema`: `response_format` in `params`; the agent's text is parsed with `parseVerdict`.
  Grammar-enforced. In every run so far it returned exactly the same text as the fetch client for the
  same prompt and settings (Strands streams, fetch does not; the prompt tokens are the same). That is
  an observation from these runs, not a guarantee.
- `structured_output`: Strands' own `structuredOutputSchema` (a zod schema). Strands registers a
  `strands_structured_output` tool and the model answers by calling it. llama-server's gpt-oss tool
  calling handled it in every run here. Its prompt is longer (973 tokens against 785) because of the
  tool definition, so it can answer differently from `json_schema`; pick one mode for B1 and B2.

## Reproducible answers: what the bench must keep

Greedy decoding is not enough on its own. llama.cpp sums floating point numbers in an order that
depends on how the prompt is split into batches, and a different sum can flip a greedy choice.
Two things change that split: reusing a cached prompt prefix (`cache_prompt`), and batching two
requests together (two slots, concurrent calls). Both changed answers here.

`results/repro_check.json` (one slot): B1 is the smoke case with the log only, B2 the same log plus
"I'll flash the hallway lamp twice. Did it blink?" "Yes, it blinked." The calls ran in this order.

| Setting | B1 first | B2 | B1 again | B1 through Strands |
| --- | --- | --- | --- | --- |
| `cache_prompt` off (default) | stale_duplicate 0.80, 134 tokens | name_collision 0.92 | stale_duplicate 0.80, same text | stale_duplicate 0.80, same text |
| `cache_prompt` on | name_collision 0.92 (reused 784 of 785 prompt tokens) | name_collision 0.92 | stale_duplicate 0.80 (reused 782) | name_collision 0.92 |

With caching off, B1 gave the identical text every time (same sha256 and token count), before and
after B2 and through Strands. The whole table was run twice, on two freshly started servers under
different load, and all 8 answers matched between the two runs, text for text (the saved file is the
second run). With caching on, the same B1 request answered `name_collision` 0.92,
which is wrong and above the 0.9 "confirmed" line (a false_confirmed in HomeTruth terms), or the right
`stale_duplicate` 0.80, depending only on what the slot held before. The cold diagnosis calls in
`results/llm_measure.json` also gave `stale_duplicate` 3 times out of 3.

`results/repro_check_parallel2.json` (two slots, `LLM_PARALLEL=2`): the sequential, cache off calls
matched the one-slot answers exactly, but B1 sent at the same time as B2 answered `name_collision`
0.92 (128 tokens) instead of `stale_duplicate` 0.80, and B2 moved from 0.92 to 0.95. The script
correctly reported FAIL there.

So the bench keeps `cachePrompt: false` (the default), one slot (the default), and one call at a time.
`node bench/llm/repro_check.ts` checks a server in about 3 minutes.

What caching off costs: two different scenarios share only the first 359 rendered prompt tokens
(system prompt and template header; B1 and B2 of the same scenario share 782). At that run's
68.8 tok/s prompt speed, that is at most 5,218 ms per call, about 26 min over 300 calls. The 300-call
estimates below already assume cold prompts, so they need no change.

## Measured results (15 Oct 2026, this VM)

The VM has 16 vCPUs on a shared AMD Ryzen 9 5950X host and 48 GB RAM; other builds were
running at the same time, so speeds moved by up to about 15% between runs. Every number below is
copied from a file in `results/`.

**Strands smoke** (`results/strands_smoke.json`, default settings, so `cache_prompt` off, temperature 0,
2 runs): PASS, 4 of 4 required calls parsed (Strands `json_schema` and fetch), and the extra
`structured_output` mode parsed 2 of 2. Every call answered the expected `stale_duplicate`, and each
client gave the same answer both times.

| Client | Parsed | cause_id given | Mean wall time |
| --- | --- | --- | --- |
| strands:json_schema | 2/2 | stale_duplicate, 0.80 (134 output tokens) | 28,034 ms |
| strands:structured_output | 2/2 | stale_duplicate, 0.85 (135 output tokens) | 31,626 ms |
| fetch:json_schema | 2/2 | stale_duplicate, 0.80 (same text as Strands json_schema) | 29,477 ms |

It ran on a busy VM (other builds were running) and every call paid for its whole prompt, which is
why each call took about 28 to 31 s here. This is one hand-written case, so it says nothing about accuracy. The
earlier smoke with `cache_prompt` on (`results/strands_smoke_cacheprompt_on.json`) answered
`name_collision` 0.95 for both JSON schema clients, the flip explained above.

**Speed and memory, default config** (`results/llm_measure.json`; exact 1,500-token prompt,
300 forced tokens, no prompt cache, 3 runs, medians):

| Metric | Value |
| --- | --- |
| Prompt processing | **64.3 tok/s** (runs: 62.4, 71.5, 64.3) |
| Generation | **10.5 tok/s** (runs: 10.0, 10.6, 10.5) |
| One 1,500 in / 300 out call | 51,825 ms median wall time |
| Peak RSS (VmHWM) of llama-server | **12,225.8 MiB**, all anonymous (file-backed 15.8 MiB) |
| Cold diagnosis call, small log (785 prompt tokens, 134 output tokens incl. reasoning) | 25,337 ms median (21,710; 25,337; 25,851) |
| Startup to healthy | 16 to 18 s (start-llm.sh output) |

**Same server with mmap** (`--load-mode auto`): `results/llm_measure_mmap.json` gave 57.1 / 9.8 tok/s
and peak RSS 21,908.4 MiB (10,356 MiB anonymous plus 11,552.3 MiB mapped file pages);
`results/llm_measure_mmap_run2.json` gave 63.7 / 10.7 tok/s; with `--threads-batch 8`,
`results/llm_measure_mmap_tb8.json` gave 61.9 / 10.8 tok/s. Startup to healthy was 8 to 9 s.

**Raw kernel speed** (llama-bench, no HTTP and no sampling, `results/llama_bench_threads.json`,
2 repetitions each, tok/s):

| Threads | Flash attn | Prompt 1,500 | Generate 300 |
| --- | --- | --- | --- |
| 6 | on | 60.7 | 12.3 |
| 8 | on | 74.7 / 75.5 (two sweeps) | 12.6 / 12.1 |
| 10 | on | 82.4 | 12.4 |
| 12 | on | 65.3 (stddev 13.8) | 12.1 |
| 16 | on | 70.1 | **7.2** |
| 8 | off | 61.3 | 11.9 |
| 12 | off | 59.8 | 11.9 |
| 16 | off | 61.2 | 6.4 |

Generation is memory bound and flat from 6 to 12 threads. Using all 16 vCPUs roughly halved it,
most likely because the vCPUs are shared with other work and every straggler stalls the thread
barrier. The server path is slower than llama-bench's raw numbers; plan with the server numbers.

**Two parallel slots** (`LLM_PARALLEL=2`, 16k context per slot, two 1,500 / 300 requests at once):

| Run | Rounds of two calls | Median round | Per slot (median) | Peak RSS |
| --- | --- | --- | --- | --- |
| `load-mode none`, `results/llm_measure_parallel2.json` (load average 9.7 to 18.4) | 89,801; 83,596; 100,006 ms | 89,801 ms | 30.7 tok/s prompt, 7.6 tok/s generation | 12,640.7 MiB |
| mmap, `results/llm_measure_mmap_parallel2.json` | 91,656; 81,231 ms | 86,443.5 ms | 30.2 tok/s prompt, 8.2 tok/s generation | (mmap) |

Two slots finish two calls in less time than two single-slot calls, but batched calls changed answers
(see above), so they are not usable for B1 and B2.

## Wall time for 300 benchmark calls

| Call shape | Basis | 300 calls |
| --- | --- | --- |
| 1,500 tokens in, 300 out, one slot | server timings, `llm_measure.json` | **259.6 min** (51.9 s per call) |
| same | measured round wall time, `llm_measure.json` | 259.1 min |
| same, across all single-slot runs | `llm_measure*.json` | 258.0 to 289.7 min |
| same, two slots (not reproducible, see above) | `llm_measure_parallel2.json` / `llm_measure_mmap_parallel2.json` | 224.5 / 216.1 min |
| small smoke log, cold (785 in, 134 out) | `llm_measure.json` | 126.7 min |

Every row assumes cold prompts, which is what `cachePrompt: false` gives. So a reproducible 300-call
baseline run with 1,500-token logs takes about 4.3 hours on this VM, and about 2.1 hours with logs
the size of the smoke case. Shorter logs cut it roughly in proportion: prompt processing is about
15.6 ms per token and generation about 95 ms per token here. Run the bench unattended.

## Known limits

- CPU only, on a shared VM: expect run to run spread in speed (single-slot prompt speed ranged 48.9
  to 74.6 tok/s across the saved runs). The JSON files record each run. Load changed speed but not
  answers: the cache off B1 answer was the same in every saved run (identical text in
  `results/repro_check*.json`, same cause and 134 output tokens in `results/llm_measure.json`), with
  1-minute load averages between 6.2 and 21.5.
- Answers are reproducible only with `cache_prompt` off, one slot and one call at a time (measured
  above). Other settings, another llama.cpp build, another thread count or another CPU backend may
  change batch splits and therefore answers; rerun `repro_check.ts` after changing any of them.
- `maxTokens` (1,024) includes gpt-oss's reasoning tokens. A call that hits the cap fails with kind
  `max_tokens` and the text `hit max_tokens before the answer finished`, from both clients (tested
  offline for both Strands modes and fetch, and live with a cap of 16), never half-parsed.
- `/v1/chat/completions` only; the Strands default Responses API is not used.
- Without `LLM_API_KEY` the server accepts any local caller. It is bound to 127.0.0.1 and refuses
  cross-origin browser calls, but llama-server does not check the Host header (checked: a request
  with `Host: rebind.example:8771` got HTTP 200), so a web page using DNS rebinding could still reach
  it while it runs. Start it with `LLM_API_KEY` set to close that.
