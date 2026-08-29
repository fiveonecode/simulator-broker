#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="$repo_root/artifacts/distribution"
default_app_path="$repo_root/artifacts/distribution/SimulatorBroker-macOS-distribution/payload/app/Simulator Broker.app"
app_path="$default_app_path"

usage() {
  cat <<'EOF'
Usage: bash scripts/package_cask_zip.sh [options]

Zip a Developer ID-signed Simulator Broker.app as the Homebrew cask
artifact Simulator-Broker-<version>.zip. This path does not build, sign,
notarize, staple, tag, or publish.

The signed app comes from npm run package:distribution:

  artifacts/distribution/SimulatorBroker-macOS-distribution/payload/app/Simulator Broker.app

Notarize and staple that app first. This script only writes the app-only
zip with ditto -c -k --keepParent. It refuses unsigned, ad-hoc, or
non-Developer ID signatures, and it refuses a zip that contains the
distribution payload instead of the app bundle.

Options:
  --app <path>         Signed Simulator Broker.app to zip. Default: the
                       package:distribution payload app.
  --output-dir <path>  Destination for the zip and checksum. Default:
                       artifacts/distribution
  -h, --help           Show this help text.
EOF
}

require_strict_child_path() {
  local parent="$1"
  local child="$2"

  case "$child" in
    "$parent"/*)
      ;;
    *)
      echo "Refusing to write outside the output directory: $child" >&2
      exit 1
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      app_path="$2"
      shift 2
      ;;
    --output-dir)
      output_dir="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown package_cask_zip.sh argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "package_cask_zip.sh requires macOS ditto." >&2
  exit 1
fi

if ! command -v ditto >/dev/null 2>&1; then
  echo "package_cask_zip.sh requires ditto." >&2
  exit 1
fi

if ! command -v codesign >/dev/null 2>&1; then
  echo "package_cask_zip.sh requires codesign." >&2
  exit 1
fi

version="$(node -e "const fs=require('node:fs'); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).version)" "$repo_root/package.json")"

if [[ -z "$version" || "$version" == "." || "$version" == ".." || "$version" == *"/"* || "$version" == *"\\"* ]]; then
  echo "Refusing to package an invalid package.json version: ${version:-<empty>}" >&2
  exit 1
fi

if [[ ! -d "$app_path" ]]; then
  echo "Signed app bundle not found: $app_path" >&2
  echo "Run npm run package:distribution with a Developer ID Application identity, notarize and staple the app, then rerun." >&2
  exit 1
fi

app_basename="$(basename "$app_path")"
if [[ "$app_basename" != "Simulator Broker.app" ]]; then
  echo "Cask zip requires the bundle to be named Simulator Broker.app, got: $app_basename" >&2
  exit 1
fi

codesign_output="$(mktemp "${TMPDIR:-/tmp}/simbroker-package-cask-zip-codesign.XXXXXX")"
cleanup() {
  rm -f "$codesign_output"
}
trap cleanup EXIT

if ! codesign -dv --verbose=4 "$app_path" >"$codesign_output" 2>&1; then
  echo "codesign could not read the app bundle. It is not a signed Simulator Broker.app." >&2
  cat "$codesign_output" >&2 || true
  exit 1
fi

if grep -Eiq '^Signature=adhoc$' "$codesign_output"; then
  echo "Refusing to zip an ad-hoc signed app. Sign with Developer ID Application first." >&2
  exit 1
fi

if grep -Eiq 'flags=.*adhoc' "$codesign_output"; then
  echo "Refusing to zip an ad-hoc signed app. Sign with Developer ID Application first." >&2
  exit 1
fi

if ! grep -F 'Authority=Developer ID Application:' "$codesign_output" >/dev/null; then
  echo "Refusing to zip an app that is not signed with Developer ID Application." >&2
  cat "$codesign_output" >&2 || true
  exit 1
fi

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
zip_name="Simulator-Broker-${version}.zip"
zip_path="$output_dir/$zip_name"
checksum_path="$output_dir/${zip_name}.sha256"

require_strict_child_path "$output_dir" "$zip_path"
require_strict_child_path "$output_dir" "$checksum_path"

rm -f "$zip_path" "$checksum_path"
ditto -c -k --keepParent "$app_path" "$zip_path"

python3 - "$zip_path" <<'PY'
import sys
import zipfile

zip_path = sys.argv[1]
prefix = "Simulator Broker.app"
with zipfile.ZipFile(zip_path) as archive:
    names = archive.namelist()

if not names:
    sys.stderr.write("Cask zip is empty.\n")
    sys.exit(1)

for name in names:
    if name in {prefix, prefix + "/"} or name.startswith(prefix + "/"):
        continue
    sys.stderr.write(f"Cask zip must contain only {prefix}, found: {name}\n")
    sys.exit(1)
PY

if command -v shasum >/dev/null 2>&1; then
  (cd "$output_dir" && shasum -a 256 "$zip_name" > "${zip_name}.sha256")
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$output_dir" && sha256sum "$zip_name" > "${zip_name}.sha256")
else
  echo "Neither shasum nor sha256sum is available; cannot write $checksum_path" >&2
  exit 1
fi

printf '%s\n' "$zip_path"
printf '%s\n' "$checksum_path"
