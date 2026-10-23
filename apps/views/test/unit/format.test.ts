import { describe, expect, test } from 'vitest';
import { capitalize, clockTime, countWord, evidenceLabel, keepDates, keepHyphens, keepTogether, keepUnits, percent, percentLabel, when } from '../../src/ui/format.ts';

const LA = { locale: 'en-US', timeZone: 'America/Los_Angeles' };
const NBSP = ' ';

describe('format', () => {
  test('percent rounds and clamps', () => {
    expect(percent(0.94)).toBe(94);
    expect(percent(0.555)).toBe(56);
    expect(percent(1.2)).toBe(100);
    expect(percent(-1)).toBe(0);
    expect(percent(Number.NaN)).toBe(0);
    expect(percentLabel(0.04)).toBe('4%');
  });

  test('clock times are in the household zone and never split from AM or PM', () => {
    expect(clockTime('2026-10-16T14:00:00.000Z', LA)).toBe(`7:00${NBSP}AM`);
    expect(clockTime('2026-10-16T10:11:58.000Z', LA, true)).toBe(`3:11:58${NBSP}AM`);
    expect(clockTime('not a time', LA)).toBe('');
  });

  test('when() names the day relative to now', () => {
    const now = Date.parse('2026-10-15T17:21:00.000Z'); // Thursday 10:21 in Los Angeles
    expect(when('2026-10-16T14:00:00.000Z', now, LA)).toBe(`tomorrow at 7:00${NBSP}AM`);
    expect(when('2026-10-15T23:00:00.000Z', now, LA)).toBe(`today at 4:00${NBSP}PM`);
    expect(when('2026-10-14T14:00:00.000Z', now, LA)).toBe(`yesterday at 7:00${NBSP}AM`);
    expect(when('2026-10-18T14:00:00.000Z', now, LA)).toBe(`Sunday at 7:00${NBSP}AM`);
    expect(when('2026-11-02T15:00:00.000Z', now, LA)).toBe(`Nov 2 at 7:00${NBSP}AM`);
    // 06:30 UTC on the 16th is still the 15th in Los Angeles.
    expect(when('2026-10-16T06:30:00.000Z', now, LA)).toBe(`today at 11:30${NBSP}PM`);
  });

  test('unknown zones fall back instead of throwing inside a render', () => {
    expect(() => clockTime('2026-10-16T14:00:00.000Z', { locale: 'en-US', timeZone: 'Mars/Olympus' })).not.toThrow();
  });

  test('small words', () => {
    expect(countWord(3)).toBe('Three');
    expect(countWord(12)).toBe('12');
    expect(evidenceLabel(1)).toBe('1 log entry');
    expect(evidenceLabel(14)).toBe('14 log entries');
    expect(capitalize('tomorrow')).toBe('Tomorrow');
  });

  test('keepUnits keeps a number with its unit, and nothing else', () => {
    expect(keepUnits('Its Wi-Fi signal is weak, at -82 dBm. Moving it closer helps.')).toBe('Its Wi-Fi signal is weak, at -82\u00a0dBm. Moving it closer helps.');
    expect(keepUnits('120 V and 60 W, 5 GHz')).toBe('120\u00a0V and 60\u00a0W, 5\u00a0GHz');
    expect(keepUnits('9 times today, 14 Watts of nothing, 3 Wi-Fi plugs')).toBe('9 times today, 14 Watts of nothing, 3 Wi-Fi plugs');
    expect(keepTogether('dropped off Wi-Fi at -82 dBm')).toBe('dropped off Wi\u2011Fi at -82\u00a0dBm');
  });

  test('keepDates keeps day and month together, in either order', () => {
    expect(keepDates('The old copy, offline since 3 October, is retired.')).toBe('The old copy, offline since 3\u00a0October, is retired.');
    expect(keepDates('went offline on October 3. May I fix it? 12 Mayflies')).toBe('went offline on October\u00a03. May I fix it? 12 Mayflies');
  });

  test('keepHyphens only binds short hyphenated words', () => {
    expect(keepHyphens('dropped off Wi-Fi 9 times')).toBe('dropped off Wi‑Fi 9 times');
    expect(keepHyphens('a plug-in repeater at -82 dBm')).toBe('a plug-in repeater at -82 dBm');
  });
});
