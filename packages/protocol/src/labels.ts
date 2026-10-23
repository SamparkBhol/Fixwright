// Cause, finding and probe vocabularies with the plain labels views and speech use.
// Labels are short enough for a hypothesis bar or a chip; details are one plain sentence.

/** Single fault causes the diagnosis engine ranks. */
export const DIAGNOSIS_CAUSE_IDS = [
  'stale_duplicate',
  'device_power_lost',
  'radio_link_weak',
  'hub_down',
  'vendor_cloud_outage',
  'account_link_expired',
  'power_on_default_on',
  'name_collision',
  'dead_trigger',
  'wifi_network_changed',
] as const;

/** Causes explain_event can name for something that already happened, plus unknown. */
export const EVENT_CAUSE_IDS = ['power_restore', 'automation_trigger', 'user_action', 'unknown'] as const;

export const CAUSE_IDS = [...DIAGNOSIS_CAUSE_IDS, ...EVENT_CAUSE_IDS] as const;
export type DiagnosisCauseId = (typeof DIAGNOSIS_CAUSE_IDS)[number];
export type EventCauseId = (typeof EVENT_CAUSE_IDS)[number];
export type CauseId = (typeof CAUSE_IDS)[number];

export interface Label {
  label: string;
  detail: string;
}

export const CAUSE_LABELS: Readonly<Record<CauseId, Label>> = {
  stale_duplicate: {
    label: 'Name points at an old copy',
    detail: 'The spoken name still points at an old copy of the device that was left behind when it was paired again.',
  },
  device_power_lost: {
    label: 'Device has no power',
    detail: 'The device is switched off at the wall or unplugged, while the rest of the home is fine.',
  },
  radio_link_weak: {
    label: 'Weak radio link',
    detail: 'The device is too far from the hub or a repeater, so it keeps dropping off.',
  },
  hub_down: {
    label: 'Hub or bridge offline',
    detail: 'The hub or bridge that carries this device cannot be reached, so every device on it is offline.',
  },
  vendor_cloud_outage: {
    label: "Maker's cloud is down",
    detail: "The device maker's cloud service is having problems, so commands do not get through.",
  },
  account_link_expired: {
    label: 'Account link expired',
    detail: "The link to the device maker's account has expired and needs signing in again.",
  },
  power_on_default_on: {
    label: 'Turns on after a power cut',
    detail: 'When power comes back, the device switches itself on because it is set to start on.',
  },
  name_collision: {
    label: 'Two devices share a name',
    detail: 'Two different devices answer to the same spoken name, so a command can reach the wrong one.',
  },
  dead_trigger: {
    label: 'Automation uses a removed device',
    detail: 'An automation still refers to a device that no longer exists, so it does not run as meant.',
  },
  wifi_network_changed: {
    label: 'Wi-Fi network changed',
    detail: 'The router or the network name changed, and the device is still looking for the old one.',
  },
  power_restore: {
    label: 'Power came back on',
    detail: 'Mains power went out and came back, and devices restarted on their own.',
  },
  automation_trigger: {
    label: 'An automation did it',
    detail: 'An automation in the home switched the device.',
  },
  user_action: {
    label: 'Someone used the app',
    detail: 'A person switched the device from an app or a wall control.',
  },
  unknown: {
    label: "Can't tell yet",
    detail: 'There is not enough evidence in the logs to name a cause.',
  },
};

export const FINDING_KINDS = [
  'duplicate_name',
  'ghost_entity',
  'flapping',
  'low_battery',
  'dead_trigger',
  'power_on_default',
  'integration_error',
  'unprotected_load',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const FINDING_LABELS: Readonly<Record<FindingKind, Label>> = {
  duplicate_name: {
    label: 'Duplicate spoken name',
    detail: 'Two devices answer to the same name, so a voice command can reach the wrong one.',
  },
  ghost_entity: {
    label: 'Old copy left behind',
    detail: 'An old copy of a device has been offline for over a day and is still in the device list.',
  },
  flapping: {
    label: 'Keeps dropping off',
    detail: 'The device went offline and came back at least five times in the last day.',
  },
  low_battery: {
    label: 'Low battery',
    detail: 'The battery is below 15 percent and the device may stop reporting soon.',
  },
  dead_trigger: {
    label: 'Automation uses a removed device',
    detail: 'An automation refers to a device that no longer exists.',
  },
  power_on_default: {
    label: 'Turns on after a power cut',
    detail: 'The device is set to switch on whenever power comes back, even if it was off before.',
  },
  integration_error: {
    label: 'Connection needs attention',
    detail: 'The connection to one of your device brands failed to start.',
  },
  unprotected_load: {
    label: 'Essential device not protected',
    detail: 'Something that should never lose power, like an aquarium filter or a freezer, is on a switchable outlet and not protected.',
  },
};

/** Probe library ids. ProbeResult.probe_id is not limited to these. */
export const PROBE_IDS = [
  'hub_reachable',
  'entity_availability',
  'link_quality',
  'cloud_status',
  'integration_state',
  'duplicate_name_scan',
  'registry_scan',
  'flash_test',
  'confirm_flash',
  'power_switch_check',
  'router_changed',
] as const;
export type KnownProbeId = (typeof PROBE_IDS)[number];
export type ProbeKind = 'passive' | 'active' | 'human';

export const PROBE_KINDS: Readonly<Record<KnownProbeId, ProbeKind>> = {
  hub_reachable: 'passive',
  entity_availability: 'passive',
  link_quality: 'passive',
  cloud_status: 'passive',
  integration_state: 'passive',
  duplicate_name_scan: 'passive',
  registry_scan: 'passive',
  flash_test: 'active',
  confirm_flash: 'human',
  power_switch_check: 'human',
  router_changed: 'human',
};
