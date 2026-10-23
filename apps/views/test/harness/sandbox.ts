// Modeled on ext-apps 2.0.3 examples/basic-host. Errors and CSP violations in
// the view become console errors in this frame, so the browser tests can count them without touching the view.

const RESOURCE_READY = 'ui/notifications/sandbox-resource-ready';
const PROXY_READY = 'ui/notifications/sandbox-proxy-ready';

document.addEventListener('securitypolicyviolation', (e) => console.error('[sandbox] CSP violation', e.violatedDirective, e.blockedURI));

if (window.self === window.top) throw new Error('sandbox proxy must run inside an iframe');
if (!document.referrer) throw new Error('no referrer; cannot validate the embedding host');
const HOST_ORIGIN = new URL(document.referrer).origin;
const ALLOWED = new URLSearchParams(location.search).get('host');
if (HOST_ORIGIN !== ALLOWED) throw new Error(`embedding origin not allowed: ${HOST_ORIGIN}`);
const OWN_ORIGIN = window.location.origin;

let topAccessible = false;
try {
  void (window.top as Window).document.title;
  topAccessible = true;
} catch {
  // expected: the host is on another origin
}
if (topAccessible) throw new Error('sandbox is not isolated from the host');

const inner = document.createElement('iframe');
inner.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
inner.setAttribute('title', 'Fixwright view');
inner.style.cssText = 'width:100%;height:100%;border:0;display:block;background:transparent';
document.body.appendChild(inner);

function instrument(win: Window | null): void {
  if (!win) return;
  win.addEventListener('error', (e) => console.error('[view] uncaught', e.message));
  win.addEventListener('unhandledrejection', (e) => console.error('[view] unhandled rejection', String(e.reason)));
  win.document.addEventListener('securitypolicyviolation', (e) =>
    console.error('[view] CSP violation', e.violatedDirective, e.blockedURI, `${e.sourceFile || 'inline'}:${e.lineNumber}`),
  );
}

window.addEventListener('message', (event) => {
  if (event.source === window.parent) {
    if (event.origin !== HOST_ORIGIN) return;
    const data = event.data;
    if (data && data.method === RESOURCE_READY) {
      const { html, sandbox } = data.params ?? {};
      if (typeof sandbox === 'string') inner.setAttribute('sandbox', sandbox);
      if (typeof html === 'string') {
        // document.write keeps the view on the sandbox origin and under this page's CSP.
        const doc = inner.contentDocument;
        if (!doc) throw new Error('inner document unavailable');
        doc.open();
        instrument(inner.contentWindow);
        doc.write(html);
        doc.close();
      }
      return;
    }
    if (data && typeof data.method === 'string' && data.method.startsWith('ui/notifications/sandbox-')) return;
    inner.contentWindow?.postMessage(data, '*');
  } else if (event.source === inner.contentWindow) {
    if (event.origin !== OWN_ORIGIN) return;
    window.parent.postMessage(event.data, HOST_ORIGIN);
  }
});

window.parent.postMessage({ jsonrpc: '2.0', method: PROXY_READY, params: {} }, HOST_ORIGIN);
