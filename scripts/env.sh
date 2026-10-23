# Sourced by the repo's shell scripts. Sets FIXWRIGHT_ROOT (the checkout) and FIXWRIGHT_RUN (PID files and
# logs of the local stack). An environment file, when one exists, is sourced first: FIXWRIGHT_ENV, else
# tools/buildenv.sh beside the checkout (the build workspace keeps caches and temp files there). A fresh
# clone has neither and runs with the caller's own environment.
FIXWRIGHT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXWRIGHT_ENV="${FIXWRIGHT_ENV:-$FIXWRIGHT_ROOT/../tools/buildenv.sh}"
# shellcheck source=/dev/null
if [ -f "$FIXWRIGHT_ENV" ]; then source "$FIXWRIGHT_ENV"; fi
FIXWRIGHT_TMP="${BUILD_ROOT:-$FIXWRIGHT_ROOT}/.tmp"
FIXWRIGHT_RUN="$FIXWRIGHT_TMP/fixwright-dev"
export FIXWRIGHT_ROOT FIXWRIGHT_TMP FIXWRIGHT_RUN
