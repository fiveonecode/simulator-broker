# Agents
Related: `spec/README.md`, `spec/harness-integration.md`, `spec/build-and-test.md`, `spec/project-structure.md`, `WORKFLOW.md`, `.agents/manifests/specs.yaml`, `.agents/manifests/harness-contract.yaml`, `.agents/manifests/agent-harness-runtime.yaml`, `.agents/manifests/broker-runtime.yaml`, `.agents/manifests/implementation-foundation.yaml`, `.agents/verify/implementation.yaml`, `.agents/verify/spec-only.yaml`

## Purpose

This file defines the intended agent workflow for the bootstrap phase of this repo.

## Current routing

- `harness-contract` exclusively owns `WORKFLOW.md`, `.agents/`, agent
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

## macOS app workflow contract

- `script/build_and_run.sh` is the canonical macOS app kill/build/run entrypoint for local work.
- `.codex/environments/environment.toml` must expose a `Run` action that points at `./script/build_and_run.sh`.
- App workflow changes should route through the repo-shipped skills above instead of ad hoc shell chains or undocumented local commands.
- When the app needs desktop-only behavior that SwiftUI cannot express cleanly, document the exact gap first and keep the implementation covered by `swiftui-pro` and `xcode-build`.

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
- For `long-running` sessions, `agent:complete` requires populated `task-plan`, `session-handoff`, and `advisory-evaluation` artifacts.
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
