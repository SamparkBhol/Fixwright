# Alexa+ add-ons, MCP toolkit path (docs last modified 21 July 2026) friction log

| Reviewer | Status |
| :--- | :--- |
| **Fixwright builder (solo entrant, Alexa+ track)** | Complete |
| **Alexa+ developer experience team** | Under review |

## BLUF (bottom line up front)

The Alexa+ requirements and the MCP design guide are specific and worth building against, but a builder
without partner access cannot run any Alexa+ tool, so every entrant rebuilds a host and guesses how Alexa+
behaves. Two platform gaps, no device health signal and no way for an add-on to speak first, sit right
under the smart home pain that matters most, and the MCP SDK v2, ext-apps and Home Assistant each added
surprises of their own.

**Grade:** C (docs content B+, access and tooling D, platform capabilities for smart home C).

The two fixes with the largest effect: publish a public host emulator (or the Local Inspector) with a
hostContext reference, and give add-ons a device health signal plus a push channel.

## Persona

- **Role:** Solo full stack and AI engineer building an Alexa+ add-on for the hackathon.
- **Experience with this product:** First time building for Alexa+. Familiar with MCP, TypeScript,
  Cloudflare Workers and Home Assistant.
- **Goal:** Ship a live MCP add-on (Fixwright, a home doctor) that would pass certification in spirit,
  with MCP Apps views, an Agent Skill, a benchmark and an open source repo, by 23 October 2026.
- **Technical context:** Clean environment and a new project. No Alexa+ access of any kind and no Echo
  device. Based in India with a budget of $0: no AWS credits left (they ran out on 7 October 2026) and no
  card on any cloud account. Everything runs on one headless Linux VM with no GPU and no Docker, plus
  GitHub Actions.

## Scope

- [x] Read the Alexa+ add-on docs: overview, MCP toolkit, client lifecycle, design guide, functional and
      policy requirements, certification guidelines.
- [ ] Install the Alexa+ CLI and Local Inspector (blocked: partner only, 404 on npm).
- [x] Serve an MCP server at protocol 2025-11-25 over Streamable HTTP on Cloudflare Workers Free.
- [x] Build three MCP Apps views to the Alexa+ design guide and render them in a host.
- [x] Build an Alexa+ style host simulator (because none is public) with device classes and voice only.
- [x] Connect a real Home Assistant 2026.9.4 and repair it with read back.
- [x] Run an LLM only baseline on a local open weights model through the Strands Agents TypeScript SDK.
- [x] Ship an Agent Skill and an open source package.
- [ ] Deploy and measure Cloudflare's own CPU accounting (pending at the time of writing).

## Pros

- **The functional requirements are concrete.** Requirement 13 (MCP tool validation) reads like a test
  plan: every listed tool must work, inputs validated against the schema, `isError` for failures, stable
  ids that chain from one call to the next. I built the tool surface straight from it.
- **The MCP design guide is opinionated in a useful way.** A 768x480 base canvas, 48 px touch targets,
  4.5:1 contrast, "one title, one or two supporting fields, one clear action", and a mandatory voice only
  path. It is rare to get design rules this exact; 247 visual tests now cover my views in both themes at
  1280x800, 960x480 and 390x844.
- **Choosing MCP was the right call.** One server runs unchanged against my host simulator, a terminal
  client and any other MCP client. Alexa+ add-ons are not a walled garden.
- **"Voice first, not voice only" is the right frame.** Writing every result as one spoken line first and
  rendering the view from the same structured data kept speech and screen consistent (requirement 10).
- **The policy requirements are short and readable,** with "watch out for" notes that point at real
  failure modes.
- **Open standards around the track are solid:** MCP 2025-11-25, MCP Apps, Agent Skills (my skill passes
  the reference validator), all usable without any Amazon account.

## Cons

- The Alexa+ toolkit, CLI, simulator and Local Inspector are partner only, and the npm packages the docs
  tell you to install return 404.
- The docs and samples name three different MCP protocol versions.
- No public host emulator or hostContext reference, so every entrant writes one.
- No device health signal and no proactive push for add-ons, which are exactly what smart home repair needs.
- Organizer guidance conflicts on how long the server must stay live and on judging dates.
- Every AWS runtime service needs a card, and the hackathon credits ran out before the build started.

## Friction

Entries 1.1 to 1.14 are about Alexa+ and Amazon. Entries 2.1 to 2.16 are about the stack an Alexa+ MCP
add-on is built on. Every entry gives the six fields the hackathon rules ask for: the task attempted, the
steps taken, expected against actual, a severity rating (High, Medium or Low), the workaround used and an
actionable suggestion. There is no screen recording, so each Timestamp gives the date (UTC) and the work
phase, and the Appendix maps each entry to the file that holds its evidence.

### 1.1 The Alexa+ CLI and Local Inspector cannot be installed

**Task attempted:** Install the Alexa+ CLI and the Local Inspector, to check the MCP server and preview the
views the way Alexa+ would.

**Steps taken:**
1. Followed the Alexa+ add-on setup page, which says to install both with `npm install -g`.
2. Looked up `@alexa-ai/cli` and `@alexa-ai/addon-local-inspector` on the npm registry.
3. Read the toolkit pages and the hackathon forum threads about toolkit and simulator access.

**Expected:** Both packages install, as the setup page says.

**Actual:** Both return 404 on npm. The toolkit, CLI, simulator and Local Inspector are partner only, so a
builder outside the partner program has no way to run any Alexa+ check locally.

**Severity:** High

**Workaround used:** I built my own Alexa+ style host (`apps/host`) from the design guide, and turned the
functional requirements into tests (`e2e/golden.e2e.ts` and the server's integration tests).

**Actionable suggestion:** Publish the CLI and Local Inspector for hackathon entrants, or say at the top of
the setup page that they are partner only and link what everyone else should use instead.

**Timestamp:** 2026-10-14, research before the build.

### 1.2 The docs name three MCP protocol versions

**Task attempted:** Pick the MCP protocol version the server negotiates with Alexa+.

**Steps taken:**
1. Read the version on the Alexa+ overview page.
2. Read the `protocolVersion` in the client lifecycle sample and in the Local Inspector sample.
3. Checked which revision the MCP TypeScript SDK v2 treats as primary.

**Expected:** One protocol version that Alexa+ speaks, stated once.

**Actual:** The overview says 2025-11-25. The client lifecycle sample sends 2025-03-26. The Local Inspector
sample sends 2025-06-18. The current MCP revision is 2026-07-28, which the SDK v2 treats as primary.

**Severity:** Medium

**Workaround used:** I serve 2025-11-25 as the primary lane and accept 2025-06-18 and 2025-03-26 as well,
so any of the three documented versions can connect.

**Actionable suggestion:** State the versions Alexa+ negotiates today (and plans to) on the overview page,
and update both samples to match.

**Timestamp:** 2026-10-14, research.

### 1.3 There is no public host emulator or hostContext reference

**Task attempted:** See how Alexa+ renders an MCP Apps view on each device class, and how it routes
`ui/message`, approvals and tool calls that come from a view.

**Steps taken:**
1. Read the design guide's hostContext section.
2. Looked for the values per device class in the docs and samples.
3. Looked for a public simulator. The Local Inspector synthesizes hostContext, but it is partner only.

**Expected:** A reference that shows the real hostContext values and host behaviour per device class.

**Actual:** The design guide lists the hostContext fields (deviceClass, maxWidth, maxHeight, isMobile,
platform, displayMode, safeAreaInsets, deviceCapabilities, theme) but not their values per device. About
345 public Alexa+ projects were on Devpost by 14 October, and every entrant without partner access faces
the same rebuild.

**Severity:** High

**Workaround used:** I built a host with four device classes (1280x800, 960x480, 390x844 and a speaker with
no screen), an approval sheet, a sandbox on a second origin and a Visual Trace. It sends the device class
as a custom hostContext field (`dev.fixwright/deviceClass`), labelled as simulated on screen.

**Actionable suggestion:** Publish a reference host (even a static page) that emits the real hostContext
for each device class, or a JSON fixture of those values.

**Timestamp:** 2026-10-14 to 2026-10-17, host simulator build (`apps/host`).

### 1.4 Screen references in speech: the requirement and the wire do not meet

**Task attempted:** Meet functional requirement 9 ("Never reference visual elements ... on devices without
a screen") from the server.

**Steps taken:**
1. Mapped each functional requirement to the build for the README's certification table.
2. Read what reaches a tool call. The design guide says "The MCP wire is identical across surfaces", and
   hostContext goes to the view, not to the tool.
3. Checked the spoken templates in `packages/engine/src/phrase.ts` for screen words.

**Expected:** A way for the server to know whether its spoken line will play on a screen.

**Actual:** A tool cannot tell whether its line will play on a speaker with no screen. My checkup speech
says "There are two more on the screen." on every device, and a failed repair or undo step says it "needs
a look on the screen". I only found these while mapping requirement 9.

**Severity:** Medium

**Workaround used:** The Agent Skill tells assistants to say those two lines in their own words on a device
with no screen, and the README marks requirement 9 as Partly.

**Actionable suggestion:** Say next to requirement 9 that tool speech must be screen agnostic, or pass
`deviceCapabilities` in the tool call's `_meta` so a server can adapt.

**Timestamp:** 2026-10-17, certification mapping for the README.

### 1.5 Elicitation is "supported", but not on the serving mode the docs recommend

**Task attempted:** Ask the person a question in the middle of a diagnosis ("Did the lamp blink?").

**Steps taken:**
1. Read the Alexa+ docs, which list elicitation as supported.
2. Checked it against stateless Streamable HTTP in spike A (Workers plus MCP). Server pushed elicitation
   and MCP Tasks need a stream the stateless lane does not keep, and the stateful Cloudflare option
   (McpAgent) is deprecated.

**Expected:** A documented way to ask the user a question mid tool.

**Actual:** The docs say elicitation is supported but not how it works on stateless Streamable HTTP, where
server pushed elicitation and Tasks cannot work.

**Severity:** Medium

**Workaround used:** `diagnose` returns `status: needs_answer` with the question, the assistant asks it in
its own turn, and the reply comes back through a second tool, `diagnose_answer`, with the same
`diagnosis_id`.

**Actionable suggestion:** Document the pattern Alexa+ expects for a question in the middle of a flow on
stateless servers.

**Timestamp:** 2026-10-14, spike A.

### 1.6 Add-ons have no device health signal

**Task attempted:** Diagnose "device not responding" for a device the household uses with Alexa.

**Steps taken:**
1. Read the Alexa+ add-on docs and the Alexa smart home docs for a reachability or health signal an add-on
   can read.
2. Looked for any way an add-on can see Alexa's device list or a device's last seen time.

**Expected:** An add-on that diagnoses "device not responding" can read whether Alexa itself sees the
device as unreachable.

**Actual:** Nothing. The Alexa+ smart home docs push "unresponsive" reporting onto device makers. Yet "can't
find the device" and "delete everything and start over" are among the most consequential smart home
complaints I found.

**Severity:** High

**Workaround used:** Fixwright reads a hub the household links (Home Assistant) or the SimHome twin. For
devices only Alexa sees, it can only guide the person.

**Actionable suggestion:** A Device Health API for add-ons, with the user's consent: reachability, last seen,
and the endpoint behind a spoken name.

**Timestamp:** 2026-10-14, research.

### 1.7 Add-ons cannot speak first or push

**Task attempted:** Tell the household the next morning whether a repair held.

**Steps taken:**
1. Looked through the add-on docs for proactive events, notifications or a way to start a conversation.
2. Checked whether a tool result can schedule anything for later. It cannot; the add-on only answers calls.

**Expected:** After a repair, the add-on can tell the household the next morning whether it held.

**Actual:** Add-ons cannot start a conversation or send a notification.

**Severity:** High

**Workaround used:** A Durable Object alarm runs the check at 07:00 household time and sends the result
through ntfy, a third party push service, which a real household would have to install. `repair_status`
reports the same result when the person asks.

**Actionable suggestion:** A consented proactive notification channel for add-ons (an Alexa app
notification or a yellow ring), rate limited and opt in.

**Timestamp:** 2026-10-14, research.

### 1.8 The environment data policy is unclear for hub reading add-ons

**Task attempted:** Decide what Fixwright may read about the customer's home and still meet the policy
requirements.

**Steps taken:**
1. Read policy requirement 3 and its examples.
2. Listed what a diagnosis must read: device state, availability, logbook rows and integration status.
3. Looked for an example that covers a hub the customer links and authorizes themselves.

**Expected:** A clear line on what an add-on may read about the customer's home.

**Actual:** Policy requirement 3 rejects an add-on that "collects data about the customer's Alexa environment
(e.g., device usage or device preferences)". It does not say whether that covers device state from a hub
the customer links and authorizes themselves (Home Assistant, SmartThings), which is what a diagnosis
add-on must read.

**Severity:** Medium

**Workaround used:** Fixwright reads only a hub the household links, or the simulated house, and never
Alexa's own device registry or activity. The README lists the policy question as open.

**Actionable suggestion:** Add an example that separates Alexa's own registry and activity (off limits)
from data the customer links from another service with consent.

**Timestamp:** 2026-10-14, research.

### 1.9 Broken links

**Task attempted:** Open the Alexa+ "Supported Capabilities" page and the Devpost "Fire TV documentation"
page while reading the docs.

**Steps taken:**
1. Clicked "Supported Capabilities" on the Alexa+ docs home.
2. Clicked "Fire TV documentation" on the hackathon resources page.

**Expected:** Both links open.

**Actual:** Both return 404. The Alexa+ link uses a bad relative path
(`/docs/add-ons/.add-ons/mcp-toolkit-supported-capabilities.html`). The Devpost link has `%20` inside its
path.

**Severity:** Low

**Workaround used:** None was needed in the end. The side navigation of the same Alexa+ page has its own
Supported capabilities links, and the Fire TV page does not matter for an Alexa+ entry.

**Actionable suggestion:** Fix both links, and run a link checker on the docs build.

**Timestamp:** 2026-10-14, research.

### 1.10 Organizer guidance conflicts on liveness and judging dates

**Task attempted:** Plan how long the MCP server must stay live, and when judging happens.

**Steps taken:**
1. Read the FAQ, the official rules and the schedule tab.
2. Read the organizer's forum answers of 2 and 10 October on liveness.

**Expected:** One answer to "how long must the MCP server stay live?" and one judging window.

**Actual:** The organizer said on 2 and 10 October that the server "needs to be live and accessible till the
end of the judging period"; the FAQ says it does not need to stay running. The schedule says judging runs
26 October to 20 November; the rules say 9 to 20 November.

**Severity:** Medium

**Workaround used:** I follow the rules, which say they prevail over other hackathon materials, and plan to
keep the server live at $0 until 3 December. `.github/workflows/uptime.yml` probes it every 3 hours and
opens an issue if it fails.

**Actionable suggestion:** One pinned answer in the FAQ, matching the rules.

**Timestamp:** 2026-10-14, research.

### 1.11 "Start here" tooling without Alexa+ support

**Task attempted:** Start the Alexa+ build with Amazon Devices Builder Tools, which the resources page bills
as "start here" for every track.

**Steps taken:**
1. Opened Amazon Devices Builder Tools from the resources page.
2. Looked for Alexa+ add-on support in what it offers.

**Expected:** It helps with an Alexa+ add-on.

**Actual:** It has no Alexa+ capability.

**Severity:** Low

**Workaround used:** I worked from the Alexa+ add-on docs and the MCP specification directly.

**Actionable suggestion:** Label which tracks each tool supports.

**Timestamp:** 2026-10-14, research.

### 1.13 Every AWS runtime service needs a card, and the credits ran out

**Task attempted:** Host the MCP server and run the baseline model on AWS (Lambda or AgentCore, Bedrock) at
no cost.

**Steps taken:**
1. Checked the hackathon's AWS promo credit offer.
2. Checked what each AWS runtime service needs to start.

**Expected:** Hackathon credits or a card free tier for an MCP server and a model.

**Actual:** Every AWS runtime service needs a card, and the hackathon's AWS promo credits ran out on 7
October.

**Severity:** Medium

**Workaround used:** I host on Cloudflare Workers Free and run the baseline model (gpt-oss-20b) locally on
llama.cpp, called through the Strands Agents TypeScript SDK, which needs no AWS account.

**Actionable suggestion:** Card free sandbox accounts for registered entrants, or say early that credits
are limited.

**Timestamp:** 2026-10-14, research.

### 1.14 Checking a name: the Alexa Skills store search and Devpost

**Task attempted:** Check that the product and open source names were not already taken by an Alexa skill
or another hackathon project.

**Steps taken:**
1. Searched the Alexa Skills store for four candidate names.
2. Searched the hackathon's project gallery and Devpost for the same names.

**Expected:** A skill search with no match shows an empty result, and entrants can see whether another
project already uses a name.

**Actual:** The Alexa Skills store search shows a small "No results" banner and then fills the page with
products from every department. The hackathon gallery is hidden until judging, so duplicate project names
cannot be checked.

**Severity:** Low

**Workaround used:** I read the banner text for each name, and checked the names on npm, the MCP registry,
GitHub, the app stores and USPTO instead.

**Actionable suggestion:** An explicit empty skills result, or a name availability lookup in the developer
console.

**Timestamp:** 2026-10-14, spike F (name check).

### 2.1 MCP TypeScript SDK v2: 2025-11-25 is the "legacy" era

**Task attempted:** Serve and call MCP 2025-11-25 with the MCP TypeScript SDK v2, from a Worker and from a
browser host.

**Steps taken:**
1. Served `createMcpHandler` on `wrangler dev` (spike A).
2. Connected the SDK client from Node with its default settings, with `supportedProtocolVersions`
   `['2025-06-18']` and with `versionNegotiation: 'auto'`.
3. Connected the same client from headless Chromium (spike B).

**Expected:** An SDK that serves 2025-11-25, the version Alexa+ documents, as its main path.

**Actual:** SDK v2 implements 2026-07-28 and serves 2024-10-07 through 2025-11-25 as the "legacy" era
through a stateless fallback in `createMcpHandler`. The default client stays legacy, while
`versionNegotiation: 'auto'` lands on 2026-07-28. In a browser, a CORS blocked `server/discover` probe falls
back to legacy silently and leaves console errors.

**Severity:** Medium

**Workaround used:** The host's client pins `supportedProtocolVersions: ['2025-11-25']` with legacy
negotiation, so it starts with `initialize` and never sends the discovery probe.

**Actionable suggestion:** Name the eras by spec date in the README, and surface why `auto` fell back.

**Timestamp:** 2026-10-14, spikes A and B.

### 2.2 MCP TypeScript SDK v2: the legacy leg answers only with SSE

**Task attempted:** Get plain JSON responses on the 2025-11-25 lane, for simple clients and the uptime
probe.

**Steps taken:**
1. Sent `initialize` to `createMcpHandler` with `Accept` set to `application/json`, to
   `text/event-stream`, to `*/*` and to both media types (spike A).
2. Looked for a JSON response option on the legacy leg.

**Expected:** A JSON response option on 2025-11-25, and lenient `Accept` handling.

**Actual:** Every 2025 era response from `createMcpHandler` is `text/event-stream`; there is no JSON option on
the built in legacy leg. `Accept` must list both `application/json` and `text/event-stream`: either alone, or
`*/*`, gets 406. A host that sends only `application/json` fails.

**Severity:** Medium

**Workaround used:** Every client I wrote sends both media types and parses SSE: the uptime probe
(`.github/scripts/uptime-probe.mjs`) and the plain client (`scripts/plain-mcp.ts`).

**Actionable suggestion:** An `enableJsonResponse` option on the legacy leg, and a 406 body that names the
missing media type.

**Timestamp:** 2026-10-14, spike A.

### 2.3 MCP TypeScript SDK v2: schemas converted on every request

**Task attempted:** Keep each MCP request inside the Workers Free CPU budget of 10 ms.

**Steps taken:**
1. Wrote the spike's 12 zod tools the plain way, with schemas inside the per request server factory.
2. Measured CPU per request in Node with the same handler code: 50 warm up and 300 measured requests per
   request type (spike A).
3. Profiled where the time went.

**Expected:** A cheap per request server factory.

**Actual:** `registerTool` converts every input and output schema to JSON Schema on each request: p50 1.51 to
2.50 ms and p95 6.04 to 7.31 ms per request in Node, which puts the Free plan's 10 ms CPU per request at
risk.

**Severity:** High (on Workers Free)

**Workaround used:** I cache the converted schemas per isolate (`cachedJson`) and prime them at module scope.
With the cache, warm p95 stayed under 2 ms for every MCP request type in the spike.

**Actionable suggestion:** Memoize the conversion in the SDK, keyed by schema object.

**Timestamp:** 2026-10-14, spike A.

### 2.4 MCP TypeScript SDK v2 client in the browser

**Task attempted:** Run the SDK client in the browser host with a clean console, and typecheck the host as a
browser project.

**Steps taken:**
1. Connected from headless Chromium to a stateless server, 30 runs with the SDK defaults (spike B).
2. Counted console errors and failed requests per run.
3. Typechecked a browser project with TypeScript 6.0.3 and `types: []`.

**Expected:** A clean console against a spec compliant stateless server, and a browser project that
typechecks.

**Actual:** The client always opens a standalone GET stream after `initialized`; the stateless server answers
405 (correct), and Chromium logs a console error on every connect, which breaks a zero console error test.
`close()` aborts unread SSE tails (`net::ERR_ABORTED` on the last POST in 22 to 25 of 30 runs). The client
typings reference `Buffer`, so the browser project fails with TS2591. There is no CORS helper for the MCP
endpoint (about 40 lines to write).

**Severity:** Low

**Workaround used:** The host wraps `fetch`: it answers the standalone GET with a local 405, reads every
POST body to the end before `close()`, and records timings for the Visual Trace. The typings error is
skipped with `skipLibCheck`, and the server has its own CORS layer.

**Actionable suggestion:** An option to skip the standalone GET (or skip it when no `mcp-session-id` came
back), a quiet close, `Uint8Array` in the typings, and a `withCors` helper.

**Timestamp:** 2026-10-14, spike B.

### 2.5 ext-apps 2.0.3: the AppBridge forwards view tool calls without the visibility check

**Task attempted:** Let views call tools through the ext-apps `AppBridge` while keeping model only tools out
of their reach.

**Steps taken:**
1. Built an `AppBridge` with an MCP client (spike C).
2. Registered a test tool, `hub_factory_reset`, with `_meta.ui.visibility` `["model"]`.
3. Called it from the view.

**Expected:** A view cannot call a tool whose `_meta.ui.visibility` is `["model"]`.

**Actual:** An `AppBridge` built with an MCP client forwards `tools/call` from the view with no visibility
check, and the model only tool answered the view.

**Severity:** High

**Workaround used:** My host gives the bridge a null client and registers its own handlers. They enforce
visibility and show an approval sheet before any tool that changes something.

**Actionable suggestion:** Enforce visibility in the bridge, or document the gap loudly in the README.

**Timestamp:** 2026-10-14, spike C.

### 2.6 ext-apps and zod under the default CSP, and view size

**Task attempted:** Load the views under the spec's default CSP (no `unsafe-eval`) with a small bundle.

**Steps taken:**
1. Loaded a view three times with plain zod, and three times with a jitless preset imported first, and
   counted `securitypolicyviolation` events (spike C).
2. Measured the built views from the views build manifest (18 October 2026).

**Expected:** Views load without CSP violations, and a small bundle.

**Actual:** zod probes `new Function` when a schema is created, before `App` sets jitless mode, so every view
load raised one `securitypolicyviolation` (3 of 3 loads). A view is 400,485 to 409,455 bytes (110,587 to
112,835 gzip), almost all of it one inlined script. Alexa+ resource limits for views are not documented.

**Severity:** Medium

**Workaround used:** Each view's first import presets `globalThis.__zod_globalConfig` to jitless (0 of 3 loads
then raised a violation). An esbuild plugin keeps only zod's English locale, which took a minimal view
from 599,473 to 338,285 bytes.

**Actionable suggestion:** Set jitless before zod is first touched inside ext-apps, and document view size
limits.

**Timestamp:** 2026-10-14, spike C; sizes 2026-10-18.

### 2.7 ext-apps docs: small mismatches

**Task attempted:** Serve MCP Apps views from a Worker and tear them down cleanly, following the ext-apps
README and the MCP Apps spec.

**Steps taken:**
1. Followed the README's setup for HTTP servers.
2. Sent `ui/resource-teardown` before removing each view's iframe, with the params the spec gives.

**Expected:** The README and the spec match the SDK.

**Actual:** The README says HTTP servers need `@modelcontextprotocol/node` and express; `createMcpHandler().fetch`
works without them on Workers. The spec gives `ui/resource-teardown` params `{reason}`; the SDK type is `{}`.

**Severity:** Low

**Workaround used:** I used `createMcpHandler().fetch` directly with no Node adapter, and send teardown with
`{}` as the SDK type says. All 20 teardowns in the spike were answered before the iframe was removed.

**Actionable suggestion:** Align the README and the type with the spec.

**Timestamp:** 2026-10-14, spike C.

### 2.8 Cloudflare workerd: no warm up in global scope

**Task attempted:** Warm the MCP SDK when the Worker loads, so the first request on a new isolate is cheap.

**Steps taken:**
1. Built a synthetic MCP request with `new Request(url, {body})` in global scope.
2. Tried the same with a parsed body and top level await.
3. Measured the first request on a fresh isolate in Node, with and without priming (spike A).

**Expected:** Top level await could run one synthetic MCP request to warm the SDK.

**Actual:** `new Request(url, {body})` in global scope throws `Disallowed operation called within global scope`,
and with a parsed body the module fails with `Top-level await in module is unsettled`. The first request
pays the cold cost (10.5 to 14 ms CPU in Node).

**Severity:** Medium

**Workaround used:** `primeSchemas()` builds and caches every tool schema at module scope, which needs no
request. It roughly halved the first request in the spike. The rest is checked after deploy in Workers
Logs.

**Actionable suggestion:** Document a supported warm up pattern for SDK heavy Workers.

**Timestamp:** 2026-10-14, spike A.

### 2.9 Cloudflare docs: the Durable Object CPU limit on Free

**Task attempted:** Find the CPU limit a Durable Object call gets on the Workers Free plan.

**Steps taken:**
1. Read the Durable Objects limits page.
2. Measured workerd CPU locally from `/proc` over 50 full golden runs in the browser.

**Expected:** One clear CPU limit for a Durable Object on the Free plan.

**Actual:** The Durable Objects limits page lists "CPU per request 30 seconds (default)" and also says Durable
Objects "have the same per invocation CPU limits as any Workers do" (10 ms on Free). Locally, workerd used
9.091 ms of CPU per HTTP request on average across 50 full golden runs, static files and a new household
included, under a load average of 10.8 to 12.4.

**Severity:** Medium

**Workaround used:** I keep MCP handling in the Worker with cached schemas, keep each Durable Object call
small, and plan to read Cloudflare's own CPU accounting in Workers Logs after the deploy.

**Actionable suggestion:** One table of Free plan limits per invocation type (Worker request, Durable Object
RPC, alarm).

**Timestamp:** 2026-10-14, spike A; golden runs 2026-10-17.

### 2.10 wrangler 4.144.0 dev extras inflate local CPU

**Task attempted:** Measure local CPU per request with `wrangler dev --local`.

**Steps taken:**
1. Ran `wrangler dev --local` and read the workerd processes' CPU from `/proc` over 300 sequential
   requests.
2. Repeated with the Local Explorer and local observability turned off.

**Expected:** Plain local dev, with CPU numbers that reflect the Worker.

**Actual:** `wrangler dev` prints "Wrangler detected this dev session is running in an AI agent", starts a
Local Explorer with trace and log capture that raised local workerd CPU to 1.6 to 2.5 ms per request
(0.9 to 1.07 ms without it), and opens ephemeral loopback ports that cannot be pinned.

**Severity:** Low

**Workaround used:** `X_LOCAL_OBSERVABILITY=false` and `X_LOCAL_EXPLORER=false` for every performance run.

**Actionable suggestion:** Document both variables for performance work.

**Timestamp:** 2026-10-14, spike A.

### 2.11 Home Assistant onboarding is not hermetic

**Task attempted:** Boot a fresh Home Assistant 2026.9.4 without Docker and onboard it by API, for tests and
CI.

**Steps taken:**
1. Installed Home Assistant with uv into a venv on CPython 3.14.7.
2. Started `hass` with a fresh config and called the onboarding endpoints.
3. Watched the config entries and the log, and left an instance running past five minutes.

**Expected:** Headless onboarding of a fresh instance only marks steps done.

**Actual:** `POST /api/onboarding/core_config` starts google_translate, met, radio_browser and shopping_list
config flows that use the network, with no opt out, so CI is not hermetic. Home Assistant 2026.9 also moves
the YAML `http:` block into a pending trial config that reverts to the defaults (port 8123) and restarts
after five minutes unless promoted, and without a supervisor that restart ends the process. The frontend is
a critical default integration that logbook depends on, so an API only config still needs about 0.4 GB of
extra requirements.

**Severity:** Medium

**Workaround used:** The onboarding script waits for those config entries to settle and deletes every one
except shopping_list, so local and CI start from the same baseline. It also calls `http/config/promote`;
an instance then ran 354 s past launch with no revert.

**Actionable suggestion:** An onboarding flag to skip default integrations, and a note on promoting
`http/config` for headless installs.

**Timestamp:** 2026-10-14, spike E; 2026-10-15, adapter-ha.

### 2.12 Home Assistant: safety guards need care

**Task attempted:** Make sure the adapter can never switch a lock, alarm, camera or garage door, whatever a
service call names.

**Steps taken:**
1. Wrote a guard that refuses denied domains by entity id.
2. Read how Home Assistant 2026.9.4 resolves service names and entity ids, and which services reach devices
   directly.
3. Sent calls with a wrong token to see how Home Assistant counts them.

**Expected:** A guard that refuses locks and security devices by entity id is enough.

**Actual:** Home Assistant lower cases entity ids and service names, so `LOCK.FRONT_DOOR` gets past a guard
that compares ids as given. Integration services (`mqtt.publish`, `zwave_js.set_value`,
`zha.issue_zigbee_cluster_command`, ESPHome actions) reach devices regardless of the entity they name.
`homeassistant.turn_on` on a script entity runs the script. Every 401, including websocket `auth_invalid`,
counts toward `ip_ban`.

**Severity:** High

**Workaround used:** The guard lower cases first, resolves areas, devices, groups and scenes to entities,
and refuses integration services and scripts as unverified. One auth gate holds every call after a
rejected token, so a wrong token costs one rejected login, not one per call.

**Actionable suggestion:** A "safe service" allowlist pattern in the developer docs for agent integrations.

**Timestamp:** 2026-10-15, adapter-ha.

### 2.13 Home Assistant: logbook context and timing

**Task attempted:** Explain a power cut on Home Assistant from its logbook and history.

**Steps taken:**
1. Cut the simulated hallway circuit, restored it, and read the logbook rows and their context.
2. Timed `state_changed` events on the websocket against the REST call that caused them.
3. Asked for the explanation right after the restore.

**Expected:** Logbook context names the cause of each change, and the recorder is current.

**Actual:** Template entities carry a stale context (an earlier user action) when an automation changed their
source. A `state_changed` event arrived 21 ms after a 19 ms REST call returned. Asking right after a power cut,
before the recorder listed the restore, once returned "unknown".

**Severity:** Medium

**Workaround used:** The power restore detector works from timing: at least 5 devices on at least 2
integrations coming back within 10 s (`packages/engine/src/explain.ts`). Writes wait for the event and also
read back, and the Home Assistant test waits 1.6 s for the recorder before asking.

**Actionable suggestion:** Document context propagation through templates, and the recorder commit delay.

**Timestamp:** 2026-10-14, spike E; 2026-10-17, integration.

### 2.14 llama.cpp and Strands: reproducible baselines take work

**Task attempted:** Get a reproducible LLM baseline from a local open weights model through the Strands
Agents TypeScript SDK.

**Steps taken:**
1. Started llama-server (b11146) with gpt-oss-20b and called it through Strands `OpenAIModel`.
2. Sent the same request before and after another one, with prompt caching on and off, and batched with a
   second request on a two slot server (`bench/llm/repro_check.ts`).
3. Ran both Strands JSON modes next to a plain fetch client (`bench/llm/strands_smoke.ts`).

**Expected:** Greedy decoding at temperature 0 gives the same answer every time.

**Actual:** Prompt cache reuse and two parallel slots both changed how the prompt is split into batches, which
changed the chosen cause on a 785 token prompt. The Strands `OpenAIModel` defaults to the Responses API, and
llama-server serves Chat Completions. Strands throws `MaxTokensError` instead of returning the partial
answer. `@strands-agents/sdk` 1.19.0 requires the v1 MCP SDK (`@modelcontextprotocol/sdk` ^1.25.2) as a peer
next to the v2 packages. llama.cpp marks every `bNNNN` build as a prerelease; stable `vX.Y.Z` releases point
at one through `nightly-tag.txt`.

**Severity:** Medium

**Workaround used:** `cache_prompt` off, one slot and sequential calls; `api: 'chat'` on the Strands model;
`MaxTokensError` mapped to the same failure kind the fetch client reports; the v1 MCP SDK and
`@opentelemetry/api` pinned as peers; llama.cpp v0.5.0 resolved to b11146 and pinned by archive sha256.

**Actionable suggestion:** A determinism note in the llama.cpp server docs; a Chat Completions example and a
partial result option in Strands.

**Timestamp:** 2026-10-15, bench/llm.

### 2.16 npm and vitest

**Task attempted:** Install the npm workspace with vitest 5.0.2 and typecheck each workspace.

**Steps taken:**
1. Ran `npm install` at the workspace root with npm 10.9.4.
2. Ran the tests and the typechecks from inside workspace folders.

**Expected:** `npm install` builds the tree, and a typecheck checks the project it is pointed at.

**Actual:** npm 10.9.4 crashes in arborist ("Cannot read properties of null (reading 'edgesOut')") on vitest
5.0.2's optional peer graph. vitest 5 hides console output of passing tests by default. `npx tsc -p
tsconfig.json` run from a workspace folder resolved the workspace root's project, so a typecheck once passed
while checking the wrong project.

**Severity:** Medium

**Workaround used:** `legacy-peer-deps=true` in `.npmrc`, with every required peer pinned by hand (vite for
vitest; zod, the v1 MCP SDK and `@opentelemetry/api` for Strands). Every typecheck runs through the
package's own `npm run check`. The hidden output needed no workaround once I knew about it.

**Actionable suggestion:** Fix the arborist crash; print a note when vitest hides output.

**Timestamp:** 2026-10-15, workspace install.

## Questions

- Which MCP protocol versions does Alexa+ negotiate today, and when will it speak 2026-07-28?
- What are the real hostContext values per device class, and is `deviceClass` ever absent?
- Does reading device state from a hub the customer links with consent fall under the environment data
  policy?
- What are the size and CSP limits for MCP Apps views on Echo Show devices?
- How should an add-on ask the person a question mid flow on a stateless server?
- Will add-ons get a proactive notification channel?

## Recommendations

Ranked by severity, highest first. `PRODUCT_FEEDBACK.md` turns the top ones into feature requests with
priority ratings.

1. Publish the Alexa+ CLI and Local Inspector, or a public reference host with real hostContext per device
   class (1.1, 1.3).
2. Give add-ons a device health signal and a consented push channel (1.6, 1.7).
3. Enforce tool visibility in the ext-apps AppBridge (2.5).
4. Memoize schema conversion in the MCP SDK and add a JSON response option to its 2025 era leg (2.3, 2.2).
5. State the MCP protocol versions Alexa+ speaks in one place and update the samples (1.2).
6. Say that tool speech must be screen agnostic, or pass device capabilities to tool calls (1.4).
7. Clarify the environment data policy for customer linked hubs (1.8).
8. Pin one answer on server liveness and judging dates (1.10).
9. Card free sandbox accounts or clearer credit limits for entrants (1.13).
10. Fix the broken links and label which tools support which track (1.9, 1.11, 1.12).

## Screen recording

- Full session: none recorded. The evidence for each entry is in the Appendix.

## Test environment

- OS: Debian GNU/Linux 12 (bookworm), Linux 6.8, headless VM, no GPU, no Docker. AMD Ryzen 9 5950X,
  16 vCPUs, 48 GB RAM.
- Device/Emulator: No Echo device and no Alexa+ access. My own Alexa+ style host simulator (`apps/host`)
  in headless Chromium 153 from Playwright 1.63.0, with large display, small display, phone and voice only
  modes.
- SDK/API version tested: Alexa+ add-on docs last modified 21 July 2026; MCP 2025-11-25 over Streamable
  HTTP (2025-06-18 and 2025-03-26 accepted); `@modelcontextprotocol/server`, `client` and `core` 2.2.0;
  `@modelcontextprotocol/ext-apps` 2.0.3; zod 4.6.5; `@strands-agents/sdk` 1.19.0; Home Assistant
  2026.9.4 REST and WebSocket APIs.
- Runtime versions: Node 22.22.1, npm 10.9.4, TypeScript 6.0.3, wrangler 4.144.0 (`wrangler dev --local`),
  Home Assistant on CPython 3.14.7 (uv managed), llama.cpp b11146 with gpt-oss-20b (MXFP4). CI on GitHub Actions, ubuntu-24.04.

## What succeeded

- An MCP server at protocol 2025-11-25 on Cloudflare Workers Free, with 11 tools, 3 MCP Apps views and one
  SQLite Durable Object per household.
- The full golden path end to end in a browser host on four device classes, 11 of 11 tests, 0 console errors.
- A real Home Assistant 2026.9.4 repaired and read back over its REST API, then undone.
- An LLM only baseline on a local open weights model through Strands, reproducible run to run, and a full
  benchmark run with it (`bench/results/HOMETRUTH.txt`).
- An Agent Skill that passes the reference validator, and an open source package with its own CI.

## What failed

- Installing or running any Alexa+ tool.
- Testing on a real Echo or against the real Alexa+ host.
- Using AWS runtime services at $0.

## Appendix

### Evidence

| Entries | Evidence |
| :--- | :--- |
| 1.1 to 1.13 | Research notes behind the build decision (14 October 2026), saved copies of the Alexa+ docs and the hackathon pages |
| 1.4 | `packages/engine/src/phrase.ts` (`ck_more`), Alexa+ design guide "Layout and Rendering" |
| 1.14 | Spike report F (name check) |
| 2.1 to 2.10 | Spike reports A, B and C (Workers plus MCP, browser client, MCP Apps), `apps/server/README.md`, `apps/views/dist/manifest.json`, `docs/integration/LATENCY.json` |
| 2.11 to 2.13 | Spike report E, `packages/adapter-ha/README.md`, `apps/server/evidence/home-assistant.txt` |
| 2.14 | `bench/llm/README.md`, `bench/llm/results/repro_check*.json`, `bench/llm/results/strands_smoke.json` |
| 2.16 | `docs/DEPENDENCIES.md`, `.npmrc` |

### Scratch pad

Written with the full template from [friction-log-guide](https://github.com/chris-trag/friction-log-guide)
(`templates/friction-log-template.md`), with the three fields the hackathon rules add to it (task attempted,
steps taken, workaround used). Severity labels are the template's words without the symbols. Raw session
notes were not kept apart from the spike reports named above. The research notes and spike reports are my
own build notes and are not part of this repository.
