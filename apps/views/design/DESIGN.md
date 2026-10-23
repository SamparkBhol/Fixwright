# Fixwright views: design decisions

Every choice below names the rule it follows in the Alexa+ MCP add-on design guide
(https://developer.amazon.com/docs/alexaplus/add-ons/mcp-addon-design-guide-overview.html, read on 14 October
2026, quoted here only in short passages). "VF" is Visual foundations,
"LR" Layout and rendering, "CP" Components and patterns, "DM" Display modes, "A11Y" Accessibility,
"OV" the Introduction with the four principles, "TCX" Test your add-on CX.

Measured numbers come from `npm run test:visual` (`test/visual/last-render-report.json`) and
`dist/manifest.json` on 15 Oct 2026.

## 1. Patterns: only Card and Carousel

| View | Pattern | Why |
| --- | --- | --- |
| stepper | Card | One entity (the device under diagnosis) with one clear action at a time (CP Card: "one result warrants individual focus"; "Reserve CTAs for actions that complete a task or goal, or that move the user forward"). Its rows (probes, steps, timeline) are List style homogeneous items. |
| carousel | Carousel, List on a phone | Checkup findings are homogeneous items to scan side by side (CP Carousel). On a portrait phone the same items stack vertically, because a taller than wide design renders as a vertically scrolling Card viewport (LR "Orientation determines viewport"). |
| repair-card | Card | One repair, its read back per step, one action (Undo). |

No Map (no location data) and no invented pattern (CP: "Don't invent alternatives"). The repair plan is a
state of the stepper Card, not a new surface: the dry run, the steps and "Fix it" in one place.

Carousel specifics (CP Carousel): 3 to 5 items (`MAX_ITEMS = 5`, more are cut, the protocol already caps at
5), strongest first (sorted by severity even if the server forgets), first item painted within 500 ms of
the tool result. Measured on the last run: every carousel render painted its first item 31.5 ms or less
after the host sent the result (median 24.1 ms over 18 renders); all 154 renders within 36.6 ms (median
25.4 ms).

## 2. One title, one or two supporting fields, one clear action (OV principle 2)

Each screen has exactly three zones:

1. Header: a short context line (Diagnosis, Repair plan, Home checkup) beside the Simulated home tag, one
   title (the device), one hero chip (the verdict).
2. Hero column: the evidence. Hypothesis bars on a diagnosis, the timeline on an explanation, the change
   list on a plan, the read back steps on a repair.
3. Decision card: one sentence and at most one primary button (plus one quiet secondary, like No or
   Not now).

Density control: when the probe chips would wrap, the passes fold into one "4 checks passed" chip
(`fitStrips`), while every failure, every unknown and every answer the person gave stays visible. The
full list with details is one tap away in fullscreen (OV: "Show only the information the customer needs
to make the next decision"; VF: "fewer metadata fields per item").

Long step lists fold the same way (`src/ui/fold.ts`). The engine plans the golden path power on fix as
14 steps, one per device; inline, the screen keeps as many steps as fit, and one row stands in for the
rest and says how they went: "11 more steps, all read back" (or "12 more steps" on a plan, "9 done, 2
skipped" when mixed). Rules behind it:
- CP List: "a See More button opens the full list in an overflow surface". The row is that button: it
  opens the full list in place (aria-expanded), and only the evidence column scrolls, with a fade at its
  foot, so the header and the decision stay put (TCX: no "content that extends off-screen with no scroll
  indicator").
- TCX: "Any truncation on commit screens ... all details must display completely". The plan's commit
  facts (the diff lines, every protected device, the expiry, Fix it) never fold; only the mechanical
  steps for each device do, and every one is a tap away. Steps that failed or were put back never fold.
- On a fixed landscape screen the fold is measured: steps fold one at a time from the end until the
  column fits. Where the height is open (portrait, a growing frame) it keeps 3. Lists under 5 never fold.
  Fullscreen lists every step.

A cause that rounds to 0% (the engine's "Can't tell yet" at 0.3%) is left out of the bars: an empty
track is noise at a glance, and the leader always stays (OV: "Strip the rest").

Carousel cards: severity chip, title, a detail, one action (CP Carousel; OV principle 2).
- Every title shows in full. When any title in the row would be cut at the Display5 size (the golden
  path "Kitchen plug dropped off Wi-Fi 9 times today" in a three card row on 1280x800), the whole row
  drops one type step together, as it always does for 4 or 5 cards, so the hierarchy stays even across
  cards (TCX: "Text that stops mid-word with no ellipsis", truncation that makes content unintelligible).
- The detail takes the free height above the action (`fitCarousel` measures it), so it is no longer
  clamped at two lines while space sits empty; it still ends in an ellipsis if it is longer than the
  card, and shows in full on a phone and in fullscreen.
- A finding with nothing to press (fixable false, no action label, like the 6% battery) ends with a quiet
  "Needs your hands" line where the action would be, so the card closes cleanly and says why there is no
  button.
- The one action does what the finding allows (OV principle 1, "resolves the customer's intent within the
  conversation"; TCX task completion, "Dead ends where the customer has no path forward"; TCX error
  recovery, "Loops where the same error repeats"). A fixable finding opens its plan here
  (`repair_plan {issue_id}`). The engine also labels findings it cannot fix ("Show me how" for a weak
  Wi-Fi link or an expired sign in, "Protect it" for an aquarium filter on a strip) and answers
  `repair_plan` for them with no_fix, so those cards never call it: they say the person's request in the
  conversation (ui/message), "Show me how to fix this. Kitchen plug dropped off Wi-Fi 9 times today." or
  "Protect the aquarium filter.", and the conversation answers by voice (apps/host's router replies with
  the finding's guidance, or routes to `protect_device` behind its approval sheet). The card then reads
  "Asked in the conversation" where its button was. A host without ui/message gets "Needs your hands".
  The protocol could carry these words so the view does not have to build them from titles.
- A failed card action puts the server's sentence where the detail was, as a plain line with the alert
  icon: the card keeps its severity chip, head, title and button in view at every size and never scrolls
  inside itself (`overflow: clip`), and the detail comes back with the next try (TCX error recovery: the
  experience stays recoverable).
- Numbers keep their units and days their months on one line ("-82 dBm", "3 October"), as Wi-Fi already
  did (TCX: text that breaks inside a unit reads as truncation).

## 3. Far field type and one root scale (OV principle 3, VF scaling implementation)

- Authored once on the 768x480 base canvas. The runtime resolves one surface and applies one root
  `zoom` to the stage: 1.667 on 1280x800, 1 on 960x480 and on a phone (VF: "Express surface adaptation
  as one root scale, not per-element sizing"). No pixel values per surface anywhere.
- Primary tokens are copied from the token reference (typography, spacing, shape, icon sizes); the rest
  is derived (`--radius-xl = radius-l * 1.5`, `--control-h = target + spacing-xs`) so the system scales
  as one piece (VF: "Build a derived token system").
- Type steps used: title Display3 32, hero percentage Display2 40, a question Display5 24, body
  Headline1 20, chips Headline2 18, details and labels Body1 16, the smallest text Body2 14 (23 px on an
  Echo Show 8 class screen). Nothing smaller than Body2 ships.
- Labels are sentence case: the context line over the title, block headings ("Causes", "Each step, read
  back") and the decision lead ("What I found", "Next check"). A lead that repeats the header chip
  (Likely, Can't tell) is dropped. Body1 at weight 600 in the secondary text
  color sets them apart from their content; no tracked all caps (project design direction, "Views inside
  the device"). Percentages are whole numbers that add up to 100, the residual reading "Something else".
- Short declarative copy in buttons: Yes, No, Show the fix, Fix it, Undo, Back (OV principle 3).

## 4. Surface resolution (LR "How your widget learns its surface")

`src/ui/context.ts` maps hostContext to one breakpoint once per render and puts it on the root element
as classes (`dc-large`, `mode-inline`, `orient-landscape`, `h-fixed`), so CSS holds every breakpoint in
one place (LR: "Keep your surface list a single source of truth").

- The custom `dev.fixwright/deviceClass` key (`large | small | phone | voice`) is authoritative when
  present (LR: "deviceClass is authoritative").
- Without it, the class is derived from `containerDimensions` (then the frame size), and the view logs a
  console warning once (LR: "surface a dev-time warning rather than silently degrading"). Tested.
- `host-context-changed` resolves again and lays out again in place, with no reload and no new tool call (LR:
  "Re-adapt on host-context-changed"). Theme, device class and display mode changes are tested live.
- Optional `dev.fixwright/now` lets a host with a simulated clock (the demo's "next morning") drive
  relative times ("Tomorrow at 7:00 AM") and the next check refresh.
- `containerDimensions` with `maxHeight` only (apps/host's Phone sends `{width: 358, maxHeight: 480}`)
  means the host grows the frame with the view up to that cap. The view keeps the cap (`--max-h`), stops
  growing there and scrolls inside (section 9). LR lists maxHeight among the hostContext fields.

## 5. Color (VF card color, primary and secondary colors)

| Token | Dark | Light | Source |
| --- | --- | --- | --- |
| card (view background) | #14181E | #FAF9FB | VF default-normal (dark), nested-outer-normal (light) |
| inner (nested cards, chips) | #1B2028 | #FFFFFF | VF nested-inner-normal |
| primary button | #2D415E | #2D415E | VF secondary blue/270 |
| secondary button | #232F40 | #E8ECF2 | VF secondary blue/190 (dark); light derived |

- In light mode the view itself is the outer card and its nested cards are white, which is the token
  pairing the guide gives for nested cards.
- The primary color marks the one action that moves the task forward on each screen (Yes, Show the fix,
  Fix it). Card actions in the carousel open a plan, not a final action, so they use the secondary
  style (VF: "Reserve bright primary colors for buttons that complete final actions").
- Status tones (pass, fail, warn, info, neutral) appear as text, icons, thin bars and 11 to 14 percent
  tints, never as large saturated fields (VF: "Avoid using bold brand colors or gradients as large
  fields"). No gradients at all.

## 6. Contrast and color independence (A11Y contrast, color correction and inversion)

- Every piece of text meets 4.5:1, stricter than the guide's 3:1 for large text. The Playwright suite
  computes it from computed styles for every text element in every render (2,658 checks): lowest
  measured 5.54:1 in dark, 4.86:1 in light.
- Color is never the only signal: every tone travels with an icon shape (check, cross, question, clock,
  undo) and a word (Urgent, Worth a look, Confirmed, Likely, Can't tell), so the views stay usable with
  color correction or inversion. Icon glyphs on tone dots use the dark glyph color in dark mode and white
  in light mode (glyph contrast at least 5.9:1 against the dot, computed from the tokens).

## 7. Touch targets (A11Y touch targets)

All controls are at least 48x48 in authoring units, and so at least 80x80 device px on a large screen;
main buttons are 56 tall, the fold row is 48 tall and full width. The suite measures every control in
every render, both rendered and divided by the zoom. All buttons have an accessible name (text, or
aria-label on the expand control).

## 8. Display modes (DM)

- Inline is the default and carries the whole task.
- Fullscreen is offered only when the host lists it (`availableDisplayModes`) and only through the view's
  own expand control (DM: "You will also provide the controls for customers to enter a fullscreen
  mode"; "don't move them between inline and fullscreen spontaneously"). It is the same experience with
  more room: every probe with its detail, each claim with its evidence count ("Backed by 14 log
  entries"), the exact entity level changes of a plan, every later check.
- Inline landscape screens fit the canvas as delivered: the suite fails any render where content reaches
  into the bottom padding or needs scrolling, and it now renders the engine's real 14 step power on plan
  and repair (fixtures `repair_plan_power_on`, `repair_apply_power_on`, `repair_plan_protected`), which
  fit because long step lists fold (section 2). Real outputs captured from the engine
  also fit at 1280x800 and 960x480 (overflow 0 for all eight). Opening the full list scrolls the evidence
  column only, by the person's choice.
- The fit holds for the states people reach by pressing, not only for fresh results (before the fit,
  buttons hung up to 113 px below the decision card once a decline or an error line was added). On a
  fixed landscape screen the decision card measures itself after mount (`fitDecision`) and, only when
  something reaches into its bottom padding, adds steps one at a time, gentlest first: one type step down
  with tighter spacing; a wider card (the evidence column gives up some width, and the step fold then
  measures what is left); body size text with the icon dropped (the header chip still carries tone and
  shape); wider still. Nothing that carries meaning is hidden: the sentence, the lead, the note, the
  outcome line and every button stay (TCX: no truncation). The suite renders seven outcome states in the
  matrix and sweeps 108 more (every screen with an action, every way it can end, at both landscape
  sizes) with the same overflow, bleed and scroll guards; switching the fit off makes 18 matrix renders
  fail with that overflow.
- A fixed landscape card never scrolls: focus restored after a render uses `preventScroll`, so even
  content that could not fit would never push the header off the top (portrait and growing frames
  scroll by design, so there focus still brings the button into view).
- In fullscreen everything is listed, so a page can run long. The decision card then hugs its content
  and stays in view beside the evidence while it scrolls (sticky), and the fullscreen details close the
  evidence column, so Fix it is never a long scroll away. Tested by scrolling to the end of the 14 step
  plan.

## 9. Portrait and frames the host caps (LR viewport types; TCX scrolling; A11Y input parity)

LR: "Card viewport. Scales and scrolls vertically", and "Designs that are taller than they are wide
render as a Card". TCX: "Results that aren't scrollable" and "Content that extends off-screen with no
scroll indicator" are failures. apps/host's Phone gives the view a frame 358 px wide that grows with the
view's size reports and stops at 480 px. Earlier the view hid its overflow there, so Yes, No,
Show the fix and Undo sat below the cap and could not be reached.

- The card stops at the host's cap and scrolls inside it; if a host ever makes the frame shorter than
  it said, the page scrolls too, so nothing is unreachable.
- Portrait reads top down: the decision leads (the question, the verdict, the next check) with its
  actions right under it, and the evidence (chips, bars, timeline, steps) follows. A person in a 480 px
  frame sees "I'll flash the hallway lamp twice. Did it blink?" and Yes and No without scrolling. A
  plan keeps the dry run first: a commit screen shows what will change before the button that changes
  it (TCX commit screens).
- The actions sit in an action bar that pins to the bottom of the scrolling card when it would fall
  below the edge (sticky), with a short fade above it so content visibly slides under. On a plan, Fix it
  stays in reach while the person reads the changes.
- The card is the only thing that scrolls. It is positioned, so the screen reader text inside it
  (absolutely placed `.sr-only` spans) stays in its scroll box instead of stretching the page, and its
  overscroll is contained, so a swipe past the end never drags the frame's page and never leaves a blank
  band under the card (TCX fit and finish; LR Card viewport scrolls vertically, once). The inner scrollers
  (the evidence column, the carousel row) are positioned for the same reason.
- Tested in a harness container that copies apps/host exactly (`container: 'flex'`): every case in both
  themes, frame and card at most 480 px, the page itself with nothing to scroll, every control scrolled
  into view and hit tested at its center, and the pinned actions on screen with nothing scrolled. Plus a
  full run by tapping on a touch screen in that frame (Yes, Show the fix, Fix it, Undo), and real wheel
  turns past the end of the 14 step repair, after which the page is still at 0 and the card still meets
  the frame's bottom edge.

## 10. Voice only (DM voice-only, A11Y input parity)

- Views are optional. The spoken reply in `speech` carries the meaning; a voice only host renders no view.
  If a host still shows the frame with the `voice` class, the view shows exactly the spoken reply as a
  caption, so screen and voice cannot disagree.
- Input parity: every button is a tool the model can call by voice (`diagnose_answer`, `repair_plan`,
  `repair_apply`, `undo`), and after a touch action the view calls `ui/update-model-context` with the
  result, so "undo that" by voice works after "Fix it" by touch. A card for a finding only the
  conversation can help with goes the other way: its button says the person's words in the conversation
  (ui/message), so touch and voice reach the same answer.
- The views render only `structuredContent`; they never compute a fact the server did not send.

## 11. Runtime envelope and payload (LR runtime envelope, UI payload packaging)

- The postMessage bridge (ext-apps `App`) is the only channel; no window.parent access, no storage, no
  cookies, no network. The suite records every request made by the view frame under the MCP Apps default
  CSP (`connect-src 'none'`) and requires none.
- One self contained HTML file per view, script and styles inlined, system fonts only (no font files).
- Weight: 400,760 / 409,455 / 400,485 bytes (110,700 / 112,835 / 110,587 gzip, 18 Oct 2026) for stepper, carousel, repair card, against an early prototype view's 608,934 (132,664 gzip). The
  main saving is an esbuild plugin that keeps only zod's English locale (`scripts/zod-english-only.ts`; a
  minimal App view went from 599,473 to 338,285 bytes).
- Inline script text is escaped so it cannot end its element ("</script") or enter the HTML parser's
  escaped state ("<!--"), with escapes that mean the same inside strings, templates and regexes with the u flag
  (unit tested by running the escaped code).
- `dist/manifest.json` carries a sha256 per file so the server can version its resource URIs by content
  (LR: "Version your resource URI with a content hash"). The protocol fixes the URIs today, so this is
  ready but not wired.

## 12. Motion (A11Y motion safety)

- The bars move from the previous answer to the new one (55% to 94% after "Yes, it blinked"), done steps
  tick in one by one, cards rise into place: each animation lasts 720 ms or less, runs once per new
  result and never on a relayout.
- No flashing or blinking anywhere. The pending spinner is a faint full ring with one bright arc, so it
  reads as progress even in a still frame (it used to read as a "(" glyph at large size); under reduced
  motion it stays still and the button label says what is happening.
- `prefers-reduced-motion: reduce` turns every animation and transition off (tested: zero running
  animations).

## 13. Screen readers (A11Y VoiceView)

- Probe chips read as "Hub, passed" and "Availability, found a problem"; steps as "Retire the old copy,
  done". Icons are `aria-hidden`.
- Each block has a heading; the decision card is labelled by its sentence.
- A polite live region announces "Checking." while a call runs and the spoken reply when it lands.
- A failure is an alert (`role="alert"`); a declined approval and an asked card are status lines
  (`role="status"`), announced politely, because nothing went wrong.
- After an action, focus moves to the new screen's primary button; Back from a carousel plan returns it
  to the card the person came from, its button, or the card itself (labelled by its title, with the
  same ring) once that card is Fixed and has no button left; while a call runs the pressed button
  keeps focus (`aria-busy`, `aria-disabled` instead of `disabled`, so focus is not lost). The focus ring
  is a 3 px outline with a 3 px offset.
- The fold row is a button with `aria-expanded` and `aria-controls` pointing at the list; it keeps focus
  when it opens or closes, and a host relayout keeps the list open.
- When the carousel row scrolls (four or five cards), it takes keyboard focus (tabindex 0, a focus ring)
  so arrow keys move along it and a card without a button can still be reached (A11Y: "Touch only,
  including on-screen keyboard"; TCX: complete the CX "using touch and keyboard only").

## 14. States people actually hit

- Pending: the pressed button names what is happening (Checking, Planning, Fixing, Undoing) and every
  other action is blocked until the answer arrives.
- Refused or failed: the server's own sentence (ProblemOutput speech) shows inside the decision card,
  nothing else changes, and the button works again (TCX error recovery). On landscape the card makes
  room for it by stepping its own type down (section 8), so the sentence and the buttons stay inside
  the card's border; in portrait it sits in the pinned action bar above the buttons. A host refusal the view cannot
  read shows "That didn't go through. You can try again, or just ask me out loud."
- Declined: saying no on the host's approval sheet is the person's choice, not a failure. apps/host's
  convention resends the view's latest result, then
  denies with "Not approved. Nothing changed." The views treat a result identical to the screen showing
  as a resend, not as news: the screen keeps its place (the plan's "Not now", the device name, the
  carousel's cards and Fixed marks), and the denial of the call in flight shows as a calm status line,
  "Not approved. Nothing changed.", in the info tint with no alert (TCX error recovery: no dead end, no
  start over; before this change the carousel fell to "That didn't work" with no cards and no way back).
  The same words without a resend read the same way. A newer version of the screen showing (same plan,
  repair or diagnosis id) also keeps its place; anything else starts a new screen.
- Waiting: the tool input names the device; a quiet skeleton in the shape of the coming layout.
- An explanation's fix plans with `repair_plan {explanation_id}`, an id the server resolves
  on its own, instead of the suggested fix's issue id (which would need the server to know which
  session owns that issue).
- A repair card on its own is titled by its outcome ("Fixed and checked"), so its chip carries the
  evidence: "3 of 3 read back", or "2 read back, 1 skipped" when a retry found a step already in place
  (never a bare "Fixed" next to a title that says so).
- Next check: an applied repair asks once for the latest result (`refresh_view`) when its check time has
  passed, so the morning check appears in place.

## 15. Brand and honesty

- No logo or attribution inside the view (the host places attribution, Brand expression), no Alexa or
  Amazon marks (a unit test scans the built files).
- Every screen from a simulated home carries a "Simulated home" tag, so simulated data is never taken for a real home.

## 16. Known gaps

- Testing on a device (Echo Show, VoiceView, screen magnifier, color filters) and the Local Inspector are
  not available here; the Playwright harness stands in for the host. Its flexible phone container and its
  decline convention copy apps/host, but the real host itself is not driven by this suite; the words a
  card sends are checked against the real packages/router.
- The words a card sends for a finding it cannot fix are built from the finding's title (the protocol
  does not carry them yet).
- A repair card opened on its own cannot name the device yet.
- Fonts: the stack prefers Inter, then the platform's system UI font; the screenshots use Inter because
  it is installed on the build machine.
