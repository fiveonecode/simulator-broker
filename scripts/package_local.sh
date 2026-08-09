#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/script/require_macos_build_prereqs.sh"
output_dir="$repo_root/artifacts/distribution"
archive_name="SimulatorBroker-macOS-local-debug"
skip_build=0
app_source="$repo_root/DerivedData/SimulatorBrokerApp/Build/Products/Debug/SimulatorBrokerApp.app"

validate_archive_name() {
  local name="$1"

  if [[ -z "$name" || "$name" == "." || "$name" == ".." || "$name" == *"/"* || "$name" == *"\\"* ]]; then
    echo "Archive name must be a non-dot basename without path separators: $name" >&2
    exit 1
  fi
}

require_strict_child_path() {
  local parent="$1"
  local child="$2"

  case "$child" in
    "$parent"/*)
      ;;
    *)
      echo "Refusing to package outside the output directory: $child" >&2
      exit 1
      ;;
  esac
}

usage() {
  cat <<'EOF'
Usage: bash scripts/package_local.sh [options]

Build and package the Debug app into a portable local-development bundle.
This path is intentionally not distribution-ready and does not perform
signing or Gatekeeper validation for shipping.

Options:
  --output-dir <path>    Destination for the bundle, zip, and summary JSON.
  --archive-name <name>  Bundle/archive base name. Default:
                         SimulatorBroker-macOS-local-debug
  --skip-build           Reuse an existing Debug app in DerivedData.
  -h, --help             Show this help text.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      output_dir="$2"
      shift 2
      ;;
    --archive-name)
      archive_name="$2"
      shift 2
      ;;
    --skip-build)
      skip_build=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown package_local.sh argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

validate_archive_name "$archive_name"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"

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
  echo "Built Debug app bundle not found at $app_source" >&2
  exit 1
fi

bundle_root="$output_dir/$archive_name"
payload_root="$bundle_root/payload"
support_root="$bundle_root/support"
archive_path="$output_dir/$archive_name.zip"
summary_path="$output_dir/$archive_name.json"

require_strict_child_path "$output_dir" "$bundle_root"
require_strict_child_path "$output_dir" "$archive_path"
require_strict_child_path "$output_dir" "$summary_path"

rm -rf "$bundle_root" "$archive_path"
mkdir -p "$payload_root/app" "$payload_root/runtime" "$support_root"

cp -R "$repo_root/broker-core" "$payload_root/runtime/"
cp -R "$repo_root/client" "$payload_root/runtime/"
cp "$repo_root/package.json" "$payload_root/runtime/package.json"
cp -R "$app_source" "$payload_root/app/Simulator Broker.app"
cp "$repo_root/LICENSE" "$bundle_root/LICENSE"

cp "$repo_root/scripts/install_distribution.sh" "$support_root/install_distribution.sh"
chmod +x "$support_root/install_distribution.sh"

cat > "$bundle_root/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
bundle_root="$(cd "$(dirname "$0")" && pwd)"
exec bash "$bundle_root/support/install_distribution.sh" \
  --payload-root "$bundle_root/payload" \
  --install-source local-debug-portable-bundle \
  "$@"
EOF
chmod +x "$bundle_root/install.sh"

cat > "$bundle_root/README.txt" <<'EOF'
Simulator Broker local-debug portable bundle

This bundle packages the Debug app for internal development convenience.
It is not a signed, notarized, or Gatekeeper-ready distribution artifact.
If you have repo access on this machine, prefer `npm run install:local`
from the repo checkout instead of using this bundle.

1. Run ./install.sh
2. Source "$HOME/Library/Application Support/SimulatorBroker/install/env.sh"
3. Run "simbroker host init --bootstrap-config" on the target machine

Optional install flags:
- --prefix <path>
- --bin-dir <path>
- --applications-dir <path>
EOF

ditto -c -k --sequesterRsrc --keepParent "$bundle_root" "$archive_path"

node - <<'EOF' "$summary_path" "$archive_path" "$bundle_root"
const fs = require("node:fs");

const [summaryPath, archivePath, bundlePath] = process.argv.slice(2);
const summary = {
  archivePath,
  artifactKind: "local-debug-portable-bundle",
  buildConfiguration: "Debug",
  bundlePath,
  distributionReady: false,
  generatedAt: new Date().toISOString(),
  signingValidation: "not-run",
  warning:
    "This bundle packages the Debug app for local development only. Use scripts/package_distribution.sh for Release packaging and signing validation."
};

fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
EOF

cat "$summary_path"
