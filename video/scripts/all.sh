#!/usr/bin/env bash
# npm run video:all: TTS, timeline, record, compose and verify, end to end.
# Without FIXWRIGHT_SERVER it starts the video's private stack (scripts/stack.sh, ports 8733 to 8737) and
# stops it again afterwards; with FIXWRIGHT_SERVER it records against that server instead.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/../../scripts/env.sh"
VIDEO="$FIXWRIGHT_ROOT/video"
started=0
if [ -z "${FIXWRIGHT_SERVER:-}" ]; then
  bash "$VIDEO/scripts/stack.sh" up
  started=1
fi
cleanup() { if [ "$started" = 1 ]; then bash "$VIDEO/scripts/stack.sh" down >/dev/null || true; fi; }
trap cleanup EXIT
cd "$VIDEO"
t0=$(node -p 'Date.now()')
mkdir -p out
# onnxruntime prints a long minified line on some errors; keep the log, show the useful lines.
if ! node --no-warnings tts.ts >out/tts.log 2>&1; then grep -v pthread_setaffinity out/tts.log | cut -c1-300 | tail -20; exit 1; fi
grep -E '^tts' out/tts.log || true
node --no-warnings timeline.ts
node --no-warnings record.ts
node --no-warnings compose.ts
t1=$(node -p 'Date.now()')
node -e "console.log('video:all wall ' + ((Number(process.argv[2]) - Number(process.argv[1])) / 1000).toFixed(1) + ' s')" "$t0" "$t1"
