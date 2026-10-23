#!/usr/bin/env bash
# Home Assistant run of the server: start adapter-ha's local Home Assistant 2026.9.4 (127.0.0.1:8741),
# run test/integration/ha.test.ts against it through wrangler dev (ports 8704 to 8706), stop the hub.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../../scripts/env.sh"
SERVER="$FIXWRIGHT_ROOT/apps/server"
HA="$SERVER/../../packages/adapter-ha/scripts/ha-local.sh"
cleanup() { bash "$HA" stop || true; }
trap cleanup EXIT
bash "$HA" start
eval "$(bash "$HA" env)"
cd "$SERVER"
FIXWRIGHT_HA=1 "$SERVER/../../node_modules/.bin/vitest" run test/integration/ha.test.ts
