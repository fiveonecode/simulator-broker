# Agents
Related: `spec/README.md`, `spec/harness-integration.md`, `spec/build-and-test.md`, `spec/project-structure.md`, `WORKFLOW.md`, `autopilot.yml`, `.agents/manifests/specs.yaml`, `.agents/manifests/harness-contract.yaml`, `.agents/manifests/agent-harness-runtime.yaml`, `.agents/manifests/broker-runtime.yaml`, `.agents/manifests/implementation-foundation.yaml`, `.agents/verify/implementation.yaml`, `.agents/verify/spec-only.yaml`

## Purpose

This file defines the intended agent workflow for the bootstrap phase of this repo.

`CONTRIBUTING.md` publishes two tracks. Public patches use Node.js 20 and the
Node test suites (`test:broker-core`, `test:client`, `test:harness-adoption`,
or `npm test`) and do not require `agent:context` or a task session directory.
Maintainers and agent runs still use `agent:context` / `agent:verify` /
`agent:complete`. Harness enforcement in this repository is unchanged.

## Current routing

- `harness-contract` exclusively owns `WORKFLOW.md`, `autopilot.yml`, `.agents/`, agent
  instructions, the canonical validator, and harness setup files
- `agent-harness-runtime` exclusively owns executable `agent-harness/` source,
  tests, and package metadata, so harness code changes run executable checks
- `specs` owns product specs, public reference docs, examples, and README
- `broker-runtime` exclusively owns `broker-core/` and `client/`, so CLI and
  broker tasks do not inherit unrelated macOS UI skill requirements
- `implementation-foundation` owns `app/` plus app build, packaging, and install
  scripts

## Required skills

- `spec-creation-updating` for specs, manifests, and verification contracts
- `apple-doc-research` for Apple frameworks and SDK guidance
- `swiftui-pro` for SwiftUI code and structure
- `swift-concurrency-pro` for concurrency-sensitive code
- `harness-engineering` for harness evolution
- `screenshot-analyze-verification` when screenshot evidence is used
- `xcode-build` for the macOS app build, launch, Run action, focused test reruns, and local debug loop
- `swiftui-pro` for macOS scene structure, sidebars, commands, settings, keyboard-first desktop affordances, view refactors, window chrome, and modern materials
- `swift-concurrency-pro` for async service calls, task cancellation, actors, and cross-thread correctness
- `apple-doc-research` when Apple framework, signing, packaging, notarization, or platform guidance is needed

Shared names supplied by the managed-global baseline are not committed under
project skill roots. Project-local skills remain source-owned in this repository.

## Complex-system failure discipline
Related: `AGENTS.md`, `CLAUDE.md`, `agent-harness/src/lib/task-session.ts`, `agent-harness/tests/config.test.ts`, `agent-harness/tests/completion.test.ts`

Reliability, safety, incident, and recovery work follows the learning model in
[How Complex Systems Fail](https://how.complexsystems.fail). This is a focused
analysis and evidence contract, not a requirement to add layers or redesign a
working subsystem.

| ID | Requirement | Verifier |
|----|-------------|----------|
| SB-AG-CS-001 | Analysis must model failure as interacting conditions, including latent faults and degraded operation, rather than stop at one root cause or blame an operator. | Shared-instruction contract test in `agent-harness/tests/config.test.ts`; review evidence |
| SB-AG-CS-002 | Verification must examine relevant defense combinations, near misses, and recovery paths in addition to nominal success. | Routed verification plan and review evidence |
| SB-AG-CS-003 | Long-running plans and handoffs must explicitly document risk and residual risk, including the conditions under which it remains. | `agent:complete`; positive and negative completion tests in `agent-harness/tests/completion.test.ts` |
| SB-AG-CS-004 | Every safety change must be treated as a possible new coupling and failure mode. Add a safeguard only for a recurring or high-consequence risk and only when it reduces net coupling and operational complexity. | Shared-instruction contract test; review evidence |

For a `long-running` session, `task-plan.json` `risks` and
`session-handoff.json` `openRisks` each contain at least one explicit entry. If
no risk is known, the entry says so and records the evidence basis; an empty
list is not evidence. The completion gate checks presence deterministically,
while review checks the substance. This keeps the mechanism small and avoids a
fragile semantic verifier.

## macOS app workflow contract

- `script/build_and_run.sh` is the canonical macOS app kill/build/run entrypoint for local work.
- `.codex/environments/environment.toml` must expose a `Run` action that points at `./script/build_and_run.sh`.
- Codex harness actions in `.codex/environments/environment.toml`, including `verify-specs`, must pass `--session-dir` under `${AGENT_HOME:-$HOME/.agents}/agent-harness/simulator-broker/`. The product slug is `simulator-broker`; it is not derived from `package.json` name `simulator-broker-app`.
- App workflow changes should route through the resolved skills above instead of ad hoc shell chains or undocumented local commands.
- When the app needs desktop-only behavior that SwiftUI cannot express cleanly, document the exact gap first and keep the implementation covered by `swiftui-pro` and `xcode-build`.

## Autopilot origin contract
Related: `autopilot.yml`, `WORKFLOW.md`, `spec/build-and-test.md`, `spec/project-structure.md`, `.agents/manifests/harness-contract.yaml`

Codex Autopilot loads target verification only from repository-root `autopilot.yml` on the origin default branch. It does not read `.agents` or `WORKFLOW.md` as the Autopilot gate. Local Symphony/agent runs still use `WORKFLOW.md` `validation.command` (`./scripts/validate.sh`) and `.agents`.

In scope: origin Autopilot verification command, protected verifier paths, and `harness-contract` ownership of `autopilot.yml`. Out of scope: replacing `agent:complete`, GitHub CI, or `scripts/validate.sh`; authorizing Autopilot-labeled product PR merges.

- `version` is integer `1`, not float `1.0`.
- `verify.command` is `npm test`.
- `contract.protectedPaths` includes `autopilot.yml`, `.agents/**`, `WORKFLOW.md`, `package.json`, and `package-lock.json`.
- The `harness-contract` manifest is the single primary owner of `autopilot.yml`.
- `autopilot.yaml` is invalid. Do not add a sibling alias.

| ID | Requirement | Verifier |
|----|-------------|----------|
| SB-AP-001 | Origin default branch contains regular-file `autopilot.yml` | Autopilot origin inspect `ready_on_origin`; `verify:spec-only` |
| SB-AP-002 | `verify.command` is `npm test` | `autopilot.yml` contents; `verify:spec-only` |
| SB-AP-003 | Worker edits under `.agents/**` and `WORKFLOW.md` are Autopilot protected paths | `autopilot.yml` `protectedPaths` |
| SB-AP-004 | `autopilot.yml` has exactly one primary manifest (`harness-contract`) | `npm run agent:preflight -- --paths-file` / config-contract |

Missing origin `autopilot.yml` → Autopilot `waiting_external_prereq` / `external_prereq.missing`. Uncovered or overlapping `autopilot.yml` → spec-only / config-contract fail.

## Verification model

Use `npm run agent:verify -- --profile <profile-id> --paths <files> --session-dir <dir>` for deterministic checks.

### Live harness profiles

<!-- agent-harness-profiles:start -->
- `implementation` — proof `code`
- `spec-only` — proof `contract`
<!-- agent-harness-profiles:end -->

### Live eval suites

<!-- agent-harness-suites:start -->

<!-- agent-harness-suites:end -->

- `implementation` runs the complete `npm test` suite and the
  `agent-harness` TypeScript build plus Vitest suite for any app,
  broker-core, client, executable harness, or implementation-support change.
- `spec-only` checks spec and harness contract integrity. A task that changes
  implementation plus specs, manifests, or harness contracts must pass both
  selected profiles.
- `./scripts/validate.sh` is the one repo-level validation command used by
  `WORKFLOW.md`; it runs the complete test suite and the repository diff check.

Operational rules:

- `agent:context` writes the task contract and surfaces any blocking verification obligations.
- `agent:complete -- --session-dir <dir>` is the close-out gate; it fails unless required profiles passed and every blocking obligation is satisfied or the session is explicitly reported blocked.
- `agent:complete` also enforces a clean close-out: no new uncommitted task changes, no malformed task commit messages, no changed paths outside the selected manifest path constraints, and no leftover untracked junk outside allowlisted local artifact paths.
- `agent:verify` records the task-tree fingerprint for the declared paths, and `agent:complete` rejects required verification proof when the fingerprint is missing or those paths changed after the passing run.
- `agent:complete` evaluates forbidden path constraints per selected manifest, so a path forbidden by any selected manifest fails close-out even when another selected manifest allows it.
- For `long-running` sessions, `agent:complete` requires populated `task-plan`, `session-handoff`, and `advisory-evaluation` artifacts, including explicit plan risk and handoff residual-risk entries.
- Every meaningful task commit must use a structured git message with `Why:`, `Changed:`, `Verification:`, `Affected:`, `Refs:`, and `Session:` sections. Commit messages are durable public output: use repo-relative paths, GitHub URLs, commit SHAs, and public task artifact labels such as `task-sessions/<session-name>`; never include machine-local or parent-relative paths. `agent:complete` rejects detected local-path forms in every new commit touching task paths.
- Normal Symphony runs must use the repo-owned `WORKFLOW.md`, may not edit its
  protected validation paths from an ordinary implementation task, and stop at
  validated local handoff unless a human explicitly requests PR handoff.

Generated verification profile index:

<!-- agent-harness-profiles:start -->
- `implementation` — proof `code`
- `spec-only` — proof `contract`
<!-- agent-harness-profiles:end -->

Generated eval suite index:

<!-- agent-harness-suites:start -->

<!-- agent-harness-suites:end -->

## Runaway build/test lease triage

When a broker-managed build/test lease leaks memory, stalls, or leaves a detached simulator test host behind, agents must diagnose through broker-owned surfaces first:

- inspect `simbroker lease show --lease-file <path>` or `--lease-id <id>` for runtime owner and downstream process metadata
- inspect `simbroker events watch --type lease.contained` for containment reason, evidence path, killed PIDs, skipped lease-adjacent PIDs, and RSS summary
- inspect the evidence bundle before making claims about whether cleanup was owned by the broker or by a consumer app
- use `simbroker lease contain --lease-file <path> --reason manual-cleanup` only for the active lease being investigated
- do not kill unrelated simulator, manual-testing, UI-session, or other-lease processes outside the broker containment contract
- if a wrapper only released a lease file and no containment evidence exists for a runaway process, treat that as an incomplete broker-managed cleanup proof

## Public Context Rule

When implementation work depends on behavior learned from a private product or
local operator context:

- extract the generic behavior into `spec/` before implementation
- use public-safe examples under `examples/` for committed fixtures
- do not commit private source snapshots, local machine paths, credentials, or
  company-only task context
- record intentional deviations from prior behavior in the active specs

## External harness adoption rule

When defining how consumer repos, AI agents, or CI should become broker-aware:

- codify the contract first in `spec/harness-integration.md`
- use `harness-engineering` when the change affects harness conventions, agent instructions, or automation wiring
- use `broker-harness-adoption` when the task is to patch a consumer repo to follow the guide
- treat any future reusable adoption skill as an implementation of the guide, not a replacement for it
