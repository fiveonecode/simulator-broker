# Public-Safe On-Demand Simulator Lifecycle
Related: `spec/tasks/README.md`, `spec/global-simulator-broker.md`, `spec/architecture.md`, `spec/build-and-test.md`, `spec/harness-integration.md`

> **Document ID:** `GSB-TASK-010`
> **Version:** `1.0.0`
> **Last Updated:** `2026-08-10`
> **Status:** `Implemented`
> **Owner:** `spec-steward`
> **Implementation Owners:** `broker-core`, `client`, `macos-app`

## 1. Objective

Simulator Broker owns simulator reuse, idle shutdown, and operator controls. Consumer repositories remain unchanged: releasing an existing lease is sufficient.

Registered aliases remain standby capacity and are never deleted by idle management. A low-concurrency client repeatedly reuses the same warm compatible alias; additional aliases are used only when concurrent demand requires them. When an operator configures an idle policy, unused automated simulators return to the shutdown state after the configured grace period.

## 2. Fixed product decisions

- Lease acquisition returns the selected simulator booted and ready for use.
- Candidate selection uses one rule only: matching pin, compatible booted alias, then compatible shutdown alias. Within each tier, the most recently released alias wins; configured alias order is the final deterministic tie-breaker.
- There is no legacy rotation mode, migration path, compatibility flag, or fallback selector.
- Idle policy is absent by default. Source, docs, fixtures, and onboarding provide no default duration.
- Idle management never deletes or renames registered aliases.
- The app and CLI are clients of broker authority and never write broker configuration or state directly.

## 3. Scope and boundaries

### In scope

- deterministic warm reuse and boot-on-acquire
- broker-state-only idle policy
- direct and service-backed idle CLI/API commands
- scheduled reconciliation in `brokerd`
- one-time, human-confirmed cleanup of existing idle simulators
- count-only idle summaries and local audit events
- macOS Overview controls
- public-surface verification

### Out of scope

- consumer repository source or configuration changes
- deleting retained simulator capacity
- per-project idle policy
- unattended policy mutation or cleanup apply
- migration or backward-compatibility behavior
- committing a machine's aliases, simulator IDs, state roots, operator identity, or chosen duration

## 4. Broker requirements

### REQ-001 — Deterministic selection and acquisition

After capability, explicit requirement, health, lease, pin, and optional explicit-alias filtering, the broker ranks available candidates as follows:

1. an alias pinned to the requesting project and purpose
2. a compatible booted alias
3. a compatible shutdown alias

Within each tier, a later valid `lastLeaseReleasedAt` ranks first. Missing or equal timestamps fall back to host-config order. The broker records the lease, performs the purpose's reset if required, boots a shutdown selection, and only then returns success. Reset or boot failure rolls back the lease and marks the alias `repair-needed`.

### REQ-002 — Local policy artifact

The policy is stored only at `<state-root>/idle-policy.json`, outside every repository, with this exact schema:

```json
{
  "version": 1,
  "graceSeconds": 60
}
```

The numeric value above demonstrates the minimum valid shape, not a shipped default. `graceSeconds` must be an integer from `60` through `86400`. Any additional field is invalid. File absence means not configured.

### REQ-003 — CLI and API

The public command surface is:

```text
simbroker idle status
simbroker idle enable --grace-seconds <60-86400> --actor-type human --actor-id <operator-id>
simbroker idle disable --actor-type human --actor-id <operator-id>
simbroker idle reconcile
simbroker idle cleanup
simbroker idle cleanup --apply --confirm <plan-id> --actor-type human --actor-id <operator-id>
```

Policy enable/disable and cleanup apply require a non-empty human actor ID. Cleanup preview is non-mutating and returns only a candidate count, status, and deterministic plan ID. Apply must recompute the plan under the mutation lock and reject missing, non-human, or stale confirmation with exit code `5`.

### REQ-004 — Scheduled reconciliation

When `brokerd` starts, it immediately reconciles idle state before publishing its initial snapshot. It then reconciles every 30 seconds and refreshes the app snapshot after each run. Reconciliation executions must not overlap.

A normal client lease acquisition lazily starts `brokerd` when policy is configured and no service is running. Explicit local-only mode neither starts nor schedules the service and reports `local-only-mode` as its scheduler limitation.

### REQ-005 — Eligibility and locking

Reconciliation takes the existing broker mutation lock and re-reads leases and simulator inventory. A registered alias is eligible only when all of these are true at the reconciliation timestamp:

- power state is `booted`
- health is exactly `healthy`
- no active lease exists
- no pin exists
- capability is not `manual-persistent`
- `lastLeaseReleasedAt + graceSeconds` is at or before the reconciliation timestamp

Stale-lease recovery records the recovery timestamp as the new release time, starting a fresh grace period. Unknown externally booted devices are not registered candidates and remain untouched.

### REQ-006 — Failure handling and observability

Successful shutdown changes the alias power state to `shutdown`. Shutdown failure changes its health to `repair-needed` with the stable reason `idle-shutdown-failed`, preventing timer retries until repair.

Broker events and the app snapshot expose:

- whether policy is configured
- configured grace duration or `null`
- currently eligible count
- last cleanup result
- next scheduled cleanup timestamp or `null`

Cleanup results and idle command summaries may expose counts, status, timestamps, plan IDs, and stable reason codes. They must not expose local paths, host aliases, simulator IDs, operator IDs, or raw runtime errors.

## 5. macOS app requirements

The Overview screen contains an **Automatic shutdown** section that shows configured/not-configured state, grace duration, eligible count, last result, and these actions:

- **Apply** validates an explicitly entered integer from `60` through `86400` and calls `idle enable` through broker service transport.
- **Disable** calls `idle disable` through broker service transport.
- **Clean idle simulators now** first requests cleanup preview, presents a count-only confirmation, and applies the confirmed plan only after operator approval.

The duration field is blank when policy is unconfigured. The app refreshes its broker snapshot after policy mutation, lease mutation, scheduled reconciliation, service restart, and cleanup. It does not read or write `idle-policy.json` directly.

## 6. Public-safety requirements

- No real home path, host alias, simulator ID, state root, local timing choice, operator identity, consumer-product name, local log, screenshot, seeded configuration, or preference may enter tracked public text.
- Public fixtures use temporary roots and synthetic identifiers.
- Tests never use the default broker state root.
- `npm run verify:public-surface` scans tracked text plus non-ignored untracked text for the current home path and prohibited broker-state artifacts.
- An ignored root-level `.public-safety.local` may contain one literal denylist value per line. The scanner reports only rule numbers and paths, never the values.
- The normal `npm test` and release verification path runs `verify:public-surface`.

## 7. Verification traceability

| Requirement | Deterministic evidence |
|---|---|
| REQ-001 | repeated UI/build acquisition reuses the warm alias; concurrent demand uses standby; shutdown selection uses newest release; boot/reset failures roll back |
| REQ-002 | absent policy, exact schema, boundary validation, machine-local path tests |
| REQ-003 | parser, direct CLI, service parity, human confirmation, stale-plan, and privacy tests |
| REQ-004 | immediate startup reconcile, 30-second timer, lazy daemon start, local-only limitation, restart persistence tests |
| REQ-005 | grace boundary, lease, pin, manual, unhealthy, external-device, stale recovery, and mutation-lock tests |
| REQ-006 | successful shutdown, one-shot repair-needed failure, count-only serialization, event and snapshot tests |
| App | Swift model decoding, store commands, confirmation flow, snapshot refresh, and app build/test suite |
| Public safety | scanner unit tests plus `npm run verify:public-surface` in the normal gate |

## 8. Rollout boundary

Release and machine rollout are separate steps. After a public release, the local operator chooses and enables the desired valid duration, applies one confirmed cleanup plan, and verifies that sequential work reuses warm aliases while concurrent work expands only to the required standby aliases. The chosen value and resulting local state remain outside this repository.

## Document history

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0.0 | 2026-08-10 | Codex | Finalized and implemented the public-safe lifecycle contract with boot-on-acquire and no compatibility mode. |
