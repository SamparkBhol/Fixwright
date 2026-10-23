// Kill switch: if B1 or B2 matches Fixwright on false_confirmed and top1, the headline moves
// from "Fixwright diagnoses better than an LLM" to the human-as-sensor and verified-repair loop.
// "Matches" is read the way the intervals allow: a baseline matches on a metric when its 95% Wilson
// interval overlaps Fixwright's, or when it is at least as good. Overlap is the lenient reading: it
// fires whenever the data cannot tell the two apart, so a fired switch never rests on luck in
// Fixwright's favour. Both agents are compared on exactly the same scenarios (paired), and an exact
// McNemar test on those pairs is reported alongside as a second opinion.

import { computeMetrics, type CaseRow } from './metrics.ts';
import { mcnemarExact, overlaps, type Rate } from './stats.ts';

/** Below this many paired scenarios the intervals are too wide for the evaluation to mean much. */
export const MIN_CONCLUSIVE_N = 30;

export const KILL_SWITCH_RULE =
  'A baseline matches Fixwright on a metric when its 95% Wilson interval overlaps Fixwright\'s on the same scenarios, or when it is at least as good. The kill switch fires if B1 or B2 matches on both top1 and the false_confirmed rate.';

export interface MetricMatch {
  fixwright: Rate;
  baseline: Rate;
  match: boolean;
  /** Paired discordance: b = only Fixwright has it, c = only the baseline has it. */
  paired: { b: number; c: number; p_mcnemar: number };
}

export interface Comparison {
  baseline: 'b1' | 'b2';
  n: number;
  conclusive: boolean;
  top1: MetricMatch;
  false_confirmed: MetricMatch;
  matches: boolean;
}

export interface KillSwitch {
  rule: string;
  evaluated: boolean;
  /** Every comparison has at least MIN_CONCLUSIVE_N paired scenarios. */
  conclusive: boolean;
  /** The verdict: null when not evaluated or not conclusive, so a small run never reads as a fired switch. */
  fires: boolean | null;
  /** The rule applied regardless of sample size (null when not evaluated). For reading small runs only. */
  provisional_fires: boolean | null;
  comparisons: Comparison[];
  note: string;
}

function matchHigher(fw: Rate, bl: Rate): boolean {
  if (fw.value === null || bl.value === null || !fw.ci95 || !bl.ci95) return false;
  return bl.value >= fw.value || overlaps(fw.ci95, bl.ci95);
}

function matchLower(fw: Rate, bl: Rate): boolean {
  if (fw.value === null || bl.value === null || !fw.ci95 || !bl.ci95) return false;
  return bl.value <= fw.value || overlaps(fw.ci95, bl.ci95);
}

function discordance(fw: Map<string, CaseRow>, bl: readonly CaseRow[], has: (r: CaseRow) => boolean): MetricMatch['paired'] {
  let b = 0;
  let c = 0;
  for (const row of bl) {
    const other = fw.get(row.scenario_id);
    if (!other) continue;
    if (has(other) && !has(row)) b++;
    if (!has(other) && has(row)) c++;
  }
  return { b, c, p_mcnemar: mcnemarExact(b, c) };
}

/** Compares one baseline with Fixwright on the scenarios both ran. */
export function compare(fixwrightRows: readonly CaseRow[], baselineRows: readonly CaseRow[], baseline: 'b1' | 'b2'): Comparison {
  const fwById = new Map(fixwrightRows.map((r) => [r.scenario_id, r]));
  const paired = baselineRows.filter((r) => fwById.has(r.scenario_id));
  const fwPaired = paired.map((r) => fwById.get(r.scenario_id) as CaseRow);
  const fw = computeMetrics(fwPaired);
  const bl = computeMetrics(paired);
  const top1: MetricMatch = {
    fixwright: fw.top1,
    baseline: bl.top1,
    match: matchHigher(fw.top1, bl.top1),
    paired: discordance(fwById, paired, (r) => r.correct),
  };
  const falseConfirmed: MetricMatch = {
    fixwright: fw.false_confirmed.rate,
    baseline: bl.false_confirmed.rate,
    match: matchLower(fw.false_confirmed.rate, bl.false_confirmed.rate),
    paired: discordance(fwById, paired, (r) => r.false_confirmed),
  };
  return {
    baseline,
    n: paired.length,
    conclusive: paired.length >= MIN_CONCLUSIVE_N,
    top1,
    false_confirmed: falseConfirmed,
    matches: top1.match && falseConfirmed.match,
  };
}

export function evaluateKillSwitch(rows: readonly CaseRow[]): KillSwitch {
  const fw = rows.filter((r) => r.agent === 'fixwright');
  const comparisons: Comparison[] = [];
  for (const baseline of ['b1', 'b2'] as const) {
    const bl = rows.filter((r) => r.agent === baseline);
    if (bl.length > 0 && fw.length > 0) comparisons.push(compare(fw, bl, baseline));
  }
  if (comparisons.length === 0) {
    return { rule: KILL_SWITCH_RULE, evaluated: false, conclusive: false, fires: null, provisional_fires: null, comparisons, note: 'Not evaluated: this run has no baseline (B1 or B2) next to Fixwright.' };
  }
  const fires = comparisons.some((c) => c.matches);
  const smallest = Math.min(...comparisons.map((c) => c.n));
  const note =
    smallest < MIN_CONCLUSIVE_N
      ? `Not conclusive: only ${smallest} paired scenarios (at least ${MIN_CONCLUSIVE_N} needed), so the intervals are too wide to tell the agents apart. This run checks the pipeline, not the headline.`
      : fires
        ? 'Fires: a baseline cannot be told apart from Fixwright on both top1 and false confirmations. Move the headline to the human-as-sensor and verified-repair loop.'
        : 'Does not fire: neither baseline matches Fixwright on both top1 and false confirmations.';
  const conclusive = smallest >= MIN_CONCLUSIVE_N;
  return { rule: KILL_SWITCH_RULE, evaluated: true, conclusive, fires: conclusive ? fires : null, provisional_fires: fires, comparisons, note };
}
