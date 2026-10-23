#!/usr/bin/env bash
# Health check for the local LLM server. Exit 0 when healthy, 1 otherwise.
#   health-llm.sh          liveness: /health and /v1/models
#   health-llm.sh --deep   also asks for a tiny JSON answer to prove generation works
set -euo pipefail
# shellcheck source=llm-config.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/llm-config.sh"

fail() { printf '[health-llm] DOWN: %s\n' "$*"; exit 1; }
# Harmless when the server has no key; required when it was started with LLM_API_KEY.
auth=(-H "Authorization: Bearer ${LLM_API_KEY:-local-no-key}")

health="$(curl -s --max-time 3 -w '\n%{http_code}' "$LLM_BASE_URL/health" || true)"
code="${health##*$'\n'}"
case "$code" in
  200) ;;
  000|"") fail "nothing answers at $LLM_BASE_URL (start it with start-llm.sh)" ;;
  503) fail "$LLM_BASE_URL is up but the model is still loading" ;;
  *) fail "$LLM_BASE_URL/health answered HTTP $code" ;;
esac

models="$(curl -s --max-time 3 "${auth[@]}" -w '\n%{http_code}' "$LLM_BASE_URL/v1/models" || true)"
models_code="${models##*$'\n'}"
case "$models_code" in
  200) ;;
  401) fail "the server requires an API key; set LLM_API_KEY to the key it was started with" ;;
  *) fail "/v1/models answered HTTP ${models_code:-000}" ;;
esac
grep -q "\"$LLM_MODEL_ALIAS\"" <<< "$models" || fail "/v1/models does not list $LLM_MODEL_ALIAS"

pid="$(cat "$LLM_PID_FILE" 2>/dev/null || echo '?')"
rss_kib="$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status" 2>/dev/null || echo '?')"
printf '[health-llm] UP: %s/v1 model=%s pid=%s rss_kib=%s\n' "$LLM_BASE_URL" "$LLM_MODEL_ALIAS" "$pid" "$rss_kib"

if [[ "${1:-}" == "--deep" ]]; then
  body='{"model":"'"$LLM_MODEL_ALIAS"'","temperature":0,"max_tokens":256,
    "messages":[{"role":"user","content":"Reply with a JSON object {\"ok\": true}."}],
    "response_format":{"type":"json_schema","json_schema":{"name":"ping","strict":true,
      "schema":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}}}}'
  started=$(date +%s%3N)
  reply="$(curl -fs --max-time 120 "${auth[@]}" -H 'content-type: application/json' -d "$body" "$LLM_BASE_URL/v1/chat/completions")" \
    || fail "chat completion failed"
  elapsed=$(( $(date +%s%3N) - started ))
  python3 -I -c 'import json,sys; d=json.loads(sys.stdin.read()); c=d["choices"][0]["message"]["content"]; assert json.loads(c)["ok"] is True, c' <<< "$reply" \
    || fail "generation did not return the expected JSON: $reply"
  printf '[health-llm] DEEP OK: JSON round trip in %s ms\n' "$elapsed"
fi
