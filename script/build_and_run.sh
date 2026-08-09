#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 [run|--debug|--logs|--telemetry|--verify] [-- <app args>]" >&2
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/script/require_macos_build_prereqs.sh"
derived_data_path="${DERIVED_DATA_PATH:-$repo_root/DerivedData/SimulatorBrokerApp}"
app_bundle="$derived_data_path/Build/Products/Debug/SimulatorBrokerApp.app"
app_binary="$app_bundle/Contents/MacOS/SimulatorBrokerApp"
app_name="SimulatorBrokerApp"
app_pid_file="$derived_data_path/$app_name.pid"
app_args=()

build_app() {
  require_macos_build_prereqs
  bash "$repo_root/scripts/generate_app_project.sh"
  xcodebuild \
    -project "$repo_root/app/SimulatorBrokerApp.xcodeproj" \
    -scheme SimulatorBrokerApp \
    -derivedDataPath "$derived_data_path" \
    -destination "platform=macOS" \
    build
}

open_app() {
  if [[ ${#app_args[@]} -eq 0 ]]; then
    /usr/bin/open -n "$app_bundle"
  else
    /usr/bin/open -n "$app_bundle" --args "${app_args[@]}"
  fi

  record_launched_app_pid || true
}

process_command_matches_app() {
  local pid="$1"
  local process_command

  process_command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$process_command" == *"$app_binary"* ]]
}

find_checkout_app_pid() {
  local pid

  while IFS= read -r pid; do
    if [[ -n "$pid" ]] && process_command_matches_app "$pid"; then
      printf '%s\n' "$pid"
      return 0
    fi
  done < <(pgrep -x "$app_name" 2>/dev/null || true)

  return 1
}

record_launched_app_pid() {
  local max_attempts="${BUILD_AND_RUN_LAUNCH_RECORD_ATTEMPTS:-20}"
  local delay_seconds="${BUILD_AND_RUN_LAUNCH_RECORD_DELAY_SECONDS:-0.1}"
  local attempt
  local pid

  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    pid="$(find_checkout_app_pid || true)"
    if [[ -n "$pid" ]]; then
      mkdir -p "$(dirname "$app_pid_file")"
      printf '%s\n' "$pid" >"$app_pid_file"
      return 0
    fi

    if [[ "$attempt" -lt "$max_attempts" ]]; then
      sleep "$delay_seconds"
    fi
  done

  return 1
}

terminate_tracked_app_pid() {
  local pid="$1"
  local max_attempts="${BUILD_AND_RUN_KILL_ATTEMPTS:-20}"
  local delay_seconds="${BUILD_AND_RUN_KILL_DELAY_SECONDS:-0.1}"
  local attempt

  kill "$pid" >/dev/null 2>&1 || return 0
  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    if [[ "$attempt" -lt "$max_attempts" ]]; then
      sleep "$delay_seconds"
    fi
  done

  kill -9 "$pid" >/dev/null 2>&1 || true
}

kill_running_app() {
  local pid=""

  if [[ -f "$app_pid_file" ]]; then
    read -r pid <"$app_pid_file" || pid=""
  fi
  rm -f "$app_pid_file"
  if [[ -z "$pid" ]]; then
    pid="$(find_checkout_app_pid || true)"
  fi

  if [[ "$pid" =~ ^[0-9]+$ ]] && process_command_matches_app "$pid"; then
    terminate_tracked_app_pid "$pid"
  fi
}

wait_for_app_launch() {
  local max_attempts="${BUILD_AND_RUN_VERIFY_ATTEMPTS:-10}"
  local delay_seconds="${BUILD_AND_RUN_VERIFY_DELAY_SECONDS:-1}"
  local attempt
  local pid

  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
    pid="$(find_checkout_app_pid || true)"
    if [[ -n "$pid" ]]; then
      mkdir -p "$(dirname "$app_pid_file")"
      printf '%s\n' "$pid" >"$app_pid_file"
      return 0
    fi

    if [[ "$attempt" -lt "$max_attempts" ]]; then
      sleep "$delay_seconds"
    fi
  done

  return 1
}

resolve_bundle_id() {
  local info_plist="$app_bundle/Contents/Info.plist"
  local detected_bundle_id=""

  if [[ -f "$info_plist" ]]; then
    detected_bundle_id="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$info_plist" 2>/dev/null || true)"
  fi

  if [[ -z "$detected_bundle_id" ]]; then
    detected_bundle_id="dev.codex.simulator-broker-app"
  fi

  printf '%s\n' "$detected_bundle_id"
}

main() {
  local mode="run"

  if [[ $# -gt 0 ]]; then
    case "$1" in
      run|--debug|debug|--logs|logs|--telemetry|telemetry|--verify|verify)
        mode="$1"
        shift
        ;;
      --)
        shift
        ;;
      *)
        echo "Unknown launch mode: $1" >&2
        usage
        exit 2
        ;;
    esac
  fi

  if [[ $# -gt 0 && "$1" == "--" ]]; then
    shift
  fi

  app_args=("$@")

  kill_running_app
  build_app

  if [[ ! -x "$app_binary" ]]; then
    echo "Built app binary not found at $app_binary" >&2
    exit 1
  fi

  local bundle_id
  bundle_id="$(resolve_bundle_id)"

  case "$mode" in
    run)
      open_app
      ;;
    --debug|debug)
      lldb -- "$app_binary" "${app_args[@]}"
      ;;
    --logs|logs)
      open_app
      /usr/bin/log stream --info --style compact --predicate "process == \"$app_name\""
      ;;
    --telemetry|telemetry)
      open_app
      /usr/bin/log stream --debug --info --style compact --predicate "subsystem == \"$bundle_id\""
      ;;
    --verify|verify)
      open_app
      wait_for_app_launch
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
