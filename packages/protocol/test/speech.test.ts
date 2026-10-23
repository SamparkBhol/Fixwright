import { describe, expect, it } from 'vitest';
import {
  MAX_SPEECH_WORDS,
  countWords,
  estimateSpeechSeconds,
  isSpeechSafe,
  speechProblems,
  speechSafe,
} from '../src/index.ts';

const GOLDEN_LINES = [
  "I'll flash the hallway lamp twice. Did it blink?",
  'The lamp works. The name Hallway Lamp still points at an old copy of it that went offline on October 3.',
  'Power came back at 3:12. Fourteen devices restarted within four seconds. None of your automations fired.',
  "That strip runs the aquarium filter, which you marked protected. I'll turn off the lamp on it instead.",
  'Hall motion sensor battery at 6%. Kitchen plug dropped off Wi-Fi 9 times today.',
  'हाँ, लैंप ठीक है। मैं इसे कल सुबह फिर जाँचूँगा।',
];

describe('speechSafe', () => {
  it.each(GOLDEN_LINES)('leaves clean speech untouched: %s', (line) => {
    expect(speechSafe(line)).toBe(line);
    expect(speechProblems(line)).toEqual([]);
  });

  it.each<[string, string]>([
    ['Hub: ok | Signal: ok | Cloud: ok', 'Hub: ok, Signal: ok, Cloud: ok'],
    ['The **lamp** _works_.', 'The lamp works.'],
    ['<speak>The lamp <b>works</b>.</speak>', 'The lamp works.'],
    ['light.hallway_lamp is offline.', 'hallway lamp is offline.'],
    ['Saved as pln_01m50980d03sy1gk7c. Say yes to apply.', 'Saved as. Say yes to apply.'],
    ['Next I will call repair_plan for you.', 'Next I will call for you.'],
    ['Done {"state":"applied","steps":[1,2]} and checked.', 'Done and checked.'],
    ['Read more at https://example.com/fix?id=1 today.', 'Read more at today.'],
    ['See [the guide](https://example.com) first.', 'See the guide first.'],
    ['Power came back \u2014 fourteen devices restarted.', 'Power came back, fourteen devices restarted.'],
    ['All fixed ✅ 🎉', 'All fixed'],
    ['# Fixed\n- renamed the lamp\n- retired the old copy', 'Fixed. renamed the lamp. retired the old copy.'],
    ['  Too    many   spaces .  ', 'Too many spaces.'],
    ['power_on_behavior is on', 'power on behavior is on'],
    ['Tom &amp; Jerry', 'Tom & Jerry'],
  ])('%j becomes %j', (input, expected) => {
    expect(speechSafe(input)).toBe(expected);
    expect(speechProblems(speechSafe(input))).toEqual([]);
  });

  it('keeps whole sentences and stays under 30 seconds', () => {
    const sentence = 'The hallway lamp answered every command overnight without a single miss.'; // 11 words
    const long = Array.from({ length: 10 }, () => sentence).join(' ');
    const out = speechSafe(long);
    expect(countWords(out)).toBeLessThanOrEqual(MAX_SPEECH_WORDS);
    expect(countWords(out)).toBe(66);
    expect(out.endsWith('without a single miss.')).toBe(true);
    expect(estimateSpeechSeconds(out)).toBeLessThan(30);
  });

  it('does not split sentences inside "3 a.m." or "3.5"', () => {
    const lead = 'At 3 a.m. last night the power blinked and 2.5 seconds later fourteen devices came back on together.';
    const filler = Array.from({ length: 8 }, () => 'Every one of them restarted on its own.').join(' ');
    const out = speechSafe(`${lead} ${filler}`);
    expect(out.startsWith(lead)).toBe(true);
    expect(isSpeechSafe(out)).toBe(true);
  });

  it('cuts one endless sentence at a clause, never inside a time like 3:12', () => {
    const endless = `Power came back at 3:12, ${Array.from({ length: 40 }, (_, i) => `device ${i} restarted`).join(' and ')}`;
    const out = speechSafe(endless);
    expect(countWords(out)).toBeLessThanOrEqual(MAX_SPEECH_WORDS);
    expect(out.endsWith('.')).toBe(true);
    expect(out).toContain('3:12');
  });

  it('is idempotent', () => {
    const inputs = [
      ...GOLDEN_LINES,
      'Hub: ok | Signal: ok',
      '# Fixed\n- renamed light.hallway_lamp_2\n- retired dx_01m50980d03sy1gk7c',
      Array.from({ length: 30 }, () => 'Fourteen devices restarted within four seconds.').join(' '),
      'Done \u2014 really {"a":[1,{"b":2}]} done',
    ];
    for (const input of inputs) {
      const once = speechSafe(input);
      expect(speechSafe(once), input).toBe(once);
    }
  });
});

describe('speechProblems', () => {
  it('names every broken rule', () => {
    expect(speechProblems('')).toEqual(['is empty']);
    expect(speechProblems(' Hi')).toEqual(['has extra whitespace']);
    expect(speechProblems('Line one.\nLine two.')).toContain('has line breaks');
    expect(speechProblems('a | b')).toEqual(['has a pipe']);
    expect(speechProblems('Say <b>yes</b>.')).toEqual(['has markup']);
    expect(speechProblems('Values [1, 2].')).toEqual(['has brackets or JSON']);
    expect(speechProblems('Ref dx_01m50980d03sy1gk7c.')).toEqual(expect.arrayContaining(['has an id']));
    expect(speechProblems('Ask light.lamp now.')).toEqual(['has an entity id']);
    expect(speechProblems('Use undo or repair_status.')).toEqual(expect.arrayContaining(['has a tool name']));
    expect(speechProblems('See www.example.com now.')).toEqual(['has a link']);
    expect(speechProblems('Done \u2014 fixed.')).toEqual(['has a long dash']);
    expect(speechProblems('Done 🎉')).toEqual(['has emoji']);
    expect(speechProblems('word '.repeat(75).trim())[0]).toMatch(/^is too long \(75 words, about 30 s\)$/);
  });

  it('allows exactly MAX_SPEECH_WORDS words, which is 29.6 seconds', () => {
    expect(MAX_SPEECH_WORDS).toBe(74);
    expect(isSpeechSafe('word '.repeat(74).trim())).toBe(true);
    expect(estimateSpeechSeconds('word '.repeat(74).trim())).toBeCloseTo(29.6);
  });

  it('allows normal punctuation people hear: times, percents, hyphens, apostrophes', () => {
    expect(speechProblems("It's 3:12, battery at 6%, Wi-Fi plug, 9 times.")).toEqual([]);
  });
});
