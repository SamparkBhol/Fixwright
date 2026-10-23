// Protected loads. Some things must never lose power: an aquarium filter, a freezer, a grow
// light. The guard refuses any action that would cut them, including switching off the power strip
// they hang off, and offers the nearest safe alternative (the lamp on the same strip).

import type { Entity, EntityId, ProtectedDevice, SwitchAlternative } from '@fixwright/protocol';
import { isUnsafeDevice } from './house.ts';
import { phrase } from './phrase.ts';
import type { Outlet, PowerStrip, Topology } from './types.ts';
import { deviceNoun, loadNoun } from './util/text.ts';

/** Actions that might cut power. turn_on never does. */
export type GuardAction = 'turn_off' | 'turn_on' | 'toggle' | 'flash' | 'power_cycle';

export type GuardDecision =
  | { allow: true }
  | {
      allow: false;
      code: 'protected_load' | 'unsafe_device';
      /** The protected devices the action would cut. */
      blocked: ProtectedDevice[];
      /** The one alternative to offer (and the one the speech names), when there is one. */
      alternative?: SwitchAlternative;
      /** Every unprotected outlet on the strip, best first. */
      alternatives: SwitchAlternative[];
      speech: string;
    };

export type ProtectedSet = readonly ProtectedDevice[] | ReadonlySet<EntityId>;

function isProtected(id: EntityId, set: ProtectedSet): boolean {
  return set instanceof Set ? set.has(id) : (set as readonly ProtectedDevice[]).some((p) => p.entity_id === id);
}

function protectedRecord(outlet: Outlet, set: ProtectedSet): ProtectedDevice {
  const found = set instanceof Set ? undefined : (set as readonly ProtectedDevice[]).find((p) => p.entity_id === outlet.entity_id);
  return found ?? { entity_id: outlet.entity_id, name: outlet.load, reason: '' };
}

const cutsPower = (action: GuardAction): boolean => action !== 'turn_on';

function stripFor(entityId: EntityId, topology: Topology): PowerStrip | undefined {
  return topology.strips.find((s) => s.entity_id === entityId);
}

function outletFor(entityId: EntityId, topology: Topology): Outlet | undefined {
  for (const s of topology.strips) {
    const o = s.outlets.find((x) => x.entity_id === entityId);
    if (o) return o;
  }
  return undefined;
}

export interface GuardOptions {
  /** Current entities, so the alternative can be one that is actually on. */
  states?: readonly Pick<Entity, 'entityId' | 'state'>[];
}

/**
 * Decides whether an action on an entity is safe. Refuses locks, garage doors, alarms and cameras
 * outright, any power cutting action on a protected device, and switching off a strip that feeds one
 * (offering one unprotected outlet on the same strip instead).
 */
export function protectedGuard(
  action: GuardAction,
  entity: Entity,
  protectedSet: ProtectedSet,
  topology: Topology,
  options: GuardOptions = {},
): GuardDecision {
  if (isUnsafeDevice(entity)) {
    return { allow: false, code: 'unsafe_device', blocked: [], alternatives: [], speech: phrase('guard_unsafe', {}) };
  }
  if (!cutsPower(action)) return { allow: true };

  if (isProtected(entity.entityId, protectedSet)) {
    const outlet = outletFor(entity.entityId, topology);
    const load = outlet?.load ?? entity.name;
    const blocked = outlet
      ? [protectedRecord(outlet, protectedSet)]
      : [{ entity_id: entity.entityId, name: entity.name, reason: '' }];
    return { allow: false, code: 'protected_load', blocked, alternatives: [], speech: phrase('guard_protected', { load }) };
  }

  const strip = stripFor(entity.entityId, topology);
  if (!strip) return { allow: true };
  const guarded = strip.outlets.filter((o) => isProtected(o.entity_id, protectedSet));
  if (guarded.length === 0) return { allow: true };

  // One alternative, so what Fixwright says is exactly what it switches: a light that is on comes first,
  // since "turn off the strip" is most often about the light on it.
  const states = new Map((options.states ?? []).map((e) => [e.entityId, e.state]));
  const isLight = (o: Outlet): boolean => ['lamp', 'light', 'lights', 'bulb'].includes(deviceNoun({ name: o.load, domain: 'switch' }));
  const rank = (o: Outlet): number => (states.get(o.entity_id) === 'off' ? 2 : 0) + (isLight(o) ? 0 : 1);
  const alternatives: SwitchAlternative[] = strip.outlets
    .filter((o) => !isProtected(o.entity_id, protectedSet))
    .sort((a, b) => rank(a) - rank(b) || a.outlet - b.outlet)
    .map((o) => ({ entity_id: o.entity_id, name: o.load, label: `Turn off the ${o.load} on the same strip` }));
  const first = alternatives[0];
  return {
    allow: false,
    code: 'protected_load',
    blocked: guarded.map((o) => protectedRecord(o, protectedSet)),
    ...(first ? { alternative: first } : {}),
    alternatives,
    speech: phrase('guard_strip', {
      loads: guarded.map((o) => o.load),
      ...(first ? { alternativeNoun: loadNoun(first.name) } : {}),
    }),
  };
}
