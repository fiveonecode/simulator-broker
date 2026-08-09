---
name: broker-harness-adoption
description: Make a consumer repo, agent instructions, and CI harness broker-aware for Simulator Broker. Use when a repo needs `.simulator-broker/project.json`, broker-aware wrapper scripts, AGENTS.md or CLAUDE.md updates, CI integration, or an audit against the canonical harness integration guide.
---

# Broker Harness Adoption

Use this skill when a repo needs to adopt Simulator Broker as part of its human workflows, AI agent workflows, or CI.

## Workflow

### 1. Read the contract first

- Read [spec/harness-integration.md](../../../spec/harness-integration.md) before proposing or applying changes.
- Treat that guide as the source of truth.
- Do not invent a second broker adoption contract in prompt text or code comments.

### 2. Inspect the consumer repo

- Find the simulator-dependent entrypoints:
  - wrapper scripts
  - task runners
  - AGENTS.md or equivalent agent instructions
  - CI workflows
- Identify which flows need separate broker purposes such as `manual-testing`, `agent-ui-session`, `agent-build-test`, or `ci-ui-test`.
- Check whether the repo already uses direct `simctl`, hardcoded alias names, or ad hoc lease files.

### 3. Apply the minimum committed changes

- Add or update `.simulator-broker/project.json`.
- Add one shared broker-aware lease helper plus thin flow-specific wrappers when the repo has multiple simulator workflow classes.
- Update agent instructions so agents acquire by purpose and avoid direct `simctl` mutation on broker-managed aliases.
- Update CI or automation wiring when the repo uses simulators in unattended runs.

### 4. Preserve the broker model

- Select by purpose, not by host alias name.
- Keep machine-local broker paths out of committed repo config.
- Prefer `--repo-root` plus `--lease-file` in wrappers.
- Release the lease in a trap, `finally`, or equivalent cleanup path.
- Use broker surfaces for diagnosis:
  - `simbroker lease explain`
  - `simbroker host status`
  - `simbroker lease show`
  - `simbroker events watch`

### 5. Reuse the sample repo when helpful

- Use [examples/harness-adoption/sample-consumer-repo/README.md](../../../examples/harness-adoption/sample-consumer-repo/README.md) as the default pattern for:
  - purpose mapping across manual, agent-interactive, agent-build-test, and CI flows
  - broker-aware shell wrappers
  - agent instructions
  - CI runner scripts
- Adapt the example to the consumer repo instead of copying it blindly.

### 6. Verify the adoption

- Run `simbroker project validate --repo-root <repo>`.
- Run `simbroker lease explain --repo-root <repo> --purpose <purpose>`.
- Run at least one repo-local broker-aware wrapper and confirm cleanup releases the lease.
- When the repo has multiple workflow classes, verify at least one success path and one failure-cleanup path.
- When working inside this repo, also run `npm run test:harness-adoption`.

## Deliverables

- committed project policy
- broker-aware wrapper entrypoint or wrapper set
- updated agent instructions
- CI or automation integration when relevant
- verification evidence that the repo can acquire and release through the broker
