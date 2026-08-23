#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
artifact_dir=""
distribution_zip=""
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/simbroker-install-smoke.XXXXXX")"
bin_dir=""
app_path=""
state_root=""
lease_file=""
host_config_path=""
app_process_name="SimulatorBrokerApp"
launched_app_pids_path="$tmp_root/launched-app-pids.txt"
lease_acquired=0
lease_released=0
service_stopped=0
preexisting_simulators_path="$tmp_root/preexisting-simulators.txt"
default_install_metadata_path="${HOME}/Library/Application Support/SimulatorBroker/install/install.json"
default_install_metadata_backup="$tmp_root/default-install-metadata.json"
default_install_metadata_symlink_target_path="$tmp_root/default-install-metadata.symlink-target"
default_install_metadata_existed=0
default_install_metadata_was_symlink=0

artifact_path() {
  printf '%s/%s\n' "${artifact_dir:-$tmp_root}" "$1"
}

find_installable_distribution_bundle_root() {
  local distribution_root="$1"
  local preferred_root="$distribution_root/SimulatorBroker-macOS"

  if [[ -x "$preferred_root/install.sh" ]]; then
    printf '%s\n' "$preferred_root"
    return 0
  fi

  find "$distribution_root" -mindepth 1 -maxdepth 1 -type d -exec test -x '{}/install.sh' \; -print | head -n 1
}

stop_launched_app() {
  [[ -f "$launched_app_pids_path" ]] || return 0

  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done < "$launched_app_pids_path"

  local deadline=$((SECONDS + 10))
  while [[ "$SECONDS" -lt "$deadline" ]]; do
    local remaining=0
    while IFS= read -r pid; do
      [[ -z "$pid" ]] && continue
      if kill -0 "$pid" >/dev/null 2>&1; then
        remaining=1
        break
      fi
    done < "$launched_app_pids_path"

    if [[ "$remaining" -eq 0 ]]; then
      break
    fi

    sleep 0.2
  done

  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
  done < "$launched_app_pids_path"
}

collect_app_pids() {
  pgrep -x "$app_process_name" || true
}

capture_app_failure_logs() {
  local process_snapshot_path
  local failure_log_path
  process_snapshot_path="$(artifact_path installed-app-processes.log)"
  failure_log_path="$(artifact_path installed-app-launch.log)"

  ps -axo pid,etime,command | grep "[S]imulatorBrokerApp" > "$process_snapshot_path" 2>/dev/null || true

  if [[ -x /usr/bin/log ]]; then
    /usr/bin/log show \
      --last 2m \
      --style compact \
      --predicate "process == \"$app_process_name\"" \
      > "$failure_log_path" 2>/dev/null || true
  fi
}

record_simulator_inventory() {
  local output_path="$1"
  xcrun simctl list devices --json | node -e '
    const fs = require("node:fs");
    const payload = JSON.parse(fs.readFileSync(0, "utf8"));
    const ids = [];
    for (const devices of Object.values(payload.devices ?? {})) {
      for (const device of devices ?? []) {
        if (typeof device.udid === "string" && device.udid.length > 0) {
          ids.push(device.udid);
        }
      }
    }
    process.stdout.write(`${[...new Set(ids)].sort().join("\n")}\n`);
  ' > "$output_path"
}

snapshot_default_install_metadata() {
  if [[ -e "$default_install_metadata_path" || -L "$default_install_metadata_path" ]]; then
    mkdir -p "$(dirname "$default_install_metadata_backup")"
    if [[ -L "$default_install_metadata_path" ]]; then
      readlink "$default_install_metadata_path" > "$default_install_metadata_symlink_target_path"
      if [[ -e "$default_install_metadata_path" ]]; then
        cp -pL "$default_install_metadata_path" "$default_install_metadata_backup"
      fi
      default_install_metadata_was_symlink=1
    else
      cp -Pp "$default_install_metadata_path" "$default_install_metadata_backup"
    fi
    default_install_metadata_existed=1
  fi
}

resolve_default_metadata_symlink_target() {
  local link_target="$1"
  if [[ "$link_target" = /* ]]; then
    printf '%s\n' "$link_target"
  else
    printf '%s/%s\n' "$(dirname "$default_install_metadata_path")" "$link_target"
  fi
}

restore_default_install_metadata() {
  if [[ "$default_install_metadata_existed" -eq 1 ]]; then
    mkdir -p "$(dirname "$default_install_metadata_path")"
    if [[ "$default_install_metadata_was_symlink" -eq 1 && -f "$default_install_metadata_symlink_target_path" ]]; then
      local link_target
      local resolved_target
      link_target="$(cat "$default_install_metadata_symlink_target_path")"
      resolved_target="$(resolve_default_metadata_symlink_target "$link_target")"
      mkdir -p "$(dirname "$resolved_target")"
      if [[ -e "$default_install_metadata_backup" ]]; then
        cp -p "$default_install_metadata_backup" "$resolved_target"
      else
        rm -f "$resolved_target"
      fi
      rm -f "$default_install_metadata_path"
      ln -s "$link_target" "$default_install_metadata_path"
      return
    fi
    if [[ -e "$default_install_metadata_backup" ]]; then
      cp -Pp "$default_install_metadata_backup" "$default_install_metadata_path"
    fi
    return
  fi

  rm -f "$default_install_metadata_path"
}

cleanup_broker_resources() {
  local cli_path=""

  if [[ -n "$bin_dir" ]]; then
    cli_path="$bin_dir/simbroker"
  fi

  if [[ "$lease_acquired" -eq 1 && "$lease_released" -eq 0 && -x "$cli_path" && -f "$lease_file" ]]; then
    "$cli_path" \
      --host-config "$host_config_path" \
      --state-root "$state_root" \
      lease release \
      --lease-file "$lease_file" \
      > "$(artifact_path lease-release-cleanup.json)" 2>&1 || true
  fi

  if [[ "$service_stopped" -eq 0 && -x "$cli_path" ]]; then
    "$cli_path" \
      --host-config "$host_config_path" \
      --state-root "$state_root" \
      service stop \
      > "$(artifact_path service-stop-cleanup.json)" 2>&1 || true
  fi
}

launch_installed_app_smoke() {
  local app_path="$1"
  local launch_start_file="$tmp_root/app-pids-before.txt"
  local launch_current_file="$tmp_root/app-pids-after.txt"
  local launch_deadline=$((SECONDS + 15))
  local open_log_path
  open_log_path="$(artifact_path installed-app-open.log)"

  : > "$launch_start_file"
  : > "$launch_current_file"
  : > "$launched_app_pids_path"

  collect_app_pids > "$launch_start_file"

  if ! open -na "$app_path" --args --state-root "$state_root" --host-config "$host_config_path" > "$open_log_path" 2>&1; then
    capture_app_failure_logs
    echo "Failed to open installed app bundle: $app_path" >&2
    return 1
  fi

  while [[ "$SECONDS" -lt "$launch_deadline" ]]; do
    collect_app_pids > "$launch_current_file"
    grep -Fxv -f "$launch_start_file" "$launch_current_file" > "$launched_app_pids_path" || true

    if [[ -s "$launched_app_pids_path" ]]; then
      break
    fi

    sleep 0.5
  done

  if [[ ! -s "$launched_app_pids_path" ]]; then
    capture_app_failure_logs
    echo "Installed app launch smoke did not create a new $app_process_name process." >&2
    return 1
  fi

  sleep 2

  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      capture_app_failure_logs
      echo "Installed app process exited before smoke verification completed: $pid" >&2
      return 1
    fi
  done < "$launched_app_pids_path"
}

cleanup() {
  stop_launched_app
  cleanup_broker_resources

  if [[ -n "$host_config_path" && -f "$host_config_path" && -f "$preexisting_simulators_path" ]]; then
    while IFS= read -r simulator_id; do
      [[ -z "$simulator_id" ]] && continue
      xcrun simctl delete "$simulator_id" >/dev/null 2>&1 || true
    done < <(node -e '
      const fs = require("node:fs");
      const hostConfigPath = process.argv[1];
      const preexistingPath = process.argv[2];
      const payload = JSON.parse(fs.readFileSync(hostConfigPath, "utf8"));
      const preexisting = new Set(fs.readFileSync(preexistingPath, "utf8").split(/\n+/).filter(Boolean));
      for (const alias of payload.aliases ?? []) {
        if (typeof alias.simulatorId === "string" && alias.simulatorId.length > 0 && !preexisting.has(alias.simulatorId)) {
          console.log(alias.simulatorId);
        }
      }
    ' "$host_config_path" "$preexisting_simulators_path")
  fi

  restore_default_install_metadata
  rm -rf "$tmp_root"
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifact-dir)
      artifact_dir="$2"
      mkdir -p "$artifact_dir"
      shift 2
      ;;
    --distribution-zip)
      distribution_zip="$2"
      shift 2
      ;;
    *)
      echo "Unknown install_smoke.sh argument: $1" >&2
      exit 1
      ;;
  esac
done

prefix="$tmp_root/prefix"
bin_dir="$tmp_root/bin"
applications_dir="$tmp_root/Applications"
app_path="$applications_dir/Simulator Broker.app"
host_config_path="$tmp_root/host-config.json"
state_root="$tmp_root/state"
repo_path="$tmp_root/repo"
lease_file="$tmp_root/lease.json"
summary_path="${artifact_dir:-$tmp_root}/install-smoke-summary.json"

log_command() {
  local name="$1"
  shift
  "$@" > "${artifact_dir:-$tmp_root}/${name}.json"
}

install_mode="repo-worktree"
distribution_archive_json="null"
snapshot_default_install_metadata

if [[ -n "$distribution_zip" ]]; then
  install_mode="portable-bundle"
  distribution_archive_json="\"$distribution_zip\""
  distribution_root="$tmp_root/distribution"
  ditto -x -k "$distribution_zip" "$distribution_root"
  distribution_bundle_root="$(find_installable_distribution_bundle_root "$distribution_root")"

  if [[ -z "$distribution_bundle_root" || ! -x "$distribution_bundle_root/install.sh" ]]; then
    echo "Failed to find an installable distribution bundle in $distribution_zip" >&2
    exit 1
  fi

  bash "$distribution_bundle_root/install.sh" \
    --prefix "$prefix" \
    --bin-dir "$bin_dir" \
    --applications-dir "$applications_dir" \
    > "${artifact_dir:-$tmp_root}/install-distribution.log"
else
  bash "$repo_root/scripts/install_local.sh" \
    --prefix "$prefix" \
    --bin-dir "$bin_dir" \
    --applications-dir "$applications_dir" \
    > "${artifact_dir:-$tmp_root}/install-local.log"
fi

export SIMBROKER_HOST_CONFIG="$host_config_path"
export SIMBROKER_STATE_ROOT="$state_root"
export PATH="$bin_dir:$PATH"

record_simulator_inventory "$preexisting_simulators_path"
log_command setup-preview simbroker setup --json --host-id install-smoke-host
setup_plan_id="$(node -e '
  const fs = require("node:fs");
  const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (payload.mode !== "preview" || payload.status !== "changes_required" || payload.devices?.length !== 6) {
    throw new Error("Setup preview did not describe the six-device starter plan.");
  }
  process.stdout.write(payload.planId);
' "$(artifact_path setup-preview.json)")"
log_command setup-apply simbroker setup --apply --confirm "$setup_plan_id" --host-id install-smoke-host --json
node -e '
  const fs = require("node:fs");
  const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (payload.status !== "ready" || payload.devices?.total !== 6 || payload.service?.running !== true || payload.snapshot?.ready !== true || payload.health?.ok !== true) {
    throw new Error("Confirmed setup did not finish with six healthy aliases and a running service.");
  }
' "$(artifact_path setup-apply.json)"
log_command project-init simbroker project init --repo-root "$repo_path" --project-id install-smoke --project-name "Install Smoke"
node -e '
  const fs = require("node:fs");
  const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const uiPurposes = payload.projectConfig?.purposes?.filter((purpose) => purpose.requires?.deviceFamily === "iPhone") ?? [];
  if (uiPurposes.length === 0 || uiPurposes.some((purpose) => Object.hasOwn(purpose.requires, "iosVersion"))) {
    throw new Error("Default project scaffold must be version-agnostic.");
  }
' "$(artifact_path project-init.json)"
log_command project-validate simbroker project validate --repo-root "$repo_path"
log_command service-status simbroker service status
log_command lease-acquire simbroker lease acquire \
  --repo-root "$repo_path" \
  --purpose agent-ui-session \
  --actor-type agent \
  --actor-id install-smoke-agent \
  --owner-pid "$$" \
  --lease-file "$lease_file"
lease_acquired=1
log_command app-snapshot simbroker app snapshot

test -x "$bin_dir/simbroker"
test -d "$app_path"
test -f "$repo_path/.simulator-broker/project.json"
test -f "$state_root/app-snapshot.json"

launch_installed_app_smoke "$app_path"
log_command lease-release simbroker lease release --lease-file "$lease_file"
lease_released=1
log_command setup-rerun-preview simbroker setup --json
setup_rerun_plan_id="$(node -e '
  const fs = require("node:fs");
  const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(payload.planId);
' "$(artifact_path setup-rerun-preview.json)")"
log_command setup-rerun-apply simbroker setup --apply --confirm "$setup_rerun_plan_id" --json
node -e '
  const fs = require("node:fs");
  const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (payload.devices?.created !== 0 || payload.status !== "ready") {
    throw new Error("Idempotent setup rerun created new Simulator devices.");
  }
' "$(artifact_path setup-rerun-apply.json)"
log_command service-stop simbroker service stop
service_stopped=1

launch_pids_json="$(node -e '
  const fs = require("node:fs");
  const pids = fs.readFileSync(process.argv[1], "utf8")
    .split(/\n+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value));
  process.stdout.write(JSON.stringify(pids));
' "$launched_app_pids_path")"

cat > "$summary_path" <<EOF
{
  "appPath": "$app_path",
  "binPath": "$bin_dir/simbroker",
  "hostConfigPath": "$host_config_path",
  "installMode": "$install_mode",
  "leaseFile": "$lease_file",
  "launchPids": $launch_pids_json,
  "launchVerified": true,
  "projectFilePath": "$repo_path/.simulator-broker/project.json",
  "repoPath": "$repo_path",
  "stateRoot": "$state_root",
  "distributionArchive": $distribution_archive_json,
  "tmpRoot": "$tmp_root"
}
EOF

cat "$summary_path"
