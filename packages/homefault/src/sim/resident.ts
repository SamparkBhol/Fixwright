// The household's day: a resident who uses voice and the app, automations on their schedules, a motion
// sensor at night, batteries draining at midnight, and any fault process that recurs (a plug that keeps
// dropping off Wi-Fi). Each day is planned once, from the seed and the date alone, so a restored
// snapshot continues exactly as the original would have.

import { int, jitter, rngFor } from '../rng.ts';
import { atLocal, localDayKey, MINUTE, nextDayKey } from '../time.ts';
import { schedule } from './engine.ts';
import type { SimState } from './model.ts';

interface RoutineItem {
  at: string;
  /** Plus or minus this many minutes, seeded per day. */
  spreadMin: number;
  act:
    | { kind: 'voice'; name: string; service: 'turn_on' | 'turn_off' }
    | { kind: 'motion'; entityId: string }
    | { kind: 'sweep' };
}

/**
 * The resident's day. Between 15:00 and 07:00 the hallway lamp gets nine commands: four by voice in
 * the evening, two night light runs (on and off each) and one by voice in the morning. The reading lamp
 * on the living room strip is on from early morning to mid morning and from early afternoon to bedtime,
 * so at 15:00 and at 07:00 the next day it is the lamp on that strip someone would miss.
 */
export const DAILY_ROUTINE: readonly RoutineItem[] = [
  { at: '01:40', spreadMin: 20, act: { kind: 'motion', entityId: 'binary_sensor.hall_motion' } },
  { at: '05:55', spreadMin: 3, act: { kind: 'motion', entityId: 'binary_sensor.hall_motion' } },
  { at: '06:35', spreadMin: 3, act: { kind: 'voice', name: 'Hallway Lamp', service: 'turn_on' } },
  { at: '06:40', spreadMin: 4, act: { kind: 'voice', name: 'Reading Lamp', service: 'turn_on' } },
  { at: '07:12', spreadMin: 4, act: { kind: 'sweep' } },
  { at: '07:20', spreadMin: 4, act: { kind: 'voice', name: 'Hallway Lamp', service: 'turn_off' } },
  { at: '08:30', spreadMin: 10, act: { kind: 'voice', name: 'Reading Lamp', service: 'turn_off' } },
  { at: '14:20', spreadMin: 10, act: { kind: 'voice', name: 'Reading Lamp', service: 'turn_on' } },
  { at: '17:45', spreadMin: 10, act: { kind: 'voice', name: 'Hallway Lamp', service: 'turn_on' } },
  { at: '19:30', spreadMin: 10, act: { kind: 'voice', name: 'Hallway Lamp', service: 'turn_off' } },
  { at: '21:50', spreadMin: 10, act: { kind: 'voice', name: 'Hallway Lamp', service: 'turn_on' } },
  { at: '22:30', spreadMin: 10, act: { kind: 'voice', name: 'Bedroom Lamp', service: 'turn_on' } },
  { at: '22:40', spreadMin: 5, act: { kind: 'voice', name: 'Reading Lamp', service: 'turn_off' } },
  { at: '23:05', spreadMin: 10, act: { kind: 'voice', name: 'Hallway Lamp', service: 'turn_off' } },
  { at: '23:12', spreadMin: 2, act: { kind: 'voice', name: 'Bedroom Lamp', service: 'turn_off' } },
];

/** Hook for faults that recur every day (see faults.ts). */
export type FaultDayPlanner = (s: SimState, dayKey: string, dayStartMs: number, dayEndMs: number) => void;

function planDay(s: SimState, dayKey: string, faultPlanner: FaultDayPlanner): void {
  const start = atLocal(dayKey, '00:00:00', s.tz);
  const end = atLocal(nextDayKey(dayKey), '00:00:00', s.tz);
  const later = (at: number): boolean => at >= s.nowMs;

  // Batteries drain once a day, at the midnight that starts it.
  if (later(start)) schedule(s, { at: start, kind: 'drain' });

  DAILY_ROUTINE.forEach((item, i) => {
    const rng = rngFor(s.seed, 'routine', dayKey, i);
    const at = atLocal(dayKey, item.at, s.tz) + jitter(rng, item.spreadMin) * MINUTE + int(rng, 0, 59) * 1000;
    if (!later(at)) return;
    switch (item.act.kind) {
      case 'voice':
        schedule(s, { at, kind: 'voice', name: item.act.name, service: item.act.service });
        break;
      case 'motion':
        schedule(s, { at, kind: 'motion', entityId: item.act.entityId, on: true });
        break;
      case 'sweep':
        schedule(s, { at, kind: 'sweep', entityIds: [...s.routine.sweep] });
        break;
    }
  });

  for (const def of Object.values(s.automations)) {
    def.triggers.forEach((t, i) => {
      if (t.kind !== 'time') return;
      const at = atLocal(dayKey, t.at, s.tz);
      if (later(at)) schedule(s, { at, kind: 'auto_time', automationId: def.entityId, trigger: i });
    });
  }

  for (const def of Object.values(s.templates)) {
    for (const step of def.schedule) {
      const at = atLocal(dayKey, step.at, s.tz);
      if (later(at)) schedule(s, { at, kind: 'template', entityId: def.entityId, state: step.state });
    }
  }

  faultPlanner(s, dayKey, Math.max(start, s.nowMs), end);
}

/**
 * Plans the local day that contains the current time (from now on) and schedules the next planning
 * step at the following midnight. Called once when a house is built, then by the 'plan' event.
 */
export function planToday(s: SimState, faultPlanner: FaultDayPlanner): void {
  const day = localDayKey(s.nowMs, s.tz);
  if (s.plannedThrough !== null && day <= s.plannedThrough) return;
  planDay(s, day, faultPlanner);
  s.plannedThrough = day;
  schedule(s, { at: atLocal(nextDayKey(day), '00:00:00', s.tz), kind: 'plan' });
}
