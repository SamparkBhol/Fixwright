// Builds the golden path fixtures for every tool output. write-fixtures.ts writes them
// to fixtures/<tool>.json and test/fixtures.test.ts checks the files never drift from this source.
//
// The story: on 15 Oct 2026 at 10:20 (household time, America/Los_Angeles) the person asks about the
// hallway lamp. It was paired again on 3 Oct, so its name still points at the old offline copy. Fixwright
// flashes the online copy, the person says it blinked, and the fix is applied. The next morning check
// passes. Power blipped at 03:12 that night and fourteen devices came back on. Then a checkup, and a
// refused request to turn off the strip that runs the protected aquarium filter.
//
// Ledger seqs are illustrative but consistent across fixtures. Numbers in the speech lines are the
// golden path's own; other probabilities are placeholders for rendering, not measurements.

import { manualClock, newId, seededRng, ID_ALPHABET } from '../src/index.ts';
import type { IdPrefix, ProbeResult, ProblemOutput, Rng, SourceInfo, ToolOutputMap } from '../src/index.ts';

export type GoldenFixtures = ToolOutputMap & { problem: ProblemOutput };

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

export function goldenFixtures(): GoldenFixtures {
  const rng: Rng = seededRng(20261023);
  const idAt = (prefix: IdPrefix, iso: string): string => newId(prefix, manualClock(iso), rng);
  const token = (): string => Array.from({ length: 32 }, () => ID_ALPHABET.charAt(Math.floor(rng.next() * 32))).join('');
  const source: SourceInfo = { adapter: 'simhome', simulated: true };

  // Ledger: 112 old copy goes offline (3 Oct), 113 lamp paired again as a new entity, 1201..1208 the
  // diagnosis probes and answer, 1301..1330 the 03:12 power restore on 16 Oct.
  const diagnosisId = idAt('dx', '2026-10-15T17:20:04.000Z');
  const questionId = idAt('q', '2026-10-15T17:20:07.200Z');
  const planId = idAt('pln', '2026-10-15T17:20:31.000Z');
  const confirmToken = token();
  const repairId = idAt('rep', '2026-10-15T17:20:38.000Z');
  const explanationId = idAt('exp', '2026-10-16T14:01:12.000Z');
  const powerIssueId = idAt('iss', '2026-10-16T14:01:12.000Z');
  const checkupId = idAt('chk', '2026-10-16T14:02:40.000Z');
  const [nameIssueId, batteryIssueId, wifiIssueId] = [0, 1, 2].map(() => idAt('iss', '2026-10-16T14:02:40.000Z')) as [string, string, string];

  const target = { entity_id: 'light.hallway_lamp', name: 'Hallway Lamp', guided: false };
  const passiveProbes: ProbeResult[] = [
    { probe_id: 'hub_reachable', label: 'Hub', outcome: 'pass', detail: 'The Zigbee hub answered right away.', evidence: [1201], disruptive: false, at: '2026-10-15T17:20:04.180Z' },
    { probe_id: 'link_quality', label: 'Signal', outcome: 'pass', detail: 'The lamp that is online has a strong signal.', evidence: [1202], disruptive: false, at: '2026-10-15T17:20:04.260Z' },
    { probe_id: 'cloud_status', label: 'Hue cloud', outcome: 'pass', detail: 'Hue reports no problems.', evidence: [1203], disruptive: false, at: '2026-10-15T17:20:04.900Z' },
    { probe_id: 'entity_availability', label: 'Availability', outcome: 'fail', detail: 'The device named Hallway Lamp has been offline since October 3.', evidence: [112, 1204], disruptive: false, at: '2026-10-15T17:20:05.010Z' },
    { probe_id: 'duplicate_name_scan', label: 'Names', outcome: 'fail', detail: 'A second copy of the lamp, Hallway Lamp 2, is online.', evidence: [113, 1205], disruptive: false, at: '2026-10-15T17:20:05.090Z' },
    { probe_id: 'flash_test', label: 'Flash test', outcome: 'pass', detail: 'Flashed the online copy twice. It answered both times.', evidence: [1206], disruptive: true, at: '2026-10-15T17:20:07.100Z' },
  ];

  const diagnose: ToolOutputMap['diagnose'] = {
    speech: "Your hub is reachable, the signal is good and the Hue cloud is fine. I'll flash the hallway lamp twice. Did it blink?",
    status: 'needs_answer',
    view: 'stepper',
    ids: { diagnosis_id: diagnosisId },
    source,
    diagnosis_id: diagnosisId,
    target,
    probes: [...passiveProbes],
    hypotheses: [
      { cause_id: 'stale_duplicate', label: 'Name points at an old copy', p: 0.55 },
      { cause_id: 'device_power_lost', label: 'Device has no power', p: 0.38 },
      { cause_id: 'name_collision', label: 'Two devices share a name', p: 0.04 },
    ],
    question: {
      question_id: questionId,
      text: "I'll flash the hallway lamp twice. Did it blink?",
      expects: 'yes_no',
      action_performed: 'Flashed the online Hallway Lamp twice',
    },
  };

  const diagnose_answer: ToolOutputMap['diagnose_answer'] = {
    speech: 'The lamp works. The name Hallway Lamp still points at an old copy of it that went offline on October 3. Want me to fix that?',
    status: 'ok',
    view: 'stepper',
    ids: { diagnosis_id: diagnosisId },
    source,
    diagnosis_id: diagnosisId,
    target,
    probes: [
      ...passiveProbes,
      { probe_id: 'confirm_flash', label: 'You saw it blink', outcome: 'pass', detail: 'You said yes, it blinked.', evidence: [1207, 1208], disruptive: false, at: '2026-10-15T17:20:19.400Z' },
    ],
    hypotheses: [
      { cause_id: 'stale_duplicate', label: 'Name points at an old copy', p: 0.94 },
      { cause_id: 'device_power_lost', label: 'Device has no power', p: 0.03 },
      { cause_id: 'name_collision', label: 'Two devices share a name', p: 0.02 },
    ],
    verdict: {
      level: 'confirmed',
      cause_id: 'stale_duplicate',
      label: 'Name points at an old copy',
      confidence: 0.94,
      claims: [
        { text: 'The lamp works.', evidence: [1206, 1207] },
        { text: 'The name Hallway Lamp still points at an old copy of it that went offline on October 3.', evidence: [112, 113, 1205] },
      ],
      fix_available: true,
    },
  };

  const planSteps = [
    'Give the online lamp the name Hallway Lamp',
    'Retire the old copy',
    'Switch it on and off to check it answers',
  ];

  const repair_plan: ToolOutputMap['repair_plan'] = {
    speech: "Here's the fix. Hallway Lamp will point to the lamp that is online. The old copy, offline since October 3, is retired. Shall I go ahead?",
    status: 'needs_confirmation',
    view: 'stepper',
    ids: { diagnosis_id: diagnosisId, plan_id: planId },
    source,
    plan_id: planId,
    confirm_token: confirmToken,
    expires_at: '2026-10-15T17:25:31.000Z',
    diff: [
      { entity_id: 'light.hallway_lamp_2', field: 'name', from: 'Hallway Lamp 2', to: 'Hallway Lamp' },
      { entity_id: 'light.hallway_lamp', field: 'registry', from: 'kept, offline since October 3', to: 'removed' },
    ],
    diff_lines: ['Hallway Lamp will point to the lamp that is online.', 'The old copy, offline since October 3, is retired.'],
    steps: planSteps.map((label, i) => ({ step: i + 1, label, status: 'pending' as const })),
    protected_conflicts: [],
  };

  const doneSteps = [
    { step: 1, label: planSteps[0] ?? '', status: 'done' as const, read_back: 'Name reads Hallway Lamp' },
    { step: 2, label: planSteps[1] ?? '', status: 'done' as const, read_back: 'Old copy is gone from the device list' },
    { step: 3, label: planSteps[2] ?? '', status: 'done' as const, read_back: 'It answered both times' },
  ];

  const repair_apply: ToolOutputMap['repair_apply'] = {
    speech: "Done. I switched it on and off, it answered both times. I'll check on it again tomorrow morning.",
    status: 'ok',
    view: 'repair_card',
    ids: { diagnosis_id: diagnosisId, plan_id: planId, repair_id: repairId },
    source,
    repair_id: repairId,
    plan_id: planId,
    state: 'applied',
    steps: doneSteps,
    undo_available: true,
    next_check_at: '2026-10-16T14:00:00.000Z',
  };

  const repair_status: ToolOutputMap['repair_status'] = {
    speech: 'Hallway lamp answered all 9 commands overnight. Repair confirmed.',
    status: 'ok',
    view: 'repair_card',
    ids: { plan_id: planId, repair_id: repairId },
    source,
    repair_id: repairId,
    plan_id: planId,
    state: 'confirmed',
    steps: doneSteps,
    undo_available: true,
    checks: [{ at: '2026-10-16T14:00:00.000Z', result: 'pass', detail: 'Hallway lamp answered all 9 commands overnight.' }],
  };

  const undo: ToolOutputMap['undo'] = {
    speech: 'Undone. Hallway Lamp is back the way it was before the fix.',
    status: 'ok',
    view: 'repair_card',
    ids: { plan_id: planId, repair_id: repairId },
    source,
    repair_id: repairId,
    plan_id: planId,
    state: 'undone',
    steps: [
      { step: 1, label: 'Bring back the old copy', status: 'done', read_back: 'Old copy is back in the device list' },
      { step: 2, label: 'Give the online lamp its old name back', status: 'done', read_back: 'Name reads Hallway Lamp 2' },
    ],
    undo_available: false,
  };

  const explain_event: ToolOutputMap['explain_event'] = {
    speech:
      'Power came back at 3:12. Fourteen devices restarted within four seconds. None of your automations fired. I can make them remember whether they were on or off. Do it?',
    status: 'ok',
    view: 'stepper',
    ids: { explanation_id: explanationId, issue_id: powerIssueId },
    source,
    explanation_id: explanationId,
    verdict: {
      level: 'confirmed',
      cause_id: 'power_restore',
      label: 'Power came back on',
      confidence: 0.95,
      claims: [
        { text: 'Power came back at 3:12.', evidence: [1302] },
        { text: 'Fourteen devices restarted within four seconds.', evidence: range(1303, 1316) },
        { text: 'None of your automations fired.', evidence: range(1317, 1330) },
      ],
      fix_available: true,
    },
    timeline: [
      { ts: '2026-10-16T10:11:58.000Z', label: 'Power went out', evidence: [1301] },
      { ts: '2026-10-16T10:12:00.000Z', label: 'Power came back', evidence: [1302] },
      { ts: '2026-10-16T10:12:00.400Z', label: 'Fourteen devices restarted within four seconds', evidence: range(1303, 1316) },
      { ts: '2026-10-16T10:12:04.000Z', label: 'They came back on with no automation or app command', evidence: range(1317, 1330) },
    ],
    suggested_fix: { issue_id: powerIssueId, label: 'Make them remember whether they were on or off' },
  };

  const home_checkup: ToolOutputMap['home_checkup'] = {
    speech:
      'I found three things. Two lights answer to Living Room Light. The hall motion sensor battery is at 6%. And the kitchen plug dropped off Wi-Fi 9 times today.',
    status: 'ok',
    view: 'carousel',
    ids: { checkup_id: checkupId },
    source,
    checkup_id: checkupId,
    findings: [
      {
        issue_id: nameIssueId,
        kind: 'duplicate_name',
        severity: 'high',
        title: 'Two lights answer to Living Room Light',
        detail: 'A Hue group and a Zigbee bulb are both called Living Room Light, so a command can reach the wrong one.',
        entity_ids: ['light.living_room_light', 'light.living_room_light_2'],
        fixable: true,
        action_label: 'Rename one',
      },
      {
        issue_id: batteryIssueId,
        kind: 'low_battery',
        severity: 'high',
        title: 'Hall motion sensor battery at 6%',
        detail: 'At 6% it may stop reporting motion soon.',
        entity_ids: ['binary_sensor.hall_motion', 'sensor.hall_motion_battery'],
        fixable: false,
      },
      {
        issue_id: wifiIssueId,
        kind: 'flapping',
        severity: 'medium',
        title: 'Kitchen plug dropped off Wi-Fi 9 times today',
        detail: 'Its Wi-Fi signal is weak, at -82 dBm. Moving the plug or the router closer usually helps.',
        entity_ids: ['switch.kitchen_plug'],
        fixable: false,
        action_label: 'Show me how',
      },
    ],
  };

  const protect_device: ToolOutputMap['protect_device'] = {
    speech: "Done. I'll never switch off the aquarium filter, even through its power strip.",
    status: 'ok',
    ids: {},
    source,
    protected: [{ entity_id: 'switch.living_room_power_strip_outlet_2', name: 'Aquarium Filter', reason: 'The fish need it running.' }],
  };

  const switch_device: ToolOutputMap['switch_device'] = {
    speech: "That strip runs the aquarium filter, which you marked protected. I'll turn off the lamp on it instead.",
    status: 'refused',
    ids: {},
    source,
    switched: { entity_id: 'switch.living_room_power_strip_outlet_1', name: 'Floor Lamp', state: 'off' },
    alternative: { entity_id: 'switch.living_room_power_strip_outlet_1', name: 'Floor Lamp', label: 'Turn off the Floor Lamp on the same strip' },
  };

  // A repair card left open overnight refreshes to the morning result.
  const refresh_view: ToolOutputMap['refresh_view'] = { ...repair_status };

  const problem: ProblemOutput = {
    speech: "I couldn't reach your hub just now. Try again in a minute.",
    status: 'error',
    ids: {},
    source,
    problem: { code: 'hub_unreachable', retryable: true },
  };

  return {
    home_checkup,
    diagnose,
    diagnose_answer,
    explain_event,
    repair_plan,
    repair_apply,
    repair_status,
    undo,
    protect_device,
    switch_device,
    refresh_view,
    problem,
  };
}

/** Stable JSON text for a fixture file. */
export function fixtureJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
