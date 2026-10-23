# fixwright-sandbox: what the tests prove

`npm run check -w @fixwright/sandbox` (unit, Node) and `npm run test:wrangler -w @fixwright/sandbox` (real workerd).

- [x] `GET /sandbox.html` serves the proxy page as `text/html` with the MCP Apps spec's default CSP when nothing is declared.
- [x] The page carries the `HOST_ORIGINS` allowlist as inert JSON and exactly one executable script.
- [x] `frame-ancestors` lists exactly the configured host origins; with none configured the Worker answers 503.
- [x] Declared domains from `?csp=` reach `connect-src`, `script-src`, `img-src` and friends.
- [x] Injection attempts in `?csp=` (`;`, keywords, `*`, `javascript:`, several sources in one entry) are dropped;
      the policy always has the same 12 directives.
- [x] Malformed `?csp=` JSON is treated as nothing declared.
- [x] No `Set-Cookie` on any path or method; `Cache-Control: no-store`.
- [x] Every other path is 404; POST is 405 with `Allow: GET, HEAD`; HEAD has headers and no body.
- [x] `parseOrigins` keeps exact origins only (lower case, no duplicates, no paths or other schemes).
- [x] `scriptSafeJson` cannot close the script element.
- [x] The checked in generated proxy script equals a fresh esbuild bundle of `src/proxy.ts`.
- [x] Under real `wrangler dev --local` (workerd): 200 page, default CSP, `frame-ancestors` from `wrangler.jsonc`
      vars, allowlist in the page, no cookie, declared domain in the CSP, 404 elsewhere, 405 for POST.
- [x] In Chromium (host e2e): the view runs two frames deep on the sandbox origin, cannot read `window.top`,
      and every message reaches it through this proxy.
