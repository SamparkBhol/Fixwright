#!/usr/bin/env bash
# Starts llama-server (OpenAI-compatible API) on 127.0.0.1:8771 with gpt-oss-20b and waits until
# the model is loaded. Idempotent: a healthy server that this script started is left running.
set -euo pipefail
# shellcheck source=llm-config.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/llm-config.sh"

log() { printf '[start-llm] %s\n' "$*"; }

health_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$LLM_BASE_URL/health" || true
}

if [[ ! -x "$LLAMA_SERVER_BIN" || ! -f "$LLM_MODEL_FILE" ]]; then
  log "llama.cpp or the model is missing. Run $LLM_SCRIPT_DIR/fetch-llm.sh first."
  exit 1
fi

mkdir -p "$LLM_RUN_DIR"
existing_pid="$(cat "$LLM_PID_FILE" 2>/dev/null || true)"
if llm_pid_is_server "$existing_pid"; then
  if [[ "$(health_code)" == "200" ]]; then
    log "already running (pid $existing_pid) at $LLM_BASE_URL"
    exit 0
  fi
  log "pid $existing_pid exists but is not healthy yet; waiting for it"
else
  rm -f "$LLM_PID_FILE"
  if [[ "$(health_code)" != "000" ]]; then
    log "port $LLM_PORT is already taken by another process; refusing to start"
    exit 1
  fi
  args=(
    --model "$LLM_MODEL_FILE"
    --alias "$LLM_MODEL_ALIAS"
    --host "$LLM_HOST" --port "$LLM_PORT"
    --ctx-size "$LLM_CTX" --parallel "$LLM_PARALLEL"
    --threads "$LLM_THREADS" --threads-batch "$LLM_THREADS_BATCH"
    --flash-attn "$LLM_FLASH_ATTN" --load-mode "$LLM_LOAD_MODE"
    --jinja --reasoning-format auto --reasoning-effort "$LLM_REASONING_EFFORT"
    --cache-ram "$LLM_CACHE_RAM_MIB"
    --metrics --no-webui
    # Bound to loopback already; also stop browser pages on other origins from calling it.
    --cors-origins localhost
  )
  rm -f "$LLM_KEY_FILE"
  if [[ -n "$LLM_API_KEY" ]]; then
    # A key file, not --api-key, so the key never shows up in the process list.
    (umask 077 && printf '%s\n' "$LLM_API_KEY" > "$LLM_KEY_FILE")
    args+=(--api-key-file "$LLM_KEY_FILE")
  fi
  : > "$LLM_LOG_FILE"
  # setsid detaches the server from this shell so it outlives the script; stop-llm.sh ends it.
  # With job control off (the default in scripts) setsid execs in place, so $! is the server itself.
  set +m
  setsid "$LLAMA_SERVER_BIN" "${args[@]}" >> "$LLM_LOG_FILE" 2>&1 < /dev/null &
  existing_pid=$!
  echo "$existing_pid" > "$LLM_PID_FILE"
  log "started pid $existing_pid, log $LLM_LOG_FILE"
fi

started=$SECONDS
until [[ "$(health_code)" == "200" ]] && llm_pid_is_server "$existing_pid"; do
  if ! kill -0 "$existing_pid" 2>/dev/null; then
    log "server exited during startup; last log lines:"
    tail -n 20 "$LLM_LOG_FILE" >&2
    rm -f "$LLM_PID_FILE"
    exit 1
  fi
  if (( SECONDS - started > LLM_START_TIMEOUT_S )); then
    log "not healthy after ${LLM_START_TIMEOUT_S}s; stopping it"
    "$LLM_SCRIPT_DIR/stop-llm.sh" || true
    exit 1
  fi
  sleep 0.5
done
log "healthy after $(( SECONDS - started ))s: $LLM_BASE_URL/v1 (model alias $LLM_MODEL_ALIAS${LLM_API_KEY:+, API key required})"
