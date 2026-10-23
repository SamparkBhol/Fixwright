// From the person's words to entities: "why the hallway lamp keeps saying it's not responding" points to
// light.hallway_lamp (plus any copies sharing its name). Matching folds case and punctuation, accepts
// synonyms (lamp, light, bulb) and one letter typos, and falls back to area plus device words. When
// nothing matches, the diagnosis runs in guided mode on the person's own name for the device.

import type { Entity } from '@fixwright/protocol';
import { engineError } from './errors.ts';
import type { HouseView } from './house.ts';
import { isCopyName, deviceNoun, fold, tokenMatches, tokens } from './util/text.ts';
import type { SymptomClass } from './types.ts';

const SYMPTOM_PATTERNS: ReadonlyArray<[SymptomClass, RegExp]> = [
  ['automation', /\b(automation|routine|schedule|scene|didnt run|did not run|doesnt run|never ran|not triggering|doesnt trigger|didnt trigger)\b/],
  ['wrong_device', /\b(wrong (light|lamp|one|device|plug)|other (light|lamp|one)|both (lights|lamps)|two (lights|lamps|devices)|instead of)\b/],
  ['unexpected_on', /\b(by itself|on its own|randomly|in the middle of the night|apne aap)\b/],
  // "won't turn on" is a device ignoring a command, not one switching on by itself: checked before "turns on".
  ['unresponsive', /\b(wont|will not|doesnt|does not|didnt|did not|cant|cannot|can not|isnt|is not|not) (turn|turning|switch|switching|come|coming) (on|off)\b/],
  ['unexpected_on', /\b(turns? on|turned on|came on|comes on|switch(es|ed)? on|keeps? turning on)\b/],
  [
    'unresponsive',
    /\b(not responding|unresponsive|isnt responding|no response|(doesnt|does not|didnt|did not|wont|will not) respond|offline|unavailable|doesnt work|not working|wont (turn|switch|respond|work)|cant (turn|control|reach)|stopped working|dead|disconnected|keeps dropping|drops off|isnt working|nahi chal|kaam nahi|band ho)\b/,
  ],
];

export function classifySymptom(text: string): SymptomClass {
  const f = fold(text);
  for (const [cls, re] of SYMPTOM_PATTERNS) if (re.test(f)) return cls;
  return 'unknown';
}

const STOP_AFTER = /\b(keeps|keep|is|isnt|was|wont|will|doesnt|does|did|didnt|has|hasnt|went|goes|turned|turns|turning|says|saying|stopped|cant|not|always|never|just|wasnt|randomly|came|comes|wouldnt)\b/;

/** The person's own name for the device, for guided mode: "my garage heater keeps tripping" gives "garage heater". */
export function devicePhrase(text: string): string {
  const f = fold(text);
  const m = /\b(?:the|my|our|a|an)\s+(.+)$/.exec(f);
  let rest = m?.[1] ?? f;
  const stop = STOP_AFTER.exec(rest);
  if (stop) rest = rest.slice(0, stop.index);
  const words = rest.trim().split(' ').filter(Boolean).slice(0, 4);
  return words.length > 0 ? words.join(' ') : 'device';
}

export interface TargetMatch {
  /** The entity the spoken name points at. */
  primary?: Entity;
  /** Every live entity sharing that spoken name (the primary first), including "Name 2" copies. */
  group: Entity[];
  name: string;
  guided: boolean;
  score: number;
}

const MATCH_THRESHOLD = 0.6;

function nameScore(name: string, text: string[]): number {
  const words = tokens(name);
  if (words.length === 0) return 0;
  let matched = 0;
  for (const w of words) if (text.some((t) => tokenMatches(w, t))) matched++;
  const coverage = matched / words.length;
  const phrase = ` ${text.join(' ')} `.includes(` ${words.join(' ')} `) ? 0.15 : 0;
  // Longer names that are fully present beat shorter ones ("Living Room Light" over "Light").
  return coverage + phrase + (coverage === 1 ? Math.min(words.length, 5) * 0.02 : 0);
}

function areaScore(e: Entity, text: string[]): number {
  if (!e.area) return 0;
  const area = tokens(e.area);
  if (area.length === 0 || !area.every((a) => text.some((t) => tokenMatches(a, t)))) return 0;
  const noun = deviceNoun(e);
  return text.some((t) => tokenMatches(noun, t)) ? 0.75 : 0;
}

function entityScore(e: Entity, text: string[]): number {
  return Math.max(nameScore(e.name, text), ...e.aliases.map((a) => nameScore(a, text)), areaScore(e, text));
}

/** Entities a person might mean by a device name: no config selects, diagnostics or disabled entries. */
function candidates(house: HouseView, includeAutomations: boolean): Entity[] {
  return house.live.filter((e) => {
    if (e.domain === 'automation') return includeAutomations;
    return !['select', 'number', 'button', 'update', 'input_boolean', 'input_select', 'script', 'scene', 'zone', 'person'].includes(e.domain);
  });
}

/** Of several copies, the one the name points at: the plain entity id first, then the offline one. */
function pickPrimary(group: Entity[]): Entity | undefined {
  return [...group].sort((a, b) => {
    const suffix = (e: Entity): number => (/_\d+$/.test(e.entityId) ? 1 : 0);
    return suffix(a) - suffix(b) || Number(b.state === 'unavailable') - Number(a.state === 'unavailable') || a.entityId.localeCompare(b.entityId);
  })[0];
}

/** "the thermostat" with one thermostat in the house: match on the device word alone. */
function nounOnlyMatch(pool: Entity[], words: string[], text: string): { e: Entity; score: number } | undefined {
  const hits = pool.filter((e) => {
    const noun = deviceNoun(e);
    return noun !== 'device' && words.some((t) => tokenMatches(noun, t));
  });
  const names = new Set(hits.map((e) => fold(e.name).replace(/ \d+$/, '')));
  if (names.size > 1) throw engineError('ambiguous_device', `"${text}" could be ${hits.map((e) => e.entityId).join(', ')}`);
  const e = hits[0];
  return e ? { e, score: MATCH_THRESHOLD } : undefined;
}

/**
 * Resolves the device from `device` (when the person named one) or the symptom text. Throws
 * ambiguous_device when two differently named devices match equally well.
 */
export function resolveTarget(house: HouseView, symptom: string, device?: string): TargetMatch {
  const text = device ?? symptom;
  const words = tokens(text);
  const automation = classifySymptom(symptom) === 'automation';
  const scored = candidates(house, automation || words.includes('automation'))
    .map((e) => ({ e, score: entityScore(e, words) }))
    .filter((s) => s.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.e.entityId.localeCompare(b.e.entityId));
  const best = scored[0] ?? nounOnlyMatch(candidates(house, false), words, text);
  if (!best) return { group: [], name: devicePhrase(text), guided: true, score: 0 };

  const rivals = scored.filter((s) => s.score >= best.score - 0.05 && !isCopyName(s.e.name, best.e.name));
  if (rivals.length > 0) {
    throw engineError('ambiguous_device', `"${text}" matches ${[best.e, ...rivals.map((r) => r.e)].map((e) => e.entityId).join(', ')}`);
  }
  const group = house.live.filter(
    (e) => e.domain === best.e.domain && (isCopyName(e.name, best.e.name) || e.aliases.some((a) => fold(a) === fold(best.e.name))),
  );
  const primary = pickPrimary(group) ?? best.e;
  const ordered = [primary, ...group.filter((e) => e !== primary)];
  const name = fold(primary.name) === fold(best.e.name) ? primary.name : best.e.name;
  return { primary, group: ordered, name, guided: false, score: best.score };
}
