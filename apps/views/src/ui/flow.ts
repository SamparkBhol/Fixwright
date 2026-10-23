// Pure, so the unit tests can walk the golden path without a browser.
import { DECLINED_NOTE, UNREADABLE_PROBLEM, type ToolOutcome, type ViewPayload } from './payload.ts';
import { barShares } from './screens.ts';
import type { ToolCall } from './vm.ts';

export type PanelPayload = Exclude<ViewPayload, { kind: 'checkup' }>;

export interface Flow {
  screen: PanelPayload;
  /** Where "Not now" goes back to: the verdict a plan came from. */
  back: PanelPayload | null;
  /** The device or finding this flow is about, kept across screens that do not name it. */
  subject?: string;
  pending: string | null;
  error: string | null;
  notice: string | null;
  barsFrom: Record<string, number> | null;
}

export function subjectOf(p: PanelPayload): string | undefined {
  return p.kind === 'diagnosis' ? p.data.target.name : undefined;
}

export function startFlow(screen: PanelPayload, subject?: string): Flow {
  const s = subject ?? subjectOf(screen);
  return { screen, back: null, ...(s ? { subject: s } : {}), pending: null, error: null, notice: null, barsFrom: null };
}

export function beginAction(flow: Flow, actionId: string): Flow {
  return { ...flow, pending: actionId, error: null, notice: null };
}

export function screenKey(p: PanelPayload): string {
  switch (p.kind) {
    case 'diagnosis':
      return `diagnosis:${p.data.diagnosis_id}`;
    case 'explanation':
      return `explanation:${p.data.explanation_id}`;
    case 'plan':
      return `plan:${p.data.plan_id}`;
    case 'repair':
      return `repair:${p.data.repair_id}`;
  }
}

// apps/host resends the latest result, then denies the call, when the person declines.
export function isResend(flow: Flow | null, next: PanelPayload): boolean {
  return Boolean(flow) && flow?.screen.kind === next.kind && JSON.stringify(flow.screen.data) === JSON.stringify(next.data);
}

// A newer version of the showing screen keeps its way back, its subject and moving bars. The caller handles
// exact resends (isResend) first, because those must not cancel an action in flight.
export function fromHost(flow: Flow | null, next: PanelPayload): Flow {
  if (!flow || screenKey(flow.screen) !== screenKey(next)) return startFlow(next);
  const subject = subjectOf(next) ?? flow.subject;
  return {
    screen: next,
    back: flow.back,
    ...(subject ? { subject } : {}),
    pending: null,
    error: null,
    notice: null,
    barsFrom: next.kind === 'diagnosis' ? percents(flow.screen) : null,
  };
}

export function asDeclined(outcome: ToolOutcome): ToolOutcome {
  return outcome.ok ? outcome : { ok: false, problem: { ...outcome.problem, speech: DECLINED_NOTE, declined: true } };
}

function percents(p: PanelPayload): Record<string, number> | null {
  if (p.kind !== 'diagnosis') return null;
  return Object.fromEntries(barShares(p.data.hypotheses).map((b) => [b.key, b.pct]));
}

export function finishAction(flow: Flow, actionId: string, outcome: ToolOutcome, accepts: readonly PanelPayload['kind'][]): Flow {
  if (!outcome.ok) {
    // A declined approval is the person's choice: a calm note, no error.
    return outcome.problem.declined
      ? { ...flow, pending: null, error: null, notice: outcome.problem.speech }
      : { ...flow, pending: null, error: outcome.problem.speech, notice: null };
  }
  const next = outcome.payload;
  if (next.kind === 'checkup' || !accepts.includes(next.kind)) return { ...flow, pending: null, error: UNREADABLE_PROBLEM, notice: null };
  const subject = subjectOf(next) ?? flow.subject;
  return {
    screen: next,
    // A plan can be dismissed back to the screen that offered it; nothing else goes back.
    back: next.kind === 'plan' ? (actionId === 'plan' ? flow.screen : flow.back) : null,
    ...(subject ? { subject } : {}),
    pending: null,
    error: null,
    notice: null,
    barsFrom: next.kind === 'diagnosis' ? percents(flow.screen) : null,
  };
}

export function cancelPlan(flow: Flow): Flow {
  if (!flow.back) return flow;
  return { ...flow, screen: flow.back, back: null, pending: null, error: null, notice: null, barsFrom: null };
}

// refresh_view is app only, so the card can show the morning check in place.
export function dueRefresh(flow: Flow | null, nowMs: number): ToolCall | null {
  const s = flow?.screen;
  if (!s || s.kind !== 'repair' || s.data.state !== 'applied' || !s.data.next_check_at) return null;
  const due = Date.parse(s.data.next_check_at);
  return Number.isFinite(due) && due <= nowMs ? { name: 'refresh_view', arguments: { ref_id: s.data.repair_id } } : null;
}
