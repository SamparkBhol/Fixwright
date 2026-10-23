// Renders MCP Apps views the way the MCP Apps spec prescribes:
//   host page -> sandbox proxy iframe (another origin, CSP from ?csp=) -> inner view iframe.
// AppBridge is built with a null client and explicit handlers, so the host decides every view
// request itself: visibility is enforced, mutating tools wait for the person's approval, and
// resources are served from the host's cache. Each tool result gets a fresh view instance; the new
// one fades in over the old one, which is then torn down (ui/resource-teardown, close, remove).
//
// When the person declines an approval, the call is still denied with a JSON-RPC error (the MCP Apps
// way), but first the view gets its latest result again as ui/notifications/tool-result. Views that
// let a newer host result win over a pending action (apps/views does) then simply stay on the screen
// they were showing, instead of reporting a failure for a choice the person made.

import type { CallToolResult, JSONRPCMessage, Tool } from '@modelcontextprotocol/client';
import { AppBridge, PostMessageTransport, buildAllowAttribute, type McpUiHostContext } from '@modelcontextprotocol/ext-apps/app-bridge';
import { HOST_INFO, type McpSession } from './mcp.ts';
import { decideViewCall, isBackgroundCall, toolResourceUri } from './policy.ts';
import type { TraceStore } from './trace.ts';

export interface ApprovalRequest {
  tool: Tool;
  args: Record<string, unknown>;
  /** How the view asked: a tools/call, or a ui/message whose words were routed to this tool. */
  via: 'call' | 'message';
  /** For a message: the words the view sent on the person's behalf. */
  said?: string;
}

/**
 * The denial a view receives when the person says no. Plain words: apps/views shows them as a calm
 * status line, not an error.
 */
export const DECLINED_BY_PERSON = 'Not approved. Nothing changed.';

/** A finished call that a view started (after any approval). */
export interface ViewCallResult {
  tool: Tool;
  args: Record<string, unknown>;
  result: CallToolResult;
  ms: number;
  /** performance.now() when the call went out, so the host can tell whether anything newer was shown since. */
  startedAt: number;
  /** The tool whose result opened the view that made the call. */
  shownTool: Tool;
}

export interface ViewHostDeps {
  slot: HTMLElement;
  sandboxUrl: string;
  sandboxOrigin: string;
  session: () => McpSession | null;
  trace: TraceStore;
  hostContext: (tool: Tool) => McpUiHostContext;
  approve: (req: ApprovalRequest) => Promise<boolean>;
  /** Count a view started call as host work, so the test hook's idle() waits for it. */
  track: <T>(work: Promise<T>) => Promise<T>;
  /** The person tapped a view button that calls a tool the model can call too: it is their turn. */
  onViewTap: (tool: Tool, args: Record<string, unknown>) => void;
  /** A view called a tool and got a result (after any approval). */
  onViewToolResult: (call: ViewCallResult) => void;
  /** The view sent ui/message: treat its text as something the person said. */
  onViewMessage: (text: string) => void;
  onSize: (size: { width?: number; height?: number }) => void;
  log: (type: string, detail?: unknown) => void;
}

export interface ViewHandle {
  id: number;
  uri: string;
  tool: Tool;
  iframe: HTMLIFrameElement;
  bridge: AppBridge;
  detach: () => void;
  /** The newest result this view shows: the one it was opened with, or its own last successful call. */
  latest: CallToolResult;
}

export interface ViewHost {
  show(tool: Tool, args: Record<string, unknown>, result: CallToolResult): Promise<void>;
  refreshContext(): void;
  teardown(reason: string): Promise<void>;
  readonly current: ViewHandle | null;
  readonly rendering: boolean;
}

const SANDBOX_ATTR = 'allow-scripts allow-same-origin allow-forms';
const READY = 'ui/notifications/sandbox-proxy-ready';

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function createViewHost(deps: ViewHostDeps): ViewHost {
  let current: ViewHandle | null = null;
  let counter = 0;
  let rendering = 0;

  function waitProxyReady(iframe: HTMLIFrameElement, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onMsg = (e: MessageEvent): void => {
        const data = e.data as { method?: unknown } | null;
        if (e.source === iframe.contentWindow && e.origin === deps.sandboxOrigin && data?.method === READY) done();
      };
      const timer = setTimeout(() => done(new Error(`sandbox proxy at ${deps.sandboxOrigin} not ready after ${ms} ms`)), ms);
      const done = (err?: Error): void => {
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        if (err) reject(err);
        else resolve();
      };
      window.addEventListener('message', onMsg);
    });
  }

  /** A PostMessageTransport pinned to the sandbox origin, with both directions on the trace. */
  function tracedTransport(target: Window, id: number): { transport: PostMessageTransport; detach: () => void } {
    const transport = new PostMessageTransport(target, target);
    transport.send = async (message: JSONRPCMessage) => {
      deps.trace.add('bridge', 'out', id, message);
      target.postMessage(message, deps.sandboxOrigin);
    };
    const onMsg = (e: MessageEvent): void => {
      const data = e.data as { jsonrpc?: unknown } | null;
      if (e.source !== target || e.origin !== deps.sandboxOrigin || data?.jsonrpc !== '2.0') return;
      deps.trace.add('bridge', 'in', id, data);
    };
    window.addEventListener('message', onMsg);
    return { transport, detach: () => window.removeEventListener('message', onMsg) };
  }

  async function callFromView(bridge: AppBridge, handle: () => ViewHandle | null, name: string, rawArgs: unknown): Promise<CallToolResult> {
    const session = deps.session();
    if (!session) throw new Error('Not connected to the Fixwright server.');
    const tool = session.tools.get(name);
    const decision = decideViewCall(tool, name);
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    if (!decision.allow || !tool) {
      deps.log('view tools/call refused', { name, reason: decision.allow ? 'unknown tool' : decision.reason });
      throw new Error(decision.allow ? 'Unknown tool.' : decision.reason);
    }
    if (!isBackgroundCall(tool)) deps.onViewTap(tool, args);
    if (decision.approval) {
      const yes = await deps.approve({ tool, args, via: 'call' });
      deps.log(yes ? 'approval granted' : 'approval declined', { name: tool.name, via: 'tools/call' });
      if (!yes) {
        const h = handle();
        if (h && h === current) await bridge.sendToolResult(h.latest).catch(() => undefined);
        throw new Error(DECLINED_BY_PERSON);
      }
    }
    const t0 = performance.now();
    const result = await session.callTool(tool.name, args);
    const h = handle();
    if (h) {
      if (!result.isError && result.structuredContent) h.latest = result;
      deps.onViewToolResult({ tool, args, result, ms: performance.now() - t0, startedAt: t0, shownTool: h.tool });
    }
    return result;
  }

  function install(bridge: AppBridge, handle: () => ViewHandle | null): void {
    bridge.oncalltool = (params) => deps.track(callFromView(bridge, handle, params.name, params.arguments));
    bridge.onreadresource = async (params) => {
      const session = deps.session();
      if (!session) throw new Error('Not connected.');
      return session.client.readResource(params);
    };
    bridge.onlistresources = async (params) => {
      const session = deps.session();
      if (!session) throw new Error('Not connected.');
      return session.client.listResources(params);
    };
    bridge.onmessage = async (params) => {
      const text = (params.content ?? [])
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join(' ')
        .trim();
      if (text) deps.onViewMessage(text);
      return {};
    };
    bridge.onopenlink = async (params) => {
      deps.log('ui/open-link', params);
      if (/^https:\/\//.test(params.url)) window.open(params.url, '_blank', 'noopener,noreferrer');
      return {};
    };
    bridge.onupdatemodelcontext = async (params) => {
      deps.log('ui/update-model-context', params);
      return {};
    };
    bridge.onloggingmessage = (params) => deps.log('view log', params);
    bridge.onsizechange = (params) => {
      if (handle() === current) deps.onSize(params);
    };
    bridge.onrequestdisplaymode = async () => ({ mode: 'inline' });
    bridge.onrequestteardown = () => {
      if (handle() === current) void teardownHandle(current, 'view asked');
    };
  }

  async function teardownHandle(h: ViewHandle | null, reason: string): Promise<void> {
    if (!h) return;
    if (current === h) current = null;
    // Off the screen at once (it fades out). The teardown handshake below can take a few more ms, and
    // only one frame may ever count as the active view.
    h.iframe.classList.remove('active');
    h.iframe.classList.add('leaving');
    try {
      await withTimeout(h.bridge.teardownResource({}), 1500, 'ui/resource-teardown');
    } catch (e) {
      deps.log('teardown without answer', { reason, error: String(e) });
    }
    try {
      await h.bridge.close();
    } catch {
      /* already closed */
    }
    h.detach();
    setTimeout(() => h.iframe.remove(), 220);
  }

  async function show(tool: Tool, args: Record<string, unknown>, result: CallToolResult): Promise<void> {
    const session = deps.session();
    const uri = toolResourceUri(tool);
    if (!session || !uri) return;
    rendering++;
    const id = ++counter;
    let frame: HTMLIFrameElement | null = null;
    let cleanup: (() => void) | null = null;
    try {
      const ui = await session.readUi(uri);
      const iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', SANDBOX_ATTR);
      iframe.referrerPolicy = 'origin';
      iframe.title = `${tool.title ?? tool.name} view`;
      iframe.className = 'view-frame entering';
      iframe.dataset['uri'] = uri;
      iframe.dataset['tool'] = tool.name;
      const allow = buildAllowAttribute(ui.permissions);
      if (allow) iframe.setAttribute('allow', allow);
      const src = new URL(deps.sandboxUrl);
      if (ui.csp) src.searchParams.set('csp', JSON.stringify(ui.csp));
      const ready = waitProxyReady(iframe, 10_000);
      iframe.src = src.href;
      frame = iframe;
      deps.slot.append(iframe);
      await ready;
      const target = iframe.contentWindow;
      if (!target) throw new Error('sandbox iframe has no window');

      let handle: ViewHandle | null = null;
      const bridge = new AppBridge(
        null,
        { ...HOST_INFO },
        {
          openLinks: {},
          serverTools: {},
          serverResources: {},
          logging: {},
          message: { text: {} },
          updateModelContext: { text: {} },
          sandbox: { csp: ui.csp ?? {}, ...(ui.permissions ? { permissions: ui.permissions } : {}) },
        },
        { hostContext: deps.hostContext(tool) },
      );
      install(bridge, () => handle);
      const initialized = new Promise<void>((resolve) => bridge.addEventListener('initialized', () => resolve()));
      const traced = tracedTransport(target, id);
      handle = { id, uri, tool, iframe, bridge, detach: traced.detach, latest: result };
      cleanup = () => {
        traced.detach();
        void bridge.close().catch(() => undefined);
      };
      await bridge.connect(traced.transport);
      await bridge.sendSandboxResourceReady({ html: ui.html, ...(ui.csp ? { csp: ui.csp } : {}), ...(ui.permissions ? { permissions: ui.permissions } : {}) });
      await withTimeout(initialized, 10_000, 'view initialize');
      await bridge.sendToolInput({ arguments: args });
      await bridge.sendToolResult(result);

      const previous = current;
      current = handle;
      bridge.setHostContext(deps.hostContext(tool));
      // Two frames for the view to paint before it fades in over the previous one.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      iframe.classList.remove('entering');
      iframe.classList.add('active');
      void teardownHandle(previous, 'replaced');
    } catch (e) {
      cleanup?.();
      frame?.remove();
      throw e;
    } finally {
      rendering--;
    }
  }

  return {
    show,
    refreshContext() {
      if (current) current.bridge.setHostContext(deps.hostContext(current.tool));
    },
    teardown: (reason) => teardownHandle(current, reason),
    get current() {
      return current;
    },
    get rendering() {
      return rendering > 0;
    },
  };
}
