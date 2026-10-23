// routeUtterance: picks the Fixwright tool (and its arguments) for one thing the person said, given
// where the conversation is. Deterministic rules only, so the demo never depends on a model quota.
// The order matters and is the whole policy:
//   1. Commands that never depend on context: undo, "did the fix hold".
//   2. A dry run waiting for its yes: a yes that gives consent ("yes", "apply it") applies it (with the
//      plan's own confirm_token), no drops it. A question ("is everything ok?"), an observation ("yes,
//      it blinked") or a yes that carries another request ("yes, undo it") is never consent, so it can
//      never spend the plan; a question about the plan hears the dry run again.
//   3. A question waiting for an answer: yes, no, or anything that is not clearly a new request is
//      passed word for word to diagnose_answer (the server asks once more if it is unclear).
//   4. A fix on offer ("Want me to fix that?"): yes or "fix that" plans it, no drops it.
//   5. New requests: fix a checkup finding, checkup, protect, explain a past event, diagnose, switch.
//   6. Replies: "fix that" with nothing to fix, help, a reminder of what waits for a yes or no (a dry
//      run, an offer), a stray yes, and the fallback.

import { parseYesNo, type ToolName } from '@fixwright/protocol';
import { cleanDevice, normalize, stripInvocation } from './normalize.ts';
import { clearPending, initialState, type ConversationState, type FindingRef, type RepairRef } from './state.ts';

export type Intent =
  | 'apply_plan'
  | 'decline_plan'
  | 'answer_question'
  | 'accept_offer'
  | 'decline_offer'
  | 'fix_that'
  | 'fix_finding'
  | 'checkup'
  | 'diagnose'
  | 'explain'
  | 'switch'
  | 'protect'
  | 'unprotect'
  | 'undo'
  | 'status'
  | 'cancel'
  | 'help'
  | 'reply';

export interface ToolRoute {
  tool: ToolName;
  arguments: Record<string, unknown>;
  intent: Intent;
}

export interface ReplyRoute {
  /** Say this; no tool call. Plain speech. */
  reply: string;
  intent: Intent;
  /** When present, the conversation state to keep from now on (the person declined something). */
  state?: ConversationState;
}

export type Route = ToolRoute | ReplyRoute;

export const isToolRoute = (r: Route): r is ToolRoute => 'tool' in r;

export const REPLIES = {
  empty: "I didn't catch that. Tell me which device is acting up, or ask for a checkup.",
  thanks: "You're welcome. Ask me any time something in the house acts up.",
  help: 'I find out why a device is acting up, explain something your home did, and give your house a checkup. Try: why is the hallway lamp not responding?',
  fallback:
    'I can find out why a device is acting up, explain something your home did, or give your house a checkup. Try: why is the hallway lamp not responding?',
  strayAnswer: "I'm not waiting on an answer right now. Tell me which device is acting up, or ask for a checkup.",
  declinePlan: "Okay, I won't change anything.",
  declineOffer: "Okay, I'll leave it as it is.",
  nothingToFix: "Tell me what's acting up first, and I'll find the real fault before fixing anything.",
  nothingToUndo: "There's no fix to undo yet.",
  noRepairYet: "I haven't fixed anything yet, so there's nothing to check on.",
  whichDevice: 'Which device do you mean?',
  notFixable: "I can't fix that one by myself.",
  cancelQuestion: "Okay, I'll stop there. Ask me again whenever you like.",
  whichFinding: 'Which one should I fix? You can say the first one, or name it.',
  planWaiting: 'Got it, I already have that. Shall I apply the fix? Say yes or no.',
  offerWaiting: 'Got it, I already have that. Want me to fix it? Say yes or no.',
  /** A dry run waits and the words were neither a yes, a no nor a new request. */
  planAsk: 'The fix is ready, and nothing has changed yet. Shall I apply it? Say yes or no.',
  /** Opens the dry run read back when the person asks about it ("is it safe?", "what will it change?"). */
  planDetails: "Here's what the fix changes.",
  /** Closes the dry run read back. */
  planDetailsAsk: 'Nothing changes until you say yes. Shall I apply it?',
  /** A fix is on offer and the reply mixed a yes or a no with something else. */
  offerAsk: 'Want me to fix it? Say yes or no.',
} as const;

/** "Did the kitchen plug fix hold?" when no repair in this conversation touched that device. */
export function noRepairFor(device: string): string {
  return `I don't have a fix for the ${device} yet. Ask "did the fix hold?" to hear about the newest one.`;
}

/** At most this many dry run lines are read out; the rest are counted. */
const MAX_SPOKEN_DIFF_LINES = 3;

const MAX_TEXT = 500;
const MAX_DEVICE_WORDS = 6;

const PRONOUNS = new Set(['it', 'its', 'this', 'that', 'them', 'those', 'these', 'one', 'this one', 'that one', 'everything', 'something', 'thing']);

// Patterns run on normalize() output: lower case, no apostrophes, "a.m." as "am".

const ANSWER_LEAD =
  /^(?:yes|yeah|yep|yup|ya|yah|no|nope|nah|haan|haa|han|ha|ji|nahi|nahin|nai|na|it did|it didnt|i did|i didnt|i saw|i heard|it blinked|blinked|didnt|sure|correct|it worked|nothing happened|uh huh|mhm)\b/;

// A short acknowledgement before a stop does not make it a yes: "okay, never mind", "oh wait".
const STOP_LEAD = '(?:(?:ok|okay|alright|all right|oh|ah|actually|hmm|um|uh|no|nah)\\s+)*';

// "cancel", "wait", "not now": stops a pending plan or offer. Whole utterance only, so "stop
// protecting the aquarium filter" is still a request.
const CANCEL = new RegExp(
  `^${STOP_LEAD}(?:cancel|stop|wait|hold on|hold off|not now|not yet|never mind|nevermind|forget it|forget about it|leave it|skip it|skip|abort|maybe later|later|ruko|rehne do|rehnedo|mat karo|chhodo|chodo)(?: (?:it|that|this|please|for now|then|thanks|thank you))*$`,
);

// "apply it", "apply the fix": how people answer "Apply this fix?" (the sheet's chip says "Yes, apply it").
const APPLY_IT =
  /^(?:(?:yes|yeah|yep|ok|okay|sure|please|haan|go ahead and|go on and|go on|can you|could you|would you|then)\s+)*(?:apply|make|do) (?:it|that|this|the fix|this fix|that fix|the repair|the change|the changes|the plan|them)(?:\s+(?:please|for me|now|then|thanks|thank you))*$|^(?:please )?apply(?: please)?$/;

// The yes words a reply may open with, so the rest can be checked for another request.
const YES_LEAD = /^(?:(?:yes|yeah|yep|yup|ya|yah|sure|ok|okay|alright|all right|haan|haa|han|ha|ji|please|fine|right|correct)\s+)+/;

// Inside a yes, these take it back or hedge it: "yes, cancel", "yes but only the lamp", "yes, later".
const TAKE_BACK = /\b(?:stop|cancel|wait|hold on|hold off|never mind|nevermind|forget it|abort|ruko|rehne do|mat karo|but|instead|except|rather|later)\b/;

// The person is asking, not agreeing: "is everything ok?" holds "ok" and "is it working?" holds
// "working", and neither may ever spend a plan. Polite requests ("can you do it") are not here.
const ASKING =
  /^(?:why|what|whats|how|hows|when|where|who|which|is|are|was|were|does|did|has|have|do (?:i|you|we)|can (?:i|we)|should (?:i|we))\b/;

// What a person saw or heard when a probe ran. As a reply to "Shall I apply the fix?" it answers a
// question that is already closed, so it is not consent.
const OBSERVATION =
  /\b(?:blink(?:ed|s|ing)?|flash(?:ed|es|ing)|flicker(?:ed|ing|s)?|lit up|came on|click(?:ed|s)?|heard (?:it|a)|i saw|saw it|jal (?:raha|rahi|gaya|gayi)|jala|jali|dikha|blink hua)\b/;

// Words that end a question: only explicit stops, because "wait" may mean "let me look".
const CANCEL_QUESTION = new RegExp(
  `^${STOP_LEAD}(?:cancel|stop|abort|never mind|nevermind|forget it|forget about it)(?: (?:it|that|this|please|for now|then|thanks|thank you))*$`,
);

// While a dry run waits: the person asks about it ("is it safe?", "what will it change?", "tell me more").
const ABOUT_PLAN =
  /^(?:why|what|whats|how|hows|when|which|is|are|was|does|did|do|can|could|will|would|should|tell me|explain|say that again|repeat|more|details)\b/;

const UNDO =
  /\b(?:undo|revert|roll ?back|put (?:it|that|them|everything) back|change (?:it|that|them) back|set (?:it|that) back|take (?:it|that) back|reverse (?:it|that|the fix|the repair)|wapas karo|pehle jaisa kar do)\b/;

const STATUS =
  /\b(?:did (?:the |that |my |your )?(?:fix|repair) (?:hold|work|stick|last)|did it (?:hold|stick|last)|is (?:the |that )?(?:fix|repair) (?:holding|working|still working)|(?:repair|fix) status|status of (?:the |that )?(?:fix|repair)|how (?:is|did) (?:the |that |your )?(?:fix|repair) (?:doing|going|holding up|go)|how is .+ (?:doing|holding up) since|since you fixed|check (?:on )?(?:the |that )?(?:fix|repair))\b|^status$|^(?:any |the )?status update$/;

// "Did the hallway lamp fix hold?", "is the fix on the hallway lamp holding?": a status question that names
// the device, so it goes to that device's repair instead of the newest one.
const STATUS_OUTCOME = '(?:hold|held|work|worked|stick|stuck|last|lasted|holding|working|still working|doing|going|go|holding up)';
const STATUS_NAMED: readonly RegExp[] = [
  new RegExp(`\\b(?:did|has|have|is|how is|hows|how did|how has) (.+?) (?:fix|repair|fixes|repairs) ${STATUS_OUTCOME}\\b`),
  new RegExp(`\\b(?:did|has|is|how is|hows|how did|how has) (?:the |my |your |that )?(?:fix|repair) (?:on|for|to|of) (.+?) ${STATUS_OUTCOME}\\b`),
  /\b(?:status of|check on) (?:the |my |your |that )?(?:fix|repair) (?:on|for|to|of) (.+)$/,
  /\b(?:status of|check on) (.+?) (?:fix|repair)$/,
];
// Words that name which repair, not which device: "did last night's fix hold?" is the newest repair.
const NOT_A_DEVICE = /^(?:(?:the|my|your|our|that|this|last|latest|newest|recent|previous|first|second|morning|nights|night|todays|yesterdays|your own)\s*)+$/;

/**
 * A question about how a fix is doing. `device` is the device it names, or null for "did the fix hold?"
 * and "did last night's fix hold?" (the newest repair). Null when the words are not a status question.
 */
function statusAsk(norm: string): { device: string | null } | null {
  let shaped = false;
  for (const re of STATUS_NAMED) {
    const m = re.exec(norm);
    if (!m?.[1]) continue;
    shaped = true;
    if (NOT_A_DEVICE.test(m[1])) continue;
    const d = asDevice(m[1]);
    if (d && !isPronoun(d) && !NOT_A_DEVICE.test(d)) return { device: d };
  }
  return shaped || STATUS.test(norm) ? { device: null } : null;
}

const isStatusAsk = (norm: string): boolean => statusAsk(norm) !== null;

const FIX_THAT =
  /^(?:(?:yes|yeah|ok|okay|sure|please|haan|go ahead and|can you|could you|would you)\s+)*(?:fix|repair|sort out|solve) (?:it|that|this|them|those|the problem|the issue|that one|this one|it up)(?:\s+(?:please|for me|now|then))*$/;

const FIX_VERB = /\b(?:fix|repair|rename|sort out|take care of|resolve|solve|handle)\b/;

const CHECKUP =
  /\b(?:check ?up|health ?check|home check|house check|check (?:on )?(?:my|the|our) (?:whole )?(?:house|home|devices|smart home)|scan (?:my|the|our) (?:whole )?(?:house|home|devices)|(?:anything|something) wrong with (?:my|the|our) (?:house|home)|how is (?:my|the|our) (?:house|home)(?: doing)?|(?:is|are) (?:my|the|our) (?:whole )?(?:house|home|smart home|devices|place) (?:ok|okay|alright|all right|fine|healthy|good|working)|is everything (?:ok|okay|alright|all right|fine|working)|(?:whats|what is) (?:wrong|going on|up|happening) with (?:my|the|our) (?:whole )?(?:house|home|smart home|devices|place)|check (?:all )?(?:the |my )?batteries|ghar (?:ka|ki) (?:checkup|jaanch))\b/;

const CHECKUP_FOCUS = /\b(?:check ?up|health ?check)\s+(?:of|on|for|in)\s+(?:the |my |our )?(.+)$/;

const PROTECT_PATTERNS: readonly RegExp[] = [
  /^(?:please )?protect (?:the |my |our )?(.+?)(?: because (.+))?$/,
  /\b(?:never|dont ever|do not ever|dont you ever) (?:turn|switch|shut|power) (?:off |down )?(?:the |my |our )?(.+?)(?: (?:off|down))?(?: because (.+))?$/,
  /\b(?:always keep|keep) (?:the |my |our )?(.+?) (?:on|running) (?:always|all the time|no matter what)(?: because (.+))?$/,
  /^always keep (?:the |my |our )?(.+?) (?:on|running)(?: because (.+))?$/,
];

const UNPROTECT =
  /\b(?:unprotect|stop protecting|remove (?:the )?protection (?:from|for|on)|no longer protect|you can (?:turn|switch) off|its (?:ok|okay|fine) to (?:turn|switch) off) (?:the |my |our )?(.+)$/;

const SYMPTOM =
  /\b(?:(?:wont|doesnt|cant|wouldnt|isnt|dont) [a-z0-9 ]{1,60}? (?:turn|switch|come) (?:on|off)|not responding|isnt responding|arent responding|stopped responding|stop responding|unresponsive|no response|not working|isnt working|arent working|doesnt work|dont work|stopped working|stop working|wont work|offline|unavailable|unreachable|disconnected|not connected|wont connect|cant connect|(?:wont|doesnt|dont|not|cant|wouldnt) (?:turn|switch) (?:on|off)|not turning (?:on|off)|keeps? (?:dropping|disconnecting|going offline|turning off|turning on|saying|failing|losing)|drop(?:s|ped|ping)? (?:off|out)|(?:losing|lost|loses) (?:wifi|wi fi|connection|signal|its connection)|disconnecting|broken|wont respond|doesnt respond|cant find|cant control|not showing up|isnt showing up|stuck|acting up|acting weird|kaam nahi kar(?: raha| rahi)?|nahi chal raha|chal nahi raha|nahi jal raha|jal nahi raha|kaam nahi karta)\b/;

const DIAGNOSE_LEAD =
  /\b(?:whats wrong with|what is wrong with|something is wrong with|somethings wrong with|(?:whats|what is) (?:going on|up|happening) with|problem with|issue with|diagnose|troubleshoot|look at|check on|check|fix|repair)\s+(?:the |my |our )?(.+)$/;

// "is the hallway lamp working?", "is the kitchen plug online": asking about one device's health.
const STATE_WORD = '(?:working|responding|online|connected|ok|okay|alright|all right|fine)';
const STATE_QUESTION = new RegExp(`^(?:is|are) .{1,60}? ${STATE_WORD}(?: (?:now|again|properly|right now|at all|today|yet))?$`);

const EXPLAIN_LEAD =
  /\b(?:what happened|what went on|whats been happening|why did|why were|why was|what turned|who turned|what switched|who switched|what made|kya hua)\b/;

const TIME =
  /\b(?:at \d{1,2}(?::\d{2})?(?: ?[ap]m)?|\d{1,2}(?::\d{2})? ?[ap]m|last night|this morning|yesterday|overnight|earlier today|earlier|tonight|in the night|at night|midnight|noon|this afternoon|this evening|while i was (?:out|away|asleep)|raat ko|kal raat)\b/;

const EVENT_VERB =
  /\b(?:turn(?:ed|s)? (?:on|off)|came on|come on|went off|go off|went out|switched (?:on|off)|switch(?:es)? (?:on|off)|lit up|light up|started|restarted|flicker(?:ed)?|blinked|beeped|woke)\b/;

const DEVICE_STOP =
  '(?:keeps?|kept|is|are|isnt|arent|wont|doesnt|dont|does|do|says?|saying|said|stopped|stop|has|hasnt|have|not|cant|cannot|will|went|go|goes|going|gone|gets?|got|getting|drops?|dropped|dropping|shows?|showing|turned|turns?|turning|still|always|never|broken|dead|stuck|working|responding|connected|offline|unresponsive|unavailable|unreachable|disconnected|acting|seems|appears|was|were|wouldnt|kaam|nahi|chal|kyun|kyon|jal)';

// "why does Alexa say the hallway lamp is offline": the device is what the reporter talks about, not
// the reporter. The leading "why" is kept so the device patterns still apply.
const REPORT_VERB = '(?:keeps? )?(?:say|says|saying|said|tell me|tells me|told me|show|shows|showing|report|reports|reporting)(?: that)? ';
const REPORTER = new RegExp(
  `^(why )?(?:(?:does|do|did|is|would) )?(?:alexa|the alexa app|the app|my app|the assistant|my assistant|fixwright|my phone|the phone) ${REPORT_VERB}`,
);
// "why does it keep saying the hallway lamp is not responding": "it" is the reporter only when a
// named device follows; otherwise "it" is the device ("why does it say offline").
const IT_REPORTER = new RegExp(`^(why )?(?:(?:does|do|did|is|would) )?(?:it|she|he|they) ${REPORT_VERB}`);

// A clause that only names a device: "what about the kitchen plug, it keeps dropping".
const MENTION_LEAD = /^(?:what about|how about|and also|and|also|plus|same with|same for|now)\s+/;
const QUESTION_WORD = /^(?:why|what|how|when|where|who|which|is|are|does|do|did|can|could|would|will|should)\b/;
const FILLER = new Set(['so', 'well', 'hmm', 'um', 'uh', 'ugh', 'again', 'sorry', 'please', 'thanks', 'hey', 'hi', 'ok', 'okay', 'oh', 'and', 'also', 'now', 'then', 'still', 'just']);

const DEVICE_PATTERNS: readonly RegExp[] = [
  /\b(?:cant|couldnt|cannot) (?:get|make) (.+?) (?:to|work|respond)\b/,
  // "why won't my bedroom lamp switch on": the device sits between the negation and the switch verb,
  // so "switch" in a device name ("the hallway switch") is still part of it.
  /\b(?:wont|doesnt|cant|wouldnt|isnt|dont|didnt) (.+?) (?:turn|switch|come|power) (?:on|off|back on)\b/,
  new RegExp(`\\bwhy (?:is |are |does |do |did |isnt |arent |doesnt |dont |wont |cant |has |hasnt |will |would )?(.+?) ${DEVICE_STOP}\\b`),
  new RegExp(`^(?:is|are|does|do) (.+?) ${DEVICE_STOP}\\b`),
  new RegExp(`^(?:is|are) (.+?) ${STATE_WORD}\\b`),
  new RegExp(`^(.+?) ${DEVICE_STOP}\\b`),
];

const SWITCH_PATTERNS: ReadonlyArray<{ re: RegExp; device: number; state: number }> = [
  { re: /^(?:please |can you |could you |would you )?(?:turn|switch|power|shut) (on|off|down) (.+?)(?: please)?$/, device: 2, state: 1 },
  { re: /^(?:please |can you |could you |would you )?(?:turn|switch|power|shut) (.+?) (on|off|down)(?: please)?$/, device: 1, state: 2 },
  { re: /^(.+?) (band|off|on|chalu|chalao|jalao) (?:karo|kar do|kardo)$/, device: 1, state: 2 },
];

const THANKS = /^(?:(?:ok|okay|great|cool|nice|perfect|awesome)\s+)?(?:thanks|thank you|thank u|thx|cheers|shukriya|dhanyavad)(?: (?:so much|a lot|alexa|fixwright))*$/;
const HELP = /^(?:help|what can you do|how does this work|what do you do|who are you|hi|hello|hey|namaste|good (?:morning|evening|afternoon))\b/;

const ORDINALS: ReadonlyArray<[RegExp, number]> = [
  [/\b(?:first|1st|number one|no 1|1)\b/, 0],
  [/\b(?:second|2nd|number two|no 2|2)\b/, 1],
  [/\b(?:third|3rd|number three|no 3|3)\b/, 2],
  [/\b(?:fourth|4th|number four|no 4|4)\b/, 3],
  [/\b(?:fifth|5th|number five|no 5|5)\b/, 4],
];

const TITLE_STOP = new Set([
  'the', 'a', 'an', 'to', 'at', 'of', 'in', 'on', 'and', 'or', 'is', 'are', 'it', 'its', 'one', 'that', 'this', 'fix', 'repair',
  'rename', 'please', 'my', 'answer', 'times', 'today', 'two', 'with',
]);

const tool = (name: ToolName, args: Record<string, unknown>, intent: Intent): ToolRoute => ({ tool: name, arguments: args, intent });
const reply = (text: string, intent: Intent = 'reply', state?: ConversationState): ReplyRoute =>
  state ? { reply: text, intent, state } : { reply: text, intent };

const clip = (s: string): string => (s.length <= MAX_TEXT ? s : s.slice(0, MAX_TEXT).trim());

function asDevice(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = cleanDevice(raw);
  if (!d || d.split(' ').length > MAX_DEVICE_WORDS) return null;
  return d;
}

const isPronoun = (d: string): boolean => PRONOUNS.has(d);

function resolveDevice(raw: string | undefined, state: ConversationState): string | null {
  const d = asDevice(raw);
  if (!d) return null;
  if (isPronoun(d)) return state.lastDevice;
  return d;
}

const STOP_WORD = new RegExp(`^(?:${DEVICE_STOP}|it|its|and|but|because|since)$`);

/** "hallway lamp it is broken" -> "hallway lamp": a device phrase ends at the first verb or pronoun. */
function trimAtStop(phrase: string): string {
  const words: string[] = [];
  for (const w of phrase.split(' ')) {
    if (STOP_WORD.test(w)) break;
    words.push(w);
  }
  return words.join(' ');
}

/** A device phrase found in one clause, before "it" is resolved to the last device. */
interface DeviceHit {
  phrase: string;
  pronoun: boolean;
}

function hitFrom(raw: string | undefined): DeviceHit | null {
  const d = asDevice(raw);
  if (!d) return null;
  if (isPronoun(d)) return { phrase: d, pronoun: true };
  if (/^(?:why|what|how|is|are|it|its|the|no|yes|i|we|you|me|my|they)$/.test(d)) return null;
  return { phrase: d, pronoun: false };
}

function deviceInClause(rawClause: string): DeviceHit | null {
  const clause = rawClause.replace(REPORTER, (_m, why: string | undefined) => why ?? '');
  if (IT_REPORTER.test(clause)) {
    const reported = scanClause(clause.replace(IT_REPORTER, (_m, why: string | undefined) => why ?? ''));
    if (reported && !reported.pronoun) return reported;
  }
  return scanClause(clause);
}

function scanClause(clause: string): DeviceHit | null {
  const lead = DIAGNOSE_LEAD.exec(clause);
  if (lead?.[1]) {
    const head = lead[1].split(' ')[0] ?? '';
    return PRONOUNS.has(head) ? { phrase: head, pronoun: true } : hitFrom(trimAtStop(lead[1]));
  }
  for (const re of DEVICE_PATTERNS) {
    const m = re.exec(clause);
    if (m) {
      const hit = hitFrom(m[1]);
      if (hit) return hit;
    }
  }
  return null;
}

/** A clause that is only a device name ("the kitchen plug"), with no verb, question or answer. */
function mentionIn(clause: string): string | null {
  const bare = clause.replace(MENTION_LEAD, '');
  if (!bare || QUESTION_WORD.test(bare) || ANSWER_LEAD.test(bare) || HELP.test(bare) || SYMPTOM.test(bare)) return null;
  const words = bare.split(' ');
  if (words.some((w) => STOP_WORD.test(w)) || words.every((w) => FILLER.has(w))) return null;
  const d = asDevice(bare);
  return d && !isPronoun(d) ? d : null;
}

/**
 * Look for the device clause by clause ("fix the hallway lamp, it is broken"). A named device wins
 * over "it"; when only "it" carries the symptom, a clause that just names a device is that "it"
 * ("what about the kitchen plug, it keeps dropping"), and otherwise "it" is the last device.
 */
function deviceFromSymptom(spoken: string, state: ConversationState): string | null {
  let pronoun = false;
  let mention: string | null = null;
  for (const part of spoken.split(/[,;.!?]+/)) {
    const clause = normalize(part);
    if (!clause) continue;
    const hit = deviceInClause(clause);
    if (hit && !hit.pronoun) return hit.phrase;
    if (hit) pronoun = true;
    else mention ??= mentionIn(clause);
  }
  return pronoun ? (mention ?? state.lastDevice) : null;
}

function diagnoseRoute(spoken: string, norm: string, state: ConversationState): ToolRoute | null {
  if (FIX_THAT.test(norm)) return null;
  const symptom = SYMPTOM.test(norm) || STATE_QUESTION.test(norm);
  const lead = DIAGNOSE_LEAD.test(norm) && !CHECKUP.test(norm);
  if (!symptom && !lead) return null;
  const device = deviceFromSymptom(spoken, state);
  if (!symptom && !device) return null;
  const args: Record<string, unknown> = { symptom: clip(spoken) };
  if (device) args['device'] = device;
  return tool('diagnose', args, 'diagnose');
}

function explainRoute(spoken: string, norm: string): ToolRoute | null {
  const lead = EXPLAIN_LEAD.test(norm);
  const timedEvent = TIME.test(norm) && EVENT_VERB.test(norm);
  if (!lead && !timedEvent) return null;
  // "Why did the lamp stop responding?" is a live problem (diagnose); with a time ("at 3 a.m.", "last
  // night") it is a past event to explain.
  if (SYMPTOM.test(norm) && !/\bwhat happened\b/.test(norm) && !(lead && TIME.test(norm))) return null;
  return tool('explain_event', { question: clip(spoken) }, 'explain');
}

function switchRoute(norm: string, state: ConversationState): Route | null {
  for (const p of SWITCH_PATTERNS) {
    const m = p.re.exec(norm);
    if (!m) continue;
    const word = m[p.state] ?? '';
    const on = word === 'on' || word === 'chalu' || word === 'chalao' || word === 'jalao';
    const raw = asDevice(m[p.device]);
    if (!raw) continue;
    if (isPronoun(raw)) {
      if (!state.lastDevice) return reply(REPLIES.whichDevice);
      return tool('switch_device', { device: state.lastDevice, on }, 'switch');
    }
    return tool('switch_device', { device: raw, on }, 'switch');
  }
  return null;
}

function protectRoute(norm: string, state: ConversationState): Route | null {
  const un = UNPROTECT.exec(norm);
  if (un) {
    const device = resolveDevice(un[1], state);
    return device ? tool('protect_device', { device, protect: false }, 'unprotect') : reply(REPLIES.whichDevice);
  }
  for (const re of PROTECT_PATTERNS) {
    const m = re.exec(norm);
    if (!m) continue;
    const device = resolveDevice(m[1], state);
    if (!device) return reply(REPLIES.whichDevice);
    const args: Record<string, unknown> = { device };
    const reason = m[2]?.trim();
    if (reason) args['reason'] = reason.slice(0, 200);
    return tool('protect_device', args, 'protect');
  }
  return null;
}

// "is anything broken?", "is everything ok?": a whole house question even without the word house.
const CHECKUP_ANY = /\b(?:anything|something|everything) (?:broken|wrong|not working|acting up|off|ok|okay|alright|all right|fine|working)\b(?! (?:with|in|on) )|\bwhat(?:s| is) broken\b/;

function checkupRoute(norm: string): ToolRoute | null {
  if (!CHECKUP.test(norm) && !CHECKUP_ANY.test(norm)) return null;
  if (/\bbatteries\b/.test(norm) && !/\bcheck ?up\b/.test(norm)) return tool('home_checkup', { focus: 'batteries' }, 'checkup');
  const focus = CHECKUP_FOCUS.exec(norm)?.[1]?.trim();
  if (focus && !/^(?:(?:my |the |our |whole )*(?:house|home|place|devices|smart home))$/.test(focus)) {
    return tool('home_checkup', { focus: focus.slice(0, 200) }, 'checkup');
  }
  return tool('home_checkup', {}, 'checkup');
}

function titleTokens(title: string): Set<string> {
  return new Set(
    normalize(title)
      .split(' ')
      .filter((t) => t.length > 1 && !TITLE_STOP.has(t) && !/^\d+$/.test(t)),
  );
}

/** How people name a kind of finding when its title words do not come to mind ("the duplicate name"). */
const KIND_WORDS: Readonly<Record<string, readonly string[]>> = {
  duplicate_name: ['duplicate', 'duplicates', 'same name', 'name', 'names', 'collision'],
  ghost_entity: ['ghost', 'old copy', 'stale', 'leftover'],
  flapping: ['wifi', 'wi fi', 'dropping', 'dropped', 'flapping', 'connection', 'signal'],
  low_battery: ['battery', 'batteries'],
  dead_trigger: ['automation', 'trigger', 'routine'],
  power_on_default: ['power cut', 'outage', 'power restore', 'power on'],
  integration_error: ['integration', 'login', 'account', 'relink'],
  unprotected_load: ['protect', 'protection', 'unprotected'],
};

function kindScore(norm: string, kind: string | undefined): number {
  const words = kind ? (Object.hasOwn(KIND_WORDS, kind) ? KIND_WORDS[kind] : undefined) : undefined;
  if (!words) return 0;
  const padded = ` ${norm} `;
  return words.filter((w) => padded.includes(` ${w} `)).length;
}

function pickFinding(norm: string, findings: readonly FindingRef[]): FindingRef | null {
  if (/\b(?:last one|the last)\b/.test(norm)) return findings[findings.length - 1] ?? null;
  for (const [re, index] of ORDINALS) if (re.test(norm)) return findings[index] ?? null;
  const said = new Set(norm.split(' ').filter((t) => !TITLE_STOP.has(t)));
  let best: FindingRef | null = null;
  let bestScore = 0;
  let tie = false;
  for (const f of findings) {
    let score = kindScore(norm, f.kind);
    for (const t of titleTokens(f.title)) if (said.has(t)) score++;
    if (score > bestScore) {
      best = f;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) tie = true;
  }
  return bestScore > 0 && !tie ? best : null;
}

/** For a finding Fixwright cannot change itself, say so and pass on the server's own advice. */
function notFixable(f: FindingRef | undefined): ReplyRoute {
  const detail = f?.detail?.trim();
  return reply(detail ? `${REPLIES.notFixable} ${detail}` : REPLIES.notFixable);
}

function findingRoute(norm: string, state: ConversationState): Route | null {
  if (state.findings.length === 0 || !FIX_VERB.test(norm)) return null;
  const f = pickFinding(norm, state.findings);
  if (!f) {
    if (FIX_THAT.test(norm) && state.findings.length > 1) return reply(REPLIES.whichFinding);
    if (FIX_THAT.test(norm) && state.findings.length === 1) {
      const only = state.findings[0];
      if (only) return only.fixable ? tool('repair_plan', { issue_id: only.issue_id }, 'fix_finding') : notFixable(only);
    }
    return null;
  }
  if (!f.fixable) return notFixable(f);
  return tool('repair_plan', { issue_id: f.issue_id }, 'fix_finding');
}

function offerArgs(state: ConversationState): Record<string, unknown> | null {
  const o = state.pendingOffer;
  if (!o) return null;
  if (o.kind === 'diagnosis') return { diagnosis_id: o.id };
  if (o.kind === 'issue') return { issue_id: o.id };
  return { explanation_id: o.id };
}

/** "Fix that" when nothing is on offer: fall back to the newest finished diagnosis or explanation. */
function fixThatRoute(state: ConversationState): Route {
  if (state.last.diagnosis_id) return tool('repair_plan', { diagnosis_id: state.last.diagnosis_id }, 'fix_that');
  if (state.last.explanation_id) return tool('repair_plan', { explanation_id: state.last.explanation_id }, 'fix_that');
  return reply(REPLIES.nothingToFix);
}

/** Requests that start something new. Returns null when the words are not clearly one of them. */
function newRequest(spoken: string, norm: string, state: ConversationState): Route | null {
  return (
    findingRoute(norm, state) ??
    checkupRoute(norm) ??
    protectRoute(norm, state) ??
    explainRoute(spoken, norm) ??
    diagnoseRoute(spoken, norm, state) ??
    switchRoute(norm, state)
  );
}

function commandRoute(norm: string, state: ConversationState): Route | null {
  if (UNDO.test(norm)) {
    return state.last.repair_id ? tool('undo', { repair_id: state.last.repair_id }, 'undo') : reply(REPLIES.nothingToUndo, 'undo');
  }
  const status = statusAsk(norm);
  if (status?.device) return namedStatusRoute(status.device, state);
  if (status) {
    return state.last.repair_id
      ? tool('repair_status', { repair_id: state.last.repair_id }, 'status')
      : reply(REPLIES.noRepairYet, 'status');
  }
  return null;
}

/** A status question about one device: that device's repair, else say there is none. */
function namedStatusRoute(device: string, state: ConversationState): Route {
  if (!state.repairs) {
    // A state without the repair list (the server's copy): the newest repair, as before.
    return state.last.repair_id ? tool('repair_status', { repair_id: state.last.repair_id }, 'status') : reply(REPLIES.noRepairYet, 'status');
  }
  const ref = findRepair(device, state.repairs);
  if (ref) return tool('repair_status', { repair_id: ref.repair_id }, 'status');
  return reply(state.repairs.length > 0 ? noRepairFor(device) : REPLIES.noRepairYet, 'status');
}

const wordsOf = (text: string): string => ` ${normalize(text).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;

/**
 * The repair a device phrase refers to, newest first: one that was about the device (its diagnosis or
 * finding names it) beats one that only touched it among other devices.
 */
function findRepair(device: string, repairs: readonly RepairRef[]): RepairRef | null {
  const d = wordsOf(cleanDevice(normalize(device)));
  if (d.trim() === '') return null;
  let best: RepairRef | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (let i = repairs.length - 1; i >= 0; i--) {
    const r = repairs[i];
    if (!r) continue;
    const subject = r.subject ? wordsOf(r.subject) : '';
    const rank = subject && (subject.includes(d) || d.includes(subject)) ? 0 : r.text.some((t) => wordsOf(t).includes(d)) ? 1 : null;
    if (rank !== null && rank < bestRank) {
      best = r;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * The repair a piece of text is about, such as a push ("Hallway lamp answered all 9 commands overnight."):
 * the newest repair whose subject the text names. Null when the text names none.
 */
export function repairForText(text: string, state: ConversationState): string | null {
  const t = wordsOf(text);
  const repairs = state.repairs ?? [];
  for (let i = repairs.length - 1; i >= 0; i--) {
    const r = repairs[i];
    if (r?.subject && t.includes(wordsOf(r.subject))) return r.repair_id;
  }
  return null;
}

type Consent = 'yes' | 'no' | 'unclear' | 'observation';

/** "fix the kitchen plug" names a device; "fix it" or "fix that one" does not. */
function namesAnotherDevice(rest: string): boolean {
  const lead = DIAGNOSE_LEAD.exec(rest);
  if (!lead?.[1]) return false;
  const d = asDevice(trimAtStop(lead[1]));
  return !!d && !isPronoun(d);
}

/**
 * A yes that carries something else is not a clean yes to this prompt: "yes, undo it", "okay, turn off
 * the kitchen plug", "yes, is it safe?", "yes, give my house a checkup", "yes but only the lamp".
 */
function asksSomethingElse(norm: string): boolean {
  const rest = norm.replace(YES_LEAD, '');
  if (!rest) return false;
  return (
    TAKE_BACK.test(rest) ||
    ASKING.test(rest) ||
    UNDO.test(rest) ||
    isStatusAsk(rest) ||
    CHECKUP.test(rest) ||
    EXPLAIN_LEAD.test(rest) ||
    SYMPTOM.test(rest) ||
    UNPROTECT.test(rest) ||
    PROTECT_PATTERNS.some((re) => re.test(rest)) ||
    SWITCH_PATTERNS.some((p) => p.re.test(rest)) ||
    namesAnotherDevice(rest)
  );
}

/** A reply to "Shall I?": consent, a no or a stop, an observation (not consent), or something else. */
function readConsent(spoken: string, norm: string): Consent {
  if (FIX_THAT.test(norm) || APPLY_IT.test(norm)) return 'yes';
  if (CANCEL.test(norm)) return 'no';
  if (ASKING.test(norm)) return 'unclear';
  if (OBSERVATION.test(norm)) return 'observation';
  const yn = parseYesNo(spoken, { consent: true });
  return yn === 'yes' && asksSomethingElse(norm) ? 'unclear' : yn;
}

const sentence = (line: string): string => {
  const t = line.replace(/\s+/g, ' ').trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/**
 * A dry run waits and the words were neither a yes, a no nor a new request. A question about it gets
 * the dry run read back (the plan's own diff lines, nothing invented); anything else asks again.
 */
function planReminder(norm: string, plan: NonNullable<ConversationState['pendingPlan']>): ReplyRoute {
  const lines = plan.diff_lines.map(sentence).filter((l) => l.length > 1);
  if (!ABOUT_PLAN.test(norm.replace(YES_LEAD, '')) || lines.length === 0) return reply(REPLIES.planAsk);
  const spoken = lines.slice(0, MAX_SPOKEN_DIFF_LINES);
  const more = lines.length - spoken.length;
  const rest = more > 0 ? [`And ${more} more ${more === 1 ? 'change' : 'changes'}.`] : [];
  return reply([REPLIES.planDetails, ...spoken, ...rest, REPLIES.planDetailsAsk].join(' '));
}

/**
 * How the person answered a yes or no permission prompt (a plan, an offer, a host's approval sheet).
 * Stricter than parseYesNo: a question or an observation is never a yes, and a stop is a no.
 */
export function consentOf(utterance: string): 'yes' | 'no' | 'unclear' {
  const spoken = stripInvocation(utterance);
  const norm = normalize(spoken);
  if (!norm) return 'unclear';
  const c = readConsent(spoken, norm);
  return c === 'observation' ? 'unclear' : c;
}

export function routeUtterance(utterance: string, state: ConversationState = initialState()): Route {
  const spoken = stripInvocation(utterance);
  const norm = normalize(spoken);
  if (!norm) return reply(REPLIES.empty);
  const answerLike = ANSWER_LEAD.test(norm);

  if (!answerLike) {
    const command = commandRoute(norm, state);
    if (command) return command;
  }

  if (state.pendingPlan) {
    const yn = readConsent(spoken, norm);
    if (yn === 'yes') {
      const { plan_id, confirm_token } = state.pendingPlan;
      return tool('repair_apply', { plan_id, confirm_token }, 'apply_plan');
    }
    if (yn === 'no') return reply(REPLIES.declinePlan, 'decline_plan', clearPending(state, ['pendingPlan']));
    if (yn === 'observation') return reply(REPLIES.planWaiting);
  }

  if (state.pendingQuestion) {
    if (CANCEL_QUESTION.test(norm)) return reply(REPLIES.cancelQuestion, 'cancel', clearPending(state, ['pendingQuestion']));
    const { diagnosis_id, question_id } = state.pendingQuestion;
    const answer = tool('diagnose_answer', { diagnosis_id, question_id, answer: clip(spoken) }, 'answer_question');
    if (answerLike) return answer;
    // A question back ("is the hallway lamp working?") is a new request when it reads as one, even
    // though parseYesNo would hear "working" as a yes.
    if (!ASKING.test(norm) && parseYesNo(spoken) !== 'unclear') return answer;
    return newRequest(spoken, norm, state) ?? answer;
  }

  if (state.pendingOffer) {
    const yn = readConsent(spoken, norm);
    const args = offerArgs(state);
    if (yn === 'yes' && args) return tool('repair_plan', args, 'accept_offer');
    if (yn === 'no') return reply(REPLIES.declineOffer, 'decline_offer', clearPending(state, ['pendingOffer']));
    if (yn === 'observation') return reply(REPLIES.offerWaiting);
  }

  const request = newRequest(spoken, norm, state);
  if (request) return request;

  // "apply the fix" with nothing planned is "fix that" ("do it" alone stays a stray yes).
  if (FIX_THAT.test(norm) || (/\bapply\b/.test(norm) && APPLY_IT.test(norm))) return fixThatRoute(state);
  if (THANKS.test(norm)) return reply(REPLIES.thanks, 'help');
  if (HELP.test(norm)) return reply(REPLIES.help, 'help');
  // Something waits for a yes or no: say what it is instead of the generic hint.
  if (state.pendingPlan) return planReminder(norm, state.pendingPlan);
  if (state.pendingOffer && (answerLike || parseYesNo(spoken, { consent: true }) !== 'unclear')) return reply(REPLIES.offerAsk);
  if (parseYesNo(spoken, { consent: true }) !== 'unclear') return reply(REPLIES.strayAnswer);
  return reply(REPLIES.fallback);
}
