#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
run_dir="${BROKER_RUN_DIR:-$REPO_ROOT/.tmp/agent-ui-session}"
session_dir="${SESSION_DIR:-$run_dir/session}"
actor_id="${BROKER_ACTOR_ID:-agent-local}"

mkdir -p "$run_dir" "$session_dir"

bash "$SCRIPT_DIR/with-broker-lease.sh" \
  --purpose agent-ui-session \
  --actor-type agent \
  --actor-id "$actor_id" \
  --session-dir "$session_dir" \
  --run-dir "$run_dir" \
  -- node "$SCRIPT_DIR/write-session-report.mjs" "$run_dir/agent-ui-session-report.json"
