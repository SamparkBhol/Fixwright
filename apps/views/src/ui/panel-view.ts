import { fitStrips } from './components.ts';
import { asDeclined, beginAction, cancelPlan, dueRefresh, finishAction, fromHost, isResend, startFlow, type Flow, type PanelPayload } from './flow.ts';
import { createStepFold } from './fold.ts';
import { fitDecision, keepHeadsWithContent, renderPanel } from './panel.ts';
import { FALLBACK_PROBLEM, UNREADABLE_PROBLEM, type ToolOutcome } from './payload.ts';
import { startView, type RenderReason, type Runtime, type ViewName } from './runtime.ts';
import { panelFor } from './screens.ts';
import { messageScreen, voiceScreen, waitingScreen } from './states.ts';
import type { ActionVM, ChipVM, PanelVM } from './vm.ts';

/** Past a day the host shows a new result anyway. */
const MAX_REFRESH_WAIT_MS = 24 * 60 * 60 * 1000;
const REFRESH_GRACE_MS = 60 * 1000;

export interface WaitingCopy {
  eyebrow: string;
  title: string;
  line: string;
}

export interface PanelViewConfig {
  name: ViewName;
  accepts: readonly PanelPayload['kind'][];
  waiting(input: Record<string, unknown>): WaitingCopy;
  eyebrow: string;
}

interface Message {
  title: string;
  text: string;
  chip: ChipVM;
}

const NOT_DONE: ChipVM = { label: 'Not done', tone: 'fail', icon: 'alert' };
const NOTHING: ChipVM = { label: 'Nothing to show', tone: 'neutral', icon: 'info' };
const STOPPED: ChipVM = { label: 'Stopped', tone: 'neutral', icon: 'dash' };

export function runPanelView(cfg: PanelViewConfig): Runtime {
  return startView(cfg.name, (rt) => {
    let flow: Flow | null = null;
    let input: Record<string, unknown> = {};
    let message: Message | null = null;
    // apps/host resends the showing screen before it denies a declined approval.
    let resentDuringAction = false;

    const vmOf = (f: Flow): PanelVM =>
      panelFor(f.screen, rt.time(), { ...(f.subject ? { subject: f.subject } : {}), canCancel: f.back !== null, canAsk: rt.canAsk(), hints: rt.hints() });
    const fold = createStepFold(() => render('layout'));

    function render(reason: RenderReason, focus: 'keep' | 'primary' = 'keep'): void {
      const s = rt.surface();
      if (reason !== 'layout') fold.reset();
      let node: HTMLElement;
      if (flow) {
        const vm = vmOf(flow);
        node =
          s.deviceClass === 'voice'
            ? voiceScreen(flow.screen.data.speech, vm.chip)
            : renderPanel(vm, {
                surface: s,
                actions: { pending: flow.pending, press: (a) => void press(a) },
                error: flow.error,
                notice: flow.notice,
                // Bars move from the previous answer's values only on the render that brings new data.
                barsFrom: reason === 'layout' ? null : flow.barsFrom,
                onToggleMode: () => void rt.toggleDisplayMode(),
              });
      } else if (message) {
        node = messageScreen({ eyebrow: cfg.eyebrow, ...message });
      } else {
        node = waitingScreen({ ...cfg.waiting(input), shape: 'panel' });
      }
      rt.mount(node, reason, focus, () => {
        // Order matters: each fit measures what the one before it left.
        fitStrips(node);
        fitDecision(node, s);
        fold.apply(node, s);
        keepHeadsWithContent(node, s);
      });
      fold.afterMount(node);
      if (reason !== 'layout') scheduleRefresh();
    }

    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;
    let refreshedFor = '';

    async function refresh(): Promise<void> {
      const call = dueRefresh(flow, rt.time().nowMs);
      if (!flow || flow.pending || !call || refreshing) return;
      // Ask once per due check; a newer result from the host or the person replaces the screen anyway.
      const key = `${String(call.arguments.ref_id)}@${flow.screen.kind === 'repair' && 'next_check_at' in flow.screen.data ? flow.screen.data.next_check_at : ''}`;
      if (key === refreshedFor) return;
      refreshedFor = key;
      refreshing = true;
      const outcome = await rt.call(call);
      refreshing = false;
      const cur = flow?.screen;
      if (!outcome.ok || outcome.payload.kind !== 'repair' || cur?.kind !== 'repair') return;
      if (outcome.payload.data.repair_id !== cur.data.repair_id || flow?.pending) return;
      flow = { ...startFlow(outcome.payload), ...(flow?.subject ? { subject: flow.subject } : {}) };
      render('result');
      rt.announce(outcome.payload.data.speech);
    }

    function scheduleRefresh(): void {
      clearTimeout(refreshTimer);
      const s = flow?.screen;
      if (!s || s.kind !== 'repair' || s.data.state !== 'applied' || !s.data.next_check_at) return;
      const wait = Date.parse(s.data.next_check_at) - rt.time().nowMs + REFRESH_GRACE_MS;
      if (Number.isFinite(wait) && wait > 0 && wait <= MAX_REFRESH_WAIT_MS) refreshTimer = setTimeout(() => void refresh(), wait);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void refresh();
    });

    async function press(a: ActionVM): Promise<void> {
      if (!flow || flow.pending) return;
      if (a.local === 'cancel') {
        flow = cancelPlan(flow);
        render('action', 'primary');
        return;
      }
      if (a.ask) {
        // The host routes the words and shows its own result, which replaces this screen.
        flow = beginAction(flow, a.id);
        const asked = flow;
        render('layout');
        rt.announce(`${a.pendingLabel}.`);
        const ok = await rt.ask(a.ask);
        if (flow !== asked) return;
        flow = { ...flow, pending: null, error: ok ? null : FALLBACK_PROBLEM };
        render('layout');
        if (!ok) rt.announce(FALLBACK_PROBLEM);
        return;
      }
      if (!a.tool) return;
      flow = beginAction(flow, a.id);
      resentDuringAction = false;
      const started = flow;
      render('layout');
      rt.announce(`${a.pendingLabel}.`);
      const answer: ToolOutcome = await rt.call(a.tool);
      // The host may have shown a newer result meanwhile; that one wins.
      if (flow !== started) return;
      const outcome = resentDuringAction ? asDeclined(answer) : answer;
      resentDuringAction = false;
      flow = finishAction(flow, a.id, outcome, cfg.accepts);
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
      onInput(args) {
        input = args;
        if (!flow) render('layout');
      },
      onResult(outcome) {
        if (!outcome.ok) {
          flow = null;
          message = { title: "That didn't work", text: outcome.problem.speech, chip: NOT_DONE };
        } else if (outcome.payload.kind === 'checkup' || !cfg.accepts.includes(outcome.payload.kind)) {
          flow = null;
          message = { title: 'Nothing to show here', text: UNREADABLE_PROBLEM, chip: NOTHING };
        } else if (flow && isResend(flow, outcome.payload)) {
          // apps/host resends the showing screen before it denies a declined approval: keep the flow and its call.
          if (flow.pending) resentDuringAction = true;
          render('layout');
          return;
        } else {
          flow = fromHost(flow, outcome.payload);
          message = null;
        }
        render('result');
        rt.reportPaint({ via: 'tool-result', kind: outcome.ok ? outcome.payload.kind : 'problem' });
      },
      onCancelled() {
        if (flow) return;
        message = { title: 'Stopped', text: 'This request was cancelled before it finished.', chip: STOPPED };
        render('layout');
      },
      relayout() {
        render('layout');
        // A host with a simulated clock moves dev.fixwright/now forward: pick up a check that is now due.
        void refresh();
      },
      debugState: () => ({ flow, input, message, stepsOpen: fold.isOpen() }),
    };
  });
}
