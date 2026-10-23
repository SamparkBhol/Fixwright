# @fixwright/views

The three MCP Apps views Fixwright returns with its tools. Each is one
self contained HTML file: the ext-apps `App` class over the postMessage bridge, script and styles inlined,
no network, system fonts.

| View | Resource URI | Renders | Actions (tools called through the bridge) |
| --- | --- | --- | --- |
| `dist/stepper.html` | `ui://fixwright/stepper.html` | `diagnose`, `diagnose_answer`, `explain_event`, `repair_plan`, then a repair in place | Yes / No: `diagnose_answer {diagnosis_id, question_id, answer}`. Show the fix: `repair_plan {diagnosis_id}` (diagnosis) or `{explanation_id}` (explanation). Fix it: `repair_apply {plan_id, confirm_token}`. Undo: `undo {repair_id}` |
| `dist/carousel.html` | `ui://fixwright/carousel.html` | `home_checkup` (3 to 5 findings) | Card action on a fixable finding: `repair_plan {issue_id}`, then Fix it and Undo in place. On a labelled finding that is not fixable ("Show me how", "Protect it"): ui/message with the person's request, e.g. "Show me how to fix this. Kitchen plug dropped off Wi-Fi 9 times today." |
| `dist/repair-card.html` | `ui://fixwright/repair-card.html` | `repair_apply`, `repair_status`, `undo` | Undo: `undo {repair_id}`. When the next check is due: `refresh_view {ref_id: repair_id}` (app only), once |

Design: `design/DESIGN.md` (every decision with the design guide rule it follows). Screenshots of every
state: `screenshots/`.

## Use from the server

```ts
// wrangler.jsonc: rules [{ type: "Text", globs: ["**/*.html"] }]
import stepperHtml from '../../views/dist/stepper.html';
registerAppResource(server, 'stepper', VIEW_URIS.stepper, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
  contents: [{ uri: VIEW_URIS.stepper, mimeType: RESOURCE_MIME_TYPE, text: stepperHtml }],
}));
```

- No `_meta.ui.csp` is needed: the views make no requests, so the MCP Apps restrictive default CSP is
  exactly right.
- `dist/manifest.json` lists bytes, gzip bytes and a sha256 per file, for cache busting or content
  hashed URIs.
- Build before the server bundles: `npm run build -w @fixwright/views` (also part of `npm run check`).

## What the views expect from the host

- `hostContext.theme`, `displayMode`, `availableDisplayModes`, `containerDimensions`, `locale`,
  `timeZone`, `safeAreaInsets` (all standard).
- `containerDimensions` either fixed (`{width, height}`: the view fills it) or growing (`{width,
  maxHeight}`: the view reports its size through ext-apps autoResize, never past `maxHeight`, and
  scrolls inside past that). apps/host's Phone (`{width: 358, maxHeight: 480}`, slot capped at 480 px)
  works as it is: the question and Yes / No show without scrolling, the actions pin to the bottom of
  the frame when content runs longer, and only the card scrolls (the frame's page never does, so a swipe
  past the end leaves no blank band).
- `dev.fixwright/deviceClass`: `large | small | phone | voice`. Authoritative when sent; without it the
  class comes from `containerDimensions` and the view logs one console warning.
- `dev.fixwright/now` (optional): the host clock as an ISO time, for a simulated clock. Drives "tomorrow
  at 7:00 AM" and the next check refresh. Read as an anchor: the last value plus the time since it
  arrived, anchored again on each new value, so a host may tick it once a minute.
- `dev.fixwright/focus` (optional): the person's words behind the screen, such as "Why did every plug turn
  on at 3 a.m.?". A finished repair (no step pending or failed) lists first the steps for the device those
  words name ("hallway lamp"), then those for the kind of device they name ("plug"), each group in step
  order. Plans keep step order: their numbers are the order the fix runs in.
- `dev.fixwright/stepLabels` (optional): clearer labels the host knows from the home, keyed
  `${plan_id}|${label}`, one per step with that label in step order, for two devices that share a name
  ("Set Living Room Light (the Floor Lamp) to remember its last state"). Read defensively.
- `dev.fixwright/hubLabel` (optional, at most 48 characters): the header tag for a result from a real hub.
  Without it a real Home Assistant is tagged "Real Home Assistant"; apps/host sends "Real Home Assistant,
  demo devices" for its test hub, whose devices are fixtures. A simulated house is always "Simulated home".
- Next steps instead of dead ends. When the host takes `ui/message`, a "Can't
  tell" verdict without a fix offers "Check again" (asks the conversation "Check the Porch Plug again.")
  and a failed morning check ("It's acting up again") offers "Diagnose" first, then Undo ("Look at the
  Hallway Lamp again." in a flow that knows the device, else "Why is it acting up again?").
- Probe chips: a probe that found the problem is amber with an alert mark ("found a problem"), never a
  red cross; red stays for repairs that did not work.
- Keep with next: in a portrait or growing card that scrolls, a section heading never sits at the bottom
  edge with none of its content in view (`keepHeadsWithContent`, measured again when the card resizes). The
  visual suite checks every phone frame for it.
- Diagnosis bars show whole percents that add up to exactly 100 (largest remainder rounding). The share
  no named cause holds (the `unknown` cause plus whatever the list leaves out) is one bar labelled
  "Something else"; at most three bars, so smaller causes fold into it. A share that rounds to 0% is left
  out (the leader always stays).
- The host should ask the person to approve `repair_apply` and `undo` before forwarding them. On a "no",
  apps/host's convention is to resend the view's latest
  result as tool result and then deny the call with "Not approved. Nothing changed." The views keep the
  screen as it was (the plan's Not now and device name, the carousel's cards and Fixed marks) and show
  those words as a calm status line, not an error; the same words without a resend read the same way.
  A denial in other words shows "That didn't go through. You can try again, or just ask me out loud."
- A result identical to the screen showing is a resend and never cancels the call in flight; a newer
  version of the showing screen (same plan, repair or diagnosis id) keeps its place; anything else
  starts a new screen.
- Optional: `message` (ui/message: a carousel card for a finding Fixwright cannot fix says the person's
  request in the conversation; without it that card shows "Needs your hands"), `updateModelContext` (the
  view reports what was done by touch), `requestDisplayMode` (expand control, shown only when
  `fullscreen` is available).
- Test hook: `window.__fixwrightView` in the view frame (`surface()`, `state()`, `hostContext()`).

## Build and test

From the repo root:

```
npm run check -w @fixwright/views        # tsc (src, then scripts and tests), build, 152 unit tests,
                                         # then 247 Playwright tests in headless Chromium (130 s on 18 Oct 2026)
npm run check:fast -w @fixwright/views   # the same without the browser suite
npm run test:visual -w @fixwright/views  # build, then the 247 Playwright tests only
npm run harness -w @fixwright/views      # manual: http://localhost:8725/ (toolbar: state, theme, device,
                                         # mode, container fixed or flex)
node apps/views/scripts/write-fixtures.ts  # regenerate apps/views/fixtures from the builder
```

`npm run check` (and so the root `npm run check`) includes the browser suite, so CI needs the Playwright
Chromium (`npx playwright install chromium`).

The browser tests start their own servers, 8725 (host page) and 8726 (sandbox proxy, a second origin with
the MCP Apps default CSP), inside the test process and close them at the end. If that pair is busy (a
second run in parallel) they take the next free pair: 8727 and 8728, 8723 and 8724, 8721 and 8722. Ports
stay inside this module's range, 8721 to 8729.

## Layout

```
src/stepper.ts, src/carousel.ts, src/repair-card.ts   entries (zod jitless preset imported first)
src/ui/runtime.ts      App wiring: connect, surface, theme, root zoom, tool calls, focus, paint timing
src/ui/context.ts      hostContext to surface (device class, scale, canvas), pure
src/ui/payload.ts      tool result guards (no zod at runtime), pure
src/ui/screens.ts      payload to panel view model (labels, numbers, tool calls), pure
src/ui/checkup.ts      checkup to carousel view model, the words a card asks with, host results while
                       the carousel is open (carouselFromHost), pure
src/ui/flow.ts         diagnose, answer, verdict, plan, repair and undo transitions, host resends
                       and newer versions (isResend, fromHost), declines, pure
src/ui/format.ts       percent, household time, relative day, no break glue for units and dates, pure
src/ui/fold.ts         long step lists: what to fold and the row's words (pure), the fit pass (DOM)
src/ui/components.ts, panel.ts, carousel.ts, states.ts, icons.ts, dom.ts   DOM, no innerHTML; panel.ts
                       also holds the decision card's landscape fit pass (fitDecision)
src/ui/tokens.css, base.css, panel.css, carousel.css    tokens from the design guide, light and dark
scripts/build.ts       esbuild, single file inline, manifest, sizes; scripts/zod-english-only.ts plugin
scripts/view-fixtures.ts, write-fixtures.ts   the views' extra fixtures, validated by protocol schemas
test/unit/             vitest, pure layers, fixtures, build output; ask-routing.test.ts runs the card's words
                       through packages/router (imported by path, test only)
test/harness.html, test/harness/   host stub (AppBridge, null client, fixture router, apps/host's decline
                       convention, ui/message log), sandbox proxy, servers
test/visual/           Playwright: render matrix (resting and outcome states) and interactions;
                       last-render-report.json and last-outcome-report.json hold the last run's layout measurements
```

## Fixtures

The protocol's golden path fixtures (`packages/protocol/fixtures`) plus twelve view fixtures in
`fixtures/` (a "no" answer, likely and can't tell verdicts, a five finding checkup, the plans and
applies the carousel and the explanation open, a retried apply whose first step had already run, a
rolled back repair, a regressed check). Only fixable findings have a plan, as with the engine, which
answers repair_plan with no_fix for any other finding.
The five finding checkup's power on card is the explanation's own issue, so it opens the 14
device plan. The retried apply has the engine executor's shape for a step whose idempotency key already
ran (skipped, "Already applied"). The power on
fix (`repair_plan_power_on`, `repair_apply_power_on`) has the shape @fixwright/engine plans for the
golden path house: 14 devices, one step, diff row and read back each, a next check at 7:00 the next
morning; `repair_plan_protected` adds a protected device line, the worst case for the inline fit. They
are design and test data: probabilities, ledger seqs and times are illustrative, not measurements, and
every one is `source.simulated: true`, which the views label "Simulated home". A result from a real Home Assistant
(`source: { adapter: 'home-assistant', simulated: false }`) is labelled "Real Home Assistant" instead, or the
host's `dev.fixwright/hubLabel` ("Real Home Assistant, demo devices" from apps/host). The visual harness
pins its ports with `VIEWS_HARNESS_PORTS=host,sandbox` when a run must stay in another range.

## Measured (17 Oct 2026, headless Chromium 153 from Playwright 1.63.0)

- Size (18 Oct 2026): stepper 400,760 bytes (110,700 gzip), carousel 409,455 (112,835), repair card 400,485 (110,587).
  An early prototype view was 608,934 (132,664 gzip). Build of all three plus the harness: 135 to 144 ms over
  the last runs.
- Tool result sent by the host to first paint in the view (double rAF): min 16.4 ms, median 24.9 ms,
  max 34.4 ms over 210 renders; carousel first item median 26.1 ms, max 34.4 ms over 34 (budget 500 ms).
- Lowest text contrast: 5.54:1 dark, 4.86:1 light, over 3,748 text element checks.
- Outcome states on fixed landscape screens (28 matrix renders plus 108 in the sweep): card overflow 0,
  bottom padding at most 0.6 px (the guard allows 1), nothing below the decision card. The fit needed no
  step in 77 of the 108 sweep renders, one step in 21, two in 8 and three in 2; the fourth step was never
  needed. With the fit switched off, 18 of the 28 matrix renders fail (up to 44 px of overflow).
- apps/host's phone frame (50 renders): frame and card at most 480 px, 46 of them scroll inside, all 70
  controls reachable by scrolling and hit testing, the pinned actions on screen with nothing scrolled in
  38 of 38 screens that have them, and page overflow 0 in all 50.
- `npm run check -w @fixwright/views`: 2 min 16 s on the last run (unit 0.3 s, browser 131 s).

## Integration notes

- Server: an explanation's "Show the fix" calls `repair_plan {explanation_id}`, which
  @fixwright/engine's `planRepair({kind: 'explanation'})` serves directly. A diagnosis calls it with
  `{diagnosis_id}`, a checkup card with `{issue_id}`, and only for a finding with `fixable: true`.
- Engine and protocol: still open is what `action_label` means on a finding that is not fixable. An
  optional `ask` field with the words to send would settle it. Until then the views build the words from the
  title (`askWords` in src/ui/checkup.ts).
- Host: nothing more required. apps/host follows the decline convention and sends the clock ticks
  described above, and already routes a view's ui/message like the
  person's words, behind its approval sheet for anything that changes the house. The growing phone frame
  is handled in the view. The views also work with `availableDisplayModes: ['inline']`: no expand
  control is shown, and long lists open in place.

## Versions

No new dependencies. Runtime: @modelcontextprotocol/ext-apps 2.0.3, @modelcontextprotocol/core 2.2.0,
zod 4.6.5 (classic API through ext-apps; only the English locale is bundled). Build and test, from the
workspace root: typescript 6.0.3, esbuild 0.28.2, vitest 5.0.2, playwright 1.63.0 (preinstalled
Chromium), @types/node 22.20.4. Node 22.22.1 runs the `.ts` scripts directly.
