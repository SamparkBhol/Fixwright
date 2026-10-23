# bench/llm verification checklist

## Offline tests: 45 pass (`npm run check` in bench, or `npx vitest run llm/test` in bench)

`test/typecheck.test.ts`
- [x] `tsc -p bench/llm/tsconfig.json` exits 0, and the program really contains this folder's sources
      (guards against checking the wrong project). bench's own `tsc` step does not cover bench/llm,
      so this keeps the folder typechecked as well as tested.

`test/verdict.test.ts`
- [x] `LLM_CAUSE_IDS` equals `@fixwright/protocol`'s `DIAGNOSIS_CAUSE_IDS` plus `'unknown'`, in order;
      it covers every homefault ground truth cause; the system prompt lists every allowed cause.
- [x] A bare JSON verdict parses; a fenced json block with prose around it parses.
- [x] Braces and escaped quotes inside strings do not confuse the JSON extractor.
- [x] No JSON, unbalanced JSON and single-quoted pseudo JSON are rejected with a reason, never thrown.
- [x] confidence outside 0..1, a cause id outside the library, missing fields and extra fields are rejected.
- [x] A custom cause list is honoured.
- [x] The JSON Schema sent as `response_format` is strict, lists all three required fields, carries the
      cause enum and the 0..1 bounds, and has no `$schema` key.
- [x] "Confirmed" uses the 0.9 threshold: 0.9 counts, 0.89 does not.

`test/estimate.test.ts`
- [x] Call time = prompt tokens / pp + output tokens / tg + overhead; run time scales with calls.
- [x] Non-positive throughput, fractional call counts and empty medians throw RangeError.

`test/clients.test.ts` (a fake fetch plays llama-server, so the real Strands SDK and OpenAI client code run)
- [x] Endpoint defaults to 127.0.0.1:8771/v1 and model `gpt-oss-20b`; env overrides work.
- [x] The fetch client sends temperature 0, seed 42, `cache_prompt: false`, reasoning effort low and a strict json_schema.
- [x] The fetch client parses a llama-server response and keeps usage, timings and reasoning apart.
- [x] Fetch failures are typed: HTTP error and a body without choices are `server_error`, `finish_reason: length`
      is `max_tokens` (with partial text and token usage), a schema failure is `invalid_output`, a network
      error is `request_failed`. None of them throws.
- [x] The Strands provider is `api: 'chat'` with the right model id, sampling and llama.cpp params;
      `structured_output` mode sends no `response_format`.
- [x] Strands `json_schema` mode: a streamed SSE answer goes through the Agent and parses; the request
      reaches `/v1/chat/completions` with stream true, `max_completion_tokens`, seed, `cache_prompt: false` and the schema.
- [x] Strands `structured_output` mode: the forced `strands_structured_output` tool call validates.
- [x] Strands truncation, both modes: an SSE stream ending in `finish_reason: length` (Strands throws
      `MaxTokensError`) becomes `max_tokens` with the same error text as fetch, the partial text and the token usage.
- [x] Strands `json_schema` answer that fails the schema is `invalid_output`.
- [x] Strands HTTP 500 is `server_error` with exactly the fetch client's wording (`HTTP 500: boom`);
      a dead server is `request_failed`.

`test/proc.test.ts`
- [x] The ggml libraries mapped into a process are read from `/proc/<pid>/maps` text, and the CPU
      backend variant (`haswell`) is named; no backend gives null.
- [x] Peak and current RSS are parsed from `/proc/<pid>/status` in MiB.
- [x] The pid file is per port under the workspace run dir; a missing or broken pid file is explained.

`test/scripts.test.ts` (the real start and stop scripts against a fake `llama-server`, a copy of bash, on ports 8778 and 8779)
- [x] `llm-config.sh` derives one pid file and one log per port, and the same pid file the TypeScript side reads.
- [x] A failed start on another port leaves the running server's pid file and process alone (the old
      orphan bug). Proven to catch it: with the old shared pid file name, 3 of these 4 tests fail.
- [x] `stop-llm.sh` on a port with no pid file is a no-op; on the right port it ends the server with
      SIGTERM (no SIGKILL needed) and removes the pid file.
- [x] `stop-llm.sh` never signals a pid that is not our server (it was given the test runner's own pid).

## Live checks (real gpt-oss-20b, server on 127.0.0.1:8771)

- [x] `test/live.test.ts` with `FIXWRIGHT_LLM_LIVE=1`: 3 pass. Strands `json_schema` and fetch return a
      valid verdict; with a 16-token cap both report `max_tokens` with the same text and 16 completion tokens.
      Also passed with `LLM_API_KEY` set on a keyed server.
- [x] `repro_check.ts` (`results/repro_check.json`): PASS. With the default `cache_prompt: false`, B1
      gave identical text before and after B2 and through Strands; with caching on the same request
      flipped between `name_collision` 0.92 and `stale_duplicate` 0.80. Run twice on fresh servers:
      all 8 answers identical between the runs.
- [x] `repro_check.ts` on two slots (`results/repro_check_parallel2.json`): sequential answers match the
      one-slot ones, but batching B1 with B2 changed both answers; the script reported FAIL as designed.
- [x] `strands_smoke.ts --runs 2`: PASS, all 6 calls parsed, every client gave the same answer both runs
      (`results/strands_smoke.json`).
- [x] `health-llm.sh --deep`: schema-constrained JSON round trip works.
- [x] `measure_llm.ts`: exact 1,500 prompt tokens and 300 generated tokens per run are asserted from
      the server's own timings before any number is kept (`results/llm_measure*.json`); the two-slot run
      with `load-mode none` also records the CPU backend and ran with an API key.
- [x] The running server maps `libggml-cpu-haswell.so` (`server.cpu_backend` in `results/repro_check.json`).
- [x] API key: key file mode 600 and absent from the process command line; no key or a wrong key get
      401 (health says why), `/health` stays open, both clients report `server_error` (HTTP 401).
- [x] llama-server does not check the Host header (`Host: rebind.example:8771` got HTTP 200), which is
      why the README recommends `LLM_API_KEY` against DNS rebinding.

## Checked by hand during the build

- [x] llama.cpp archive sha256 matches the GitHub asset digest; the GGUF size and sha256 match the
      Hugging Face LFS metadata at the pinned revision (`fetch-llm.sh` repeats both checks).
- [x] The prebuilt runs on this Debian 12 VM (glibc 2.36, binaries need at most 2.34).
- [x] `--reasoning-effort low` is in force: `/apply-template` renders `Reasoning: low`, and per-request
      overrides render `Reasoning: high` / `Reasoning: medium`.
- [x] `max_completion_tokens` (what Strands sends) is honoured.
- [x] CORS: a foreign Origin gets no allow header; a localhost Origin is reflected.
- [x] The prompt and schema refactor (cause list derived from the protocol) left the system prompt,
      the messages and the JSON schema byte-identical (sha256 compared before and after).
- [x] `start-llm.sh` is idempotent; after the last stop no llama-server process was left, nothing listened
      on 8770 to 8779, and the run dir held only logs (no pid or key file).
- [x] Every command run for this folder wrote only inside `$LLM_WORKSPACE_ROOT` (big files in `.cache/llm`,
      scratch files in the workspace `.tmp`, removed after use).
