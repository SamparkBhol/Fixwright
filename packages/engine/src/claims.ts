// Claim checker. Every factual sentence Fixwright says is a claim citing ledger seqs. A claim
// survives only if each cited event exists and supports it: right entities, right time window, right
// probe values, and (for "none of your automations fired") a ledger that really holds no such event.
// Framing sentences cite nothing and may not state facts about the house. A confirmed verdict that loses
// any factual claim is downgraded to likely.

import { CONFIRM_THRESHOLD, speechProblems, type HouseEvent, type Verdict } from '@fixwright/protocol';
import type { CheckedClaim, ClaimSupport, Ledger, Phraser } from './types.ts';
import { fold, NOUNS, numberWord } from './util/text.ts';

export interface DroppedClaim {
  claim: CheckedClaim;
  reason: string;
}

export interface ClaimCheck {
  kept: CheckedClaim[];
  dropped: DroppedClaim[];
}

export interface ClaimCheckOptions {
  /** Names of things in the house (entities, areas, brands). Framing text may not mention them. */
  houseWords?: readonly string[];
}

const ms = (iso: string): number => Date.parse(iso);

function entityIdsOf(e: HouseEvent): string[] {
  const ids = new Set<string>();
  if (e.entityId) ids.add(e.entityId);
  const listed = e.data?.['entity_ids'];
  if (Array.isArray(listed)) for (const id of listed) if (typeof id === 'string') ids.add(id);
  return [...ids];
}

/** The times an event speaks for: when it happened, and any time it reports (an offline since date). */
function timesOf(e: HouseEvent): number[] {
  const out = [ms(e.ts)];
  for (const key of ['lastChanged', 'offline_since', 'observed_at']) {
    const v = e.data?.[key];
    if (typeof v === 'string' && Number.isFinite(ms(v))) out.push(ms(v));
  }
  return out;
}

const hasContext = (e: HouseEvent): boolean =>
  e.context !== undefined &&
  (e.context.automationId !== undefined || e.context.userId !== undefined || e.context.service !== undefined || e.context.parentSeq !== undefined);

async function supportProblem(events: HouseEvent[], s: ClaimSupport, ledger: Ledger): Promise<string | null> {
  if (s.entityIds) {
    const wanted = new Set(s.entityIds);
    const stray = events.find((e) => !entityIdsOf(e).some((id) => wanted.has(id)));
    if (stray) return `event ${stray.seq} is about a different device`;
  }
  if (s.notAbout) {
    const excluded = new Set(s.notAbout);
    const about = events.find((e) => entityIdsOf(e).some((id) => excluded.has(id)));
    if (about) return `event ${about.seq} is about a device the claim leaves out`;
  }
  if (s.window) {
    const [a, b] = [ms(s.window.since), ms(s.window.until)];
    if (!events.some((e) => timesOf(e).some((t) => t >= a && t <= b))) return 'no cited event falls in the claimed time';
  }
  if (s.allWithin) {
    const [a, b] = [ms(s.allWithin.since), ms(s.allWithin.until)];
    const late = events.find((e) => ms(e.ts) < a || ms(e.ts) > b);
    if (late) return `event ${late.seq} is outside the claimed span`;
  }
  if (s.distinctEntities !== undefined) {
    const n = new Set(events.flatMap((e) => (e.entityId ? [e.entityId] : []))).size;
    if (n !== s.distinctEntities) return `cites ${n} devices, claims ${s.distinctEntities}`;
  }
  for (const pv of s.probeValues ?? []) {
    const ok = events.some((e) => e.data?.['probe_id'] === pv.probe_id && pv.values.includes(String(e.data?.['value'])));
    if (!ok) return `no ${pv.probe_id} result shows ${pv.values.join(' or ')}`;
  }
  if (s.noContext) {
    const caused = events.find((e) => (e.kind === 'state' || e.kind === 'availability') && hasContext(e));
    if (caused) return `event ${caused.seq} was caused by an automation, service or person`;
  }
  if (s.absent) {
    const found = await ledger.query({ since: s.absent.since, until: s.absent.until, kinds: s.absent.kinds });
    const first = found[0];
    if (first) return `the ledger holds a ${first.kind} event (seq ${first.seq})`;
  }
  return null;
}

const MONTHS = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/;
const NUMBER_WORDS = new Set(Array.from({ length: 100 }, (_, i) => numberWord(i)).flatMap((w) => w.split(' ')));
const TIME_WORDS = /\b(today|yesterday|ago|since|last night)\b/;

/** Does a sentence carry facts about the house (numbers, dates, times, names of things in it)? */
export function statesFacts(text: string, houseWords: readonly string[] = []): boolean {
  if (/\d/.test(text)) return true;
  const f = fold(text);
  if (MONTHS.test(f) || TIME_WORDS.test(f)) return true;
  if (f.split(' ').some((w) => NUMBER_WORDS.has(w) && w !== 'one')) return true;
  const padded = ` ${f} `;
  return houseWords.some((w) => {
    const fw = fold(w);
    return fw.length > 0 && padded.includes(` ${fw} `);
  });
}

/** Checks claims against the ledger. Returns the claims that hold and why the others were dropped. */
export async function checkClaims(claims: readonly CheckedClaim[], ledger: Ledger, opts: ClaimCheckOptions = {}): Promise<ClaimCheck> {
  const seqs = [...new Set(claims.flatMap((c) => c.evidence))];
  const found = seqs.length > 0 ? await ledger.query({ seqs }) : [];
  const bySeq = new Map(found.map((e) => [e.seq, e]));
  const kept: CheckedClaim[] = [];
  const dropped: DroppedClaim[] = [];
  for (const claim of claims) {
    if (claim.kind === 'framing') {
      if (claim.evidence.length > 0) dropped.push({ claim, reason: 'framing text cites evidence' });
      else if (statesFacts(claim.text, opts.houseWords)) dropped.push({ claim, reason: 'framing text states a fact about the house' });
      else kept.push(claim);
      continue;
    }
    if (claim.evidence.length === 0) {
      dropped.push({ claim, reason: 'no evidence' });
      continue;
    }
    const missing = claim.evidence.filter((s) => !bySeq.has(s));
    if (missing.length > 0) {
      dropped.push({ claim, reason: `evidence ${missing.join(', ')} is not in the ledger` });
      continue;
    }
    const events = claim.evidence.map((s) => bySeq.get(s) as HouseEvent);
    const problem = claim.support ? await supportProblem(events, claim.support, ledger) : null;
    if (problem) dropped.push({ claim, reason: problem });
    else kept.push(claim);
  }
  return { kept, dropped };
}

export interface CheckedVerdict {
  verdict: Verdict;
  /** The claims that survived, with their support (the verdict itself only carries text and evidence). */
  kept: CheckedClaim[];
  dropped: DroppedClaim[];
}

/**
 * Runs the claim checker over a verdict. Dropped claims leave the verdict; a confirmed verdict that lost
 * a factual claim, has none left, or sits under the threshold becomes likely.
 */
export async function checkVerdict(
  verdict: Verdict,
  claims: readonly CheckedClaim[],
  ledger: Ledger,
  opts: ClaimCheckOptions = {},
): Promise<CheckedVerdict> {
  const { kept, dropped } = await checkClaims(claims, ledger, opts);
  const facts = kept.filter((c) => c.kind === 'fact');
  const lostFact = dropped.some((d) => d.claim.kind === 'fact');
  const level =
    verdict.level === 'confirmed' && (lostFact || facts.length === 0 || verdict.confidence < CONFIRM_THRESHOLD) ? 'likely' : verdict.level;
  return {
    verdict: { ...verdict, level, claims: facts.map((c) => ({ text: c.text, evidence: [...c.evidence] })) },
    kept,
    dropped,
  };
}

/** Plain claims (as in a Verdict) seen as facts, so checkVerdict can take a protocol verdict as is. */
export const asFacts = (claims: readonly { text: string; evidence: number[] }[]): CheckedClaim[] =>
  claims.map((c) => ({ text: c.text, evidence: [...c.evidence], kind: c.evidence.length > 0 ? 'fact' : 'framing' }));

// An optional phraser (an LLM) may restyle a line, never change what it says. The gate is lexical and
// deliberately strict: the rephrased sentence must carry the template's content words in the same order
// (word forms may change: "works", "working"), and may only add or drop the style words below. It must
// also keep the negation, keep a question a question, and add no number, date, quantity, device word or
// name. That rejects meaning reversals ("The lamp works." to "The lamp is broken.", "Power came back" to
// "Power went out") and word order swaps, because both change the content words. Pronouns and the plain
// forms of be, have and do are not content words, so they get their own checks: the same people in the
// same order ("I switched it" may not become "You switched it", "your automations" not "my automations";
// only the implied "you" and a resumptive "it" may be added), and no tense the template lacks ("is
// reachable" may not become "was reachable", "has been" not "had been"; a template with no helper verb
// may gain a present one, "works" to "is working"). It does not understand meaning, so it trades nearly
// all paraphrase freedom for safety: a phraser can add warmth ("So,", "okay"), not new wording.

/** Words a phraser may add or drop: articles, pronouns, plain forms of be, have and do, and fillers. */
const STYLE_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'i', 'im', 'ive', 'me', 'my', 'you', 'youre', 'your', 'it', 'its', 'we', 'us', 'our', 'they', 'theyre', 'them', 'their',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'do', 'does', 'did',
  'so', 'and', 'just', 'also', 'now', 'right', 'here', 'there', 'really', 'still', 'okay', 'ok', 'alright', 'well', 'oh',
  'of', 'to', 'at', 'for', 'with',
]);

/** Folds word forms together: plurals and third person ("lamps", "works") and the ing form ("working"). */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && /(ch|sh|ss|x)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** The words that carry meaning, in order. */
export function contentWords(text: string): string[] {
  const f = fold(text);
  return f === '' ? [] : f.split(' ').filter((w) => !STYLE_WORDS.has(w)).map(stem);
}

const NEGATION = /\b(not|no|none|never|nothing|didnt|doesnt|isnt|wasnt|wont|cant|couldnt|arent|werent|nobody)\b/;

/** Who a pronoun points at: the speaker, the household, the people addressed, a group, a thing. */
const PERSON: Readonly<Record<string, string>> = {
  i: 'i', im: 'i', ive: 'i', ill: 'i', me: 'i', my: 'i', mine: 'i', myself: 'i',
  we: 'we', weve: 'we', us: 'we', our: 'we', ours: 'we',
  you: 'you', youre: 'you', youve: 'you', youll: 'you', your: 'you', yours: 'you', yourself: 'you',
  they: 'they', theyre: 'they', theyve: 'they', them: 'they', their: 'they', theirs: 'they',
  it: 'it', its: 'it', itself: 'it',
};

const PAST_HELPERS: ReadonlySet<string> = new Set(['was', 'were', 'had', 'did', 'wasnt', 'werent', 'hadnt', 'didnt', 'theyd', 'youd']);
const PRESENT_HELPERS: ReadonlySet<string> = new Set([
  'am', 'is', 'are', 'has', 'have', 'do', 'does', 'isnt', 'arent', 'hasnt', 'havent', 'dont', 'doesnt',
  'im', 'ive', 'youre', 'youve', 'theyre', 'theyve', 'weve', 'thats', 'theres', 'heres',
]);

const persons = (text: string): string[] => fold(text).split(' ').flatMap((w) => (PERSON[w] ? [PERSON[w]] : []));

/**
 * The template's pronouns all appear in the rephrase, in order, and the only ones it adds are the implied
 * "you" ("Want me to fix that?" to "Do you want me to fix that?") and a resumptive "it". A swap ("I
 * switched it" to "You switched it", "your automations" to "my automations") fails.
 */
function samePeople(original: string, candidate: string): boolean {
  const want = persons(original);
  let i = 0;
  for (const p of persons(candidate)) {
    if (i < want.length && p === want[i]) i++;
    else if (p !== 'you' && p !== 'it') return false;
  }
  return i === want.length;
}

function tenses(text: string): Set<'past' | 'present'> {
  const out = new Set<'past' | 'present'>();
  for (const w of fold(text).split(' ')) {
    if (PAST_HELPERS.has(w)) out.add('past');
    else if (PRESENT_HELPERS.has(w)) out.add('present');
  }
  return out;
}

/** A tense in the rephrase that the template does not have (a present helper may join a template with none). */
function addsTense(original: string, candidate: string): boolean {
  const had = tenses(original);
  for (const t of tenses(candidate)) if (!had.has(t) && !(t === 'present' && had.size === 0)) return true;
  return false;
}

const QUANTITY = new Set(['all', 'every', 'both', 'several', 'many', 'other', 'others', 'some', 'few', 'each', 'more', 'most', 'again']);
const DEVICE_WORDS = new Set(NOUNS.flatMap((n) => [n, `${n}s`, `${n}es`]));

/** The facts a sentence carries, counted: numbers, months, quantity words, device words and house names. */
function factTokens(text: string, houseWords: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const add = (t: string): void => {
    out.set(t, (out.get(t) ?? 0) + 1);
  };
  for (const m of text.matchAll(/-?\d+(?:[.:]\d+)?%?/g)) add(m[0].replace(/%$/, ''));
  const f = fold(text);
  for (const w of f.split(' ')) {
    if (NUMBER_WORDS.has(w) && w !== 'one') {
      const n = Array.from({ length: 100 }, (_, i) => i).find((i) => numberWord(i) === w);
      add(n === undefined ? w : String(n));
    }
    if (MONTHS.test(w) || QUANTITY.has(w) || DEVICE_WORDS.has(w)) add(w);
  }
  const padded = ` ${f} `;
  for (const hw of houseWords) {
    const fw = fold(hw);
    if (fw && padded.includes(` ${fw} `)) add(`name:${fw}`);
  }
  return out;
}

/**
 * Whether a rephrased line may replace its template line (see the gate notes above): speakable, not much
 * longer, the same content words in the same order, the same negation, the same pronouns in the same order,
 * no added tense, a question only if the template is one, no number, date, quantity, device word or name
 * the template did not have (counted, so "October 3" does not license "3 other lamps"), and (for framing)
 * still no facts.
 */
export function rephraseAllowed(original: CheckedClaim, candidate: string, houseWords: readonly string[] = []): boolean {
  const said = candidate.trim();
  if (said === '' || speechProblems(said).length > 0) return false;
  if (said.split(/\s+/).length > original.text.split(/\s+/).length * 2 + 6) return false;
  if (original.text.trim().endsWith('?') !== said.endsWith('?')) return false;
  if (NEGATION.test(fold(original.text)) !== NEGATION.test(fold(said))) return false;
  const want = contentWords(original.text);
  const got = contentWords(said);
  if (want.length !== got.length || want.some((w, i) => w !== got[i])) return false;
  if (!samePeople(original.text, said) || addsTense(original.text, said)) return false;
  if (original.kind === 'framing') return !statesFacts(said, houseWords);
  const allowed = factTokens(original.text, houseWords);
  for (const [t, n] of factTokens(said, houseWords)) if (n > (allowed.get(t) ?? 0)) return false;
  return true;
}

/**
 * The sentences to speak: the phraser's version of each line where it passes rephraseAllowed, the
 * template text otherwise. A phraser that throws or returns the wrong count is ignored.
 */
export async function phraseLines(lines: readonly CheckedClaim[], phraser: Phraser | undefined, houseWords: readonly string[] = []): Promise<string[]> {
  const templates = lines.map((l) => l.text);
  if (!phraser || lines.length === 0) return templates;
  let out: string[];
  try {
    out = await phraser(lines.map((l) => ({ text: l.text, kind: l.kind, evidence: [...l.evidence] })));
  } catch {
    return templates;
  }
  if (!Array.isArray(out) || out.length !== lines.length) return templates;
  return lines.map((l, i) => {
    const candidate = out[i];
    return typeof candidate === 'string' && rephraseAllowed(l, candidate.trim(), houseWords) ? candidate.trim() : l.text;
  });
}
