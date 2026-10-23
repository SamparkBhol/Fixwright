# @fixwright/router

Deterministic routing from what a person says to the Fixwright tool that should handle it, plus the
small conversation state machine that makes "yes" mean the right thing. No model, no quota: the
golden path never depends on an LLM. Pure TypeScript (no I/O, no clock, no
randomness), so the same code runs in the host simulator bundle, behind the server's
`/assistant/route`, and in Node tests.

## API

```ts
import { routeUtterance, applyResult, initialState, isToolRoute } from '@fixwright/router';

let state = initialState();                       // plain JSON, safe to persist
const route = routeUtterance("Alexa, ask Fixwright why the hallway lamp keeps saying it's not responding.", state);
if (isToolRoute(route)) {
  // route = { tool: 'diagnose', arguments: { symptom: "why the hallway lamp ...", device: 'hallway lamp' }, intent: 'diagnose' }
  const result = await client.callTool({ name: route.tool, arguments: route.arguments });
  state = applyResult(state, { tool: route.tool, arguments: route.arguments, structuredContent: result.structuredContent, isError: result.isError });
} else {
  speak(route.reply);                              // { reply, intent, state? }
  if (route.state) state = route.state;            // the person declined a plan or an offer
}
```

- `routeUtterance(utterance, state?) -> ToolRoute | ReplyRoute`
  - `ToolRoute = { tool: ToolName; arguments: Record<string, unknown>; intent: Intent }`. Arguments always
    pass the protocol input schema (tested for every table case).
  - `ReplyRoute = { reply: string; intent: Intent; state?: ConversationState }`: say `reply`; when `state`
    is present, keep it (used when the person says no to a plan or an offer).
- `applyResult(state, { tool, arguments?, structuredContent?, isError? }) -> ConversationState`: folds one
  tool result into the conversation. Reads `structuredContent` defensively (junk never throws).
- `consentOf(utterance) -> 'yes' | 'no' | 'unclear'`: how the person answered a permission prompt (a plan,
  an offer, or a host's own approval sheet; apps/host uses it while its sheet is open). Stricter than
  `parseYesNo`: "fix that" and consent words are yes, a whole utterance stop ("cancel", "not now", "rehne
  do") is no, and a question ("is everything ok?"), an observation ("yes, it blinked") or a yes that carries
  another request ("yes, undo it", "yes, is it safe?") is never yes. "apply it" and "apply the fix" are yes.
- `repairForText(text, state) -> repair_id | null`: the newest repair whose subject the text names, such
  as a push ("Hallway lamp answered all 9 commands overnight." names the hallway lamp's repair). apps/host
  uses it to open the repair a tapped push is about.
- `initialState()`, `clearPending(state, slots)`, `isToolRoute(route)`, `REPLIES` (every reply string),
  `noRepairFor(device)` (the reply when no repair touched a named device), `MAX_REPAIRS`, and the text
  helpers `normalize`, `stripInvocation`, `cleanDevice`.

### Conversation state (`ConversationState`, plain JSON)

| Field | Set by | Used for |
| --- | --- | --- |
| `pendingQuestion {diagnosis_id, question_id, text}` | diagnose / diagnose_answer with `needs_answer` | the next yes, no or observation goes to `diagnose_answer` word for word |
| `pendingOffer {kind, id, label}` | a verdict with `fix_available`, or explain_event's `suggested_fix` | "yes" or "fix that" gives `repair_plan` with `diagnosis_id`, `issue_id` or `explanation_id` |
| `pendingPlan {plan_id, confirm_token, expires_at, diff_lines, subject?}` | repair_plan with `needs_confirmation`; `subject` is the diagnosed device (plan from a `diagnosis_id`) or the finding's title (from an `issue_id`) | the one explicit yes gives `repair_apply` with that plan's own token |
| `findings [{issue_id, title, fixable, kind?, detail?}]` | home_checkup | "fix the first one", "fix the living room light", "fix the duplicate name" (by `kind`); for a finding Fixwright cannot fix, the reply passes on the server's own `detail` advice |
| `last {checkup_id, issue_id, diagnosis_id, explanation_id, plan_id, repair_id}` | every result's `ids` | "undo", "did the fix hold", "fix that" with nothing on offer |
| `lastDevice` | diagnose target, switch, protect | "turn it off", "why is it still offline" |
| `repairs? [{repair_id, subject, text}]` (newest last, at most 8) | repair_apply: the plan's `subject`, its `diff_lines` and the step labels | "did the hallway lamp fix hold?", a tapped push. Optional: a state without it (older states, the server's sanitized copy) answers named status questions about the newest repair, as before |

Failures: a dead plan (`plan_expired`, `plan_used`, `token_mismatch`) is dropped so a later yes can
never reuse it; a retryable failure (hub unreachable) keeps it. An answer the server already took
(`question_answered`) clears the question.

### Routing order (the whole policy)

1. Context free commands: undo ("undo", "put it back", "wapas karo") and repair status ("did the fix
   hold", "status", "how is the lamp doing since you fixed it"). A status question that names a device
   ("did the hallway lamp fix hold?", "is the fix on the kettle plug holding?") goes to that device's
   repair: one whose subject is the device beats a newer one that only touched it among others (the 14
   device power on fix also sets the hallway lamp), newest first within each. No repair touched the device:
   `noRepairFor(device)`. Words that name which repair rather than a device ("did last night's fix hold?")
   mean the newest one.
2. A pending plan: a yes that gives consent (`consentOf`: "yes", "do it", "fix it", "apply it", "apply the fix",
   "go ahead", "okay", "can you do it", "haan kar do") gives `repair_apply`; no, or a whole utterance stop ("cancel", "stop",
   "wait", "hold on", "not now", "never mind", "rehne do") gets a reply and drops the plan. A question is never
   consent ("is everything ok?" is a checkup, "is the hallway lamp working?" a diagnosis), and an
   observation ("yes, it blinked") answers a question that is already closed, so it gets "Got it, I
   already have that. Shall I apply the fix? Say yes or no." Nothing else ever sends a `confirm_token`.
   "Stop protecting the aquarium filter" is still a request, not a stop. A question about the plan ("is it
   safe?", "what will it change?", "tell me more") gets the dry run read back from the plan's own
   `diff_lines` (at most 3 spoken, the rest counted), then "Nothing changes until you say yes. Shall I apply
   it?"; anything else, such as "yes, undo it", gets "The fix is ready, and nothing has changed yet. Shall I
   apply it? Say yes or no." and keeps the plan.
3. A pending question: "cancel", "stop" or "never mind" drop it (intent `cancel`; "wait" does not, the
   person may be looking). Anything that starts like an answer, or that `parseYesNo` reads as yes or no
   (English, Hindi, Devanagari), goes to `diagnose_answer` word for word, except a question back ("is the
   porch light working?", which `parseYesNo` alone would hear as yes). A clear new request (checkup,
   switch, explain, a new device problem) leaves the question; any other words still go to the server,
   which asks once more with a clearer question.
4. A pending offer: the same consent rules; yes or "fix that" gives `repair_plan`; no or a stop gets a reply and
   drops the offer; an observation gets "Got it, I already have that. Want me to fix it? Say yes or no."
5. New requests: fix a checkup finding (by ordinal, by title words or by kind words such as "the duplicate
   name" or "the wifi one"), `home_checkup` (optional `focus`; also "is my house ok", "is everything
   alright", "what's going on with my house"),
   `protect_device` (also "never turn off X because ...", unprotect with `protect: false`),
   `explain_event` ("why did ... at 3 a.m.", "what happened last night", past event plus a time; a
   symptom with a time, "why did the lamp go offline at 3 a.m.", is a past event too),
   `diagnose` (not responding, offline, isn't working, won't turn on or switch on, keeps dropping off,
   broken, "is X working / online", "what is going on with X", Hindi "kaam nahi kar raha"; the device is
   extracted clause by clause; a reporter is skipped, so "why does Alexa say the hallway lamp is offline"
   and "why does it keep saying the hallway lamp is not responding" name the hallway lamp; "switch" inside
   a device name stays in it; a named device beats "it", so "what about the kitchen plug, it keeps
   dropping" names the kitchen plug; "it" alone means the last device),
   `switch_device` ("turn off X", "switch X on", "X band kar do").
6. Replies: "fix that" with nothing on offer (falls back to the newest diagnosis or explanation),
   help, a stray yes or no, and the fallback hint.

## Tests

From the repo root:

```
npm run check -w @fixwright/router    # tsc on src alone (no Node types), tsc on tests, vitest
```

`test/route.test.ts` holds 144 table cases built on states folded from the real protocol fixtures,
`test/state.test.ts` covers the state machine and the golden path as one conversation,
`test/named-status.test.ts` covers the repair memory, status questions that name a device and
`repairForText`, and `test/purity.test.ts` guards the pure package rule (190 tests in all). See `VERIFY.md`.

## Versions

Depends only on `@fixwright/protocol` (for `parseYesNo`, `ToolName` and, in tests, `ToolInputs` and the
fixtures). TypeScript 6.0.3 and vitest 5.0.2 from the root.
