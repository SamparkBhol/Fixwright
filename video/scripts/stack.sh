#!/usr/bin/env bash
# A private copy of the Fixwright dev stack for the video, on the video's own ports, so a render never
# races other runs of scripts/dev-up.sh (which restart the shared stack on 8701/8702 and wipe its state).
#   http://127.0.0.1:8733  apps/server under wrangler dev --local (MCP at /mcp, the host page at /)
#   http://127.0.0.1:8734  apps/sandbox under wrangler dev --local (the views' second origin)
#   http://127.0.0.1:8735  scripts/ntfy-receiver.ts (the server's NTFY_BASE)
# It serves the builds that scripts/dev-up.sh made (apps/views/dist, and a copy of apps/host/dist taken at
# start) and builds nothing itself; the host is pointed at this sandbox with ?sandbox=. State and logs live in
# $FIXWRIGHT_TMP/fixwright-video-stack (scripts/env.sh). Usage: stack.sh up | down
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../scripts/env.sh"

VIDEO="$FIXWRIGHT_ROOT/video"
ROOT="$FIXWRIGHT_ROOT"
RUN="$FIXWRIGHT_TMP/fixwright-video-stack"
WRANGLER="$ROOT/node_modules/.bin/wrangler"
SERVER_PORT=8733 SANDBOX_PORT=8734 NTFY_PORT=8735 SERVER_INSPECTOR=8736 SANDBOX_INSPECTOR=8737
SERVER="http://127.0.0.1:$SERVER_PORT" SANDBOX="http://127.0.0.1:$SANDBOX_PORT" NTFY="http://127.0.0.1:$NTFY_PORT"
ORIGINS="$SERVER,http://localhost:$SERVER_PORT"
mkdir -p "$RUN"

alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
healthy() { node -e "fetch(process.argv[1],{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" "$1"; }
group_alive() { kill -0 -- "-$1" 2>/dev/null || kill -0 "$1" 2>/dev/null; }

down() {
  local stopped=0
  for name in server sandbox ntfy; do
    local file="$RUN/$name.pid"
    [ -f "$file" ] || continue
    local pid
    pid="$(cat "$file")"
    if [ -n "$pid" ] && group_alive "$pid"; then
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 50); do group_alive "$pid" || break; sleep 0.1; done
      if group_alive "$pid"; then kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi
      stopped=$((stopped + 1))
    fi
    rm -f "$file"
  done
  echo "video stack down ($stopped stopped)"
}

# Own process group per piece (set -m where there is no setsid, as on macOS), so down stops workerd too.
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

case "${1:-up}" in
  down) down; exit 0 ;;
  up) ;;
  *) echo "usage: stack.sh up|down"; exit 2 ;;
esac

if alive ntfy && alive sandbox && alive server && healthy "$SERVER/health" && healthy "$SANDBOX/sandbox.html" && healthy "$NTFY/health"; then
  echo "video stack already up: $SERVER"
  exit 0
fi
down >/dev/null
for f in "$ROOT/apps/views/dist/stepper.html" "$ROOT/apps/views/dist/carousel.html" "$ROOT/apps/views/dist/repair-card.html" "$ROOT/apps/host/dist/app.js"; do
  [ -s "$f" ] || { echo "missing build $f: run npm run dev:up (or the package builds) once first"; exit 1; }
done
rm -rf "$RUN/state-server" "$RUN/state-sandbox" "$RUN/host-dist"
# A private copy of the host page: other runs rebuild apps/host/dist in place, which leaves a running
# wrangler answering 500 for /.
cp -r "$ROOT/apps/host/dist" "$RUN/host-dist"
export X_LOCAL_OBSERVABILITY=false X_LOCAL_EXPLORER=false

start ntfy node --no-warnings "$ROOT/scripts/ntfy-receiver.ts" "$NTFY_PORT"
( cd "$ROOT/apps/sandbox" && start sandbox "$WRANGLER" dev --local --ip 127.0.0.1 --port "$SANDBOX_PORT" \
    --inspector-ip 127.0.0.1 --inspector-port "$SANDBOX_INSPECTOR" --persist-to "$RUN/state-sandbox" \
    --show-interactive-dev-session=false --var "HOST_ORIGINS:$ORIGINS" )
( cd "$ROOT/apps/server" && start server "$WRANGLER" dev --local --ip 127.0.0.1 --port "$SERVER_PORT" \
    --inspector-ip 127.0.0.1 --inspector-port "$SERVER_INSPECTOR" --persist-to "$RUN/state-server" \
    --show-interactive-dev-session=false --assets "$RUN/host-dist" \
    --var "CONFIRM_SECRET:fixwright-local-dev-only-confirm-secret-0001" \
    --var "NTFY_BASE:$NTFY" \
    --var "ALLOWED_ORIGINS:$ORIGINS" \
    --var "DEMO_START:${FIXWRIGHT_DEMO_START:-2026-10-15T22:00:00.000Z}" \
    --var "ALLOW_HA_LINK:0" \
    --var "RATE_MCP_PER_MIN:240" \
    --var "RATE_DEMO_PER_MIN:30" )

for _ in $(seq 1 300); do
  if healthy "$SERVER/health" && healthy "$SANDBOX/sandbox.html" && healthy "$NTFY/health"; then
    echo "video stack up: $SERVER (sandbox $SANDBOX, ntfy $NTFY); logs in $RUN"
    exit 0
  fi
  for p in ntfy sandbox server; do
    if ! alive "$p"; then echo "$p exited, see $RUN/$p.log"; tail -15 "$RUN/$p.log"; down >/dev/null; exit 1; fi
  done
  sleep 0.2
done
echo "video stack did not become healthy in 60 s, see $RUN/*.log"
down >/dev/null
exit 1
