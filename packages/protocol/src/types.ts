// The Fixwright contract as plain TypeScript. schemas.ts mirrors every data type here
// with zod, and test/types.test.ts proves at compile time that the two never drift apart.
//
// Tool inputs, tool outputs and OutputBase are `type` aliases rather than interfaces on purpose: object
// type aliases are assignable to Record<string, unknown>, which MCP's arguments and structuredContent expect.

import type {
  AdapterKind,
  Severity,
  Status,
  ToolName,
  ViewKind,
} from './names.ts';
import type { CauseId, FindingKind } from './labels.ts';
import type { ProblemCode } from './errors.ts';

export type { AdapterKind, Severity, Status, ToolName, ViewKind } from './names.ts';
export type { CauseId, FindingKind } from './labels.ts';

// The core model.

/** ISO 8601 timestamp in UTC, e.g. 2026-10-15T10:12:00.000Z. */
export type Iso = string;
/** Home Assistant style entity id, e.g. light.hallway_lamp. */
export type EntityId = string;
export type Transport = 'zigbee' | 'wifi' | 'thread' | 'cloud' | 'virtual';

export interface Entity {
  entityId: EntityId;
  /** Friendly name as spoken. */
  name: string;
  aliases: string[];
  /** light | switch | sensor | binary_sensor | select | climate | fan | automation | ... */
  domain: string;
  area?: string;
  deviceId?: string;
  /** zigbee2mqtt | hue | kasa | matter | ecobee | demo | template | ... */
  integration: string;
  transport: Transport;
  vendor?: string;
  model?: string;
  /** 'on' | 'off' | 'unavailable' | numeric string | option */
  state: string;
  attributes: Record<string, unknown>;
  lastChanged: Iso;
  lastUpdated: Iso;
  /** Home Assistant restored=true: known to the registry but not provided by its integration. */
  restored?: boolean;
  disabled?: boolean;
  /** Present in the registry, missing from the state machine. */
  registryOnly?: boolean;
}

export type EventKind =
  | 'state'
  | 'availability'
  | 'service_call'
  | 'automation_run'
  | 'integration'
  | 'power'
  | 'probe'
  | 'human_answer'
  | 'repair'
  | 'note';

export interface EventContext {
  userId?: string;
  service?: string;
  automationId?: string;
  eventType?: string;
  parentSeq?: number;
}

export interface HouseEvent {
  /** Ledger sequence. Adapters return 0 and the ledger assigns the real value. */
  seq: number;
  ts: Iso;
  kind: EventKind;
  entityId?: EntityId;
  from?: string;
  to?: string;
  context?: EventContext;
  source: 'home' | 'fixwright';
  data?: Record<string, unknown>;
}

/** Per entity link and health signals. All optional: adapters fill what they can. */
export interface Signals {
  /** Zigbee LQI, 0 to 255. */
  linkQuality?: number;
  /** Wi-Fi RSSI in dBm. */
  rssi?: number;
  lastSeen?: Iso;
  batteryPct?: number;
  uptimeS?: number;
  powerOnBehavior?: 'previous' | 'on' | 'off' | 'toggle';
  /** Unavailable transitions in the last 24 h. */
  flaps24h?: number;
}

export interface IntegrationStatus {
  integration: string;
  state: 'loaded' | 'setup_error' | 'not_loaded' | 'setup_retry';
  reason?: string;
  entryId?: string;
}

export interface CloudStatus {
  vendor: string;
  status: 'ok' | 'degraded' | 'outage' | 'unknown';
  source: string;
  checkedAt: Iso;
}

export interface HubStatus {
  reachable: boolean;
  latencyMs?: number;
  version?: string;
}

export interface EventQuery {
  since: Iso;
  until?: Iso;
  entityIds?: EntityId[];
}

export interface RegistryPatch {
  name?: string | null;
  aliases?: string[];
  disabled?: boolean;
}

export interface HomeAdapter {
  readonly kind: AdapterKind;
  listEntities(): Promise<Entity[]>;
  getEntity(id: EntityId): Promise<Entity | null>;
  callService(domain: string, service: string, data: Record<string, unknown>): Promise<{ changed: Entity[] }>;
  events(q: EventQuery): Promise<HouseEvent[]>;
  signals(id: EntityId): Promise<Signals>;
  integrations(): Promise<IntegrationStatus[]>;
  hubStatus(): Promise<HubStatus>;
  cloudStatus(vendor: string): Promise<CloudStatus>;
  registryUpdate(id: EntityId, patch: RegistryPatch): Promise<Entity>;
  registryRemove(id: EntityId): Promise<void>;
  reloadIntegration(integration: string): Promise<void>;
  selectOption(id: EntityId, option: string): Promise<Entity>;
  /** Adapter clock. SimHome may run on virtual time. */
  now(): Iso;
}

export interface Clock {
  now(): Iso;
  nowMs(): number;
}

/** Uniform random numbers in [0, 1). */
export interface Rng {
  next(): number;
}

// The tool shapes.

export interface Ids {
  checkup_id?: string;
  issue_id?: string;
  diagnosis_id?: string;
  explanation_id?: string;
  plan_id?: string;
  repair_id?: string;
}

export interface SourceInfo {
  adapter: AdapterKind;
  simulated: boolean;
}

/** Fields every tool output carries, whatever its status and view. */
export type OutputCommon = {
  /** One spoken reply, under 30 s, no markup, no pipes, no ids, no tool names, no JSON. */
  speech: string;
  ids: Ids;
  source: SourceInfo;
};

export type OutputBase = OutputCommon & {
  status: Status;
  view?: ViewKind;
};

/** A factual sentence and the ledger seqs that back it. Evidence is empty only for framing text. */
export interface Claim {
  text: string;
  evidence: number[];
}

export type VerdictLevel = 'confirmed' | 'likely' | 'cant_tell';

export interface Verdict {
  level: VerdictLevel;
  cause_id: CauseId;
  label: string;
  confidence: number;
  claims: Claim[];
  fix_available: boolean;
}

export type ProbeOutcome = 'pass' | 'fail' | 'unknown';

export interface ProbeResult {
  probe_id: string;
  label: string;
  outcome: ProbeOutcome;
  detail: string;
  evidence: number[];
  disruptive: boolean;
  at: Iso;
}

export interface Hypothesis {
  cause_id: CauseId;
  label: string;
  p: number;
}

export interface Question {
  question_id: string;
  text: string;
  expects: 'yes_no' | 'choice';
  choices?: string[];
  action_performed?: string;
}

export interface Finding {
  issue_id: string;
  kind: FindingKind;
  severity: Severity;
  title: string;
  detail: string;
  entity_ids: EntityId[];
  fixable: boolean;
  action_label?: string;
}

export interface DiffRow {
  entity_id: EntityId;
  field: string;
  from: string;
  to: string;
}

export type RepairStepStatus = 'pending' | 'done' | 'rolled_back' | 'skipped' | 'failed';

export interface RepairStep {
  step: number;
  label: string;
  status: RepairStepStatus;
  read_back?: string;
}

export interface DiagnosisTarget {
  entity_id?: EntityId;
  name: string;
  /** True when Fixwright cannot see the device and walks the person through it instead. */
  guided: boolean;
}

export interface TimelineEntry {
  ts: Iso;
  label: string;
  evidence: number[];
}

export interface SuggestedFix {
  issue_id: string;
  label: string;
}

export type RepairApplyState = 'applied' | 'rolled_back' | 'failed';
export type RepairState = RepairApplyState | 'confirmed' | 'regressed' | 'undone';

export interface RepairCheck {
  at: Iso;
  result: 'pass' | 'fail';
  detail: string;
}

export interface ProtectedDevice {
  entity_id: EntityId;
  name: string;
  reason: string;
}

export interface SwitchedDevice {
  entity_id: EntityId;
  name: string;
  state: string;
}

export interface SwitchAlternative {
  entity_id: EntityId;
  name: string;
  label: string;
}

export type HomeCheckupInput = {
  focus?: string;
};
export type DiagnoseInput = {
  symptom: string;
  device?: string;
};
export type DiagnoseAnswerInput = {
  diagnosis_id: string;
  question_id: string;
  answer: string;
};
export type ExplainEventInput = {
  question: string;
  since?: Iso;
  until?: Iso;
};
/** Exactly one of the three ids. */
export type RepairPlanInput = {
  diagnosis_id?: string;
  issue_id?: string;
  explanation_id?: string;
};
export type RepairApplyInput = {
  plan_id: string;
  confirm_token: string;
};
export type RepairStatusInput = {
  repair_id: string;
};
export type UndoInput = {
  repair_id: string;
};
export type ProtectDeviceInput = {
  device: string;
  reason?: string;
  /** Defaults to true. False removes the protection. */
  protect?: boolean;
};
export type SwitchDeviceInput = {
  device: string;
  on: boolean;
};
export type RefreshViewInput = {
  ref_id: string;
};

export type HomeCheckupOutput = OutputCommon & {
  status: 'ok';
  view: 'carousel';
  checkup_id: string;
  /** 3 to 5, most severe first. Fewer only when the house is healthy. */
  findings: Finding[];
};

export type DiagnoseOutput = OutputCommon & {
  status: 'ok' | 'needs_answer';
  view: 'stepper';
  diagnosis_id: string;
  target: DiagnosisTarget;
  probes: ProbeResult[];
  /** Top 3, most likely first, p sums to at most 1. */
  hypotheses: Hypothesis[];
  /** Present exactly when status is needs_answer. */
  question?: Question;
  /** Present exactly when status is ok (the diagnosis finished). */
  verdict?: Verdict;
};

export type DiagnoseAnswerOutput = DiagnoseOutput;

export type ExplainEventOutput = OutputCommon & {
  status: 'ok';
  view: 'stepper';
  explanation_id: string;
  verdict: Verdict;
  timeline: TimelineEntry[];
  suggested_fix?: SuggestedFix;
};

export type RepairPlanOutput = OutputCommon & {
  status: 'needs_confirmation';
  view: 'stepper';
  plan_id: string;
  confirm_token: string;
  expires_at: Iso;
  diff: DiffRow[];
  /** Plain sentences describing the diff. */
  diff_lines: string[];
  /** All pending. */
  steps: RepairStep[];
  protected_conflicts: string[];
};

export type RepairApplyOutput = OutputCommon & {
  status: 'ok';
  view: 'repair_card';
  repair_id: string;
  plan_id: string;
  state: RepairApplyState;
  steps: RepairStep[];
  undo_available: boolean;
  next_check_at?: Iso;
};

export type RepairStatusOutput = OutputCommon & {
  status: 'ok';
  view: 'repair_card';
  repair_id: string;
  plan_id: string;
  state: RepairState;
  steps: RepairStep[];
  undo_available: boolean;
  next_check_at?: Iso;
  checks: RepairCheck[];
};

export type UndoOutput = OutputCommon & {
  status: 'ok';
  view: 'repair_card';
  repair_id: string;
  plan_id: string;
  state: 'undone';
  /** The inverse steps, each read back. */
  steps: RepairStep[];
  undo_available: false;
};

export type ProtectDeviceOutput = OutputCommon & {
  status: 'ok';
  /** Every protected device after the change. */
  protected: ProtectedDevice[];
};

export type SwitchDeviceOutput = OutputCommon & {
  status: 'ok' | 'refused';
  switched?: SwitchedDevice;
  /** Offered (or, with `switched`, performed) when a protected load blocks the request. */
  alternative?: SwitchAlternative;
};

/** Any tool output seen through its shared fields (what OutputBaseSchema accepts). */
export type AnyOutput = OutputBase & { [key: string]: unknown };

/** The latest structuredContent for the referenced id: one of the view tools' outputs. */
export type RefreshViewOutput = AnyOutput;

/**
 * What a tool returns with isError: true. Every tool may return it instead of its normal output.
 * MCP clients and servers skip outputSchema validation for isError results.
 */
export type ProblemOutput = OutputCommon & {
  status: 'error' | 'refused';
  problem: { code: ProblemCode; retryable: boolean };
};

export interface ToolInputMap {
  home_checkup: HomeCheckupInput;
  diagnose: DiagnoseInput;
  diagnose_answer: DiagnoseAnswerInput;
  explain_event: ExplainEventInput;
  repair_plan: RepairPlanInput;
  repair_apply: RepairApplyInput;
  repair_status: RepairStatusInput;
  undo: UndoInput;
  protect_device: ProtectDeviceInput;
  switch_device: SwitchDeviceInput;
  refresh_view: RefreshViewInput;
}

export interface ToolOutputMap {
  home_checkup: HomeCheckupOutput;
  diagnose: DiagnoseOutput;
  diagnose_answer: DiagnoseAnswerOutput;
  explain_event: ExplainEventOutput;
  repair_plan: RepairPlanOutput;
  repair_apply: RepairApplyOutput;
  repair_status: RepairStatusOutput;
  undo: UndoOutput;
  protect_device: ProtectDeviceOutput;
  switch_device: SwitchDeviceOutput;
  refresh_view: RefreshViewOutput;
}

export type ToolInput<N extends ToolName> = ToolInputMap[N];
export type ToolOutput<N extends ToolName> = ToolOutputMap[N];

/** Everything each view can be handed. */
export type StepperPayload = DiagnoseOutput | ExplainEventOutput | RepairPlanOutput;
export type CarouselPayload = HomeCheckupOutput;
export type RepairCardPayload = RepairApplyOutput | RepairStatusOutput | UndoOutput;
