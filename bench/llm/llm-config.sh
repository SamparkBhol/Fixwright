# Shared settings for the local LLM scripts. Sourced, never executed.
# Every value can be overridden from the environment before calling a script.

LLM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The folder that holds the checkout; the model cache lives there, outside the repo.
LLM_WORKSPACE_ROOT="${LLM_WORKSPACE_ROOT:-$(cd "$LLM_SCRIPT_DIR/../../.." && pwd)}"

# The build workspace keeps caches and temp files beside the checkout. A fresh clone has no such file.
# shellcheck source=/dev/null
if [ -f "$LLM_WORKSPACE_ROOT/tools/buildenv.sh" ]; then source "$LLM_WORKSPACE_ROOT/tools/buildenv.sh"; fi

LLM_HOME="${LLM_HOME:-$LLM_WORKSPACE_ROOT/.cache/llm}"

# llama.cpp prebuilt: stable release v0.5.0 (2026-09-23), whose binaries ship as nightly build b11146.
LLAMA_TAG="${LLAMA_TAG:-b11146}"
LLAMA_ASSET="llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz"
LLAMA_ASSET_SHA256="${LLAMA_ASSET_SHA256:-c150306eb16b5ab696f76a8bdf810c35fd98a24e82158742e6fa28f420ff8410}"
LLAMA_DIR="${LLAMA_DIR:-$LLM_HOME/llama.cpp/llama-$LLAMA_TAG}"
LLAMA_SERVER_BIN="$LLAMA_DIR/llama-server"

# Model: ggml-org/gpt-oss-20b-GGUF at a pinned repo revision, MXFP4 weights (Apache-2.0).
LLM_MODEL_REPO="ggml-org/gpt-oss-20b-GGUF"
LLM_MODEL_REVISION="${LLM_MODEL_REVISION:-ef9b12f2ff56c69cf32153a02784e7a3c88bf524}"
LLM_MODEL_NAME="gpt-oss-20b-MXFP4.gguf"
LLM_MODEL_SHA256="${LLM_MODEL_SHA256:-27cd6c432c7672cb812a92f611cf3ba7bbc35928262bb1e1253ff4ee6ae35901}"
LLM_MODEL_BYTES="${LLM_MODEL_BYTES:-12109566624}"
LLM_MODEL_FILE="${LLM_MODEL_FILE:-$LLM_HOME/models/$LLM_MODEL_NAME}"
LLM_MODEL_ALIAS="${LLM_MODEL_ALIAS:-gpt-oss-20b}"

# Server. The LLM tools use ports 8771 to 8779; the server takes 8771.
LLM_HOST="${LLM_HOST:-127.0.0.1}"
LLM_PORT="${LLM_PORT:-8771}"
LLM_CTX="${LLM_CTX:-16384}"
LLM_PARALLEL="${LLM_PARALLEL:-1}"
LLM_THREADS="${LLM_THREADS:-8}"
LLM_THREADS_BATCH="${LLM_THREADS_BATCH:-10}"
LLM_FLASH_ATTN="${LLM_FLASH_ATTN:-on}"
# none = read the GGUF into private memory: peak RSS about 12 GiB, start about 18 s.
# auto = mmap it: start about 9 s, but peak RSS about 21 GiB (the mapped file pages count as resident).
LLM_LOAD_MODE="${LLM_LOAD_MODE:-none}"
LLM_REASONING_EFFORT="${LLM_REASONING_EFFORT:-low}"
LLM_CACHE_RAM_MIB="${LLM_CACHE_RAM_MIB:-2048}"
LLM_START_TIMEOUT_S="${LLM_START_TIMEOUT_S:-180}"
# Optional. When set, llama-server requires "Authorization: Bearer <key>" on every API call (not on
# /health), which also shuts out a DNS-rebinding web page. The TypeScript clients read the same
# variable. Unset by default: the server is bound to loopback.
LLM_API_KEY="${LLM_API_KEY:-}"

LLM_RUN_DIR="${LLM_RUN_DIR:-$LLM_HOME/run}"
# One pid file, log and key file per port, so a server started on another port never touches the
# files of the one on 8771 (a shared pid file once orphaned a server). Derived, not overridable.
LLM_PID_FILE="$LLM_RUN_DIR/llama-server-$LLM_PORT.pid"
LLM_LOG_FILE="$LLM_RUN_DIR/llama-server-$LLM_PORT.log"
LLM_KEY_FILE="$LLM_RUN_DIR/llama-server-$LLM_PORT.key"
LLM_BASE_URL="http://$LLM_HOST:$LLM_PORT"

# True only if pid runs our llama-server binary (not a wrapper such as setsid) on our port.
llm_pid_is_server() {
  local pid="$1"
  [[ -n "$pid" && -e "/proc/$pid/exe" ]] || return 1
  [[ "$(readlink -f "/proc/$pid/exe")" == "$(readlink -f "$LLAMA_SERVER_BIN")" ]] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q -- "--port $LLM_PORT "
}
