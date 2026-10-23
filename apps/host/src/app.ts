// The host simulator's behavior: what the person says becomes MCP tool calls, the result's view renders
// on the current device, the reply is spoken, and the demo controls run here. The DOM lives in ui/.

import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { ToolName } from '@fixwright/protocol';
import { applyResult, consentOf, initialState, isToolRoute, REPLIES, repairForText, routeUtterance, type Intent, type Route, type ToolRoute } from '@fixwright/router';
import { approvalFor, tapWords } from './approval.ts';
import { createClock, type HostClock } from './clock.ts';
import type { HostConfig } from './config.ts';
import { browserStorage, createDemoApi, loadHousehold, saveHousehold, type DemoApi, type DemoResponse } from './demo-api.ts';
import { DEVICES, HOUSE_TIME_ZONE, type DeviceClass, type Theme } from './devices.ts';
import { faultInfo } from './faults.ts';
import { flashMoment, flashProbe, morningMoment, readHouse, restoreMoment, wallAt, type HouseRead, type MomentDraft } from './house.ts';
import { HOST_INFO, connectMcp, speechOf, type McpSession } from './mcp.ts';
import { dueRepairRef, isBackgroundCall, requiresApproval, toolResourceUri } from './policy.ts';
import { createStore, type AppState, type HouseLogEntry, type PushNote, type ReplyCard, type Store, type TabId, type TranscriptEntry } from './state.ts';
import { clearerLabels, readHome, type HomeEntity, type PlanSteps } from './step-labels.ts';
import { createTrace, type TraceStore } from './trace.ts';
import { createViewHost, type ApprovalRequest, type ViewCallResult, type ViewHost } from './view-host.ts';
import { createListener, createSpeaker, type Listener, type Speaker } from './voice.ts';

export const DEVICE_CLASS_KEY = 'dev.fixwright/deviceClass';
/** The host clock for views (apps/views README): drives "tomorrow at 7:00 AM" and the morning refresh. */
export const NOW_KEY = 'dev.fixwright/now';
/** The person's words that led to the screen (apps/views README): a finished repair lists those devices first. */
export const FOCUS_KEY = 'dev.fixwright/focus';
/** Clearer step labels for two devices that share a name, keyed `${plan_id}|${label}` (step-labels.ts). */
export const STEP_LABELS_KEY = 'dev.fixwright/stepLabels';
/** What the views' header tag says for a linked Home Assistant (apps/views README). */
export const HUB_LABEL_KEY = 'dev.fixwright/hubLabel';

/** Requests that set what the conversation is about; a yes, a no or an answer keeps the earlier one. */
const FOCUS_INTENTS: ReadonlySet<Intent> = new Set(['diagnose', 'explain', 'checkup', 'status', 'switch', 'protect', 'unprotect', 'fix_finding', 'undo']);
const MAX_FOCUS = 300;
const MAX_PLANS = 20;

/**
 * How an approval sheet closed. 'tap': a button on the sheet. 'spoken': the person said yes or no
 * (their words are already in the transcript). 'dismissed': the screen went away (voice only), so
 * the host says nothing changed. 'closed': replaced by a new request, a new sheet or a reset.
 */
type ApprovalEnd = 'tap' | 'spoken' | 'dismissed' | 'closed';

export interface HostEvent {
  t: number;
  type: string;
  detail?: unknown;
}

export interface HostApp {
  readonly config: HostConfig;
  readonly events: readonly HostEvent[];
  readonly store: Store<AppState>;
  readonly trace: TraceStore;
  readonly clock: HostClock;
  readonly spoken: readonly string[];
  readonly session: McpSession | null;
  readonly views: ViewHost;
  readonly listener: Listener;
  ready(): Promise<void>;
  say(text: string, via?: TranscriptEntry['via']): Promise<void>;
  setDevice(device: DeviceClass): Promise<void>;
  setTheme(theme: Theme): void;
  setTab(tab: TabId): void;
  /** Pin the host clock (ISO or ms), or null to follow real time; views get the new time too. */
  setClock(time: string | number | null): void;
  /** The ambient ticker: redraws the clock and keeps the views' copy of the host clock current. */
  tick(): void;
  dismissToast(): void;
  /** The person tapped a push: show the repair it is about (the one its words name, else the newest). */
  openPush(push: PushNote): Promise<void>;
  answerApproval(allow: boolean): void;
  injectFault(id: string): Promise<DemoResponse>;
  resetHouse(): Promise<DemoResponse>;
  jumpClock(to: 'next_morning' | number): Promise<DemoResponse>;
  newHousehold(): Promise<void>;
  idle(): Promise<void>;
  mountViewSlot(slot: HTMLElement): void;
}

const ACTIVITY: Record<string, (args: Record<string, unknown>) => string> = {
  diagnose: (a) => (typeof a['device'] === 'string' ? `Checking the ${a['device']}` : 'Running the checks'),
  diagnose_answer: () => 'Weighing your answer',
  explain_event: () => "Reading your home's logs",
  home_checkup: () => 'Checking the whole house',
  repair_plan: () => 'Preparing a dry run',
  repair_apply: () => 'Applying the fix',
  repair_status: () => 'Checking on the fix',
  undo: () => 'Putting it back',
  switch_device: () => 'Switching it',
  protect_device: () => 'Saving that',
};

// Tools that can change a device or carry a moment. The plan is read after these only, because the demo
// routes allow 30 requests a minute per address (apps/server RATE_DEMO_PER_MIN).
const HOUSE_READS: ReadonlySet<string> = new Set(['diagnose', 'diagnose_answer', 'explain_event', 'repair_apply', 'undo', 'switch_device']);
/** Tools whose changes the plan marks. A flash puts the lamp back, so diagnose marks nothing. */
const HOUSE_CHANGES: ReadonlySet<string> = new Set(['repair_apply', 'undo', 'switch_device']);

const UNREACHABLE = "I couldn't reach Fixwright just now. Try again in a minute.";
const DECLINED = 'Okay. Nothing changed.';
const TOAST_MS = 12_000;

export function createHostApp(config: HostConfig): HostApp {
  const clock = createClock();
  const trace = createTrace(() => performance.now());
  const spoken: string[] = [];
  let session: McpSession | null = null;
  let entryId = 0;
  let logId = 0;
  let inflight = 0;
  let idleWaiters: Array<() => void> = [];
  // The newest result with a view, from the router or from a view's own call. A device switch back
  // from voice only shows it again. lastViewAt orders the two sources: a view's result counts only if
  // nothing newer was shown while its call ran.
  let lastView: { tool: Tool; args: Record<string, unknown>; result: CallToolResult } | null = null;
  let lastViewAt = 0;
  let tickMinute = 0;
  let approvalResolve: ((allow: boolean, end: ApprovalEnd) => void) | null = null;
  let viewSlot: HTMLElement | null = null;
  // What the views are told about the steps on screen: the person's words, and clearer labels from the
  // home's device list (/demo/state) and each plan's exact changes.
  let focus: string | null = null;
  let home: HomeEntity[] = [];
  const plans = new Map<string, PlanSteps>();
  let stepLabels: Record<string, string[]> = {};
  /** The header tag for a linked Home Assistant; empty for the simulated house. */
  let hubLabel = '';
  // Host-side events (approvals, refusals, transport errors). Kept apart from the Visual Trace,
  // which shows only real JSON-RPC messages.
  const events: HostEvent[] = [];
  const logEvent = (type: string, detail?: unknown): void => {
    events.push({ t: performance.now(), type, ...(detail === undefined ? {} : { detail }) });
    if (events.length > 500) events.splice(0, events.length - 500);
  };

  const store = createStore<AppState>({
    device: config.device,
    theme: config.theme,
    tab: 'conversation',
    connection: { status: 'connecting', tools: 0 },
    transcript: [],
    busy: null,
    speaking: null,
    listening: false,
    interim: '',
    viewTool: null,
    replyCard: null,
    approval: null,
    household: loadHousehold(browserStorage, config.serverUrl),
    houseLog: [],
    pushes: [],
    toast: null,
    toastAfter: 0,
    activeFaults: null,
    conversation: initialState(),
    house: null,
    moment: null,
    momentAt: null,
    changed: [],
    clockKnown: false,
    tick: 0,
    micSupported: false,
  });

  const demo: DemoApi = createDemoApi(config.serverUrl, () => store.get().household?.token ?? null);

  const speaker: Speaker = createSpeaker(
    {
      onStart: (text) => store.set({ speaking: text }),
      onEnd: () => store.set({ speaking: null }),
    },
    { muted: config.testMode },
  );

  const listener: Listener = createListener({
    onInterim: (text) => store.set({ interim: text }),
    onFinal: (text) => {
      store.set({ interim: '' });
      if (text) void say(text, 'voice');
    },
    onState: (listening) => store.set({ listening, ...(listening ? {} : { interim: '' }) }),
    onError: (message) => addEntry({ role: 'assistant', text: message }),
  });
  store.set({ micSupported: listener.supported });

  function addEntry(e: Omit<TranscriptEntry, 'id' | 'at'>): TranscriptEntry {
    const entry: TranscriptEntry = { ...e, id: ++entryId, at: clock.nowMs() };
    store.set((s) => ({ transcript: [...s.transcript, entry].slice(-200) }));
    return entry;
  }

  function speak(text: string): void {
    if (!text) return;
    spoken.push(text);
    speaker.speak(text);
  }

  function hostContext(tool?: Tool): McpUiHostContext {
    const s = store.get();
    const spec = DEVICES[s.device];
    return {
      theme: s.theme,
      displayMode: 'inline',
      availableDisplayModes: ['inline'],
      containerDimensions: spec.container ?? { maxHeight: 0 },
      locale: 'en-US',
      timeZone: HOUSE_TIME_ZONE,
      userAgent: `${HOST_INFO.name}/${config.version}`,
      platform: spec.platform,
      deviceCapabilities: { touch: true, hover: false },
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      ...(tool ? { toolInfo: { tool } } : {}),
      [DEVICE_CLASS_KEY]: s.device,
      // Whole seconds: an unchanged clock sends no host-context-changed at all (AppBridge diffs).
      [NOW_KEY]: new Date(Math.floor(clock.nowMs() / 1000) * 1000).toISOString(),
      // Always sent (an empty focus clears an old one: host-context-changed carries changed keys only).
      [FOCUS_KEY]: focus ?? '',
      [STEP_LABELS_KEY]: stepLabels,
      [HUB_LABEL_KEY]: hubLabel,
    };
  }

  const labelsOf = (sc: Record<string, unknown>): string[] =>
    Array.isArray(sc['steps']) ? sc['steps'].map((x) => (x as { label?: unknown } | null)?.label).filter((l): l is string => typeof l === 'string') : [];

  /** A plan, or a repair of a known plan: clearer labels for its steps, sent to the view. */
  function noteSteps(name: string, sc: unknown): void {
    const o = sc as Record<string, unknown> | null;
    const planId = typeof o?.['plan_id'] === 'string' ? o['plan_id'] : null;
    if (!o || !planId) return;
    if (name === 'repair_plan' && Array.isArray(o['diff'])) {
      const entityIds = o['diff'].map((d) => (d as { entity_id?: unknown } | null)?.entity_id).filter((x): x is string => typeof x === 'string');
      plans.set(planId, { plan_id: planId, entityIds, labels: labelsOf(o) });
      if (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value as string);
    }
    const plan = plans.get(planId);
    if (!plan) return;
    const labels = name === 'repair_plan' ? plan.labels : labelsOf(o);
    const found = clearerLabels({ ...plan, labels }, home);
    if (Object.keys(found).length === 0) return;
    stepLabels = { ...stepLabels, ...found };
    views.refreshContext();
  }

  let momentId = 0;
  const seenFlashes = new Set<string>();
  const houseZone = (): string => store.get().house?.clock?.tz ?? HOUSE_TIME_ZONE;

  function applyRead(read: HouseRead): void {
    if (!read.rooms && !read.clock) return;
    store.set((s) => ({ house: { rooms: read.rooms ?? s.house?.rooms ?? [], clock: read.clock ?? s.house?.clock ?? null } }));
  }

  function play(draft: MomentDraft | null): void {
    if (draft) store.set({ moment: { ...draft, id: ++momentId } });
  }

  /** Reads the plan after a tool call that can change it, and plays the moment the call logged. */
  async function afterTool(name: string, result: CallToolResult): Promise<void> {
    if (!HOUSE_READS.has(name) || result.isError) return;
    const sc = result.structuredContent;
    const flash = name === 'diagnose' || name === 'diagnose_answer' ? flashProbe(sc) : null;
    const fresh = flash !== null && !seenFlashes.has(flash.key);
    if (flash) seenFlashes.add(flash.key);
    const st = await demo.state();
    if (!st.ok) return;
    const before = new Map((store.get().house?.rooms ?? []).flatMap((r) => r.dots.map((d) => [d.entityId, d.state] as const)));
    applyRead(readHouse(st.body));
    const rooms = store.get().house?.rooms ?? null;
    if (HOUSE_CHANGES.has(name)) {
      const changed = (rooms ?? []).flatMap((r) => r.dots).filter((d) => before.has(d.entityId) && before.get(d.entityId) !== d.state).map((d) => d.entityId);
      store.set({ changed });
    }
    if (fresh) play(flashMoment(sc, rooms));
    if (name === 'explain_event') play(restoreMoment(sc, rooms, houseZone(), wallAt(clock.nowMs(), houseZone())));
  }

  /** The home's devices changed (a new household, a fault, a reset): label every plan again. */
  function relabelAll(): void {
    stepLabels = {};
    for (const plan of plans.values()) stepLabels = { ...stepLabels, ...clearerLabels(plan, home) };
    views.refreshContext();
  }

  function track<T>(p: Promise<T>): Promise<T> {
    inflight++;
    return p.finally(() => {
      inflight--;
      settleIdle();
    });
  }

  // Idle means nothing more happens without the person: no tool call, view render or view started
  // call in flight, or the only thing left is an approval waiting for their answer.
  function isIdle(): boolean {
    return !views.rendering && (inflight === 0 || store.get().approval !== null);
  }

  function settleIdle(): void {
    if (!isIdle()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  }

  async function approve(req: ApprovalRequest): Promise<boolean> {
    approvalResolve?.(false, 'closed');
    const approval = approvalFor(req, store.get().conversation);
    const { confirm } = approval;
    store.set({ approval });
    logEvent('approval asked', { name: req.tool.name, via: req.via === 'message' ? 'ui/message' : 'tools/call' });
    // A voice first device asks out loud too; the person may answer by voice (see say()).
    speak(approval.title);
    settleIdle();
    return new Promise<boolean>((resolve) => {
      approvalResolve = (allow, end) => {
        approvalResolve = null;
        store.set({ approval: null });
        if (end === 'tap') addEntry({ role: 'user', text: allow ? `${confirm}.` : 'Not now.', via: 'approval' });
        if (!allow && end !== 'closed') {
          addEntry({ role: 'assistant', text: DECLINED });
          speak(DECLINED);
        }
        if (end === 'dismissed' || end === 'closed') logEvent('approval closed', { name: req.tool.name, reason: end });
        resolve(allow);
      };
    });
  }

  /** Keep the newest result with a view, so a device switch back from voice only shows it. */
  function rememberView(tool: Tool, args: Record<string, unknown>, result: CallToolResult): void {
    lastView = { tool, args, result };
    lastViewAt = performance.now();
  }

  /** A view's own call finished: fold it in like any turn, and make it the screen to come back to. */
  function onViewToolResult(call: ViewCallResult): void {
    const { tool, args, result, ms, startedAt, shownTool } = call;
    if (isBackgroundCall(tool)) {
      // refresh_view and the like: the view updates itself quietly. No turn, nothing spoken.
      store.set((s) => ({
        conversation: applyResult(s.conversation, { tool: tool.name as ToolName, arguments: args, structuredContent: result.structuredContent, isError: result.isError === true }),
      }));
      logEvent('view refreshed', { name: tool.name, isError: result.isError === true });
    } else {
      recordResult(tool.name, args, result, 'view', ms);
      void track(afterTool(tool.name, result));
    }
    if (result.isError || !result.structuredContent || startedAt < lastViewAt) return;
    if (toolResourceUri(tool)) {
      rememberView(tool, args, result);
      if (store.get().device !== 'voice') store.set({ viewTool: tool.name, replyCard: null });
    } else {
      // A tool without its own view (refresh_view): same screen, newer content.
      rememberView(lastView?.tool ?? shownTool, lastView?.args ?? {}, result);
    }
  }

  const views: ViewHost = createViewHost({
    get slot(): HTMLElement {
      if (!viewSlot) throw new Error('view slot not mounted');
      return viewSlot;
    },
    sandboxUrl: config.sandboxUrl,
    sandboxOrigin: config.sandboxOrigin,
    session: () => session,
    trace,
    hostContext: (tool) => hostContext(tool),
    approve,
    track,
    onViewTap: (tool, args) => addEntry({ role: 'user', text: tapWords(tool.name, args), via: 'tap' }),
    onViewToolResult,
    onViewMessage: (text) => void say(text, 'view'),
    onSize: (size) => {
      if (store.get().device === 'phone' && viewSlot && typeof size.height === 'number') {
        viewSlot.style.setProperty('--view-height', `${Math.min(size.height, 480)}px`);
      }
    },
    log: (type, detail) => logEvent(type, detail),
  });

  function recordResult(name: string, args: Record<string, unknown>, result: CallToolResult, origin: 'assistant' | 'view', ms: number): void {
    const sc = result.structuredContent as { status?: unknown } | undefined;
    store.set((s) => ({
      conversation: applyResult(s.conversation, { tool: name as ToolName, arguments: args, structuredContent: result.structuredContent, isError: result.isError === true }),
    }));
    if (!result.isError) noteSteps(name, result.structuredContent);
    const text = speechOf(result) || (result.isError ? UNREACHABLE : '');
    const tool = session?.tools.get(name);
    addEntry({
      role: 'assistant',
      text,
      tool: { name, title: tool?.title ?? name, status: typeof sc?.status === 'string' ? sc.status : result.isError ? 'error' : 'ok', ms, isError: result.isError === true, origin },
    });
    speak(text);
  }

  async function runTool(name: string, args: Record<string, unknown>, fromView = false): Promise<void> {
    const s = session;
    if (!s) {
      addEntry({ role: 'assistant', text: UNREACHABLE });
      speak(UNREACHABLE);
      return;
    }
    const label = ACTIVITY[name]?.(args) ?? 'Asking Fixwright';
    store.set({ busy: label, changed: [] });
    const t0 = performance.now();
    let result: CallToolResult;
    try {
      result = await s.callTool(name, args);
    } catch (e) {
      store.set({ busy: null });
      addEntry({ role: 'assistant', text: UNREACHABLE, tool: { name, title: name, status: 'unreachable', ms: performance.now() - t0, isError: true, origin: 'assistant' } });
      speak(UNREACHABLE);
      logEvent('transport error', { tool: name, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const ms = performance.now() - t0;
    store.set({ busy: null });
    const tool = s.tools.get(name);
    if (tool && !result.isError && toolResourceUri(tool)) {
      rememberView(tool, args, result);
      if (store.get().device !== 'voice') {
        recordResult(name, args, result, 'assistant', ms);
        await showView(tool, args, result);
        await afterTool(name, result);
        return;
      }
    }
    recordResult(name, args, result, 'assistant', ms);
    // A view's own message keeps its screen (the card that asked stays in place).
    if (tool && !fromView && !result.isError && !isBackgroundCall(tool) && !toolResourceUri(tool)) await showReply(name, result);
    await afterTool(name, result);
  }

  /** A turn without a view of its own replaces the screen with its words, never with an older card. */
  async function showReply(name: string, result: CallToolResult): Promise<void> {
    const text = speechOf(result);
    if (!text) return;
    const sc = result.structuredContent as { status?: unknown; switched?: { name?: unknown; state?: unknown } } | undefined;
    const sw = sc?.switched;
    const card: ReplyCard = {
      tool: name,
      status: typeof sc?.status === 'string' ? sc.status : 'ok',
      text,
      switched: typeof sw?.name === 'string' && typeof sw.state === 'string' ? { name: sw.name, state: sw.state } : null,
    };
    lastView = null;
    lastViewAt = performance.now();
    store.set({ replyCard: card });
    if (views.current) await views.teardown('answered in words');
    store.set({ viewTool: null });
  }

  /** Render a result's view. Speech already carried the meaning, so a failed render is logged, not fatal. */
  async function showView(tool: Tool, args: Record<string, unknown>, result: CallToolResult): Promise<void> {
    try {
      await views.show(tool, args, result);
      store.set({ viewTool: tool.name, replyCard: null });
    } catch (e) {
      logEvent('view failed', { tool: tool.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Show lastView again. A repair whose morning check came due meanwhile is refreshed first, which relies
   * on apps/server's refresh_view returning a repair's current status.
   */
  async function showLatest(): Promise<void> {
    if (!lastView) return;
    const { tool, args } = lastView;
    let { result } = lastView;
    const ref = dueRepairRef(result.structuredContent, clock.nowMs());
    if (ref && session) {
      try {
        const fresh = await session.callTool('refresh_view', { ref_id: ref });
        logEvent('view refreshed', { name: 'refresh_view', by: 'host', isError: fresh.isError === true });
        if (!fresh.isError && fresh.structuredContent) {
          result = fresh;
          rememberView(tool, args, fresh);
          store.set((s) => ({ conversation: applyResult(s.conversation, { tool: 'refresh_view', arguments: { ref_id: ref }, structuredContent: fresh.structuredContent }) }));
        }
      } catch {
        /* show what we have; the view refreshes itself once it can */
      }
    }
    await showView(tool, args, result);
  }

  async function route(text: string): Promise<Route> {
    const conv = store.get().conversation;
    if (config.routerMode === 'server') {
      try {
        return await demo.route(text, conv);
      } catch {
        /* fall back to the local copy of the same router */
      }
    }
    return routeUtterance(text, conv);
  }

  /**
   * A view's ui/message is routed like the person's words, so it could name a change ("yes" while a
   * plan waits, "undo that"). Spoken or typed words are the person's own yes; a view's are not, so
   * anything that is not read only waits for the approval sheet first.
   */
  async function approveViewMessage(said: string, r: ToolRoute): Promise<boolean> {
    const tool = session?.tools.get(r.tool) ?? { name: r.tool, inputSchema: { type: 'object' as const } };
    if (!requiresApproval(tool)) return true;
    const yes = await approve({ tool, args: r.arguments, via: 'message', said });
    logEvent(yes ? 'approval granted' : 'approval declined', { name: r.tool, via: 'ui/message' });
    return yes;
  }

  /**
   * The approval sheet is open and the person spoke. Their own yes or no answers it (a view's words
   * never do). Returns true when the words were the answer.
   */
  function answerOpenApproval(clean: string, via: TranscriptEntry['via']): boolean {
    const answer = consentOf(clean);
    if (answer === 'unclear' || !approvalResolve) return false;
    addEntry({ role: 'user', text: clean, via, intent: answer === 'yes' ? 'approve' : 'decline' });
    logEvent('approval answered', { name: store.get().approval?.tool, answer, by: 'voice' });
    approvalResolve(answer === 'yes', 'spoken');
    return true;
  }

  function say(text: string, via: TranscriptEntry['via'] = 'typed'): Promise<void> {
    const clean = text.trim();
    if (!clean) return Promise.resolve();
    if (via === 'view' && approvalResolve) {
      // The sheet waits for the person. A view may not answer it, close it or queue behind it.
      logEvent('view message ignored', { reason: 'approval open' });
      return Promise.resolve();
    }
    return track(
      (async () => {
        speaker.cancel();
        if (store.get().toast) store.set({ toast: null });
        if (approvalResolve && answerOpenApproval(clean, via)) return;
        const r = await route(clean);
        const sheet = approvalResolve ? store.get().approval : null;
        if (sheet && !isToolRoute(r)) {
          // Neither a yes, a no nor a new request: keep the sheet and ask again.
          addEntry({ role: 'user', text: clean, via });
          const again = `${sheet.title} Say yes or no.`;
          addEntry({ role: 'assistant', text: again });
          speak(again);
          return;
        }
        // A new request moves on: the sheet closes and nothing it asked about changes.
        if (sheet) approvalResolve?.(false, 'closed');
        if (isToolRoute(r) && FOCUS_INTENTS.has(r.intent)) focus = clean.slice(0, MAX_FOCUS);
        addEntry({ role: 'user', text: clean, via, intent: r.intent });
        if (isToolRoute(r)) {
          if (via === 'view' && !(await approveViewMessage(clean, r))) return;
          await runTool(r.tool, r.arguments, via === 'view');
        } else {
          if (r.state) store.set({ conversation: r.state });
          addEntry({ role: 'assistant', text: r.reply });
          speak(r.reply);
        }
      })(),
    );
  }

  function openPush(push: PushNote): Promise<void> {
    return track(
      (async () => {
        speaker.cancel();
        store.set({ toast: null });
        approvalResolve?.(false, 'closed');
        const conv = store.get().conversation;
        // The push names its device ("Hallway lamp answered all 9 commands overnight."): that repair.
        const repairId = repairForText(push.message, conv) ?? conv.last.repair_id;
        addEntry({ role: 'user', text: 'Show me that repair.', via: 'tap', intent: 'status' });
        logEvent('push opened', { title: push.title, repair_id: repairId });
        if (!repairId) {
          addEntry({ role: 'assistant', text: REPLIES.noRepairYet });
          speak(REPLIES.noRepairYet);
          return;
        }
        focus = push.message.slice(0, MAX_FOCUS);
        await runTool('repair_status', { repair_id: repairId });
      })(),
    );
  }

  async function setDevice(device: DeviceClass): Promise<void> {
    const prev = store.get().device;
    if (prev === device) return;
    store.set({ device });
    if (device === 'voice') {
      approvalResolve?.(false, 'dismissed'); // the screen that asked is going away
      await views.teardown('voice only');
      store.set({ viewTool: null });
    } else if (prev === 'voice' && lastView) {
      await track(showLatest());
    } else {
      views.refreshContext();
    }
  }

  function logDemo(action: string, r: DemoResponse): void {
    const body = r.body as Record<string, unknown> | null;
    const summary = r.ok
      ? Array.isArray(body?.['active_faults'])
        ? `${(body['active_faults'] as string[]).length} faults active`
        : typeof body?.['now'] === 'string'
          ? `House time ${body['now']}`
          : 'Done'
      : `Failed (${r.status || 'network'})`;
    const entry: HouseLogEntry = { id: ++logId, action, ok: r.ok, status: r.status, ms: r.ms, summary };
    store.set((s) => ({ houseLog: [entry, ...s.houseLog].slice(0, 30) }));
  }

  /**
   * Read active faults (and the house clock) from a demo response, or ask /demo/state. `moved`: the
   * house clock itself changed (a reset, a new household), so a pinned host clock moves with it; a
   * plain reading never replaces a pin the test hook or the video pipeline made.
   */
  async function syncHouse(r: DemoResponse | null, moved = false): Promise<void> {
    const pick = (b: unknown): string[] | null => {
      const o = b as Record<string, unknown> | null;
      const list = o?.['active_faults'] ?? o?.['activeFaults'];
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : null;
    };
    let faults = r?.ok ? pick(r.body) : null;
    // /demo/state is read every time: the home's device list comes only with it, and a fault or a reset
    // can change the names in it.
    const fromResponse = faults !== null;
    const stamp = clock.mark();
    const st = await demo.state();
    // The clock first: the plan's wall is painted from house time as soon as the house arrives.
    const synced = !fromResponse && st.ok && typeof (st.body as { now?: unknown } | null)?.now === 'string' && clock.syncTo((st.body as { now: string }).now, { moved, stamp });
    if (st.ok) applyRead(readHouse(st.body));
    if (synced) views.refreshContext();
    if (st.ok) {
      const adapter = (st.body as { adapter?: unknown } | null)?.adapter;
      const label = adapter === 'home-assistant' ? config.hubLabel : '';
      if (label !== hubLabel) {
        hubLabel = label;
        views.refreshContext();
      }
    }
    if (!fromResponse) faults = st.ok ? pick(st.body) : null;
    const devices = st.ok ? readHome(st.body) : null;
    if (devices) {
      home = devices;
      relabelAll();
    }
    store.set((s) => ({ activeFaults: faults ?? s.activeFaults, tick: s.tick + 1, clockKnown: true }));
  }

  async function clearScreen(): Promise<void> {
    approvalResolve?.(false, 'closed');
    lastView = null;
    lastViewAt = performance.now();
    await views.teardown('house changed');
    store.set({ viewTool: null, replyCard: null, changed: [], conversation: initialState(), pushes: [], toast: null, moment: null });
    seenFlashes.clear();
    focus = null;
    plans.clear();
    stepLabels = {};
  }

  async function jumpClock(to: 'next_morning' | number): Promise<DemoResponse> {
    const stamp = clock.mark();
    const r = await demo.clock(to);
    logDemo(to === 'next_morning' ? 'Clock: next morning 7:00' : `Clock: +${Math.round(to / 60000)} min`, r);
    const body = r.body as { now?: unknown; pushes?: unknown } | null;
    // The house clock moved: a pinned host clock moves with it (unless a newer pin came meanwhile).
    if (r.ok && typeof body?.now === 'string') clock.syncTo(body.now, { moved: true, stamp });
    const pushes = Array.isArray(body?.pushes) ? (body.pushes as PushNote[]).filter((p) => typeof p?.message === 'string' && typeof p?.title === 'string') : [];
    const toast = pushes[0] ?? null;
    if (toast) {
      // The push is the newest thing on the device, so the captions show it until the next turn.
      store.set((s) => ({ pushes: [...pushes, ...s.pushes].slice(0, 20), toast, toastAfter: entryId }));
      play(morningMoment(clock.nowMs(), houseZone()));
      if (!config.testMode) {
        setTimeout(() => {
          if (store.get().toast === toast) store.set({ toast: null });
        }, TOAST_MS);
      }
    }
    store.set((s) => ({ tick: s.tick + 1 }));
    // The views follow the house clock: the repair card now sees its morning check as due.
    views.refreshContext();
    await track(syncHouse(null));
    return r;
  }

  let readyPromise: Promise<void> | null = null;
  function ready(): Promise<void> {
    readyPromise ??= (async () => {
      if (!store.get().household) {
        const h = await demo.createHousehold();
        if (h) {
          saveHousehold(browserStorage, config.serverUrl, h);
          store.set({ household: h });
        }
      }
      try {
        session = await connectMcp({ mcpUrl: config.mcpUrl, trace, session: 1, token: () => store.get().household?.token ?? null });
        store.set({
          connection: {
            status: 'ready',
            protocolVersion: session.protocolVersion,
            era: session.era,
            server: session.serverInfo,
            tools: session.tools.size,
          },
        });
        // Awaited: once ready() resolves, the house time is in and nothing lands later, so a
        // setClock() right after ready() holds (and a pin made earlier holds too: a reading never
        // replaces a pin).
        await syncHouse(null);
      } catch (e) {
        store.set({ connection: { status: 'error', tools: 0, error: e instanceof Error ? e.message : String(e) }, clockKnown: true });
      }
    })();
    return readyPromise;
  }

  return {
    config,
    events,
    store,
    trace,
    clock,
    spoken,
    get session() {
      return session;
    },
    views,
    listener,
    ready,
    say,
    setDevice: (d) => track(setDevice(d)),
    setTheme(theme) {
      store.set({ theme });
      views.refreshContext();
    },
    setTab: (tab) => store.set({ tab }),
    setClock(time) {
      clock.pin(time);
      store.set((s) => ({ tick: s.tick + 1, clockKnown: true }));
      views.refreshContext();
    },
    tick() {
      store.set((s) => ({ tick: s.tick + 1 }));
      // Once a minute is enough for the views' "tomorrow at 7:00 AM" and a due morning check.
      const minute = Math.floor(clock.nowMs() / 60_000);
      if (minute !== tickMinute) {
        tickMinute = minute;
        views.refreshContext();
      }
    },
    dismissToast: () => store.set({ toast: null }),
    openPush,
    answerApproval(allow) {
      approvalResolve?.(allow, 'tap');
    },
    async injectFault(id) {
      const r = await demo.fault(id);
      logDemo(`Break: ${faultInfo(id)?.title ?? id}`, r);
      await syncHouse(r);
      return r;
    },
    async resetHouse() {
      const r = await demo.reset();
      logDemo('Reset the house', r);
      await clearScreen();
      await syncHouse(r, true);
      return r;
    },
    jumpClock,
    async newHousehold() {
      const h = await demo.createHousehold();
      saveHousehold(browserStorage, config.serverUrl, h);
      store.set({ household: h });
      await clearScreen();
      logDemo('New household', { ok: !!h, status: h ? 200 : 0, body: h, ms: 0 });
      await syncHouse(null, true);
    },
    idle() {
      if (isIdle()) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    mountViewSlot(slot) {
      viewSlot = slot;
    },
  };
}
