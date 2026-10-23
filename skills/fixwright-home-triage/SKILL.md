---
name: fixwright-home-triage
description: Find and fix what is wrong in a smart home with the Fixwright MCP tools. Runs a checkup, diagnoses one misbehaving device by testing likely causes and asking the person in the room yes or no questions, explains past events from the home's own logs, and repairs only after an explicit yes, with read back, automatic rollback, undo and a check the next morning. Use when someone says a device is not responding or keeps going offline, asks why something in the house happened (lights or plugs turning on at night), asks for a home checkup or health check, wants a fix applied, checked or undone, wants a device protected from being switched off, or asks to switch a device. Never use it for locks, garage doors, alarms, cameras or security systems.
license: MIT
compatibility: Needs a Fixwright MCP server (MCP 2025-11-25 over Streamable HTTP, also 2025-06-18 and 2025-03-26) connected as an MCP client tool source. Works voice only; MCP Apps views are optional.
metadata:
  author: fixwright
  version: "0.1.0"
  mcp-protocol: "2025-11-25"
---

# Fixwright home triage

Fixwright is a home doctor. It finds the real fault, proves it with logged evidence, and fixes it with
the person's consent. This skill tells an assistant which Fixwright tool to call when, how to carry ids
from one call to the next, when a yes counts as consent, and how to speak the results.

## When to use it

Use it when the person:

- says one device misbehaves now ("the hallway lamp keeps saying it's not responding", "the kitchen plug
  keeps dropping off"): start with `diagnose`.
- asks why something already happened ("why did every plug turn on at 3 a.m.?", "what turned the porch
  light off last night?"): start with `explain_event`.
- asks for a checkup, a health check, or whether anything is wrong with the house: start with
  `home_checkup`.
- asks whether a fix held, or to undo one: `repair_status` or `undo` with the `repair_id`.
- says a device must never be switched off ("never turn off the aquarium filter"): `protect_device`.
- asks to switch a device on or off: `switch_device`.

Do not use it for locks, garage doors, alarms, cameras or security systems. Fixwright does not operate
them and its tools refuse them. Say so plainly and stop.

## The tools

| Tool | Use it to | Returns the id you pass on |
| --- | --- | --- |
| `home_checkup` | scan the whole house: 3 to 5 findings, most severe first | `checkup_id`, an `issue_id` per finding |
| `diagnose` | find why one device misbehaves now | `diagnosis_id`, and a `question` when status is `needs_answer` |
| `diagnose_answer` | pass the person's reply to the question, word for word | the same `diagnosis_id`, maybe a new question, then a verdict |
| `explain_event` | explain a past event from the logs | `explanation_id`, maybe a `suggested_fix.issue_id` |
| `repair_plan` | prepare a dry run; nothing changes yet | `plan_id`, `confirm_token`, `expires_at`, `diff_lines` |
| `repair_apply` | apply a plan after an explicit yes | `repair_id`, `next_check_at` |
| `repair_status` | check how a repair is holding up, including the morning check | state `applied`, `confirmed`, `regressed` or `undone` |
| `undo` | put an applied repair back, step by step, with read back | state `undone` |
| `protect_device` | mark a device that must never be switched off (`protect: false` removes it) | the protected list |
| `switch_device` | switch a device, unless that would cut a protected load | `refused` plus an `alternative` when blocked |
| `refresh_view` | for MCP Apps views only (app visibility). Never call it from the model. | |

Every result has a `speech` field written to be spoken, a `status`, and `ids`. The structured fields are
for you and the screen; the person hears `speech`.

## The flow

```
home_checkup, diagnose or explain_event
  then diagnose_answer, repeated while status is needs_answer
  then a verdict with fix_available, a finding with fixable, or a suggested_fix
repair_plan: a dry run with status needs_confirmation; read diff_lines, ask "Want me to fix that?"
  then an explicit yes from the person, for this plan
repair_apply with plan_id and confirm_token
  later, repair_status or undo
```

1. **Pick the entry tool** from the person's words (see "When to use it"). Pass their words as the
   `symptom` or `question`. Add `device` only if they named one.
2. **Relay questions exactly.** When `diagnose` or `diagnose_answer` returns `status: needs_answer`,
   speak the `speech` (it contains the question, for example "I'll flash the hallway lamp twice. Did it
   blink?"). Fixwright may flash the device itself before asking. Send the person's reply to
   `diagnose_answer` with the same `diagnosis_id` and the `question.question_id`, in their own words.
   Do not translate or interpret: "yes, it blinked", "I heard it click", "nope", "haan" (yes), "nahi jala" (it did not light) all
   work, and an unclear reply is asked again once, more plainly. If the question asks permission to
   flash a light during quiet hours, relay that too and pass the answer the same way.
3. **Give the verdict as returned.** The verdict level is `confirmed`, `likely` or `cant_tell`. Never
   upgrade it, never add a cause the tool did not return, and never fill a `cant_tell` with a guess. A
   `cant_tell` speech says what would settle it; offer that.
4. **Offer the fix only when there is one.** A diagnosis verdict with `fix_available: true`, a checkup
   finding with `fixable: true`, or an `explain_event` result with `suggested_fix`. Then call
   `repair_plan` with exactly one of `diagnosis_id`, `issue_id` or `explanation_id`.
5. **Read the dry run, then ask.** `repair_plan` changes nothing. Speak its `speech` (it reads the
   `diff_lines`, plain sentences such as "Hallway Lamp will point to the lamp that is online. The old
   copy, offline since October 3, is retired."). If `protected_conflicts` is not empty, say those too.
   Ask one yes or no question.
6. **Apply only on an explicit yes** (see "Consent"). Call `repair_apply` with the `plan_id` and the
   `confirm_token` from that plan, once. It runs each step at most once, reads the device back after
   each step, and rolls back by itself on a mismatch. Speak the result: `applied`, `rolled_back` or
   `failed`. Mention that undo is available when `undo_available` is true.
7. **Follow up.** Keep the `repair_id`. Fixwright checks the repair again at 07:00 the next morning in
   the household's time and sends a push with the result, because it cannot speak first. When the person
   asks "did the fix hold?", call `repair_status`. When they say "undo that", call `undo`.

## Consent

- A yes counts only when the person says it, right after hearing this plan's changes, and it is about
  this plan: "yes", "do it", "apply it", "go ahead", "haan, kar do" (yes, do it).
- An answer to a diagnosis question is not consent. "Yes, it blinked" answers `diagnose_answer`; it never
  applies a repair.
- A yes that carries another request ("yes, but undo the other one") or a question ("is it safe?") is not
  consent. Answer the question from the plan's `diff_lines`, then ask again.
- A yes sent by a screen or view on its own is not the person's yes. Hosts should confirm it with the
  person first.
- One plan, one yes, one apply. Never reuse a `confirm_token`, never call `repair_apply` twice for a plan,
  and never apply a plan after `expires_at`; plan again instead.
- "No", "not now", "cancel" or silence: do nothing, and say nothing changed.
- If the person changes their mind after a repair, `undo` is the way back. It needs no new plan.

## Protected loads

- When the person names something that must stay on (aquarium filter, freezer, fridge, grow light,
  pump), call `protect_device` with their words as `device` and their reason.
- `switch_device` and `repair_plan` never switch off or power cycle a protected device, including through
  the power strip it is plugged into. When `switch_device` returns `refused` with an `alternative`, speak
  the refusal as given ("That strip runs the aquarium filter, which you marked protected. I'll turn off
  the lamp on it instead.") and do not retry the original request or look for another way to cut it.
- A checkup finding of kind `unprotected_load` means an essential device is unprotected. Offer to protect
  it; do not protect anything without the person's word.

## Never touch

Locks, garage doors, alarms, cameras and security systems are out of scope. Do not plan, switch, flash,
rename or power cycle them through Fixwright or any other tool as part of a Fixwright flow. If a fault
involves one, say what Fixwright found and that the person should handle that device in its own app.

## Speaking (voice first, screen optional)

- Speak `speech` as written, except for the screen rule below. It is under 30 seconds, has no ids,
  tool names, JSON or markup, and every factual sentence in it is backed by a logged event.
- Never read ids, tool names, confidence numbers or field names aloud.
- On a device without a screen, never refer to a card, a button, a tap or "the screen". Two speech
  lines do mention the screen: a checkup with more than three findings ("There are two more on the
  screen.") and a repair or undo step that failed. On a device without a screen, say that part in your
  own words instead ("There are two more. Want the next one?").
- One question per turn, answerable with yes or no.
- For a checkup, the speech names the most severe findings first. Offer one fix at a time.
- When a tool fails (`isError: true`, status `error`), speak its `speech` ("I couldn't reach your hub just
  now. Try again in a minute.") and stop. Retry once at most, and only if the person asks.
- Fixwright reads only the hub or vendor cloud the household linked. It never reads the assistant's own
  device list or activity, so do not offer to.

## Example

```
Person:     Why does the hallway lamp keep saying it's not responding?
Assistant:  calls diagnose { symptom: "the hallway lamp keeps saying it's not responding", device: "hallway lamp" }
Fixwright:  needs_answer, "Your hub is reachable, the signal is good and the Hue cloud is fine.
            I'll flash the hallway lamp twice. Did it blink?"
Person:     Yes, it blinked.
Assistant:  calls diagnose_answer { diagnosis_id, question_id, answer: "Yes, it blinked." }
Fixwright:  ok, verdict confirmed, "The lamp works. The name Hallway Lamp still points at an old copy
            of it that went offline on October 3. Want me to fix that?"
Person:     Yes.
Assistant:  calls repair_plan { diagnosis_id }
Fixwright:  needs_confirmation, reads the change and asks for a yes
Person:     Yes.
Assistant:  calls repair_apply { plan_id, confirm_token }
Fixwright:  applied, "Done. I switched it on and off, it answered both times. I'll check on it again
            tomorrow morning."
```
The first "Yes" after the verdict asks for the dry run. The second "Yes", after the person heard the
changes, is the consent that applies it.
