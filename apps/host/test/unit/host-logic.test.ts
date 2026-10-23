// Unit tests for the host's pure logic: trace classification and pairing, latency percentiles, the
// view call policy, configuration, the clock, household storage and the suggestion chips.

import { describe, expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/client';
import { applyResult, initialState } from '@fixwright/router';
import diagnoseFx from '@fixwright/protocol/fixtures/diagnose.json' with { type: 'json' };
import planFx from '@fixwright/protocol/fixtures/repair_plan.json' with { type: 'json' };
import { TOOL_DEFS, toolMeta, type ToolName } from '@fixwright/protocol';
import { classify, createTrace, methodKey, requestFor } from '../../src/trace.ts';
import { formatMs, latencyTable, percentile, roundTrips } from '../../src/latency.ts';
import { decideViewCall, dueRepairRef, isBackgroundCall, requiresApproval, toolResourceUri, toolVisibility } from '../../src/policy.ts';
import { approvalFor, tapWords } from '../../src/approval.ts';
import { readConfig } from '../../src/config.ts';
import { createClock, formatClock } from '../../src/clock.ts';
import { householdKey, loadHousehold, saveHousehold } from '../../src/demo-api.ts';
import { estimateSpeechMs } from '../../src/voice.ts';
import { askedOf, pushBody, pushCaption, replyTag, suggestionsFor } from '../../src/ui/stage.ts';
import type { TranscriptEntry } from '../../src/state.ts';
import { FAULTS, FAULT_IDS } from '../../src/faults.ts';
import { DEVICES, isDeviceClass } from '../../src/devices.ts';

const toolFor = (name: ToolName): Tool =>
  ({
    name,
    title: TOOL_DEFS[name].title,
    inputSchema: { type: 'object' },
    annotations: TOOL_DEFS[name].annotations,
    _meta: toolMeta(name),
  }) as Tool;

describe('trace', () => {
  it('classifies requests, notifications, results and errors', () => {
    expect(classify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose' } })).toEqual({ kind: 'request', method: 'tools/call', id: 1, tool: 'diagnose' });
    expect(classify({ jsonrpc: '2.0', method: 'notifications/initialized' })).toMatchObject({ kind: 'notification', id: null });
    expect(classify({ jsonrpc: '2.0', id: 1, result: {} })).toMatchObject({ kind: 'response', method: 'result' });
    expect(classify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } })).toMatchObject({ kind: 'error' });
    expect(classify('junk')).toMatchObject({ kind: 'notification', method: 'unknown' });
  });

  it('pairs a response with its request per lane and session, and caps the store', () => {
    let t = 0;
    const trace = createTrace(() => (t += 10), 5);
    trace.add('mcp', 'out', 1, { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    trace.add('bridge', 'in', 7, { jsonrpc: '2.0', id: 0, method: 'ui/initialize', params: {} });
    const res = trace.add('mcp', 'in', 1, { jsonrpc: '2.0', id: 0, result: {} });
    expect(requestFor(trace.entries, res)?.method).toBe('initialize');
    for (let i = 0; i < 5; i++) trace.add('mcp', 'out', 1, { jsonrpc: '2.0', method: 'x' });
    expect(trace.entries.length).toBe(5);
    expect(methodKey({ method: 'tools/call', tool: 'undo' })).toBe('tools/call undo');
  });
});

describe('latency', () => {
  it('uses nearest rank percentiles', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });

  it('measures round trips per method and per tool, ignoring unanswered requests', () => {
    let t = 0;
    const clock = [0, 12, 20, 25, 30, 41, 50, 90, 100];
    const trace = createTrace(() => clock[t++] ?? 0);
    trace.add('mcp', 'out', 1, { jsonrpc: '2.0', id: 0, method: 'initialize' }); // 0
    trace.add('mcp', 'in', 1, { jsonrpc: '2.0', id: 0, result: {} }); // 12
    trace.add('mcp', 'out', 1, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'diagnose' } }); // 20
    trace.add('mcp', 'in', 1, { jsonrpc: '2.0', id: 1, result: {} }); // 25
    trace.add('mcp', 'out', 1, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose' } }); // 30
    trace.add('mcp', 'in', 1, { jsonrpc: '2.0', id: 2, error: { code: 1, message: 'x' } }); // 41
    trace.add('mcp', 'out', 1, { jsonrpc: '2.0', id: 3, method: 'tools/list' }); // 50, never answered
    trace.add('bridge', 'out', 2, { jsonrpc: '2.0', id: 0, method: 'ui/resource-teardown' }); // 90
    trace.add('bridge', 'in', 2, { jsonrpc: '2.0', id: 0, result: {} }); // 100
    expect(Object.fromEntries(roundTrips(trace.entries))).toEqual({ initialize: [12], 'tools/call diagnose': [5, 11] });
    const rows = latencyTable(trace.entries);
    expect(rows.map((r) => r.method)).toEqual(['initialize', 'tools/call diagnose']);
    expect(rows[1]).toMatchObject({ n: 2, p50: 5, p95: 11, max: 11, last: 11 });
    expect(latencyTable(trace.entries, 'bridge')[0]).toMatchObject({ method: 'ui/resource-teardown', p50: 10 });
    expect(formatMs(4.25)).toBe('4.3 ms');
    expect(formatMs(42.4)).toBe('42 ms');
    expect(formatMs(Number.NaN)).toBe('n/a');
  });
});

describe('view call policy', () => {
  it('refuses tools a view may not call and unknown tools', () => {
    expect(decideViewCall(toolFor('switch_device'), 'switch_device')).toMatchObject({ allow: false });
    expect(decideViewCall(toolFor('protect_device'), 'protect_device')).toMatchObject({ allow: false });
    expect(decideViewCall(undefined, 'factory_reset')).toMatchObject({ allow: false });
  });

  it('asks the person before anything that changes the house, never for reads or answers', () => {
    expect(decideViewCall(toolFor('repair_apply'), 'repair_apply')).toEqual({ allow: true, approval: true });
    expect(decideViewCall(toolFor('undo'), 'undo')).toEqual({ allow: true, approval: true });
    expect(decideViewCall(toolFor('repair_plan'), 'repair_plan')).toEqual({ allow: true, approval: false });
    expect(decideViewCall(toolFor('refresh_view'), 'refresh_view')).toEqual({ allow: true, approval: false });
    expect(decideViewCall(toolFor('diagnose_answer'), 'diagnose_answer')).toEqual({ allow: true, approval: false });
    // The flash test is diagnose's only write and it puts the lamp back, so a Diagnose tap needs no sheet.
    expect(TOOL_DEFS.diagnose.annotations.readOnlyHint).toBe(false);
    expect(decideViewCall(toolFor('diagnose'), 'diagnose')).toEqual({ allow: true, approval: false });
  });

  it('applies the same approval rule to whatever a view starts, by call or by message', () => {
    const names = Object.keys(TOOL_DEFS) as ToolName[];
    const needs = names.filter((n) => requiresApproval(toolFor(n))).sort();
    expect(needs).toEqual(['protect_device', 'repair_apply', 'switch_device', 'undo']);
    // A tool the host does not know carries no read only hint, so it asks first.
    expect(requiresApproval({ name: 'factory_reset' })).toBe(true);
  });

  it('words the approval sheet per change, and says when a view spoke for the person', () => {
    const plan = applyResult(initialState(), { tool: 'repair_plan', structuredContent: planFx });
    const apply = approvalFor({ tool: toolFor('repair_apply'), args: { plan_id: planFx.plan_id, confirm_token: planFx.confirm_token }, via: 'call' }, plan);
    expect(apply).toMatchObject({ tool: 'repair_apply', title: 'Apply this fix?', lines: planFx.diff_lines, confirm: 'Yes, apply it', note: null });
    const other = approvalFor({ tool: toolFor('repair_apply'), args: { plan_id: 'pln_other', confirm_token: 'x' }, via: 'call' }, plan);
    expect(other.lines).toEqual(['Fixwright will apply the planned repair and read back every step.']);
    const msg = approvalFor({ tool: toolFor('undo'), args: { repair_id: 'rep_1' }, via: 'message', said: 'undo that' }, plan);
    expect(msg).toMatchObject({ title: 'Undo this repair?', note: 'The screen sent “undo that” for you.' });
    const sw = approvalFor({ tool: toolFor('switch_device'), args: { device: 'kitchen plug', on: false }, via: 'message', said: 'x'.repeat(200) }, plan);
    expect(sw).toMatchObject({ title: 'Turn off the kitchen plug?', confirm: 'Yes, turn it off' });
    expect(sw.note?.length).toBeLessThan(110);
    expect(approvalFor({ tool: toolFor('protect_device'), args: { device: 'freezer', protect: false }, via: 'message', said: 'ok' }, plan).title).toBe('Stop protecting the freezer?');
    for (const a of [apply, msg, sw]) expect(`${a.title} ${a.lines.join(' ')} ${a.footer} ${a.note ?? ''}`).not.toMatch(/[\u2014]/);
  });

  it('counts a tap on a view as the person\'s turn, in plain words, except a view refreshing itself', () => {
    expect(tapWords('diagnose_answer', { answer: 'yes' })).toBe('Yes.');
    expect(tapWords('diagnose_answer', { answer: 'no' })).toBe('No.');
    expect(tapWords('diagnose_answer', { answer: 'Did it blink? Not sure!' })).toBe('Did it blink? Not sure!');
    expect(tapWords('repair_apply', { plan_id: 'pln_1', confirm_token: 't' })).toBe('Fix it.');
    expect(tapWords('undo', { repair_id: 'rep_1' })).toBe('Undo it.');
    expect(tapWords('repair_plan', { issue_id: 'iss_1' })).toBe('Show me the fix.');
    expect(tapWords('switch_device', { device: 'kitchen plug', on: true })).toBe('Turn on the kitchen plug.');
    expect(tapWords('anything_else', {})).toBe('Tapped on the screen.');
    // refresh_view is app only: the view's own housekeeping, never a turn and never spoken.
    expect(isBackgroundCall(toolFor('refresh_view'))).toBe(true);
    for (const n of ['diagnose_answer', 'repair_plan', 'repair_apply', 'undo'] as const) expect(isBackgroundCall(toolFor(n)), n).toBe(false);
  });

  it('knows when a repair shown again has a morning check that came due', () => {
    const applied = { state: 'applied', repair_id: 'rep_1', next_check_at: '2026-10-16T14:00:00.000Z' };
    expect(dueRepairRef(applied, Date.parse('2026-10-16T13:59:59.000Z'))).toBeNull();
    expect(dueRepairRef(applied, Date.parse('2026-10-16T14:00:00.000Z'))).toBe('rep_1');
    expect(dueRepairRef({ ...applied, state: 'confirmed' }, Date.parse('2026-10-17T00:00:00.000Z'))).toBeNull();
    expect(dueRepairRef({ ...applied, next_check_at: 'soon' }, Date.parse('2026-10-17T00:00:00.000Z'))).toBeNull();
    expect(dueRepairRef(undefined, 0)).toBeNull();
  });

  it('reads visibility and the view uri, including the legacy flat key', () => {
    expect(toolVisibility({ _meta: undefined })).toEqual(['model', 'app']);
    expect(toolVisibility(toolFor('refresh_view'))).toEqual(['app']);
    expect(toolResourceUri(toolFor('home_checkup'))).toBe('ui://fixwright/carousel.html');
    expect(toolResourceUri({ _meta: { 'ui/resourceUri': 'ui://x/y.html' } })).toBe('ui://x/y.html');
    expect(toolResourceUri({ _meta: { ui: { resourceUri: 'https://evil.example' } } })).toBeNull();
  });
});

describe('config', () => {
  it('defaults to the page origin and reads overrides', () => {
    const base = readConfig({ search: '', origin: 'https://fixwright.example.workers.dev' });
    expect(base.mcpUrl).toBe('https://fixwright.example.workers.dev/mcp');
    expect(base).toMatchObject({ routerMode: 'local', device: 'large', theme: 'dark', testMode: false });
    const c = readConfig({ search: '?server=http://127.0.0.1:8713/&sandbox=http://127.0.0.1:8712/sandbox.html&router=server&device=phone&theme=light&test=1', origin: 'http://localhost:8711' });
    expect(c).toMatchObject({ serverUrl: 'http://127.0.0.1:8713', mcpUrl: 'http://127.0.0.1:8713/mcp', sandboxOrigin: 'http://127.0.0.1:8712', routerMode: 'server', device: 'phone', theme: 'light', testMode: true });
    expect(readConfig({ search: '?device=toaster', origin: 'http://x' }).device).toBe('large');
    // A linked Home Assistant is the test hub with demo devices unless the page says the devices are real.
    expect(readConfig({ search: '', origin: 'http://x' }).hubLabel).toBe('Real Home Assistant, demo devices');
    expect(readConfig({ search: '?ha_devices=real', origin: 'http://x' }).hubLabel).toBe('Real Home Assistant');
  });
});

describe('clock', () => {
  it('follows real time, pins, and syncs to the server clock', () => {
    let real = 1_000;
    const clock = createClock(() => real);
    expect(clock.nowMs()).toBe(1_000);
    clock.syncTo('1970-01-01T00:00:05.000Z');
    real = 2_000;
    expect(clock.nowMs()).toBe(6_000);
    clock.pin('2026-10-15T17:20:00.000Z');
    expect(clock.pinned).toBe(true);
    expect(formatClock(clock.nowMs(), 'America/Los_Angeles')).toEqual({ time: '10:20 AM', date: 'Thursday, October 15' });
    // A plain reading of the house time never replaces a pin the test hook or the video asked for.
    expect(clock.syncTo('2026-10-16T13:00:00.000Z')).toBe(false);
    expect(new Date(clock.nowMs()).toISOString()).toBe('2026-10-15T17:20:00.000Z');
    // A move of the house clock (a /demo/clock jump, a reset) carries the pinned clock with it.
    expect(clock.syncTo('2026-10-16T14:00:00.000Z', { moved: true })).toBe(true);
    expect(new Date(clock.nowMs()).toISOString()).toBe('2026-10-16T14:00:00.000Z');
    clock.pin(null);
    expect(clock.nowMs()).toBe(6_000); // back to real time with the earlier server offset
  });

  it('lets a pin made while a server answer was in flight win over that answer', () => {
    const clock = createClock(() => 1_000);
    // ready() asks /demo/state; the test hook pins before the answer lands.
    const stamp = clock.mark();
    clock.pin('2026-10-15T22:30:00.000Z');
    expect(clock.syncTo('2026-10-15T17:00:00.000Z', { stamp })).toBe(false);
    expect(clock.syncTo('2026-10-15T17:00:00.000Z', { stamp, moved: true })).toBe(false);
    expect(new Date(clock.nowMs()).toISOString()).toBe('2026-10-15T22:30:00.000Z');
    // Unpinning is an explicit choice too: an answer asked for before it is still too old.
    const before = clock.mark();
    clock.pin(null);
    expect(clock.syncTo('2026-10-15T17:00:00.000Z', { stamp: before })).toBe(false);
    expect(clock.nowMs()).toBe(1_000);
    // An answer asked for after the last choice applies.
    expect(clock.syncTo('2026-10-15T17:00:00.000Z', { stamp: clock.mark() })).toBe(true);
    expect(new Date(clock.nowMs()).toISOString()).toBe('2026-10-15T17:00:00.000Z');
    // Garbage from the server is ignored.
    expect(clock.syncTo('not a time')).toBe(false);
  });
});

describe('household storage', () => {
  const memory = (): Storage => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, length: 0 } as Storage;
  };

  const A = 'http://127.0.0.1:8713';
  const B = 'https://fixwright.example.workers.dev';

  it('round trips a token and rejects junk', () => {
    const s = memory();
    saveHousehold(() => s, A, { token: 'hh_mock0001abc', ntfyTopic: 'topic' });
    expect(loadHousehold(() => s, A)).toEqual({ token: 'hh_mock0001abc', ntfyTopic: 'topic' });
    s.setItem(householdKey(A), '{"token":"<script>"}');
    expect(loadHousehold(() => s, A)).toBeNull();
    s.setItem(householdKey(A), 'not json');
    expect(loadHousehold(() => s, A)).toBeNull();
  });

  it('keeps one token per server origin, so ?server= never reuses another server\'s household', () => {
    const s = memory();
    saveHousehold(() => s, A, { token: 'hh_fromA', ntfyTopic: null });
    expect(loadHousehold(() => s, B)).toBeNull();
    expect(loadHousehold(() => s, `${A}/`)).toEqual({ token: 'hh_fromA', ntfyTopic: null });
    saveHousehold(() => s, B, { token: 'hh_fromB', ntfyTopic: null });
    expect(loadHousehold(() => s, A)?.token).toBe('hh_fromA');
    expect(householdKey('not a url')).toBe('fixwright.household.v2:not a url');
  });

  it('never throws when storage is missing or blocked', () => {
    const throwing = (): Storage => {
      throw new Error('SecurityError');
    };
    expect(loadHousehold(throwing, A)).toBeNull();
    expect(() => saveHousehold(throwing, A, { token: 'hh_x', ntfyTopic: null })).not.toThrow();
    expect(loadHousehold(() => null, A)).toBeNull();
  });
});

describe('small helpers', () => {
  it('estimates speaking time at 2.5 words per second with a floor', () => {
    expect(estimateSpeechMs('one two three four five')).toBe(2000);
    expect(estimateSpeechMs('Yes.')).toBe(1200);
  });

  it('offers suggestions that match the conversation', () => {
    const s0 = initialState();
    expect(suggestionsFor(s0)[0]).toBe('Why is the hallway lamp not responding?');
    const q = applyResult(s0, { tool: 'diagnose', structuredContent: diagnoseFx });
    expect(suggestionsFor(q)).toContain('Yes, it blinked');
    const p = applyResult(s0, { tool: 'repair_plan', structuredContent: planFx });
    // "What will it change?" hears the dry run read back (packages/router answers it while a plan waits).
    expect(suggestionsFor(p)).toEqual(['Yes, do it', 'No, leave it', 'What will it change?']);
    // While the approval sheet is open, the chips answer it.
    const sheet = approvalFor({ tool: toolFor('repair_apply'), args: { plan_id: planFx.plan_id, confirm_token: planFx.confirm_token }, via: 'call' }, p);
    expect(suggestionsFor(p, sheet)).toEqual(['Yes, apply it', 'Not now']);
  });

  it('stops offering a suggestion once the person has said it, in any wording of the same words', () => {
    const s0 = initialState();
    const asked = askedOf([
      { role: 'user', text: 'Alexa, ask Fixwright why did every plug turn on at 3 a.m.?' },
      { role: 'assistant', text: 'Give my house a checkup' },
    ]);
    const list = suggestionsFor(s0, null, asked);
    expect(list).not.toContain('Why did every plug turn on at 3 a.m.?');
    // Only the person's own turns count.
    expect(list).toContain('Give my house a checkup');
    // A request Alexa would route to its own smart home control names the add-on.
    expect(list).toContain('Ask Fixwright to turn off the living room power strip');
    // Every starter used: the list starts over rather than going empty.
    const all = askedOf(suggestionsFor(s0).map((text) => ({ role: 'user' as const, text })));
    expect(suggestionsFor(s0, null, all)).toEqual(suggestionsFor(s0));
  });

  it('captions a push that landed after the last turn, until the next turn', () => {
    const toast = { title: 'Repair confirmed', message: 'Hallway lamp answered all 9 commands overnight. Repair confirmed.', at: '2026-10-16T14:00:00.000Z' };
    const turn = (id: number): TranscriptEntry => ({ id, role: 'assistant', text: 'Okay. Nothing changed.', at: 0 });
    const transcript = [turn(1), turn(2)];
    expect(pushCaption({ toast, toastAfter: 2, transcript, interim: '' })).toBe(toast.message);
    // A newer turn (or words being spoken right now) takes the captions back.
    expect(pushCaption({ toast, toastAfter: 1, transcript, interim: '' })).toBeNull();
    expect(pushCaption({ toast, toastAfter: 2, transcript, interim: 'did the' })).toBeNull();
    expect(pushCaption({ toast: null, toastAfter: 2, transcript, interim: '' })).toBeNull();
    expect(pushCaption({ toast, toastAfter: 0, transcript: [], interim: '' })).toBe(toast.message);
  });

  it('shows a push title once: the message drops a last sentence that only repeats it', () => {
    expect(pushBody({ title: 'Repair confirmed', message: 'Hallway lamp answered all 9 commands overnight. Repair confirmed.' })).toBe('Hallway lamp answered all 9 commands overnight.');
    expect(pushBody({ title: 'Repair needs a look', message: 'Hallway lamp missed 1 of 9 commands and went offline once overnight.' })).toBe('Hallway lamp missed 1 of 9 commands and went offline once overnight.');
    // A message that is nothing but the title stays whole.
    expect(pushBody({ title: 'Repair confirmed', message: 'Repair confirmed.' })).toBe('Repair confirmed.');
  });

  it('tags a reply card by what the turn did', () => {
    expect(replyTag({ tool: 'switch_device', status: 'refused' })).toEqual({ icon: 'shield', text: 'Kept on' });
    expect(replyTag({ tool: 'protect_device', status: 'ok' })).toEqual({ icon: 'shield', text: 'Protected' });
    expect(replyTag({ tool: 'switch_device', status: 'ok' })).toEqual({ icon: 'check', text: 'Done' });
  });

  it('lists the ten homefault faults F1 to F10 with unique ids', () => {
    expect(FAULTS.map((f) => f.code)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10']);
    expect(new Set(FAULT_IDS).size).toBe(10);
  });

  it('describes the four devices with their screen sizes', () => {
    expect(DEVICES.large.screen).toEqual({ width: 1280, height: 800 });
    expect(DEVICES.small.screen).toEqual({ width: 960, height: 480 });
    expect(DEVICES.phone.screen).toEqual({ width: 390, height: 844 });
    expect(DEVICES.voice.screen).toBeNull();
  });

  it('accepts only the four device names, not inherited object keys', () => {
    for (const d of ['large', 'small', 'phone', 'voice']) expect(isDeviceClass(d)).toBe(true);
    for (const d of ['toString', 'constructor', '__proto__', 'hasOwnProperty', '', null, 3]) expect(isDeviceClass(d)).toBe(false);
  });
});
