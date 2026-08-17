# Spec Index
Related: `spec/architecture.md`, `spec/global-simulator-broker.md`, `spec/implementation-plan.md`, `spec/harness-integration.md`, `spec/build-and-test.md`, `spec/project-structure.md`, `spec/agents.md`, `spec/tasks/README.md`, `references/README.md`

## Purpose

This repo exists to develop a reusable local simulator broker:

- reusable across repos on one machine
- visible through a macOS app UI
- compatible with agent sessions and automations
- grounded in deterministic broker behavior captured in the active specs and tests

## Canonical docs

| Path | Purpose |
|---|---|
| `spec/global-simulator-broker.md` | Core system spec and seeded behavior contract |
| `spec/architecture.md` | Component boundaries and extraction direction |
| `spec/implementation-plan.md` | Concrete phase plan, repo integration contract, and verification growth path |
| `spec/harness-integration.md` | Canonical guide for making consumer repos and agentic harnesses broker-aware |
| `spec/build-and-test.md` | Current setup and verification commands |
| `spec/project-structure.md` | Folder contract for this seed repo |
| `spec/agents.md` | Agent workflow and skill routing rules |
| `spec/tasks/README.md` | Worker-ready cross-layer and macOS audit implementation tasks |
| `spec/tasks/public-safe-on-demand-simulator-lifecycle.md` | Cross-layer contract for deterministic warm reuse and public-safe idle shutdown |
| `references/README.md` | Public-safe reference and example policy |

## Current project status

- repo bootstrapped
- agent harness copied and wired
- Codex instructions initialized
- useful skills copied into `.agents/skills/`
- product-specific seed material removed from the public source tree
- reusable implementation plan drafted in `spec/implementation-plan.md`
- file-backed `broker-core` first slice implemented in `broker-core/`
- CLI first slice implemented in `client/bin/simbroker.mjs`
- local `brokerd` authority implemented in `client/bin/brokerd.mjs` and `client/service/`
- CLI automatically routes through the local service when it is running
- broker-mediated lifecycle controls for `simulators boot|shutdown|erase|repair` are implemented in direct and service-backed CLI flows
- the broker now provisions and repairs real simulator devices through a shared `simctl` adapter boundary in `broker-core/simctl.mjs`
- broker state now synchronizes alias health and power state from `simctl` during bootstrap, status refresh, doctor, and lifecycle flows
- direct and service-backed broker failures now expose stable exit codes and service HTTP status classes
- automated Node tests cover broker-core and CLI repo-integration behavior
- automated Node tests cover service lifecycle, concurrent clients, restart safety, NDJSON event streaming, and lifecycle-control override flows
- macOS operator app implementation lives under `app/` and is backed by the broker-owned `app-snapshot.json` artifact plus brokerd command transport
- app-side broker actions now cover pin create and clear, lease release, and lifecycle controls with override-required handling
- the macOS app now exposes a native command surface with pane-switching shortcuts plus focused-window broker actions from the menu bar
- the app now supports explicit `--state-root`, `--host-config`, and optional `--cli-path` launch overrides plus direct pane/detail targeting for deterministic fixture, smoke, and operator review runs, and the high-risk operator flows now have screenshot evidence
- the app now classifies first-run setup state, can bootstrap host config plus start `brokerd` through the installed CLI, and shows repo onboarding guidance when the machine is ready but no repo has registered yet
- the macOS app now emits unified `Logger` telemetry for app lifecycle, refresh, setup, and broker command action boundaries, and `./script/build_and_run.sh --telemetry` surfaces those events for local triage
- app unit tests and the local XcodeGen-driven build/test flow now support build-only reruns, focused `-only-testing` filters, and stable `xcresult` output for runtime triage
- local install, local-debug portable packaging, Release distribution packaging, and onboarding flows now exist through `install_local.sh`, `package_local.sh`, `package_distribution.sh`, `test:install-smoke`, `test:package-smoke`, `host init --bootstrap-config`, and `project init`
- the published onboarding docs now distinguish repo-local contributor install, local-debug portable bundling, and signed distribution packaging, and they explicitly require sourcing the installed env helper before repo onboarding commands are used
- broker-aware sample consumer repo artifacts now cover manual human, interactive agent, unattended agent build-and-test, and CI patterns under `examples/harness-adoption/`
- broker-aware build/test leases now support downstream process registration, memory ceiling containment, evidence bundles, and forced-abort cleanup for detached simulator-like processes
- broker capacity commands now support public-safe `capacity check`,
  non-mutating deterministic `capacity reconcile` preview, and
  human-confirmed additive apply with local transaction evidence, rollback, and
  recovery
- guide-aligned `broker-harness-adoption` skill artifacts live under `.agents/skills/broker-harness-adoption/`
- repo-owned Symphony execution is governed by `WORKFLOW.md`, which uses
  `scripts/validate.sh` as the canonical full-repository validation entry point
- implementation paths now require the `implementation` verification profile,
  while specs and harness contracts also require `spec-only`
- lease acquisition now boots the selected simulator and deterministic selection
  prefers a matching pin, then warm compatible capacity, then shutdown capacity,
  with most-recent release reuse inside each tier
- optional machine-local idle policy, scheduled reconciliation, confirmed cleanup,
  app controls, and the `verify:public-surface` gate are implemented without a
  shipped duration preference

## Lower-priority roadmap

1. Expand the sample harness repo into additional consumer patterns and keep the adoption skill aligned with `spec/harness-integration.md`. Status: implemented.
2. Extend app screenshot coverage to lower-risk happy-path mutations such as create-pin and release-lease flows. Status: next.

## macOS app remediation tasks

The April 11, 2026 worker-ready task set for the macOS app audit lives under `spec/tasks/`.
All nine remediation tasks in that set are now implemented; keep the task specs as completion/history records and implementation contracts for future follow-up work.
