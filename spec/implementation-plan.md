# Implementation Plan
Related: `spec/README.md`, `spec/global-simulator-broker.md`, `spec/architecture.md`, `spec/harness-integration.md`, `spec/build-and-test.md`, `spec/project-structure.md`

> **Document ID:** `GSB-PLAN-001`
> **Version:** `0.9.0`
> **Last Updated:** `2026-08-10`
> **Status:** `Draft`
> **Owner:** `spec-steward`
> **Implementation owners:** `spec-steward`, `ios-dev`

## 1. Objective and planning decisions

This plan defines how to build Simulator Broker into a machine-local control plane for iOS simulators that works for:

- humans through a macOS app and CLI
- AI agents through stable CLI JSON, deterministic lease artifacts, and observable state
- CI and local automation through repo-owned purpose definitions
- multiple repos on one machine without forcing repo-specific alias names into committed policy

This plan intentionally does not include any single-repo migration work. It focuses on the reusable product and the integration contract that any repo can adopt.

### Planning decisions

- the first supported scope is one macOS user on one machine
- the broker core remains the source of deterministic lease behavior
- the app and CLI are peer clients of the same broker authority; no app-only mutation path is allowed
- durable pins remain active across broker restart and host reboot until they are explicitly cleared
- repos request simulator purposes and capability classes, not machine-local alias names, unless an operator explicitly pins an alias
- repo purpose configs may declare required iOS version and device family constraints when a workflow needs them
- the system supports both ephemeral leases for jobs and durable pins for human-managed reservations
- all state-changing actions for broker-managed aliases must go through the broker authority rather than direct client `simctl` calls
- force-overriding another live holder is a human operator action, not an AI agent action
- drift detection should be strict for identity or destructive-state changes and lightweight for normal operational state changes
- repo integration must be possible with one committed file plus stable CLI commands

### Current implementation status

Implemented now:

- file-backed `broker-core` for host and repo validation, registry state, leases,
  pins, events, deterministic warm reuse, and stale recovery
- `simbroker` CLI with repo-root discovery, JSON payloads, deterministic lease-file emission, event inspection, and pin management
- `brokerd` local authority with same-user Unix-socket transport, service lifecycle commands, and CLI auto-routing when the service is running
- broker-mediated lifecycle controls for `boot`, `shutdown`, `erase`, and `repair`, including human override validation and audit events
- real and fixture-backed `simctl` adapter boundary for host bootstrap, lifecycle execution, reset-on-acquire, and repair rebinding
- registry health and power-state synchronization against `simctl` during broker startup, status refresh, and lifecycle paths
- direct and service-backed broker failures grouped into stable exit-code classes with matching service HTTP status classes
- broker-owned `app-snapshot.json` read model plus `app snapshot` CLI surface
- macOS app with Overview, Simulators, Projects, and Events screens backed by the canonical snapshot artifact
- app launch overrides for alternate broker roots plus direct pane/detail targeting and improved operator-facing overview and empty-state presentation
- app-first onboarding classification for missing CLI, missing host config, stopped service, read-only snapshot, and snapshot-refresh states
- app-driven first-run setup that bootstraps host config and starts `brokerd` through the installed CLI
- repo-next-step guidance in the app when the host is ready but no repo has registered a broker project yet
- app-side broker actions for pin create and clear, lease release, and lifecycle requests over the shared broker authority
- known-project cataloging in broker state so the app can offer repo and purpose-aware pin assignment
- local install flow for the CLI and app bundle through `install_local.sh`
- first-run host bootstrap through `host init --bootstrap-config`
- fresh-repo scaffolding through `project init`
- clean-machine-style install smoke coverage through `test:install-smoke`
- install-smoke cleanup that deletes the real simulators provisioned during bootstrap
- service integration tests covering concurrent clients, restart safety, and NDJSON event streaming
- direct and service-backed lifecycle-control tests covering holder conflicts, override-required flows, and repair audit events
- native XCTest coverage for app read models, pin eligibility, command dispatch, and a local XcodeGen build/test workflow
- automated Node tests plus manual CLI smoke artifacts for the repo-integration path
- broker-aware sample consumer repo artifacts and harness smoke tests under `examples/harness-adoption/`
- initial `broker-harness-adoption` skill scaffold under `.agents/skills/`
- boot-on-acquire plus matching-pin, warm, then shutdown selection using the
  most recently released alias within each tier
- opt-in machine-local idle shutdown, `brokerd` scheduling, count-confirmed
  cleanup, macOS app controls, and tracked-text public-safety verification

Still pending:

- broader happy-path app evidence beyond the current overview, unhealthy-detail, destructive confirmation, and override-required remediation captures

## 2. Scope

### In scope

- a reusable broker core with deterministic lease semantics
- a host-local simulator inventory and policy model
- a repo-owned project integration file for simulator purposes
- a stable CLI for humans, agents, and CI
- a local broker service for state snapshots, mutations, and event streaming
- a macOS app for visibility and later operator actions
- ownership and observability metadata rich enough to explain who holds each simulator and why

### Out of scope

- cross-host or multi-user synchronization
- Android or non-Apple simulator orchestration
- migration plans for any specific consumer repo
- making the app the sole owner of repo policy
- secret distribution, cloud scheduling, or remote fleet management

## 3. Repo-agnostic product model

### Primary actors

| Actor | Needs |
|---|---|
| human operator | inspect every simulator, manually pin/release aliases, repair or reset unhealthy simulators, see current holders |
| AI agent session | acquire by purpose, observe the selected simulator, emit lease artifacts, release deterministically, watch state without parsing UI |
| CI or automation job | non-interactive acquire and release, deterministic wait behavior, structured failure output, no local UI dependency |
| repo maintainer | commit a project policy once, validate it, and keep harness code independent from host alias names |

### Core concepts

| Concept | Meaning |
|---|---|
| host alias | one machine-local simulator entry managed by the broker, such as a manual or automation slot |
| capability class | a host-level promise such as `manual-persistent`, `interactive-resettable`, `automation-resettable`, `build-fast`, or `build-clean` |
| project | a repo-integrated consumer identified by `projectId`, `projectName`, and `repoRoot` |
| purpose | a repo-owned label such as `manual-testing`, `agent-ui-session`, `agent-build-test`, `ci-ui-test`, or `ci-build-test` that maps to one capability class |
| lease | an active exclusive assignment of one alias to one actor and project for a bounded period |
| pin | an operator-managed durable reservation that binds an alias to one project or purpose until cleared |
| event | an immutable record of assignment, release, repair, reset, pin, or health changes used by the app and CLI watch surfaces |

### Success criteria for repo adoption

- a new repo can integrate by adding `.simulator-broker/project.json`, validating it, and calling the CLI
- normal repo automation never needs to commit machine-local alias names
- every active lease explains `projectId`, `purposeId`, `actorType`, `actorId`, and `jobId` when available
- a human can see all simulators and all active holders without opening a consumer repo
- an agent can fully manage its lease lifecycle without scraping app UI or ad hoc files
- the app and CLI can explain why a request was denied, which policy blocked it, and what holder currently owns the alias

## 4. Integration contracts

### 4.1 Host-local inventory contract

The host-local broker installation owns simulator inventory and capability definitions.

Planned canonical path:

- `~/Library/Application Support/SimulatorBroker/host-config.json`

Planned state root:

- `~/Library/Application Support/SimulatorBroker/state/`

The host config defines:

- alias inventory
- display names
- device and runtime preferences
- capability classes
- reset policy defaults
- health status and repair expectations

Illustrative shape:

```json
{
  "version": 1,
  "hostId": "mac-studio-01",
  "aliases": [
    {
      "alias": "manual-1",
      "displayName": "Manual iPhone 16",
      "capabilities": ["manual-persistent"],
      "deviceType": "iPhone 16",
      "platform": "iOS",
      "runtimeStrategy": "latest-stable",
      "resetPolicy": "none"
    },
    {
      "alias": "ui-1",
      "displayName": "Interactive UI 1",
      "capabilities": ["interactive-resettable", "automation-resettable"],
      "deviceType": "iPhone 16",
      "platform": "iOS",
      "runtimeStrategy": "latest-stable",
      "resetPolicy": "erase-on-acquire"
    },
    {
      "alias": "ui-2",
      "displayName": "Interactive UI 2",
      "capabilities": ["interactive-resettable", "automation-resettable"],
      "deviceType": "iPhone 16",
      "platform": "iOS",
      "runtimeStrategy": "latest-stable",
      "resetPolicy": "erase-on-acquire"
    }
  ]
}
```

Current implementation note:

- starter host bootstrap currently provisions `manual-1`, `ui-1`, `ui-2`, `build-1`, `build-2`, and `ipad-1`

### 4.2 Repo project contract

Each repo integrates through one committed project file.

Planned canonical path:

- `.simulator-broker/project.json`

Required behavior:

- the broker CLI can discover this file from `--repo-root`, `--project-file`, or the current working directory
- the repo file declares purposes and the capability class each purpose needs
- the repo file must not require host alias names for normal operation
- the repo file may declare requirements for `deviceFamily` and `iosVersion` only in v1

Requirement semantics:

- requirements filter the candidate aliases before lease ranking begins
- when multiple aliases satisfy the same requirements, the broker filters by
  health and uses its single matching-pin, warm, then shutdown order with most
  recent release first inside a tier
- a requirement mismatch must fail with a structured explanation of the unsatisfied fields and the closest available alternatives
- host inventory remains authoritative; repo requirements narrow selection but do not create aliases or bypass host policy

Allowed `requires` fields in v1:

- `deviceFamily`: enum `iPhone` or `iPad`
- `iosVersion`: string matching `^\d+(\.\d+)?$`

Validation and matching rules:

- fields are ANDed together when both are present
- `iosVersion: "18"` matches any installed iOS `18.x` runtime
- `iosVersion: "18.2"` matches only iOS `18.2`
- device type names such as `iPhone 16` are not allowed in repo config v1
- if no `requires` block is present, selection is driven only by capability,
  health, lease and pin state, power state, and most recent release time

Illustrative shape:

```json
{
  "version": 1,
  "projectId": "simulator-broker-app",
  "projectName": "Simulator Broker App",
  "purposes": [
    {
      "id": "manual-testing",
      "displayName": "Manual Testing",
      "capability": "manual-persistent",
      "defaultActorType": "human"
    },
    {
      "id": "agent-ui-session",
      "displayName": "Agent UI Session",
      "capability": "interactive-resettable",
      "defaultActorType": "agent",
      "requires": {
        "deviceFamily": "iPhone",
        "iosVersion": "18"
      }
    },
    {
      "id": "agent-build-test",
      "displayName": "Agent Build and Test",
      "capability": "build-fast",
      "defaultActorType": "agent"
    },
    {
      "id": "ci-ui-test",
      "displayName": "CI UI Test",
      "capability": "automation-resettable",
      "defaultActorType": "ci"
    }
  ]
}
```

### 4.3 Lease, pin, and event schemas

Every active lease must carry enough context for both the app and CLI.

Required lease fields:

- `leaseId`
- `alias`
- `displayName`
- `simulatorId`
- `projectId`
- `projectName`
- `repoRoot`
- `purposeId`
- `actorType`
- `actorId`
- `jobId`
- `jobKind`
- `leaseKind`
- `pinId` when the lease comes from a durable pin
- `resetPolicy`
- `startedAt`
- `expiresAt`
- `sessionDir`
- `artifactPath`

Required event fields:

- `eventId`
- `timestamp`
- `type`
- `alias`
- `leaseId`
- `projectId`
- `purposeId`
- `actorType`
- `jobId`
- `payload`

### 4.4 CLI contract

The CLI is the primary repo integration surface and must remain stable and machine-readable.

Required command families:

- `simbroker doctor`
- `simbroker host init`
- `simbroker host status`
- `simbroker project validate`
- `simbroker project show`
- `simbroker lease acquire`
- `simbroker lease explain`
- `simbroker lease release`
- `simbroker lease show`
- `simbroker simulators list`
- `simbroker simulators boot`
- `simbroker simulators shutdown`
- `simbroker simulators erase`
- `simbroker simulators repair`
- `simbroker events watch`
- `simbroker pin create`
- `simbroker pin clear`
- `simbroker idle status`
- `simbroker idle enable`
- `simbroker idle disable`
- `simbroker idle reconcile`
- `simbroker idle cleanup`

Required CLI properties:

- every mutating and status command supports `--json`
- `lease acquire` supports `--repo-root`, `--project-file`, `--purpose`, `--actor-type`, `--actor-id`, `--job-id`, `--job-kind`, `--session-dir`, and `--lease-file`
- successful `lease acquire` returns only after the selected simulator is booted
- `events watch` supports a streaming machine-readable mode such as JSON lines
- denial payloads and validation failures must include a stable reason code, current holder details when relevant, and suggested next actions
- every CLI error payload includes `reasonCode` and `exitCode`
- exit code `2` means invalid request or setup failure
- exit code `3` means unavailable capacity or transient broker-side unavailability
- exit code `4` means repair-needed or unhealthy-alias failure
- exit code `5` means override-required or human-override-required failure
- exit code `1` means internal failure or an unclassified unexpected error

Required service error properties:

- error JSON payloads mirror CLI failure payloads and include the same `reasonCode` and `exitCode`
- service HTTP status `400` is used for invalid request or setup failures
- service HTTP status `404` is used for unknown routes
- service HTTP status `409` is used for unavailable capacity, transient broker unavailability, and holder conflicts
- service HTTP status `412` is used for override-required and human-override-required failures
- service HTTP status `423` is used for repair-needed alias failures
- service HTTP status `500` is used for internal failures

### 4.5 App contract

The macOS app is a first-class operator surface, not a special execution path.

Required app views:

- simulator inventory
- active leases
- pins
- projects
- recent event feed

Required app actions by the end-state:

- create and clear pins
- release active leases
- boot, shutdown, erase, or repair simulators subject to confirmation and policy
- configure or disable Automatic shutdown and run count-confirmed idle cleanup
- filter by project, purpose, actor type, and health

### 4.6 Broker-mediated lifecycle control

The broker is the control plane for broker-managed aliases, not just the allocator.

Required rules:

- app, CLI, agents, and repo harnesses must request boot, shutdown, erase, repair, pin, release, and lease actions through the broker authority
- direct `simctl` mutation by clients is unsupported for broker-managed aliases and must be treated as external drift when detected
- the current lease holder may request non-destructive actions on its own alias
- destructive actions on an unleased alias may proceed under normal policy
- destructive actions on an alias held by another live actor must be denied by default with structured conflict details
- a human operator may force an override only by supplying an explicit override flag, a reason, and a target confirmation to the broker
- a forced override must emit an audit event and revoke the conflicting lease before the destructive action begins
- AI agents may request repair, but they must not force-override another live holder; the broker may allow, queue, deny, or return `human-override-required`
- the broker must expose enough state for operators to understand what it is doing instead of acting as a black box

Required human force-override confirmation fields:

- `forceOverride: true`
- `overrideReason`: non-empty human-entered string
- `expectedAlias`: alias the human inspected
- `expectedLeaseId`: active conflicting lease the human intends to break

Override validation rules:

- the broker must reject the override if `expectedAlias` no longer matches the target alias
- the broker must reject the override if `expectedLeaseId` is no longer the active conflicting lease
- a fresh status refresh is required before retrying any rejected override
- AI agents may never send `forceOverride: true`

Transparency requirements:

- every mutation emits an event with actor identity, action, target alias, and outcome
- status and explain surfaces show holder, policy constraints, last reset or repair, and current health
- drift detection must use the explicit health states `healthy`, `state-drift`, `repair-needed`, and `repairing`
- out-of-band boot or shutdown state changes may be recorded as non-blocking drift when alias identity is still intact
- out-of-band destructive or identity-changing mutations, including delete, recreate, erase during conflict, or alias-to-device mismatch, must block new leases until repaired

Drift-state transition rules:

- `healthy` -> `state-drift` when the broker observes out-of-band boot or shutdown with the expected alias-to-simulator identity still intact
- `state-drift` -> `healthy` when a later broker observation or broker-mediated action sees the alias back in an acceptable non-destructive state
- `healthy` -> `repair-needed` when the broker observes alias identity loss, simulator deletion, alias-to-device mismatch, runtime mismatch against host config, or out-of-band destructive mutation during conflict
- `state-drift` -> `repair-needed` when any blocking drift condition is later observed
- `repair-needed` -> `repairing` when the broker starts a repair action
- `repairing` -> `healthy` when repair succeeds and identity plus policy checks pass
- `repairing` -> `repair-needed` when repair fails or post-repair validation fails

Lease-blocking rules:

- `healthy` and `state-drift` aliases may receive new leases when other lease rules allow it
- `repair-needed` and `repairing` aliases must not receive new leases

### 4.7 Harness-awareness contract

The broker is not adopted until the consumer repo's harness, agent instructions, and CI flows become broker-aware.

Canonical source of truth:

- `spec/harness-integration.md`

Required rules:

- every consumer repo must integrate through a committed `.simulator-broker/project.json`
- every consumer repo must expose at least one broker-aware wrapper or task-runner entrypoint for simulator work
- agent instructions must teach agents to acquire by purpose, inspect broker state through CLI surfaces, and avoid direct `simctl` mutation on broker-managed aliases
- CI and automation must acquire and release through the broker with explicit actor and job metadata
- any future reusable adoption skill must follow the harness integration guide instead of defining a second contract

## 5. Implementation map

| Surface | Role in the plan |
|---|---|
| `spec/` | source of truth for contracts, implementation order, and verification gates |
| `broker-core/` | deterministic state model, warm-reuse ordering, liveness, reset/boot coordination, idle reconciliation, schema validation, event generation |
| `client/` | CLI surface, repo integration helpers, stable JSON contract, local service client, and the first broker service target |
| `app/` | macOS visibility and operator actions built on the same broker authority |
| `examples/harness-adoption/` | public consumer-repo fixture for broker-aware harness integration |

## 6. Phase plan

### Phase 1 — Contracts and `broker-core`

Status:

- partially implemented

Goal:

- implement the reusable domain model and deterministic engine without any repo-specific behavior

Deliverables:

- schema validation for host config, repo project config, lease records, pins, and events
- file-backed registry, lease store, event log, and lock model under the new `SimulatorBroker` state root
- deterministic capability-to-alias selection and stale-lease recovery
- reset coordination that preserves the current serialized-reset guarantee for resettable aliases
- unit-testable `simctl` adapter boundary

Verification:

- schema fixture tests for valid and invalid host and repo configs
- unit tests for ranking, stale recovery, pin precedence, and reset coordination
- integration tests for file-backed reserve and release flows with fake `simctl`

Exit criteria:

- `broker-core` can acquire and release leases for purposes defined by repo configs
- events and lease artifacts contain the required ownership metadata

### Phase 2 — CLI and repo integration path

Status:

- partially implemented

Goal:

- make any repo able to adopt the broker through a committed project file and shell-safe CLI calls

Deliverables:

- installable `simbroker` CLI
- repo discovery and validation for `.simulator-broker/project.json`
- `lease acquire`, `lease explain`, `lease release`, `lease show`, `simulators list`, and `events watch` commands with stable JSON
- helper output modes for harnesses, including deterministic lease file emission
- structured mismatch and denial reporting for purpose constraints, holder conflicts, and repair-needed states
- canonical harness integration guide for shell-based harnesses, AI agent sessions, and CI runners
- sample fixture repos proving that shell-based harnesses and agent sessions can integrate without alias-specific logic

Verification:

- CLI snapshot tests for JSON payloads and exit codes
- fixture-repo end-to-end tests that acquire and release by purpose
- multi-process tests where parallel agent and CI requests share one machine-local broker state
- guide-driven harness adoption checks proving a repo can become broker-aware without hidden local steps

Exit criteria:

- a sample repo can request `manual-testing`, `agent-ui-session`, and `ci-ui-test` purposes without committing host alias names
- an AI agent can observe lease state through CLI only
- a repo maintainer can follow the harness integration guide and make a consumer repo broker-aware without relying on one-off prompt instructions

### Phase 3 — Local broker service and observability

Status:

- partially implemented

Goal:

- introduce one local authority for app and CLI clients while preserving CLI-first adoption

Deliverables:

- `brokerd` service target backed by `broker-core`
- same-user local API for snapshots, mutations, and subscriptions
- durable event stream and state snapshot surfaces
- CLI client mode that talks to the local service when available
- broker lifecycle management, restart safety, and event replay for the app
- shared command execution path so direct and service-backed CLI flows stay contract-compatible

Verification:

- service integration tests covering concurrent clients
- restart and crash-recovery tests proving leases and pins survive service restarts correctly
- watch-stream tests proving the app and CLI observe the same event order
- drift-detection tests proving non-blocking state drift stays observable and blocking drift prevents new leases

Exit criteria:

- the app and CLI use `brokerd` whenever the local service is available and fall back to direct mode only when the daemon is absent
- the broker service can serve simultaneous human and automation clients deterministically
- service lifecycle is observable through `simbroker service start|status|stop`

Remaining work inside Phase 3:

- add richer snapshot or subscription surfaces aimed at the future app instead of only the shared CLI command contract

### Phase 4 — macOS app read-only visibility

Status:

- implemented

Goal:

- ship a useful app for operators before enabling high-risk mutation controls

Deliverables:

- overview screen with host health, lease counts, and pool saturation
- simulator list with alias, runtime, health, project, purpose, and actor information
- lease detail view with project, job, session, and artifact metadata
- project list and event feed
- refresh and filtering flows backed by the broker-owned snapshot artifact under the local broker state root

Verification:

- SwiftUI unit tests for the read models
- UI smoke tests against a seeded local broker service
- screenshot acceptance evidence for key screens and empty, busy, and repair-needed states

Exit criteria:

- a human can identify which repo, purpose, and actor currently owns every simulator from the app alone

Current implementation slice:

- `app/project.yml` generated with XcodeGen for a macOS SwiftUI app plus XCTest target
- `brokerd` and the CLI keep a canonical `app-snapshot.json` artifact current in broker state
- the app polls `app-snapshot.json` and `brokerd.json` for Overview, Simulators, Projects, and Events
- screenshot evidence covers busy overview, repair-needed simulator detail, project summary, event feed, and empty-state onboarding

### Phase 5 — Operator actions and explicit assignment

Status:

- implemented for the broker authority, CLI, and macOS app operator surface

Goal:

- let humans and scripts actively steer simulator ownership instead of only observing it

Deliverables:

- CLI and app support for creating and clearing pins
- lease release actions from app and CLI
- broker-mediated actions for boot, shutdown, erase, and repair with audit events and explicit override handling
- conflict handling and confirmations for destructive actions
- clear separation between durable pins and ephemeral job leases

Verification:

- integration tests for pin precedence, release safety, and destructive action confirmations
- UI tests for pin creation, release flows, and unhealthy simulator remediation
- event-log assertions that every mutation is auditable

Exit criteria:

- a human can intentionally assign a simulator to a repo or purpose
- scripts can request either an automatic lease or a pinned alias through stable commands

Current implementation slice:

- `simbroker simulators boot|shutdown|erase|repair` in direct and service-backed CLI mode
- current-holder validation for non-destructive actions on leased aliases
- destructive-action denial for conflicting leases unless a human supplies `forceOverride`, `overrideReason`, `expectedAlias`, and `expectedLeaseId`
- `lease.revoked`, `simulator.booted`, `simulator.shutdown`, `simulator.erased`, `simulator.repair.started`, and `simulator.repaired` events
- lifecycle-aware alias snapshots including `powerState`, `lastBootedAt`, `lastShutdownAt`, `lastErasedAt`, and `lastRepairedAt`
- app-side create-pin, clear-pin, lease-release, and lifecycle controls routed through the same `brokerd` authority used by the CLI
- app-side override-required handling that re-prompts the human for a reason before retrying destructive repair
- known-project snapshot metadata so the app can offer valid project and purpose choices for pin assignment without repo-local hardcoding

Remaining work inside Phase 5:

### Phase 6 — Packaging, onboarding, and adoption kit

Status:

- implemented through the current local install and bootstrap flow

Goal:

- make the product easy to install on a new machine and easy to adopt in a new repo

Deliverables:

- app bundle and CLI install flow for a clean macOS machine
- first-run host setup flow in app or CLI
- `simbroker project init` scaffolding for new repos
- reference integration snippets for shell-based harnesses, AI agent sessions, and CI runners
- optional reusable broker-harness-adoption skill that patches consumer repos according to `spec/harness-integration.md`
- operational docs for host setup, repair, and troubleshooting

Verification:

- clean-machine smoke test for install, host init, sample repo setup, lease acquire, and app visibility
- docs walkthrough test where another engineer can onboard a repo using only the published instructions

Exit criteria:

- a new machine can install the product and run a sample repo without manual hidden steps
- repo adoption requires one project file and standard CLI commands

Current implementation slice:

- `scripts/install_local.sh` builds the macOS app, stages a payload, and installs through a generic distribution installer
- `scripts/package_local.sh` produces a portable zip bundle with a bundled `install.sh` that has no repo-root assumptions at install time
- `scripts/install_distribution.sh` performs the shared payload install logic used by both repo-local and packaged installs
- `scripts/install_smoke.sh` verifies both repo-local and packaged install paths, host bootstrap, repo scaffolding, service start, lease acquire, app snapshot generation from the installed CLI, and cleanup of provisioned simulators
- `scripts/package_smoke.sh` packages the product and then runs the bundled install path through the full smoke flow
- `simbroker host init --bootstrap-config` writes a starter host config when a machine-local config does not exist yet
- `simbroker project init` scaffolds `.simulator-broker/project.json` for a fresh consumer repo
- the sample harness adoption kit now covers manual human, interactive agent, unattended agent build-test, and CI patterns, and the broker-harness-adoption skill/checklist follow the same guide

Lower-priority roadmap after this phase:

1. Extend app screenshot evidence to lower-risk happy-path operator mutations.
2. Add operational host setup and troubleshooting docs that assume the packaged distribution path exists.
3. Continue improving the broker-harness-adoption helper from guide-aligned reference material toward more mechanical repo audits and patch suggestions.

### Phase 7 — Real simulator execution and drift repair

Status:

- implemented

Goal:

- replace placeholder simulator assumptions with a real broker-owned `simctl` execution boundary that works in tests, on local machines, and through installed CLI flows

Deliverables:

- a shared `simctl` adapter boundary with real-machine and fixture-backed implementations
- host bootstrap that provisions real simulator devices and records their actual IDs plus runtime versions
- broker-state synchronization against `simctl` so missing, unavailable, or mismatched aliases become `repair-needed`
- dedicated reset-lock coordination for `erase-on-acquire`
- repair flows that can recreate and rebind a missing simulator without bypassing broker policy
- install-smoke cleanup that deletes the simulators it provisioned

Verification:

- `broker-core` tests for bootstrap provisioning, reset rollback, lifecycle updates, and repair rebinding
- `client` and `brokerd` tests against the fixture-backed `simctl` adapter
- real-machine install smoke proving the installed CLI can bootstrap, lease, snapshot, and clean up

Exit criteria:

- no broker-managed bootstrap or lifecycle path relies on fake simulator IDs
- reset-on-acquire failures cannot leak a live lease
- a missing broker-managed simulator is observable as `repair-needed` and recoverable through broker-managed repair
- installed onboarding flows leave no provisioned simulators behind after smoke verification

Current implementation slice:

- `broker-core/simctl.mjs` provides both the system-backed `xcrun simctl` implementation and a JSON-fixture adapter for tests
- `host init --bootstrap-config` provisions starter aliases as real simulator devices and persists their real IDs
- `loadBrokerState` synchronizes registry health and power state from `simctl` before broker responses are returned
- `acquireLeaseBroker` serializes `erase-on-acquire` behind a reset lock and rolls back the lease when reset fails
- `repairSimulatorBroker` can recreate a missing alias device and rewrite host config to the new simulator ID

### Phase 8 — CLI and service failure contract

Status:

- implemented

Goal:

- make broker failures machine-readable and stable enough for harnesses, CI, and service clients to branch on specific failure classes without scraping text

Deliverables:

- a shared reason-code to exit-code mapping used by direct CLI mode and service-backed CLI mode
- service JSON error payloads that carry the same `exitCode` contract as CLI errors
- service HTTP status classes aligned with the same broker failure groups
- direct and service-backed tests for invalid request, unavailable capacity, repair-needed, and override-required cases
- roadmap and contract docs that publish the exact failure-code table

Verification:

- `broker-core` tests for error-contract mapping helpers and `BrokerError` payloads
- `client` tests for direct CLI exit codes
- `brokerd` tests for service-backed CLI parity and raw service HTTP status classes

Exit criteria:

- harnesses can branch on `exitCode` without parsing human-readable error strings
- the same broker failure category produces the same non-zero exit code in direct CLI mode and service-backed CLI mode
- raw service consumers can rely on stable HTTP status classes plus the JSON `exitCode`

Current implementation slice:

- `broker-core/error-contract.mjs` owns the exit-code and HTTP-status mapping
- `BrokerError` now resolves and persists `exitCode` into every error payload
- `client/bin/simbroker.mjs` emits `reasonCode` and `exitCode` for both broker errors and unexpected internal failures
- `client/service/brokerd.mjs` maps broker failures into stable HTTP status classes instead of flattening all broker errors to `400`
- `client/test/simbroker.test.mjs` and `client/test/brokerd.test.mjs` now assert the published failure contract

### Phase 9 — Public-safe on-demand simulator lifecycle

Status:

- implemented

Goal:

- retain all registered aliases as normally shutdown standby capacity while
  making low-concurrency work reuse only the warm simulator capacity it needs

Deliverables:

- one deterministic selection order with no legacy rotation path
- boot-on-acquire and repair-needed rollback on boot failure
- absent-by-default state-root idle policy with an explicit human duration
- immediate and 30-second `brokerd` reconciliation plus lazy service start
- public CLI/API and macOS Overview controls for status, policy, and confirmed cleanup
- snapshot/event summaries that do not disclose local simulator identifiers
- `verify:public-surface` in the normal test and release gate

Verification:

- core tests for warm reuse, concurrency, eligibility exclusions, stale recovery,
  lock races, boundary timing, shutdown failure, and confirmed cleanup
- direct/service client tests for parser parity, lazy daemon behavior, service
  restart, scheduler execution, privacy, and snapshot updates
- macOS tests for explicit duration, apply/disable, preview confirmation, cleanup,
  and refresh behavior
- public-surface scanner tests using temporary roots and synthetic values

Exit criteria:

- sequential demand reuses one warm alias per compatible workload while
  concurrent demand can use additional retained standby aliases
- automated aliases shut down only after an operator-configured grace period
- pins, live leases, manual aliases, unhealthy aliases, and external devices are untouched
- no local duration, identity, alias, simulator ID, or state root ships in public source

## 7. Cross-cutting verification strategy

Each implementation phase must add or strengthen deterministic verification profiles.

Required verification categories:

- schema and contract validation
- `broker-core` unit and concurrency tests
- CLI JSON contract snapshots
- multi-process integration tests across sample repos
- app runtime and screenshot evidence
- clean-machine install and onboarding smoke tests
- public-surface text scanning and temporary-root fixture enforcement

Expected profile growth beyond `spec-only`:

- `broker-core`
- `cli-contract`
- `service-contract`
- `repo-integration`
- `app-ui`
- `install-smoke`

## 8. Resolved defaults

- repo project selection uses `requires` only in v1; there is no `prefers` field
- v1 `requires` supports only `deviceFamily` and `iosVersion`
- a human operator may force-override a conflicting live lease for urgent repair only with `forceOverride`, `overrideReason`, `expectedAlias`, and `expectedLeaseId`
- AI agents may request repair but may not force-override another live holder
- drift detection is moderate: validate on broker startup, lease boundaries, broker-mediated actions, and normal status refreshes rather than continuous heavy polling
- only `repair-needed` and `repairing` block new leases; `state-drift` remains observable but non-blocking
- lease selection has one order only: matching pin, compatible booted alias,
  compatible shutdown alias, with most recently released first inside each tier
- acquisition returns only after the selected simulator is booted
- idle policy is absent by default and has no migration or legacy-selection mode
- there are no remaining product-level open questions in this plan
