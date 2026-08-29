#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIMBROKER_BIN="${SIMBROKER_BIN:-simbroker}"

purpose=""
actor_type=""
actor_id=""
job_id=""
job_kind=""
session_dir="${SESSION_DIR:-}"
run_dir="${BROKER_RUN_DIR:-$REPO_ROOT/.tmp/simbroker-run}"
memory_ceiling_bytes="${BROKER_MEMORY_CEILING_BYTES:-}"
memory_ceiling_mib="${BROKER_MEMORY_CEILING_MIB:-}"
monitor_interval_ms="${BROKER_MONITOR_INTERVAL_MS:-1000}"
simulator_process_names="${BROKER_SIMULATOR_PROCESS_NAMES:-}"
lease_acquired="false"
command_pid=""
command_started="false"
wait_completed="false"
allow_cleanup_release="true"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purpose)
      purpose="$2"
      shift 2
      ;;
    --actor-type)
      actor_type="$2"
      shift 2
      ;;
    --actor-id)
      actor_id="$2"
      shift 2
      ;;
    --job-id)
      job_id="$2"
      shift 2
      ;;
    --job-kind)
      job_kind="$2"
      shift 2
      ;;
    --session-dir)
      session_dir="$2"
      shift 2
      ;;
    --run-dir)
      run_dir="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$purpose" || -z "$actor_type" || -z "$actor_id" || $# -eq 0 ]]; then
  echo "Usage: with-broker-lease.sh --purpose <purpose> --actor-type <type> --actor-id <id> [--job-id <id>] [--job-kind <kind>] [--session-dir <dir>] [--run-dir <dir>] -- <command...>" >&2
  exit 1
fi

evidence_dir="${BROKER_EVIDENCE_DIR:-$run_dir/simulator-broker-evidence}"
mkdir -p "$run_dir"
lease_file="$run_dir/simulator-lease-${BASHPID:-$$}.json"
lease_alias_file="$run_dir/simulator-lease.json"

refresh_lease_alias() {
  ln -sfn "$(basename "$lease_file")" "$lease_alias_file"
}

cleanup_lease_alias() {
  if [[ ! -L "$lease_alias_file" ]]; then
    return 0
  fi
  local alias_target=""
  alias_target="$(readlink "$lease_alias_file" 2>/dev/null || true)"
  if [[ "$alias_target" == "$(basename "$lease_file")" ]]; then
    rm -f "$lease_alias_file"
  fi
}

release_lease() {
  if [[ "$lease_acquired" != "true" ]]; then
    return 0
  fi
  if [[ ! -f "$lease_file" ]]; then
    cleanup_lease_alias
    lease_acquired="false"
    return 0
  fi
  "$SIMBROKER_BIN" lease release --lease-file "$lease_file" >/dev/null 2>&1
  cleanup_lease_alias
  lease_acquired="false"
}

contain_downstream() {
  if [[ "$lease_acquired" != "true" ]]; then
    return 0
  fi
  if [[ ! -f "$lease_file" ]]; then
    cleanup_lease_alias
    lease_acquired="false"
    return 0
  fi
  local reason="${1:-forced-abort}"
  "$SIMBROKER_BIN" lease contain --lease-file "$lease_file" --reason "$reason" >/dev/null 2>&1
}

command_has_exited() {
  if [[ -z "$command_pid" ]]; then
    return 0
  fi
  local stat_output=""
  if ! stat_output="$(ps -o stat= -p "$command_pid" 2>/dev/null | tr -d '[:space:]')" || [[ -z "$stat_output" ]]; then
    return 0
  fi
  [[ "$stat_output" == Z* ]]
}

cleanup() {
  if [[ "$lease_acquired" != "true" ]]; then
    return
  fi
  if [[ "$command_started" == "true" && "$wait_completed" != "true" ]]; then
    if contain_downstream || [[ ! -f "$lease_file" ]]; then
      if [[ "$allow_cleanup_release" == "true" ]]; then
        release_lease >/dev/null 2>&1 || true
      fi
    fi
    return
  fi
  if [[ "$allow_cleanup_release" == "true" ]]; then
    release_lease >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

"$SIMBROKER_BIN" project validate --repo-root "$REPO_ROOT" >/dev/null

acquire_args=(
  lease acquire
  --repo-root "$REPO_ROOT"
  --purpose "$purpose"
  --actor-type "$actor_type"
  --actor-id "$actor_id"
  --lease-file "$lease_file"
  --evidence-dir "$evidence_dir"
  --owner-pid "$$"
)

owner_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d '[:space:]' || true)"
if [[ -n "$owner_pgid" ]]; then
  acquire_args+=(--owner-pgid "$owner_pgid")
fi
if [[ -n "$session_dir" ]]; then
  acquire_args+=(--session-dir "$session_dir")
fi
if [[ -n "$job_id" ]]; then
  acquire_args+=(--job-id "$job_id")
fi
if [[ -n "$job_kind" ]]; then
  acquire_args+=(--job-kind "$job_kind")
fi
if [[ -n "$memory_ceiling_bytes" ]]; then
  acquire_args+=(--memory-ceiling-bytes "$memory_ceiling_bytes")
elif [[ -n "$memory_ceiling_mib" ]]; then
  acquire_args+=(--memory-ceiling-mib "$memory_ceiling_mib")
fi
if [[ -n "$monitor_interval_ms" ]]; then
  acquire_args+=(--monitor-interval-ms "$monitor_interval_ms")
fi
if [[ -n "$simulator_process_names" ]]; then
  acquire_args+=(--simulator-process-names "$simulator_process_names")
fi

"$SIMBROKER_BIN" "${acquire_args[@]}" >/dev/null
lease_acquired="true"
refresh_lease_alias

lease_field() {
  node -e 'const fs=require("fs"); const lease=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(lease[process.argv[2]] ?? "")' "$lease_file" "$1"
}

export SIMBROKER_LEASE_FILE="$lease_file"
export SIMBROKER_LEASE_ID="$(lease_field leaseId)"
export SIMBROKER_ACTOR_TYPE="$actor_type"
export SIMBROKER_PROJECT_ID="$(lease_field projectId)"
export SIMBROKER_PURPOSE_ID="$(lease_field purposeId)"
export SIMBROKER_SIMULATOR_ALIAS="$(lease_field alias)"
export SIMBROKER_SIMULATOR_ID="$(lease_field simulatorId)"
export SIMBROKER_RESET_POLICY="$(lease_field resetPolicy)"
export SIMBROKER_JOB_ID="$(lease_field jobId)"
export SIMBROKER_JOB_KIND="$(lease_field jobKind)"

command_display="$(printf '%q ' "$@")"
"$@" &
command_pid="$!"
command_started="true"
command_pgid="$(ps -o pgid= -p "$command_pid" 2>/dev/null | tr -d '[:space:]' || true)"

register_args=(
  lease register-process
  --lease-file "$lease_file"
  --pid "$command_pid"
  --command "$command_display"
  --evidence-dir "$evidence_dir"
  --owner-pid "$$"
)
if [[ -n "$owner_pgid" ]]; then
  register_args+=(--owner-pgid "$owner_pgid")
fi
if [[ -n "$command_pgid" ]]; then
  register_args+=(--pgid "$command_pgid")
fi
if [[ -n "$memory_ceiling_bytes" ]]; then
  register_args+=(--memory-ceiling-bytes "$memory_ceiling_bytes")
elif [[ -n "$memory_ceiling_mib" ]]; then
  register_args+=(--memory-ceiling-mib "$memory_ceiling_mib")
fi
if [[ -n "$monitor_interval_ms" ]]; then
  register_args+=(--monitor-interval-ms "$monitor_interval_ms")
fi
if [[ -n "$simulator_process_names" ]]; then
  register_args+=(--simulator-process-names "$simulator_process_names")
fi

set +e
"$SIMBROKER_BIN" "${register_args[@]}" >/dev/null
register_status="$?"
set -e
if [[ "$register_status" -ne 0 ]]; then
  if command_has_exited; then
    set +e
    wait "$command_pid"
    command_status="$?"
    set -e
    wait_completed="true"
  else
    exit "$register_status"
  fi
fi

containment_triggered="false"
if [[ -n "$memory_ceiling_bytes" || -n "$memory_ceiling_mib" ]]; then
  while kill -0 "$command_pid" 2>/dev/null; do
    sleep "$(node -e 'const ms=Number(process.argv[1] || 1000); process.stdout.write(String(Math.max(ms, 100) / 1000))' "$monitor_interval_ms")"
    if command_has_exited; then
      break
    fi
    set +e
    monitor_payload="$("$SIMBROKER_BIN" lease contain --lease-file "$lease_file" --reason memory-ceiling)"
    monitor_status="$?"
    set -e
    if [[ "$monitor_status" -ne 0 ]]; then
      if [[ -n "$monitor_payload" ]]; then
        printf '%s\n' "$monitor_payload" >&2
      fi
      if command_has_exited; then
        set +e
        wait "$command_pid"
        command_status="$?"
        set -e
        wait_completed="true"
        allow_cleanup_release="false"
      fi
      exit "$monitor_status"
    fi
    contained="$(node -e 'const payload=JSON.parse(process.argv[1] || "{}"); console.log(payload.contained === true ? "true" : "false")' "$monitor_payload")"
    if [[ "$contained" == "true" ]]; then
      containment_triggered="true"
      break
    fi
    if command_has_exited; then
      break
    fi
  done
fi

if [[ "$wait_completed" != "true" ]]; then
  set +e
  wait "$command_pid"
  command_status="$?"
  set -e
  wait_completed="true"
fi

if [[ "$containment_triggered" == "true" ]]; then
  command_pid=""
  cleanup_lease_alias
  lease_acquired="false"
  exit 3
fi

if [[ "$command_status" -ne 0 ]]; then
  if contain_downstream || [[ ! -f "$lease_file" ]]; then
    release_lease >/dev/null 2>&1 || true
  else
    allow_cleanup_release="false"
  fi
  exit "$command_status"
fi

command_pid=""
if [[ -f "$lease_file" ]]; then
  set +e
  final_monitor_payload="$("$SIMBROKER_BIN" lease contain --lease-file "$lease_file" --reason memory-ceiling)"
  final_monitor_status="$?"
  set -e
  if [[ "$final_monitor_status" -ne 0 ]]; then
    if [[ -n "$final_monitor_payload" ]]; then
      printf '%s\n' "$final_monitor_payload" >&2
    fi
    allow_cleanup_release="false"
    exit "$final_monitor_status"
  fi

  final_contained="$(node -e 'const payload=JSON.parse(process.argv[1] || "{}"); console.log(payload.contained === true ? "true" : "false")' "$final_monitor_payload")"
  if [[ "$final_contained" == "true" ]]; then
    cleanup_lease_alias
    lease_acquired="false"
    exit 3
  fi

  final_cleanup_needed="$(node -e 'const payload=JSON.parse(process.argv[1] || "{}"); const observation=payload.observation ?? {}; const downstreamOwnedProcessCount=Number(observation.downstreamOwnedProcessCount ?? 0); const simulatorProcessCount=Number(observation.simulatorProcessCount ?? 0); console.log((simulatorProcessCount > 0 || downstreamOwnedProcessCount > 0) ? "true" : "false")' "$final_monitor_payload")"
  if [[ "$final_cleanup_needed" == "true" ]]; then
    if contain_downstream manual-cleanup || [[ ! -f "$lease_file" ]]; then
      release_lease
      exit 0
    fi
    allow_cleanup_release="false"
    exit 1
  fi
fi
release_lease
