// Home Assistant wire shapes (2026.9.4), as the REST and websocket APIs return them.
// Only the fields the adapter reads are typed; everything else is kept as unknown.

export interface HaContext {
  id: string;
  parent_id: string | null;
  user_id: string | null;
}

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  /** ISO 8601 with a +00:00 offset and microseconds. */
  last_changed: string;
  last_updated: string;
  last_reported?: string;
  context?: HaContext;
}

export interface HaEvent<T = unknown> {
  event_type: string;
  data: T;
  origin: string;
  time_fired: string;
  context: HaContext;
}

export interface StateChangedData {
  entity_id: string;
  old_state: HaState | null;
  new_state: HaState | null;
}

/**
 * One logbook row. REST sends `when` as an ISO string, the websocket as unix seconds (float).
 * The context_* fields describe the event that started the row's context (logbook ContextAugmenter):
 * a call_service, an automation_triggered or script_started event, or another entity's state change.
 */
export interface LogbookRow {
  when: string | number;
  name?: string;
  message?: string;
  entity_id?: string;
  state?: string;
  domain?: string;
  icon?: string;
  source?: string;
  context_id?: string;
  context_user_id?: string;
  context_event_type?: string;
  context_domain?: string;
  context_service?: string;
  context_entity_id?: string;
  context_entity_id_name?: string;
  context_state?: string;
  context_name?: string;
  context_message?: string;
  context_source?: string;
}

/**
 * A history point. The websocket uses the compressed format (s, a, lu, lc in unix seconds, lc only
 * when it differs from lu); REST uses full keys, and in minimal mode only the first point is complete.
 */
export interface HaHistoryPoint {
  s?: string;
  a?: Record<string, unknown>;
  lu?: number;
  lc?: number;
  entity_id?: string;
  state?: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

/** config/entity_registry/get and get_entries (extended form; config/entity_registry/list omits aliases). */
export interface HaEntityEntry {
  entity_id: string;
  id?: string;
  unique_id?: string;
  platform: string;
  config_entry_id: string | null;
  device_id: string | null;
  area_id: string | null;
  name: string | null;
  original_name: string | null;
  has_entity_name?: boolean;
  /** null stands for "the entity's computed name". */
  aliases?: Array<string | null>;
  disabled_by: string | null;
  hidden_by: string | null;
  entity_category?: string | null;
  device_class?: string | null;
  original_device_class?: string | null;
  translation_key?: string | null;
  labels?: string[];
  /** Unix seconds. */
  created_at?: number;
  modified_at?: number;
}

export interface HaDeviceEntry {
  id: string;
  name: string | null;
  name_by_user: string | null;
  manufacturer: string | null;
  model: string | null;
  area_id: string | null;
  config_entries: string[];
  connections: Array<[string, string]>;
  identifiers: Array<[string, string]>;
  via_device_id: string | null;
  disabled_by: string | null;
  sw_version?: string | null;
  labels?: string[];
}

export interface HaAreaEntry {
  area_id: string;
  name: string;
  aliases?: string[];
  floor_id?: string | null;
  labels?: string[];
}

export interface HaConfigEntry {
  entry_id: string;
  domain: string;
  title: string;
  source: string;
  /** loaded | setup_error | migration_error | setup_retry | not_loaded | failed_unload | setup_in_progress | unload_in_progress */
  state: string;
  reason?: string | null;
  disabled_by?: string | null;
  supports_unload?: boolean;
}

export interface HaFlowProgress {
  flow_id: string;
  handler: string;
  context?: { source?: string; entry_id?: string; unique_id?: string };
}

export interface HaConfig {
  version: string;
  state: string;
  components: string[];
  time_zone?: string;
  location_name?: string;
}
