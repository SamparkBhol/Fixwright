// No MCP server: the "server" is a fixture router, so every view state is reproducible.
import { AppBridge, PostMessageTransport, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';

type ViewName = 'stepper' | 'carousel' | 'repair-card';
type DeviceClass = 'large' | 'small' | 'phone' | 'voice';
type Theme = 'light' | 'dark';
type Mode = 'inline' | 'fullscreen';
type Json = Record<string, unknown>;

interface CallToolResultLike {
  content: { type: 'text'; text: string }[];
  structuredContent?: Json;
  isError?: boolean;
}

export interface Scenario {
  view: ViewName;
  /** "protocol/<name>" from packages/protocol/fixtures or "views/<name>" from apps/views/fixtures. */
  fixture: string;
  tool: string;
  args?: Json;
  theme?: Theme;
  device?: DeviceClass;
  mode?: Mode;
  /** Leave out dev.fixwright/deviceClass to exercise the size fallback. */
  omitDeviceClass?: boolean;
  /** ISO time for dev.fixwright/now (the host's simulated clock). */
  now?: string;
  /** Never send the tool result (to look at the waiting state). */
  holdResult?: boolean;
  /** Send this structuredContent instead of the fixture's (a variant built in the test). */
  override?: Json;
  /**
   * 'flex': the container apps/host gives its Phone: containerDimensions {width: 358, maxHeight: 480}, the
   * frame starts 440 px tall and then follows the view's size reports, capped at 480 px.
   */
  container?: 'fixed' | 'flex';
}

export interface Policy {
  /** Approve mutating tool calls from the view (repair_apply, undo). */
  approve: boolean;
  /**
   * How a declined approval reaches the view.
   * 'convention': apps/host (src/view-host.ts): resend the view's latest result as
   *   tool-result, then deny with DECLINED_BY_PERSON.
   * 'words': deny with DECLINED_BY_PERSON only.
   * 'plain': deny with other words (a host that follows no convention).
   */
  decline: 'convention' | 'words' | 'plain';
  latencyMs: number;
  /** Fail the next tools/call: a server ProblemOutput, or an exception on the host side. */
  failNext: 'problem' | 'throw' | null;
}

export const DEVICES: Record<DeviceClass, { width: number; height: number }> = {
  large: { width: 1280, height: 800 },
  small: { width: 960, height: 480 },
  phone: { width: 390, height: 844 },
  voice: { width: 480, height: 480 },
};

/** apps/host Phone: src/devices.ts container and src/app.ts slot cap (onSize: min(height, 480)). */
export const FLEX_PHONE = { width: 358, maxHeight: 480, initialHeight: 440 } as const;

const NEEDS_APPROVAL = new Set(['repair_apply', 'undo']);
/** apps/host's denial text (src/view-host.ts DECLINED_BY_PERSON). */
export const DECLINED_BY_PERSON = 'Not approved. Nothing changed.';
const APP_VISIBLE = new Set(['home_checkup', 'diagnose', 'diagnose_answer', 'explain_event', 'repair_plan', 'repair_apply', 'repair_status', 'undo', 'refresh_view']);

const params = new URLSearchParams(location.search);
const SANDBOX_URL = params.get('sandbox') ?? 'http://127.0.0.1:8726/sandbox.html';
const SANDBOX_ORIGIN = new URL(SANDBOX_URL).origin;
const now = () => performance.timeOrigin + performance.now();
const stage = document.getElementById('stage') as HTMLDivElement;

const state = {
  scenario: null as Scenario | null,
  bridge: null as AppBridge | null,
  iframe: null as HTMLIFrameElement | null,
  theme: 'dark' as Theme,
  device: 'large' as DeviceClass,
  mode: 'inline' as Mode,
  now: undefined as string | undefined,
  omitDeviceClass: false,
  flex: false,
  sizes: [] as { width?: number; height?: number }[],
  policy: { approve: true, decline: 'convention', latencyMs: 0, failNext: null } as Policy,
  /** The view's latest result, as apps/host keeps it: the one it was opened with, then each successful call's. */
  latest: null as CallToolResultLike | null,
  messages: [] as string[],
  calls: [] as { name: string; arguments: Json; at: number; approved: boolean | null }[],
  logs: [] as { logger?: string; data: unknown; at: number }[],
  modelContext: [] as unknown[],
  displayModeRequests: [] as string[],
  resultSentAt: 0,
  fixtures: new Map<string, Json>(),
};

async function fixture(name: string): Promise<Json> {
  const cached = state.fixtures.get(name);
  if (cached) return structuredClone(cached);
  const res = await fetch(`/fixtures/${name}.json`);
  if (!res.ok) throw new Error(`fixture ${name}: HTTP ${res.status}`);
  const json = (await res.json()) as Json;
  state.fixtures.set(name, json);
  return structuredClone(json);
}

function toResult(sc: Json): CallToolResultLike {
  const speech = typeof sc.speech === 'string' ? sc.speech : '';
  const isError = sc.status === 'error' || (sc.status === 'refused' && 'problem' in sc);
  return { content: [{ type: 'text', text: speech }], structuredContent: sc, ...(isError ? { isError: true } : {}) };
}

/** Every plan the fixture router can hand out; the matching apply fixture swaps repair_plan for repair_apply. */
const PLAN_FIXTURES = ['protocol/repair_plan', 'views/repair_plan_rename', 'views/repair_plan_power_on'];

async function plans(): Promise<{ name: string; plan: Json }[]> {
  return Promise.all(PLAN_FIXTURES.map(async (name) => ({ name, plan: await fixture(name) })));
}

/** repair_plan: the plan whose ids carry the requested diagnosis, issue or explanation id. */
async function planFor(args: Json): Promise<Json | null> {
  for (const { plan } of await plans()) {
    const ids = (plan.ids ?? {}) as Json;
    for (const key of ['diagnosis_id', 'issue_id', 'explanation_id']) {
      if (typeof args[key] === 'string' && ids[key] === args[key]) return plan;
    }
  }
  return null;
}

async function serve(name: string, args: Json): Promise<CallToolResultLike> {
  switch (name) {
    case 'diagnose_answer': {
      const yes = /^(y|yes|yeah|haan|ha)\b/i.test(String(args.answer ?? ''));
      return toResult(await fixture(yes ? 'protocol/diagnose_answer' : 'views/diagnose_answer_no'));
    }
    case 'repair_plan': {
      const plan = await planFor(args);
      return toResult(plan ?? (await fixture('protocol/problem')));
    }
    case 'repair_apply': {
      const found = (await plans()).find((p) => p.plan.plan_id === args.plan_id);
      if (!found) return toResult(await fixture('protocol/problem'));
      if (found.plan.confirm_token !== args.confirm_token) {
        return toResult({ speech: "That plan doesn't match. Ask me for the fix again.", status: 'refused', ids: {}, source: found.plan.source, problem: { code: 'token_mismatch', retryable: false } });
      }
      return toResult(await fixture(found.name.replace('repair_plan', 'repair_apply')));
    }
    case 'undo':
      return toResult(await fixture('protocol/undo'));
    case 'refresh_view':
    case 'repair_status':
      return toResult(await fixture('protocol/repair_status'));
    default:
      return toResult(await fixture('protocol/problem'));
  }
}

function hostContext(): McpUiHostContext {
  const size = DEVICES[state.device];
  return {
    theme: state.theme,
    displayMode: state.mode,
    // The flexible phone mirrors apps/host, which offers inline only.
    availableDisplayModes: state.flex ? ['inline'] : ['inline', 'fullscreen'],
    containerDimensions: state.flex ? { width: FLEX_PHONE.width, maxHeight: FLEX_PHONE.maxHeight } : { width: size.width, height: size.height },
    locale: 'en-US',
    timeZone: 'America/Los_Angeles',
    userAgent: 'fixwright-views-harness/0.1.0',
    platform: state.device === 'phone' ? 'mobile' : 'web',
    deviceCapabilities: { touch: true, hover: false },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...(state.omitDeviceClass ? {} : { 'dev.fixwright/deviceClass': state.device }),
    ...(state.now ? { 'dev.fixwright/now': state.now } : {}),
  };
}

function sizeStage(): void {
  const size = state.flex ? { width: FLEX_PHONE.width, height: FLEX_PHONE.initialHeight } : DEVICES[state.device];
  stage.style.width = `${size.width}px`;
  stage.style.height = `${size.height}px`;
  stage.dataset.container = state.flex ? 'flex' : 'fixed';
  stage.dataset.device = state.device;
  stage.dataset.theme = state.theme;
  document.documentElement.dataset.theme = state.theme;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newBridge(): AppBridge {
  const bridge = new AppBridge(
    null,
    { name: 'fixwright-views-harness', version: '0.1.0' },
    { openLinks: {}, serverTools: {}, logging: {}, updateModelContext: { text: {} }, message: { text: {} }, sandbox: { csp: {} } },
    { hostContext: hostContext() },
  );
  // Explicit tools/call handler (null client): enforce app visibility and ask approval for mutations,
  // as the spec requires and as the real host simulator does.
  bridge.oncalltool = async (p) => {
    const name = p.name;
    const args = (p.arguments ?? {}) as Json;
    const needsApproval = NEEDS_APPROVAL.has(name);
    state.calls.push({ name, arguments: args, at: now(), approved: needsApproval ? state.policy.approve : null });
    if (!APP_VISIBLE.has(name)) throw new Error(`tool ${name} is not callable from a view`);
    if (state.policy.latencyMs) await sleep(state.policy.latencyMs);
    const fail = state.policy.failNext;
    state.policy.failNext = null;
    if (fail === 'throw') throw new Error('host error');
    if (needsApproval && !state.policy.approve) {
      if (state.policy.decline === 'plain') throw new Error('The person declined this action');
      if (state.policy.decline === 'convention' && state.latest) await bridge.sendToolResult(state.latest as never);
      throw new Error(DECLINED_BY_PERSON);
    }
    const result = fail === 'problem' ? toResult(await fixture('protocol/problem')) : await serve(name, args);
    if (!result.isError && result.structuredContent) state.latest = result;
    return result as never;
  };
  bridge.onloggingmessage = (p) => {
    state.logs.push({ ...(p.logger ? { logger: p.logger } : {}), data: p.data, at: now() });
  };
  bridge.onupdatemodelcontext = async (p) => {
    state.modelContext.push(p);
    return {};
  };
  bridge.onmessage = async (p) => {
    const text = (p.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join(' ').trim();
    state.messages.push(text);
    return {};
  };
  bridge.onopenlink = async () => ({});
  bridge.onrequestdisplaymode = async (p) => {
    state.displayModeRequests.push(p.mode);
    state.mode = p.mode === 'fullscreen' ? 'fullscreen' : 'inline';
    bridge.setHostContext(hostContext());
    return { mode: state.mode };
  };
  bridge.onsizechange = (p) => {
    state.sizes.push({ ...(p.width !== undefined ? { width: p.width } : {}), ...(p.height !== undefined ? { height: p.height } : {}) });
    if (state.flex && typeof p.height === 'number') stage.style.height = `${Math.min(p.height, FLEX_PHONE.maxHeight)}px`;
  };
  return bridge;
}

async function teardown(): Promise<void> {
  const { bridge, iframe } = state;
  state.bridge = null;
  state.iframe = null;
  if (bridge) {
    try {
      await Promise.race([bridge.teardownResource({}), sleep(2000)]);
    } finally {
      await bridge.close();
    }
  }
  iframe?.remove();
}

function waitProxyReady(iframe: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve) => {
    const onMsg = (e: MessageEvent) => {
      if (e.source === iframe.contentWindow && e.origin === SANDBOX_ORIGIN && e.data?.method === 'ui/notifications/sandbox-proxy-ready') {
        window.removeEventListener('message', onMsg);
        resolve();
      }
    };
    window.addEventListener('message', onMsg);
  });
}

async function load(s: Scenario): Promise<{ resultSentAt: number }> {
  await teardown();
  state.scenario = s;
  state.theme = s.theme ?? 'dark';
  state.device = s.device ?? 'large';
  state.mode = s.mode ?? 'inline';
  state.now = s.now;
  state.omitDeviceClass = Boolean(s.omitDeviceClass);
  state.flex = s.container === 'flex';
  state.sizes = [];
  state.calls = [];
  state.logs = [];
  state.modelContext = [];
  state.displayModeRequests = [];
  state.resultSentAt = 0;
  state.latest = null;
  state.messages = [];
  sizeStage();

  const [html, fromFixture] = await Promise.all([fetch(`/views/${s.view}.html`).then((r) => r.text()), fixture(s.fixture)]);
  const sc = s.override ?? fromFixture;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  iframe.title = 'Fixwright view';
  const url = new URL(SANDBOX_URL);
  url.searchParams.set('host', location.origin);
  const ready = waitProxyReady(iframe);
  iframe.src = url.href;
  stage.replaceChildren(iframe);
  state.iframe = iframe;
  await ready;

  const bridge = newBridge();
  state.bridge = bridge;
  const initialized = new Promise<void>((r) => bridge.addEventListener('initialized', () => r()));
  await bridge.connect(new PostMessageTransport(iframe.contentWindow as Window, iframe.contentWindow as Window));
  await bridge.sendSandboxResourceReady({ html });
  await initialized;
  await bridge.sendToolInput({ arguments: s.args ?? {} });
  if (!s.holdResult) {
    const first = toResult(sc);
    if (!first.isError) state.latest = first;
    state.resultSentAt = now();
    await bridge.sendToolResult(first as never);
  }
  return { resultSentAt: state.resultSentAt };
}

function update(patch: Partial<{ theme: Theme; device: DeviceClass; mode: Mode; now: string }>): void {
  Object.assign(state, patch);
  sizeStage();
  state.bridge?.setHostContext(hostContext());
}

declare global {
  interface Window {
    __harness: typeof api;
  }
}

const api = {
  load,
  teardown,
  update,
  setPolicy: (p: Partial<Policy>) => Object.assign(state.policy, p),
  calls: () => state.calls,
  /** Texts the view sent as ui/message (words for the conversation). */
  messages: () => state.messages,
  /** Send a tool result to the open view, as a host does for a newer result. */
  sendResult: (sc: Json) => state.bridge?.sendToolResult(toResult(sc) as never),
  logs: () => state.logs,
  modelContext: () => state.modelContext,
  displayModeRequests: () => state.displayModeRequests,
  resultSentAt: () => state.resultSentAt,
  sizes: () => state.sizes,
};
window.__harness = api;

// Manual use: the toolbar on test/harness.html (hidden with ?bare=1).
function wireToolbar(): void {
  const form = document.getElementById('controls') as HTMLFormElement | null;
  if (!form) return;
  const read = (n: string) => (form.elements.namedItem(n) as HTMLSelectElement).value;
  const run = () => {
    const [view, fixtureName, tool] = read('scenario').split('|') as [ViewName, string, string];
    void load({ view, fixture: fixtureName, tool, theme: read('theme') as Theme, device: read('device') as DeviceClass, mode: read('mode') as Mode, container: read('container') === 'flex' ? 'flex' : 'fixed' });
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run();
  });
  (form.elements.namedItem('container') as HTMLSelectElement).addEventListener('change', run);
  for (const n of ['theme', 'device', 'mode']) (form.elements.namedItem(n) as HTMLSelectElement).addEventListener('change', () => update({ [n]: read(n) }));
  (form.elements.namedItem('approve') as HTMLInputElement).addEventListener('change', (e) => {
    state.policy.approve = (e.target as HTMLInputElement).checked;
  });
  run();
}
if (!params.has('bare')) wireToolbar();
