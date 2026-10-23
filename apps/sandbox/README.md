# fixwright-sandbox (apps/sandbox)

The MCP Apps sandbox proxy as its own Cloudflare Worker, on its own origin (the
pattern of ext-apps basic-host). It serves exactly one page, `/sandbox.html`. The host simulator loads it in an iframe; the
page checks who embeds it, refuses to run unless the host is cross origin, creates the inner view
iframe, writes the view HTML into it (so the view shares this origin and inherits this page's CSP),
and relays JSON-RPC between host and view.

```
host page (fixwright.<sub>.workers.dev)
  └─ iframe  fixwright-sandbox.<sub>.workers.dev/sandbox.html?csp=<json>   ← this Worker
       └─ iframe  about:blank + document.write(view html)                  ← the MCP Apps view
```

## Behaviour

- `GET` or `HEAD /sandbox.html` only. Every other path is 404, other methods 405 (`Allow: GET, HEAD`).
- CSP header from `?csp=` (the view's declared `_meta.ui.csp`: `connectDomains`, `resourceDomains`,
  `frameDomains`, `baseUriDomains`). Nothing declared gives the MCP Apps spec's restrictive default:
  `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  font-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none';
  base-uri 'self'; form-action 'none'; frame-ancestors <HOST_ORIGINS>`.
  Declared entries are kept only when they are plain `http(s)://` or `ws(s)://` sources (optional `*.`
  subdomain, port, path), at most 20 per list, so a crafted `?csp=` cannot add directives or keywords.
  Malformed JSON counts as nothing declared.
- Host allowlist from the `HOST_ORIGINS` variable (comma or space separated exact origins). It goes
  into `frame-ancestors` (the browser refuses other embedders) and into the page as an inert
  JSON block that the proxy script checks against `document.referrer`. With no valid origin configured
  the Worker answers 503 rather than serving an unprotected page.
- Never sets a cookie. Also `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`.
- The proxy pins messages to the view's origin when the view keeps `allow-same-origin` (falls back to
  `"*"` only for an opaque origin view), accepts host messages only from the embedding origin, and
  swallows `ui/notifications/sandbox-*` messages meant for itself.

## Files

- `src/worker.ts`: the Worker (`export default { fetch }`) and `handle(request, env)`.
- `src/csp.ts`: `parseCspParam`, `sanitizeSources`, `parseOrigins`, `buildCsp` (pure).
- `src/page.ts`: `sandboxHtml(origins)`, `scriptSafeJson`.
- `src/proxy.ts`: the browser script of the proxy page (typechecked with the DOM lib).
- `src/generated/proxy-script.ts`: `src/proxy.ts` bundled by esbuild into a string constant. Generated
  by `npm run build`; `npm run check` regenerates it and a test fails if it ever drifts.
- `wrangler.jsonc`: name `fixwright-sandbox`, compatibility date 2026-09-29, `HOST_ORIGINS` for local dev.

## Run

From the repo root:

```
npm run check -w @fixwright/sandbox          # build the proxy script, tsc (worker, proxy, tests), vitest
npm run test:wrangler -w @fixwright/sandbox  # real workerd: wrangler dev --local on 127.0.0.1:8714, 8 HTTP checks, then stops
npm run dev -w @fixwright/sandbox            # wrangler dev --local on 127.0.0.1:8714 (inspector 8719)
npm run deploy:dry -w @fixwright/sandbox     # wrangler deploy --dry-run, no account needed
```

Deploy (needs the Cloudflare token later):
`npx wrangler deploy --var HOST_ORIGINS:https://fixwright.<subdomain>.workers.dev` from this folder, then
build the host with `SANDBOX_URL=https://fixwright-sandbox.<subdomain>.workers.dev/sandbox.html`.

The host's Playwright test runs this same `fetch` handler through a small Node adapter on
127.0.0.1:8712 and drives the double iframe in Chromium (see `apps/host`).

## Measured (15 Oct 2026)

- `npm run check`: 17 tests pass. Generated proxy script: 2,344 bytes.
- `npm run test:wrangler`: wrangler dev ready in 1,311 ms; 8 of 8 checks pass; no process left behind.
- `wrangler deploy --dry-run`: total upload 6.82 KiB, 2.76 KiB gzip.

## Versions

wrangler 4.144.0, @cloudflare/workers-types 5.20260929.1, esbuild 0.28.2, TypeScript 6.0.3, vitest 5.0.2.
No runtime dependencies.
