#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
run_dir="${BROKER_RUN_DIR:-$REPO_ROOT/.tmp/ci-ui-test}"
actor_id="${BROKER_ACTOR_ID:-ci-runner}"
job_id="${CI_JOB_ID:-local-ci-job}"
job_kind="${CI_JOB_KIND:-ui-test}"

mkdir -p "$run_dir"

export CI_JOB_ID="$job_id"
export CI_JOB_KIND="$job_kind"

bash "$REPO_ROOT/scripts/with-broker-lease.sh" \
  --purpose ci-ui-test \
  --actor-type ci \
  --actor-id "$actor_id" \
  --job-id "$job_id" \
  --job-kind "$job_kind" \
  --run-dir "$run_dir" \
  -- node "$REPO_ROOT/scripts/write-session-report.mjs" "$run_dir/ci-ui-test-report.json"
