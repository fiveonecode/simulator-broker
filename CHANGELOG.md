# Changelog

All notable changes to Simulator Broker are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Homebrew formula `Formula/simbroker.rb` installs the Alpha CLI tarball
  (`brew install fiveonecode/simulator-broker/simbroker`).
- Homebrew cask `Casks/simulator-broker.rb` installs `Simulator Broker.app`
  from the signed, notarized GitHub Release zip `Simulator-Broker-<version>.zip`
  when that zip is attached.
- Packable npm CLI `packages/simbroker` (`npm run package:npm`) with a `bin`
  field. The repo-root package stays private.

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
