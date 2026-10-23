// The postMessage bridge is the only channel to the host, so everything host facing goes through here.
import { App, applyDocumentTheme, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { anchorClock, anchoredNow, fitsCanvas, readHints, resolveSurface, surfaceClasses, type ClockAnchor, type StepHints, type Surface } from './context.ts';
import { byId } from './dom.ts';
import { DECLINED_NOTE, FALLBACK_PROBLEM, isDeclineMessage, readToolResult, type ToolOutcome } from './payload.ts';
import type { TimeContext, ToolCall } from './vm.ts';

export type ViewName = 'stepper' | 'carousel' | 'repair-card';
export const VIEW_VERSION = '0.1.0';

export type RenderReason = 'result' | 'action' | 'layout';

export type FocusRequest = 'keep' | 'primary' | ((root: HTMLElement) => HTMLElement | null);

export interface ViewHooks {
  onInput?(args: Record<string, unknown>): void;
  onResult(outcome: ToolOutcome): void;
  onCancelled?(): void;
  /** New surface, theme or display mode, no new data. */
  relayout(): void;
  /** For tests and the demo video: window.__fixwrightView.state(). */
  debugState?(): unknown;
}

export interface Runtime {
  readonly name: ViewName;
  surface(): Surface;
  time(): TimeContext;
  hints(): StepHints;
  call(tool: ToolCall): Promise<ToolOutcome>;
  canAsk(): boolean;
  /** ui/message: words in the conversation as the person's. Resolves true when the host took them. */
  ask(text: string): Promise<boolean>;
  announce(text: string): void;
  reducedMotion(): boolean;
  toggleDisplayMode(): Promise<void>;
  /** Focus moves only when it was already inside the view, so nothing is stolen. */
  mount(node: Node, reason: RenderReason, focus?: FocusRequest, fit?: () => void): void;
  /** Tell the conversation what changed through the view, so voice can pick up where touch left off. */
  shareWithModel(text: string, structured: Record<string, unknown>): void;
  /** Report the first paint after a tool result (double rAF), used for the 500 ms first item budget. */
  reportPaint(meta: Record<string, unknown>): void;
}

interface DebugHandle {
  name: ViewName;
  version: string;
  surface(): Surface;
  state(): unknown;
  hostContext(): McpUiHostContext | undefined;
}

declare global {
  interface Window {
    __fixwrightView?: DebugHandle;
  }
}

const now = () => performance.timeOrigin + performance.now();

export function startView(name: ViewName, makeHooks: (rt: Runtime) => ViewHooks): Runtime {
  const root = document.documentElement;
  const stage = byId('stage');
  const appEl = byId('app');
  const live = byId('live');
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const lightQuery = window.matchMedia('(prefers-color-scheme: light)');

  const app = new App({ name: `fixwright-${name}`, version: VIEW_VERSION }, { availableDisplayModes: ['inline', 'fullscreen'] }, { autoResize: true });

  let surface: Surface = resolveSurface(undefined, viewport());
  let modeOverride: Surface['displayMode'] | null = null;
  let receivedAt = 0;
  let paintReportedFor = -1;
  let warnedDerived = false;
  let clock: ClockAnchor | null = null;

  function viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function context(): McpUiHostContext | undefined {
    return app.getHostContext();
  }

  function applySurface(): void {
    const ctx = context();
    clock = anchorClock(clock, ctx, Date.now());
    const s = resolveSurface(ctx, viewport());
    surface = modeOverride ? { ...s, displayMode: modeOverride } : s;
    if (surface.theme) applyDocumentTheme(surface.theme);
    else root.dataset.theme = lightQuery.matches ? 'light' : 'dark';
    for (const c of [...root.classList]) if (/^(dc|mode|orient|h)-/.test(c)) root.classList.remove(c);
    root.classList.add(...surfaceClasses(surface));
    stage.style.setProperty('zoom', String(surface.scale));
    stage.style.width = `${surface.canvasWidth}px`;
    stage.style.height = surface.canvasHeight === null ? 'auto' : `${surface.canvasHeight}px`;
    // A growing frame with a cap (the phone transcript) never outgrows it; the card scrolls inside.
    if (surface.canvasMaxHeight === null) root.style.removeProperty('--max-h');
    else root.style.setProperty('--max-h', `${surface.canvasMaxHeight}px`);
    root.style.setProperty('--inset-top', `${surface.insets.top / surface.scale}px`);
    root.style.setProperty('--inset-bottom', `${surface.insets.bottom / surface.scale}px`);
    if (ctx && surface.classSource === 'derived' && !warnedDerived) {
      warnedDerived = true;
      // Design guide: deviceClass is authoritative; size heuristics are a fallback, so say so at dev time.
      console.warn(`[fixwright ${name}] host sent no dev.fixwright/deviceClass; using ${surface.deviceClass} from the container size`);
    }
  }

  const rt: Runtime = {
    name,
    surface: () => surface,
    time: () => ({ locale: surface.locale, timeZone: surface.timeZone, nowMs: anchoredNow(clock, Date.now()) }),
    hints: () => readHints(context()),
    async call(tool) {
      try {
        const result = await app.callServerTool({ name: tool.name, arguments: tool.arguments });
        receivedAt = now();
        return readToolResult(result);
      } catch (e) {
        // A host that follows the decline convention denies with DECLINED_NOTE. Other host text may be
        // technical, so it stays out of the view.
        const message = e instanceof Error ? e.message : String(e);
        if (isDeclineMessage(message)) return { ok: false, problem: { speech: DECLINED_NOTE, retryable: true, declined: true } };
        return { ok: false, problem: { speech: FALLBACK_PROBLEM, retryable: true } };
      }
    },
    canAsk: () => Boolean(app.getHostCapabilities()?.message),
    async ask(text) {
      if (!rt.canAsk()) return false;
      try {
        const res = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
        return res.isError !== true;
      } catch {
        return false;
      }
    },
    announce(text) {
      live.textContent = '';
      requestAnimationFrame(() => {
        live.textContent = text;
      });
    },
    reducedMotion: () => motionQuery.matches,
    async toggleDisplayMode() {
      const target = surface.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
      try {
        const res = await app.requestDisplayMode({ mode: target });
        modeOverride = res.mode === 'fullscreen' || res.mode === 'inline' ? res.mode : null;
      } catch {
        modeOverride = null;
      }
      applySurface();
      hooks.relayout();
    },
    mount(node, reason, focus = 'keep', fit) {
      const active = document.activeElement instanceof HTMLElement && appEl.contains(document.activeElement) ? document.activeElement : null;
      const activeKey = active?.dataset.action;
      appEl.classList.toggle('enter', reason !== 'layout' && !motionQuery.matches);
      appEl.replaceChildren(node);
      appEl.setAttribute('aria-busy', 'false');
      fit?.();
      if (!active) return;
      const same = activeKey ? appEl.querySelector<HTMLElement>(`[data-action="${CSS.escape(activeKey)}"]`) : null;
      const primary = appEl.querySelector<HTMLElement>('.btn-primary') ?? appEl.querySelector<HTMLElement>('.btn');
      const picked = typeof focus === 'function' ? focus(appEl) : null;
      const target = picked ?? (focus === 'primary' ? (primary ?? appEl.querySelector<HTMLElement>('#view-title')) : (same ?? primary));
      // A fixed landscape card is laid out to fit and must not scroll: scrolling it to a focused button cuts
      // its header. Portrait and growing frames scroll by design, so focus brings it into view.
      target?.focus({ preventScroll: fitsCanvas(surface) });
    },
    shareWithModel(text, structured) {
      if (!app.getHostCapabilities()?.updateModelContext) return;
      app.updateModelContext({ content: [{ type: 'text', text }], structuredContent: structured }).catch(() => undefined);
    },
    reportPaint(meta) {
      const at = receivedAt;
      if (at === paintReportedFor) return;
      paintReportedFor = at;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const paintedAt = now();
          root.dataset.paintedAt = String(paintedAt);
          root.dataset.receivedAt = String(at);
          app.sendLog({ level: 'info', logger: 'fixwright.view', data: { event: 'painted', view: name, receivedAt: at, paintedAt, ...meta } }).catch(() => undefined);
        }),
      );
    },
  };

  const hooks = makeHooks(rt);

  app.ontoolinput = (params) => {
    applySurface();
    hooks.onInput?.((params.arguments ?? {}) as Record<string, unknown>);
  };
  app.ontoolresult = (result) => {
    receivedAt = now();
    applySurface();
    hooks.onResult(readToolResult(result));
  };
  app.ontoolcancelled = () => hooks.onCancelled?.();
  app.onhostcontextchanged = (partial) => {
    if ('displayMode' in partial) modeOverride = null;
    applySurface();
    hooks.relayout();
  };
  app.onteardown = async () => ({});
  app.onerror = (e) => console.error(`[fixwright ${name}]`, e);

  let resizeQueued = false;
  window.addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      applySurface();
      hooks.relayout();
    });
  });
  lightQuery.addEventListener('change', () => {
    if (!surface.theme) {
      applySurface();
      hooks.relayout();
    }
  });

  window.__fixwrightView = { name, version: VIEW_VERSION, surface: () => surface, state: () => hooks.debugState?.(), hostContext: context };

  applySurface();
  hooks.relayout();
  app
    .connect()
    .then(() => {
      applySurface();
      hooks.relayout();
    })
    .catch((e: unknown) => console.error(`[fixwright ${name}] could not connect to the host`, e));
  return rt;
}
