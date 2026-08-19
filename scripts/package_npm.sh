#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="$repo_root/artifacts/npm"

usage() {
  cat <<'EOF'
Usage: bash scripts/package_npm.sh [options]

Stage the packable `simbroker` npm CLI (runtime without tests) and write
a versioned tarball. The repo-root package stays private.

Options:
  --output-dir <path>  Destination for the npm tarball. Default: artifacts/npm
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
      echo "Unknown package_npm.sh argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

pkg_src="$repo_root/packages/simbroker"
if [[ ! -f "$pkg_src/package.json" || ! -f "$pkg_src/bin/simbroker.js" ]]; then
  echo "Missing packages/simbroker package.json or bin/simbroker.js" >&2
  exit 1
fi

version="$(node -e "const fs=require('node:fs'); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).version)" "$repo_root/package.json")"
pkg_version="$(node -e "const fs=require('node:fs'); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).version)" "$pkg_src/package.json")"
pkg_name="$(node -e "const fs=require('node:fs'); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).name)" "$pkg_src/package.json")"
root_private="$(node -e "const fs=require('node:fs'); process.stdout.write(String(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).private === true))" "$repo_root/package.json")"

if [[ "$root_private" != "true" ]]; then
  echo "Refusing to pack while the repo-root package.json is not private" >&2
  exit 1
fi

if [[ "$pkg_name" != "simbroker" ]]; then
  echo "packages/simbroker package.json name must be simbroker" >&2
  exit 1
fi

if [[ "$version" != "$pkg_version" ]]; then
  echo "packages/simbroker version ($pkg_version) must match root version ($version)" >&2
  exit 1
fi

if [[ -z "$version" || "$version" == "." || "$version" == ".." || "$version" == *"/"* || "$version" == *"\\"* ]]; then
  echo "Refusing to package an invalid package.json version: ${version:-<empty>}" >&2
  exit 1
fi

stage="$(mktemp -d "${TMPDIR:-/tmp}/simbroker-package-npm.XXXXXX")"
cleanup() {
  rm -rf "$stage"
}
trap cleanup EXIT

mkdir -p "$stage/bin" "$stage/broker-core" "$stage/client"
cp "$pkg_src/package.json" "$stage/package.json"
cp "$pkg_src/bin/simbroker.js" "$stage/bin/simbroker.js"
chmod +x "$stage/bin/simbroker.js"
cp "$pkg_src/README.md" "$stage/README.md"
cp "$repo_root/LICENSE" "$stage/LICENSE"

tar -C "$repo_root/broker-core" --exclude test --exclude '*.test.mjs' -cf - . \
  | tar -C "$stage/broker-core" -xf -
tar -C "$repo_root/client" --exclude test --exclude '*.test.mjs' -cf - . \
  | tar -C "$stage/client" -xf -

mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"

(
  cd "$stage"
  npm pack --pack-destination "$output_dir"
)

tarball="$output_dir/simbroker-${version}.tgz"
if [[ ! -f "$tarball" ]]; then
  echo "npm pack did not write $tarball" >&2
  ls -la "$output_dir" >&2 || true
  exit 1
fi

printf '%s\n' "$tarball"
