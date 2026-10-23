#!/usr/bin/env bash
# Downloads the pinned llama.cpp CPU build and the gpt-oss-20b GGUF into .cache/llm and
# verifies both by sha256. Safe to rerun: verified files are skipped.
set -euo pipefail
# shellcheck source=llm-config.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/llm-config.sh"

log() { printf '[fetch-llm] %s\n' "$*"; }

verify_sha256() { # file expected_sha
  local got
  got="$(sha256sum "$1" | cut -d' ' -f1)"
  if [[ "$got" != "$2" ]]; then
    log "checksum mismatch for $1: expected $2, got $got"
    return 1
  fi
}

fetch_llama() {
  local dl_dir="$LLM_HOME/dl/$LLAMA_TAG"
  local archive="$dl_dir/$LLAMA_ASSET"
  if [[ -x "$LLAMA_SERVER_BIN" ]]; then
    log "llama.cpp $LLAMA_TAG already installed at $LLAMA_DIR"
    return
  fi
  mkdir -p "$dl_dir" "$LLM_HOME/llama.cpp"
  if [[ ! -f "$archive" ]]; then
    log "downloading $LLAMA_ASSET"
    curl -fsSL -o "$archive.part" \
      "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG/$LLAMA_ASSET"
    mv "$archive.part" "$archive"
  fi
  verify_sha256 "$archive" "$LLAMA_ASSET_SHA256"
  tar -xzf "$archive" -C "$LLM_HOME/llama.cpp"
  log "llama.cpp installed: $("$LLAMA_SERVER_BIN" --version 2>&1 | grep -m1 '^version')"
}

fetch_model() {
  local marker="$LLM_MODEL_FILE.verified"
  if [[ -f "$LLM_MODEL_FILE" && -f "$marker" && "$(cat "$marker")" == "$LLM_MODEL_SHA256" ]]; then
    log "model already verified at $LLM_MODEL_FILE"
    return
  fi
  mkdir -p "$(dirname "$LLM_MODEL_FILE")"
  if [[ ! -f "$LLM_MODEL_FILE" ]]; then
    log "downloading $LLM_MODEL_REPO@$LLM_MODEL_REVISION/$LLM_MODEL_NAME (about 12 GB, resumable)"
    curl -fSL -C - -o "$LLM_MODEL_FILE.part" \
      "https://huggingface.co/$LLM_MODEL_REPO/resolve/$LLM_MODEL_REVISION/$LLM_MODEL_NAME"
    mv "$LLM_MODEL_FILE.part" "$LLM_MODEL_FILE"
  fi
  local size
  size="$(stat -c %s "$LLM_MODEL_FILE")"
  if [[ "$size" != "$LLM_MODEL_BYTES" ]]; then
    log "size mismatch: expected $LLM_MODEL_BYTES bytes, got $size"
    exit 1
  fi
  log "verifying sha256 (takes about 35 s)"
  verify_sha256 "$LLM_MODEL_FILE" "$LLM_MODEL_SHA256"
  printf '%s' "$LLM_MODEL_SHA256" > "$marker"
  log "model verified: $LLM_MODEL_FILE"
}

fetch_llama
fetch_model
