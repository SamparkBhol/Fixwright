// The sandbox proxy page script (outer iframe, its own origin). It is bundled into sandbox.html by
// scripts/build.ts. Pattern from ext-apps basic-host:
//   host page --postMessage--> this proxy --postMessage--> inner iframe (the view)
// The proxy checks who embeds it, refuses to run without cross origin isolation from the host, writes
// the view HTML into the inner iframe (document.write keeps it on this origin under this page's CSP),
// relays JSON-RPC both ways, and swallows the ui/notifications/sandbox-* messages meant for itself.

const RESOURCE_READY = 'ui/notifications/sandbox-resource-ready';
const PROXY_READY = 'ui/notifications/sandbox-proxy-ready';
const DEFAULT_INNER_SANDBOX = 'allow-scripts allow-same-origin allow-forms';

interface Permissions {
  camera?: unknown;
  microphone?: unknown;
  geolocation?: unknown;
  clipboardWrite?: unknown;
}

function allowAttribute(p: Permissions | undefined): string {
  if (!p) return '';
  const out: string[] = [];
  if (p.camera) out.push('camera');
  if (p.microphone) out.push('microphone');
  if (p.geolocation) out.push('geolocation');
  if (p.clipboardWrite) out.push('clipboard-write');
  return out.join('; ');
}

function readAllowlist(): string[] {
  const el = document.getElementById('fixwright-hosts');
  try {
    const list: unknown = JSON.parse(el?.textContent ?? '[]');
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function topIsCrossOrigin(): boolean {
  try {
    void (window.top as Window).document.title;
    return false;
  } catch {
    return true;
  }
}

function refuse(reason: string): void {
  document.documentElement.dataset['proxy'] = 'refused';
  console.error(`[fixwright sandbox] ${reason}`);
}

function start(): void {
  if (window.self === window.top) return refuse('this page only runs inside a host iframe');
  const allowed = readAllowlist();
  const referrer = document.referrer ? new URL(document.referrer).origin : '';
  if (!referrer || !allowed.includes(referrer)) return refuse(`embedding origin not allowed: ${referrer || 'unknown'}`);
  if (!topIsCrossOrigin()) return refuse('the host page shares this origin, so views would not be isolated');

  const hostOrigin = referrer;
  const ownOrigin = window.location.origin;
  const inner = document.createElement('iframe');
  inner.setAttribute('sandbox', DEFAULT_INNER_SANDBOX);
  inner.setAttribute('title', 'Fixwright view');
  inner.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;display:block;background:transparent';
  document.body.appendChild(inner);

  // A view with allow-same-origin keeps this origin, so messages can be pinned to it. Without it the
  // view has an opaque origin and "*" is the only target that reaches it.
  const innerTarget = (): string => ((inner.getAttribute('sandbox') ?? '').includes('allow-same-origin') ? ownOrigin : '*');

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source === window.parent) {
      if (event.origin !== hostOrigin) return;
      const data = event.data as { method?: unknown; params?: Record<string, unknown> } | null;
      if (data && data.method === RESOURCE_READY) {
        const params = data.params ?? {};
        if (typeof params['sandbox'] === 'string') inner.setAttribute('sandbox', params['sandbox']);
        const allow = allowAttribute(params['permissions'] as Permissions | undefined);
        if (allow) inner.setAttribute('allow', allow);
        const html = params['html'];
        if (typeof html === 'string') {
          const doc = inner.contentDocument;
          if (doc) {
            doc.open();
            doc.write(html);
            doc.close();
          } else {
            inner.srcdoc = html;
          }
        }
        return;
      }
      if (data && typeof data.method === 'string' && data.method.startsWith('ui/notifications/sandbox-')) return;
      inner.contentWindow?.postMessage(event.data, innerTarget());
      return;
    }
    if (event.source === inner.contentWindow) {
      if (event.origin !== ownOrigin && event.origin !== 'null') return;
      window.parent.postMessage(event.data, hostOrigin);
    }
  });

  document.documentElement.dataset['proxy'] = 'ready';
  window.parent.postMessage({ jsonrpc: '2.0', method: PROXY_READY, params: {} }, hostOrigin);
}

start();
