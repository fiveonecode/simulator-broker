#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/script/require_macos_build_prereqs.sh"
prefix="${HOME}/Library/Application Support/SimulatorBroker/install"
bin_dir="${HOME}/.local/bin"
applications_dir="${HOME}/Applications"
skip_build=0

while [[ $# -gt 0 ]]; do
  case "$1" in
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
    --skip-build)
      skip_build=1
      shift
      ;;
    *)
      echo "Unknown install_local.sh argument: $1" >&2
      exit 1
      ;;
  esac
done

app_source="$repo_root/DerivedData/SimulatorBrokerApp/Build/Products/Debug/SimulatorBrokerApp.app"
payload_root="$(mktemp -d "${TMPDIR:-/tmp}/simbroker-install-local.XXXXXX")"

cleanup() {
  rm -rf "$payload_root"
}
trap cleanup EXIT

if [[ "$skip_build" -ne 1 ]]; then
  require_macos_build_prereqs
  bash "$repo_root/scripts/generate_app_project.sh"
  xcodebuild \
    -project "$repo_root/app/SimulatorBrokerApp.xcodeproj" \
    -scheme SimulatorBrokerApp \
    -derivedDataPath "$repo_root/DerivedData/SimulatorBrokerApp" \
    -destination "platform=macOS" \
    build >/dev/null
fi

if [[ ! -d "$app_source" ]]; then
  echo "Built app bundle not found at $app_source" >&2
  exit 1
fi

mkdir -p "$payload_root/app" "$payload_root/runtime"
cp -R "$repo_root/broker-core" "$payload_root/runtime/"
cp -R "$repo_root/client" "$payload_root/runtime/"
cp "$repo_root/package.json" "$payload_root/runtime/package.json"
cp -R "$app_source" "$payload_root/app/Simulator Broker.app"

bash "$repo_root/scripts/install_distribution.sh" \
  --payload-root "$payload_root" \
  --prefix "$prefix" \
  --bin-dir "$bin_dir" \
  --applications-dir "$applications_dir" \
  --install-source repo-worktree
