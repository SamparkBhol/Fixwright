// Moves a SimHome snapshot in time. Every instant shifts by one delta, so the house keeps the same
// relative history and its clock reads the new time. Context ids, the counter and the seed stay as they
// are, so the copy continues exactly like the original until the next local midnight; from then on each
// new day is planned from its own date, as SimHome.create would plan it.

import type { LogRow } from '../logrows.ts';
import { iso, localDayKey, startOfLocalDay } from '../time.ts';
import { rowSize, simError } from './engine.ts';
import type { SimSnapshot, SimState } from './model.ts';
import { rehydrate } from './simhome.ts';

/** Entity attributes that hold an instant (ISO 8601). */
const TIME_ATTRIBUTES = ['last_triggered'] as const;

/** Fault options that hold an instant (epoch ms). */
const TIME_OPTIONS = ['at', 'offlineSince'] as const;

// Keeps every shifted instant inside four digit years, so ISO strings and the log byte count keep their size.
const MIN_MS = Date.UTC(1971, 0, 1);
const MAX_MS = Date.UTC(9998, 0, 1);

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNumber(dayKey: string): number {
  const m = DAY_KEY.exec(dayKey);
  if (!m) throw simError('bad_snapshot', `Not a day key: ${dayKey}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000;
}

function addDays(dayKey: string, days: number): string {
  return new Date((dayNumber(dayKey) + days) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Whole calendar days to move the planning day keys. The pending 'plan' event moves with everything
 * else, and the day before the one it lands on counts as planned, so planning resumes when it fires
 * whatever the delta (a delta of whole days keeps every local midnight).
 */
function dayShift(s: SimState, delta: number): number {
  const plan = s.pending.find((p) => p.kind === 'plan');
  if (s.plannedThrough !== null && plan) {
    const planned = localDayKey(startOfLocalDay(plan.at + delta, s.tz) - 1, s.tz);
    return dayNumber(planned) - dayNumber(s.plannedThrough);
  }
  return dayNumber(localDayKey(s.nowMs + delta, s.tz)) - dayNumber(localDayKey(s.nowMs, s.tz));
}

const shiftIso = (value: string, delta: number): string => iso(Date.parse(value) + delta);

function shiftAttributes(attributes: Record<string, unknown>, delta: number): void {
  for (const key of TIME_ATTRIBUTES) {
    const value = attributes[key];
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) attributes[key] = shiftIso(value, delta);
  }
}

function shiftRow(row: LogRow, delta: number): LogRow {
  const out = { ...row, when: shiftIso(row.when, delta) };
  if (out.type === 'state' && out.attributes) {
    out.attributes = { ...out.attributes };
    shiftAttributes(out.attributes, delta);
  }
  return out;
}

/**
 * A copy of a SimHome snapshot whose clock reads newNowMs, with every timestamp (log rows, entity
 * last_changed and last_updated, device times, fault and cloud times, pending events) moved by the same
 * delta. To keep wall clock times (the 3:11 a.m. outage, the 09:00 to 15:00 drop window), pass a
 * newNowMs at the same local time of day as the snapshot's clock.
 */
export function rebaseSnapshot(snapshot: SimSnapshot, newNowMs: number): SimSnapshot {
  if (!Number.isSafeInteger(newNowMs) || newNowMs < MIN_MS || newNowMs > MAX_MS) {
    throw simError('bad_request', 'newNowMs must be whole epoch milliseconds between 1971 and 9998');
  }
  const s = rehydrate(snapshot);
  const delta = newNowMs - s.nowMs;
  if (delta === 0) return s;
  const days = dayShift(s, delta);

  s.nowMs = newNowMs;
  for (const d of Object.values(s.devices)) {
    d.bootMs += delta;
    d.lastSeenMs += delta;
    if (d.dropUntil > 0) d.dropUntil += delta;
    if (d.bootingUntil > 0) d.bootingUntil += delta;
    d.actuations = d.actuations.map((t) => t + delta);
  }
  for (const e of Object.values(s.entities)) {
    e.lastChanged = shiftIso(e.lastChanged, delta);
    e.lastUpdated = shiftIso(e.lastUpdated, delta);
    e.createdMs += delta;
    shiftAttributes(e.attributes, delta);
  }
  for (const c of Object.values(s.cloud)) c.since += delta;
  for (const f of Object.values(s.faults)) {
    f.since += delta;
    for (const key of TIME_OPTIONS) {
      const value = f.opts[key];
      if (typeof value === 'number') f.opts[key] = value + delta;
    }
    if (typeof f.opts.plannedDay === 'string') f.opts.plannedDay = addDays(f.opts.plannedDay, days);
  }
  for (const p of s.pending) p.at += delta;
  if (s.plannedThrough !== null) s.plannedThrough = addDays(s.plannedThrough, days);
  s.rows = s.rows.map((row) => shiftRow(row, delta));
  s.rowBytes = s.rows.reduce((n, row) => n + rowSize(row), 0);
  return s;
}
