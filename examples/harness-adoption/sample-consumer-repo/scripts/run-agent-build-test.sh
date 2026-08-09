#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
run_dir="${BROKER_RUN_DIR:-$REPO_ROOT/.tmp/agent-build-test}"
session_dir="${SESSION_DIR:-$run_dir/session}"
actor_id="${BROKER_ACTOR_ID:-agent-build}"
job_id="${BROKER_JOB_ID:-$actor_id-build}"
job_kind="${BROKER_JOB_KIND:-agent-build-test}"

mkdir -p "$run_dir" "$session_dir"

bash "$SCRIPT_DIR/with-broker-lease.sh" \
  --purpose agent-build-test \
  --actor-type agent \
  --actor-id "$actor_id" \
  --job-id "$job_id" \
  --job-kind "$job_kind" \
  --session-dir "$session_dir" \
  --run-dir "$run_dir" \
  -- node "$SCRIPT_DIR/write-session-report.mjs" "$run_dir/agent-build-test-report.json"
