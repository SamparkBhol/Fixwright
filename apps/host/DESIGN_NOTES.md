# Host stage design notes

What was built in apps/host against the design direction, and where it bends.

## Built

- **Wall.** The stage backdrop is `--wall-day` #CBD5D3 from 07:00 to 21:59 house time and `--wall-night`
  #1B2433 otherwise. House time is the host clock synced to `/demo/state` `now`, in the zone of its `clock`
  object; the label under the switcher reads "House time 3:00 PM, simulated" when the server says the clock
  is simulated (the same time style as the device, its push and the views), and "Replaying 3:12 AM" while the
  restore replay holds the night wall. Until the house clock is read the wall keeps its day default, and it
  only fades once it has been painted from house time, so a page opened at night never plays a night.
- **Lamplight.** #FFB547 is used for two things only: a plan dot that is on, and the blink (the flashed dot
  also grows and glows wider while it plays, so it can be found in a full frame). The morning is the wall
  coming out of the night slowly into the day token, with no tint of its own. Buttons are ink on paper; the
  Say button is ink.
- **Type.** Atkinson Hyperlegible Next 400, 500 and 700 everywhere on the stage and console, Atkinson
  Hyperlegible Mono 400 only in the Visual Trace. Both self hosted from `src/fonts/` with their OFL files.
  Scale 13, 16, 20, 25 px in use; body 16 px at 1.5.
- **Labels.** Sentence case throughout. No tracked capitals, no middle dot meta strings, no arrows on
  buttons. The trace keeps its direction arrows because they are the trace's notation, not a call to act.
- **Switcher.** Four silhouettes (large display, small display, phone, speaker) standing on one short shelf
  line; the selected one is filled. Each has the device name and size as its accessible name.
- **Device and shelf.** The device stands on a full width shelf at the bottom of the canvas and keeps its
  own shadow, the only shadow on the page. Radii: device 28 px, panels 12 px, chips and buttons 999 px.
- **House plan.** Six rooms in one strip with doorways in the shared walls, one dot per light, switch or fan
  from `/demo/state`, read after each tool call that can change the house (no polling, and few enough reads
  for the demo routes' 30 per minute). On is lamplight, off is outlined, offline is `--fault`. A `--sound`
  ring marks the lamp that answered the flash test. On a phone width page the strip folds into two rows.
- **Moments.** Each one is built from logged times, never from a script:
  - Flash: the four switches SimHome logged for the lamp that really changed (`physical.recentActuations`,
    15 to 16 ms apart), stretched to 1.8 s in the same proportions. For the ghost lamp this is the online
    copy, so the plan shows a red old copy beside a lamp that blinks twice.
  - 3 a.m.: the wall goes to night, every device on the cut circuit goes offline at the cut, and the
    fourteen that came on light up in logged order and at logged offsets, over the same span as the
    explanation's own rows (checked in e2e/golden.e2e.ts), then the wall comes back.
  - Morning: when the next morning push lands, the wall goes from night into a warm morning tint (day
    plaster mixed with 20% lamplight) and then follows the clock.
  - With reduced motion, and in test mode, the plan shows the end state and the line that says what
    happened. `__fixwright.holdMoment(ms)` freezes any moment for screenshots and the video.
- **Console on paper.** `--paper` #EEF2F1 with ink text and hairline rules. Four tabs (Conversation, Visual
  Trace, Latency, Break my house); About opens from the top bar, as the layout in the direction shows, and
  also holds the device screen theme switch.
- **Kept as they were.** The honesty banner (now in the top bar, its URL never cut), the push toast outside
  the device view, the approval sheet, the views inside the device with the Alexa+ guide tokens, and every
  `window.__fixwright` call the video pipeline uses.

## Where it bends

- The plan replays SimHome's own record of visible switches, not the ledger rows themselves, because
  `/demo/state` does not return ledger rows. The two share their instants (the explanation's "Power came
  back" and last row match the first and last replayed switch to the millisecond), and the e2e asserts it.
- A linked Home Assistant has no record of visible switches, so its plan shows live states with no replay.
- `--sound` also colors the Connected dot in the top bar: the server answered.
