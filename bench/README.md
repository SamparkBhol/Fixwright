# @fixwright/bench: HomeTruth

HomeTruth scores how well an agent finds the real fault in a broken smart home, and how often it says
"confirmed" when it is wrong. It runs three agents on the same homefault scenarios:

| Agent | What it is |
| --- | --- |
| `fixwright` | The product's own path on `scenarioHome(view)`: the assistant router (`@fixwright/router`) picks the tool as the live product does (explain_event for "why did every light turn on at 3 a.m.?", the diagnose loop for everything else), then `@fixwright/engine` runs it. The diagnose loop is `startDiagnosis`, then `answerDiagnosis` for every question it asks. Its human probes (`confirm_flash`, `power_switch_check`, `router_changed`) map one to one onto homefault's question kinds and the simulated person answers them. Permission questions (a flash during quiet hours) are granted. |
| `b1` | LLM only: the raw logs rendered as text (`src/render.ts`) and the symptom, one call per scenario. |
| `b2` | LLM only: the same as B1 plus the answers the person gave Fixwright in that scenario, with the questions as Fixwright asked them. The only difference from Fixwright is who reasons over the evidence. |

The LLM is gpt-oss-20b on llama.cpp, served locally by `llm/start-llm.sh` (see `llm/README.md`), and
called through the Strands Agents TypeScript SDK (`strandsVerdict`, OpenAI compatible chat provider,
JSON schema mode). The plain fetch client runs only when the Strands call gets no answer from the
server, and every case records which client answered.

## Run it

```sh
cd bench
node src/run.ts --set all                                   # Fixwright on all 720 scenarios, about 2 s
llm/start-llm.sh                                            # B1 and B2 need the local model
node src/run.ts --agents fixwright,b1,b2 --set heldout --n 6 --stratified --seed 1 --out smoke-heldout-b1b2-n6
llm/stop-llm.sh                                             # always stop it when done
```

The full run (hours) is one unattended script. It starts the model with 8 threads, runs Fixwright on
every set, then B1 and B2 on all 20 incidents and on a stratified held-out sample of 100 (10 per cause,
seed 1), restarts the model and resumes from the checkpoint if anything crashes, runs Fixwright on every
set again at the end (the engine may change meanwhile), writes `results/HOMETRUTH.txt` and stops the
model, also on a crash or a kill:

```sh
mkdir -p ../.tmp && setsid scripts/hometruth-full.sh >> ../.tmp/bench_run.log 2>&1 < /dev/null &
node src/hometruth.ts        # rewrite results/HOMETRUTH.txt from the result files alone
```

A baseline result that already exists without a checkpoint is not run again, and the start Fixwright
runs are kept once all five exist (they are the before-baselines snapshot the engine drift check
compares against), so restarting the script continues where it stopped. Only the final Fixwright runs
and HOMETRUTH.txt are always redone.

| Flag | Meaning |
| --- | --- |
| `--agents fixwright,b1,b2` | Which agents (default `fixwright`). Fixwright always runs next to a baseline: it is the kill switch reference, and B2 reads its answers. |
| `--set dev\|heldout\|incidents\|all` | dev = generator seeds 1 to 500, heldout = 10001 to 10200, incidents = the 20 reconstructed reports (default heldout). |
| `--n N`, `--stratified`, `--seed S` | Run a seeded sample of N; stratified spreads it over the ground truth causes (counts differ by at most one). Same set, N and seed: same ids. |
| `--ids a,b,c` | Exactly these scenarios. |
| `--human-reliability R`, `--human-seed S` | The simulated person answers truthfully with probability R (default 0.9); seeded per scenario, so answers never depend on run order or sample. |
| `--fixwright-routing router\|diagnose` | `router` (default) is the live product's path; `diagnose` forces the diagnose loop for every symptom. |
| `--mode json_schema\|structured_output` | Strands JSON mode (default json_schema). |
| `--no-reuse` | Call the model even when a B2 request is byte for byte the B1 request (no answers from the person). |
| `--out NAME` | Writes `results/NAME.json` and `results/NAME.summary.txt` (or pass a path ending in `.json`). |
| `--resume`, `--fresh` | Continue an interrupted run from its checkpoint, or discard the checkpoint. |

Model server: `LLM_BASE_URL` (or `LLM_HOST`, `LLM_PORT`, default 127.0.0.1:8771), `LLM_MODEL`, `LLM_API_KEY`.

## Scoring

Scoring is homefault's `runBench`, the same for every agent: correct means the right cause and not
abstaining; `cant_tell` and any error are abstentions; false_confirmed means "confirmed" and wrong.
An LLM answer is confirmed when its confidence is at least 0.9, likely below, can't tell when it says
`unknown`. An answer that is not a valid verdict (schema failure, or the token cap hit before the JSON
ended) is can't tell and counted separately as an invalid output. A call with no answer from the
server after the fetch fallback and one whole retry is an infrastructure failure, reported apart and
rerun on `--resume`.

Metrics per agent, overall and per subset and cause: top1, top1 when answering, false_confirmed count
and rate, abstention, confirmed precision, invalid outputs, probes, disruptive probes, questions to the
person (with the permission questions among them), latency p50 and p95. Every rate carries a 95%
Wilson score interval (`src/stats.ts`), which stays inside 0 to 1 and is sensible at 0 of n.

explain_event names what happened (its detectors), not a cause from the library. A power restore that
switched devices on is scored as `power_on_default_on`, the fault whose fix explain_event suggests for it.
"An automation did it" and "someone used the app" name no fault and are scored as given.

## Reproducible answers

bench/llm measured that greedy decoding alone is not enough: prompt caching and batching two requests
both changed answers (`llm/results/repro_check.json`, `repro_check_parallel2.json`). So every run uses
temperature 0, seed 42, `cache_prompt` off, one slot and one call at a time. The CLI reads the server's
`/props` before the first call and refuses to start if it has more than one slot, or if caching is on
or the temperature is not 0. Each result file records the full generation settings, the Strands and
openai SDK versions, llama.cpp's build, model file, context, slots, command line and CPU backend, and
the server's own counters over each baseline (prompt and generation speed, and the cached prompt tokens,
which must stay 0).

## Files a run writes

- `results/<name>.json`: format `hometruth.results/1`; every case (verdict, probes, questions and
  answers, the LLM's exact text, prompt sha256, tokens, client path, attempts), the configuration, the
  settings above, metrics with intervals, timings and the kill switch evaluation.
- `results/<name>.summary.txt`: plain text: sample sizes, model and settings, date, machine, results,
  kill switch and the timings needed to size a longer run.
- `results/<name>.partial.jsonl` while baselines run: one line per scored case. A crashed run continues
  with `--resume`; a row is reused only if the request it answered is byte for byte the request this
  run would send (same rendered log, same answers, same settings). The file is deleted once the result
  is written, unless some cases got no answer from the server: then it stays, and `--resume` retries
  only those. Without `--resume` the CLI refuses to start over a checkpoint, so work is never lost.
- `results/HOMETRUTH.txt` (from `node src/hometruth.ts`): the full run in plain text, computed from the
  `hometruth-*` result files only: sample sizes, model and settings, metrics with intervals for
  Fixwright, B1 and B2, the kill switch verdict, whether the engine changed during the run, caveats and
  what the numbers do not show.

## Kill switch

"If B1 or B2 matches Fixwright on false_confirmed and top1, the headline moves to the human-as-sensor and
verified-repair loop." A baseline matches on a metric when its 95% Wilson interval overlaps Fixwright's
on the same scenarios, or it is at least as good. Overlap is the lenient reading: the switch fires
whenever the data cannot tell the two apart. Below 30 paired scenarios the summary says the evaluation
is not conclusive and the JSON's `fires` is null (the rule's raw answer is kept as `provisional_fires`).
An exact McNemar test on the paired cases is reported next to it.

For the full run the deciding set is the stratified held-out sample of 100 (10 per cause, seed 1). That
choice was written into `src/hometruth.ts` at 13:13 UTC on 17 Oct 2026, three minutes after the run
started and before any held-out baseline answer existed (the held-out baseline run began at 13:22).
The incidents and the two sets together are shown next to it, not used for the verdict. If any B1 or
B2 call on the deciding set got no answer from the server after every retry, HOMETRUTH.txt withholds the
verdict instead of scoring those calls as abstentions, and says so in its caveats.

## Measured (17 Oct 2026, this VM: AMD Ryzen 9 5950X, 16 vCPUs, 48 GB, Node 22.22.1)

**Full run.** It finished on 17 October 2026, and `results/HOMETRUTH.txt` has every number with its
95% interval. On the deciding held out sample of 100: Fixwright 78 right, 3 false confirmations, 19 can't
tells; B1 71, 5 and 4; B2 83, 3 and 3. The kill switch fires (B1 and B2 each match Fixwright on top1 and
false confirmations), so the root README leads with what the run does show. The person's answers lift the
same LLM from 71 to 83: 12 scenarios turned right and none turned wrong (paired, exact McNemar p 0.0005,
from the case rows of `results/hometruth-heldout-b1b2-n100.json`). Fixwright is right on 78 of the 81
scenarios where it names a cause.

The smoke runs below came before the full run and check the pipeline end to end. Every number is copied
from `results/`.

**Fixwright on every set** (router on, human reliability 0.9, seed 1). Whole process wall time
including scenario generation: dev 2.4 s, heldout 1.3 s, incidents 0.5 s, all 3.1 s; the agent itself
took 0.86 s, 0.40 s, 0.06 s and 1.20 s.

| Set | top1 (95% CI) | false confirmed | abstention | confirmed precision |
| --- | --- | --- | --- | --- |
| dev, 500 | 0.828 (0.792 to 0.859) | 17 (0.034) | 0.138 | 0.951 |
| heldout, 200 | 0.805 (0.745 to 0.854) | 7 (0.035) | 0.160 | 0.947 |
| incidents, 20 | 0.800 (0.584 to 0.919) | 0 | 0.200 | 1.000 |
| all, 720 | 0.821 (0.791 to 0.847) | 24 (0.033, CI 0.022 to 0.049) | 0.146 | 0.951 |

On all 720: 5.87 probes per case, 0.25 disruptive, 0.63 questions to the person (7 of the 450 were
permission questions), latency p50 1.204 ms and p95 2.508 ms; 643 cases went to diagnose and 77 to
explain_event; 27 diagnoses stopped with `ambiguous_device` (counted as abstentions).

With `--fixwright-routing diagnose` on all 720 (`results/smoke-fixwright-all-diagnose-only.*`): top1
0.792 (0.760 to 0.820), 4 false confirmations (0.006), abstention 0.203.

Finding for the router and engine owners: 21 of the 24 false confirmations in the router run are
explain_event answers to "Why did the porch light at dusk not run this morning?" style questions
(ground truth dead_trigger). The router sends them to explain_event, which answers "Someone used the
app" (14) or "An automation did it" (7) at confirmed level. explain_event explains a change that
happened; it has no detector for something that did not happen. The 43 power restore questions it
answers correctly are why routing still raises top1.

**B1 and B2 on 6 stratified held-out scenarios** (`results/smoke-heldout-b1b2-n6.*`; one cause each:
stale_duplicate, dead_trigger, radio_link_weak, hub_down, wifi_network_changed, vendor_cloud_outage).
gpt-oss-20b MXFP4 on llama.cpp b11146, one slot, context 16384, temperature 0, seed 42, max tokens
1024, reasoning low, cache_prompt off, Strands json_schema mode. Started with `llm/start-llm.sh`
(healthy after 21 s) and stopped with `llm/stop-llm.sh`.

| Agent | top1 | false confirmed | abstention | invalid outputs |
| --- | --- | --- | --- | --- |
| Fixwright | 6 of 6 | 0 | 0 | |
| B1 | 3 of 6 | 2 | 0 | 0 |
| B2 | 5 of 6 | 0 | 0 | 0 |

B1 confirmed name_collision (0.95) on the stale duplicate and device_power_lost (0.9) on the Wi-Fi
change. With Fixwright's answers (the flash was heard; the speaker is plugged in; the router changed)
B2 got both right. Kill switch: not conclusive at 6 paired scenarios, as the summary says.

Timings: 13 min 54 s wall for the whole run. B1 made 6 Strands calls (no fetch fallback, no failure):
mean 102.3 s, p50 87.7 s, p95 135.3 s per call; prompts 4,438 to 8,054 tokens (mean 6,033), answers
90 to 215 tokens. B2 made 2 calls and reused 4 identical B1 requests (Fixwright asked no question
there). Server counters: prompt 69.3 tok/s (B1) and 72.7 tok/s (B2), generation 8.8 and 9.2 tok/s,
0 prompt tokens from cache. Sizing from these: a stratified 100 scenario held-out run is about 100 B1
calls plus one B2 call per scenario where Fixwright asked the person something (76 of the 200
held-out scenarios), so about 138 calls at about 100 s, roughly 3.8 h. The smoke summary was re-rendered from its JSON after a
formatting change (rounding of means, the kill switch line); no number changed.

## API (`src/index.ts`)

```ts
fixwrightAgent({ seed?, routing?: 'router' | 'diagnose', onRecord? }): BenchAgent
fixwrightScenario(view, askHuman, seed?, routing?): Promise<FixwrightRecord>   // never throws
toolFor(symptom): 'diagnose' | 'explain_event'; EXPLAIN_TO_CAUSE
llmAgent({ variant: 'b1' | 'b2', endpoint, gen, mode?, answersFor?, clients?, cache? }): BenchAgent
runBaseline(view, opts): Promise<LlmRecord>; baselineInput(view, answers?); requestKey(...)
renderScenarioLog(view): string                  // what B1 and B2 read
runAgents(opts): Promise<{ rows, agent_ms, resumed }>
computeMetrics(rows), metricsBySet(rows), evaluateKillSwitch(rows)
wilson(k, n), rate(k, n), percentile(xs, p), mcnemarExact(b, c)
loadSet(name), sampleScenarios(items, { n?, stratified?, seed })
parseCli(argv), runCli(opts, deps)               // deps inject clock, model clients, server probes
readCheckpoint(path, fingerprint), openCheckpoint(...)
buildReport(input), summaryText(report), writeReport(path, report)
```

## Tests

`npm run check` in `bench/`: typecheck plus vitest (the bench tests with a mocked model, and the
`FIXWRIGHT_LLM_LIVE=1`.

## Pinned extras

Beyond the project wide pins, this workspace pins (newest release at least 14 days old on 15 Oct 2026):

- openai 6.49.0 (2026-07-23): the Strands OpenAI-compatible model provider, used to reach a local
  llama.cpp server, needs `openai@^6.45.0`. 6.49.0 is the newest 6.x.
- @modelcontextprotocol/sdk 1.31.0 (2026-09-28): required peer of @strands-agents/sdk 1.19.0.
- @opentelemetry/api 1.9.1 (2026-03-25): required peer of @strands-agents/sdk 1.19.0.
- @fixwright/router 0.1.0 (workspace package, added 17 Oct 2026, installed offline): the bench runs
  Fixwright through the same router as the live product.

See `docs/DEPENDENCIES.md` for the full list.
