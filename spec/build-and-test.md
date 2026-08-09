# Build And Test
Related: `spec/README.md`, `spec/global-simulator-broker.md`, `spec/implementation-plan.md`, `spec/project-structure.md`

## Current state

A first extracted implementation slice now exists:

- file-backed broker core in `broker-core/index.mjs`
- real and fixture-backed `simctl` adapter coverage in `broker-core/simctl.mjs`
- CLI entrypoint in `client/bin/simbroker.mjs`
- local broker service target in `client/bin/brokerd.mjs` backed by `client/service/`
- broker-owned `app-snapshot.json` artifact and `app snapshot` CLI surface
- SwiftUI macOS app under `app/` generated from `app/project.yml`
- XCTest coverage for read-model filtering, pin eligibility, and broker-command store behavior
- automated coverage in `broker-core/test/` and `client/test/`
- broker-aware sample harness smoke coverage in `examples/harness-adoption/test/` across manual human, interactive agent, unattended agent build-test, CI, failure-cleanup, memory-monitor containment failure cleanup, and detached simulator-like process containment patterns
- broker containment coverage in `broker-core/test/` for memory ceiling observations, high-memory cleanup evidence, detached simulator-like process discovery, unrelated process preservation, stale-owner containment when process metadata exists, and incomplete-cleanup lease retention
- lifecycle-control policy and override coverage for `boot`, `shutdown`, `erase`, and `repair`
- direct and service-backed exit-code contract coverage for invalid requests, unavailable capacity, repair-needed aliases, and override-required flows
- direct and service-backed capacity coverage for public-safe check output,
  deterministic reconcile preview, exact human-confirmed additive apply,
  rollback, committed recovery, idempotency, and audit events
- app-side operator controls for pin create and clear, lease release, and lifecycle actions over the shared broker authority
- app launch-time fixture overrides through `--state-root`, `--host-config`, optional `--cli-path`, plus direct pane/detail targeting for deterministic screenshot and smoke scenarios
- broker-owned state artifacts are restricted to the current user, and lease, containment, pin, and lifecycle mutations share the broker mutation authority whether invoked directly, through the service, or from the app
- the macOS app test wrapper now supports build-only reruns, focused `-only-testing` filters, and stable `xcresult` output for runtime triage
- the macOS app emits unified `Logger` telemetry for startup, refresh, setup, broker actions, and override-required command outcomes
- the repo-owned macOS entrypoints now fail fast with actionable messages when `xcodegen` or `xcodebuild` is missing or misconfigured
- local install smoke coverage for a fresh-machine-style bootstrap, service start, lease acquire, app snapshot flow, installed-app launch proof, simulator cleanup that preserves preexisting simulators, and restoration of preexisting default install metadata
- installer coverage for stopping a running service before replacing the installed runtime, restarting it after metadata is written, shell-safe env helper serialization, and default-location install metadata for custom prefixes without leaving smoke-run paths in a developer install
- local-debug portable bundle support through a zip bundle plus package-smoke verification of the bundled install path and installed-app launch proof
- a separate Release distribution packaging path that requires operator-supplied signing inputs, runs `codesign` plus `spctl`, optionally notarizes with `notarytool`, and writes a readiness summary JSON
- executable `agent-harness/` changes now route through the implementation
  profile, which includes the harness TypeScript build and Vitest suite
- agent-harness Git helpers use an expanded subprocess output buffer so context, fingerprint, and completion checks can inspect large adopted repositories without failing on Node's default output cap

The current deterministic verification contract includes implementation tests plus spec integrity.

Generated agent harness commands:

<!-- agent-harness-commands:start -->
```bash
npm run agent:catalog
npm run agent:complete
npm run agent:context
npm run agent:detached-start
npm run agent:detached-status
npm run agent:doctor
npm run agent:eval
npm run agent:evaluate
npm run agent:handoff
npm run agent:plan
npm run agent:scorecard
npm run agent:soak
npm run agent:verify
npm --prefix agent-harness run preflight -- --paths-file <file>
```
<!-- agent-harness-commands:end -->

Generated verification profiles:

<!-- agent-harness-build-profiles:start -->
- `implementation` — proof `code`
- `spec-only` — proof `contract`
<!-- agent-harness-build-profiles:end -->

## Contributor onboarding contract

Use the repo-local contributor flow when the engineer already has this checkout on the target Mac.

Prerequisites:

- macOS with Xcode and iOS Simulator support installed
- `xcodegen` available on `PATH`
- Node.js LTS available on `PATH`

Canonical onboarding commands:

```bash
npm run install:local
source "$HOME/Library/Application Support/SimulatorBroker/install/env.sh"
command -v simbroker
open "$HOME/Applications/Simulator Broker.app"
```

After the app shows the broker is ready, onboard each consumer repo with:

```bash
simbroker project init --repo-root /path/to/repo
simbroker project validate --repo-root /path/to/repo
```

`npm run package:local` is the local-debug bundle path for local development convenience. It is not the primary contributor onboarding path and it is not a Gatekeeper-ready distribution artifact.

Contributor install troubleshooting:

- if `command -v simbroker` resolves to a repo checkout path instead of `"$HOME/.local/bin/simbroker"`, the machine is still using a dev wrapper rather than the installed runtime
- if `"$HOME/Library/Application Support/SimulatorBroker/install/env.sh"` is missing after a prior install attempt, treat the machine as partially installed
- repair the machine by removing `"$HOME/.local/bin/simbroker"`, `"$HOME/Applications/Simulator Broker.app"`, and `"$HOME/Library/Application Support/SimulatorBroker/install"`, then rerunning `npm run install:local`
- do not delete `"$HOME/Library/Application Support/SimulatorBroker/state"` as part of normal reinstall/repair unless you explicitly intend to reset live broker host state

## Required commands

### Agent harness commands

<!-- agent-harness-commands:start -->
```bash
npm run agent:catalog
npm run agent:complete
npm run agent:context
npm run agent:doctor
npm run agent:eval
npm run agent:evaluate
npm run agent:handoff
npm run agent:plan
npm run agent:scorecard
npm run agent:soak
npm run agent:verify
npm --prefix agent-harness run preflight -- --paths-file <file>
```
<!-- agent-harness-commands:end -->

### Agent harness build profiles

<!-- agent-harness-build-profiles:start -->
- `implementation` — proof `code`
- `spec-only` — proof `contract`
<!-- agent-harness-build-profiles:end -->

```bash
./scripts/validate.sh
./script/build_and_run.sh
./script/build_and_run.sh --verify
./script/build_and_run.sh --logs
./script/build_and_run.sh --telemetry
npm test
npm run test:install-smoke
npm run test:app
npm run test:app:build
npm run test:app:focus -- SimulatorBrokerAppTests/BrokerDashboardStoreTests
npm run test:app:focus -- SimulatorBrokerAppTests/BrokerSnapshotLoaderTests --result-bundle-path "$PWD/artifacts/app-test.xcresult"
npm run test:broker-core
npm run test:client
npm run test:harness-adoption
node client/bin/simbroker.mjs lease --help
node client/bin/simbroker.mjs host --help
node client/bin/simbroker.mjs capacity --help
node client/bin/simbroker.mjs capacity check --repo-root <repo> [--purpose <purpose>] --json
node client/bin/simbroker.mjs capacity reconcile --repo-root <repo> [--purpose <purpose>] --json
node client/bin/simbroker.mjs capacity reconcile --repo-root <repo> [--purpose <purpose>] --apply --confirm <plan-id> --actor-type human --actor-id <operator-id> --json
bash scripts/install_local.sh
bash scripts/install_distribution.sh --payload-root <payload-root>
bash scripts/package_distribution.sh --team-id <team-id> --signing-identity '<identity>'
bash scripts/package_local.sh
bash scripts/install_smoke.sh
bash scripts/package_smoke.sh
npm run package:distribution
npm run package:local
npm run test:package-smoke
bash scripts/generate_app_project.sh
bash scripts/test_app.sh
bash scripts/test_app.sh --build-only
bash scripts/test_app.sh --only-testing SimulatorBrokerAppTests/BrokerDashboardStoreTests
bash scripts/test_app.sh --only-testing SimulatorBrokerAppTests/BrokerSnapshotLoaderTests --result-bundle-path "$PWD/artifacts/app-test.xcresult"
npm run agent:context -- --paths README.md broker-core/ client/ package.json spec/README.md spec/architecture.md spec/build-and-test.md spec/global-simulator-broker.md spec/implementation-plan.md spec/project-structure.md --session-dir "$HOME/.codex/agent-harness/simulator-broker-app/phase8-exit-code-contract" --session-mode long-running
npm run agent:plan -- --session-dir "$HOME/.codex/agent-harness/simulator-broker-app/phase8-exit-code-contract"
npm run agent:verify -- --profile implementation --paths broker-core/ client/ --session-dir "$HOME/.codex/agent-harness/simulator-broker-app/phase8-exit-code-contract"
npm run agent:verify -- --profile spec-only --paths README.md broker-core/ client/ package.json spec/README.md spec/architecture.md spec/build-and-test.md spec/global-simulator-broker.md spec/implementation-plan.md spec/project-structure.md --session-dir "$HOME/.codex/agent-harness/simulator-broker-app/phase8-exit-code-contract"
npm run agent:handoff -- --session-dir "$HOME/.codex/agent-harness/simulator-broker-app/phase8-exit-code-contract"
npm run agent:evaluate -- --session-dir "$HOME/.codex/agent-harness/simulator-broker-app/phase8-exit-code-contract"
npm run agent:complete -- --session-dir "$HOME/.codex/agent-harness/simulator-broker-app/phase8-exit-code-contract"
```

## Verification obligations

- `npm run agent:context -- --paths <files> --session-dir <dir>` is the routing and obligation source of truth for a task.
- Implementation-owned paths require the `implementation` profile, which runs
  the complete `npm test` suite plus the `agent-harness` TypeScript build and
  Vitest suite. Specs, manifests, and harness contract paths require
  `spec-only`; mixed tasks must pass both profiles.
- `WORKFLOW.md` invokes `./scripts/validate.sh` for normal Symphony validation.
  The validator runs `npm test` plus the canonical diff-integrity check.
- `npm run agent:complete -- --session-dir <dir>` is the close-out gate; it fails unless the required verification profiles passed against the current task-tree fingerprint and any blocking obligations are satisfied or the session is explicitly reported blocked.
- Every meaningful task commit must use a structured git message with `Why:`, `Changed:`, `Verification:`, `Affected:`, `Refs:`, and `Session:` sections.
- `agent:complete` enforces a clean close-out: no new uncommitted task changes, no malformed task commit messages, no changed paths outside selected manifest path constraints, and no leftover untracked junk outside allowlisted local artifact paths.
- For `long-running` sessions, `agent:complete` also requires populated `task-plan`, `session-handoff`, and `advisory-evaluation` artifacts.

## Future verification intent

Add stronger profiles next for:

- repo integration contract across sample fixture repos
- harness adoption smoke tests driven by `spec/harness-integration.md`
- macOS app runtime and UI evidence
- macOS app run-loop contract for `script/build_and_run.sh` and `.codex/environments/environment.toml`
- packaging and install smoke tests on a clean machine

## Current slice acceptance

- `agent-harness` installs and runs
- manifests resolve correctly
- `npm test` passes for broker-core, CLI, and local service behavior
- `npm test` also passes the macOS app read-model unit tests through `npm run test:app`
- `npm test` also proves the sample consumer repo wrappers can acquire, release, and contain leases through the broker across manual, agent, CI, failure-cleanup, memory-monitor containment failure cleanup, and detached simulator-like process paths
- `npm run test:broker-core` proves lifecycle-control policy, holder conflict handling, lease/pin/lifecycle serialization, current-user state permissions, reset rollback, repair rebinding, repair retirement retry, audit-event recording, UTF-8-safe bounded recent-event tail reads, bounded `simctl` subprocess execution, no-breach containment observations, memory ceiling evidence capture, owned-only cleanup, detached simulator-like process inclusion, unrelated process preservation, stale-owner containment when process metadata exists, and lease retention when cleanup fails
- `npm run test:broker-core` also proves capacity check privacy, deterministic
  reconcile plan IDs, one action per unique requirement tuple, non-actionable
  live busy capacity, read-only stale-owner filtering, exact human confirmation
  before recovery, additive host-config merge under shared mutation locking,
  no-changes idempotency, verified pre-commit rollback, recovery-required
  journal blocking, and committed transaction recovery through fixture-backed
  `simctl`
- `npm run test:client` proves service lifecycle, concurrent clients, startup readiness before service metadata publication, restart safety, malformed service response handling, expected service identity validation for command dispatch and stop dispatch, NDJSON event streaming including stop with an active follower, service-backed lifecycle-control flows against the fixture-backed `simctl` boundary, stable direct plus service-backed exit-code behavior, useful `lease --help` / `host --help` / `capacity --help` output, and direct/service capacity plan parity
- `npm run test:app` proves the XcodeGen project builds and the app decodes snapshots, filters pin candidates, bounds local CLI subprocesses, preserves refresh diagnostics after successful mutations whose snapshot reload fails, and routes broker-command errors correctly
- `npm run test:app:build` isolates compile-time failures with the same XcodeGen and derived-data settings used by the full suite
- `npm run test:app:focus -- <filter>` reruns one named XCTest scope and writes a stable `xcresult` bundle under `artifacts/app-tests/` unless the caller overrides the path explicitly
- `./script/build_and_run.sh` is the canonical local macOS app run loop, stops only the app instance launched from the current checkout's built app path, and `./script/build_and_run.sh --verify` proves that built app launches as a foreground `.app`
- `./script/build_and_run.sh --telemetry` proves the app emits filterable `AppLifecycle` and `Refresh` unified logs during a live run, while `bash scripts/test_app.sh` exercises `Setup` and `Commands` events in focused app tests
- the installer prints the installed CLI path, app path, env helper path, any current-shell PATH warning, and the exact `source "<env-helper>"` next step after installation
- `npm run test:install-smoke` proves a fresh-machine-style install can bootstrap host config, scaffold a repo, start the service, acquire a lease, generate an app snapshot from the installed CLI, launch the installed app bundle against the smoke fixture, assert the `SimulatorBrokerApp` process stays alive, restore any preexisting default install metadata including symlink target contents, and clean up only the simulators provisioned by the smoke run afterward
- `npm run package:distribution` builds the app in `Release`, requires operator-supplied `SIMBROKER_DISTRIBUTION_TEAM_ID` plus `SIMBROKER_DISTRIBUTION_SIGNING_IDENTITY`, optionally consumes `SIMBROKER_NOTARYTOOL_PROFILE`, and writes a machine-readable readiness summary under `artifacts/distribution/`
- when notarization credentials are unavailable, `npm run package:distribution` still writes the summary JSON and tells the operator to rerun with `SIMBROKER_NOTARYTOOL_PROFILE` instead of implying the archive is Gatekeeper-ready
- `npm run package:distribution` returns non-zero after writing its summary JSON when the artifact is still unsigned, unstapled, unnotarized, or rejected by `spctl`
- `npm run test:package-smoke` proves the zipped local-debug portable bundle can be unpacked, installed through its bundled `install.sh`, and complete the same host-bootstrap, repo-scaffold, lease, snapshot, installed-app launch, process-proof, and cleanup flow as the repo-local installer
- `implementation` verification passes for implementation-owned changes
- `spec-only` verification passes for spec or harness changes
- task-session closeout rejects stale required verification and committed path drift outside selected manifest constraints
- README and `spec/harness-integration.md` now describe a no-hidden-step contributor onboarding path that includes sourcing the env helper before repo onboarding commands are run
- manual CLI and service smoke artifacts are captured in the active session dir when a task changes the CLI, service, or broker core
- manual app smoke artifacts include key window captures for overview, empty-state, simulator detail, destructive confirmation, and override-required remediation scenarios in addition to visibility states
- app overview, simulator detail, and no-snapshot states may be launched deterministically for review with `open -na /path/to/SimulatorBrokerApp.app --args --state-root <root> [--host-config <path>] [--cli-path <path>] [--pane <pane>] [--simulator-alias <alias>]`
- onboarding work should capture install-smoke logs, installed-app screenshot evidence, and the corresponding screenshot-review artifact in the active session dir
- when a task changes the service or CLI authority path, capture durable test logs such as `test-client.log` and `npm-test.log` in the active session dir
- `agent:complete` passes after a structured task commit and clean close-out
