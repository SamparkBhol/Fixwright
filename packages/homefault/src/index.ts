// homefault: behavioural fault injection for smart home agents.
// Pure: no I/O, no Node built-ins, no ambient clock or randomness. Runs in Node 22, workerd and browsers.

export * from './types.ts';
export { seededRng, rngFor, hashSeed } from './rng.ts';
export {
  DAY,
  HOUR,
  MINUTE,
  iso,
  localClock,
  localDayKey,
  localParts,
  lastLocalOccurrence,
  parseLocal,
  startOfLocalDay,
  toMs,
  zonedToUtcMs,
} from './time.ts';
export { foldName, isCodedError, own, type CodedError } from './util.ts';
export * from './logrows.ts';
export {
  SimHome,
  DEFAULT_TZ,
  DEMO_NOW_LOCAL,
  INPUT_LIMITS,
  toEntity,
  type FaultSpec,
  type InjectReport,
  type PersonAnswer,
  type PersonQuestion,
  type PhysicalReading,
  type SimHomeOptions,
} from './sim/simhome.ts';
export { rebaseSnapshot } from './sim/rebase.ts';
export { AREAS, SNAPSHOT_VERSION, type AreaId, type SimSnapshot } from './sim/model.ts';
export {
  BATTERY_DRAIN_PER_DAY,
  DEFAULT_MAX_ROW_BYTES,
  HA_VERSION,
  LIVING_ROOM_STRIP,
  OFFICE_STRIP,
  POWER_ON_OPTIONS,
  powerOnSelectId,
} from './sim/blueprint.ts';
export { DAILY_ROUTINE } from './sim/resident.ts';
export { BOOT_MS, SIM_ERROR } from './sim/engine.ts';
export {
  FAULTS,
  FAULT_CODES,
  FAULT_IDS,
  DEFAULT_ON_ENTITIES,
  DEMO_BATTERY_PCT,
  DEMO_FLAP_WINDOW,
  DEMO_FLAPS_TODAY,
  DEMO_GHOST_SINCE_LOCAL,
  DEMO_OUTAGE_CLOCK,
  faultId,
  type FaultCode,
  type FaultDef,
  type FaultId,
  type FaultOptions,
  type FaultSource,
} from './faults.ts';
export * from './scenario/types.ts';
export { validateScenario, parseScenario, MAX_DROP_RATE, type ValidationResult } from './scenario/validate.ts';
export { checkEvidence, restartClusters, type EvidenceReport } from './scenario/evidence.ts';
export { scenarioHome, SCENARIO_HOME_ERROR, type ScenarioHome } from './scenario/adapter.ts';
export { scenarioFromSimHome, type TwinMeta } from './scenario/twin.ts';
export {
  generateScenario,
  generateSet,
  causeForSeed,
  seedsOf,
  splitOf,
  SPLITS,
  GENERATOR_VERSION,
  MAX_JITTER_MS,
  type GenerateOptions,
  type Split,
} from './generator/index.ts';
export * from './bench.ts';
