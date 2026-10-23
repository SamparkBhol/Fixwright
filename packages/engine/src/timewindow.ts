// Time windows from plain questions: "at 3 a.m." is the last 03:00 to 03:59 household hour,
// "last night" is 18:00 to 08:00, plus this morning, yesterday, today, "an hour ago", "in the last hour" and
// a few Hindi forms (kal raat, subah, 3 baje). Returns null when the question names no time.
//
// A clock time with no day ("at 3 a.m.", "at 3") could be any time that hour came round in the last 48
// hours, and "at 3" with no a.m. or p.m. could be either 3 o'clock. timeWindowCandidates returns them all,
// most recent first; explain_event takes the most recent one that has activity in it (parseTimeWindow alone
// keeps the most recent). "last night", "this morning", "yesterday" or "today" settle the day.

import { DAY_MS, HOUR_MS, MINUTE_MS, localTime, localToUtc } from './util/time.ts';
import { numberWord } from './util/text.ts';

export interface TimeWindow {
  sinceMs: number;
  untilMs: number;
  label: string;
}

const NIGHT = /\b(last night|overnight|during the night|in the night|kal raat|raat ko|raat mein|raat main|raat)\b/;
const MORNING = /\b(this morning|in the morning|subah)\b/;
const AFTERNOON = /\b(this afternoon|in the afternoon|dopahar)\b/;
const EVENING = /\b(this evening|in the evening|shaam)\b/;

const CLOCK_WITH_MERIDIEM = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?\s?m\b\.?|p\.?\s?m\b\.?|o'?clock|baje)/;
const CLOCK_AFTER_AT = /\b(?:at|around|about|near|by|se)\s+(\d{1,2})(?:[:.](\d{2}))?\b(?!\s*(?:%|percent|times|minutes?|mins?|hours?|degrees|seconds?|days?|devices?|plugs?|lights?))/;
const AGO = /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty five)\s+(minutes?|mins?|hours?)\s+ago\b/;
// "in the last hour", "over the past 30 minutes", "the last couple of hours", "in the last day".
const LAST = /\b(?:last|past)\s+(?:(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|thirty|forty five|few|couple of|couple)\s+)?(minutes?|mins?|hours?|days?)\b/;
/** The longest span "in the last ..." reads, so a typo cannot ask for a month of history. */
const LAST_MAX_MS = 7 * DAY_MS;
/** How far back a clock time with no day ("at 3 a.m.") may reach: the hour came round within this span. */
const CANDIDATE_SPAN_MS = 2 * DAY_MS;

function wordNumber(w: string): number {
  if (/^\d+$/.test(w)) return Number(w);
  if (w === 'a' || w === 'an') return 1;
  if (w === 'forty five') return 45;
  if (w === 'few') return 3;
  if (w === 'couple' || w === 'couple of') return 2;
  for (let i = 0; i < 60; i++) if (numberWord(i) === w) return i;
  return 1;
}

/** The window a question names, or null. For an hour with no a.m. or p.m. this is the most recent one. */
export function parseTimeWindow(question: string, nowMs: number, tz: string): TimeWindow | null {
  return timeWindowCandidates(question, nowMs, tz)[0] ?? null;
}

/**
 * Every window the question could mean, most recent first: one window, or for a clock time with no day
 * ("at 3 a.m.", "at 3") every time that hour came round in the last 48 hours (both 3 o'clocks when there is
 * no a.m. or p.m.). Empty when the question names no time.
 */
export function timeWindowCandidates(question: string, nowMs: number, tz: string): TimeWindow[] {
  const q = ` ${question.toLowerCase().replace(/[?!,]/g, ' ').replace(/\s+/g, ' ')} `;
  const now = localTime(nowMs, tz);
  const at = (dayOffset: number, hour: number, minute = 0): number => localToUtc(now.year, now.month, now.day + dayOffset, hour, minute, tz);
  const night = NIGHT.test(q);
  const morning = MORNING.test(q);
  const evening = EVENING.test(q) || AFTERNOON.test(q);

  const clock = CLOCK_WITH_MERIDIEM.exec(q) ?? CLOCK_AFTER_AT.exec(q);
  if (clock) {
    const h = Number(clock[1]);
    const min = clock[2] !== undefined ? Number(clock[2]) : undefined;
    const meridiem = clock[3] ?? '';
    if (h <= 23 && (min ?? 0) <= 59) {
      let hours: number[];
      if (meridiem.startsWith('a')) hours = [h % 12];
      else if (meridiem.startsWith('p')) hours = [(h % 12) + 12];
      else if (h >= 13 || h === 0) hours = [h];
      else if (night) hours = h >= 6 && h <= 11 ? [h + 12] : [h % 12];
      else if (morning) hours = [h % 12];
      else if (evening) hours = [(h % 12) + 12];
      else hours = [h % 12, (h % 12) + 12];
      const startMinute = min === undefined ? 0 : min - 10;
      const lengthMs = (min === undefined ? 60 : 20) * MINUTE_MS;
      // "yesterday at 3" and "today at 3" name the day. "last night", "this morning" and "this evening"
      // name the latest one. Otherwise every time the hour came round in the last 48 hours is a candidate,
      // so "at 3 a.m." asked at 07:00 still finds the night before when the night just past was quiet.
      const yesterday = !night && /\b(yesterday|kal)\b/.test(q);
      const today = /\b(today|aaj)\b/.test(q);
      const days = yesterday ? [-1] : today ? [0] : [0, -1, -2];
      const latestOnly = night || morning || evening;
      const starts = hours
        .flatMap((hour) => days.map((day) => at(day, hour, startMinute)))
        .filter((start) => start <= nowMs && start >= nowMs - CANDIDATE_SPAN_MS)
        .sort((a, b) => b - a)
        .slice(0, latestOnly ? hours.length : undefined);
      if (starts.length > 0) {
        const shown = min === undefined ? `${h}` : `${h}:${String(min).padStart(2, '0')}`;
        return starts.map((start) => ({ sinceMs: start, untilMs: Math.min(start + lengthMs - 1, nowMs), label: `around ${shown}` }));
      }
    }
  }
  const last = LAST.exec(q);
  if (last) {
    const n = Math.max(1, last[1] === undefined ? 1 : wordNumber(last[1]));
    const word = (last[2] ?? '').replace(/^mins?$/, 'minute').replace(/s$/, '');
    const unit = word.startsWith('h') ? HOUR_MS : word.startsWith('d') ? DAY_MS : MINUTE_MS;
    const label = n === 1 ? `in the last ${word}` : `in the last ${n} ${word}s`;
    return [{ sinceMs: nowMs - Math.min(n * unit, LAST_MAX_MS), untilMs: nowMs, label }];
  }
  const one = (w: TimeWindow): TimeWindow[] => [w];
  if (night) {
    return now.hour < 8
      ? one({ sinceMs: at(-1, 18), untilMs: nowMs, label: 'last night' })
      : one({ sinceMs: at(-1, 18), untilMs: at(0, 8) - 1, label: 'last night' });
  }
  if (morning) return one({ sinceMs: at(0, 5), untilMs: Math.min(at(0, 12) - 1, nowMs), label: 'this morning' });
  if (AFTERNOON.test(q) && now.hour >= 12) return one({ sinceMs: at(0, 12), untilMs: Math.min(at(0, 18) - 1, nowMs), label: 'this afternoon' });
  if (EVENING.test(q)) {
    return now.hour >= 18
      ? one({ sinceMs: at(0, 18), untilMs: nowMs, label: 'this evening' })
      : one({ sinceMs: at(-1, 18), untilMs: at(0, 0) - 1, label: 'yesterday evening' });
  }
  if (/\b(yesterday|kal)\b/.test(q)) return one({ sinceMs: at(-1, 0), untilMs: at(0, 0) - 1, label: 'yesterday' });
  if (/\b(today|aaj)\b/.test(q)) return one({ sinceMs: at(0, 0), untilMs: nowMs, label: 'today' });
  const ago = AGO.exec(q);
  if (ago) {
    const n = wordNumber(ago[1] ?? '1');
    const unit = (ago[2] ?? '').startsWith('h') ? HOUR_MS : MINUTE_MS;
    const center = nowMs - n * unit;
    const slack = Math.max(5 * MINUTE_MS, (n * unit) / 4);
    return one({ sinceMs: center - slack, untilMs: Math.min(center + slack, nowMs), label: `${ago[1]} ${ago[2]} ago` });
  }
  if (/\b(just now|a moment ago|right now|abhi)\b/.test(q)) return one({ sinceMs: nowMs - 15 * MINUTE_MS, untilMs: nowMs, label: 'just now' });
  return [];
}

/** "at 3 a.m." goes as a whole, with its "at". */
const withLead = (re: RegExp): RegExp => new RegExp(`(?:\\b(?:at|around|about|near|by|se)\\s+)?${re.source}`, 'g');
const TIME_EXPRESSIONS = [withLead(CLOCK_WITH_MERIDIEM), withLead(/\b\d{1,2}[:.]\d{2}\b/), ...[CLOCK_AFTER_AT, LAST, AGO].map((re) => new RegExp(re.source, 'g'))];

/**
 * The question with its time expressions taken out ("at 3", "3:12 a.m.", "3 baje", "in the last 2 hours"),
 * so an hour cannot read as a device number. A bare number stays: in "why did plug 3 turn on?" it is the name.
 */
export function withoutTimes(question: string): string {
  return TIME_EXPRESSIONS.reduce((text, re) => text.replace(re, ' '), ` ${question.toLowerCase().replace(/[?!,]/g, ' ')} `).replace(/\s+/g, ' ').trim();
}

/** Whether "3:12" needs "a.m." to be clear: only when the window spans morning and afternoon or night. */
export function needsMeridiem(w: Pick<TimeWindow, 'sinceMs' | 'untilMs'>, tz: string): boolean {
  if (w.untilMs - w.sinceMs >= 12 * HOUR_MS) return true;
  return localTime(w.sinceMs, tz).hour < 12 !== localTime(w.untilMs, tz).hour < 12;
}
