import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Frame } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Policy, Scenario } from '../harness/host.ts';
import { startHarness, type Harness } from '../harness/serve.ts';
import { ASKED } from '../../src/ui/carousel.ts';
import { DECLINED_NOTE, FALLBACK_PROBLEM } from '../../src/ui/payload.ts';
import type {} from '../../src/ui/runtime.ts'; // window.__fixwrightView
import { audit, launch, load, openSession, settle, waitPainted, type Session } from './helpers.ts';
import { fixture } from '../unit/load.ts';

const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'screenshots');

let harness: Harness;
let browser: Browser;
let s: Session;

beforeAll(async () => {
  harness = await startHarness();
  browser = await launch();
  s = await openSession(browser, harness.hostUrl, 'large');
});

/** Decision fit steps each outcome needed, per landscape size (test/visual/last-outcome-report.json). */
const outcomeReport: Record<string, Record<string, number>> = {};

afterAll(async () => {
  await s?.close();
  await browser?.close();
  await harness?.close();
  if (Object.keys(outcomeReport).length) await writeFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'last-outcome-report.json'), `${JSON.stringify(outcomeReport, null, 2)}\n`);
});

beforeEach(async () => {
  s.errors.length = 0;
  s.warnings.length = 0;
  s.viewRequests.length = 0;
  await s.page.evaluate(() => window.__harness.setPolicy({ approve: true, decline: 'convention', latencyMs: 0, failNext: null }));
});

const calls = () => s.page.evaluate(() => window.__harness.calls());
const chipText = (f: Frame) => f.locator('.chip-hero .chip-label').innerText();
const button = (f: Frame, action: string) => f.locator(`[data-action="${action}"]`);
const latency = (ms: number) => s.page.evaluate((v) => window.__harness.setPolicy({ latencyMs: v }), ms);
const shot = (name: string) => s.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const decline = (how: 'convention' | 'words' | 'plain') => s.page.evaluate((d) => window.__harness.setPolicy({ approve: false, decline: d }), how);
const approve = () => s.page.evaluate(() => window.__harness.setPolicy({ approve: true }));
const noticeText = (f: Frame) => f.locator('.notice').innerText();

describe('stepper golden path', () => {
  test('Yes, confirmed, dry run, Not now, Fix it, Undo', async () => {
    // The fixtures' own afternoon, so the applied card's next check reads "Tomorrow at 7:00 AM", never a past day.
    const f = await load(s.page, { view: 'stepper', fixture: 'protocol/diagnose', tool: 'diagnose', now: '2026-10-15T17:20:30.000Z' });
    await waitPainted(f);
    expect(await chipText(f)).toBe('Needs you');

    await latency(600);
    await button(f, 'answer-yes').click();
    await expect.poll(() => button(f, 'answer-yes').getAttribute('aria-busy')).toBe('true');
    expect(await button(f, 'answer-yes').innerText()).toBe('Checking');
    expect(await button(f, 'answer-no').getAttribute('aria-disabled')).toBe('true');
    await shot('flow-stepper-pending-dark-large');
    await expect.poll(() => chipText(f), { timeout: 5000 }).toBe('Confirmed');
    expect(await f.locator('.bar.is-lead .bar-pct').innerText()).toBe('94%');
    const dx = fixture<{ diagnosis_id: string; question: { question_id: string } }>('protocol/diagnose');
    expect((await calls()).map((c) => [c.name, c.arguments])).toEqual([['diagnose_answer', { diagnosis_id: dx.diagnosis_id, question_id: dx.question.question_id, answer: 'yes' }]]);
    expect(await f.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.action)).toBe('plan');
    expect((await s.page.evaluate(() => window.__harness.modelContext())).length).toBe(1);
    await latency(0);

    await button(f, 'plan').click();
    await expect.poll(() => chipText(f)).toBe('Nothing changed yet');
    expect(await f.locator('.title').innerText()).toBe('Hallway Lamp');
    await button(f, 'cancel').click();
    await expect.poll(() => chipText(f)).toBe('Confirmed');
    await button(f, 'plan').click();
    await expect.poll(() => chipText(f)).toBe('Nothing changed yet');

    await button(f, 'apply').click();
    await expect.poll(() => chipText(f)).toBe('Fixed');
    expect(await f.locator('.step.status-done').count()).toBe(3);
    expect(await f.locator('.step-rb').allInnerTexts()).toEqual(['Name reads Hallway Lamp', 'Old copy is gone from the device list', 'It answered both times']);
    await settle(f);
    await shot('flow-stepper-applied-dark-large');

    await button(f, 'undo').click();
    await expect.poll(() => chipText(f)).toBe('Undone');
    expect(await button(f, 'undo').count()).toBe(0);

    const plan = fixture<{ plan_id: string; confirm_token: string; ids: { diagnosis_id: string } }>('protocol/repair_plan');
    const apply = fixture<{ repair_id: string }>('protocol/repair_apply');
    expect((await calls()).map((c) => [c.name, c.arguments, c.approved])).toEqual([
      ['diagnose_answer', { diagnosis_id: dx.diagnosis_id, question_id: dx.question.question_id, answer: 'yes' }, null],
      ['repair_plan', { diagnosis_id: plan.ids.diagnosis_id }, null],
      ['repair_plan', { diagnosis_id: plan.ids.diagnosis_id }, null],
      ['repair_apply', { plan_id: plan.plan_id, confirm_token: plan.confirm_token }, true],
      ['undo', { repair_id: apply.repair_id }, true],
    ]);
    expect(s.errors).toEqual([]);
    expect(s.viewRequests).toEqual([]);
  });

  test('No asks the next question', async () => {
    const f = await load(s.page, { view: 'stepper', fixture: 'protocol/diagnose', tool: 'diagnose' });
    await waitPainted(f);
    await button(f, 'answer-no').click();
    await expect.poll(() => f.locator('.decision-text').innerText()).toBe("Is the lamp's wall switch on?");
    expect(await f.locator('.bar.is-lead .bar-label').innerText()).toBe('Device has no power');
  });

  test("declining Fix it the way apps/host does: the plan stays with Not now and the device's name, a calm note, no error", async () => {
    // apps/host resends the view's latest result, then denies with "Not approved. Nothing changed."
    const f = await load(s.page, { view: 'stepper', fixture: 'protocol/diagnose', tool: 'diagnose' });
    await waitPainted(f);
    await button(f, 'answer-yes').click();
    await expect.poll(() => chipText(f)).toBe('Confirmed');
    await button(f, 'plan').click();
    await expect.poll(() => chipText(f)).toBe('Nothing changed yet');
    await decline('convention');
    await latency(300);
    await button(f, 'apply').click();
    await expect.poll(() => button(f, 'apply').getAttribute('aria-busy')).toBe('true');
    await expect.poll(() => noticeText(f), { timeout: 5000 }).toBe(DECLINED_NOTE);
    await latency(0);
    expect(await f.locator('[role="alert"]').count()).toBe(0);
    expect(await f.locator('.notice').getAttribute('role')).toBe('status');
    expect(await f.locator('.title').innerText()).toBe('Hallway Lamp');
    expect(await button(f, 'cancel').innerText()).toBe('Not now');
    expect(await chipText(f)).toBe('Nothing changed yet');
    expect(await button(f, 'apply').getAttribute('aria-disabled')).toBeNull();
    await settle(f);
    await shot('flow-stepper-declined-dark-large');
    await button(f, 'cancel').click();
    await expect.poll(() => chipText(f)).toBe('Confirmed');
    await button(f, 'plan').click();
    await expect.poll(() => chipText(f)).toBe('Nothing changed yet');
    expect(await f.locator('.notice').count()).toBe(0);
    await approve();
    await button(f, 'apply').click();
    await expect.poll(() => chipText(f)).toBe('Fixed');
    expect((await calls()).filter((c) => c.name === 'repair_apply').map((c) => c.approved)).toEqual([false, true]);
    expect(s.errors).toEqual([]);
  });

  test('a host that denies with the same words but sends nothing first: the same calm note', async () => {
    const f = await load(s.page, { view: 'stepper', fixture: 'protocol/repair_plan', tool: 'repair_plan' });
    await waitPainted(f);
    await decline('words');
    await button(f, 'apply').click();
    await expect.poll(() => noticeText(f)).toBe(DECLINED_NOTE);
    expect(await f.locator('[role="alert"]').count()).toBe(0);
    expect(await chipText(f)).toBe('Nothing changed yet');
  });

  test('a host that denies in words of its own: "didn\'t go through", and the button works again', async () => {
    const f = await load(s.page, { view: 'stepper', fixture: 'protocol/repair_plan', tool: 'repair_plan' });
    await waitPainted(f);
    await decline('plain');
    await button(f, 'apply').click();
    await expect.poll(() => f.locator('[role="alert"]').innerText()).toBe(FALLBACK_PROBLEM);
    expect(await chipText(f)).toBe('Nothing changed yet');
    expect(await button(f, 'apply').getAttribute('aria-disabled')).toBeNull();
    await approve();
    await button(f, 'apply').click();
    await expect.poll(() => chipText(f)).toBe('3 of 3 read back');
    expect((await calls()).map((c) => c.approved)).toEqual([false, true]);
  });

  test('restoring focus never scrolls a fixed landscape card, even when its content cannot fit', async () => {
    const f = await load(s.page, { view: 'stepper', fixture: 'views/diagnose_likely', tool: 'diagnose' });
    await waitPainted(f);
    // Text far past what any fit step can absorb, so the card has content below its edge (the case
    // this guards: the likely verdict with a host error scrolled 44 px and cut its eyebrow and chip).
    await f.addStyleTag({ content: '.decision-text { font-size: 64px !important; line-height: 1.2 !important; }' });
    const card = () => f.evaluate(() => {
      const c = document.getElementById('app') as HTMLElement;
      return { overflow: c.scrollHeight - c.clientHeight, top: c.scrollTop };
    });
    await f.locator('[data-action="plan"]').focus();
    await f.evaluate(() => {
      (document.getElementById('app') as HTMLElement).scrollTop = 0;
    });
    await s.page.evaluate(() => window.__harness.setPolicy({ failNext: 'throw' }));
    await s.page.keyboard.press('Enter');
    await expect.poll(() => f.locator('[role="alert"]').count()).toBe(1);
    await settle(f);
    const after = await card();
    expect(after.overflow).toBeGreaterThan(0);
    expect(after.top).toBe(0);
    expect(await f.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.action)).toBe('plan');
  });

  test("a server problem is shown in the server's words", async () => {
    const f = await load(s.page, { view: 'stepper', fixture: 'protocol/diagnose', tool: 'diagnose' });
    await waitPainted(f);
    await s.page.evaluate(() => window.__harness.setPolicy({ failNext: 'problem' }));
    await button(f, 'answer-yes').click();
    await expect.poll(() => f.locator('[role="alert"]').innerText()).toBe("I couldn't reach your hub just now. Try again in a minute.");
    expect(await button(f, 'answer-yes').getAttribute('aria-disabled')).toBeNull();
    await button(f, 'answer-yes').click();
    await expect.poll(() => chipText(f)).toBe('Confirmed');
    expect(await f.locator('[role="alert"]').count()).toBe(0);
  });

  test('explain_event offers its fix by explanation id and applies all fourteen', async () => {
    const f = await load(s.page, { view: 'stepper', fixture: 'protocol/explain_event', tool: 'explain_event' });
    await waitPainted(f);
    await button(f, 'plan').click();
    await expect.poll(() => f.locator('.diff-line').first().innerText()).toBe('Fourteen devices will remember whether they were on or off when power comes back.');
    await button(f, 'apply').click();
    await expect.poll(() => f.locator('.step-rb').first().innerText()).toBe('Set to previous');
    const explanation = fixture<{ explanation_id: string }>('protocol/explain_event').explanation_id;
    expect((await calls()).map((c) => [c.name, c.arguments])).toEqual([
      ['repair_plan', { explanation_id: explanation }],
      ['repair_apply', { plan_id: fixture<{ plan_id: string }>('views/repair_plan_power_on').plan_id, confirm_token: fixture<{ confirm_token: string }>('views/repair_plan_power_on').confirm_token }],
    ]);
  });
});

describe('long step lists (the 14 device power on fix)', () => {
  const steps = (f: Frame) => f.locator('.steps > .step:not(.is-folded)').count();
  const more = (f: Frame) => f.locator('.steps-more');

  test('fold to what fits, open in place with the column scrolling, close again', async () => {
    const f = await load(s.page, { view: 'repair-card', fixture: 'views/repair_apply_power_on', tool: 'repair_apply', now: '2026-10-15T17:31:00.000Z' });
    await waitPainted(f);
    const shown = await steps(f);
    expect(shown).toBeGreaterThanOrEqual(2);
    expect(shown).toBeLessThan(14);
    expect(await more(f).innerText()).toBe(`${14 - shown} more steps, all read back`);
    expect(await more(f).getAttribute('aria-expanded')).toBe('false');
    expect(await f.evaluate(() => {
      const card = document.getElementById('app') as HTMLElement;
      return card.scrollHeight - card.clientHeight;
    })).toBeLessThanOrEqual(0);

    await more(f).click();
    await expect.poll(() => steps(f)).toBe(14);
    expect(await more(f).getAttribute('aria-expanded')).toBe('true');
    expect(await more(f).innerText()).toBe('Show fewer steps');
    const col = await f.evaluate(() => {
      const c = document.querySelector('.main-col') as HTMLElement;
      const card = document.getElementById('app') as HTMLElement;
      return { scrolling: c.classList.contains('is-scrolling'), overflow: c.scrollHeight - c.clientHeight, top: c.scrollTop, cardOverflow: card.scrollHeight - card.clientHeight };
    });
    expect(col.scrolling).toBe(true);
    expect(col.overflow).toBeGreaterThan(0);
    expect(col.top).toBeGreaterThan(0);
    expect(col.cardOverflow).toBeLessThanOrEqual(0);
    expect(await f.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.action)).toBe('steps-more');
    const revealed = await f.evaluate((n) => {
      const c = (document.querySelector('.main-col') as HTMLElement).getBoundingClientRect();
      const r = (document.querySelectorAll<HTMLElement>('.steps > .step')[n] as HTMLElement).getBoundingClientRect();
      return r.top >= c.top - 1 && r.bottom <= c.bottom + 1;
    }, shown);
    expect(revealed).toBe(true);
    await settle(f);
    await shot('flow-steps-open-dark-large');

    await s.page.evaluate(() => window.__harness.update({ theme: 'light' }));
    await expect.poll(() => f.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    expect(await steps(f)).toBe(14);
    await s.page.evaluate(() => window.__harness.update({ theme: 'dark' }));

    await s.page.keyboard.press('Enter');
    await expect.poll(() => steps(f)).toBe(shown);
    expect(await more(f).getAttribute('aria-expanded')).toBe('false');
    expect(await button(f, 'undo').isVisible()).toBe(true);
    expect(s.errors).toEqual([]);
  });

  test('a new result starts folded again, and a step that failed is never folded away', async () => {
    const f = await load(s.page, { view: 'repair-card', fixture: 'views/repair_apply_power_on', tool: 'repair_apply', now: '2026-10-15T17:31:00.000Z' });
    await waitPainted(f);
    await more(f).click();
    await expect.poll(() => steps(f)).toBe(14);
    await button(f, 'undo').click();
    await expect.poll(() => chipText(f)).toBe('2 of 2 reversed');
    expect(await more(f).count()).toBe(0);

    const failed = fixture<Record<string, unknown> & { steps: { step: number; status: string }[] }>('views/repair_apply_power_on');
    failed.steps = failed.steps.map((st) => (st.step === 12 ? { ...st, status: 'failed' } : st.step > 12 ? { ...st, status: 'rolled_back' } : st));
    const g = await load(s.page, { view: 'repair-card', fixture: 'views/repair_apply_power_on', tool: 'repair_apply', override: { ...failed, state: 'rolled_back', undo_available: false } });
    await waitPainted(g);
    const visible = await g.locator('.steps > .step:not(.is-folded)').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.status));
    expect(visible).toEqual(expect.arrayContaining(['failed', 'rolled_back', 'rolled_back']));
    expect(await more(g).innerText()).toMatch(/^\d+ more steps, all read back$/);
  });

  test('fullscreen lists every step without folding, and Fix it stays in view while they scroll', async () => {
    const f = await load(s.page, { view: 'stepper', fixture: 'views/repair_plan_power_on', tool: 'repair_plan', mode: 'fullscreen' });
    await waitPainted(f);
    expect(await steps(f)).toBe(14);
    expect(await more(f).isVisible()).toBe(false);
    const inView = () =>
      f.evaluate(() => {
        const r = (document.querySelector('[data-action="apply"]') as HTMLElement).getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });
    expect(await inView()).toBe(true);
    await f.evaluate(() => {
      const card = document.getElementById('app') as HTMLElement;
      card.scrollTop = card.scrollHeight;
    });
    expect(await inView()).toBe(true);
    await shot('flow-fullscreen-steps-scrolled-dark-large');
  });
});

describe("apps/host's phone frame (358 wide, grows to 480 px, inline only)", () => {
  test('the question and Yes are in view, and the whole fix runs by tapping a touch screen', async () => {
    const p = await openSession(browser, harness.hostUrl, 'phone', { touch: true });
    try {
      const f = await load(p.page, { view: 'stepper', fixture: 'protocol/diagnose', tool: 'diagnose', device: 'phone', container: 'flex' });
      await waitPainted(f);
      await expect.poll(() => f.evaluate(() => window.innerHeight)).toBe(480);
      const inView = (sel: string) =>
        f.evaluate((q) => {
          const el = document.querySelector(q);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight;
        }, sel);
      expect(await inView('.decision-text')).toBe(true);
      expect(await inView('[data-action="answer-yes"]')).toBe(true);
      expect(await p.page.locator('#stage').evaluate((el) => el.getBoundingClientRect().height)).toBe(480);
      await p.page.locator('#stage').screenshot({ path: path.join(SHOTS, 'flow-hostphone-question-dark.png') });

      // tap() sends touchstart and touchend (hasTouch context), as a finger does.
      await f.locator('[data-action="answer-yes"]').tap();
      await expect.poll(() => chipText(f)).toBe('Confirmed');
      expect(await inView('[data-action="plan"]')).toBe(true);
      await f.locator('[data-action="plan"]').tap();
      await expect.poll(() => chipText(f)).toBe('Nothing changed yet');
      expect(await inView('[data-action="apply"]')).toBe(true);
      await p.page.locator('#stage').screenshot({ path: path.join(SHOTS, 'flow-hostphone-plan-dark.png') });
      await f.locator('[data-action="apply"]').tap();
      await expect.poll(() => chipText(f)).toBe('Fixed');
      expect(await inView('[data-action="undo"]')).toBe(true);
      expect(p.errors).toEqual([]);
    } finally {
      await p.close();
    }
  });

  test('scrolling past the end of a long card moves the card only, never the page', async () => {
    const p = await openSession(browser, harness.hostUrl, 'phone', { touch: true });
    try {
      const f = await load(p.page, { view: 'repair-card', fixture: 'views/repair_apply_power_on', tool: 'repair_apply', device: 'phone', container: 'flex', now: '2026-10-15T17:31:00.000Z' });
      await waitPainted(f);
      await expect.poll(() => f.evaluate(() => window.innerHeight)).toBe(480);
      const page = () => f.evaluate(() => ({ overflow: (document.scrollingElement as HTMLElement).scrollHeight - window.innerHeight, top: (document.scrollingElement as HTMLElement).scrollTop }));
      expect((await page()).overflow).toBeLessThanOrEqual(0);
      const box = await p.page.locator('#stage').boundingBox();
      if (!box) throw new Error('no stage');
      await p.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 12; i++) await p.page.mouse.wheel(0, 400);
      await expect
        .poll(() => f.evaluate(() => {
          const c = document.getElementById('app') as HTMLElement;
          return c.scrollHeight - c.clientHeight - c.scrollTop;
        }))
        .toBeLessThanOrEqual(1);
      await p.page.waitForTimeout(150);
      expect(await page()).toEqual({ overflow: expect.any(Number), top: 0 });
      expect((await page()).overflow).toBeLessThanOrEqual(0);
      const gap = await f.evaluate(() => window.innerHeight - (document.getElementById('app') as HTMLElement).getBoundingClientRect().bottom);
      expect(Math.abs(gap)).toBeLessThanOrEqual(1);
      await p.page.locator('#stage').screenshot({ path: path.join(SHOTS, 'flow-hostphone-scrolled-end-dark.png') });
      expect(p.errors).toEqual([]);
    } finally {
      await p.close();
    }
  });
});

describe('carousel', () => {
  test('a card action opens its plan in place, the fix applies, and the card shows Fixed', async () => {
    const f = await load(s.page, { view: 'carousel', fixture: 'protocol/home_checkup', tool: 'home_checkup' });
    await waitPainted(f);
    const logs = await s.page.evaluate(() => window.__harness.logs());
    expect(logs.at(-1)?.data).toMatchObject({ event: 'painted', view: 'carousel', firstItem: true });
    const issue = fixture<{ findings: { issue_id: string }[] }>('protocol/home_checkup').findings[0]?.issue_id as string;

    await latency(400);
    await button(f, `plan-${issue}`).click();
    await expect.poll(() => button(f, `plan-${issue}`).innerText()).toBe('Planning');
    await latency(0);
    await expect.poll(() => chipText(f)).toBe('Nothing changed yet');
    expect(await f.locator('.title').innerText()).toBe('Two lights answer to Living Room Light');
    await settle(f);
    await shot('flow-carousel-plan-dark-large');
    await button(f, 'apply').click();
    await expect.poll(() => chipText(f)).toBe('Fixed');
    await button(f, 'back').click();
    await expect.poll(() => f.locator(`[data-issue="${issue}"] .sev`).innerText()).toBe('Fixed');
    expect(await button(f, `plan-${issue}`).count()).toBe(0);
    expect(await chipText(f)).toBe('1 urgent');
    expect(await f.locator('.title').innerText()).toBe('Two things need a look');
    expect((await calls()).map((c) => c.name)).toEqual(['repair_plan', 'repair_apply']);
    expect(s.errors).toEqual([]);
  });

  test('three cards: every title in full, details use the free height, nothing to press says so', async () => {
    const f = await load(s.page, { view: 'carousel', fixture: 'protocol/home_checkup', tool: 'home_checkup' });
    await waitPainted(f);
    const cards = await f.locator('.track .item').evaluateAll((els) =>
      els.map((el) => {
        const t = el.querySelector('.item-title') as HTMLElement;
        return { cut: t.scrollHeight > t.clientHeight + 1, lines: getComputedStyle(el.querySelector('.item-detail') as Element).webkitLineClamp, note: el.querySelector('.item-note')?.textContent ?? null, button: Boolean(el.querySelector('button')) };
      }),
    );
    expect(cards.map((c) => c.cut)).toEqual([false, false, false]);
    expect(cards.every((c) => Number(c.lines) >= 3)).toBe(true);
    expect(cards.map((c) => [c.button, c.note])).toEqual([
      [true, null],
      [false, 'Needs your hands'],
      [true, null],
    ]);
    expect(await f.locator('.track').getAttribute('tabindex')).toBeNull();
  });

  test('five cards: the row takes keyboard focus and arrow keys move along it', async () => {
    const f = await load(s.page, { view: 'carousel', fixture: 'views/home_checkup_five', tool: 'home_checkup' });
    await waitPainted(f);
    const track = f.locator('.track');
    expect(await track.getAttribute('tabindex')).toBe('0');
    await track.focus();
    const ring = await track.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(ring).toBe('solid');
    await s.page.keyboard.press('ArrowRight');
    await expect.poll(() => track.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  });

  test('Back from a plan returns to the cards without calling anything', async () => {
    const f = await load(s.page, { view: 'carousel', fixture: 'views/home_checkup_five', tool: 'home_checkup' });
    await waitPainted(f);
    const issue = fixture<{ findings: { issue_id: string }[] }>('views/home_checkup_five').findings[4]?.issue_id as string;
    await button(f, `plan-${issue}`).click();
    await expect.poll(() => f.locator('.decision-text').innerText()).toContain("I'll read each change back");
    expect(await f.locator('.title').innerText()).toBe('Fourteen devices turn on after a power cut');
    await button(f, 'cancel').click();
    await expect.poll(() => f.locator('.track .item').count()).toBe(5);
    expect((await calls()).length).toBe(1);
  });

  test("declining Fix it the way apps/host does keeps the plan, the cards and the cards' Fixed marks", async () => {
    const five = fixture<{ findings: { issue_id: string; title: string }[] }>('views/home_checkup_five');
    const [rename, , , , powerOn] = five.findings as { issue_id: string; title: string }[];
    const f = await load(s.page, { view: 'carousel', fixture: 'views/home_checkup_five', tool: 'home_checkup' });
    await waitPainted(f);
    await button(f, `plan-${rename?.issue_id}`).click();
    await expect.poll(() => chipText(f)).toBe('Nothing changed yet');
    await button(f, 'apply').click();
    await expect.poll(() => chipText(f)).toBe('Fixed');
    await button(f, 'back').click();
    await expect.poll(() => f.locator(`[data-issue="${rename?.issue_id}"] .sev`).innerText()).toBe('Fixed');
    await button(f, `plan-${powerOn?.issue_id}`).click();
    await expect.poll(() => chipText(f)).toBe('Nothing changed yet');
    await decline('convention');
    await button(f, 'apply').click();
    await expect.poll(() => noticeText(f)).toBe(DECLINED_NOTE);
    expect(await f.locator('[role="alert"]').count()).toBe(0);
    expect(await f.locator('.title').innerText()).toBe(powerOn?.title);
    expect(await chipText(f)).toBe('Nothing changed yet');
    expect(await button(f, 'apply').getAttribute('aria-disabled')).toBeNull();
    await settle(f);
    await shot('flow-carousel-declined-dark-large');
    await button(f, 'cancel').click();
    await expect.poll(() => f.locator('.track .item').count()).toBe(5);
    expect(await f.locator(`[data-issue="${rename?.issue_id}"] .sev`).innerText()).toBe('Fixed');
    expect(await button(f, `plan-${powerOn?.issue_id}`).count()).toBe(1);
    expect(await chipText(f)).toBe('1 urgent');
    expect((await calls()).map((c) => [c.name, c.approved])).toEqual([
      ['repair_plan', null],
      ['repair_apply', true],
      ['repair_plan', null],
      ['repair_apply', false],
    ]);
    expect(s.errors).toEqual([]);
  });

  test('Back from a fixed card puts keyboard focus on that card, and Back from a plan on its button, in view', async () => {
    const five = fixture<{ findings: { issue_id: string }[] }>('views/home_checkup_five').findings;
    const rename = five[0]?.issue_id as string;
    const powerOn = five[4]?.issue_id as string;
    const f = await load(s.page, { view: 'carousel', fixture: 'views/home_checkup_five', tool: 'home_checkup' });
    await waitPainted(f);
    const focused = () =>
      f.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        const item = el?.closest<HTMLElement>('.item');
        const track = document.querySelector('.track') as HTMLElement;
        const r = item?.getBoundingClientRect();
        const t = track.getBoundingClientRect();
        return {
          issue: item?.dataset.issue ?? null,
          isCard: Boolean(el?.classList.contains('item')),
          action: el?.dataset.action ?? null,
          inView: Boolean(r) && (r as DOMRect).left >= t.left - 1 && (r as DOMRect).right <= t.right + 1,
          ring: el ? getComputedStyle(el).outlineStyle : null,
        };
      });
    await f.locator(`[data-action="plan-${rename}"]`).focus();
    await s.page.keyboard.press('Enter');
    await expect.poll(() => chipText(f)).toBe('Nothing changed yet');
    await s.page.keyboard.press('Enter');
    await expect.poll(() => chipText(f)).toBe('Fixed');
    await f.locator('[data-action="back"]').focus();
    await s.page.keyboard.press('Enter');
    await expect.poll(() => f.locator('.track .item').count()).toBe(5);
    expect(await focused()).toEqual({ issue: rename, isCard: true, action: null, inView: true, ring: 'solid' });
    await f.locator(`[data-action="plan-${powerOn}"]`).focus();
    await s.page.keyboard.press('Enter');
    await expect.poll(() => chipText(f)).toBe('Nothing changed yet');
    await f.locator('[data-action="cancel"]').focus();
    await s.page.keyboard.press('Enter');
    await expect.poll(() => f.locator('.track .item').count()).toBe(5);
    expect(await focused()).toEqual({ issue: powerOn, isCard: false, action: `plan-${powerOn}`, inView: true, ring: 'solid' });
    expect(s.errors).toEqual([]);
  });

  test('"Show me how" on a finding the server cannot fix asks the conversation, never repair_plan', async () => {
    const three = fixture<{ findings: { issue_id: string; fixable: boolean }[] }>('protocol/home_checkup');
    const wifi = three.findings[2]?.issue_id as string;
    const f = await load(s.page, { view: 'carousel', fixture: 'protocol/home_checkup', tool: 'home_checkup' });
    await waitPainted(f);
    expect(await button(f, `plan-${wifi}`).count()).toBe(0);
    await button(f, `ask-${wifi}`).click();
    await expect.poll(() => f.locator(`[data-issue="${wifi}"] .item-note`).innerText()).toBe(ASKED);
    expect(await s.page.evaluate(() => window.__harness.messages())).toEqual(['Show me how to fix this. Kitchen plug dropped off Wi-Fi 9 times today.']);
    expect(await calls()).toEqual([]);
    expect(await button(f, `ask-${wifi}`).count()).toBe(0);
    await settle(f);
    await shot('flow-carousel-asked-dark-large');
    expect(s.errors).toEqual([]);
  });

  test.each(['large', 'small'] as const)('a failed card action at %s: the message takes the detail\'s place, the card never scrolls inside', async (size) => {
    const p = size === 'large' ? s : await openSession(browser, harness.hostUrl, size);
    try {
      const five = fixture<{ findings: { issue_id: string }[] }>('views/home_checkup_five');
      const ghost = five.findings[3]?.issue_id as string;
      const f = await load(p.page, { view: 'carousel', fixture: 'views/home_checkup_five', tool: 'home_checkup', device: size });
      await waitPainted(f);
      // The fixture router has no plan for this finding, so repair_plan answers with the server's problem.
      await f.locator(`[data-action="plan-${ghost}"]`).click();
      const card = f.locator(`[data-issue="${ghost}"]`);
      await expect.poll(() => card.locator('[role="alert"]').innerText()).toBe("I couldn't reach your hub just now. Try again in a minute.");
      await settle(f);
      const geo = await card.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const within = (q: string) => {
          const c = el.querySelector(q)?.getBoundingClientRect();
          return Boolean(c) && (c as DOMRect).top >= r.top - 1 && (c as DOMRect).bottom <= r.bottom + 1;
        };
        const pad = parseFloat(getComputedStyle(el).paddingBottom) * (Number(getComputedStyle(document.getElementById('stage') as HTMLElement).zoom) || 1);
        const btn = (el.querySelector('.btn') as HTMLElement).getBoundingClientRect();
        return {
          scrollTop: el.scrollTop,
          overflow: el.scrollHeight - el.clientHeight,
          head: within('.item-head'),
          title: within('.item-title'),
          error: within('.error'),
          button: within('.btn'),
          buttonInPadding: btn.bottom > r.bottom - pad + 1,
          detail: Boolean(el.querySelector('.item-detail')),
        };
      });
      expect(geo).toEqual({ scrollTop: 0, overflow: 0, head: true, title: true, error: true, button: true, buttonInPadding: false, detail: false });
      await card.scrollIntoViewIfNeeded();
      await p.page.screenshot({ path: path.join(SHOTS, `flow-carousel-card-error-dark-${size}.png`) });
      // No plan in the fixtures, so the next try fails again.
      await p.page.evaluate(() => window.__harness.setPolicy({ latencyMs: 600 }));
      await f.locator(`[data-action="plan-${ghost}"]`).click();
      await expect.poll(() => card.locator('.item-detail').count()).toBe(1);
      expect(await card.locator('.btn').innerText()).toBe('Planning');
      await expect.poll(() => card.locator('[role="alert"]').count()).toBe(1);
      await p.page.evaluate(() => window.__harness.setPolicy({ latencyMs: 0 }));
    } finally {
      if (p !== s) await p.close();
    }
  });
});

// A declined or failed call adds a line to the decision card, which must still hold everything
// on a fixed landscape screen, at both landscape sizes.
describe('every decision card holds the line its last action left (fixed landscape screens)', () => {
  type Ending = 'problem' | 'throw' | 'convention' | 'plain';
  const ASKING: Ending[] = ['problem', 'throw'];
  const COMMIT: Ending[] = ['problem', 'throw', 'convention', 'plain'];
  const POLICY: Record<Ending, Partial<Policy>> = {
    problem: { failNext: 'problem' },
    throw: { failNext: 'throw' },
    convention: { approve: false, decline: 'convention' },
    plain: { approve: false, decline: 'plain' },
  };
  const five = fixture<{ findings: { issue_id: string }[] }>('views/home_checkup_five').findings;
  interface Sweep {
    name: string;
    scenario: Omit<Scenario, 'device'>;
    open?: string;
    action: string;
    endings: Ending[];
  }
  const stepper = (fixtureName: string, tool: string, now?: string): Omit<Scenario, 'device'> => ({ view: 'stepper', fixture: fixtureName, tool, ...(now ? { now } : {}) });
  const card = (fixtureName: string, now: string): Omit<Scenario, 'device'> => ({ view: 'repair-card', fixture: fixtureName, tool: 'repair_apply', now });
  const carousel: Omit<Scenario, 'device'> = { view: 'carousel', fixture: 'views/home_checkup_five', tool: 'home_checkup' };
  const SWEEP: Sweep[] = [
    { name: 'question', scenario: stepper('protocol/diagnose', 'diagnose'), action: 'answer-yes', endings: ASKING },
    { name: 'question after a no', scenario: stepper('views/diagnose_answer_no', 'diagnose_answer'), action: 'answer-yes', endings: ASKING },
    { name: 'confirmed verdict', scenario: stepper('protocol/diagnose_answer', 'diagnose_answer'), action: 'plan', endings: ASKING },
    { name: 'likely verdict', scenario: stepper('views/diagnose_likely', 'diagnose'), action: 'plan', endings: ASKING },
    { name: 'explanation', scenario: stepper('protocol/explain_event', 'explain_event'), action: 'plan', endings: ASKING },
    { name: 'plan', scenario: stepper('protocol/repair_plan', 'repair_plan'), action: 'apply', endings: COMMIT },
    { name: 'plan with Not now', scenario: stepper('protocol/diagnose_answer', 'diagnose_answer'), open: 'plan', action: 'apply', endings: COMMIT },
    { name: 'plan with a protected device', scenario: stepper('views/repair_plan_protected', 'repair_plan'), action: 'apply', endings: COMMIT },
    { name: 'plan of 14 steps', scenario: stepper('views/repair_plan_power_on', 'repair_plan'), action: 'apply', endings: COMMIT },
    { name: 'repair', scenario: card('protocol/repair_apply', '2026-10-15T17:21:00.000Z'), action: 'undo', endings: COMMIT },
    { name: 'repair of 14 steps', scenario: card('views/repair_apply_power_on', '2026-10-15T17:31:00.000Z'), action: 'undo', endings: COMMIT },
    { name: 'retried repair', scenario: card('views/repair_apply_retried', '2026-10-15T17:22:00.000Z'), action: 'undo', endings: COMMIT },
    { name: 'confirmed repair', scenario: card('protocol/repair_status', '2026-10-16T14:05:00.000Z'), action: 'undo', endings: COMMIT },
    { name: 'regressed repair', scenario: card('views/repair_regressed', '2026-10-16T14:05:00.000Z'), action: 'undo', endings: COMMIT },
    { name: 'carousel plan, rename', scenario: carousel, open: `plan-${five[0]?.issue_id}`, action: 'apply', endings: COMMIT },
    { name: 'carousel plan, power on', scenario: carousel, open: `plan-${five[4]?.issue_id}`, action: 'apply', endings: COMMIT },
  ];

  test.each(['large', 'small'] as const)('at %s', async (size) => {
    const p = size === 'large' ? s : await openSession(browser, harness.hostUrl, size);
    const resting: Policy = { approve: true, decline: 'convention', latencyMs: 0, failNext: null };
    const setPolicy = (pol: Partial<Policy>) => p.page.evaluate((v) => window.__harness.setPolicy(v), { ...resting, ...pol });
    const bad: string[] = [];
    const steps: Record<string, number> = {};
    try {
      for (const c of SWEEP) {
        for (const ending of c.endings) {
          await setPolicy({});
          const f = await load(p.page, { ...c.scenario, device: size });
          await waitPainted(f);
          if (c.open) {
            await f.locator(`[data-action="${c.open}"]`).click();
            await f.waitForSelector('[data-action="apply"]', { timeout: 5000 });
          }
          await setPolicy(POLICY[ending]);
          await f.locator(`[data-action="${c.action}"]`).click();
          await f.waitForSelector(ending === 'convention' ? '.decision .notice' : '.decision .error', { timeout: 5000 });
          await p.page.mouse.move(0, 0);
          await settle(f);
          const a = await audit(f);
          steps[`${c.name}, ${ending}`] = a.decisionFit;
          const problems = [
            a.contentOverflowY > 0 ? `card overflow ${a.contentOverflowY}` : '',
            a.bottomBleed > 1 ? `bleed ${a.bottomBleed}` : '',
            a.decisionSpill > 1 ? `spill ${a.decisionSpill}` : '',
            a.cardScrollTop !== 0 ? `card scrolled ${a.cardScrollTop}` : '',
            a.clippedText.length ? `clipped ${a.clippedText.join('; ')}` : '',
            a.smallTargets.length ? `small targets ${a.smallTargets.join('; ')}` : '',
            a.lowContrast.length ? `low contrast ${a.lowContrast.join('; ')}` : '',
          ].filter(Boolean);
          if (problems.length) bad.push(`${c.name}, ${ending}: ${problems.join(', ')}`);
        }
      }
      outcomeReport[size] = steps;
      expect(bad).toEqual([]);
      expect(p.errors).toEqual([]);
    } finally {
      await setPolicy({});
      if (p !== s) await p.close();
    }
  });
});

describe('repair card', () => {
  test('declining Undo the way apps/host does keeps the card and its Undo, with a calm note', async () => {
    const f = await load(s.page, { view: 'repair-card', fixture: 'protocol/repair_apply', tool: 'repair_apply', now: '2026-10-15T17:21:00.000Z' });
    await waitPainted(f);
    await decline('convention');
    await button(f, 'undo').click();
    await expect.poll(() => noticeText(f)).toBe(DECLINED_NOTE);
    expect(await chipText(f)).toBe('3 of 3 read back');
    expect(await button(f, 'undo').getAttribute('aria-disabled')).toBeNull();
    expect(await f.locator('[role="alert"]').count()).toBe(0);
  });

  test('Undo calls undo with the repair id and shows the reversed steps', async () => {
    const f = await load(s.page, { view: 'repair-card', fixture: 'protocol/repair_apply', tool: 'repair_apply', now: '2026-10-15T17:21:00.000Z' });
    await waitPainted(f);
    expect(await f.locator('.decision-text').innerText()).toBe('Tomorrow at 7:00 AM');
    await button(f, 'undo').click();
    await expect.poll(() => chipText(f)).toBe('2 of 2 reversed');
    expect(await calls()).toMatchObject([{ name: 'undo', arguments: { repair_id: fixture<{ repair_id: string }>('protocol/repair_apply').repair_id }, approved: true }]);
  });

  test('when the host clock passes the next check, the next check result appears in place', async () => {
    const f = await load(s.page, { view: 'repair-card', fixture: 'protocol/repair_apply', tool: 'repair_apply', now: '2026-10-15T17:21:00.000Z' });
    await waitPainted(f);
    expect(await calls()).toEqual([]);
    await s.page.evaluate(() => window.__harness.update({ now: '2026-10-16T14:02:00.000Z' }));
    await expect.poll(() => chipText(f)).toBe('Check passed');
    expect(await f.locator('.decision-text').innerText()).toBe('Hallway lamp answered all 9 commands overnight.');
    expect(await calls()).toMatchObject([{ name: 'refresh_view', arguments: { ref_id: fixture<{ repair_id: string }>('protocol/repair_apply').repair_id } }]);
    // Asked once per due check, not on every context change.
    await s.page.evaluate(() => window.__harness.update({ now: '2026-10-16T14:03:00.000Z' }));
    await s.page.waitForTimeout(150);
    expect((await calls()).length).toBe(1);
  });
});

describe('host context', () => {
  test('theme changes live without a reload', async () => {
    const f = await load(s.page, { view: 'stepper', fixture: 'protocol/diagnose_answer', tool: 'diagnose_answer', theme: 'dark' });
    await waitPainted(f);
    const bg = () => f.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(await bg()).toBe('rgb(20, 24, 30)');
    await s.page.evaluate(() => window.__harness.update({ theme: 'light' }));
    await expect.poll(bg).toBe('rgb(250, 249, 251)');
    expect(await f.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
  });

  test('device class changes lay out the same view again', async () => {
    const f = await load(s.page, { view: 'stepper', fixture: 'protocol/diagnose', tool: 'diagnose', device: 'large' });
    await waitPainted(f);
    const surface = () => f.evaluate(() => window.__fixwrightView?.surface());
    expect(await surface()).toMatchObject({ deviceClass: 'large' });
    expect(Math.round((await surface())?.canvasWidth ?? 0)).toBe(768);
    await s.page.setViewportSize({ width: 960, height: 480 });
    await s.page.evaluate(() => window.__harness.update({ device: 'small' }));
    await expect.poll(async () => (await surface())?.deviceClass).toBe('small');
    expect(await surface()).toMatchObject({ scale: 1, canvasWidth: 960, canvasHeight: 480 });
    expect(await f.evaluate(() => document.documentElement.className)).toContain('dc-small');
    await s.page.setViewportSize({ width: 1280, height: 800 });
  });

  test('without the custom device class the view falls back to the container size and says so', async () => {
    const f = await load(s.page, { view: 'carousel', fixture: 'protocol/home_checkup', tool: 'home_checkup', omitDeviceClass: true });
    await waitPainted(f);
    expect(await f.evaluate(() => window.__fixwrightView?.surface())).toMatchObject({ deviceClass: 'large', classSource: 'derived' });
    expect(s.warnings.some((w) => w.includes('dev.fixwright/deviceClass'))).toBe(true);
    expect(s.errors).toEqual([]);
  });

  test('the expand control asks the host for fullscreen and shows the details', async () => {
    const f = await load(s.page, { view: 'stepper', fixture: 'protocol/diagnose_answer', tool: 'diagnose_answer' });
    await waitPainted(f);
    expect(await f.locator('.details').count()).toBe(0);
    await button(f, 'toggle-mode').click();
    await expect.poll(() => f.locator('.details').count()).toBe(1);
    expect(await f.locator('.details .block-h').allInnerTexts()).toEqual(['What I checked', 'Why I think so']);
    await button(f, 'toggle-mode').click();
    await expect.poll(() => f.locator('.details').count()).toBe(0);
    expect(await s.page.evaluate(() => window.__harness.displayModeRequests())).toEqual(['fullscreen', 'inline']);
  });

  test('voice class shows the spoken reply as a caption', async () => {
    const f = await load(s.page, { view: 'stepper', fixture: 'protocol/diagnose_answer', tool: 'diagnose_answer', device: 'voice' });
    await waitPainted(f);
    // The caption is the spoken reply word for word; on screen, dates and units are glued with no break characters.
    const caption = (await f.locator('.caption').innerText()).replace(/\u00a0/g, ' ').replace(/\u2011/g, '-');
    expect(caption).toBe(fixture<{ speech: string }>('protocol/diagnose_answer').speech);
    await shot('state-voice-caption-dark');
  });

  test('waiting state names what is being checked', async () => {
    const f = await load(s.page, { view: 'stepper', fixture: 'protocol/diagnose', tool: 'diagnose', args: { device: 'Hallway Lamp', symptom: 'not responding' }, holdResult: true });
    await expect.poll(() => f.locator('.title').innerText()).toBe('Hallway Lamp');
    expect(await f.locator('.waiting-line').innerText()).toBe('Running the checks');
    await shot('state-waiting-dark-large');
  });
});

describe('accessibility', () => {
  test('keyboard: Tab reaches the answer, the focus ring shows, Enter answers', async () => {
    const f = await load(s.page, { view: 'stepper', fixture: 'protocol/diagnose', tool: 'diagnose' });
    await waitPainted(f);
    await f.locator('[data-action="toggle-mode"]').focus();
    await s.page.keyboard.press('Tab');
    expect(await f.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.action)).toBe('answer-yes');
    const ring = await f.evaluate(() => {
      const st = getComputedStyle(document.activeElement as Element);
      return { style: st.outlineStyle, width: parseFloat(st.outlineWidth) };
    });
    expect(ring.style).toBe('solid');
    expect(ring.width).toBeCloseTo(3, 1);
    await settle(f);
    await shot('flow-stepper-focus-dark-large');
    await s.page.keyboard.press('Enter');
    await expect.poll(() => chipText(f)).toBe('Confirmed');
  });

  test('screen reader text: probe outcomes and step status are spoken, icons are hidden', async () => {
    const f = await load(s.page, { view: 'stepper', fixture: 'protocol/diagnose', tool: 'diagnose' });
    await waitPainted(f);
    const hub = await f.locator('.probe[data-probe^="hub_reachable"]').textContent();
    expect(hub?.replace(/\s+/g, ' ').trim()).toBe('Hub, passed');
    expect(await f.locator('svg:not([aria-hidden="true"])').count()).toBe(0);
    expect(await f.locator('#live').getAttribute('aria-live')).toBe('polite');
  });

  test('reduced motion: nothing animates', async () => {
    const rm = await openSession(browser, harness.hostUrl, 'large', { reducedMotion: true });
    try {
      const f = await load(rm.page, { view: 'stepper', fixture: 'protocol/diagnose', tool: 'diagnose' });
      await waitPainted(f);
      const running = await f.evaluate(() => document.getAnimations().filter((a) => (a.effect?.getComputedTiming().duration as number) > 1).length);
      expect(running).toBe(0);
      expect(await f.evaluate(() => document.getElementById('app')?.classList.contains('enter'))).toBe(false);
      expect(rm.errors).toEqual([]);
    } finally {
      await rm.close();
    }
  });

  test('with motion allowed, the bars grow from the previous answer', async () => {
    const f = await load(s.page, { view: 'stepper', fixture: 'protocol/diagnose', tool: 'diagnose' });
    await waitPainted(f);
    await button(f, 'answer-yes').click();
    await expect.poll(() => chipText(f)).toBe('Confirmed');
    const from = await f.locator('.bar.is-lead .bar-fill').evaluate((el) => getComputedStyle(el).getPropertyValue('--from').trim());
    expect(from).toBe('55%');
  });
});
