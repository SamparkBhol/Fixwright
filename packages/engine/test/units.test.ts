// Unit tests for the pieces under the tools: target resolution, time windows, household time, the
// Bayes helpers and human reliability.

import { describe, expect, it, vi } from 'vitest';
import { seededRng } from '@fixwright/protocol';
import {
  answerLikelihood,
  auditHumanAnswers,
  bayesUpdate,
  classifySymptom,
  defaultSettings,
  devicePhrase,
  entropy,
  expectedInfoGain,
  houseView,
  inQuietHours,
  isCopyName,
  localTime,
  needsMeridiem,
  nextLocalTime,
  normalize,
  parseTimeWindow,
  priorFor,
  timeWindowCandidates,
  withoutTimes,
  phrase,
  probeScore,
  resolveTarget,
  sincePhrase,
  updateHumanReliability,
  answerDiagnosis,
  startDiagnosis,
  warmUp,
} from '../src/index.ts';
import { buildGoldenHouse, NOW, rig, TZ } from './support/golden-house.ts';

const house = houseView([...buildGoldenHouse().entities.values()]);
const nowMs = Date.parse(NOW);

describe('target resolution', () => {
  it.each([
    ["why the hallway lamp keeps saying it's not responding", 'light.hallway_lamp'],
    ['the HALLWAY LAMP is dead', 'light.hallway_lamp'],
    ['the hallway lmap wont turn on', 'light.hallway_lamp'],
    ['the lamp in the hallway', 'light.hallway_lamp'],
    ['the hallway light is offline', 'light.hallway_lamp'],
    ["the kitchen plug isn't working", 'switch.kitchen_plug'],
    ['my kitchen socket keeps dropping', 'switch.kitchen_plug'],
    ['the living room power strip', 'switch.living_room_power_strip'],
    ['the reading lamp', 'switch.living_room_power_strip_outlet_1'],
  ])('%s resolves to %s', (text, id) => {
    expect(resolveTarget(house, text).primary?.entityId).toBe(id);
  });

  it('groups copies of the spoken name, the plain entity first', () => {
    const m = resolveTarget(house, 'hallway lamp');
    expect(m.group.map((e) => e.entityId)).toEqual(['light.hallway_lamp', 'light.hallway_lamp_2']);
    expect(m.name).toBe('Hallway Lamp');
  });

  it('prefers the device the person named over the symptom', () => {
    expect(resolveTarget(house, 'it keeps saying not responding', 'kitchen plug').primary?.entityId).toBe('switch.kitchen_plug');
  });

  it('falls back to guided mode with the person\'s own words', () => {
    expect(resolveTarget(house, 'my garage door opener keeps beeping')).toMatchObject({ guided: true, name: 'garage door opener', group: [] });
    expect(devicePhrase('the bathroom fan stopped working')).toBe('bathroom fan');
  });

  it('refuses to guess between differently named devices', () => {
    expect(() => resolveTarget(house, 'the lamp')).toThrow(/could be/);
  });

  it('knows copy names from different devices', () => {
    expect(isCopyName('Hallway Lamp', 'Hallway Lamp 2')).toBe(true);
    expect(isCopyName('hallway lamp', 'Hallway  Lamp!')).toBe(true);
    expect(isCopyName('Lamp 1', 'Lamp 2')).toBe(false);
    expect(isCopyName('Hallway Lamp', 'Hallway Lamp Shade')).toBe(false);
  });

  it.each([
    ["keeps saying it's not responding", 'unresponsive'],
    ['turned on by itself at night', 'unexpected_on'],
    ['the wrong light turns on', 'wrong_device'],
    ["my routine didn't run", 'automation'],
    ['the lamp is weird', 'unknown'],
  ] as const)('classifies "%s" as %s', (text, cls) => {
    expect(classifySymptom(text)).toBe(cls);
  });
});

describe('time windows', () => {
  const local = (ms: number) => localTime(ms, TZ);
  const win = (q: string, at = nowMs) => parseTimeWindow(q, at, TZ);

  it('"at 3 a.m." is the last 03:00 to 03:59 household hour', () => {
    const w = win('why did every plug turn on at 3 a.m.?');
    expect(w && [local(w.sinceMs), local(w.untilMs)]).toEqual([
      { year: 2026, month: 10, day: 15, hour: 3, minute: 0, second: 0 },
      { year: 2026, month: 10, day: 15, hour: 3, minute: 59, second: 59 },
    ]);
    expect(w && needsMeridiem(w, TZ)).toBe(false);
  });

  it('takes yesterday when the hour has not come yet today', () => {
    const w = win('what happened at 11 pm');
    expect(w && local(w.sinceMs)).toMatchObject({ day: 14, hour: 23 });
  });

  it('"last night" is 18:00 to 08:00, or up to now before 8', () => {
    const w = win('why did the lights come on last night');
    expect(w && [local(w.sinceMs).hour, local(w.sinceMs).day, local(w.untilMs).hour, local(w.untilMs).day]).toEqual([18, 14, 7, 15]);
    expect(w && needsMeridiem(w, TZ)).toBe(true);
    const early = win('last night', Date.parse('2026-10-15T12:00:00.000Z'));
    expect(early?.untilMs).toBe(Date.parse('2026-10-15T12:00:00.000Z'));
  });

  it.each([
    ['this morning', 5, 15],
    ['yesterday', 0, 14],
    ['today', 0, 15],
    ['kal raat 3 baje', 3, 15],
    ['around 3:15', 3, 15],
  ])('%s starts at %i:00 on the %ith', (q, hour, day) => {
    const w = win(q);
    expect(w && local(w.sinceMs)).toMatchObject({ hour, day });
  });

  it('reads "in the last hour" and similar spans up to now', () => {
    expect(win('what happened in the last hour')).toEqual({ sinceMs: nowMs - 3_600_000, untilMs: nowMs, label: 'in the last hour' });
    expect(win('anything odd over the past 30 minutes')).toEqual({ sinceMs: nowMs - 30 * 60_000, untilMs: nowMs, label: 'in the last 30 minutes' });
    expect(win('the last couple of hours')).toMatchObject({ sinceMs: nowMs - 2 * 3_600_000, label: 'in the last 2 hours' });
    expect(win('in the last day')).toMatchObject({ sinceMs: nowMs - 86_400_000 });
    // Capped at a week, and "last night" is still the night.
    expect(win('in the last 90 days')?.sinceMs).toBe(nowMs - 7 * 86_400_000);
    expect(win('last night')?.label).toBe('last night');
  });

  it('"at 3" with no a.m. or p.m. offers both 3 o\'clocks, most recent first', () => {
    // 15:30 household time: 3 p.m. today, then 3 a.m. today.
    const at1530 = Date.parse('2026-10-15T22:30:00.000Z');
    const c = timeWindowCandidates('why did every plug turn on at 3?', at1530, TZ);
    const days = (ws: { sinceMs: number }[]) => ws.map((w) => [local(w.sinceMs).day, local(w.sinceMs).hour]);
    // Every 3 o'clock of the last 48 hours: 3 p.m. today, 3 a.m. today, then both of yesterday's.
    expect(days(c)).toEqual([
      [15, 15],
      [15, 3],
      [14, 15],
      [14, 3],
    ]);
    // 10:20: 3 a.m. today, then 3 p.m. yesterday, and so on back 48 hours. parseTimeWindow keeps the most recent.
    expect(timeWindowCandidates('at 3', nowMs, TZ).map((w) => local(w.sinceMs).hour)).toEqual([3, 15, 3, 15]);
    expect(win('at 3') && local((win('at 3') as { sinceMs: number }).sinceMs).hour).toBe(3);
    // "last night" settles the day: one window.
    expect(timeWindowCandidates('at 3 last night', at1530, TZ)).toHaveLength(1);
  });

  it('"at 3 a.m." offers every 3 a.m. of the last 48 hours, so the next morning still finds the night before', () => {
    const at1530 = Date.parse('2026-10-15T22:30:00.000Z');
    const days = (ws: { sinceMs: number }[]) => ws.map((w) => [local(w.sinceMs).day, local(w.sinceMs).hour]);
    expect(days(timeWindowCandidates('at 3 a.m.', at1530, TZ))).toEqual([
      [15, 3],
      [14, 3],
    ]);
    // 07:00 on 16 October, after the morning jump: the night just past first, then the night of the outage.
    const next7am = Date.parse('2026-10-16T14:00:00.000Z');
    expect(days(timeWindowCandidates('Why did every plug turn on at 3 a.m.?', next7am, TZ))).toEqual([
      [16, 3],
      [15, 3],
    ]);
    // Nothing older than 48 hours: at 02:00 on 16 October, 3 a.m. on 14 October is 47 hours back, 13 October is not.
    const at0200 = Date.parse('2026-10-16T09:00:00.000Z');
    expect(days(timeWindowCandidates('at 3 a.m.', at0200, TZ))).toEqual([
      [15, 3],
      [14, 3],
    ]);
    // A day in the question settles it.
    expect(days(timeWindowCandidates('yesterday at 3 a.m.', next7am, TZ))).toEqual([[15, 3]]);
    expect(days(timeWindowCandidates('what happened today at 3', at1530, TZ))).toEqual([
      [15, 15],
      [15, 3],
    ]);
    expect(timeWindowCandidates('at 3 a.m. last night', next7am, TZ)).toHaveLength(1);
    // parseTimeWindow still reads the most recent one.
    expect(local((parseTimeWindow('at 3 a.m.', next7am, TZ) as { sinceMs: number }).sinceMs)).toMatchObject({ day: 16, hour: 3 });
  });

  it('reads "an hour ago" and ignores counts that are not times', () => {
    const w = win('the fan went off an hour ago');
    expect(w && w.sinceMs < nowMs - 3_600_000 && w.untilMs > nowMs - 3_600_000).toBe(true);
    expect(win('it dropped off 9 times')).toBeNull();
    expect(win('why is the lamp at 30%')).toBeNull();
  });

  it('takes out only real time expressions, so a number in a device name stays', () => {
    expect(withoutTimes('Why did plug 3 turn on?')).toBe('why did plug 3 turn on');
    expect(withoutTimes('why did plug 3 turn on at 3 am?')).toBe('why did plug 3 turn on');
    expect(withoutTimes('why did lamp 2 come on at 3:12 a.m.')).toBe('why did lamp 2 come on');
    expect(withoutTimes('why did lamp 2 come on in the last 2 hours')).toBe('why did lamp 2 come on in the');
    expect(withoutTimes('plug 3 kal raat 3 baje kyun on hua')).toBe('plug 3 kal raat kyun on hua');
    // Numbered names: Hallway Lamp 2, Plug 3, Outlet 12, with and without a time next to them.
    expect(withoutTimes('Why did Outlet 12 turn on?')).toBe('why did outlet 12 turn on');
    expect(withoutTimes('why did outlet 12 turn on at 12?')).toBe('why did outlet 12 turn on');
    expect(withoutTimes('why did outlet 12 turn on at 12:05 pm')).toBe('why did outlet 12 turn on');
    expect(withoutTimes('why did hallway lamp 2 come on 20 minutes ago')).toBe('why did hallway lamp 2 come on');
    expect(withoutTimes('why did hallway lamp 2 come on at 2')).toBe('why did hallway lamp 2 come on');
    expect(withoutTimes('why did plug 3 turn on around 3 o\'clock')).toBe('why did plug 3 turn on');
  });
});

describe('spoken names and counts', () => {
  it('says a numbered name without "the"', () => {
    expect(phrase('guide_power', { name: 'plug 3', check: false })).toBe('Switch plug 3 back on at the wall.');
    expect(phrase('ex_in_restore', { name: 'plug 3' })).toBe('Plug 3 was one of them.');
    expect(phrase('ex_in_restore', { name: 'hallway lights' })).toBe('The hallway lights were among them.');
    expect(phrase('ex_in_restore', { name: 'porch light' })).toBe('The porch light was one of them.');
    expect(phrase('ex_in_restore', { name: 'glass lamp' })).toBe('The glass lamp was one of them.');
    expect(phrase('ap_next_check', { count: 6, today: true })).toBe("I'll check on them again at 7 this morning.");
    expect(phrase('ap_next_check', { count: 1 })).toBe("I'll check on it again tomorrow morning.");
    expect(phrase('guide_power', { name: 'porch light', check: false })).toBe('Switch the porch light back on at the wall.');
  });

  it('says "both commands" for two, never "all 2"', () => {
    expect(phrase('mc_pass', { name: 'Hallway Lamp', count: 2 })).toBe('Hallway lamp answered both commands it got overnight. Repair confirmed.');
    expect(phrase('mc_fail', { name: 'Hallway Lamp', missed: 2, count: 2 })).toBe("Hallway lamp missed both commands it got overnight. I'll take another look.");
    expect(phrase('mc_pass', { name: 'Hallway Lamp', count: 9 })).toBe('Hallway lamp answered all 9 commands overnight. Repair confirmed.');
  });
});

describe('household time', () => {
  it('knows quiet hours across midnight', () => {
    const q = { start: '22:00', end: '07:00' };
    expect(inQuietHours(Date.parse('2026-10-16T06:30:00.000Z'), TZ, q)).toBe(true); // 23:30
    expect(inQuietHours(Date.parse('2026-10-15T13:59:00.000Z'), TZ, q)).toBe(true); // 06:59
    expect(inQuietHours(Date.parse('2026-10-15T14:00:00.000Z'), TZ, q)).toBe(false); // 07:00
    expect(inQuietHours(nowMs, TZ, q)).toBe(false);
  });

  it('finds the next 07:00, across a daylight saving change too', () => {
    expect(new Date(nextLocalTime(nowMs, TZ, '07:00')).toISOString()).toBe('2026-10-16T14:00:00.000Z');
    expect(new Date(nextLocalTime(Date.parse('2026-11-01T12:00:00.000Z'), TZ, '07:00')).toISOString()).toBe('2026-11-01T15:00:00.000Z');
  });

  it('says since when in plain words', () => {
    expect(sincePhrase(Date.parse('2026-10-03T18:42:10.000Z'), nowMs, TZ)).toBe('since October 3');
    expect(sincePhrase(Date.parse('2026-10-15T08:05:00.000Z'), nowMs, TZ)).toBe('since 1:05 a.m.');
    expect(sincePhrase(Date.parse('2026-10-14T20:00:00.000Z'), nowMs, TZ)).toBe('since yesterday');
  });

  it('rejects a bad time zone or clock up front', () => {
    expect(() => defaultSettings({ tz: 'Mars/Olympus' })).toThrow();
    expect(() => defaultSettings({ quietHours: { start: '25:00', end: '07:00' } })).toThrow();
  });
});

describe('Bayes helpers', () => {
  it('normalises and updates', () => {
    expect(normalize({ a: 2, b: 2 })).toEqual({ a: 0.5, b: 0.5 });
    expect(normalize({ a: 0, b: 0 })).toEqual({ a: 0.5, b: 0.5 });
    const post = bayesUpdate({ a: 0.5, b: 0.5 }, 'x', (h) => (h === 'a' ? 0.9 : 0.1));
    expect(post['a']).toBeCloseTo(0.9, 12);
  });

  it('values a discriminating probe above a useless one', () => {
    const d = { a: 0.5, b: 0.5 };
    const sharp = expectedInfoGain(d, ['x', 'y'], (h, v) => ((h === 'a') === (v === 'x') ? 0.95 : 0.05));
    const flat = expectedInfoGain(d, ['x', 'y'], () => 0.5);
    expect(sharp).toBeGreaterThan(0.5);
    expect(flat).toBeCloseTo(0, 12);
    expect(entropy(d)).toBeCloseTo(1, 12);
  });

  it('scores probes by gain over (1 + 2 x disruption + cost / 2000)', () => {
    expect(probeScore(1, { disruption: 0, costMs: 0 })).toBe(1);
    expect(probeScore(1, { disruption: 1, costMs: 2000 })).toBe(0.25);
  });

  it('treats a human answer as a noisy sensor', () => {
    const rel = { sensitivity: 0.92, specificity: 0.95 };
    expect(answerLikelihood(1, 'yes', rel)).toBeCloseTo(0.92, 12);
    expect(answerLikelihood(0, 'yes', rel)).toBeCloseTo(0.05, 12);
    expect(answerLikelihood(0, 'no', rel)).toBeCloseTo(0.95, 12);
  });

  it('moves household reliability gradually when sensors contradict an answer', () => {
    const start = { sensitivity: 0.92, specificity: 0.95 };
    const missed = updateHumanReliability(start, 'no', true);
    expect(missed.sensitivity).toBeCloseTo((0.92 * 20) / 21, 12);
    expect(missed.positives).toBe(21);
    const right = updateHumanReliability(start, 'no', false);
    expect(right.specificity).toBeCloseTo((0.95 * 20 + 1) / 21, 12);
  });

  it('audits the answers of a diagnosis once the cause is known', async () => {
    const r = rig();
    const dx = await startDiagnosis({ symptom: "the hallway lamp isn't responding" }, r.deps);
    const no = await answerDiagnosis(dx.session, { diagnosis_id: dx.session.diagnosis_id, question_id: dx.output.question?.question_id ?? '', answer: 'no' }, r.deps);
    // The repair later proved the lamp worked, so that "no, it didn't blink" was wrong.
    const audit = auditHumanAnswers(no.session, 'stale_duplicate', r.deps.settings.humanReliability);
    expect(audit.contradicted).toEqual([dx.output.question?.question_id]);
    expect(audit.reliability.sensitivity).toBeLessThan(0.92);
  });

  it('builds priors that sum to 1 and include the catch all', () => {
    const p = priorFor({ primary: house.byId.get('light.hallway_lamp'), guided: false, symptom: 'unresponsive' });
    expect(Object.values(p).reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
    expect(p['unknown']).toBeGreaterThan(0);
    expect(p['wifi_network_changed']).toBeUndefined();
    expect(p['device_power_lost']).toBeGreaterThan(p['stale_duplicate'] ?? 1);
  });

  it('is deterministic for the same seed', async () => {
    const a = await startDiagnosis({ symptom: 'the hallway lamp' }, rig(buildGoldenHouse(), {}, NOW, 3).deps);
    const b = await startDiagnosis({ symptom: 'the hallway lamp' }, rig(buildGoldenHouse(), {}, NOW, 3).deps);
    expect(a.output).toEqual(b.output);
    expect(seededRng(3).next()).toBe(seededRng(3).next());
  });

  it('warms up on its own tiny house without touching anyone else', async () => {
    const r = rig();
    await warmUp(TZ);
    await warmUp();
    expect(r.house.calls).toEqual([]);
    expect(r.ledger.all()).toEqual([]);
  });

  it('warms up with no timers, I/O or random values, which Workers refuse in global scope', async () => {
    const traps = [
      vi.spyOn(globalThis, 'setTimeout'),
      vi.spyOn(globalThis, 'setInterval'),
      vi.spyOn(globalThis, 'fetch'),
      vi.spyOn(globalThis.crypto, 'getRandomValues'),
      vi.spyOn(globalThis.crypto, 'randomUUID'),
      vi.spyOn(Math, 'random'),
      vi.spyOn(Date, 'now'),
    ];
    try {
      await warmUp('Asia/Kolkata');
      for (const t of traps) expect(t).not.toHaveBeenCalled();
    } finally {
      for (const t of traps) t.mockRestore();
    }
  });
});
