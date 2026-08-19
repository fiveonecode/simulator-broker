#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: bash scripts/sync_homebrew_tap.sh --tap-dir <path>

Copy Formula/ and Casks/ from this checkout into a clone of
fiveonecode/homebrew-simulator-broker. Refuses to delete tap files when
this tree has no Formula/simbroker.rb.

Options:
  --tap-dir <path>  Existing checkout of fiveonecode/homebrew-simulator-broker
  -h, --help        Show this help text.
EOF
}

tap_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tap-dir)
      tap_dir="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown sync_homebrew_tap.sh argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$tap_dir" ]]; then
  usage >&2
  exit 1
fi

if [[ ! -d "$tap_dir/.git" ]]; then
  echo "Tap dir must be a git checkout: $tap_dir" >&2
  exit 1
fi

if [[ ! -f "$repo_root/Formula/simbroker.rb" ]]; then
  echo "This tree has no Formula/simbroker.rb; leaving the tap unchanged." >&2
  exit 1
fi

mkdir -p "$tap_dir/Formula" "$tap_dir/Casks"
cp -R "$repo_root/Formula/." "$tap_dir/Formula/"
cp -R "$repo_root/Casks/." "$tap_dir/Casks/"
printf '%s\n' "$tap_dir"
