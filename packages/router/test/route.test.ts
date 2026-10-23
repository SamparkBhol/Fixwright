// Table tests for routeUtterance. Conversation states are built by folding the real protocol fixtures
// through applyResult, so ids and tokens are the ones the golden path really carries.

import { describe, expect, it } from 'vitest';
import diagnoseFx from '@fixwright/protocol/fixtures/diagnose.json' with { type: 'json' };
import answerFx from '@fixwright/protocol/fixtures/diagnose_answer.json' with { type: 'json' };
import planFx from '@fixwright/protocol/fixtures/repair_plan.json' with { type: 'json' };
import applyFx from '@fixwright/protocol/fixtures/repair_apply.json' with { type: 'json' };
import explainFx from '@fixwright/protocol/fixtures/explain_event.json' with { type: 'json' };
import checkupFx from '@fixwright/protocol/fixtures/home_checkup.json' with { type: 'json' };
import { applyResult, consentOf, initialState, isToolRoute, REPLIES, routeUtterance, type ConversationState, type Intent } from '../src/index.ts';

const S0 = initialState();
const QUESTION = applyResult(S0, { tool: 'diagnose', structuredContent: diagnoseFx });
const VERDICT = applyResult(QUESTION, { tool: 'diagnose_answer', structuredContent: answerFx });
const PLAN = applyResult(VERDICT, { tool: 'repair_plan', structuredContent: planFx });
const REPAIRED = applyResult(PLAN, { tool: 'repair_apply', structuredContent: applyFx });
const EXPLAINED = applyResult(REPAIRED, { tool: 'explain_event', structuredContent: explainFx });
const CHECKED = applyResult(REPAIRED, { tool: 'home_checkup', structuredContent: checkupFx });

const DX = diagnoseFx.diagnosis_id;
const QID = diagnoseFx.question!.question_id;
const PLAN_ID = planFx.plan_id;
const TOKEN = planFx.confirm_token;
const REP = applyFx.repair_id;
const SUGGESTED = explainFx.suggested_fix!.issue_id;
const [F1, F2, F3] = checkupFx.findings;

type Expect =
  | { tool: string; args?: Record<string, unknown>; exact?: Record<string, unknown>; intent?: Intent }
  | { reply: string | RegExp; intent?: Intent };

interface Case {
  say: string;
  state?: ConversationState;
  expect: Expect;
}

const cases: Record<string, Case> = {
  // Golden path
  'golden 1: diagnose with wake word and invocation': {
    say: "Alexa, ask Fixwright why the hallway lamp keeps saying it's not responding.",
    expect: { tool: 'diagnose', exact: { symptom: "why the hallway lamp keeps saying it's not responding.", device: 'hallway lamp' } },
  },
  'golden 2: yes it blinked answers the pending question word for word': {
    say: 'Yes, it blinked.',
    state: QUESTION,
    expect: { tool: 'diagnose_answer', exact: { diagnosis_id: DX, question_id: QID, answer: 'Yes, it blinked.' } },
  },
  'golden 3a: yes after the verdict plans the fix': { say: 'Yes.', state: VERDICT, expect: { tool: 'repair_plan', exact: { diagnosis_id: DX }, intent: 'accept_offer' } },
  'golden 3b: yes to the plan applies it with its token': {
    say: 'Yes.',
    state: PLAN,
    expect: { tool: 'repair_apply', exact: { plan_id: PLAN_ID, confirm_token: TOKEN }, intent: 'apply_plan' },
  },
  'golden 5: why did every plug turn on at 3 am': {
    say: 'Why did every plug turn on at 3 a.m.?',
    expect: { tool: 'explain_event', exact: { question: 'Why did every plug turn on at 3 a.m.?' } },
  },
  'golden 5b: do it after the explanation plans the suggested fix': {
    say: 'Do it.',
    state: EXPLAINED,
    expect: { tool: 'repair_plan', exact: { issue_id: SUGGESTED } },
  },
  'golden 6: give my house a checkup': { say: 'Give my house a checkup.', expect: { tool: 'home_checkup', exact: {} } },
  'golden 7: turn off the living room power strip': {
    say: 'Turn off the living room power strip.',
    expect: { tool: 'switch_device', exact: { device: 'living room power strip', on: false } },
  },

  // diagnose variants
  'diagnose: why is X offline': { say: 'Why is the kitchen plug offline?', expect: { tool: 'diagnose', args: { device: 'kitchen plug' } } },
  "diagnose: X isn't working": { say: "My porch light isn't working", expect: { tool: 'diagnose', args: { device: 'porch light' } } },
  "diagnose: why won't X turn on": { say: "Why won't the bedroom fan turn on?", expect: { tool: 'diagnose', args: { device: 'bedroom fan' } } },
  "diagnose: X won't turn on (no why)": { say: "the hallway lamp won't turn on", expect: { tool: 'diagnose', args: { device: 'hallway lamp' } } },
  'diagnose: does X keep going offline': { say: 'Why does the kitchen plug keep going offline', expect: { tool: 'diagnose', args: { device: 'kitchen plug' } } },
  'diagnose: what is wrong with X': { say: "What's wrong with the thermostat?", expect: { tool: 'diagnose', args: { device: 'thermostat' } } },
  'diagnose: X not responding': { say: 'hallway lamp not responding', expect: { tool: 'diagnose', args: { device: 'hallway lamp' } } },
  'diagnose: unavailable': { say: 'Why is the hall motion sensor unavailable', expect: { tool: 'diagnose', args: { device: 'hall motion sensor' } } },
  'diagnose: stopped responding (past tense stays diagnose)': {
    say: 'Why did the hallway lamp stop responding?',
    expect: { tool: 'diagnose', args: { device: 'hallway lamp' } },
  },
  'diagnose: Hindi kaam nahi kar raha': { say: 'hallway lamp kaam nahi kar raha', expect: { tool: 'diagnose', args: { device: 'hallway lamp' } } },
  'diagnose: check the X': { say: 'Check the porch light', expect: { tool: 'diagnose', exact: { symptom: 'Check the porch light', device: 'porch light' } } },
  'diagnose: no device named keeps the symptom only': { say: "It's not working", expect: { tool: 'diagnose', exact: { symptom: "It's not working" } } },
  'diagnose: "it" uses the last device': {
    say: "Why is it still not responding?",
    state: { ...S0, lastDevice: 'Hallway Lamp' },
    expect: { tool: 'diagnose', args: { device: 'Hallway Lamp' } },
  },
  'diagnose: fix the X with no context finds the fault first': { say: 'Fix the hallway lamp, it is broken', expect: { tool: 'diagnose', args: { device: 'hallway lamp' } } },
  'diagnose: why did X go offline': { say: 'why did the hallway lamp go offline', expect: { tool: 'diagnose', exact: { symptom: 'why did the hallway lamp go offline', device: 'hallway lamp' } } },
  'diagnose: why does X go offline': { say: 'why does the kitchen plug go offline', expect: { tool: 'diagnose', args: { device: 'kitchen plug' } } },
  'diagnose: why has X gone offline': { say: 'Why has the porch light gone offline?', expect: { tool: 'diagnose', args: { device: 'porch light' } } },
  'diagnose: X keeps dropping off wifi': { say: 'why is the kitchen plug dropping off wifi', expect: { tool: 'diagnose', args: { device: 'kitchen plug' } } },
  'diagnose: the reporter is not the device (Alexa says ...)': {
    say: 'Why does Alexa say the hallway lamp is not responding?',
    expect: { tool: 'diagnose', args: { device: 'hallway lamp' } },
  },
  'diagnose: is X broken': { say: 'is the porch light broken', expect: { tool: 'diagnose', args: { device: 'porch light' } } },
  'diagnose: the app says X is offline': { say: 'The app says the kitchen plug is offline', expect: { tool: 'diagnose', args: { device: 'kitchen plug' } } },
  "diagnose: I can't get X to turn on": { say: "I can't get the porch light to turn on", expect: { tool: 'diagnose', args: { device: 'porch light' } } },
  'diagnose: a named device beats "it" (what about X, it ...)': {
    say: 'what about the kitchen plug, it keeps dropping',
    state: { ...S0, lastDevice: 'Hallway Lamp' },
    expect: { tool: 'diagnose', args: { device: 'kitchen plug' } },
  },
  'diagnose: a bare device clause names "it"': {
    say: 'The kitchen plug. It keeps dropping off.',
    state: { ...S0, lastDevice: 'Hallway Lamp' },
    expect: { tool: 'diagnose', args: { device: 'kitchen plug' } },
  },
  'diagnose: "it" alone still means the last device': {
    say: 'it keeps dropping',
    state: { ...S0, lastDevice: 'Kitchen Plug' },
    expect: { tool: 'diagnose', args: { device: 'Kitchen Plug' } },
  },
  'diagnose: a filler clause is not a device': { say: 'ugh, it keeps going offline', state: { ...S0, lastDevice: 'Hallway Lamp' }, expect: { tool: 'diagnose', args: { device: 'Hallway Lamp' } } },
  'diagnose: is X working': { say: 'Is the hallway lamp working?', expect: { tool: 'diagnose', args: { device: 'hallway lamp' } } },
  'diagnose: is X online': { say: 'is the kitchen plug online', expect: { tool: 'diagnose', args: { device: 'kitchen plug' } } },
  'diagnose: is X not working keeps the device whole': { say: 'Is the kitchen plug not working?', expect: { tool: 'diagnose', args: { device: 'kitchen plug' } } },
  "diagnose: why won't X switch on": { say: "Why won't my bedroom lamp switch on?", expect: { tool: 'diagnose', args: { device: 'bedroom lamp' } } },
  'diagnose: "switch" inside a device name stays in it': { say: "Why won't the hallway switch turn on?", expect: { tool: 'diagnose', args: { device: 'hallway switch' } } },
  'diagnose: "it keeps saying X ..." names X': {
    say: 'Why does it keep saying the hallway lamp is not responding?',
    state: { ...S0, lastDevice: 'Kitchen Plug' },
    expect: { tool: 'diagnose', args: { device: 'hallway lamp' } },
  },
  '"it keeps saying it\'s ..." still means the last device': {
    say: "Why does it keep saying it's not responding?",
    state: { ...S0, lastDevice: 'Kitchen Plug' },
    expect: { tool: 'diagnose', args: { device: 'Kitchen Plug' } },
  },
  'diagnose: what is going on with X': { say: 'What is going on with the kitchen plug?', expect: { tool: 'diagnose', args: { device: 'kitchen plug' } } },

  // diagnose_answer
  'answer: plain no': { say: 'No.', state: QUESTION, expect: { tool: 'diagnose_answer', args: { answer: 'No.' } } },
  "answer: it didn't blink": { say: "It didn't blink", state: QUESTION, expect: { tool: 'diagnose_answer', args: { answer: "It didn't blink" } } },
  'answer: Hindi haan': { say: 'haan', state: QUESTION, expect: { tool: 'diagnose_answer', args: { answer: 'haan' } } },
  'answer: Hindi nahi jala': { say: 'nahi jala', state: QUESTION, expect: { tool: 'diagnose_answer', args: { answer: 'nahi jala' } } },
  'answer: Hindi jal raha hai': { say: 'jal raha hai', state: QUESTION, expect: { tool: 'diagnose_answer', args: { answer: 'jal raha hai' } } },
  'answer: Devanagari haan': { say: 'हाँ', state: QUESTION, expect: { tool: 'diagnose_answer' } },
  'answer: I heard it click': { say: 'I heard it click', state: QUESTION, expect: { tool: 'diagnose_answer' } },
  'answer: hedge still goes to the server (it asks again)': { say: 'not sure', state: QUESTION, expect: { tool: 'diagnose_answer', args: { answer: 'not sure' } } },
  'answer: mumble goes to the server (it asks again)': { say: 'hmm the cat walked by', state: QUESTION, expect: { tool: 'diagnose_answer' } },
  'answer: "no, still not working" is an answer, not a new diagnosis': {
    say: "No, it's still not working",
    state: QUESTION,
    expect: { tool: 'diagnose_answer', args: { answer: "No, it's still not working" } },
  },
  'answer: a clear new request leaves the question': { say: 'Give my house a checkup', state: QUESTION, expect: { tool: 'home_checkup' } },
  'answer: switching a device leaves the question': { say: 'turn off the kitchen plug', state: QUESTION, expect: { tool: 'switch_device', args: { on: false } } },
  'answer: cancel stops the diagnosis': { say: 'cancel', state: QUESTION, expect: { reply: REPLIES.cancelQuestion, intent: 'cancel' } },
  'answer: "wait" is not a cancel (they may be looking)': { say: 'wait', state: QUESTION, expect: { tool: 'diagnose_answer', args: { answer: 'wait' } } },
  'answer: asking "is X working?" is a request, not a yes': { say: 'Is the porch light working?', state: QUESTION, expect: { tool: 'diagnose', args: { device: 'porch light' } } },

  // the yes turn for a plan
  'plan: do it': { say: 'Do it', state: PLAN, expect: { tool: 'repair_apply', exact: { plan_id: PLAN_ID, confirm_token: TOKEN } } },
  'plan: fix it': { say: 'Fix it', state: PLAN, expect: { tool: 'repair_apply', args: { plan_id: PLAN_ID } } },
  'plan: go ahead': { say: 'Go ahead', state: PLAN, expect: { tool: 'repair_apply' } },
  'plan: haan kar do': { say: 'haan kar do', state: PLAN, expect: { tool: 'repair_apply' } },
  'plan: okay counts as consent': { say: 'okay', state: PLAN, expect: { tool: 'repair_apply' } },
  'plan: no declines and drops the plan': { say: 'No, leave it', state: PLAN, expect: { reply: REPLIES.declinePlan, intent: 'decline_plan' } },
  "plan: don't do it declines": { say: "Don't do it", state: PLAN, expect: { reply: REPLIES.declinePlan } },
  'plan: a new request while the plan waits': { say: 'Why did every plug turn on at 3 a.m.?', state: PLAN, expect: { tool: 'explain_event' } },
  'plan: cancel declines': { say: 'Cancel', state: PLAN, expect: { reply: REPLIES.declinePlan, intent: 'decline_plan' } },
  'plan: stop declines': { say: 'stop', state: PLAN, expect: { reply: REPLIES.declinePlan, intent: 'decline_plan' } },
  'plan: wait declines': { say: 'Wait.', state: PLAN, expect: { reply: REPLIES.declinePlan, intent: 'decline_plan' } },
  'plan: not now declines': { say: 'not now, thanks', state: PLAN, expect: { reply: REPLIES.declinePlan, intent: 'decline_plan' } },
  'plan: Hindi rehne do declines': { say: 'rehne do', state: PLAN, expect: { reply: REPLIES.declinePlan, intent: 'decline_plan' } },
  'plan: "yes, it blinked" answers a closed question and never spends the plan': {
    say: 'Yes, it blinked.',
    state: PLAN,
    expect: { reply: REPLIES.planWaiting },
  },
  'plan: "is everything ok?" is a checkup, not consent': { say: 'Is everything ok?', state: PLAN, expect: { tool: 'home_checkup' } },
  'plan: "is X working?" is a question, not consent': { say: 'is the hallway lamp working', state: PLAN, expect: { tool: 'diagnose', args: { device: 'hallway lamp' } } },
  'plan: "can you do it" is consent': { say: 'can you do it', state: PLAN, expect: { tool: 'repair_apply', exact: { plan_id: PLAN_ID, confirm_token: TOKEN } } },
  'plan: "stop protecting X" is a request, not a cancel': {
    say: 'stop protecting the aquarium filter',
    state: PLAN,
    expect: { tool: 'protect_device', exact: { device: 'aquarium filter', protect: false } },
  },
  // How people answer "Apply this fix?" with no sheet open (the voice only speaker).
  'plan: "apply it" is consent': { say: 'apply it', state: PLAN, expect: { tool: 'repair_apply', exact: { plan_id: PLAN_ID, confirm_token: TOKEN }, intent: 'apply_plan' } },
  'plan: "apply the fix" is consent': { say: 'Apply the fix.', state: PLAN, expect: { tool: 'repair_apply', exact: { plan_id: PLAN_ID, confirm_token: TOKEN }, intent: 'apply_plan' } },
  'plan: "yes, apply it please" is consent': { say: 'Yes, apply it please', state: PLAN, expect: { tool: 'repair_apply', exact: { plan_id: PLAN_ID, confirm_token: TOKEN } } },
  'plan: "is it safe?" reads the dry run back': {
    say: 'Is it safe?',
    state: PLAN,
    expect: { reply: `${REPLIES.planDetails} ${planFx.diff_lines.join(' ')} ${REPLIES.planDetailsAsk}` },
  },
  'plan: "what will it change?" reads the dry run back': {
    say: 'What will it change?',
    state: PLAN,
    expect: { reply: `${REPLIES.planDetails} ${planFx.diff_lines.join(' ')} ${REPLIES.planDetailsAsk}` },
  },
  'plan: "yes, is it safe?" asks, it never applies': { say: 'Yes, is it safe?', state: PLAN, expect: { reply: new RegExp(`^${REPLIES.planDetails}`) } },
  'plan: "yes, undo it" never spends the plan': { say: 'yes, undo it', state: PLAN, expect: { reply: REPLIES.planAsk } },

  // the offer after a verdict or explanation
  'offer: fix that': { say: 'Fix that', state: VERDICT, expect: { tool: 'repair_plan', exact: { diagnosis_id: DX } } },
  'offer: yes please': { say: 'yes please', state: VERDICT, expect: { tool: 'repair_plan', exact: { diagnosis_id: DX } } },
  'offer: sure fix it': { say: 'sure, fix it', state: EXPLAINED, expect: { tool: 'repair_plan', exact: { issue_id: SUGGESTED } } },
  'offer: no thanks declines': { say: 'no thanks', state: VERDICT, expect: { reply: REPLIES.declineOffer, intent: 'decline_offer' } },
  'offer: maybe later declines': { say: 'maybe later', state: VERDICT, expect: { reply: REPLIES.declineOffer, intent: 'decline_offer' } },
  'offer: "yes it did" is still a yes': { say: 'yes it did', state: VERDICT, expect: { tool: 'repair_plan', exact: { diagnosis_id: DX } } },
  'offer: an observation again is not consent': { say: 'yes, it blinked', state: VERDICT, expect: { reply: REPLIES.offerWaiting } },
  'offer: explanation_id when only the verdict offers a fix': {
    say: 'yes',
    state: { ...S0, pendingOffer: { kind: 'explanation', id: 'exp_01m52g8k205e3py55a', label: null } },
    expect: { tool: 'repair_plan', exact: { explanation_id: 'exp_01m52g8k205e3py55a' } },
  },
  'fix that: falls back to the last diagnosis': {
    say: 'fix that',
    state: { ...S0, last: { ...S0.last, diagnosis_id: DX } },
    expect: { tool: 'repair_plan', exact: { diagnosis_id: DX }, intent: 'fix_that' },
  },
  'fix that: nothing to fix yet': { say: 'Fix that', expect: { reply: REPLIES.nothingToFix } },

  // explain_event variants
  'explain: what happened last night': { say: 'What happened last night?', expect: { tool: 'explain_event', exact: { question: 'What happened last night?' } } },
  'explain: what turned the porch light off last night': { say: 'What turned the porch light off last night?', expect: { tool: 'explain_event' } },
  'explain: why did X turn off at 11 pm': { say: 'Why did the kitchen plug turn off at 11 pm?', expect: { tool: 'explain_event' } },
  'explain: the lights came on overnight': { say: 'the lights came on overnight, why?', expect: { tool: 'explain_event' } },
  'explain: at 3:12': { say: 'why did the hallway lamp turn on at 3:12', expect: { tool: 'explain_event' } },
  'explain: Hindi kal raat kya hua': { say: 'kal raat kya hua', expect: { tool: 'explain_event' } },
  'explain: a symptom with a time is a past event': { say: 'Why did the hallway lamp go offline at 3 a.m.?', expect: { tool: 'explain_event' } },

  // checkup
  'checkup: check up (two words)': { say: 'Can you do a check up?', expect: { tool: 'home_checkup', exact: {} } },
  'checkup: health check': { say: 'Run a health check on my house', expect: { tool: 'home_checkup', exact: {} } },
  'checkup: anything wrong with my house': { say: 'Is anything wrong with my house?', expect: { tool: 'home_checkup' } },
  'checkup: focus on the kitchen': { say: 'Do a checkup of the kitchen', expect: { tool: 'home_checkup', exact: { focus: 'kitchen' } } },
  'checkup: batteries focus': { say: 'Check the batteries', expect: { tool: 'home_checkup', exact: { focus: 'batteries' } } },
  'checkup: is my house ok': { say: 'Is my house ok?', expect: { tool: 'home_checkup', exact: {} } },
  'checkup: is everything alright': { say: 'is everything alright', expect: { tool: 'home_checkup', exact: {} } },
  'checkup: what is going on with my house': { say: "What's going on with my house?", expect: { tool: 'home_checkup', exact: {} } },
  "checkup: what's wrong with my home": { say: "what's wrong with my home", expect: { tool: 'home_checkup', exact: {} } },

  // fixing a checkup finding
  'finding: fix the first one': { say: 'Fix the first one', state: CHECKED, expect: { tool: 'repair_plan', exact: { issue_id: F1!.issue_id } } },
  'finding: by name': { say: 'Fix the living room light', state: CHECKED, expect: { tool: 'repair_plan', exact: { issue_id: F1!.issue_id } } },
  'finding: not fixable by Fixwright says why': { say: 'fix the battery one', state: CHECKED, expect: { reply: `${REPLIES.notFixable} ${F2!.detail}` } },
  'finding: third one passes on the advice': { say: 'repair number three', state: CHECKED, expect: { reply: `${REPLIES.notFixable} ${F3!.detail}` } },
  'finding: by device name passes on the advice': {
    say: 'fix the kitchen plug',
    state: CHECKED,
    expect: { reply: "I can't fix that one by myself. Its Wi-Fi signal is weak, at -82 dBm. Moving the plug or the router closer usually helps." },
  },
  'finding: an older state without advice still answers': {
    say: 'fix the kitchen plug',
    state: { ...CHECKED, findings: CHECKED.findings.map(({ detail: _d, ...f }) => f) },
    expect: { reply: REPLIES.notFixable },
  },
  'finding: fix that with several findings asks which': { say: 'fix it', state: CHECKED, expect: { reply: REPLIES.whichFinding } },
  'finding: by kind (the duplicate name)': { say: 'Fix the duplicate name', state: CHECKED, expect: { tool: 'repair_plan', exact: { issue_id: F1!.issue_id }, intent: 'fix_finding' } },
  'finding: by kind (the wifi one) passes on the advice': { say: 'fix the wifi one', state: CHECKED, expect: { reply: `${REPLIES.notFixable} ${F3!.detail}` } },
  'finding: a device not in the checkup is diagnosed': { say: 'fix the hallway lamp', state: CHECKED, expect: { tool: 'diagnose', args: { device: 'hallway lamp' } } },

  // switch_device
  'switch: turn on X': { say: 'Turn on the hallway lamp', expect: { tool: 'switch_device', exact: { device: 'hallway lamp', on: true } } },
  'switch: switch X off': { say: 'switch the kitchen plug off', expect: { tool: 'switch_device', exact: { device: 'kitchen plug', on: false } } },
  'switch: please turn off X please': { say: 'Please turn off the floor lamp please', expect: { tool: 'switch_device', exact: { device: 'floor lamp', on: false } } },
  'switch: shut down X': { say: 'shut down the grow light', expect: { tool: 'switch_device', exact: { device: 'grow light', on: false } } },
  'switch: Hindi band kar do': { say: 'living room light band kar do', expect: { tool: 'switch_device', exact: { device: 'living room light', on: false } } },
  'switch: Hindi chalu karo': { say: 'pankha chalu karo', expect: { tool: 'switch_device', exact: { device: 'pankha', on: true } } },
  'switch: "it" uses the last device': {
    say: 'turn it off',
    state: { ...S0, lastDevice: 'Floor Lamp' },
    expect: { tool: 'switch_device', exact: { device: 'Floor Lamp', on: false } },
  },
  'switch: "it" with no device asks which': { say: 'turn it off', expect: { reply: REPLIES.whichDevice } },

  // protect_device
  'protect: protect X': { say: 'Protect the aquarium filter', expect: { tool: 'protect_device', exact: { device: 'aquarium filter' } } },
  'protect: never turn off X because': {
    say: 'Never turn off the aquarium filter because the fish need it',
    expect: { tool: 'protect_device', exact: { device: 'aquarium filter', reason: 'the fish need it' } },
  },
  "protect: don't ever switch off X": { say: "Don't ever switch off the freezer", expect: { tool: 'protect_device', exact: { device: 'freezer' } } },
  'protect: always keep X on': { say: 'Always keep the grow light on', expect: { tool: 'protect_device', exact: { device: 'grow light' } } },
  'unprotect: stop protecting X': {
    say: 'Stop protecting the aquarium filter',
    expect: { tool: 'protect_device', exact: { device: 'aquarium filter', protect: false }, intent: 'unprotect' },
  },

  // undo and status
  'undo: undo': { say: 'Undo that', state: REPAIRED, expect: { tool: 'undo', exact: { repair_id: REP } } },
  'undo: put it back': { say: 'Put it back the way it was', state: REPAIRED, expect: { tool: 'undo', exact: { repair_id: REP } } },
  'undo: nothing to undo': { say: 'undo', expect: { reply: REPLIES.nothingToUndo } },
  'status: did the fix hold': { say: 'Did the fix hold?', state: REPAIRED, expect: { tool: 'repair_status', exact: { repair_id: REP } } },
  'status: status': { say: 'status', state: REPAIRED, expect: { tool: 'repair_status', exact: { repair_id: REP } } },
  'status: how is the lamp doing since you fixed it': {
    say: 'How is the hallway lamp doing since you fixed it?',
    state: REPAIRED,
    expect: { tool: 'repair_status', exact: { repair_id: REP } },
  },
  'status: nothing repaired yet': { say: 'Did the fix work?', expect: { reply: REPLIES.noRepairYet } },
  'status: wins over a pending plan': { say: 'did the fix hold', state: { ...PLAN, last: { ...PLAN.last, repair_id: REP } }, expect: { tool: 'repair_status' } },

  // replies
  'reply: empty': { say: '   ', expect: { reply: REPLIES.empty } },
  'reply: wake word only': { say: 'Alexa,', expect: { reply: REPLIES.empty } },
  'reply: help': { say: 'What can you do?', expect: { reply: REPLIES.help, intent: 'help' } },
  'reply: stray yes': { say: 'yes', expect: { reply: REPLIES.strayAnswer } },
  'reply: unknown': { say: 'Play some jazz', expect: { reply: REPLIES.fallback } },
};

describe('routeUtterance', () => {
  for (const [name, c] of Object.entries(cases)) {
    it(name, () => {
      const route = routeUtterance(c.say, c.state ?? S0);
      if ('tool' in c.expect) {
        expect(isToolRoute(route), JSON.stringify(route)).toBe(true);
        if (!isToolRoute(route)) return;
        expect(route.tool).toBe(c.expect.tool);
        if (c.expect.exact) expect(route.arguments).toEqual(c.expect.exact);
        if (c.expect.args) expect(route.arguments).toMatchObject(c.expect.args);
        if (c.expect.intent) expect(route.intent).toBe(c.expect.intent);
      } else {
        expect(isToolRoute(route), JSON.stringify(route)).toBe(false);
        if (isToolRoute(route)) return;
        if (typeof c.expect.reply === 'string') expect(route.reply).toBe(c.expect.reply);
        else expect(route.reply).toMatch(c.expect.reply);
        if (c.expect.intent) expect(route.intent).toBe(c.expect.intent);
      }
    });
  }

  it('has at least 60 table cases', () => {
    expect(Object.keys(cases).length).toBeGreaterThanOrEqual(60);
  });

  it('declining a plan returns a state without the plan and keeps everything else', () => {
    const route = routeUtterance('no', PLAN);
    expect(isToolRoute(route)).toBe(false);
    if (isToolRoute(route)) return;
    expect(route.state?.pendingPlan).toBeNull();
    expect(route.state?.last).toEqual(PLAN.last);
  });

  it('declining an offer clears only the offer', () => {
    const route = routeUtterance('nahi', VERDICT);
    expect(!isToolRoute(route) && route.state?.pendingOffer).toBeNull();
    expect(!isToolRoute(route) && route.state?.last.diagnosis_id).toBe(DX);
  });

  it('never sends a confirm_token without a pending plan', () => {
    for (const say of ['yes', 'do it', 'fix it', 'go ahead', 'haan']) {
      for (const state of [S0, QUESTION, VERDICT, REPAIRED, EXPLAINED, CHECKED]) {
        const route = routeUtterance(say, state);
        if (isToolRoute(route)) expect(route.tool, `${say}`).not.toBe('repair_apply');
      }
    }
  });

  it('does not mutate the state it is given', () => {
    const before = JSON.stringify(PLAN);
    routeUtterance('no', PLAN);
    routeUtterance('yes', PLAN);
    expect(JSON.stringify(PLAN)).toBe(before);
  });

  it('consentOf: questions, observations and stops are never a yes', () => {
    const table: Array<[string, 'yes' | 'no' | 'unclear']> = [
      ['yes', 'yes'],
      ['Yes, apply it', 'yes'],
      ['apply it', 'yes'],
      ['apply the fix', 'yes'],
      ['do it', 'yes'],
      ['go ahead', 'yes'],
      ['haan kar do', 'yes'],
      ['okay', 'yes'],
      ['Alexa, yes', 'yes'],
      ['no', 'no'],
      ['Not now', 'no'],
      ['cancel', 'no'],
      ['rehne do', 'no'],
      ["don't do it", 'no'],
      ['Yes, it blinked.', 'unclear'],
      ['is everything ok?', 'unclear'],
      ['is the hallway lamp working', 'unclear'],
      ['give my house a checkup', 'unclear'],
      // A yes that carries another request answers that request, not "Apply this fix?".
      ['yes undo it', 'unclear'],
      ['Yes, undo it.', 'unclear'],
      ['yes, is it safe?', 'unclear'],
      ['what will it change?', 'unclear'],
      ['', 'unclear'],
    ];
    for (const [say, want] of table) expect(consentOf(say), say).toBe(want);
  });

  it('every tool route passes the protocol input schema', async () => {
    const { ToolInputs } = await import('@fixwright/protocol');
    for (const [name, c] of Object.entries(cases)) {
      const route = routeUtterance(c.say, c.state ?? S0);
      if (!isToolRoute(route)) continue;
      const parsed = ToolInputs[route.tool].safeParse(route.arguments);
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });
});
