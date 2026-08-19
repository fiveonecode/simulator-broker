#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: bash scripts/sync_homebrew_tap.sh --tap-dir <path>
       bash scripts/sync_homebrew_tap.sh --check-remote

Copy Formula/ and Casks/ from this checkout into a clone of
fiveonecode/homebrew-simulator-broker. Refuses to delete tap files when
this tree has no Formula/simbroker.rb.

--check-remote compares this checkout's Formula/simbroker.rb to the
published tap formula. It is optional and is not part of spec-only.

Options:
  --tap-dir <path>  Existing checkout of fiveonecode/homebrew-simulator-broker
  --check-remote    Compare local Formula/simbroker.rb to the live tap
  -h, --help        Show this help text.
EOF
}

tap_dir=""
check_remote=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tap-dir)
      tap_dir="$2"
      shift 2
      ;;
    --check-remote)
      check_remote=1
      shift
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

if [[ "$check_remote" -eq 1 ]]; then
  if [[ ! -f "$repo_root/Formula/simbroker.rb" ]]; then
    echo "This tree has no Formula/simbroker.rb." >&2
    exit 1
  fi
  remote_url="https://raw.githubusercontent.com/fiveonecode/homebrew-simulator-broker/main/Formula/simbroker.rb"
  remote_tmp="$(mktemp "${TMPDIR:-/tmp}/simbroker-tap-formula.XXXXXX")"
  cleanup_remote() {
    rm -f "$remote_tmp"
  }
  trap cleanup_remote EXIT
  if ! curl --fail --silent --show-error --max-time 15 -A "simulator-broker-sync-homebrew-tap" \
    -o "$remote_tmp" "$remote_url"; then
    echo "Could not fetch live tap formula from $remote_url" >&2
    exit 1
  fi
  if ! cmp -s "$repo_root/Formula/simbroker.rb" "$remote_tmp"; then
    echo "Live tap Formula/simbroker.rb does not match this checkout. Run scripts/sync_homebrew_tap.sh --tap-dir <tap> and push the tap." >&2
    exit 1
  fi
  echo "Live tap formula matches this checkout."
  exit 0
fi

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
