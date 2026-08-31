#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="$repo_root/artifacts/distribution"
default_app_path="$repo_root/artifacts/distribution/SimulatorBroker-macOS-distribution/payload/app/Simulator Broker.app"
app_path="$default_app_path"

usage() {
  cat <<'EOF'
Usage: bash scripts/package_cask_zip.sh [options]

Zip a Developer ID-signed, stapled Simulator Broker.app as the Homebrew
cask artifact Simulator-Broker-<version>.zip. This path does not build,
sign, notarize, staple, tag, or publish.

The signed app comes from npm run package:distribution:

  artifacts/distribution/SimulatorBroker-macOS-distribution/payload/app/Simulator Broker.app

Notarize and staple that app first. This script only writes the app-only
zip with explicit ditto metadata suppression. It refuses unsigned, ad-hoc, or
non-Developer ID signatures, a signature that codesign --verify --deep
--strict rejects, an app whose CFBundleIdentifier is not
dev.codex.simulator-broker-app, an app that xcrun stapler validate
rejects, and a zip that contains the distribution payload instead of
the app bundle.

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

version="$(node -e "const fs=require('node:fs'); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).version)" "$repo_root/package.json")"

if [[ -z "$version" || "$version" == "." || "$version" == ".." || "$version" == *"/"* || "$version" == *"\\"* ]]; then
  echo "Refusing to package an invalid package.json version: ${version:-<empty>}" >&2
  exit 1
fi

app_basename="$(basename "$app_path")"
resolved_app_path=""
if [[ -d "$app_path" ]]; then
  if ! resolved_app_path="$(cd "$app_path" 2>/dev/null && pwd -P)"; then
    echo "Cask zip could not resolve the signed app bundle." >&2
    exit 1
  fi
fi

if ! mkdir -p "$output_dir" 2>/dev/null; then
  echo "Unable to prepare the cask ZIP output directory." >&2
  exit 1
fi
if ! output_dir="$(cd "$output_dir" 2>/dev/null && pwd -P)"; then
  echo "Unable to resolve the cask ZIP output directory." >&2
  exit 1
fi
if [[ -n "$resolved_app_path" ]]; then
  case "$output_dir/" in
    "$resolved_app_path/"*)
      echo "Refusing to write cask ZIP outputs inside the signed app bundle." >&2
      exit 1
      ;;
  esac
fi

zip_name="Simulator-Broker-${version}.zip"
zip_path="$output_dir/$zip_name"
checksum_path="$output_dir/${zip_name}.sha256"

require_strict_child_path "$output_dir" "$zip_path"
require_strict_child_path "$output_dir" "$checksum_path"

codesign_verify_output=""
codesign_output=""
stapler_output=""
candidate_zip=""
candidate_checksum=""
published=false
cleanup() {
  for temporary_path in \
    "$codesign_verify_output" \
    "$codesign_output" \
    "$stapler_output" \
    "$candidate_zip" \
    "$candidate_checksum"; do
    if [[ -n "$temporary_path" ]]; then
      rm -f "$temporary_path" 2>/dev/null || true
    fi
  done
  if [[ "$published" != true ]]; then
    rm -f "$zip_path" "$checksum_path" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# A failed rebuild must not leave older final bytes looking current.
if ! rm -f "$zip_path" "$checksum_path" 2>/dev/null; then
  echo "Unable to clear older cask ZIP outputs." >&2
  exit 1
fi

if [[ ! -d "$app_path" ]]; then
  echo "Signed app bundle not found: $app_path" >&2
  echo "Run npm run package:distribution with a Developer ID Application identity, notarize and staple the app, then rerun." >&2
  exit 1
fi
app_path="$resolved_app_path"

if [[ "$app_basename" != "Simulator Broker.app" ]]; then
  echo "Cask zip requires the bundle to be named Simulator Broker.app, got: $app_basename" >&2
  exit 1
fi

expected_bundle_id="dev.codex.simulator-broker-app"
if ! command -v python3 >/dev/null 2>&1; then
  echo "package_cask_zip.sh requires python3 to read CFBundleIdentifier." >&2
  exit 1
fi

info_plist="$app_path/Contents/Info.plist"
if [[ ! -f "$info_plist" ]]; then
  echo "Cask zip requires Contents/Info.plist in $app_basename" >&2
  exit 1
fi

if ! bundle_id="$(python3 - "$info_plist" <<'PY'
import plistlib
import sys

try:
    with open(sys.argv[1], "rb") as handle:
        plist = plistlib.load(handle)
except Exception:
    sys.exit(1)

identifier = plist.get("CFBundleIdentifier")
if not isinstance(identifier, str) or not identifier.strip():
    sys.exit(1)
sys.stdout.write(identifier.strip())
PY
)"; then
  echo "Cask zip could not read CFBundleIdentifier from $info_plist" >&2
  exit 1
fi

if [[ "$bundle_id" != "$expected_bundle_id" ]]; then
  echo "Cask zip requires CFBundleIdentifier ${expected_bundle_id}, got: ${bundle_id}" >&2
  exit 1
fi

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

if ! command -v xcrun >/dev/null 2>&1; then
  echo "package_cask_zip.sh requires xcrun stapler." >&2
  exit 1
fi

codesign_verify_output="$(mktemp "${TMPDIR:-/tmp}/simbroker-package-cask-zip-codesign-verify.XXXXXX")"
codesign_output="$(mktemp "${TMPDIR:-/tmp}/simbroker-package-cask-zip-codesign.XXXXXX")"
stapler_output="$(mktemp "${TMPDIR:-/tmp}/simbroker-package-cask-zip-stapler.XXXXXX")"

if ! codesign --verify --deep --strict "$app_path" >"$codesign_verify_output" 2>&1; then
  echo "Refusing to zip an app whose code signature does not verify. The bundle contents no longer match the embedded signature." >&2
  cat "$codesign_verify_output" >&2 || true
  exit 1
fi

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

if ! grep -Fx "Identifier=${expected_bundle_id}" "$codesign_output" >/dev/null; then
  echo "Cask zip requires codesign Identifier ${expected_bundle_id}." >&2
  cat "$codesign_output" >&2 || true
  exit 1
fi

if ! xcrun stapler validate "$app_path" >"$stapler_output" 2>&1; then
  echo "Refusing to zip an app that is not notarized and stapled. Notarize and staple the Developer ID-signed Simulator Broker.app, then rerun." >&2
  cat "$stapler_output" >&2 || true
  exit 1
fi

if ! candidate_zip="$(mktemp "$output_dir/.${zip_name}.XXXXXX" 2>/dev/null)"; then
  echo "Unable to prepare the cask ZIP candidate." >&2
  exit 1
fi
if ! ditto -c -k --norsrc --noextattr --noacl --noqtn --keepParent "$app_path" "$candidate_zip"; then
  echo "Failed to create the cask ZIP candidate." >&2
  exit 1
fi

# The docs regression invokes this same standard-library candidate validator.
if ! python3 "$repo_root/scripts/validate_cask_zip.py" "$candidate_zip" "$app_basename"; then
  exit 1
fi

archive_hash=""
if command -v shasum >/dev/null 2>&1; then
  if ! archive_hash="$(shasum -a 256 "$candidate_zip" 2>/dev/null | awk '{print $1}')"; then
    echo "Unable to compute the cask ZIP checksum." >&2
    exit 1
  fi
elif command -v sha256sum >/dev/null 2>&1; then
  if ! archive_hash="$(sha256sum "$candidate_zip" 2>/dev/null | awk '{print $1}')"; then
    echo "Unable to compute the cask ZIP checksum." >&2
    exit 1
  fi
else
  echo "Neither shasum nor sha256sum is available; cannot write the cask ZIP checksum." >&2
  exit 1
fi
if [[ ! "$archive_hash" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "Unable to compute the cask ZIP checksum." >&2
  exit 1
fi

if ! candidate_checksum="$(mktemp "$output_dir/.${zip_name}.sha256.XXXXXX" 2>/dev/null)"; then
  echo "Unable to prepare the cask ZIP checksum candidate." >&2
  exit 1
fi
if ! printf '%s  %s\n' "$archive_hash" "$zip_name" > "$candidate_checksum" 2>/dev/null; then
  echo "Unable to write the cask ZIP checksum candidate." >&2
  exit 1
fi

# Normalize both complete candidates before either final name becomes visible.
if ! chmod 0644 "$candidate_zip" "$candidate_checksum" 2>/dev/null; then
  echo "Unable to publish readable cask ZIP artifacts." >&2
  exit 1
fi
if ! mv "$candidate_zip" "$zip_path" 2>/dev/null; then
  echo "Unable to publish the cask ZIP." >&2
  exit 1
fi
candidate_zip=""
if ! mv "$candidate_checksum" "$checksum_path" 2>/dev/null; then
  echo "Unable to publish the cask ZIP checksum." >&2
  exit 1
fi
candidate_checksum=""
published=true

printf '%s\n' "$zip_path"
printf '%s\n' "$checksum_path"
