# VERIFY: @fixwright/protocol

`npm run check -w @fixwright/protocol` runs three steps; all pass (17 Oct 2026: 258 of 258 tests; 255 on 15 Oct).

1. `tsc -p tsconfig.src.json`: the source compiles with `lib: ES2023` and no Node or DOM types, so it
   uses nothing a Worker or browser lacks.
2. `tsc -p tsconfig.json`: tests and scripts compile, including the compile time type proofs below.
3. `vitest run`: the runtime tests.

## Checklist

### Types and schemas agree (test/types.test.ts, 5, checked by tsc)
- [x] Every core model schema infers exactly its handwritten type (Entity, HouseEvent, Signals,
      IntegrationStatus, CloudStatus, HubStatus).
- [x] Every shared shape and every one of the 11 tool inputs and outputs, plus ProblemOutput, infers
      exactly the handwritten type. A negative control (comparing repair_apply with repair_status, and
      with an extra field) made tsc fail, so drift is caught.
- [x] All tool inputs and outputs are assignable to `Record<string, unknown>` (MCP arguments and
      structuredContent) without casts.

### Fixtures (test/fixtures.test.ts, 47)
- [x] There is exactly one fixture per tool plus `problem.json`, and each validates against its schema.
- [x] Each file is byte for byte what `scripts/golden.ts` builds, and the builder is deterministic.
- [x] Every fixture's speech passes the speech rules.
- [x] `identifyOutput` recognizes every fixture's tool and rejects the problem output.
- [x] Golden path steps 1 to 7: the flash question with two leading causes after hub, signal and cloud
      pass; 94% and a confirmed verdict with evidence after "yes"; a pending dry run then an applied repair
      with read back on every step and undo available; the 07:00 PDT check confirming 9 of 9 commands;
      "Power came back at 3:12. Fourteen devices restarted within four seconds. None of your automations
      fired." with 14 evidence seqs; the three checkup titles; the refusal for the strip with the
      protected aquarium filter.
- [x] Ids chain diagnose to diagnose_answer to repair_plan to repair_apply to repair_status, undo and
      refresh_view, and encode their creation time.

### Schemas reject broken data (test/schemas.test.ts, 49)
- [x] Every output fails without speech; every strict output fails with an unknown field.
- [x] Speech with a pipe, markup, an id, a tool name or over 74 words fails.
- [x] Wrong status or view for a tool fails; ids that do not chain fail; wrong id prefixes fail.
- [x] Diagnose: question only with needs_answer, verdict only with ok, at most 3 unique hypotheses,
      sorted, summing to at most 1, known cause ids, choice questions need two choices.
- [x] Verdict: confirmed needs confidence of at least 0.9 and at least one evidenced claim.
- [x] Checkup: at most 5 findings, most severe first, unique issue ids, valid entity ids.
- [x] Plans all pending and numbered from 1; applied repairs all done or skipped; undo only when
      something is applied; checks and timelines in time order; output times must be UTC with Z.
- [x] switch_device: ok must switch something; a refusal may only switch the offered alternative.
- [x] refresh_view accepts any output with valid shared fields; problem outputs need a known code and
      error or refused.
- [x] Inputs: the golden path calls pass; empty, malformed, reversed windows, short tokens and bad ids
      fail; repair_plan takes exactly one id with a readable message; unknown keys are stripped and text trimmed.
- [x] JSON Schema: every input and output converts to `type: object`, every input property has a
      description, and the Standard Schema JSON hook the MCP SDK calls works.
- [x] Core model: adapter extras are stripped; bad entity ids, transports, local times, seqs, kinds,
      LQI and power on behavior values fail.

### Real MCP SDK round trip (test/mcp-sdk.test.ts, 15)
- [x] All 11 TOOL_DEFS register on McpServer 2.2.0 (ext-apps 2.0.3 `registerAppTool` for view tools)
      and a Client 2.2.0 over InMemoryTransport lists them with titles, annotations, object input and
      output schemas, described inputs, `_meta.ui` (resourceUri, visibility) and the legacy
      `ui/resourceUri` key.
- [x] tools/call for every tool returns its fixture and passes the server's and the client's output
      validation.
- [x] An output that breaks a rule is stopped by the server; an isError problem output passes through
      unvalidated; bad input returns the schema message.

### Tool definitions (test/tool-defs.test.ts, 10)
- [x] Exactly 11 tools in order; view URIs for tools 1 to 8 and none for 9 to 11.
- [x] refresh_view is app only; switch_device and protect_device are model only; the views' buttons
      (diagnose_answer, repair_plan, repair_apply, undo) are callable from apps.
- [x] readOnlyHint true for home_checkup, explain_event, repair_plan, repair_status and refresh_view;
      diagnose and diagnose_answer are not read only (the flash test), not destructive and not idempotent;
      only repair_apply is destructive (the retired copy is removed after the morning check);
      openWorldHint false everywhere; protect_device names no medical equipment (policy 13).
- [x] Descriptions say when to use and when not to, are long enough to guide a model, and avoid banned
      words and long dashes. `toolMeta` returns independent copies.

### Ids, clock and rng (test/ids.test.ts, 10)
- [x] Format `<prefix>_<10><8>` in lower case Crockford base32 for all 8 prefixes; time reads back exactly.
- [x] 500 ids over a simulated week with a fake clock sort in time order as strings and are unique.
- [x] The monotonic factory strictly increases within one millisecond, after the clock steps back, and
      when the random part wraps.
- [x] Deterministic per clock and seed; unknown prefixes, negative, NaN or out of range times and rng
      values outside [0, 1) throw.
- [x] seededRng repeats per seed within [0, 1); manualClock moves only when told.

### Yes or no (test/yesno.test.ts, 72)
- [x] 68 table cases: English, romanized Hindi and 12 Devanagari answers across yes, no and unclear,
      including every word in the yes and no lists, nonvisual answers, negation before and after the verb, the
      trailing tag "na", hedges and contradictions.
- [x] Consent words count only for permission questions, and can be negated.
- [x] Chandrabindu and anusvara spellings match; case, punctuation, curly apostrophes and "did not"
      are normalized.

### Speech (test/speech.test.ts, 28)
- [x] Golden lines (and a Devanagari line) pass through unchanged.
- [x] Pipes, markdown, HTML and SSML, entity ids, generated ids, tool names, JSON, links, markdown
      links, long dashes, emoji, list lines, extra spaces and snake_case are each cleaned as expected,
      and the result always passes `speechProblems`.
- [x] Truncation keeps whole sentences under 74 words, does not split at "3 a.m." or "2.5", and cuts
      an endless sentence at a clause without splitting "3:12". The function is idempotent.
- [x] `speechProblems` names each broken rule; 74 words (29.6 s) is allowed, 75 is not.

### Labels and errors (test/labels-errors.test.ts, 8)
- [x] CAUSE_LABELS covers the 10 diagnosis causes plus the 4 explain causes; FINDING_LABELS covers the 8
      kinds; PROBE_KINDS covers the 11 library probes. Labels are at most 34 characters and plain.
- [x] Every problem code has a speech safe default line; protocolError, isProtocolError and
      problemOutput produce valid problem outputs with the right status; assertNever throws.

### Purity (test/purity.test.ts, 14)
- [x] The source has no `node:` imports, require, process, Buffer, Date.now, new Date with no argument,
      Math.random, crypto, fetch, timers or runtime globals, and imports only `zod/v4` from outside.
- [x] esbuild bundles it for a neutral platform with the workerd, worker and browser conditions with
      no Node built in modules.

## Checked outside `npm run check`
- [x] `npm run smoke:browser`: the browser bundle runs in headless Chromium 153.0.8010.12 (Playwright
      1.63.0, preinstalled browsers): 11 tools, the diagnose_answer fixture validates, Devanagari yes and
      Hindi no parse, no page errors. The browser was closed afterwards.
- [x] Protocol source typechecks inside consumers configured for workers-types, DOM, bare ES2023 and
      Node, including the `@fixwright/protocol/fixtures/*.json` subpath import (throwaway check,
      removed after).
- [ ] Not run here: executing the bundle inside workerd itself. The neutral bundle with workerd
      conditions builds, and an early prototype ran zod 4.6.5 with the MCP server in workerd; the server's
      wrangler tests cover the real runtime.
