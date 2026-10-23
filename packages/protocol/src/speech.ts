// Speech rules for OutputBase.speech: one spoken reply, under 30 seconds, no markup, pipes, ids,
// tool names or JSON. speechProblems() checks a string; speechSafe() repairs one.

import { TOOL_NAMES } from './names.ts';
import { ID_PREFIXES } from './ids.ts';

export const SPEECH_WORDS_PER_SECOND = 2.5;
export const MAX_SPEECH_SECONDS = 30;
/** 74 words at 2.5 words per second is 29.6 s, the most that stays under 30 s. */
export const MAX_SPEECH_WORDS = Math.ceil(MAX_SPEECH_SECONDS * SPEECH_WORDS_PER_SECOND) - 1;

// Home Assistant domains, so "light.hallway_lamp" is caught but "3.5" or "e.g." are not.
const ENTITY_DOMAINS = [
  'alarm_control_panel', 'automation', 'binary_sensor', 'button', 'calendar', 'camera', 'climate', 'counter',
  'cover', 'date', 'datetime', 'device_tracker', 'event', 'fan', 'group', 'humidifier', 'image', 'input_boolean',
  'input_button', 'input_datetime', 'input_number', 'input_select', 'input_text', 'lawn_mower', 'light', 'lock',
  'media_player', 'notify', 'number', 'person', 'remote', 'scene', 'script', 'select', 'sensor', 'siren',
  'switch', 'text', 'time', 'timer', 'todo', 'update', 'vacuum', 'valve', 'water_heater', 'weather', 'zone',
];
const ENTITY_ID_RE = new RegExp(`\\b(?:${ENTITY_DOMAINS.join('|')})\\.([a-z0-9_]+)\\b`, 'g');
const OUR_ID_RE = new RegExp(`\\b(?:${ID_PREFIXES.join('|')})_[0-9a-z]+\\b`, 'gi');
const TOOL_NAME_RE = new RegExp(`\\b(?:${TOOL_NAMES.filter((n) => n.includes('_')).join('|')})\\b`, 'g');
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const PICTOGRAPH_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}‍︎️]/gu;
const DASH_RE = /\s*[\u2012\u2013\u2014\u2015]\s*/g;
// A sentence ends at . ! ? or the Devanagari danda, before whitespace and a character that is not a
// lower case letter ("3 a.m. last night" is one sentence, "3 a.m. Fourteen" is two).
const SENTENCE_END_RE = /[.!?।]+["')\]]*(?=\s+(?![a-z])|$)/gu;

/** Words a speaker would say: whitespace separated tokens with a letter or digit in them. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

export function estimateSpeechSeconds(text: string): number {
  return countWords(text) / SPEECH_WORDS_PER_SECOND;
}

/** Every rule the text breaks, as short readable phrases. Empty means the text is safe to speak. */
export function speechProblems(text: string): string[] {
  const problems: string[] = [];
  if (text.trim() === '') return ['is empty'];
  if (text !== text.trim() || /\s{2,}/.test(text)) problems.push('has extra whitespace');
  if (/[\r\n\t]/.test(text)) problems.push('has line breaks');
  if (text.includes('|')) problems.push('has a pipe');
  if (/[<>]/.test(text) || /[*_`#~]/.test(text)) problems.push('has markup');
  if (/[{}[\]]/.test(text)) problems.push('has brackets or JSON');
  if (new RegExp(OUR_ID_RE.source, 'i').test(text)) problems.push('has an id');
  if (new RegExp(ENTITY_ID_RE.source).test(text)) problems.push('has an entity id');
  if (new RegExp(TOOL_NAME_RE.source).test(text)) problems.push('has a tool name');
  if (new RegExp(URL_RE.source, 'i').test(text)) problems.push('has a link');
  if (/[\u2012\u2013\u2014\u2015]/.test(text)) problems.push('has a long dash');
  if (new RegExp(PICTOGRAPH_RE.source, 'u').test(text)) problems.push('has emoji');
  const words = countWords(text);
  if (words > MAX_SPEECH_WORDS) {
    problems.push(`is too long (${words} words, about ${Math.round(words / SPEECH_WORDS_PER_SECOND)} s)`);
  }
  return problems;
}

export function isSpeechSafe(text: string): boolean {
  return speechProblems(text).length === 0;
}

const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

/**
 * Turns any text into one speakable reply: strips markup, links, JSON, ids and tool names, reads
 * entity ids as words ("light.hallway_lamp" becomes "hallway lamp"), joins lines into sentences and
 * keeps whole sentences up to MAX_SPEECH_WORDS. Idempotent: speechSafe(speechSafe(x)) === speechSafe(x).
 */
export function speechSafe(text: string): string {
  let s = String(text ?? '').normalize('NFC');
  s = s.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? ' ');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/<[^>\n]*>/g, ' ');
  s = s.replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1');
  s = s.replace(URL_RE, ' ');
  s = removeBracketed(s);
  s = s.replace(OUR_ID_RE, ' ');
  s = s.replace(TOOL_NAME_RE, ' ');
  s = s.replace(ENTITY_ID_RE, (_m, objectId: string) => objectId.replace(/_+/g, ' ').trim());
  s = s.replace(/\|/g, ', ');
  s = s.replace(PICTOGRAPH_RE, '');
  s = joinLines(s);
  s = s.replace(DASH_RE, ', ');
  s = s.replace(/[*_`#~<>]+/g, ' ');
  s = tidyPunctuation(s);
  return truncateToWords(s, MAX_SPEECH_WORDS);
}

/** Drops {...} and [...] groups (JSON, markdown references), innermost first, then stray brackets. */
function removeBracketed(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\{[^{}]*\}/g, ' ').replace(/\[[^[\]]*\]/g, ' ');
  } while (s !== prev);
  return s.replace(/[{}[\]]/g, ' ');
}

/** Each line with text in it becomes a sentence; list markers, headings and quote marks are dropped. */
function joinLines(s: string): string {
  const lines = s
    .split(/\r?\n|\r/)
    .map((line) => line.replace(/^\s*(?:[-*+•>]+|#{1,6}|\d{1,3}[.)])\s+/, '').trim())
    .filter((line) => /[\p{L}\p{N}]/u.test(line));
  if (lines.length <= 1) return lines[0] ?? '';
  return lines.map((line) => (/[.!?,;:।]$/.test(line) ? line : `${line}.`)).join(' ');
}

function tidyPunctuation(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s
      .replace(/\s+/g, ' ')
      .replace(/\(\s*\)/g, ' ')
      .replace(/\s+([,.;:!?।])/g, '$1')
      .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
      .replace(/[,;:]\s*([.!?।])/g, '$1')
      .replace(/\.{2,}/g, '.')
      .replace(/([,;:])(?=[^\s\d])/g, '$1 ');
  } while (s !== prev);
  return s.replace(/^[\s,.;:!?।]+/, '').replace(/[\s,;:]+$/, '').trim();
}

function splitSentences(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of s.matchAll(SENTENCE_END_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    out.push(s.slice(start, end).trim());
    start = end;
  }
  const rest = s.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** Keeps whole sentences up to max words; a first sentence that is too long is cut at a clause. */
function truncateToWords(s: string, max: number): string {
  if (countWords(s) <= max) return s;
  const kept: string[] = [];
  let words = 0;
  for (const sentence of splitSentences(s)) {
    const n = countWords(sentence);
    if (words + n > max) break;
    kept.push(sentence);
    words += n;
  }
  if (kept.length > 0) return kept.join(' ');
  const tokens = s.split(/\s+/);
  let cut = '';
  for (let i = 0, n = 0; i < tokens.length; i++) {
    const t = tokens[i] ?? '';
    if (/[\p{L}\p{N}]/u.test(t)) n++;
    if (n > max) break;
    cut = cut ? `${cut} ${t}` : t;
  }
  // Last clause break that is followed by a space, so "3:12" is never split.
  let clause = -1;
  for (const m of cut.matchAll(/[,;:](?=\s)/g)) clause = m.index ?? -1;
  if (clause > cut.length / 2) cut = cut.slice(0, clause);
  return `${cut.replace(/[\s,;:.!?]+$/, '')}.`;
}
