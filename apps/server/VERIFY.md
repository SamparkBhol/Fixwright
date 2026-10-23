# apps/server: what the tests prove

Run: `npm run check -w @fixwright/server` (typecheck of src with Workers types and of tests with Node types,
then vitest: unit tests and the workerd integration file). The Home Assistant run: `npm run test:ha -w
@fixwright/server`. Last full run 18 Oct 2026 06:43 UTC, inside the root `npm run check` (integration on ports 8714 to 8716
with `FIXWRIGHT_TEST_PORT=8714`): 101 passed, 1 skipped (the HA test without a hub) in `check`
(`docs/integration/CHECK.txt`). The HA run
was not repeated after the 17 Oct hardening (its hub uses port 8741, outside the ports of that run); its last run,
before the hardening, passed.

## Golden path (test/support/golden.ts, run twice)

In process on node:sqlite (`test/unit/household.test.ts`) and through `wrangler dev --local` with the MCP client
2.2.0 on 2025-11-25 (`test/integration/worker.test.ts`). Every tool result is validated against
`ToolOutputs.<tool>` and, through MCP, `content[0].text` equals `speech`.

- [x] diagnose: status needs_answer, speech exactly "Your hub is reachable, the signal is good and the Hue cloud
      is fine. I'll flash the hallway lamp twice. Did it blink?", at least two hypotheses.
- [x] diagnose_answer "Yes, it blinked.": confirmed stale_duplicate, confidence at least 0.9 (0.945 measured),
      speech contains "The lamp works. The name Hallway Lamp still points at an old copy of it that went offline
      on October 3."
- [x] repair_plan: needs_confirmation, a diff, a 43 character base64url token.
- [x] two simultaneous repair_apply with the same token: exactly one applied, the other `plan_used`.
- [x] the applied repair: every step done with a read back, "I switched it on and off, it answered both times.",
      undo available, next check at 2026-10-16T14:00:00.000Z.
- [x] token reuse later: `plan_used`; a forged token: `token_mismatch`.
- [x] `/demo/clock {to:'next_morning'}`: now 07:00 household time, pushes exactly
      ["Hallway lamp answered all 9 commands overnight. Repair confirmed."], and the ntfy mock received that body
      with Title "Repair confirmed" and Tags "white_check_mark,house" on the household's topic.
- [x] repair_status: confirmed, one passing check, speech the morning line.
- [x] explain_event "Why did every plug turn on at 3 a.m.?" with the outage window: confirmed power_restore,
      speech contains "Power came back at 3:12. Fourteen devices restarted within four seconds. None of your
      automations fired."
- [x] repair_plan from the explanation and repair_apply: applied (14 power on settings).
- [x] home_checkup: exactly three findings, "Two lights answer to Living Room Light" first, "Hall motion sensor
      battery at 6%", and the kitchen plug's 9 drops.
- [x] switch_device "living room power strip" off: refused with exactly "That strip runs the aquarium filter,
      which you marked protected. I'll turn off the lamp on it instead.", alternative and switched =
      switch.reading_lamp, read back off.
- [x] protect_device: unprotect, then protect again with its speech and the protected list.
- [x] undo of the power on repair: undone, every inverse step done; undo again refused; the confirmed lamp
      repair (its old copy removed after the check) refuses undo.
- [x] refresh_view with a repair id returns a valid repair_status output in state confirmed; with a diagnosis
      id a valid diagnose output.
- [x] `evidence/golden-path.txt` holds the spoken lines of the last workerd run.

## MCP surface (workerd)

- [x] initialize at 2025-11-25 answers 2025-11-25 with the CORS header for the allowed origin; the raw curl
      transcript is in `evidence/initialize-2025-11-25.txt`.
- [x] tools/list: the 11 protocol tools; 8 carry `_meta.ui.resourceUri` equal to TOOL_DEFS; visibility equal to
      TOOL_DEFS (refresh_view `['app']`); every output schema is an object.
- [x] resources/list and resources/read: the three `ui://fixwright/*.html` views, each an HTML document with
      `RESOURCE_MIME_TYPE`.

## HTTP edges (workerd)

- [x] GET and DELETE /mcp: 405. A 70,000 byte body: 413. Invalid JSON: 400.
- [x] CORS: preflight 204 with the allow headers and Vary for the allowed origin; a 405 error still carries the
      allow-origin header; another origin gets 403 on preflight and on a request, without allow-origin, with Vary.
- [x] A Host header that is not ours: 403.
- [x] Per IP rate limit: the demo bucket answers 429 with Retry-After of at least 1 s (and the CORS header);
      another address still gets 200.
- [x] /health `{ ok: true, version: '0.1.0', protocol: '2025-11-25', tools: 11 }`; `/` serves the host page.
- [x] /assistant/route routes the golden utterance to diagnose; junk client state is ignored; an empty
      utterance is 400.
- [x] /demo/link-ha is 404 with ALLOW_HA_LINK=0 (and 404 in process).

## Households

- [x] A created household gets a `hh_` + 32 character token and a `fixwright-` + 20 character topic; a fault
      injected there does not appear in hh_public; its own state shows it as private.
- [x] A checkup made in one household cannot be refreshed from another; it can from its own.
- [x] A token with one character changed: 401. Reset clears the injected fault.
- [x] In process: a diagnosis from one household cannot be answered in another (session_expired).

## Durable Object alarm and the due queue

- [x] workerd: after a repair, `/demo/clock` moves household time to two seconds before 07:00 and returns no
      pushes; the Durable Object's own alarm then runs the check and pushes "... Repair confirmed." to the
      household's topic; repair_status reads confirmed.
- [x] In process: alarm() before 07:00 runs nothing; two concurrent alarm() calls after 07:00 run the check once
      and push once; a third runs nothing.
- [x] alarm() twice after the golden path: nothing more is pushed.
- [x] ntfy down: the push is recorded as not delivered, retried by the next alarm a minute later, delivered, and
      the record shows 2 attempts.
- [x] An undone repair is never checked or pushed.

## Pure helpers (test/unit)

- [x] confirm token equals Node's own HMAC-SHA256 base64url of `plan_id|plan_hash|expires_at`; any changed part
      or another secret fails; constant time compare; canonical JSON ignores key order and undefined.
- [x] household tokens verify without storage; a flipped character, a guessed token or another secret fail;
      hh_public is accepted; seeds are 1 for hh_public and stable 1 to 500 otherwise.
- [x] CORS origin parsing keeps only exact origins; near misses (port, scheme, subdomain, `null`) are rejected;
      preflight header set; immutable responses get headers; Vary keeps existing values.
- [x] Host patterns: ports allowed, one label wildcard only.
- [x] Body cap: declared and streamed bodies over 64 KB refused, exactly 64 KB accepted.
- [x] Token bucket: a burst of perMinute, then 429 with the right Retry-After, refill.
- [x] Config: short secret is null (routes answer 503), bad NTFY_BASE falls back, bad numbers fall back.
- [x] CAS (node:sqlite, same SQL): a plan is consumed once; expired and unknown plans create nothing; a failure
      inside the transaction leaves the plan unused; step keys claim once; a stale epoch or a finished repair
      claims nothing; transitions are CAS on state and epoch; undo starts once with a new epoch and never from
      applying; a repair that cannot be undone refuses undo; enqueue is idempotent; one claimer wins a due item; an expired
      lease is swept with a newer epoch and the old epoch cannot finish it; a failing item closes after 3 attempts.
- [x] Failures speak: unknown session, plan, repair and view ids come back as isError with a speech line and the
      right problem code; an expired plan is refused and creates no repair.
- [x] Demo controls: faults by code, unknown fault 400, capped state (under 64 KB, simulated, five demo faults,
      the aquarium filter protected), reset keeps the topic, hh_public resets after an hour, clock jump limits.

## Home Assistant (test/integration/ha.test.ts, tag ha)

- [x] Home Assistant 2026.9.4 from adapter-ha's `ha-local.sh` on 127.0.0.1:8741, wrangler dev with
      ALLOW_HA_LINK=1 on 8704.
- [x] A real power cut on the hallway circuit brings all six devices back on.
- [x] hh_public cannot be linked (403); a created household links (200, version 2026.9.4).
- [x] explain_event over the cut: power_restore (confirmed in the last run), with a suggested fix; every output
      says `source: { adapter: 'home-assistant', simulated: false }`.
- [x] repair_plan and repair_apply: applied, six steps each done with read back; the hub reads `previous` on
      all six power on selects.
- [x] undo: the hub reads `on` again on all six.
- [x] `evidence/home-assistant.txt` holds the lines of the last run.

## Hardening, 17 Oct 2026

- [x] JSON-RPC batches pay one rate limit token per message, at most 10 messages: in process
      (`test/unit/app.test.ts`: tokens taken 1 + 9 for a 10 message batch, the next batch refused with 429
      before any tool runs, 11 and 100 messages answer 400 -32600 and run nothing) and through workerd
      (`worker.test.ts`: 11 messages 400; 10 message batches of tools/list hit 429 after 20 to 30 batches,
      where one token per request would allow 240).
- [x] Rollback on a read back mismatch: F8 (hub down) injected after repair_plan; repair_apply gives
      `rolled_back`, "Something didn't check out, so I put everything back the way it was.", no `done` step,
      no undo, no due item, repair_status `rolled_back`, undo `no_fix`, the plan stays spent.
- [x] Simulated daytime clock: `DEMO_START` "15:00" (default and in wrangler.jsonc) starts a house at 15:00
      Los Angeles time on the current local date; houses built at 03:00, 06:30 and 23:30 Los Angeles time run
      the whole golden path word for word; time runs on with real time; daylight saving handled; `/health`
      and `/demo/state` carry the `clock` label (`simulated`, `starts_at`, `tz`, `note`, state: `offset_ms`).
- [x] Demo house template: the first house for a start time builds it, later houses restore a copy with their
      own seed (snapshot equal except the seed), a restored private house runs the golden path, and through
      workerd a private house has the same clock and protected list as hh_public. CPU in `HOUSEHOLD_CPU.json`.
- [x] Recovery sweep: a repair cut off in `applying` after every step is settled `applied` by read back
      (undo and the morning check restored); one cut off before its flash check is `rolled_back` (inverses
      run and read back, nothing due, plan spent); an undo cut off in `undoing` is run again to `undone`; with
      the hub down nothing changes. Each read back is a ledger event with phase `recovery`.
- [x] `/demo/state` is capped at 64 KB of UTF-8 (a body under the cap by UTF-16 length but over it in bytes is
      trimmed; pushes are trimmed once entities are gone).
- [x] `/demo/link-ha` hardening: https only, http to loopback only while the server runs on loopback; private,
      loopback, link-local, CGNAT, metadata, multicast and reserved IPv4 and IPv6 literals refused in every
      spelling (decimal, hex, short, mapped, NAT64); internal names refused; the token stored only sealed
      (AES-256-GCM, HKDF key, household id as additional data; wrong household, wrong key and a changed
      character do not open); every Home Assistant call made with `redirect: 'manual'`; a refused token or an
      unreachable hub gets a fixed line without Home Assistant's text; a token sealed under another key asks
      the person to link again.

## Measurements (scripts, not part of check)

- [x] `scripts/cpu-bench.ts`: per request type p50/p95/max CPU for the Worker and the DO, first request costs in
      fresh processes, household build cost (`BENCH_CPU.json`).
- [x] `scripts/workerd-cpu.ts`: workerd CPU from /proc over 300 golden requests (`WORKERD_CPU.json`).
- [x] `scripts/household-cpu.ts`: new household CPU before and after the demo house template, cold and warm
      (`HOUSEHOLD_CPU.json`).
- [x] `wrangler deploy --dry-run --metafile`: bundle raw and gzip, before and after, by contributor
      (`evidence/bundle-size.txt`).

## Not covered

- Cloudflare's real CPU accounting and the Free plan's enforcement of the 10 ms limit (needs a deploy; see
  README "Measured").
- A guided follow up check firing end to end (the queue path is the same as the morning check's; the engine
  tests `evaluateGuidedCheck`).
- `/assistant/route` with a Workers AI fallback: none is wired (it is optional, never required).
