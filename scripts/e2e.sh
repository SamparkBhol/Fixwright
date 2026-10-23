#!/usr/bin/env bash
# End to end on the real local stack: (re)starts it with scripts/dev-up.sh, runs the Playwright tests in
# e2e/ (default the golden path), and always stops the stack again.
#   scripts/e2e.sh                 e2e/golden.e2e.ts
#   scripts/e2e.sh ha              the Home Assistant beat: starts adapter-ha's local Home Assistant on 8741,
#                                  runs e2e/home-assistant.e2e.ts with ALLOW_HA_LINK=1, stops the hub
# Extra arguments go to vitest.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
ROOT="$FIXWRIGHT_ROOT"
HA="$ROOT/packages/adapter-ha/scripts/ha-local.sh"
mode="${1:-golden}"
[ $# -gt 0 ] && shift

cleanup() {
  bash "$ROOT/scripts/dev-down.sh" >/dev/null || true
  if [ "$mode" = "ha" ]; then bash "$HA" stop >/dev/null || true; fi
}
trap cleanup EXIT

bash "$ROOT/scripts/dev-down.sh" >/dev/null
case "$mode" in
  golden)
    bash "$ROOT/scripts/dev-up.sh"
    E2E_INCLUDE=golden.e2e.ts "$ROOT/node_modules/.bin/vitest" run -c "$ROOT/e2e/vitest.config.ts" "$@"
    ;;
  ha)
    bash "$HA" start
    eval "$(bash "$HA" env)"
    export HA_URL HA_TOKEN HA_CONFIG_DIR
    ALLOW_HA_LINK=1 bash "$ROOT/scripts/dev-up.sh"
    E2E_INCLUDE=home-assistant.e2e.ts "$ROOT/node_modules/.bin/vitest" run -c "$ROOT/e2e/vitest.config.ts" "$@"
    ;;
  *)
    echo "usage: scripts/e2e.sh [golden|ha] [vitest args]"
    exit 2
    ;;
esac
