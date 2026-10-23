# @fixwright/router: what the tests prove

Run: `npm run check -w @fixwright/router` from the repo root.

- [x] Every golden path utterance routes to the right tool with the right arguments,
      including the wake word and "ask Fixwright" invocation being stripped (`route.test.ts`, "golden" cases).
- [x] The golden path as one conversation chains ids: diagnose then diagnose_answer then repair_plan then
      repair_apply then explain_event then repair_plan then home_checkup then switch_device (`state.test.ts`).
- [x] Diagnose variants: offline, isn't working, won't turn on (with and without "why"), keeps going
      offline, what's wrong with, unavailable, stopped responding, go offline, gone offline, dropping off
      wifi, is X broken, "I can't get X to turn on", Hindi "kaam nahi kar raha", pronoun "it" resolved to
      the last device, device extracted per clause; a reporter ("Alexa says", "the app says") is never
      taken as the device; a named device or a bare device clause beats "it"; a filler clause is not a
      device. Also: "is X working?", "is X online", "is X not working?" (device whole), "why won't my
      bedroom lamp switch on", "switch" inside a device name, "why does it keep saying X is not
      responding" (X, not "it"), "it keeps saying it's ..." (still the last device), "what is going on
      with X".
- [x] Pending question: yes, no, "it didn't blink", haan, nahi jala, jal raha hai, Devanagari, "I heard
      it click", hedges and mumbles go to diagnose_answer word for word; "No, it's still not working" is an
      answer, not a new diagnosis; a clear new request (checkup, switch) leaves the question; a question
      back ("is the porch light working?") is a new request, not a yes.
- [x] Pending plan: yes, do it, fix it, go ahead, okay, haan kar do give repair_apply with that plan's
      plan_id and confirm_token; no, "don't do it", cancel, stop, wait, "not now, thanks" and "rehne do"
      decline and return a state without the plan; "stop protecting X" stays a request. A question never
      spends the plan ("is everything ok?" gives checkup, "is the hallway lamp working" gives diagnose), "yes,
      it blinked" gets the plan waiting reply, and "can you do it" is consent. "apply it", "Apply
      the fix." and "Yes, apply it please" apply the plan with its token; "Is it safe?" and "What will it
      change?" get exactly the plan's two diff lines between the read back opener and "Shall I apply it?";
      "Yes, is it safe?" reads back too, and "yes, undo it" gets the plan waiting ask, never repair_apply.
- [x] Pending question: cancel stops the diagnosis (intent cancel); "wait" is passed on as an answer.
- [x] A confirm_token is never sent unless a plan is pending (checked across 5 yes phrases x 6 states).
- [x] Pending offer: fix that, yes please, sure fix it, "yes it did" give repair_plan with diagnosis_id,
      issue_id or explanation_id; no and "maybe later" decline and clear only the offer; "yes, it blinked"
      gets the offer waiting reply.
- [x] `consentOf` over 23 replies: yes, "Yes, apply it", "apply it", "apply the fix", do it, go ahead, haan
      kar do, okay, a wake word plus yes give yes; no, "Not now", cancel, rehne do, "don't do it" give no; "Yes,
      it blinked.", "is everything ok?", "is the hallway lamp working", a new request, "yes undo it", "Yes,
      undo it.", "yes, is it safe?", "what will it change?" and empty input give unclear (so none of them can
      answer a host's "Apply this fix?" sheet with yes).
- [x] explain_event: at 3 a.m., last night, 11 pm, 3:12, overnight, Hindi "kal raat kya hua";
      "why did X stop responding" stays a diagnosis, "why did X go offline at 3 a.m." is explained.
- [x] Checkup (checkup, check up, health check, anything wrong with my house, is my house ok, is
      everything alright, what's going on with my house, what's wrong with my home, focus on a room,
      batteries) and fixing a finding by ordinal, by name or by kind ("fix the duplicate name", "the wifi
      one"); a device that is not among the findings is diagnosed; an unfixable finding gets a reply that
      passes on the server's own advice (its `detail`), and an older state without `detail` still gets a
      reply.
- [x] switch_device (on, off, shut down, polite forms, Hindi band and chalu, "it"), protect_device
      (protect, never turn off ... because ..., don't ever switch off, always keep on), unprotect.
- [x] undo and repair_status with the last repair id; replies when there is nothing to undo or check.
- [x] Status questions that name a device ("did the hallway lamp fix hold?", "is the fix on the hallway
      lamp holding?", "status of the hallway lamp fix") go to that device's repair even when a newer repair
      (the power on fix) also touched it; a device only the newer repair touched goes to that one; a device
      no repair touched gets `noRepairFor`; "did my fix hold?" and "did last night's fix hold?" mean the
      newest repair; a state without the repair list falls back to the newest; "yes, did the hallway lamp
      fix hold?" never applies a waiting plan (test/named-status.test.ts).
- [x] Repair memory: each applied repair with its subject (the diagnosed device or the finding) and its
      text, newest last, at most MAX_REPAIRS, a failed apply remembers nothing; `repairForText` finds the
      repair a push names, and null when it names none.
- [x] Replies for empty input, the bare wake word, help, a stray yes and unknown requests.
- [x] Every tool route's arguments pass the protocol zod input schema.
- [x] State machine: questions, offers, plans, findings, ids, devices; dead plans dropped after
      plan_expired, plan_used and token_mismatch; retryable failures keep the plan; question_answered
      clears the question; junk structuredContent never throws; state round trips through JSON.
- [x] routeUtterance never mutates the state it is given.
- [x] Source is pure: no Node built in modules, clock, randomness, fetch, process or timers.
