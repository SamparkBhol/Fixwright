#!/usr/bin/env bash
# Runs as the root prepare script, so after npm ci or npm install. packages/homefault is a git submodule
# (the homefault repo, pinned by commit); a clone made without --recurse-submodules leaves it empty, npm
# still links it, and every import of 'homefault' fails later with a less helpful error.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/packages/homefault/package.json"
HOMEFAULT_TAG="v0.1.0"

[ -f "$PKG" ] && exit 0
if git -C "$ROOT" ls-files --stage -- packages/homefault 2> /dev/null | grep -q '^160000'; then
  echo "homefault: fetching the packages/homefault submodule" >&2
  git -C "$ROOT" submodule update --init packages/homefault || true
fi
# A checkout with no submodule entry in its index (or no git at all) still names the repository in
# .gitmodules, so clone the release tag from there.
if [ ! -f "$PKG" ] && command -v git > /dev/null 2>&1; then
  URL="$(git config -f "$ROOT/.gitmodules" --get submodule.packages/homefault.url 2>/dev/null || true)"
  case "$URL" in
    "" | *"{{"* | ../* | ./*) ;;
    *)
      echo "homefault: cloning $URL at $HOMEFAULT_TAG" >&2
      rmdir "$ROOT/packages/homefault" 2> /dev/null || true
      git clone --quiet --depth 1 --branch "$HOMEFAULT_TAG" "$URL" "$ROOT/packages/homefault" || true
      ;;
  esac
fi
if [ ! -f "$PKG" ]; then
  echo "homefault: packages/homefault is empty. Clone with git clone --recurse-submodules, or run" >&2
  echo "git submodule update --init in the checkout, then npm ci again." >&2
  exit 1
fi
