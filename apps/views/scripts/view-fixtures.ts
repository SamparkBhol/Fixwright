// Test and design data, not measurements: probabilities, seqs and times are illustrative, and
// every fixture carries source.simulated = true so the views label it. Only fixable findings get a plan: the
// engine answers repair_plan for any other finding with no_fix, so the Wi-Fi finding has none.
import { manualClock, newId, seededRng, ID_ALPHABET, type IdPrefix, type ToolOutputMap } from '@fixwright/protocol';
import diagnose from '../../../packages/protocol/fixtures/diagnose.json' with { type: 'json' };
import explain from '../../../packages/protocol/fixtures/explain_event.json' with { type: 'json' };
import checkup from '../../../packages/protocol/fixtures/home_checkup.json' with { type: 'json' };
import apply from '../../../packages/protocol/fixtures/repair_apply.json' with { type: 'json' };
import status from '../../../packages/protocol/fixtures/repair_status.json' with { type: 'json' };

type Out = ToolOutputMap;

export interface ViewFixtures {
  diagnose_answer_no: Out['diagnose_answer'];
  diagnose_likely: Out['diagnose'];
  diagnose_cant_tell: Out['diagnose'];
  home_checkup_five: Out['home_checkup'];
  repair_plan_rename: Out['repair_plan'];
  repair_apply_rename: Out['repair_apply'];
  repair_plan_power_on: Out['repair_plan'];
  repair_apply_power_on: Out['repair_apply'];
  repair_plan_protected: Out['repair_plan'];
  repair_apply_retried: Out['repair_apply'];
  repair_rolled_back: Out['repair_apply'];
  repair_regressed: Out['repair_status'];
}

export const FIXTURE_TOOL: Record<keyof ViewFixtures, keyof Out> = {
  diagnose_answer_no: 'diagnose_answer',
  diagnose_likely: 'diagnose',
  diagnose_cant_tell: 'diagnose',
  home_checkup_five: 'home_checkup',
  repair_plan_rename: 'repair_plan',
  repair_apply_rename: 'repair_apply',
  repair_plan_power_on: 'repair_plan',
  repair_apply_power_on: 'repair_apply',
  repair_plan_protected: 'repair_plan',
  repair_apply_retried: 'repair_apply',
  repair_rolled_back: 'repair_apply',
  repair_regressed: 'repair_status',
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function viewFixtures(): ViewFixtures {
  const rng = seededRng(7681280);
  const idAt = (prefix: IdPrefix, iso: string) => newId(prefix, manualClock(iso), rng);
  const token = () => Array.from({ length: 32 }, () => ID_ALPHABET.charAt(Math.floor(rng.next() * 32))).join('');
  const base = { source: { adapter: 'simhome' as const, simulated: true } };

  const dx = clone(diagnose) as Out['diagnose'];
  const passive = dx.probes.slice(0, 6);

  // The person says no: power moves to the top and Fixwright asks a second question.
  const questionNo = idAt('q', '2026-10-15T17:20:20.000Z');
  const diagnose_answer_no: Out['diagnose_answer'] = {
    ...clone(dx),
    speech: "Thanks. Then the lamp may have no power. Is the lamp's wall switch on?",
    probes: [
      ...passive,
      { probe_id: 'confirm_flash', label: "You didn't see it blink", outcome: 'fail', detail: 'You said no, it did not blink.', evidence: [1207, 1208], disruptive: false, at: '2026-10-15T17:20:19.400Z' },
    ],
    hypotheses: [
      { cause_id: 'device_power_lost', label: 'Device has no power', p: 0.62 },
      { cause_id: 'stale_duplicate', label: 'Name points at an old copy', p: 0.3 },
      { cause_id: 'name_collision', label: 'Two devices share a name', p: 0.03 },
    ],
    question: { question_id: questionNo, text: "Is the lamp's wall switch on?", expects: 'yes_no' },
  };

  const diagnose_likely: Out['diagnose'] = {
    ...clone(dx),
    speech: "The lamp is most likely without power. Its wall switch is off. Switch it back on and I'll check it answers.",
    status: 'ok',
    probes: [
      ...diagnose_answer_no.probes,
      { probe_id: 'power_switch_check', label: 'Wall switch is off', outcome: 'fail', detail: 'You said the wall switch is off.', evidence: [1209, 1210], disruptive: false, at: '2026-10-15T17:20:31.000Z' },
    ],
    hypotheses: [
      { cause_id: 'device_power_lost', label: 'Device has no power', p: 0.86 },
      { cause_id: 'stale_duplicate', label: 'Name points at an old copy', p: 0.09 },
      { cause_id: 'name_collision', label: 'Two devices share a name', p: 0.02 },
    ],
    verdict: {
      level: 'likely',
      cause_id: 'device_power_lost',
      label: 'Device has no power',
      confidence: 0.86,
      claims: [
        { text: "The lamp didn't blink when I flashed it.", evidence: [1206, 1207] },
        { text: 'You said its wall switch is off.', evidence: [1209] },
      ],
      fix_available: true,
    },
  };
  delete (diagnose_likely as { question?: unknown }).question;

  const guidedId = idAt('dx', '2026-10-15T18:02:00.000Z');
  const diagnose_cant_tell: Out['diagnose'] = {
    ...base,
    speech: "I can't tell yet. I can't see the porch plug from here. If your Wi-Fi router changed recently, that would explain it.",
    status: 'ok',
    view: 'stepper',
    ids: { diagnosis_id: guidedId },
    diagnosis_id: guidedId,
    target: { name: 'Porch Plug', guided: true },
    probes: [
      { probe_id: 'hub_reachable', label: 'Hub', outcome: 'pass', detail: 'Your hub answered right away.', evidence: [1401], disruptive: false, at: '2026-10-15T18:02:00.300Z' },
      { probe_id: 'entity_availability', label: 'Porch Plug', outcome: 'unknown', detail: 'This plug is not connected to anything I can see.', evidence: [1402], disruptive: false, at: '2026-10-15T18:02:00.500Z' },
      { probe_id: 'router_changed', label: 'Router change', outcome: 'unknown', detail: "You weren't sure if the router changed.", evidence: [1403], disruptive: false, at: '2026-10-15T18:02:14.000Z' },
    ],
    hypotheses: [
      { cause_id: 'wifi_network_changed', label: 'Wi-Fi network changed', p: 0.45 },
      { cause_id: 'device_power_lost', label: 'Device has no power', p: 0.3 },
      { cause_id: 'radio_link_weak', label: 'Weak radio link', p: 0.15 },
    ],
    verdict: {
      level: 'cant_tell',
      cause_id: 'wifi_network_changed',
      label: 'Wi-Fi network changed',
      confidence: 0.45,
      claims: [{ text: 'Checking the router name on the plug label would settle it.', evidence: [] }],
      fix_available: false,
    },
  };

  const chk = clone(checkup) as Out['home_checkup'];
  const ghostId = idAt('iss', '2026-10-16T14:02:40.000Z');
  // The same power on fault the explanation found, so its card opens the 14 device plan (repair_plan_power_on).
  const powerOnId = (explain as { suggested_fix?: { issue_id: string } }).suggested_fix?.issue_id ?? '';
  const home_checkup_five: Out['home_checkup'] = {
    ...chk,
    speech: 'I found five things. Two lights answer to Living Room Light, the hall motion sensor battery is at 6%, and the kitchen plug dropped off Wi-Fi 9 times today. There are two smaller ones on screen.',
    findings: [
      ...chk.findings,
      {
        issue_id: ghostId,
        kind: 'ghost_entity',
        severity: 'medium',
        title: 'An old copy of Hallway Lamp is still listed',
        detail: 'It has been offline since October 3 and can catch commands meant for the real lamp.',
        entity_ids: ['light.hallway_lamp'],
        fixable: true,
        action_label: 'Retire it',
      },
      {
        issue_id: powerOnId,
        kind: 'power_on_default',
        severity: 'low',
        title: 'Fourteen devices turn on after a power cut',
        detail: 'They are set to switch on whenever power comes back, even if they were off.',
        entity_ids: ['switch.kitchen_plug', 'light.porch'],
        fixable: true,
        action_label: 'Make them remember',
      },
    ],
  };

  const [nameIssue] = chk.findings.map((f) => f.issue_id) as [string, string, string];
  const renamePlanId = idAt('pln', '2026-10-16T14:03:10.000Z');
  const repair_plan_rename: Out['repair_plan'] = {
    ...base,
    speech: "Here's the fix. The Zigbee bulb will be called Living Room Bulb, so Living Room Light means the Hue group only. Shall I go ahead?",
    status: 'needs_confirmation',
    view: 'stepper',
    ids: { issue_id: nameIssue, plan_id: renamePlanId },
    plan_id: renamePlanId,
    confirm_token: token(),
    expires_at: '2026-10-16T14:08:10.000Z',
    diff: [{ entity_id: 'light.living_room_light_2', field: 'name', from: 'Living Room Light', to: 'Living Room Bulb' }],
    diff_lines: ['The Zigbee bulb will be called Living Room Bulb.', 'Living Room Light will mean the Hue group only.'],
    steps: [
      { step: 1, label: 'Rename the Zigbee bulb to Living Room Bulb', status: 'pending' },
      { step: 2, label: 'Check that each name reaches one device', status: 'pending' },
    ],
    protected_conflicts: [],
  };
  const renameRepairId = idAt('rep', '2026-10-16T14:03:20.000Z');
  const repair_apply_rename: Out['repair_apply'] = {
    ...base,
    speech: 'Done. Living Room Light now means the Hue group, and the bulb is Living Room Bulb.',
    status: 'ok',
    view: 'repair_card',
    ids: { issue_id: nameIssue, plan_id: renamePlanId, repair_id: renameRepairId },
    repair_id: renameRepairId,
    plan_id: renamePlanId,
    state: 'applied',
    steps: [
      { step: 1, label: 'Rename the Zigbee bulb to Living Room Bulb', status: 'done', read_back: 'Name reads Living Room Bulb' },
      { step: 2, label: 'Check that each name reaches one device', status: 'done', read_back: 'Each name now points at one device' },
    ],
    undo_available: true,
  };

  const exp = clone(explain) as Out['explain_event'];
  const powerIssue = exp.suggested_fix?.issue_id ?? '';
  // Mirrors the engine's planRepair and executePlan output for the golden path house's power on fix (run on
  // 15 Oct 2026): 14 devices from F2, so the views are laid out and tested against the real length.
  const powerOnDevices = [
    ['select.kitchen_ceiling_power_on_behavior', 'Kitchen Ceiling'],
    ['select.bedroom_lamp_power_on_behavior', 'Bedroom Lamp'],
    ['select.office_lamp_power_on_behavior', 'Office Lamp'],
    ['select.porch_light_power_on_behavior', 'Porch Light'],
    ['select.office_heater_plug_power_on_behavior', 'Office Heater Plug'],
    ['select.dining_pendant_power_on_behavior', 'Dining Pendant'],
    ['select.tv_plug_power_on_behavior', 'TV Plug'],
    ['select.coffee_maker_power_on_behavior', 'Coffee Maker'],
    ['select.bedroom_fan_plug_power_on_behavior', 'Bedroom Fan Plug'],
    ['select.garden_lights_power_on_behavior', 'Garden Lights'],
    ['select.desk_plug_power_on_behavior', 'Desk Plug'],
    ['select.nursery_lamp_power_on_behavior', 'Nursery Lamp'],
    ['select.patio_heater_plug_power_on_behavior', 'Patio Heater Plug'],
    ['select.stairs_light_power_on_behavior', 'Stairs Light'],
  ] as const;
  const powerOnSteps = powerOnDevices.map(([, name], i) => ({ step: i + 1, label: `Set ${name} to remember its last state`, status: 'pending' as const }));
  const powerPlanId = idAt('pln', '2026-10-15T17:30:00.000Z');
  const repair_plan_power_on: Out['repair_plan'] = {
    ...base,
    speech: "Here's the fix. Fourteen devices will remember whether they were on or off when power comes back. Shall I go ahead?",
    status: 'needs_confirmation',
    view: 'stepper',
    ids: { explanation_id: exp.explanation_id, issue_id: powerIssue, plan_id: powerPlanId },
    plan_id: powerPlanId,
    confirm_token: token(),
    expires_at: '2026-10-15T17:35:00.000Z',
    diff: powerOnDevices.map(([entity_id]) => ({ entity_id, field: 'power on behavior', from: 'on', to: 'previous' })),
    diff_lines: ['Fourteen devices will remember whether they were on or off when power comes back.'],
    steps: powerOnSteps,
    protected_conflicts: [],
  };
  const powerRepairId = idAt('rep', '2026-10-15T17:30:20.000Z');
  const repair_apply_power_on: Out['repair_apply'] = {
    ...base,
    speech: "Done. I made fourteen changes and checked each one. I'll check on them again tomorrow morning.",
    status: 'ok',
    view: 'repair_card',
    ids: { explanation_id: exp.explanation_id, issue_id: powerIssue, plan_id: powerPlanId, repair_id: powerRepairId },
    repair_id: powerRepairId,
    plan_id: powerPlanId,
    state: 'applied',
    steps: powerOnSteps.map((st) => ({ ...st, status: 'done' as const, read_back: 'Set to previous' })),
    undo_available: true,
    next_check_at: '2026-10-16T14:00:00.000Z',
  };
  // The same plan in a house where the person protected the aquarium filter on the living room strip
  // (homefault's default house): the worst case for fitting the inline plan, every row plus a protected line.
  const protectedPlanId = idAt('pln', '2026-10-15T17:31:00.000Z');
  const repair_plan_protected: Out['repair_plan'] = {
    ...clone(repair_plan_power_on),
    ids: { explanation_id: exp.explanation_id, issue_id: powerIssue, plan_id: protectedPlanId },
    plan_id: protectedPlanId,
    confirm_token: token(),
    protected_conflicts: ['Aquarium Filter is protected, so I will leave it as it is.'],
  };

  const ap = clone(apply) as Out['repair_apply'];
  const repair_rolled_back: Out['repair_apply'] = {
    ...ap,
    speech: "That didn't work, so I put everything back. The old copy wouldn't go away. Nothing is changed.",
    state: 'rolled_back',
    steps: [
      { step: 1, label: 'Give the online lamp the name Hallway Lamp', status: 'rolled_back', read_back: 'Name is back to Hallway Lamp 2' },
      { step: 2, label: 'Retire the old copy', status: 'failed', read_back: 'Old copy is still in the device list' },
      { step: 3, label: 'Switch it on and off to check it answers', status: 'skipped' },
    ],
    undo_available: false,
  };
  delete (repair_rolled_back as { next_check_at?: unknown }).next_check_at;

  const st = clone(status) as Out['repair_status'];
  const repair_regressed: Out['repair_status'] = {
    ...st,
    speech: 'Hallway lamp missed 3 of 9 commands overnight. Want me to look at it again?',
    state: 'regressed',
    checks: [{ at: '2026-10-16T14:00:00.000Z', result: 'fail', detail: 'Hallway lamp missed 3 of 9 commands overnight.' }],
  };

  // The engine's executor reports a step whose idempotency key already ran (a retried alarm or call) as
  // skipped with the read back "Already applied" (packages/engine/src/executor.ts), and runs the rest.
  const retriedId = idAt('rep', '2026-10-15T17:21:30.000Z');
  const repair_apply_retried: Out['repair_apply'] = {
    ...clone(apply),
    ids: { ...ap.ids, repair_id: retriedId },
    repair_id: retriedId,
    steps: ap.steps.map((s) => (s.step === 1 ? { step: 1, label: s.label, status: 'skipped' as const, read_back: 'Already applied' } : s)),
  } as Out['repair_apply'];

  return {
    diagnose_answer_no,
    diagnose_likely,
    diagnose_cant_tell,
    home_checkup_five,
    repair_plan_rename,
    repair_apply_rename,
    repair_plan_power_on,
    repair_apply_power_on,
    repair_plan_protected,
    repair_apply_retried,
    repair_rolled_back,
    repair_regressed,
  };
}
