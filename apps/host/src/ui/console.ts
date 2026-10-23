// The console beside the stage: Conversation, Visual Trace (raw JSON-RPC on both lanes with timing),
// Latency (p50 and p95 per method, measured in this browser), Break my house (fault injection, reset,
// clock jump, pushes) and About (what is real and what is simulated), which the top bar opens.

import type { HostApp } from '../app.ts';
import { DRILLS, FAULTS, faultInfo, type FaultInfo } from '../faults.ts';
import { formatMs, latencyTable } from '../latency.ts';
import { PROTOCOL_VERSION } from '../mcp.ts';
import { TABS, type AppState, type TabId } from '../state.ts';
import { methodKey, requestFor, type Lane, type TraceEntry } from '../trace.ts';
import { h, icon } from './dom.ts';
import { pushBody } from './stage.ts';

const MAX_STRING = 600;

/**
 * Pretty JSON as DOM nodes with token classes; long strings (view HTML) are shortened. Each line is its own
 * block indented by its depth, so a long string wraps under its own key instead of at column 0.
 */
export function jsonView(value: unknown): HTMLElement {
  const text = JSON.stringify(value, (_k, v: unknown) => (typeof v === 'string' && v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}… (${v.length - MAX_STRING} more characters)` : v), 2) ?? 'undefined';
  const pre = h('pre', { class: 'json' });
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  for (const raw of text.split('\n')) {
    const body = raw.trimStart();
    const row = h('span', { class: 'jl', style: `--depth:${raw.length - body.length}` });
    let last = 0;
    re.lastIndex = 0;
    for (let m = re.exec(body); m; m = re.exec(body)) {
      if (m.index > last) row.append(body.slice(last, m.index));
      const cls = m[1] ? (m[2] ? 'k' : 's') : m[3] ? 'b' : 'n';
      row.append(h('span', { class: `j-${cls}`, text: m[1] ?? m[0] }));
      if (m[2]) row.append(m[2]);
      last = m.index + m[0].length;
    }
    if (last < body.length) row.append(body.slice(last));
    pre.append(row);
  }
  return pre;
}

function protocolBadge(e: TraceEntry): string | null {
  const msg = e.msg as { method?: string; params?: { protocolVersion?: unknown }; result?: { protocolVersion?: unknown } };
  if (e.method === 'initialize' && typeof msg.params?.protocolVersion === 'string') return msg.params.protocolVersion;
  if (e.kind === 'response' && typeof msg.result?.protocolVersion === 'string') return msg.result.protocolVersion;
  return null;
}

function hasStructured(e: TraceEntry): boolean {
  const msg = e.msg as { result?: { structuredContent?: unknown } };
  return e.kind === 'response' && typeof msg.result?.structuredContent === 'object';
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB`;
}

const ARROWS: Record<Lane, Record<'in' | 'out', string>> = {
  mcp: { out: 'host → server', in: 'server → host' },
  bridge: { out: 'host → view', in: 'view → host' },
};

export function mountConsole(root: HTMLElement, app: HostApp): void {
  const { store, trace } = app;
  const tabButtons = new Map<TabId, HTMLButtonElement>();
  const panels = new Map<TabId, HTMLElement>();
  const traceCount = h('span', { class: 'trace-count' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  for (const t of TABS) {
    const b = h(
      'button',
      { type: 'button', role: 'tab', class: 'tab', 'data-tab': t.id, title: t.label, onclick: () => app.setTab(t.id) },
      h('span', { class: 'tab-long', text: t.label }),
      // Phone width: the short label shows and the long one stays as the accessible name.
      h('span', { class: 'tab-short', 'aria-hidden': 'true', text: t.short }),
    );
    tabButtons.set(t.id, b);
    tabs.append(b);
    const panel = h('section', { class: 'panel', role: 'tabpanel', 'data-panel': t.id });
    panels.set(t.id, panel);
  }
  panels.set('about', h('section', { class: 'panel', role: 'region', 'aria-label': 'About', 'data-panel': 'about' }));
  root.append(tabs, ...panels.values());

  const convList = h('ol', { class: 'conv' });
  const convEmpty = h('p', { class: 'empty', text: 'Say something to start. Every turn shows the tool the router picked and how long the server took.' });
  panels.get('conversation')?.append(convEmpty, convList);
  function renderConversation(s: AppState): void {
    convEmpty.hidden = s.transcript.length > 0;
    convList.replaceChildren(
      ...s.transcript.map((e) => {
        const li = h('li', { class: `turn ${e.role}`, 'data-role': e.role });
        const who = e.role === 'assistant' ? 'Fixwright' : e.via === 'view' ? 'Sent by the view' : e.via === 'tap' ? 'You, on the screen' : 'You';
        li.append(h('div', { class: 'turn-who', text: who }));
        if (e.via === 'tap' || e.via === 'view') li.dataset['via'] = e.via;
        li.append(h('p', { class: 'turn-text', text: e.text }));
        if (e.role === 'user' && e.intent) li.append(h('div', { class: 'turn-meta', text: `Routed as ${e.intent}` }));
        if (e.tool) {
          const t = e.tool;
          li.append(
            h(
              'div',
              { class: `tool-chip ${t.isError ? 'err' : ''}`, 'data-tool': t.name },
              h('code', { text: `tools/call ${t.name}` }),
              h('span', { class: 'tool-status', text: t.status }),
              t.origin === 'view' ? h('span', { class: 'tool-origin', text: 'from the view' }) : null,
              t.ms > 0 ? h('span', { class: 'tool-ms', text: formatMs(t.ms) }) : null,
            ),
          );
        }
        return li;
      }),
    );
    const panel = panels.get('conversation');
    if (panel && s.tab === 'conversation') panel.scrollTop = panel.scrollHeight;
  }

  let laneFilter: 'all' | Lane = 'all';
  const traceList = h('ol', { class: 'trace' });
  const filters = h('div', { class: 'seg', role: 'group', 'aria-label': 'Lane' });
  const setFilter = (f: 'all' | Lane): void => {
    laneFilter = f;
    traceList.dataset['filter'] = f;
    for (const b of filters.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset['filter'] === f));
  };
  for (const [f, label] of [['all', 'All'], ['mcp', 'MCP server'], ['bridge', 'View bridge']] as const) {
    filters.append(h('button', { type: 'button', 'data-filter': f, onclick: () => setFilter(f), text: label }));
  }
  const traceHead = h(
    'div',
    { class: 'panel-head stacked' },
    h('div', {}, h('h3', { text: 'Raw JSON-RPC, as sent and received' }), h('p', { class: 'muted' }, traceCount, h('span', { text: 'Click a row to open the message. Times are from page load, measured in this browser.' }))),
    filters,
  );
  panels.get('trace')?.append(traceHead, traceList);
  setFilter(laneFilter);

  function traceRow(e: TraceEntry): HTMLElement {
    const req = e.kind === 'response' || e.kind === 'error' ? requestFor(trace.entries, e) : null;
    const label = req ? `${e.kind === 'error' ? '✕ ' : '↳ '}${methodKey(req)}` : methodKey(e);
    const badge = protocolBadge(e);
    const row = h('li', { class: `tr ${e.lane} ${e.dir} ${e.kind}`, 'data-lane': e.lane, 'data-dir': e.dir, 'data-kind': e.kind, 'data-method': req ? req.method : e.method });
    if (req?.tool ?? e.tool) row.dataset['tool'] = (req?.tool ?? e.tool) as string;
    const body = h('div', { class: 'tr-body', hidden: true });
    const head = h(
      'button',
      {
        type: 'button',
        class: 'tr-head',
        'aria-expanded': 'false',
        onclick: () => {
          const open = body.hidden;
          body.hidden = !open;
          head.setAttribute('aria-expanded', String(open));
          if (open && !body.firstChild) body.append(jsonView(e.msg));
        },
      },
      h('span', { class: 'tr-t', text: `${(e.t / 1000).toFixed(3)}s` }),
      h('span', { class: 'tr-dir', title: ARROWS[e.lane][e.dir], text: e.dir === 'out' ? '→' : '←' }),
      h('span', { class: 'tr-lane', text: e.lane === 'mcp' ? 'MCP' : 'View' }),
      h('span', { class: 'tr-method', title: label, text: label }),
      h(
        'span',
        { class: 'tr-meta' },
        e.id !== null && !req ? h('span', { class: 'tr-id', text: `#${e.id}` }) : null,
        badge ? h('span', { class: 'tr-badge', 'data-protocol': badge, text: badge }) : null,
        hasStructured(e) ? h('span', { class: 'tr-badge sc', title: 'result.structuredContent', text: 'structured' }) : null,
        req ? h('span', { class: 'tr-ms', text: formatMs(e.t - req.t) }) : h('span', { class: 'tr-size', text: formatBytes(e.bytes) }),
      ),
    );
    row.append(head, body);
    return row;
  }

  let pendingRows: TraceEntry[] = [];
  let scheduled = false;
  const flush = (): void => {
    scheduled = false;
    const frag = document.createDocumentFragment();
    for (const e of pendingRows) frag.append(traceRow(e));
    pendingRows = [];
    traceList.append(frag);
    while (traceList.childElementCount > 1500) traceList.firstElementChild?.remove();
    traceCount.textContent = `${trace.entries.length} ${trace.entries.length === 1 ? 'message' : 'messages'}. `;
    const panel = panels.get('trace');
    if (panel && store.get().tab === 'trace') panel.scrollTop = panel.scrollHeight;
    renderLatency();
  };
  for (const e of trace.entries) pendingRows.push(e);
  trace.subscribe((e) => {
    pendingRows.push(e);
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(flush);
    }
  });

  const latBody = h('div', { class: 'lat' });
  panels.get('latency')?.append(
    h('div', { class: 'panel-head' }, h('div', {}, h('h3', { text: 'Round trip per method' }), h('p', { class: 'muted', text: 'From the request leaving the host to its response arriving, measured live in this browser. Nothing here is estimated.' }))),
    latBody,
  );
  function renderLatency(): void {
    const rows = latencyTable(trace.entries, 'mcp');
    if (rows.length === 0) {
      latBody.replaceChildren(h('p', { class: 'empty', text: 'No round trips yet.' }));
      return;
    }
    const max = Math.max(...rows.map((r) => r.p95), 1);
    latBody.replaceChildren(
      h(
        'div',
        { class: 'lat-row lat-headrow' },
        h('span', { text: 'Method' }),
        h('span', { text: 'n' }),
        h('span', { text: 'p50' }),
        h('span', { text: 'p95' }),
        h('span', { text: '' }),
      ),
      ...rows.map((r) => {
        const bar = h('div', { class: 'lat-bar' }, h('i', { class: 'p95', style: `width:${(r.p95 / max) * 100}%` }), h('i', { class: 'p50', style: `width:${(r.p50 / max) * 100}%` }));
        const [family, tool] = r.method.startsWith('tools/call ') ? ['tools/call', r.method.slice(11)] : [null, r.method];
        return h(
          'div',
          { class: 'lat-row', 'data-method': r.method },
          h('div', { class: 'lat-method', title: r.method }, family ? h('span', { class: 'lat-family', text: family }) : null, h('code', { text: tool })),
          h('span', { class: 'num', text: String(r.n) }),
          h('span', { class: 'num', 'data-p': '50', text: formatMs(r.p50) }),
          h('span', { class: 'num', 'data-p': '95', text: formatMs(r.p95) }),
          bar,
        );
      }),
    );
  }

  const hhToken = h('code', { class: 'hh-token' });
  const hhTopic = h('span', { class: 'muted' });
  const active = h('div', { class: 'active-faults' });
  const pushes = h('div', { class: 'pushes' });
  const houseLog = h('ol', { class: 'house-log' });
  const faultRow = (f: FaultInfo, action: string) =>
    h(
      'div',
      { class: 'fault', 'data-fault': f.id },
      h('span', { class: 'fault-code', text: f.code }),
      h(
        'div',
        { class: 'fault-text' },
        h('strong', { text: f.title }),
        h('span', { text: f.detail }),
        f.source ? h('a', { href: f.source.url, target: '_blank', rel: 'noopener noreferrer', class: 'fault-src' }, icon('link', 12), h('span', { text: f.source.date ? `Public report, ${f.source.date}` : 'Public report' })) : null,
      ),
      h('button', { type: 'button', class: 'btn small danger', onclick: () => void app.injectFault(f.id), text: action }),
    );
  const faultList = h('div', { class: 'faults' }, ...FAULTS.map((f) => faultRow(f, 'Break it')));
  const drillList = h('div', { class: 'faults drills' }, ...DRILLS.map((f) => faultRow(f, 'Set it up')));
  panels.get('house')?.append(
    h('div', { class: 'callout' }, icon('bolt', 16), h('p', { text: 'Faults go into the simulated home twin on the server (SimHome), never into a real house. Break something, then ask Fixwright about it.' })),
    h('div', { class: 'card hh' }, h('div', {}, h('div', { class: 'card-label', text: 'Your demo household' }), hhToken, hhTopic), h('button', { type: 'button', class: 'btn small ghost', onclick: () => void app.newHousehold(), text: 'New household' })),
    active,
    h(
      'div',
      { class: 'card time' },
      h('div', {}, h('div', { class: 'card-label', text: 'Simulated clock' }), h('span', { class: 'muted', text: 'Jump ahead to run the next morning check and its push.' })),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn small', 'data-clock': 'next_morning', onclick: () => void app.jumpClock('next_morning') }, icon('clock', 14), h('span', { text: 'Next morning 7:00' })), h('button', { type: 'button', class: 'btn small ghost', onclick: () => void app.jumpClock(3_600_000), text: '+1 hour' })),
    ),
    pushes,
    h('h3', { class: 'section', text: 'Test the safety net' }),
    drillList,
    h('h3', { class: 'section', text: 'Inject a fault' }),
    faultList,
    h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn small ghost', onclick: () => void app.resetHouse() }, icon('reset', 14), h('span', { text: 'Reset the house' }))),
    h('h3', { class: 'section', text: 'Demo calls' }),
    houseLog,
  );
  function renderHouse(s: AppState): void {
    active.replaceChildren(
      h('span', { class: 'active-label', text: s.activeFaults === null ? 'Injected faults: unknown' : s.activeFaults.length ? 'Injected into the simulated house' : 'No faults injected' }),
      ...(s.activeFaults ?? []).map((id) => {
        const f = faultInfo(id);
        return h('span', { class: 'active-chip', 'data-active-fault': id, title: f?.detail ?? id }, h('b', { text: f?.code ?? '?' }), h('span', { text: f?.title ?? id }));
      }),
    );
    const t = s.household?.token;
    hhToken.textContent = t ? `${t.slice(0, 7)}…${t.slice(-4)}` : 'hh_public (shared)';
    // Shortened like the token: on a public ntfy server anyone who reads the full topic could subscribe.
    const topic = s.household?.ntfyTopic;
    hhTopic.textContent = topic ? `Push topic ${topic.length > 18 ? `${topic.slice(0, 14)}…${topic.slice(-3)}` : topic}` : 'No push topic';
    pushes.replaceChildren(
      ...s.pushes.map((p) =>
        h('div', { class: 'push', 'data-push': 'true' }, h('div', { class: 'push-app' }, icon('bell', 14), h('span', { text: 'Fixwright' }), h('time', { text: new Date(p.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) })), h('strong', { text: p.title }), h('p', { text: pushBody(p) })),
      ),
    );
    houseLog.replaceChildren(
      ...s.houseLog.map((l) => h('li', { class: l.ok ? 'ok' : 'err' }, h('span', { text: l.action }), h('span', { class: 'muted', text: `${l.summary}, ${formatMs(l.ms)}` }))),
    );
  }

  const facts = h('dl', { class: 'facts' });
  const themeSeg = h('div', { class: 'seg theme-seg', role: 'group', 'aria-label': 'Device screen theme' });
  for (const [theme, label] of [['dark', 'Dark'], ['light', 'Light']] as const) {
    themeSeg.append(h('button', { type: 'button', 'data-theme-choice': theme, onclick: () => app.setTheme(theme), text: label }));
  }
  panels.get('about')?.append(
    h('h3', { class: 'section first', text: 'How to try it' }),
    h(
      'ol',
      { class: 'guide-steps' },
      ...[
        'Ask "Why does the hallway lamp keep saying it\u2019s not responding?" Fixwright checks the hub, the signal and the maker\u2019s cloud, then asks you to look.',
        'Say "Yes, it blinked." It finds the real fault, then say "Yes" twice to see the fix and apply it.',
        'Ask "Why did every plug turn on at 3 a.m.?" and watch the house plan replay the power cut.',
        'Ask "Give my house a checkup" or "Is anything broken?"',
        'Ask Fixwright to turn off the living room power strip, and see it protect the aquarium filter.',
        'Open Break my house to cause any fault, reset the house or jump to the next morning, then ask again.',
      ].map((t) => h('li', { text: t })),
    ),
    h('p', { class: 'muted', text: 'The strip under the screen is your house, built from the house data. Amber means on, an empty circle means off, red means offline. Tap a device to switch it, or to diagnose it when it is offline. Tap a room name for a checkup of that room. Open the dashboard from the top bar for the whole house at a glance.' }),
    h('h3', { class: 'section', text: 'What is real' }),
    h(
      'ul',
      { class: 'ticks' },
      ...[
        'The MCP server and its endpoint, spoken to over Streamable HTTP with a real MCP client in this page.',
        'Every tool call, its structuredContent and the views it renders.',
        'The JSON-RPC in the Visual Trace and every number in the Latency tab.',
        'The approval step: nothing a view starts, by a button or by a message, changes the house until you say yes, out loud or on the host’s own sheet. A view can never answer the sheet for you.',
      ].map((t) => h('li', { text: t })),
    ),
    h('h3', { class: 'section', text: 'What is simulated' }),
    h(
      'ul',
      { class: 'ticks sim' },
      ...[
        'The Alexa+ host itself. This page imitates its behavior with generic devices, not its look or voice.',
        'The house: a digital twin (SimHome) with injected faults, power events and vendor outages.',
        'The house clock and the jump to the next morning (the page and the views both follow it), and your spoken answers when you type them.',
      ].map((t) => h('li', { text: t })),
    ),
    h('h3', { class: 'section', text: 'Device screen' }),
    h('p', { class: 'muted', text: 'The views follow the device theme, as they would on a real screen.' }),
    themeSeg,
    h('h3', { class: 'section', text: 'This session' }),
    facts,
  );
  function renderAbout(s: AppState): void {
    const rows: Array<[string, string]> = [
      ['MCP server', app.config.mcpUrl],
      ['Protocol', s.connection.protocolVersion ? (s.connection.protocolVersion === PROTOCOL_VERSION ? `MCP ${PROTOCOL_VERSION}, the version this page asked for` : `MCP ${s.connection.protocolVersion}, this page asked for ${PROTOCOL_VERSION}`) : s.connection.status],
      ['Transport', 'Streamable HTTP, stateless'],
      ['Server', s.connection.server ? `${s.connection.server.name} ${s.connection.server.version}` : 'Not connected yet'],
      ['Tools', String(s.connection.tools)],
      ['View sandbox', app.config.sandboxOrigin],
      ['Router', app.config.routerMode === 'server' ? 'server /assistant/route' : 'deterministic, in this page'],
      ['Host', `fixwright-host-sim ${app.config.version}`],
    ];
    facts.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
  }

  function render(s: AppState, prev: AppState | null): void {
    if (!prev || s.tab !== prev.tab) {
      for (const [id, b] of tabButtons) b.setAttribute('aria-selected', String(id === s.tab));
      for (const [id, p] of panels) p.hidden = id !== s.tab;
      if (s.tab === 'latency') renderLatency();
    }
    if (!prev || s.transcript !== prev.transcript || s.tab !== prev.tab) renderConversation(s);
    if (!prev || s.household !== prev.household || s.pushes !== prev.pushes || s.houseLog !== prev.houseLog || s.activeFaults !== prev.activeFaults) renderHouse(s);
    if (!prev || s.connection !== prev.connection) renderAbout(s);
    if (!prev || s.theme !== prev.theme) for (const b of themeSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset['themeChoice'] === s.theme));
  }
  render(store.get(), null);
  store.subscribe((s, prev) => render(s, prev));
  flush();
}
