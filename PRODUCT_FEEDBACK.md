# Product feedback

Notes on every tool, API and SDK Fixwright was built with, written while building it (14 to 18 October
2026). Each section answers the five questions the hackathon rules ask: what I used it for, what worked
well, what needs work, how onboarding went (zero to hello world), and whether I would build with it again
(yes or no, and why). Each ends with one recommendation. The friction log (`FRICTION_LOG.md`) has the full
entries with steps, expected and actual results and workarounds. Feature requests with priority ratings
are at the end.

## AWS service used: the Strands Agents SDK (AWS Builder mini challenge)

The AWS service in Fixwright is the Strands Agents SDK for TypeScript (`@strands-agents/sdk` 1.19.0). I use
it in `bench/` to run the LLM only baselines of the HomeTruth benchmark. `bench/llm/src/strands-client.ts`
builds a Strands `OpenAIModel` on Chat Completions (`api: 'chat'`) pointed at a local llama.cpp server that
runs gpt-oss-20b, and passes the seed, `cache_prompt: false`, the reasoning effort and a strict JSON schema
for `{cause_id, confidence, explanation}` through `params`. For each scenario, `strandsVerdict()` creates a
fresh Strands `Agent` with the diagnosis system prompt and retries off, calls `agent.invoke()` once, and
validates the answer with zod. `bench/src/agents/llm.ts` runs both baselines through it: B1 reads the logs
and the symptom, and B2 also reads the answers the person gave Fixwright. A plain fetch client exists only
as a fallback for when Strands gets no answer from the server, and the final run never needed it: 165
Strands calls, 0 fallbacks, 0 failures (`bench/results/HOMETRUTH.txt`). Nothing else from AWS is used.
There is no Bedrock, AgentCore, SageMaker or Kiro, and no AWS account: the hackathon credits ran out on 7
October and every AWS runtime service needs a card, so the model runs on my own machine. Strands is part of
the benchmark, not of the live add-on, which runs no model at all.

## Strands Agents TypeScript SDK 1.19.0

**Used for.** The B1 and B2 baselines of HomeTruth, as described above: 165 calls in the final run, plus
`bench/llm/strands_smoke.ts`, which checks both Strands JSON modes against the local server.

**What worked well.** `OpenAIModel` reached a local llama-server with `api: 'chat'` and a `baseURL`, and
llama.cpp specific fields (`seed`, `cache_prompt`, `response_format`) passed through `params`. In JSON schema
mode, Strands returned the same text as a plain fetch client for the same prompt in every run, and the
`structured_output` mode worked through gpt-oss tool calling. Token usage comes back on the result
(`metrics.accumulatedUsage`), which the benchmark records per call.

**What needs work.** The provider defaults to the Responses API, which llama-server does not serve. Hitting
the token cap throws `MaxTokensError` rather than returning the partial answer. The SDK needs the v1 MCP SDK
and `@opentelemetry/api` as peers, next to a project already on the v2 MCP packages.

**Onboarding.** One package and one model object. The provider defaults to the Responses API, which the
local server does not serve; with `api: 'chat'` the smoke script got a valid verdict in both JSON modes.

**Build with it again: Yes**, because the whole baseline is one small file, the agent code does not care
which model sits behind it, and the same code could later point at a hosted model by changing only the model
object.

**Recommendation.** A documented Chat Completions example for local OpenAI compatible servers.

## Alexa+ add-on docs and the MCP design guide

**Used for.** The tool surface (functional requirements), the three MCP Apps views (design guide), the
consent and speech rules, and the certification table in the README.

**What worked well.** The functional requirements read like a test plan, especially requirement 13 (every
listed tool works, inputs validated, `isError` for failures, ids that chain from one call to the next). The
design guide gives real numbers: a 768x480 base canvas at zoom 1.667, 48 px touch targets, 4.5:1 contrast,
dark card colours, "one title, one or two supporting fields, one clear action", and a voice only path for
every flow. I built the tool surface and the three views straight from these pages.

**What needs work.** The CLI, simulator and Local Inspector are partner only (the npm packages return 404),
so none of the guidance could be checked with Amazon's own tools. Three MCP protocol versions appear across
the overview and samples. hostContext fields are listed without their values per device. Requirement 9
forbids screen references on screenless devices, while the guide says the MCP wire is identical across
surfaces, so a tool cannot know which device will speak its line.

**Onboarding.** There was no hello world with Amazon's tools: the first install command returned 404. My
hello world was my own host simulator calling my own server.

**Build with it again: Yes**, because one MCP server reaches Alexa+ and any other MCP client, and the
requirements are specific enough to build against. With a public emulator, the host I had to build would
not be needed.

**Recommendation.** Publish a reference host or the Local Inspector for hackathon entrants, with the real
hostContext per device class.

## MCP TypeScript SDK v2 (`@modelcontextprotocol/server`, `client` and `core` 2.2.0)

**Used for.** The MCP server in the Cloudflare Worker (`createMcpHandler`), the host simulator's client in
the browser, and the server's integration tests in Node.

**What worked well.** `createMcpHandler(factory, { legacy: 'stateless' })` serves the 2025-11-25 handshake and
the 2026-07-28 era from one factory, and its `fetch` handler runs on Cloudflare Workers with no Node
adapter. zod schemas become `inputSchema` and `outputSchema`. The client runs in the browser with a custom
`fetch`, which made the host's Visual Trace and latency meter easy. Locally, initialize, tools/list and every
tool call measured 7.2 to 18.3 ms at p50 in the browser.

**What needs work.** The 2025 era leg answers only with SSE and returns 406 unless `Accept` lists both media
types. Schemas are converted to JSON Schema on every request (p95 6.04 to 7.31 ms with the prototype's 12 tools in
Node), a real risk on a 10 ms CPU budget until I cached them per isolate. The client opens a standalone GET
that a stateless server must refuse with 405, which Chromium logs as an error on every connect. "Legacy" for
the version Alexa+ documents is a naming trap.

**Onboarding.** Fast. On day one, the first server prototype had a server on `wrangler dev` answering `initialize` at
2025-11-25 and `tools/list` with 12 tools, and the Node client calling them, all checked by a gate script
that reruns in about 40 s.

**Build with it again: Yes**, because one factory serves every protocol era from the same code, and the
rough edges each had a small fix.

**Recommendation.** Memoize schema conversion in the SDK and add a JSON response option to the legacy leg.

## MCP Apps (`@modelcontextprotocol/ext-apps` 2.0.3)

**Used for.** The three views (diagnosis stepper, checkup carousel, repair card) with `registerAppTool` and
`registerAppResource` on the server and the `App` class in each view, and the `AppBridge` in the host.

**What worked well.** Three single file views were straightforward. hostContext (theme, display mode,
container size) reaches the view and is sent again on change, which is how one view adapts to four device
classes. The double iframe sandbox on a second origin works as the spec describes.

**What needs work.** An `AppBridge` given an MCP client forwards a view's `tools/call` without checking the
tool's visibility, so a model only tool was callable from a view. zod triggers one CSP violation per view
load under the default CSP until jitless mode is set before zod loads. Each view is about 400 to 410 KB,
almost all of it one inlined script, and Alexa+ view size limits are not documented.

**Onboarding.** Good. The MCP Apps prototype rendered a view inside the nested sandbox on a third origin from
`structuredContent`, and a "Fix it" tap in the view made a tool call round trip in 8.3 ms, on day one
(22 of 22 checks).

**Build with it again: Yes**, because views from structured content let speech and screen agree by
construction. I would keep my own visibility checks until the bridge enforces them.

**Recommendation.** Enforce `_meta.ui.visibility` inside the bridge.

## Cloudflare Workers, Durable Objects and wrangler 4.144.0

**Used for.** Hosting the MCP server, one SQLite Durable Object per household (ledger, plans, repairs, due
queue), a rate limit Durable Object, the sandbox origin for the views and the host's static files.

**What worked well.** `wrangler dev --local` runs the Worker, two SQLite Durable Object classes and alarms with
no account, which let me build and test everything for $0 before deploying. SQLite in a Durable Object gave
me an append only ledger, compare and set claims for repair steps and a due queue on one alarm. `getByName`
maps a household token to its object. The bundle is 1,854 KiB (530 KiB gzip,
`apps/server/evidence/bundle-size.txt`), far inside the limits.

**What needs work.** The Durable Object CPU limit on the Free plan is described two ways on the same page.
Global scope forbids the synthetic request I wanted for SDK warm up. `wrangler dev` added an AI agent notice
and a Local Explorer that about doubled local CPU per request until I turned it off
(`X_LOCAL_OBSERVABILITY=false`, `X_LOCAL_EXPLORER=false`).

**Onboarding.** Smooth, because local dev needs no account. The first server prototype had a Durable Object writing rows and
firing an alarm 2 to 4 ms late on day one. Deploying still waits on an account, so Cloudflare's own CPU
accounting is not measured yet; locally, workerd used 9.091 ms of CPU per HTTP request on average over 50
golden runs under a load average of 10.8 to 12.4.

**Build with it again: Yes**, because a stateful MCP backend with alarms runs locally with no account and
costs $0 to host.

**Recommendation.** One table of Free plan CPU limits per invocation type: Worker request, Durable Object
RPC, alarm.

## Home Assistant 2026.9.4

**Used for.** The real hub behind the Home Assistant adapter (`packages/adapter-ha`), the
`npm run e2e:ha` beat and the `ha-integration.yml` workflow.

**What worked well.** The REST and WebSocket APIs cover everything a diagnosis needs: states, the entity
registry, config entries and their reloads, logbook, history and services. Template entities, input booleans
and a tiny custom integration were enough to build a hallway circuit where power cuts, ghost entities and
power-on behaviour faults happen through Home Assistant's own mechanisms. A fresh instance was ready in 4.1
to 5.3 seconds, and the official container is pinned by digest in CI.

**What needs work.** Onboarding starts integrations that use the network, with no opt out. The YAML `http:`
block becomes a pending trial config that reverts and restarts after five minutes unless promoted. Entity ids
are lower cased (a guard that compares ids as given can be bypassed), integration services can reach devices
regardless of the entity named, and template entities can carry a stale logbook context.

**Onboarding.** Good once the path was found: installed without Docker through uv on CPython 3.14.7, the first
HTTP answer came about 1 s after launch, and the Home Assistant prototype's whole gate (boot, onboard, test, stop) runs in 20 to
23 s. Two dependencies had no wheels for Python 3.14 and compiled from source.

**Build with it again: Yes**, because it is the one open hub whose APIs expose enough to diagnose a fault and
read a repair back.

**Recommendation.** An onboarding option that skips default integrations, for headless and CI use.

## llama.cpp and gpt-oss-20b

**Used for.** Serving the baseline model locally behind an OpenAI compatible API for the Strands calls.

**What worked well.** A pinned prebuilt llama-server (b11146) and the ungated gpt-oss-20b MXFP4 file ran on a
CPU only VM: 64.3 tok/s prompt processing and 10.5 tok/s generation (median of three runs), 12.2 GiB peak
memory. JSON schema constrained output gave 0 invalid answers in 165 benchmark calls, and the Apache-2.0
weights make the baseline auditable by anyone.

**What needs work.** Greedy decoding at temperature 0 was not reproducible on its own: prompt cache reuse and
two parallel slots changed answers. Stable releases are pointers to prerelease nightly builds, which made
"the newest release at least 14 days old" a puzzle. On a shared CPU, one baseline call took 1 min 47 s on
average on the held out sample.

**Onboarding.** A 12 GB model download checked by sha256, then `start-llm.sh` was healthy in about 17 s. No
source build was needed.

**Build with it again: Yes**, because anyone can rerun the baseline for free with the same binary and weights.
For speed I would add a GPU.

**Recommendation.** A determinism section in the server docs: `cache_prompt` off, one slot, sequential calls.

## ntfy

**Used for.** The next morning push. When a repair's 07:00 check runs, the household's Durable Object sends
`POST NTFY_BASE/<topic>` with `Title` and `Tags` headers and a 5 s timeout. Each household gets a random
topic.

**What worked well.** No account and no key: publishing is one HTTP POST, so the push code is small and works
from a Worker. A local receiver that accepts the same POST (`scripts/ntfy-receiver.ts`, 70 lines) is enough
for the e2e tests to check each push.

**What needs work.** The topic name is the only secret, so anyone who learns it can read or post. A real
household has to install the ntfy app and subscribe to a topic, which is a step most people will not take.
The deployed Worker has not posted to ntfy.sh yet; that is checked after the deploy.

**Onboarding.** Nothing to sign up for, and the publish API is one request.

**Build with it again: Yes** for a demo and for builders, because it needs no account. For households I
would rather use a consented Alexa notification channel, which does not exist for add-ons today.

**Recommendation.** Keep the anonymous publish API as simple as it is; a short note on choosing hard to guess
topics for per user pushes would help.

## Agent Skills specification and skills-ref 0.1.1

**Used for.** `skills/fixwright-home-triage/SKILL.md`, which teaches any agent when to call each Fixwright
tool, how to carry ids, when a yes counts as consent and how to speak on a device with no screen.

**What worked well.** The spec is short and its limits are explicit: `name` matches the folder, a 1,024
character `description`, a 500 character `compatibility`, string to string `metadata`, and a body under
500 lines. The reference validator checks all of that in one command.

**What needs work.** The validator checks the format, not whether an agent follows the skill, so the flow in
the skill is tested only through the product's own e2e.

**Onboarding.** Quick: read the specification page, wrote the file, and `agentskills validate` passed after
installing skills-ref into a Python venv with uv.

**Build with it again: Yes**, because one file carries the consent rules to any assistant that loads skills,
next to the MCP server they describe.

**Recommendation.** A way to check a skill against a recorded conversation, not only its frontmatter.

## GitHub Actions

**Used for.** `ci.yml` (every workspace's check and the golden path e2e), `ha-integration.yml` (the Home
Assistant beat against the official container, pinned by digest) and `uptime.yml` (probes the deployed
server every 3 hours and opens an issue when it fails).

**What worked well.** Actions pinned by commit SHA. On 17 October, actionlint 1.7.12 with shellcheck found 0
problems in all three workflows, and the probe script was tested locally against the dev stack.

**What needs work.** Nothing I can rate yet from GitHub itself: the repo is not pushed, so the workflows have
not run on GitHub. A container service with host networking, which the Home Assistant job uses, could not be
rehearsed on this VM.

**Onboarding.** Familiar.

**Build with it again: Yes**, because free CI and a scheduled probe are what keep a demo endpoint honest
through judging.

**Recommendation.** A local runner for scheduled workflows in the official tooling, so they can be checked
before the first push.

## zod 4.6.5

**Used for.** Every tool input and output schema in `packages/protocol` (turned into JSON Schema for MCP), and
validating the LLM's answers in the benchmark.

**What worked well.** One schema gives the TypeScript type, the runtime check and the JSON Schema. Converting
24 schemas with `z.toJSONSchema` took 0.605 ms at p50 in the first server prototype.

**What needs work.** zod probes `new Function` when a schema is created, which raises a CSP violation in a
view unless jitless is set before zod is first touched. Its classic entry re-exports every locale, about
260 KB of messages a view never needs.

**Onboarding.** Familiar API; the one rule to learn was importing from `zod/v4`, the same entry the MCP SDK
uses.

**Build with it again: Yes**, because one source of truth for types, checks and JSON Schema is what keeps
11 tools consistent.

**Recommendation.** Detect a CSP that forbids eval before probing for it.

## esbuild 0.28.2

**Used for.** Bundling each MCP Apps view into one HTML file and bundling the host page; wrangler uses it
for the Worker.

**What worked well.** Fast builds, and a plugin API small enough that keeping only zod's English locale took
one `onResolve` hook. That took a minimal view from 599,473 to 338,285 bytes (129,117 to 90,307 gzip).

**What needs work.** There is no HTML entry point, so the views build inlines the script and the style into a
template itself, with its own escapes for `</script` and `<!--`.

**Onboarding.** Immediate; the build API is one call.

**Build with it again: Yes**, because it is quick and its plugins solve bundle size problems in a few lines.

**Recommendation.** An option to emit a single HTML file with the bundle inlined.

## vitest 5.0.2

**Used for.** All 2,057 tests across the workspaces (`docs/integration/CHECK.txt`), the views' 247 visual
tests in a second config, and tags that make the live Home Assistant tests opt in.

**What worked well.** Tags made the integration tests opt in, and the same runner handles unit, browser
visual and live tests.

**What needs work.** npm 10.9.4 crashes in arborist on vitest 5.0.2's optional peer graph. vitest 5 hides the
console output of passing tests by default.

**Onboarding.** Familiar, apart from the install crash, which took `legacy-peer-deps=true` and pinning each
peer by hand.

**Build with it again: Yes**, because it ran every kind of test in this repo with one tool.

**Recommendation.** Print a note when output of passing tests is hidden.

## TypeScript 6.0.3 and Node 22 type stripping

**Used for.** Every package, strict, ESM. Node 22 runs the `.ts` scripts directly (bench, scripts).

**What worked well.** One strict contract package (`@fixwright/protocol`) shared by every module, and
running `.ts` with Node needs no build step.

**What needs work.** The MCP client typings reference `Buffer`, so a browser project with `types: []` fails
with TS2591. `npx tsc -p tsconfig.json` run from a workspace folder resolved the root's project once.

**Onboarding.** Familiar.

**Build with it again: Yes**, because a typed contract package is how separate modules agree on every
tool's input and output.

**Recommendation.** For the MCP SDK, `Uint8Array` instead of `Buffer` in browser facing typings.

## Playwright 1.63.0

**Used for.** The golden path e2e on four device classes, the views' visual tests, the screenshots and the
visual tests.

**What worked well.** Headless Chromium drove the whole product end to end: a host page, a sandbox on a
second origin, views in a nested iframe, the golden path on four device classes, 11 of 11 tests with zero
console errors, plus 247 visual tests of the views. `page.clock` made the host's timers deterministic.

animations. A click inside a double sandboxed view resolves before the view's `postMessage` reaches the host,
so a test has to wait for a host side marker before it checks the result.

**Onboarding.** Immediate, with Chromium already installed.

**Build with it again: Yes**, because it drove a three origin app end to end, headless.


## Atkinson Hyperlegible Next and Mono (via `@fontsource` 5.3.0)

**Used for.** Every word on the host's stage and console; the Mono face only in the Visual Trace.

**What worked well.** Drawn by the Braille Institute for legibility at a distance and for low vision readers,
which is the far field job here. The OFL allows self hosting, so the page makes no font request to another
origin, and the license files ship with the fonts.

**What needs work.** Nothing I hit.

**Onboarding.** Copy the latin woff2 files from the npm packages; done.

**Build with it again: Yes**, because it reads well at a distance and costs nothing to ship.

**Recommendation.** None.

## Web Speech API (browser)

**Used for.** The host's mic button (speech recognition where the browser has it) and spoken replies
(`speechSynthesis`, a generic voice).

**What worked well.** No library and no key for a voice demo in the browser.

**What needs work.** Headless Chromium has no recognition API and no voices, so the e2e covers the typed path
and the speaking state only.

**Onboarding.** Immediate in a desktop browser.

**Build with it again: Yes** for a simulator, because it needs nothing. A real product speaks through
Alexa+.

**Recommendation.** None for this use.

## Devpost

**Used for.** The hackathon rules, resources, forum and the submission.

**What worked well.** The hackathon page states the judging criteria and the stages, and the rules say plainly
that judges may score from the text, images and video. The organizer answered forum questions within about a
day.

**What needs work.** The project gallery is hidden until judging, so entrants cannot check for duplicate names
in a very large field. The "Fire TV documentation" link on the resources page returns 404 (it contains
`%20`). Server liveness and judging dates differ between the rules, the schedule and organizer statements.

**Onboarding.** The rules, resources and FAQ pages cover what is needed to start.

**Build with it again: Yes**, because the rules and the forum are clear enough to plan a solo entry around.

**Recommendation.** Warn on duplicate project titles at submission.

## Also used

uv installed Home Assistant and the skills validator into workspace venvs. npm
workspaces hold the monorepo together.

## Feature requests

| Request | Why it matters to Fixwright | Priority |
| --- | --- | --- |
| A public Alexa+ host emulator or the Local Inspector for entrants, with the real hostContext per device class | I had to build my own host and guess how Alexa+ renders views and routes approvals. Nothing in this entry could be checked against Alexa+ itself. | Critical |
| A Device Health API for add-ons, with the user's consent: reachability, last seen, and the endpoint behind a spoken name | Most "can't find the device" pain is about devices only Alexa sees. Fixwright can diagnose only devices behind a hub the household links. | Critical |
| A consented, rate limited proactive notification channel for add-ons | The next morning check is the proof a repair held. Today it goes out through a third party push app. | Important |
| One stated list of MCP protocol versions Alexa+ negotiates, with samples that match | I serve three versions because the docs name three. | Important |
| Device capabilities (screen or no screen) in the tool call's `_meta` | Lets tool speech follow requirement 9 on speakers without guessing. | Nice-to-have |
