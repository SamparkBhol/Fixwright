// Cause library. Each cause has a prior that depends on the device (domain, transport,
// integration), an applicability test, how well it explains each kind of symptom, and a repair template.
// The numbers are model parameters (judgement calls about how common each fault is for a given device),
// not measurements. The HomeTruth bench measures how well the resulting diagnoses hold up.

import { CAUSE_LABELS, type DiagnosisCauseId, type Entity } from '@fixwright/protocol';
import { ACCOUNT_INTEGRATIONS, HUB_INTEGRATIONS, isGroup, isPhysical, SWITCHABLE_DOMAINS } from './house.ts';
import { phrase } from './phrase.ts';
import type { GuidedCheckKind, SymptomClass } from './types.ts';

export interface CauseContext {
  primary?: Entity;
  dut?: Entity;
  guided: boolean;
  symptom: SymptomClass;
  /**
   * What the device under test tells about its power on behaviour: 'select' when it has a power on select
   * the planner can set to previous, 'signal' when the setting can only be read, undefined when neither.
   * A setting nobody can read cannot be tested or fixed, so the cause is not a hypothesis then.
   */
  powerOn?: 'select' | 'signal';
}

export type RepairMode = 'automatic' | 'guided' | 'none';

export interface GuidanceParams {
  /** The device as spoken inside a sentence. */
  name: string;
  /** A follow up check is scheduled, so the line may promise one. */
  check: boolean;
  /** Devices the check covers. */
  count: number;
  /** The device runs on a battery, so it has no wall switch to turn back on. */
  battery?: boolean;
  /** Its battery reads low (battery_level came out 'low'), so a fresh battery is the advice. */
  batteryLow?: boolean;
}

export interface RepairTemplate {
  mode: RepairMode;
  /** What the repair does, in one plain line (README, views). */
  summary: string;
  /** What the person can do when Fixwright cannot fix it alone. Spoken after the verdict. */
  guidance?: (p: GuidanceParams) => string;
  /** How Fixwright tells that the person's (or the vendor's) fix worked (followup.ts). */
  check?: GuidedCheckKind;
}

export interface CauseDef {
  id: DiagnosisCauseId;
  label: string;
  /** Prior weight for this device before any probe; 0 means the cause cannot apply. */
  prior(ctx: CauseContext): number;
  /** P(the person describes the problem this way | cause), relative. */
  symptom: Readonly<Record<SymptomClass, number>>;
  repair: RepairTemplate;
}

const transport = (ctx: CauseContext): string => ctx.primary?.transport ?? 'unknown';
const physical = (ctx: CauseContext): boolean => ctx.guided || (ctx.primary !== undefined && isPhysical(ctx.primary));
const radio = (ctx: CauseContext): boolean => ['zigbee', 'thread', 'wifi'].includes(transport(ctx));

/** Symptom weights: [unresponsive, unexpected_on, wrong_device, automation, unknown]. 0 means the cause cannot produce that complaint. */
function symptoms(unresponsive: number, unexpectedOn: number, wrongDevice: number, automation: number): Record<SymptomClass, number> {
  return { unresponsive, unexpected_on: unexpectedOn, wrong_device: wrongDevice, automation, unknown: 1 };
}

export const CAUSES: readonly CauseDef[] = [
  {
    id: 'stale_duplicate',
    label: CAUSE_LABELS.stale_duplicate.label,
    prior: (ctx) => (!ctx.guided && ctx.primary !== undefined && ctx.primary.domain !== 'automation' && !isGroup(ctx.primary) ? 0.1 : 0),
    symptom: symptoms(1, 0.05, 0.5, 0.3),
    repair: {
      mode: 'automatic',
      summary: 'Move the spoken name to the online copy and retire the old copy, reading each change back.',
    },
  },
  {
    id: 'device_power_lost',
    label: CAUSE_LABELS.device_power_lost.label,
    prior: (ctx) => (physical(ctx) && ctx.primary?.transport !== 'cloud' ? 0.28 : 0),
    symptom: symptoms(1, 0.05, 0.05, 0.3),
    repair: {
      mode: 'guided',
      summary: 'A person switches the power back on; Fixwright checks that the device comes back online.',
      // A battery device has no wall switch: a low reading asks for a fresh battery, a fine one for a reseat.
      guidance: (p) => (p.battery !== true ? phrase('guide_power', p) : p.batteryLow === true ? phrase('guide_battery', p) : phrase('guide_battery_seat', p)),
      check: 'comes_back',
    },
  },
  {
    id: 'radio_link_weak',
    label: CAUSE_LABELS.radio_link_weak.label,
    prior: (ctx) => (ctx.guided ? 0.08 : radio(ctx) ? 0.16 : 0),
    symptom: symptoms(1, 0.1, 0.05, 0.3),
    repair: {
      mode: 'guided',
      summary: 'Guidance to move the device or add a mains powered repeater; the next morning check counts the drops.',
      guidance: (p) => phrase('guide_radio', p),
      check: 'flaps',
    },
  },
  {
    id: 'hub_down',
    label: CAUSE_LABELS.hub_down.label,
    prior: (ctx) => (ctx.primary !== undefined && HUB_INTEGRATIONS.has(ctx.primary.integration) ? 0.08 : 0),
    symptom: symptoms(1, 0.05, 0.05, 0.3),
    repair: { mode: 'automatic', summary: 'Reload the hub integration and read back that it is loaded.' },
  },
  {
    id: 'vendor_cloud_outage',
    label: CAUSE_LABELS.vendor_cloud_outage.label,
    prior: (ctx) => {
      if (ctx.guided) return 0.04;
      if (ctx.primary?.vendor === undefined) return 0;
      return transport(ctx) === 'cloud' ? 0.25 : transport(ctx) === 'wifi' ? 0.05 : 0.015;
    },
    symptom: symptoms(1, 0.05, 0.05, 0.3),
    repair: {
      mode: 'none',
      summary: 'Nothing to change at home; recheck the vendor status later and push when it is back.',
      guidance: (p) => phrase('guide_cloud', p),
      check: 'cloud_back',
    },
  },
  {
    id: 'account_link_expired',
    label: CAUSE_LABELS.account_link_expired.label,
    prior: (ctx) => {
      if (ctx.guided) return 0.04;
      const p = ctx.primary;
      return p !== undefined && (ACCOUNT_INTEGRATIONS.has(p.integration) || p.transport === 'cloud') ? 0.05 : 0;
    },
    symptom: symptoms(1, 0.02, 0.05, 0.3),
    repair: {
      mode: 'guided',
      summary: 'Guided relink of the vendor account (QR code on screen, simulated in the demo); Fixwright checks the link loads again.',
      guidance: (p) => phrase('guide_account', p),
      check: 'link_back',
    },
  },
  {
    id: 'power_on_default_on',
    label: CAUSE_LABELS.power_on_default_on.label,
    prior: (ctx) => {
      const e = ctx.dut ?? ctx.primary;
      return e !== undefined && SWITCHABLE_DOMAINS.has(e.domain) && ctx.powerOn !== undefined ? 0.1 : 0;
    },
    // The setting only acts when power comes back: it can switch a device on by itself, but never make it
    // ignore commands or answer to the wrong name, so those complaints rule it out.
    symptom: symptoms(0, 1, 0, 0.1),
    repair: {
      mode: 'automatic',
      summary: "Set the device's power on behaviour to previous, and read it back.",
      // Only spoken when the setting can be read but not changed from here (no power on select).
      guidance: (p) => phrase('guide_power_on', p),
    },
  },
  {
    id: 'name_collision',
    label: CAUSE_LABELS.name_collision.label,
    prior: (ctx) => (!ctx.guided && ctx.primary !== undefined && ctx.primary.domain !== 'automation' ? 0.04 : 0),
    symptom: symptoms(0.3, 0.3, 1, 0.2),
    repair: { mode: 'automatic', summary: 'Rename one of the two devices to a distinct name the planner proposes.' },
  },
  {
    id: 'dead_trigger',
    label: CAUSE_LABELS.dead_trigger.label,
    prior: (ctx) => (ctx.primary?.domain === 'automation' ? 0.4 : ctx.symptom === 'automation' && !ctx.guided ? 0.1 : 0),
    symptom: symptoms(0.1, 0.2, 0.1, 1),
    repair: { mode: 'automatic', summary: 'Show the automation and turn it off with consent, and read it back.' },
  },
  {
    id: 'wifi_network_changed',
    label: CAUSE_LABELS.wifi_network_changed.label,
    prior: (ctx) => (ctx.guided ? 0.12 : transport(ctx) === 'wifi' ? 0.1 : 0),
    symptom: symptoms(1, 0.02, 0.05, 0.3),
    repair: {
      mode: 'guided',
      summary: 'Guided triage: put each Wi-Fi device on the new network; Fixwright checks which ones come back.',
      guidance: (p) => phrase('guide_wifi', p),
      check: 'comes_back',
    },
  },
];

export const CAUSE_BY_ID: ReadonlyMap<DiagnosisCauseId, CauseDef> = new Map(CAUSES.map((c) => [c.id, c]));

/** Prior weight of the catch all 'unknown' hypothesis. */
export const UNKNOWN_PRIOR = 0.04;

export function causeDef(id: DiagnosisCauseId): CauseDef {
  const c = CAUSE_BY_ID.get(id);
  if (!c) throw new RangeError(`unknown cause ${id}`);
  return c;
}

/** Applicable causes with their priors, times how well each explains the symptom, plus 'unknown'. */
export function priorFor(ctx: CauseContext): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of CAUSES) {
    const p = c.prior(ctx) * c.symptom[ctx.symptom];
    if (p > 0) out[c.id] = p;
  }
  out['unknown'] = UNKNOWN_PRIOR;
  const total = Object.values(out).reduce((s, p) => s + p, 0);
  return Object.fromEntries(Object.entries(out).map(([k, p]) => [k, p / total]));
}

/** Causes Fixwright repairs by itself (repair_plan works on them). */
export const isAutomatic = (id: string): boolean => CAUSE_BY_ID.get(id as DiagnosisCauseId)?.repair.mode === 'automatic';
