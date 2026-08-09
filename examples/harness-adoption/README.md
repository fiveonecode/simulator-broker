# Harness Adoption Examples

These examples show how a consumer repo can become broker-aware without committing host-local alias names.

Current contents:

- `sample-consumer-repo/` — a pattern-library repo with:
  - committed `.simulator-broker/project.json`
  - one shared lease helper
  - manual human, interactive agent, unattended agent, and CI wrapper examples
  - downstream process registration and forced-abort containment evidence for build/test wrappers
  - agent instructions
  - a CI runner script and GitHub Actions example

Smoke coverage for these examples lives in `test/harness-adoption.test.mjs`.
