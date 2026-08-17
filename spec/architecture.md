# Architecture Overview
Related: `spec/README.md`, `spec/global-simulator-broker.md`, `spec/implementation-plan.md`, `spec/build-and-test.md`, `references/README.md`

## Objective

Define a standalone simulator broker with four intentional layers:

1. broker core
2. local daemon or service API
3. thin CLI client and compatibility adapters
4. macOS app UI

## Planned component split

### `broker-core/`

Owns:

- lease lifecycle
- broker-mediated lifecycle policy for boot, shutdown, erase, and repair
- registry state
- deterministic pin/warm/shutdown selection ordering
- stale lease recovery
- idle-policy state, eligibility, reconciliation, and count-only cleanup plans
- reset-lock and mutation-lock semantics
- simulator inventory and `simctl` adapter boundaries
- policy parsing and validation
- capability-to-alias resolution
- lease, pin, and event schemas
- public-safe capacity classification, deterministic reconcile planning, and
  additive capacity transactions

Does not own:

- repo-specific policy authoring UX
- app presentation logic
- project-specific harness wrappers

Current implementation slice:

- file-backed registry, lease, pin, and event authority in `broker-core/index.mjs`
- lease containment helpers in `broker-core/containment.mjs` for process sampling, memory ceiling decisions, evidence writing, and lease-scoped termination
- shared real-or-fixture `simctl` adapter boundary in `broker-core/simctl.mjs`
- real simulator provisioning during `host init --bootstrap-config`, after an honest warning that real devices will be created
- registry drift synchronization and repair rebinding through broker-managed lifecycle flows
- reset-lock coordination for `erase-on-acquire`
- boot-on-acquire and most-recent-release warm reuse
- state-root-only idle policy and safe idle shutdown under the broker mutation lock
- capacity check and confirmed reconcile using the same repo/host policy,
  `simctl` adapter boundary, mutation lock, local transaction journal, rollback,
  and recovery model as the rest of broker authority

### `brokerd`

Owns:

- same-user local broker authority
- state snapshots and event streaming
- mutation coordination for CLI and app clients

Current implementation slice:

- Unix-socket local service implemented under `client/service/`
- foreground daemon target at `client/bin/brokerd.mjs`
- service lifecycle control through `simbroker service start|status|stop`
- shared command execution path with the CLI so direct and service-backed flows produce the same JSON contracts
- service error responses now map broker reason codes into stable HTTP status classes and exit-code payloads
- lifecycle-control requests for `boot`, `shutdown`, `erase`, and `repair`
- service-backed `capacity check` and `capacity reconcile` requests routed
  through the same broker-core evaluator and apply engine as direct CLI mode
- canonical `app-snapshot.json` artifact written into broker state for the macOS app
- command endpoint consumed directly by the macOS app for broker-backed operator actions
- immediate startup idle reconciliation, a non-overlapping 30-second scheduler,
  and snapshot refresh after each reconciliation

Does not own:

- broker selection logic
- repo-owned policy files
- app-specific presentation models beyond the shared read-only snapshot contract

### `client/`

Owns:

- CLI surface for humans, agents, and shell scripts
- stable JSON output for mutating and status commands; `help` and `doctor`
  default to human-readable text and keep the same payload behind `--json`
- repo project discovery and validation
- repo project scaffolding through `project init`
- explicit removal of inactive local project registrations through `project forget`
- compatibility wrappers for repos that want thin local helper commands
- automatic routing through `brokerd` when the local service is available
- lifecycle-control flags for explicit actor identity, active-lease references, and human override confirmation
- stable non-zero exit codes shared by direct CLI mode and service-backed CLI mode
- build/test containment commands: `lease register-process` records downstream command metadata, and `lease contain` records monitor observations or performs cleanup for memory ceiling, forced abort, timeout, stale owner, and manual cleanup reasons
- capacity commands: `capacity check` diagnoses whether repo purposes can
  acquire capacity now; `capacity reconcile` previews and, with exact human
  confirmation, applies additive broker-managed capacity
- idle commands: status, explicit human enable/disable, reconcile, and
  count-only cleanup preview plus exact human-confirmed apply
- lazy `brokerd` startup for normal acquisitions when idle policy is configured,
  while explicit local-only mode remains unscheduled

The CLI remains a thin control surface. It does not own simulator selection or registry mutation rules, but it may run wrapper-oriented orchestration that registers a local downstream process and calls broker-core containment.

### `app/`

Owns:

- UI visibility into simulators, aliases, leases, and ownership
- project and actor attribution
- optional operator actions after the read-only phase

Current implementation slice:

- SwiftUI macOS app generated from `app/project.yml`
- Overview, Simulators, Projects, and Events screens
- polling store that reads the broker-owned snapshot artifact and service metadata from the broker state root
- explicit `--state-root` launch override plus direct pane/detail targeting for fixture, smoke, and operator review runs without rewriting the default broker install root
- filterable simulator table plus detail panes for leases, pins, lifecycle fields, and event attribution
- broker-backed operator actions for pin create and clear, lease release, and lifecycle commands with confirmation and override flows
- Overview Automatic shutdown status, explicit duration entry, policy
  apply/disable, and count-confirmed cleanup over broker transport

Does not own:

- the source-of-truth policy for every repo
- direct assumptions about a single consumer repo

## Core architectural rule

The app must not become the only authority for broker policy. Repo-owned policy files remain versioned inputs so broker behavior can be reviewed and reproduced.

The app and CLI must operate on the same broker authority and observe the same state model. No simulator mutation may exist only in the app.

All lifecycle actions for broker-managed aliases, including boot, shutdown, erase, repair, pin, and release, must route through the broker authority rather than direct client `simctl` calls.

Lease acquisition itself boots the selected alias before returning. Idle policy
and cleanup are also broker-only mutations; neither the app nor a consumer repo
may write broker state files directly.

All destructive cleanup for broker-managed build/test leases must also route through broker authority. Repo wrappers may start downstream commands, but process ownership metadata, memory checks, evidence bundles, lease release, and audit events belong to the broker contract.

All capacity reconciliation for broker-managed aliases must route through
broker authority. Consumer repos may request purposes and portable requirements,
but they must not edit host config, choose host aliases, or create/delete
broker capacity directly.

The broker must remain transparent: clients need explainable denial reasons, holder details, health state, and an auditable event feed instead of opaque background behavior.

## Policy split

- host-local inventory and capability definitions belong to the machine-local broker install
- repo-owned purpose definitions belong to committed project files inside each consumer repo
- repo purpose definitions may include explicit iOS version or device family requirements
- normal automation requests purposes and capabilities, not hardcoded aliases
- explicit alias pins are an operator action, not the default repo integration path
- idle shutdown policy belongs only to machine-local broker state and is absent
  until a human chooses a valid duration

## Baseline Broker Constraints

- deterministic reservation, not opportunistic picking from `simctl` output
- one selection order: matching pin, compatible booted alias, compatible
  shutdown alias; most recent release first inside a tier
- explicit alias pools per role
- manual aliases protected from automation
- `erase-on-acquire` only for UI-like roles
- canonical lease artifact emission
- separate reset lock for slow UI resets

## Initial implementation order

1. finalize host config, repo project config, lease, pin, and event schemas in specs
2. implement `broker-core` with deterministic file-backed state and capability resolution
3. implement the CLI repo integration surface and stable JSON contract
4. add the local broker service and shared observation model
5. add explicit lifecycle and repair controls on the shared broker authority
6. ship the app visibility surface
7. add app-side mutation controls on the same shared broker authority
