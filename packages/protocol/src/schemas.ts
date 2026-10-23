// Zod schemas mirroring types.ts. Core model schemas (adapter boundary) strip unknown keys; tool
// output pieces are strict so drift between the engine, server and views fails loudly in tests.

import * as z from 'zod/v4';
import {
  ADAPTER_KINDS,
  EVENT_KINDS,
  PROBE_OUTCOMES,
  REPAIR_STEP_STATUSES,
  SEVERITIES,
  STATUSES,
  TRANSPORTS,
  VERDICT_LEVELS,
  VIEW_KINDS,
  CONFIRM_THRESHOLD,
} from './names.ts';
import { CAUSE_IDS, FINDING_KINDS } from './labels.ts';
import { idPattern, type IdPrefix } from './ids.ts';
import { speechProblems } from './speech.ts';

/** ISO 8601 in UTC with a Z suffix, as every output and the ledger use. */
export const IsoSchema = z.iso.datetime({ message: 'expected an ISO 8601 UTC timestamp ending in Z' });
/** Inputs also accept an explicit offset, e.g. 2026-10-15T03:00:00-07:00. */
export const IsoInputSchema = z.iso.datetime({ offset: true, message: 'expected an ISO 8601 timestamp with Z or an offset' });

export const EntityIdSchema = z
  .string()
  .regex(/^[a-z0-9_]+\.[a-z0-9_]+$/, 'expected an entity id like light.hallway_lamp');

export function idSchema(prefix: IdPrefix) {
  return z.string().regex(idPattern(prefix), `expected a ${prefix}_ id`);
}

/** Ledger sequence numbers that back a claim. */
export const EvidenceSchema = z.array(z.int().nonnegative());

export const SpeechSchema = z
  .string()
  .superRefine((text, ctx) => {
    for (const problem of speechProblems(text)) ctx.addIssue({ code: 'custom', message: `speech ${problem}` });
  })
  .describe('One spoken reply for the person, under 30 seconds. Say it as written.');

export const ProbabilitySchema = z.number().min(0).max(1);

// The core model.

export const TransportSchema = z.enum(TRANSPORTS);
export const EventKindSchema = z.enum(EVENT_KINDS);
export const AdapterKindSchema = z.enum(ADAPTER_KINDS);

export const EntitySchema = z.object({
  entityId: EntityIdSchema,
  name: z.string(),
  aliases: z.array(z.string()),
  domain: z.string().min(1),
  area: z.string().optional(),
  deviceId: z.string().optional(),
  integration: z.string().min(1),
  transport: TransportSchema,
  vendor: z.string().optional(),
  model: z.string().optional(),
  state: z.string(),
  attributes: z.record(z.string(), z.unknown()),
  lastChanged: IsoSchema,
  lastUpdated: IsoSchema,
  restored: z.boolean().optional(),
  disabled: z.boolean().optional(),
  registryOnly: z.boolean().optional(),
});

export const EventContextSchema = z.object({
  userId: z.string().optional(),
  service: z.string().optional(),
  automationId: z.string().optional(),
  eventType: z.string().optional(),
  parentSeq: z.int().nonnegative().optional(),
});

export const HouseEventSchema = z.object({
  seq: z.int().nonnegative(),
  ts: IsoSchema,
  kind: EventKindSchema,
  entityId: EntityIdSchema.optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  context: EventContextSchema.optional(),
  source: z.enum(['home', 'fixwright']),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const SignalsSchema = z.object({
  linkQuality: z.number().min(0).max(255).optional(),
  rssi: z.number().max(0).optional(),
  lastSeen: IsoSchema.optional(),
  batteryPct: z.number().min(0).max(100).optional(),
  uptimeS: z.number().nonnegative().optional(),
  powerOnBehavior: z.enum(['previous', 'on', 'off', 'toggle']).optional(),
  flaps24h: z.int().nonnegative().optional(),
});

export const IntegrationStatusSchema = z.object({
  integration: z.string().min(1),
  state: z.enum(['loaded', 'setup_error', 'not_loaded', 'setup_retry']),
  reason: z.string().optional(),
  entryId: z.string().optional(),
});

export const CloudStatusSchema = z.object({
  vendor: z.string().min(1),
  status: z.enum(['ok', 'degraded', 'outage', 'unknown']),
  source: z.string(),
  checkedAt: IsoSchema,
});

export const HubStatusSchema = z.object({
  reachable: z.boolean(),
  latencyMs: z.number().nonnegative().optional(),
  version: z.string().optional(),
});

// The shapes every tool shares.

export const StatusSchema = z.enum(STATUSES);
export const ViewKindSchema = z.enum(VIEW_KINDS);
export const CauseIdSchema = z.enum(CAUSE_IDS);
export const FindingKindSchema = z.enum(FINDING_KINDS);
export const SeveritySchema = z.enum(SEVERITIES);

export const IdsSchema = z
  .strictObject({
    checkup_id: idSchema('chk').optional(),
    issue_id: idSchema('iss').optional(),
    diagnosis_id: idSchema('dx').optional(),
    explanation_id: idSchema('exp').optional(),
    plan_id: idSchema('pln').optional(),
    repair_id: idSchema('rep').optional(),
  })
  .describe('Ids to chain into the next call: checkup to issue to plan to repair.');

export const SourceInfoSchema = z
  .strictObject({ adapter: AdapterKindSchema, simulated: z.boolean() })
  .describe('Which home the answer came from. simulated is true for the SimHome twin.');

/** Shape shared by every output (OutputBase without status and view, which tools narrow). */
export const outputCommonShape = {
  speech: SpeechSchema,
  ids: IdsSchema,
  source: SourceInfoSchema,
};

/** Accepts any tool output and checks only the fields all outputs share. */
export const OutputBaseSchema = z.looseObject({
  ...outputCommonShape,
  status: StatusSchema,
  view: ViewKindSchema.optional(),
});

export const ClaimSchema = z.strictObject({
  text: z.string().min(1),
  evidence: EvidenceSchema,
});

export const VerdictSchema = z
  .strictObject({
    level: z.enum(VERDICT_LEVELS),
    cause_id: CauseIdSchema,
    label: z.string().min(1),
    confidence: ProbabilitySchema,
    claims: z.array(ClaimSchema),
    fix_available: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.level !== 'confirmed') return;
    if (v.confidence < CONFIRM_THRESHOLD) {
      ctx.addIssue({ code: 'custom', path: ['confidence'], message: `a confirmed verdict needs confidence of at least ${CONFIRM_THRESHOLD}` });
    }
    if (!v.claims.some((c) => c.evidence.length > 0)) {
      ctx.addIssue({ code: 'custom', path: ['claims'], message: 'a confirmed verdict needs at least one claim with evidence' });
    }
  });

export const ProbeResultSchema = z.strictObject({
  probe_id: z.string().regex(/^[a-z][a-z0-9_]*$/, 'probe ids are snake_case'),
  label: z.string().min(1),
  outcome: z.enum(PROBE_OUTCOMES),
  detail: z.string(),
  evidence: EvidenceSchema,
  disruptive: z.boolean(),
  at: IsoSchema,
});

export const HypothesisSchema = z.strictObject({
  cause_id: CauseIdSchema,
  label: z.string().min(1),
  p: ProbabilitySchema,
});

export const QuestionSchema = z
  .strictObject({
    question_id: idSchema('q'),
    text: z.string().min(1),
    expects: z.enum(['yes_no', 'choice']),
    choices: z.array(z.string().min(1)).optional(),
    action_performed: z.string().optional(),
  })
  .superRefine((q, ctx) => {
    if (q.expects === 'choice' && (q.choices?.length ?? 0) < 2) {
      ctx.addIssue({ code: 'custom', path: ['choices'], message: 'a choice question needs at least two choices' });
    }
    if (q.expects === 'yes_no' && q.choices !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['choices'], message: 'a yes or no question has no choices' });
    }
  });

export const FindingSchema = z.strictObject({
  issue_id: idSchema('iss'),
  kind: FindingKindSchema,
  severity: SeveritySchema,
  title: z.string().min(1),
  detail: z.string(),
  entity_ids: z.array(EntityIdSchema),
  fixable: z.boolean(),
  action_label: z.string().min(1).optional(),
});

export const DiffRowSchema = z.strictObject({
  entity_id: EntityIdSchema,
  field: z.string().min(1),
  from: z.string(),
  to: z.string(),
});

export const RepairStepSchema = z.strictObject({
  step: z.int().positive(),
  label: z.string().min(1),
  status: z.enum(REPAIR_STEP_STATUSES),
  read_back: z.string().optional(),
});

export const DiagnosisTargetSchema = z.strictObject({
  entity_id: EntityIdSchema.optional(),
  name: z.string().min(1),
  guided: z.boolean(),
});

export const TimelineEntrySchema = z.strictObject({
  ts: IsoSchema,
  label: z.string().min(1),
  evidence: EvidenceSchema,
});

export const SuggestedFixSchema = z.strictObject({
  issue_id: idSchema('iss'),
  label: z.string().min(1),
});

export const RepairCheckSchema = z.strictObject({
  at: IsoSchema,
  result: z.enum(['pass', 'fail']),
  detail: z.string().min(1),
});

export const ProtectedDeviceSchema = z.strictObject({
  entity_id: EntityIdSchema,
  name: z.string().min(1),
  reason: z.string(),
});

export const SwitchedDeviceSchema = z.strictObject({
  entity_id: EntityIdSchema,
  name: z.string().min(1),
  state: z.string().min(1),
});

export const SwitchAlternativeSchema = z.strictObject({
  entity_id: EntityIdSchema,
  name: z.string().min(1),
  label: z.string().min(1),
});
