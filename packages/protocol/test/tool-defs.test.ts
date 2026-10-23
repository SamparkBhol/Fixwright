import { describe, expect, it } from 'vitest';
import { TOOL_DEFS, TOOL_DEF_LIST, TOOL_NAMES, ToolInputs, ToolOutputs, VIEW_URIS, toolMeta } from '../src/index.ts';

const BANNED = /\b(seamless|unlock|journey|leverage|robust|delve|elevate|empower|cutting edge|game changer)\b|[\u2013\u2014]|\s-\s/i;

describe('TOOL_DEFS', () => {
  it('has exactly the 11 tools, in registration order', () => {
    expect(Object.keys(TOOL_DEFS)).toEqual([...TOOL_NAMES]);
    expect(TOOL_NAMES).toHaveLength(11);
    expect(TOOL_DEF_LIST.map((d) => d.name)).toEqual([...TOOL_NAMES]);
    for (const name of TOOL_NAMES) expect(TOOL_DEFS[name].name).toBe(name);
  });

  it('points tools 1 to 8 at their view and leaves the rest without one', () => {
    const uris = Object.fromEntries(TOOL_NAMES.map((n) => [n, TOOL_DEFS[n].ui.resourceUri]));
    expect(uris).toEqual({
      home_checkup: 'ui://fixwright/carousel.html',
      diagnose: 'ui://fixwright/stepper.html',
      diagnose_answer: 'ui://fixwright/stepper.html',
      explain_event: 'ui://fixwright/stepper.html',
      repair_plan: 'ui://fixwright/stepper.html',
      repair_apply: 'ui://fixwright/repair-card.html',
      repair_status: 'ui://fixwright/repair-card.html',
      undo: 'ui://fixwright/repair-card.html',
      protect_device: undefined,
      switch_device: undefined,
      refresh_view: undefined,
    });
    expect(Object.values(VIEW_URIS).sort()).toEqual([
      'ui://fixwright/carousel.html',
      'ui://fixwright/repair-card.html',
      'ui://fixwright/stepper.html',
    ]);
  });

  it('makes refresh_view app only and keeps every other tool visible to the model', () => {
    expect(TOOL_DEFS.refresh_view.ui.visibility).toEqual(['app']);
    for (const name of TOOL_NAMES.filter((n) => n !== 'refresh_view')) {
      expect(TOOL_DEFS[name].ui.visibility, name).toContain('model');
    }
    // Device control stays in the conversation: views cannot call these.
    expect(TOOL_DEFS.switch_device.ui.visibility).toEqual(['model']);
    expect(TOOL_DEFS.protect_device.ui.visibility).toEqual(['model']);
    // The views' buttons need these.
    for (const name of ['diagnose_answer', 'repair_plan', 'repair_apply', 'undo'] as const) {
      expect(TOOL_DEFS[name].ui.visibility, name).toContain('app');
    }
  });

  it('marks only the tools that never switch or change anything as read only', () => {
    const readOnly = TOOL_NAMES.filter((n) => TOOL_DEFS[n].annotations.readOnlyHint);
    expect(readOnly).toEqual(['home_checkup', 'explain_event', 'repair_plan', 'repair_status', 'refresh_view']);
    for (const name of TOOL_NAMES) expect(TOOL_DEFS[name].annotations.openWorldHint, name).toBe(false);
  });

  it('says diagnose flashes the device: not read only, not destructive, not idempotent', () => {
    expect(TOOL_DEFS.diagnose.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(TOOL_DEFS.diagnose.description).toMatch(/flash the device and restore it/);
    expect(TOOL_DEFS.diagnose_answer.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  });

  it('marks repair_apply destructive, since the retired copy is later removed for good, and nothing else', () => {
    const destructive = TOOL_NAMES.filter((n) => TOOL_DEFS[n].annotations.destructiveHint);
    expect(destructive).toEqual(['repair_apply']);
    expect(TOOL_DEFS.repair_apply.annotations.idempotentHint).toBe(true); // a plan runs at most once
    for (const name of ['undo', 'protect_device', 'switch_device'] as const) {
      expect(TOOL_DEFS[name].annotations, name).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    }
  });

  it('gives protect_device household examples only, with no medical framing', () => {
    expect(TOOL_DEFS.protect_device.description).toMatch(/aquarium filter, freezer, fridge, grow light or pump/);
    for (const name of TOOL_NAMES) expect(TOOL_DEFS[name].description, name).not.toMatch(/medical|patient|life saving/i);
  });

  it('carries the exact zod schemas from ToolInputs and ToolOutputs', () => {
    for (const name of TOOL_NAMES) {
      expect(TOOL_DEFS[name].inputSchema).toBe(ToolInputs[name]);
      expect(TOOL_DEFS[name].outputSchema).toBe(ToolOutputs[name]);
    }
  });

  it('has descriptions written for a model: when to use, when not to, and plain wording', () => {
    for (const name of TOOL_NAMES) {
      const { title, description } = TOOL_DEFS[name];
      expect(title.length, name).toBeGreaterThan(3);
      expect(description.length, name).toBeGreaterThan(120);
      expect(description, name).not.toMatch(BANNED);
      expect(title, name).not.toMatch(BANNED);
    }
    const sayWhenNot = TOOL_NAMES.filter((n) => /\b(Do not|Never|not for)\b/i.test(TOOL_DEFS[n].description));
    expect(sayWhenNot.length).toBeGreaterThanOrEqual(9);
    expect(TOOL_DEFS.repair_apply.description).toMatch(/yes/);
    expect(TOOL_DEFS.diagnose.description).toMatch(/diagnose_answer/);
  });

  it('toolMeta returns a fresh copy each time, so the SDK can write into it', () => {
    const a = toolMeta('diagnose');
    const b = toolMeta('diagnose');
    expect(a).toEqual({ ui: { resourceUri: 'ui://fixwright/stepper.html', visibility: ['model', 'app'] } });
    expect(a).not.toBe(b);
    expect(a.ui.visibility).not.toBe(TOOL_DEFS.diagnose.ui.visibility);
    a.ui.visibility.push('app');
    expect(TOOL_DEFS.diagnose.ui.visibility).toEqual(['model', 'app']);
  });
});
