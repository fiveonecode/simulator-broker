#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source "$repo_root/script/require_macos_build_prereqs.sh"

require_macos_build_prereqs
xcodegen generate --spec "$repo_root/app/project.yml"
