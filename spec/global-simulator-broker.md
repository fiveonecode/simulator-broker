# Global Simulator Broker
Related: `spec/README.md`, `spec/architecture.md`, `spec/implementation-plan.md`, `spec/build-and-test.md`, `spec/project-structure.md`, `spec/tasks/public-safe-on-demand-simulator-lifecycle.md`, `references/README.md`

> **Document ID:** `GSB-001`
> **Version:** `0.14.1`
> **Last Updated:** `2026-08-18`
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
- registry synchronization against `simctl` so missing, unavailable, or mismatched simulators become `repair-needed`
- reset-on-acquire coordination behind a dedicated reset lock with rollback on reset failure
- boot-on-acquire with lease rollback and `repair-needed` state on boot failure
- policy-driven idle shutdown under the mutation lock, with stale recovery
  starting a fresh grace period and shutdown failures becoming repair-needed

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
- service-backed command requests may carry an `expectedServiceIdentity` object, and `brokerd` must compare its host config path, state root, and socket path to the live daemon metadata immediately before command dispatch
- service-backed command requests may carry client request-start, queue-timeout, and execution-timeout budget fields; `brokerd` must reject a request whose queue budget has already expired, or whose recomputed dispatch-time execution budget exceeds the client-advertised execution budget, before dispatching the broker command; dispatch-time recomputation must use the request project file path when the command carries one
- service stop requests may carry the same `expectedServiceIdentity` object, and `brokerd` must validate it before acknowledging shutdown
- service stop closes active event streams before shutdown completes
- malformed JSON from a running service is reported as service unavailability by clients instead of escaping as an uncaught parser failure
- service startup must not publish a listenable socket or service metadata until the initial broker-owned app snapshot refresh has completed or explicitly reported a missing-host setup state; the CLI start launcher must wait within the bounded startup snapshot budget for one shared process-table sample, startup-lock owner PID lifetime sampling, and all inventory commands, validate startup-lock owner PID lifetime before accepting an old lock as live, and terminate the spawned daemon on startup timeout
- service-backed timeout budgets must reserve one shared process-table sample per broker state load; stale-lease containment process samples discovered from lease files before command dispatch for every broker state load that can retry containment; serialized read lock waits for `host status`, `doctor`, and `lease explain`; final app snapshot lock waits for every command that publishes the shared app snapshot artifact; capacity check inventory reads; lease acquire reset `simctl` shutdown/erase work plus boot readiness wait; explicit simulator boot readiness wait; and host bootstrap runtime lookup, baseline inventory, starter-alias provisioning, replacement-retirement, and final snapshot refresh work before the transport timeout is advertised
- broker-mediated lifecycle-control requests for `boot`, `shutdown`, `erase`, and `repair`
- command transport consumed by the macOS app for broker-backed operator actions
- service-backed commands observing the same real `simctl`-synchronized alias health and repair state as direct CLI mode
- immediate idle reconciliation before the startup snapshot, non-overlapping
  reconciliation every 30 seconds, and snapshot refresh after every timer run

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
- `doctor`
- `service start`, `service status`, and `service stop`
- automatic service routing when `brokerd` is available
- `simulators boot`, `simulators shutdown`, `simulators erase`, and `simulators repair`
- `idle status`, human-attributed `idle enable` and `idle disable`, immediate
  `idle reconcile`, and count-only `idle cleanup` preview plus confirmed apply
- policy-enabled normal lease acquisition lazily starts `brokerd` when needed;
  explicit local-only mode remains unscheduled and reports that limitation
- command option parsing rejects unknown flags before dispatch for lifecycle commands, lease acquire/register/contain/release, capacity commands, service control, event watches, pin mutations, and host initialization so misspelled state or routing flags cannot fall through to defaults before a destructive operation
- boolean option parsing honors explicit `false` and rejects unsupported values for command-shaping booleans, including lease containment diagnostic capture and owner-kill controls
- stable non-zero exit codes shared by direct CLI mode and service-backed CLI mode
- local install, package, and smoke scripts under `scripts/`

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
- broker-backed actions for pin create and clear, lease release, and lifecycle requests with human override confirmation
- Overview **Automatic shutdown** status and broker-backed Apply, Disable, and
  count-confirmed cleanup actions; unconfigured policy leaves duration blank
- first-run setup classification for missing CLI, missing host config, stopped service, and snapshot-refresh states
- app-driven host bootstrap, service start, and snapshot refresh through bounded, cancellation-aware installed `simbroker` CLI subprocesses without creating an app-only mutation path; the app runner uses command-specific setup budgets that include preliminary service probe transfer, command transfer, service queue allowance, startup snapshot process sampling and inventory, and launcher headroom, and bounds process-tree discovery during cancellation before falling back to root-process signaling
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
- erase and repair

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
- only humans may force-override another live holder for urgent repair
- human-forced repair overrides must include `forceOverride`, `overrideReason`, `expectedAlias`, and `expectedLeaseId`
- direct out-of-band boot or shutdown is observable drift but not automatically blocking when alias identity is intact
- destructive or identity-changing out-of-band drift is blocking until repair completes
- broker health states are `healthy`, `state-drift`, `repair-needed`, and `repairing`
- local project-registration cleanup must use the broker-owned `project forget --project-id <id>` command rather than editing broker state files; it may remove only an explicit registration with no active lease or pin, records a global `project.forgotten` audit event that does not itself restore the removed project to the Projects read model, and refreshes the shared app snapshot

Failure-contract defaults for v1:

- exit code `0` means success
- exit code `2` means invalid request or setup failure, including malformed flags, unknown commands, invalid config, or missing broker files
- exit code `3` means unavailable capacity or transient broker-side unavailability, including exhaustion, conflicts, missing runtimes, service unavailability, expired service command queue budgets, or bounded process-sampler timeouts
- exit code `4` means the requested alias needs repair before work can proceed
- exit code `5` means human override or override confirmation is required before the action may continue
- exit code `1` means internal failure or an unclassified unexpected error
- service responses must carry the same `exitCode` value in their JSON error payloads
- clients must classify malformed service JSON as `service-unavailable`
- clients must reject non-positive `events watch --follow --poll-interval-ms` values as malformed flags
- recent-event reads used for app snapshots must avoid parsing the full historical event log when only a bounded tail is requested and must preserve UTF-8 text when multibyte characters cross internal read chunk boundaries
- app mutation flows must not clear or overwrite snapshot refresh errors after a successful broker mutation; a mutation is user-visible success only after the follow-up snapshot refresh succeeds or is superseded by a newer successful refresh
- service HTTP status classes should stay aligned with the same failure groups: `400` invalid request, `404` unknown route, `409` unavailable or conflict, `412` override-required, `423` repair-needed, and `500` internal failure

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
grace. Unknown externally booted devices remain untouched. Shutdown failure
marks the alias `repair-needed` with `idle-shutdown-failed`, so the scheduler
does not repeatedly retry it.

`brokerd` reconciles immediately at startup and every 30 seconds thereafter,
without overlapping runs, and refreshes the app snapshot after each run. A
policy-enabled normal acquisition lazily starts `brokerd` when it is absent.
Explicit local-only mode never schedules work and reports `local-only-mode`.

Events and snapshots summarize configuration state, grace duration, eligible
count, last cleanup result, and next scheduled cleanup. Idle and cleanup
summaries must not return local paths, aliases, simulator IDs, operator IDs, or
raw runtime errors.

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
modes. Capacity apply, host bootstrap, and simulator repair share the same
host-config mutation lock. Forced host bootstrap also takes the lease mutation
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
- useful skills are available locally in `.agents/skills/`
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
