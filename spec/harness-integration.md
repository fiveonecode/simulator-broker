# Harness Integration
Related: `spec/README.md`, `spec/implementation-plan.md`, `spec/global-simulator-broker.md`, `spec/agents.md`, `spec/build-and-test.md`

> **Document ID:** `GSB-HARNESS-001`
> **Version:** `0.4.1`
> **Last Updated:** `2026-08-10`
> **Status:** `Draft`
> **Owner:** `spec-steward`

## 1. Objective

This document defines how a consumer repo makes its human workflows, AI agents, and CI harness aware of Simulator Broker.

The goal is to make broker adoption explicit and repeatable:

- a repo maintainer can wire the broker in without hidden tribal knowledge
- an AI agent can discover the broker path from committed repo artifacts and agent instructions
- CI can acquire and release leases deterministically
- no consumer repo needs to commit host-local alias names for normal operation

This guide is the canonical source of truth for broker-aware harness integration.

If a reusable AI skill is created later, that skill must implement this guide rather than invent a second contract.

Current repo artifacts that follow this guide:

- `examples/harness-adoption/sample-consumer-repo/`
- `.agents/skills/broker-harness-adoption/`

Current sample coverage now includes:

- human manual checkout flow
- interactive AI-agent session flow
- unattended agent build-and-test flow
- CI UI-test flow

## 1.1 Recommended operator-first bootstrap

Recommended machine and repo onboarding order:

1. Install Simulator Broker locally (`bash scripts/install_local.sh --cli-only`
   or `npm run install:local`).
2. Verify the shell resolves the installed CLI with `command -v simbroker`.
   After install, a new login shell should already have `simbroker` on `PATH`.
   If this shell does not, source the env helper:
   `source "$HOME/Library/Application Support/SimulatorBroker/install/env.sh"`
3. Confirm `command -v simbroker` points at the installed wrapper.
4. Launch the app and complete host setup from the app if it shows `Set Up This Mac`.
5. Confirm the app dashboard is live and `brokerd` is running.
6. In each consumer repo, scaffold `.simulator-broker/project.json` with `simbroker project init --repo-root <repo>`.
7. Validate with `simbroker project validate --repo-root <repo>`.
8. Apply the repo harness changes from this guide or the `broker-harness-adoption` skill.

If the shell still does not resolve `simbroker`, open a new login shell, rerun
the `source .../env.sh` step, or use the absolute CLI path shown by the
installed app.

## 2. Adoption levels

### Minimal adoption

Required when a repo only needs occasional human or agent use:

- optionally scaffold the starting project file with `simbroker project init --repo-root <repo>`
- commit `.simulator-broker/project.json`
- validate the project file with `simbroker project validate`
- add agent instructions telling agents to use the broker CLI instead of direct `simctl` for broker-managed aliases

### Harness adoption

Required when a repo has repeatable local scripts or agent workflows:

- add one broker-aware wrapper or helper script
- acquire a lease before simulator work starts
- expose the lease artifact or selected simulator metadata to downstream steps
- release the lease in a shell trap, `finally`, or equivalent cleanup block

### Full automation adoption

Required when CI or scheduled automation uses simulators:

- use broker-aware wrapper commands in CI and automation
- pass stable actor and job metadata
- capture the lease artifact in job logs or artifacts when helpful
- verify that abnormal exits still release the lease

## 2.1 Canonical pattern matrix

Consumer repos should start from a small pattern library instead of inventing one-off wrappers.

Recommended baseline patterns:

- `manual-testing` for human-driven manual verification on a persistent manual slot
- `agent-ui-session` for interactive AI-agent sessions that need a resettable UI slot
- `agent-build-test` for unattended AI-agent build or test runs that should not compete with manual slots
- `ci-ui-test` for CI UI runs with stable job metadata

Recommended sample wrapper mapping:

- `scripts/run-manual-testing-session.sh`
- `scripts/run-agent-ui-session.sh`
- `scripts/run-agent-build-test.sh`
- `ci/run-ui-test.sh`

Pattern design rule:

- split purposes when queueing, reset behavior, or ownership expectations differ
- if two flows truly have the same broker behavior and contention policy, they may share one purpose

## 3. Required repo changes

Every broker-aware repo must make the following changes explicit.

### 3.1 Committed project policy

The repo must commit `.simulator-broker/project.json`.

Recommended bootstrap path:

```bash
simbroker project init --repo-root "$PWD"
```

The file must define:

- `projectId`
- `projectName`
- repo-owned `purposes`
- required broker capability per purpose
- optional v1 `requires.deviceFamily`
- optional v1 `requires.iosVersion`

The repo must not commit:

- host alias names for normal operation
- simulator UUIDs
- machine-local file paths outside repo-owned wrappers

### 3.2 Broker-aware wrapper entrypoint

The repo should expose one deterministic entrypoint for simulator work, such as:

- `scripts/with_simulator_broker.sh`
- `make broker-ui-session`
- `just broker-ui-session`
- a repo-native Node, Ruby, Python, or Swift helper

Repos with multiple simulator workflow classes should usually expose:

- one shared lease helper
- one thin wrapper per purpose pattern

The entrypoint must:

- call `simbroker lease acquire`
- pass `--repo-root` or `--project-file`
- pass `--purpose`
- pass `--actor-type`
- pass `--actor-id`
- pass `--session-dir` when an agent session has one
- pass `--lease-file` so downstream steps can read deterministic JSON
- pass `--owner-pid` and `--owner-pgid` when the wrapper can determine them
- pass `--evidence-dir` pointing at a run-local artifact directory
- call `simbroker lease register-process` after starting the downstream command so the broker can associate the lease with command PID, command process group, command string, memory ceiling, and simulator app/test-host process names
- call `simbroker lease contain --reason forced-abort` before release when downstream work fails or leaves possible detached processes
- release the lease with `simbroker lease release --lease-file <path>` on success

Build/test wrappers should support optional memory protection:

- `--memory-ceiling-bytes` or `--memory-ceiling-mib`
- `--monitor-interval-ms`
- configured simulator process names when detached test hosts do not include a predictable project-derived name

### 3.3 Agent instructions

The repo's agent instructions such as `AGENTS.md`, `CLAUDE.md`, or equivalent must teach agents:

- use Simulator Broker for broker-managed aliases
- select simulators by repo purpose, not by hardcoded alias
- use `lease explain`, `host status`, `lease show`, and `events watch` for diagnosis
- never call direct `simctl` mutations on broker-managed aliases unless the repo explicitly marks the action as outside broker control
- never attempt human-only override flows such as forced repair override
- when the repo ships a macOS app, route desktop build, launch, and focused test work through `xcode-build` and keep a repo-owned `script/build_and_run.sh` plus `.codex/environments/environment.toml` Run action in sync
- when the repo ships a macOS app, use `swiftui-pro`, `swift-concurrency-pro`, `apple-doc-research`, and `xcode-build` as the desktop-specific review and implementation guide rails

### 3.4 CI or automation wiring

Any CI or scheduled automation that uses simulators must:

- acquire by purpose before simulator work starts
- pass stable `--actor-type ci`
- pass stable `--job-id` and `--job-kind` when available
- release in a cleanup step that still runs after failure

## 4. Minimal execution pattern

This is the canonical harness flow for local scripts, agent sessions, and CI.

1. Validate broker project policy.
2. Run `simbroker capacity check --repo-root "$PWD" --purpose <purpose> --json`
   when the workflow needs an explicit preflight capacity report.
3. If check reports missing structural capacity, a human operator may run
   `simbroker capacity reconcile` to preview a deterministic additive plan and
   then apply that exact plan with `--apply --confirm <plan-id> --actor-type
   human --actor-id <operator-id>`.
4. Acquire a lease by purpose.
5. Read simulator metadata from the lease artifact. Successful acquisition
   means the selected simulator has already been booted by the broker.
6. Run simulator-dependent work.
7. Register downstream process metadata.
8. Monitor memory ceilings when configured.
9. Contain on forced abort, timeout, or ceiling breach.
10. Release the lease on success.

Agents and CI may consume capacity check and preview JSON as evidence, but they
must not run human-confirmed apply unattended. Apply is an operator action that
creates additive broker-managed capacity and writes local-only transaction
evidence.

Illustrative shell pattern:

```bash
set -euo pipefail

LEASE_FILE="${RUN_DIR}/simulator-lease.json"
EVIDENCE_DIR="${RUN_DIR}/simulator-broker-evidence"
LEASE_ACTIVE="false"
ALLOW_RELEASE="true"

cleanup() {
  if [[ "$LEASE_ACTIVE" != "true" ]]; then
    return
  fi
  if [[ "$ALLOW_RELEASE" == "true" ]]; then
    simbroker lease release --lease-file "$LEASE_FILE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

simbroker project validate --repo-root "$PWD" >/dev/null

simbroker lease acquire \
  --repo-root "$PWD" \
  --purpose agent-ui-session \
  --actor-type agent \
  --actor-id "${BROKER_ACTOR_ID}" \
  --session-dir "${SESSION_DIR}" \
  --evidence-dir "$EVIDENCE_DIR" \
  --owner-pid "$$" \
  --lease-file "$LEASE_FILE" >/dev/null
LEASE_ACTIVE="true"

SIMULATOR_ID="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).simulatorId)' "$LEASE_FILE")"
SIMULATOR_ALIAS="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).alias)' "$LEASE_FILE")"

# Start repo-specific simulator work, then register the downstream process.
run_tests &
COMMAND_PID="$!"
COMMAND_PGID="$(ps -o pgid= -p "$COMMAND_PID" | tr -d '[:space:]')"

simbroker lease register-process \
  --lease-file "$LEASE_FILE" \
  --pid "$COMMAND_PID" \
  --pgid "$COMMAND_PGID" \
  --command "run_tests" \
  --evidence-dir "$EVIDENCE_DIR" >/dev/null

if ! wait "$COMMAND_PID"; then
  if simbroker lease contain --lease-file "$LEASE_FILE" --reason forced-abort >/dev/null 2>&1; then
    simbroker lease release --lease-file "$LEASE_FILE" >/dev/null 2>&1 || true
    LEASE_ACTIVE="false"
  else
    ALLOW_RELEASE="false"
  fi
  exit 1
fi
```

Equivalent wrappers in other languages are acceptable if they preserve the same behavior.

## 5. Observation and debugging contract

Consumer repos should not invent custom state files when the broker already exposes the needed surfaces.

Required diagnostic commands:

- `simbroker project validate --repo-root <repo>`
- `simbroker project show --repo-root <repo>`
- `simbroker capacity check --repo-root <repo> [--purpose <purpose>] --json`
- `simbroker capacity reconcile --repo-root <repo> [--purpose <purpose>] --json`
- `simbroker lease explain --repo-root <repo> --purpose <purpose>`
- `simbroker host status`
- `simbroker lease show --lease-file <lease-file>`
- `simbroker lease contain --lease-file <lease-file> --reason manual-cleanup`
- `simbroker events watch`

Harness behavior rules:

- use `lease explain` when acquire fails and the failure needs a structured explanation
- use `host status` or `events watch` for operator-visible debugging
- treat the lease artifact as the canonical per-run handle for release and inspection
- treat `lease.contained` events and evidence bundles as the source of truth for forced-abort, timeout, stale-owner, or memory-ceiling cleanup
- do not replace broker containment with broad `pkill`, manual simulator shutdown, or host-wide process cleanup

## 6. Environment and configuration guidance

Wrappers may use flags directly or centralize defaults through environment variables.

Useful environment variables:

- `SIMBROKER_HOST_CONFIG`
- `SIMBROKER_STATE_ROOT`
- `SIMBROKER_PROJECT_FILE`

Recommended policy:

- keep machine-local broker host configuration out of committed repo files
- commit only repo-owned purpose policy
- set machine-local broker paths in developer setup, CI secrets, or local wrapper bootstrap

## 7. Purpose mapping guidance

Repos should define stable purpose names that express why a simulator is needed, not which exact alias should be used.

Recommended examples:

- `manual-testing`
- `agent-ui-session`
- `agent-build-test`
- `ci-ui-test`
- `ci-build-test`

Current sample repo coverage:

- `manual-testing`
- `agent-ui-session`
- `agent-build-test`
- `ci-ui-test`

Purpose design rules:

- purpose names should be understandable to humans and agents without additional prompts
- one purpose should correspond to one class of simulator behavior
- if the same workflow needs different device families, define separate purposes rather than teaching the harness to guess
- if a repo wants local unattended automation to stay separate from AI-agent automation, define a dedicated local purpose rather than overloading `manual-testing`

## 8. Guide-first and skill-second rule

The broker should eventually provide a reusable harness-adoption skill, but not before the written guide is stable.

Future optional deliverable:

- `broker-harness-adoption` skill that audits a consumer repo and patches:
  - `.simulator-broker/project.json`
  - `AGENTS.md` or equivalent agent instructions
  - wrapper scripts or task runners
  - CI workflow snippets

That skill must:

- follow this guide exactly
- prefer committed repo changes over one-off prompt advice
- never hardcode host alias names into consumer repos

Current implementation note:

- this repo now includes a guide-aligned `broker-harness-adoption` skill and a sample pattern library, but it should still be treated as a helper rather than a fully autonomous patch engine

## 9. Verification requirements for consumer repos

Every repo adoption should prove four things:

1. The committed project file is valid.
2. The harness can acquire by purpose.
3. The harness can expose the selected simulator metadata to downstream steps.
4. The harness releases on success and failure paths.
5. Build/test wrappers contain detached simulator-like processes on forced-abort or memory-ceiling paths.

Minimum verification commands:

```bash
simbroker project init --repo-root "$PWD"
simbroker project validate --repo-root "$PWD"
simbroker lease explain --repo-root "$PWD" --purpose agent-ui-session
```

Minimum smoke requirement:

- run one repo-local broker-aware wrapper
- capture the lease artifact
- confirm cleanup releases or contains the lease
- when the repo has build/test wrappers, confirm an owned detached process fixture is killed and unrelated process fixtures survive

Recommended stronger smoke for pattern-heavy repos:

- run one manual human wrapper
- run one interactive agent wrapper
- run one unattended automation wrapper
- prove at least one wrapper still releases or contains after a downstream failure and preserves the evidence directory path

## 10. Completion criteria

The harness-awareness phase is complete only when:

- the implementation plan points to this guide as the broker adoption contract
- the spec index lists this guide as canonical
- future broker phases include sample harness adoption and optional skill automation based on this guide

## 11. Document History

| Version | Date | Summary |
| --- | --- | --- |
| 0.4.1 | 2026-08-10 | Clarified that successful acquisition returns a broker-booted simulator. |
| 0.4.0 | 2026-07-20 | Added capacity check and operator-confirmed reconcile guidance for simulator-dependent harness preflights. |
