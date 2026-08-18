#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/script/require_macos_build_prereqs.sh"
prefix="${HOME}/Library/Application Support/SimulatorBroker/install"
default_bin_dir="${HOME}/.local/bin"
bin_dir="$default_bin_dir"
applications_dir="${HOME}/Applications"
skip_build=0
cli_only=0
bin_dir_explicit=0
profile_path=""

homebrew_bin_dir() {
  if ! command -v brew >/dev/null 2>&1; then
    return 1
  fi
  local brew_prefix=""
  brew_prefix="$(brew --prefix 2>/dev/null || true)"
  if [[ -z "$brew_prefix" ]]; then
    return 1
  fi
  printf '%s\n' "$brew_prefix/bin"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      prefix="$2"
      shift 2
      ;;
    --bin-dir)
      bin_dir="$2"
      bin_dir_explicit=1
      shift 2
      ;;
    --applications-dir)
      applications_dir="$2"
      shift 2
      ;;
    --profile)
      profile_path="$2"
      shift 2
      ;;
    --skip-build)
      skip_build=1
      shift
      ;;
    --cli-only)
      cli_only=1
      shift
      ;;
    *)
      echo "Unknown install_local.sh argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$cli_only" -eq 1 && "$bin_dir_explicit" -eq 0 ]]; then
  if brew_bin="$(homebrew_bin_dir)" && [[ -d "$brew_bin" && -w "$brew_bin" ]]; then
    bin_dir="$brew_bin"
  fi
fi

app_source="$repo_root/DerivedData/SimulatorBrokerApp/Build/Products/Debug/SimulatorBrokerApp.app"
payload_root="$(mktemp -d "${TMPDIR:-/tmp}/simbroker-install-local.XXXXXX")"

cleanup() {
  rm -rf "$payload_root"
}
trap cleanup EXIT

if [[ "$cli_only" -ne 1 && "$skip_build" -ne 1 ]]; then
  require_macos_build_prereqs
  bash "$repo_root/scripts/generate_app_project.sh"
  xcodebuild \
    -project "$repo_root/app/SimulatorBrokerApp.xcodeproj" \
    -scheme SimulatorBrokerApp \
    -derivedDataPath "$repo_root/DerivedData/SimulatorBrokerApp" \
    -destination "platform=macOS" \
    build >/dev/null
fi

mkdir -p "$payload_root/runtime"
cp -R "$repo_root/broker-core" "$payload_root/runtime/"
cp -R "$repo_root/client" "$payload_root/runtime/"
cp "$repo_root/package.json" "$payload_root/runtime/package.json"

distribution_args=(
  --payload-root "$payload_root"
  --prefix "$prefix"
  --bin-dir "$bin_dir"
  --install-source repo-worktree
)

if [[ "$cli_only" -eq 1 ]]; then
  distribution_args+=(--cli-only)
else
  if [[ ! -d "$app_source" ]]; then
    echo "Built app bundle not found at $app_source" >&2
    exit 1
  fi
  mkdir -p "$payload_root/app"
  cp -R "$app_source" "$payload_root/app/Simulator Broker.app"
  distribution_args+=(--applications-dir "$applications_dir")
fi

if [[ -n "$profile_path" ]]; then
  distribution_args+=(--profile "$profile_path")
fi

bash "$repo_root/scripts/install_distribution.sh" "${distribution_args[@]}"
