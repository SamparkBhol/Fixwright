import type { DiagnoseOutput, ExplainEventOutput, RepairPlanOutput, RepairStep, Verdict } from '@fixwright/protocol';
import { hubOf } from './components.ts';
import { NO_HINTS, type StepHints } from './context.ts';
import { capitalize, clockTime, when } from './format.ts';
import type { RepairPayload, ViewPayload } from './payload.ts';
import type { ActionVM, BarVM, BlockVM, ChipVM, ClaimVM, DecisionVM, PanelVM, ProbeVM, StepVM, TimeContext, Tone } from './vm.ts';

export const MAX_INLINE_PROBES = 8;

export const VERDICT_CHIPS: Record<Verdict['level'], ChipVM> = {
  confirmed: { label: 'Confirmed', tone: 'pass', icon: 'check' },
  likely: { label: 'Likely', tone: 'warn', icon: 'half' },
  cant_tell: { label: "Can't tell", tone: 'neutral', icon: 'question' },
};

const LEAD_TONE: Record<Verdict['level'], Tone> = { confirmed: 'pass', likely: 'warn', cant_tell: 'neutral' };
// The header chip already says Likely or Can't tell, and a can't tell claim names what would settle it.
const VERDICT_LEAD: Record<Verdict['level'], string | null> = { confirmed: 'What I found', likely: null, cant_tell: null };

function verdictLead(level: Verdict['level']): { lead?: string } {
  const lead = VERDICT_LEAD[level];
  return lead ? { lead } : {};
}

export const REPAIR_CHIPS: Record<RepairPayload['state'], ChipVM> = {
  applied: { label: 'Fixed', tone: 'pass', icon: 'check' },
  confirmed: { label: 'Confirmed', tone: 'pass', icon: 'check' },
  rolled_back: { label: 'Put back', tone: 'warn', icon: 'undo' },
  failed: { label: 'Not fixed', tone: 'fail', icon: 'cross' },
  regressed: { label: 'Acting up again', tone: 'fail', icon: 'alert' },
  undone: { label: 'Undone', tone: 'info', icon: 'undo' },
};

// Repair outputs do not name their device, so a lone repair card is titled by its outcome.
export const REPAIR_TITLES: Record<RepairPayload['state'], string> = {
  applied: 'Fixed and checked',
  confirmed: 'Repair confirmed',
  rolled_back: 'Put back the way it was',
  failed: "Couldn't finish the fix",
  regressed: "It's acting up again",
  undone: 'Back as it was',
};

// In a flow the title names the device, so the chip states the outcome. On its own card the title states
// the outcome, so the chip carries the evidence.
export function repairChip(r: RepairPayload, hasSubject: boolean): ChipVM {
  if (hasSubject) return REPAIR_CHIPS[r.state];
  const done = r.steps.filter((s) => s.status === 'done').length;
  const skipped = r.steps.filter((s) => s.status === 'skipped').length;
  const all = r.steps.length > 0 && done === r.steps.length;
  // A retry finds some steps already in place: never claim more than was read back.
  const doneOrSkipped = done > 0 && skipped > 0 && done + skipped === r.steps.length;
  switch (r.state) {
    case 'applied':
      if (all) return { label: `${done} of ${r.steps.length} read back`, tone: 'pass', icon: 'check' };
      return doneOrSkipped ? { label: `${done} read back, ${skipped} skipped`, tone: 'pass', icon: 'check' } : REPAIR_CHIPS.applied;
    case 'confirmed':
      return { label: 'Check passed', tone: 'pass', icon: 'check' };
    case 'regressed':
      return { label: 'Check failed', tone: 'fail', icon: 'alert' };
    case 'rolled_back':
      return { label: 'Rolled back', tone: 'warn', icon: 'undo' };
    case 'undone':
      return all ? { label: `${done} of ${r.steps.length} reversed`, tone: 'info', icon: 'undo' } : REPAIR_CHIPS.undone;
    default:
      return REPAIR_CHIPS[r.state];
  }
}

const STEP_TEXT: Record<RepairStep['status'], string> = {
  pending: 'to do',
  done: 'done',
  rolled_back: 'put back',
  skipped: 'skipped',
  failed: 'failed',
};

const PROBE_TEXT: Record<ProbeVM['outcome'], string> = { pass: 'passed', fail: 'found a problem', unknown: 'no answer yet' };

const HUMAN_PROBES = new Set(['confirm_flash', 'power_switch_check', 'router_changed']);

function claims(list: { text: string; evidence: number[] }[]): ClaimVM[] {
  return list.map((c, i) => ({ key: `claim-${i}`, text: c.text, evidence: c.evidence.length }));
}

function claimText(v: Verdict): string {
  return v.claims.map((c) => c.text.trim()).filter(Boolean).join(' ');
}

function probesBlock(d: DiagnoseOutput, heading: string): Extract<BlockVM, { type: 'probes' }> {
  return {
    type: 'probes',
    heading,
    items: d.probes.map((p, i) => ({
      key: `${p.probe_id}-${i}`,
      label: p.label,
      outcome: p.outcome,
      outcomeText: PROBE_TEXT[p.outcome],
      detail: p.detail,
      evidence: p.evidence.length,
      human: HUMAN_PROBES.has(p.probe_id),
    })),
  };
}

/** The 'unknown' cause plus whatever the list leaves out. */
export const RESIDUAL_KEY = 'something_else';
export const RESIDUAL_LABEL = 'Something else';

/** Whole percents that add up to exactly 100 (largest remainder; ties go to the earlier share). */
export function apportion(hypotheses: readonly { cause_id: string; p: number }[]): { key: string; pct: number }[] {
  if (hypotheses.length === 0) return [];
  const named = hypotheses.filter((h) => h.cause_id !== 'unknown').map((h) => ({ key: h.cause_id, p: Number.isFinite(h.p) ? Math.min(1, Math.max(0, h.p)) : 0 }));
  const total = named.reduce((sum, h) => sum + h.p, 0);
  const scale = total > 1 ? 1 / total : 1;
  const shares = [...named.map((h) => ({ key: h.key, x: h.p * scale * 100 })), { key: RESIDUAL_KEY, x: Math.max(0, 100 - total * scale * 100) }];
  const floors = shares.map((s) => Math.floor(s.x + 1e-9));
  let left = 100 - floors.reduce((sum, f) => sum + f, 0);
  const order = shares.map((s, i) => ({ i, r: s.x - (floors[i] ?? 0) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left--;
  }
  return shares.map((s, i) => ({ key: s.key, pct: floors[i] ?? 0 }));
}

/** As many bars as the inline layout holds. */
export const MAX_BARS = 3;

export function barShares(hypotheses: readonly { cause_id: string; p: number }[], max = MAX_BARS): { key: string; pct: number }[] {
  const all = apportion(hypotheses);
  if (all.filter((b, i) => i === 0 || b.pct > 0).length <= max) return all;
  const named = hypotheses.filter((h) => h.cause_id !== 'unknown');
  const keep = new Set([...named].sort((a, b) => b.p - a.p).slice(0, Math.max(1, max - 1)));
  return apportion(named.filter((h) => keep.has(h)));
}

const DEVICE_NOUNS = new Set(['plug', 'lamp', 'light', 'bulb', 'fan', 'heater', 'strip', 'outlet', 'socket', 'switch', 'sensor', 'lock', 'thermostat', 'pendant', 'backlight', 'kettle', 'camera', 'speaker', 'tv', 'blind', 'shade', 'charger']);

const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (/(?:ch|sh)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));

export function focusRanker(focus: string | null): ((label: string) => number) | null {
  if (!focus) return null;
  const fw = wordsOf(focus);
  const kinds = new Set(fw.filter((w) => DEVICE_NOUNS.has(w)));
  if (kinds.size === 0) return null;
  const names = fw.flatMap((w, i) => (i > 0 && kinds.has(w) && !DEVICE_NOUNS.has(fw[i - 1] ?? '') ? [` ${fw[i - 1]} ${w} `] : []));
  return (label) => {
    const lw = wordsOf(label);
    const joined = ` ${lw.join(' ')} `;
    if (names.some((n) => joined.includes(n))) return 0;
    return lw.some((w) => kinds.has(w)) ? 1 : 2;
  };
}

// Once nothing is pending or failed, step order no longer shows progress, so the named devices come first.
export function stepsBlock(steps: RepairStep[], heading: string, opts: { planId?: string; hints?: StepHints } = {}): Extract<BlockVM, { type: 'steps' }> {
  const hints = opts.hints ?? NO_HINTS;
  const seen = new Map<string, number>();
  const items = [...steps]
    .sort((a, b) => a.step - b.step)
    .map<StepVM>((s) => {
      const nth = seen.get(s.label) ?? 0;
      seen.set(s.label, nth + 1);
      const clearer = opts.planId ? hints.labels[`${opts.planId}|${s.label}`]?.[nth] : undefined;
      return {
        key: `step-${s.step}`,
        n: s.step,
        label: clearer ?? s.label,
        status: s.status,
        statusText: STEP_TEXT[s.status],
        ...(s.read_back ? { readBack: s.read_back } : {}),
      };
    });
  const rank = focusRanker(hints.focus);
  const finished = steps.every((s) => s.status !== 'pending' && s.status !== 'failed');
  if (rank && finished) {
    const ranks = new Map(items.map((it) => [it.key, rank(it.label)]));
    items.sort((a, b) => (ranks.get(a.key) ?? 2) - (ranks.get(b.key) ?? 2) || a.n - b.n);
  }
  return { type: 'steps', heading, items };
}

export interface PanelExtras {
  /** The host takes ui/message, so a next step the conversation owns can be offered. */
  canAsk?: boolean;
  hubLabel?: string | null;
}

function theName(name: string): string {
  return /^(?:the|my|our|your)\s/i.test(name) ? name : `the ${name}`;
}

export function diagnosisPanel(d: DiagnoseOutput, extras: PanelExtras = {}): PanelVM {
  const verdict = d.verdict;
  const question = d.status === 'needs_answer' ? d.question : undefined;
  const leadTone: Tone = verdict ? LEAD_TONE[verdict.level] : 'info';
  const strip = probesBlock(d, 'What I checked');
  const pcts = barShares(d.hypotheses);
  const labels = new Map<string, string>(d.hypotheses.map((h) => [h.cause_id, h.label]));
  const bars: BlockVM = {
    type: 'bars',
    heading: verdict ? 'Causes' : 'Most likely',
    items: pcts
      .map((b, i) => {
        const residual = b.key === RESIDUAL_KEY;
        const lead = i === 0;
        return { key: b.key, label: residual ? RESIDUAL_LABEL : (labels.get(b.key) ?? b.key), pct: b.pct, lead, tone: lead ? leadTone : 'neutral' } satisfies BarVM;
      })
      // A 0% share is an empty track, noise at a glance; the leader always stays.
      .filter((b) => b.lead || b.pct > 0),
  };

  let chip: ChipVM;
  let decision: DecisionVM;
  if (question) {
    chip = { label: 'Needs you', tone: 'info', icon: 'ask' };
    const answer = (value: string, label: string, style: ActionVM['style']): ActionVM => ({
      id: `answer-${value}`,
      label,
      pendingLabel: 'Checking',
      style,
      tool: { name: 'diagnose_answer', arguments: { diagnosis_id: d.diagnosis_id, question_id: question.question_id, answer: value } },
    });
    const actions =
      question.expects === 'choice' && question.choices?.length
        ? question.choices.slice(0, 3).map((c, i) => answer(c, c, i === 0 ? 'primary' : 'secondary'))
        : [answer('yes', 'Yes', 'primary'), answer('no', 'No', 'secondary')];
    decision = {
      icon: 'ask',
      tone: 'info',
      emphasis: 'hero',
      text: question.text,
      ...(question.action_performed ? { note: `${question.action_performed}.` } : {}),
      actions,
    };
  } else if (verdict) {
    chip = VERDICT_CHIPS[verdict.level];
    const actions: ActionVM[] = verdict.fix_available
      ? [{ id: 'plan', label: 'Show the fix', pendingLabel: 'Planning', style: 'primary', tool: { name: 'repair_plan', arguments: { diagnosis_id: d.diagnosis_id } } }]
      : [];
    // Can't tell is never a dead end (guide: end to end task completion).
    if (verdict.level === 'cant_tell' && !verdict.fix_available && extras.canAsk) {
      actions.push({ id: 'check-again', label: 'Check again', pendingLabel: 'Checking', style: 'primary', ask: `Check ${theName(d.target.name)} again.` });
    }
    decision = {
      icon: verdict.level === 'confirmed' ? 'check' : verdict.level === 'likely' ? 'half' : 'question',
      tone: LEAD_TONE[verdict.level],
      ...verdictLead(verdict.level),
      text: claimText(verdict) || d.speech,
      actions,
    };
  } else {
    chip = { label: 'Checking', tone: 'neutral', icon: 'clock' };
    decision = { icon: 'info', tone: 'neutral', text: d.speech, actions: [] };
  }

  const details: BlockVM[] = [];
  if (verdict?.claims.length) details.push({ type: 'claims', heading: 'Why I think so', items: claims(verdict.claims) });
  return {
    screen: 'diagnosis',
    eyebrow: d.target.guided ? 'Guided check' : 'Diagnosis',
    title: d.target.name,
    chip,
    simulated: d.source.simulated,
    hub: hubOf(d.source, extras.hubLabel),
    strip,
    main: [bars],
    details,
    decision,
  };
}

export function explanationPanel(e: ExplainEventOutput, t: TimeContext, extras: PanelExtras = {}): PanelVM {
  const v = e.verdict;
  const timeline: BlockVM = {
    type: 'timeline',
    heading: 'What the logs show',
    items: e.timeline.map((x, i) => ({ key: `t-${i}`, time: clockTime(x.ts, t, true), label: x.label, evidence: x.evidence.length })),
  };
  const fix = e.suggested_fix;
  // repair_plan takes exactly one id; the explanation id needs no lookup of the owning session.
  const decision: DecisionVM = fix
    ? {
        icon: 'wrench',
        tone: 'info',
        lead: 'I can fix this',
        text: `${fix.label}.`,
        actions: [{ id: 'plan', label: 'Show the fix', pendingLabel: 'Planning', style: 'primary', tool: { name: 'repair_plan', arguments: { explanation_id: e.explanation_id } } }],
      }
    : { icon: v.level === 'confirmed' ? 'check' : 'info', tone: LEAD_TONE[v.level], ...verdictLead(v.level), text: claimText(v) || e.speech, actions: [] };
  return {
    screen: 'explanation',
    eyebrow: 'What happened',
    title: v.label,
    chip: VERDICT_CHIPS[v.level],
    simulated: e.source.simulated,
    hub: hubOf(e.source, extras.hubLabel),
    main: [timeline],
    details: v.claims.length ? [{ type: 'claims', heading: 'Why I think so', items: claims(v.claims) }] : [],
    decision,
  };
}

export function planPanel(p: RepairPlanOutput, t: TimeContext, opts: { subject?: string; canCancel: boolean; backLabel?: string; hints?: StepHints }): PanelVM {
  const expires = clockTime(p.expires_at, t);
  const actions: ActionVM[] = [
    { id: 'apply', label: 'Fix it', pendingLabel: 'Fixing', style: 'primary', tool: { name: 'repair_apply', arguments: { plan_id: p.plan_id, confirm_token: p.confirm_token } } },
  ];
  if (opts.canCancel) actions.push({ id: 'cancel', label: opts.backLabel ?? 'Not now', pendingLabel: opts.backLabel ?? 'Not now', style: 'secondary', local: 'cancel' });
  return {
    screen: 'plan',
    eyebrow: 'Repair plan',
    title: opts.subject ?? 'Ready to fix',
    chip: { label: 'Nothing changed yet', tone: 'info', icon: 'shield' },
    simulated: p.source.simulated,
    hub: hubOf(p.source, opts.hints?.hubLabel),
    main: [
      { type: 'diff', heading: 'What will change', lines: p.diff_lines, conflicts: p.protected_conflicts },
      stepsBlock(p.steps, 'Steps', { planId: p.plan_id, ...(opts.hints ? { hints: opts.hints } : {}) }),
    ],
    details: p.diff.length
      ? [{ type: 'changes', heading: 'Exact changes', rows: p.diff.map((r, i) => ({ key: `d-${i}`, entity: r.entity_id, field: r.field, from: r.from, to: r.to })) }]
      : [],
    decision: {
      icon: 'shield',
      tone: 'info',
      lead: 'Checked as I go',
      text: "I'll read each change back, and put everything back if one doesn't match.",
      ...(expires ? { note: `Good until\u00a0${expires}.` } : {}),
      actions,
    },
  };
}

function repairDecision(r: RepairPayload, t: TimeContext): Omit<DecisionVM, 'actions'> {
  const checks = 'checks' in r ? r.checks : [];
  const last = checks[checks.length - 1];
  switch (r.state) {
    case 'applied': {
      const allDone = r.steps.every((s) => s.status === 'done' || s.status === 'skipped');
      const next = r.next_check_at ? when(r.next_check_at, t.nowMs, t) : '';
      if (next) {
        return { icon: 'clock', tone: 'pass', lead: 'Next check', text: capitalize(next), emphasis: 'hero', note: "I'll look at it again then and let you know how it went." };
      }
      return { icon: 'check', tone: 'pass', lead: allDone ? 'Read back after every step' : 'Applied', text: 'Every step read back the way it should.' };
    }
    case 'confirmed':
      return {
        icon: 'check',
        tone: 'pass',
        lead: last ? 'The fix held' : 'Confirmed',
        text: last?.detail ?? r.speech,
        ...(last ? { note: capitalize(`${when(last.at, t.nowMs, t)}.`) } : {}),
      };
    case 'regressed':
      return {
        icon: 'alert',
        tone: 'fail',
        lead: "The fix didn't hold",
        text: last?.detail ?? r.speech,
        ...(last ? { note: capitalize(`${when(last.at, t.nowMs, t)}.`) } : {}),
      };
    case 'rolled_back':
      return { icon: 'undo', tone: 'warn', lead: 'Nothing changed', text: "One step didn't read back the way it should, so I put everything back." };
    case 'failed':
      return { icon: 'cross', tone: 'fail', lead: "I couldn't finish", text: 'The fix stopped partway. The steps show how far it got.' };
    case 'undone':
      return { icon: 'undo', tone: 'info', lead: 'Undone', text: 'I reversed each step and read it back.' };
  }
}

export function repairPanel(r: RepairPayload, t: TimeContext, opts: { subject?: string; extraActions?: ActionVM[]; hints?: StepHints; canAsk?: boolean } = {}): PanelVM {
  const actions: ActionVM[] = [];
  if (r.state === 'regressed' && opts.canAsk) {
    const words = opts.subject ? `Look at ${theName(opts.subject)} again.` : 'Why is it acting up again?';
    actions.push({ id: 'look-again', label: 'Diagnose', pendingLabel: 'Checking', style: 'primary', ask: words });
  }
  if (r.undo_available) {
    actions.push({ id: 'undo', label: 'Undo', pendingLabel: 'Undoing', style: 'secondary', tool: { name: 'undo', arguments: { repair_id: r.repair_id } } });
  }
  actions.push(...(opts.extraActions ?? []));
  const checks = 'checks' in r ? r.checks : [];
  const heading = r.state === 'undone' ? 'Each step, reversed' : 'Each step, read back';
  return {
    screen: 'repair',
    eyebrow: 'Repair',
    title: opts.subject ?? REPAIR_TITLES[r.state],
    chip: repairChip(r, Boolean(opts.subject)),
    simulated: r.source.simulated,
    hub: hubOf(r.source, opts.hints?.hubLabel),
    main: [stepsBlock(r.steps, heading, { planId: r.plan_id, ...(opts.hints ? { hints: opts.hints } : {}) })],
    details: checks.length
      ? [{ type: 'checks', heading: 'Checks since the fix', items: checks.map((c, i) => ({ key: `c-${i}`, when: capitalize(when(c.at, t.nowMs, t)), result: c.result, detail: c.detail })) }]
      : [],
    decision: { ...repairDecision(r, t), actions },
  };
}

export interface PanelContext {
  subject?: string;
  canCancel: boolean;
  canAsk?: boolean;
  hints?: StepHints;
  backLabel?: string;
  extraActions?: ActionVM[];
}

export function panelFor(p: Exclude<ViewPayload, { kind: 'checkup' }>, t: TimeContext, ctx: PanelContext): PanelVM {
  switch (p.kind) {
    case 'diagnosis':
      return diagnosisPanel(p.data, { canAsk: ctx.canAsk ?? false, hubLabel: ctx.hints?.hubLabel ?? null });
    case 'explanation':
      return explanationPanel(p.data, t, { hubLabel: ctx.hints?.hubLabel ?? null });
    case 'plan':
      return planPanel(p.data, t, ctx);
    case 'repair':
      return repairPanel(p.data, t, ctx);
  }
}
