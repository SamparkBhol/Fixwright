// The claim checker drops claims whose evidence is missing or
// says something else, downgrades a confirmed verdict that lost one, keeps framing free of facts, and
// gates an LLM phraser sentence by sentence.

import { describe, expect, it } from 'vitest';
import type { Verdict } from '@fixwright/protocol';
import {
  answerDiagnosis,
  asFacts,
  checkClaims,
  checkVerdict,
  createMemoryLedger,
  explainEvent,
  phraseLines,
  rephraseAllowed,
  startDiagnosis,
  statesFacts,
  type CheckedClaim,
  type Phraser,
} from '../src/index.ts';
import { rig } from './support/golden-house.ts';

async function ledgerWithEvents() {
  const ledger = createMemoryLedger();
  const offline = await ledger.append({ ts: '2026-10-03T18:42:10.000Z', kind: 'availability', entityId: 'light.hallway_lamp', from: 'on', to: 'unavailable', source: 'home' });
  const other = await ledger.append({ ts: '2026-10-15T09:00:00.000Z', kind: 'state', entityId: 'switch.kitchen_plug', from: 'off', to: 'on', source: 'home' });
  const probe = await ledger.append({
    ts: '2026-10-15T17:20:00.000Z',
    kind: 'probe',
    entityId: 'light.hallway_lamp_2',
    source: 'fixwright',
    data: { probe_id: 'flash_test', value: 'answered', entity_ids: ['light.hallway_lamp_2'] },
  });
  const run = await ledger.append({ ts: '2026-10-15T10:12:01.000Z', kind: 'automation_run', entityId: 'automation.night_lights', source: 'home', context: { automationId: 'night_lights' } });
  return { ledger, offline, other, probe, run };
}

describe('claim checker', () => {
  it('drops a fabricated claim and downgrades confirmed to likely', async () => {
    const { ledger, offline } = await ledgerWithEvents();
    const verdict: Verdict = {
      level: 'confirmed',
      cause_id: 'stale_duplicate',
      label: 'Name points at an old copy',
      confidence: 0.95,
      claims: [
        { text: 'The old copy went offline on October 3.', evidence: [offline] },
        { text: 'The lamp was unplugged by a guest.', evidence: [9999] },
      ],
      fix_available: true,
    };
    const { verdict: checked, dropped } = await checkVerdict(verdict, asFacts(verdict.claims), ledger);
    expect(checked.level).toBe('likely');
    expect(checked.claims.map((c) => c.text)).toEqual(['The old copy went offline on October 3.']);
    expect(dropped.map((d) => d.reason)).toEqual(['evidence 9999 is not in the ledger']);
  });

  it('keeps a confirmed verdict whose claims all hold', async () => {
    const { ledger, offline } = await ledgerWithEvents();
    const verdict: Verdict = {
      level: 'confirmed',
      cause_id: 'stale_duplicate',
      label: 'x',
      confidence: 0.94,
      claims: [{ text: 'The old copy went offline on October 3.', evidence: [offline] }],
      fix_available: true,
    };
    expect((await checkVerdict(verdict, asFacts(verdict.claims), ledger)).verdict.level).toBe('confirmed');
  });

  it('drops a claim citing an event about another device', async () => {
    const { ledger, other } = await ledgerWithEvents();
    const claim: CheckedClaim = { text: 'The hallway lamp went offline.', evidence: [other], kind: 'fact', support: { entityIds: ['light.hallway_lamp'] } };
    const { kept, dropped } = await checkClaims([claim], ledger);
    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toMatch(/different device/);
  });

  it('drops a claim whose time does not match its evidence', async () => {
    const { ledger, offline } = await ledgerWithEvents();
    const claim: CheckedClaim = {
      text: 'It went offline on October 9.',
      evidence: [offline],
      kind: 'fact',
      support: { window: { since: '2026-10-09T07:00:00.000Z', until: '2026-10-10T06:59:59.999Z' } },
    };
    expect((await checkClaims([claim], ledger)).dropped).toHaveLength(1);
  });

  it('drops a claim whose probe reported the opposite value', async () => {
    const { ledger, probe } = await ledgerWithEvents();
    const claim: CheckedClaim = { text: "It didn't answer.", evidence: [probe], kind: 'fact', support: { probeValues: [{ probe_id: 'flash_test', values: ['no_answer'] }] } };
    expect((await checkClaims([claim], ledger)).dropped[0]?.reason).toBe('no flash_test result shows no_answer');
  });

  it('checks absence claims against the ledger', async () => {
    const { ledger, other } = await ledgerWithEvents();
    const claim: CheckedClaim = {
      text: 'None of your automations fired.',
      evidence: [other],
      kind: 'fact',
      support: { absent: { kinds: ['automation_run'], since: '2026-10-15T10:12:00.000Z', until: '2026-10-15T10:13:00.000Z' } },
    };
    expect((await checkClaims([claim], ledger)).dropped[0]?.reason).toMatch(/automation_run/);
  });

  it('checks the device count', async () => {
    const { ledger, offline, other } = await ledgerWithEvents();
    const claim: CheckedClaim = { text: 'Three devices restarted.', evidence: [offline, other], kind: 'fact', support: { distinctEntities: 3 } };
    expect((await checkClaims([claim], ledger)).dropped[0]?.reason).toBe('cites 2 devices, claims 3');
  });

  it('keeps framing only when it states no facts and cites nothing', async () => {
    const { ledger, offline } = await ledgerWithEvents();
    const claims: CheckedClaim[] = [
      { text: 'Want me to fix that?', evidence: [], kind: 'framing' },
      { text: 'Fourteen devices restarted.', evidence: [], kind: 'framing' },
      { text: 'The Hallway Lamp needs a look.', evidence: [], kind: 'framing' },
      { text: 'Here is what I found.', evidence: [offline], kind: 'framing' },
      { text: 'The lamp is fine.', evidence: [], kind: 'fact' },
    ];
    const { kept, dropped } = await checkClaims(claims, ledger, { houseWords: ['Hallway Lamp'] });
    expect(kept.map((c) => c.text)).toEqual(['Want me to fix that?']);
    expect(dropped.map((d) => d.reason)).toEqual([
      'framing text states a fact about the house',
      'framing text states a fact about the house',
      'framing text cites evidence',
      'no evidence',
    ]);
  });

  it('spots facts in text', () => {
    expect(statesFacts("I'll check on it again tomorrow morning.")).toBe(false);
    expect(statesFacts('It went offline on October 3.')).toBe(true);
    expect(statesFacts('It dropped off nine times.')).toBe(true);
    expect(statesFacts('It went off yesterday.')).toBe(true);
  });
});

describe('phraser gate', () => {
  const fact: CheckedClaim = { text: 'Power came back at 3:12.', evidence: [1], kind: 'fact' };
  const framing: CheckedClaim = { text: 'Want me to fix that?', evidence: [], kind: 'framing' };

  it('accepts a restyled sentence with the same content words in the same order', () => {
    expect(rephraseAllowed(fact, 'So, power came back at 3:12.')).toBe(true);
    expect(rephraseAllowed(framing, 'Do you want me to fix that?')).toBe(true);
    expect(rephraseAllowed({ text: 'The lamp works.', evidence: [1], kind: 'fact' }, 'Okay, the lamp is working.')).toBe(true);
  });

  it('rejects meaning reversals and swapped roles, which a word list alone would miss', () => {
    const works: CheckedClaim = { text: 'The lamp works.', evidence: [1], kind: 'fact' };
    expect(rephraseAllowed(works, 'The lamp is broken.')).toBe(false);
    expect(rephraseAllowed(fact, 'Power went out at 3:12.')).toBe(false);
    expect(rephraseAllowed(fact, 'Your power returned at 3:12.')).toBe(false);
    const point: CheckedClaim = { text: 'Hallway Lamp will point to the lamp that is online.', evidence: [1], kind: 'fact' };
    expect(rephraseAllowed(point, 'The lamp that is online will point to Hallway Lamp.')).toBe(false);
    expect(rephraseAllowed(framing, "I'll fix that.")).toBe(false);
    expect(rephraseAllowed(framing, 'I fixed that.')).toBe(false);
    expect(rephraseAllowed({ text: 'Its Wi-Fi signal is weak, at -82 dBm.', evidence: [1], kind: 'fact' }, 'Its Wi-Fi signal is weak, at 82 dBm.')).toBe(false);
  });

  it('rejects swapped people and changed tense, which pronoun and helper words alone would let through', () => {
    const flash: CheckedClaim = { text: 'I switched it on and off, it answered both times.', evidence: [1], kind: 'fact' };
    expect(rephraseAllowed(flash, 'You switched it on and off, it answered both times.')).toBe(false);
    expect(rephraseAllowed({ text: 'None of your automations fired.', evidence: [1], kind: 'fact' }, 'None of my automations fired.')).toBe(false);
    expect(rephraseAllowed({ text: 'Your hub is reachable, the signal is good.', evidence: [1], kind: 'fact' }, 'Your hub was reachable, the signal was good.')).toBe(false);
    const offline: CheckedClaim = { text: 'The hallway lamp has been offline since 3 October.', evidence: [1], kind: 'fact' };
    expect(rephraseAllowed(offline, 'The hallway lamp had been offline since 3 October.')).toBe(false);
    expect(rephraseAllowed({ text: 'Its wall switch is off.', evidence: [1], kind: 'fact' }, 'Was its wall switch off.')).toBe(false);
    expect(rephraseAllowed({ text: 'The lamp works.', evidence: [1], kind: 'fact' }, 'The lamp was working.')).toBe(false);
    // Still allowed: warmth, the implied "you", and a present helper where the template had none.
    expect(rephraseAllowed(flash, 'Okay, I switched it on and off, and it answered both times.')).toBe(true);
    expect(rephraseAllowed(offline, 'So, the hallway lamp has been offline since 3 October.')).toBe(true);
    expect(rephraseAllowed(framing, 'Do you want me to fix that?')).toBe(true);
  });

  it('rejects new numbers, flipped negation, facts in framing and unspeakable text', () => {
    expect(rephraseAllowed(fact, 'Power came back at 3:15.')).toBe(false);
    expect(rephraseAllowed(fact, 'Power came back at 3:12 after 20 minutes.')).toBe(false);
    expect(rephraseAllowed({ text: 'None of your automations fired.', evidence: [1], kind: 'fact' }, 'Your automations fired.')).toBe(false);
    expect(rephraseAllowed(framing, 'Want me to fix the Hallway Lamp?', ['Hallway Lamp'])).toBe(false);
    expect(rephraseAllowed(fact, 'Power came back at **3:12**.')).toBe(false);
  });

  it('uses the template for any line the phraser gets wrong, and ignores a broken phraser', async () => {
    const phraser: Phraser = () => ['So, power came back at 3:12.', 'Shall I fix the Hallway Lamp?'];
    expect(await phraseLines([fact, framing], phraser, ['Hallway Lamp'])).toEqual(['So, power came back at 3:12.', 'Want me to fix that?']);
    const throws: Phraser = () => {
      throw new Error('model down');
    };
    expect(await phraseLines([fact], throws)).toEqual(['Power came back at 3:12.']);
    expect(await phraseLines([fact, framing], () => ['only one'])).toEqual(['Power came back at 3:12.', 'Want me to fix that?']);
  });

  it('cannot slip a fabricated fact into the spoken verdict', async () => {
    const r = rig();
    r.deps.phraser = (lines) => lines.map((l) => (l.kind === 'fact' ? `${l.text.replace(/\.$/, '')} and 3 other lamps too.` : l.text));
    const dx = await startDiagnosis({ symptom: "the hallway lamp isn't responding" }, r.deps);
    const yes = await answerDiagnosis(dx.session, { diagnosis_id: dx.session.diagnosis_id, question_id: dx.output.question?.question_id ?? '', answer: 'yes' }, r.deps);
    expect(yes.output.speech).toBe(
      'The lamp works. The name Hallway Lamp still points at an old copy of it that went offline on October 3. Want me to fix that?',
    );
  });

  it('lets a faithful phraser restyle the explanation', async () => {
    const r = rig();
    r.deps.phraser = (lines) => lines.map((l) => l.text.replace('Power came back at', 'So, the power came back at'));
    const { output } = await explainEvent({ question: 'Why did every plug turn on at 3 a.m.?' }, r.deps);
    expect(output.speech.startsWith('So, the power came back at 3:12.')).toBe(true);
    expect(output.verdict.claims[0]?.text).toBe('Power came back at 3:12.');
  });
});
