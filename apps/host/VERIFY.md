# Host simulator: what the tests prove

`npm run check -w @fixwright/host` runs both suites below (plus `tsc` on the browser code and on the
Node side).

## Unit (`test/unit`, vitest, Node)

- [x] Mock server over real HTTP with the real SDK client: negotiates 2025-11-25, lists the 11 tools with
      ext-apps `_meta.ui` (resourceUri, `refresh_view` app only), serves the three views as
      `text/html;profile=mcp-app`, and every result passes the protocol output schemas (or ProblemOutput).
- [x] Mock golden path with chaining ids; a question answers once (`question_answered`); a plan needs its own
      token (`token_mismatch`) and applies once (`plan_used`); no and unclear answers ask again; the suggested fix
      plans and applies; unfixable findings refuse (`no_fix`); the strip refusal; protect.
- [x] Mock routes: CORS only for the host origin (preflight 204, other origins 403 without ACAO);
      households are separate; the clock jump confirms an applied repair and returns the push text
      "Hallway lamp answered all 9 commands overnight. Repair confirmed."; after it, refresh_view for that
      repair returns the confirmed status (the protocol's refresh_view fixture speech and checks, valid as a
      repair_status output); /assistant/route uses the router;
      /health; the protocol version header on every MCP POST after initialize.
- [x] Trace classification and request/response pairing per lane and session; store cap.
- [x] Latency: nearest rank p50/p95, per method and per tool, unanswered requests ignored, lanes separate.
- [x] View policy: model only and unknown tools refused; repair_apply and undo need approval; reads and
      diagnose_answer do not; visibility default; resourceUri incl. the legacy flat key; a uri outside ui:// refused.
- [x] One approval rule (`requiresApproval`) for calls and messages: exactly protect_device, repair_apply,
      switch_device and undo of the 11 tools, plus any tool the host does not know.
- [x] Approval sheet wording per change (apply with the plan's own diff lines only when the plan ids match,
      undo, switch on or off, protect and unprotect), the "The screen sent ... for you." note for view
      messages, long view text shortened, no em dash.
- [x] Clock: follows real time, pins, and a plain reading of the house time (`/demo/state`) never replaces a
      pin, while a move (a `/demo/clock` jump, a reset) carries a pinned clock with it; an answer asked for
      before a later pin or unpin is too old and is dropped (`mark()` stamps), so a pin made while `ready()`
      was still reading the house time holds.
- [x] Config defaults and overrides; household storage round trip, junk rejected,
      one token per server origin (a `?server=` switch never reuses another server's household), and no
      throw when storage is missing or blocked; speech time estimate; suggestion chips per state; F1 to
      F10; device sizes; `isDeviceClass` rejects inherited keys (`toString`, `__proto__`).
- [x] The mock's follow up question for "no" and unclear answers keeps the fixture's probes and
      hypotheses exactly (no invented numbers).
- [x] A tap on a view is worded as the person's turn per tool ("Yes.", "Fix it.", "Undo it.", "Show me the
      fix."); `refresh_view` is a background call (app only), never a turn.
- [x] `dueRepairRef`: a repair shown again is refreshed only when it is `applied` and its next check time
      has passed on the host clock.
- [x] While the approval sheet is open the suggestion chips are its two answers ("Yes, apply it", "Not now");
      while a plan waits they include "What will it change?", which packages/router answers with the plan's
      own diff lines.
- [x] `clearerLabels` (step-labels.test.ts): the floor lamp bulb renamed Living Room Light gets "(the Floor
      Lamp)" next to the Hue group of that name; the old hallway copy that no longer exists shares no name;
      two shared name steps in one plan each get their own note in step order; devices in different rooms
      get the room; no home data, no labels. `readHome` reads /demo/state rows and skips malformed ones.
- [x] `pushCaption`: a push that landed after the last turn is what the captions show, until the next turn or
      words being spoken.

## End to end (`test/e2e/golden.e2e.ts`, Playwright 1.63 + headless Chromium, three origins)

Host `http://localhost:8711` (dist/), sandbox `http://127.0.0.1:8712` (the sandbox Worker's fetch handler),
mock server `http://127.0.0.1:8713`.

- [x] The clock pinned right after `ready()` (17:42Z, deliberately not the mock house's START, 17:20Z) holds:
      the snapshot and the idle screen read 10:42 AM, and every `dev.fixwright/now` sent to the views in step 1
      is the pinned value, never START.
- [x] Connects as a real MCP client: negotiated 2025-11-25, 11 tools, honesty banner with the server URL;
      every MCP POST came from the host origin with `Bearer hh_mock...` from `/demo/household`; no GET reached
      the server (local 405); the three views were read once at connect (prefetch).
- [x] 1. "Alexa, ask Fixwright why the hallway lamp ..." gives diagnose, `needs_answer`, spoken question; the stepper
      renders two frames deep on the sandbox origin and cannot read `window.top`. Exactly one frame is
      `active` the moment say() resolves. The view got the pinned host clock as `dev.fixwright/now`.
- [x] 2. Voice only: same conversation and pending question, no iframe at all, "Yes, it blinked." gives
      diagnose_answer spoken ("The lamp works. ..."), ring state speaking.
- [x] 3. Back to the large display: the verdict view returns; "Yes." gives repair_plan with a pending plan;
      exactly one active frame right after say() (the replaced one drops `active` at once).
- [x] 3b. A forged `ui/message` "yes" from inside the view while the plan waits opens the approval sheet
      ("Apply this fix?", "The screen sent “yes” for you.") and makes no repair_apply call; `approve(false)`
      keeps the plan pending, speaks "Okay. Nothing changed.", logs `approval asked` and
      `approval declined` with `via: ui/message`, and the view keeps its Fix it button. While the sheet is
      open the captions show "Sent by the view: yes" over "Apply this fix?".
- [x] 4. "Fix it" in the view: the tap is the person's turn ("Fix it.", via tap, in the captions as "You
      tapped"), the sheet's question is spoken and captioned, the chips are its two answers, and the
      approval prompt shows the plan's diff lines; "Yes, apply it" gives one
      repair_apply over MCP, the view receives structuredContent with `state: applied`, spoken read back.
      `idle()` alone (no polling) waits for the view started call to finish.
- [x] 4a. A forged `ui/message` "undo that" opens "Undo this repair?"; a second forged message "yes" while it is
      open is dropped (`view message ignored`) and the sheet stays; a spoken "No." answers it (intent
      decline, "Okay. Nothing changed.") gives no undo call.
- [x] 4b. "Undo" in the view gives approval; "Not now" makes the host send again the view's latest result as
      `ui/notifications/tool-result`, then denies the call ("Not approved. Nothing changed."); no MCP call is
      made; the view keeps its Undo button and shows no error line; a forged view call to the model only
      `switch_device` is refused before any network call.
- [x] 4c. Voice only and back after the view applied the fix itself: the screen is repair-card.html from the
      view's own repair_apply (viewTool repair_apply) with Undo, "Fixed and checked", no "Nothing changed yet"
      and no Fix it button; with the real views it reads "Tomorrow at 7:00 AM", relative to the pinned host clock.
- [x] 5. Break my house: next morning 7:00 gives the push "Hallway lamp answered all 9 commands overnight. Repair
      confirmed.", the host clock syncs to 2026-10-16T14:00Z; the push shows on the display itself; the views
      get `dev.fixwright/now` 2026-10-16T14:00:00.000Z, the repair card calls refresh_view (no approval) and
      shows "Repair confirmed" with no "tomorrow"; F8 "Break it" gives an active fault chip and the household's server
      state. The banner never overlaps the view slot (page coordinate boxes): it fills the caption band on the
      large and small displays, in place of the caption line, and drops over the chat on the phone
      (screenshots 06, 17, 18). Tapping it opens the repair it names as the person's turn ("Show me that
      repair." via tap gives repair_status) and the banner leaves; "Did the fix hold?" gives repair_status.
- [x] 6. "Why did every plug turn on at 3 a.m.?" gives explain_event spoken; "Yes." gives plan; "Yes." gives apply by voice,
      no approval prompt (the spoken yes is the approval).
- [x] 7. Small display checkup carousel, then the phone: conversation intact, carousel rendered again, every
      chat bubble shows its whole sentence.
- [x] 8. "Turn off the living room power strip." is refused with the aquarium filter line, spoken.
- [x] 9. Visual Trace: initialize request and response both badged 2025-11-25, tools/list, diagnose_answer
      request and response with structuredContent (expanded JSON), view bridge lane present; Latency rows
      with p50 and p95 for initialize and tools/call diagnose.
- [x] 10. Light theme; About. 11. Reset clears the view, ids and pushes; 5 default faults active; no em dash on screen.
- [x] The large display has one width across seven sampled turns (idle, diagnose, plan, applied, after
      the phone, checkup); it never rescales between turns.
- [x] A second page: a view's "yes" approved on the sheet with `approve(true)` resolves after exactly one
      repair_apply, clears the plan and shows the repair card.
- [x] A third page: tapping Yes on the stepper is the person's turn ("Yes.", via tap) followed by the
      verdict; voice only and back shows the verdict, with no Yes or No buttons; tapping Fix it opens the sheet,
      which stays open and fits the screen on the small display and the phone (screenshots 15 and 16) with room
      in its footer: the small print clears the buttons by 16 px or more, the two answers share the row as equal
      halves at least 44 px tall, and the row clears the card's bottom edge (32 px on the phone); a typed
      "yes" answers it: the sheet closes, exactly one repair_apply, the plan is spent, and a late
      `approve(true)` sends nothing more; voice only and back shows repair-card.html with Undo; on voice only
      the next morning push shows under the speaker (screenshot 14), and back on the display the due repair
      is refreshed to "Repair confirmed".
- [x] At 1280×720, 430×900 and 390×844 the honesty banner is visible with the full server URL (never
      clipped) and the page does not scroll sideways; at 1280 the four console tabs fit (About is in the top bar).
- [x] `?router=server` routes through `POST /assistant/route`.
- [x] Zero console errors in all frames, zero page errors, zero failed requests across the whole run (except
      the lines caused by the test's own forged request ids 9001 to 9005, filtered by id).
- [x] Mutation check (manual, first pass): with the view message approval gate removed, steps 3b, 4a and
      the test that approves by message fail.
- [x] Mutation check (manual, second pass), each fix reverted on its own: view results not remembered makes 4c, 5
      and the third page fail; a spoken yes not sent to the sheet makes 4a, 4b and the third page fail; no
      `dev.fixwright/now` makes 1, 5, the width test and the third page fail; the replaced frame keeping
      `active` until its teardown answer makes 3, the width test and the third page fail.
- [x] The whole suite also passes at 1920×1080 and 1280×720 (`E2E_VIEWPORT`) and with the placeholder views.
- [x] Screenshots for each device written to `screenshots/`.
