// Tool definitions for MCP registration. Descriptions are written for the host's language model:
// what the tool is for, when to use it, when not to, and how its result chains into the next call.

import { TOOL_NAMES, TOOL_VIEWS, VIEW_URIS, type ToolName, type ViewKind, type ViewUri } from './names.ts';
import { ToolInputs, ToolOutputs } from './tools.ts';

export type ToolVisibility = 'model' | 'app';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolUi {
  /** The MCP Apps view that renders this tool's result. */
  resourceUri?: ViewUri;
  /** Who may call the tool: the model, views (app), or both. */
  visibility: ToolVisibility[];
}

export interface ToolDef<N extends ToolName = ToolName> {
  name: N;
  title: string;
  description: string;
  inputSchema: (typeof ToolInputs)[N];
  outputSchema: (typeof ToolOutputs)[N];
  annotations: ToolAnnotations;
  view?: ViewKind;
  ui: ToolUi;
}

const SPEAK = 'Reply with the speech field as written; it is made to be spoken.';

const hints = (readOnly: boolean, idempotent: boolean, destructive = false): ToolAnnotations => ({
  readOnlyHint: readOnly,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: false,
});

interface DefText {
  title: string;
  description: string;
  annotations: ToolAnnotations;
  visibility: ToolVisibility[];
}

const TEXT: Record<ToolName, DefText> = {
  home_checkup: {
    title: 'Home checkup',
    description: [
      'Scan the whole smart home for problems before they bite: two devices answering to the same spoken name,',
      'old copies left behind after pairing a device again, devices that keep dropping off, low batteries, automations that',
      'point at removed devices, plugs that switch on after a power cut, failing integrations, and essential loads',
      '(aquarium filter, freezer) that are not protected.',
      'Use when the person asks for a checkup, a health check, or whether anything is wrong with the house.',
      'Do not use for one specific misbehaving device (use diagnose) or for something that already happened (use explain_event).',
      'Returns 3 to 5 findings, most severe first; each issue_id can go to repair_plan if the person wants it fixed.',
      SPEAK,
    ].join(' '),
    annotations: hints(true, true),
    visibility: ['model', 'app'],
  },
  diagnose: {
    title: 'Diagnose a device',
    description: [
      'Find out why one smart home device misbehaves right now, e.g. "the hallway lamp keeps saying it\'s not responding"',
      'or "the kitchen plug keeps going offline". Checks the hub, signal, vendor cloud and device names first, may briefly',
      'flash the device and restore it, and ranks the likely causes.',
      'If status is needs_answer, ask the person the question in speech and pass their reply, word for word, to',
      'diagnose_answer with the same diagnosis_id and question_id.',
      'If status is ok, the verdict is final; when fix_available is true, offer the fix and on yes call repair_plan with diagnosis_id.',
      'Do not use for a whole home health check (home_checkup) or to explain a past event such as lights turning on at night (explain_event).',
      'Never state a cause the tool did not return.',
      SPEAK,
    ].join(' '),
    // The flash test switches the device off and on again, so diagnose writes to the house.
    annotations: hints(false, false),
    visibility: ['model', 'app'],
  },
  diagnose_answer: {
    title: 'Answer a diagnosis question',
    description: [
      'Send the person\'s reply to the question a diagnosis just asked, such as "I\'ll flash the hallway lamp twice. Did it blink?".',
      'Pass their words exactly as said; English and Hindi both work ("yes, it blinked", "I heard it click", "haan", "nahi jala").',
      'Use only right after diagnose or diagnose_answer returned status needs_answer. Returns the updated diagnosis,',
      'which may ask one more question or give the verdict. An unclear reply is asked again once, more plainly.',
      SPEAK,
    ].join(' '),
    annotations: hints(false, false),
    visibility: ['model', 'app'],
  },
  explain_event: {
    title: 'Explain what happened',
    description: [
      'Explain something the home already did, using its own logs: "why did every plug turn on at 3 a.m.?",',
      '"what turned the porch light off last night?". Reads the time window from the question (or since and until),',
      'names the cause only when the logs back it, and says it can\'t tell when they do not.',
      'If suggested_fix is present, offer it; on yes call repair_plan with its issue_id.',
      'Do not use for a device that is misbehaving right now (use diagnose).',
      SPEAK,
    ].join(' '),
    annotations: hints(true, true),
    visibility: ['model', 'app'],
  },
  repair_plan: {
    title: 'Plan a repair',
    description: [
      'Prepare a fix as a dry run without changing anything. Give exactly one of diagnosis_id (a finished diagnosis',
      'with fix_available true), issue_id (a checkup finding or an explain_event suggested_fix) or explanation_id.',
      'Returns the changes in plain sentences, the steps and a confirm_token. Read the changes to the person and ask for',
      'a clear yes; only after that yes, call repair_apply with plan_id and confirm_token. The plan expires at expires_at.',
      'Never plans changes to locks, garage doors, alarms or cameras, and never switches off a protected device.',
      SPEAK,
    ].join(' '),
    annotations: hints(true, true),
    visibility: ['model', 'app'],
  },
  repair_apply: {
    title: 'Apply a repair',
    description: [
      'Apply a planned repair after the person explicitly said yes to that plan. Needs plan_id and confirm_token from repair_plan.',
      'Runs each step once, reads the device back after each one, and rolls back by itself if a read back does not match.',
      'Never call it without a fresh yes for this exact plan; a plan can be applied only once.',
      'Returns a repair_id for repair_status and undo, and when the repair will be checked again.',
      SPEAK,
    ].join(' '),
    // Renames and settings are overwritten, and once the morning check passes the old copy is removed from
    // the registry, which Home Assistant cannot restore.
    annotations: hints(false, true, true),
    visibility: ['model', 'app'],
  },
  repair_status: {
    title: 'Repair status',
    description: [
      'Check how a repair is holding up, including the next morning check, e.g. "did the fix work?" or',
      '"how is the hallway lamp doing since you fixed it?". Needs the repair_id from repair_apply.',
      'Do not use to start a new diagnosis.',
      SPEAK,
    ].join(' '),
    annotations: hints(true, true),
    visibility: ['model', 'app'],
  },
  undo: {
    title: 'Undo a repair',
    description: [
      'Reverse a repair that was applied, putting each change back and reading it back.',
      'Use when the person asks to undo the fix or put things back the way they were. Needs the repair_id.',
      'Do not use to cancel a plan that was never applied; just do not apply it.',
      SPEAK,
    ].join(' '),
    annotations: hints(false, true),
    visibility: ['model', 'app'],
  },
  protect_device: {
    title: 'Protect a device',
    description: [
      'Mark a device Fixwright must never switch off or power cycle, such as an aquarium filter, freezer, fridge,',
      'grow light or pump, including through the power strip it is plugged into.',
      'Use when the person says something like "never turn off the aquarium filter". Set protect to false to remove the protection.',
      'Returns every protected device.',
      SPEAK,
    ].join(' '),
    annotations: hints(false, true),
    visibility: ['model'],
  },
  switch_device: {
    title: 'Switch a device',
    description: [
      'Turn a device on or off for the person while respecting protected devices.',
      'If the device, or the power strip it is on, would cut a protected load, the tool refuses and offers a safe',
      'alternative such as the lamp on the same strip; do not retry the refused request.',
      'It does not operate locks, garage doors, alarms or cameras.',
      SPEAK,
    ].join(' '),
    annotations: hints(false, true),
    visibility: ['model'],
  },
  refresh_view: {
    title: 'Refresh a view',
    description:
      'For views only, not for the model. Returns the latest result for a checkup, diagnosis, explanation, plan or repair id so an open view can update itself.',
    annotations: hints(true, true),
    visibility: ['app'],
  },
};

function buildDef<N extends ToolName>(name: N): ToolDef<N> {
  const text = TEXT[name];
  const view: ViewKind | undefined = (TOOL_VIEWS as Partial<Record<ToolName, ViewKind>>)[name];
  return {
    name,
    title: text.title,
    description: text.description,
    inputSchema: ToolInputs[name],
    outputSchema: ToolOutputs[name],
    annotations: text.annotations,
    ...(view ? { view } : {}),
    ui: { ...(view ? { resourceUri: VIEW_URIS[view] } : {}), visibility: text.visibility },
  };
}

export const TOOL_DEFS: { readonly [N in ToolName]: ToolDef<N> } = {
  home_checkup: buildDef('home_checkup'),
  diagnose: buildDef('diagnose'),
  diagnose_answer: buildDef('diagnose_answer'),
  explain_event: buildDef('explain_event'),
  repair_plan: buildDef('repair_plan'),
  repair_apply: buildDef('repair_apply'),
  repair_status: buildDef('repair_status'),
  undo: buildDef('undo'),
  protect_device: buildDef('protect_device'),
  switch_device: buildDef('switch_device'),
  refresh_view: buildDef('refresh_view'),
};

/** All definitions in registration order. */
export const TOOL_DEF_LIST: readonly ToolDef[] = TOOL_NAMES.map((n) => TOOL_DEFS[n]);

/**
 * A fresh `_meta` for registerAppTool. ext-apps writes extra keys into the object it is given, so the
 * shared definitions are never handed over directly.
 */
export function toolMeta(name: ToolName): { ui: ToolUi } {
  const ui = TOOL_DEFS[name].ui;
  return { ui: { ...ui, visibility: [...ui.visibility] } };
}
