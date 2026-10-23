// Text cleanup shared by every rule. Two forms come out of an utterance:
// - `spoken`: the person's words with the wake word and invocation removed, casing kept. This is what
//   tools receive (symptom, answer, question), because the server wants their words, not ours.
// - `norm`: lower case, apostrophes dropped ("isn't" -> "isnt"), punctuation turned into spaces,
//   "a.m." -> "am". The matching rules run on this form only.

const WAKE = /^\s*(?:hey\s+|ok\s+|okay\s+)?alexa\b[\s,.!:;-]*/i;

// "ask Fixwright why...", "tell Fixwright to...", "open Fixwright and...", "Fixwright, ..."
const INVOCATION =
  /^\s*(?:(?:please\s+)?(?:ask|tell|open|use|have|get)\s+fixwright(?:\s+(?:to|and|if|about|for))?|fixwright\b[\s,.:;-]*)\s*/i;

export function stripInvocation(utterance: string): string {
  let s = String(utterance ?? '').normalize('NFC').trim();
  s = s.replace(WAKE, '');
  s = s.replace(INVOCATION, '');
  return s.trim();
}

export function normalize(text: string): string {
  let s = text.normalize('NFC').toLowerCase();
  s = s.replace(/[‘’ʼ`´']/g, '');
  s = s.replace(/\b([ap])\.\s?m\b\.?/g, '$1m');
  // Keep digits joined by ':' or '.' (times like 3:12) before punctuation turns into spaces.
  s = s.replace(/(\d)[:.](\d)/g, '$1:$2');
  s = s.replace(/[^\p{L}\p{M}\p{N}:\s]/gu, ' ');
  s = s.replace(/(?<!\d):|:(?!\d)/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Remove a leading article or possessive and trailing filler from a device phrase. */
export function cleanDevice(phrase: string): string {
  let s = phrase.trim();
  s = s.replace(/^(?:the|my|our|a|an|that|this|those|these)\s+/, '');
  s = s.replace(/\s+(?:again|now|please|anymore|any more|for me|right now|today|at all|ever)$/g, '');
  s = s.replace(/\s+(?:again|now|please|anymore)$/g, '');
  return s.trim();
}
