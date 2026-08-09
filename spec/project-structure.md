# Project Structure
Related: `spec/README.md`, `spec/global-simulator-broker.md`, `references/README.md`

## Top-level layout

- `agent-harness/` — copied harness engine used by `agent:*` commands
- `.agents/` — manifests, verification profiles, and curated skills
- `.codex/environments/` — Codex environment bootstrap and Run actions
- `WORKFLOW.md` — public-safe repo-owned Symphony execution, validation,
  protected-path, and handoff contract
- `spec/` — active source of truth, including worker-ready task specs under `spec/tasks/`
- `examples/` — executable sample repos and smoke fixtures for broker adoption patterns; not source of truth
- `references/` — public-safe reference notes; copied product snapshots are not checked in
- `app/` — XcodeGen spec, SwiftUI source, and XCTest coverage for the macOS operator app
- `broker-core/` — reusable broker logic; current file-backed slice, lease containment helpers, shared `simctl` adapter, and error-contract boundaries live here
- `client/` — CLI, local service, and compatibility layer; `client/bin/` contains `simbroker` and `brokerd`, `client/service/` contains the Unix-socket authority implementation, and `client/public-surface.mjs` implements the public text safety gate
- `script/` — canonical app run-loop entrypoints and shared macOS build preflight helpers such as `build_and_run.sh`
- `scripts/` — repo-owned helper scripts including the canonical
  `validate.sh` full-repository gate, app generation, repo-local install,
  distribution install, portable package creation, smoke verification, and
  harness bootstrap

## Important rule

Only `spec/`, `WORKFLOW.md`, `.agents/`, and real implementation directories
are source of truth. `examples/` are executable guidance and smoke fixtures.
`references/` is for seed material and comparison.

## State artifact layout

The broker state root may contain runtime artifacts in addition to source-of-truth state files:

- `leases/` — active lease JSON files
- `events.ndjson` — append-only audit events
- `registry.json`, `pins/`, and `known-projects.json` — broker state
- `idle-policy.json` — optional policy containing only `version` and
  `graceSeconds`; absent by default and written only through broker commands
- `evidence/` — default lease containment evidence root when a wrapper does not provide a run-local evidence path

No state artifact belongs in a consumer repository. In particular,
`idle-policy.json`, app snapshots, daemon metadata, host config, aliases,
simulator IDs, and operator attribution remain machine-local.

Consumer wrappers should prefer a run-local evidence directory such as `<run-dir>/simulator-broker-evidence` so failure bundles travel with the rest of the job artifacts.
