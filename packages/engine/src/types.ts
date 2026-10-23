// Engine types: what the engine needs injected (deps, settings, ledger) and the plain JSON objects it
// hands back for the server to persist (sessions, plans). Everything here is serialisable with JSON.stringify.

import type {
  CauseId,
  DiagnosisCauseId,
  Clock,
  DiagnosisTarget,
  DiffRow,
  EntityId,
  EventKind,
  Finding,
  HomeAdapter,
  HouseEvent,
  Hypothesis,
  Iso,
  ProbeOutcome,
  ProbeResult,
  ProtectedDevice,
  RegistryPatch,
  Rng,
  TimelineEntry,
  Verdict,
} from '@fixwright/protocol';

/** Filters are ANDed. Times are inclusive. Results are in seq order. */
export interface LedgerQuery {
  since?: Iso;
  until?: Iso;
  entityIds?: EntityId[];
  kinds?: EventKind[];
  seqs?: number[];
  source?: 'home' | 'fixwright';
}

/** Append only event log. The server backs it with the HouseholdDO events table. */
export interface Ledger {
  append(e: Omit<HouseEvent, 'seq'>): Promise<number>;
  query(q: LedgerQuery): Promise<HouseEvent[]>;
}

/** Household local clock times, 'HH:MM'. A start after the end spans midnight. */
export interface QuietHours {
  start: string;
  end: string;
}

/**
 * How well this household's answers track reality. positives and negatives are the pseudo counts behind
 * each rate, so later sensor evidence moves them gradually (see updateHumanReliability).
 */
export interface HumanReliability {
  sensitivity: number;
  specificity: number;
  positives?: number;
  negatives?: number;
}

export interface Outlet {
  entity_id: EntityId;
  name: string;
  outlet: number;
  /** What is plugged in, as the person would say it. */
  load: string;
}

export interface PowerStrip {
  entity_id: EntityId;
  name: string;
  outlets: Outlet[];
}

export interface Topology {
  strips: PowerStrip[];
}

export interface EngineSettings {
  /** IANA time zone of the household, e.g. America/Los_Angeles. */
  tz: string;
  quietHours: QuietHours;
  humanReliability: HumanReliability;
  protected: ProtectedDevice[];
  /** Power strip wiring. Inferred from the entity list when left out. */
  topology?: Topology;
  /** Ask with sound ("Did you hear it click?") instead of sight, for people who prefer it. */
  preferNonVisual?: boolean;
}

/** One sentence the engine wants to say, with its evidence. Framing lines carry no facts and no evidence. */
export interface PhraseLine {
  text: string;
  kind: 'fact' | 'framing';
  evidence: number[];
}

/**
 * Optional rephrasing hook (an LLM, for instance). It gets the template lines and returns one sentence per
 * line. Every returned sentence must pass the claim checker against its line, or the template text is used.
 */
export type Phraser = (lines: PhraseLine[]) => Promise<string[]> | string[];

export interface EngineDeps {
  adapter: HomeAdapter;
  ledger: Ledger;
  clock: Clock;
  /** Production must pass a crypto backed Rng: plans draw their confirm token from it. */
  rng: Rng;
  settings: EngineSettings;
  phraser?: Phraser;
}

/** What a claim's evidence has to show for the claim checker to keep it. */
export interface ClaimSupport {
  /** Every cited event must be about one of these entities. */
  entityIds?: EntityId[];
  /** No cited event may be about any of these entities ("The kitchen plug wasn't one of them."). */
  notAbout?: EntityId[];
  /** At least one cited event (or a time it reports) must fall in this window. */
  window?: { since: Iso; until: Iso };
  /** Every cited event must fall in this window (used for "within four seconds"). */
  allWithin?: { since: Iso; until: Iso };
  /** The cited events must cover exactly this many distinct entities. */
  distinctEntities?: number;
  /** Cited probe or answer events must report one of these values. */
  probeValues?: { probe_id: string; values: string[] }[];
  /** Cited events must carry no automation, service or user context. */
  noContext?: boolean;
  /** The ledger must hold no event of these kinds in the window (absence claims). */
  absent?: { kinds: EventKind[]; since: Iso; until: Iso };
}

export interface CheckedClaim {
  text: string;
  evidence: number[];
  kind: 'fact' | 'framing';
  support?: ClaimSupport;
}

export type SymptomClass = 'unresponsive' | 'unexpected_on' | 'wrong_device' | 'automation' | 'unknown';

export type HypothesisId = DiagnosisCauseId | 'unknown';

export interface Observation {
  probe_id: string;
  /** Observed value from the probe's value set; null when the probe could not tell. */
  value: string | null;
  outcome: ProbeOutcome;
  evidence: number[];
  at: Iso;
  /** Set for human probes: what was said and how it was read. */
  answer?: { question_id: string; said: 'yes' | 'no' };
  /** Probe specific facts (plain JSON) the claims and phrasing use. */
  data: Record<string, unknown>;
}

export interface PendingQuestion {
  question_id: string;
  /** The human probe being asked, or the active probe that needs consent. */
  probe_id: string;
  kind: 'observe' | 'consent';
  text: string;
  clearer: string;
  asked_at: Iso;
  reasked: boolean;
  action_performed?: string;
  /** Ledger seqs of what was done right before asking (the flash), cited with the answer. */
  evidence: number[];
}

export interface DiagnosisSession {
  type: 'diagnosis';
  version: 1;
  diagnosis_id: string;
  created_at: Iso;
  updated_at: Iso;
  symptom: string;
  symptom_class: SymptomClass;
  target: DiagnosisTarget;
  /** primary: the entity the spoken name points at. dut: the device under test (an online copy if one exists). */
  entities: { primary?: EntityId; dut?: EntityId; twins: EntityId[]; group: EntityId[] };
  /** Hypothesis set in a stable order, 'unknown' last. */
  causes: HypothesisId[];
  prior: Record<string, number>;
  posterior: Record<string, number>;
  probes: ProbeResult[];
  observations: Observation[];
  pending?: PendingQuestion;
  consent: { disruptive?: 'granted' | 'declined' };
  questions_asked: number;
  passive_done: boolean;
  status: 'needs_answer' | 'ok';
  hypotheses: Hypothesis[];
  verdict?: Verdict;
  /** What would settle it, when the verdict is not confirmed. */
  settle?: string;
  /**
   * Set when the verdict is a cause the person (or the vendor) fixes and Fixwright can still tell when it is
   * fixed: the server schedules it and runs evaluateGuidedCheck (see followup.ts). The spoken guidance only
   * promises a check when this is present.
   */
  guided_check?: GuidedCheck;
  reliability: HumanReliability;
}

/**
 * How Fixwright confirms a fix it could not make itself:
 *   comes_back   the devices report available again (device_power_lost, wifi_network_changed)
 *   flaps        no drops since the guidance, counted the next morning (radio_link_weak)
 *   cloud_back   the vendor's status page reports ok again (vendor_cloud_outage)
 *   link_back    the integration is loaded again after the person signs in (account_link_expired)
 */
export type GuidedCheckKind = 'comes_back' | 'flaps' | 'cloud_back' | 'link_back';

/** A scheduled check, plain JSON. The server stores it, runs it at check_at, and again while it is pending. */
export interface GuidedCheck {
  kind: GuidedCheckKind;
  cause_id: DiagnosisCauseId;
  diagnosis_id: string;
  entity_ids: EntityId[];
  /** The device as spoken inside a sentence ("hallway lamp"). */
  name: string;
  /** When the guidance was given. Only events after it count. */
  since: Iso;
  /** When to run the first check. */
  check_at: Iso;
  /** How often to run a pending check again; 0 means a single check at check_at. */
  every_ms: number;
  /** A check still pending at this time reports fail. */
  until: Iso;
  /** cloud_back: the vendor string the adapter's cloudStatus takes, and its spoken brand. */
  vendor?: string;
  brand?: string;
  /** link_back: the integration that must load again. */
  integration?: string;
  /** flaps: drops in the day before the guidance, for the push. */
  baseline?: number;
}

export interface GuidedCheckResult {
  /** pending: not settled yet and before `until`; run again at next_check_at, push nothing. */
  result: 'pass' | 'fail' | 'pending';
  /** One sentence for a view or a checks[] row. */
  detail: string;
  /** The push and spoken line. Empty while pending. */
  speech: string;
  next_check_at?: Iso;
  /** Ledger seqs behind the result: the home events seen and the recorded check itself. */
  evidence: number[];
}

/** 'fixwright': the change was Fixwright's own write (a flash test, a repair step or an undo). */
export type Detector = 'power_restore' | 'automation_trigger' | 'user_action' | 'fixwright' | 'none';

export interface SuggestedRepair {
  issue_id: string;
  label: string;
  cause_id: DiagnosisCauseId;
  entity_ids: EntityId[];
}

export interface ExplanationSession {
  type: 'explanation';
  version: 1;
  explanation_id: string;
  created_at: Iso;
  question: string;
  window: { since: Iso; until: Iso; label: string };
  detector: Detector;
  verdict: Verdict;
  timeline: TimelineEntry[];
  suggested_fix?: SuggestedRepair;
}

export interface CheckupFindingRecord {
  finding: Finding;
  evidence: number[];
  /** Present when repair_plan can act on this finding. */
  repair?: { cause_id: DiagnosisCauseId; entity_ids: EntityId[] };
}

export interface CheckupSession {
  type: 'checkup';
  version: 1;
  checkup_id: string;
  created_at: Iso;
  findings: CheckupFindingRecord[];
}

/** One adapter operation, described as data. The server's executor runs it (see executor.ts). */
export type PlanOp =
  | { kind: 'registry_update'; entity_id: EntityId; patch: RegistryPatch }
  | { kind: 'registry_remove'; entity_id: EntityId }
  | { kind: 'select_option'; entity_id: EntityId; option: string }
  | { kind: 'reload_integration'; integration: string }
  | { kind: 'call_service'; domain: string; service: string; entity_id: EntityId }
  | { kind: 'flash_check'; entity_id: EntityId; domain: string; times: number };

/** What reading the device back after an op must show. */
export type ReadBackExpectation =
  | { kind: 'name'; entity_id: EntityId; equals: string }
  /** The entity answers to exactly these aliases (folded, any order). */
  | { kind: 'aliases'; entity_id: EntityId; equals: string[] }
  | { kind: 'disabled'; entity_id: EntityId; equals: boolean }
  | { kind: 'state'; entity_id: EntityId; equals: string }
  | { kind: 'absent'; entity_id: EntityId }
  | { kind: 'integration_loaded'; integration: string }
  | { kind: 'answers'; entity_id: EntityId; times: number };

export interface PlanAction {
  label: string;
  op: PlanOp;
  expect: ReadBackExpectation;
  /** Short text shown on the card when the read back matches. */
  read_back_text: string;
}

export interface PlanStep extends PlanAction {
  step: number;
  /** `${plan_id}:${step}`: the server runs each key at most once. */
  idempotency_key: string;
  /** How to put it back. Null for steps that change nothing (checks) or cannot be reversed. */
  inverse: PlanAction | null;
}

/**
 * What the next morning check looks at. 'none' (name collision, dead trigger: nothing a sensor can show)
 * means no morning check is scheduled; morningCheckAt returns undefined and morningCheck reports
 * 'not_checked' instead of inventing a pass.
 */
export interface RepairVerify {
  kind: 'commands_answered' | 'setting_holds' | 'available' | 'none';
  entity_ids: EntityId[];
  /** Name used in the morning push, e.g. "Hallway lamp". */
  name: string;
}

export interface RepairPlan {
  type: 'plan';
  version: 1;
  plan_id: string;
  created_at: Iso;
  expires_at: Iso;
  confirm_token: string;
  source: { diagnosis_id?: string; issue_id?: string; explanation_id?: string };
  cause_id: CauseId;
  steps: PlanStep[];
  diff: DiffRow[];
  diff_lines: string[];
  protected_conflicts: string[];
  /** Ops to run only after the morning check passes (no undo is offered for them). */
  follow_up: PlanOp[];
  verify: RepairVerify;
  /** Every state changing step has an inverse. */
  undoable: boolean;
}
