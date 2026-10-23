# @fixwright/protocol

The shared contract for every Fixwright package: the core model, zod schemas for all
11 MCP tool inputs and outputs, the tool definitions a host sees, ids, the cause and finding label
tables, the yes or no parser and the speech rules.

It is pure TypeScript: no I/O, no Node built in modules, no `Date.now()` or `Math.random()` (a `Clock` and an
`Rng` are injected). It runs unchanged in Node 22, Cloudflare workerd and the browser. Workspace
packages import the source directly (`"exports": {".": "./src/index.ts"}`); wrangler and esbuild compile it.

```ts
import { TOOL_DEFS, ToolOutputs, parseYesNo, speechSafe, newId } from '@fixwright/protocol';
import type { DiagnoseOutput, HomeAdapter } from '@fixwright/protocol';
import fixture from '@fixwright/protocol/fixtures/diagnose.json' with { type: 'json' };
```

## API

### Types (`src/types.ts`)

- Core model: `Iso`, `EntityId`, `Transport`, `Entity`, `EventKind`, `HouseEvent`,
  `EventContext`, `Signals`, `IntegrationStatus`, `CloudStatus`, `HubStatus`, `EventQuery`, `RegistryPatch`,
  `HomeAdapter`, `Clock`, `Rng`.
- Tool shapes: `OutputBase`, `Ids`, `SourceInfo`, `Claim`, `Verdict`, `ProbeResult`, `Hypothesis`,
  `Question`, `Finding`, `DiffRow`, `RepairStep`, `DiagnosisTarget`, `TimelineEntry`, `SuggestedFix`,
  `RepairCheck`, `ProtectedDevice`, `SwitchedDevice`, `SwitchAlternative`.
- Per tool: `HomeCheckupInput` ... `RefreshViewInput`, `HomeCheckupOutput` ... `RefreshViewOutput`,
  `ProblemOutput`, plus `ToolInputMap`, `ToolOutputMap`, `ToolInput<N>`, `ToolOutput<N>`.
- Per view: `StepperPayload` (diagnose, explain_event, repair_plan), `CarouselPayload` (home_checkup),
  `RepairCardPayload` (repair_apply, repair_status, undo).

Tool inputs and outputs are `type` aliases, not interfaces, so they are assignable to
`Record<string, unknown>` (MCP `arguments` and `structuredContent`) without casts.

### Schemas

- `ToolInputs.<tool>` and `ToolOutputs.<tool>` for all 11 tools, plus `ProblemOutputSchema`.
- Core and shared: `EntitySchema`, `HouseEventSchema`, `SignalsSchema`, `IntegrationStatusSchema`,
  `CloudStatusSchema`, `HubStatusSchema`, `IdsSchema`, `SourceInfoSchema`, `OutputBaseSchema`,
  `VerdictSchema`, `ProbeResultSchema`, `HypothesisSchema`, `QuestionSchema`, `FindingSchema`,
  `DiffRowSchema`, `RepairStepSchema` and friends.
- Primitives: `IsoSchema` (UTC, `Z` only), `IsoInputSchema` (also accepts an offset), `EntityIdSchema`,
  `idSchema(prefix)`, `SpeechSchema`, `EvidenceSchema`, `ProbabilitySchema`.

### Tool definitions

- `TOOL_DEFS[name]`: `{ name, title, description, inputSchema, outputSchema, annotations, view?, ui: { resourceUri?, visibility } }`.
  Descriptions are written for the host's model: when to use the tool, when not to, and how its ids chain.
- `TOOL_DEF_LIST` (registration order), `TOOL_NAMES`, `VIEW_URIS`, `TOOL_VIEWS`.
- `toolMeta(name)`: a fresh `{ ui }` object for `registerAppTool` (ext-apps writes into it).

| Tool | View | Visibility | readOnly | destructive | idempotent |
| --- | --- | --- | --- | --- | --- |
| home_checkup | carousel | model, app | yes | no | yes |
| diagnose | stepper | model, app | no (the flash test switches the device and restores it) | no | no |
| diagnose_answer | stepper | model, app | no (asking again may flash again) | no | no |
| explain_event | stepper | model, app | yes | no | yes |
| repair_plan | stepper | model, app | yes | no | yes |
| repair_apply | repair_card | model, app | no | yes (after the morning check the old copy leaves the registry for good) | yes (a plan runs once) |
| repair_status | repair_card | model, app | yes | no | yes |
| undo | repair_card | model, app | no | no | yes |
| protect_device | none | model | no | no | yes |
| switch_device | none | model | no | no | yes |
| refresh_view | none | app | yes | no | yes |

`openWorldHint` is false for every tool. A host that asks before every tool that is not read only (apps/host
does) now asks before `diagnose` too, because diagnose may flash a light. View URIs: `ui://fixwright/stepper.html`,
`ui://fixwright/carousel.html`, `ui://fixwright/repair-card.html`.

Registering on the server (with the server's `cachedJson` wrapper, which converts each schema once):

```ts
for (const def of TOOL_DEF_LIST) {
  const config = {
    title: def.title,
    description: def.description,
    inputSchema: cachedJson(def.inputSchema),
    outputSchema: cachedJson(def.outputSchema),
    annotations: def.annotations,
    _meta: toolMeta(def.name),
  };
  if (def.ui.resourceUri) registerAppTool(server, def.name, config, handler);
  else server.registerTool(def.name, config, handler);
}
// a normal result
return { content: [{ type: 'text', text: out.speech }], structuredContent: out };
// a failure or refusal
return { isError: true, content: [{ type: 'text', text: p.speech }], structuredContent: problemOutput(err, source, ids) };
```

### Helpers

- `newId(prefix, clock, rng)`: `<prefix>_<10 char time><8 char random>`, lower case Crockford base32,
  sorts by creation time. `createIdFactory(clock, rng)` gives strictly increasing ids even within one
  millisecond. Also `isId`, `idPrefix`, `idTimeMs`, `ID_PATTERN`, `idPattern`, `ID_PREFIXES`
  (`chk iss dx q exp pln rep hh`). The demo household token `hh_public` is a name, not a generated id.
- `seededRng(seed)` (mulberry32) and `manualClock(start)` with `advance` and `set`: deterministic
  Clock and Rng for tests, fixtures and simulations.
- `parseYesNo(answer, { consent? })`: `'yes' | 'no' | 'unclear'` for English, romanized Hindi and
  Devanagari, with fixed yes and no word lists plus nonvisual answers ("I heard it click", "the fan is
  running"). Negations bind to the observation they precede or, in Hindi, follow ("didn't blink",
  "nahi jala", "jala nahi"). Hedges ("not sure", "pata nahi") and contradictions are `'unclear'`.
  `consent: true` also accepts "okay", "go ahead", "theek hai" for permission questions.
- `speechSafe(text)`: strips markup, pipes, links, JSON, ids and tool names, reads entity ids as words,
  turns long dashes into commas, and keeps whole sentences up to 74 words (29.6 s at 2.5 words per
  second). Idempotent. `speechProblems(text)` lists what a string breaks; `isSpeechSafe`,
  `countWords`, `estimateSpeechSeconds`, `MAX_SPEECH_WORDS`.
- `CAUSE_IDS`, `CAUSE_LABELS` (the 10 diagnosis causes plus `power_restore`,
  `automation_trigger`, `user_action`, `unknown` for explain_event), `FINDING_KINDS`, `FINDING_LABELS`,
  `PROBE_IDS`, `PROBE_KINDS`, `SEVERITY_RANK`, `CONFIRM_THRESHOLD` (0.9).
- `ProtocolError` `{ code, message, speech, retryable }`, `PROBLEM_CODES`, `PROBLEM_DEFAULTS` (a
  speech safe line per code), `protocolError(code, message?, speech?)`, `isProtocolError`,
  `problemOutput(error, source, ids?)`, `assertNever`.
- `identifyOutput(value)`: which tool produced a structuredContent (for refresh_view results),
  validated, or null.

## Contract rules

These are enforced by the schemas, so the server, views and host can rely on them:

1. Outputs are strict objects (unknown keys fail). Inputs strip unknown keys and trim text.
2. Status and view are narrowed per tool: `home_checkup` is `ok` + `carousel`; `diagnose` is `ok` or
   `needs_answer` + `stepper`; `repair_plan` is `needs_confirmation`; `protect_device` and
   `switch_device` carry no view.
3. Failures and refusals of any tool are a `ProblemOutput` sent with `isError: true` (both SDKs skip
   output validation for those). The one in band refusal is `switch_device`: `status:
   'refused'` with an `alternative`; when `switched` is also present it is that alternative, already done.
4. The tool's own id must equal the same key in `ids` (`ids.diagnosis_id === diagnosis_id`, and so on).
5. diagnose: `question` present exactly when `needs_answer`, `verdict` exactly when `ok`; at most 3
   hypotheses, unique, most likely first, p summing to at most 1.
6. A `confirmed` verdict has confidence of at least 0.9 and at least one claim with evidence.
7. Checkup: at most 5 findings, unique issue ids, most severe first.
8. Plans have steps numbered from 1, all `pending`. An `applied` repair has every step `done` or
   `skipped`. `undo_available` only for `applied`, `confirmed` or `regressed`. Undo returns
   `state: 'undone'` and `undo_available: false`.
9. Timelines and checks are in time order. Output times are UTC with `Z`; input times may carry an offset.
10. `speech` must pass `speechProblems`: run `speechSafe` on anything generated before returning it.

## Fixtures

`fixtures/<tool>.json` holds one output per tool along the golden path, plus
`problem.json` (hub unreachable). They come from `scripts/golden.ts`; regenerate with
`npm run fixtures -w @fixwright/protocol` (it validates before writing). A test fails if a file drifts
from the generator.

The story: the hallway lamp was paired again on 3 October, so its name points at the old offline copy;
diagnose flashes the online copy and asks "Did it blink?"; the answer lifts the top cause to 94% and
confirms it; the plan and apply rename and retire with read back; the 07:00 check finds all 9 overnight
commands answered; power came back at 3:12 and fourteen devices restarted; the checkup finds the three
demo issues; the strip with the protected aquarium filter is refused. Ids chain across files, and the
SimHome source is marked `simulated: true`.

Values that appear in the golden path script (94%, 3:12, fourteen, 9 commands, 6%, 9 drops, -82 dBm,
3 October) are used as given. Every other probability, ledger seq, timestamp and the explanation's 0.95
confidence are placeholders for rendering and testing, not measurements. Entity ids in fixtures are
illustrative; the SimHome twin is the source of truth for live ids.

## Testing

From the repo root:

```
npm run check -w @fixwright/protocol      # tsc on src alone (no Node or DOM types), tsc on tests, vitest
npm run smoke:browser -w @fixwright/protocol   # optional: runs the bundle in headless Chromium
```

What the tests prove is listed in `VERIFY.md`.

## Versions

- Runtime: zod 4.6.5, imported from `zod/v4`.
- Dev (for `test/mcp-sdk.test.ts`, the round trip through the real SDKs): @modelcontextprotocol/server
  2.2.0, @modelcontextprotocol/client 2.2.0, @modelcontextprotocol/core 2.2.0,
  @modelcontextprotocol/ext-apps 2.0.3. TypeScript 6.0.3, vitest 5.0.2, esbuild 0.28.2 and
  playwright 1.63.0 come from the root.

Measured on 15 Oct 2026: 255 tests in about 0.5 s (258 on 17 Oct); the neutral ESM bundle (with zod) is 247,795 bytes,
135,128 minified, 41,755 gzipped; the browser bundle ran in headless Chromium 153.0.8010.12 with no
page errors.
