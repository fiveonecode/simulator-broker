#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

managed_skills=(
  code-review
  harness-engineering
  ios-xcodegen
  spec-creation-updating
  xcode-build
  xcode-cloud
)

skill_roots=(
  .agent/skills
  .agents/skills
  .claude/skills
  .codex/skills
  .cursor/skills
  .opencode/skills
)

for root in "${skill_roots[@]}"; do
  for skill in "${managed_skills[@]}"; do
    target="$root/$skill"
    if [[ -e "$target" || -L "$target" ]]; then
      echo "managed-global skill must not be copied into this repository: $target" >&2
      exit 1
    fi
  done
done

echo "managed skill ownership check passed"
