#!/usr/bin/env bash
# One command for the live suite: start the local Home Assistant fixture (scripts/ha-local.sh), run every
# test tagged integration (including the workerd smoke test on port 8742), stop Home Assistant, and check
# that nothing this script started is still running. Exit code is the test result.
#   scripts/integration.sh                       everything
#   scripts/integration.sh --tags-filter '!workerd'   extra vitest arguments are passed through
set -uo pipefail
BUILDENV="${FIXWRIGHT_ENV:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)/tools/buildenv.sh}"
# shellcheck source=/dev/null
[ -f "$BUILDENV" ] && source "$BUILDENV"
PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC2329 # both run from the EXIT trap
leftovers() { pgrep -fa "$PKG/.runtime/config|$PKG/worker|wrangler.js dev --ip 127.0.0.1 --port 8742" | grep -v -e pgrep -e integration.sh || true; }
# shellcheck disable=SC2329
cleanup() {
  bash "$PKG/scripts/ha-local.sh" stop
  local left
  left="$(leftovers)"
  if [ -n "$left" ]; then
    echo "integration: stopping leftovers:"; echo "$left"
    echo "$left" | awk '{print $1}' | xargs -r kill -TERM 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

bash "$PKG/scripts/ha-local.sh" start || exit 1
eval "$(bash "$PKG/scripts/ha-local.sh" env)"
export HA_RESULTS_DIR="${HA_RESULTS_DIR:-$PKG/.runtime/results}"
cd "$PKG" || exit 2
T0=$(date +%s%3N)
npx vitest run --tags-filter integration "$@"
RC=$?
echo "integration: vitest exit $RC in $(( $(date +%s%3N) - T0 )) ms; results in $HA_RESULTS_DIR"
exit $RC
