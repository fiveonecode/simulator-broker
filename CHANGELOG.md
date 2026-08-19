# Changelog

All notable changes to Simulator Broker are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Public first-run order is Homebrew CLI, Homebrew cask, then **Set Up This
  Mac** / **Complete first-time setup** (or `host init --bootstrap-config`
  and `service start`). Hello world runs only after a host config exists
  and after `capacity check --purpose agent-ui-session`; stop on
  `unavailable` or `repair_needed` and use `doctor` / `simulators repair`.
  Homebrew does not create simulators.
- The app **Finish Local Broker Installation** copy leads with
  `brew install fiveonecode/simulator-broker/simbroker` and **Refresh**.
- `host init --bootstrap-config` `runtime-not-found` errors name
  `--ios-version` and `xcrun simctl list runtimes`. Default starter iOS
  stays `18`.

### Added

- Homebrew formula `Formula/simbroker.rb` installs the Alpha CLI tarball
  (`brew install fiveonecode/simulator-broker/simbroker`). Homebrew clones
  [`fiveonecode/homebrew-simulator-broker`](https://github.com/fiveonecode/homebrew-simulator-broker)
  for that tap name. `Formula/` and `Casks/` here stay the source of truth.
- Homebrew cask `Casks/simulator-broker.rb` installs `Simulator Broker.app`
  from the signed, notarized GitHub Release zip `Simulator-Broker-<version>.zip`.
  Tag `v0.1.0-alpha.1` now attaches that zip, and the cask pins its SHA-256.
- Packable npm CLI `packages/simbroker` (`npm run package:npm`) with a `bin`
  field. The repo-root package stays private. Tag-driven
  `.github/workflows/release.yml` attaches that tarball and no longer
  claims the release is not a Homebrew formula or npm package.

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
