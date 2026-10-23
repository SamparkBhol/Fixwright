// One mock household: answers the 11 Fixwright tools from the protocol's golden path fixtures with
// consistent, chaining ids, plus the small amount of state the host needs to exercise every branch
// (questions answered once, plans applied once with their own token, repairs that confirm after the
// next morning clock jump, undo, protected loads). It is a stand in for apps/server in host tests,
// not a model of a house: every number it returns comes from the fixtures.

import diagnoseFx from '@fixwright/protocol/fixtures/diagnose.json' with { type: 'json' };
import answerFx from '@fixwright/protocol/fixtures/diagnose_answer.json' with { type: 'json' };
import explainFx from '@fixwright/protocol/fixtures/explain_event.json' with { type: 'json' };
import checkupFx from '@fixwright/protocol/fixtures/home_checkup.json' with { type: 'json' };
import planFx from '@fixwright/protocol/fixtures/repair_plan.json' with { type: 'json' };
import applyFx from '@fixwright/protocol/fixtures/repair_apply.json' with { type: 'json' };
import statusFx from '@fixwright/protocol/fixtures/repair_status.json' with { type: 'json' };
import undoFx from '@fixwright/protocol/fixtures/undo.json' with { type: 'json' };
import protectFx from '@fixwright/protocol/fixtures/protect_device.json' with { type: 'json' };
import switchFx from '@fixwright/protocol/fixtures/switch_device.json' with { type: 'json' };
import houseFx from './house.json' with { type: 'json' };
import {
  createIdFactory,
  manualClock,
  parseYesNo,
  problemOutput,
  protocolError,
  seededRng,
  type ManualClock,
  type ProblemCode,
  type ToolName,
} from '@fixwright/protocol';
import { FAULT_IDS } from '../../src/faults.ts';

export interface ToolReply {
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

type Json = Record<string, unknown>;

const SOURCE = { adapter: 'simhome', simulated: true } as const;
/** The fixtures' story starts here (UTC); 17:20 is 10:20 in the house's Los Angeles time zone. */
export const START = '2026-10-15T17:20:00.000Z';
const NEXT_MORNING = '2026-10-16T14:00:00.000Z';
const DEFAULT_FAULTS = ['ghost_after_repair', 'power_restore_default_on', 'duplicate_spoken_name', 'wifi_flapping', 'low_battery'];

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const HOUSE_TZ = 'America/Los_Angeles';
// house.json records when each device visibly switched in a real SimHome house, as offsets from the flash
// test's probe and from "Power came back"; the fixtures say when those two happened in this story.
const FLASH_AT = Date.parse(diagnoseFx.probes.find((p) => p.probe_id === 'flash_test')?.at ?? START);
const POWER_BACK = Date.parse(explainFx.timeline.find((t) => t.label === 'Power came back')?.ts ?? START);
const FLASH_OFFSETS: Readonly<Record<string, number[]>> = houseFx.flash;
const RESTORE_OFFSETS: Readonly<Record<string, number[]>> = houseFx.restore;

interface PlanRecord {
  plan_id: string;
  token: string;
  used: boolean;
  kind: 'lamp' | 'power' | 'rename';
  ids: Json;
}

interface RepairRecord {
  repair_id: string;
  plan: PlanRecord;
  state: 'applied' | 'confirmed' | 'undone';
  appliedAtMs: number;
}

export interface Push {
  title: string;
  message: string;
  at: string;
}

export interface MockHousehold {
  readonly token: string;
  readonly ntfyTopic: string;
  call(tool: ToolName, args: Json): ToolReply;
  injectFault(id: string): { ok: boolean; active_faults: string[] };
  reset(): void;
  jumpClock(to: unknown): { ok: boolean; now: string; pushes: Push[] };
  snapshot(): Json;
}

export function createHousehold(token: string, seed = 7): MockHousehold {
  let clock: ManualClock = manualClock(START);
  let newId = createIdFactory(clock, seededRng(seed));
  let faults = new Set(DEFAULT_FAULTS);
  let answered = new Set<string>();
  let openQuestions = new Map<string, string>(); // question_id -> diagnosis_id
  let plans = new Map<string, PlanRecord>();
  let repairs = new Map<string, RepairRecord>();
  let outputs = new Map<string, Json>();
  let pushes: Push[] = [];
  let usedFixtureIds = new Set<string>();
  let flashed = false;

  function resetState(): void {
    clock = manualClock(START);
    newId = createIdFactory(clock, seededRng(seed));
    faults = new Set(DEFAULT_FAULTS);
    answered = new Set();
    openQuestions = new Map([[diagnoseFx.question.question_id, diagnoseFx.diagnosis_id]]);
    plans = new Map();
    repairs = new Map();
    outputs = new Map();
    pushes = [];
    usedFixtureIds = new Set();
    flashed = false;
  }
  resetState();

  /** The fixture id the first time, a fresh id after that, so ids never repeat within a household. */
  const firstOr = (fixtureId: string, prefix: 'pln' | 'rep' | 'q'): string => {
    if (usedFixtureIds.has(fixtureId)) return newId(prefix);
    usedFixtureIds.add(fixtureId);
    return fixtureId;
  };

  const actuations = (entityId: string): string[] =>
    [...(RESTORE_OFFSETS[entityId] ?? []).map((t) => POWER_BACK + t), ...(flashed ? (FLASH_OFFSETS[entityId] ?? []).map((t) => FLASH_AT + t) : [])]
      .sort((a, b) => a - b)
      .map((t) => new Date(t).toISOString());

  const remember = (out: Json): Json => {
    const ids = (out['ids'] ?? {}) as Record<string, string>;
    for (const id of Object.values(ids)) outputs.set(id, out);
    return out;
  };

  const ok = (out: Json): ToolReply => ({ structuredContent: remember(out), isError: false });
  const fail = (code: ProblemCode, ids: Json = {}): ToolReply => ({
    structuredContent: problemOutput(protocolError(code), SOURCE, ids) as unknown as Json,
    isError: true,
  });

  function diagnose(): ToolReply {
    // A fresh diagnosis reopens the fixture's question so the golden path can be replayed.
    answered.delete(diagnoseFx.question.question_id);
    flashed = true;
    openQuestions.set(diagnoseFx.question.question_id, diagnoseFx.diagnosis_id);
    return ok(clone(diagnoseFx) as Json);
  }

  // A follow up question for a "no" or an unclear answer. The mock has no model of the house, so the
  // probes and hypotheses stay exactly as the diagnose fixture has them: no number here is made up.
  // Only the question changes, to the power_switch_check probe's wall switch wording.
  function reask(diagnosisId: string, text: string, answer: 'no' | 'unclear'): ToolReply {
    const out = clone(diagnoseFx) as Json;
    const questionId = newId('q');
    openQuestions.set(questionId, diagnosisId);
    const asked = answer === 'no' ? "Okay, it didn't blink." : "I didn't catch that.";
    out['speech'] = `${asked} ${text}`;
    out['question'] = { question_id: questionId, text, expects: 'yes_no' };
    return ok(out);
  }

  function diagnoseAnswer(args: Json): ToolReply {
    const diagnosisId = String(args['diagnosis_id']);
    const questionId = String(args['question_id']);
    if (diagnosisId !== diagnoseFx.diagnosis_id) return fail('session_expired', { diagnosis_id: diagnosisId });
    if (answered.has(questionId)) return fail('question_answered', { diagnosis_id: diagnosisId });
    if (openQuestions.get(questionId) !== diagnosisId) return fail('not_found', { diagnosis_id: diagnosisId });
    const yn = parseYesNo(String(args['answer'] ?? ''));
    answered.add(questionId);
    openQuestions.delete(questionId);
    if (yn === 'yes') return ok(clone(answerFx) as Json);
    if (yn === 'no') return reask(diagnosisId, "Is the lamp's wall switch on?", 'no');
    return reask(diagnosisId, 'Did the hallway lamp blink just now? Please say yes or no.', 'unclear');
  }

  function newPlan(kind: PlanRecord['kind'], ids: Json): ToolReply {
    const out = clone(planFx) as Json;
    const planId = kind === 'lamp' ? firstOr(planFx.plan_id, 'pln') : newId('pln');
    const token = planId === planFx.plan_id ? planFx.confirm_token : `${newId('q').slice(2)}${newId('q').slice(2)}`.slice(0, 32);
    out['plan_id'] = planId;
    out['confirm_token'] = token;
    out['ids'] = { ...ids, plan_id: planId };
    out['expires_at'] = new Date(clock.nowMs() + 5 * 60_000).toISOString();
    if (kind === 'power') {
      out['speech'] = "Here's the fix. The plugs and lights that came back on will remember whether they were on or off after a power cut. Shall I go ahead?";
      out['diff'] = [{ entity_id: 'select.power_on_behavior', field: 'power_on_behavior', from: 'on', to: 'previous' }];
      out['diff_lines'] = ['The plugs and lights that came back on will remember whether they were on or off after a power cut.'];
      out['steps'] = [
        { step: 1, label: 'Set each one to remember its last state', status: 'pending' },
        { step: 2, label: 'Read each setting back', status: 'pending' },
      ];
    } else if (kind === 'rename') {
      out['speech'] = "Here's the fix. The Zigbee bulb gets its own name, so Living Room Light means only the Hue group. Shall I go ahead?";
      out['diff'] = [{ entity_id: 'light.living_room_light_2', field: 'name', from: 'Living Room Light', to: 'Living Room Bulb' }];
      out['diff_lines'] = ['The Zigbee bulb will be called Living Room Bulb, so Living Room Light means only the Hue group.'];
      out['steps'] = [
        { step: 1, label: 'Rename the Zigbee bulb to Living Room Bulb', status: 'pending' },
        { step: 2, label: 'Read the name back', status: 'pending' },
      ];
    }
    plans.set(planId, { plan_id: planId, token, used: false, kind, ids });
    return ok(out);
  }

  function repairPlan(args: Json): ToolReply {
    const dx = args['diagnosis_id'];
    const issue = args['issue_id'];
    const exp = args['explanation_id'];
    if (typeof dx === 'string') {
      if (dx !== answerFx.diagnosis_id || !answered.has(diagnoseFx.question.question_id)) return fail('no_fix', { diagnosis_id: dx });
      return newPlan('lamp', { diagnosis_id: dx });
    }
    if (typeof issue === 'string') {
      if (issue === explainFx.suggested_fix.issue_id) return newPlan('power', { issue_id: issue });
      const finding = checkupFx.findings.find((f) => f.issue_id === issue);
      if (!finding) return fail('not_found', { issue_id: issue });
      if (!finding.fixable) return fail('no_fix', { issue_id: issue });
      return newPlan('rename', { issue_id: issue });
    }
    if (typeof exp === 'string' && exp === explainFx.explanation_id) return newPlan('power', { explanation_id: exp });
    return fail('not_found');
  }

  function repairApply(args: Json): ToolReply {
    const plan = plans.get(String(args['plan_id']));
    if (!plan) return fail('not_found');
    const ids = { ...plan.ids, plan_id: plan.plan_id };
    if (plan.used) return fail('plan_used', ids);
    if (plan.token !== args['confirm_token']) return fail('token_mismatch', ids);
    plan.used = true;
    const repairId = plan.kind === 'lamp' ? firstOr(applyFx.repair_id, 'rep') : newId('rep');
    const out = clone(applyFx) as Json;
    out['repair_id'] = repairId;
    out['plan_id'] = plan.plan_id;
    out['ids'] = { ...ids, repair_id: repairId };
    if (plan.kind !== 'lamp') {
      const steps = (plan.kind === 'power'
        ? [
            { step: 1, label: 'Set each one to remember its last state', read_back: 'Each one reads back as remember last state' },
            { step: 2, label: 'Read each setting back', read_back: 'All settings match' },
          ]
        : [
            { step: 1, label: 'Rename the Zigbee bulb to Living Room Bulb', read_back: 'Name reads Living Room Bulb' },
            { step: 2, label: 'Read the name back', read_back: 'Living Room Light now means only the Hue group' },
          ]
      ).map((s) => ({ ...s, status: 'done' }));
      out['steps'] = steps;
      out['speech'] = plan.kind === 'power' ? "Done. They'll remember whether they were on or off. I'll check on them tomorrow morning." : "Done. I'll check the names again tomorrow morning.";
    }
    repairs.set(repairId, { repair_id: repairId, plan, state: 'applied', appliedAtMs: clock.nowMs() });
    return ok(out);
  }

  function repairCard(rep: RepairRecord, base: Json): Json {
    const out = clone(base);
    out['repair_id'] = rep.repair_id;
    out['plan_id'] = rep.plan.plan_id;
    out['ids'] = { plan_id: rep.plan.plan_id, repair_id: rep.repair_id };
    return out;
  }

  function repairStatus(args: Json): ToolReply {
    const rep = repairs.get(String(args['repair_id']));
    if (!rep) return fail('not_found');
    if (rep.state === 'undone') {
      const out = repairCard(rep, undoFx as Json);
      out['speech'] = 'That fix was undone, so there is nothing to check.';
      out['checks'] = [];
      return ok(out);
    }
    if (rep.state === 'confirmed') return ok(repairCard(rep, statusFx as Json));
    const out = repairCard(rep, statusFx as Json);
    out['state'] = 'applied';
    out['checks'] = [];
    out['next_check_at'] = applyFx.next_check_at;
    out['speech'] = "The fix is in place. I'll check on it tomorrow morning.";
    if (rep.plan.kind !== 'lamp') out['steps'] = (outputs.get(rep.repair_id)?.['steps'] as unknown) ?? out['steps'];
    return ok(out);
  }

  function undo(args: Json): ToolReply {
    const rep = repairs.get(String(args['repair_id']));
    if (!rep) return fail('not_found');
    rep.state = 'undone';
    return ok(repairCard(rep, undoFx as Json));
  }

  function switchDevice(args: Json): ToolReply {
    const device = String(args['device'] ?? '').trim();
    const on = args['on'] === true;
    if (/\bstrip\b/i.test(device) && !on) return ok(clone(switchFx) as Json);
    const name = device.replace(/\b\w/g, (c) => c.toUpperCase());
    const slug = device.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'device';
    return ok({
      speech: `Done. The ${device.toLowerCase()} is ${on ? 'on' : 'off'}.`,
      status: 'ok',
      ids: {},
      source: SOURCE,
      switched: { entity_id: `switch.${slug}`, name, state: on ? 'on' : 'off' },
    });
  }

  function protectDevice(args: Json): ToolReply {
    if (args['protect'] === false) {
      return ok({ speech: 'Okay. I can switch it off again when you ask.', status: 'ok', ids: {}, source: SOURCE, protected: [] });
    }
    return ok(clone(protectFx) as Json);
  }

  // refresh_view gives the latest structuredContent for that id. For a repair that is its current
  // status, so a repair card open at the morning check picks up the confirmation (the protocol's
  // refresh_view fixture is that confirmed status).
  function refreshView(args: Json): ToolReply {
    const ref = String(args['ref_id']);
    if (repairs.has(ref)) return repairStatus({ repair_id: ref });
    const out = outputs.get(ref);
    return out ? { structuredContent: out, isError: false } : fail('not_found');
  }

  return {
    token,
    ntfyTopic: `fixwright-mock-${token.slice(-6)}`,
    call(tool, args) {
      switch (tool) {
        case 'home_checkup':
          return ok(clone(checkupFx) as Json);
        case 'diagnose':
          return diagnose();
        case 'diagnose_answer':
          return diagnoseAnswer(args);
        case 'explain_event':
          return ok(clone(explainFx) as Json);
        case 'repair_plan':
          return repairPlan(args);
        case 'repair_apply':
          return repairApply(args);
        case 'repair_status':
          return repairStatus(args);
        case 'undo':
          return undo(args);
        case 'protect_device':
          return protectDevice(args);
        case 'switch_device':
          return switchDevice(args);
        case 'refresh_view':
          return refreshView(args);
      }
    },
    injectFault(id) {
      if (!FAULT_IDS.includes(id)) return { ok: false, active_faults: [...faults] };
      faults.add(id);
      return { ok: true, active_faults: [...faults] };
    },
    reset: resetState,
    jumpClock(to) {
      const before = clock.nowMs();
      if (to === 'next_morning') clock.set(Math.max(before, Date.parse(NEXT_MORNING)));
      else if (typeof to === 'number' && Number.isFinite(to) && to > 0) clock.advance(to);
      const fresh: Push[] = [];
      for (const rep of repairs.values()) {
        if (rep.state !== 'applied' || clock.nowMs() < Date.parse(NEXT_MORNING)) continue;
        rep.state = 'confirmed';
        if (rep.plan.kind === 'lamp') {
          const detail = statusFx.checks[0]?.detail ?? '';
          fresh.push({ title: 'Repair confirmed', message: detail.replace(/\.$/, '. Repair confirmed.'), at: clock.now() });
        } else {
          fresh.push({ title: 'Repair confirmed', message: 'The overnight check passed. Repair confirmed.', at: clock.now() });
        }
      }
      pushes.push(...fresh);
      return { ok: true, now: clock.now(), pushes: fresh };
    },
    snapshot() {
      return {
        now: clock.now(),
        clock: { simulated: true, starts_at: START, tz: HOUSE_TZ, note: 'Simulated clock. The mock house starts where the fixtures start.', offset_ms: 0 },
        simulated: true,
        entities: houseFx.entities.map((e) => ({ ...e, physical: { recentActuations: actuations(e.entity_id) } })),
        active_faults: [...faults],
        repairs: [...repairs.values()].map((r) => ({ repair_id: r.repair_id, state: r.state })),
        pushes,
      };
    },
  };
}
