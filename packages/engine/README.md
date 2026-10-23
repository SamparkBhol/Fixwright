# @fixwright/engine

The reasoning core of Fixwright: it diagnoses a misbehaving device, explains something
the home already did, runs a checkup, checks every factual claim against the event ledger, plans repairs
with inverses and read backs, guards protected loads, and phrases every spoken line.

It is pure TypeScript. All I/O goes through the injected `HomeAdapter` and `Ledger`, time through the
`Clock` and randomness through the `Rng`. No Node built in modules, no `Date.now()` or `Math.random()`, no
top level I/O and no classes, so it runs unchanged in Node 22, Cloudflare workerd and the browser (a test
bundles it for a neutral platform with workerd conditions and runs a diagnosis from the bundle). Its only
dependency is `@fixwright/protocol`. Sessions and plans are plain JSON for the server to persist.

## How it works

**Diagnosis.** Single fault Bayes over ten causes plus an `unknown` catch all. Each cause
has a prior that depends on the device (domain, transport, integration) and on what kind of symptom the
person described (unresponsive, turns on by itself, wrong device, automation). Probes report a value from a
fixed set with a likelihood table P(value | cause); the catch all's likelihood sits halfway between the
typical cause and a flat guess, so evidence that fits nothing shows up as doubt instead of confidence.

1. Every applicable passive probe runs first (hub, availability and flaps, signal, vendor cloud,
   integration state, the signature of a device paired again, registry, power on setting, other Wi-Fi devices).
2. Then active probes (the flash test) and human questions, each chosen by expected information gain
   divided by `1 + 2 * disruption + cost_ms / 2000`. The flash test is valued together with the question it
   makes possible ("Did it blink?"), one step ahead.
3. Quiet hours (default 22:00 to 07:00 household time): a disruptive probe first asks permission. Nothing is
   switched until the person says yes.
4. People are noisy sensors: P(yes | fact) = sensitivity (0.92), P(yes | not fact) = 1 minus specificity (0.95),
   per household. `auditHumanAnswers` moves those rates once sensor evidence shows what was true.
5. Stop at 0.9: confirmed if every claim survives the claim checker, else likely. With no probes left,
   0.6 to 0.9 is likely and below is can't tell, with a line saying what would settle it.
6. Answers accept English and Hindi (parseYesNo from protocol). An unclear answer is asked again once with a
   clearer question. A flash question flashes again so there is something to see, under the same quiet hours
   rule as the first flash: once quiet hours have begun and nobody said yes, the second asking is about the flash
   already done ("Just yes or no, did the hallway lamp blink when I flashed it?") and switches nothing. A
   repeat flash shows on the stepper as its own probe ("Flash test again") with its ledger event.
7. **A named cause needs an observed fault.** A likely or confirmed verdict must keep, after the
   claim checker, at least one claim that cites a probe or answer of this diagnosis that came out `fail` (the
   device offline, a weak signal, the wall switch off, the power on setting on). "The lamp works." or "Your
   hub and its signal look fine." only rule other causes out, so they do not count. Without such a claim the
   top cause is only what the others left over, and the verdict is can't tell.
8. **A device that works when tested gets an honest can't tell.** The catch all `unknown` also stands for a
   fault that is not happening right now (intermittent, or outside the home: the voice service, a routine),
   so on the probes that ask whether the device works now (availability, the flash, the person seeing it,
   the wall switch) it predicts a working device. When the flash answered and the person saw it, nothing
   drains into an unrelated cause: "The kitchen ceiling worked when I tested it just now. So I can't tell
   what went wrong before. If it happens again, ask me right away and I'll test it while it's happening."
9. **A likely verdict says what it is:** "It's most likely an old copy of the device, but I'm not certain."
   The voice only path hears the cause, not only the doubt.
10. **A fix is offered only when it can be planned.** `fix_available` is true only when `canRepair` (the same
    drafts and safety rules as `planRepair`) builds a plan, so "Want me to fix that?" is never followed by
    "I can't fix that one by myself." explain_event's suggested fix follows the same rule.
11. **power_on_default_on is a hypothesis only when it can be tested and could cause the complaint:** the
    device has a power on select or reports the setting, and the person said it turns on by itself (or
    described it vaguely). A power on setting cannot make a device ignore commands or answer to the wrong
    name. Whenever it is a hypothesis, the `power_on_setting` probe reads the setting (from the adapter's
    signal, or the select itself). A setting that can be read but not changed gets guidance ("You can set the
    study lamp to remember whether it was on or off from its maker's app.") instead of a fix. "Won't turn on"
    is read as a device ignoring commands, not one switching on by itself.
12. **A named cause has to fit the complaint.** A likely or confirmed verdict needs the cause's
    symptom weight to be at least `FIT_MIN` (0.2). An old copy, a power cut, a weak signal or a router change
    cannot switch a lamp on by itself, so when the evidence points at one of those for "keeps turning on by
    itself", the verdict is can't tell and the fault is said for what it is: "The hallway lamp worked when I
    tested it just now. I did find an old copy of the device, but that wouldn't switch it on by itself. So I
    can't tell what went wrong before." No fix is offered for the complaint (the checkup still lists the old copy).
    **A house can have two faults.** Before giving up, the engine sets that fault aside together with
    the failed readings it accounts for (a failed reading at least `EXPLAINED_LIKELIHOOD` (0.5) likely under it),
    replays the remaining readings from the prior, and names a second cause when it fits the complaint, clears
    the likely bar on what is left and has a failed reading of its own. On SimHome seed 1, where the hallway lamp
    has an old copy and is also set to switch on when power comes back: "The hallway lamp is set to switch on
    whenever power comes back. I also found an old copy of the device, but that wouldn't switch it on by itself.
    Want me to fix that?" (confirmed at 0.962 on that remainder; the fix sets the online copy's select). The
    verdict's confidence is that remainder posterior; `hypotheses` still shows the single fault posterior.
    The same search also runs when the unfit fault on top is below the likely bar but a reading shows it is
    there, and the second cause needs a failed reading of one of its own probes. The two fault golden house now
    names the power on setting for every answer pattern (before: [yes, no] and [no, yes] ended in can't tell,
    with the old copy or the power problem on top at 0.529 and 0.344), and SimHome's "keeps turning on by
    itself" answered with no names it on all 200 seeds. Only one unfit fault is set aside.
13. **A cause a sensor ruled out is never named.** Each cause has its own probes (the old copy and
    name scans; availability, battery and wall switch for a power problem; link quality; hub; vendor cloud;
    integration state; the power on setting; the automation's references; the other Wi-Fi devices and the
    router). When one of its own sensor probes came out clean at a likelihood of at most `RULED_OUT_LIKELIHOOD`
    (0.05) under it, and none of its own probes failed, the can't tell line and the verdict's cause id skip it.
    Another probe's reading never rules a cause out: the tables are single fault, so in a house with
    two faults one fault's readings must not hide the other. A failed reading never rules a cause out either.
    Example: the living room light (two lights share the name) read online, but the person says
    its wall switch is off: "I can't tell yet. It's most likely a power problem or two devices sharing a name."
 The can't tell line names
    only causes holding at least `NAME_FLOOR` (0.1) of the posterior, so "most likely X or Y" never names
    causes at 0.014 and 0.005; with fewer than two left it says "I can't tell yet." `registry_scan` now gives P(every device present | dead_trigger) = 0.02, so "the night lights automation
    doesn't work" with every device present says "Every device Night Lights uses still exists. So I can't tell
    what went wrong before." instead of "most likely an automation using a removed device".
14. **Battery devices.** A device whose signal reports `batteryPct`, or that has a battery sensor on
    the same device (the Home Assistant shape), is read by the passive `battery_level` probe (below 15% is low)
    and is never asked about a wall switch or a plug. A low battery is claimed and the guidance fits: "The hall
    motion sensor's battery is down to 6%. Your hub and its signal look fine. Put a fresh battery in the hall
    motion sensor." A likely verdict says "a flat battery", not "a power problem". The fresh battery advice
    needs a low reading: a battery device that went offline with its battery at 80% gets "Check that
    the battery in the hall motion sensor is seated properly." instead.

**Explain.** The time window comes from the question ("at 3 a.m." is a 03:00 to 03:59 household hour,
"last night" is 18:00 to 08:00, also this morning, yesterday, an hour ago, in the last hour, over the past 30
minutes, kal raat, 3 baje). A clock time with no day ("at 3 a.m.", "at 3") takes the most recent time that
hour came round in the last 48 hours with something about the device asked about (Fixwright's own writes
count only for the device they switched, when the question names it), else the most recent one with anything
going on in the house, else the most recent one (after the jump to 07:00 the next morning, "Why did
every plug turn on at 3 a.m.?" still tells the 3:12 restore word for word, because the night just past was
quiet). "at 3" with no a.m. or p.m. looks at both 3 o'clocks, and the answer then says a.m. or p.m.
"yesterday at 3" and "today at 3" take that day only; "last night", "this morning" and "this evening" take
the latest one. Detectors in order: power restore (at least 5 devices across at
least 2 integrations come back within 10 s, and the on transitions after it carry no context), automation
trigger, then a person or Fixwright itself (whichever changed the device last), else can't tell. A question
about a blink, flash or flicker is about one quick change, so the latest of those detections answers
("why did the hallway lamp blink?" seconds after a flash test is "That was me.", not the 3:12 a.m. restore). Every number in the answer is computed from the
events: "Power came back at 3:12. Fourteen devices restarted within four seconds. None of your automations
fired." The last sentence is also checked as an absence claim (the ledger must hold no automation run in that
span). When only some of the devices that restarted have a power on setting the fix can change (Home
Assistant: nine restarted, six have a select), the offer says so: "Nine devices restarted within one second.
Six of the nine can remember their last state. I can set those. Do it?" The count is the devices whose select
can be set to previous and is not already, the same test the plan makes.

**Fixwright's own writes are not a person.** The flash test, the repair's on and off check, repair
steps and undo all go through `callService`, and hubs log them with the API user's context (SimHome
`user_api`, Home Assistant `context_user_id`), exactly like an app command. explain_event matches each such
change to Fixwright's own `probe` (flash_test) and `repair` ledger rows by device and time (the row lands up
to 15 s after the change, or 2 s before it) and says "That was me. I switched the hallway lamp at 3:00 to test
it and to check the fix." (cause `user_action` with the label "Fixwright switched it", since the protocol has no cause id of its
own for it yet). The claim cites the home rows and Fixwright's own rows. These changes count as activity
when choosing the window only for a question about the device they switched, and the power restore ignores them.

**The device the question names.** A question about one device ("why did the kitchen plug turn on at
3 a.m.?") gets the restore story only when that device was part of it ("The porch light was one of them.").
Otherwise: "The kitchen plug wasn't one of the fourteen devices that restarted when power came back at 3:12.",
then the other detectors run on that device alone, and no power on fix is offered. "every plug", "all my
lights" and "everything" are questions about the house. Time expressions ("at 3", "3:12 a.m.", "3 baje", "in the
last 2 hours", the same patterns the time window reads) are removed before the device is resolved, so "at 3"
can never pick "Plug 3", while a bare number stays part of the name: "why did plug 3 turn on?" gives "Plug 3
wasn't one of the fourteen devices that restarted when power came back at 3:12 a.m. Someone switched plug 3
from the app at 8:05 a.m." (a name ending in a number is said without "the").

**Guided follow ups.** Causes the person or the vendor fixes still get verified when a sensor can
tell. The diagnosis plans a check and stores it in the session (`guided_check`); only then does the spoken
guidance promise one:

| Cause | Check | Runs | Passes when |
| --- | --- | --- | --- |
| device_power_lost | comes_back | every 5 min for 2 h | the device reports available again |
| radio_link_weak | flaps | once, at the first 07:00 at least 6 h later | no drops since the advice and online now |
| vendor_cloud_outage | cloud_back | every 15 min for 24 h | the vendor's status reports ok |
| account_link_expired | link_back | every 5 min for 24 h | the integration is loaded again |
| wifi_network_changed | comes_back | every 5 min for 24 h | the target and its offline Wi-Fi peers are back |

`evaluateGuidedCheck(check, deps)` returns pending (with `next_check_at`, nothing to push) until it settles
or `until` passes, then pass or fail with a push line ("The study lamp is back online.", "The kitchen plug
dropped off 3 times since yesterday. A plugged in repeater near it should help.") and records the result as a
ledger `note` it cites with the home events behind it. When no sensor can tell (the copy that answers already
reports on, an old copy that will never come back, no vendor, guided mode), there is no check and the line
promises nothing: "Switch the hallway lamp back on at the wall."

**Claim checker.** A claim survives only if every cited seq exists and the events support it: right
entities, right time window, right probe values, exact device count, no automation or user context, and for
absence claims an empty ledger query. Framing lines cite nothing and may not mention numbers, dates or
names. A confirmed verdict that loses a factual claim becomes likely.

**Phraser gate, and its limit.** An optional `phraser` (an LLM) may restyle lines. The gate is lexical,
not a semantic claim check: a rephrased sentence must carry the template's content words in the same order
(word forms may change, "works" and "working"), may only add or drop style words (articles, fillers like "so"
and "okay", a few small words such as of, to, at, for, with, still and just), must keep the negation and the
question mark, and may add no number, date, quantity, device word or name. Pronouns and the helpers be, have
and do have their own checks: the template's pronouns must all appear in the same order, the only
ones a rephrase may add are the implied "you" ("Do you want me to fix that?") and a resumptive "it", and it may
add no tense the template lacks (a template with no helper may gain a present one, "works" to "is working").
Otherwise the template line is spoken. That rejects meaning reversals ("The lamp works." to "The lamp is
broken.", "Power came back at 3:12." to "Power went out at 3:12."), word order swaps, swapped people ("I
switched it" to "You switched it", "your automations" to "my automations") and changed tense ("is reachable"
to "was reachable", "has been" to "had been", "Its wall switch is off." to "Was its wall switch off."). It still
does not understand meaning: it cannot judge a synonym, so it leaves a phraser almost no freedom (warmth, not
new wording), and the small words above can be added or dropped. No model is wired today.

**Checkup.** Duplicate names, old copies left behind, flapping, low batteries, dead triggers, power on
set to on, failed integrations and unprotected essential loads, 3 to 5 findings, most severe first. Each
finding is backed by a ledger event and the home events behind it.

**Repairs.** `planRepair` builds steps (adapter op, read back expectation, inverse), a diff, plain diff
lines and protected conflicts. Automatic causes: stale duplicate (point the name at the online copy, move the
old copy's other names to it, retire the old copy, switch the lamp on and off to check), power on default
(each select to `previous`), name collision (rename one, with a proposed distinct name), hub down (reload),
dead trigger (turn the automation off). Other causes return `no_fix` with spoken guidance (and a guided
check where one exists). Locks, garage doors, alarms and cameras are never touched; a protected load is never
switched off. `executePlan` runs steps with read back and rolls back on the first mismatch; `undoPlan`
reverses and says what it undid ("Undone. Those fourteen power on settings are back the way they were.",
"There's nothing to undo." for a hub reconnect); `morningCheck` confirms the repair held.

**Morning check honesty.** Only plans a sensor can verify get one: lamp commands answered, settings still
set, the device still online (`isVerifiable(plan)`). A rename or a disabled automation has nothing to
measure, so `morningCheckAt` returns undefined, `executePlan` promises no check, and `morningCheck` returns
`not_checked` with empty speech, never "Repair confirmed". Every checked result (pass or fail) appends a ledger
`note` with what it read (each setting's state, or the commands, replies, drops and current states) and
cites it next to the home events, so even a quiet night's "stayed online all night" has evidence.
One setting is spoken as one ("The power on setting held overnight.", "One of the fourteen power on settings
changed back overnight."), and so is one command ("answered the one command it got overnight"), and two
("answered both commands it got overnight", never "all 2"). A lamp that
answered every command but dropped off says both, never "missed 0 of 9": "Hallway lamp answered all 9
commands overnight, but went offline once. I'll take another look."; missed commands plus drops: "Hallway
lamp missed 2 of 9 commands and went offline 3 times overnight. I'll take another look."

**Protected loads.** `protectedGuard` refuses switching off a protected device or the strip feeding
it, and offers one unprotected outlet (a light that is on comes first), so the spoken offer names exactly
what the server switches: "That strip runs the aquarium filter, which you marked protected. I'll turn off
the lamp on it instead."

## API

All exports come from `src/index.ts`.

```ts
import {
  startDiagnosis, answerDiagnosis, explainEvent, runCheckup, planRepair,
  executePlan, undoPlan, morningCheck, protectedGuard, inferTopology, phrase, warmUp,
  createMemoryLedger, defaultSettings, nextLocalTime,
} from '@fixwright/engine';

const deps: EngineDeps = { adapter, ledger, clock, rng, settings: defaultSettings({ tz, protected: [] }) };
```

| Function | Returns |
| --- | --- |
| `startDiagnosis(input: DiagnoseInput, deps)` | `{ session: DiagnosisSession, output: DiagnoseOutput }` |
| `answerDiagnosis(session, input: DiagnoseAnswerInput, deps)` | `{ session, output: DiagnoseAnswerOutput }` (input session is not mutated) |
| `explainEvent(input: ExplainEventInput, deps)` | `{ session: ExplanationSession, output: ExplainEventOutput }` |
| `runCheckup(input: HomeCheckupInput, deps)` | `{ session: CheckupSession, output: HomeCheckupOutput }` |
| `planRepair(source: RepairSource, deps)` | `{ plan: RepairPlan, output: RepairPlanOutput }` |
| `canRepair(causeId, entityIds, deps, house?)` | whether `planRepair` could build a plan now (same drafts and safety rules; changes nothing) |
| `executePlan(plan, deps, hooks?)` | `{ state: 'applied' \| 'rolled_back' \| 'failed', steps: RepairStep[], applied: number[], speech }` |
| `undoPlan(plan, applied, deps)` | `{ ok, steps: RepairStep[], speech }` |
| `morningCheck(plan, sinceIso, deps)` | `{ result: 'pass' \| 'fail' \| 'not_checked', detail, speech, answered, total, evidence }` |
| `morningCheckAt(plan, appliedAtMs, tz)`, `isVerifiable(plan)` | the next 07:00 household time as ISO, or undefined when there is nothing to check |
| `evaluateGuidedCheck(check, deps)` | `{ result: 'pending' \| 'pass' \| 'fail', detail, speech, next_check_at?, evidence }` for `session.guided_check` |
| `planGuidedCheck(input)` | the `GuidedCheck` for a guided verdict, or undefined (the diagnosis calls it) |
| `protectedGuard(action, entity, protectedSet, topology, { states }?)` | `{ allow: true }` or `{ allow: false, code, blocked, alternative?, alternatives, speech }` |
| `inferTopology(entities)` | `Topology` (power strips and what each outlet feeds) |
| `phrase(key, params)` | the template line (`PHRASE_KEYS` lists every key) |
| `checkClaims(claims, ledger, opts?)`, `checkVerdict(verdict, claims, ledger, opts?)` | kept and dropped claims; the downgraded verdict and the kept claims with their support |
| `applyOp`, `readBack`, `runAction` | one op through the adapter; one read back check |
| `auditHumanAnswers(session, causeId, reliability)` | updated household reliability and contradicted question ids |
| `warmUp(tz?)` | runs every tool path on a tiny in memory house (see below) |
| `parseTimeWindow(question, nowMs, tz)`, `timeWindowCandidates(question, nowMs, tz)`, `withoutTimes(question)`, `resolveTarget(house, text, device?)` | the parsers, exposed for the router and tests (`timeWindowCandidates` gives every time a clock hour with no day came round in the last 48 hours, both 3 o'clocks for "at 3", most recent first; `parseTimeWindow` keeps the most recent; `withoutTimes` takes out the time expressions and keeps "plug 3", "Outlet 12" and "Hallway Lamp 2") |
| `FIT_MIN` (0.2), `RULED_OUT_LIKELIHOOD` (0.05), `EXPLAINED_LIKELIHOOD` (0.5), `NAME_FLOOR` (0.1) | the verdict honesty thresholds described under Diagnose |
| `createMemoryLedger()`, `syncHomeEvents(deps, query)` | in memory ledger; copy adapter events into a ledger once |

`RepairSource` is `{ kind: 'diagnosis', session } | { kind: 'issue', session: CheckupSession | ExplanationSession, issue_id } | { kind: 'explanation', session }`.

Errors are thrown as `Error` objects that also carry the protocol `ProtocolError` fields (`code`,
`speech`, `retryable`), so `problemOutput(err, source, ids)` turns them into an `isError` result:
`ambiguous_device`, `session_expired`, `question_answered`, `no_fix` (with guidance speech), `not_found`,
`unsafe_device`. Every output validates against `ToolOutputs.<tool>` (tested).

### Ledger

```ts
interface Ledger {
  append(e: Omit<HouseEvent, 'seq'>): Promise<number>;
  query(q: { since?; until?; entityIds?; kinds?; seqs?; source? }): Promise<HouseEvent[]>; // ANDed, inclusive, seq order
}
```

The engine copies the adapter's home events into the ledger before reasoning (deduplicated by time, kind,
entity, transition and context), and appends `probe`, `human_answer` and `repair` events of its own. Their
`data` carries `probe_id`, `value`, `entity_ids` and `diagnosis_id` or `plan_id`.

## What the server does with it

1. Store each session or plan as JSON (diagnoses, explanations, checkups, plans) and pass it back.
2. Pass a crypto backed `Rng` (`crypto.getRandomValues`): plans draw their `confirm_token` from it. Store
   the token hash; `expires_at` is 5 minutes.
3. Call `await warmUp()` at module scope next to `primeSchemas()`. First use of Intl time zone data and V8
   compiling the engine cost as much as the request budget; at module scope they count against the startup
   limit instead. Cost in the last run (median of 5 fresh processes): 32.761 ms of CPU at startup, which
   brought the first diagnose from 12.857 ms down to 6.445 ms. It is safe in a Worker's global scope: it
   runs on its own tiny in memory house with a fixed clock and a seeded generator, so it makes no I/O, sets
   no timer and draws no random value (`test/units.test.ts` traps all three while it runs).
4. Run `executePlan(plan, deps, { claim })` where `claim(key)` is the Durable Object compare and set on
   `plan_id:step`, so a retried alarm never runs a step twice. Keep `applied` for undo.
5. After `executePlan`, take `next_check_at = morningCheckAt(plan, now, tz)`. When it is undefined, schedule
   nothing and leave `next_check_at` out of repair_apply. Otherwise run `morningCheck(plan, repairedAt, deps)` at
   that time, with `repairedAt` read as `adapter.now()` once the repair has finished (SimHome
   writes take virtual time, so the repair's own check then falls before it), record `{ at, result, detail }` in checks, push its `speech`, and on a pass run `plan.follow_up`
   (removing the retired copy from the registry; no undo is offered after that). Then `auditHumanAnswers` with
   the confirmed cause and store the new reliability. A `not_checked` result is never recorded or pushed.
6. `switch_device`: call `protectedGuard('turn_off', entity, settings.protected, topology, { states: entities })`;
   on a refusal, switch only `alternative` and speak `speech`.
7. When a diagnosis session has `guided_check`, store it and add a due row at its `check_at`. On each run call
   `evaluateGuidedCheck(check, deps)`: pending means enqueue again at `next_check_at` and push nothing; pass or
   fail means push `speech` and stop. On a pass, `auditHumanAnswers(session, check.cause_id, reliability)`.
   This replaces a separate vendor cloud recheck: its verdict carries a `cloud_back` check.

## Adapter data the engine reads

Both `homefault` (SimHome) and `@fixwright/adapter-ha` already produce these; the engine was run against

- Availability: rows with `from: 'unavailable'` or `to: 'unavailable'` (kind `availability` or `state`). A
  device that comes back already on is one row, `unavailable` to `on`.
- Restarts: `data.uptime_reset: true`, `data.boot_reason` containing "power", or a `power` row on an entity
  with `data.event` boot and `data.reason` PowerOnReboot (Matter BootReason). A `power` row with no entity and
  `to: 'on'` is mains power returning.
- Commands: `service_call` rows with `data.service` ending in `turn_on` or `turn_off` (the morning check).
- Automations: `automation_run` rows with `context.automationId` and an optional `data.trigger`; automation
  entities list what they use in `attributes.references` (or `entity_ids`, `entities`).
- Power on behaviour: a select on the same device or named `select.<object id>_power_on_behavior` (also
  `power_on_behaviour`, `start_up_on_off`, `startup_on_off`), options including `previous`.
- Power strips: a switch whose name says strip; outlets on the same device, named `<strip>_outlet_<n>`, or
  with `attributes.power_strip`; the outlet number in `attributes.outlet`; the load is `attributes.load` or
  the outlet's name.
- Ghosts: `restored: true` or `registryOnly: true`, unavailable for over 24 h.

## Integration notes for homefault, the server and the demo

`npm run sweep:simhome -w @fixwright/engine` runs the golden path on SimHome seeds 1 to 200 (last run 17 Oct
check, both in the sweep's order and in the real order (step 5 after the 07:00 jump), and none of the past
failures the sweep replays come back. The engine run on SimHome seed 1 (`npm run smoke:simhome`, same day)
speaks every golden path line word for word: "Your hub is reachable, the signal is good and the Hue cloud
is fine. I'll flash the hallway lamp twice. Did it blink?", the step 2 verdict at 0.945, "Power came back at 3:12.
Fourteen devices restarted within four seconds. None of your automations fired.", the three checkup cards, and
"That strip runs the aquarium filter, which you marked protected. I'll turn off the lamp on it instead." Three
gaps in the demo house data that the engine needed were fixed in homefault.

Sequencing: "Why did every plug turn on at 3 a.m.?" asked after the jump to 07:00 the next morning (the real
order: steps 1 to 4, then 5) gives the step 5 line word for word, with the 14 setting fix, on SimHome seeds 1
to 200 (`test/simhome-morning.test.ts` and the sweep's next morning counters). The answer does not add "yesterday": the person asked about 3 a.m., and the most
recent 3 a.m. with anything in it is the one that is answered. The checkup's "today" wording after the jump is
a homefault and server matter, not the engine's.

## Choices worth knowing

- **Retire is reversible.** The fix for an old copy is to remove it from the registry. Home Assistant
  cannot bring a removed registry entry back, so undo would be impossible. The plan disables the old copy
  (which already takes it off voice control), and removal waits in `follow_up` until the morning check
  passes. The spoken diff line stays the same: "The old copy, offline since 3 October, is retired."
- **The signature of a device paired again is one observation.** An online copy with the same name plus an old copy the
  integration no longer provides is one fact about one event (pairing it again), so `duplicate_name_scan` reports
  it as `stale_pair` and `registry_scan` only runs when there is no copy. Counting them separately made the
  diagnosis overconfident before anyone was asked.
- **Two extra passive probes.** `power_on_setting` (whenever power_on_default_on is a hypothesis) and
  `wifi_peers` (other Wi-Fi devices offline, for a router change). Probe ids are open in the protocol.
- **Priors and likelihood tables are model parameters**, judgement calls about how common each fault is and
  how integrations report state (for example: integrations report state optimistically, so a device with no
  power can still seem to answer the flash test). They are not measurements; the HomeTruth bench measures
  how the diagnoses hold up. On the golden house they give 0.624 for the stale copy before the question and
  0.946 after "yes", the "about 94%" the golden path speaks.
- **A symptom weight of 0 means "cannot cause this complaint".** Only power_on_default_on has them (for "not
  responding" and "wrong device"). The other small weights stay above 0 on purpose: the symptom classifier is a
  word list, and a hard 0 would make a misread complaint unrecoverable. Naming a cause takes more: a weight of at least `FIT_MIN` (0.2), so a weight such as 0.05 keeps a
  misread complaint recoverable in the posterior but can never make an unrelated fault the answer.

## Measured (Node 22.22.1, linux x64, 17 Oct 2026, `npm run bench:cpu -w @fixwright/engine`)

CPU per tool step on the golden house, 200 runs after 20 warmup runs, fresh house and ledger each run
(`process.cpuUsage`, which also counts V8 helper threads). Workers allow 10 ms per request on the Free plan.
Last run, at a load average of about 12 on 16 cores (14:31 UTC, while a local LLM
benchmark ran 8 threads):

| Step | median | p95 | max |
| --- | --- | --- | --- |
| diagnose (all passive probes, battery, flash, question) | 0.919 ms | 2.888 ms | 5.714 ms |
| diagnose_answer (verdict, claim check, second fault, fix feasibility) | 0.371 ms | 1.878 ms | 4.377 ms |
| repair_plan | 0.134 ms | 0.343 ms | 1.424 ms |
| explain_event (own writes matched, 48 hour window candidates) | 0.684 ms | 2.377 ms | 3.833 ms |
| home_checkup | 0.653 ms | 2.254 ms | 5.618 ms |

First request in a fresh process in this run (median of 5): without `warmUp()` diagnose 12.857 ms (still over
the 10 ms budget for a cold isolate), diagnose_answer 3.922 ms, explain 7.082 ms, checkup 3.377 ms; after
`warmUp()` (32.761 ms at startup) diagnose 6.445 ms, diagnose_answer 1.155 ms, explain 3.112 ms, checkup 1.847 ms.
The checkup code did not change between these runs and rose from 0.575 to 0.653 ms against the 13:00 UTC run below
(load about 2 to 4), so most of every rise is the machine. Relative to the checkup, explain went from 0.98 to
1.05 times its median.

An earlier run (17 Oct, 13:00 UTC, load about 2 to 4) gave diagnose 0.759, diagnose_answer 0.328, repair_plan 0.118,
explain 0.562 and checkup 0.575 ms (p95 2.555, 1.353, 0.172, 1.855 and 1.833 ms); first diagnose in a fresh
process without `warmUp()` 11.339 ms.

The 12:37 UTC run (17 Oct, load about 12) gave diagnose 1.115, diagnose_answer 0.413, repair_plan 0.143,
explain 0.676 and checkup 0.707 ms.

The 15 Oct run (load about 4.5) gave diagnose 0.754, diagnose_answer 0.324, repair_plan 0.118,
explain 0.727 and checkup 0.571 ms; the checkup code did not change between those two runs and rose by the same factor
as diagnose, so the difference is mostly load. First request in a fresh process in the 12:37 UTC run (median of 5): without
`warmUp()` diagnose 12.733 ms, explain 4.238 ms, checkup 3.489 ms; after `warmUp()` (32.128 ms at startup)
diagnose 5.76 ms, diagnose_answer 1.144 ms, explain 2.657 ms, checkup 1.839 ms.

Earlier runs: an older one gave diagnose 0.729 ms and checkup 0.579 ms at a load average of about 6. Runs earlier
the same afternoon, at load averages of 8 to 12, gave diagnose medians of 1.29 to 1.42 ms and p95 up to 5.2 ms,
with one max of 10.4 ms; the unchanged checkup code rose the same way (0.85 to 0.96 ms), so that spread is the
machine, not the engine.

First request in a fresh process in the 15 Oct run (median of 5 processes): without `warmUp()` diagnose 11.224 ms,
explain 8.519 ms, checkup 5.48 ms, so a cold isolate's first diagnose is over the 10 ms budget; after `warmUp()`
(28.253 ms at startup) diagnose 5.519 ms, diagnose_answer 1.143 ms, explain 5.473 ms, checkup 2.682 ms. These
first request numbers swing widely with load (a diagnose median after warmUp of 6.3 ms over 15 processes at a
load average of 11). A wider warmUp (adding a power strip, a power on diagnosis and a morning check) was tried in
an interleaved A/B of 25 processes each: it lowered the first diagnose (5.68 to 4.80 ms) and checkup (3.63 to
1.37 ms) but raised the first explain (5.17 to 7.16 ms), so the worst single request got worse and it was not
kept. Measured in Node, not inside workerd. Raw numbers: `BENCH_CPU.json`.

## Testing

From the repo root:

```
npm run check -w @fixwright/engine        # tsc on src (no Node types), tsc on tests and scripts, vitest
npm run bench:cpu -w @fixwright/engine    # CPU per step, writes BENCH_CPU.json
npm run smoke:simhome -w @fixwright/engine  # the golden path on SimHome seed 1, printed line by line
npm run sweep:simhome -w @fixwright/engine  # the golden path and the replayed past failures on SimHome seeds 1 to 200
```

`test/support/` holds the FakeAdapter (an in memory home that, like real integrations, reports state
optimistically and can ignore commands), `verdict-invariants.ts` (the rules every finished diagnosis
must meet, used by the golden house sweep, the property test and the SimHome sweep) and the golden house: F1 hallway lamp paired again on 3 Oct, F2 the
03:11:58 to 03:12:00 power cut with 14 devices across zigbee2mqtt, kasa and matter, F3 two Living Room
Lights, F4 the kitchen plug's 9 drops at -82 dBm, F5 the motion sensor at 6%, and the living room strip with
a reading lamp on outlet 1 and the aquarium filter on outlet 2. `test/simhome-morning.test.ts` runs the golden
path in its real order on homefault's SimHome (seeds 1 to 3), importing homefault by path like the sweep, so the

## Versions

No dependencies beyond `@fixwright/protocol` (and its zod 4.6.5). From the root: typescript 6.0.3,
vitest 5.0.2, esbuild 0.28.2 (purity test), @types/node 22.20.4. No package was added.
