#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash script/verify_release_app_binary.sh <executable> <local-build-root>

Verify that a universal macOS Release executable contains arm64 and x86_64
only, contains no debugging-symbol records, and does not embed the exact local
build root in either architecture or the universal container.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

if [[ "$#" -ne 2 ]]; then
  usage >&2
  exit 2
fi

executable_path="$1"
local_build_root="${2%/}"

[[ -f "$executable_path" ]] || die "Release executable was not found."
[[ -n "$local_build_root" && "$local_build_root" == /* && "$local_build_root" != "/" ]] \
  || die "Local build root must be a non-root absolute path."
[[ "$local_build_root" != *$'\n'* && "$local_build_root" != *$'\r'* ]] \
  || die "Local build root must not contain line breaks."
command -v node >/dev/null 2>&1 || die "Node.js is required to verify Release executable bytes."
command -v xcrun >/dev/null 2>&1 || die "xcrun is required to inspect the Release executable."

scan_raw_bytes() {
  local candidate_path="$1"
  local candidate_label="$2"

  node --input-type=module - "$candidate_path" "$local_build_root" "$candidate_label" <<'NODE'
import fs from "node:fs";

const [, , executablePath, localBuildRoot, candidateLabel] = process.argv;
const bytes = fs.readFileSync(executablePath);
const forbiddenPrefix = Buffer.from(`${localBuildRoot}/`, "utf8");

if (bytes.indexOf(forbiddenPrefix) !== -1) {
  process.stderr.write(`error: Release executable ${candidateLabel} contains the local build root.\n`);
  process.exit(1);
}
NODE
}

architecture_output="$(xcrun lipo "$executable_path" -archs 2>/dev/null)" \
  || die "Could not inspect the Release executable architectures."
read -r -a architectures <<<"$architecture_output"
if [[ "${#architectures[@]}" -ne 2 ]]; then
  die "Release executable must contain exactly arm64 and x86_64 slices."
fi
has_arm64=0
has_x86_64=0
for architecture in "${architectures[@]}"; do
  case "$architecture" in
    arm64)
      has_arm64=1
      ;;
    x86_64)
      has_x86_64=1
      ;;
    *)
      die "Release executable must contain exactly arm64 and x86_64 slices."
      ;;
  esac
done
if [[ "$has_arm64" -ne 1 || "$has_x86_64" -ne 1 ]]; then
  die "Release executable must contain exactly arm64 and x86_64 slices."
fi

slice_root="$(mktemp -d "${TMPDIR:-/tmp}/simbroker-release-binary.XXXXXX")"
cleanup() {
  rm -f \
    "$slice_root/arm64" \
    "$slice_root/arm64.nm" \
    "$slice_root/arm64.otool" \
    "$slice_root/x86_64" \
    "$slice_root/x86_64.nm" \
    "$slice_root/x86_64.otool"
  rmdir "$slice_root" 2>/dev/null || true
}
trap cleanup EXIT

for architecture in arm64 x86_64; do
  slice_path="$slice_root/$architecture"
  if ! xcrun lipo "$executable_path" -thin "$architecture" -output "$slice_path" >/dev/null 2>&1; then
    die "Could not inspect the Release executable $architecture slice."
  fi

  scan_raw_bytes "$slice_path" "$architecture slice"

  symbols_path="$slice_root/$architecture.nm"
  if ! xcrun nm -ap "$slice_path" >"$symbols_path" 2>/dev/null; then
    die "Could not inspect the Release executable $architecture symbols."
  fi
  node --input-type=module - "$symbols_path" "$architecture" <<'NODE'
import fs from "node:fs";

const [, , symbolsPath, architecture] = process.argv;
const symbols = fs.readFileSync(symbolsPath, "utf8");
const debuggingSymbol = /^[0-9A-Fa-f]+\s+-\s+[0-9A-Fa-f]{2}\s+[0-9A-Fa-f]{4}\s+/mu;

if (debuggingSymbol.test(symbols)) {
  process.stderr.write(`error: Release executable ${architecture} slice retains debugging symbols.\n`);
  process.exit(1);
}

if (/(?:^|\s)\/\S/mu.test(symbols)) {
  process.stderr.write(`error: Release executable ${architecture} slice retains an absolute-path symbol.\n`);
  process.exit(1);
}
NODE

  load_commands_path="$slice_root/$architecture.otool"
  if ! xcrun otool -l "$slice_path" >"$load_commands_path" 2>/dev/null; then
    die "Could not inspect the Release executable $architecture load commands."
  fi
  node --input-type=module - "$load_commands_path" "$architecture" <<'NODE'
import fs from "node:fs";

const [, , loadCommandsPath, architecture] = process.argv;
const loadCommands = fs.readFileSync(loadCommandsPath, "utf8");

if (/^\s*(?:segname|sectname)\s+__DWARF(?:\s|$)/mu.test(loadCommands)) {
  process.stderr.write(`error: Release executable ${architecture} slice retains embedded DWARF.\n`);
  process.exit(1);
}
NODE
done

scan_raw_bytes "$executable_path" "universal file"

echo "Release executable local-build-root check passed for arm64 and x86_64."
