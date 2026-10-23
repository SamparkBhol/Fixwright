export interface TimeOptions {
  locale: string;
  timeZone: string | undefined;
}

export function percent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(100, Math.max(0, Math.round(p * 100)));
}

export function percentLabel(p: number): string {
  return `${percent(p)}%`;
}

function safeFormat(opts: Intl.DateTimeFormatOptions, o: TimeOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(o.locale, { ...opts, timeZone: o.timeZone });
  } catch {
    // Unknown locale or zone from the host: fall back rather than throw inside a render.
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: undefined });
  }
}

export function clockTime(iso: string, o: TimeOptions, seconds = false): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const f = safeFormat({ hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) }, o);
  // Never break a line between the time and AM or PM.
  return f.format(ms).replace(/\s(?=[AaPp]\.?[Mm]\.?$)/, '\u00a0');
}

/** Keep short hyphenated words such as Wi-Fi on one line (non-breaking hyphen). */
export function keepHyphens(text: string): string {
  return text.replace(/\b([A-Za-z]{1,3})-([A-Za-z]{1,3})\b/g, '$1\u2011$2');
}

/** Keep a number with its unit ("-82 dBm", "120 V") on one line (non-breaking space). */
export function keepUnits(text: string): string {
  return text.replace(/(\d) (?=(?:dBm|dB|ms|kWh|Wh|mA|GHz|MHz|Hz|W|V|°[CF])(?![A-Za-z]))/g, '$1\u00a0');
}

const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
const DAY_MONTH = new RegExp(`\\b(\\d{1,2}) (?=${MONTH}\\b)`, 'g');
const MONTH_DAY = new RegExp(`\\b(${MONTH}) (?=\\d{1,2}\\b)`, 'g');

/** Keep a date's day and month on one line ("3 October", "October 3"). */
export function keepDates(text: string): string {
  return text.replace(DAY_MONTH, '$1\u00a0').replace(MONTH_DAY, '$1\u00a0');
}

/** Every string a view shows goes through this (dom.ts append). */
export function keepTogether(text: string): string {
  return keepDates(keepUnits(keepHyphens(text)));
}

export function dayNumber(ms: number, o: TimeOptions): number {
  const parts = safeFormat({ year: 'numeric', month: 'numeric', day: 'numeric' }, o).formatToParts(ms);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / 86_400_000);
}

export function when(iso: string, nowMs: number, o: TimeOptions): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const time = clockTime(iso, o);
  const diff = dayNumber(ms, o) - dayNumber(nowMs, o);
  if (diff === 0) return `today at ${time}`;
  if (diff === 1) return `tomorrow at ${time}`;
  if (diff === -1) return `yesterday at ${time}`;
  if (diff > 1 && diff < 7) return `${safeFormat({ weekday: 'long' }, o).format(ms)} at ${time}`;
  return `${safeFormat({ day: 'numeric', month: 'short' }, o).format(ms)} at ${time}`;
}

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

const SMALL_NUMBERS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** "Three things need a look" reads better than "3 things" in a headline; falls back to digits. */
export function countWord(n: number): string {
  return SMALL_NUMBERS[n] ?? String(n);
}

export function evidenceLabel(n: number): string {
  return `${n} ${plural(n, 'log entry', 'log entries')}`;
}
