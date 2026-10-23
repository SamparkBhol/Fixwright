// The Fixwright bench agent: the product's own path from what the person said to a verdict, on a
// homefault scenario with scenarioHome(view) as the HomeAdapter. The deterministic assistant router
// (@fixwright/router) picks the tool the way the live product does: a question about something the home
// already did ("Why did every light turn on at 3 a.m.?") goes to explain_event, everything else to the
// diagnose loop (startDiagnosis, then answerDiagnosis for every question it asks). The engine's human
// probes map one to one onto homefault's question kinds; the simulated person answers them. Permission
// questions (a flash during quiet hours) are not facts about the house, so the bench grants them: the
// person asked for help.

import { answerDiagnosis, createMemoryLedger, defaultSettings, explainEvent, startDiagnosis, type DiagnosisSession, type EngineDeps } from '@fixwright/engine';
import { routeUtterance } from '@fixwright/router';
import type { DiagnoseOutput, HomeAdapter, Verdict } from '@fixwright/protocol';
import {
  HUMAN_QUESTION_KINDS,
  rngFor,
  scenarioHome,
  type AgentVerdict,
  type AskHuman,
  type BenchAgent,
  type HumanAnswer,
  type HumanQuestionKind,
  type ScenarioView,
} from 'homefault';

/** Enough for MAX_QUESTIONS (3), each re-asked once, plus a quiet hours permission question. */
export const MAX_TURNS = 10;

/** One question the engine asked and what it was told. */
export interface Exchange {
  /** The engine probe behind the question (confirm_flash, power_switch_check, router_changed), or `<probe>_consent`. */
  probe_id: string;
  kind: 'observe' | 'consent';
  /** The question exactly as the engine spoke it. */
  text: string;
  /** What the person said: the simulated person's answer, or the bench's yes to a permission question. */
  answer: HumanAnswer;
}

/** Everything the bench keeps about one Fixwright diagnosis, beyond the scored verdict. */
export type FixwrightTool = 'diagnose' | 'explain_event';

/** router: the tool the live product would pick (default). diagnose: always the diagnose loop. */
export type FixwrightRouting = 'router' | 'diagnose';

/**
 * explain_event names what happened (its detectors), not a fault from the cause library. A power
 * restore that switched devices on is the power_on_default_on fault, whose fix explain_event suggests;
 * "an automation did it" and "someone used the app" name no fault and are scored as given.
 */
export const EXPLAIN_TO_CAUSE: Readonly<Record<string, string>> = { power_restore: 'power_on_default_on' };

export interface FixwrightRecord {
  scenario_id: string;
  /** The tool that ran: the router's pick, or diagnose when routing is off. */
  tool: FixwrightTool;
  /** explain_event only: the detector's own cause id before mapping (power_restore, user_action, ...). */
  explain_cause?: string;
  verdict: { cause_id: string; level: Verdict['level']; confidence: number; label: string } | null;
  /** Engine error code when the diagnosis stopped with an error (for example ambiguous_device). */
  error_code: string | null;
  target: { entity_id?: string; name: string; guided: boolean } | null;
  /** Sensor and active probes run (human answers excluded), including a repeated flash. */
  probes_used: number;
  /** Probes a person would notice: every flash, first and repeated. */
  disruptive_probes: number;
  /** Every question asked, observations and permission questions, re-asks included. */
  questions: number;
  consent_questions: number;
  probe_ids: string[];
  exchanges: Exchange[];
  /** Top hypotheses when the diagnosis finished. */
  hypotheses: { cause_id: string; p: number }[];
  turns: number;
}

export interface FixwrightAgentOptions {
  /** Seeds the engine's id generator per scenario. Ids never change a verdict. Default 1. */
  seed?: number;
  /** Default 'router'. */
  routing?: FixwrightRouting;
  /** Called once per scenario with the full record. */
  onRecord?: (r: FixwrightRecord) => void;
}

const isHumanKind = (id: string): id is HumanQuestionKind => (HUMAN_QUESTION_KINDS as readonly string[]).includes(id);

/** The engine's deps for one scenario. The clock stands at the scenario's `now`, like a frozen house. */
export function scenarioDeps(view: ScenarioView, seed: number): EngineDeps {
  const nowMs = Date.parse(view.now);
  // homefault declares the same HomeAdapter shape as the protocol (its protocol-compat test proves it).
  const adapter: HomeAdapter = scenarioHome(view);
  return {
    adapter,
    ledger: createMemoryLedger(),
    clock: { now: () => view.now, nowMs: () => nowMs },
    rng: rngFor('fixwright-bench', seed, view.id),
    settings: defaultSettings({ tz: view.tz }),
  };
}

const errorCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'exception';
};

/** The tool the live product would call for this symptom: explain_event when the router says so, else diagnose. */
export function toolFor(symptom: string): FixwrightTool {
  const route = routeUtterance(symptom);
  return 'tool' in route && route.tool === 'explain_event' ? 'explain_event' : 'diagnose';
}

function summarize(view: ScenarioView, session: DiagnosisSession | null, output: DiagnoseOutput | null, exchanges: Exchange[], turns: number, error: string | null): FixwrightRecord {
  const probes = output?.probes ?? session?.probes ?? [];
  const sensorProbes = probes.filter((p) => !isHumanKind(p.probe_id));
  const v = output?.status === 'ok' ? output.verdict : undefined;
  return {
    scenario_id: view.id,
    tool: 'diagnose',
    verdict: v ? { cause_id: v.cause_id, level: v.level, confidence: v.confidence, label: v.label } : null,
    error_code: error,
    target: output ? { ...output.target } : null,
    probes_used: sensorProbes.length,
    disruptive_probes: probes.filter((p) => p.disruptive).length,
    questions: exchanges.length,
    consent_questions: exchanges.filter((e) => e.kind === 'consent').length,
    probe_ids: probes.map((p) => p.probe_id),
    exchanges,
    hypotheses: (output?.hypotheses ?? []).map((h) => ({ cause_id: h.cause_id, p: h.p })),
    turns,
  };
}

/** explain_event on the symptom: a passive read of the logs, no probes and no questions. */
export async function explainScenario(view: ScenarioView, seed = 1): Promise<FixwrightRecord> {
  const base: FixwrightRecord = {
    scenario_id: view.id,
    tool: 'explain_event',
    verdict: null,
    error_code: null,
    target: null,
    probes_used: 0,
    disruptive_probes: 0,
    questions: 0,
    consent_questions: 0,
    probe_ids: [],
    exchanges: [],
    hypotheses: [],
    turns: 0,
  };
  try {
    const { output } = await explainEvent({ question: view.symptom.text }, scenarioDeps(view, seed));
    const v = output.verdict;
    const cause = Object.hasOwn(EXPLAIN_TO_CAUSE, v.cause_id) ? (EXPLAIN_TO_CAUSE[v.cause_id] as string) : v.cause_id;
    return { ...base, explain_cause: v.cause_id, verdict: { cause_id: cause, level: v.level, confidence: v.confidence, label: v.label } };
  } catch (err) {
    return { ...base, error_code: errorCode(err) };
  }
}

/** Runs the tool the router picks for the symptom. Never throws: engine errors come back in `error_code`. */
export async function fixwrightScenario(view: ScenarioView, askHuman: AskHuman, seed = 1, routing: FixwrightRouting = 'router'): Promise<FixwrightRecord> {
  const tool = routing === 'router' ? toolFor(view.symptom.text) : 'diagnose';
  return tool === 'explain_event' ? explainScenario(view, seed) : diagnoseScenario(view, askHuman, seed);
}

/** Runs one diagnosis to its verdict. Never throws: engine errors come back in `error_code`. */
export async function diagnoseScenario(view: ScenarioView, askHuman: AskHuman, seed = 1): Promise<FixwrightRecord> {
  const deps = scenarioDeps(view, seed);
  const exchanges: Exchange[] = [];
  let session: DiagnosisSession | null = null;
  let output: DiagnoseOutput | null = null;
  let turns = 0;
  try {
    const input = { symptom: view.symptom.text, ...(view.symptom.device !== undefined ? { device: view.symptom.device } : {}) };
    ({ session, output } = await startDiagnosis(input, deps));
    while (output.status === 'needs_answer' && output.question && session.pending) {
      if (turns >= MAX_TURNS) return summarize(view, session, output, exchanges, turns, 'too_many_turns');
      turns++;
      const pending = session.pending;
      let answer: HumanAnswer;
      if (pending.kind === 'consent') {
        answer = 'yes';
      } else {
        if (!isHumanKind(pending.probe_id)) return summarize(view, session, output, exchanges, turns, `unmapped_question:${pending.probe_id}`);
        const subject = session.entities.dut ?? session.entities.primary;
        answer = await askHuman({ kind: pending.probe_id, text: output.question.text, ...(subject !== undefined ? { entity_id: subject } : {}) });
      }
      exchanges.push({
        probe_id: pending.kind === 'consent' ? `${pending.probe_id}_consent` : pending.probe_id,
        kind: pending.kind,
        text: output.question.text,
        answer,
      });
      ({ session, output } = await answerDiagnosis(session, { diagnosis_id: session.diagnosis_id, question_id: output.question.question_id, answer }, deps));
    }
    return summarize(view, session, output, exchanges, turns, null);
  } catch (err) {
    return summarize(view, session, output, exchanges, turns, errorCode(err));
  }
}

/** The verdict homefault's runner scores, from a record. An engine error is an abstention. */
export function toAgentVerdict(r: FixwrightRecord): AgentVerdict {
  const base = { probes_used: r.probes_used, disruptive_probes: r.disruptive_probes };
  if (!r.verdict) return { cause_id: r.error_code ?? 'unknown', level: 'cant_tell', ...base };
  return { cause_id: r.verdict.cause_id, level: r.verdict.level, confidence: r.verdict.confidence, ...base };
}

/** A homefault BenchAgent that runs Fixwright: router, then explain_event or the diagnose loop. */
export function fixwrightAgent(opts: FixwrightAgentOptions = {}): BenchAgent {
  const seed = opts.seed ?? 1;
  return {
    name: 'fixwright',
    async diagnose(view, askHuman) {
      const record = await fixwrightScenario(view, askHuman, seed, opts.routing ?? 'router');
      opts.onRecord?.(record);
      return toAgentVerdict(record);
    },
  };
}
