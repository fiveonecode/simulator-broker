# Changelog

All notable changes to Simulator Broker are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Guided, deterministic `simbroker setup` preview and confirmed apply for
  prerequisite checks, newest-compatible runtime selection, the six-device
  starter pool, atomic provisioning, `brokerd` startup, snapshot refresh, and
  health verification. Setup blocks file-shaped destination ancestors before
  mutation, rechecks the post-doctor snapshot for unavailable or
  `repair-needed` aliases, and gives the macOS app a lock/rollback/finishing
  timeout with the same cooperative escalation window used on Stop.
- A macOS setup-plan sheet with all six aliases, runtime/build and disk details,
  remediation commands, exact plan confirmation, cooperative Stop, and
  cancellation-aware task ownership.

### Changed

- Guided setup binds existing-host confirmation to the requested `--host-id`,
  uses the separate device-type inventory when a runtime omits
  `supportedDeviceTypes`, and fails closed when known-projects or lease/pin
  JSON cannot be loaded instead of reporting `ready`.
- Ubuntu Node CI no longer treats `git diff-files` exit `1` as “scan every
  index blob”, in-process `brokerd` tests inject the fixture `simctl`
  adapter, client tests run with `--test-concurrency=1 --test-timeout=120000`
  on Ubuntu CI, `brokerd` and `simbroker` client tests run one at a time,
  CLI helpers bound `service start` waits, and `service start` stops waiting
  when spawned `brokerd` exits even if a startup lock directory remains.
  Ubuntu CI does not use `--test-force-exit`; on Node 20 that flag cancels
  later queued `describe()` tests.
- Broker-core process fixtures inject a synthetic controller pid so Ubuntu
  CI cannot classify a fixture requester as `current-broker-process` when
  the test-runner pid lands on a hardcoded fixture pid such as `2500`.
- New project scaffolds require an iPhone for UI purposes without pinning an
  iOS version unless `--ios-version` is explicit.
- Homebrew CLI and app metadata now require macOS 14 Sonoma, matching the app
  deployment target.
- Newcomer documentation and install/package smoke tests use `simbroker setup`;
  `host init --bootstrap-config` remains an advanced compatibility command.

## [0.1.0-alpha.2] - 2026-08-20

This tag is the first Homebrew CLI tarball, npm tarball, and notarized
app zip that match the public first-run docs on `main`.

### Changed

- Public first-run order is Homebrew CLI, Homebrew cask, then **Set Up This
  Mac** / **Complete first-time setup** (or `host init --bootstrap-config`
  and `service start`). Hello world runs only after a host config exists
  and after `capacity check --purpose agent-ui-session`. Read
  `purposes[].status`, not the top-level `status`. Stop on `unavailable`
  and preview with `capacity reconcile`. Stop on `repair_needed` and use
  `doctor` plus `simulators repair --alias <alias>`. Homebrew does not
  create simulators.
- The app **Finish Local Broker Installation** copy leads with
  `brew install fiveonecode/simulator-broker/simbroker` and **Refresh**.
  Refresh now discovers `simbroker` in Homebrew prefix `bin` as well as
  `install.json` and the clone-install default bin.
- `host init --bootstrap-config` `runtime-not-found` errors name
  `--ios-version` and `xcrun simctl list runtimes`. Default starter iOS
  stays `18`.
- Formula, cask, README npm URL, and SECURITY supported version now name
  `0.1.0-alpha.2`.

### Added

- Homebrew formula `Formula/simbroker.rb` installs the Alpha CLI tarball
  (`brew install fiveonecode/simulator-broker/simbroker`). Homebrew clones
  [`fiveonecode/homebrew-simulator-broker`](https://github.com/fiveonecode/homebrew-simulator-broker)
  for that tap name. `Formula/` and `Casks/` here stay the source of truth.
- Homebrew cask `Casks/simulator-broker.rb` installs `Simulator Broker.app`
  from the signed, notarized GitHub Release zip `Simulator-Broker-<version>.zip`.
  This tag attaches that zip, and the cask pins its SHA-256.
- Packable npm CLI `packages/simbroker` (`npm run package:npm`) with a `bin`
  field. The repo-root package stays private. Tag-driven
  `.github/workflows/release.yml` attaches that tarball.

## [0.1.0-alpha.1] - 2026-08-18

First tagged Alpha. The CLI, local `brokerd` service, and macOS operator app
already exist on `main`; this release names that surface and attaches a
downloadable CLI tarball.

### Added

- Public Node test workflow on GitHub-hosted Ubuntu for
  `verify:public-surface`, `test:broker-core`, `test:client`, and
  `test:harness-adoption`. That job does not run the macOS app suite.
  Snapshot tests inject the fixture `simctl` adapter so the suite does not
  call host `xcrun`. The default public-surface scan skips identical index
  blobs on a clean worktree, and the job budget is 30 minutes.
- `scripts/package_cli.sh` (`npm run package:cli`) builds a versioned CLI
  tarball without XcodeGen or an app build.
- Tag-driven GitHub Release workflow that attaches the CLI tarball and its
  SHA-256 checksum. Alpha tags are published as pre-releases.
- CLI-only install through `bash scripts/install_local.sh --cli-only`, with
  PATH persistence through a Homebrew prefix bin or one guarded login-profile
  snippet.
- Human-readable `simbroker` help and `simbroker doctor`, with `--json` for
  machine payloads.
- Public-patches contributing track: Node.js 20 and the Node test suites, with
  no harness session required.

### Notes

- Alpha: macOS and Xcode are still required to create and run iOS Simulators.
- This release is not a Homebrew formula, notarized app, or npm package.
