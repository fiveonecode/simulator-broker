# Adoption Checklist

Use this checklist after reading `spec/harness-integration.md`.

## Required

- `.simulator-broker/project.json` exists and validates
- at least one broker-aware wrapper exists
- wrapper acquires by purpose and emits a deterministic lease artifact
- wrapper releases on failure and success
- agent instructions mention Simulator Broker and forbid direct `simctl` mutation on broker-managed aliases

## Pattern matrix when relevant

- manual human flow uses a dedicated purpose such as `manual-testing`
- interactive agent flow uses a dedicated purpose such as `agent-ui-session`
- unattended agent build or test flow uses a dedicated purpose such as `agent-build-test`
- CI flow uses a dedicated purpose such as `ci-ui-test`

## When CI uses simulators

- CI wrapper passes `--actor-type ci`
- CI wrapper passes stable `--job-id`
- CI wrapper passes stable `--job-kind`
- cleanup still releases after failing test steps

## Verification

- `simbroker project validate --repo-root <repo>`
- `simbroker lease explain --repo-root <repo> --purpose <purpose>`
- run one wrapper and confirm the selected simulator metadata is available downstream
- confirm there is no leftover active lease after the wrapper exits
- confirm at least one wrapper still releases the lease after a downstream failure when the repo has unattended automation
