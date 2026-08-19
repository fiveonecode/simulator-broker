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

version="$(node -e "const fs=require('node:fs'); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).version)" "$repo_root/package.json")"

if [[ -z "$version" || "$version" == "." || "$version" == ".." || "$version" == *"/"* || "$version" == *"\\"* ]]; then
  echo "Refusing to package an invalid package.json version: ${version:-<empty>}" >&2
  exit 1
fi

stage="$(mktemp -d "${TMPDIR:-/tmp}/simbroker-package-cli.XXXXXX")"
cleanup() {
  rm -rf "$stage"
}
trap cleanup EXIT

archive_name="simulator-broker-${version}-cli"
bundle="$stage/$archive_name"
mkdir -p "$bundle/bin" "$bundle/broker-core" "$bundle/client"

tar -C "$repo_root/broker-core" --exclude test --exclude '*.test.mjs' -cf - . \
  | tar -C "$bundle/broker-core" -xf -
tar -C "$repo_root/client" --exclude test --exclude '*.test.mjs' -cf - . \
  | tar -C "$bundle/client" -xf -

cp "$repo_root/package.json" "$bundle/package.json"
cp "$repo_root/LICENSE" "$bundle/LICENSE"
cp "$repo_root/CHANGELOG.md" "$bundle/CHANGELOG.md"

cat > "$bundle/README.md" <<EOF
# Simulator Broker CLI ${version}

Alpha CLI runtime. Node.js 20 or newer is required. Creating and running iOS
Simulators still requires macOS and Xcode.

Run:

    ./bin/simbroker --help

This archive is the Node CLI only. Homebrew installs it through
Formula/simbroker.rb. The packable npm CLI is packages/simbroker
(`npm run package:npm`). The macOS operator app is separate.
EOF

cat > "$bundle/bin/simbroker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root/client/bin/simbroker.mjs" "$@"
EOF
chmod +x "$bundle/bin/simbroker"

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
tarball="$output_dir/${archive_name}.tar.gz"
checksum="$output_dir/${archive_name}.tar.gz.sha256"

tar -C "$stage" -czf "$tarball" "$archive_name"

if command -v shasum >/dev/null 2>&1; then
  (cd "$output_dir" && shasum -a 256 "${archive_name}.tar.gz" > "${archive_name}.tar.gz.sha256")
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$output_dir" && sha256sum "${archive_name}.tar.gz" > "${archive_name}.tar.gz.sha256")
else
  echo "Neither shasum nor sha256sum is available; cannot write $checksum" >&2
  exit 1
fi

printf '%s\n' "$tarball"
printf '%s\n' "$checksum"
