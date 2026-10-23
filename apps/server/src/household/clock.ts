// The demo house clock. SimHome households run on household time = real time + an offset; this file says
// where a new house starts (DEMO_START) and labels the clock for /health and /demo/state, so nobody mistakes
// the afternoon a judge sees at 3 a.m. for real time.

import { localTime, localToUtc } from '@fixwright/engine';

/** Every demo house lives in Los Angeles time (the demo script's). */
export const TZ = 'America/Los_Angeles';

/** The anchor demo houses use unless DEMO_START says otherwise: the demo script's afternoon. */
export const DEFAULT_DEMO_START = '15:00';

const HM = /^(\d{1,2}):(\d{2})$/;

/**
 * Where a new SimHome house starts, as household ms. "HH:MM" is that time on the current local date (so a
 * judge at 23:30 or 03:00 still gets the afternoon house), an ISO instant is that instant, "now" is real time.
 * Household time then runs with real time from there (plus whatever /demo/clock adds).
 */
export function demoStartMs(spec: string, realNowMs: number, tz: string): number {
  const s = spec.trim();
  const hm = HM.exec(s);
  if (hm && Number(hm[1]) < 24 && Number(hm[2]) < 60) {
    const t = localTime(realNowMs, tz);
    return localToUtc(t.year, t.month, t.day, Number(hm[1]), Number(hm[2]), tz);
  }
  if (s !== 'now') {
    const at = Date.parse(s);
    if (Number.isFinite(at)) return at;
  }
  return realNowMs;
}

export interface ClockLabel {
  /** True when household time is not real time. */
  simulated: boolean;
  /** "15:00" (local, on the day the house is built), an ISO instant, or "now". */
  starts_at: string;
  tz: string;
  note: string;
}

/** How demo houses keep time under a DEMO_START value, in words for /health and /demo/state. */
export function clockLabel(spec: string, tz: string = TZ): ClockLabel {
  const s = spec.trim();
  const hm = HM.exec(s);
  if (hm && Number(hm[1]) < 24 && Number(hm[2]) < 60) {
    const at = `${hm[1]?.padStart(2, '0')}:${hm[2]}`;
    return { simulated: true, starts_at: at, tz, note: `Simulated clock. Each new demo house starts at ${at} ${tz} time on the day it is built, then runs with real time.` };
  }
  if (s !== 'now' && Number.isFinite(Date.parse(s))) {
    const at = new Date(Date.parse(s)).toISOString();
    return { simulated: true, starts_at: at, tz, note: `Simulated clock. Each new demo house starts at ${at}, then runs with real time.` };
  }
  return { simulated: false, starts_at: 'now', tz, note: `Demo houses run on real ${tz} time.` };
}
