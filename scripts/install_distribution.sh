#!/usr/bin/env bash
set -euo pipefail

payload_root=""
default_prefix="${HOME}/Library/Application Support/SimulatorBroker/install"
prefix="$default_prefix"
bin_dir="${HOME}/.local/bin"
applications_dir="${HOME}/Applications"
install_source="distribution"

path_contains_dir() {
  local target_dir="$1"
  local path_entry=""
  IFS=':' read -r -a path_entries <<< "${PATH:-}"

  for path_entry in "${path_entries[@]}"; do
    if [[ "$path_entry" == "$target_dir" ]]; then
      return 0
    fi
  done

  return 1
}

shell_quote() {
  printf '%q' "$1"
}

require_supported_node() {
  local node_path="$1"
  local node_version=""

  if "$node_path" -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(Number.isInteger(major) && major >= 20 ? 0 : 1);' >/dev/null 2>&1; then
    return 0
  fi

  node_version="$("$node_path" --version 2>/dev/null || printf 'unknown')"
  if [[ -z "$node_version" ]]; then
    node_version="unknown"
  fi
  echo "Simulator Broker requires Node.js 20 or newer; found $node_version at $node_path." >&2
  exit 1
}

maybe_fail_stage() {
  local stage="$1"

  if [[ "${SIMBROKER_INSTALL_TEST_FAIL_STAGE:-}" == "$stage" ]]; then
    echo "Injected install_distribution.sh failure at stage: $stage" >&2
    exit 97
  fi
}

backup_existing() {
  local target="$1"
  local backup="$2"

  if [[ -e "$target" || -L "$target" ]]; then
    mkdir -p "$(dirname "$backup")"
    mv "$target" "$backup"
  fi
}

restore_target() {
  local target="$1"
  local backup="$2"

  if [[ "${commit_started:-0}" -eq 1 ]]; then
    rm -rf "$target"
  fi
  if [[ -e "$backup" || -L "$backup" ]]; then
    mkdir -p "$(dirname "$target")"
    mv "$backup" "$target"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --payload-root)
      payload_root="$2"
      shift 2
      ;;
    --prefix)
      prefix="$2"
      shift 2
      ;;
    --bin-dir)
      bin_dir="$2"
      shift 2
      ;;
    --applications-dir)
      applications_dir="$2"
      shift 2
      ;;
    --install-source)
      install_source="$2"
      shift 2
      ;;
    *)
      echo "Unknown install_distribution.sh argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$payload_root" ]]; then
  echo "install_distribution.sh requires --payload-root" >&2
  exit 1
fi

payload_root="$(cd "$payload_root" && pwd)"
runtime_root="$payload_root/runtime"
app_source="$payload_root/app/Simulator Broker.app"

if [[ ! -d "$runtime_root/broker-core" ]]; then
  echo "Missing broker-core runtime in payload root: $runtime_root" >&2
  exit 1
fi

if [[ ! -d "$runtime_root/client" ]]; then
  echo "Missing client runtime in payload root: $runtime_root" >&2
  exit 1
fi

if [[ ! -f "$runtime_root/package.json" ]]; then
  echo "Missing package.json runtime metadata in payload root: $runtime_root" >&2
  exit 1
fi

if [[ ! -d "$app_source" ]]; then
  echo "Missing app bundle in payload root: $app_source" >&2
  exit 1
fi

lib_dir="$prefix/lib/simulator-broker-app"
env_file="$prefix/env.sh"
metadata_path="$prefix/install.json"
default_metadata_path="$default_prefix/install.json"
app_destination="$applications_dir/Simulator Broker.app"
cli_wrapper="$bin_dir/simbroker"
node_bin="$(command -v node || true)"
service_was_running=0
service_stopped=0
install_complete=0
backup_started=0
commit_started=0
install_tmp_root=""
backup_root=""
metadata_targets=("$metadata_path")
metadata_backup_paths=()

if [[ -z "$node_bin" ]]; then
  echo "Node.js was not found in PATH. Install Node.js before installing Simulator Broker." >&2
  exit 1
fi
require_supported_node "$node_bin"

if [[ "$default_metadata_path" != "$metadata_path" ]]; then
  metadata_targets+=("$default_metadata_path")
fi

mkdir -p "$prefix" "$bin_dir" "$applications_dir"
install_tmp_root="$(mktemp -d "$prefix/.install.XXXXXX")"
backup_root="$install_tmp_root/backup"
staging_lib_dir="$install_tmp_root/staging/lib/simulator-broker-app"
staging_app_destination="$install_tmp_root/staging/app/Simulator Broker.app"
staging_cli_wrapper="$install_tmp_root/staging/simbroker"
staging_env_file="$install_tmp_root/staging/env.sh"
staging_metadata_path="$install_tmp_root/staging/install.json"
backup_lib_dir="$backup_root/lib/simulator-broker-app"
backup_app_destination="$backup_root/app/Simulator Broker.app"
backup_cli_wrapper="$backup_root/simbroker"
backup_env_file="$backup_root/env.sh"

rollback_install() {
  set +e
  set +u
  if [[ "$backup_started" -eq 1 || "$commit_started" -eq 1 ]]; then
    restore_target "$lib_dir" "$backup_lib_dir"
    restore_target "$app_destination" "$backup_app_destination"
    restore_target "$cli_wrapper" "$backup_cli_wrapper"
    restore_target "$env_file" "$backup_env_file"

    local index=0
    while [[ "$index" -lt "${#metadata_targets[@]}" ]]; do
      restore_target "${metadata_targets[$index]}" "${metadata_backup_paths[$index]:-}"
      index=$((index + 1))
    done
  fi

  if [[ "$service_stopped" -eq 1 && -x "$cli_wrapper" ]]; then
    "$cli_wrapper" service start >/dev/null 2>&1 || true
  fi
}

finish_install() {
  local status=$?
  if [[ "$install_complete" -ne 1 ]]; then
    rollback_install
  fi
  if [[ -n "$install_tmp_root" ]]; then
    rm -rf "$install_tmp_root"
  fi
  exit "$status"
}
trap finish_install EXIT

mkdir -p "$staging_lib_dir" "$(dirname "$staging_app_destination")" "$(dirname "$staging_cli_wrapper")"
cp -R "$runtime_root/broker-core" "$staging_lib_dir/"
cp -R "$runtime_root/client" "$staging_lib_dir/"
cp "$runtime_root/package.json" "$staging_lib_dir/package.json"
cp -R "$app_source" "$staging_app_destination"

{
  printf '%s\n' '#!/usr/bin/env bash'
  printf '%s\n' 'set -euo pipefail'
  printf 'exec %s %s "$@"\n' "$(shell_quote "$node_bin")" "$(shell_quote "$lib_dir/client/bin/simbroker.mjs")"
} > "$staging_cli_wrapper"
chmod +x "$staging_cli_wrapper"

{
  printf 'export PATH=%s:"$PATH"\n' "$(shell_quote "$bin_dir")"
  printf 'export SIMBROKER_APP=%s\n' "$(shell_quote "$app_destination")"
  printf 'export SIMBROKER_INSTALL_ROOT=%s\n' "$(shell_quote "$prefix")"
} > "$staging_env_file"

installed_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
SIMBROKER_INSTALL_APP_PATH="$app_destination" \
SIMBROKER_INSTALL_BIN_DIR="$bin_dir" \
SIMBROKER_INSTALL_CLI_PATH="$cli_wrapper" \
SIMBROKER_INSTALL_LIB_DIR="$lib_dir" \
SIMBROKER_INSTALL_METADATA_PATH="$staging_metadata_path" \
SIMBROKER_INSTALL_NODE_PATH="$node_bin" \
SIMBROKER_INSTALL_PAYLOAD_ROOT="$payload_root" \
SIMBROKER_INSTALL_PREFIX="$prefix" \
SIMBROKER_INSTALL_SOURCE="$install_source" \
SIMBROKER_INSTALLED_AT="$installed_at" \
"$node_bin" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const metadataPath = process.env.SIMBROKER_INSTALL_METADATA_PATH;
const metadata = {
  appPath: process.env.SIMBROKER_INSTALL_APP_PATH,
  binDir: process.env.SIMBROKER_INSTALL_BIN_DIR,
  cliPath: process.env.SIMBROKER_INSTALL_CLI_PATH,
  installSource: process.env.SIMBROKER_INSTALL_SOURCE,
  installedAt: process.env.SIMBROKER_INSTALLED_AT,
  libDir: process.env.SIMBROKER_INSTALL_LIB_DIR,
  nodePath: process.env.SIMBROKER_INSTALL_NODE_PATH,
  payloadRoot: process.env.SIMBROKER_INSTALL_PAYLOAD_ROOT,
  prefix: process.env.SIMBROKER_INSTALL_PREFIX,
};

fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
NODE
maybe_fail_stage "after-staging"

if [[ -x "$cli_wrapper" ]]; then
  service_status_stderr="$install_tmp_root/service-status.stderr"
  set +e
  existing_service_status="$("$cli_wrapper" service status --json 2>"$service_status_stderr")"
  service_status_code=$?
  set -e
  if [[ "$service_status_code" -ne 0 ]]; then
    echo "Cannot verify existing Simulator Broker service status; aborting installation before replacing runtime." >&2
    if [[ -s "$service_status_stderr" ]]; then
      cat "$service_status_stderr" >&2
    fi
    exit 1
  fi

  service_status_running=0
  if SIMBROKER_EXISTING_SERVICE_STATUS="$existing_service_status" "$node_bin" <<'NODE'
const status = process.env.SIMBROKER_EXISTING_SERVICE_STATUS ?? "";
try {
  const payload = JSON.parse(status);
  if (payload.running === true) {
    process.exit(0);
  }
  if (payload.running === false) {
    process.exit(1);
  }
  process.exit(2);
} catch {
  process.exit(2);
}
NODE
  then
    service_status_running=1
  else
    service_status_parse_code=$?
    if [[ "$service_status_parse_code" -ne 1 ]]; then
      echo "Cannot parse existing Simulator Broker service status; aborting installation before replacing runtime." >&2
      exit 1
    fi
  fi

  if [[ "$service_status_running" -eq 1 ]]; then
    service_was_running=1
    "$cli_wrapper" service stop >/dev/null
    service_stopped=1
  fi
fi

backup_started=1
backup_existing "$lib_dir" "$backup_lib_dir"
backup_existing "$app_destination" "$backup_app_destination"
backup_existing "$cli_wrapper" "$backup_cli_wrapper"
backup_existing "$env_file" "$backup_env_file"

index=0
while [[ "$index" -lt "${#metadata_targets[@]}" ]]; do
  backup_path="$backup_root/metadata-$index.json"
  metadata_backup_paths+=("$backup_path")
  backup_existing "${metadata_targets[$index]}" "$backup_path"
  index=$((index + 1))
done

mkdir -p "$(dirname "$lib_dir")" "$(dirname "$app_destination")" "$(dirname "$cli_wrapper")" "$(dirname "$env_file")"
commit_started=1
mv "$staging_lib_dir" "$lib_dir"
maybe_fail_stage "after-runtime-swap"
mv "$staging_app_destination" "$app_destination"
maybe_fail_stage "after-app-swap"
mv "$staging_cli_wrapper" "$cli_wrapper"
mv "$staging_env_file" "$env_file"
maybe_fail_stage "after-wrapper-swap"

for target_path in "${metadata_targets[@]}"; do
  mkdir -p "$(dirname "$target_path")"
  cp "$staging_metadata_path" "$target_path"
done
maybe_fail_stage "after-metadata-write"

if [[ "$service_was_running" -eq 1 ]]; then
  "$cli_wrapper" service start >/dev/null
fi
install_complete=1

printf '%s\n' \
  "Installed Simulator Broker." \
  "Install source: $install_source" \
  "CLI: $cli_wrapper" \
  "App: $app_destination" \
  "Env helper: $env_file"

if ! path_contains_dir "$bin_dir"; then
  printf '%s\n' "Warning: $bin_dir is not currently on PATH in this shell."
fi

printf '%s\n' "Next command: source \"$env_file\""
