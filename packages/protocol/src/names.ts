// Closed vocabularies shared by types, schemas and tool definitions.

export const TOOL_NAMES = [
  'home_checkup',
  'diagnose',
  'diagnose_answer',
  'explain_event',
  'repair_plan',
  'repair_apply',
  'repair_status',
  'undo',
  'protect_device',
  'switch_device',
  'refresh_view',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const STATUSES = ['ok', 'needs_answer', 'needs_confirmation', 'refused', 'error'] as const;
export type Status = (typeof STATUSES)[number];

export const VIEW_KINDS = ['stepper', 'carousel', 'repair_card'] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export const VIEW_URIS = {
  stepper: 'ui://fixwright/stepper.html',
  carousel: 'ui://fixwright/carousel.html',
  repair_card: 'ui://fixwright/repair-card.html',
} as const satisfies Record<ViewKind, string>;
export type ViewUri = (typeof VIEW_URIS)[ViewKind];

/** Which view renders each tool's result. Tools without a view are voice only. */
export const TOOL_VIEWS = {
  home_checkup: 'carousel',
  diagnose: 'stepper',
  diagnose_answer: 'stepper',
  explain_event: 'stepper',
  repair_plan: 'stepper',
  repair_apply: 'repair_card',
  repair_status: 'repair_card',
  undo: 'repair_card',
} as const satisfies Partial<Record<ToolName, ViewKind>>;
export type ViewToolName = keyof typeof TOOL_VIEWS;

export const ADAPTER_KINDS = ['simhome', 'home-assistant'] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

export const TRANSPORTS = ['zigbee', 'wifi', 'thread', 'cloud', 'virtual'] as const;

export const EVENT_KINDS = [
  'state',
  'availability',
  'service_call',
  'automation_run',
  'integration',
  'power',
  'probe',
  'human_answer',
  'repair',
  'note',
] as const;

export const SEVERITIES = ['high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Lower rank sorts first: findings are listed most severe first. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { high: 0, medium: 1, low: 2 };

export const VERDICT_LEVELS = ['confirmed', 'likely', 'cant_tell'] as const;
export const PROBE_OUTCOMES = ['pass', 'fail', 'unknown'] as const;
export const REPAIR_STEP_STATUSES = ['pending', 'done', 'rolled_back', 'skipped', 'failed'] as const;
export const REPAIR_APPLY_STATES = ['applied', 'rolled_back', 'failed'] as const;
export const REPAIR_STATES = [...REPAIR_APPLY_STATES, 'confirmed', 'regressed', 'undone'] as const;

/** Confidence at which the engine stops probing and may call a verdict confirmed. */
export const CONFIRM_THRESHOLD = 0.9;
