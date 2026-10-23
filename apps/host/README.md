# Fixwright host simulator (apps/host)

An Alexa+ style host in the browser, built to demo the Fixwright MCP server honestly: a real MCP
client, real MCP Apps views in a real sandbox, and a developer console that shows every JSON-RPC
message. The host itself is simulated and says so on every screen:

> Alexa+ host simulated. Live MCP server: `<url>` (MCP 2025-11-25, Streamable HTTP).

Generic device frames only: no assistant logo, no real product shapes, a neutral light ring, and a
generic system voice.

## What it does

- **Real MCP client.** `@modelcontextprotocol/client` 2.2.0, one long lived `Client` per page, legacy
  negotiation with `supportedProtocolVersions: ['2025-11-25']`. The fetch wrapper answers the
  SDK's standalone `GET` locally with 405 (the server is stateless; a network 405 would log a console
  error), drains POST bodies before close, records HTTP timing, and adds `Authorization: Bearer hh_...`.
  The Visual Trace captures messages by patching the transport's `send` and `onmessage`.
- **MCP Apps views, double sandboxed.** `AppBridge` with a **null client** and explicit
  handlers: `tools/call` from a view is refused unless the tool's `_meta.ui.visibility` includes `app`,
  and anything not read only waits for the person's **approval prompt** (host chrome above the view).
  Answers to the on screen question (`diagnose_answer`) go straight through: they are the person's input,
  not a change. Views load inside the sandbox proxy on another origin (`apps/sandbox`), which writes them
  into an inner iframe. All three `ui://` views are **prefetched and cached at connect**. Each result gets
  a fresh view instance: the old one fades out first and the new one fades in after it, so two cards are
  never on screen together, and the old one is torn down (`ui/resource-teardown`, close, remove). A turn
  whose tool has no view (switch_device, protect_device) shows its words on a display instead of leaving an
  older card up, and on the phone the newest bubble is the answer.
- **One approval rule for everything a view starts** (`src/policy.ts` `requiresApproval`). A view's
  `ui/message` is routed like the person's words, so a view that sends "yes" while a plan waits, or
  "undo that", would otherwise spend the plan's `confirm_token` or undo a repair on its own. Spoken and
  typed words are the person's own yes; a view's words are not, so any route to a tool that is not
  read only (repair_apply, undo, switch_device, protect_device, or a tool the host does not know) opens
  the approval sheet first, which says "The screen sent “yes” for you." The caption and the console mark
  such words as "Sent by the view".
- **The sheet can be answered out loud.** The host speaks the sheet's question ("Apply this fix?") and
  shows it as the caption. While it is open, the person's own words go to the sheet first:
  `consentOf` from the router reads a yes ("yes", "do it", "apply it", "apply the fix", "haan kar do") or a
  no ("no", "not now", "cancel", "rehne do"); a question, an observation ("yes, it blinked") or a yes that
  carries another request ("yes, undo it") is never a yes. With no sheet open (voice only), a question about
  a waiting plan ("is it safe?", "what will it change?") hears the plan's own diff lines read back. A new request
  ("give my house a checkup") closes the sheet with nothing changed and runs; anything else asks again
  ("Apply this fix? Say yes or no."). So a spoken yes applies the plan exactly once and the sheet closes;
  it can never go around the sheet. A view's `ui/message` cannot answer, close or queue behind an open
  sheet (it is dropped and logged). The suggestion chips become "Yes, apply it" and "Not now". The sheet
  uses far field type, at least as large as the view text behind it.
- **A tap is the person's turn.** When the person taps a view button that calls a model visible tool
  (Yes, Fix it, Undo, Show the fix), the host adds their turn to the captions and the transcript ("You
  tapped: Fix it."), so the reply that follows pairs with what they did. A view refreshing itself
  (`refresh_view`, app only) is not a turn and is not spoken.
- **Declining is calm, not a failure.** "Not now" sends again the view its latest result, then denies the
  call with "Not approved. Nothing changed." (a JSON-RPC error, the MCP Apps way). The views keep the
  newer host result, so the repair card simply stays with its Undo button, and the
  host says "Okay. Nothing changed." out loud.
- **Devices.** Large display 1280×800, small display 960×480, phone 390×844, and a voice only speaker
  with a light ring and big captions. Views get the screen as `containerDimensions` plus
  `dev.fixwright/deviceClass: 'large' | 'small' | 'phone' | 'voice'`. Switching devices keeps the
  conversation; voice only tears the view down and speaks, and returning to a screen shows the newest
  result again on the new device, including results of calls the view made itself (a tapped Yes shows the
  verdict, a tapped Fix it shows the repair card with Undo, never the answered question or the dry run). A
  view's result counts only if nothing newer was shown while its call ran. A repair whose morning check
  came due while there was no screen is refreshed (`refresh_view`) before it is shown. The device **holds one size from turn to turn**: captions and
  suggestion chips have fixed heights, so the stage box only changes with the window or the device. A
  small display or a phone may be drawn up to 1.2x or 1.35x the large display's scale (readable, still
  visibly smaller); the phone shows the conversation as whole chat bubbles instead of captions.
- **One clock.** The host clock (pinned by the test hook, synced to the server's house time, moved by
  "Next morning 7:00") reaches the views as hostContext `dev.fixwright/now` (whole second ISO), sent again
  on every pin, jump or sync and once a minute. So "tomorrow at 7:00 AM" is relative to the house time, and
  after the morning jump the repair card on screen sees its check as due and refreshes itself to "Repair
  confirmed". A pin is the test hook's or the video's explicit choice: a plain reading
  of the house time never replaces it, and an answer asked for before a later pin is dropped, so
  `setClock()` right after `ready()` holds (ready() awaits its first `/demo/state` reading). A jump or a reset
  moves the house clock itself, so a pinned clock moves with it.
- **The morning push lands on the device, never on the view.** A push from `/demo/clock` shows as a
  notification card until the person's next turn or a tap on its close button; outside test mode it also
  leaves after 12 s. On the large and small displays it fills the caption band under the device, in place
  of the caption line (so the captions never pair the last answer with the new news); on the phone it drops
  over the app header and the chat (the view sits below them, at most 480 px tall, so it is never covered);
  with no screen it sits above the speaker ("pushed to your phone"). The e2e checks that its box and the
  view slot's never overlap on all three screens. **Tapping the push opens the repair it is about**: the
  repair whose subject the push names (`repairForText` from @fixwright/router: "Hallway lamp answered all 9
  commands overnight." opens the hallway lamp repair, not the newer power on fix), else the newest repair,
  as the person's own turn ("You tapped: Show me that repair.") with `repair_status`.
- **Step hints for the views.** Two more hostContext keys (apps/views reads both, any host may leave them
  out): `dev.fixwright/focus`, the person's words behind the screen (set by a new request such as "Why did
  every plug turn on at 3 a.m.?" or "Did the hallway lamp fix hold?", kept through the yes turns), so a
  finished repair lists the devices those words name first; and `dev.fixwright/stepLabels`, clearer step
  labels for two devices that share a name (`src/step-labels.ts`): the host reads the home's devices from
  `/demo/state` (its stand in for the assistant's own device list; read on ready and after every fault,
  reset or new household) and each plan's diff rows, so "Set Living Room Light to remember its last state"
  becomes "Set Living Room Light (the Floor Lamp) to remember its last state" when a Hue group shares the
  name. The note is the room when the rooms differ, else the device's own name, else its hub. A third
  key, `dev.fixwright/hubLabel`, tags a linked Home Assistant "Real Home Assistant, demo devices" (the test
  hub's devices are fixtures); open the page with `?ha_devices=real` for a hub with real devices.
- **Safety net drills.** Break my house has a "Test the safety net" section above the faults: S1 "The next
  fix won't stick" (the next repair's first change is dropped, so the read back fails and everything is put
  back) and S2 "The fixed lamp loses power overnight" (its wall switch is off from 2:00 to 2:20 on the next
  jump to the morning, so the 7:00 check fails and the card offers "Diagnose"). Both go to `/demo/fault`
  and fire once (apps/server `src/household/safety.ts`). The push topic is shown shortened, like the token.
  house clock from `/demo/state` (day #CBD5D3 from 07:00 to 21:59, night #1B2433 otherwise), the device on a
  shelf, four device silhouettes as the switcher, and the house plan under the shelf: six rooms, one dot per
  light, switch or fan, read from `/demo/state` after each tool call that can change the house (no polling).
  A dot is lamplight when on, outlined when off and red when offline; a green ring marks the lamp that
  answered the flash test. Lamplight (#FFB547) is the only accent and only means on or lit. Type is
  Atkinson Hyperlegible Next, with Atkinson Hyperlegible Mono only in the Visual Trace, self hosted.
- **Three moments, each from logged times.** The flash test: the plan blinks the lamp that really switched,
  four switches in the rhythm the twin logged them (`physical.recentActuations`, 15 to 16 ms apart, shown
  stretched to 1.8 s). The 3 a.m. question: the wall goes to night, the devices that came on light up in
  the logged order over the logged span (the same span as the explanation's own rows), then the wall comes
  back. The morning push: the wall comes slowly out of the night into the day, then follows the clock. With
  reduced motion, and in test mode, the plan shows the end state and the line that says what happened,
  without the words about a slower replay, which only show while it moves. Dots a switch, repair or undo
  changed carry a dashed ring until the next request.
- **Phone width.** At 700 px and below the suggestion chips wrap instead of scrolling, the composer says
  "Type what you would say", the plan folds into two rows of three rooms, and the four console tabs use
  short labels (Chat, Trace, Latency, Break it) with the long label kept as the accessible name. A suggestion the person already said is not
  offered again until every starter has been used.
- **Conversation.** Mic (Web Speech API where the browser has it), a text box and context aware
  suggestion chips; replies are spoken with `speechSynthesis` and shown as captions. Utterances go
  through the deterministic `@fixwright/router` in the page (or `POST /assistant/route` with
  `?router=server`), the host calls the tool over MCP, renders the view and speaks `speech`.
- **Console tabs.** Conversation (each turn with the router intent and the tool call, status and time),
  Visual Trace (raw JSON-RPC on two lanes, MCP server and view bridge, with protocol version and
  structuredContent badges, click to expand), Latency (p50 and p95 per method and per tool, measured in
  the page), Break my house (inject F1 to F10 via `/demo/fault`, `/demo/reset`, `/demo/clock` next morning
  or +1 hour, active faults, the household token, pushes). About (what is real, what is simulated, the
  device screen theme, session facts) opens from the top bar.
- **Household.** On first load `POST /demo/household` gives a token that is kept in `localStorage`, one
  per server origin, so switching `?server=` never reuses a household minted by another server (every
  access wrapped in try/catch; without storage the token lives for the page only, and without the route
  the shared `hh_public` household is used).
- **Small screens.** The honesty banner never truncates the server URL (it wraps as a whole); below 700 px
  it gets its own row. The page never scrolls sideways (checked at 390 and 430 px), and the four console
  tabs fit from 1280 px up.

## Configuration

Build time defaults (env for `npm run build`) and query parameters (override at runtime):

| Build env | Query | Meaning | Default |
| --- | --- | --- | --- |
| `SERVER_URL` | `?server=` | Fixwright server base URL, MCP at `<server>/mcp` | the page's own origin |
| `SANDBOX_URL` | `?sandbox=` | sandbox proxy page on its own origin | `http://127.0.0.1:8712/sandbox.html` |
| | `?router=server` | route through `POST <server>/assistant/route` | local router |
| | `?device=large\|small\|phone\|voice`, `?theme=light` | initial device and theme | large, dark |
| | `?test=1` | deterministic: no audio, no animations, no clock ticker | off |

Production: apps/server serves `dist/` at `/` (same origin as `/mcp`), so only the sandbox needs setting:
`SANDBOX_URL=https://fixwright-sandbox.<subdomain>.workers.dev/sandbox.html npm run build -w @fixwright/host`,
and the sandbox Worker gets `HOST_ORIGINS=https://fixwright.<subdomain>.workers.dev`.

## Test hook: `window.__fixwright`

For Playwright and the video pipeline (`src/hook.ts`):

```ts
await __fixwright.ready();                         // household + MCP connect + view prefetch done
__fixwright.setClock('2026-10-15T17:20:00Z');       // pin the host clock for the page and the views (null: real time)
let s = await __fixwright.say("Why is the hallway lamp not responding?"); // resolves after the tool call and view render
s = await __fixwright.setDevice('voice');          // 'large' | 'small' | 'phone' | 'voice'
s = await __fixwright.approve(true);               // tap the open approval prompt; resolves after the approved call
s = await __fixwright.say('yes');                  // or answer it out loud (a no, "not now" or "cancel" declines)
__fixwright.setTheme('light'); __fixwright.setTab('trace');
__fixwright.snapshot();  // { device, connection, transcript (with via: typed | tap | view | approval ...), spoken,
                         //   viewTool, viewUri, approval, conversation, pushes, toast, clockMs,
                         //   house: { wall, shown, morning, rooms, moment: { kind, line, devices, spanMs, frames } } }
__fixwright.holdMoment(700);  // freeze the newest plan moment 700 ms in (screenshots, the video); null plays live
__fixwright.trace();     // the Visual Trace as data (each row with t, performance.now() in the page, and session);
                         // __fixwright.events(): approvals, refusals, transport errors
await __fixwright.idle();  // waits for tool calls, view renders and calls a view starts; resolves early
                           // when an approval is open (the host is waiting for the person)
```

## Mock server

`test/mock-server.ts`: a real MCP server (`@modelcontextprotocol/server` 2.2.0, `createMcpHandler`,
stateless 2025-11-25 lane) with all 11 tools registered from the protocol's `TOOL_DEFS`, answering from
`packages/protocol/fixtures` with chaining ids (`test/mock/household.ts`): questions answered once, plans
applied once with their own token (`token_mismatch`, `plan_used` otherwise), repairs confirmed by the
next morning clock jump (with the push), undo, the protected strip refusal, `refresh_view` (for a repair:
its current status, so it turns `confirmed` after the jump), households per token. A "no" or unclear answer gets a follow up question with the fixture's own probes and
hypotheses unchanged (the mock invents no numbers). It serves the three `ui://` views from `apps/views/dist` when built, else a small handwritten
placeholder view (`test/placeholder-view/`, no SDK, renders all three from structuredContent and, like apps/views, refreshes a repair whose check is
due by the host clock). It stubs
`/demo/household`, `/demo/fault`, `/demo/reset`, `/demo/clock`, `/demo/state`, `/assistant/route` and
`/health`, with CORS for allowlisted origins only. The mock's numbers all come from the fixtures; it is
test infrastructure, not a model of a house.

## Run

From the repo root:

```
npm run dev -w @fixwright/host        # build + host :8711, sandbox :8712, mock server :8713; open the printed URL
npm run build -w @fixwright/host      # dist/index.html, dist/app.js, dist/app.css
npm run check -w @fixwright/host      # tsc (browser + node), unit tests, build, Playwright end to end
npm run test:e2e -w @fixwright/host   # just the end to end run
```

E2E options: `E2E_VIEWS=placeholder` (force the placeholder views), `E2E_VIEWPORT=1920x1080`,
`E2E_SHOTS=<dir>`, `E2E_REPORT=1` (print the latency table and the device width per turn; vitest 5 hides
console output of passing tests, so add `-- --silent=false`). Ports: 8711 to 8713 for the e2e stack,
8761 for the mock server unit test. Everything runs in the test process and is closed after it.

## Screenshots

`screenshots/` (written by the e2e run, 1600×1000, real views from apps/views): `00-idle-large`,
`01-large-diagnose`, `02-voice-verdict`, `03-large-plan`, `03b-large-message-approval` (a view's "yes"
waiting on the sheet), `04-large-approval`, `05-large-applied`, `05b-large-declined` (the repair card
after "Not now"), `06-break-my-house`, `07-small-checkup`, `08-phone-checkup`, `09-trace`, `10-latency`,
`11-light-about`, plus `12-laptop-1280x720`, `13-narrow-390`, `14-voice-push` (the morning push on a
speaker with no screen), `15-small-approval` and `16-phone-approval` (the sheet's far field type on the
smaller screens), `17-small-push` and `18-phone-push` (the morning push with the repair card on the
smaller screens), `19-large-flash-replay` (the flash held mid blink), `20-morning-light` (the wall as the
morning push lands) and `21-large-restore-replay` (the 3 a.m. replay held halfway, on the night wall). In `04`
the captions read "You tapped: Fix it." over "Apply this fix?"; in `06` the morning push fills the caption
band under the display, clear of the repair card.

## Golden path in this host

Golden path steps 3 and 5 take two yes turns here: "Want me to fix that?" "Yes." plans the fix and
shows the dry run (repair_plan), and a second "Yes." (or "Fix it" on the screen, then the approval sheet)
applies it (repair_apply). That keeps the product rule: the person sees the dry run before the one yes
that changes the house. The video script needs both turns. A spoken "Yes" also answers the approval sheet
when the dry run was opened on the screen.

For the video: record at 1920×1080 or larger. At 1280×720 the large display is drawn about 494 px wide and
the phone about 200×420 px, too small to read. With the real server, ask "Why did every plug turn on at 3
a.m.?" before the next morning jump (after the jump, "3 a.m." means a quiet night).
Then, for step 4, ask "Did the hallway lamp fix hold?" before the jump: the power on fix is newer, so a bare
"Did the fix hold?" shows that one, while the push confirms the hallway lamp. After the jump the hallway lamp
card refreshes itself to "Repair confirmed" under the push, and tapping the push opens the same repair
(root e2e step 4 and screenshot docs/screens/11).

## Measured (18 Oct 2026, stage redesign, headless Chromium, localhost)

- `npm run check -w @fixwright/host`: 52 unit tests and 24 end to end tests against the mock server, green
  (root `npm run check`, 13:49 UTC).
- `npm run e2e` (the real local stack, e2e/golden.e2e.ts): 11 of 11 in each of 3 runs in a row, about 11.4 s
  each. Step 9 now waits for the host to take the view's message.
- On the real stack the flash replay used 4 logged switches 45 to 48 ms apart end to end, and the 3 a.m.
  replay 14 devices over 3,436 ms, the same span as the explanation's own rows.

## Measured (17 Oct 2026, headless Chromium, localhost, mock server)

- Tests: 34 unit tests and 23 end to end tests pass; three consecutive e2e runs of the final suite were
  green, each about 11 s. packages/router: 171 tests; apps/sandbox: 17 tests.
- Bundle: `app.js` 801,463 B (193,938 B gzip), `app.css` 30,361 B; apps/host 53,590 B and
  packages/router 21,262 B of app.js (esbuild metafile).
- The numbers below are from 15 Oct and still describe this build except where this list says otherwise.

## Measured (15 Oct 2026, headless Chromium, localhost, mock server)

- Tests: 32 unit tests and 22 end to end tests pass; the e2e run takes about 10 to 19 s (the machine was shared with other test suites).
- Mutation check of that day's fixes, each reverted on its own: results of view started calls not
  remembered (3 e2e fail), a spoken yes not sent to the sheet (3 fail), no host clock for views (4 fail),
  the replaced frame keeping `active` until its teardown answer (3 fail).
- Bundle: `app.js` 799,001 B (193,118 B gzip), `app.css` 29,017 B (7,244 B gzip). By package (minified
  bytes in app.js, from the esbuild metafile, printed by every build): zod 453,451 (all locales, pulled in by
  the SDKs), @modelcontextprotocol/client 194,157, apps/host 53,089, ext-apps 30,825, protocol 26,934,
  router 19,301, core 16,588, eventsource-parser 3,803, pkce-challenge 759.
- Device size on the stage, one width on all 6 sampled turns (the e2e asserts it): the large display
  is 852.7 px wide at 1600×1000, 970.5 px at 1920×1080 and 493.9 px at 1280×720 (the full e2e suite passes
  at all three window sizes).
- One e2e run's Latency tab (round trip in the page, against the mock server, which rebuilds its MCP
  server per request): initialize 73 ms; tools/list 61 ms; resources/read p50 49 ms, p95 60 ms (3);
  tools/call diagnose 41 ms, diagnose_answer 19 ms, explain_event 9.5 ms, home_checkup p50 9.1 ms, p95
  18 ms (2), refresh_view p50 15 ms, p95 18 ms (2), repair_apply p50 9.0 ms, p95 14 ms (2), repair_plan
  p50 8.7 ms, p95 11 ms (2), repair_status 11 ms, switch_device 16 ms. These are local numbers from a
  loaded machine, not the deployed Worker.

## Known limits

- Web Speech input and audible `speechSynthesis` are implemented but cannot run in headless Chromium (no
  recognition API, no voices); the e2e covers the typed path and the speaking state only.
- The host's own tests run against `test/mock-server.ts`; the real server is covered by the root e2e
  (`e2e/golden.e2e.ts`).
- Pushes are shown from the `/demo/clock` response; the host does not subscribe to ntfy itself
  (the real server is meant to return them the same way).
- Production `SANDBOX_URL` (host build) and `HOST_ORIGINS` (sandbox Worker) are unknown until deploy.
- The host refreshes a due repair itself only when it shows it again after voice only. A repair card that
  is already on screen relies on the views' own refresh (on the next host clock change, or their 60 s
  grace after the check time), and both rely on the server answering refresh_view with the repair's
  current status.
- In the mock, a repair applied after the next morning jump keeps the fixture's check time (that same
  morning), so its card asks refresh_view once and stays "Fixed and checked". The real server schedules
  the next 07:00.

## Fonts

`src/fonts/`: Atkinson Hyperlegible Next (400, 500, 700) and Atkinson Hyperlegible Mono (400), latin subset
woff2, from the `@fontsource/atkinson-hyperlegible-next` and `@fontsource/atkinson-hyperlegible-mono` 5.3.0
packages, which repackage the Google Fonts release of the Braille Institute fonts (github.com/googlefonts).
SIL Open Font License 1.1; the license files sit beside the fonts and ship in `dist/fonts/`. The build copies
them; the page makes no font request to any other origin.

## Versions

@modelcontextprotocol/client 2.2.0, @modelcontextprotocol/core 2.2.0, @modelcontextprotocol/ext-apps 2.0.3,
zod 4.6.5 (runtime); @modelcontextprotocol/server 2.2.0 (dev, mock server; added with
`npm install --workspace @fixwright/host --save-exact`), @fixwright/sandbox (dev, workspace), esbuild 0.28.2,
playwright 1.63.0 (preinstalled Chromium), vitest 5.0.2, TypeScript 6.0.3 from the root.
