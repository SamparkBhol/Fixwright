// Zod schemas for the 11 MCP tools. Inputs strip unknown keys and carry .describe() text,
// because hosts show it to the model. Outputs are strict and enforce the cross field rules the views
// rely on (ids chain, top 3 hypotheses, question only while waiting for an answer, and so on).

import * as z from 'zod/v4';
import { PROBLEM_CODES } from './errors.ts';
import { REPAIR_APPLY_STATES, REPAIR_STATES, SEVERITY_RANK, type ToolName } from './names.ts';
import {
  DiagnosisTargetSchema,
  DiffRowSchema,
  FindingSchema,
  HypothesisSchema,
  IsoInputSchema,
  IsoSchema,
  OutputBaseSchema,
  ProbeResultSchema,
  ProtectedDeviceSchema,
  QuestionSchema,
  RepairCheckSchema,
  RepairStepSchema,
  SuggestedFixSchema,
  SwitchAlternativeSchema,
  SwitchedDeviceSchema,
  TimelineEntrySchema,
  VerdictSchema,
  idSchema,
  outputCommonShape,
} from './schemas.ts';
import type { Ids, RepairStep, ToolOutputMap } from './types.ts';

type Ctx = z.core.$RefinementCtx;

const PROBABILITY_SLACK = 1e-9;

const deviceName = (example: string) =>
  z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe(`The device as the person named it, e.g. "${example}". Use their words; do not invent an id.`);

const REF_ID_PATTERN = /^(chk|iss|dx|exp|pln|rep)_[0-9a-hjkmnp-tv-z]{18}$/;

export const ToolInputs = {
  home_checkup: z.object({
    focus: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Optional area or kind of problem to focus on, in the person\'s words, e.g. "kitchen" or "batteries". Leave out for a whole home checkup.'),
  }),

  diagnose: z.object({
    symptom: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe('What the person says is wrong, in their own words, e.g. "the hallway lamp keeps saying it\'s not responding".'),
    device: deviceName('hallway lamp')
      .optional()
      .describe('The device as the person named it, e.g. "hallway lamp". Leave out if they did not name one; the tool works it out from the symptom.'),
  }),

  diagnose_answer: z.object({
    diagnosis_id: idSchema('dx').describe('diagnosis_id from the diagnose (or previous diagnose_answer) result that asked the question.'),
    question_id: idSchema('q').describe('question_id of the question being answered, from that same result.'),
    answer: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe('The person\'s reply word for word, e.g. "yes, it blinked", "no", "I heard it click", "haan", "nahi jala". Do not translate or turn it into yes or no yourself.'),
  }),

  explain_event: z
    .object({
      question: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe('The person\'s question about something the home already did, word for word, e.g. "why did every plug turn on at 3 a.m.?". The time window is read from it.'),
      since: IsoInputSchema.optional().describe('Optional start of the time window (ISO 8601 with Z or an offset). Leave out to let the tool read the window from the question.'),
      until: IsoInputSchema.optional().describe('Optional end of the time window (ISO 8601 with Z or an offset). Leave out to let the tool read the window from the question.'),
    })
    .superRefine((v, ctx) => {
      if (v.since && v.until && Date.parse(v.since) >= Date.parse(v.until)) {
        ctx.addIssue({ code: 'custom', path: ['until'], message: 'until must be after since' });
      }
    }),

  repair_plan: z
    .object({
      diagnosis_id: idSchema('dx').optional().describe('diagnosis_id of a finished diagnosis whose verdict has fix_available true.'),
      issue_id: idSchema('iss').optional().describe('issue_id of a checkup finding, or of the suggested_fix from explain_event.'),
      explanation_id: idSchema('exp').optional().describe('explanation_id of an explain_event result that offered a fix.'),
    })
    .superRefine((v, ctx) => {
      const given = [v.diagnosis_id, v.issue_id, v.explanation_id].filter((x) => x !== undefined).length;
      if (given !== 1) {
        ctx.addIssue({ code: 'custom', message: 'Give exactly one of diagnosis_id, issue_id or explanation_id.' });
      }
    }),

  repair_apply: z.object({
    plan_id: idSchema('pln').describe('plan_id from the repair_plan result the person just said yes to.'),
    confirm_token: z
      .string()
      .min(16)
      .max(256)
      .describe('confirm_token from that same repair_plan result. Send it only after the person clearly said yes to this plan.'),
  }),

  repair_status: z.object({
    repair_id: idSchema('rep').describe('repair_id from a repair_apply result.'),
  }),

  undo: z.object({
    repair_id: idSchema('rep').describe('repair_id of the repair to reverse, from a repair_apply or repair_status result.'),
  }),

  protect_device: z.object({
    device: deviceName('aquarium filter'),
    reason: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe('Why it must stay on, in the person\'s words, e.g. "the fish need it". Optional.'),
    protect: z
      .boolean()
      .optional()
      .describe('true (the default) protects the device; false removes the protection.'),
  }),

  switch_device: z.object({
    device: deviceName('living room power strip'),
    on: z.boolean().describe('true to turn the device on, false to turn it off.'),
  }),

  refresh_view: z.object({
    ref_id: z
      .string()
      .regex(REF_ID_PATTERN, 'expected a checkup, issue, diagnosis, explanation, plan or repair id')
      .describe('The checkup_id, diagnosis_id, explanation_id, plan_id or repair_id the view is showing.'),
  }),
} as const satisfies Record<ToolName, z.ZodType>;

function sameId(ctx: Ctx, ids: Ids, key: keyof Ids, value: string): void {
  if (ids[key] !== value) {
    ctx.addIssue({ code: 'custom', path: ['ids', key], message: `ids.${key} must equal ${key}` });
  }
}

function sameIdIfBoth(ctx: Ctx, ids: Ids, key: keyof Ids, value: string | undefined): void {
  if (ids[key] !== undefined && value !== undefined && ids[key] !== value) {
    ctx.addIssue({ code: 'custom', path: ['ids', key], message: `ids.${key} does not match` });
  }
}

function stepsNumbered(ctx: Ctx, steps: readonly RepairStep[]): void {
  steps.forEach((s, i) => {
    if (s.step !== i + 1) ctx.addIssue({ code: 'custom', path: ['steps', i, 'step'], message: `steps are numbered from 1 in order; expected ${i + 1}` });
  });
}

function ascendingTimes(ctx: Ctx, field: string, times: readonly string[]): void {
  for (let i = 1; i < times.length; i++) {
    if (Date.parse(times[i] ?? '') < Date.parse(times[i - 1] ?? '')) {
      ctx.addIssue({ code: 'custom', path: [field, i], message: `${field} must be in time order` });
    }
  }
}

function unique(ctx: Ctx, field: string, values: readonly string[]): void {
  const seen = new Set<string>();
  values.forEach((v, i) => {
    if (seen.has(v)) ctx.addIssue({ code: 'custom', path: [field, i], message: `duplicate ${v} in ${field}` });
    seen.add(v);
  });
}

const HomeCheckupOutput = z
  .strictObject({
    ...outputCommonShape,
    status: z.literal('ok'),
    view: z.literal('carousel'),
    checkup_id: idSchema('chk'),
    findings: z
      .array(FindingSchema)
      .max(5)
      .describe('3 to 5 findings, most severe first (fewer only when the house is healthy). Each issue_id works with repair_plan.'),
  })
  .superRefine((o, ctx) => {
    sameId(ctx, o.ids, 'checkup_id', o.checkup_id);
    unique(ctx, 'findings', o.findings.map((f) => f.issue_id));
    for (let i = 1; i < o.findings.length; i++) {
      const prev = o.findings[i - 1];
      const cur = o.findings[i];
      if (prev && cur && SEVERITY_RANK[cur.severity] < SEVERITY_RANK[prev.severity]) {
        ctx.addIssue({ code: 'custom', path: ['findings', i, 'severity'], message: 'findings must be listed most severe first' });
      }
    }
  });

const DiagnoseOutput = z
  .strictObject({
    ...outputCommonShape,
    status: z.enum(['ok', 'needs_answer']),
    view: z.literal('stepper'),
    diagnosis_id: idSchema('dx'),
    target: DiagnosisTargetSchema,
    probes: z.array(ProbeResultSchema),
    hypotheses: z.array(HypothesisSchema).max(3).describe('Top causes, most likely first; p sums to at most 1.'),
    question: QuestionSchema.optional().describe('Present when status is needs_answer: ask it, then call diagnose_answer.'),
    verdict: VerdictSchema.optional().describe('Present when status is ok: the diagnosis is finished.'),
  })
  .superRefine((o, ctx) => {
    sameId(ctx, o.ids, 'diagnosis_id', o.diagnosis_id);
    unique(ctx, 'hypotheses', o.hypotheses.map((h) => h.cause_id));
    for (let i = 1; i < o.hypotheses.length; i++) {
      if ((o.hypotheses[i]?.p ?? 0) > (o.hypotheses[i - 1]?.p ?? 0)) {
        ctx.addIssue({ code: 'custom', path: ['hypotheses', i, 'p'], message: 'hypotheses must be sorted, most likely first' });
      }
    }
    const total = o.hypotheses.reduce((sum, h) => sum + h.p, 0);
    if (total > 1 + PROBABILITY_SLACK) {
      ctx.addIssue({ code: 'custom', path: ['hypotheses'], message: `hypothesis probabilities sum to ${total}, more than 1` });
    }
    if ((o.status === 'needs_answer') !== (o.question !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['question'], message: 'question is present exactly when status is needs_answer' });
    }
    if ((o.status === 'ok') !== (o.verdict !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'verdict is present exactly when status is ok' });
    }
  });

const ExplainEventOutput = z
  .strictObject({
    ...outputCommonShape,
    status: z.literal('ok'),
    view: z.literal('stepper'),
    explanation_id: idSchema('exp'),
    verdict: VerdictSchema,
    timeline: z.array(TimelineEntrySchema),
    suggested_fix: SuggestedFixSchema.optional().describe('A fix to offer. On yes, call repair_plan with its issue_id.'),
  })
  .superRefine((o, ctx) => {
    sameId(ctx, o.ids, 'explanation_id', o.explanation_id);
    sameIdIfBoth(ctx, o.ids, 'issue_id', o.suggested_fix?.issue_id);
    ascendingTimes(ctx, 'timeline', o.timeline.map((t) => t.ts));
  });

const RepairPlanOutput = z
  .strictObject({
    ...outputCommonShape,
    status: z.literal('needs_confirmation'),
    view: z.literal('stepper'),
    plan_id: idSchema('pln'),
    confirm_token: z.string().min(16).max(256).describe('Pass to repair_apply only after the person says yes to this plan.'),
    expires_at: IsoSchema,
    diff: z.array(DiffRowSchema),
    diff_lines: z.array(z.string().min(1)).describe('The changes as plain sentences, ready to read out.'),
    steps: z.array(RepairStepSchema).min(1),
    protected_conflicts: z.array(z.string()),
  })
  .superRefine((o, ctx) => {
    sameId(ctx, o.ids, 'plan_id', o.plan_id);
    stepsNumbered(ctx, o.steps);
    o.steps.forEach((s, i) => {
      if (s.status !== 'pending') ctx.addIssue({ code: 'custom', path: ['steps', i, 'status'], message: 'every step of a plan is pending' });
    });
  });

const repairCardShape = {
  ...outputCommonShape,
  status: z.literal('ok'),
  view: z.literal('repair_card'),
  repair_id: idSchema('rep'),
  plan_id: idSchema('pln'),
  steps: z.array(RepairStepSchema),
  undo_available: z.boolean(),
  next_check_at: IsoSchema.optional().describe('When Fixwright checks the repair again (the next morning).'),
};

function repairCardRules(o: { ids: Ids; repair_id: string; plan_id: string; steps: RepairStep[] }, ctx: Ctx): void {
  sameId(ctx, o.ids, 'repair_id', o.repair_id);
  sameIdIfBoth(ctx, o.ids, 'plan_id', o.plan_id);
  stepsNumbered(ctx, o.steps);
}

const UNDOABLE_STATES = new Set<string>(['applied', 'confirmed', 'regressed']);

function undoRule(o: { state: string; undo_available: boolean }, ctx: Ctx): void {
  if (o.undo_available && !UNDOABLE_STATES.has(o.state)) {
    ctx.addIssue({ code: 'custom', path: ['undo_available'], message: `nothing to undo when the repair is ${o.state}` });
  }
}

const RepairApplyOutput = z
  .strictObject({ ...repairCardShape, state: z.enum(REPAIR_APPLY_STATES) })
  .superRefine((o, ctx) => {
    repairCardRules(o, ctx);
    undoRule(o, ctx);
    if (o.state === 'applied') {
      o.steps.forEach((s, i) => {
        if (s.status !== 'done' && s.status !== 'skipped') {
          ctx.addIssue({ code: 'custom', path: ['steps', i, 'status'], message: 'an applied repair has every step done or skipped' });
        }
      });
    }
  });

const RepairStatusOutput = z
  .strictObject({
    ...repairCardShape,
    state: z.enum(REPAIR_STATES),
    checks: z.array(RepairCheckSchema).describe('Follow up checks, oldest first, e.g. the next morning check.'),
  })
  .superRefine((o, ctx) => {
    repairCardRules(o, ctx);
    undoRule(o, ctx);
    ascendingTimes(ctx, 'checks', o.checks.map((c) => c.at));
  });

const UndoOutput = z
  .strictObject({
    ...outputCommonShape,
    status: z.literal('ok'),
    view: z.literal('repair_card'),
    repair_id: idSchema('rep'),
    plan_id: idSchema('pln'),
    state: z.literal('undone'),
    steps: z.array(RepairStepSchema).describe('The inverse steps, each read back.'),
    undo_available: z.literal(false),
  })
  .superRefine((o, ctx) => repairCardRules(o, ctx));

const ProtectDeviceOutput = z
  .strictObject({
    ...outputCommonShape,
    status: z.literal('ok'),
    protected: z.array(ProtectedDeviceSchema).describe('Every protected device after this change.'),
  })
  .superRefine((o, ctx) => unique(ctx, 'protected', o.protected.map((p) => p.entity_id)));

const SwitchDeviceOutput = z
  .strictObject({
    ...outputCommonShape,
    status: z.enum(['ok', 'refused']),
    switched: SwitchedDeviceSchema.optional(),
    alternative: SwitchAlternativeSchema.optional().describe('A safe alternative when a protected load blocked the request. If switched is also present, it was already done.'),
  })
  .superRefine((o, ctx) => {
    if (o.status === 'ok' && o.switched === undefined) {
      ctx.addIssue({ code: 'custom', path: ['switched'], message: 'status ok means a device was switched' });
    }
    if (o.status === 'refused' && o.switched !== undefined && o.switched.entity_id !== o.alternative?.entity_id) {
      ctx.addIssue({ code: 'custom', path: ['switched'], message: 'after a refusal, only the offered alternative may be switched' });
    }
  });

export const ToolOutputs = {
  home_checkup: HomeCheckupOutput,
  diagnose: DiagnoseOutput,
  diagnose_answer: DiagnoseOutput,
  explain_event: ExplainEventOutput,
  repair_plan: RepairPlanOutput,
  repair_apply: RepairApplyOutput,
  repair_status: RepairStatusOutput,
  undo: UndoOutput,
  protect_device: ProtectDeviceOutput,
  switch_device: SwitchDeviceOutput,
  refresh_view: OutputBaseSchema,
} as const satisfies Record<ToolName, z.ZodType>;

/** structuredContent of an isError result, for every tool. */
export const ProblemOutputSchema = z.strictObject({
  ...outputCommonShape,
  status: z.enum(['error', 'refused']),
  problem: z.strictObject({ code: z.enum(PROBLEM_CODES), retryable: z.boolean() }),
});

export type IdentifiedOutput = {
  [N in Exclude<ToolName, 'diagnose_answer' | 'refresh_view'>]: { tool: N; output: ToolOutputMap[N] };
}[Exclude<ToolName, 'diagnose_answer' | 'refresh_view'>];

// diagnose and diagnose_answer share a shape, so both identify as 'diagnose'.
const IDENTIFY_ORDER = [
  'home_checkup',
  'diagnose',
  'explain_event',
  'repair_plan',
  'repair_status',
  'repair_apply',
  'undo',
  'protect_device',
  'switch_device',
] as const satisfies readonly IdentifiedOutput['tool'][];

/**
 * Which tool produced a structuredContent (e.g. from refresh_view), validated against that tool's
 * output schema. Returns null when it matches none.
 */
export function identifyOutput(value: unknown): IdentifiedOutput | null {
  for (const tool of IDENTIFY_ORDER) {
    const r = ToolOutputs[tool].safeParse(value);
    if (r.success) return { tool, output: r.data } as IdentifiedOutput;
  }
  return null;
}
