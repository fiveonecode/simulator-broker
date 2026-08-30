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
- deterministic warm-reuse, boot-on-acquire, idle-policy boundary, exclusion,
  stale-recovery, lock-race, scheduler, confirmed-cleanup, and failure coverage
- tracked-text public-surface scanning with an ignored local denylist extension
- app-side operator controls for pin create and clear, lease release, and lifecycle actions over the shared broker authority
- app launch-time fixture overrides through `--state-root`, `--host-config`, optional `--cli-path`, plus direct pane/detail targeting for deterministic screenshot and smoke scenarios. When `--cli-path` / `SIMBROKER_CLI_PATH` and `install.json` are unset, the app also looks for an executable `simbroker` in Homebrew prefix `bin` (`/opt/homebrew`, `/usr/local`, and `HOMEBREW_PREFIX`) before `~/.local/bin`
- broker-owned state artifacts are restricted to the current user, and lease, containment, pin, and lifecycle mutations share the broker mutation authority whether invoked directly, through the service, or from the app
- inactive local project registrations can be removed only through the explicit, locked `project forget --project-id <id>` command; it is idempotent, refreshes the shared app snapshot, preserves the repository and audit history, and rejects projects with active leases or pins
- the macOS app test wrapper now supports build-only reruns, focused `-only-testing` filters, and stable `xcresult` output for runtime triage
- app project generation atomically derives an ignored Swift runtime-version constant and explicit app `Info.plist` compatibility key from the root `package.json`; both are separate from bundle marketing/build metadata and are regenerated before every supported build or test entrypoint
- the macOS app emits unified `Logger` telemetry for startup, refresh, setup, broker actions, and override-required command outcomes
- the repo-owned macOS entrypoints now fail fast with actionable messages when `xcodegen` or `xcodebuild` is missing or misconfigured
- local install smoke coverage for a fresh-machine-style bootstrap, service start, lease acquire, app snapshot flow, and correlated installed-app snapshot-decode proof, plus simulator cleanup that preserves preexisting simulators and restoration of preexisting default install metadata
- guided setup coverage for prerequisite preview, exact plan extraction,
  confirmed six-device apply, service/snapshot/doctor readiness,
  version-agnostic project scaffold, lease acquire/release, zero-create rerun,
  and baseline-preserving cleanup
- installer coverage for stopping a running service before replacing the installed runtime, restarting it after metadata is written, shell-safe env helper serialization, and default-location install metadata for custom prefixes without leaving smoke-run paths in a developer install
- daemon runtime-health coverage for missing worker modules, replaced runtime
  files, stale client/daemon versions, fail-closed CLI and app probes, explicit
  restart recovery, and preservation of active file-backed leases
- CLI-only install through `bash scripts/install_local.sh --cli-only`, which copies the Node runtime and writes `simbroker` without XcodeGen or an app build
- PATH persistence after install: Homebrew prefix bin when that is the install
  location, otherwise one guarded login-profile snippet for the default
  `~/.local/bin` location. The default profile is `~/.zprofile` for zsh, an
  existing `~/.bash_profile` or `~/.bash_login` for Bash (checked in that
  order), or `~/.profile` otherwise; `--profile`
  overrides the profile path so tests never edit the operator login rc
- Public first-run order is Homebrew CLI, optional Homebrew cask, then app
  **Complete first-time setup** or `simbroker setup`. The shared guided flow
  previews prerequisites/newest compatible runtime/six devices, confirms an
  exact plan, starts the service, refreshes the snapshot, and verifies doctor.
  `host init --bootstrap-config` remains advanced and keeps its iOS 18 default.
  Homebrew does not create simulators. Hello world requires setup ready and a
  passing `capacity check --purpose agent-ui-session` (`purposes[].status`, not
  top-level `status`). `unavailable` stops at reconcile; `repair_needed` stops
  at doctor plus `simulators repair --alias <alias>`. The cask is the default
  app install and does not require XcodeGen; XcodeGen is source-build-only.
  Released Simulators intentionally remain warm after lease release while the
  opt-in idle policy is absent; newcomer guidance names `idle status` and the
  human-attributed `idle enable` command without choosing a duration
- `scripts/package_cli.sh` packages the Node CLI runtime into a versioned
  top-level directory inside a tarball without XcodeGen or an app build;
  newcomer commands invoke
  `./simulator-broker-<version>-cli/bin/simbroker`, not `./bin/simbroker`
- `Formula/simbroker.rb` installs that GitHub Release tarball through Homebrew.
  `brew install fiveonecode/simulator-broker/simbroker` clones
  `fiveonecode/homebrew-simulator-broker`. `scripts/sync_homebrew_tap.sh`
  copies `Formula/` and `Casks/` into a tap checkout only when
  `Formula/simbroker.rb` exists. `--check-remote` compares this tree to
  the published tap formula and is not part of `spec-only`
- `scripts/package_npm.sh` (`npm run package:npm`) packs `packages/simbroker`
  with a `bin` field; the repo-root package stays `private`
- `Casks/simulator-broker.rb` installs `Simulator Broker.app` from
  `Simulator-Broker-<version>.zip` on GitHub Releases (signed/notarized app
  from `payload/app/Simulator Broker.app` after `package_distribution.sh`
  and `package_cask_zip.sh`, not `package:local`). The cask pins the
  published zip SHA-256.
- `scripts/package_cask_zip.sh` (`npm run package:cask-zip`) writes that
  app-only zip with `ditto -c -k --keepParent`. It does not build, sign,
  notarize, staple, tag, or publish. Version, missing-app, bundle-name,
  and `CFBundleIdentifier` (`dev.codex.simulator-broker-app`) checks run
  before the Darwin/`ditto` gate so `spec-only` stays portable. After
  `codesign --verify --deep --strict` and Developer ID inspection it runs
  `xcrun stapler validate` and refuses a missing app, a signature that
  does not verify, an ad-hoc or non-Developer ID signature, the wrong
  sealed identifier, an unstapled app, and a zip that contains the
  distribution payload instead of `Simulator Broker.app`.
- public GitHub-hosted CI splits by machine: Ubuntu runs the managed-skill
  ownership check, `test:docs`, `test:broker-core`, and
  `test:harness-adoption` with a 10-minute budget; macOS runs `test:client`
  with a 15-minute budget. Neither job runs `test:app` or
  `verify:public-surface`. Home-path leak scanning
  uses `os.homedir()` of the current machine, so GitHub-hosted runners would
  search for `/home/runner` or `/Users/runner`, not the operator home. The
  full-repo scan stays on local `npm test`. Do not raise those budgets to
  hide a hung `simctl` or `brokerd` wait. Broker tests that build an
  app snapshot, including in-process `startBrokerService`, must inject the
  fixture `simctl` adapter (`SIMBROKER_SIMCTL_FIXTURE_STATE` or an explicit
  adapter / snapshot writer). macOS CI runs client tests with
  `node --test --test-concurrency=1 --test-timeout=120000` so client files
  cannot interleave and a hung test cannot consume
  `serviceStartupTimeoutMs`. Do not add `--test-force-exit`: on Node 20 it
  exits while later `describe()` tests are still queued. `brokerd` and
  `simbroker` client tests use `describe` concurrency `1` so in-file
  service starts cannot overlap. Keepalive owner and command processes in
  `simbroker` tests stay referenced until they exit; `unref()` during an
  `await` lets Node 20 fire `beforeExit` and cancel later queued tests.
  `package_distribution.sh` payload-scan tests skip on GitHub CI and on
  non-Darwin. Copying the runtime and scanning the staged payload is too
  slow for the 120-second client-file timeout; those tests stay on local
  Darwin `npm test`. The script scans the staged payload and archive
  name; it does not rerun the full-repo `verify:public-surface` scan. Before
  staging or signing, including with `--skip-build`, the script requires the
  app's `SimulatorBrokerExpectedRuntimeVersion` `Info.plist` value to exactly
  match the root `package.json` version. A stale or missing value fails before
  `codesign` so a version bump cannot silently reuse an older app build.
  The default public-surface scan reads index
  blobs only for dirty or missing worktree files. `git diff-files` exit `1`
  is the dirty-name list; only a real git failure fails the scan. A clean
  checkout must not spawn one `git cat-file` per file. `simbroker service
  start` must fail as soon as the spawned `brokerd` exits without becoming
  ready; it must not keep polling for `serviceStartupTimeoutMs` just because
  the startup lock directory still exists. Broker-core process-table
  fixtures inject `processController.currentPid` so hardcoded fixture
  PIDs cannot match the GitHub Actions test-runner pid. Containment still
  skips the live `process.pid` when `currentPid` is omitted.
- tagged versions such as `v0.1.0-alpha.3` attach the CLI tarball, the
  packable `simbroker-<version>.tgz`, and the notarized
  `Simulator-Broker-<version>.zip` to a GitHub Release. The Homebrew
  formula and cask pin the operator-packed checksums of those tagged
  assets. `.github/workflows/release.yml` may rebuild the CLI and npm
  tarballs on the tag. Its Ubuntu `test:client` run must finish within the
  30-minute job budget; issue `#9`'s nested full-repo scan was removed, so a
  timeout is a regression rather than an expected release condition. After
  the workflow succeeds, attach or `--clobber` operator-packed assets as in
  Tagged Alpha ship. Do not
  leave Homebrew pointing at a workflow rebuild that has a different
  hash. The app zip is an operator-signed notarized attach for this
  Alpha, produced with `npm run package:cask-zip` after notarization.
- local-debug portable bundle support through a zip bundle plus package-smoke verification of the bundled install path and correlated installed-app snapshot-decode proof
- a separate Release distribution packaging path that requires operator-supplied signing inputs, runs `codesign` plus `spctl`, optionally notarizes with `notarytool`, and writes a readiness summary JSON
- executable `agent-harness/` changes now route through the implementation
  profile, which includes the harness TypeScript build and Vitest suite
- agent-harness Git helpers use an expanded subprocess output buffer so context, fingerprint, and completion checks can inspect large adopted repositories without failing on Node's default output cap

The current deterministic verification contract includes implementation tests plus spec integrity.

## Tagged Alpha ship

This is the operator sequence for a tagged Alpha whose Homebrew formula
and cask match the GitHub Release. It is not GitHub Actions and it does
not reinstall a live machine.

1. Bump `package.json` / lock / `packages/simbroker`, `CHANGELOG.md`,
   newcomer docs, `Formula/simbroker.rb` URL, and
   `Casks/simulator-broker.rb` version. Leave the cask `sha256` on the
   previous zip until the new zip exists.
2. Run `npm run agent:verify -- --profile spec-only` for the changed
   paths.
3. Run `npm run package:cli` and `npm run package:npm`. Pin
   `Formula/simbroker.rb` `sha256` to the CLI tarball.
4. Sign the Release app with `npm run package:distribution` and a
   Developer ID Application identity. The packaging command verifies the
   generated app runtime compatibility key against the bumped root version
   before signing; `--skip-build` is valid only for an already-matching app.
5. Notarize and staple that app (`asc notarization submit --wait` or a
   `notarytool` keychain profile), then `npm run package:cask-zip`.
6. Pin `Casks/simulator-broker.rb` `sha256` to
   `Simulator-Broker-<version>.zip`.
7. Re-run `npm run agent:verify -- --profile spec-only` for the changed
   paths so the pinned formula and cask checksums are in the verified
   tree.
8. Open a pull request. After merge, create tag `v<version>` and wait
   for `.github/workflows/release.yml` to finish or fail. If that job
   did not create the GitHub Release, create it with the operator-packed
   CLI tarball, npm tgz, and app zip. If the job created the release,
   `gh release upload` the app zip and `--clobber` CLI/npm assets whose
   hashes differ from the formula pins. Operator-packed checksums remain
   the Homebrew source of truth.
9. Run `scripts/sync_homebrew_tap.sh` against a
   `fiveonecode/homebrew-simulator-broker` checkout.
10. Live Homebrew reinstall is a separate operator step: only when the
    machine has zero leases and zero pins. Do not run
    `host init --bootstrap-config`.

`package:cask-zip` does not unlock a signing keychain, merge, tag, or
run `brew`.

Codex Autopilot is a separate origin-default-branch gate. It runs only the
command in `autopilot.yml` (`npm test`). Autopilot does not read `.agents` or
`WORKFLOW.md` as its contract. Missing origin `autopilot.yml` is not skip.
Local full-repo validation remains `./scripts/validate.sh`. GitHub-hosted CI
stays the split Ubuntu/macOS jobs, and both public pull requests and tagged
releases run `npm run test:docs`. Pull-request CI still does not run
`test:app` or `verify:public-surface`; the release workflow also does not run
`test:app`.

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

## Public newcomer docs

The public front door is `README.md` plus `docs/getting-started.md`,
`docs/concepts.md`, and `docs/status.md`. Those pages are newcomer guidance.
This file remains the contributor and verification contract.

`CONTRIBUTING.md` splits public patches from maintainer and agent runs. A
public patch names Node.js 20 and the Node test suites and does not require
`agent:context` or a Codex session directory. The maintainer track still
documents `agent:context`, `agent:verify`, and `agent:complete`. Harness
enforcement (`agent:complete` structured commits, selected profiles, and
session artifacts) is unchanged.

## Contributor onboarding contract

Use the repo-local contributor flow when the engineer already has this checkout on the target Mac.

Prerequisites:

- macOS with Xcode and iOS Simulator support installed
- `xcodegen` available on `PATH`
- Node.js LTS available on `PATH`

Canonical CLI-only onboarding commands:

```bash
bash scripts/install_local.sh --cli-only
command -v simbroker
```

Canonical contributor app+CLI onboarding commands:

```bash
npm run install:local
command -v simbroker
open "$HOME/Applications/Simulator Broker.app"
```

The CLI-only path does not require `xcodegen`. After either installer, a new
login shell should resolve `simbroker` without sourcing `env.sh`. The env
helper remains a current-shell fallback.

After the app shows the broker is ready, onboard each consumer repo with:

```bash
simbroker setup
simbroker project init --repo-root /path/to/repo
simbroker project validate --repo-root /path/to/repo
```

If a repository has been moved or deleted and no active lease or pin belongs to
it, remove only its stale local registration with `simbroker project forget
--project-id <project-id>`.

`npm run package:local` is the local-debug bundle path for local development convenience. It is not the primary contributor onboarding path and it is not a Gatekeeper-ready distribution artifact.

For users rather than contributors, the canonical app install is
`brew install --cask fiveonecode/simulator-broker/simulator-broker`; it does
not require XcodeGen. Ordinary Homebrew reinstall and uninstall stop the
service first and preserve `host-config.json` plus `state/`. Deleting the full
`$HOME/Library/Application Support/SimulatorBroker` directory is an explicit
reset step only and does not delete repo-local configuration or Xcode Simulator
devices.

Contributor install troubleshooting:

- if `command -v simbroker` resolves to a repo checkout path instead of `"$HOME/.local/bin/simbroker"`, the machine is still using a dev wrapper rather than the installed runtime
- if `"$HOME/Library/Application Support/SimulatorBroker/install/env.sh"` is missing after a prior install attempt, treat the machine as partially installed
- if `simbroker` is still available, stop `brokerd` and quit `Simulator Broker.app` before manually replacing the install paths; do not take the service offline while it has an active lease
- repair the machine by removing `"$HOME/.local/bin/simbroker"`, `"$HOME/Applications/Simulator Broker.app"`, and `"$HOME/Library/Application Support/SimulatorBroker/install"`, then rerunning `npm run install:local`, reloading `env.sh`, and running `simbroker service start`
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
npm run test:docs
node --test docs/test/installed-app-smoke-evidence.test.mjs
npm run test:harness-adoption
npm run verify:public-surface
bash scripts/check_managed_skill_ownership.sh
node client/bin/simbroker.mjs lease --help
node client/bin/simbroker.mjs host --help
node client/bin/simbroker.mjs capacity --help
node client/bin/simbroker.mjs idle --help
node client/bin/simbroker.mjs capacity check --repo-root <repo> [--purpose <purpose>] --json
node client/bin/simbroker.mjs capacity reconcile --repo-root <repo> [--purpose <purpose>] --json
node client/bin/simbroker.mjs capacity reconcile --repo-root <repo> [--purpose <purpose>] --apply --confirm <plan-id> --actor-type human --actor-id <operator-id> --json
node client/bin/simbroker.mjs idle status --json
node client/bin/simbroker.mjs idle enable --grace-seconds <60-86400> --actor-type human --actor-id <operator-id> --json
node client/bin/simbroker.mjs idle disable --actor-type human --actor-id <operator-id> --json
node client/bin/simbroker.mjs idle reconcile --json
node client/bin/simbroker.mjs idle cleanup --json
node client/bin/simbroker.mjs idle cleanup --apply --confirm <plan-id> --actor-type human --actor-id <operator-id> --json
bash scripts/install_local.sh
bash scripts/install_local.sh --cli-only
bash scripts/install_distribution.sh --payload-root <payload-root>
bash scripts/install_distribution.sh --payload-root <payload-root> --cli-only --profile <profile-path>
bash scripts/package_distribution.sh --team-id <team-id> --signing-identity '<identity>'
bash scripts/package_local.sh
bash scripts/install_smoke.sh
bash scripts/package_smoke.sh
npm run package:cli
npm run package:cask-zip
npm run package:distribution
npm run package:local
npm run test:package-smoke
bash scripts/generate_app_project.sh
bash scripts/test_app.sh
bash scripts/test_app.sh --build-only
bash scripts/test_app.sh --only-testing SimulatorBrokerAppTests/BrokerDashboardStoreTests
bash scripts/test_app.sh --only-testing SimulatorBrokerAppTests/BrokerSnapshotLoaderTests --result-bundle-path "$PWD/artifacts/app-test.xcresult"
npm run agent:context -- --paths README.md broker-core/ client/ package.json spec/README.md spec/architecture.md spec/build-and-test.md spec/global-simulator-broker.md spec/implementation-plan.md spec/project-structure.md --session-dir "${AGENT_HOME:-$HOME/.agents}/agent-harness/simulator-broker/phase8-exit-code-contract" --session-mode long-running
npm run agent:plan -- --session-dir "${AGENT_HOME:-$HOME/.agents}/agent-harness/simulator-broker/phase8-exit-code-contract"
npm run agent:verify -- --profile implementation --paths broker-core/ client/ --session-dir "${AGENT_HOME:-$HOME/.agents}/agent-harness/simulator-broker/phase8-exit-code-contract"
npm run agent:verify -- --profile spec-only --paths README.md broker-core/ client/ package.json spec/README.md spec/architecture.md spec/build-and-test.md spec/global-simulator-broker.md spec/implementation-plan.md spec/project-structure.md --session-dir "${AGENT_HOME:-$HOME/.agents}/agent-harness/simulator-broker/phase8-exit-code-contract"
npm run agent:handoff -- --session-dir "${AGENT_HOME:-$HOME/.agents}/agent-harness/simulator-broker/phase8-exit-code-contract"
npm run agent:evaluate -- --session-dir "${AGENT_HOME:-$HOME/.agents}/agent-harness/simulator-broker/phase8-exit-code-contract"
npm run agent:complete -- --session-dir "${AGENT_HOME:-$HOME/.agents}/agent-harness/simulator-broker/phase8-exit-code-contract"
```

## Verification obligations

- `npm run agent:context -- --paths <files> --session-dir <dir>` is the routing and obligation source of truth for a task.
- Task session dirs live under `${AGENT_HOME:-$HOME/.agents}/agent-harness/simulator-broker/`. The product slug is `simulator-broker`; it is not derived from `package.json` name `simulator-broker-app` or from the checkout directory. Codex harness actions in `.codex/environments/environment.toml`, including `verify-specs`, must use this same product slug. `CODEX_HOME` remains a compatibility parent for legacy session roots.
- Implementation-owned paths require the `implementation` profile, which runs
  the complete `npm test` suite plus the `agent-harness` TypeScript build and
  Vitest suite. Specs, manifests, and harness contract paths require
  `spec-only`; mixed tasks must pass both profiles.
- `WORKFLOW.md` invokes `./scripts/validate.sh` for normal Symphony validation.
  The validator runs `npm test` plus the canonical diff-integrity check.
- `npm test` begins with `verify:public-surface`. Public fixtures must use
  temporary broker roots and synthetic identifiers; tests must never read from
  or write to the default broker state root.
- `scripts/package_distribution.sh` scans the staged payload and archive
  name for public-surface issues. It does not rerun full-repo
  `verify:public-surface`; that gate is local `npm test`. Client tests
  that invoke those payload scans skip when `CI=true` or the platform is
  not Darwin.
- `npm run agent:complete -- --session-dir <dir>` is the close-out gate; it fails unless the required verification profiles passed against the current task-tree fingerprint and any blocking obligations are satisfied or the session is explicitly reported blocked.
- Every meaningful task commit must use a structured git message with `Why:`, `Changed:`, `Verification:`, `Affected:`, `Refs:`, and `Session:` sections. Commit messages are durable public output: use repo-relative paths, GitHub URLs, commit SHAs, and public task artifact labels such as `task-sessions/<session-name>` instead of machine-local or parent-relative paths. `agent:complete` rejects detected local-path forms in every new commit touching task paths.
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
- `npm run test:broker-core` also proves most-recent-release reuse for UI and
  build capacity, concurrent standby expansion, boot-on-acquire rollback,
  grace-boundary eligibility, all safety exclusions, stale grace restart,
  mutation-lock serialization, shutdown failure repair state, and confirmed
  count-only cleanup
- `npm run test:client` proves service lifecycle, concurrent clients, startup readiness before service metadata publication, restart safety, missing-worker degradation, on-disk runtime replacement detection, exact client/daemon runtime compatibility, state-preserving explicit upgrade restart, malformed service response handling, required exact runtime identity before command worker dispatch, path-compatible stop dispatch, NDJSON event streaming including stop with an active follower, service-backed lifecycle-control flows and boot readiness budgets against the fixture-backed `simctl` boundary, stable direct plus service-backed exit-code behavior, useful command help, direct/service capacity and idle parity, lazy daemon start, local-only scheduler limitation, immediate startup reconciliation, 30-second timer wiring, and snapshot refresh
- `npm run test:app` proves the XcodeGen project builds, embeds the root package runtime version, rejects missing or mismatched service runtime versions before exposing command authority, recognizes only exact `409` `service-runtime-incompatible` status with `running: true` and matching service identity as verified restart-required recovery, keeps other conflict/non-success/malformed/missing/mismatched/timeout results unverified, decodes snapshots, filters pin candidates, bounds local CLI subprocesses, preserves refresh diagnostics after successful mutations whose snapshot reload fails, revokes cached service authority after a current-generation refresh failure until a later exact-status success, keeps confirmed service absence and verified restart-required status recovery-capable across snapshot-only decode failures while healthy service plus the same failure stays unverified, represents unverified service status with or without a cached snapshot including first load with an existing host configuration while preserving true and cached missing-host onboarding, dismisses pending service mutations and delayed idle previews across every service-authority or runtime-health transition, including confirmed absence to live service, without letting in-flight lifecycle responses republish them, cancels guided setup still previewing or awaiting confirmation while preserving setup already applying, refreshes intentional setup cancellation outside the cancelled task and discards late setup-generation results so replacement setup is not poisoned, does not start that recovery refresh after dashboard-store lifecycle shutdown, treats refresh-loop cancellation as discarded without revoking cached authority or publishing an error, propagates mutation/setup cancellation without retry and resumes superseded refresh waiters exactly once, blocks confirm/mutate paths while authority is revoked, prevents superseded failures from downgrading newer state, routes broker-command errors correctly, preserves selected host-config, state-root, and service-socket paths in the unverified-status CLI fallback and keeps that command visible with a cached snapshot, and drives Automatic shutdown apply, disable, preview, confirmation, cleanup, and refresh flows
- the generated app test scheme receives a per-run temporary state root and
  host-config path from `scripts/test_app.sh`; the XCTest host never launches
  against the default broker state root
- `npm run verify:public-surface` proves the tracked public text has no current
  home path or prohibited local broker artifact and applies optional rules from
  ignored `.public-safety.local` without printing matched values
- `npm run test:app:build` isolates compile-time failures with the same XcodeGen and derived-data settings used by the full suite
- `npm run test:app:focus -- <filter>` reruns one named XCTest scope and writes a stable `xcresult` bundle under `artifacts/app-tests/` unless the caller overrides the path explicitly
- `./script/build_and_run.sh` is the canonical local macOS app run loop, stops only the app instance launched from the current checkout's built app path, and `./script/build_and_run.sh --verify` proves that built app launches as a foreground `.app`
- `./script/build_and_run.sh --telemetry` proves the app emits filterable `AppLifecycle` and `Refresh` unified logs during a live run, while `bash scripts/test_app.sh` exercises `Setup` and `Commands` events in focused app tests
- the installer prints the installed CLI path, app path when an app was installed, env helper path, any current-shell PATH warning, PATH persist result, and the next command (`command -v simbroker` after persist, or `source "<env-helper>"` when persist is skipped)
- `bash scripts/install_local.sh --cli-only` installs the CLI runtime without invoking `xcodegen` or `xcodebuild` and without requiring an app bundle
- `npm run package:cli` writes `artifacts/cli/simulator-broker-<version>-cli.tar.gz` plus a SHA-256 checksum and does not invoke XcodeGen or `xcodebuild`
- `npm run package:cask-zip` writes `artifacts/distribution/Simulator-Broker-<version>.zip` plus a SHA-256 checksum from a Developer ID-signed, stapled `Simulator Broker.app` using `ditto -c -k --keepParent`. It verifies the sealed signature with `codesign --verify --deep --strict`, requires `CFBundleIdentifier`/`Identifier` `dev.codex.simulator-broker-app`, runs `xcrun stapler validate` before writing the zip, and does not build, sign, notarize, staple, tag, or publish
- `.github/workflows/ci.yml` runs `test:docs`, `test:broker-core`, and
  `test:harness-adoption` on `ubuntu-latest` (10 minutes) and `test:client` on
  `macos-latest` (15 minutes). `.github/workflows/release.yml` runs
  `test:docs` after tag/version validation and before package creation. These
  workflows do not run `npm run test:app`; pull-request CI does not run
  `npm run verify:public-surface`
- the GitHub-hosted CI, tagged-release, and on-demand OCR workflows use
  `actions/checkout@v7` plus `actions/setup-node@v7`; every setup-node step
  explicitly disables implicit package-manager caching while preserving its
  existing Node test version
- `.github/ISSUE_TEMPLATE/` ships install-failure, bug, and feature forms, and
  `.github/pull_request_template.md` is a public-patch checklist that does not
  require `agent:context` or a task session directory
- `host init --bootstrap-config` writes a warning that real Simulator devices will be created before it calls `simctl` create
- `node --test docs/test/installed-app-smoke-evidence.test.mjs` proves the installed-app evidence verifier accepts the known unified-log preamble, valid NDJSON, and count sentinel; correlates one exact PID, canonical executable, state root, and a valid snapshot `generatedAt` equal to or newer than the prepared lower bound; rejects wrong or split identities, earlier/invalid/`none` generations, missing evidence, and malformed complete records; accepts a newer valid generation; and ignores only an unterminated final line during polling
- `npm run test:install-smoke` proves a fresh-machine-style install can bootstrap host config, scaffold a repo, start the service, acquire a lease, start a bounded exact-path unified-log capture, prepare a snapshot-generation lower bound with the installed CLI immediately before launch, use a fresh-window launch, launch exactly one installed app process for the canonical bundle executable, and prove that same live PID reports the exact state root plus a successful manual refresh for that prepared-or-newer snapshot generation. Its summary must set `launchVerified`, `snapshotDecodeVerified`, and `refreshVerified` to `true`; cleanup revalidates executable identity before stopping only that PID, restores any preexisting default install metadata including symlink target contents, and deletes only simulators provisioned by the smoke run
- `npm run package:distribution` builds the app in `Release`, requires operator-supplied `SIMBROKER_DISTRIBUTION_TEAM_ID` plus `SIMBROKER_DISTRIBUTION_SIGNING_IDENTITY`, optionally consumes `SIMBROKER_NOTARYTOOL_PROFILE`, verifies the app's embedded expected runtime version exactly matches `package.json` before staging or signing, and writes a machine-readable readiness summary under `artifacts/distribution/`
- when notarization credentials are unavailable, `npm run package:distribution` still writes the summary JSON and tells the operator to rerun with `SIMBROKER_NOTARYTOOL_PROFILE` instead of implying the archive is Gatekeeper-ready
- `npm run package:distribution` returns non-zero after writing its summary JSON when the artifact is still unsigned, unstapled, unnotarized, or rejected by `spctl`
- `npm run test:package-smoke` proves the zipped local-debug portable bundle can be unpacked, installed through its bundled `install.sh`, and delegate to the same host-bootstrap, repo-scaffold, lease, snapshot, exact-process snapshot-decode evidence, and cleanup flow as the repo-local installer
- `implementation` verification passes for implementation-owned changes
- `spec-only` verification passes for spec or harness changes
- task-session closeout rejects stale required verification and committed path drift outside selected manifest constraints
- README and `spec/harness-integration.md` now describe a no-hidden-step onboarding path: CLI-only install, persisted PATH, then repo onboarding commands. The env helper remains a current-shell fallback
- manual CLI and service smoke artifacts are captured in the active session dir when a task changes the CLI, service, or broker core
- manual app smoke artifacts include key window captures for overview, empty-state, simulator detail, destructive confirmation, and override-required remediation scenarios in addition to visibility states
- app overview, simulator detail, and no-snapshot states may be launched deterministically for review with `open --fresh --new -a /path/to/SimulatorBrokerApp.app --args --state-root <root> [--host-config <path>] [--cli-path <path>] [--pane <pane>] [--simulator-alias <alias>]`
- onboarding work should capture install-smoke logs, installed-app screenshot evidence, and the corresponding screenshot-review artifact in the active session dir
- when a task changes the service or CLI authority path, capture durable test logs such as `test-client.log` and `npm-test.log` in the active session dir
- `agent:complete` passes after a structured task commit and clean close-out
