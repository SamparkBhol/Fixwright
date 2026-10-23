// Every state, dark and light, at 1280x800, 960x480, 390x844, in apps/host's growing phone frame and in
// fullscreen. Outcome states are reached by pressing through the real bridge, so the line the last action
// left is on screen when the layout is measured.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Frame } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Policy, Scenario } from '../harness/host.ts';
import { startHarness, type Harness } from '../harness/serve.ts';
import { fixture } from '../unit/load.ts';
import { audit, launch, load, openSession, reach, settle, SIZES, waitPainted, type Audit, type Reach, type Session, type Size } from './helpers.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(ROOT, 'screenshots');

/** One press through the bridge: the host answers under `policy`, and the press is done once `until` shows. */
interface Press {
  action: string;
  policy?: Partial<Policy>;
  until: string;
}

interface Case {
  id: string;
  scenario: Omit<Scenario, 'theme' | 'device'>;
  presses?: Press[];
}

const FIVE = fixture<{ findings: { issue_id: string }[] }>('views/home_checkup_five').findings;
/** The five finding checkup's power on card: the longest title, so the tallest plan header in the carousel. */
const POWER_ON = FIVE[4]?.issue_id as string;
const DECLINE: Partial<Policy> = { approve: false, decline: 'convention' };
const PLAN_OPEN = '[data-action="apply"]';

export const CASES: Case[] = [
  { id: 'stepper-question', scenario: { view: 'stepper', fixture: 'protocol/diagnose', tool: 'diagnose', args: { symptom: "the hallway lamp keeps saying it's not responding", device: 'hallway lamp' } } },
  { id: 'stepper-confirmed', scenario: { view: 'stepper', fixture: 'protocol/diagnose_answer', tool: 'diagnose_answer' } },
  { id: 'stepper-likely', scenario: { view: 'stepper', fixture: 'views/diagnose_likely', tool: 'diagnose' } },
  { id: 'stepper-cant-tell', scenario: { view: 'stepper', fixture: 'views/diagnose_cant_tell', tool: 'diagnose' } },
  { id: 'stepper-explain', scenario: { view: 'stepper', fixture: 'protocol/explain_event', tool: 'explain_event', args: { question: 'Why did every plug turn on at 3 a.m.?' } } },
  { id: 'stepper-plan', scenario: { view: 'stepper', fixture: 'protocol/repair_plan', tool: 'repair_plan' } },
  { id: 'stepper-plan-long', scenario: { view: 'stepper', fixture: 'views/repair_plan_power_on', tool: 'repair_plan' } },
  { id: 'stepper-plan-protected', scenario: { view: 'stepper', fixture: 'views/repair_plan_protected', tool: 'repair_plan' } },
  { id: 'stepper-problem', scenario: { view: 'stepper', fixture: 'protocol/problem', tool: 'diagnose' } },
  { id: 'carousel-three', scenario: { view: 'carousel', fixture: 'protocol/home_checkup', tool: 'home_checkup' } },
  { id: 'carousel-five', scenario: { view: 'carousel', fixture: 'views/home_checkup_five', tool: 'home_checkup' } },
  { id: 'repair-applied', scenario: { view: 'repair-card', fixture: 'protocol/repair_apply', tool: 'repair_apply', now: '2026-10-15T17:21:00.000Z' } },
  { id: 'repair-applied-long', scenario: { view: 'repair-card', fixture: 'views/repair_apply_power_on', tool: 'repair_apply', now: '2026-10-15T17:31:00.000Z' } },
  { id: 'repair-confirmed', scenario: { view: 'repair-card', fixture: 'protocol/repair_status', tool: 'repair_status', now: '2026-10-16T14:05:00.000Z' } },
  { id: 'repair-regressed', scenario: { view: 'repair-card', fixture: 'views/repair_regressed', tool: 'repair_status', now: '2026-10-16T14:05:00.000Z' } },
  { id: 'repair-retried', scenario: { view: 'repair-card', fixture: 'views/repair_apply_retried', tool: 'repair_apply', now: '2026-10-15T17:22:00.000Z' } },
  { id: 'repair-rolled-back', scenario: { view: 'repair-card', fixture: 'views/repair_rolled_back', tool: 'repair_apply' } },
  { id: 'repair-undone', scenario: { view: 'repair-card', fixture: 'protocol/undo', tool: 'undo' } },
  // Outcome states: the line the last action left sits inside the decision card (landscape) or the action
  // bar (portrait), and the screen still fits.
  {
    id: 'stepper-question-failed',
    scenario: { view: 'stepper', fixture: 'protocol/diagnose', tool: 'diagnose' },
    presses: [{ action: 'answer-yes', policy: { failNext: 'throw' }, until: '.error' }],
  },
  {
    id: 'stepper-confirmed-failed',
    scenario: { view: 'stepper', fixture: 'protocol/diagnose_answer', tool: 'diagnose_answer' },
    presses: [{ action: 'plan', policy: { failNext: 'problem' }, until: '.error' }],
  },
  {
    id: 'stepper-confirmed-error',
    scenario: { view: 'stepper', fixture: 'protocol/diagnose_answer', tool: 'diagnose_answer' },
    presses: [{ action: 'plan', policy: { failNext: 'throw' }, until: '.error' }],
  },
  {
    id: 'stepper-likely-failed',
    scenario: { view: 'stepper', fixture: 'views/diagnose_likely', tool: 'diagnose' },
    presses: [{ action: 'plan', policy: { failNext: 'throw' }, until: '.error' }],
  },
  {
    id: 'stepper-plan-declined',
    scenario: { view: 'stepper', fixture: 'protocol/diagnose_answer', tool: 'diagnose_answer' },
    presses: [
      { action: 'plan', until: PLAN_OPEN },
      { action: 'apply', policy: DECLINE, until: '.notice' },
    ],
  },
  {
    id: 'carousel-plan-declined',
    scenario: { view: 'carousel', fixture: 'views/home_checkup_five', tool: 'home_checkup' },
    presses: [
      { action: `plan-${POWER_ON}`, until: PLAN_OPEN },
      { action: 'apply', policy: DECLINE, until: '.notice' },
    ],
  },
  {
    id: 'carousel-plan-denied',
    scenario: { view: 'carousel', fixture: 'views/home_checkup_five', tool: 'home_checkup' },
    presses: [
      { action: `plan-${POWER_ON}`, until: PLAN_OPEN },
      { action: 'apply', policy: { approve: false, decline: 'plain' }, until: '.error' },
    ],
  },
];

const RESTING_POLICY: Policy = { approve: true, decline: 'convention', latencyMs: 0, failNext: null };

async function pressThrough(session: Session, frame: Frame, presses: Press[]): Promise<void> {
  for (const p of presses) {
    await session.page.evaluate((pol) => window.__harness.setPolicy(pol), { ...RESTING_POLICY, ...p.policy });
    await frame.locator(`[data-action="${p.action}"]`).click();
    await frame.waitForSelector(p.until, { timeout: 5000 });
  }
  await session.page.evaluate((pol) => window.__harness.setPolicy(pol), RESTING_POLICY);
  await session.page.mouse.move(0, 0);
}

const byId = (id: string): Case => {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};

const FULLSCREEN: Case[] = ['stepper-confirmed', 'stepper-plan', 'stepper-plan-long', 'carousel-five', 'repair-confirmed'].map((id) => ({
  id,
  scenario: { ...byId(id).scenario, mode: 'fullscreen' },
}));

const THEMES = ['dark', 'light'] as const;
const DEVICES: Size[] = ['large', 'small', 'phone'];

let harness: Harness;
let browser: Browser;
const sessions = new Map<Size, Session>();
const report: Record<string, Audit & { paintMs: number; reach?: Reach }> = {};
/** apps/host's Phone: a 358 px wide frame that grows with the view up to 480 px (harness container 'flex'). */
let flexPhone: Session;

beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
  harness = await startHarness();
  browser = await launch();
  for (const d of DEVICES) sessions.set(d, await openSession(browser, harness.hostUrl, d));
  flexPhone = await openSession(browser, harness.hostUrl, 'phone');
});

afterAll(async () => {
  for (const s of sessions.values()) await s.close();
  await flexPhone?.close();
  await browser?.close();
  await harness?.close();
  await writeFile(path.join(ROOT, 'test', 'visual', 'last-render-report.json'), `${JSON.stringify(report, null, 2)}\n`);
});

async function check(c: Case, theme: (typeof THEMES)[number], device: Size, suffix = ''): Promise<void> {
  const flex = suffix === '-flex';
  const session = flex ? flexPhone : (sessions.get(device) as Session);
  session.errors.length = 0;
  session.viewRequests.length = 0;
  await session.page.evaluate((pol) => window.__harness.setPolicy(pol), RESTING_POLICY);
  const frame = await load(session.page, { ...c.scenario, theme, device, ...(flex ? { container: 'flex' as const } : {}) });
  const paintedAt = await waitPainted(frame);
  const sentAt = await session.page.evaluate(() => window.__harness.resultSentAt());
  if (c.presses) await pressThrough(session, frame, c.presses);
  if (flex) {
    // The host sizes the frame from the view's size reports (capped at 480); wait until the frame matches.
    await expect
      .poll(
        async () => {
          const last = (await session.page.evaluate(() => window.__harness.sizes())).at(-1)?.height;
          const inner = await frame.evaluate(() => window.innerHeight);
          return last !== undefined && inner === Math.min(last, 480);
        },
        { timeout: 5000 },
      )
      .toBe(true);
  }
  await settle(frame);
  const a = await audit(frame);
  const name = `${c.id}${suffix}-${theme}-${device}`;
  const r = flex ? await reach(frame) : undefined;
  report[name] = { ...a, paintMs: Math.round((paintedAt - sentAt) * 10) / 10, ...(r ? { reach: r } : {}) };
  if (flex) await session.page.locator('#stage').screenshot({ path: path.join(SHOTS, `${name}.png`) });
  else await session.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  if (r) {
    expect(r.frameHeight, 'frame height under the host cap (px)').toBeLessThanOrEqual(480);
    expect(r.cardHeight, 'card height under the host cap (px)').toBeLessThanOrEqual(480);
    expect(r.unreachable, 'controls a finger cannot reach').toEqual([]);
    expect(r.pageOverflow, 'page taller than the frame (px): a swipe past the card would drag it').toBeLessThanOrEqual(0);
    if (r.pinnedVisible !== null) expect(r.pinnedVisible, 'actions in view without scrolling').toBe(true);
    // A section heading in view must bring some of its content with it (never a "Steps" heading over nothing).
    const orphans = await frame.evaluate(() => {
      const card = document.querySelector('.card');
      if (!card) return [];
      const top = card.getBoundingClientRect().top;
      const bar = document.querySelector('.panel > .action-bar:last-child');
      const bottom = bar ? bar.getBoundingClientRect().top : card.getBoundingClientRect().bottom;
      const out: string[] = [];
      for (const head of Array.from(document.querySelectorAll('.main-col > .block > .block-h'))) {
        const r = head.getBoundingClientRect();
        const body = head.nextElementSibling;
        if (!body || r.top >= bottom || r.bottom <= top) continue;
        const first = (body.querySelector(':scope > :not(.is-folded)') ?? body).getBoundingClientRect();
        if (first.bottom > bottom + 1) out.push(`${head.textContent ?? ''} [scrollTop ${card.scrollTop}, kept ${(document.querySelector('.panel') as HTMLElement | null)?.dataset.kept}, head ${Math.round(r.top)}, first ${Math.round(first.bottom)}, bottom ${Math.round(bottom)}]`);
      }
      return out;
    });
    expect(orphans, 'section headings in view with none of their content').toEqual([]);
  }

  expect(session.errors, 'console errors').toEqual([]);
  expect(session.viewRequests, 'network requests from the view').toEqual([]);
  expect(a.overflowX, 'horizontal overflow (px)').toBeLessThanOrEqual(0);
  expect(a.offscreen, 'elements outside the viewport').toEqual([]);
  expect(a.smallTargets, 'touch targets under 48 px').toEqual([]);
  expect(a.unnamedControls, 'controls without an accessible name').toEqual([]);
  expect(a.lowContrast, 'text under 4.5:1').toEqual([]);
  expect(a.textChecked, 'text elements checked').toBeGreaterThan(3);
  expect(a.clippedText, 'text cut without an ellipsis').toEqual([]);
  if (device !== 'phone' && c.scenario.mode !== 'fullscreen') {
    expect(a.contentOverflowY, 'inline content taller than the canvas (px)').toBeLessThanOrEqual(0);
    expect(a.bottomBleed, 'inline content reaching into the bottom padding (px)').toBeLessThanOrEqual(1);
    expect(a.decisionSpill, 'content hanging below the decision card (px)').toBeLessThanOrEqual(1);
    expect(a.cardScrollTop, 'the fixed card scrolled (px)').toBe(0);
  }
  expect(paintedAt - sentAt, 'tool-result to painted (ms)').toBeLessThan(500);
  expect(a.zoom).toBeCloseTo(device === 'large' ? SIZES.large.width / 768 : 1, 2);
}

describe.each(DEVICES)('%s', (device) => {
  describe.each(THEMES)('%s', (theme) => {
    test.each(CASES)('$id', async (c) => check(c, theme, device));
  });
});

// Every case taller than the frame must scroll inside it; the golden path ones are, by a wide margin.
describe('phone in a growing frame capped at 480 px (apps/host)', () => {
  describe.each(THEMES)('%s', (theme) => {
    test.each(CASES)('$id', async (c) => check(c, theme, 'phone', '-flex'));
  });
});

describe('fullscreen (large)', () => {
  describe.each(THEMES)('%s', (theme) => {
    test.each(FULLSCREEN)('$id', async (c) => check(c, theme, 'large', '-fullscreen'));
  });
});
