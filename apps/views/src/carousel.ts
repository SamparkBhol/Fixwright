// A fixable finding opens its plan in place, so the whole fix works by touch alone. One the server cannot
// fix asks the conversation instead (ui/message), which answers by voice.
import './ui/zod-jitless.ts'; // must stay first: keeps zod from probing eval under the sandbox CSP
import './ui/tokens.css';
import './ui/base.css';
import './ui/panel.css';
import './ui/carousel.css';
import { fitCarousel, renderCarousel, revealInRow } from './ui/carousel.ts';
import { EMPTY_CAROUSEL, carouselFromHost, checkupCarousel, type CarouselState } from './ui/checkup.ts';
import { asDeclined, beginAction, cancelPlan, finishAction, startFlow } from './ui/flow.ts';
import { createStepFold } from './ui/fold.ts';
import { fitDecision, keepHeadsWithContent, renderPanel } from './ui/panel.ts';
import { FALLBACK_PROBLEM, UNREADABLE_PROBLEM } from './ui/payload.ts';
import { startView, type FocusRequest, type RenderReason } from './ui/runtime.ts';
import { panelFor } from './ui/screens.ts';
import { messageScreen, voiceScreen, waitingScreen } from './ui/states.ts';
import type { ActionVM } from './ui/vm.ts';

const BACK: ActionVM = { id: 'back', label: 'Back to checkup', pendingLabel: 'Back to checkup', style: 'secondary', local: 'back' };

startView('carousel', (rt) => {
  let st: CarouselState = EMPTY_CAROUSEL;
  let pending: string | null = null;
  let error: { key: string; text: string } | null = null;
  let resentDuringAction = false;
  const fold = createStepFold(() => render('layout'));

  function render(reason: RenderReason, focus: FocusRequest = 'keep'): void {
    const s = rt.surface();
    if (reason !== 'layout') fold.reset();
    const { checkup, open } = st;
    let node: HTMLElement;
    if (!checkup) {
      node = st.message
        ? messageScreen({ eyebrow: 'Home checkup', title: "That didn't work", text: st.message, chip: { label: 'Not done', tone: 'fail', icon: 'alert' } })
        : waitingScreen({ eyebrow: 'Home checkup', title: 'Checking your home', line: 'Looking for anything that needs a hand', shape: 'carousel' });
    } else if (s.deviceClass === 'voice') {
      const vm = checkupCarousel(checkup, { fixed: st.fixed });
      node = voiceScreen(open ? open.flow.screen.data.speech : checkup.speech, vm.chip);
    } else if (open) {
      const f = open.flow;
      const vm = panelFor(f.screen, rt.time(), {
        subject: open.title,
        canCancel: true,
        backLabel: f.back ? 'Not now' : 'Back',
        extraActions: f.screen.kind === 'repair' ? [BACK] : [],
        hints: rt.hints(),
      });
      node = renderPanel(vm, {
        surface: s,
        actions: { pending: f.pending, press: (a) => void pressInFlow(a) },
        error: f.error,
        notice: f.notice,
        barsFrom: null,
        onToggleMode: () => void rt.toggleDisplayMode(),
      });
    } else {
      node = renderCarousel(checkupCarousel(checkup, { fixed: st.fixed, asked: st.asked, canAsk: rt.canAsk(), hubLabel: rt.hints().hubLabel ?? null }), {
        surface: s,
        actions: { pending, press: (a) => void pressFinding(a) },
        error,
        onToggleMode: () => void rt.toggleDisplayMode(),
      });
    }
    rt.mount(node, reason, focus, () => {
      if (open) {
        fitDecision(node, s);
        fold.apply(node, s);
        keepHeadsWithContent(node, s);
      } else fitCarousel(node, s);
    });
    fold.afterMount(node);
  }

  async function pressFinding(a: ActionVM): Promise<void> {
    const started = st.checkup;
    if (!started || pending || st.open) return;
    const issue = a.id.replace(/^(?:plan|ask)-/, '');
    const finding = started.findings.find((f) => f.issue_id === issue);
    if (!finding || (!a.tool && !a.ask)) return;
    pending = a.id;
    error = null;
    render('layout');
    rt.announce(`${a.pendingLabel}.`);
    if (a.ask) {
      const ok = await rt.ask(a.ask);
      pending = null;
      if (st.checkup?.checkup_id !== started.checkup_id) return;
      if (ok) st = { ...st, asked: new Set([...st.asked, issue]) };
      else error = { key: issue, text: FALLBACK_PROBLEM };
      render('layout');
      if (!ok) rt.announce(FALLBACK_PROBLEM);
      return;
    }
    const outcome = await rt.call(a.tool as NonNullable<ActionVM['tool']>);
    pending = null;
    // The host showed a newer checkup or opened a flow while the call was out: the newer screen wins.
    if (st.checkup?.checkup_id !== started.checkup_id || st.open) {
      render('layout');
      return;
    }
    if (outcome.ok && outcome.payload.kind === 'plan') {
      st = { ...st, open: { issue, title: finding.title, flow: startFlow(outcome.payload) } };
      render('action', 'primary');
      rt.reportPaint({ via: a.id, kind: 'plan' });
      rt.announce(outcome.payload.data.speech);
      rt.shareWithModel(outcome.payload.data.speech, outcome.payload.data);
    } else {
      error = { key: issue, text: outcome.ok ? UNREADABLE_PROBLEM : outcome.problem.speech };
      render('layout');
      rt.announce(error.text);
    }
  }

  function closeFlow(): void {
    const open = st.open;
    if (!open) return;
    const s = open.flow.screen;
    const fixedNow = s.kind === 'repair' && (s.data.state === 'applied' || s.data.state === 'confirmed');
    st = { ...st, open: null, fixed: fixedNow ? new Set([...st.fixed, open.issue]) : st.fixed };
    // Focus returns to the card the person came from, not to the first button on screen.
    const card = (root: HTMLElement) => root.querySelector<HTMLElement>(`.item[data-issue="${CSS.escape(open.issue)}"]`);
    render('action', (root) => card(root)?.querySelector<HTMLElement>('.btn') ?? card(root));
    const back = card(document.body);
    if (back && back.contains(document.activeElement)) revealInRow(back);
  }

  async function pressInFlow(a: ActionVM): Promise<void> {
    const open = st.open;
    if (!open || open.flow.pending) return;
    if (a.local === 'back' || (a.local === 'cancel' && !open.flow.back)) return closeFlow();
    if (a.local === 'cancel') {
      st = { ...st, open: { ...open, flow: cancelPlan(open.flow) } };
      render('action', 'primary');
      return;
    }
    if (!a.tool) return;
    const started = { ...open, flow: beginAction(open.flow, a.id) };
    st = { ...st, open: started };
    resentDuringAction = false;
    render('layout');
    rt.announce(`${a.pendingLabel}.`);
    const answer = await rt.call(a.tool);
    // The host showed a newer result while the call was out: that one wins.
    if (st.open !== started) return;
    const outcome = resentDuringAction ? asDeclined(answer) : answer;
    resentDuringAction = false;
    const flow = finishAction(started.flow, a.id, outcome, ['plan', 'repair']);
    st = { ...st, open: { ...started, flow } };
    if (!outcome.ok && flow.notice) {
      render('layout');
      rt.announce(flow.notice);
    } else if (outcome.ok && !flow.error) {
      render('action', 'primary');
      rt.reportPaint({ via: a.id, kind: outcome.payload.kind });
      rt.announce(outcome.payload.data.speech);
      rt.shareWithModel(outcome.payload.data.speech, outcome.payload.data);
    } else {
      render('layout');
      rt.announce(flow.error ?? '');
    }
  }

  return {
    onInput() {
      if (!st.checkup) render('layout');
    },
    onResult(outcome) {
      const prevCheckup = st.checkup;
      const next = carouselFromHost(st, outcome);
      if (next.resend) {
        // apps/host resends the open screen before it denies a declined approval.
        if (st.open?.flow.pending) resentDuringAction = true;
        render('layout');
        return;
      }
      const sameCards = Boolean(prevCheckup) && next.state.checkup?.checkup_id === prevCheckup?.checkup_id;
      st = next.state;
      if (!sameCards) {
        pending = null;
        error = null;
      }
      render('result');
      rt.reportPaint({ via: 'tool-result', firstItem: Boolean(document.querySelector('.track .item')) });
    },
    onCancelled() {
      if (!st.checkup) {
        st = { ...st, message: 'This checkup was cancelled before it finished.' };
        render('layout');
      }
    },
    relayout() {
      render('layout');
    },
    debugState: () => ({ ...st, fixed: [...st.fixed], asked: [...st.asked], pending, error }),
  };
});
