// The rules every finished diagnosis keeps, shared by the golden house sweep and the property test:
//   * a verdict that names a cause (likely or confirmed) has claims, every cited seq exists, and at least one
//     claim cites a probe or answer of this diagnosis that came out 'fail' (an observed fault)
//   * that cause fits the person's complaint (its symptom weight is at least FIT_MIN)
//   * a likely verdict says its cause out loud, so the voice only path carries the meaning
//   * can't tell offers no fix, and its only possible claim is that the device works right now (or, for an
//     automation, that every device it uses still exists)
//   * can't tell never shows or says a cause a sensor reading ruled out (a probe that tests it came out
//     clean), or one that cannot cause the complaint, and says no cause that holds less than
//     NAME_FLOOR of the posterior
//   * a named cause that is not the top single fault cause was found after setting aside a fault that cannot
//     cause the complaint, and the speech says what was set aside
//   * a battery device is never asked about a wall switch or a plug
//   * a fix is offered only when planRepair really builds a plan (no "Want me to fix that?" followed by
//     "I can't fix that one by myself.")

import { ToolOutputs, type DiagnoseOutput, type DiagnosisCauseId, type HouseEvent } from '@fixwright/protocol';
import {
  BATTERY_SPOKEN,
  CAUSE_SPOKEN,
  causeDef,
  FIT_MIN,
  isEngineError,
  NAME_FLOOR,
  planRepair,
  PROBE_BY_ID,
  row,
  RULED_OUT_LIKELIHOOD,
  type DiagnosisSession,
  type EngineDeps,
} from '../../src/index.ts';

export interface VerdictStats {
  likely: number;
  confirmed: number;
  cantTell: number;
  /** Can't tell verdicts that say the device worked when tested. */
  worksNow: number;
  /** Fixes offered, each one planned for real. */
  fixesPlanned: number;
  /** Can't tell verdicts that set aside a real fault because it cannot cause the complaint. */
  unfit: number;
  /** Likely or confirmed verdicts for a second fault, found after setting aside one that cannot cause the complaint. */
  secondFault: number;
  /** Diagnoses that read a battery level. */
  battery: number;
}

export const emptyStats = (): VerdictStats => ({ likely: 0, confirmed: 0, cantTell: 0, worksNow: 0, fixesPlanned: 0, unfit: 0, secondFault: 0, battery: 0 });

/**
 * The probes that test each cause (written out here on their own, from what each probe checks, so the
 * invariant is not the engine's code read back): the old copy and name scans, the device's availability,
 * battery and wall switch, the link, the hub, the vendor cloud, the account link, the power on setting,
 * the automation's references, and the other Wi-Fi devices and the router.
 */
const TESTED_BY: Readonly<Record<DiagnosisCauseId, readonly string[]>> = {
  stale_duplicate: ['duplicate_name_scan'],
  name_collision: ['duplicate_name_scan'],
  device_power_lost: ['entity_availability', 'battery_level', 'power_switch_check'],
  radio_link_weak: ['link_quality'],
  hub_down: ['hub_reachable'],
  vendor_cloud_outage: ['cloud_status'],
  account_link_expired: ['integration_state'],
  power_on_default_on: ['power_on_setting'],
  dead_trigger: ['registry_scan'],
  wifi_network_changed: ['wifi_peers', 'router_changed'],
};

/** The latest reading of each probe that tests the cause. */
function ownReadings(session: DiagnosisSession, c: string): DiagnosisSession['observations'] {
  return (TESTED_BY[c as DiagnosisCauseId] ?? []).flatMap((id) => {
    const o = [...session.observations].reverse().find((x) => x.probe_id === id && x.value !== null);
    return o ? [o] : [];
  });
}

/**
 * Causes a sensor probe that tests them came out clean on, at a reading all but impossible under them,
 * with none of their own probes failing (a failed reading, or another probe's reading, never
 * rules a cause out, since a house can have two faults).
 */
function ruledOut(session: DiagnosisSession): Set<string> {
  const out = new Set<string>();
  for (const c of session.causes) {
    if (c === 'unknown') continue;
    const own = ownReadings(session, c);
    if (own.some((o) => o.outcome === 'fail')) continue;
    const clean = own.some((o) => {
      const def = PROBE_BY_ID.get(o.probe_id);
      return def !== undefined && def.kind !== 'human' && o.value !== null && def.outcome[o.value] === 'pass' && (row(def.table, c)[o.value] ?? 1) <= RULED_OUT_LIKELIHOOD;
    });
    if (clean) out.add(c);
  }
  return out;
}

/** Returns what is wrong with a finished diagnosis (empty when every rule holds) and counts what it saw. */
export async function verdictProblems(
  output: DiagnoseOutput,
  session: DiagnosisSession,
  ledger: readonly HouseEvent[],
  deps: EngineDeps,
  stats: VerdictStats = emptyStats(),
): Promise<string[]> {
  const v = output.verdict;
  if (output.status !== 'ok' || !v) return [];
  const problems: string[] = [];
  const bySeq = new Map(ledger.map((e) => [e.seq, e]));
  for (const c of v.claims) {
    for (const seq of c.evidence) if (!bySeq.has(seq)) problems.push(`claim "${c.text}" cites missing seq ${seq}`);
  }
  const ownFault = (seq: number): boolean => {
    const e = bySeq.get(seq);
    return e?.data?.['diagnosis_id'] === session.diagnosis_id && e.data['outcome'] === 'fail';
  };
  const battery = session.observations.some((o) => o.probe_id === 'battery_level');
  if (battery) {
    stats.battery++;
    if (session.observations.some((o) => o.probe_id === 'power_switch_check')) problems.push('a battery device was asked about its wall switch');
  }
  if (v.level === 'cant_tell') {
    stats.cantTell++;
    if (v.fix_available) problems.push("can't tell offers a fix");
    if (v.claims.length > 1) problems.push(`can't tell carries ${v.claims.length} claims`);
    if (v.claims.some((c) => c.evidence.some(ownFault))) problems.push("can't tell cites a fault it did not name");
    if (v.claims.length === 1 && /just now\.$/.test(v.claims[0]?.text ?? '')) stats.worksNow++;
    if (/I did find /.test(output.speech)) stats.unfit++;
    const ruled = ruledOut(session);
    if (ruled.has(v.cause_id)) problems.push(`can't tell shows ${v.cause_id}, which a sensor ruled out`);
    const weight = v.cause_id === 'unknown' ? 1 : causeDef(v.cause_id as DiagnosisCauseId).symptom[session.symptom_class];
    if (!(weight >= FIT_MIN)) problems.push(`can't tell shows ${v.cause_id}, which cannot cause a ${session.symptom_class} complaint`);
    const likelyLine = /It's most likely ([^.]*)\./.exec(output.speech)?.[1] ?? '';
    for (const c of ruled) {
      const spoken = CAUSE_SPOKEN[c];
      if (spoken && likelyLine.includes(spoken)) problems.push(`can't tell names ${c}, which a sensor ruled out`);
    }
    for (const [c, p] of Object.entries(session.posterior)) {
      const spoken = CAUSE_SPOKEN[c];
      if (p < NAME_FLOOR && spoken && likelyLine.includes(spoken)) problems.push(`can't tell names ${c} at p ${p.toFixed(3)}`);
    }
  } else {
    if (v.level === 'likely') stats.likely++;
    else stats.confirmed++;
    if (v.claims.length === 0) problems.push(`${v.level} ${v.cause_id} has no claims`);
    if (!v.claims.some((c) => c.evidence.some(ownFault))) problems.push(`${v.level} ${v.cause_id} cites no observed fault`);
    const weight = causeDef(v.cause_id as DiagnosisCauseId).symptom[session.symptom_class];
    if (!(weight >= FIT_MIN)) problems.push(`${v.cause_id} does not fit a ${session.symptom_class} complaint (weight ${weight})`);
    const spoken = CAUSE_SPOKEN[v.cause_id] ?? '';
    const said = output.speech.includes(spoken) || (v.cause_id === 'device_power_lost' && battery && output.speech.includes(BATTERY_SPOKEN));
    if (v.level === 'likely' && !said) problems.push(`likely ${v.cause_id} never says "${spoken}"`);
    const top = Object.entries(session.posterior).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (top !== v.cause_id && !/I also found /.test(output.speech)) problems.push(`${v.level} ${v.cause_id} is not the top cause ${top}, and nothing was set aside`);
    if (top !== v.cause_id) {
      stats.secondFault++;
      // A second fault is named only on a failed reading of a probe that tests it.
      if (!ownReadings(session, v.cause_id).some((o) => o.outcome === 'fail')) problems.push(`second fault ${v.cause_id} is named without a failed reading of its own`);
    }
  }
  if (v.fix_available) {
    try {
      const plan = await planRepair({ kind: 'diagnosis', session }, deps);
      const parsed = ToolOutputs.repair_plan.safeParse(plan.output);
      if (!parsed.success) problems.push(`repair_plan output invalid: ${JSON.stringify(parsed.error.issues)}`);
      stats.fixesPlanned++;
    } catch (err) {
      problems.push(`fix offered for ${v.cause_id} but planRepair failed: ${isEngineError(err) ? err.code : String(err)}`);
    }
  }
  return problems;
}
