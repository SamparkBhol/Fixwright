// The golden path end to end on the real local stack: the host page served by apps/server under
// `wrangler dev --local` (same origin /mcp), views from apps/views/dist inside the apps/sandbox proxy on its
// own origin, the real HouseholdDO with its SimHome, and a local ntfy receiver as the only stand in.
// Run with `npm run e2e` (starts and stops the stack). Exact speech lines, zero console errors in every
// frame, no failed requests, one screenshot per beat in docs/screens/ (1600x1000).
//
// Order: steps 1, 2, 3, then 5 (explain at 3 a.m. and its fix), 6 (checkup) and 7 (protected strip), then 4
// (the next morning jump and its push), then 8 (Visual Trace). The demo house's power restore happened at
// 3:12 on 15 October; after the jump to 07:00 on 16 October "at 3 a.m." means the quiet night that follows,
// and the checkup words the Wi-Fi drops "in the last day" instead of
// "today". Asking before the jump keeps every scripted line word for word, and the morning push still confirms
// the hallway lamp repair from step 3: step 4 asks about that repair by name ("did the hallway lamp fix
// hold?"), so the card under the push is the hallway lamp's, and tapping the push opens the same repair.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { launch, ntfyReceived, openHost, SANDBOX, SERVER, viewText, type HookSnapshot, type Session, type TraceRow } from './support.ts';

let browser: Browser;
let s: Session;
/** The safety net beat's own household (step 9). */
let s2: Session | undefined;

const LINES = {
  diagnose: "Your hub is reachable, the signal is good and the light maker's cloud is fine. I'll flash the hallway lamp twice. Did it blink?",
  verdict: 'The lamp works. The name Hallway Lamp still points at an old copy of it that went offline on October 3. Want me to fix that?',
  plan: 'Hallway Lamp will point to the lamp that is online. The old copy, offline since October 3, is retired.',
  applied: "Done. I switched it on and off, it answered both times. I'll check on it again tomorrow morning.",
  explain: 'Power came back at 3:12. Fourteen devices restarted within four seconds. None of your automations fired. I can make them remember whether they were on or off. Do it?',
  powerFix: "Done. I made fourteen changes and checked each one. I'll check on them again tomorrow morning.",
  checkup: ['Two lights answer to Living Room Light', 'Hall motion sensor battery at 6%', 'Kitchen plug dropped off Wi-Fi 9 times today'],
  refused: "That strip runs the aquarium filter, which you marked protected. I'll turn off the lamp on it instead.",
  push: 'Hallway lamp answered all 9 commands overnight. Repair confirmed.',
  flashed: 'Flashed the online Hallway Lamp twice',
};

/** The hallway lamp repair from step 3, so step 4 can check that its card is the one on screen. */
let lampRepairId = '';

interface DemoEntity {
  entity_id: string;
  name: string;
  state: string;
  physical?: { exists?: boolean; recentActuations?: string[] };
}
interface DemoState {
  now: string;
  ledger: { events: number; last_seq: number };
  entities: DemoEntity[];
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Step labels on the card, in the order shown (folded ones included), without the screen reader suffix. */
async function stepLabels(): Promise<string[]> {
  return s.view().locator('.step .row-title').evaluateAll((els) => els.map((el) => (el.firstChild?.textContent ?? '').trim()));
}

/** structuredContent of the newest tools/call result for a tool, from the Visual Trace. */
async function lastResult(tool: string): Promise<Record<string, unknown>> {
  const rows = await s.trace();
  const call = rows.filter((r) => r.lane === 'mcp' && r.dir === 'out' && r.method === 'tools/call' && r.tool === tool).at(-1);
  expect(call, `no tools/call ${tool} in the trace`).toBeTruthy();
  const reply = rows.find((r) => r.lane === 'mcp' && r.dir === 'in' && r.id === call?.id && r !== call) as TraceRow | undefined;
  const result = (reply?.msg as { result?: { structuredContent?: Record<string, unknown> } } | undefined)?.result;
  expect(result?.structuredContent, `no structuredContent for ${tool}`).toBeTruthy();
  return result?.structuredContent as Record<string, unknown>;
}

const lastTurn = (snap: HookSnapshot): HookSnapshot['transcript'][number] | undefined => snap.transcript.at(-1);

beforeAll(async () => {
  browser = await launch();
  s = await openHost(browser);
});

afterAll(async () => {
  await s2?.context.close();
  await s?.context.close();
  await browser?.close();
});

describe('the golden path on the real stack', () => {
  it('connects to the live server at 2025-11-25 with its own household', async () => {
    const snap = await s.snap();
    expect(snap.connection.status).toBe('ready');
    expect(snap.connection.protocolVersion).toBe('2025-11-25');
    expect(snap.connection.tools).toBe(11);
    expect(s.household.token).toMatch(/^hh_/);
    await expect.poll(() => s.page.locator('#honesty-banner').textContent()).toContain(`Alexa+ host simulated. Live MCP server: ${SERVER}/mcp (MCP 2025-11-25, Streamable HTTP).`);
    const state = await s.demo<{ simulated: boolean; adapter: string; active_faults: string[]; now: string }>('/demo/state');
    expect(state.simulated).toBe(true);
    // DEMO_START: 15:00 in the house on 15 October (each SimHome write takes a few ms of house time).
    expect(state.now.slice(0, 16)).toBe('2026-10-15T22:00');
    await s.shot('00-idle-large');
  });

  it('1. large display: diagnose asks to flash the lamp, two causes left on the bars', async () => {
    const before = await s.demo<DemoState>('/demo/state');
    const snap = await s.say("Alexa, ask Fixwright why the hallway lamp keeps saying it's not responding.");
    expect(lastTurn(snap)).toMatchObject({ role: 'assistant', tool: 'diagnose', status: 'needs_answer' });
    expect(snap.spoken.at(-1)).toBe(LINES.diagnose);
    expect(snap.device).toBe('large');
    expect(snap.viewUri).toBe('ui://fixwright/stepper.html');
    const out = await lastResult('diagnose');
    const probes = out['probes'] as { probe_id: string; outcome: string }[];
    expect(probes.filter((p) => p.outcome === 'pass').map((p) => p.probe_id)).toEqual(expect.arrayContaining(['hub_reachable', 'link_quality', 'cloud_status']));
    const hyps = out['hypotheses'] as { cause_id: string; p: number }[];
    expect(hyps.length).toBeGreaterThanOrEqual(2);
    expect(hyps.filter((h) => h.p >= 0.1).length).toBe(2);
    expect((out['question'] as { text: string }).text).toBe("I'll flash the hallway lamp twice. Did it blink?");
    expect((out['question'] as { action_performed?: string }).action_performed).toBe(LINES.flashed);
    // The view sits in the sandbox proxy's inner frame on the sandbox origin.
    const outer = s.page.frames().find((f) => f.url().startsWith(`${SANDBOX}/sandbox.html`));
    expect(outer).toBeTruthy();
    expect(await outer?.childFrames()[0]?.evaluate(() => window.location.origin)).toBe(SANDBOX);
    await expect.poll(() => s.view().getByText('Did it blink?').first().isVisible()).toBe(true);
    await expect.poll(() => s.view().getByRole('button', { name: /^yes$/i }).isVisible()).toBe(true);
    // The view says what the server did.
    await expect.poll(async () => (await viewText(s)).includes(`${LINES.flashed}.`)).toBe(true);
    // The server really flashed the online copy: in the house twin the lamp lit and went dark twice (two on
    // and two off writes, four changes a person could see) and ended as it was; the old copy, which no
    // longer exists, was not touched; and the ledger recorded the writes.
    const after = await s.demo<DemoState>('/demo/state');
    const lamp = (st: DemoState, id: string): DemoEntity | undefined => st.entities.find((e) => e.entity_id === id);
    const online = lamp(after, 'light.hallway_lamp_2');
    const newActs = (online?.physical?.recentActuations ?? []).filter((t) => t >= before.now);
    expect(newActs, JSON.stringify(online)).toHaveLength(4);
    expect(online?.name).toBe('Hallway Lamp');
    expect(online?.state).toBe(lamp(before, 'light.hallway_lamp_2')?.state);
    const old = lamp(after, 'light.hallway_lamp');
    expect(old?.physical?.exists).toBe(false);
    expect(old?.physical?.recentActuations ?? []).toEqual([]);
    expect(after.ledger.events).toBeGreaterThanOrEqual(before.ledger.events + 4);
    await s.shot('01-diagnose-large');
    // The house plan blinks that lamp twice, in the rhythm of the four switches the twin logged.
    const moment = (await s.snap()).house.moment;
    const times = newActs.map((t) => Date.parse(t));
    expect(moment).toMatchObject({ kind: 'flash', devices: ['light.hallway_lamp_2'], frames: 4, spanMs: Math.max(...times) - Math.min(...times) });
    expect(moment?.line).toBe(`The online Hallway Lamp switched 4 times in ${moment?.spanMs} ms.`);
    expect(await s.page.locator('.house-line').textContent()).toBe(moment?.line);
    expect(await s.page.locator('.plan .dot[data-entity="light.hallway_lamp_2"]').getAttribute('data-answered')).toBe('true');
    expect(await s.page.locator('.plan .dot[data-entity="light.hallway_lamp"]').getAttribute('data-state')).toBe('unavailable');
    await s.hook('holdMoment', 100);
    expect(await s.page.locator('.plan .dot[data-entity="light.hallway_lamp_2"]').getAttribute('data-state')).toBe('on');
    await s.shot('01b-flash-replay-large');
    await s.hook('holdMoment', null);
  });

  it('2. voice only, same conversation: "Yes, it blinked." confirms the old copy', async () => {
    const before = await s.snap();
    const v = await s.hook<HookSnapshot>('setDevice', 'voice');
    expect(v.viewUri).toBeNull();
    expect(v.transcript.length).toBe(before.transcript.length);
    await expect.poll(() => s.page.locator('#view-slot iframe').count()).toBe(0);
    const snap = await s.say('Yes, it blinked.');
    expect(lastTurn(snap)).toMatchObject({ tool: 'diagnose_answer', status: 'ok' });
    expect(snap.spoken.at(-1)).toBe(LINES.verdict);
    const verdict = (await lastResult('diagnose_answer'))['verdict'] as { level: string; cause_id: string; confidence: number };
    expect(verdict.level).toBe('confirmed');
    expect(verdict.cause_id).toBe('stale_duplicate');
    expect(verdict.confidence).toBeGreaterThanOrEqual(0.9);
    expect(verdict.confidence).toBeLessThan(0.97);
    expect(await s.page.locator('#view-slot iframe').count()).toBe(0);
    expect(await s.page.locator('.speaker').isVisible()).toBe(true);
    await s.shot('02-voice-verdict');
  });

  it('3. back on the large display: the dry run, then one yes applies it with read back and undo', async () => {
    const back = await s.hook<HookSnapshot>('setDevice', 'large');
    expect(back.viewTool).toBe('diagnose_answer');
    await expect.poll(() => s.view().getByText('Confirmed').first().isVisible()).toBe(true);
    await s.shot('03-verdict-large');
    const plan = await s.say('Yes.');
    expect(lastTurn(plan)).toMatchObject({ tool: 'repair_plan', status: 'needs_confirmation' });
    expect(plan.spoken.at(-1)).toContain(LINES.plan);
    const planned = await lastResult('repair_plan');
    expect((planned['diff_lines'] as string[]).join(' ')).toBe(LINES.plan);
    expect((planned['steps'] as { status: string }[]).every((x) => x.status === 'pending')).toBe(true);
    await expect.poll(() => s.view().getByRole('button', { name: /fix it/i }).isVisible()).toBe(true);
    await s.shot('04-plan-large');
    const applied = await s.say('Yes.');
    expect(lastTurn(applied)).toMatchObject({ tool: 'repair_apply', status: 'ok' });
    expect(applied.spoken.at(-1)).toBe(LINES.applied);
    const rep = await lastResult('repair_apply');
    expect(rep['state']).toBe('applied');
    expect(rep['undo_available']).toBe(true);
    lampRepairId = rep['repair_id'] as string;
    expect(lampRepairId).toMatch(/^rep_/);
    const steps = rep['steps'] as { status: string; read_back?: string }[];
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((x) => x.status === 'done' && typeof x.read_back === 'string' && x.read_back.length > 0)).toBe(true);
    expect(applied.viewUri).toBe('ui://fixwright/repair-card.html');
    await expect.poll(() => s.view().getByRole('button', { name: /undo/i }).isVisible()).toBe(true);
    await s.shot('05-applied-large');
  });

  it('5. explains the 3 a.m. power restore and applies the power on fix by voice', async () => {
    const ex = await s.say('Why did every plug turn on at 3 a.m.?');
    expect(lastTurn(ex)).toMatchObject({ tool: 'explain_event', status: 'ok' });
    expect(ex.spoken.at(-1)).toBe(LINES.explain);
    const out = await lastResult('explain_event');
    expect((out['verdict'] as { level: string; cause_id: string }).level).toBe('confirmed');
    expect((out['verdict'] as { cause_id: string }).cause_id).toBe('power_restore');
    expect(out['suggested_fix']).toBeTruthy();
    await expect.poll(() => s.view().getByText(/Power came back/).first().isVisible()).toBe(true);
    await s.shot('06-explain-large');
    // The plan replays the restore: the fourteen devices the explanation counts, lit in the order the twin
    // logged them, over the same span as the explanation's own rows (power back to the last device on).
    const replay = ex.house.moment;
    const timeline = (out['timeline'] as { ts: string; label: string }[]).map((r) => ({ ...r, ms: Date.parse(r.ts) }));
    const back = timeline.find((r) => r.label === 'Power came back')?.ms ?? Number.NaN;
    const lastOn = Math.max(...timeline.map((r) => r.ms));
    expect(replay?.kind).toBe('restore');
    expect(replay?.devices).toHaveLength(14);
    expect(replay?.spanMs).toBe(lastOn - back);
    const house = await s.demo<DemoState>('/demo/state');
    const cameOn = (id: string): number => Math.min(...(house.entities.find((e) => e.entity_id === id)?.physical?.recentActuations ?? []).map((t) => Date.parse(t)).filter((t) => t >= back && t <= lastOn));
    const order = replay?.devices.map(cameOn) ?? [];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(replay?.line).toBe('At 3:12 AM the power came back and the house restarted.');
    expect((await s.hook<HookSnapshot>('holdMoment', 4900)).house.shown).toBe('night');
    expect(await s.page.locator('.house-time').textContent()).toBe('Replaying 3:12 AM');
    await s.shot('06b-restore-replay-large');
    expect((await s.hook<HookSnapshot>('holdMoment', null)).house.shown).toBe('day');
    const plan = await s.say('Yes.');
    expect(lastTurn(plan)).toMatchObject({ tool: 'repair_plan', status: 'needs_confirmation' });
    const applied = await s.say('Yes.');
    expect(lastTurn(applied)).toMatchObject({ tool: 'repair_apply', status: 'ok' });
    expect(applied.spoken.at(-1)).toBe(LINES.powerFix);
    const rep = await lastResult('repair_apply');
    expect(rep['state']).toBe('applied');
    const steps = rep['steps'] as { status: string; read_back?: string }[];
    expect(steps.length).toBe(14);
    expect(steps.every((x) => x.status === 'done' && (x.read_back ?? '').length > 0)).toBe(true);
    await expect.poll(() => s.view().getByRole('button', { name: /undo/i }).isVisible()).toBe(true);
    // The question was about plugs, so the card lists the plugs first (the server's step order varies),
    // and the step for the floor lamp bulb that is also called Living Room Light says which light it is.
    const labels = await stepLabels();
    expect(labels).toHaveLength(14);
    const plugs = labels.filter((l) => /\bplug\b/i.test(l));
    expect(plugs.length).toBeGreaterThanOrEqual(3);
    expect(labels.slice(0, plugs.length)).toEqual(plugs);
    const shown = await s.view().locator('.step:visible .row-title').count();
    expect(shown).toBeGreaterThan(0);
    expect(labels.slice(0, shown).every((l) => /\bplug\b/i.test(l))).toBe(true);
    expect(labels).toContain('Set Living Room Light (the Floor Lamp) to remember its last state');
    await s.shot('07-power-fix-large');
  });

  it('6. checkup on a small display, then the phone', async () => {
    const small = await s.hook<HookSnapshot>('setDevice', 'small');
    const turns = small.transcript.length;
    const snap = await s.say('Give my house a checkup.');
    expect(lastTurn(snap)).toMatchObject({ tool: 'home_checkup', status: 'ok' });
    expect(snap.viewUri).toBe('ui://fixwright/carousel.html');
    const findings = (await lastResult('home_checkup'))['findings'] as { title: string }[];
    expect(findings.length).toBeGreaterThanOrEqual(3);
    expect(findings.length).toBeLessThanOrEqual(5);
    for (const t of LINES.checkup) expect(findings.map((f) => f.title)).toContain(t);
    await expect.poll(() => s.view().getByText(LINES.checkup[0] as string).first().isVisible()).toBe(true);
    await s.shot('08-checkup-small');
    const phone = await s.hook<HookSnapshot>('setDevice', 'phone');
    expect(phone.transcript.length).toBe(turns + 2);
    expect(phone.viewUri).toBe('ui://fixwright/carousel.html');
    await expect.poll(async () => (await viewText(s)).includes(LINES.checkup[0] as string)).toBe(true);
    await s.shot('09-checkup-phone');
  });

  it('7. refuses to cut the protected aquarium filter and switches the lamp instead', async () => {
    // Named through the add-on: on a real Echo, a bare "turn off the strip" goes to Alexa's own smart home control.
    const snap = await s.say('Alexa, ask Fixwright to turn off the living room power strip.');
    expect(lastTurn(snap)).toMatchObject({ tool: 'switch_device', status: 'refused' });
    expect(snap.spoken.at(-1)).toBe(LINES.refused);
    const out = await lastResult('switch_device');
    expect((out['alternative'] as { name: string }).name).toMatch(/lamp/i);
    // No view answers a switch, so the checkup card leaves the screen: the phone's newest bubble is the answer.
    expect(snap.viewTool).toBeNull();
    await expect.poll(() => s.page.locator('#view-slot iframe').count()).toBe(0);
    await s.shot('10-protected-phone');
    // The plan marks the lamp the refusal switched off instead.
    const lamp = (out['alternative'] as { entity_id?: string }).entity_id;
    expect(lamp).toBeTruthy();
    expect(await s.page.locator(`.plan .dot[data-entity="${lamp}"]`).getAttribute('data-changed')).toBe('true');
    // A display shows the answer in words, not the older checkup card.
    await s.hook('setDevice', 'small');
    await expect.poll(() => s.page.locator('.reply-card').isVisible()).toBe(true);
    expect(await s.page.locator('.reply-card .reply-text').textContent()).toBe(LINES.refused);
    await s.shot('10b-protected-small');
  });

  it('4. next morning 7:00: the check confirms the hallway lamp repair, the push arrives and its card updates', async () => {
    await s.hook('setDevice', 'large');
    // The hallway lamp repair's card on screen (asked for by name: the power on fix is newer), waiting
    // for its 7:00 check.
    const before = await s.say('Did the hallway lamp fix hold?');
    expect(lastTurn(before)).toMatchObject({ tool: 'repair_status', status: 'ok' });
    expect(before.spoken.at(-1)).toBe("The fix is in place and checked. I'll look at it again at 7 in the morning.");
    const asked = await lastResult('repair_status');
    expect(asked['repair_id']).toBe(lampRepairId);
    expect(asked['state']).toBe('applied');
    await expect.poll(() => s.view().getByRole('button', { name: /undo/i }).isVisible()).toBe(true);
    expect(await stepLabels()).toContain('Retire the old copy');
    await s.hook('setTab', 'house');
    await s.page.locator('[data-clock="next_morning"]').click();
    await expect.poll(async () => (await s.snap()).pushes.length).toBeGreaterThan(0);
    const snap = await s.snap();
    expect(snap.pushes.map((p) => p.message), JSON.stringify(snap.pushes)).toContain(LINES.push);
    expect(new Date(snap.clockMs).toISOString().slice(0, 16)).toBe('2026-10-16T14:00');
    // The push sits in the caption band under the display, never on the card.
    await expect.poll(() => s.page.locator('.captions .push-toast').isVisible()).toBe(true);
    // The push's title is "Repair confirmed", so the card does not repeat it at the end of the message.
    expect(await s.page.locator('.captions .push-toast .toast-title').textContent()).toBe('Repair confirmed');
    expect(await s.page.locator('.captions .push-toast .toast-message').textContent()).toBe(LINES.push.replace(/ Repair confirmed\.$/, ''));
    expect(await s.page.locator('.screen .push-toast').isVisible()).toBe(false);
    // The push landed at 7:00, so the wall comes out of the night into morning light.
    expect(snap.house.moment).toMatchObject({ kind: 'morning', line: '7:00 AM in the house. The overnight check ran and its push landed.' });
    expect(snap.house.wall).toBe('day');
    // The push reached the (local) ntfy server, with its title and tags headers.
    await expect.poll(async () => (await ntfyReceived(s.household.ntfy_topic)).map((p) => p.message)).toContain(LINES.push);
    const pushed = (await ntfyReceived(s.household.ntfy_topic)).find((p) => p.message === LINES.push);
    expect(pushed?.title).toBe('Repair confirmed');
    // The card on screen sees its check as due on the new house time and asks the server for its current
    // status (refresh_view, app only, read only): the real server answers with the confirmed repair.
    await expect.poll(async () => (await s.trace()).some((e) => e.lane === 'mcp' && e.dir === 'out' && e.tool === 'refresh_view')).toBe(true);
    await s.hook('idle');
    await expect.poll(() => s.view().getByText('Repair confirmed').first().isVisible()).toBe(true);
    const refreshed = await lastResult('refresh_view');
    expect(refreshed['state']).toBe('confirmed');
    expect(refreshed['repair_id']).toBe(lampRepairId);
    // The card under the push is the hallway lamp's: its own check line, its own steps.
    await expect.poll(async () => (await viewText(s)).includes('Hallway lamp answered all 9 commands overnight.')).toBe(true);
    expect(await stepLabels()).toContain('Retire the old copy');
    const toastBox = await s.page.locator('.captions .push-toast').boundingBox();
    const slotBox = await s.page.locator('#view-slot').boundingBox();
    expect(overlaps(toastBox as Box, slotBox as Box), `${JSON.stringify(toastBox)} over ${JSON.stringify(slotBox)}`).toBe(false);
    await s.shot('11-morning-push-large');
    // Tapping the push opens the repair it is about: the hallway lamp's, confirmed.
    await s.page.locator('.captions .push-toast .toast-open').click();
    const tapped = await s.hook<HookSnapshot>('idle');
    expect(tapped.transcript.at(-2)).toMatchObject({ role: 'user', via: 'tap' });
    expect(lastTurn(tapped)).toMatchObject({ tool: 'repair_status', status: 'ok' });
    const opened = await lastResult('repair_status');
    expect(opened['repair_id']).toBe(lampRepairId);
    expect(opened['state']).toBe('confirmed');
    await expect.poll(() => s.view().getByText('Repair confirmed').first().isVisible()).toBe(true);
    await expect.poll(async () => (await viewText(s)).includes('Hallway lamp answered all 9 commands overnight.')).toBe(true);
    await s.hook('setTab', 'conversation');
  });

  it('8. Visual Trace: initialize at 2025-11-25, tools/list and diagnose_answer with structuredContent', async () => {
    await s.hook('setTab', 'trace');
    await s.page.locator('[data-filter="mcp"]').click();
    const init = s.page.locator('.tr[data-lane="mcp"][data-method="initialize"]');
    await expect.poll(() => init.count()).toBeGreaterThan(0);
    expect(await init.locator('.tr-badge[data-protocol="2025-11-25"]').count()).toBeGreaterThan(0);
    expect(await s.page.locator('.tr[data-lane="mcp"][data-method="tools/list"]').count()).toBeGreaterThan(0);
    const answer = s.page.locator('.tr[data-lane="mcp"][data-tool="diagnose_answer"]');
    expect(await answer.count()).toBe(2);
    expect(await answer.locator('.tr-badge.sc').count()).toBe(1);
    await answer.last().scrollIntoViewIfNeeded();
    await answer.last().locator('.tr-head').click();
    expect(await answer.last().locator('.json').textContent()).toContain('"structuredContent"');
    const rows = await s.trace();
    const initOut = rows.find((r) => r.lane === 'mcp' && r.method === 'initialize' && r.dir === 'out');
    const raw = rows.find((r) => r.lane === 'mcp' && r.dir === 'in' && r.id === initOut?.id);
    expect((raw?.msg as { result?: { protocolVersion?: string } }).result?.protocolVersion).toBe('2025-11-25');
    await s.shot('12-trace');
  });

  it('9. the safety net, live: a fix that does not stick is put back, and an overnight relapse fails the morning check with a next step', async () => {
    // A second household, so the golden path's house and pushes stay as they were.
    s2 = await openHost(browser);
    const t = s2;
    const drill = async (id: string): Promise<void> => {
      await t.hook('setTab', 'house');
      await t.page.locator(`[data-fault="${id}"] button`).click();
      await expect.poll(() => t.page.locator(`[data-active-fault="${id}"]`).isVisible()).toBe(true);
      await t.hook('setTab', 'conversation');
    };
    const lampName = async (): Promise<string | undefined> => (await t.demo<DemoState>('/demo/state')).entities.find((e) => e.entity_id === 'light.hallway_lamp_2')?.name;
    const repairLamp = async (): Promise<HookSnapshot> => {
      const dx = await t.say("Alexa, ask Fixwright why the hallway lamp keeps saying it's not responding.");
      if (dx.transcript.at(-1)?.status === 'needs_answer') await t.say('Yes, it blinked.');
      const plan = await t.say('Yes.');
      expect(plan.transcript.at(-1)).toMatchObject({ tool: 'repair_plan', status: 'needs_confirmation' });
      return t.say('Yes.');
    };
    const result = async (tool: string): Promise<Record<string, unknown>> => {
      const rows = await t.trace();
      const call = rows.filter((r) => r.lane === 'mcp' && r.dir === 'out' && r.method === 'tools/call' && r.tool === tool).at(-1);
      const reply = rows.find((r) => r.lane === 'mcp' && r.dir === 'in' && r.id === call?.id && r !== call);
      return (reply?.msg as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
    };

    // S1: the first change is accepted but never lands. The read back catches it and everything goes back.
    const before = await lampName();
    await drill('next_step_fails');
    const failed = await repairLamp();
    expect(failed.transcript.at(-1)?.tool).toBe('repair_apply');
    expect(failed.spoken.at(-1)).toBe("Something didn't check out, so I put everything back the way it was.");
    expect((await result('repair_apply'))['state']).toBe('rolled_back');
    expect(await lampName()).toBe(before);
    await expect.poll(() => t.view().getByText('Put back').first().isVisible()).toBe(true);
    await t.shot('15-safety-rollback-large');

    // The drill fired once: the same repair, asked again, applies and reads back.
    const fixed = await repairLamp();
    expect(fixed.spoken.at(-1)).toBe(LINES.applied);
    const applied = await result('repair_apply');
    expect(applied['state']).toBe('applied');
    expect(await lampName()).toBe('Hallway Lamp');

    // S2: the repaired lamp loses power at 2:00. The 7:00 check catches it, pushes, and the card offers a next step.
    await drill('overnight_relapse');
    await t.hook('setTab', 'house');
    await t.page.locator('[data-clock="next_morning"]').click();
    await expect.poll(async () => (await t.snap()).pushes.map((p) => p.title)).toContain('Repair needs a look');
    await t.hook('setTab', 'conversation');
    const relapse = 'Hallway lamp missed 1 of 9 commands and went offline once overnight.';
    expect((await t.snap()).pushes.map((p) => p.message).join(' ')).toContain(relapse);
    await t.hook('idle');
    await expect.poll(() => t.view().getByText('Check failed').first().isVisible()).toBe(true);
    await expect.poll(async () => (await viewText(t)).includes(relapse)).toBe(true);
    const next = t.view().getByRole('button', { name: 'Diagnose' });
    await expect.poll(() => next.isVisible()).toBe(true);
    await t.shot('16-safety-relapse-large');
    const turns = (await t.snap()).transcript.length;
    await next.click();
    // The click returns before the view's message crosses the two sandbox frames, so idle() alone could
    // resolve first. Wait until the host has taken the message, then until its diagnose has finished.
    await expect.poll(async () => (await t.snap()).transcript.slice(turns).find((e) => e.role === 'user')).toMatchObject({ via: 'view', text: 'Why is it acting up again?' });
    await expect.poll(async () => (await t.hook<HookSnapshot>('idle')).transcript.at(-1)?.tool).toBe('diagnose');
    const looked = await t.snap();
    expect(looked.approval).toBeNull();
    expect(looked.transcript.at(-1)?.status).not.toBe('error');
    expect((await result('diagnose'))['target']).toMatchObject({ name: 'Hallway Lamp' });
  });

  it('ran with zero console errors in every frame, no page errors and no failed requests', () => {
    for (const session of [s, s2]) {
      if (!session) continue;
      expect(session.consoleErrors, session.consoleErrors.join('\n')).toEqual([]);
      expect(session.pageErrors, session.pageErrors.join('\n')).toEqual([]);
      expect(session.failedRequests, session.failedRequests.join('\n')).toEqual([]);
    }
  });
});
