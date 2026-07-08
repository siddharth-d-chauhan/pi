#!/usr/bin/env bash
# Rebuild pi from source so the `pi` symlink picks up local changes.
#
# Usage:
#   ./rebuild.sh             # full rebuild of all packages
#   ./rebuild.sh coding-agent # rebuild only the named workspace
#
# Works from any directory — resolves to ~/pi/ (the repo root).
set -euo pipefail

REPO="${PI_REPO:-$HOME/pi}"

if [[ ! -d "$REPO" ]]; then
  echo "error: repo not found at $REPO (set PI_REPO to override)" >&2
  exit 1
fi

cd "$REPO"

if [[ $# -eq 0 ]]; then
  echo ">> full rebuild: tui → ai → agent → coding-agent → orchestrator"
  npm run build
else
  for pkg in "$@"; do
    if [[ ! -d "packages/$pkg" ]]; then
      echo "error: no workspace packages/$pkg" >&2
      exit 1
    fi
    echo ">> building packages/$pkg"
    (cd "packages/$pkg" && npm run build)
  done
fi

echo ">> done. `pi --version` -> $(pi --version)"