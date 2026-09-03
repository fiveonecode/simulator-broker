# Project Structure
Related: `spec/README.md`, `spec/global-simulator-broker.md`, `references/README.md`, `autopilot.yml`

## Top-level layout

- `agent-harness/` — copied harness engine used by `agent:*` commands
- `.agents/` — manifests, verification profiles, and curated skills
- `.codex/environments/` — Codex environment bootstrap and Run actions
- `WORKFLOW.md` — public-safe repo-owned Symphony execution, validation,
  protected-path, and handoff contract
- `autopilot.yml` — Codex Autopilot origin verification contract; Autopilot
  does not read `.agents` or `WORKFLOW.md` as that gate
- `CHANGELOG.md` — published version history for tagged releases
- `.github/workflows/` — public Node test CI and tag-driven CLI release
- `Formula/` — Homebrew CLI formula for the tagged Alpha tarball. Source of
  truth for the tap; Homebrew clones
  `fiveonecode/homebrew-simulator-broker` when a stranger runs
  `brew install fiveonecode/simulator-broker/simbroker`
- `Casks/` — Homebrew cask for the signed, notarized operator app zip.
  Synced to the same tap.
- `packages/simbroker/` — packable npm CLI metadata and `bin` wrapper; the
  repo-root package stays private
- `.github/ISSUE_TEMPLATE/` — install-failure, bug, and feature issue forms
- `.github/pull_request_template.md` — public-patch PR checklist; no harness
  session required
- `spec/` — active source of truth, including worker-ready task specs under `spec/tasks/`
- `spec/tasks/guided-simbroker-setup.md` — cross-layer setup command, app,
  recovery, and acceptance source of truth
- `docs/` — public newcomer docs (getting started, concepts, status) and the
  README screenshot; not source of truth
- `examples/` — executable sample repos and smoke fixtures for broker adoption patterns; not source of truth
- `references/` — public-safe reference notes; copied product snapshots are not checked in
- `app/` — XcodeGen spec, SwiftUI source, and XCTest coverage for the macOS operator app; supported generation atomically emits an ignored `Sources/Generated/BrokerRuntimeVersion.generated.swift` constant and `Generated/SimulatorBrokerApp-Info.plist` runtime compatibility plus Finder/About version keys from the root package version before XcodeGen runs
- `broker-core/` — reusable broker logic; current file-backed slice, lease containment helpers, shared `simctl` adapter, and error-contract boundaries live here
- `client/` — CLI, local service, and compatibility layer; `client/bin/` contains `simbroker` and `brokerd`, `client/service/` contains the Unix-socket authority implementation, and `client/public-surface.mjs` implements the public text safety gate
- `client/setup-preflight.mjs` — bounded read-only macOS/Xcode/path/disk setup
  prerequisites; it does not own broker mutation
- `script/` — canonical app run-loop entrypoints and shared macOS build preflight helpers such as `build_and_run.sh`
- `scripts/` — repo-owned helper scripts including the canonical
  `validate.sh` full-repository gate, app generation, repo-local install,
  CLI-only install (`install_local.sh --cli-only`), CLI tarball packaging
  (`package_cli.sh`) plus its raw USTAR validator (`validate_cli_tar.mjs`),
  Homebrew cask zip (`package_cask_zip.sh`) plus its standard-library candidate
  validator (`validate_cask_zip.py`), npm CLI packing (`package_npm.sh`), Homebrew tap
  sync (`sync_homebrew_tap.sh`), distribution install, portable package creation, smoke
  verification, and harness bootstrap

## Important rule

Only `spec/`, `WORKFLOW.md`, `.agents/`, and real implementation directories
are source of truth. `docs/` is the public newcomer front door linked from
`README.md`. `examples/` are executable guidance and smoke fixtures.
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
