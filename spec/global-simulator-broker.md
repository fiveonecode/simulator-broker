# Global Simulator Broker
Related: `spec/README.md`, `spec/architecture.md`, `spec/implementation-plan.md`, `spec/build-and-test.md`, `spec/project-structure.md`, `spec/tasks/public-safe-on-demand-simulator-lifecycle.md`, `references/README.md`

> **Document ID:** `GSB-001`
> **Version:** `0.19.0`
> **Last Updated:** `2026-10-23`
> **Status:** `Draft`
> **Owner:** `spec-steward`
> **Implementation owners:** `spec-steward`, `ios-dev`

## 1. Objective and context

This repo is the standalone home of a reusable simulator broker plus macOS app surface.

The broker preserves the following deterministic behavior:

- deterministic simulator alias selection
- machine-local shared lease state
- stale lease recovery
- reset policy per role
- automatic between-lease disk reclaim for build slots, with manual opt-in
- deterministic lease artifacts

A first extracted implementation slice now exists:

- file-backed broker core for validation, leases, pins, registry state, event recording, and lifecycle-control policy
- CLI support for host, project, lease, event, pin, doctor, and lifecycle-control flows
- same-user broker daemon for shared CLI and future app authority
- broker-owned `app-snapshot.json` artifact for read-only UI consumption
- macOS app with overview, simulator, project, and event visibility plus broker-backed operator controls
- explicit `--state-root` app launch override plus direct pane/detail targeting for fixture-backed and smoke-test runs
- app-side broker command transport over the local Unix socket with override-required handling
- local install flow, portable packaged distribution, and clean-machine-style onboarding smoke scripts
- real `simctl` adapter boundary for provisioning, lifecycle actions, reset-on-acquire coordination, and drift observation
- stable exit-code and service HTTP-status contract for broker failures
- lease-scoped containment for broker-aware build/test wrappers, including downstream process metadata, memory ceiling checks, evidence bundles, and stale-owner cleanup when process metadata exists
- deterministic warm reuse, boot-on-acquire, optional machine-local idle shutdown,
  confirmed cleanup, and public-safe operator controls
- guided machine setup shared by CLI and app, with deterministic preview,
  newest-compatible runtime selection, six-device provisioning, service and
  snapshot completion, and doctor verification

The extracted system must work for any repo that uses AI agentic development harnesses, CI jobs, or human-operated simulator workflows on one machine.

## 2. Scope

### In scope

- define the extracted broker architecture
- preserve the important deterministic broker semantics
- define generic policy and lease ownership schemas
- define a repo integration contract that lets projects request simulator purposes without hardcoding host alias names
- allow repo purpose definitions to express iOS version and device family requirements when needed
- define how the macOS app views simulator state and usage
- define how humans, agents, and CI identify themselves when they hold a lease
- define how broker-managed lifecycle actions are requested, authorized, and audited
- keep all committed examples and fixtures public-safe
- prepare Codex harness, specs, and skills for continued work

### Out of scope

- defining cross-host or multi-user synchronization

## 3. Baseline behavior that must not be lost casually

### Current policy and role model

- aliases: `manual-1`, `ui-1`, `ui-2`, `build-1`, `build-2`, `ipad-1`
- protected manual alias not auto-assigned to automation
- build-like roles with `resetPolicy: none`
- UI-like roles with `resetPolicy: erase-on-acquire`

### Current state and lease model

- machine-local state root under `~/Library/Application Support/SimulatorBroker/state`
- canonical `registry.json`
- canonical `leases/<lease-id>.json`
- optional state-root-only `idle-policy.json` containing exactly `version` and
  `graceSeconds`; absence means not configured
- broker mutation lock and separate reset lock
- lease records containing alias, simulator ID, role, owner label, pid, cwd, session dir, timing, reset policy, and broker lease file path
- broker-owned state directories and files are restricted to the current user; share leases through broker APIs or emitted lease artifacts, not by relaxing state-root permissions
- emitted lease artifact paths must not resolve to the host config, project config, broker state root, or any path inside the broker state root; protected overlaps are invalid requests, and cleanup must validate the recorded artifact path before deleting it
- lease acquisition must roll back the canonical lease file if a permitted emitted lease artifact cannot be written, so failed acquisition does not leave a hidden live lease behind

### Current reservation semantics

- reclaim stale leases when the owning process is gone
- rank a matching pin first, then compatible booted aliases, then compatible
  shutdown aliases
- within each tier prefer the most recently released alias and use configured
  alias order only as the final deterministic tie-breaker
- complete any required reset and boot the selected simulator before returning
  a successful lease
- fail invalid explicit alias or simulator overrides
- avoid borrowing aliases across configured role pools
- serialize slow erase/reset work for UI roles under a dedicated reset lock
- serialize release, process registration, lease containment, pin clearing, inactive project-registration cleanup, lifecycle operations, final app snapshot artifact writes, and state-refresh operations that normalize registry or stale lease state through the broker mutation authority so lease, pin, registry, lifecycle state, and shared app snapshots cannot race each other

### Current integration surface

- broker entrypoint script
- broker verification script
- direct usage from code verification flows
- direct usage from UI session flows

## 4. Initial target architecture

### `broker-core`

Must own:

- generic broker state schema
- policy schema and validation
- deterministic reservation algorithm
- stale recovery
- deterministic warm-reuse ordering
- idle-policy validation, eligibility, reconciliation, and cleanup planning
- slot-reclaim policy validation, eligibility, and between-lease erase
- reset coordination
- `simctl` adapter boundary
- purpose and capability resolution

Must not own:

- app-specific UI models
- project-specific path names
- repo-local command wrappers

Current implementation slice:

- host and repo config validation
- deterministic alias selection
- host config validation requires unique alias names and unique simulator IDs
- file-backed registry, leases, pins, and events
- stale lease recovery
- real and fixture-backed `simctl` adapters for broker-managed lifecycle work
- real `simctl` subprocess calls use a bounded execution timeout and surface timeout failures through the broker error payload, including final app snapshot refresh, instead of blocking service progress indefinitely
- process inventory subprocesses used for lease liveness, containment, and final app snapshot refresh must use a bounded timeout and surface sampler timeouts through the broker error contract instead of blocking command or service progress indefinitely
- host bootstrap that provisions real simulator devices, including dual iPhone UI aliases (`ui-1`, `ui-2`), a dedicated second `build-fast` alias (`build-2`) for overlapping build-test demand, and records actual simulator IDs
- host bootstrap and final state refresh/event recording run under broker mutation authority; failed bootstrap provisioning rolls back only simulators created by that bootstrap attempt before host config commit
- forced host replacement persists previous managed simulator IDs that require retirement in the first durable replacement host-config write
- simulator repair persists replaced simulator IDs as pending retirements when old-device shutdown or deletion fails after the repaired host config commits, and later repair/maintenance attempts must retry those pending retirements until deletion succeeds
- registry synchronization against `simctl` marks a missing device
  `repair-needed` with `simulator-missing`, an unavailable device with
  `simulator-unavailable`, and a family or runtime mismatch with
  `simulator-config-mismatch`. An existing `slot-reclaim-failed` reason is
  preserved across that synchronization. Synchronization never clears
  `repair-needed`. A leftover `repairing` entry becomes `repair-needed` with
  `repair-interrupted` on the next load. Only a successful repair returns
  the alias to `healthy`
- reset-on-acquire coordination behind a dedicated reset lock with rollback on reset failure
- boot-on-acquire with lease rollback and `repair-needed`
  (`boot-on-acquire-failed`) when boot fails. The real `simctl` adapter treats
  a boot result whose text says the device is already `Booted` or `Booting`
  as underway, then still runs `bootstatus`. A timeout and every other
  non-zero boot result still fail
- policy-driven idle shutdown under the mutation lock, with stale recovery
  starting a fresh grace period and shutdown failures becoming repair-needed
  (`idle-shutdown-failed`). The real `simctl` adapter treats an already
  `Shutdown` device as success and waits out `Shutting Down` by polling
  `simctl list` until `Shutdown` or the existing command timeout. A device in
  any other state gets one more shutdown attempt. Timeout and every other
  shutdown failure still fail, and the scheduler does not retry a
  repair-needed alias

### `brokerd`

Must own:

- host-local API
- single machine authority over lease mutation
- streaming state updates for UI

Current implementation slice:

- same-user local HTTP-over-Unix-socket service under `client/service/`
- service status, start, and stop control through `simbroker service <command>`
- shared command execution path used by direct CLI mode and service-backed CLI mode
- NDJSON event streaming for `events watch --follow --json-lines`
- CLI service routing validates that the live service metadata matches the requested host config, state root, and socket before routing commands or reporting an unchanged start
- service-backed command requests must carry an `expectedServiceIdentity` object whose host config path, state root, socket path, and exact opaque `runtimeVersion` match the live daemon metadata immediately before command dispatch; a missing runtime version fails closed before worker admission
- service-backed command requests may carry client request-start, queue-timeout, and execution-timeout budget fields; `brokerd` must reject a request whose queue budget has already expired, or whose recomputed dispatch-time execution budget exceeds the client-advertised execution budget, before dispatching the broker command; dispatch-time recomputation must use the request project file path when the command carries one
- service stop requests may carry the path portion of the same `expectedServiceIdentity` object, and `brokerd` must validate it before acknowledging shutdown; cooperative stop intentionally remains compatible with an older client so explicit upgrade recovery can drain the live daemon
- service stop closes active event streams before shutdown completes
- malformed JSON from a running service is reported as service unavailability by clients instead of escaping as an uncaught parser failure
- service startup must not publish a listenable socket or service metadata until the initial broker-owned app snapshot refresh has completed or explicitly reported a missing-host setup state; the CLI start launcher must wait within the bounded startup snapshot budget for one shared process-table sample, startup-lock owner PID lifetime sampling, and all inventory commands, validate startup-lock owner PID lifetime before accepting an old lock as live, and terminate the spawned daemon on startup timeout
- service-backed timeout budgets must reserve one shared process-table sample per broker state load; stale-lease containment process samples discovered from lease files before command dispatch for every broker state load that can retry containment; serialized read lock waits for `host status`, `doctor`, and `lease explain`; final app snapshot lock waits for every command that publishes the shared app snapshot artifact; capacity check inventory reads; the longer of lease-acquire reset `simctl` shutdown/erase plus boot readiness and one build-slot reclaim (`simctl list`, `du`, shutdown, and erase) plus that same boot readiness; lease-release reclaim list, `du`, shutdown, erase, and reset-lock wait; idle-reconcile and service-startup reclaim for every enabled candidate, including each reset-lock wait; explicit simulator boot readiness wait; and host bootstrap runtime lookup, baseline inventory, starter-alias provisioning, replacement-retirement, and final snapshot refresh work before the transport timeout is advertised
- broker-mediated lifecycle-control requests for `boot`, `shutdown`, `erase`, `repair`, and `delete`
- `simulators delete` execution time includes the capacity lock, the lease lock, snapshot publication, one state load, and two `simctl` commands (shutdown, then delete) per host alias. A missing or non-array `aliases` list uses the six-alias starter fallback. An empty list uses zero. Repair keeps its own static ten-command budget plus pending retirements and is not redefined by the delete count
- command transport consumed by the macOS app for broker-backed operator actions
- service-backed commands observing the same real `simctl`-synchronized alias health and repair state as direct CLI mode
- immediate idle reconciliation before the startup snapshot, non-overlapping
  reconciliation every 30 seconds, and snapshot refresh after every timer run

#### Service runtime health contract

`brokerd` health is a fail-closed runtime contract, not a process-liveness
claim. The canonical health states are `healthy`, `degraded`, and
`incompatible`.

| ID | Requirement | Verifier |
| --- | --- | --- |
| SB-SVC-RT-001 | Service metadata includes the daemon `runtimeVersion`; the CLI and app accept service-backed work only when that opaque value exactly matches their installed runtime version. A missing version is incompatible, and `/v1/command` rejects missing or mismatched expected versions before worker dispatch. | `client/test/brokerd.test.mjs` dispatch and stale-runtime rejection cases; `client/test/simbroker.test.mjs` legacy-daemon rejection case; `app/Tests/BrokerServiceClientTests.swift`; `app/Tests/BrokerSnapshotLoaderTests.swift` |
| SB-SVC-RT-002 | `brokerd` records its entrypoint and package-metadata identity at startup. Missing, replaced, or version-changed runtime files transition the daemon to `incompatible`. | `client/test/brokerd.test.mjs` installed-runtime loss case |
| SB-SVC-RT-003 | Every production command, snapshot, and scheduled-reconciliation worker receives the daemon's full startup runtime descriptor and compares it with the worker's current entrypoint/package descriptor before any broker operation begins. A bootstrap, runtime-load, or descriptor-mismatch failure transitions the daemon to `degraded`; it must not return a healthy status after that failure. | `client/test/brokerd.test.mjs` worker bootstrap module-loss and deterministic same-version runtime-replacement race cases |
| SB-SVC-RT-004 | Healthy status is HTTP `200`. `degraded` or `incompatible` status is HTTP `409`, uses reason `service-runtime-incompatible` and exit code `3`, and keeps `running: true` with exact service metadata so clients can withhold command authority while offering cooperative restart instead of treating the daemon as stopped or unverified. Other `409`, malformed, missing, mismatched, or transport-failed responses remain unverified. | `client/test/brokerd.test.mjs` status assertions; error-contract tests through `npm run test:client`; `app/Tests/BrokerSnapshotLoaderTests.swift`; `app/Tests/BrokerDashboardStoreTests.swift` |
| SB-SVC-RT-005 | While unhealthy, only status and cooperative stop remain available. Command, snapshot, event-stream, and scheduled worker admission fail closed until restart. | `client/test/brokerd.test.mjs` module-loss and stale-runtime rejection cases |
| SB-SVC-RT-006 | Explicit `simbroker service start` cooperatively stops an unhealthy or version-incompatible daemon, waits for its admitted workers, starts the installed runtime, and preserves file-backed leases, pins, registry, and events. | `client/test/brokerd.test.mjs` stale-runtime restart with active lease |

Guided setup preview reports `ready` with service action `keep` only when the
live daemon is healthy. A live `degraded` or `incompatible` daemon stays
`running: true` and is finishing work with service action `start`, so confirmed
apply uses the same cooperative restart path as `simbroker service start`.
Verified by `client/test/setup-preflight.test.mjs` and the unhealthy-daemon
setup cases in `client/test/simbroker.test.mjs`.

Runtime health remains degraded after the first worker bootstrap failure even if
files reappear. This keeps recovery deterministic: restore or reinstall the
runtime if necessary, then run `simbroker service start`. The daemon does not
self-exit because a live status and cooperative stop surface are required to
recover without guessing at processes or deleting sockets. A crash between
stop and restart is recoverable by rerunning the same start command; service
restart is not a cross-process atomic operation.

App project generation writes an ignored Swift constant and explicit app
`Info.plist` compatibility key atomically from the root `package.json` version.
Distribution packaging compares that inspectable key with `package.json` before
staging or signing, including when reusing a Release build with `--skip-build`.
Snapshot loading treats missing or mismatched service versions as read-only,
and every app mutation rechecks live status before POSTing the same exact
version in `expectedServiceIdentity`. This assumes the supported Homebrew
formula and cask are installed as a paired release; independently skewed
formula/cask installations intentionally remain read-only until the pair is
upgraded or reinstalled together.

### `client`

Must own:

- stable human and agent CLI
- stable JSON output for mutating and status commands; `help` and `doctor`
  default to human-readable text and keep the same payload behind `--json`
- repo project discovery and validation
- structured explain and denial reporting
- compatibility shims for repo-owned wrappers

Current implementation slice:

- `project validate` and `project show`
- `project init`
- `project forget --project-id <id>` removes only an explicit inactive local registration under the broker mutation lock; it is idempotent, publishes the refreshed app snapshot, preserves the repository and audit history, and rejects active lease or pin references with `project-in-use`
- `host init` and `host status`
- `lease acquire`, `lease explain`, `lease show`, and `lease release`
- `lease register-process` for wrapper-owned downstream command metadata
- `lease contain` for lease-scoped memory ceiling, forced-abort, timeout, stale-owner, and manual-cleanup containment
- `events watch`
- `pin create` and `pin clear`
- `capacity check` and `capacity reconcile` for public-safe capacity diagnosis,
  deterministic reconcile preview, and human-confirmed additive capacity apply
- `doctor`. Human text stays the default. `--json` issues for an unhealthy
  alias include `alias`, `causeCode` or `null`, `driftReason`, `health`,
  `reasonCode: alias-unhealthy`, and path-qualified `remediationCommands` for
  `simbroker host status` and `simbroker simulators repair --alias <alias>`.
  When `causeCode` is `runtime-not-found` or `device-type-not-found`, the
  same list also includes `simbroker simulators delete --alias <alias>`.
  Human text prints those remediation commands and appends
  `Reason: <driftReason>` when that string is non-empty. Doctor output stays
  on the machine that ran it
- `service start`, `service status`, and `service stop`
- automatic service routing when `brokerd` is available
- `simulators boot`, `simulators shutdown`, `simulators erase`,
  `simulators repair`, and `simulators delete`. Alias repair and alias delete
  are the operator and app commands. Purpose repair and purpose delete are
  the agent and CI commands and are specified below
- `idle status`, human-attributed `idle enable` and `idle disable`, immediate
  `idle reconcile`, and count-only `idle cleanup` preview plus confirmed apply
- policy-enabled normal lease acquisition lazily starts `brokerd` when needed;
  explicit local-only mode remains unscheduled and reports that limitation
- command option parsing rejects unknown flags before dispatch for lifecycle commands, lease acquire/register/contain/release, capacity commands, service control, event watches, pin mutations, and host initialization so misspelled state or routing flags cannot fall through to defaults before a destructive operation
- boolean option parsing honors explicit `false` and rejects unsupported values for command-shaping booleans, including lease containment diagnostic capture and owner-kill controls
- stable non-zero exit codes shared by direct CLI mode and service-backed CLI mode
- local install, package, and smoke scripts under `scripts/`, including CLI-only install through `install_local.sh --cli-only` and PATH persistence through Homebrew prefix bin or one guarded login-profile line
- `host init --bootstrap-config` warns that it creates real iOS Simulator devices before those devices are created

#### Project initialization caller-context contract

`project init` resolves repository identity at the CLI boundary before direct or
service-backed dispatch. This prevents a resident `brokerd` process from making
project identity depend on the directory where the daemon happened to start.

| ID | Requirement | Verifier |
| --- | --- | --- |
| SB-PROJECT-INIT-001 | The CLI sends both an absolute `projectFilePath` and an absolute `repoRoot` with every `project init` request. With neither path flag, the project file is `<caller cwd>/.simulator-broker/project.json` and the repository root is the caller working directory. With a caller-resolved project file and no explicit repo root, the root is one directory above the file's containing directory, matching the canonical `.simulator-broker/project.json` layout. | `client/test/simbroker.test.mjs` `project init keeps caller repo identity when a resident service was launched elsewhere` |
| SB-PROJECT-INIT-002 | An explicit `--repo-root` remains authoritative for project identity. An explicit `--project-file` remains authoritative for the file location. The canonical paired form points that file at `<repo-root>/.simulator-broker/project.json`, and direct and service-backed dispatch use the same absolute values. | The same resident-service regression plus `project init scaffolds a starter repo config that can be validated immediately` |
| SB-PROJECT-INIT-003 | A resident service launched from another working directory must return and register the caller repository identity. Repeating the same init without overwrite fails with `project-config-exists` and a caller-root recovery command. A following capacity check discovers the created project and reports its project ID; `repo.repoRoot` remains `null` by the public-safe capacity redaction contract. | `client/test/simbroker.test.mjs` `project init keeps caller repo identity when a resident service was launched elsewhere` |

These rules add no retry or service-side path discovery. The caller resolves the
context once and the daemon treats it as request data. This keeps the recovery
boundary explicit while avoiding a second working-directory-dependent path.

### `app`

Must show in the current phase:

- existing simulators in the broker pool
- alias and role state
- who owns each active lease
- which project the lease belongs to
- whether the lease comes from an agent session, automation, or manual human action

Current implementation slice:

- SwiftUI app backed by the broker-owned `app-snapshot.json`, which carries both `stateRoot` and `hostConfigPath` so the app can reject stale snapshots from a different selected broker host config
- Overview screen for host health, saturation, and attention items
- Simulators screen with filters and lease or pin detail
- Projects screen with per-project purpose counts and active aliases
- Events screen with recent broker activity and event attribution
- broker-backed actions for pin create and clear, lease release, and lifecycle requests with human override confirmation. Delete is a confirmed alias command with no override sheet. It stays enabled for an unleased, unpinned alias that is not `repairing`, including a booted `repair-needed` alias, and it does not use the healthy or state-drift gate that disables Boot and Erase
- Overview **Automatic shutdown** status and broker-backed Apply, Disable, and
  count-confirmed cleanup actions; unconfigured policy leaves duration blank
- first-run setup classification for missing CLI, missing host config, stopped
  service, and snapshot-refresh states
- app-driven `simbroker setup --json` preview and exact confirmed apply through
  one bounded, cancellation-aware installed CLI subprocess contract; fresh
  setup uses a dedicated six-device plan sheet, while service/snapshot-only
  finishing work bypasses device confirmation
- setup plan/phase/pending confirmation/stored task live in the `@MainActor`
  store; Stop cancels the CLI process, cancellation refreshes state without a
  generic error, and the setup timeout includes preflight, provisioning,
  bounded rollback, service, snapshot, and doctor instead of the 30-second fallback
- repo onboarding guidance in the app when the machine is ready but no broker-aware repo has been registered yet

## 5. Ownership metadata that the extracted system should add

Legacy lease metadata is not rich enough for the intended app UI.

The extracted system should likely add fields such as:

- `projectId`
- `projectName`
- `repoRoot`
- `purposeId`
- `actorType`
- `actorId`
- `jobId`
- `jobKind`
- `threadId`
- `automationId`
- `automationName`
- `clientInstanceId`
- `leaseKind`
- `pinId`

## 6. Broker-mediated lifecycle rule

For broker-managed aliases, the broker must be the middle layer for all state-changing operations:

- reserve and release
- pin and clear pin
- boot and shutdown
- erase, repair, and delete

The app, CLI, AI agents, and repo harnesses must call broker-owned commands or APIs for those actions instead of mutating managed aliases directly with `simctl`.

The broker must also remain observable rather than opaque:

- expose current holder and policy state
- explain denials and conflicts with structured reasons
- emit auditable events for every mutation and override
- detect external drift and mark aliases unhealthy when direct out-of-band mutation is observed

Default operational decisions for v1:

- repo project config uses explicit requirements only; there is no soft-preference layer
- repo project config v1 supports only `deviceFamily` and `iosVersion` in `requires`
- when multiple aliases satisfy a requirement set, the single deterministic
  warm-reuse ordering chooses among them; no legacy rotation mode exists
- acquisition succeeds only after the selected simulator is booted
- active-holder lifecycle actions require an active lease ID or lease file reference; actor ID and actor type are attribution metadata, not authorization credentials
- only humans may force-override another live holder for urgent repair, and
  only through alias repair
- human-forced alias repair overrides must include `forceOverride`, `overrideReason`, `expectedAlias`, and `expectedLeaseId`
- purpose repair rejects `--force-override` for every actor type, including human
- direct out-of-band boot or shutdown is observable drift but not automatically blocking when alias identity is intact
- destructive or identity-changing out-of-band drift is blocking until repair completes
- broker health states are `healthy`, `state-drift`, `repair-needed`, and `repairing`
- local project-registration cleanup must use the broker-owned `project forget --project-id <id>` command rather than editing broker state files; it may remove only an explicit registration with no active lease or pin, records a global `project.forgotten` audit event that does not itself restore the removed project to the Projects read model, and refreshes the shared app snapshot

Failure-contract defaults for v1:

- exit code `0` means success
- exit code `2` means invalid request, including malformed flags, unknown
  commands, invalid config, or missing broker files
- exit code `3` means unavailable capacity or transient broker-side unavailability, including exhaustion, conflicts, missing runtimes, service unavailability, expired service command queue budgets, or bounded process-sampler timeouts
- exit code `4` means repair is required or a repair or delete attempt failed.
  This includes an alias that needs repair, `purpose-repair-failed`,
  `purpose-delete-failed`, and `capacity-repair-required`. HTTP status is `423`
- exit code `5` means human override or override confirmation is required before the action may continue. Purpose repair uses `human-override-required` when every unhealthy match is held and nothing was repaired. Purpose delete uses the same reason when every eligible match is held and nothing was deleted. HTTP status is `412`
- setup confirmation-required and stale-plan errors use `5`; setup prerequisite
  and non-alias health failures use `3`; alias health uses `4`; cooperative
  SIGINT/SIGTERM interruption uses `130`/`143`
- exit code `1` means internal failure or an unclassified unexpected error
- service responses must carry the same `exitCode` value in their JSON error payloads
- clients must classify malformed service JSON as `service-unavailable`
- clients must reject non-positive `events watch --follow --poll-interval-ms` values as malformed flags
- recent-event reads used for app snapshots must avoid parsing the full historical event log when only a bounded tail is requested and must preserve UTF-8 text when multibyte characters cross internal read chunk boundaries
- app mutation flows must not clear or overwrite snapshot refresh errors after a successful broker mutation; a mutation is user-visible success only after the follow-up snapshot refresh succeeds or is superseded by a newer successful refresh
- a current-generation app refresh failure preserves the last readable snapshot, tooling, and runtime paths but clears cached service authority until a later successful refresh validates exact service status; a live-status probe timeout, non-success HTTP response, or malformed response is a refresh failure rather than confirmed service absence, except that exact HTTP `409` status with reason `service-runtime-incompatible`, exit code `3`, `running: true`, and matching selected service identity is verified live-but-unhealthy state that disables commands while retaining guided cooperative restart; a snapshot-only decode failure after confirmed service absence or verified restart-required status preserves recovery affordances, while the same failure after a validated healthy service remains unverified; the unverified state takes precedence even when no snapshot is cached and applies on first load when host configuration already exists; every validated service-authority or runtime-health transition, including confirmed absence to a live service, dismisses pending mutation confirmations and invalidates delayed idle or lifecycle responses, revocation also cancels guided setup still previewing or awaiting confirmation; every operator, polling-loop, and setup-owned refresh captures the dashboard-store lifecycle generation before its task is queued, queued setup work verifies its setup and lifecycle ownership plus current service-authority eligibility before any local command begins, setup tasks publish completion or failure state only while that captured generation still owns the flow, and an intentional setup cancellation refresh runs outside the cancelled task and publishes only while its setup generation and captured lifecycle generation still own the flow so a late result cannot poison a replacement setup or restart work after lifecycle shutdown; cancellation of a dashboard refresh, including a loader that surfaces a non-cancellation failure after cancellation, is discarded without revoking cached authority or publishing an error, while mutation and setup callers propagate cancellation and every superseded-generation waiter is resumed exactly once; service and local-setup confirmation paths reject revoked authority and must not present or offer recovery from unverified brokerd status; a true missing-host first load and a later failure after a cached missing-host success remain onboarding, including when that later failure must first clear stale live-service authority cached after an external host-config deletion; a superseded failure must not downgrade newer loaded state, and setup already applying is not interrupted by refresh-driven dismissal; the unverified-status CLI fallback uses the same selected host-config, state-root, and service-socket paths as setup and remains visible after a cached-snapshot refresh failure, not only on first-run setup
- service HTTP status classes should stay aligned with the same failure groups: `400` invalid request, `404` unknown route, `409` unavailable or conflict, `412` override-required, `423` repair-needed, and `500` internal failure

### Purpose-scoped repair

Agents and CI repair a purpose themselves. They do not wait for the app Repair
button, and they do not call `xcrun simctl` on a broker-managed simulator.
Registry sync does not clear `repair-needed` after the device looks fine again.
Only a successful repair sets `healthy`.

```bash
simbroker simulators repair \
  --repo-root <repo> \
  --purpose <purpose> \
  --actor-type <agent|ci|human> \
  --actor-id <id> \
  --json
```

The alias form stays available for the app, doctor, and a human operator:

```bash
simbroker simulators repair --alias <alias>
```

`--alias` together with `--purpose` is `invalid-flag` (exit `2`).
`--force-override` on the purpose form is `invalid-flag` (exit `2`) for every
actor type. `--actor-type` must be `agent`, `ci`, or `human`, and
`--actor-id` is required.

Purpose repair takes one capacity lock and then one lease lock for the whole
call. It must not call the alias-repair entrypoint from inside those locks.
The pre-repair state load samples the clock after both locks are held, so a
dead lease without containment metadata records `lastLeaseReleasedAt` at
reclaim time. Lock-owner metadata keeps the timestamp captured before the
waits.
It uses the same structural match as capacity check. It repairs a match only
when that match is `repair-needed` or `repairing`, has no active lease, and is
not pinned for another project or for another purpose of this project. A pin
for this project and this purpose, including a project-wide pin, does not block
repair. Aliases are visited in alias order. One alias failure does not skip
the remaining matches. A lease or other-purpose pin that appears before that
alias is mutated counts as held, not failed.

Repair reuses the current device when it is available and matches the
preferred runtime and device type, renaming it when needed. Otherwise it
creates a replacement and retires the old simulator ID. That is the same
replacement behavior as the app Repair button. A newer preferred device type
can therefore replace the device. Wrapper scripts stay acquire-only and must
not hide this command.

Direct and service-backed execution share this command. The service budget
remains the existing single-alias repair execution budget, including the
pending-retirement extension already used by `simulators repair`.

Success JSON is schema version `1` and is public-safe. It contains `ok`,
`command: "simulators.repair"`, `purposeId`, integer counts `repaired`,
`failed`, and `held`, `status`, sorted `reasons`, and `schemaVersion`. It must
not contain aliases, simulator IDs, paths, actor IDs, or raw `simctl` text.
Service-backed success omits `servedBy`. The event log may keep the alias and
the detailed cause.

`status` is `repaired` when at least one match was repaired and none failed,
`nothing_to_repair` when every count is zero, `held` when nothing was repaired
and at least one match is held, and `failed` when any repair failed. A mix of
repaired and held matches with no failure is `repaired`.

Stable `reasons` values are:

- `simulator-missing`
- `simulator-unavailable`
- `simulator-config-mismatch`
- `boot-on-acquire-failed`
- `reset-on-acquire-failed`
- `idle-shutdown-failed`
- `slot-reclaim-failed`
- `repair-interrupted`
- `repair-failed`
- `runtime-not-found` or `device-type-not-found` beside `repair-failed` when that is the alias failure reason
- `unhealthy-alias` for any other stored drift string

`simulator-config-mismatch` may also appear from the stored public drift
reason when sync rewrites an alias, including an iOS `26.4` alias compared
with an installed `18.2` runtime, before repair throws. Status and exit stay
the same.

Exit `0` when status is `repaired` or `nothing_to_repair`, including a repaired
result that also counted held matches. Exit `4` with `purpose-repair-failed`
when any repair failed, even if a sibling was repaired. Exit `5` with
`human-override-required` when nothing was repaired and at least one match is
held. The thrown error payload carries the same public summary.

An agent runs this command at most once for a denial, then retries the blocked
`capacity check` or `lease acquire` once. Exit `5` stops for a human. Exit `4`
whose `reasons` include `runtime-not-found` or `device-type-not-found`
continues to purpose delete, specified below. Any other exit `4` stops after
one local `simbroker doctor` read of `causeCode` and `driftReason`. Doctor
output, aliases, simulator IDs, and host paths stay out of public logs.

| ID | Requirement | Verifier |
| --- | --- | --- |
| SB-PURPOSE-REPAIR-001 | One purpose repair clears every unleased repair-needed structural match, leaves the simulator ID in place when the device can be reused, and lets a later acquire succeed. Public JSON has counts and stable reasons only. | `broker-core/test/broker-core.test.mjs` `purpose repair clears an unleased repair-needed alias and acquire can proceed` |
| SB-PURPOSE-REPAIR-002 | A live holder is left untouched. The command exits `5` with `human-override-required` and does not publish the alias, simulator ID, or holder identity. | `broker-core/test/broker-core.test.mjs` `purpose repair leaves a live holder untouched and requires a human` |
| SB-PURPOSE-REPAIR-003 | Force override and an alias selector are `invalid-flag` exit `2` in core and at the CLI, including an unknown actor type. | `broker-core/test/broker-core.test.mjs` `purpose repair rejects force override and an alias selector`; `client/test/simbroker.test.mjs` `purpose repair rejects an alias, force override, and unknown actor type` |
| SB-PURPOSE-REPAIR-004 | One failed alias returns exit `4` with `purpose-repair-failed`, keeps the repaired sibling, and hides the alias and private error text. | `broker-core/test/broker-core.test.mjs` `purpose repair reports a failed alias without hiding a repaired sibling`; `broker-core/test/error-contract.test.mjs` exit `4` and HTTP `423` for `purpose-repair-failed` |
| SB-PURPOSE-REPAIR-005 | Sole repair-needed capacity uses `recommendedAction: repair_matching_simulators`, null action kind, and a blocked reconcile with no create action. | `broker-core/test/broker-core.test.mjs` `purpose repair clears an unleased repair-needed alias and acquire can proceed` |
| SB-PURPOSE-REPAIR-006 | A dead non-containment lease that exits while purpose repair waits on the capacity lock records `lastLeaseReleasedAt` at the post-lock time. Lock-owner metadata keeps the pre-wait time, and idle reconcile at that post-lock time still has grace left. | `broker-core/test/broker-core.test.mjs` `purpose repair stamps a dead non-containment lease with the post-lock time` |
| SB-DOCTOR-DRIFT-001 | Doctor JSON includes `driftReason` and an alias-repair remediation command. Human text prints that reason. | `broker-core/test/broker-core.test.mjs` `doctor reports the drift reason and an alias repair command`; `client/test/simbroker.test.mjs` `doctor human formatter includes the drift reason` |
| SB-SIMCTL-RACE-001 | Real `simctl boot` continues to `bootstatus` for current state `Booted` or `Booting`. Real `simctl shutdown` waits from `Shutting Down` to `Shutdown` and times out if that wait never finishes. Other non-zero results still fail. | `broker-core/test/broker-core.test.mjs` `system simctl boot continues when the device is already booted or booting`, `system simctl shutdown waits until a shutting-down device reaches Shutdown`, `system simctl shutdown fails when a shutting-down device never finishes` |

Implementation map:

- `broker-core/index.mjs` owns purpose repair, the capacity recommendation, and doctor issue fields
- `broker-core/simctl.mjs` owns in-progress boot and shutdown tolerance
- `broker-core/error-contract.mjs` owns `purpose-repair-failed`
- `client/command-dispatch.mjs` owns the purpose flag split, help line, and doctor reason text
- the macOS app Repair button stays alias repair
- `examples/harness-adoption/sample-consumer-repo/scripts/` stays acquire-only

### Simulator delete

Humans, the app, agents, and CI delete a broker-managed simulator only through
`simbroker simulators delete`. The app is a broker client and never calls
`simctl`. There is no `--force-override` on either form. Idle cleanup, slot
reclaim, and setup rollback do not delete a simulator. This command does not
uninstall an iOS runtime, retarget an alias to another iOS version, or add
`--ios-version` to repair.

#### Alias delete

The app button and an explicit one-alias command use:

```bash
simbroker simulators delete --alias <alias> [--actor-type agent|ci|human] [--actor-id <id>]
```

Omitted `--actor-type` means `human`. A non-empty actor type outside
`agent`, `ci`, or `human` is `invalid-flag` (exit `2`). `--alias` together
with `--purpose`, and `--force-override` on either form, are `invalid-flag`
(exit `2`) before any mutation. Unknown flags are rejected before mutation.

The command can delete a `healthy`, `state-drift`, or `repair-needed` alias,
including a booted repair-needed alias, when it is unleased and unpinned. Any
pin holds, including a pin for the same project and purpose. A loaded entry
that is still `repairing` throws `alias-busy` (exit `3`, HTTP `409`). A lease
is `lease-conflict` (exit `3`). A pin is `pin-conflict` (exit `3`).

`loadBrokerState` always syncs the registry and converts a persisted
`repairing` row to `repair-needed` before the command sees it. That recovered
row is eligible for delete. The `alias-busy` guard remains for an entry that
is still `repairing` after that load. Crash recovery must not be changed to
block delete.

A missing alias returns success with `unchanged: true`. Inventory sync may
still list devices. Shutdown and delete are not called again, and no event
is written. A device that is already absent skips `simctl` and still removes
the host-config and registry records.

Shutdown and delete go through the existing `deleteAliasSimulator` helper.
If that call throws, the alias stays, health becomes `repair-needed`,
`driftReason` stores the error message or cause, and `driftCauseCode` is
stored only when `reasonCode` is in the known allowlist below. The command
appends `simulator.delete.failed`, does not write `pendingRetirements`, and
rethrows. A non-`BrokerError` is wrapped as `simulator-action-failed`.

After the device is gone, the alias is removed from host config and the
registry. Both writes use the pending-retirement helper so an empty
`pendingRetirements` array is omitted. The command appends
`simulator.deleted`. The CLI refreshes `app-snapshot.json` after the command
returns, outside the lease lock. An empty alias list is valid. The six-alias
check stays on the starter plan only.

Alias success JSON contains `ok`, `command: "simulators.delete"`, `alias`,
`unchanged`, and `performedAt`. It omits `simulatorId` and host paths. The
event log may keep the alias and simulator ID.

#### Purpose delete

Agents and CI use:

```bash
simbroker simulators delete \
  --repo-root <repo> \
  --purpose <purpose> \
  --actor-type <agent|ci|human> \
  --actor-id <id> \
  --json
```

`--actor-type` and `--actor-id` are required. The command takes the capacity
lock and then the lease lock once. Those locks are not reentrant, so purpose
delete must call the shared inner alias function and must not call the public
alias entrypoint or refresh the snapshot inside the lease lock.

It visits structural matches in alias order. It deletes a match only when
health is `repair-needed`, `driftCauseCode` is `runtime-not-found` or
`device-type-not-found`, and the alias has no active lease and no pin.
`healthy`, `state-drift`, other repair causes, leased matches, and pinned
matches stay. A lease or pin on an otherwise eligible match counts as held.
`repairing` is ignored and is not held. One failure does not skip later
matches.

Success JSON is schema version `1` and is public-safe. It contains `ok`,
`command: "simulators.delete"`, `purposeId`, integer counts `deleted`,
`failed`, and `held`, `status`, sorted `reasons`, and `schemaVersion`. It
must not contain aliases, simulator IDs, paths, actor IDs, or raw `simctl`
text. Service-backed success omits `servedBy`.

`status` is `deleted` when at least one match was deleted and none failed,
even if some matches were held. It is `nothing_to_delete` when every count
is zero, `held` when nothing was deleted and `held` is greater than zero,
and `failed` when any delete failed.

Exit `0` when status is `deleted` or `nothing_to_delete`. Exit `4` with
`purpose-delete-failed` when any delete failed. Exit `5` with
`human-override-required` when nothing was deleted and at least one match is
held. Both thrown payloads carry the same public summary fields.

Public `reasons` are `runtime-not-found`, `device-type-not-found`,
`delete-failed`, and `simulator-missing` only when the device was already
gone and the records were removed. The eligibility cause is also present on
success, held, and failure.

#### Cause codes

Registry rows persist `driftCauseCode` beside `driftReason`.
`normalizeRegistry` rebuilds entries and must copy the field. Older rows
have `null`. A token is stored only when it is in this allowlist:

- `boot-on-acquire-failed`
- `device-type-not-found`
- `idle-shutdown-failed`
- `repair-interrupted`
- `reset-on-acquire-failed`
- `runtime-not-found`
- `simulator-action-failed`
- `simulator-config-mismatch`
- `simulator-missing`
- `simulator-unavailable`
- `slot-reclaim-failed`

Purpose delete triggers only on `runtime-not-found` and
`device-type-not-found`. Repair failure sets `driftCauseCode` from
`error.payload.reasonCode` when that token is known. Repair success, and a
sync that returns a row to `healthy`, clear it. A sync that rewrites
`driftReason` on a still-unhealthy row does not clear it. A missing device
sets `driftReason` to `simulator-missing` and keeps `driftCauseCode`.

An older row with `null` is skipped by purpose delete until a later repair
records a cause. The app alias button can still delete that unleased,
unpinned row.

#### Agent and CI procedure

When `capacity check` reports `recommendedAction`
`repair_matching_simulators`, run purpose repair once. Exit `0` retries the
check or acquire once. Exit `5` stops for a human and never passes
`--force-override`. Exit `4` whose `reasons` include `runtime-not-found` or
`device-type-not-found` runs purpose delete once. Delete exit `0` retries
capacity check once and acquires only when the purpose is `available`.
Delete exit `5` stops for a human. Any other repair exit `4` or delete exit
`4` runs `simbroker doctor` once, reads `causeCode` and `driftReason`
locally, and stops. `repair_needed` with `install_runtime`,
`run_broker_doctor`, or `inspect_unknown` follows that action and does not
repair or delete. Never call `xcrun simctl` boot, shutdown, erase, delete,
or repair on a broker-managed simulator. Wrapper scripts stay acquire-only.

#### App

Delete appears in the simulator detail Broker actions and in the Broker
menu. It is enabled when commands can be sent, no mutation is in flight, the
alias has no lease and no pin, and health is not `repairing`. `repair-needed`
stays enabled, including when the simulator is booted. Confirmation says the
action removes the alias from the pool and deletes the simulator and its
data, and that it does not uninstall the iOS runtime. Confirm sends alias
delete with `actorType` `human` and actor id `simulator-broker-app`. It does
not send `forceOverride` and does not open the override sheet. Leased or
pinned detail text says to release the lease and clear the pin before
deleting. The repair banner still explains repair and adds that Delete is
available when the simulator is not leased or pinned. After a successful
refresh, or when restoring a stored selection, an alias that is gone from
the snapshot is cleared to no selection instead of jumping to another alias.
An alias that is only filtered out keeps the existing first-filtered
selection.

#### Residual risk

Purpose delete shrinks capacity, so the next check may be `unavailable`.
Reconcile stays human-confirmed. A `simctl` shutdown refusal leaves the
alias for a later retry. A host-config write that fails after the device is
already gone is recovered by the next delete through the missing-device
path.

| ID | Requirement | Verifier |
| --- | --- | --- |
| SB-SIM-DELETE-001 | Alias delete removes an unleased, unpinned `healthy`, `state-drift`, `repair-needed`, or recovered `repairing` alias, including a booted repair-needed alias. A missing alias is `unchanged: true` with no second shutdown or delete and no event. Success JSON omits simulator ID and host paths. Snapshot refresh runs after the command returns, outside the lease lock. Host writes omit an empty `pendingRetirements` array. | `broker-core/test/broker-core.test.mjs` `alias delete removes a booted repair-needed simulator and refreshes the snapshot`, `alias delete refuses a lease or pin and accepts healthy, drifted, and recovered repairing aliases`; `client/test/simbroker.test.mjs` `direct CLI delete removes one alias or one stuck purpose and refreshes the snapshot` |
| SB-SIM-DELETE-002 | A device that is already absent skips `simctl` and still removes host-config and registry records. Purpose reasons include `simulator-missing` for that success. | `broker-core/test/broker-core.test.mjs` `alias delete removes records when the device is already gone`, `purpose delete reports a missing device and continues after one failure` |
| SB-SIM-DELETE-003 | A shutdown or delete throw leaves the alias, sets `repair-needed`, stores `driftReason` and a known `driftCauseCode`, appends `simulator.delete.failed`, writes no `pendingRetirements`, and rethrows. A non-broker error is `simulator-action-failed`. The command uses `deleteAliasSimulator`. | `broker-core/test/broker-core.test.mjs` `alias delete keeps the alias when simctl delete fails` |
| SB-SIM-DELETE-004 | A lease is `lease-conflict`, a pin is `pin-conflict`, and a still-`repairing` loaded entry is `alias-busy`. Each is exit `3` and HTTP `409`. Any pin holds. Persisted `repairing` is recovered and then deleted. | `broker-core/test/broker-core.test.mjs` `alias delete refuses a lease or pin and accepts healthy, drifted, and recovered repairing aliases`; `broker-core/test/error-contract.test.mjs` exit `3` and HTTP `409` for `lease-conflict`, `pin-conflict`, and `alias-busy` |
| SB-SIM-DELETE-005 | Purpose delete removes only unleased, unpinned `repair-needed` matches whose cause is `runtime-not-found` or `device-type-not-found`, in alias order, under one lock pair. Other health values, other causes, leases, and pins stay. `repairing` is ignored. One failure does not skip later matches. The public alias entrypoint is not called. | `broker-core/test/broker-core.test.mjs` `purpose delete removes only unowned missing-runtime matches`, `purpose delete reports a missing device and continues after one failure` |
| SB-SIM-DELETE-006 | Purpose JSON is schema version `1` with counts, status, and sorted reasons only. `deleted` and `nothing_to_delete` exit `0`. Any failure throws `purpose-delete-failed`. Held-only throws `human-override-required` with the same summary. | `broker-core/test/broker-core.test.mjs` `purpose delete removes only unowned missing-runtime matches`, `purpose delete stops for a human when every eligible match is held`, `purpose delete reports nothing to delete and rejects override selectors` |
| SB-SIM-DELETE-007 | `purpose-delete-failed` is exit `4` and HTTP `423`. Held-only purpose delete is exit `5` and HTTP `412`. Mixed selectors, `--force-override`, and a bad actor type are exit `2` and HTTP `400`. | `broker-core/test/error-contract.test.mjs`; `client/test/simbroker.test.mjs` `purpose delete accepts agent and ci actors and rejects mixed selectors`; `broker-core/test/broker-core.test.mjs` `alias delete rejects force override and a purpose selector`, `purpose delete reports nothing to delete and rejects override selectors` |
| SB-SIM-DELETE-008 | `driftCauseCode` survives registry normalization and is cleared only when a row returns to `healthy` or repair succeeds. Repair failure records a known reason code. Purpose repair publishes `runtime-not-found` or `device-type-not-found` beside `repair-failed` and still exits `4`. | `broker-core/test/broker-core.test.mjs` `purpose repair publishes runtime-not-found beside repair-failed`, `alias delete keeps the alias when simctl delete fails` |
| SB-SIM-DELETE-009 | Doctor JSON includes `causeCode` or `null`. Only `runtime-not-found` and `device-type-not-found` add the alias delete remediation after host status and repair. Human doctor text prints that command. | `broker-core/test/broker-core.test.mjs` `doctor names alias delete only for a missing runtime or device type`, `doctor reports the drift reason and an alias repair command`; `client/test/simbroker.test.mjs` `doctor human formatter names alias delete for a missing runtime` |
| SB-SIM-DELETE-010 | Direct and service CLI accept both forms, reject `--alias` with `--purpose` and `--force-override`, refresh the snapshot after success, and omit `servedBy` from purpose success. Help lists both commands. | `client/test/simbroker.test.mjs` `direct CLI delete removes one alias or one stuck purpose and refreshes the snapshot`, `purpose delete accepts agent and ci actors and rejects mixed selectors`; `client/test/brokerd.test.mjs` `service-backed purpose delete omits host paths from success JSON` |
| SB-SIM-DELETE-011 | Delete execution time scales with two `simctl` commands per host alias and includes the capacity lock. No paths uses the six-alias fallback (`2_385_000` ms execution). An empty alias array adds no simctl time. The repair budget of `2630` / `2690` seconds with two pending retirements stays unchanged. | `client/test/simbroker.test.mjs` `service mutation timeouts cover broker lock waits`; `app/Tests/BrokerServiceClientTests.swift` `testDeleteTimeoutBudgetScalesWithHostAliasCount`, `testRepairTimeoutBudgetScalesWithPendingRetirements` |
| SB-SIM-DELETE-012 | The app enables Delete for an unleased, unpinned, non-`repairing` alias, including booted `repair-needed`, and disables it for a lease, a pin, `repairing`, or when commands cannot be sent. Confirmation sends alias delete as human actor `simulator-broker-app` with no override. A selected alias missing from the snapshot clears to no selection. A filtered-out alias keeps the first filtered match. | `app/Tests/BrokerDashboardStoreTests.swift` `testDeleteStaysEnabledForBootedRepairNeededSimulator`, `testDeleteRequestIsIgnoredWhenTheSimulatorIsHeldOrCommandsCannotBeSent`, `testDeleteConfirmationSendsAliasDeleteWithoutOverride`, `testVanishedSimulatorSelectionClearsWithoutReplacingAFilteredAlias`, `testSceneRestorationClearsAMissingSimulatorAndFallsBackForProjectAndEvent`, `testCommandAvailabilityMatchesSelectedSimulatorState` |
| SB-SIM-DELETE-013 | Sample agent instructions and the adoption checklist teach the one-attempt purpose delete after a matching repair exit `4`. Wrapper scripts do not contain `simulators delete`. | `examples/harness-adoption/test/harness-adoption.test.mjs` `sample agent instructions repair only for repair_matching_simulators`, `adoption checklist repairs only when capacity recommends repair_matching_simulators` |
| SB-SIM-DELETE-014 | README and getting-started hello world teach purpose delete after repair exit `4` with `runtime-not-found` or `device-type-not-found`, and neither hello section contains `simulators delete --alias`. | `docs/test/front-door.test.mjs` `README Use it orders Homebrew CLI, cask, guided setup, then hello world` |

Implementation map:

- `broker-core/index.mjs` owns both delete forms, `driftCauseCode`, and doctor `causeCode`
- `broker-core/error-contract.mjs` owns `purpose-delete-failed`
- `client/command-dispatch.mjs` owns the flag split and help lines
- `client/service/service-client.mjs` and `app/Sources/BrokerServiceClient.swift` own the delete timeout
- `client/service/brokerd.mjs` omits `servedBy` on purpose success
- `app/Sources/` owns the Delete button, menu, confirmation, and selection clearing
- `spec/harness-integration.md` owns the agent and CI procedure
- `.agents/skills/broker-harness-adoption/SKILL.md` points at that procedure and does not invent a second one
- `examples/harness-adoption/sample-consumer-repo/scripts/` stays acquire-only

## 7. Public-safe idle lifecycle contract

Idle shutdown is opt-in machine policy. The broker stores it only at
`<state-root>/idle-policy.json`, outside repositories, with exactly this shape:

```json
{
  "version": 1,
  "graceSeconds": 60
}
```

The value shown is the minimum valid value, not a default. `graceSeconds` must
be an integer from `60` through `86400`; absence of the file means not
configured. Source, docs, fixtures, and onboarding must not embed an operator's
chosen duration.

The public command surface is:

```text
simbroker idle status
simbroker idle enable --grace-seconds <60-86400> --actor-type human --actor-id <operator-id>
simbroker idle disable --actor-type human --actor-id <operator-id>
simbroker idle reconcile
simbroker idle cleanup
simbroker idle cleanup --apply --confirm <plan-id> --actor-type human --actor-id <operator-id>
```

Enable, disable, and cleanup apply require explicit human attribution. Cleanup
preview is non-mutating and count-only. Apply recomputes the candidate set under
the mutation lock and requires the exact current plan ID. There is no unattended
confirmation bypass.

Reconciliation takes the broker mutation lock, re-reads leases and inventory,
and shuts down only registered aliases that are booted, healthy, unleased,
unpinned, non-`manual-persistent`, and at or beyond the recorded release time
plus grace. Stale recovery records a new release time and therefore restarts
grace. Unknown externally booted devices remain untouched. The real `simctl`
adapter waits out current state `Shutting Down` until `Shutdown` or the
command timeout, and retries shutdown once when the device is in any other
non-shutdown state. Timeout and every other shutdown failure mark the alias
`repair-needed` with `idle-shutdown-failed`, so the scheduler does not
repeatedly retry it.

`brokerd` reconciles immediately at startup and every 30 seconds thereafter,
without overlapping runs, and refreshes the app snapshot after each run. A
policy-enabled normal acquisition lazily starts `brokerd` when it is absent.
Explicit local-only mode never schedules work and reports `local-only-mode`.

Events and snapshots summarize configuration state, grace duration, eligible
count, last cleanup result, and next scheduled cleanup. Idle and cleanup
summaries must not return local paths, aliases, simulator IDs, operator IDs, or
raw runtime errors.

## 7a. Slot disk reclaim contract

Build-like slots keep `resetPolicy: none` so incremental test hosts can reuse
installed apps. That data also grows: OS symbol caches, unified logs, and
leftover test-host tmp directories. The broker therefore reclaims disk
automatically between leases. This is not a replacement for
`erase-on-acquire`, and it never runs while a slot is leased, pinned,
mid-acquire, or being erased under the reset lock.

Policy lives in optional host-config `slotReclaim`. Absence means the defaults
below. The field is machine-local configuration, not a repo file.

```json
{
  "enabled": true,
  "build": {
    "enabled": true,
    "maxLeasesSinceErase": 8,
    "maxAgeSeconds": 86400,
    "maxDiskBytes": 8589934592
  },
  "manual": {
    "enabled": false,
    "maxLeasesSinceErase": 8,
    "maxAgeSeconds": 86400,
    "maxDiskBytes": 8589934592
  }
}
```

`maxDiskBytes` default is 8 GiB. Class membership is capability-based:
`build-fast` with `resetPolicy: none` is `build`; `manual-persistent` is
`manual` even when it also lists `build-fast`. `erase-on-acquire` aliases are
never reclaim candidates. Manual reclaim stays off because those slots hold
human-installed apps and accounts; operators opt in with
`slotReclaim.manual.enabled: true`. Set `slotReclaim.enabled: false` or
`slotReclaim.build.enabled: false` to disable.

Any one threshold is enough: on-disk size at or above `maxDiskBytes`,
`leasesSinceErase` at or above `maxLeasesSinceErase`, or last erase (or last
use when never erased) older than `maxAgeSeconds`. Last use is the newest
parseable timestamp among `lastLeaseReleasedAt`, `lastLeaseStartedAt`, and
`lastBootedAt`. Unused never-booted slots are not age-triggered.

Reclaim takes the broker mutation lock, re-reads leases, and erases only a
free candidate. It runs after a successful release of that alias, at the start
of acquire before the new lease file is written, and during the existing
`brokerd` idle-reconcile loop even when idle policy is unconfigured. A held,
pinned, or mid-acquire slot is skipped. Aliases already `repair-needed` or
`repairing` are skipped and are not marked `healthy` by reclaim. Disk size is
measured only for unheld aliases whose class policy is enabled, using one
shared device listing for that pass. Erase uses the dedicated reset lock,
then records `lastErasedAt`, resets `leasesSinceErase` to `0`, and shuts the
device down. Failure marks the alias `repair-needed` with
`slot-reclaim-failed` and does not retry that alias until repair. Registry
synchronization preserves that reason.

Service-backed acquire, release, idle reconcile, and service startup reserve
that reclaim work before advertising their timeouts. One pass reserves one
shared `simctl list` plus, for each enabled candidate that pass can erase, one
`du`, one shutdown, and one erase, each at the simctl command cap, and the
reset-lock wait plus settle for each erase. Acquire and release reserve at most
one alias. Acquire uses the longer of reset-on-acquire (shutdown, erase, boot,
and `bootstatus`) and reclaim plus that same boot, because those shutdown and
erase paths do not stack. Idle reconcile and startup reserve every enabled
candidate. A missing host config reserves no reclaim time. The starter host
has two enabled build slots, and the budget follows the host file once it
exists. A disabled policy, or a host with no enabled class, reserves none of
this time. The startup allowance is inside `serviceStartupTimeoutMs`, which the
launcher uses before `brokerd` installs its `SIGTERM` handler. A failed `du`
leaves disk size unknown, so only the lease-count and age rules can still
trigger reclaim.

Successful reclaim emits `slot.reclaimed` with alias, class, reason
(`disk` | `leases` | `age`), and source (`lease-release` | `lease-acquire` |
`idle-reconcile`). `host status` and `doctor` include the resolved policy
summary and last reclaim result. The macOS app snapshot may carry extra
per-simulator counters; the app UI is unchanged.

## 8. Capacity check and confirmed reconcile contract

Repos can ask the broker to classify simulator capacity before starting
simulator-dependent work:

```bash
simbroker capacity check --repo-root <repo> [--purpose <purpose-id>] --json
```

The response is public-safe by default. It reports `schemaVersion`, `command`,
overall `status`, `repo.configured`, `repo.projectId`, `host.configured`,
`host.inventoryFresh`, per-purpose reports, and a summary. It must not expose
absolute paths, simulator UUIDs, broker aliases, host IDs, sockets, usernames,
raw `simctl` payloads, or environment values.

Each selected purpose is classified as exactly one of:

- `available`
- `unavailable`
- `repair_needed`
- `setup_missing`
- `unknown`

Successfully reported negative capacity is still exit `0`; the status,
blocking reasons, and recommended action live in JSON. Blocking reasons include
`no-matching-capacity`, `matching-capacity-busy`, `pin-conflict`,
`runtime-not-found`, `device-type-not-found`, `repair-needed`,
`missing-host-config`, `missing-project-file`, and `inventory-unavailable`.

When every structural match is blocked only by `repair-needed`, purpose status
is `repair_needed`, `recommendedAction` is `repair_matching_simulators`, and
the reconcile action kind is null. Reconcile status is `blocked` and the plan
contains no create action. The broker must not plan replacement capacity for
that state. Apply of that blocked plan fails with `capacity-repair-required`
(exit `4`) before mutation. A provisioning blocker, when one is present, keeps
that blocker's recommended action instead of `repair_matching_simulators`.

Reconcile preview is non-mutating:

```bash
simbroker capacity reconcile --repo-root <repo> [--purpose <purpose-id>] --json
```

It deduplicates selected purposes into one action per unique tuple:

```text
capability + deviceFamily + iosVersion + resetPolicy
```

Preview returns `status: no_changes`, `changes_required`, or `blocked`, plus a
deterministic `sha256:` plan ID derived from canonical public action data,
selected project purpose fields, capacity-relevant host config, refreshed
inventory, health, lease, and pin state. Volatile timestamps, paths, PIDs, and
presentation-only fields are excluded from the digest.

Apply is additive only and requires exact current human confirmation:

```bash
simbroker capacity reconcile \
  --repo-root <repo> \
  [--purpose <purpose-id>] \
  --apply \
  --confirm <plan-id> \
  --actor-type human \
  --actor-id <operator-id> \
  --json
```

Apply must reject missing confirmation, stale confirmation, missing actor ID,
and non-human actor type with exit `5` before mutation. It must reject blocked
plans before mutation. These checks use a read-only state snapshot and run
before transaction recovery. Read-only capacity snapshots ignore lease records
whose owner fails the same PID and containment-identity liveness checks used by
the mutating state loader, without reclaiming the lease or writing cleanup
evidence. There is no unattended `--yes`, force flag, stdin confirmation, or
environment-variable bypass in v1.

The broker chooses the additive alias name, display name, device type, newest
compatible stable iOS runtime, and reset policy. Existing aliases, simulator
IDs, leases, pins, deterministic selection state, and reset semantics are never deleted, erased,
repurposed, renamed, or repaired by capacity reconcile. Busy or pinned matching
capacity is non-actionable and never creates extra capacity. Missing runtime or
device type blocks apply instead of downloading or guessing.

Apply runs under the broker mutation authority in direct and service-backed
modes. Guided setup and capacity apply acquire capacity then lease-mutation
locks; host bootstrap and simulator repair share the same host-config mutation
authority. Setup revalidates its canonical plan before adopting or creating any
Simulator and treats the atomic host-config rename as its commit point. Forced
host bootstrap also takes the lease mutation
lock and refuses to replace host config while any live lease or pin is active.
Service-backed timeout budgets for capacity apply must include both forward
simulator creation work and the bounded rollback inventory/delete/verification
work that may run before the host-config commit point.
Apply writes a restrictive local transaction intent before the first simulator
creation. Before each `simctl create`, the transaction records the matching
pre-create simulator IDs for that planned name, device type, and runtime.
Recovery may infer a simulator ID for an interrupted create only when the
matching simulator was absent from that pre-create baseline. The broker creates
all planned simulators through the injected `simctl` adapter boundary, re-reads
the current host config under the lock, merges only the transaction additions,
then commits with an atomic same-directory temp write, file sync, rename, and
parent-directory sync. Before the rename commit point, failures roll back only
simulators created by the transaction and preserve the original host config.
Rollback is complete only after the inventory confirms each transaction-created
simulator is absent.
After the rename commit point, the broker preserves committed devices and
reports `committed_recovery_required` if audit finalization must be retried.

Transactions in `rollback_incomplete` or ambiguous `failed` states remain
recovery-blocking. A later authorized apply retries recovery and must not create
or commit new capacity until the operator-required state has been resolved.

Every apply attempt writes local-only transaction evidence under the broker
state root and emits one terminal event: `capacity.reconcile.applied`,
`capacity.reconcile.no_changes`, `capacity.reconcile.failed`,
`capacity.reconcile.rolled_back`, or
`capacity.reconcile.rollback_incomplete`. Preview and check do not write audit
events or transaction journals.

## 9. Lease-scoped build/test containment contract

Broker-managed build/test leases must be safe even when the consumer app, `xcodebuild`, or simulator-launched test host is defective. Containment is lease-scoped only; the broker must not become a generic host process killer.

Runtime metadata is optional; broker-aware wrappers should record it before downstream simulator work starts:

- lease owner PID and process group
- downstream command PID and process group
- downstream command string
- simulator UDID already assigned to the lease
- project id, purpose id, actor id, job id, and job kind already assigned to the lease
- memory ceiling in bytes when the wrapper wants active memory protection
- monitor interval in milliseconds
- simulator app or test-host process names that may detach from the wrapper process tree
- evidence root, preferably inside the run or session artifact directory

The broker discovers lease-owned processes from these sources:

- exact owner PID and downstream command PID
- descendants of the owner or downstream command
- downstream process group when that group is distinct from a known owner process group
- simulator-like processes whose command line includes the leased simulator UDID and a configured or derived simulator process name

Memory ceiling checks must sum the RSS of all discovered lease-owned processes, including detached simulator-like app or test-host processes. When the ceiling is not breached, the broker records a `runtime.lastObservation` sample and leaves the lease active.

On `memory-ceiling`, `forced-abort`, `timeout`, `stale-owner`, or `manual-cleanup` containment, the broker must run under the broker lease mutation lock and:

1. Capture an evidence bundle before termination.
2. Terminate only lease-owned downstream PIDs, process groups, and simulator-like processes.
3. Avoid unrelated manual/UI simulator processes and other leases.
4. Escalate from `SIGTERM` to `SIGKILL` only for owned PIDs that were selected for cleanup.
5. Remove the lease file and emitted lease artifact only after cleanup completes without hard kill failures and without remaining lease-owned PIDs other than explicitly skipped owner/requester/current-broker PIDs.
6. Clear the registry active lease and write `lastLeaseReleasedAt` only for that completed-cleanup path.
7. Keep the lease active, preserve the registry holder, write the failed containment observation, and return a containment failure when any kill action reports a non-`ESRCH` error or lease-owned work still remains after cleanup.
8. Emit `lease.contained` with reason, evidence path, killed PIDs, skipped lease-adjacent PIDs, and RSS summary only for the completed-cleanup path.

The evidence bundle must be a directory under the lease evidence root and include:

- `lease.json`
- `processes-before.txt`
- `process-tree-before.txt`
- `broker-status-before.json`
- optional `vmmap-summary-<pid>.txt`
- optional `sample-<pid>.txt`
- `cleanup-actions.json`
- `processes-after.txt`
- `broker-status-after.json`
- `summary.json`

`summary.json` must include reason, lease id, alias, simulator id, project id, purpose id, actor id, job id, owner metadata, killed PIDs, skipped lease-adjacent PIDs, command, selected tests when visible, and RSS totals.

Stale owner reclaim must preserve the existing `lease.reclaimed` behavior for legacy leases without process metadata. If a stale lease has registered process metadata or a memory ceiling, stale reclaim must run containment and emit `lease.contained` instead of silently deleting the lease JSON.

## 10. Public-source completion criteria for this repo

This repo is ready for public-source collaboration only if:

- specs exist and define the extraction direction
- copied product seed material is absent from the public tree
- public examples demonstrate adoption patterns without private product data
- agent harness commands run in this repo
- shared skills resolve from the managed-global baseline and project-specific
  skills remain available under `.agents/skills/`
- a fresh agent can begin here without opening a private product repo first
- `verify:public-surface` runs in the normal gate, scans tracked text for real
  home paths and prohibited local artifacts, and supports an ignored
  `.public-safety.local` operator denylist without disclosing matched values
- public tests use temporary broker roots and synthetic identities, never the
  default broker state root

## 11. Remaining implementation detail

- implementation may still choose internal type names and module boundaries, but the external contract above is fixed for v1

## 12. Document History

| Version | Date | Summary |
| --- | --- | --- |
| 0.19.0 | 2026-10-23 | Added alias and purpose simulator delete, persisted `driftCauseCode`, and the agent follow-up that deletes only unowned `runtime-not-found` or `device-type-not-found` matches. |
| 0.18.2 | 2026-10-21 | Reserved `simctl list`, `du`, shutdown, erase, and reset-lock time for build-slot reclaim in the acquire, release, idle-reconcile, and service-startup budgets. |
| 0.18.1 | 2026-10-21 | Preserved `slot-reclaim-failed` across registry sync, skipped reclaim for repair-latched aliases, aged never-erased slots from the newest use timestamp, and limited disk measurement to enabled candidates. |
| 0.18.0 | 2026-10-21 | Added between-lease disk reclaim for build slots, with host-config policy defaults, manual opt-in, and `slot.reclaimed` events. |
| 0.17.0 | 2026-10-05 | Added purpose-scoped repair for agents and CI, pointed sole repair-needed capacity at that command, and stopped treating an in-progress boot or shutdown as a new repair-needed failure. |
| 0.16.8 | 2026-09-01 | Required `project init` to carry caller-resolved repository identity across direct and resident-service dispatch, including repeat-init recovery and the intentionally redacted capacity response. |
| 0.16.7 | 2026-08-31 | App restart-required status requires canonical exit code `3`, queued refreshes retain lifecycle ownership, and missing-host probe failures clear stale live-service authority while remaining onboarding. |
| 0.16.6 | 2026-08-30 | Lifecycle cancellation preserves cached authority, service transitions invalidate stale setup, setup recovery cannot restart after stop, and path-qualified unverified guidance remains visible. |
| 0.16.5 | 2026-08-30 | App distinguishes exact verified live runtime incompatibility from generic unverified status and offers cooperative restart without command authority. |
| 0.16.4 | 2026-08-30 | Service identity changes invalidate pending mutations, confirmed absence survives snapshot corruption, and setup cancellation refreshes outside the cancelled task. |
| 0.16.3 | 2026-08-30 | Service probe failures remain unverified, stale responses cannot publish confirmations, and known missing-host state remains onboarding. |
| 0.16.2 | 2026-08-30 | Refresh-failure fail-closed represents unverified service status independently of snapshot availability, cancels pending mutation/setup previews and confirmations, and does not interrupt setup already applying. |
| 0.16.1 | 2026-08-30 | Guided setup treats a live unhealthy daemon as finishing work (`start`, not `ready`/`keep`) and honors cancellation while replacing it. |
| 0.16.0 | 2026-08-30 | Added fail-closed daemon runtime health, exact client/daemon version compatibility, and explicit state-preserving restart recovery. |
| 0.15.1 | 2026-08-24 | Clarified that guided setup apply timeout covers bounded rollback as well as provisioning and finishing stages. |
| 0.15.0 | 2026-08-22 | Added the shared guided setup/runtime/confirmation/recovery/app contract and version-agnostic project scaffolding default. |
| 0.14.1 | 2026-08-18 | Help and doctor default to human-readable text; `--json` keeps the stable machine payload. |
| 0.14.0 | 2026-08-10 | Replaced lease rotation with deterministic warm reuse, required boot-on-acquire, and added opt-in public-safe idle lifecycle, scheduler, cleanup, app, and verification contracts. |
| 0.13.13 | 2026-08-10 | Added locked, explicit, idempotent cleanup for inactive local project registrations with lease/pin conflict protection and snapshot refresh. |
| 0.13.12 | 2026-08-04 | Clarified startup-lock sampler timeout coverage, per-state-load stale containment budget retries, deterministic snapshot host-config fixtures, and non-remediable erase conflicts. |
| 0.13.11 | 2026-08-03 | Clarified stale containment timeout budgets, startup-lock PID lifetime validation, snapshot host-config identity, and repair-only live-holder overrides. |
| 0.13.7 | 2026-08-03 | Clarified unknown flag rejection before destructive commands, explicit containment diagnostic booleans, capacity-check inventory budgets, serialized final app snapshot writers, and command-specific app setup timeouts. |
| 0.13.6 | 2026-08-03 | Clarified request-scoped dispatch budget recomputation, reset-on-acquire and serialized-read timeout coverage, starter alias runtime lookup budgets, and simctl-timeout final snapshot failures. |
| 0.13.5 | 2026-08-03 | Clarified dispatch-time service budget recomputation, host bootstrap service budgets, capacity rollback budget coverage, and contract-bearing final snapshot failures. |
| 0.13.4 | 2026-08-03 | Clarified service command queue expiry and bounded process inventory sampling. |
| 0.13.3 | 2026-08-03 | Clarified repair retirement retry, startup readiness, UTF-8-safe tail reads, and app refresh failure preservation. |
| 0.13.2 | 2026-08-03 | Clarified first-write replacement retirements, service stop identity validation, bounded simctl execution, and bounded recent-event reads. |
| 0.13.1 | 2026-08-03 | Clarified atomic service command identity validation. |
| 0.13.0 | 2026-08-01 | Clarified service identity validation, bootstrap rollback, final host refresh serialization, lease artifact rollback, and event follow poll validation. |
| 0.12.0 | 2026-08-01 | Clarified lease artifact protection, serialized status refresh, active lease reference authorization, and capacity pre-create recovery baselines. |
| 0.11.0 | 2026-07-30 | Removed copied product seed references from the public-source contract and retained the broker invariants as generic baseline behavior. |
| 0.10.0 | 2026-07-20 | Added public-safe capacity check, deterministic reconcile preview, human-confirmed additive apply, transaction safety, and audit event contract. |
