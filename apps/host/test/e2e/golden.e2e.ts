// End to end: the host page (localhost:8711), the sandbox proxy (127.0.0.1:8712) and the mock MCP
// server (127.0.0.1:8713) in headless Chromium, walking the golden path.
// Asserts the trace shows initialize at 2025-11-25, views render inside the double sandbox iframe,
// "Fix it" from a view opens the approval prompt (and so does a view's ui/message that would change
// the house), a spoken yes or no answers that prompt, device switches keep the conversation and come
// back to the newest screen (also after a tap in the view), voice only shows no view but speaks, the
// views run on the host clock (the morning check lands on the device), the device holds its size from
// turn to turn, and the whole run logs zero console errors. Saves a screenshot per device.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Frame, type FrameLocator, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HookSnapshot } from '../../src/hook.ts';
import { startStack, type Stack } from '../support/stack.ts';
import { START } from '../mock/household.ts';
import houseFx from '../mock/house.json' with { type: 'json' };

const SHOTS = process.env['E2E_SHOTS'] ?? join(dirname(new URL(import.meta.url).pathname), '..', '..', 'screenshots');
// Pinned on purpose to a time the mock house does not start at (START, 10:20 in the house's time
// zone), so a pin that the first /demo/state reading overwrote would show up as START.
const PINNED_CLOCK = '2026-10-15T17:42:00.000Z';

let stack: Stack;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const failedRequests: string[] = [];
/** Width of the large display on screen, sampled on several turns: it must never change. */
const largeWidths: number[] = [];
/** Request ids the tests forge from inside a view; the view's SDK rightly logs their stray replies. */
const FORGED_IDS = [9001, 9002, 9003, 9004, 9005];

const hook = <T>(fn: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(
    async ([name, a]) => {
      const h = (window as unknown as { __fixwright: Record<string, (...x: unknown[]) => unknown> }).__fixwright;
      return (await h[name as string]?.(...(a as unknown[]))) as unknown;
    },
    [fn, args] as const,
  ) as Promise<T>;

const say = (text: string): Promise<HookSnapshot> => hook<HookSnapshot>('say', text);
interface TraceRow {
  lane: string;
  dir: string;
  kind: string;
  method: string;
  tool: string | null;
  id: string | number | null;
  msg: unknown;
}
const traceRows = (): Promise<TraceRow[]> => hook<TraceRow[]>('trace');
const snap = (): Promise<HookSnapshot> => hook<HookSnapshot>('snapshot');
const view = (): FrameLocator => page.frameLocator('#view-slot iframe.active:not(.leaving)').frameLocator('iframe');

async function shot(name: string, target: 'page' | 'stage' = 'page'): Promise<void> {
  // The views animate their cards in; a shot shows the state a person sees a moment later.
  await Promise.all(
    page.frames().map((f) =>
      f
        .evaluate(() =>
          Promise.race([
            Promise.all(
              document
                .getAnimations()
                .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
                .map((a) => a.finished.catch(() => undefined)),
            ),
            new Promise((r) => setTimeout(r, 2000)),
          ]).then(() => undefined),
        )
        .catch(() => undefined),
    ),
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  const path = join(SHOTS, `${name}.png`);
  if (target === 'stage') await page.locator('#stage').screenshot({ path });
  else await page.screenshot({ path });
}

function viewFrames(): Frame[] {
  return page.frames().filter((f) => f !== page.mainFrame());
}

/** The innermost frame of the view on screen (the view itself, inside the sandbox proxy). */
async function activeViewFrame(p: Page = page): Promise<Frame> {
  const outer = await (await p.locator('#view-slot iframe.active:not(.leaving)').elementHandle())?.contentFrame();
  const inner = outer?.childFrames()[0];
  if (!inner) throw new Error('no view frame on screen');
  return inner;
}

/** Post a ui/message from inside the view, as a view (or a compromised one) could. */
async function viewSays(text: string, id: number, p: Page = page): Promise<void> {
  await (await activeViewFrame(p)).evaluate(
    ([t, i]) => window.parent.postMessage({ jsonrpc: '2.0', id: i, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: t }] } }, '*'),
    [text, id] as const,
  );
}

async function sampleLargeWidth(): Promise<void> {
  largeWidths.push(await page.locator('.device-body').evaluate((el) => Math.round(el.getBoundingClientRect().width * 10) / 10));
}

/** Exactly one frame is the active view: a replaced frame stops counting the moment the new one shows. */
async function expectOneActiveFrame(p: Page = page): Promise<void> {
  expect(await p.locator('#view-slot iframe.active').count()).toBe(1);
  expect(await p.locator('#view-slot iframe.active:not(.leaving)').count()).toBe(1);
}

const nowSentToViews = async (): Promise<string[]> =>
  (await traceRows())
    .filter((e) => e.lane === 'bridge' && e.dir === 'out')
    .map((e) => {
      const m = e.msg as { params?: Record<string, unknown>; result?: { hostContext?: Record<string, unknown> } };
      return m.params?.['dev.fixwright/now'] ?? m.result?.hostContext?.['dev.fixwright/now'];
    })
    .filter((v): v is string => typeof v === 'string');

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The visible push banner: the caption band's on a display, the phone's own on the phone. */
const pushBanner = (p: Page = page) => p.locator('.push-toast:not([hidden])');

/**
 * The push banner never covers the view (screenshots 11 and 12 once had it over the card's steps): it
 * sits in the caption band on a display and over the chat on the phone. Boxes are in page coordinates.
 */
async function expectToastClearOfView(): Promise<void> {
  await expect.poll(() => pushBanner().count()).toBe(1);
  const toast = await pushBanner().boundingBox();
  const slot = await page.locator('#view-slot').boundingBox();
  expect(toast).not.toBeNull();
  expect(slot).not.toBeNull();
  expect(overlaps(toast as Box, slot as Box), `push banner ${JSON.stringify(toast)} covers the view ${JSON.stringify(slot)}`).toBe(false);
}

const dotOf = (entityId: string) => page.locator(`.plan .dot[data-entity="${entityId}"]`);

const mcpCalls = async (tool: string): Promise<number> => (await traceRows()).filter((e) => e.lane === 'mcp' && e.dir === 'out' && e.method === 'tools/call' && e.tool === tool).length;

beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
  stack = await startStack({ views: (process.env['E2E_VIEWS'] as 'auto' | 'dist' | 'placeholder' | undefined) ?? 'auto' });
  browser = await chromium.launch({ headless: true });
  const [vw, vh] = (process.env['E2E_VIEWPORT'] ?? '1600x1000').split('x').map(Number);
  context = await browser.newContext({ viewport: { width: vw || 1600, height: vh || 1000 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${m.location().url}`);
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
  await page.goto(stack.pageUrl({ test: '1' }));
  await hook('ready');
  await hook('setClock', PINNED_CLOCK);
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await stack?.close();
});

describe('golden path in the host simulator', () => {
  it('holds a clock pinned right after ready(), on the device and in every view context', async () => {
    expect(PINNED_CLOCK).not.toBe(START);
    const s = await snap();
    expect(new Date(s.clockMs).toISOString()).toBe(PINNED_CLOCK);
    // 17:42 UTC is 10:42 AM in the house's Los Angeles time zone; START would read 10:20.
    await expect.poll(() => page.locator('.idle-time').first().textContent()).toBe('10:42 AM');
  });

  it('connects as a real MCP client at 2025-11-25 with a household token', async () => {
    const s = await snap();
    expect(s.connection.status).toBe('ready');
    expect(s.connection.protocolVersion).toBe('2025-11-25');
    expect(s.connection.tools).toBe(11);
    await expect.poll(() => page.locator('#honesty-banner').textContent()).toContain('Alexa+ host simulated. Live MCP server: ');
    expect(await page.locator('#honesty-banner').textContent()).toContain(`${stack.serverUrl}/mcp (MCP 2025-11-25, Streamable HTTP).`);
    const mcpPosts = stack.mock.requests.filter((r) => r.path === '/mcp' && r.method === 'POST');
    expect(mcpPosts.length).toBeGreaterThanOrEqual(3);
    expect(mcpPosts.every((r) => r.origin === stack.hostOrigin)).toBe(true);
    expect(mcpPosts.every((r) => /^Bearer hh_mock/.test(r.authorization ?? ''))).toBe(true);
    expect(mcpPosts.filter((r) => r.rpcMethod !== 'initialize').every((r) => r.protocolVersion === '2025-11-25')).toBe(true);
    expect(stack.mock.requests.some((r) => r.method === 'GET' && r.path === '/mcp')).toBe(false);
    const resourcesRead = mcpPosts.filter((r) => r.rpcMethod === 'resources/read').length;
    expect(resourcesRead).toBe(3);
    // The house plan: six rooms, one dot per light, switch or fan from /demo/state, on a day wall at 10:42.
    const { house } = await snap();
    expect(house.rooms?.map((r) => r.id)).toEqual(['garage', 'kitchen', 'hallway', 'living_room', 'office', 'bedroom']);
    expect(house.rooms?.flatMap((r) => r.dots).length).toBe(houseFx.entities.length);
    expect(await page.locator('.plan .dot').count()).toBe(houseFx.entities.length);
    expect(await dotOf('light.hallway_lamp').getAttribute('data-state')).toBe('unavailable');
    expect(await page.locator('.plan .dot[data-state="on"]').count()).toBe(houseFx.entities.filter((e) => e.state === 'on').length);
    expect([house.wall, house.shown]).toEqual(['day', 'day']);
    expect(await page.locator('.house-time').textContent()).toBe('House time 10:42 AM, simulated');
    await sampleLargeWidth();
    await shot('00-idle-large');
  });

  it('1. diagnoses the hallway lamp and renders the stepper inside the double sandbox iframe', async () => {
    const s = await say("Alexa, ask Fixwright why the hallway lamp keeps saying it's not responding.");
    expect(s.transcript.at(-1)).toMatchObject({ role: 'assistant', tool: 'diagnose', status: 'needs_answer' });
    expect(s.spoken.at(-1)).toContain("I'll flash the hallway lamp twice. Did it blink?");
    expect(s.viewUri).toBe('ui://fixwright/stepper.html');
    await expect.poll(() => view().getByText('Hallway Lamp').first().isVisible()).toBe(true);
    const frames = viewFrames();
    const outer = frames.find((f) => f.url().startsWith(stack.sandboxUrl));
    expect(outer, frames.map((f) => f.url()).join(', ')).toBeTruthy();
    const inner = frames.find((f) => f.parentFrame() === outer);
    expect(inner).toBeTruthy();
    expect(await inner?.evaluate(() => window.location.origin)).toBe(new URL(stack.sandboxUrl).origin);
    await expectOneActiveFrame();
    // The view runs on the host clock (pinned here), not on the browser's or the house's start time.
    const sent = await nowSentToViews();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((t) => t === PINNED_CLOCK)).toBe(true);
    expect(sent).not.toContain(START);
    expect(await inner?.evaluate(() => {
      try {
        return String((window.top as Window).document.title);
      } catch {
        return 'blocked';
      }
    })).toBe('blocked');
    await sampleLargeWidth();
    await shot('01-large-diagnose');
  });

  it('1b. the plan blinks the lamp that really switched, in the rhythm of its logged switches', async () => {
    const { house } = await snap();
    expect(house.moment).toMatchObject({ kind: 'flash', devices: ['light.hallway_lamp_2'], frames: 4 });
    // Test mode shows what reduced motion shows: the end state and the line, no playback.
    expect(await page.locator('.house-line').textContent()).toBe(house.moment?.line);
    expect(house.moment?.line).toMatch(/^The online Hallway Lamp switched 4 times in \d+ ms\.$/);
    expect(await dotOf('light.hallway_lamp_2').getAttribute('data-state')).toBe('off');
    expect(await dotOf('light.hallway_lamp_2').getAttribute('data-answered')).toBe('true');
    const states: string[] = [];
    for (const at of [100, 700, 1300, 1900]) {
      await hook('holdMoment', at);
      states.push(String(await dotOf('light.hallway_lamp_2').getAttribute('data-state')));
      if (at === 100) await shot('19-large-flash-replay');
    }
    // A held frame is the replay itself, so only then does the line speak of the slower rhythm.
    expect(await page.locator('.house-line').textContent()).toBe(`${house.moment?.line} Shown slower, in the same rhythm.`);
    expect(await dotOf('light.hallway_lamp_2').getAttribute('data-focus')).toBe('true');
    expect(states).toEqual(['on', 'off', 'on', 'off']);
    await hook('holdMoment', null);
    expect(await dotOf('light.hallway_lamp_2').getAttribute('data-replay')).toBe('false');
  });

  it('2. switches to voice only: same conversation, no view, the answer is spoken', async () => {
    const before = await snap();
    const s1 = await hook<HookSnapshot>('setDevice', 'voice');
    expect(s1.device).toBe('voice');
    expect(s1.viewUri).toBeNull();
    await expect.poll(() => page.locator('#view-slot iframe').count()).toBe(0);
    expect(s1.transcript.length).toBe(before.transcript.length);
    expect(s1.conversation.pendingQuestion?.question_id).toBe(before.conversation.pendingQuestion?.question_id);

    const s2 = await say('Yes, it blinked.');
    expect(s2.transcript.at(-1)).toMatchObject({ tool: 'diagnose_answer', status: 'ok' });
    expect(s2.spoken.at(-1)).toContain('The lamp works. The name Hallway Lamp still points at an old copy of it that went offline on October 3.');
    expect(await page.locator('#view-slot iframe').count()).toBe(0);
    expect(await page.locator('.speaker').isVisible()).toBe(true);
    expect(await page.locator('.ring').getAttribute('data-state')).toBe('speaking');
    await shot('02-voice-verdict');
  });

  it('3. back on the large display: the verdict view returns, then "Yes." plans the fix', async () => {
    const s1 = await hook<HookSnapshot>('setDevice', 'large');
    expect(s1.viewTool).toBe('diagnose_answer');
    await expect.poll(() => view().getByText('Confirmed').first().isVisible()).toBe(true);
    const s2 = await say('Yes.');
    expect(s2.transcript.at(-1)).toMatchObject({ tool: 'repair_plan', status: 'needs_confirmation' });
    expect(s2.conversation.pendingPlan?.plan_id).toMatch(/^pln_/);
    await expectOneActiveFrame();
    await expect.poll(() => view().getByRole('button', { name: /fix it/i }).isVisible()).toBe(true);
    await sampleLargeWidth();
    await shot('03-large-plan');
  });

  it('3b. a view that sends "yes" as a message cannot spend the plan without the approval sheet', async () => {
    const before = await snap();
    expect(before.conversation.pendingPlan).not.toBeNull();
    await viewSays('yes', 9002);
    await page.waitForFunction(() => (window as unknown as { __fixwright: { snapshot(): HookSnapshot } }).__fixwright.snapshot().approval !== null);
    const dialog = page.getByRole('alertdialog');
    await expect.poll(() => dialog.isVisible()).toBe(true);
    expect(await dialog.textContent()).toContain('Apply this fix?');
    expect(await dialog.textContent()).toContain('The screen sent “yes” for you.');
    expect(await mcpCalls('repair_apply')).toBe(0);
    // The captions pair what the view sent with the question the sheet asks.
    expect(await page.locator('.cap-user').getAttribute('data-via')).toBe('view');
    expect(await page.locator('.cap-reply').textContent()).toBe('Apply this fix?');
    await shot('03b-large-message-approval');

    const s = await hook<HookSnapshot>('approve', false);
    expect(s.approval).toBeNull();
    expect(s.spoken.at(-1)).toBe('Okay. Nothing changed.');
    expect(s.conversation.pendingPlan?.plan_id).toBe(before.conversation.pendingPlan?.plan_id);
    expect(await mcpCalls('repair_apply')).toBe(0);
    expect(s.transcript.at(-3)).toMatchObject({ role: 'user', text: 'yes', intent: 'apply_plan' });
    const events = await hook<Array<{ type: string; detail?: { via?: string } }>>('events');
    expect(events.some((e) => e.type === 'approval asked' && e.detail?.via === 'ui/message')).toBe(true);
    expect(events.some((e) => e.type === 'approval declined' && e.detail?.via === 'ui/message')).toBe(true);
    await expect.poll(() => view().getByRole('button', { name: /fix it/i }).isVisible()).toBe(true);
  });

  it('4. "Fix it" in the view opens the approval prompt; yes applies the repair', async () => {
    await view().getByRole('button', { name: /fix it/i }).click();
    await page.waitForFunction(() => (window as unknown as { __fixwright: { snapshot(): HookSnapshot } }).__fixwright.snapshot().approval !== null);
    const dialog = page.getByRole('alertdialog');
    await expect.poll(() => dialog.isVisible()).toBe(true);
    expect(await dialog.textContent()).toContain('Hallway Lamp will point to the lamp that is online.');
    // The tap is the person's turn; the sheet's question is the reply, and it is spoken.
    const asking = await snap();
    expect(asking.transcript.at(-1)).toMatchObject({ role: 'user', text: 'Fix it.', via: 'tap' });
    expect(asking.spoken.at(-1)).toBe('Apply this fix?');
    expect(await page.locator('.cap-user').textContent()).toBe('Fix it.');
    expect(await page.locator('.cap-user').getAttribute('data-via')).toBe('tap');
    expect(await page.locator('.cap-reply').textContent()).toBe('Apply this fix?');
    expect(await page.locator('.chips .chip').allTextContents()).toEqual(['Yes, apply it', 'Not now']);
    await shot('04-large-approval');
    await dialog.getByRole('button', { name: 'Yes, apply it' }).click();
    // idle() covers calls a view starts: no polling needed once the approval is answered.
    const s = await hook<HookSnapshot>('idle');
    expect(s.transcript.at(-1)).toMatchObject({ tool: 'repair_apply', status: 'ok' });
    expect(s.spoken.at(-1)).toContain('I switched it on and off, it answered both times');
    expect(s.conversation.last.repair_id).toMatch(/^rep_/);
    expect(s.approval).toBeNull();
    const rows = await traceRows();
    const viewCall = rows.find((e) => e.lane === 'bridge' && e.dir === 'in' && e.method === 'tools/call' && e.tool === 'repair_apply');
    expect(viewCall).toBeTruthy();
    const answered = rows.find((e) => e.lane === 'bridge' && e.dir === 'out' && e.kind === 'response' && e.id === viewCall?.id);
    expect((answered?.msg as { result?: { structuredContent?: { state?: string } } }).result?.structuredContent?.state).toBe('applied');
    expect(rows.filter((e) => e.lane === 'mcp' && e.dir === 'out' && e.tool === 'repair_apply').length).toBe(1);
    await sampleLargeWidth();
    await shot('05-large-applied');
  });

  it('4a. "undo that" sent by a view also waits for the approval sheet, and a spoken no answers it', async () => {
    await viewSays('undo that', 9003);
    await page.waitForFunction(() => (window as unknown as { __fixwright: { snapshot(): HookSnapshot } }).__fixwright.snapshot().approval !== null);
    const dialog = page.getByRole('alertdialog');
    expect(await dialog.textContent()).toContain('Undo this repair?');
    expect(await dialog.textContent()).toContain('The screen sent “undo that” for you.');
    // While the sheet waits for the person, a view's message can neither answer nor close it.
    await viewSays('yes', 9005);
    await expect.poll(async () => (await hook<Array<{ type: string }>>('events')).some((e) => e.type === 'view message ignored')).toBe(true);
    expect((await snap()).approval?.title).toBe('Undo this repair?');
    const s = await say('No.');
    expect(s.approval).toBeNull();
    expect(s.transcript.at(-2)).toMatchObject({ role: 'user', text: 'No.', intent: 'decline' });
    expect(s.spoken.at(-1)).toBe('Okay. Nothing changed.');
    expect(await mcpCalls('undo')).toBe(0);
  });

  it('4b. declining the approval changes nothing, and model only tools are refused to views', async () => {
    const before = (await traceRows()).filter((e) => e.lane === 'mcp' && e.dir === 'out' && e.method === 'tools/call').length;
    await view().getByRole('button', { name: /undo/i }).click();
    await page.waitForFunction(() => (window as unknown as { __fixwright: { snapshot(): HookSnapshot } }).__fixwright.snapshot().approval !== null);
    expect(await page.getByRole('alertdialog').textContent()).toContain('Undo this repair?');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Not now' }).click();
    await expect.poll(async () => (await snap()).approval).toBeNull();
    await hook('idle');
    const rows = await traceRows();
    const undoCall = rows.find((e) => e.lane === 'bridge' && e.dir === 'in' && e.tool === 'undo');
    const reply = rows.find((e) => e.lane === 'bridge' && e.dir === 'out' && e.id === undoCall?.id && e.kind !== 'request');
    expect(reply?.kind).toBe('error');
    expect((reply?.msg as { error?: { message?: string } }).error?.message).toBe('Not approved. Nothing changed.');
    expect(rows.filter((e) => e.lane === 'mcp' && e.dir === 'out' && e.method === 'tools/call').length).toBe(before);
    // The view got its latest result again just before the denial, so it stays on the repair card
    // with its Undo button instead of reporting a failure for the person's own choice.
    const undoAt = rows.indexOf(undoCall as TraceRow);
    const resent = rows.findIndex((e, i) => i > undoAt && e.lane === 'bridge' && e.dir === 'out' && e.method === 'ui/notifications/tool-result');
    expect(resent).toBeGreaterThan(undoAt);
    expect(resent).toBeLessThan(rows.indexOf(reply as TraceRow));
    await expect.poll(() => view().getByRole('button', { name: /undo/i }).isVisible()).toBe(true);
    expect(await view().locator('.error, [role="alert"]').count()).toBe(0);
    await shot('05b-large-declined');

    // A view asking for a model only tool (switch_device) is refused by the host before any network call.
    const inner = viewFrames().find((f) => f.parentFrame() !== page.mainFrame() && f.parentFrame() !== null);
    await inner?.evaluate(() => {
      window.parent.postMessage({ jsonrpc: '2.0', id: 9001, method: 'tools/call', params: { name: 'switch_device', arguments: { device: 'living room power strip', on: false } } }, '*');
    });
    await expect.poll(async () => (await traceRows()).some((e) => e.lane === 'bridge' && e.dir === 'out' && e.id === 9001 && e.kind === 'error')).toBe(true);
    expect((await traceRows()).some((e) => e.lane === 'mcp' && e.tool === 'switch_device')).toBe(false);
    const events = await hook<Array<{ type: string }>>('events');
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['approval declined', 'view tools/call refused']));
  });

  it('4c. after the view applied the fix, a voice round trip comes back to the repair, not the dry run', async () => {
    await hook<HookSnapshot>('setDevice', 'voice');
    const s = await hook<HookSnapshot>('setDevice', 'large');
    expect(s.viewTool).toBe('repair_apply');
    expect(s.viewUri).toBe('ui://fixwright/repair-card.html');
    await expectOneActiveFrame();
    await expect.poll(() => view().getByRole('button', { name: /undo/i }).isVisible()).toBe(true);
    const text = await view().locator('body').innerText();
    expect(text).toContain('Fixed and checked');
    expect(text).not.toContain('Nothing changed yet');
    expect(await view().getByRole('button', { name: /fix it/i }).count()).toBe(0);
    // Relative times come from the host clock: 10:20 on 15 October, so the 7:00 check is tomorrow.
    if (stack.mock.viewSource === 'dist') expect(text).toMatch(/Tomorrow at 7:00\sAM/);
  });

  it('5. next morning: the clock jump confirms the repair with a push, on the device too', async () => {
    await hook('setTab', 'house');
    await page.locator('[data-clock="next_morning"]').click();
    await expect.poll(async () => (await snap()).pushes.length).toBeGreaterThan(0);
    const s = await snap();
    expect(s.pushes[0]?.message).toBe('Hallway lamp answered all 9 commands overnight. Repair confirmed.');
    expect(new Date(s.clockMs).toISOString()).toBe('2026-10-16T14:00:00.000Z');
    // The push shows on the display itself, not only in the console.
    expect(s.toast?.message).toBe('Hallway lamp answered all 9 commands overnight. Repair confirmed.');
    await expect.poll(() => page.locator('.captions .push-toast').isVisible()).toBe(true);
    expect(await page.locator('.captions .push-toast').textContent()).toContain('Repair confirmed');
    // The views got the new house time, so the repair card sees its check as due and refreshes itself
    // (refresh_view, read only, no approval) to the confirmed result.
    await expect.poll(nowSentToViews).toContain('2026-10-16T14:00:00.000Z');
    await expect.poll(async () => (await traceRows()).some((e) => e.lane === 'mcp' && e.dir === 'out' && e.tool === 'refresh_view')).toBe(true);
    await hook('idle');
    await expect.poll(() => view().getByText('Repair confirmed').first().isVisible()).toBe(true);
    expect(await view().locator('body').innerText()).not.toMatch(/tomorrow/i);
    expect((await snap()).approval).toBeNull();
    // The banner fills the caption band, clear of the card, in place of the last turn ("Not now").
    await expectToastClearOfView();
    // The title says "Repair confirmed", so the message under it does not say it again.
    expect(await page.locator('.captions .push-toast .toast-title').textContent()).toBe('Repair confirmed');
    expect(await page.locator('.captions .push-toast .toast-message').textContent()).toBe('Hallway lamp answered all 9 commands overnight.');
    expect(await page.locator('.captions .cap-reply').isHidden()).toBe(true);
    expect(await page.locator('.captions .cap-user').isHidden()).toBe(true);
    // The push lands at 7:00: the wall comes out of the night into morning light, then follows the clock.
    const morning = (await snap()).house;
    expect(morning.moment).toMatchObject({ kind: 'morning', line: '7:00 AM in the house. The overnight check ran and its push landed.' });
    expect(morning.wall).toBe('day');
    expect((await hook<HookSnapshot>('holdMoment', 400)).house).toMatchObject({ shown: 'night', morning: false });
    expect((await hook<HookSnapshot>('holdMoment', 1600)).house).toMatchObject({ shown: 'day', morning: true });
    await shot('20-morning-light');
    expect((await hook<HookSnapshot>('holdMoment', null)).house).toMatchObject({ shown: 'day', morning: false });
    await page.locator('[data-fault="hub_down"] button').click();
    await expect.poll(() => page.locator('[data-active-fault="hub_down"]').count()).toBe(1);
    const token = stack.mock.requests.filter((r) => r.path === '/demo/fault').at(-1)?.authorization;
    expect(token).toMatch(/^Bearer hh_mock/);
    const household = stack.mock.households.get(String(token).slice(7));
    expect(household?.snapshot()['active_faults']).toContain('hub_down');
    await page.locator('[data-panel="house"]').evaluate((el) => {
      el.scrollTop = 0;
    });
    await shot('06-break-my-house');
    // The same banner on the small display (caption band) and the phone (over the chat): never on the card.
    await hook('setDevice', 'small');
    await hook('idle');
    await expect.poll(() => page.locator('.captions .push-toast').isVisible()).toBe(true);
    await expectToastClearOfView();
    await shot('17-small-push');
    await hook('setDevice', 'phone');
    await hook('idle');
    await expect.poll(() => page.locator('.screen .push-toast').isVisible()).toBe(true);
    await expectToastClearOfView();
    await shot('18-phone-push');
    await hook('setDevice', 'large');
    await hook('idle');
    // Tapping the push opens the repair it names (the hallway lamp's), as the person's own turn.
    await page.locator('.captions .push-toast .toast-open').click();
    const opened = await hook<HookSnapshot>('idle');
    expect(opened.transcript.at(-2)).toMatchObject({ role: 'user', via: 'tap', text: 'Show me that repair.' });
    expect(opened.transcript.at(-1)).toMatchObject({ tool: 'repair_status', status: 'ok' });
    expect(opened.toast).toBeNull();
    await expect.poll(() => pushBanner().count()).toBe(0);
    const status = await say('Did the fix hold?');
    expect(status.transcript.at(-1)).toMatchObject({ tool: 'repair_status', status: 'ok' });
    expect(status.toast).toBeNull();
  });

  it('6. explains the 3 a.m. power restore and applies the suggested fix by voice', async () => {
    const s1 = await say('Why did every plug turn on at 3 a.m.?');
    expect(s1.transcript.at(-1)).toMatchObject({ tool: 'explain_event' });
    expect(s1.spoken.at(-1)).toContain('Power came back at 3:12. Fourteen devices restarted within four seconds. None of your automations fired.');
    // The plan replays the restore from the logged switches: night, the fourteen devices in logged order, day.
    const replay = s1.house.moment;
    expect(replay?.kind).toBe('restore');
    expect(replay?.devices.length).toBe(14);
    expect(replay?.line).toBe('At 3:12 AM the power came back and the house restarted.');
    const held = (await hook<HookSnapshot>('holdMoment', 4700)).house;
    expect(held.shown).toBe('night');
    // The night wall is the replayed 3:12 AM, and the label says so instead of the house time of day.
    expect(await page.locator('.house-time').textContent()).toBe('Replaying 3:12 AM');
    // Halfway: some devices back on, the rest still without power.
    const replayed = await page.locator('.plan .dot[data-replay="true"]').count();
    const lit = await page.locator('.plan .dot[data-replay="true"][data-state="on"]').count();
    const dark = await page.locator('.plan .dot[data-replay="true"][data-state="unavailable"]').count();
    expect(replayed).toBeGreaterThanOrEqual(14);
    expect(lit).toBeGreaterThan(0);
    expect(dark).toBeGreaterThan(0);
    expect(lit + dark).toBe(replayed);
    await shot('21-large-restore-replay');
    expect((await hook<HookSnapshot>('holdMoment', null)).house.shown).toBe('day');
    expect(await page.locator('.house-time').textContent()).toMatch(/^House time \d+:\d\d [AP]M, simulated$/);
    const s2 = await say('Yes.');
    expect(s2.transcript.at(-1)).toMatchObject({ tool: 'repair_plan', status: 'needs_confirmation' });
    const s3 = await say('Yes.');
    expect(s3.transcript.at(-1)).toMatchObject({ tool: 'repair_apply', status: 'ok' });
    expect(s3.approval).toBeNull();
  });

  it('7. checkup on a small display, then the phone, conversation intact', async () => {
    await hook('setTab', 'conversation');
    const s1 = await hook<HookSnapshot>('setDevice', 'small');
    const turns = s1.transcript.length;
    const s2 = await say('Give my house a checkup.');
    expect(s2.transcript.at(-1)).toMatchObject({ tool: 'home_checkup', status: 'ok' });
    expect(s2.viewUri).toBe('ui://fixwright/carousel.html');
    await expect.poll(() => view().getByText('Two lights answer to Living Room Light').isVisible()).toBe(true);
    await shot('07-small-checkup');
    const s3 = await hook<HookSnapshot>('setDevice', 'phone');
    expect(s3.transcript.length).toBe(turns + 2);
    // The phone shows whole sentences in its chat, never cut off.
    const bubbleCut = await page.locator('.phone-chat .bubble span').evaluateAll((els) => els.some((el) => el.scrollHeight > el.clientHeight + 1));
    expect(bubbleCut).toBe(false);
    expect(s3.viewUri).toBe('ui://fixwright/carousel.html');
    await expect.poll(() => view().getByText('Hall motion sensor battery at 6%').isVisible()).toBe(true);
    await shot('08-phone-checkup');
  });

  it('8. refuses to cut the protected aquarium filter', async () => {
    const s = await say('Turn off the living room power strip.');
    expect(s.transcript.at(-1)).toMatchObject({ tool: 'switch_device', status: 'refused' });
    expect(s.spoken.at(-1)).toBe("That strip runs the aquarium filter, which you marked protected. I'll turn off the lamp on it instead.");
    // The refusal has no view of its own: the checkup card leaves the phone, so the newest bubble is the
    // answer, and a display shows the answer in words instead of the older card.
    expect(s.viewTool).toBeNull();
    await expect.poll(() => page.locator('#view-slot iframe').count()).toBe(0);
    await hook<HookSnapshot>('setDevice', 'large');
    await expect.poll(() => page.locator('.reply-card').isVisible()).toBe(true);
    expect(await page.locator('.reply-card .reply-text').textContent()).toBe(s.spoken.at(-1));
    expect(await page.locator('.reply-card .reply-tag').textContent()).toBe('Kept on');
    await shot('22-large-refusal');
    await sampleLargeWidth();
    await say('Give my house a checkup.');
    await sampleLargeWidth();
  });

  it('holds the device at one size from turn to turn', () => {
    expect(largeWidths.length).toBeGreaterThanOrEqual(6);
    expect(new Set(largeWidths).size, largeWidths.join(', ')).toBe(1);
    if (process.env['E2E_REPORT']) console.log(`large display width per turn (px): ${largeWidths.join(', ')}`);
  });

  it('9. the Visual Trace shows initialize at 2025-11-25, tools/list and diagnose_answer with structuredContent', async () => {
    await hook('setTab', 'trace');
    const init = page.locator('.tr[data-lane="mcp"][data-method="initialize"]');
    await expect.poll(() => init.count()).toBe(2);
    expect(await init.locator('.tr-badge[data-protocol="2025-11-25"]').count()).toBe(2);
    expect(await page.locator('.tr[data-lane="mcp"][data-method="tools/list"]').count()).toBe(2);
    const answer = page.locator('.tr[data-lane="mcp"][data-tool="diagnose_answer"]');
    expect(await answer.count()).toBe(2);
    expect(await answer.locator('.tr-badge.sc').count()).toBe(1);
    expect(await page.locator('.tr[data-lane="bridge"][data-method="ui/initialize"]').count()).toBeGreaterThan(0);
    await answer.last().locator('.tr-head').click();
    expect(await answer.last().locator('.json').textContent()).toContain('"structuredContent"');
    await shot('09-trace');
    await hook('setTab', 'latency');
    const rows = page.locator('.lat-row[data-method]');
    expect(await rows.count()).toBeGreaterThanOrEqual(4);
    expect(await page.locator('.lat-row[data-method="initialize"] [data-p="50"]').textContent()).toMatch(/ms$/);
    expect(await page.locator('.lat-row[data-method="tools/call diagnose"] [data-p="95"]').textContent()).toMatch(/ms$/);
    await shot('10-latency');
    if (process.env['E2E_REPORT']) {
      const table = await page.locator('.lat-row[data-method]').evaluateAll((els) =>
        els.map((el) => [el.getAttribute('data-method'), ...[...el.querySelectorAll('.num')].map((n) => n.textContent)].join(' | ')),
      );
      console.log(`latency (method | n | p50 | p95)\n${table.join('\n')}`);
    }
  });

  it('10. light theme and About', async () => {
    await page.locator('.about-link').click();
    await expect.poll(() => page.locator('[data-panel="about"]').isVisible()).toBe(true);
    expect(await page.locator('.about-link').getAttribute('aria-pressed')).toBe('true');
    await page.locator('[data-theme-choice="light"]').click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset['theme'])).toBe('light');
    await shot('11-light-about');
    await hook('setTheme', 'dark');
  });

  it('11. resetting the house clears the screen and the conversation state', async () => {
    await hook('setTab', 'house');
    await page.getByRole('button', { name: 'Reset the house' }).click();
    await expect.poll(async () => (await snap()).viewTool).toBeNull();
    const s = await hook<HookSnapshot>('idle');
    expect(s.conversation.last.repair_id).toBeNull();
    expect(s.pushes).toEqual([]);
    await expect.poll(() => page.locator('[data-active-fault]').count()).toBe(5);
    await expect.poll(() => page.locator('#view-slot iframe').count()).toBe(0);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toContain('\u2014');
  });

  it('routes through POST /assistant/route when ?router=server', async () => {
    const other = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p2 = await other.newPage();
    p2.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`[router=server] ${m.text()}`);
    });
    await p2.goto(stack.pageUrl({ test: '1', router: 'server', device: 'small' }));
    const s = await p2.evaluate(async () => {
      const h = (window as unknown as { __fixwright: { ready(): Promise<void>; say(t: string): Promise<HookSnapshot> } }).__fixwright;
      await h.ready();
      return h.say('Give my house a checkup');
    });
    expect(s.device).toBe('small');
    expect(s.transcript.at(-1)).toMatchObject({ tool: 'home_checkup', status: 'ok' });
    expect(stack.mock.requests.some((r) => r.method === 'POST' && r.path === '/assistant/route')).toBe(true);
    await other.close();
  });

  it('a view message approved on the sheet applies the plan exactly once, and idle() waits for it', async () => {
    const other = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const p2 = await other.newPage();
    p2.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('"id":9004')) consoleErrors.push(`[message approve] ${m.text()}`);
    });
    p2.on('pageerror', (e) => pageErrors.push(String(e)));
    await p2.goto(stack.pageUrl({ test: '1' }));
    const run = (fn: string, ...args: unknown[]): Promise<HookSnapshot> =>
      p2.evaluate(
        async ([name, a]) => {
          const h = (window as unknown as { __fixwright: Record<string, (...x: unknown[]) => unknown> }).__fixwright;
          return (await h[name as string]?.(...(a as unknown[]))) as HookSnapshot;
        },
        [fn, args] as const,
      );
    await run('ready');
    await run('say', 'Why is the hallway lamp not responding?');
    await run('say', 'Yes, it blinked');
    const planned = await run('say', 'Yes');
    expect(planned.conversation.pendingPlan).not.toBeNull();
    await viewSays('yes', 9004, p2);
    await p2.waitForFunction(() => (window as unknown as { __fixwright: { snapshot(): HookSnapshot } }).__fixwright.snapshot().approval !== null);
    const s = await run('approve', true);
    expect(s.approval).toBeNull();
    expect(s.transcript.at(-1)).toMatchObject({ tool: 'repair_apply', status: 'ok' });
    expect(s.conversation.pendingPlan).toBeNull();
    expect(s.viewUri).toBe('ui://fixwright/repair-card.html');
    const applies = (await p2.evaluate(() => (window as unknown as { __fixwright: { trace(): TraceRow[] } }).__fixwright.trace())).filter(
      (e) => e.lane === 'mcp' && e.dir === 'out' && e.tool === 'repair_apply',
    );
    expect(applies.length).toBe(1);
    await other.close();
  });

  it('a tap on the view is the person\'s turn, comes back after voice only, and a spoken yes answers the sheet once', async () => {
    const other = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const p2 = await other.newPage();
    p2.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`[tap and voice] ${m.text()}`);
    });
    p2.on('pageerror', (e) => pageErrors.push(String(e)));
    await p2.goto(stack.pageUrl({ test: '1' }));
    const run = (fn: string, ...args: unknown[]): Promise<HookSnapshot> =>
      p2.evaluate(
        async ([name, a]) => {
          const h = (window as unknown as { __fixwright: Record<string, (...x: unknown[]) => unknown> }).__fixwright;
          return (await h[name as string]?.(...(a as unknown[]))) as HookSnapshot;
        },
        [fn, args] as const,
      );
    const v2 = (): FrameLocator => p2.frameLocator('#view-slot iframe.active:not(.leaving)').frameLocator('iframe');
    const applies = async (): Promise<number> =>
      (await p2.evaluate(() => (window as unknown as { __fixwright: { trace(): TraceRow[] } }).__fixwright.trace())).filter(
        (e) => e.lane === 'mcp' && e.dir === 'out' && e.tool === 'repair_apply',
      ).length;
    await run('ready');
    await run('setClock', PINNED_CLOCK);
    await run('say', 'Why is the hallway lamp not responding?');

    // Tap Yes on the stepper: the person's turn, shown in the captions, then the verdict.
    await v2().getByRole('button', { name: /^yes$/i }).click();
    // The tap reaches the host by postMessage through two frames; once its turn is in, idle() covers the call.
    await p2.waitForFunction(() =>
      (window as unknown as { __fixwright: { snapshot(): HookSnapshot } }).__fixwright.snapshot().transcript.some((e) => e.via === 'tap'),
    );
    const answered = await run('idle');
    expect(answered.transcript.at(-2)).toMatchObject({ role: 'user', text: 'Yes.', via: 'tap' });
    expect(answered.transcript.at(-1)).toMatchObject({ role: 'assistant', tool: 'diagnose_answer', status: 'ok' });
    expect(await p2.locator('.cap-user').getAttribute('data-via')).toBe('tap');

    // Voice only and back: the verdict returns, not the question that was already answered.
    await run('setDevice', 'voice');
    const back = await run('setDevice', 'large');
    expect(back.viewTool).toBe('diagnose_answer');
    await expectOneActiveFrame(p2);
    await expect.poll(() => v2().getByText('Confirmed').first().isVisible()).toBe(true);
    expect(await v2().getByRole('button', { name: /^yes$/i }).count()).toBe(0);
    expect(await v2().getByRole('button', { name: /^no$/i }).count()).toBe(0);

    // Plan by voice, tap Fix it, then answer the sheet out loud: exactly one repair_apply.
    const planned = await run('say', 'Yes');
    expect(planned.conversation.pendingPlan).not.toBeNull();
    await v2().getByRole('button', { name: /fix it/i }).click();
    await p2.waitForFunction(() => (window as unknown as { __fixwright: { snapshot(): HookSnapshot } }).__fixwright.snapshot().approval !== null);
    // The sheet stays through a switch between screens, and its far field type fits each of them.
    for (const device of ['small', 'phone', 'large'] as const) {
      const s = await run('setDevice', device);
      expect(s.approval?.title, device).toBe('Apply this fix?');
      const fit = await p2.locator('.approval-card').evaluate((card) => {
        const screen = card.closest('.screen') as HTMLElement;
        const c = card.getBoundingClientRect();
        const r = screen.getBoundingClientRect();
        return c.top >= r.top - 1 && c.bottom <= r.bottom + 1 && c.left >= r.left - 1 && c.right <= r.right + 1 && card.scrollHeight <= card.clientHeight + 1;
      });
      expect(fit, device).toBe(true);
      if (device !== 'large') {
        // The footer used to be cramped on the small display and phone, so check it has room: the
        // small print clears the buttons, the two answers share the row as equal halves of at least
        // 44 px, and the row clears the card's bottom edge (on the phone, its rounded corner).
        const footer = await p2.locator('.approval-card').evaluate((card) => {
          const scale = card.getBoundingClientRect().width / (card as HTMLElement).offsetWidth;
          const box = (el: Element | null): DOMRect => (el as Element).getBoundingClientRect();
          const c = box(card);
          const note = box(card.querySelector('.approval-note'));
          const row = box(card.querySelector('.approval-actions'));
          const [no, yes] = [...card.querySelectorAll('.approval-actions .btn')].map((b) => b.getBoundingClientRect());
          const px = (v: number): number => Math.round(v / scale);
          return {
            noteToRow: px(row.top - note.bottom),
            rowToEdge: px(c.bottom - row.bottom),
            widths: [px(no?.width ?? 0), px(yes?.width ?? 0)],
            rowShare: (no?.width ?? 0) / row.width,
            minHeight: px(Math.min(no?.height ?? 0, yes?.height ?? 0)),
          };
        });
        expect(footer.noteToRow, device).toBeGreaterThanOrEqual(16);
        expect(footer.rowToEdge, device).toBeGreaterThanOrEqual(device === 'phone' ? 32 : 18);
        expect(Math.abs((footer.widths[0] ?? 0) - (footer.widths[1] ?? 0)), device).toBeLessThanOrEqual(1);
        expect(footer.rowShare, device).toBeGreaterThan(0.45);
        expect(footer.minHeight, device).toBeGreaterThanOrEqual(44);
      }
      if (device !== 'large') await p2.screenshot({ path: join(SHOTS, `${device === 'small' ? '15-small' : '16-phone'}-approval.png`) });
    }
    const done = await run('say', 'yes');
    expect(done.approval).toBeNull();
    expect(await p2.getByRole('alertdialog').isVisible()).toBe(false);
    expect(done.transcript.at(-2)).toMatchObject({ role: 'user', text: 'yes', intent: 'approve' });
    expect(done.transcript.at(-1)).toMatchObject({ tool: 'repair_apply', status: 'ok' });
    expect(done.conversation.pendingPlan).toBeNull();
    expect(await applies()).toBe(1);
    // Nothing is left to approve, so a late tap on the (gone) sheet cannot send a second apply.
    await run('approve', true);
    expect(await applies()).toBe(1);

    // Voice only and back again: the repair card from the view's own call, with Undo.
    await run('setDevice', 'voice');
    const again = await run('setDevice', 'large');
    expect(again.viewUri).toBe('ui://fixwright/repair-card.html');
    await expect.poll(() => v2().getByRole('button', { name: /undo/i }).isVisible()).toBe(true);
    expect(await v2().getByRole('button', { name: /fix it/i }).count()).toBe(0);

    // The morning push on a speaker with no screen shows under it; back on the display, the repair
    // card comes back already due and refreshes itself to the confirmed result.
    await run('setDevice', 'voice');
    await run('setTab', 'house');
    await p2.locator('[data-clock="next_morning"]').click();
    await expect.poll(() => p2.locator('.voice-toast').isVisible()).toBe(true);
    expect(await p2.locator('.voice-toast').textContent()).toContain('Hallway lamp answered all 9 commands overnight.');
    expect(await p2.locator('.screen .push-toast').isVisible()).toBe(false);
    expect(await p2.locator('.captions .push-toast').isVisible()).toBe(false);
    await p2.screenshot({ path: join(SHOTS, '14-voice-push.png') });
    await run('setDevice', 'large');
    await expect.poll(() => v2().getByText('Repair confirmed').first().isVisible()).toBe(true);
    await expect.poll(() => p2.locator('.captions .push-toast').isVisible()).toBe(true);
    await other.close();
  });

  it('keeps the honesty banner whole and the page inside the window on small screens', async () => {
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 430, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const other = await browser.newContext({ viewport });
      const p2 = await other.newPage();
      p2.on('pageerror', (e) => pageErrors.push(String(e)));
      await p2.goto(stack.pageUrl({ test: '1' }));
      await p2.evaluate(() => (window as unknown as { __fixwright: { ready(): Promise<void> } }).__fixwright.ready());
      const m = await p2.evaluate(() => {
        const banner = document.getElementById('honesty-banner') as HTMLElement;
        const url = banner.querySelector('.banner-url') as HTMLElement;
        const de = document.documentElement;
        const tabs = document.querySelector('.tabs') as HTMLElement;
        const chips = Array.from(document.querySelectorAll<HTMLElement>('.chips .chip'));
        const page = de.clientWidth;
        return {
          visible: banner.getBoundingClientRect().height > 0,
          text: banner.textContent,
          urlClipped: url.scrollWidth > url.clientWidth + 1,
          bannerClipped: banner.scrollWidth > banner.clientWidth + 1,
          scroll: de.scrollWidth,
          client: de.clientWidth,
          tabsFit: tabs.scrollWidth <= tabs.clientWidth + 1,
          chipsCut: chips.filter((c) => c.getBoundingClientRect().right > page + 1 || c.getBoundingClientRect().left < -1).map((c) => c.textContent),
          placeholder: (document.getElementById('utterance') as HTMLInputElement).placeholder,
          tabNames: Array.from(document.querySelectorAll('.tabs [role="tab"]')).map((t) => (t.querySelector('.tab-long')?.textContent ?? '').trim()),
        };
      });
      // The console's four tabs are in view at every width (short labels on a phone, long ones kept as names;
      // About is in the top bar), every suggestion chip is on screen, and the placeholder fits the box.
      expect(m.tabsFit, `${viewport.width}`).toBe(true);
      expect(m.tabNames).toEqual(['Conversation', 'Visual Trace', 'Latency', 'Break my house']);
      expect(m.chipsCut, `${viewport.width}`).toEqual([]);
      expect(m.placeholder).toBe(viewport.width <= 700 ? 'Type what you would say' : 'Type what you would say, for example “Give my house a checkup”');
      expect(m.visible, `${viewport.width}`).toBe(true);
      expect(m.text).toContain(`${stack.serverUrl}/mcp (MCP 2025-11-25, Streamable HTTP).`);
      expect(m.urlClipped || m.bannerClipped, `${viewport.width}`).toBe(false);
      expect(m.scroll, `${viewport.width}x${viewport.height}`).toBe(m.client);
      if (viewport.width === 1280) await p2.screenshot({ path: join(SHOTS, '12-laptop-1280x720.png') });
      if (viewport.width === 390) await p2.screenshot({ path: join(SHOTS, '13-narrow-390.png') });
      await other.close();
    }
  });

  it('ran with zero console errors, page errors and failed requests', () => {
    // Some steps forge request ids from inside a view; the view's SDK rightly reports the reply to a
    // request it never sent. Those lines are the test's own doing, everything else must be silent.
    const errors = consoleErrors.filter((e) => !FORGED_IDS.some((id) => e.includes(`"id":${id}`)));
    expect(errors, errors.join('\n')).toEqual([]);
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
    expect(failedRequests, failedRequests.join('\n')).toEqual([]);
  });
});
