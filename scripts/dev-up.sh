#!/usr/bin/env bash
# Starts the whole Fixwright stack on this machine, no account and no Docker:
#   http://127.0.0.1:8701  apps/server under `wrangler dev --local` (MCP at /mcp, the host page at /)
#   http://127.0.0.1:8702  apps/sandbox under `wrangler dev --local` (the views' second origin)
#   http://127.0.0.1:8703  a local ntfy receiver (scripts/ntfy-receiver.ts); the server pushes there
# The views (apps/views/dist) and the host (apps/host/dist, built with the sandbox origin above) are built
# first. PID files and logs live in $FIXWRIGHT_RUN (scripts/env.sh). Idempotent: a stack that is already up
# and healthy is left alone; a half dead one is stopped and started again.
#
# Environment (all optional):
#   FIXWRIGHT_DEMO_START   where a new house starts (default 2026-10-15T22:00:00.000Z, 15:00 in the house)
#   ALLOW_HA_LINK=1        allow /demo/link-ha (for the Home Assistant beat)
#   FIXWRIGHT_RATE_MCP     MCP requests per IP per minute (default 240, the deploy value)
#   FIXWRIGHT_RATE_DEMO    demo route requests per IP per minute (default 30)
#   FIXWRIGHT_FRESH=1      wipe the local Durable Object state before starting (default 1)
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
ROOT="$FIXWRIGHT_ROOT"
RUN="$FIXWRIGHT_RUN"
WRANGLER="$ROOT/node_modules/.bin/wrangler"
SERVER_PORT=8701 SANDBOX_PORT=8702 NTFY_PORT=8703 SERVER_INSPECTOR=8705 SANDBOX_INSPECTOR=8706
SERVER="http://127.0.0.1:$SERVER_PORT" SANDBOX="http://127.0.0.1:$SANDBOX_PORT" NTFY="http://127.0.0.1:$NTFY_PORT"
HOST_ORIGINS="$SERVER,http://localhost:$SERVER_PORT"
mkdir -p "$RUN"

alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
healthy() { node -e "fetch(process.argv[1],{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" "$1"; }

if alive ntfy && alive sandbox && alive server && healthy "$SERVER/health" && healthy "$SANDBOX/sandbox.html" && healthy "$NTFY/health"; then
  echo "fixwright dev stack already up: $SERVER (sandbox $SANDBOX, ntfy $NTFY)"
  exit 0
fi
bash "$ROOT/scripts/dev-down.sh" >/dev/null

# Builds: views (single file HTML the server imports), the sandbox proxy script, the host page.
( cd "$ROOT" && npm run build --silent -w @fixwright/views >"$RUN/build.log" 2>&1 \
  && npm run build --silent -w @fixwright/sandbox >>"$RUN/build.log" 2>&1 \
  && SANDBOX_URL="$SANDBOX/sandbox.html" npm run build --silent -w @fixwright/host >>"$RUN/build.log" 2>&1 ) \
  || { echo "build failed, see $RUN/build.log"; tail -20 "$RUN/build.log"; exit 1; }

if [ "${FIXWRIGHT_FRESH:-1}" = "1" ]; then rm -rf "$RUN/state-server" "$RUN/state-sandbox"; fi
export X_LOCAL_OBSERVABILITY=false X_LOCAL_EXPLORER=false

# Each piece gets its own process group, so dev-down stops wrangler and its workerd children together.
# macOS has no setsid; there job control (set -m) gives the background job its own group.
start() {
  local name="$1"; shift
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >"$RUN/$name.log" 2>&1 < /dev/null &
  else
    set -m
    "$@" >"$RUN/$name.log" 2>&1 < /dev/null &
    set +m
  fi
  echo $! >"$RUN/$name.pid"
}

start ntfy node --no-warnings "$ROOT/scripts/ntfy-receiver.ts" "$NTFY_PORT"
( cd "$ROOT/apps/sandbox" && start sandbox "$WRANGLER" dev --local --ip 127.0.0.1 --port "$SANDBOX_PORT" \
    --inspector-ip 127.0.0.1 --inspector-port "$SANDBOX_INSPECTOR" --persist-to "$RUN/state-sandbox" \
    --show-interactive-dev-session=false --var "HOST_ORIGINS:$HOST_ORIGINS" )
( cd "$ROOT/apps/server" && start server "$WRANGLER" dev --local --ip 127.0.0.1 --port "$SERVER_PORT" \
    --inspector-ip 127.0.0.1 --inspector-port "$SERVER_INSPECTOR" --persist-to "$RUN/state-server" \
    --show-interactive-dev-session=false \
    --var "CONFIRM_SECRET:fixwright-local-dev-only-confirm-secret-0001" \
    --var "NTFY_BASE:$NTFY" \
    --var "ALLOWED_ORIGINS:$HOST_ORIGINS" \
    --var "DEMO_START:${FIXWRIGHT_DEMO_START:-2026-10-15T22:00:00.000Z}" \
    --var "ALLOW_HA_LINK:${ALLOW_HA_LINK:-0}" \
    --var "RATE_MCP_PER_MIN:${FIXWRIGHT_RATE_MCP:-240}" \
    --var "RATE_DEMO_PER_MIN:${FIXWRIGHT_RATE_DEMO:-30}" )

for _ in $(seq 1 300); do
  if healthy "$SERVER/health" && healthy "$SANDBOX/sandbox.html" && healthy "$NTFY/health"; then
    echo "fixwright dev stack up: open $SERVER/ (sandbox $SANDBOX, ntfy receiver $NTFY/_received)"
    echo "logs and PID files: $RUN"
    exit 0
  fi
  for p in ntfy sandbox server; do
    if ! alive "$p"; then echo "$p exited, see $RUN/$p.log"; tail -15 "$RUN/$p.log"; bash "$ROOT/scripts/dev-down.sh" >/dev/null; exit 1; fi
  done
  sleep 0.2
done
echo "stack did not become healthy in 60 s, see $RUN/*.log"
bash "$ROOT/scripts/dev-down.sh" >/dev/null
exit 1
