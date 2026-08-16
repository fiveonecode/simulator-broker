#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/script/require_macos_build_prereqs.sh"
output_dir="$repo_root/artifacts/distribution"
archive_name="SimulatorBroker-macOS-distribution"
skip_build=0
derived_data_path="$repo_root/DerivedData/SimulatorBrokerApp"
app_source="$derived_data_path/Build/Products/Release/SimulatorBrokerApp.app"
signing_identity="${SIMBROKER_DISTRIBUTION_SIGNING_IDENTITY:-}"
team_id="${SIMBROKER_DISTRIBUTION_TEAM_ID:-}"
notarytool_profile="${SIMBROKER_NOTARYTOOL_PROFILE:-}"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/simbroker-package-distribution.XXXXXX")"

cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

run_with_output_capture() {
  local output_path="$1"
  shift

  if "$@" >"$output_path" 2>&1; then
    return 0
  else
    local status=$?
    return "$status"
  fi
}

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

scan_distribution_public_surface() {
  local bundle_root="$1"
  local archive_name="$2"
  local files_path="$tmp_root/distribution-public-surface-files.txt"

  (
    cd "$bundle_root"
    find . -print0 | LC_ALL=C sort -z > "$files_path"
  )

  node --input-type=module - "$repo_root" "$bundle_root" "$files_path" "$repo_root/.public-safety.local" "$archive_name" <<'EOF'
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const [repoRoot, bundleRoot, filesPath, denylistPath, archiveName] = process.argv.slice(2);
const { scanPublicSurface } = await import(pathToFileURL(path.join(repoRoot, "client/public-surface.mjs")).href);
const files = fs.readFileSync(filesPath)
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .map((file) => file.replace(/^\.\//u, ""));
files.push(archiveName);
const report = scanPublicSurface({
  denylistPath,
  files,
  root: bundleRoot,
});

if (report.ok) {
  process.stdout.write(`Distribution public surface verified (${report.filesScanned} files scanned).\n`);
} else {
  process.stderr.write(`Distribution public surface verification failed with ${report.issues.length} issue(s).\n`);
  for (const issue of report.issues) {
    process.stderr.write(`${issue.path}:${issue.line} [${issue.rule}]\n`);
  }
  process.exitCode = 1;
}
EOF
}

usage() {
  cat <<'EOF'
Usage: bash scripts/package_distribution.sh [options]

Build and package the Release app as a signed distribution candidate.
This path requires operator-supplied signing inputs and will return non-zero
after writing a summary JSON if codesign, notarization, or Gatekeeper checks
show the artifact is not yet distribution-ready.

Options:
  --output-dir <path>         Destination for the bundle, zip, and summary JSON.
  --archive-name <name>       Bundle/archive base name. Default:
                              SimulatorBroker-macOS-distribution
  --signing-identity <name>   Required signing identity. May also be supplied
                              through SIMBROKER_DISTRIBUTION_SIGNING_IDENTITY.
  --team-id <id>              Required Apple team identifier. May also be
                              supplied through SIMBROKER_DISTRIBUTION_TEAM_ID.
  --notarytool-profile <name> Optional xcrun notarytool keychain profile. May
                              also be supplied through SIMBROKER_NOTARYTOOL_PROFILE.
  --skip-build                Reuse an existing Release app in DerivedData.
  -h, --help                  Show this help text.

For shipping or Gatekeeper validation, use a Developer ID Application identity
and provide notarization credentials through a keychain-backed notarytool profile.
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
    --signing-identity)
      signing_identity="$2"
      shift 2
      ;;
    --team-id)
      team_id="$2"
      shift 2
      ;;
    --notarytool-profile)
      notarytool_profile="$2"
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
      echo "Unknown package_distribution.sh argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

validate_archive_name "$archive_name"

(
  cd "$repo_root"
  npm run verify:public-surface
)

if [[ -z "$signing_identity" ]]; then
  echo "package_distribution.sh requires --signing-identity or SIMBROKER_DISTRIBUTION_SIGNING_IDENTITY." >&2
  exit 1
fi

if [[ -z "$team_id" ]]; then
  echo "package_distribution.sh requires --team-id or SIMBROKER_DISTRIBUTION_TEAM_ID." >&2
  exit 1
fi

identity_inventory="$(security find-identity -p codesigning -v 2>/dev/null || true)"

if ! printf '%s\n' "$identity_inventory" | grep -F "\"$signing_identity\"" >/dev/null; then
  echo "Signing identity was not found in the local keychain: $signing_identity" >&2
  exit 1
fi

if ! printf '%s\n' "$identity_inventory" | grep -F "\"$signing_identity\"" | grep -F "($team_id)" >/dev/null; then
  echo "Signing identity does not match the requested team ID ($team_id): $signing_identity" >&2
  exit 1
fi

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
build_log_path="$output_dir/$archive_name.build.log"

if [[ "$skip_build" -ne 1 ]]; then
  require_macos_build_prereqs
  bash "$repo_root/scripts/generate_app_project.sh"
  if ! xcodebuild \
    -project "$repo_root/app/SimulatorBrokerApp.xcodeproj" \
    -scheme SimulatorBrokerApp \
    -derivedDataPath "$derived_data_path" \
    -destination "platform=macOS" \
    -configuration Release \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    build >"$build_log_path" 2>&1; then
    echo "Release build failed. Inspect $build_log_path for the xcodebuild error output." >&2
    tail -n 20 "$build_log_path" >&2 || true
    exit 65
  fi
fi

if [[ ! -d "$app_source" ]]; then
  echo "Built Release app bundle not found at $app_source" >&2
  exit 1
fi

bundle_root="$output_dir/$archive_name"
payload_root="$bundle_root/payload"
support_root="$bundle_root/support"
archive_path="$output_dir/$archive_name.zip"
summary_path="$output_dir/$archive_name.json"
distribution_app_path="$payload_root/app/Simulator Broker.app"
codesign_sign_output_path="$tmp_root/codesign-sign.txt"

codesign_output_path="$tmp_root/codesign.txt"
spctl_output_path="$tmp_root/spctl.txt"
notarytool_output_path="$tmp_root/notarytool.txt"
stapler_output_path="$tmp_root/stapler.txt"

require_strict_child_path "$output_dir" "$bundle_root"
require_strict_child_path "$output_dir" "$archive_path"
require_strict_child_path "$output_dir" "$summary_path"
require_strict_child_path "$output_dir" "$build_log_path"

rm -rf "$bundle_root" "$archive_path"
mkdir -p "$payload_root/app" "$payload_root/runtime" "$support_root"

cp -R "$repo_root/broker-core" "$payload_root/runtime/"
cp -R "$repo_root/client" "$payload_root/runtime/"
cp "$repo_root/package.json" "$payload_root/runtime/package.json"
cp -R "$app_source" "$distribution_app_path"
cp "$repo_root/LICENSE" "$bundle_root/LICENSE"

cp "$repo_root/scripts/install_distribution.sh" "$support_root/install_distribution.sh"
chmod +x "$support_root/install_distribution.sh"

cat > "$bundle_root/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
bundle_root="$(cd "$(dirname "$0")" && pwd)"
exec bash "$bundle_root/support/install_distribution.sh" \
  --payload-root "$bundle_root/payload" \
  --install-source distribution-package \
  "$@"
EOF
chmod +x "$bundle_root/install.sh"

cat > "$bundle_root/README.txt" <<'EOF'
Simulator Broker distribution package

This bundle packages the Release app as a signed distribution candidate.
Review the summary JSON that sits next to this bundle before treating the
artifact as Gatekeeper-ready or distributing it outside local validation.

Operator-supplied inputs:
- Apple team ID
- signing identity
- optional xcrun notarytool keychain profile for notarization and stapling

Optional install flags:
- --prefix <path>
- --bin-dir <path>
- --applications-dir <path>
EOF

scan_distribution_public_surface "$bundle_root" "$archive_name"

codesign_sign_exit_code=0
if run_with_output_capture \
  "$codesign_sign_output_path" \
  codesign \
  --force \
  --options runtime \
  --sign "$signing_identity" \
  --timestamp \
  "$distribution_app_path"; then
  :
else
  codesign_sign_exit_code=$?
fi

notarization_status="skipped"
notarization_note="No notarytool profile was provided. Supply --notarytool-profile or SIMBROKER_NOTARYTOOL_PROFILE and rerun package_distribution.sh to notarize and staple the Release app."
notarization_exit_code=0

if [[ "$codesign_sign_exit_code" -ne 0 ]]; then
  notarization_note="Signing failed before notarization could run. Inspect the signing output and requested identity, then rerun package_distribution.sh."
fi

ditto -c -k --sequesterRsrc --keepParent "$bundle_root" "$archive_path"

if [[ "$codesign_sign_exit_code" -eq 0 && -n "$notarytool_profile" ]]; then
  if xcrun notarytool submit "$archive_path" --keychain-profile "$notarytool_profile" --wait >"$notarytool_output_path" 2>&1; then
    if xcrun stapler staple "$distribution_app_path" >"$stapler_output_path" 2>&1; then
      notarization_status="accepted"
      notarization_note="The archive was notarized with notarytool and the app bundle was stapled."
      rm -f "$archive_path"
      ditto -c -k --sequesterRsrc --keepParent "$bundle_root" "$archive_path"
    else
      notarization_exit_code=$?
      notarization_status="staple-failed"
      notarization_note="Notary submission succeeded, but stapling the app bundle failed."
    fi
  else
    notarization_exit_code=$?
    notarization_status="rejected"
    notarization_note="Notary submission failed."
  fi
fi

codesign_exit_code=0
if run_with_output_capture \
  "$codesign_output_path" \
  codesign -dvvv --entitlements :- "$distribution_app_path"; then
  :
else
  codesign_exit_code=$?
fi

spctl_exit_code=0
if run_with_output_capture \
  "$spctl_output_path" \
  spctl -a -vv "$distribution_app_path"; then
  :
else
  spctl_exit_code=$?
fi

signed_team_identifier="$(sed -n 's/^TeamIdentifier=//p' "$codesign_output_path" | head -n 1)"
team_identifier_matches_requested=1
if [[ -n "$signed_team_identifier" && "$signed_team_identifier" != "$team_id" ]]; then
  team_identifier_matches_requested=0
fi

gatekeeper_status="rejected"
if grep -Eiq ': accepted($|[[:space:]])' "$spctl_output_path"; then
  gatekeeper_status="accepted"
elif grep -Eiq ': rejected($|[[:space:]])' "$spctl_output_path"; then
  gatekeeper_status="rejected"
elif [[ "$spctl_exit_code" -eq 0 ]]; then
  gatekeeper_status="accepted"
fi

node - <<'EOF' \
  "$summary_path" \
  "$archive_path" \
  "$bundle_root" \
  "$distribution_app_path" \
  "$signing_identity" \
  "$team_id" \
  "$codesign_sign_output_path" \
  "$codesign_sign_exit_code" \
  "$codesign_output_path" \
  "$codesign_exit_code" \
  "$spctl_output_path" \
  "$spctl_exit_code" \
  "$gatekeeper_status" \
  "$team_identifier_matches_requested" \
  "$notarytool_output_path" \
  "$stapler_output_path" \
  "$notarization_status" \
  "$notarization_note" \
  "$notarization_exit_code"
const fs = require("node:fs");

const [
  summaryPath,
  archivePath,
  bundlePath,
  appPath,
  requestedSigningIdentity,
  requestedTeamIdentifier,
  codesignSignOutputPath,
  codesignSignExitCode,
  codesignOutputPath,
  codesignExitCode,
  spctlOutputPath,
  spctlExitCode,
  gatekeeperStatus,
  teamIdentifierMatchesRequested,
  notarytoolOutputPath,
  staplerOutputPath,
  notarizationStatus,
  notarizationNote,
  notarizationExitCode
] = process.argv.slice(2);

const readMaybe = (path) => {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

const codesignSignOutput = readMaybe(codesignSignOutputPath);
const codesignOutput = readMaybe(codesignOutputPath);
const spctlOutput = readMaybe(spctlOutputPath);
const notarytoolOutput = readMaybe(notarytoolOutputPath);
const staplerOutput = readMaybe(staplerOutputPath);

const signatureSummary =
  codesignOutput.match(/^Signature=(.*)$/m)?.[1] ??
  codesignOutput.match(/^Signature size=(.*)$/m)?.[1] ??
  "unknown";
const teamIdentifierSummary = codesignOutput.match(/^TeamIdentifier=(.*)$/m)?.[1] ?? "unknown";
const identifierSummary = codesignOutput.match(/^Identifier=(.*)$/m)?.[1] ?? "unknown";
const hardenedRuntimeEnabled = /runtime\b/.test(codesignOutput);

let signingIdentityClass = "unknown";
if (requestedSigningIdentity.startsWith("Developer ID Application:")) {
  signingIdentityClass = "developer-id-application";
} else if (requestedSigningIdentity.startsWith("Apple Development:")) {
  signingIdentityClass = "apple-development";
} else if (requestedSigningIdentity.startsWith("3rd Party Mac Developer Application:")) {
  signingIdentityClass = "app-store-distribution";
}

const gatekeeperAccepted = gatekeeperStatus === "accepted";
const summary = {
  archivePath,
  artifactKind: "distribution-candidate",
  appPath,
  buildConfiguration: "Release",
  bundlePath,
  generatedAt: new Date().toISOString(),
  requestedInputs: {
    signingIdentity: requestedSigningIdentity,
    teamIdentifier: requestedTeamIdentifier
  },
  signing: {
    bundleIdentifier: identifierSummary,
    hardenedRuntimeEnabled,
    requestedIdentityClass: signingIdentityClass,
    signatureSummary,
    signStep: {
      command: `codesign --force --options runtime --sign ${requestedSigningIdentity} --timestamp ${appPath}`,
      exitCode: Number(codesignSignExitCode),
      output: codesignSignOutput.trimEnd()
    },
    teamIdentifierMatchesRequested: teamIdentifierMatchesRequested === "1",
    teamIdentifierSummary,
    validation: {
      codesignCommand: `codesign -dvvv --entitlements :- ${appPath}`,
      exitCode: Number(codesignExitCode),
      output: codesignOutput.trimEnd()
    }
  },
  gatekeeper: {
    command: `spctl -a -vv ${appPath}`,
    exitCode: Number(spctlExitCode),
    output: spctlOutput.trimEnd(),
    status: gatekeeperStatus
  },
  notarization: {
    exitCode: Number(notarizationExitCode),
    note: notarizationNote,
    notarytoolOutput: notarytoolOutput.trimEnd(),
    staplerOutput: staplerOutput.trimEnd(),
    status: notarizationStatus
  },
  readyForDistribution:
    Number(codesignSignExitCode) === 0 &&
    Number(codesignExitCode) === 0 &&
    teamIdentifierMatchesRequested === "1" &&
    gatekeeperAccepted &&
    notarizationStatus === "accepted"
};

fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
EOF

cat "$summary_path"

if [[ "$codesign_sign_exit_code" -ne 0 ]]; then
  echo "Signing the Release app failed. See $summary_path for details." >&2
  exit "$codesign_sign_exit_code"
fi

if [[ "$codesign_exit_code" -ne 0 ]]; then
  echo "codesign validation failed for the Release app. See $summary_path for details." >&2
  exit "$codesign_exit_code"
fi

if [[ "$notarization_exit_code" -ne 0 ]]; then
  echo "Notarization or stapling failed. See $summary_path for details." >&2
  exit "$notarization_exit_code"
fi

if [[ "$spctl_exit_code" -ne 0 ]]; then
  echo "spctl rejected the signed Release app. See $summary_path for details." >&2
  exit "$spctl_exit_code"
fi

if [[ "$team_identifier_matches_requested" -ne 1 ]]; then
  echo "The signed team identifier does not match the requested team ID. See $summary_path for details." >&2
  exit 1
fi

if [[ "$gatekeeper_status" != "accepted" ]]; then
  echo "spctl rejected the signed Release app. See $summary_path for details." >&2
  exit 1
fi

if [[ "$notarization_status" != "accepted" ]]; then
  echo "The Release app is not notarized and stapled yet. See $summary_path for the next operator step." >&2
  exit 1
fi
