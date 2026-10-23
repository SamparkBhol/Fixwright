# @fixwright/server

The Fixwright Cloudflare Worker: the MCP server an Alexa+ host talks to, one SQLite
Durable Object per household that runs the engine against its home, the repair executor with its
invariants, the next morning check and its push, the demo routes the host simulator drives, the
deterministic `/assistant/route`, and the host simulator's static files.

Everything below that says "measured" comes from a run on this repository (dates and commands given).

## Architecture

```
 Alexa+ host / host simulator (apps/host)          ntfy.sh (push)            Home Assistant (optional)
        |  MCP 2025-11-25, Streamable HTTP               ^                          ^
        v                                                |                          | REST + WebSocket
 +---------------------------------------- Worker "fixwright" ----------------------|-------------+
 | static assets (apps/host/dist) <- any path that is a file                         |             |
 | /mcp /health /demo/* /assistant/route:                                            |             |
 |   host name check -> CORS (exact origins, Vary) -> RateLimitDO (per IP bucket)    |             |
 |   -> 64 KB body cap -> household token check (HMAC, no storage)                   |             |
 |   JSON-RPC batch: at most 10 messages, one bucket token per message               |             |
 |   /mcp: createMcpHandler(legacy 'stateless'), 11 tools + 3 ui:// views,           |             |
 |         schemas converted once at module scope (cachedJson + primeSchemas)        |             |
 |   /assistant/route: @fixwright/router (deterministic, no model)                   |             |
 +-------------------------------+---------------------------------------------------|-------------+
                                 | RPC: tool(household, name, input) / demo(household, op)
                                 v
 +------------------- HouseholdDO (one per hh_ token, getByName) -------------------+
 |  SQLite: events (ledger) sessions plans repairs step_claims protected due         |
 |          settings sim pushes                                                       |
 |  House: SimHome twin (snapshot in `sim`, virtual time = real time + offset),       |
 |         rebased from the prebuilt demo house template; or HaAdapter when linked   |
 |         (its token stored sealed with AES-GCM)                                     |
 |  @fixwright/engine: diagnose, explain, checkup, plan, executePlan, morningCheck    |
 |  Repair executor: signed single use token -> repair row (CAS) -> steps claimed     |
 |                   once each (plan_id:step, epoch) -> read back -> rollback         |
 |  One alarm: due queue (morning_check, guided_check, push_retry), CAS + epoch       |
 |  Recovery sweep on wake: a repair left applying/undoing is settled by read back    |
 +------------------------------------------------------------------------------------+
```

`src/app.ts` is the request pipeline and `src/household/household.ts` the household; neither imports a
Cloudflare module, so the unit tests and the CPU harness run the same code on node:sqlite. `src/index.ts`
and `src/household/do.ts` only wire them to Workers.

## Routes

| Route | Method | What it does |
| --- | --- | --- |
| `/mcp` | POST | MCP, `createMcpHandler(factory, { legacy: 'stateless' })`. Primary lane 2025-11-25 (also 2025-06-18, 2025-03-26 and the 2026-07-28 modern era). Household from `Authorization: Bearer hh_...`, else `hh_public`. A JSON-RPC batch (2025-03-26) holds at most 10 messages (400, code -32600, beyond) and costs one rate limit token per message. |
| `/mcp` | GET, DELETE | 405 at once (no standalone stream, no sessions). |
| `/health` | GET | `{ ok, version, protocol: '2025-11-25', tools: 11, clock }`, no rate limit. `clock` labels the demo clock: `{ simulated: true, starts_at: '15:00', tz: 'America/Los_Angeles', note }` under the default `DEMO_START`. |
| `/demo/household` | POST | `{ token, ntfy_topic }`: a new private household (a copy of the day's demo house, then its own SimHome seed 1 to 500 for everything after; its own random ntfy topic). |
| `/demo/fault` | POST | `{ fault_id }` (F1..F10 or the homefault id, or a safety net drill: S1 `next_step_fails`, S2 `overnight_relapse`) returns `{ ok, active_faults, now }`; 400 for an unknown id. Drills (`src/household/safety.ts`) are SimHome only, live beside homefault's library so HomeTruth never changes, and fire once: S1 drops the next repair's first write so its read back fails and the repair rolls back; S2 turns the repaired lamp's wall switch off from 02:00 to 02:20 on the next `next_morning` jump (the reply carries `relapse`), so the 07:00 check reports it regressed. |
| `/demo/clock` | POST | `{ to: 'next_morning' }` jumps household time to the next 07:00 and runs everything due now; `{ to: ms }` jumps forward 1 ms to 7 days. Returns `{ ok, now, pushes: [{ title, message, at, delivered }] }`. |
| `/demo/reset` | POST | Rebuilds the house (keeps the push topic, and a Home Assistant link). |
| `/demo/state` | GET | God view: now, `clock` (simulated or real, where it started, offset from real time), active faults, protected devices, repairs, due items, the last 10 pushes, ledger size, every entity with its physical truth; at most 64 KB of UTF-8 (entities trimmed first, then pushes, due items and repairs, with `truncated: true`). |
| `/demo/link-ha` | POST | Only when `ALLOW_HA_LINK=1`, never for `hh_public`: `{ base_url, token }` links the household to Home Assistant (checked with `hubStatus` first). `base_url` must be public https (no private, loopback, link-local, metadata or reserved IP literal, no internal only name); plain http to localhost only while the Worker runs on a loopback host (wrangler dev). Redirects are never followed. The token is stored sealed (AES-256-GCM, key from `HA_TOKEN_KEY` via HKDF, household id as additional data). Failures answer a fixed line, never Home Assistant's text. 404 when off. |
| `/assistant/route` | POST | `{ utterance, state? }` returns the router's `{ tool, arguments, intent }` or `{ reply, intent, state? }`. Client state is rebuilt field by field before use. |
| anything else | | Workers static assets (`apps/host/dist`). |

Every `/mcp`, `/health`, `/demo/*` and `/assistant/route` answer, errors included, carries `Vary: Origin`;
an allowed origin also gets `Access-Control-Allow-Origin` and `Expose-Headers` (mcp-session-id,
mcp-protocol-version, retry-after). OPTIONS: 204 with Allow-Methods `GET, POST, DELETE, OPTIONS`,
Allow-Headers `content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id,
mcp-method, mcp-name`, Max-Age 7200; 403 for any other origin. Errors are JSON-RPC shaped:
403 host or origin not allowed, 401 unknown household token, 405, 413 body over 64 KB, 429 with
`Retry-After`, 503 when `CONFIRM_SECRET` is missing.

The MCP SDK's `originValidationResponse` and `hostHeaderValidationResponse` take host names only; the
Worker checks exact origins (scheme and port included) and host patterns with one label wildcards
(`fixwright.*.workers.dev`) instead, which is stricter.

## Tools

All 11 from `@fixwright/protocol` `TOOL_DEFS`, input and output schemas wrapped by `cachedJson`
at module scope. The 8 view tools go through ext-apps `registerAppTool` with `_meta.ui.resourceUri`;
`refresh_view` (`visibility: ['app']`), `protect_device` and `switch_device` through `registerTool`
with `toolMeta`. `registerAppResource` serves `ui://fixwright/stepper.html`, `carousel.html` and
`repair-card.html` (wrangler Text modules from `apps/views/dist`) with `RESOURCE_MIME_TYPE`.

A result is `{ content: [{ type: 'text', text: speech }], structuredContent }`; any failure is
`isError: true` with a `ProblemOutput` (a speech line, never a thrown error).

| Tool | Server side |
| --- | --- |
| home_checkup, diagnose, diagnose_answer, explain_event | engine call; the session JSON and its latest output stored in `sessions`; a guided follow up check is put on the due queue |
| repair_plan | engine plan; `confirm_token` replaced by the signed token below; plan stored with its hash and the token's SHA-256 |
| repair_apply | the executor below |
| repair_status | from the `repairs` row (state, steps, checks, next check) |
| undo | CAS applied/confirmed/regressed to undoing (new epoch), `undoPlan` with read back, then undone |
| protect_device | resolves the device, stores it in `protected` |
| switch_device | `protectedGuard`; a refusal switches only the offered alternative, with read back |
| refresh_view | `rep_` id: the current repair_status; `pln_`, `dx_`, `exp_`, `chk_`, `iss_`: the latest stored output |

## Storage schema (HouseholdDO SQLite)

| Table | Columns | Notes |
| --- | --- | --- |
| events | seq PK, ts_ms, kind, entity_id, source, body | append only ledger; mirrored in memory and written in batches of 16 rows at the end of each operation |
| sessions | id PK, type, body, output, updated_ms | diagnoses, explanations, checkups |
| plans | plan_id PK, body, plan_hash, token_hash, expires_at, used, repair_id, output, created_ms | `used` flips 0 to 1 once |
| repairs | repair_id PK, plan_id UNIQUE, state, epoch, steps, applied, checks, undo_steps, next_check_at, repaired_at, speech, undoable, updated_ms | |
| step_claims | key PK (`plan_id:step`), repair_id, epoch, at_ms | at most once, ever |
| protected | entity_id PK, name, reason, at_ms | the demo house starts with the aquarium filter |
| due | id PK, due_ms (household time), kind, ref_id, status, epoch, attempts, lease_ms, result; UNIQUE(kind, ref_id, due_ms) | |
| settings | key PK, value (JSON) | household (seed, tz, ntfy topic, clock offset), adapter, reliability, quiet hours |
| sim | id = 1, snapshot, saved_ms | the SimHome snapshot, written after every tool that can change the house |
| pushes | id PK, at, title, message, tags, status, attempts, error, ref_id | every push, delivered or not |

## Invariants

1. **The yes is bound to the plan.** `confirm_token = base64url(HMAC-SHA256(CONFIRM_SECRET, plan_id|plan_hash|expires_at))`,
   `plan_hash` the SHA-256 of the plan's canonical JSON. `repair_apply` recomputes the hash of the stored plan,
   verifies the HMAC and the stored token hash with constant time compares, then consumes the plan and creates
   the repair row in one transaction. Two simultaneous applies with one token: exactly one applies, the other
   gets `plan_used` (tested in process and through workerd). A token for another plan, an edited plan or
   another expiry is `token_mismatch`; after 5 minutes `plan_expired`.
2. **Each step at most once.** The engine's executor asks `claim(plan_id:step)` before every step; the claim
   inserts the key only while the repair is still `applying` under the epoch that started it. Follow up ops
   after a passed morning check use `plan_id:follow_up:n` the same way.
3. **Read back and rollback.** Every step is read back by the engine; the first mismatch rolls back the done
   steps through their inverses, each read back. Undo reads back too. Tested in process: F8 (hub down)
   injected between plan and apply gives `rolled_back`, no undo, nothing due, and the plan stays spent.
   **Recovery sweep** (`src/household/recovery.ts`): a repair only sits in `applying` or `undoing` while a
   call works on it, so one found there by a fresh object was cut off (eviction, redeploy). On the object's
   first call (tool, demo route or alarm) it is settled by read back: `applied` when every step was claimed
   and reads back as planned (its morning check is scheduled), otherwise `rolled_back` (each step that may
   have run is put back through its inverse, read back; `failed` if an inverse does not read back); an undo
   is run again and read back (`undone` or `failed`). A flash check cannot be read back without acting, so a
   repair cut off there is rolled back. Every read back is a ledger event with phase `recovery`. With the hub
   down nothing is changed and the sweep runs again on the next call. Each move bumps the epoch.
4. **Repair state changes are compare and set** on (repair_id, state, epoch). A stale writer changes nothing.
   Write results are counted with `RETURNING`, because Durable Object `rowsWritten` also counts index rows
   (a one row insert into a table with a primary key reports 2; found by the workerd test, fixed).
5. **One alarm, idempotent handlers.** Due items are claimed pending to running with epoch + 1 and a 60 s lease;
   only the claiming epoch can finish one; a wake up sweeps everything overdue (and expired leases); a failed
   handler is retried in 5 minutes, at most 3 times. The morning check only runs on an `applied` repair, so an
   undone repair or a second alarm sends nothing. Tested: `alarm()` twice, and two concurrently.
6. **Push.** `POST NTFY_BASE/<topic>` with `Title` and `Tags` headers, 5 s timeout; a failure is recorded and
   retried once a minute later.
7. **Households never mix.** A household is a Durable Object named by its token; tokens are
   `hh_<20 random><12 HMAC>` so an invented token is refused (401) before any object is created.
8. **Rate limits count work, not requests.** A JSON-RPC batch on `/mcp` pays one token per message (the
   request's own token plus `n - 1` more) and holds at most 10 messages, so one request can no longer fan out
   to 100 Durable Object calls (as a batch of 100 `tools/call` once could). A refused take costs
   nothing.

## Time

SimHome households run on a simulated clock: household now = real now + `clock_offset_ms`, never behind
what the twin already lived through (its writes take 9 to 31 ms of virtual time each). `DEMO_START` sets
where a new house starts: `15:00` (default and deployed: 15:00 Los Angeles time on the current local date,
so a judge at 23:30 or 03:00 still gets the demo afternoon and its lines, never "It's late, so I'll ask
first"), any `HH:MM` the same way, an ISO instant, or `now` (real time). The house then runs with real time,
and "last night's" power cut is relative to it. `/health` and `/demo/state` carry a `clock` object that says
the clock is simulated, where it starts and (state) how far it is from real time. Tests and the scripted
demo use `2026-10-15T22:00:00.000Z` (15:00 in Los Angeles, homefault's demo day). The morning
check is due at `morningCheckAt` (the next 07:00 household time); its real alarm time is that minus the
offset. `/demo/clock` moves the offset. `hh_public` starts over after an hour of real time, and on
`/demo/reset`. A linked Home Assistant runs on real time.

Sequencing: after the jump to 07:00, "at 3 a.m." means the quiet night
that follows, so the golden path test passes the outage window (`since 2026-10-15T10:00:00.000Z`, `until
10:59:59.999Z`) to explain_event, and the checkup's kitchen plug card says "in the last day".

## Local run

From the repo root:

```
cd apps/server
cp .dev.vars.example .dev.vars                 # CONFIRM_SECRET for local dev (ignored by git)
npm run build -w @fixwright/views -w @fixwright/host   # the views and the host page, if not built yet
npx wrangler dev --local --ip 127.0.0.1 --port 8701
```

No account and no login are needed for `wrangler dev --local`. Stop it with Ctrl+C.

## Tests

```
npm run check -w @fixwright/server     # tsc (Workers types), tsc (tests), vitest: unit + workerd integration
npm run build -w @fixwright/server     # src/household/demo-template.json, the prebuilt demo house
npm run test:ha -w @fixwright/server   # starts adapter-ha's Home Assistant on 8741, runs the HA path, stops it
npm run bench:cpu -w @fixwright/server       # BENCH_CPU.json
npm run bench:workerd -w @fixwright/server   # WORKERD_CPU.json
npm run bench:household -w @fixwright/server # HOUSEHOLD_CPU.json (new household CPU, SimHome.create against the template)
npm run size -w @fixwright/server            # wrangler deploy --dry-run
FIXWRIGHT_TEST_PORT=8707 npm run test -w @fixwright/server   # integration on 8707 to 8709 when 8701 to 8703 are busy
```

- `test/unit` (node:sqlite, about 1 s): confirm and household tokens, CORS, host check, body cap, token
  bucket, every CAS state machine, and the household in process: the whole golden path, alarm idempotency,
  push failure and retry, undo before the check, demo controls, failures as speech, isolation; rollback on a
  read back mismatch (F8 after the plan); the recovery sweep (applied, rolled back, undo rerun, hub down);
  the simulated daytime clock (golden path word for word for houses built at 03:00, 06:30 and 23:30 Los
  Angeles time); the demo house template (`test/unit/template.test.ts`: the committed JSON is what a fresh build gives, 15:00
  on a later day keeps the 3:11 a.m. outage, other start times are created; a copy runs the golden path); the UTF-8 byte cap
  of `/demo/state`. `test/unit/app.test.ts`: JSON-RPC batches through the real pipeline (one token per
  message, at most 10, a 100 message batch runs nothing). `test/unit/ha-link.test.ts`: the
  link-ha address guard (IPv4 and IPv6 literals in every spelling, internal names, http only on loopback
  in dev), sealed tokens (round trip, wrong household, wrong key, tampered), no redirects, fixed error lines.
  `test/unit/clock.test.ts`: where houses start under `DEMO_START`, daylight saving, the clock labels.
- `test/integration/worker.test.ts` starts `wrangler dev --local` on 8701 (inspector 8702) with an isolated
  `--persist-to` dir and a local ntfy mock on 8703, and drives the real Worker with
  `@modelcontextprotocol/client` 2.2.0 (legacy 2025-11-25): the golden path with every output validated
  against its protocol schema, tools/list, resources/read, 405/413/400, CORS allowed and refused, the Host
  check, 429 with Retry-After, a 10 message batch costing 10 tokens and an 11 message batch refused, the
  `/health` clock label, `/assistant/route`, link-ha off, two households isolated, and the real Durable
  Object alarm running the morning check and pushing. It writes `evidence/initialize-2025-11-25.txt` (raw curl
  transcript) and `evidence/golden-path.txt`.
- `test/integration/ha.test.ts` (tag `ha`, needs `FIXWRIGHT_HA=1`; `scripts/ha-run.sh` sets it up): a real
  power cut on Home Assistant 2026.9.4, the household linked through `/demo/link-ha`, explain_event names the
  power restore, the power on behaviour repair is applied with read back and undone, both checked on the hub
  directly. Writes `evidence/home-assistant.txt`.

What the tests prove is listed in `VERIFY.md`.

## Measured

CPU, Node harness (esbuild bundle with workerd conditions, `process.cpuUsage()` around each
request with its body drained; the household in process on node:sqlite, its share measured inside the call),
200 golden cycles after 20 warm up cycles, 17 Oct 2026 12:54 UTC, Node 22.22.1, AMD Ryzen 9 5950X, load average
1.8 to 2.1 (`BENCH_CPU.json`). Worker = the Worker isolate's part; DO = the HouseholdDO's part (separate
invocations on Cloudflare):

| Request | Worker p50 / p95 / max ms | DO p50 / p95 / max ms |
| --- | --- | --- |
| initialize | 0.342 / 0.744 / 2.088 | none |
| tools/list | 0.423 / 0.735 / 2.899 | none |
| resources/read (stepper, 396 KB at the time) | 2.227 / 4.288 / 10.228 | none |
| diagnose | 0.433 / 0.648 / 1.563 | 2.312 / 4.028 / 8.566 |
| diagnose_answer | 0.403 / 0.557 / 2.413 | 1.501 / 2.831 / 4.455 |
| repair_plan | 0.389 / 0.646 / 1.609 | 3.051 / 4.01 / 19.57 |
| repair_apply | 0.356 / 0.518 / 6.807 | 1.503 / 3.482 / 7.299 |
| repair_status | 0.335 / 0.48 / 1.404 | 0.144 / 0.221 / 1.388 |
| explain_event | 0.372 / 1.194 / 4.542 | 1.154 / 2.538 / 5.402 |
| home_checkup | 0.357 / 1.09 / 4.469 | 1.482 / 3.225 / 10.132 |
| switch_device (refused) | 0.335 / 0.847 / 1.863 | 1.108 / 3.001 / 6.835 |
| refresh_view | 0.315 / 0.461 / 4.332 | 0.142 / 0.172 / 2.18 |
| /assistant/route | 0.116 / 0.188 / 1.194 | none |
| /demo/state | 0.095 / 0.145 / 2.099 | 0.322 / 0.702 / 3.527 |
| /demo/clock next_morning | 0.107 / 0.175 / 1.108 | 3.54 / 7.386 / 24.718 |

No warm p95 is near 10 ms. Two optimisations came from this harness: the ledger keeps an in memory mirror and
writes in batches (checkup DO p50 3.196 to 1.482 ms, explain 1.826 to 1.154 ms between runs), and the engine
settings and random numbers are no longer rebuilt per call. `/demo/clock` includes simulating 16 hours of the
house and the morning check; it is a demo control, not a tool.

First request in a fresh process (median of 5 processes): module import 84 to 93 ms and `primeSchemas()` plus
`warmUp()` 41 to 43 ms, both at module scope (startup budget, 1 s); the first request of any kind 13.5 to 34.6 ms
total in Node, which includes Node's own first use of `Request` and `Response`; the first diagnose 6.737 ms
Worker and 7.066 ms DO; building a household's SimHome on first use (or reset) 21.9 ms (warm resets: p50 4.415,
p95 8.35 ms). Those household figures predate the demo house template; `HOUSEHOLD_CPU.json` replaces them.

New household CPU (`HOUSEHOLD_CPU.json`, `npm run bench:household`, 18 Oct 2026 06:13 UTC, same machine, load
average 1.7). A new demo house is no longer simulated: `npm run build` (and `npm run deploy`) runs
`SimHome.create` once and writes `src/household/demo-template.json` (73,668 bytes, 15:00 on 15 October 2026
in Los Angeles), and the Worker moves that snapshot to the house's start time with homefault's
`rebaseSnapshot`, once per isolate and start time, then stores a copy with each household's own seed.
`warmTemplate()` runs one rebase at module scope. A rebase keeps local times only at the template's time of
day, so a `DEMO_START` at another time (a test's 14:00, or `now`) still builds with `SimHome.create`; the
deployed `15:00` and the e2e and video starts do not.

| POST /demo/household, HouseholdDO part (ms) | first in a fresh process (median of 7) | warm p50 / p95 / max (n 200) |
| --- | --- | --- |
| before: `SimHome.create` (the path a 14:00 start still takes) | 23.633 | 5.022 / 8.322 / 25.259 |
| after: template rebased, `warmTemplate()` at module scope | 3.913 | 1.697 / 2.444 / 11.851 (a rebase each time) |
| after: later houses with the same start (cached copy) | 3.343 (2nd house), 5.018 (3rd) | 0.586 / 1.092 / 2.23 |
| after, without `warmTemplate()` | 5.725 | |

Startup (`primeSchemas()`, `warmUp()` and `warmTemplate()` at module scope): 45.7 ms against 42.9 ms without
`warmTemplate()` in the same run (43.0 ms on the `SimHome.create` path, which runs no template rebase). The
Worker part of the first request is about 24 ms in every variant (23.6 to 24.4 ms); it is mostly Node's own
first use of `Request` and `Response` (see the cpu-bench note above), not household work. The same harness
on 17 Oct 2026 16:11 UTC, under load average 12.6 from a benchmark running alongside, gave the same picture
at higher absolute numbers: first house 31.872 ms DO before and 5.769 ms after, startup 66.7 against 56.1 ms.
Before the template was prebuilt, at load 11.5, the first house measured 29.654 ms DO (the isolate building
its template with `SimHome.create`) and a template miss p50 9.247 / p95 34.246 ms.
One difference from `SimHome.create`: the
old Hallway Lamp copy keeps its age instead of its date, so on a later day the verdict names the date 12 days
before the house's start (October 3 only on 15 October, which the e2e and the video use).

workerd itself (`WORKERD_CPU.json`, 17 Oct 2026 12:51 UTC): utime + stime of the local workerd processes over
300 golden requests in sequence (20 cycles including a house reset and a next morning jump each): 5.467 ms per
request (6.2 ms for the whole wrangler process group), at a load average of 1.2. An upper bound: it includes the
DO work, workerd's HTTP handling and wrangler's local proxy. The root README and the Devpost text quote the
browser run instead (`docs/integration/LATENCY.json`, 17 Oct 2026 13:24 UTC): 9.091 ms per HTTP request over 50
full golden runs, with static files and a new household each run, under a load average of 10.8 to 12.4.

Bundle (`wrangler deploy --dry-run --metafile`, minify on, 17 Oct 2026, `evidence/bundle-size.txt`): before
that day's hardening Total Upload 1834.23 KiB / gzip 522.58 KiB (index.js 679,734 bytes); after it 1854.15 KiB /
gzip 530.36 KiB (index.js 693,690 bytes; the views were also rebuilt by apps/views in between). What the
bytes are: the three views are 1.2 MB of the raw total (64 %), each about 400 KB of which 379 to 385 KB is one
inlined script; index.js is the MCP server SDK 209 KB, the engine 142 KB, zod 113 KB, homefault 63 KB,
adapter-ha 40 KB, protocol 34 KB, router 21 KB, MCP core 17 KB and this package 56 KB. Nothing in it is
unused at runtime: ajv is not bundled (the SDK's workerd shim uses its @cfworker/json-schema provider,
22 KB), and homefault's incidents, generator, scenario and bench code are already tree shaken out. The
hardening added 10.7 KB minified. The views are where a real cut is: compressed together with a large
window they shrink from 302 KB (compressed one by one) to 135 KB (brotli quality 9, window 2^24), so they
share most of their script; one shared runtime in apps/views is the cut worth making (not this package's
code). Without minify it measured 2362.89 KiB / gzip
595.75 KiB (before). The Worker size limit is 64 MiB uncompressed on both plans.

Not measurable locally: Cloudflare's own CPU accounting. After deploying, Workers Logs (observability is on)
show `cpuTime` per invocation; check a fresh version's first `/mcp` calls and a new household's first call
(the first house per isolate rebases the template, 3.9 ms in Node; Cloudflare documents some
per isolate flexibility for infrequent overruns of the Free plan's 10 ms, which only a deploy can confirm).

## Deploy

From the repo root:

```
npm run build -w @fixwright/views -w @fixwright/host
cd apps/server
npx wrangler login                                  # or export CLOUDFLARE_API_TOKEN (Workers Scripts edit)
npx wrangler secret put CONFIRM_SECRET              # 32+ random characters, e.g. `openssl rand -base64 48`
npx wrangler secret put HA_TOKEN_KEY                # only with ALLOW_HA_LINK=1: 32+ characters, seals stored HA tokens
npm run deploy                                      # builds the demo house template, then wrangler deploy
curl https://fixwright.<your-subdomain>.workers.dev/health
```

Vars to set in `wrangler.jsonc` before deploying (or with `--var`):

| Var | Default | Set it to |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | the local host dev server | the exact origins of any host on another origin (the page this Worker serves itself is always allowed) |
| `PUBLIC_HOSTNAMES` | `localhost,127.0.0.1,fixwright.*.workers.dev` | add a custom domain if you route one |
| `NTFY_BASE` | `https://ntfy.sh` | keep, or your own ntfy server |
| `ALLOW_HA_LINK` | `"0"` | `"1"` only for a private demo with a public Home Assistant URL (a Worker cannot reach a LAN) |
| `DEMO_START` | `15:00` | keep: every new house starts at 15:00 Los Angeles time on the day it is built (simulated clock, labeled in `/health` and `/demo/state`); `now` for real time, or an ISO instant |
| `RATE_MCP_PER_MIN`, `RATE_DEMO_PER_MIN` | 240, 30 | per IP per minute (also the burst) |

The Durable Object migration `v1` creates both SQLite classes on first deploy. Subscribe a phone to the
household's topic (`/demo/state` shows `ntfy_topic`) in the ntfy app to see the morning push.

## Free plan limits (Cloudflare docs, fetched 14 Oct 2026)

- Workers Free: 100,000 requests a day, 10 ms CPU per HTTP request, 128 MB memory, 50 subrequests per
  request, 1 s startup, 64 MiB Worker size (uncompressed; no compressed limit).
- Durable Objects on Free: SQLite backend only (this Worker uses it), 100,000 requests a day (RPC calls and
  alarms count), 13,000 GB-s duration a day, 5 GB storage per account, 1 GB per object; SQL: 100 bound
  parameters per statement (the ledger inserts 16 rows of 6 values), 2 MB per row (a SimHome snapshot is
  73,509 bytes at the start, under 256 KB by homefault's bound), 100 KB per statement.
- Each MCP tool call is one Worker request, one RateLimitDO call and one HouseholdDO call.

## Versions

Pinned: @modelcontextprotocol/server, client and core 2.2.0, @modelcontextprotocol/ext-apps 2.0.3,
zod 4.6.5, wrangler 4.144.0, @cloudflare/workers-types 5.20260929.1; from the root: typescript 6.0.3,
vitest 5.0.2, esbuild 0.28.2 (CPU harness bundle), @types/node 22.20.4. No package was added. Unit tests
use `node:sqlite` from Node 22.22.1 (experimental in Node 22; it prints a warning).
