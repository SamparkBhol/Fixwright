// The Home Assistant beat, through the host UI: a second household is linked to a real Home Assistant
// 2026.9.4 (packages/adapter-ha's local instance with the hallway circuit fixture), the hallway breaker
// really goes off and on, the person asks why the lights came on, and the power on behaviour repair is
// applied and undone. Every change is read back on the hub over its REST API, not through Fixwright.
// Needs the stack with ALLOW_HA_LINK=1 and HA_URL / HA_TOKEN: run `npm run e2e:ha`, which sets all of it up.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { createHaAdapter } from '../packages/adapter-ha/src/index.ts';
import { CIRCUIT, powerCut, powerOnSelect, setPowerOnBehavior, setup, type Fixture } from '../packages/adapter-ha/fixtures/home-assistant/inject.ts';
import { launch, openHost, SERVER, viewText, type HookSnapshot, type Session, type TraceRow } from './support.ts';

const HA_URL = process.env['HA_URL'] ?? '';
const HA_TOKEN = process.env['HA_TOKEN'] ?? '';
const run = HA_URL !== '' && HA_TOKEN !== '' ? describe : describe.skip;

let browser: Browser;
let s: Session;
let fx: Fixture;

/** A select's state straight from Home Assistant's REST API. */
async function haState(entityId: string): Promise<string> {
  const r = await fetch(`${HA_URL}/api/states/${entityId}`, { headers: { authorization: `Bearer ${HA_TOKEN}` } });
  expect(r.status, entityId).toBe(200);
  return ((await r.json()) as { state: string }).state;
}

async function lastResult(tool: string): Promise<Record<string, unknown>> {
  const rows = await s.trace();
  const call = rows.filter((r) => r.lane === 'mcp' && r.dir === 'out' && r.method === 'tools/call' && r.tool === tool).at(-1);
  const reply = rows.find((r) => r.lane === 'mcp' && r.dir === 'in' && r.id === call?.id && r !== call) as TraceRow | undefined;
  const sc = (reply?.msg as { result?: { structuredContent?: Record<string, unknown> } } | undefined)?.result?.structuredContent;
  expect(sc, `no structuredContent for ${tool}`).toBeTruthy();
  return sc as Record<string, unknown>;
}

const lastTurn = (snap: HookSnapshot): HookSnapshot['transcript'][number] | undefined => snap.transcript.at(-1);

run('Home Assistant beat through the host', () => {
  beforeAll(async () => {
    fx = { adapter: createHaAdapter({ baseUrl: HA_URL, token: HA_TOKEN }), configDir: process.env['HA_CONFIG_DIR'] };
    browser = await launch();
    s = await openHost(browser);
  });

  afterAll(async () => {
    fx?.adapter.close();
    await s?.context.close();
    await browser?.close();
  });

  it('links a second household to the real hub (never the shared one)', async () => {
    const shared = await fetch(`${SERVER}/demo/link-ha`, { method: 'POST', headers: { 'content-type': 'application/json', origin: SERVER }, body: JSON.stringify({ base_url: HA_URL, token: HA_TOKEN }) });
    expect(shared.status).toBe(403);
    const linked = await s.demo<{ ok: boolean }>('/demo/link-ha', { base_url: HA_URL, token: HA_TOKEN });
    expect(linked.ok).toBe(true);
    const state = await s.demo<{ adapter: string; simulated: boolean }>('/demo/state');
    expect(state).toMatchObject({ adapter: 'home-assistant', simulated: false });
  });

  it('a real power cut on the hallway circuit brings the devices back on', async () => {
    await setup(fx);
    await setPowerOnBehavior(fx, 'on');
    for (const d of CIRCUIT.devices) expect(await haState(powerOnSelect(d)), d).toBe('on');
    const cut = await powerCut(fx, { holdMs: 2000 });
    expect(cut.devicesOnAfter.length).toBeGreaterThanOrEqual(5);
    // Home Assistant's recorder writes history in batches: wait until the hub's own history shows the
    // devices coming back on, so the question below is asked about a restore the hub has recorded.
    const history = `${HA_URL}/api/history/period/${encodeURIComponent(cut.breakerOnAt)}?minimal_response&filter_entity_id=${CIRCUIT.devices.join(',')}`;
    const recordedOn = async (): Promise<number> => {
      const r = await fetch(history, { headers: { authorization: `Bearer ${HA_TOKEN}` } });
      const rows = (await r.json()) as { state: string }[][];
      return rows.filter((series) => series.some((x) => x.state === 'on')).length;
    };
    await expect.poll(recordedOn, { timeout: 15_000 }).toBeGreaterThanOrEqual(cut.devicesOnAfter.length);
    // The page picks up the linked house (and its real clock) on a fresh load; the household token stays.
    await s.page.reload();
    await s.hook('ready');
    expect((await s.snap()).connection.status).toBe('ready');
  });

  it('explains the restore and applies the power on fix by voice, read back on the hub', async () => {
    const ex = await s.say('Why did the hallway lights turn on by themselves?');
    expect(lastTurn(ex)).toMatchObject({ tool: 'explain_event', status: 'ok' });
    const out = await lastResult('explain_event');
    if (process.env['E2E_DEBUG']) console.log(JSON.stringify({ speech: ex.spoken.at(-1), verdict: out['verdict'], timeline: out['timeline'] }, null, 1));
    expect(out['source']).toEqual({ adapter: 'home-assistant', simulated: false });
    expect((out['verdict'] as { cause_id: string }).cause_id).toBe('power_restore');
    expect(out['suggested_fix']).toBeTruthy();
    console.log(`explain_event on Home Assistant: ${String(ex.spoken.at(-1))}`);
    await expect.poll(() => s.view().getByText('Real Home Assistant, demo devices').first().isVisible()).toBe(true);
    await s.shot('13-ha-explain-large');

    const plan = await s.say('Yes.');
    expect(lastTurn(plan)).toMatchObject({ tool: 'repair_plan', status: 'needs_confirmation' });
    const applied = await s.say('Yes.');
    expect(lastTurn(applied)).toMatchObject({ tool: 'repair_apply', status: 'ok' });
    const rep = await lastResult('repair_apply');
    expect(rep['state']).toBe('applied');
    expect(rep['source']).toEqual({ adapter: 'home-assistant', simulated: false });
    const steps = rep['steps'] as { status: string; read_back?: string }[];
    expect(steps.length).toBe(CIRCUIT.devices.length);
    expect(steps.every((x) => x.status === 'done' && (x.read_back ?? '').length > 0)).toBe(true);
    console.log(`repair_apply on Home Assistant: ${String(applied.spoken.at(-1))}`);
    for (const d of CIRCUIT.devices) expect(await haState(powerOnSelect(d)), d).toBe('previous');
    await expect.poll(() => s.view().getByText('Real Home Assistant, demo devices').first().isVisible()).toBe(true);
    await expect.poll(() => s.view().getByRole('button', { name: /undo/i }).isVisible()).toBe(true);
    expect(await viewText(s)).not.toContain('Simulated home');
    await s.shot('14-ha-repair-large');
  });

  it('undo puts the hub back the way it was, read back on the hub', async () => {
    const undone = await s.say('Undo that.');
    const snap = undone.approval ? await s.hook<HookSnapshot>('approve', true) : undone;
    expect(lastTurn(snap)).toMatchObject({ tool: 'undo', status: 'ok' });
    expect((await lastResult('undo'))['state']).toBe('undone');
    for (const d of CIRCUIT.devices) expect(await haState(powerOnSelect(d)), d).toBe('on');
  });

  it('ran with zero console errors in every frame, no page errors and no failed requests', () => {
    expect(s.consoleErrors, s.consoleErrors.join('\n')).toEqual([]);
    expect(s.pageErrors, s.pageErrors.join('\n')).toEqual([]);
    expect(s.failedRequests, s.failedRequests.join('\n')).toEqual([]);
  });
});
