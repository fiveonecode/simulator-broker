# Guided `simbroker setup`

> **Document ID:** `GSB-SETUP-001`
> **Version:** `1.0.16`
> **Last Updated:** `2026-08-28`
> **Status:** `Active`
> **Owner:** `spec-steward`, `ios-dev`
> **Target:** Next Alpha PR

Related: `spec/global-simulator-broker.md`, `spec/architecture.md`, `spec/build-and-test.md`, `spec/project-structure.md`, `docs/getting-started.md`

## 1. Objective and success criteria

New users need one safe, obvious machine-setup flow instead of discovering and
sequencing host bootstrap, service startup, snapshot refresh, and doctor
commands. The CLI and macOS app must share one authoritative setup plan and
confirmed apply contract.

Success is one `simbroker setup` invocation, one human confirmation, six healthy
starter aliases, a running path-verified `brokerd`, a current app snapshot, and
an idempotent rerun that creates no duplicate devices.

## 2. Scope and non-goals

### In scope

- bounded prerequisite inspection for Node.js 20+, macOS 14+, full Xcode,
  first-launch completion, `simctl`, installed runtimes/inventory, searchable
  writable directory destinations, and informational disk availability
- newest-compatible or explicitly selected installed iOS runtime
- deterministic six-device create/reuse preview and plan ID
- lock-scoped confirmed provisioning, atomic host commit, rollback, recovery,
  service startup, snapshot refresh, and doctor verification
- one shared CLI contract consumed by the macOS app
- version-agnostic default project scaffolding
- public docs, install/package smoke, deterministic tests, and visual evidence

### Out of scope

- downloading Xcode or runtimes automatically
- running `sudo`, accepting licenses, or completing Xcode first-launch work
- automatically replacing or repairing an unhealthy existing host
- creating consumer repo configuration during machine setup
- removing or changing the iOS 18 default of `host init --bootstrap-config`
- migrating committed project files, public-CI performance work, or npm publish

## 3. Functional requirements

### REQ-001 — Command and flag surface

The public forms are:

```text
simbroker setup [--ios-version <major|exact>] [--host-id <id>] [--json]
simbroker setup --apply --confirm <plan-id> [--ios-version <major|exact>] [--host-id <id>] [--json]
```

`--host-config`, `--state-root`, and `--service-socket` remain valid path
overrides. Setup rejects project/repo flags, `--force`, `--yes`, unknown flags,
`--confirm` without `--apply`, and apply without current confirmation. Legacy
host init is unchanged and documented only as advanced/troubleshooting.

### REQ-002 — Invocation modes

- Interactive fresh setup prints the read-only preview, prompts exactly
  `Create or adopt these 6 Simulator devices and finish setup? [y/N]`, applies
  on yes, and returns successful `cancelled` without mutation on no or EOF.
- Interactive existing healthy setup automatically performs only safe finishing
  work (service, snapshot, health) without a device-creation prompt. `ready`
  requires a current snapshot whose mtime is at least as new as host-config,
  registry, known-projects, lease/pin JSON, and the lease/pin directories.
  Those files must be readable valid records, not merely parseable JSON.
  Newer valid records and deletions of known-projects, lease, or pin records
  are finishing work, not `ready`. The snapshot is not fresh if its recorded
  lease, pin, or catalog-backed project identities are not the same set as the
  current files, or if the snapshot simulator alias set is not exactly the
  current host alias set with matching Simulator IDs.
- Non-TTY preview never prompts or mutates and prints a copyable apply command.
- `--json` preview never prompts or mutates and emits exactly one JSON document.
- Confirmed apply never prompts, recomputes under locks, and emits one human
  report or JSON document.

### REQ-003 — Prerequisites

Before planning, setup performs bounded, read-only checks:

1. Node.js is 20 or newer.
2. Platform is macOS 14 or newer.
3. `xcode-select -p` resolves to a full Xcode developer directory.
4. `xcodebuild -checkFirstLaunchStatus` succeeds.
5. `xcrun --find simctl` succeeds.
6. `simctl list --json runtimes`, `devices`, and `devicetypes` are valid.
7. One available iOS runtime supports both starter families.
8. Nearest existing host-config/state-root ancestors are searchable, writable
   directories. Occupancy is the directory entry itself (`lstat`), so a dangling
   symlink is occupied rather than treated as missing. An existing state root
   must itself be a directory. An existing host-config path must be a readable
   regular file; a directory, FIFO, dangling symlink, or other non-file is a
   host-config path blocker, not a Simulator inventory failure.
9. Disk availability is reported as bytes and formatted GiB when supported.

Setup never executes the remediation commands. Blockers provide exact manual
commands, including Xcode selection, `xcodebuild -runFirstLaunch`, Xcode
Settings > Components, or `xcodebuild -downloadPlatform iOS`. Path-access
blockers advertise a shell-safe `chmod` for the path and bits that actually
failed: `u+rw` for an existing host-config file that is not readable and
writable, and `u+wx` for a parent or destination directory that is not
searchable and writable. Disk is `info`,
is never blocking, and is excluded from the plan fingerprint.

The Xcode command contract is grounded in installed Xcode help when an official
documentation connector is unavailable: `xcodebuild -checkFirstLaunchStatus`,
`xcodebuild -runFirstLaunch`, `xcodebuild -downloadPlatform`, `xcrun --find
simctl`, and `xcrun simctl list --json`.

### REQ-004 — Runtime policy

Without override, choose the numerically newest available iOS runtime that
supports both iPhone and iPad starter types. `--ios-version 26` chooses newest
compatible 26.x; `26.4` chooses exactly 26.4. Ignore unavailable and non-iOS
runtimes, and ignore runtime records that omit a non-empty `version` string
even when `--ios-version` is unset. An incomplete selected runtime is not a
confirmable plan. Ignore device-type records that omit a non-empty `identifier`
or `name` even when they still report a product family. An incomplete selected
device type is not a confirmable plan. Sort numeric version, build version, then
identifier deterministically.
When a runtime record omits `supportedDeviceTypes` or the array is empty, derive
family compatibility and preferred starter types from the separately collected
`devicetypes` inventory, matching capacity planning. No qualifying runtime
produces a blocked preview with manual install guidance.

### REQ-005 — Starter device plan

| Alias | Family | Capabilities | Reset policy |
|---|---|---|---|
| `manual-1` | iPhone | `manual-persistent` | `none` |
| `ui-1` | iPhone | `interactive-resettable`, `automation-resettable` | `erase-on-acquire` |
| `ui-2` | iPhone | `interactive-resettable`, `automation-resettable` | `erase-on-acquire` |
| `build-1` | iPhone | `build-fast` | `none` |
| `build-2` | iPhone | `build-fast` | `none` |
| `ipad-1` | iPad | `interactive-resettable` | `erase-on-acquire` |

Existing preferred-device-type rules are reused. When no preferred name
matches, fallback candidates are sorted by identifier then name so equivalent
inventory order cannot change the selected type or plan ID. A Simulator is
`reuse` only when broker name, runtime identifier, and device type identifier
all match. Same-named incompatible devices are never adopted.

### REQ-006 — Deterministic confirmation

The SHA-256 plan ID canonicalizes schema version, requested host ID,
host-config existence/relevant digest, selected runtime identifier/version/build,
selected device type IDs, all target alias definitions/names, matching reusable
identities, and create/reuse actions. For an existing host, the fingerprint still
includes the requested `--host-id`; an explicit ID that does not match the
configured host is blocked. It excludes timestamps, disk, formatting,
service state, and unrelated inventory. Equivalent inventory order and duplicate
records cannot change the ID.

Apply acquires the capacity lock, then lease-mutation lock, rereads relevant
state, recomputes, rejects stale confirmation before mutation, and applies only
that plan. The setup-specific capacity-lock wait covers the bounded provisioning
budget so a concurrent loser reaches revalidation and returns `setup-plan-stale`
after the winner commits. Host-init and setup provisioning share rollback
helpers without nested lock acquisition or time-of-check/time-of-use gaps.

### REQ-007 — Apply and verification

Apply performs, in order:

1. confirmation revalidation under locks
2. exact create/reuse of six devices
3. atomic complete host-config commit
4. registry initialization/refresh
5. provisioning lock release
6. `brokerd` start or identity validation
7. fresh snapshot through the active service
8. doctor through the active service
9. post-doctor snapshot revalidation of path identity, the exact committed host ID and
   alias-to-Simulator-ID mapping, expected fresh aliases, matching available
   Simulator records, no `repair-needed`/`repairing`, and snapshot path identity
10. `ready` completion

### REQ-008 — Failure and recovery

- Before host commit, delete only devices created by that attempt; preserve
  reused/external devices and leave no claiming host/registry state.
- After host commit, preserve host and devices; rerun `simbroker setup` with
  the same selected `--host-config`, `--state-root`, and `--service-socket`
  paths, shell-quoted. Before host commit, the advertised recovery command also
  keeps any explicit `--host-id` and `--ios-version` selections so retry does
  not silently change the requested host or runtime. When the host commit
  succeeded but initial registry persistence did not, setup previews registry
  initialization as safe finishing
  work only when the host is attributable to the canonical starter shape, every
  alias records the exact runtime version used by its Simulator, every Simulator
  uses the setup-selected runtime and device type, and no lease, pin, or pending
  retirement state exists, then reconstructs it from the committed host and
  Simulator state during apply.
- Service failure preserves host and reports log path and exact retry.
- Health failure preserves host/service and reports doctor issues plus exact
  per-alias repair commands. Those health-failure repair commands include the
  selected `--host-config`, `--state-root`, and `--service-socket` paths.
- Existing invalid/unhealthy host is blocked without repair/replacement,
  lease/pin mutation, or retirement. Invalid known-projects, registry, or
  lease/pin JSON is the same class of existing-host failure: diagnose with
  `simbroker doctor`, do not report `ready`. Valid JSON that is not a complete
  lease or pin identity record, such as `{}`, a lease with only `leaseId` and
  `alias`, a live lease that omits snapshot-required fields such as
  `displayName`, `leaseKind`, `projectName`, or `repoRoot`, or a pin that has
  `pinId` and `alias` but omits `projectId`, `projectName`, `actorId`,
  `actorType`, `createdAt`, or `repoRoot`, is invalid existing-host state.
  Present optional snapshot fields on an otherwise complete lease or pin, such
  as `jobId`, `note`, or `purposeId`, must be strings when present; a numeric
  or otherwise mistyped optional field is the same class of invalid
  existing-host state.
  A live lease `ownerPid` must be a JSON number that is a positive integer in
  the safe integer range (`1` through `9007199254740991`) so the macOS app can
  decode it as `Int`; a numeric string such as `"123"` or a larger JSON number
  that would round or fail Swift `Int` decoding is the same class of invalid
  existing-host state and must not be coerced into a ready snapshot.
  A complete lease whose `alias` is missing from the host, whose `simulatorId`
  does not match that host alias, or that shares an alias with another lease
  file is the same class of invalid existing-host state.
  Persisted registry alias data that is schema-invalid, such as an
  unrecognized `health` or `powerState` value or an alias map that contains none of the
  configured host aliases, is also invalid; setup must not normalize it into a
  `ready` host. A known-projects catalog key that disagrees with that record's
  `projectId` is the same class of invalid existing-host state. Setup does not
  treat a missing host-config as a confirmable fresh plan when the selected
  state root already contains a registry path of any type, a JSON-named
  lease/pin directory entry of any type, or an existing known-projects catalog
  that cannot be loaded as a valid catalog. Occupancy of `registry.json` and
  `known-projects.json` uses the directory entry itself (`lstat`), so a
  dangling symlink is occupied rather than treated as missing.
  Blocked-preview doctor, repair, and
  setup remediation commands include the selected `--host-config`,
  `--state-root`, and `--service-socket` paths.
- Preview probes the requested service socket even when no host is configured
  yet. Confirmed apply revalidates that same socket identity before the
  provisioning worker mutates host or devices. A running broker with a
  different host-config, state-root, or socket identity is a `service-identity`
  blocker and is not confirmable, so apply cannot create devices before
  `startService` discovers the mismatch.
- Existing healthy host is never replaced or expanded to six.
- Lock/revalidation guarantees concurrent setup creates at most one host; the
  loser gets `setup-plan-stale`.
- First SIGINT/SIGTERM is cooperative during Simulator operations, service
  startup, snapshot refresh, and doctor verification, with exits 130/143;
  post-commit state is preserved. A second termination may force exit. The
  app Stop/timeout SIGTERM window covers one in-flight Simulator command,
  the three-command rollback attribution inventory, the additional inventory
  after an indeterminate create failure, and up to six rollback deletes.

No setup-session file is persisted. Recovery derives from host config,
Simulator inventory, service metadata, snapshot, and doctor.

### REQ-009 — macOS app

The app invokes `simbroker setup --json`. A fresh plan uses `sheet(item:)` and
shows prerequisites, runtime/build, disk, six identifiable value-type rows,
plain-language reset behavior, Create/Reuse state, finish stages, and “No
changes have been made yet.” Actions are Cancel and a count-adjusted Create &
Finish button. Apply passes exact plan ID plus the same runtime, host, and path
selection. For an already configured host, the app omits `--host-id` so core
setup does not slugify the existing ID and block finishing. `--host-id` is
passed only for an unconfigured/create plan (the previewed ID) or an actual
user-selected host override.

Service/snapshot-only plans apply immediately without a device sheet.
Automatic finishing progress is tracked on the dashboard without presenting
the first-time review sheet. Blocked plans show commands and no enabled
confirm. Success refreshes to the dashboard and says: `Setup complete —
brokerd is running and all managed simulators are healthy.` A preview that
is already `ready` refreshes the current snapshot before reporting that
success, matching confirmed apply. Failure of a confirmable plan refreshes
first, preserves the sheet, and shows completed stages and recovery.
Automatic finishing failure stays off the sheet and surfaces the recovery
error on the dashboard. The read-only snapshot `Finish setup` action is hidden
while setup is applying so an in-progress run can only be stopped through Stop.
Displayed setup failures include the CLI `logPath`, `doctorIssues` including
per-issue `remediationCommands` when present, and incomplete rollback count
when those fields are present.

The app accepts only setup schema version 1 and rejects a future or otherwise
unsupported version before presenting or applying its plan. The `@MainActor
@Observable` store owns setup plan, phase, pending confirmation,
and one stored task. Starting cancels the prior task; double confirm is
prevented. Applying disables interactive dismissal and exposes text-labelled
Stop, which cancels the CLI process. `CancellationError` is not a user failure.
The sheet scrolls, uses semantic styles, default/cancel keyboard actions,
VoiceOver labels, and status text/icons rather than color alone. Setup receives
a full bounded timeout, not the 30-second unknown-command timeout. The app never
calls `simctl` or writes broker state directly.

### REQ-010 — Project onboarding compatibility

Default UI purposes generated by `project init` require only:

```json
{ "deviceFamily": "iPhone" }
```

`iosVersion` is present only when `--ios-version` is explicit. Existing files
are not migrated. Explicit major/exact semantics are unchanged. Successful
setup ends with:

```text
Next, from a repository:
  simbroker project init
  simbroker project validate
```

### REQ-011 — Distribution metadata

Formula and cask require macOS 14 Sonoma, matching the app deployment target.
No third-party dependency is added.

## 4. Public data contracts

### Preview schema version 1

```json
{
  "ok": true,
  "command": "setup",
  "schemaVersion": 1,
  "mode": "preview",
  "status": "changes_required",
  "planId": "sha256:…",
  "prerequisites": [],
  "host": {},
  "runtime": {},
  "devices": [],
  "service": {},
  "confirmation": {},
  "nextSteps": []
}
```

Status is `ready`, `changes_required`, or `blocked`. Prerequisites carry `id`,
`ready|blocked|info`, summary, optional details, and remediation commands. Host
reports existence/action/ID. Fresh runtime reports selection source, identifier,
version, and optional build. Devices report alias/display/family/type/runtime,
capabilities/reset/action. Service reports running/action. Confirmation reports
required and create/reuse counts. Next steps carry recovery or repo onboarding.

### Completion schema version 1

```json
{
  "ok": true,
  "command": "setup",
  "schemaVersion": 1,
  "mode": "apply",
  "status": "ready",
  "planId": "sha256:…",
  "host": { "configured": true, "created": true },
  "devices": { "total": 6, "created": 6, "reused": 0 },
  "service": { "running": true, "started": true, "identityVerified": true },
  "snapshot": { "ready": true },
  "health": { "ok": true, "issueCount": 0 },
  "nextSteps": []
}
```

Human output omits private Simulator IDs. JSON may carry machine-local IDs only
where deterministic local tooling needs them.

### Error contract

| Reason | Exit |
|---|---:|
| `setup-confirmation-required` | 5 |
| `setup-plan-stale` | 5 |
| `setup-prerequisite-failed` | 3 |
| `setup-health-check-failed` | 3, or 4 with unhealthy alias |
| `setup-committed-host-mismatch` | 1 |
| `setup-interrupted` | 130/143 |

Existing runtime, type, service identity/timeout, invalid config, and unhealthy
alias codes remain valid. Setup errors include failed/completed stages, host
commit state, service state, exact recovery command, public-safe doctor
issues, service log path, and incomplete rollback counts. The macOS app
decodes those diagnostic fields into the displayed setup error. JSON stdout is
exactly one document with no progress/prompt text.

## 5. State transitions

```text
unconfigured --preview--> changes_required --confirmed/locks--> provisioning
provisioning --pre-commit failure/cancel--> unconfigured (created devices rolled back)
provisioning --host commit--> configured --service/snapshot/doctor--> ready
configured --later-stage failure--> configured (rerun setup)
ready --rerun--> verified ready (no device creation)
invalid|unhealthy existing --preview--> blocked (diagnosis only)
```

Host config is the commit point. No leases, pins, unrelated Simulator records,
or reused devices are setup rollback targets.

## 6. Non-functional and security requirements

- Every external command and lock wait is bounded; setup apply timeout covers
  preflight, inventory, six creates, concurrent provisioning contention,
  bounded rollback, service, snapshot, and doctor, and the app uses the same
  cooperative escalation window on timeout as on cancellation, including
  rollback and indeterminate-create inventory commands.
- Canonical planning is deterministic and idempotent under inventory reorder.
- Host/state artifacts remain current-user restricted and machine-local.
- Output, specs, fixtures, screenshots, and commits remain public-safe; no
  credentials, private paths, or machine IDs appear in committed evidence.
- No network request or privilege escalation occurs during setup.
- Observability uses stage-specific CLI errors and app `Setup` logs without
  recording private Simulator IDs in normal human output.

## 7. Implementation map and rollout

- `broker-core/index.mjs`: plan, fingerprint, shared provisioning, locks,
  rollback, project default
- `broker-core/error-contract.mjs`: setup exit mapping
- `client/setup-preflight.mjs`: machine prerequisites and disk information
- `client/bin/simbroker.mjs`, `client/command-dispatch.mjs`: interaction,
  service/snapshot/doctor completion, formatting, signals
- `app/Sources/BrokerSetupModels.swift`, `SetupPlan*`,
  `BrokerDashboardStore.swift`: app decode/presentation/task lifecycle
- `scripts/install_smoke.sh`: isolated preview/apply/rerun proof
- public docs/specs/tests: newcomer and compatibility contract

Rollout is additive. Legacy low-level commands remain. Rollback is reverting
the new command/app surface; setup-created machine state remains valid ordinary
broker state and is not automatically destroyed.

## 8. Verification traceability

| Requirement | Deterministic proof |
|---|---|
| REQ-001–002 | CLI help/strict flags, TTY/non-TTY/JSON tests |
| REQ-003–004 | setup-preflight and broker-core runtime selection tests |
| REQ-005–006 | six-row/reuse/fingerprint/stale-plan core tests |
| REQ-007–008 | core rollback/interruption/post-commit tests and CLI service fixture flow |
| REQ-009 | app decoding/store/timeout/cancellation tests plus strict screenshots |
| REQ-010 | core/CLI scaffold tests, docs guard, install smoke |
| REQ-011 | docs distribution metadata assertions |

Required gates are `test:broker-core`, `test:client`, `test:docs`,
`test:harness-adoption`, `test:app`, `test:install-smoke`,
`test:package-smoke`, `verify:public-surface`, `script/build_and_run.sh
--verify`, harness profiles `implementation` and `spec-only`, and
`agent:complete`.

Visual scenarios are fresh plan light/dark, missing-runtime blocked, ready
dashboard, full window, and tight sheet. Approval requires correct state, all
six rows or obvious scroll/summary affordance, runtime/warning copy, no clipping,
readable contrast, keyboard actions, and no color-only status.

## 9. Risks and decisions

- Inventory drift is mitigated by lock-scoped plan recomputation.
- Partial provisioning is mitigated by baseline/name-aware pre-commit rollback.
- Post-commit uncertainty is mitigated by preservation and idempotent rerun.
- App process cancellation is bridged to CLI termination and refresh-on-cancel.
- Long smoke runs isolate paths and delete only devices absent from the baseline.

All product choices are locked; there are no open questions.

## 10. Completion criteria

Done requires all mapped automated and visual proofs passing, documented
artifacts, structured public-safe commit(s), clean worktree, populated
long-running plan/handoff/evaluation, and a passing `agent:complete`.

## Document history

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0.16 | 2026-08-28 | `spec-steward`, `ios-dev` | Fail closed on lease/host simulator disagreement, duplicate lease aliases, extra snapshot simulator rows, and dangling registry/known-projects occupancy during setup |
| 1.0.15 | 2026-08-28 | `spec-steward`, `ios-dev` | Fail closed on incomplete setup device-type records, dangling host-config occupancy, and an invalid known-projects catalog during fresh provisioning |
| 1.0.14 | 2026-08-28 | `spec-steward`, `ios-dev` | Fail closed on version-less selected runtimes and `ownerPid` values outside the safe integer range |
| 1.0.13 | 2026-08-28 | `spec-steward`, `ios-dev` | Fail closed on unrecognized registry `powerState` and string `ownerPid`, remediating the actual failing host-config path, revalidating service identity before provisioning, and omitting app `--host-id` for already configured hosts |
| 1.0.12 | 2026-08-28 | `spec-steward`, `ios-dev` | Fail closed on mistyped optional lease/pin snapshot fields, require catalog-backed project-ID set equality for snapshot freshness, and display doctor `remediationCommands` in app setup failures |
| 1.0.11 | 2026-08-28 | `spec-steward`, `ios-dev` | Health-failure doctor and per-alias repair commands keep the selected `--host-config`, `--state-root`, and `--service-socket` paths |
| 1.0.10 | 2026-08-28 | `spec-steward`, `ios-dev` | Fail closed on occupied non-file registry/lease/pin paths and catalog-key/`projectId` mismatch, keep selected paths and host/runtime flags on setup recovery/repair commands, classify host-config I/O separately from simctl inventory, hide duplicate Finish setup while applying, and surface setup log/doctor/rollback diagnostics in the app |
| 1.0.9 | 2026-08-25 | `spec-steward`, `ios-dev` | Fail closed on snapshot-incomplete lease/pin records and schema-invalid persisted registry alias data instead of normalizing them to `ready` |
| 1.0.8 | 2026-08-25 | `spec-steward`, `ios-dev` | Block partial lease records and missing-host state roots that already contain registry/lease/pin artifacts, keep selected paths on service-identity retries, and refresh the app dashboard on an already-ready setup preview |
| 1.0.7 | 2026-08-25 | `spec-steward`, `ios-dev` | App Stop/timeout SIGTERM window includes rollback attribution inventory and the extra inventory after an indeterminate create failure |
| 1.0.6 | 2026-08-25 | `spec-steward`, `ios-dev` | Fail closed on schema-invalid lease/pin JSON, keep fallback device types order-stable, exclude automatic finishing from the setup sheet, treat doctor-record deletions as snapshot finishing work, and preserve selected path overrides in recovery commands |
| 1.0.5 | 2026-08-25 | `spec-steward`, `ios-dev` | Preview probes service identity on unconfigured hosts, and `ready` requires the snapshot to be at least as new as known-projects and lease/pin JSON |
| 1.0.4 | 2026-08-24 | `spec-steward`, `ios-dev` | Bound existing-host confirmation to the requested host ID, reused the device-type inventory when runtime records omit supported types, and failed closed on unreadable known-projects/lease JSON |
| 1.0.3 | 2026-08-24 | `spec-steward`, `ios-dev` | Required searchable writable directory ancestors, post-doctor snapshot health, and derived apply timeout plus cooperative timeout escalation |
| 1.0.2 | 2026-08-23 | `spec-steward`, `ios-dev` | Required exact setup-selected runtime/device identity for registry recovery and post-doctor committed-host revalidation |
| 1.0.1 | 2026-08-23 | `spec-steward`, `ios-dev` | Clarified registry recovery, concurrent setup waits, finishing-stage cancellation, schema rejection, and exact committed-host verification |
| 1.0.0 | 2026-08-22 | `spec-steward`, `ios-dev` | Active guided setup implementation contract |
