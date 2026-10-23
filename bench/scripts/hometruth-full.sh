#!/usr/bin/env bash
# The full HomeTruth run, unattended (hours). Run it detached:
#   setsid scripts/hometruth-full.sh >> "$LOG" 2>&1 < /dev/null &
# Phases: Fixwright on every set (start, skipped on a restart when already written), B1 and B2 on all 20 incidents and on a stratified held-out
# sample of 100 (10 per cause, seed 1), then Fixwright on every set again (the engine may have changed
# while the baselines ran), then results/HOMETRUTH.txt. Baseline runs use --resume, so a crash or a
# restart of this script loses at most the call in flight. On a crash the LLM server is restarted and
# the run resumed; on exit (normal or not) the LLM server is stopped.
set -uo pipefail
BENCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
if [ -f "$BENCH/../../tools/buildenv.sh" ]; then source "$BENCH/../../tools/buildenv.sh"; fi
LLM="$BENCH/llm"
# Other builds share this 16 vCPU machine, so llama.cpp gets 8 threads for both generation and
# prompt batches. The server command line (recorded in every result) shows it.
export LLM_THREADS="${LLM_THREADS:-8}" LLM_THREADS_BATCH="${LLM_THREADS_BATCH:-8}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-6}"
SEED=1
cd "$BENCH" || exit 1

log() { printf '[hometruth %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
stop_llm() { "$LLM/stop-llm.sh" || true; }
trap 'log "exiting; stopping the LLM server"; stop_llm' EXIT
trap 'exit 143' TERM INT

fixwright_runs() { # prefix
  local prefix="$1" set
  for set in dev heldout incidents all; do
    node src/run.ts --agents fixwright --set "$set" --out "$prefix-fixwright-$set" 2>&1 | tail -n 1 || return 1
  done
  node src/run.ts --agents fixwright --set all --fixwright-routing diagnose --out "$prefix-fixwright-all-diagnose-only" 2>&1 | tail -n 1
}

baseline() { # name, then run.ts arguments
  local name="$1"; shift
  local out="results/$name.json" ckpt="results/$name.partial.jsonl" attempt code
  if [[ -f "$out" && ! -f "$ckpt" ]]; then log "$name: already complete"; return 0; fi
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    if ! "$LLM/start-llm.sh"; then
      log "$name: the LLM server did not start (attempt $attempt); retrying in 60 s"
      stop_llm; sleep 60; continue
    fi
    log "$name: attempt $attempt"
    node src/run.ts "$@" --out "$name" --resume
    code=$?
    if [[ $code -eq 0 && ! -f "$ckpt" ]]; then log "$name: complete"; return 0; fi
    if [[ $code -eq 0 ]]; then log "$name: written, but some cases got no answer; restarting the LLM server to retry them"
    else log "$name: run.ts exited with $code; restarting the LLM server and resuming"; fi
    stop_llm; sleep 10
  done
  log "$name: gave up after $MAX_ATTEMPTS attempts"
  return 1
}

# The start runs are the before-baselines snapshot HOMETRUTH.txt measures engine drift against, so a
# restart keeps them instead of overwriting them with the engine as it is at restart time.
start_written() {
  local s
  for s in dev heldout incidents all all-diagnose-only; do [[ -f "results/hometruth-start-fixwright-$s.json" ]] || return 1; done
}

log "start: LLM_THREADS=$LLM_THREADS LLM_THREADS_BATCH=$LLM_THREADS_BATCH, pid $$"
if start_written; then log "start Fixwright runs: already written; kept as the before-baselines snapshot"
else fixwright_runs hometruth-start || log "start Fixwright runs failed"; fi
status=0
baseline hometruth-incidents-b1b2 --agents fixwright,b1,b2 --set incidents || status=1
baseline hometruth-heldout-b1b2-n100 --agents fixwright,b1,b2 --set heldout --n 100 --stratified --seed "$SEED" || status=1
stop_llm
log "final Fixwright runs on the engine as it is now"
fixwright_runs hometruth || status=1
node src/hometruth.ts || status=1
log "done (status $status)"
exit "$status"
