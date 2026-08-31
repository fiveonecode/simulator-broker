#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="$repo_root/artifacts/cli"

usage() {
  cat <<'EOF'
Usage: bash scripts/package_cli.sh [options]

Package the Node CLI runtime into a versioned tarball. This path does not
build or include the macOS operator app.

Options:
  --output-dir <path>  Destination for the tarball and checksum. Default:
                       artifacts/cli
  -h, --help           Show this help text.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      output_dir="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown package_cli.sh argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! version="$(node -e "const fs=require('node:fs'); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).version)" "$repo_root/package.json" 2>/dev/null)"; then
  echo "Unable to read the CLI package version." >&2
  exit 1
fi

if [[ -z "$version" || "$version" == "." || "$version" == ".." || "$version" == *"/"* || "$version" == *"\\"* ]]; then
  echo "Refusing to package an invalid package.json version: ${version:-<empty>}" >&2
  exit 1
fi

archive_name="simulator-broker-${version}-cli"
if ! mkdir -p "$output_dir" 2>/dev/null; then
  echo "Unable to prepare the CLI output directory." >&2
  exit 1
fi
if ! output_dir="$(cd "$output_dir" 2>/dev/null && pwd -P)"; then
  echo "Unable to resolve the CLI output directory." >&2
  exit 1
fi
tarball="$output_dir/${archive_name}.tar.gz"
checksum="$output_dir/${archive_name}.tar.gz.sha256"

# A failed rebuild must not leave older final bytes looking current.
if ! rm -f "$tarball" "$checksum" 2>/dev/null; then
  echo "Unable to clear older CLI package outputs." >&2
  exit 1
fi

tar_binary="$(command -v tar || true)"
if [[ -z "$tar_binary" ]]; then
  echo "CLI packaging requires GNU tar or bsdtar." >&2
  exit 1
fi
if ! tar_version="$(LC_ALL=C "$tar_binary" --version 2>/dev/null)"; then
  echo "Unable to identify the tar implementation; expected GNU tar or bsdtar." >&2
  exit 1
fi
tar_version_first_line="${tar_version%%$'\n'*}"
case "$tar_version_first_line" in
  "tar (GNU tar) "*)
    tar_create_options=(
      --format=ustar
      --no-xattrs
      --owner=0
      --group=0
      --numeric-owner
    )
    ;;
  "bsdtar "*)
    tar_create_options=(
      --format
      ustar
      --uid
      0
      --gid
      0
      --uname
      ''
      --gname
      ''
      --no-mac-metadata
      --no-xattrs
    )
    ;;
  *)
    echo "Unsupported tar implementation; expected GNU tar or bsdtar." >&2
    exit 1
    ;;
esac

reject_appledouble() {
  local scan_root="$1"
  local public_label="$2"
  local match
  if ! match="$(find "$scan_root" -name '._*' -print -quit 2>/dev/null)"; then
    echo "Unable to inspect ${public_label} for AppleDouble metadata." >&2
    return 1
  fi
  if [[ -n "$match" ]]; then
    echo "Refusing to package AppleDouble metadata under ${public_label}." >&2
    return 1
  fi
}

# Source AppleDouble metadata is an input error, never something to hide.
reject_appledouble "$repo_root/broker-core" "broker-core"
reject_appledouble "$repo_root/client" "client"

stage=""
candidate_tarball=""
candidate_checksum=""
published=false
cleanup() {
  if [[ -n "$stage" ]]; then
    rm -rf "$stage" 2>/dev/null || true
  fi
  if [[ -n "$candidate_tarball" ]]; then
    rm -f "$candidate_tarball" 2>/dev/null || true
  fi
  if [[ -n "$candidate_checksum" ]]; then
    rm -f "$candidate_checksum" 2>/dev/null || true
  fi
  if [[ "$published" != true ]]; then
    rm -f "$tarball" "$checksum" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if ! stage="$(mktemp -d "${TMPDIR:-/tmp}/simbroker-package-cli.XXXXXX" 2>/dev/null)"; then
  echo "Unable to create the CLI staging directory." >&2
  exit 1
fi
bundle="$stage/$archive_name"
if ! mkdir -p "$bundle/bin" "$bundle/broker-core" "$bundle/client" 2>/dev/null; then
  echo "Unable to prepare the CLI staging payload." >&2
  exit 1
fi

# Prevent copyfile from synthesizing AppleDouble companions during staging.
export COPYFILE_DISABLE=1

if ! "$tar_binary" "${tar_create_options[@]}" -C "$repo_root/broker-core" --exclude test --exclude '*.test.mjs' -cf - . 2>/dev/null \
  | "$tar_binary" -C "$bundle/broker-core" -xf - 2>/dev/null; then
  echo "Failed to stage the broker-core CLI payload." >&2
  exit 1
fi
if ! "$tar_binary" "${tar_create_options[@]}" -C "$repo_root/client" --exclude test --exclude '*.test.mjs' -cf - . 2>/dev/null \
  | "$tar_binary" -C "$bundle/client" -xf - 2>/dev/null; then
  echo "Failed to stage the client CLI payload." >&2
  exit 1
fi

if ! {
  cp "$repo_root/package.json" "$bundle/package.json" \
    && cp "$repo_root/LICENSE" "$bundle/LICENSE" \
    && cp "$repo_root/CHANGELOG.md" "$bundle/CHANGELOG.md"
} 2>/dev/null; then
  echo "Failed to stage the CLI root payload." >&2
  exit 1
fi

if ! {
  printf '# Simulator Broker CLI %s\n\n' "$version"
  cat <<'EOF'
Alpha CLI runtime. Node.js 20 or newer is required. Creating and running iOS
Simulators still requires macOS and Xcode.

From the directory where you extracted the tarball, run:

EOF
  printf '    ./%s/bin/simbroker --help\n\n' "$archive_name"
  printf 'If your shell is already inside %s, run ./bin/simbroker --help.\n\n' "$archive_name"
  cat <<'EOF'
This archive is the Node CLI only. Homebrew installs it through
Formula/simbroker.rb. The packable npm CLI is packages/simbroker
(`npm run package:npm`). The macOS operator app is separate.
EOF
} > "$bundle/README.md" 2>/dev/null; then
  echo "Failed to write the CLI README payload." >&2
  exit 1
fi

if ! cat > "$bundle/bin/simbroker" 2>/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/client/bin/simbroker.mjs" "$@"
EOF
then
  echo "Failed to write the CLI launcher payload." >&2
  exit 1
fi
if ! chmod +x "$bundle/bin/simbroker" 2>/dev/null; then
  echo "Failed to make the CLI launcher executable." >&2
  exit 1
fi

reject_appledouble "$bundle" "$archive_name"

if ! candidate_tarball="$(mktemp "$output_dir/.${archive_name}.tar.gz.XXXXXX" 2>/dev/null)"; then
  echo "Unable to prepare the CLI tar candidate." >&2
  exit 1
fi
if ! "$tar_binary" "${tar_create_options[@]}" -C "$stage" -czf "$candidate_tarball" "$archive_name" 2>/dev/null; then
  echo "Failed to create the CLI tar candidate." >&2
  exit 1
fi

# This is the same raw-header contract imported by the docs regression.
if ! node "$repo_root/scripts/validate_cli_tar.mjs" "$candidate_tarball" "$archive_name"; then
  exit 1
fi

archive_hash=""
if command -v shasum >/dev/null 2>&1; then
  if ! archive_hash="$(shasum -a 256 "$candidate_tarball" 2>/dev/null | awk '{print $1}')"; then
    echo "Unable to compute the CLI tar checksum." >&2
    exit 1
  fi
elif command -v sha256sum >/dev/null 2>&1; then
  if ! archive_hash="$(sha256sum "$candidate_tarball" 2>/dev/null | awk '{print $1}')"; then
    echo "Unable to compute the CLI tar checksum." >&2
    exit 1
  fi
else
  echo "Neither shasum nor sha256sum is available; cannot write the CLI checksum." >&2
  exit 1
fi
if [[ ! "$archive_hash" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "Unable to compute the CLI tar checksum." >&2
  exit 1
fi

if ! candidate_checksum="$(mktemp "$output_dir/.${archive_name}.tar.gz.sha256.XXXXXX" 2>/dev/null)"; then
  echo "Unable to prepare the CLI checksum candidate." >&2
  exit 1
fi
if ! printf '%s  %s\n' "$archive_hash" "${archive_name}.tar.gz" > "$candidate_checksum" 2>/dev/null; then
  echo "Unable to write the CLI checksum candidate." >&2
  exit 1
fi

if ! mv "$candidate_tarball" "$tarball" 2>/dev/null; then
  echo "Unable to publish the CLI tarball." >&2
  exit 1
fi
candidate_tarball=""
if ! mv "$candidate_checksum" "$checksum" 2>/dev/null; then
  echo "Unable to publish the CLI checksum." >&2
  exit 1
fi
candidate_checksum=""
published=true

printf '%s\n' "$tarball"
printf '%s\n' "$checksum"
