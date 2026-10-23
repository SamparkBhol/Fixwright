#!/usr/bin/env bash
# Stops the llama-server started by start-llm.sh. Only signals the pid in the pid file, and only
# after checking that the pid really is our llama-server on our port.
set -euo pipefail
# shellcheck source=llm-config.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/llm-config.sh"

log() { printf '[stop-llm] %s\n' "$*"; }

pid="$(cat "$LLM_PID_FILE" 2>/dev/null || true)"
if [[ -z "$pid" ]]; then
  log "no pid file; nothing to stop"
  exit 0
fi
if ! llm_pid_is_server "$pid"; then
  log "pid $pid is not our llama-server (already gone); removing stale pid file"
  rm -f "$LLM_PID_FILE" "$LLM_KEY_FILE"
  exit 0
fi

kill -TERM "$pid"
for _ in $(seq 1 60); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.25
done
if kill -0 "$pid" 2>/dev/null; then
  log "pid $pid ignored SIGTERM for 15 s; sending SIGKILL"
  kill -KILL "$pid"
fi
rm -f "$LLM_PID_FILE" "$LLM_KEY_FILE"
log "stopped pid $pid"
