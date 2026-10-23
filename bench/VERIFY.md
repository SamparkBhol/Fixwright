# bench verification checklist

`npm run check` in `bench/` runs `tsc -p tsconfig.json` (src, test) and every vitest file, including
the bench/llm tests (their own checklist is `llm/VERIFY.md`). The runner tests below need no model:
the LLM is mocked. Live numbers come only from the smoke runs listed at the end.

## test/stats.test.ts (Wilson math and friends)
- [x] Wilson end points equal the closed forms: k = 0 gives [0, z²/(n+z²)], k = n gives [n/(n+z²), 1],
      for n = 1, 6, 10, 200, 720; n = 10 gives the textbook 0.2775 and 0.7225.
- [x] Interior intervals equal (k + z²/2)/(n + z²) plus or minus the Wilson half width (5 of 10 is
      [0.2366, 0.7634]), contain k/n, mirror for n - k, and narrow as n grows.
- [x] n = 0 gives no interval; k > n, negative or fractional counts throw.
- [x] Nearest rank percentile (same definition as homefault), mean, interval overlap.
- [x] Exact McNemar: 0 vs 5 is 0.0625, 1 vs 9 is 22/1024, symmetric, finite for 1,000 pairs.

## test/sample.test.ts (stratified determinism)
- [x] Set sizes: dev 500, heldout 200, incidents 20, all 720 with unique ids.
- [x] Same set, n and seed give the same ids, kept in the set's own order; reversing the input does
      not change the pick; another seed gives another sample.
- [x] Stratified counts differ by at most one per cause (n = 10, 25, 37); n = 6 covers 6 causes;
      on the unbalanced incidents set 10 picks cover all 10 causes once.
- [x] Simple random sampling is seeded; no n returns everything; n = 0 or 2.5 throws.

## test/agents.test.ts (agent adapters on small scenarios, mocked LLM)
- [x] Fixwright on all 20 incidents through homefault's runBench: every question it asks is a
      homefault question kind, no unmapped question, exception or turn limit; the runner's human
      question count equals the observation exchanges; probes and disruptive probes match the record.
- [x] On a stale duplicate incident the flash question reaches the person with its text and device
      id; "yes" gives stale_duplicate, "no" never gives a confirmed stale_duplicate.
- [x] A "why did every light turn on" question is routed to explain_event, as the live product
      routes it: detector power_restore is scored as cause power_on_default_on, with no probes and no
      questions; `routing: 'diagnose'` forces the diagnose loop. Same input, same record.
- [x] B1 sends exactly {symptom, rendered log} once through Strands, never fetch; 0.9 is confirmed,
      0.89 likely, unknown can't tell; the recorded prompt hash is the request's hash.
- [x] invalid_output and max_tokens are can't tell, counted invalid, and never retried through fetch.
- [x] Strands with no answer falls back to fetch, and the record says which client answered.
- [x] Both clients down: one whole retry after the delay, then path failed and outcome infra_error.
- [x] B2 adds Fixwright's answers to the request; B2 with no answers reuses the identical B1 call
      (path reused, same hash, same verdict, no model call).
- [x] LLM agents never ask the person; B2 without Fixwright's answers refuses to start.
- [x] The rendered log is deterministic and never contains the title, source URL or ground truth.

## test/killswitch.test.ts
- [x] Metrics: top1, false confirmations, abstention, confirmed precision (abstentions excluded),
      latency p50/p95 on synthetic rows.
- [x] Not evaluated without a baseline; does not fire when false confirmations clearly differ; fires
      when a baseline cannot be told apart on both; a 6 scenario run says "Not conclusive", leaves
      `fires` null (the rule's raw answer is in `provisional_fires`); only paired scenarios are compared.

## test/cli.test.ts (CLI, checkpoint, resume)
- [x] Every flag parses; output names and paths; the recorded command reproduces the flags; bad flags,
      unsafe output names and conflicting flags fail with a plain message.
- [x] The settings check refuses an unreachable server, more than one slot, cache_prompt on and a
      temperature other than 0, before any model call.
- [x] Checkpoint fingerprints ignore key order; a line cut off by a crash is skipped; another run's
      checkpoint and a corrupted line are refused.
- [x] End to end with a fake model: result JSON and summary text are written with set sizes, model,
      generation settings, server slots, date, 95% intervals, p50/p95, invalid outputs, server counters
      and the kill switch; B2 calls the model only where Fixwright asked the person something.
- [x] Resume: a run that crashes after 4 B1 cases leaves a checkpoint and no result; without --resume
      it refuses to overwrite; with other settings it refuses to mix; with --resume only the 2 missing
      B1 cases reach the model, and the cases and metrics equal an uninterrupted run's; the checkpoint
      is deleted after the result is written.
- [x] Cases with no answer from the server: the result is written, the checkpoint is kept, and a
      `--resume` sends only those cases to the model, then deletes the checkpoint.
- [x] Fixwright alone needs no server and writes no checkpoint.

## test/hometruth.test.ts (results/HOMETRUTH.txt writer)
- [x] Built from in memory reports of real CLI runs (fake model): top1 lines equal computeMetrics on
      the case rows for Fixwright and B1; the combined block pairs both baseline runs; the server's
      thread flags, cache_prompt and the person's noise are read from the reports, not typed in.
- [x] A 10 scenario deciding set says "not conclusive"; every required section is present; no en or
      em dash and none of the banned words.
- [x] Engine drift: identical start and final runs give 0 changed answers; one altered case gives 1.
- [x] A B1 row with `infra_error` on the deciding set turns the verdict into "WITHHELD" with the count,
      replaces the verdict note, and adds an "Unanswered calls" caveat; with none, the caveat says every
      call got an answer.
- [x] Caveat numbers (generated scenario count, cause count, incident count, the 30 scenario threshold)
      are derived from the reports and `MIN_CONCLUSIVE_N`; the old garbled kill switch sentence is gone.

## scripts/hometruth-full.sh
- [x] `bash -n` passes. On a restart the start Fixwright runs are skipped once all five
      `hometruth-start-fixwright-*.json` files exist, and complete baseline results are skipped.

## Smoke runs (live, see README "Measured")
- [x] Fixwright on dev, heldout, incidents and all.
- [x] B1 and B2 on 6 stratified held-out scenarios against the local gpt-oss-20b server (one slot,
      cache_prompt off, temperature 0, seed 42), started and stopped with bench/llm scripts.
