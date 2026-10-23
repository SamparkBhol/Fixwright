// parseYesNo: reads a person's spoken reply to a yes or no question, in English, romanized Hindi or
// Devanagari. People are noisy sensors, so anything contradictory or hedged comes back 'unclear'
// and the caller asks once more with a clearer question.

export type YesNo = 'yes' | 'no' | 'unclear';

export interface ParseYesNoOptions {
  /**
   * The question asks for permission ("Want me to fix that?") rather than an observation
   * ("Did it blink?"). Then "okay", "go ahead" and "theek hai" also count as yes.
   */
  consent?: boolean;
}

type Phrase = readonly string[];
const phrases = (list: readonly string[]): Phrase[] =>
  list.map((p) => p.split(' ')).sort((a, b) => b.length - a.length);

/** Plain affirmations. */
const AFFIRM = phrases([
  'yes', 'yeah', 'yea', 'yep', 'yup', 'ya', 'yah', 'yas', 'sure', 'correct', 'affirmative', 'definitely',
  'thats right', 'it did', 'i did', 'yes it did', 'uh huh', 'mhm', 'mm hmm',
  'haan', 'haa', 'ha', 'han', 'hn', 'haanji', 'haan ji', 'ji haan', 'ji ha', 'bilkul',
  'हां', // हाँ normalizes to this
  'हा',
  'जी हां',
  'बिल्कुल',
]);

/** Observations that mean the probe worked: it blinked, clicked, is running. Negatable. */
const OBSERVE = phrases([
  'blinked', 'blinks', 'blinking', 'blink', 'it blinked', 'flashed', 'flashes', 'flashing', 'flickered',
  'flickering', 'lit up', 'came on', 'turned on', 'its on', 'it is on', 'clicked', 'click', 'heard it', 'i heard',
  'saw it', 'i saw', 'running', 'its running', 'working', 'it works',
  'jal raha hai', 'jal rahi hai', 'jal raha', 'jal gaya', 'jal gayi', 'jala', 'jali', 'chal raha hai',
  'chal rahi hai', 'chal raha', 'chalu hai', 'chalu', 'hua', 'ho gaya', 'dikha', 'dikhai diya', 'blink hua',
  'blink kiya',
  'जल रहा है',
  'जल गया',
  'जला',
  'चल रहा है',
  'चालू है',
  'हुआ',
  'दिखा',
]);

/** Respect particles: yes on their own, ignored next to a negation ("ji nahi" is no). */
const WEAK_AFFIRM = phrases(['ji', 'जी' /* जी */]);

/** Extra yeses that only make sense as permission. */
const CONSENT = phrases([
  'ok', 'okay', 'go ahead', 'do it', 'please do', 'yes please', 'fix it', 'theek hai', 'thik hai', 'kar do',
  'kardo', 'ठीक है' /* ठीक है */, 'कर दो' /* कर दो */,
]);

/** Negation words. A negation right before an observation or a permission negates it. */
const NEGATIONS = new Set([
  'no', 'nope', 'nah', 'nay', 'not', 'never', 'nothing', 'none', 'didnt', 'doesnt', 'dont', 'isnt', 'wasnt',
  'werent', 'arent', 'cant', 'couldnt', 'wont', 'havent', 'hasnt', 'hadnt',
  'nahi', 'nahin', 'nahiin', 'nai', 'nhi', 'band',
  'नहीं',
  'नही',
  'बंद',
]);

/** Hindi negations that also follow the verb: "jala nahi", "blink nahi hua". */
const TRAILING_NEGATIONS = new Set(['nahi', 'nahin', 'nahiin', 'nai', 'nhi', 'नहीं', 'नही']);

/** "na" is no only when it opens the reply; at the end it is a tag ("jal raha hai na"). */
const LEADING_ONLY_NEGATIONS = new Set(['na', 'ना' /* ना */]);

const NO_PHRASES = phrases(['uh uh', 'nuh uh', 'still off', 'band hai']);

/** Hedges and nonanswers. Any of these makes the reply unclear, whatever else it says. */
const UNCLEAR = phrases([
  'not sure', 'dont know', 'no idea', 'maybe', 'perhaps', 'i think so', 'i guess', 'cant tell', 'hard to say',
  'kind of', 'sort of', 'not really sure', 'pata nahi', 'pata nahin', 'maloom nahi', 'malum nahi', 'shayad',
  'ho sakta hai',
  'पता नहीं',
  'शायद',
]);

/** Replies that are only a request to repeat. */
const UNCLEAR_WHOLE = new Set(['what', 'huh', 'pardon', 'sorry', 'come again', 'kya', 'kya bola', 'क्या' /* क्या */]);

const AUX_NOT: Readonly<Record<string, string>> = { will: 'wont', can: 'cant', shall: 'shant' };

/** Lower case, strip punctuation and apostrophes, merge "did not" into "didnt", squeeze "yesss". */
export function normalizeAnswer(answer: string): string[] {
  let s = String(answer ?? '').normalize('NFC').toLowerCase();
  s = s.replace(/ँ/g, 'ं'); // chandrabindu to anusvara: हाँ and हां read the same
  s = s.replace(/[‘’ʼ`´']/g, '');
  s = s.replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ');
  s = s.replace(/(\p{L})\1{2,}/gu, '$1');
  s = s.replace(/\bcannot\b/g, 'cant');
  s = s.replace(
    /\b(did|does|do|is|was|were|are|has|have|had|could|would|should|can|will|shall)\s+not\b/g,
    (_m, aux: string) => AUX_NOT[aux] ?? `${aux}nt`,
  );
  return s.split(/\s+/).filter(Boolean);
}

interface Span {
  start: number;
  end: number;
}

function findAll(tokens: readonly string[], list: readonly Phrase[]): Span[] {
  const spans: Span[] = [];
  for (const phrase of list) {
    for (let i = 0; i + phrase.length <= tokens.length; i++) {
      if (phrase.every((w, j) => tokens[i + j] === w)) spans.push({ start: i, end: i + phrase.length });
    }
  }
  return spans;
}

export function parseYesNo(answer: string, options: ParseYesNoOptions = {}): YesNo {
  const tokens = normalizeAnswer(answer);
  if (tokens.length === 0) return 'unclear';
  if (UNCLEAR_WHOLE.has(tokens.join(' '))) return 'unclear';
  if (findAll(tokens, UNCLEAR).length > 0) return 'unclear';

  const isNegation = (i: number): boolean => {
    const t = tokens[i];
    if (t === undefined) return false;
    return NEGATIONS.has(t) || (i === 0 && LEADING_ONLY_NEGATIONS.has(t));
  };

  // Observations and permissions can be negated in place: "didnt blink", "nahi jala", "dont do it".
  const negated = new Set<number>();
  const observations = findAll(tokens, OBSERVE);
  const consents = options.consent ? findAll(tokens, CONSENT) : [];
  for (const s of [...observations, ...consents]) {
    const before = isNegation(s.start - 1);
    const after = TRAILING_NEGATIONS.has(tokens[s.end] ?? '');
    if (before || after) for (let i = s.start; i < s.end; i++) negated.add(i);
  }

  const hasNo = tokens.some((_t, i) => isNegation(i)) || findAll(tokens, NO_PHRASES).length > 0;
  const affirmations = [
    ...findAll(tokens, AFFIRM),
    ...consents,
    ...observations,
    ...(hasNo ? [] : findAll(tokens, WEAK_AFFIRM)),
  ];
  const hasYes = affirmations.some((s) => !rangeTouches(s, negated));

  if (hasNo && hasYes) return 'unclear';
  if (hasNo) return 'no';
  if (hasYes) return 'yes';
  return 'unclear';
}

function rangeTouches(span: Span, marked: ReadonlySet<number>): boolean {
  for (let i = span.start; i < span.end; i++) if (marked.has(i)) return true;
  return false;
}
