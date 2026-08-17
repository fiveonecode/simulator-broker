#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

npm test
git diff --check -- \
  WORKFLOW.md \
  AGENTS.md \
  CLAUDE.md \
  CODE_OF_CONDUCT.md \
  CONTRIBUTING.md \
  LICENSE \
  README.md \
  SECURITY.md \
  docs \
  app \
  broker-core \
  client \
  examples \
  package-lock.json \
  package.json \
  script \
  scripts \
  spec \
  .agents \
  .codex
