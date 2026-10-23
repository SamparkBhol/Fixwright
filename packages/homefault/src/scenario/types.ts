// The homefault scenario format (JSON Schema: schema/scenario.schema.json). A scenario is one broken
// home frozen at the moment a person asks for help: the home as an agent can query it, the raw logs it
// can read, what the person said, and, kept apart from the agent, the ground truth and what the person
// would see if asked to look.

import type { LogRow } from '../logrows.ts';
import type { CauseId, CloudStatus, Entity, HubStatus, IntegrationStatus, Iso, Signals } from '../types.ts';

export const SCENARIO_FORMAT = 'homefault.scenario/1';

export type YesNo = 'yes' | 'no';

/** Questions a diagnosing agent may ask the person in the room. */
export const HUMAN_QUESTION_KINDS = ['confirm_flash', 'power_switch_check', 'router_changed'] as const;
export type HumanQuestionKind = (typeof HUMAN_QUESTION_KINDS)[number];

/**
 * What the person would answer if asked. confirm_flash: "I'll flash the lamp twice. Did it blink?",
 * power_switch_check: "Is its wall switch on and is it plugged in?", router_changed: "Did your Wi-Fi
 * router or its name change recently?". Unset means the person would not know.
 */
export type HumanTruth = Partial<Record<HumanQuestionKind, YesNo>> & { notes?: string };

export interface ScenarioSource {
  /** Where the report is public. Generated scenarios use a homefault:// url. */
  url: string;
  /** YYYY-MM-DD the report was published. */
  date: string;
  /** Short verbatim quote from the report, never paraphrased. */
  quote?: string;
  publisher?: string;
  note?: string;
}

/** The home as an adapter would report it at `now`. */
export interface ScenarioHome {
  entities: Entity[];
  integrations: IntegrationStatus[];
  hub: HubStatus;
  cloud: CloudStatus[];
  /** Link and battery signals per entity. flaps24h is left out: count it from the events. */
  signals: Record<string, Signals>;
}

export interface GroundTruth {
  cause_id: CauseId;
  /** The entities a correct diagnosis is about. */
  entity_ids: string[];
  /** One plain sentence: what really happened. */
  explanation?: string;
}

export interface Scenario {
  $schema?: string;
  format: typeof SCENARIO_FORMAT;
  id: string;
  title: string;
  /** incident: reconstructed from a public report. generated: from the event-level generator. twin: exported from SimHome. */
  kind: 'incident' | 'generated' | 'twin';
  source: ScenarioSource;
  reconstructed: boolean;
  /** Everything the author had to assume to turn a report into logs. Required when reconstructed. */
  assumptions: string[];
  tz: string;
  /** The moment the person asks. */
  now: Iso;
  symptom: { text: string; device?: string };
  home: ScenarioHome;
  events: LogRow[];
  ground_truth: GroundTruth;
  human_truth: HumanTruth;
  noise: { jitter_ms: number; drop_rate: number };
  tags?: string[];
}

/** What an agent under test sees: no title, source, ground truth or human truth. */
export interface ScenarioView {
  id: string;
  tz: string;
  now: Iso;
  symptom: { text: string; device?: string };
  home: ScenarioHome;
  events: LogRow[];
}

export function toView(s: Scenario): ScenarioView {
  const symptom: ScenarioView['symptom'] = { text: s.symptom.text };
  if (s.symptom.device !== undefined) symptom.device = s.symptom.device;
  return {
    id: s.id,
    tz: s.tz,
    now: s.now,
    symptom,
    home: JSON.parse(JSON.stringify(s.home)) as ScenarioHome,
    events: JSON.parse(JSON.stringify(s.events)) as LogRow[],
  };
}
