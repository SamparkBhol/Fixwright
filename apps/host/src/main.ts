import { createHostApp } from './app.ts';
import { readConfig } from './config.ts';
import { createHook, type FixwrightHook } from './hook.ts';
import { mountConsole } from './ui/console.ts';
import { h } from './ui/dom.ts';
import { mountStage } from './ui/stage.ts';

declare global {
  interface Window {
    __fixwright?: FixwrightHook;
  }
}

const config = readConfig(window.location);
const app = createHostApp(config);
window.__fixwright = createHook(app);

const root = document.documentElement;
if (config.testMode) root.dataset['test'] = '1';

const bannerUrl = h('code', { class: 'banner-url', text: config.mcpUrl });
const bannerProto = h('span', { class: 'banner-proto', text: 'MCP 2025-11-25, Streamable HTTP' });
const status = h('span', { class: 'conn', 'data-status': 'connecting', text: 'Connecting' });
const about = h('button', { type: 'button', class: 'about-link', 'aria-pressed': 'false', onclick: () => app.setTab(app.store.get().tab === 'about' ? 'conversation' : 'about'), text: 'Guide' });
const topbar = h(
  'header',
  { class: 'topbar' },
  h('span', { class: 'wordmark', text: 'Fixwright' }),
  h('p', { class: 'banner', id: 'honesty-banner' }, h('span', { text: 'Alexa+ host simulated. Live MCP server: ' }), bannerUrl, h('span', { text: ' (' }), bannerProto, h('span', { text: ').' })),
  h('div', { class: 'top-actions' }, status, h('a', { class: 'dash-link', href: '/dashboard.html', target: '_blank', rel: 'noopener', text: 'Dashboard' }), about),
);

const stage = h('main', { class: 'stage', id: 'stage' });
const consoleEl = h('aside', { class: 'console', id: 'console', 'aria-label': 'Developer console' });
document.body.replaceChildren(topbar, h('div', { class: 'layout' }, stage, consoleEl));

mountStage(stage, app);
mountConsole(consoleEl, app);

function renderConnection(): void {
  const c = app.store.get().connection;
  status.dataset['status'] = c.status;
  status.textContent = c.status === 'ready' ? `Connected, ${c.tools} tools` : c.status === 'error' ? 'Server unreachable' : 'Connecting';
  status.title = c.error ?? '';
  if (c.protocolVersion) bannerProto.textContent = `MCP ${c.protocolVersion}, Streamable HTTP`;
}

// The page itself is wall and paper; the theme is the device screen's (views and the idle screen).
root.dataset['theme'] = app.store.get().theme;
app.store.subscribe((s, prev) => {
  if (s.theme !== prev.theme) root.dataset['theme'] = s.theme;
  if (s.connection !== prev.connection) renderConnection();
  if (s.tab !== prev.tab) about.setAttribute('aria-pressed', String(s.tab === 'about'));
});

if (!config.testMode) {
  setInterval(() => app.tick(), 15_000);
}

void app.ready().then(() => {
  root.dataset['ready'] = '1';
});
