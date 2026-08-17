#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/script/require_macos_build_prereqs.sh"
derived_data_path="${DERIVED_DATA_PATH:-$repo_root/DerivedData/SimulatorBrokerApp}"
result_bundle_path=""
build_only=false
declare -a only_testing_filters=()
test_runtime_root="$(mktemp -d "${TMPDIR:-/tmp}/simbroker-app-tests.XXXXXX")"

cleanup() {
  rm -rf "$test_runtime_root"
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: bash scripts/test_app.sh [options]

Options:
  --build-only                    Run xcodebuild build-for-testing instead of test
  --only-testing <target/test>    Limit the run to one XCTest target, case, or method
  --result-bundle-path <path>     Write the xcresult bundle to the given path
  --derived-data-path <path>      Override the derived data path for this run
  -h, --help                      Show this help text

Environment:
  DERIVED_DATA_PATH               Default derived data path when the CLI flag is omitted

Examples:
  bash scripts/test_app.sh
  bash scripts/test_app.sh --build-only
  bash scripts/test_app.sh --only-testing SimulatorBrokerAppTests/BrokerDashboardStoreTests
  bash scripts/test_app.sh --only-testing SimulatorBrokerAppTests/BrokerSnapshotLoaderTests --result-bundle-path "$PWD/artifacts/app-test.xcresult"
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

slugify() {
  printf '%s' "$1" | tr '/[:space:]' '--' | tr -cd '[:alnum:]-'
}

default_result_bundle_path() {
  local scope_name="full-suite"

  if $build_only; then
    scope_name="build-only"
  fi

  if ((${#only_testing_filters[@]} == 1)); then
    scope_name="focused-$(slugify "${only_testing_filters[0]}")"
  elif ((${#only_testing_filters[@]} > 1)); then
    scope_name="focused-selection"
  fi

  printf '%s/artifacts/app-tests/%s.xcresult' "$repo_root" "$scope_name"
}

absolute_path() {
  case "$1" in
    /*)
      printf '%s\n' "$1"
      ;;
    *)
      printf '%s/%s\n' "$PWD" "$1"
      ;;
  esac
}

validate_result_bundle_path() {
  local requested_path="$1"
  local absolute_result_path
  local result_name
  local parent_path

  absolute_result_path="$(absolute_path "$requested_path")"
  result_name="$(basename "$absolute_result_path")"
  parent_path="$(dirname "$absolute_result_path")"

  [[ "$result_name" == *.xcresult ]] || die "--result-bundle-path must name a .xcresult bundle"
  [[ "$result_name" != "." && "$result_name" != ".." ]] || die "--result-bundle-path must name a .xcresult bundle"
  [[ "$absolute_result_path" != "/" ]] || die "--result-bundle-path must not be the filesystem root"
  [[ "$absolute_result_path" != "$HOME" ]] || die "--result-bundle-path must not be the home directory"
  [[ "$absolute_result_path" != "$repo_root" ]] || die "--result-bundle-path must not be the repository root"
  [[ "$parent_path" != "/" ]] || die "--result-bundle-path must be inside a non-root directory"

  printf '%s\n' "$absolute_result_path"
}

while (($# > 0)); do
  case "$1" in
    --build-only)
      build_only=true
      shift
      ;;
    --only-testing)
      (($# >= 2)) || die "--only-testing requires a value"
      only_testing_filters+=("$2")
      shift 2
      ;;
    --result-bundle-path)
      (($# >= 2)) || die "--result-bundle-path requires a value"
      result_bundle_path="$2"
      shift 2
      ;;
    --derived-data-path)
      (($# >= 2)) || die "--derived-data-path requires a value"
      derived_data_path="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
done

result_bundle_path="${result_bundle_path:-$(default_result_bundle_path)}"
result_bundle_path="$(validate_result_bundle_path "$result_bundle_path")"

require_macos_build_prereqs
bash "$repo_root/scripts/generate_app_project.sh"
mkdir -p "$(dirname "$result_bundle_path")"
rm -rf "$result_bundle_path"

declare -a xcodebuild_command=(
  xcodebuild
  -project "$repo_root/app/SimulatorBrokerApp.xcodeproj"
  -scheme SimulatorBrokerApp
  -derivedDataPath "$derived_data_path"
  -destination "platform=macOS"
  -resultBundlePath "$result_bundle_path"
  "SIMBROKER_TEST_HOST_CONFIG=$test_runtime_root/host-config.json"
  "SIMBROKER_TEST_STATE_ROOT=$test_runtime_root/state"
)

if ((${#only_testing_filters[@]} > 0)); then
  for only_testing_filter in "${only_testing_filters[@]}"; do
    xcodebuild_command+=("-only-testing:${only_testing_filter}")
  done
fi

if $build_only; then
  xcodebuild_command+=(build-for-testing)
else
  xcodebuild_command+=(test)
fi

echo "Result bundle: $result_bundle_path"
echo "Running xcodebuild command:"
printf '  '
printf '%q ' "${xcodebuild_command[@]}"
printf '\n'

if "${xcodebuild_command[@]}"; then
  echo "xcodebuild completed successfully"
  echo "Result bundle: $result_bundle_path"
else
  status=$?
  echo "xcodebuild failed with status $status"
  echo "Result bundle: $result_bundle_path"
  exit "$status"
fi
