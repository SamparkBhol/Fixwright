import type { Finding, HomeCheckupOutput } from '@fixwright/protocol';
import { fromHost, isResend, screenKey, startFlow, type Flow } from './flow.ts';
import { hubOf } from './components.ts';
import { countWord, plural } from './format.ts';
import { isIconName, type IconName } from './icons.ts';
import { UNREADABLE_PROBLEM, type ToolOutcome } from './payload.ts';
import type { ActionVM, CarouselVM, ChipVM, FindingVM, Tone } from './vm.ts';

export const SEVERITY: Record<Finding['severity'], { label: string; tone: Tone; rank: number }> = {
  high: { label: 'Urgent', tone: 'fail', rank: 0 },
  medium: { label: 'Worth a look', tone: 'warn', rank: 1 },
  low: { label: 'Minor', tone: 'info', rank: 2 },
};

/** The design guide asks for 3 to 5 items inline; the protocol caps findings at 5. */
export const MAX_ITEMS = 5;

export interface CarouselMarks {
  fixed?: ReadonlySet<string>;
  asked?: ReadonlySet<string>;
  canAsk?: boolean;
  hubLabel?: string | null;
}

function findingIcon(kind: string): IconName {
  return isIconName(kind) ? kind : 'info';
}

function lowerFirst(s: string): string {
  // "Aquarium filter" reads "the aquarium filter"; an acronym such as "TV stand" keeps its capitals.
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

// The engine labels some findings it cannot change ("Show me how", "Protect it"), which repair_plan cannot
// plan, so the card asks the conversation: apps/host answers with guidance or routes "Protect the ..." to
// protect_device. A finding carries no words of its own to send, so
// they are built from its title.
export function askWords(f: Pick<Finding, 'kind' | 'title' | 'action_label'>): string {
  const title = f.title.trim().replace(/[.!?]+$/, '');
  if (f.kind === 'unprotected_load') {
    const load = /^(.+?) (?:is not|isn't) protected$/i.exec(title)?.[1];
    if (load) return `Protect the ${lowerFirst(load)}.`;
  }
  const lead = /^show me how$/i.test(f.action_label?.trim() ?? '') ? 'Show me how to fix this' : 'Help me fix this';
  return `${lead}. ${title}.`;
}

function findingAction(f: Finding, canAsk: boolean): ActionVM | undefined {
  if (f.fixable) {
    return {
      id: `plan-${f.issue_id}`,
      label: f.action_label ?? 'See the fix',
      pendingLabel: 'Planning',
      style: 'secondary',
      tool: { name: 'repair_plan', arguments: { issue_id: f.issue_id } },
    };
  }
  if (!f.action_label || !canAsk) return undefined;
  return { id: `ask-${f.issue_id}`, label: f.action_label, pendingLabel: 'Asking', style: 'secondary', ask: askWords(f) };
}

export function findingItem(f: Finding, fixed: boolean, opts: { asked?: boolean; canAsk?: boolean } = {}): FindingVM {
  const sev = SEVERITY[f.severity];
  const asked = !fixed && Boolean(opts.asked);
  const action = fixed || asked ? undefined : findingAction(f, opts.canAsk ?? false);
  return {
    key: f.issue_id,
    kind: f.kind,
    icon: findingIcon(f.kind),
    severity: f.severity,
    severityLabel: fixed ? 'Fixed' : sev.label,
    tone: fixed ? 'pass' : sev.tone,
    title: f.title,
    detail: f.detail,
    fixed,
    asked,
    ...(action ? { action } : {}),
  };
}

export function checkupCarousel(c: HomeCheckupOutput, marks: CarouselMarks = {}): CarouselVM {
  const fixed = marks.fixed ?? new Set<string>();
  const asked = marks.asked ?? new Set<string>();
  // Most severe first even if a server forgets to sort (stable for equal severity).
  const findings = [...c.findings].sort((a, b) => SEVERITY[a.severity].rank - SEVERITY[b.severity].rank).slice(0, MAX_ITEMS);
  const open = findings.filter((f) => !fixed.has(f.issue_id));
  const urgent = open.filter((f) => f.severity === 'high').length;
  const n = open.length;
  let chip: ChipVM;
  if (findings.length === 0) chip = { label: 'Healthy', tone: 'pass', icon: 'check' };
  else if (n === 0) chip = { label: 'All handled', tone: 'pass', icon: 'check' };
  else if (urgent > 0) chip = { label: `${urgent} urgent`, tone: 'fail', icon: 'alert' };
  else chip = { label: 'Nothing urgent', tone: 'pass', icon: 'check' };
  return {
    eyebrow: 'Home checkup',
    title: n === 0 ? 'All clear' : `${countWord(n)} ${plural(n, 'thing needs', 'things need')} a look`,
    chip,
    simulated: c.source.simulated,
    hub: hubOf(c.source, marks.hubLabel),
    items: findings.map((f) => findingItem(f, fixed.has(f.issue_id), { asked: asked.has(f.issue_id), canAsk: marks.canAsk ?? false })),
  };
}

export interface OpenFinding {
  issue: string;
  title: string;
  flow: Flow;
}

export interface CarouselState {
  checkup: HomeCheckupOutput | null;
  fixed: ReadonlySet<string>;
  asked: ReadonlySet<string>;
  open: OpenFinding | null;
  message: string | null;
}

export const EMPTY_CAROUSEL: CarouselState = { checkup: null, fixed: new Set(), asked: new Set(), open: null, message: null };

function keepFound(marks: ReadonlySet<string>, c: HomeCheckupOutput): Set<string> {
  return new Set([...marks].filter((id) => c.findings.some((f) => f.issue_id === id)));
}

// resend: apps/host resends the showing screen before it denies a declined approval,
// so the caller treats a failure of the call in flight as that decline.
export function carouselFromHost(s: CarouselState, outcome: ToolOutcome): { state: CarouselState; resend: boolean } {
  if (!outcome.ok) return { state: { ...EMPTY_CAROUSEL, message: outcome.problem.speech }, resend: false };
  const p = outcome.payload;
  if (p.kind === 'checkup') {
    if (s.checkup?.checkup_id !== p.data.checkup_id) return { state: { ...EMPTY_CAROUSEL, checkup: p.data }, resend: false };
    const open = s.open && p.data.findings.some((f) => f.issue_id === s.open?.issue) ? s.open : null;
    return { state: { checkup: p.data, fixed: keepFound(s.fixed, p.data), asked: keepFound(s.asked, p.data), open, message: null }, resend: false };
  }
  if (!s.checkup) return { state: { ...EMPTY_CAROUSEL, message: UNREADABLE_PROBLEM }, resend: false };
  if (p.kind !== 'plan' && p.kind !== 'repair') return { state: s, resend: false };
  if (s.open && isResend(s.open.flow, p)) return { state: s, resend: true };
  const issue = p.data.ids.issue_id;
  const finding = s.checkup.findings.find((f) => f.issue_id === issue);
  if (s.open && (screenKey(s.open.flow.screen) === screenKey(p) || s.open.issue === issue)) {
    return { state: { ...s, open: { ...s.open, flow: fromHost(s.open.flow, p) } }, resend: false };
  }
  if (finding) return { state: { ...s, open: { issue: finding.issue_id, title: finding.title, flow: startFlow(p) } }, resend: false };
  return { state: s, resend: false };
}
