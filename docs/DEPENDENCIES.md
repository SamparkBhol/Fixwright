# Dependencies

Every dependency is pinned exactly (`.npmrc` has `save-exact=true`). One install at the repo root
covers every workspace:

```
npm ci
```

Never run a plain `npm install` inside a workspace. If a module truly needs one more package:

```
npm install --workspace <workspace> --save-exact <pkg>@<version>
```

Pick the newest version that is at least 14 days old, and record it in that workspace's README. When
several installs could run at once in one checkout, wrap each in `flock .tmp/npm.lock` so they never overlap.

## Pinned versions

| Package | Version | Where |
| --- | --- | --- |
| typescript | 6.0.3 | root dev |
| vitest | 5.0.2 | root dev |
| esbuild | 0.28.2 | root dev |
| playwright | 1.63.0 | root dev |
| wrangler | 4.144.0 | root dev, server dev, sandbox dev |
| @types/node | 22.20.4 | root dev |
| zod | 4.6.5 (import from `zod/v4`) | protocol, server, views, host, bench |
| @modelcontextprotocol/server | 2.2.0 | server (protocol dev, for its SDK round-trip test) |
| @modelcontextprotocol/client | 2.2.0 | host, server dev (protocol dev) |
| @modelcontextprotocol/core | 2.2.0 | server, views, host (protocol dev) |
| @modelcontextprotocol/ext-apps | 2.0.3 | server, views, host (protocol dev) |
| @cloudflare/workers-types | 5.20260929.1 | server dev, sandbox dev |
| @strands-agents/sdk | 1.19.0 | bench |

## Extra pins (newest release at least 14 days old on 15 Oct 2026, or the version an earlier prototype already tested)

| Package | Version | Published | Where | Why |
| --- | --- | --- | --- | --- |
| vite | 8.3.1 | 2026-09-24 | root dev | Required peer of vitest 5.0.2. |
| openai | 6.49.0 | 2026-07-23 | bench | Strands' OpenAI-compatible model provider (for local llama.cpp) needs `openai@^6.45.0`; 6.49.0 is the newest 6.x. |
| @modelcontextprotocol/sdk | 1.31.0 | 2026-09-28 | bench | Required peer of @strands-agents/sdk 1.19.0 (`^1.25.2`). |
| @opentelemetry/api | 1.9.1 | 2026-03-25 | bench | Required peer of @strands-agents/sdk 1.19.0 (`^1.9.0`). |

## Workspace packages used by other workspaces

| Package | Version | Used by |
| --- | --- | --- |
| @fixwright/protocol | 0.1.0 (`*`) | engine, adapter-ha, router, server, views, host, bench |
| @fixwright/engine | 0.1.0 (`*`) | server, bench |
| @fixwright/router | 0.1.0 (`*` in host and server, `0.1.0` in bench) | host (in the page), server (`/assistant/route`), bench (routing before diagnose) |
| homefault | 0.1.0 (git submodule at `packages/homefault`, tag `v0.1.0`; `*` resolves to the workspace) | server, bench |
| @fixwright/adapter-ha | 0.1.0 (`*`) | server |
| @fixwright/sandbox | 0.1.0 | host (dev, for its e2e stack) |

Workspaces resolve to the local folders, so these are never fetched from a registry.

## Peer dependencies and `legacy-peer-deps`

npm 10.9.4 crashes while building the tree for this workspace
(`Cannot read properties of null (reading 'edgesOut')` in arborist's peer-set loader). Bisecting showed
the trigger is vitest 5.0.2's optional peer graph at the root. `.npmrc` therefore sets
`legacy-peer-deps=true`, and every required (non-optional) peer is pinned explicitly instead (the rows
above). After the install, a scan of all 287 installed packages found 12 required peer edges and all 12
resolve to a satisfying version.

## Install measurements (15 Oct 2026, warm npm cache)

- `npm install` at the root: 287 packages added in 11.2 s.
- `node_modules`: 1.2 GB (largest: onnxruntime-node 536 MB, @cloudflare 131 MB, onnxruntime-web 92 MB,
  
- Playwright 1.63.0 uses the preinstalled Chromium 153.0.8010.12 (build 1243) in `PLAYWRIGHT_BROWSERS_PATH`;
  the browsers folder stayed at 658 MB with the same three entries, so nothing was downloaded.
