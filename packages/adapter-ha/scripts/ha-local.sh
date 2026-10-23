#!/usr/bin/env bash
# Local Home Assistant 2026.9.4 for the adapter's integration tests. No Docker: it runs hass from a local
# Home Assistant venv (HA_HOME, reused by path, never modified) with a fresh copy of
# fixtures/home-assistant/config each time.
#
#   scripts/ha-local.sh start    boot on 127.0.0.1:8741, onboard headlessly, write a long lived token to
#                                .secrets/ha.json, then set up the fixture (area, aliases, all devices off)
#   scripts/ha-local.sh stop     SIGTERM, SIGKILL only after 60 s; removes the dead instance's token
#   scripts/ha-local.sh status
#   eval "$(scripts/ha-local.sh env)"   exports HA_URL, HA_TOKEN, HA_CONFIG_DIR and HA_LOG_FILE
#
# Overrides: HA_HOME (folder holding .venv with homeassistant==2026.9.4 on Python 3.14, default
# packages/adapter-ha/.ha), HASS_BIN, HASS_TIMEOUT (hard stop in seconds, default 1800).
set -euo pipefail
BUILDENV="${FIXWRIGHT_ENV:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)/tools/buildenv.sh}"
# shellcheck source=/dev/null
[ -f "$BUILDENV" ] && source "$BUILDENV"

PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HA_HOME="${HA_HOME:-$PKG/.ha}"
HASS="${HASS_BIN:-$HA_HOME/.venv/bin/hass}"
RUN="$PKG/.runtime"
CONFIG="$RUN/config"
SECRETS="$PKG/.secrets/ha.json"
PORT=8741
URL="http://127.0.0.1:$PORT"
ms() { date +%s%3N; }
# Python must not write bytecode caches into the shared venv: it stays byte for byte as it was.
export PYTHONDONTWRITEBYTECODE=1

our_pids() { pgrep -f "$HASS -c $CONFIG" || true; }

stop() {
  local t0 pid
  t0=$(ms)
  pid=$(cat "$RUN/hass.pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid" 2>/dev/null || true; fi
  for p in $(our_pids); do kill -TERM "$p" 2>/dev/null || true; done
  for _ in $(seq 1 600); do [ -z "$(our_pids)" ] && break; sleep 0.1; done
  if [ -n "$(our_pids)" ]; then
    for p in $(our_pids); do kill -KILL "$p" 2>/dev/null || true; done
    echo "ha-local: had to SIGKILL"
  fi
  rm -f "$RUN/hass.pid" "$SECRETS"
  echo "ha-local: stopped in $(( $(ms) - t0 )) ms"
}

start() {
  [ -x "$HASS" ] || { echo "ha-local: no hass at $HASS (set HASS_BIN to a Home Assistant 2026.9.4 hass binary)" >&2; exit 2; }
  stop >/dev/null
  if curl -s -o /dev/null --max-time 1 "$URL/api/"; then
    echo "ha-local: something else already answers on port $PORT; stop it first" >&2
    exit 2
  fi
  mkdir -p "$RUN"
  rm -rf "$CONFIG" "$RUN/hass.log" "$RUN/hass.log.1" "$RUN/hass.stdout"
  cp -r "$PKG/fixtures/home-assistant/config" "$CONFIG"
  # Local overlays only (the CI container ships both): ffmpeg from ffmpeg-static, libturbojpeg extracted
  # into the venv folder's tools dir. Without them hass logs harmless ERROR lines at boot.
  local ff=""
  for f in "$HA_HOME/node_modules/ffmpeg-static/ffmpeg" "$PKG/../../node_modules/ffmpeg-static/ffmpeg"; do
    [ -x "$f" ] && { ff="$f"; break; }
  done
  [ -n "$ff" ] && printf '\nffmpeg:\n  ffmpeg_bin: %s\n' "$ff" >> "$CONFIG/configuration.yaml"
  local tj="$HA_HOME/tools/libturbojpeg/usr/lib/x86_64-linux-gnu"
  [ -e "$tj/libturbojpeg.so.0" ] && export LD_LIBRARY_PATH="$tj${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

  local start_ms
  start_ms=$(ms)
  echo "$start_ms" > "$RUN/hass_start_ms"
  nohup timeout --signal=TERM --kill-after=30 "${HASS_TIMEOUT:-1800}" "$HASS" -c "$CONFIG" --skip-pip \
    --log-file "$RUN/hass.log" --log-no-color > "$RUN/hass.stdout" 2>&1 < /dev/null &
  echo $! > "$RUN/hass.pid"
  echo "ha-local: hass launched (pid $(cat "$RUN/hass.pid"), port $PORT)"

  if ! HA_URL="$URL" HA_START_MS="$start_ms" HA_SECRETS="$SECRETS" node "$PKG/scripts/onboard.ts"; then
    echo "ha-local: onboarding failed; last log lines:" >&2
    tail -n 20 "$RUN/hass.log" >&2 || true
    stop
    exit 1
  fi
  HA_SECRETS="$SECRETS" HA_CONFIG_DIR="$CONFIG" node "$PKG/fixtures/home-assistant/inject.ts" setup
  echo "ha-local: ready at $URL in $(( $(ms) - start_ms )) ms"
}

status() {
  if [ -n "$(our_pids)" ]; then echo "running (pids $(our_pids | tr '\n' ' '))"; else echo "stopped"; fi
}

env_exports() {
  [ -s "$SECRETS" ] || { echo "ha-local: no $SECRETS; run start first" >&2; exit 2; }
  # shellcheck disable=SC2016 # a JavaScript template literal, not shell
  node -e 'const s=require(process.argv[1]); console.log(`export HA_URL=${s.url}\nexport HA_TOKEN=${s.token}`)' "$SECRETS"
  echo "export HA_CONFIG_DIR=$CONFIG"
  echo "export HA_LOG_FILE=$RUN/hass.log"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  env) env_exports ;;
  *) echo "usage: $0 start|stop|status|env" >&2; exit 2 ;;
esac
