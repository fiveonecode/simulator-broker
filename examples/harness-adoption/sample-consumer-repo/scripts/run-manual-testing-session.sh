#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
run_dir="${BROKER_RUN_DIR:-$REPO_ROOT/.tmp/manual-testing}"
actor_id="${BROKER_ACTOR_ID:-${USER:-human-local}}"

mkdir -p "$run_dir"

bash "$SCRIPT_DIR/with-broker-lease.sh" \
  --purpose manual-testing \
  --actor-type human \
  --actor-id "$actor_id" \
  --run-dir "$run_dir" \
  -- node "$SCRIPT_DIR/write-session-report.mjs" "$run_dir/manual-testing-report.json"
