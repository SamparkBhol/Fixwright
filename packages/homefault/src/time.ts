// Household time. Homes live in a time zone ("the plugs turned on at 3 a.m."), logs live in UTC.
// Intl.DateTimeFormat with a timeZone is available in Node 22, workerd and every modern browser.

import type { Iso } from './types.ts';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall clock parts of an instant in a time zone (seconds precision). */
export function localParts(ms: number, tz: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** Offset of the zone from UTC at an instant, in ms (negative west of Greenwich). */
export function zoneOffsetMs(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The instant a wall clock time happens in a zone. A time that happens twice (the hour DST repeats)
 * resolves to the first; a time DST skips resolves forward (02:30 on a spring-forward night is 03:30).
 */
export function zonedToUtcMs(p: LocalParts & { ms?: number }, tz: string): number {
  const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.ms ?? 0);
  const o1 = zoneOffsetMs(guess, tz);
  const t1 = guess - o1;
  const o2 = zoneOffsetMs(t1, tz);
  if (o1 === o2) return t1;
  const t2 = guess - o2;
  if (zoneOffsetMs(t2, tz) === o2) return t2;
  return Math.max(t1, t2);
}

/** Parses '2026-10-15T15:00:00' (no offset) as wall clock time in the zone. */
export function parseLocal(text: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text);
  if (!m) throw new RangeError(`not a local date time: ${text}`);
  return zonedToUtcMs(
    {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: Number(m[6] ?? 0),
      ms: Number((m[7] ?? '0').padEnd(3, '0')),
    },
    tz,
  );
}

/** Accepts an ISO instant with offset or Z, a local wall clock string, or epoch ms. */
export function toMs(time: Iso | number, tz: string): number {
  if (typeof time === 'number') {
    if (!Number.isFinite(time)) throw new RangeError(`not a valid time: ${time}`);
    return time;
  }
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(time)) {
    const ms = Date.parse(time);
    if (!Number.isFinite(ms)) throw new RangeError(`not a valid time: ${time}`);
    return ms;
  }
  return parseLocal(time, tz);
}

export const iso = (ms: number): Iso => new Date(ms).toISOString();

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** 'YYYY-MM-DD' of the local calendar day. */
export function localDayKey(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 'HH:MM:SS' local wall clock. */
export function localClock(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** Midnight that starts the local day containing ms. */
export function startOfLocalDay(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  return zonedToUtcMs({ ...p, hour: 0, minute: 0, second: 0 }, tz);
}

/** The instant of a wall clock time ('HH:MM' or 'HH:MM:SS') on the local day named by dayKey. */
export function atLocal(dayKey: string, clock: string, tz: string): number {
  return parseLocal(`${dayKey}T${clock.length === 5 ? `${clock}:00` : clock}`, tz);
}

export function nextDayKey(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** The latest instant at or before ms whose local wall clock reads `clock`. */
export function lastLocalOccurrence(ms: number, clock: string, tz: string): number {
  const today = atLocal(localDayKey(ms, tz), clock, tz);
  if (today <= ms) return today;
  const yesterday = startOfLocalDay(ms, tz) - HOUR;
  return atLocal(localDayKey(yesterday, tz), clock, tz);
}
