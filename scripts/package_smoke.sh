#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
artifact_dir=""
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/simbroker-package-smoke.XXXXXX")"

cleanup() {
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
    *)
      echo "Unknown package_smoke.sh argument: $1" >&2
      exit 1
      ;;
  esac
done

package_output_dir="$tmp_root/package-output"
package_log_path="${artifact_dir:-$tmp_root}/package-local-debug.log"
archive_path="$package_output_dir/SimulatorBroker-macOS-local-debug.zip"
bundle_root="$package_output_dir/SimulatorBroker-macOS-local-debug"
archive_check_root="$tmp_root/archive-check"

bash "$repo_root/scripts/package_local.sh" \
  --output-dir "$package_output_dir" \
  > "$package_log_path"

if ! cmp -s "$repo_root/LICENSE" "$bundle_root/LICENSE"; then
  echo "Packaged local-debug bundle is missing the repository LICENSE file." >&2
  exit 1
fi

mkdir -p "$archive_check_root"
ditto -x -k "$archive_path" "$archive_check_root"

if ! cmp -s "$repo_root/LICENSE" "$archive_check_root/SimulatorBroker-macOS-local-debug/LICENSE"; then
  echo "Packaged local-debug archive is missing the repository LICENSE file." >&2
  exit 1
fi

bash "$repo_root/scripts/install_smoke.sh" \
  --artifact-dir "${artifact_dir:-$tmp_root}" \
  --distribution-zip "$archive_path"
