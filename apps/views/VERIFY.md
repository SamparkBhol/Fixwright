# VERIFY: @fixwright/views

`npm run check -w @fixwright/views` runs both suites: tsc on `src` (DOM, no Node types), tsc on scripts
and tests, the build, 152 vitest unit tests, then 247 Playwright tests in headless Chromium 153
(`npm run check:fast` skips the browser suite; `npm run test:visual` runs only it). Last run, 18 Oct 2026
(copy pass): 152 of 152 and 247 of 247 passed, the browser suite in 130 s.

## Unit (test/unit, 135)

### Surface (context.test.ts, 14)
- [x] 1280x800 large resolves to one root zoom of 1.667 over a 768x480 canvas; 960x480 small keeps
      scale 1 on a 960x480 canvas; a phone is portrait at scale 1.
- [x] `dev.fixwright/deviceClass` wins over the size; without it (or with an unknown value) the class is
      derived from `containerDimensions`.
- [x] A flexible container (maxHeight only) leaves the height to the content and keeps the cap, in CSS px
      and in canvas px (1280 wide with an 800 cap: zoom 1.667, cap 480).
- [x] apps/host's Phone, `{width: 358, maxHeight: 480}`, resolves to a capped portrait phone, with or
      without the device class; fixed containers and a zero cap carry no cap.
- [x] Display mode, fullscreen availability, locale, time zone and the optional host clock are read
      from the context, with safe defaults when absent.

### Formatting (format.test.ts, 8)
- [x] Percent rounding and clamping; household time in the host's zone with a no break space before AM
      or PM; today, tomorrow, yesterday, weekday and date phrasing across a UTC date line; an unknown
      zone does not throw; Wi-Fi stays on one line.
- [x] A number keeps its unit ("-82 dBm", "120 V", "5 GHz") and a day keeps its month ("3 October",
      "October 3"); "9 times", "14 Watts", "May I" and "12 Mayflies" are left alone.

### Payload guards (payload.test.ts, 30)
- [x] Every protocol fixture and every view fixture is classified as the view kind its tool renders;
      protect_device, switch_device and the problem output are not rendered.
- [x] Broken fields (a probability that is not a number, an unknown outcome or state, a read back that is not a string) are
      rejected; a ProblemOutput keeps its speech and retry hint; text only errors and empty errors get
      a safe line; unknown shapes are reported, not drawn.

### View models (screens.test.ts 19, checkup.test.ts 15, hints.test.ts 10)
- [x] Asking: "Needs you", the question as the hero line, Yes (primary) and No calling
      `diagnose_answer` with the diagnosis id, question id and answer; probe chips and the three bars
      in order with the leader first.
- [x] Confirmed: 94% lead bar in the pass tone, the claims as the finding, "Show the fix" calling
      `repair_plan {diagnosis_id}`, the human probe marked, evidence counts per claim.
- [x] Likely, can't tell (guided, no action) and multiple choice questions.
- [x] Bars add up to exactly 100 (largest remainder): the step 3 verdict reads 94%, 5% and "Something
      else" 1% (it read 95, 5 and 1 before); the residual (the unknown cause plus what the list leaves out)
      is labelled "Something else"; at most three bars, smaller causes fold into the residual; a share that
      rounds to 0% is left out, the leader always stays; with only the unknown cause the residual leads at
      100%. `apportion` always sums to 100 in whole percents, ties go to the earlier share, a list over 1
      is scaled down.
- [x] Step hints (hints.test.ts): `readHints` reads dev.fixwright/focus and dev.fixwright/stepLabels and
      drops malformed values; a finished repair lists the devices the person's words name first ("every
      plug": the five plugs of the power on fixture, then the rest in step order), a plan and a repair that
      stopped partway keep step order; each step with a shared label gets its own clearer label in step
      order, and labels for another plan are not used.
- [x] Explanation: timeline in household time (3:11:58 AM), the fix offer calling
      `repair_plan {explanation_id}`; without a fix the claims carry the card.
- [x] Plan: diff lines, pending steps, "Fix it" calling `repair_apply` with plan id and confirm token,
      "Not now" only when there is something to go back to, protected devices listed, expiry time; the
      14 step power on plan keeps all 14 steps in the model (only the view folds).
- [x] Repair: read back per step, "Tomorrow at 7:00 AM" next check, Undo with the repair id;
      confirmed and regressed show how the next check went; rolled back and undone offer no Undo; a retried
      repair whose first step was "Already applied" (skipped) does not claim every step read back; on its
      own card its chip carries the evidence instead, "2 read back, 1 skipped", and a
      failed step drops it back to the state chip.
- [x] Checkup: "Three things need a look", "2 urgent", five findings capped at five and sorted by
      severity, a fixed finding updates the counts, a healthy home reads "All clear".
- [x] Only a fixable finding calls `repair_plan {issue_id}`, checked over every finding in the fixtures
      plus the engine's unprotected load. A labelled finding that is not fixable ("Show me how",
      "Protect it") asks the conversation instead (`ask`, no tool); without ui/message from the host it
      has nothing to press; once asked, the card says so in place of the button.
- [x] The words a card sends: "Show me how to fix this. <title>.", "Protect the aquarium filter."
      (an acronym such as "TV stand" keeps its capitals), "Help me fix this. <title>." otherwise.
- [x] Results the host sends to an open carousel (`carouselFromHost`): the open plan sent again is a
      resend that changes nothing; a newer version of it, or its repair, updates it in place under the
      same title; a plan for another finding on the cards opens that finding; one for no finding, or a
      diagnosis, leaves the cards; the same checkup again keeps the Fixed marks (dropping ones no longer
      listed) and the open plan, a new checkup starts over; without cards, a payload it cannot show says
      so and a problem shows its words.

### Routing of the card's words (ask-routing.test.ts, 4)
Through packages/router, the router apps/host uses for a view's ui/message (imported by path, test only):
- [x] Every labelled finding that is not fixable asks, and nothing else does.
- [x] "Show me how" on the Wi-Fi finding and on an expired Hue sign in gets back "I can't fix that one
      by myself." plus that finding's own detail.
- [x] "Protect it" routes to `protect_device {device: 'aquarium filter'}` (the host asks the person first).

### Folding long step lists (fold.test.ts, 6)
- [x] Lists under 5 never fold; a 14 step repair keeps the first steps and folds the rest from the end;
      failed and put back steps never fold; folding a single step does not happen.
- [x] The fold row's words: "11 more steps, all read back", "all done" without read backs, "11 more
      steps" for a plan, "4 more steps: 2 done, 1 skipped, 1 to do" when mixed, "1 more step".
- [x] Mode: measured fit on fixed landscape screens, keep 3 where the height is open, none in
      fullscreen.

### Flow (flow.test.ts, 9)
- [x] The golden path through the pure state: answer, verdict with bars animating from 55/38/7 (the third
      bar is "Something else"), dry
      run, Not now back to the verdict, apply, undo, keeping the device name throughout.
- [x] A failed action keeps the screen, shows the problem, frees the buttons; a payload the view does
      not render is reported; the next check refresh is asked only when the check is due.
- [x] A declined approval is a calm note ("Not approved. Nothing changed."), not an error, the screen
      stays and the next action clears it; a success is never turned into a decline; the host's wrapped
      error message ("MCP error -32603: Not approved. Nothing changed.") is recognised, other words are not.
- [x] The exact screen resent is recognised (`isResend`); a newer version of it is not.
- [x] `fromHost`: a newer version of the same plan keeps Not now (its way back) and the device name and
      clears the pending action; another screen starts over; a newer result for the same diagnosis moves
      the bars from the old values.

### Fixtures (fixtures.test.ts, 17)
- [x] Each of the 12 view fixtures matches its protocol output schema, passes the speech rules, is
      marked simulated and is byte for byte what `scripts/view-fixtures.ts` builds.
- [x] Plans and applies chain by plan id. Every fixable checkup finding has a plan the harness router
      can find, and no finding that is not fixable has one (the engine answers no_fix for those); the
      explanation (by explanation id) points at its plan.
- [x] The retried apply has the engine executor's shape: the step that already ran is skipped with
      "Already applied", the rest are done.
- [x] The power on fix has the engine's shape: 14 steps and 14 diff rows, one diff line, every step done
      with "Set to previous", next check at 7:00 the next morning.

### Build output (build.test.ts, 16)
- [x] Each `dist/*.html` is one document: one inline script, one inline style, no external script,
      stylesheet, @import, font file or remote url() in CSS; it has the stage, app and live region.
- [x] Each is under 420,000 bytes and 115,000 gzip, and `dist/manifest.json` has its exact size and
      sha256.
- [x] No Alexa or Amazon text anywhere in the built views.
- [x] The inline script contains no "</script" and no "<!--", and still parses; the escape keeps
      strings, templates and regexes with the u flag meaning the same (the escaped code is run and compared).

## Browser (test/visual, 247)

Every view is loaded the way MCP Apps specifies: host page on one origin, sandbox proxy on a second
origin with the restrictive default CSP, the view written into the inner frame, then ui/initialize,
tool input and tool result over the real ext-apps bridge. The harness host advertises ui/message and
denies a declined approval the way apps/host does by default (policy `decline: 'convention'`: resend the
view's latest result, then deny with "Not approved. Nothing changed."), or with the same words only
(`'words'`), or with other words (`'plain'`).

### Render matrix (render.test.ts, 210)
18 resting states (diagnose asking, confirmed, likely, can't tell, explanation, plan, the engine's 14
step power on plan, the same with a protected device, a failed call, checkup of three and of five,
repair applied, the 14 step power on repair, a retried repair, confirmed, regressed, rolled back,
undone) and 7 outcome states, reached by pressing through the real bridge so the line the last action
left is on screen: Yes failing on the question (host error), "Show the fix" failing on the
confirmed verdict (the server's problem, and a host error) and on the likely verdict (host error), the
stepper's plan declined the apps/host way, and the carousel's 14 device plan declined the apps/host way
and denied in other words. All 25 in dark and light at 1280x800, 960x480 and 390x844, again in
apps/host's growing phone frame (358 wide, capped at 480), plus five fullscreen states in both themes.
Each:
- [x] No console errors and no page errors in any of the three frames (CSP violations would be errors).
- [x] No request made by the view frame.
- [x] No horizontal overflow and no element outside the viewport except inside a scroller.
- [x] Every control at least 48x48, both rendered and in authoring units; every control has a name.
- [x] Every text element at least 4.5:1 against its composited background, from computed styles.
- [x] No text clipped by its container without an ellipsis.
- [x] Landscape inline content fits the canvas: no scrolling, nothing in the bottom padding, nothing
      hanging below the decision card's border, the card never scrolled, including the 14 step plan and
      repair (long lists fold) and every outcome state (the decision card steps its type down until it
      holds its sentence, the outcome line and its buttons; `fitDecision`). Checked to fail without the
      fit: with `fitDecision` switched off, 18 of the 28 outcome renders at 1280x800 and 960x480 fail, with
      up to 44 px of card overflow and 40.1 px in the bottom padding, the overflow the fit was written to remove.
- [x] In the growing phone frame: frame and card at most 480 px; every control can be scrolled into view
      and is hit at its center; where actions are pinned, they are on screen with nothing scrolled; and
      the frame's page cannot scroll at all (page height minus frame height at most 0, so a swipe past
      the card's end has nothing to drag). Checked to fail without the fix: with the card unpositioned,
      the stepper cases fail and the first three failures report 11, 71 and 93 px of page overflow.
- [x] The tool result is painted within 500 ms (carousel: the first item).
- [x] Root zoom is 1.667 on 1280x800 and 1 elsewhere.
- [x] A screenshot per render in `screenshots/`.

### Interactions (interact.test.ts, 37)
- [x] Golden path in the stepper: Yes shows "Checking" with the other button blocked, then Confirmed and
      94%; the exact `diagnose_answer`, `repair_plan`, `repair_apply` (approved) and `undo` (approved)
      calls with their arguments; Not now goes back without a call; focus moves to the new primary
      action; the touch result reaches the model context.
- [x] No leads to the next question with power on top.
- [x] Declining Fix it the apps/host way (resend, then deny): the plan stays, titled "Hallway Lamp",
      with "Not now" and the chip "Nothing changed yet"; a calm `role="status"` note reads "Not approved.
      Nothing changed."; no alert; Fix it works again; Not now still returns to the verdict; the second
      try applies. The same words without a resend give the same note. A host that denies in other
      words gets "That didn't go through. You can try again, or just ask me out loud." and the retry works.
- [x] A server problem shows the server's sentence and the retry succeeds.
- [x] The explanation's fix plans with `repair_plan {explanation_id}`, shows the fourteen device change
      and applies it ("Set to previous" read back).
- [x] Long step lists: folded to what fits with "N more steps, all read back" and the card not
      scrolling; the row opens all 14 in place, only the evidence column scrolls, focus stays on the row,
      the first folded step comes into view; a host relayout keeps it open; Enter closes it and Undo is
      still in view. A new result starts folded; failed and put back steps are never folded away.
      Fullscreen lists all 14 and Fix it stays in view after scrolling to the end.
- [x] apps/host's phone frame, in a touch context (`hasTouch`, Playwright `tap()` sends touch events):
      the question and Yes are in view at 480 px, then Yes, Show the fix, Fix it and Undo are each in view
      and work when tapped.
- [x] apps/host's phone frame: twelve real mouse wheel turns over the 14 step repair scroll the card to
      its end, the page's own scroll stays at 0 with no overflow, and the card's bottom edge stays on the
      frame's bottom edge (no blank band).
- [x] Carousel: Planning on the pressed card, the plan titled with the finding, apply, Back to checkup,
      the card now Fixed, the counts updated; Back from a plan makes no call.
- [x] Carousel decline, the apps/host way: after fixing the first finding, the power on plan is opened and
      Fix it declined; the plan stays under its finding's title with the calm note and no alert; Back
      shows all five cards with the first still Fixed and the declined one still offering its fix; the
      calls are exactly plan, apply (approved), plan, apply (declined).
- [x] "Show me how" on the Wi-Fi finding (not fixable) sends the ui/message "Show me how to fix this.
      Kitchen plug dropped off Wi-Fi 9 times today.", calls no tool, and the card then reads "Asked in
      the conversation".
- [x] A failed card action at 1280x800 and at 960x480: the server's sentence stands where the detail
      was; the card is not scrolled inside and does not overflow; its head, title, message and button are
      all inside it, and the button keeps the card's bottom padding like its neighbours; the retry shows
      the detail again while it runs.
- [x] Every decision card holds the line its last action left, at 1280x800 and at
      960x480: 16 screens (the question, the question after a no, the confirmed and likely verdicts, the
      explanation, four plans, five repair cards, the carousel's rename and power on plans) times every
      way their action can end (the server's problem and a host error for asking screens; those two plus
      a decline the apps/host way and a denial in other words for commit screens), 108 outcome renders.
      Each has no card overflow, nothing in the bottom padding or below the decision card, the card not
      scrolled, no clipped text, 48 px targets and 4.5:1 contrast. The fit steps each one needed are
      written to `test/visual/last-outcome-report.json`.
- [x] Restoring focus never scrolls a fixed landscape card: with the likely
      verdict's text forced far past what any fit step can absorb, a failed "Show the fix" pressed from
      the keyboard leaves the card overflowing but at scroll 0, eyebrow and chip in place, and focus
      still on the button for the next Enter.
- [x] Back from a repair whose card is now Fixed puts keyboard focus on that card (it has no button
      left), with a visible ring and the card in the row's view, not on card one's button.
      Back from a plan puts it on that card's own button, the fifth card scrolled into view.
- [x] Three cards at 1280x800: no title is cut, every detail gets at least 3 lines, the battery card has
      no button and says "Needs your hands", and the row (which fits) takes no tab stop. Five cards: the
      row is focusable with a visible ring and ArrowRight scrolls it.
- [x] Repair card: declining Undo the apps/host way keeps the card, its chip and a working Undo, with the
      calm note and no alert; Undo with the repair id; moving the host clock past the next check fetches
      the next check result once (`refresh_view`) and shows "Check passed".
- [x] Theme, device class and display mode change live; the size fallback warns; the expand control
      requests fullscreen and shows the details, then returns inline; the voice class shows the spoken
      reply word for word; the waiting state names the device.
- [x] Keyboard: Tab reaches Yes with a 3 px focus ring and Enter answers; screen reader text for probe
      outcomes; every svg is aria-hidden; reduced motion leaves zero running animations; with motion,
      the lead bar starts from the previous 55%.

## Checked by hand (not in the suite)
- Screenshots read after the latest changes: the outcome states at 1280x800 and 960x480 (the likely
  verdict with a host error, the confirmed verdict with a host error, the question with a failed Yes,
  the carousel's declined power on plan, Fix it and Back inside the card's rounded edge), the same
  states on the phone with the outcome line above the pinned actions, and the retried repair card with
  its "2 read back, 1 skipped" chip.
- Earlier: the declined plan in the stepper and in the carousel, the asked card, the failed card at both
  sizes (button aligned with its neighbours), the phone frame scrolled to its end (no band), and
  "-82 dBm" wrapping as one piece on the small light carousel.

## Not covered here
- Real Echo hardware, VoiceView, screen magnifier and color filters (no device available).
- The real Fixwright server and host simulator (other modules). The harness answers tool calls from
  fixtures; its flexible phone container and its decline convention copy apps/host's behaviour
  (src/view-host.ts) rather than running apps/host. The words a card sends are checked against the real
  packages/router, not through apps/host's page.
