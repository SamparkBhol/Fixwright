// Household time: converting between UTC instants and the household's wall clock with Intl (present in
// Node, workerd and browsers), and formatting times the way people say them.

import type { QuietHours } from '../types.ts';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// Building a DateTimeFormat costs far more than using one, so keep one per time zone.
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    FORMATTERS.set(tz, f);
  }
  return f;
}

/** Wall clock time in the household's zone for an instant. */
export function localTime(ms: number, tz: string): LocalTime {
  const out: LocalTime = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatter(tz).formatToParts(new Date(ms))) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day' || part.type === 'minute' || part.type === 'second') {
      out[part.type] = Number(part.value);
    } else if (part.type === 'hour') {
      out.hour = Number(part.value) % 24;
    }
  }
  return out;
}

function offsetAt(ms: number, tz: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  const t = localTime(whole, tz);
  return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) - whole;
}

/**
 * The instant at a household wall clock time. Out of range parts roll over (day 0 is the last day of the
 * previous month), so "yesterday at 18:00" is localToUtc(y, m, d - 1, 18, 0).
 */
export function localToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const first = asUtc - offsetAt(asUtc, tz);
  return asUtc - offsetAt(first, tz);
}

/** Midnight at the start of the household day that contains ms. */
export function localDayStart(ms: number, tz: string, dayOffset = 0): number {
  const t = localTime(ms, tz);
  return localToUtc(t.year, t.month, t.day + dayOffset, 0, 0, tz);
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** "October 3" */
export function monthDay(ms: number, tz: string): string {
  const t = localTime(ms, tz);
  return `${MONTHS[t.month - 1] ?? ''} ${t.day}`;
}

/** "3 October" */
export function dayMonth(ms: number, tz: string): string {
  const t = localTime(ms, tz);
  return `${t.day} ${MONTHS[t.month - 1] ?? ''}`;
}

/** "3:12", or "3:12 a.m." with the meridiem when the context does not make it obvious. */
export function clockTime(ms: number, tz: string, meridiem: boolean): string {
  const t = localTime(ms, tz);
  const h = t.hour % 12 === 0 ? 12 : t.hour % 12;
  const base = `${h}:${String(t.minute).padStart(2, '0')}`;
  return meridiem ? `${base} ${t.hour < 12 ? 'a.m.' : 'p.m.'}` : base;
}

/**
 * "since 9:40 a.m." today, "since yesterday", or "since October 3". One date order everywhere (American,
 * like the spoken verdict "went offline on October 3"), so speech and cards never disagree.
 */
export function sincePhrase(ms: number, nowMs: number, tz: string): string {
  const today = localDayStart(nowMs, tz);
  if (ms >= today) return `since ${clockTime(ms, tz, true)}`;
  if (ms >= localDayStart(nowMs, tz, -1)) return 'since yesterday';
  return `since ${monthDay(ms, tz)}`;
}

export function parseClock(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new RangeError(`expected HH:MM, got ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new RangeError(`expected HH:MM, got ${hhmm}`);
  return h * 60 + min;
}

/** Is the household inside its quiet hours (default 22:00 to 07:00) at this instant? */
export function inQuietHours(ms: number, tz: string, quiet: QuietHours): boolean {
  const t = localTime(ms, tz);
  const now = t.hour * 60 + t.minute;
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export const iso = (ms: number): string => new Date(ms).toISOString();

/** The next household wall clock time hh:mm strictly after ms (the 07:00 morning check). */
export function nextLocalTime(ms: number, tz: string, hhmm: string): number {
  const minutes = parseClock(hhmm);
  const t = localTime(ms, tz);
  for (let day = 0; day <= 2; day++) {
    const at = localToUtc(t.year, t.month, t.day + day, Math.floor(minutes / 60), minutes % 60, tz);
    if (at > ms) return at;
  }
  throw new RangeError(`no ${hhmm} after ${iso(ms)} in ${tz}`);
}
