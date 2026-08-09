#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS_DIR="$ROOT_DIR/agent-harness"
HARNESS_TSX="$HARNESS_DIR/node_modules/.bin/tsx"
HARNESS_LOCKFILE="$HARNESS_DIR/package-lock.json"
HARNESS_LOCK_STAMP="$HARNESS_DIR/node_modules/.package-lock.json"

needs_install=0

if [[ ! -x "$HARNESS_TSX" ]]; then
  needs_install=1
elif [[ ! -f "$HARNESS_LOCK_STAMP" ]]; then
  needs_install=1
elif [[ "$HARNESS_LOCKFILE" -nt "$HARNESS_LOCK_STAMP" ]]; then
  needs_install=1
fi

if (( needs_install )); then
  npm ci --prefix "$HARNESS_DIR"
fi
