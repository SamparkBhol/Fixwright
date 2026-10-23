import type { Finding, HomeCheckupOutput } from '@fixwright/protocol';
import { describe, expect, test } from 'vitest';
import { EMPTY_CAROUSEL, MAX_ITEMS, askWords, carouselFromHost, checkupCarousel, type CarouselState } from '../../src/ui/checkup.ts';
import { beginAction, startFlow, type PanelPayload } from '../../src/ui/flow.ts';
import { UNREADABLE_PROBLEM, classifyPayload, type ToolOutcome } from '../../src/ui/payload.ts';
import { fixture } from './load.ts';

const three = fixture<HomeCheckupOutput>('protocol/home_checkup');
const five = fixture<HomeCheckupOutput>('views/home_checkup_five');
const ok = (sc: unknown): ToolOutcome => ({ ok: true, payload: classifyPayload(sc) as NonNullable<ReturnType<typeof classifyPayload>> });
const payload = (name: string) => classifyPayload(fixture(name)) as PanelPayload;

/** The engine's unprotected_load finding (packages/engine/src/checkup.ts), as the checkup would carry it. */
const aquarium: Finding = {
  issue_id: 'iss_01m52gb900aq0000000',
  kind: 'unprotected_load',
  severity: 'high',
  title: 'Aquarium filter is not protected',
  detail: "It runs on outlet 2 of the Living Room Power Strip. Protect it and I'll never switch it off.",
  entity_ids: ['switch.living_room_strip_outlet_2', 'switch.living_room_strip'],
  fixable: false,
  action_label: 'Protect it',
};

describe('checkup carousel', () => {
  test('three findings, strongest first; only the fixable one opens a plan, the labelled other asks', () => {
    const vm = checkupCarousel(three, { canAsk: true });
    expect(vm).toMatchObject({ eyebrow: 'Home checkup', title: 'Three things need a look', chip: { label: '2 urgent', tone: 'fail' }, simulated: true });
    expect(vm.items.map((i) => [i.title, i.severityLabel, i.action?.label ?? null])).toEqual([
      ['Two lights answer to Living Room Light', 'Urgent', 'Rename one'],
      ['Hall motion sensor battery at 6%', 'Urgent', null],
      ['Kitchen plug dropped off Wi-Fi 9 times today', 'Worth a look', 'Show me how'],
    ]);
    const [first, , wifi] = three.findings as [Finding, Finding, Finding];
    expect(vm.items[0]?.action?.tool).toEqual({ name: 'repair_plan', arguments: { issue_id: first.issue_id } });
    // The engine answers repair_plan for a finding that is not fixable with no_fix, so the card never calls it.
    expect(wifi.fixable).toBe(false);
    expect(vm.items[2]?.action).toMatchObject({ id: `ask-${wifi.issue_id}`, pendingLabel: 'Asking', ask: 'Show me how to fix this. Kitchen plug dropped off Wi-Fi 9 times today.' });
    expect(vm.items[2]?.action?.tool).toBeUndefined();
    expect(vm.items.map((i) => i.icon)).toEqual(['duplicate_name', 'low_battery', 'flapping']);
  });

  test('no finding that is not fixable ever calls repair_plan', () => {
    const findings = [...three.findings, ...five.findings, aquarium];
    for (const f of findings) {
      const vm = checkupCarousel({ ...three, findings: [f] }, { canAsk: true });
      const tool = vm.items[0]?.action?.tool;
      if (f.fixable) expect(tool).toEqual({ name: 'repair_plan', arguments: { issue_id: f.issue_id } });
      else expect(tool).toBeUndefined();
    }
  });

  test('without ui/message from the host, a labelled finding that is not fixable has nothing to press', () => {
    const vm = checkupCarousel(three);
    expect(vm.items.map((i) => i.action?.id ?? null)).toEqual([`plan-${three.findings[0]?.issue_id}`, null, null]);
  });

  test('a card that asked shows that instead of its button', () => {
    const wifi = three.findings[2]?.issue_id as string;
    const vm = checkupCarousel(three, { canAsk: true, asked: new Set([wifi]) });
    expect(vm.items[2]).toMatchObject({ asked: true });
    expect(vm.items[2]?.action).toBeUndefined();
    expect(vm.items[1]?.asked).toBe(false);
  });

  test('askWords: words the router understands for each kind of guidance', () => {
    expect(askWords(aquarium)).toBe('Protect the aquarium filter.');
    expect(askWords({ kind: 'unprotected_load', title: 'TV stand is not protected', action_label: 'Protect it' })).toBe('Protect the TV stand.');
    expect(askWords({ kind: 'integration_error', title: 'Hue needs you to sign in again', action_label: 'Show me how' })).toBe('Show me how to fix this. Hue needs you to sign in again.');
    expect(askWords({ kind: 'low_battery', title: 'Hall motion sensor battery at 6%.', action_label: 'Swap it' })).toBe('Help me fix this. Hall motion sensor battery at 6%.');
    expect(askWords({ kind: 'unprotected_load', title: 'Something unusual', action_label: 'Protect it' })).toBe('Help me fix this. Something unusual.');
  });

  test('five findings stay within the 3 to 5 item budget', () => {
    const vm = checkupCarousel(five);
    expect(vm.items).toHaveLength(MAX_ITEMS);
    expect(vm.title).toBe('Five things need a look');
    expect(vm.items.map((i) => i.severity)).toEqual(['high', 'high', 'medium', 'medium', 'low']);
  });

  test('severity order is enforced even if a server does not sort', () => {
    const shuffled = { ...three, findings: [...three.findings].reverse() };
    expect(checkupCarousel(shuffled).items.map((i) => i.severity)).toEqual(['high', 'high', 'medium']);
  });

  test('a fixed finding loses its action and updates the counts', () => {
    const id = three.findings[0]?.issue_id as string;
    const vm = checkupCarousel(three, { fixed: new Set([id]) });
    expect(vm.items[0]).toMatchObject({ fixed: true, severityLabel: 'Fixed', tone: 'pass' });
    expect(vm.items[0]?.action).toBeUndefined();
    expect(vm.chip.label).toBe('1 urgent');
    expect(vm.title).toBe('Two things need a look');
  });

  test('a healthy home', () => {
    const vm = checkupCarousel({ ...three, findings: [] });
    expect(vm).toMatchObject({ title: 'All clear', chip: { label: 'Healthy', tone: 'pass' }, items: [] });
  });
});

describe('results the host sends to an open carousel', () => {
  const issue = three.findings[0]?.issue_id as string;
  const plan = fixture<Record<string, unknown> & { ids: Record<string, string> }>('views/repair_plan_rename');
  const withPlan = (): CarouselState => {
    const flow = { ...startFlow(payload('views/repair_plan_rename')), back: null };
    return { checkup: three, fixed: new Set(['iss_other']), asked: new Set(), open: { issue, title: 'Two lights answer to Living Room Light', flow }, message: null };
  };

  test('the plan that is open, sent again (decline convention): a resend, nothing changes', () => {
    const s = withPlan();
    const pending = { ...s, open: { ...(s.open as NonNullable<CarouselState['open']>), flow: beginAction((s.open as NonNullable<CarouselState['open']>).flow, 'apply') } };
    const r = carouselFromHost(pending, ok(plan));
    expect(r.resend).toBe(true);
    expect(r.state).toBe(pending);
  });

  test('a newer version of the open plan updates it in place, under the same title', () => {
    const s = withPlan();
    const newer = { ...plan, expires_at: '2026-10-16T14:20:00.000Z' };
    const r = carouselFromHost(s, ok(newer));
    expect(r.resend).toBe(false);
    expect(r.state.checkup).toBe(three);
    expect(r.state.fixed).toBe(s.fixed);
    expect(r.state.open?.title).toBe('Two lights answer to Living Room Light');
    expect(r.state.open?.flow.screen.kind === 'plan' && r.state.open.flow.screen.data.expires_at).toBe('2026-10-16T14:20:00.000Z');
  });

  test("the open finding's repair replaces its plan in place", () => {
    const repair = fixture<Record<string, unknown>>('views/repair_apply_rename');
    const r = carouselFromHost(withPlan(), ok(repair));
    expect(r.state.open?.flow.screen.kind).toBe('repair');
    expect(r.state.open?.issue).toBe(issue);
  });

  test("a plan for another finding on the cards opens that finding; one for no finding leaves the cards", () => {
    const fiveState: CarouselState = { ...EMPTY_CAROUSEL, checkup: five };
    const powerOn = five.findings[4] as Finding;
    const forPowerOn = { ...fixture<Record<string, unknown>>('views/repair_plan_power_on'), ids: { issue_id: powerOn.issue_id, plan_id: 'pln_x' }, plan_id: 'pln_x' };
    const r = carouselFromHost(fiveState, ok(forPowerOn));
    expect(r.state.open).toMatchObject({ issue: powerOn.issue_id, title: powerOn.title });
    const stray = { ...forPowerOn, ids: { plan_id: 'pln_y' }, plan_id: 'pln_y' };
    expect(carouselFromHost(fiveState, ok(stray)).state).toBe(fiveState);
    expect(carouselFromHost(fiveState, ok(fixture('protocol/diagnose'))).state).toBe(fiveState);
  });

  test('the same checkup again keeps the Fixed marks and the open plan; a new one starts over', () => {
    const s = withPlan();
    const fixedHere = { ...s, fixed: new Set([issue, 'iss_gone']) };
    const again = carouselFromHost(fixedHere, ok(three));
    expect([...again.state.fixed]).toEqual([issue]);
    expect(again.state.open).toBe(s.open);
    const fresh = carouselFromHost(fixedHere, ok({ ...three, checkup_id: 'chk_new' }));
    expect(fresh.state).toMatchObject({ open: null, message: null });
    expect(fresh.state.fixed.size).toBe(0);
  });

  test('without cards, a payload the carousel cannot show says so; a problem shows its words', () => {
    expect(carouselFromHost(EMPTY_CAROUSEL, ok(plan)).state.message).toBe(UNREADABLE_PROBLEM);
    const problem = carouselFromHost(withPlan(), { ok: false, problem: { speech: 'Try again in a minute.', retryable: true } });
    expect(problem.state).toMatchObject({ checkup: null, message: 'Try again in a minute.' });
  });
});
