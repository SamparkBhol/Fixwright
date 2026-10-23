// Compile time proof that every zod schema infers exactly the handwritten type in types.ts.
// `tsc -p tsconfig.json` (part of npm run check) fails if any pair drifts; vitest just runs the shell.

import { describe, expectTypeOf, it } from 'vitest';
import type * as z from 'zod/v4';
import type {
  AnyOutput,
  Claim,
  CloudStatus,
  DiffRow,
  Entity,
  Finding,
  HouseEvent,
  HubStatus,
  Hypothesis,
  Ids,
  IntegrationStatus,
  ProbeResult,
  ProblemOutput,
  Question,
  RepairStep,
  Signals,
  SourceInfo,
  ToolInputMap,
  ToolOutputMap,
  Verdict,
} from '../src/index.ts';
import type {
  ClaimSchema,
  CloudStatusSchema,
  DiffRowSchema,
  EntitySchema,
  FindingSchema,
  HouseEventSchema,
  HubStatusSchema,
  HypothesisSchema,
  IdsSchema,
  IntegrationStatusSchema,
  OutputBaseSchema,
  ProbeResultSchema,
  ProblemOutputSchema,
  QuestionSchema,
  RepairStepSchema,
  SignalsSchema,
  SourceInfoSchema,
  ToolInputs,
  ToolOutputs,
  VerdictSchema,
} from '../src/index.ts';

// Flatten the top level, so `OutputCommon & {...}` compares equal to the flat object zod infers.
type Flat<T> = { [K in keyof T]: T[K] };
type Out<S extends z.ZodType> = Flat<z.output<S>>;
type In<S extends z.ZodType> = Flat<z.input<S>>;

describe('schemas mirror types.ts exactly', () => {
  it('core model', () => {
    expectTypeOf<Out<typeof EntitySchema>>().toEqualTypeOf<Entity>();
    expectTypeOf<Out<typeof HouseEventSchema>>().toEqualTypeOf<HouseEvent>();
    expectTypeOf<Out<typeof SignalsSchema>>().toEqualTypeOf<Signals>();
    expectTypeOf<Out<typeof IntegrationStatusSchema>>().toEqualTypeOf<IntegrationStatus>();
    expectTypeOf<Out<typeof CloudStatusSchema>>().toEqualTypeOf<CloudStatus>();
    expectTypeOf<Out<typeof HubStatusSchema>>().toEqualTypeOf<HubStatus>();
  });

  it('shared tool shapes', () => {
    expectTypeOf<Out<typeof IdsSchema>>().toEqualTypeOf<Ids>();
    expectTypeOf<Out<typeof SourceInfoSchema>>().toEqualTypeOf<SourceInfo>();
    expectTypeOf<Out<typeof ClaimSchema>>().toEqualTypeOf<Claim>();
    expectTypeOf<Out<typeof VerdictSchema>>().toEqualTypeOf<Verdict>();
    expectTypeOf<Out<typeof ProbeResultSchema>>().toEqualTypeOf<ProbeResult>();
    expectTypeOf<Out<typeof HypothesisSchema>>().toEqualTypeOf<Hypothesis>();
    expectTypeOf<Out<typeof QuestionSchema>>().toEqualTypeOf<Question>();
    expectTypeOf<Out<typeof FindingSchema>>().toEqualTypeOf<Finding>();
    expectTypeOf<Out<typeof DiffRowSchema>>().toEqualTypeOf<DiffRow>();
    expectTypeOf<Out<typeof RepairStepSchema>>().toEqualTypeOf<RepairStep>();
    expectTypeOf<Out<typeof OutputBaseSchema>>().toEqualTypeOf<Flat<AnyOutput>>();
    expectTypeOf<Out<typeof ProblemOutputSchema>>().toEqualTypeOf<Flat<ProblemOutput>>();
  });

  it('every tool input', () => {
    expectTypeOf<{ -readonly [N in keyof typeof ToolInputs]: In<(typeof ToolInputs)[N]> }>().toEqualTypeOf<ToolInputMap>();
    expectTypeOf<{ -readonly [N in keyof typeof ToolInputs]: Out<(typeof ToolInputs)[N]> }>().toEqualTypeOf<ToolInputMap>();
  });

  it('every tool output', () => {
    expectTypeOf<Out<typeof ToolOutputs.home_checkup>>().toEqualTypeOf<Flat<ToolOutputMap['home_checkup']>>();
    expectTypeOf<Out<typeof ToolOutputs.diagnose>>().toEqualTypeOf<Flat<ToolOutputMap['diagnose']>>();
    expectTypeOf<Out<typeof ToolOutputs.diagnose_answer>>().toEqualTypeOf<Flat<ToolOutputMap['diagnose_answer']>>();
    expectTypeOf<Out<typeof ToolOutputs.explain_event>>().toEqualTypeOf<Flat<ToolOutputMap['explain_event']>>();
    expectTypeOf<Out<typeof ToolOutputs.repair_plan>>().toEqualTypeOf<Flat<ToolOutputMap['repair_plan']>>();
    expectTypeOf<Out<typeof ToolOutputs.repair_apply>>().toEqualTypeOf<Flat<ToolOutputMap['repair_apply']>>();
    expectTypeOf<Out<typeof ToolOutputs.repair_status>>().toEqualTypeOf<Flat<ToolOutputMap['repair_status']>>();
    expectTypeOf<Out<typeof ToolOutputs.undo>>().toEqualTypeOf<Flat<ToolOutputMap['undo']>>();
    expectTypeOf<Out<typeof ToolOutputs.protect_device>>().toEqualTypeOf<Flat<ToolOutputMap['protect_device']>>();
    expectTypeOf<Out<typeof ToolOutputs.switch_device>>().toEqualTypeOf<Flat<ToolOutputMap['switch_device']>>();
    expectTypeOf<Out<typeof ToolOutputs.refresh_view>>().toEqualTypeOf<Flat<ToolOutputMap['refresh_view']>>();
  });

  it('tool inputs fit MCP arguments and outputs fit structuredContent (Record<string, unknown>)', () => {
    expectTypeOf<ToolInputMap[keyof ToolInputMap]>().toExtend<Record<string, unknown>>();
    expectTypeOf<ToolOutputMap[keyof ToolOutputMap]>().toExtend<Record<string, unknown>>();
    expectTypeOf<ProblemOutput>().toExtend<Record<string, unknown>>();
  });
});
