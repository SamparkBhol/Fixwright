#!/usr/bin/env bash
# Stops what scripts/dev-up.sh started, by the PID files in $FIXWRIGHT_RUN (scripts/env.sh), each one a
# process group leader, so wrangler's workerd children go with it. Idempotent: nothing running, nothing done.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
RUN="$FIXWRIGHT_RUN"

group_alive() { kill -0 -- "-$1" 2>/dev/null || kill -0 "$1" 2>/dev/null; }

stopped=0
for name in server sandbox ntfy; do
  file="$RUN/$name.pid"
  [ -f "$file" ] || continue
  pid="$(cat "$file")"
  if [ -n "$pid" ] && group_alive "$pid"; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do group_alive "$pid" || break; sleep 0.1; done
    if group_alive "$pid"; then kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi
    stopped=$((stopped + 1))
  fi
  rm -f "$file"
done
echo "fixwright dev stack down ($stopped stopped)"
