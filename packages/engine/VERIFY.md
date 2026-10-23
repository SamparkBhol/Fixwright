# VERIFY: @fixwright/engine

`npm run check -w @fixwright/engine` runs three steps; all pass (17 Oct 2026: 396 of 396 tests
in 12 files, about 2 s; earlier runs that day had 395, 374 and 359 tests).

1. `tsc -p tsconfig.src.json`: the source compiles with `lib: ES2023`, no Node or DOM types, strict and
   `noUncheckedIndexedAccess`.
2. `tsc -p tsconfig.json`: tests and scripts compile.
3. `vitest run`: the tests below. Every tool output in every test is parsed with the protocol's
   `ToolOutputs.<tool>` zod schema.

## Main behaviours

### Golden diagnosis (test/golden-diagnosis.test.ts, 29)
- [x] Targets `light.hallway_lamp` (the copy the name points at), not the copy paired again.
- [x] All passive probes run before the flash; hub, signal and cloud pass ("Hue cloud"); availability and
      names fail; every probe cites ledger evidence.
- [x] Two causes remain, stale_duplicate leading (0.624) and device_power_lost second (0.370), together over
      0.95, the top under 0.9; the question is exactly "I'll flash the hallway lamp twice. Did it blink?" and
      the speech is "Your hub is reachable, the signal is good and the Hue cloud is fine. I'll flash the
      hallway lamp twice. Did it blink?". Only the online copy is flashed (4 commands, left as it was).
- [x] "yes", "Yes, it blinked.", "haan" and "jal raha hai" each confirm stale_duplicate at a confidence
      between 0.9 and 0.97 (0.946) with claims exactly "The lamp works. The name Hallway Lamp still points at
      an old copy of it that went offline on October 3." and the speech adds "Want me to fix that?".
- [x] Every cited seq exists in the ledger and the claims pass the checker.
- [x] "no" does not confirm stale_duplicate: power loss leads and "Is the lamp's wall switch on?" follows; a
      second "no" confirms device_power_lost with "Switch the hallway lamp back on at the wall." and no
      promise of a check (no sensor can tell here; see followup.test.ts).
- [x] Those claims are about the lamp the person looked at, exactly "The hallway lamp didn't respond
      when I tested it. Its wall switch is off. Your hub and its signal look fine.", citing the online copy's
      flash and answer; nothing about the old copy's 3 October outage.
- [x] An unclear answer is asked again once with a clearer question and a new id, flashing again; the repeat
      flash is reported as its own probe ("Flash test again", disruptive, with its ledger event) and cited by
      the verdict; a second unclear answer counts as no information and never confirms the stale copy.
- [x] A diagnosis started at 21:59 flashes, an unclear answer at 22:01 switches nothing and asks
      "Just yes or no, did the hallway lamp blink when I flashed it?"; after a consent yes in quiet hours the
      asking again may flash again.
- [x] A stale question id gives `question_answered`; a foreign diagnosis id gives `session_expired`; sessions
      survive a JSON round trip and are not mutated.
- [x] Quiet hours: at 23:30 the engine asks "It's late, so I'll ask first. Can I flash the hallway lamp twice
      to test it?" and switches nothing; "ok, go ahead" flashes and asks; "no" switches nothing and moves to
      the wall switch question; custom quiet hours apply.
- [x] Also: the "Hallway Lamp 2" naming, the flapping kitchen plug (radio_link_weak from passive evidence:
      "The kitchen plug dropped off 9 times in the last day. Its Wi-Fi signal is weak, at -82 dBm."), guided
      mode for an unknown device, ambiguity refused, hub down, dead trigger, power on default, vendor cloud.

### Explain at 3 a.m. (test/explain.test.ts, 36)
- [x] The golden house gives confirmed power_restore and exactly "Power came back at 3:12. Fourteen devices
      restarted within four seconds. None of your automations fired. I can make them remember whether they
      were on or off. Do it?", with the suggested fix and its issue id.
- [x] Claims cite the right events: the 03:12:00 comeback, 14 distinct comeback rows, and on rows without
      context; the timeline is out, back, restarted, on in time order.
- [x] Not hardcoded: a 7 device outage at 03:47 spread over 5.4 s gives "Power came back at 3:47. Seven
      devices restarted within six seconds." and "last night" gives "3:12 a.m.".
- [x] Mains power events become the time evidence; Matter boot reasons and rows of devices that came back already on (the
      SimHome shapes) are read as restarts.
- [x] With the outage rows removed: cant_tell, "I see fourteen devices turned on at 3:12, but nothing in the
      log says why." With automation context: automation_trigger, "Your automation Night Lights switched
      fourteen devices at 3:12. It ran because of the time reaching 3:12 a.m."
- [x] Fewer than 5 devices, or a single integration, is not a power restore; a user context gives
      user_action; an empty window says it can't tell; home events are copied into the ledger once.
- [x] The suggested fix is offered only when `canRepair` can plan it (a power on select exists).
- [x] Fixwright's own writes: after "the kitchen ceiling isn't responding" (the engine flashes it),
      "what happened this morning" says exactly "That was me. I switched the kitchen ceiling at 10:20 to test
      it." (confirmed, label "Fixwright switched it", citing the home rows of that light and the flash_test
      probe row), never "Someone ... from the app". After golden steps 1 to 3: "That was me. I switched the
      hallway lamp at 10:20 to test it and to check the fix." A person switching the same light four minutes
      later is still "Someone switched the kitchen ceiling from the app at 10:24."
- [x] "at 3" with no a.m. or p.m.: at 15:30, after golden steps 1 to 3 in the 3 p.m. hour, "Why did
      every plug turn on at 3?" skips the hour holding only Fixwright's writes and gives the restore story with
      "3:12 a.m."; a person's change at 3:05 p.m. is taken from the most recent hour ("at 3:05 p.m.").
- [x] The named device: "why did the kitchen plug turn on at 3 a.m.?" starts "The kitchen plug wasn't
      one of the fourteen devices that restarted when power came back at 3:12." with no restore story and no
      fix; "the porch light" adds "The porch light was one of them."; "all my plugs ... at 3 am" with a "Plug 3"
      in the house is still the whole house story (the hour is not read as a device number).
- [x] Device numbers: with a "Plug 3" a person switched on from the app at 8:05 a.m. (not in the
      restore), "why did plug 3 turn on?" says "Plug 3 wasn't one of the fourteen devices that restarted when
      power came back at 3:12 a.m. Someone switched plug 3 from the app at 8:05 a.m." (user_action, no fix),
      and "why did plug 3 turn on at 3 am?" starts "Plug 3 wasn't one of the fourteen devices" with no restore
      story and no fix. Before, both gave the confirmed fourteen device story with a fix offer, because every
      bare number was stripped as a time.
- [x] Own writes in other wordings: at 15:30 after golden steps 1 to 3, "why did the hallway lamp
      turn on at 3?" says "That was me. I switched the hallway lamp at 3:30 p.m. to test it and to check the
      fix."; after flashing the porch light (part of the restore), "why did the porch light blink?" says "That
      was me. I switched the porch light at 10:20 a.m. to test it." with no fix, while "why did the porch light
      turn on at 3 a.m.?" is still the restore.
- [x] "at 3" fallback: a device with nothing in either 3 o'clock gets the 3 a.m. hour, where the
      house had a restore ("The desk fan wasn't one of the fourteen devices ... at 3:12 a.m."), not a 3 p.m.
      window cut at now with "Nothing in the log explains it."

### Checkup (test/checkup-guard.test.ts, 13; test/golden-path.test.ts, 1)
- [x] After the golden path repairs, exactly "Two lights answer to Living Room Light", "Hall motion sensor
      battery at 6%", "Kitchen plug dropped off Wi-Fi 9 times today", in that order, spoken as "I found three
      things. ... And the kitchen plug dropped off Wi-Fi 9 times today."
- [x] The untouched house gives five findings, most severe first (adds the old Hallway Lamp copy and the
      fourteen devices that turn on after a power cut); the 9 drops are cited as 9 ledger events.
- [x] An unprotected aquarium filter on a strip is a high finding; focus narrows ("batteries"); a failed sign
      in outranks the rest; a healthy house says so.

### Plans (test/repair.test.ts, 27)
- [x] stale_duplicate: retire (disable, inverse enables it again) then an on and off check; diff row and the exact
      expected diff lines; removal of the restored copy waits in `follow_up`; token of 32 base32 characters;
      expires in 5 minutes; the plan changes nothing by itself.
- [x] With "Hallway Lamp 2": rename first (aliases moved), inverse back to "Hallway Lamp 2"; apply reads back
      "Name reads Hallway Lamp", "Old copy is retired", "It answered both times"; undo restores both.
- [x] power_on_default_on: 14 `select_option` steps to `previous`, each with an inverse back to `on`; apply,
      the morning check ("The power on settings held overnight. Repair confirmed.") and undo; devices without
      a select are listed as not changeable.
- [x] Every checked morning result cites a ledger note it appended with what it read: the fourteen
      settings all read `previous`; a quiet night records zero commands, zero drops and the lamp's state;
      answered commands cite the command, the reply and the note. One setting is spoken as one ("The power on
      setting held overnight."), one that changed back is counted ("The power on setting changed back
      overnight.", "One of the fourteen power on settings changed back overnight."), and so is a single
      command ("answered the one command it got overnight").
- [x] A read back mismatch rolls back done steps (ledger shows apply done, apply failed, rollback); a claimed
      idempotency key never runs twice; the morning check reports missed commands and quiet nights.
- [x] Every command answered but one drop says "Hallway lamp answered both commands it got
      overnight, but went offline once. I'll take another look." (fail, citing the drop row), never "missed 0";
      a missed command plus a drop says "Hallway lamp missed the one command it got and went offline once
      overnight. I'll take another look."
- [x] A power on plan sets each select once, even when two entities of one device share it, and an
      old copy the integration no longer provides is skipped instead of "I can't change the hallway lamp".
- [x] Name collision renames the Hue group to "Living Room Light Group"; a dead trigger turns the automation
      off with an inverse; a garage door opener inside a power on plan is skipped and named; a plan with only a lock
      is refused; findings without a fix and unknown issue ids are refused.
- [x] With both copies named "Hallway Lamp" and the old copy aliased "hall light", the plan adds an
      alias step on the online copy (read back as an exact alias set, inverse back to none) before retiring the
      old copy, with the diff line "The lamp that is online will also answer to hall light."
- [x] Undo speech for every plan kind: the stale copy and a rename name the device, one or fourteen
      power on settings are counted ("Undone. Those fourteen power on settings are back the way they were."),
      a dead trigger names the automation, a hub reconnect says there is nothing to undo; each validates as an
      undo output.

### Protected loads (test/checkup-guard.test.ts; test/golden-path.test.ts)
- [x] The strip is refused with the reading lamp as the alternative and exactly "That strip runs the aquarium
      filter, which you marked protected. I'll turn off the lamp on it instead."
- [x] The protected outlet itself is refused for turn_off, toggle, flash and power_cycle; turning on, the
      unprotected outlet and a strip with nothing protected are allowed.
- [x] With several outlets one alternative is offered, preferring a light that is on; a garage light is not a
      garage door; locks and garage doors are refused; the flash test never runs on a protected load.

### Claim checker (test/claims.test.ts, 16)
- [x] A fabricated claim (missing seq) is dropped and confirmed becomes likely; a sound verdict stays.
- [x] Dropped too: evidence about another device, the wrong day, a probe that reported the opposite, a wrong
      device count, an absence claim contradicted by an automation run, framing text with facts or evidence.
- [x] The phraser gate accepts a restyle that keeps the content words in order ("So, power came back at
      3:12.", "Okay, the lamp is working."), rejects new numbers, flipped negation, names in framing and
      markup, ignores a broken phraser, and keeps "and 3 other lamps too" out of the spoken verdict.
- [x] It rejects meaning reversals and swaps: "The lamp is broken.", "Power went out at 3:12.", "Your
      power returned at 3:12.", "The lamp that is online will point to Hallway Lamp.", "I'll fix that." for
      "Want me to fix that?", and -82 dBm turned into 82. The gate is lexical; README says what it cannot do.
- [x] It rejects swapped people and changed tense: "You switched it on and off", "None of my
      automations fired.", "Your hub was reachable", "had been offline", "Was its wall switch off.", "The lamp
      was working."; it still accepts "Okay, I switched it on and off, and it answered both times.", "So, the
      hallway lamp has been offline since 3 October." and "Do you want me to fix that?".

### Property (test/property.test.ts, 1 test over 200 seeded houses)
- [x] Random houses (3 to 14 devices across 5 integrations, offline and restored copies, duplicate names,
      flaps, weak signals, failed integrations, cloud outages, power cuts, automation context), random times
      over two days (so quiet hours are hit), 15% of them started at 21:50 to 21:59, a clock that moves 0 to
      5 minutes between answers, random symptoms and random English or Hindi answers for up to 8 turns. Last
      run (17 Oct): 195 diagnoses, 5 ambiguous names refused, 439 questions, 17 conversations
      that crossed into quiet hours, 35 repeat flashes, 144 switching commands in quiet hours checked, 128
      quiet hour consents; verdicts 40 confirmed, 41 likely, 114 can't tell (44 saying the device worked when
      tested, 5 setting aside a real fault that cannot cause the complaint), 1 second fault named, 22 fixes
      planned for real, 12 diagnoses that read a battery. (Two earlier runs on 17 Oct: 40 likely, 115 can't
      tell, 21 fixes, 0 second faults. A 15 Oct run: 450 questions, 45 likely, 110 can't tell.)
- [x] Every diagnose, explain and checkup output validates.
- [x] Confirmed only with confidence of at least 0.9 and every claim citing existing ledger events about the
      device being diagnosed or this diagnosis's own probes.
- [x] No disruptive probe in quiet hours without a recorded yes to the consent question before it, and no
      switching at all after a consent no. This is also checked on every switching command the
      adapter received (timestamped), so a flash that is not reported as a probe still counts.
- [x] Every finished diagnosis passes `test/support/verdict-invariants.ts`: a likely or confirmed
      verdict has claims, all cited seqs exist, at least one claim cites a probe or answer of this diagnosis
      that came out `fail`, the cause is one the complaint allows (symptom weight above 0), a likely verdict
      speaks its cause, can't tell offers no fix, and every offered fix is planned by `planRepair` (output
      validated) without switching anything. The generator now adds power on selects (some without a
      `previous` option) and two more complaints ("something is wrong with", "won't turn on").
- [x] The posterior sums to 1 (within 1e-9) after every step.
- [x] Mutation checks (by hand, 15 Oct): removing the quiet hours gate makes this test fail; removing only
      the gate on asking again makes this test and the 21:59 to 22:01 test fail.

### Guided follow ups and the morning check (test/followup.test.ts, 13)
- [x] device_power_lost on a lamp that lost power: the line promises "I'll check that it comes back" because a
      comes_back check is scheduled (5 minutes, every 5, for 2 hours); it stays pending (nothing written,
      nothing to push), passes once the lamp is back ("The study lamp is back online.", citing the comeback
      row and the recorded check), and fails plainly when the window closes.
- [x] When no sensor can tell (the golden hallway lamp's online copy already reports on), no check is
      planned and neither the verdict nor the no_fix speech promises one.
- [x] radio_link_weak: one check at the next 07:00 at least 6 hours later; a quiet night passes ("stayed
      connected since yesterday, after dropping off 9 times the day before"); 3 later drops fail and are cited.
- [x] vendor_cloud_outage: pending while the status page reports an outage, passes when it is ok (naming the
      thermostat only once it is online), gives up after a day and says so.
- [x] account_link_expired passes once the integration loads; wifi_network_changed watches the target and its
      offline Wi-Fi peers and says "One of the three devices still hasn't come back." until all are back.
- [x] The morning check never invents a pass: a rename (name collision) and a disabled automation (dead
      trigger) get no scheduled check (`morningCheckAt` undefined, no "I'll check" line), and `morningCheck`
      returns `not_checked` with empty speech and no evidence. A verifiable plan is scheduled at the next 07:00.

### Verdict honesty (test/verdict-honesty.test.ts, 30)
- [x] A device that works when tested: "the kitchen ceiling isn't responding", it blinked, the wall switch is on.
      power_on_default_on is not a hypothesis (a power on setting cannot make a light ignore commands), no
      power on probe runs, and the verdict is can't tell with exactly "The kitchen ceiling worked when I
      tested it just now. So I can't tell what went wrong before. If it happens again, ask me right away and
      I'll test it while it's happening." The claim cites the flash and the yes, both about that light; no fix
      is offered, `planRepair` refuses, and no follow up check is planned.
- [x] The same light "keeps turning on by itself": the setting is read (fail), the verdict cites it, and the
      plan is the one `select_option` to `previous`.
- [x] A lamp with no readable power on setting never gets that cause. A setting that can be read but not
      changed (signal only) is named with guidance, "You can set the study lamp to remember whether it was on
      or off from its maker's app.", and no fix. With no signal, the setting is read from the select (the Home
      Assistant shape).
- [x] A likely verdict says its cause: "the kitchen ceiling isn't responding", yes, no gives "The kitchen
      ceiling's wall switch is off. Your hub and its signal look fine. It's most likely a power problem, but I'm
      not certain. Switch the kitchen ceiling back on at the wall."
- [x] An old copy cannot switch a lamp on: "the hallway lamp keeps turning on by itself", yes, yes no longer ends likely stale_duplicate
      with a fix. It is can't tell (cause not stale_duplicate, no fix, planRepair refuses): "The hallway lamp
      worked when I tested it just now. I did find an old copy of the device, but that wouldn't switch it on by
      itself. So I can't tell what went wrong before. If it happens again, ask me right away and I'll test it
      while it's happening."
- [x] Battery: "the hall motion sensor isn't working" asks nothing (no wall switch or plug question),
      runs `battery_level` (fail, "The battery is at 6%."), and confirms device_power_lost with "The hall
      motion sensor's battery is down to 6%. Your hub and its signal look fine. Put a fresh battery in the hall
      motion sensor.", citing the battery_level probe row (value low, 6). At 80% the battery passes, is not
      blamed, and there is still no wall switch question. A likely verdict says "a flat battery".
- [x] Dead trigger: "the night lights automation doesn't work" with every device present runs
      `registry_scan` (pass) and ends can't tell, cause not dead_trigger, never "an automation using a removed
      device": "Every device Night Lights uses still exists. So I can't tell what went wrong before. If it
      happens again, ask me right away and I'll test it while it's happening." With a removed device it still
      names dead_trigger.
- [x] Two faults: with the online hallway lamp also set to switch on when power comes back,
      "the hallway lamp keeps turning on by itself", yes, yes sets the old copy aside with the readings it
      accounts for and names the power on setting (fix offered, the plan sets select.hallway_lamp_2's
      setting): "The hallway lamp is set to switch on whenever power comes back. I also found an old copy of
      the device, but that wouldn't switch it on by itself." The offline reading of the old copy no longer
      rules the setting out: only a clean reading of a cause's own probe does. An old copy no longer owns the
      new copy's select by name prefix.
- [x] Battery not low: a motion sensor offline with its battery at 80% is never told to get a fresh battery;
      the guidance is "Check that the battery in the hall motion sensor is seated properly, and I'll check
      that it comes back."
- [x] Can't tell names: "the hallway lamp keeps turning on by itself", no, no says "I did find a
      power problem, but that wouldn't switch it on by itself. I can't tell yet. If it happens again, ..."
      and no longer "most likely something I can't see from here or an old copy of the device" (0.006 and
      0.024 of the posterior); causes below `NAME_FLOOR` (0.1) are never named.
- [x] The strip that feeds the protected filter is never flashed, and no settle line offers a flash.
- [x] "won't turn on", "will not turn on" and "doesn't respond" read as unresponsive; "keeps turning on by
      itself and won't turn off" still reads as turning on by itself.
- [x] The golden house sweep: every switchable device in the golden house, four complaints ("isn't responding",
      "keeps turning on by itself", "doesn't work", "something is wrong with"), four answer patterns: 352
      verdicts, none breaking a rule above (before these rules: 50 likely verdicts with no claims, 22
      fixes offered that the planner refused, 78 likely verdicts that never named their cause). Four more
      rules in `test/support/verdict-invariants.ts`: a named cause fits the complaint (weight at least
      `FIT_MIN`), a can't tell verdict never shows or says a cause a sensor ruled out or one that cannot cause
      the complaint, and a battery device is never asked about a wall switch. "Ruled out" means a
      clean reading of the cause's own probe. A can't tell line names no cause below `NAME_FLOOR`,
      and a named cause that is not the top single fault cause comes with "I also found" (a fault set
      aside). Last run (17 Oct, unchanged from the run before): 186 confirmed,
      43 likely, 123 can't tell (52 saying the device worked when tested, 12 setting aside an unrelated fault),
      148 fixes planned. (15 Oct run: 192 confirmed, 49 likely, 111 can't tell, 152 fixes.)
- [x] Mutation checks (by hand, 15 Oct), each reverted afterwards: dropping the observed fault rule fails this
      file and the property test; putting back power_on_default_on's 0.03 weight for "not responding" fails
      the reproduction; offering a fix for every automatic cause fails this file and the property test;
      removing the catch all's "works right now" rows fails two tests here.
- [x] More mutation checks (by hand, 17 Oct), each reverted afterwards (sources diffed against a backup):
      no own write matching in explain fails 4 explain tests; `fits` always true fails 3 (verdict honesty and
      property); not reading the battery fails 3; the old dead_trigger row (0.1) fails 1; dropping the open
      cause rule for can't tell fails 5; the old morning line fails 1; the restore ignoring the named device
      fails 1; "at 3" always taking the latest hour fails 1.
- [x] Scripted mutation checks (17 Oct; each mutation applied to one source file, the full suite run,
      the file restored from a backup copy, and src diffed against the backup at the end): stripping every bare
      number as a time fails 2; ruling out on any reading fails 2; no second fault fails 2; fresh battery advice
      at any level fails 1; no name floor fails 3; own writes never counting as activity fails 1; no blink rule
      fails 1; no house activity fallback for "at 3" fails 1; "all 2 commands" fails 2; "the plug 3" fails 3;
      the old select prefix match fails 1; keeping the old copy in a power on plan fails 1; no select dedupe
      fails 1.

### Numbered names, two faults, "at 3 a.m." the next morning, the partial power fix (17 Oct)
- [x] Numbered names (test/explain.test.ts, test/units.test.ts): `withoutTimes` keeps "outlet 12", "hallway
      lamp 2" and "plug 3" and takes out "at 12", "at 12:05 pm", "20 minutes ago", "at 2", "around 3 o'clock".
      "why did outlet 12 turn on?" says "Outlet 12 wasn't one of the fourteen devices that restarted when power
      came back at 3:12 a.m. Someone switched outlet 12 from the app at 12:05 a.m."; "why did outlet 12 turn on
      at 12?" takes the 00:00 hour and says "Someone switched outlet 12 from the app at 12:05 a.m."; "why did
      hallway lamp 2 turn on at 3 a.m.?" (the copy paired again, renamed Hallway Lamp 2, switched from the app at
      3:40) says it was not part of the restore and that someone switched hallway lamp 2 at 3:40.
- [x] A cause is ruled out only by its own probes (test/verdict-honesty.test.ts, 9 new): each cause has its own
      probes (a list in diagnose.ts, written out again on its own in verdict-invariants.ts). A clean sensor
      reading of one of them at 0.05 or less rules it out, unless one of its own probes failed; another probe's
      reading never does. The two fault golden house (old copy plus a power on setting set to on) names the
      power on setting with the fix for all four answer patterns; before this change [yes, no] and [no, yes]
      ended in can't tell because the unfit fault on top (0.529, 0.344) was below the likely bar. With the
      setting already on previous, the setting's own probe passes and it is never named (four patterns). The
      living room light (a shared name, read online, wall switch off by the person's answer) now says "It's most
      likely a power problem or two devices sharing a name." The invariants add: a second fault is named only
      with a failed reading of one of its own probes.
- [x] "at 3 a.m." and "at 3" with no date take the most recent time that hour came round in the last 48 hours
      with activity, else the most recent (test/units.test.ts, test/explain.test.ts, test/simhome-morning.test.ts).
      On the golden house at 07:00 on 16 October after the golden steps, and on SimHome seeds 1 to 3 after
      steps 1 to 4 (the morning check passes), "Why did every plug turn on at 3 a.m.?" speaks the step 5 line
      word for word with the 14 step fix, and "at 3" says "3:12 a.m.". When both nights had something, the most
      recent wins; with nothing in 48 hours the answer is an honest can't tell. "yesterday at 3 a.m." takes that
      day only, "at 3 a.m. last night" one window.
- [x] Partial power fix wording (test/explain.test.ts, test/phrase-purity.test.ts): nine plugs restart, three
      have no power on setting: "Nine devices restarted within one second. None of your automations fired. Six
      of the nine can remember their last state. I can set those. Do it?", and the plan has 6 steps. A select
      with no option to remember counts as not settable ("Eight of the nine"). All nine settable keeps the
      usual line.
- [x] Mutation checks (scripted, 17 Oct; each applied to one source file, the full suite run, the file restored
      from a backup and compared byte for byte): one window per clock hour fails 6; ignoring yesterday and
      today fails 1; meridiem whenever there is more than one candidate fails 20; stripping bare numbers as
      times fails 5; always the full power fix line fails 2; a failed own probe not protecting a cause fails 1;
      ruling out on any clean reading (the earlier rule) fails 1; no second fault below the likely bar fails 2.
      One mutation survives: dropping the explicit "one of its own probes failed" test for a second fault,
      because every claim that shows a fault already cites one of the cause's own probes; it stays as a guard.

## Other checks

- test/units.test.ts (48, one of them warmUp run with timers, fetch, crypto, Math.random and Date.now
  trapped, none called): target resolution (folding, synonyms, a swapped letter, area words, guided mode,
  ambiguity), symptom classes, time windows (3 a.m., 11 pm yesterday, last night, this morning, kal raat 3
  baje, an hour ago; counts and percentages are not times; "in the last hour", "over the past 30
  minutes", "the last couple of hours", capped at a week; "at 3" gives both 3 o'clocks, most recent first; `withoutTimes` takes out "at 3
  am", "3:12 a.m.", "3 baje" and "in the last 2 hours" but keeps "plug 3"; a numbered name is said without
  "the"; two commands are "both commands it got"), quiet hours across midnight, the next 07:00
  across the DST change, Bayes and EIG, the probe score formula, the human noise model, reliability updates
  and `auditHumanAnswers`, priors, determinism for a seed, warmUp touching nothing else.
- test/phrase-purity.test.ts (180): every template renders plain speakable text with no banned words or long
  dashes; the golden path lines word for word; a line for every status; the source has no Node imports,
  `Date.now`, `Math.random`, crypto, fetch, timers, globals, classes or `any`, imports only
  `@fixwright/protocol`, and an esbuild neutral bundle with workerd conditions runs a diagnosis.
- `npm run sweep:simhome -w @fixwright/engine` (not in `check`, about 7 s): the golden path and the replayed
  past failures on SimHome seeds 1 to 200, every output validated and every diagnosis run through
  `verdict-invariants.ts`. Last run, 17 Oct, exit 0 with no problems: all 200 seeds
  ask the flash question, confirm stale_duplicate with the golden path verdict, apply the repair, speak the
  explain lines exactly and apply the 14 setting fix, show the three checkup cards, refuse the strip with
  the protected load line, and pass the 07:00 morning check. On every seed: 0 "someone" answers after
  Fixwright's own flash and check (200 of 200 "Why did every plug turn on at 3?" give the restore story, 200
  of 200 "just now" questions say "That was me"), 0 wall switch questions for the motion sensor (200 claim
  the battery), 0 dead triggers named after registry_scan passes, 0 stale_duplicate verdicts for "keeps
  turning on by itself". Also on every seed: "why did the hallway lamp blink?" right after the flash says
  "That was me" 200 of 200 (0 restore stories or fix offers), "why did the hallway lamp turn on at 3?" names
  Fixwright's own flash 200 of 200, "why did the kitchen plug turn on at 3?" takes the 3 a.m. hour 200 of
  200, and "the hallway lamp keeps turning on by itself" (old copy plus a lamp set to switch on when power
  comes back) names the power on setting 200 of 200 with the fix planned and applied 200 of 200 (0 can't
  tell). 800 diagnoses, 0 invalid outputs, 0 invariant violations (400 confirmed, 200 likely, 200 can't tell;
  200 second faults named after setting one aside, 400 fixes planned). An earlier run had 200 confirmed, 200
  likely and 400 can't tell. A later run (17 Oct, exit 0, no problems): every counter above unchanged, plus,
  on a fresh house per seed in the real order (steps 1 to 4, the 07:00 jump, then step 5), the morning check passes
  200 of 200, "Why did every plug turn on at 3 a.m.?" speaks the step 5 line exactly 200 of 200, "at 3"
  gives the same line with "3:12 a.m." 200 of 200, and the 14 step fix is planned 200 of 200; "the hallway lamp
  keeps turning on by itself" answered with no names the power on setting 200 of 200 (0 can't tell). 1000
  diagnoses, 0 invalid outputs, 0 invariant violations (400 confirmed, 400 likely, 200 can't tell, 400 second
  faults, 600 fixes planned). The demo house is the same F1 to F5 on every seed; seeds vary the resident's activity and
  timing, so this is a stress sweep of one house, not 200 different houses.
- `npm run smoke:simhome -w @fixwright/engine` (not in `check`): the golden path on homefault's SimHome seed 1.
  Last run, 17 Oct: every golden path line word for word (unchanged from 15 Oct). Diagnose says "Your hub is
  reachable, the signal is good and the Hue cloud is fine. I'll flash the hallway lamp twice. Did it blink?"
  (stale 0.623, power 0.37), "yes" confirms at 0.945 with the exact verdict, the repair applies with
  read back, explain says "Power came back at 3:12. Fourteen devices restarted within four seconds. None of
  your automations fired." and the 14 step fix applies, the checkup gives exactly the three expected cards, and
  the strip is refused with "I'll turn off the lamp on it instead." (after homefault fixed its demo house data).
- `npm run bench:cpu -w @fixwright/engine`: CPU per step (numbers in README.md and BENCH_CPU.json).
