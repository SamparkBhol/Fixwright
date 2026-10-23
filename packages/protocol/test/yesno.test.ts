import { describe, expect, it } from 'vitest';
import { normalizeAnswer, parseYesNo, type YesNo } from '../src/index.ts';

const CASES: ReadonlyArray<[answer: string, expected: YesNo]> = [
  // English yes, including the word list and nonvisual answers
  ['yes', 'yes'],
  ['Yes, it blinked.', 'yes'],
  ['YES!!!', 'yes'],
  ['Yesss', 'yes'],
  ['yeah', 'yes'],
  ['Yep', 'yes'],
  ['it did', 'yes'],
  ['It blinked twice', 'yes'],
  ['blinked', 'yes'],
  ['I heard it click', 'yes'],
  ['the fan is running', 'yes'],
  ['uh huh', 'yes'],
  ['sure', 'yes'],
  // Romanized Hindi yes
  ['haan', 'yes'],
  ['ha', 'yes'],
  ['han', 'yes'],
  ['Haaan', 'yes'],
  ['ji', 'yes'],
  ['haan ji', 'yes'],
  ['jal raha hai', 'yes'],
  ['chal raha hai', 'yes'],
  ['jal raha hai na', 'yes'],
  ['blink hua', 'yes'],
  // Devanagari yes
  ['हाँ', 'yes'],
  ['हां', 'yes'],
  ['जी', 'yes'],
  ['हाँ, जल गया।', 'yes'],
  ['जी हां', 'yes'],
  // English no
  ['no', 'no'],
  ['Nope.', 'no'],
  ["didn't", 'no'],
  ['No, it didn’t.', 'no'],
  ['it did not blink', 'no'],
  ["It's not running", 'no'],
  ['nothing happened', 'no'],
  ["I don't think so", 'no'],
  ['uh uh', 'no'],
  ['never blinked', 'no'],
  // Romanized Hindi no
  ['nahi', 'no'],
  ['nahin', 'no'],
  ['na', 'no'],
  ['band hai', 'no'],
  ['nahi jala', 'no'],
  ['jala nahi', 'no'],
  ['blink nahi hua', 'no'],
  ['ji nahi', 'no'],
  // Devanagari no
  ['नहीं', 'no'],
  ['ना', 'no'],
  ['नहीं जला', 'no'],
  ['जी नहीं', 'no'],
  ['बंद है', 'no'],
  // Unclear: hedges, contradictions, nonanswers
  ['', 'unclear'],
  ['   ', 'unclear'],
  ['maybe', 'unclear'],
  ["I'm not sure", 'unclear'],
  ["I don't know", 'unclear'],
  ['pata nahi', 'unclear'],
  ['पता नहीं', 'unclear'],
  ['शायद', 'unclear'],
  ['hmm', 'unclear'],
  ['what?', 'unclear'],
  ['kya', 'unclear'],
  ['yes and no', 'unclear'],
  ['haan nahi', 'unclear'],
  ['no wait yes', 'unclear'],
  ['the cat walked past', 'unclear'],
  ['okay', 'unclear'],
  ['I think so', 'unclear'],
];

describe('parseYesNo', () => {
  it('covers at least 30 cases across English, Hindi and Devanagari', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
    expect(CASES.filter(([a]) => /[ऀ-ॿ]/.test(a)).length).toBeGreaterThanOrEqual(10);
  });

  it.each(CASES)('%j reads as %s', (answer, expected) => {
    expect(parseYesNo(answer)).toBe(expected);
  });

  it('accepts consent words only when the question asks for permission', () => {
    for (const a of ['okay', 'OK', 'go ahead', 'do it', 'theek hai', 'kar do', 'ठीक है', 'yes please']) {
      expect(parseYesNo(a, { consent: true }), a).toBe('yes');
    }
    expect(parseYesNo('okay')).toBe('unclear');
    expect(parseYesNo('no, do not do it', { consent: true })).toBe('no');
    expect(parseYesNo('okay, no, wait', { consent: true })).toBe('unclear');
    expect(parseYesNo("don't", { consent: true })).toBe('no');
  });

  it('reads chandrabindu and anusvara spellings the same', () => {
    expect(normalizeAnswer('हाँ')).toEqual(normalizeAnswer('हां'));
  });

  it('normalizes case, punctuation, curly apostrophes and negative contractions', () => {
    expect(normalizeAnswer('  It DID NOT… blink!! ')).toEqual(['it', 'didnt', 'blink']);
    expect(normalizeAnswer('Didn’t')).toEqual(['didnt']);
    expect(normalizeAnswer('cannot tell')).toEqual(['cant', 'tell']);
  });
});
