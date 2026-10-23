// The conversation state machine. Plain JSON in, plain JSON out, so a host can keep it in memory,
// localStorage or a Durable Object, and a test can write it as a literal.
//
// What it remembers:
// - pendingQuestion: a diagnosis asked the person something ("Did it blink?"); the next yes or no
//   answers it.
// - pendingOffer: a verdict or explanation offered a fix ("Want me to fix that?"); a yes plans it.
// - pendingPlan: a dry run is waiting for one explicit yes; that yes applies it with the plan's
//   confirm_token. Nothing else ever sends a confirm_token.
// - findings: the last checkup, so "fix the first one" can find its issue_id.
// - last: the newest id of each kind, so "undo" and "did the fix hold" know what they refer to.
// - repairs: the repairs applied in this conversation, with what each was about, so "did the hallway
//   lamp fix hold?" (or a tapped push that names the lamp) finds that repair, not just the newest one.

import type { ToolName } from '@fixwright/protocol';

export interface PendingQuestion {
  diagnosis_id: string;
  question_id: string;
  text: string;
}

export interface PendingPlan {
  plan_id: string;
  confirm_token: string;
  expires_at: string | null;
  /** The plain sentences of the dry run, for an approval prompt. */
  diff_lines: string[];
  /** The device or finding the plan is about, when the conversation knows it (optional, older states lack it). */
  subject?: string | null;
}

export type OfferKind = 'diagnosis' | 'issue' | 'explanation';

export interface PendingOffer {
  kind: OfferKind;
  id: string;
  label: string | null;
}

export interface FindingRef {
  issue_id: string;
  title: string;
  fixable: boolean;
  /** The finding kind (duplicate_name, low_battery, ...), so "fix the duplicate name" finds it. */
  kind?: string;
  /** The server's plain advice for the finding, said when Fixwright cannot fix it itself. */
  detail?: string;
}

/** A repair applied in this conversation, newest last. */
export interface RepairRef {
  repair_id: string;
  /** The diagnosed device or the checkup finding it fixed; null for a fix from an explanation. */
  subject: string | null;
  /** The dry run's sentences and the step labels, clipped: the devices it touched. */
  text: string[];
}

export interface LastIds {
  checkup_id: string | null;
  issue_id: string | null;
  diagnosis_id: string | null;
  explanation_id: string | null;
  plan_id: string | null;
  repair_id: string | null;
}

export interface ConversationState {
  v: 1;
  /** Tool results seen so far. Only for traces and tests. */
  turn: number;
  pendingQuestion: PendingQuestion | null;
  pendingOffer: PendingOffer | null;
  pendingPlan: PendingPlan | null;
  findings: FindingRef[];
  last: LastIds;
  lastDevice: string | null;
  /** Repairs applied in this conversation, newest last (optional: older states and the server's copy lack it). */
  repairs?: RepairRef[];
}

export function initialState(): ConversationState {
  return {
    v: 1,
    turn: 0,
    pendingQuestion: null,
    pendingOffer: null,
    pendingPlan: null,
    findings: [],
    last: {
      checkup_id: null,
      issue_id: null,
      diagnosis_id: null,
      explanation_id: null,
      plan_id: null,
      repair_id: null,
    },
    lastDevice: null,
  };
}

/** A finished tool call as the host saw it. `structuredContent` is untrusted and read defensively. */
export interface ToolOutcome {
  tool: ToolName;
  arguments?: Readonly<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const MAX_DETAIL = 300;
/** Repairs remembered per conversation, and how much of each one's text. */
export const MAX_REPAIRS = 8;
const MAX_REPAIR_LINES = 20;
const MAX_REPAIR_LINE = 160;

const ID_KEYS = ['checkup_id', 'issue_id', 'diagnosis_id', 'explanation_id', 'plan_id', 'repair_id'] as const;

/** Plan failures after which the plan can never be applied, so the yes turn must not reuse it. */
const DEAD_PLAN_CODES = new Set(['plan_expired', 'plan_used', 'token_mismatch', 'session_expired', 'not_found']);
const DEAD_QUESTION_CODES = new Set(['question_answered', 'session_expired', 'not_found']);

function problemCode(sc: unknown): string | null {
  if (!isObj(sc) || !isObj(sc['problem'])) return null;
  return str(sc['problem']['code']);
}

function mergeIds(last: LastIds, sc: Json): LastIds {
  const next = { ...last };
  const ids = isObj(sc['ids']) ? sc['ids'] : {};
  for (const key of ID_KEYS) {
    const v = str(ids[key]) ?? str(sc[key]);
    if (v) next[key] = v;
  }
  return next;
}

function readQuestion(sc: Json, diagnosisId: string | null): PendingQuestion | null {
  const q = sc['question'];
  if (sc['status'] !== 'needs_answer' || !isObj(q) || !diagnosisId) return null;
  const questionId = str(q['question_id']);
  if (!questionId) return null;
  return { diagnosis_id: diagnosisId, question_id: questionId, text: str(q['text']) ?? '' };
}

function readFindings(sc: Json): FindingRef[] {
  const list = Array.isArray(sc['findings']) ? sc['findings'] : [];
  const out: FindingRef[] = [];
  for (const f of list) {
    if (!isObj(f)) continue;
    const issueId = str(f['issue_id']);
    if (!issueId) continue;
    const detail = str(f['detail']);
    const kind = str(f['kind']);
    out.push({
      issue_id: issueId,
      title: str(f['title']) ?? '',
      fixable: f['fixable'] === true,
      ...(kind ? { kind: kind.slice(0, 40) } : {}),
      ...(detail ? { detail: detail.slice(0, MAX_DETAIL) } : {}),
    });
  }
  return out;
}

/** What a plan is about: the diagnosed device, or the checkup finding's title. Null for an explanation's fix. */
function planSubject(state: ConversationState, args: Readonly<Record<string, unknown>> | undefined): string | null {
  const issueId = str(args?.['issue_id']);
  if (issueId) return state.findings.find((f) => f.issue_id === issueId)?.title ?? null;
  return str(args?.['diagnosis_id']) ? state.lastDevice : null;
}

function rememberRepair(list: readonly RepairRef[], repairId: string, plan: PendingPlan | null, sc: Json): RepairRef[] {
  const labels = Array.isArray(sc['steps']) ? sc['steps'].map((x) => (isObj(x) ? str(x['label']) : null)).filter((x): x is string => x !== null) : [];
  const text = [...(plan?.diff_lines ?? []), ...labels].slice(0, MAX_REPAIR_LINES).map((l) => l.slice(0, MAX_REPAIR_LINE));
  const ref: RepairRef = { repair_id: repairId, subject: plan?.subject ?? null, text };
  return [...list.filter((r) => r.repair_id !== repairId), ref].slice(-MAX_REPAIRS);
}

/** Fold one tool result into the conversation. Pure: returns a new object. */
export function applyResult(state: ConversationState, outcome: ToolOutcome): ConversationState {
  const s: ConversationState = {
    ...state,
    turn: state.turn + 1,
    last: { ...state.last },
    findings: [...state.findings],
  };
  const sc = outcome.structuredContent;

  if (outcome.isError || !isObj(sc) || sc['status'] === 'error') {
    const code = problemCode(sc);
    if (outcome.tool === 'repair_apply' && (code === null || DEAD_PLAN_CODES.has(code))) s.pendingPlan = null;
    if (outcome.tool === 'diagnose_answer' && code !== null && DEAD_QUESTION_CODES.has(code)) s.pendingQuestion = null;
    return s;
  }

  s.last = mergeIds(s.last, sc);

  switch (outcome.tool) {
    case 'diagnose':
    case 'diagnose_answer': {
      const diagnosisId = str(sc['diagnosis_id']) ?? s.last.diagnosis_id;
      const target = isObj(sc['target']) ? sc['target'] : {};
      s.lastDevice = str(target['name']) ?? s.lastDevice;
      s.pendingPlan = null;
      s.pendingQuestion = readQuestion(sc, diagnosisId);
      const verdict = isObj(sc['verdict']) ? sc['verdict'] : null;
      s.pendingOffer =
        verdict && verdict['fix_available'] === true && diagnosisId
          ? { kind: 'diagnosis', id: diagnosisId, label: str(verdict['label']) }
          : null;
      return s;
    }
    case 'explain_event': {
      s.pendingQuestion = null;
      s.pendingPlan = null;
      const fix = isObj(sc['suggested_fix']) ? sc['suggested_fix'] : null;
      const verdict = isObj(sc['verdict']) ? sc['verdict'] : null;
      const issueId = fix ? str(fix['issue_id']) : null;
      const explanationId = str(sc['explanation_id']);
      if (issueId) s.pendingOffer = { kind: 'issue', id: issueId, label: fix ? str(fix['label']) : null };
      else if (verdict && verdict['fix_available'] === true && explanationId)
        s.pendingOffer = { kind: 'explanation', id: explanationId, label: str(verdict['label']) };
      else s.pendingOffer = null;
      return s;
    }
    case 'home_checkup':
      s.pendingQuestion = null;
      s.pendingPlan = null;
      s.pendingOffer = null;
      s.findings = readFindings(sc);
      return s;
    case 'repair_plan': {
      const planId = str(sc['plan_id']);
      const token = str(sc['confirm_token']);
      s.pendingQuestion = null;
      s.pendingOffer = null;
      const subject = planSubject(state, outcome.arguments);
      s.pendingPlan =
        planId && token && sc['status'] === 'needs_confirmation'
          ? { plan_id: planId, confirm_token: token, expires_at: str(sc['expires_at']), diff_lines: strList(sc['diff_lines']), ...(subject ? { subject } : {}) }
          : null;
      return s;
    }
    case 'repair_apply': {
      const repairId = str(sc['repair_id']);
      const plan = state.pendingPlan && state.pendingPlan.plan_id === str(sc['plan_id']) ? state.pendingPlan : null;
      if (repairId) s.repairs = rememberRepair(state.repairs ?? [], repairId, plan, sc);
      s.pendingPlan = null;
      s.pendingOffer = null;
      return s;
    }
    case 'switch_device': {
      const switched = isObj(sc['switched']) ? sc['switched'] : null;
      s.lastDevice = (switched && str(switched['name'])) ?? str(outcome.arguments?.['device']) ?? s.lastDevice;
      return s;
    }
    case 'protect_device':
      s.lastDevice = str(outcome.arguments?.['device']) ?? s.lastDevice;
      return s;
    case 'repair_status':
    case 'undo':
    case 'refresh_view':
      return s;
  }
}

/** Return a copy with the given pending slots emptied (used when the person says no). */
export function clearPending(
  state: ConversationState,
  slots: ReadonlyArray<'pendingQuestion' | 'pendingOffer' | 'pendingPlan'>,
): ConversationState {
  const s = { ...state };
  for (const slot of slots) s[slot] = null;
  return s;
}
