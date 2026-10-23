// structuredContent arrives over postMessage, so nothing renders before these checks. Hand written guards,
// not zod schemas, keep the single file views small.
import type {
  DiagnoseOutput,
  ExplainEventOutput,
  HomeCheckupOutput,
  RepairApplyOutput,
  RepairPlanOutput,
  RepairStatusOutput,
  UndoOutput,
} from '@fixwright/protocol';

export type RepairPayload = RepairApplyOutput | RepairStatusOutput | UndoOutput;

export type ViewPayload =
  | { kind: 'diagnosis'; data: DiagnoseOutput }
  | { kind: 'explanation'; data: ExplainEventOutput }
  | { kind: 'plan'; data: RepairPlanOutput }
  | { kind: 'repair'; data: RepairPayload }
  | { kind: 'checkup'; data: HomeCheckupOutput };

export type PayloadKind = ViewPayload['kind'];

export interface Problem {
  speech: string;
  retryable: boolean;
  /** The person said no on the host's approval sheet: nothing failed and nothing changed. */
  declined?: boolean;
}

export type ToolOutcome = { ok: true; payload: ViewPayload } | { ok: false; problem: Problem };

export interface ToolResultLike {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
}

export const FALLBACK_PROBLEM = "That didn't go through. You can try again, or just ask me out loud.";
export const UNREADABLE_PROBLEM = "I got an answer I can't show here. Ask me out loud and I'll tell you.";
/** Matches apps/host DECLINED_BY_PERSON: shown as a calm note, never an error. */
export const DECLINED_NOTE = 'Not approved. Nothing changed.';

/** An MCP error message wraps the decline words, so this checks for containment. */
export function isDeclineMessage(message: string): boolean {
  return message.includes(DECLINED_NOTE);
}

type Rec = Record<string, unknown>;

export function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNumber);
const arrayOf = <T>(v: unknown, guard: (x: unknown) => x is T): v is T[] => Array.isArray(v) && v.every(guard);
const optional = (v: unknown, guard: (x: unknown) => boolean): boolean => v === undefined || guard(v);

function hasBase(v: Rec): boolean {
  return isString(v.speech) && isString(v.status) && isRecord(v.ids) && isRecord(v.source) && isBool(v.source.simulated);
}

function isClaim(v: unknown): v is { text: string; evidence: number[] } {
  return isRecord(v) && isString(v.text) && isNumberArray(v.evidence);
}

function isVerdict(v: unknown): boolean {
  return (
    isRecord(v) &&
    (v.level === 'confirmed' || v.level === 'likely' || v.level === 'cant_tell') &&
    isString(v.cause_id) &&
    isString(v.label) &&
    isNumber(v.confidence) &&
    arrayOf(v.claims, isClaim) &&
    isBool(v.fix_available)
  );
}

function isProbe(v: unknown): v is Rec {
  return (
    isRecord(v) &&
    isString(v.probe_id) &&
    isString(v.label) &&
    (v.outcome === 'pass' || v.outcome === 'fail' || v.outcome === 'unknown') &&
    isString(v.detail) &&
    isNumberArray(v.evidence) &&
    isBool(v.disruptive)
  );
}

function isHypothesis(v: unknown): v is Rec {
  return isRecord(v) && isString(v.cause_id) && isString(v.label) && isNumber(v.p);
}

function isQuestion(v: unknown): v is Rec {
  return (
    isRecord(v) &&
    isString(v.question_id) &&
    isString(v.text) &&
    (v.expects === 'yes_no' || v.expects === 'choice') &&
    optional(v.choices, (c): c is string[] => arrayOf(c, isString)) &&
    optional(v.action_performed, isString)
  );
}

const STEP_STATUSES = ['pending', 'done', 'rolled_back', 'skipped', 'failed'];
function isStep(v: unknown): v is Rec {
  return isRecord(v) && isNumber(v.step) && isString(v.label) && STEP_STATUSES.includes(v.status as string) && optional(v.read_back, isString);
}

function isFinding(v: unknown): v is Rec {
  return (
    isRecord(v) &&
    isString(v.issue_id) &&
    isString(v.kind) &&
    (v.severity === 'high' || v.severity === 'medium' || v.severity === 'low') &&
    isString(v.title) &&
    isString(v.detail) &&
    arrayOf(v.entity_ids, isString) &&
    isBool(v.fixable) &&
    optional(v.action_label, isString)
  );
}

function isTimelineEntry(v: unknown): v is Rec {
  return isRecord(v) && isString(v.ts) && isString(v.label) && isNumberArray(v.evidence);
}

function isDiffRow(v: unknown): v is Rec {
  return isRecord(v) && isString(v.entity_id) && isString(v.field) && isString(v.from) && isString(v.to);
}

function isCheck(v: unknown): v is Rec {
  return isRecord(v) && isString(v.at) && (v.result === 'pass' || v.result === 'fail') && isString(v.detail);
}

const REPAIR_STATES = ['applied', 'rolled_back', 'failed', 'confirmed', 'regressed', 'undone'];

export function classifyPayload(sc: unknown): ViewPayload | null {
  if (!isRecord(sc) || !hasBase(sc)) return null;
  if (isString(sc.diagnosis_id) && Array.isArray(sc.hypotheses)) {
    const ok =
      isRecord(sc.target) &&
      isString(sc.target.name) &&
      isBool(sc.target.guided) &&
      arrayOf(sc.probes, isProbe) &&
      arrayOf(sc.hypotheses, isHypothesis) &&
      optional(sc.question, isQuestion) &&
      optional(sc.verdict, isVerdict);
    return ok ? { kind: 'diagnosis', data: sc as unknown as DiagnoseOutput } : null;
  }
  if (isString(sc.explanation_id) && Array.isArray(sc.timeline)) {
    const ok =
      isVerdict(sc.verdict) &&
      arrayOf(sc.timeline, isTimelineEntry) &&
      optional(sc.suggested_fix, (f): f is Rec => isRecord(f) && isString(f.issue_id) && isString(f.label));
    return ok ? { kind: 'explanation', data: sc as unknown as ExplainEventOutput } : null;
  }
  if (isString(sc.plan_id) && isString(sc.confirm_token)) {
    const ok =
      isString(sc.expires_at) &&
      arrayOf(sc.diff, isDiffRow) &&
      arrayOf(sc.diff_lines, isString) &&
      arrayOf(sc.steps, isStep) &&
      arrayOf(sc.protected_conflicts, isString);
    return ok ? { kind: 'plan', data: sc as unknown as RepairPlanOutput } : null;
  }
  if (isString(sc.repair_id) && isString(sc.state)) {
    const ok =
      REPAIR_STATES.includes(sc.state) &&
      isString(sc.plan_id) &&
      arrayOf(sc.steps, isStep) &&
      isBool(sc.undo_available) &&
      optional(sc.next_check_at, isString) &&
      optional(sc.checks, (c): c is Rec[] => arrayOf(c, isCheck));
    return ok ? { kind: 'repair', data: sc as unknown as RepairPayload } : null;
  }
  if (isString(sc.checkup_id) && Array.isArray(sc.findings)) {
    return arrayOf(sc.findings, isFinding) ? { kind: 'checkup', data: sc as unknown as HomeCheckupOutput } : null;
  }
  return null;
}

function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const c of content) if (isRecord(c) && c.type === 'text' && isString(c.text) && c.text.trim()) return c.text.trim();
  return null;
}

/** A ProblemOutput's speech is already safe to show; anything else unexpected becomes a gentle fallback line. */
export function readToolResult(result: ToolResultLike): ToolOutcome {
  const sc = result.structuredContent;
  const status = isRecord(sc) ? sc.status : undefined;
  if (result.isError || status === 'error' || status === 'refused') {
    const speech = (isRecord(sc) && isString(sc.speech) && sc.speech.trim()) || firstText(result.content) || FALLBACK_PROBLEM;
    const problem = isRecord(sc) && isRecord(sc.problem) ? sc.problem : undefined;
    return { ok: false, problem: { speech, retryable: problem ? problem.retryable === true : true } };
  }
  const payload = classifyPayload(sc);
  if (!payload) return { ok: false, problem: { speech: UNREADABLE_PROBLEM, retryable: false } };
  return { ok: true, payload };
}
