# Changelog

All notable changes to Simulator Broker are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The public Homebrew tap now runs hosted `brew style` / `brew audit`
  verification on pull requests and `main`, using the same command as its
  Autopilot origin contract.

### Fixed

- Generated app bundles now wire `CFBundleShortVersionString` and
  `CFBundleVersion` from the root package version, so Finder and About show
  the Alpha version, and distribution packaging fails closed before signing
  when either key is missing or stale.

## [0.1.0-alpha.7] - 2026-09-01

Alpha 7 keeps the Alpha 6 install and four-custom-asset contract while fixing
one app read-model regression found during the release canary.

### Fixed

- Forgetting an inactive project now keeps it out of the app's Projects list
  even when its lease history remains available in Events.

## [0.1.0-alpha.6] - 2026-09-01

Alpha 6 is the promotion-readiness follow-up to Alpha 5. It keeps the same
installation and four-custom-asset contract while correcting two first-run and
recovery clarity gaps found during live two-host validation.

### Fixed

- A configured Mac whose local controller is stopped now offers **Start
  service** in the app instead of the misleading **Finish setup** label;
  genuinely unfinished setup states retain their setup-specific actions.
- `simbroker project init` now resolves repository identity in the caller
  before dispatching through a resident `brokerd`, so the documented no-flag
  newcomer flow works even when the service was launched from another
  directory.

## [0.1.0-alpha.5] - 2026-09-01

Alpha 5 is the provenance-safe recovery release for the immutable failed
Alpha 4 tag. It keeps the same four-custom-asset contract and rebuilds every
asset from the corrected source tree.

### Fixed

- RR19 distinguishes a documented hosted-runner path from a private
  runtime-home leak while retaining positive and negative public-source
  regression coverage.
- RR20 packages the CLI README as literal data, so Markdown command examples
  cannot execute or capture checkout-root output during archive creation.
- RR21 generates the app dSYM before stripping deployment debug records, then
  rejects build paths, STABS, embedded DWARF, unexpected architectures, and
  leaks in the complete Mach-O container or either required slice.
- RR22 makes CLI packaging emit portable raw USTAR with normalized ownership,
  safe paths and modes, no AppleDouble or PAX metadata, and stale-output
  cleanup, with the same contract exercised on macOS and Ubuntu.
- RR23 gives cask ZIP packaging explicit metadata-suppression flags and a
  validated hidden candidate, rejecting AppleDouble, unsafe or extra roots,
  unsupported entry types, and stale public outputs before final publication.

## [0.1.0-alpha.4] - 2026-08-31

The `v0.1.0-alpha.4` tag is preserved as immutable failed-release evidence.
Its workflow stopped before creating a GitHub Release or uploading any custom
asset because the public-source check treated a documented hosted-runner path
as a private home-path leak. The tag must not be republished; Alpha 5
supersedes it.

This release hardens the public install, upgrade, and dashboard paths used for
the first broader Simulator Broker announcement. It also makes the complete
GitHub Release inventory explicit: CLI archive, CLI checksum, npm tarball, and
notarized app zip.

### Added

- `scripts/package_cask_zip.sh` (`npm run package:cask-zip`) writes the
  Homebrew cask zip `Simulator-Broker-<version>.zip` from a Developer
  ID-signed `Simulator Broker.app` after `package:distribution` and
  notarization. It checks version, missing app, bundle name, and
  `CFBundleIdentifier` `dev.codex.simulator-broker-app` before the
  Darwin/`ditto` gate, then refuses a signature that fails
  `codesign --verify --deep --strict` and an unstapled app with
  `xcrun stapler validate`. It does not build, sign, notarize, tag, or
  publish.
- Correlated installed-app smoke evidence now proves that the launched
  `/Applications` app decoded the freshly prepared broker snapshot and
  completed a manual refresh under one exact process, executable, state root,
  and snapshot generation.

### Changed

- Public onboarding now keeps Homebrew CLI, Homebrew cask, guided setup,
  reinstall, and direct tagged-asset commands aligned and CI-gated. Bash PATH
  persistence follows the login files Bash actually reads, while reinstall
  keeps host configuration and broker state unless reset is explicit.
- GitHub workflows use maintained Node 24 action runtimes with explicit cache
  behavior, and the agent/reliability contract now examines interacting
  conditions, degraded operation, recovery, and residual risk without adding
  unnecessary operational coupling.
- The app's timestamp wording and Automatic shutdown guidance now distinguish
  snapshot age from refresh time and explain intentional warm Simulator reuse.
- Completion fixtures and durable task evidence remain public-safe even when a
  checkout lives beneath a private machine path.

### Fixed

- `simbroker setup --help` follows the normal help path instead of entering
  setup dispatch, and installed daemon health is checked against the current
  runtime across upgrades before commands are exposed.
- The Simulators pane remains usable at the minimum supported window size.
- Dashboard refresh failures now fail closed: stale service authority cannot
  enable mutations, queued or cancelled setup/refresh work cannot publish
  after lifecycle loss, and verified recovery restores authority only after a
  current exact-status success.

## [0.1.0-alpha.3] - 2026-08-29

This tag is the first Homebrew CLI tarball, npm tarball, and notarized
app zip that include guided `simbroker setup`. Published
`0.1.0-alpha.2` artifacts predate that command. Newcomer docs no longer
warn that the current tagged install lacks setup.

### Added


- Guided, deterministic `simbroker setup` preview and confirmed apply for
  prerequisite checks, newest-compatible runtime selection, the six-device
  starter pool, atomic provisioning, `brokerd` startup, snapshot refresh, and
  health verification. Setup blocks file-shaped destination ancestors before
  mutation, rechecks the post-doctor snapshot for unavailable or
  `repair-needed` aliases, and gives the macOS app a lock/rollback/finishing
  timeout with a cooperative Stop/timeout window that also covers rollback
  and indeterminate-create inventory commands.
- A macOS setup-plan sheet with all six aliases, runtime/build and disk details,
  remediation commands, exact plan confirmation, cooperative Stop, and
  cancellation-aware task ownership.

### Changed

- Guided setup binds existing-host confirmation to the requested `--host-id`,
  uses the separate device-type inventory when a runtime omits
  `supportedDeviceTypes`, treats an available iOS runtime that omits `version`
  or reports a version outside the host-config `<major>` / `<major.minor>`
  schema as not qualifying for planning, treats device-type records that omit
  identifier or name as not qualifying for planning, and fails closed when
  known-projects, registry, or lease/pin JSON cannot be loaded or is not a
  complete identity record instead of reporting `ready`. A missing host-config
  with an existing invalid known-projects catalog is blocked before
  provisioning. Host-config occupancy uses the directory entry itself, so a
  dangling symlink is a non-file path blocker rather than a missing destination.
  A matching Simulator is reused only when it also has a non-empty string UDID.
  Incomplete live leases that omit snapshot-required fields, pins that omit
  project identity, live leases whose
  `ownerPid` is a numeric string or a JSON number outside the safe integer
  range, and persisted registry alias data with an unrecognized `health` or
  `powerState` value or no configured host aliases stay blocked instead of
  being normalized during automatic finishing. A missing host-config with an
  existing registry, lease, or pin record in the selected state root is blocked
  rather than treated as a confirmable fresh plan.
  Preview probes service identity even when no host is configured yet, and
  confirmed apply revalidates that identity before provisioning, so a
  socket occupied by a different broker is blocked before device creation.
  `ready` also requires the app snapshot to be at least as new as
  known-projects, lease/pin records, and the lease/pin directories, and to
  match the current doctor-record set, so deletions are finishing work rather
  than a stale `ready`. Fallback device-type selection is identifier-stable
  when preferred names are absent, and preferred-name matches with the same
  display name stay identifier-stable when inventory order changes. Setup
  failure recovery commands, including
  service-identity retries, keep the selected `--host-config`, `--state-root`,
  and `--service-socket` paths. The macOS app keeps automatic service/snapshot
  finishing off the first-time review sheet and refreshes the dashboard when
  setup preview is already `ready`. Setup apply Stop/timeout waits for rollback
  inventory calls before escalating to SIGKILL. Occupied non-file
  `registry.json` or JSON-named lease/pin entries, including dangling
  symlinks, block a confirmable fresh plan. A dangling `known-projects.json`
  symlink is an invalid catalog rather than a missing file, including on an
  already configured host. A dangling `registry.json` symlink on an already
  configured host is invalid existing registry state rather than a missing
  registry that finishing may reconstruct and replace. Snapshot integers must
  be JSON numbers in the safe integer range so the macOS dashboard can decode
  them as `Int`, and duplicate snapshot `projectId` values, pin `alias`
  values, or simulator `alias` values are finishing work rather than `ready`.
  Two valid purpose records in one known-projects catalog project that share
  the same `id` stay blocked instead of collapsing into a `ready` snapshot.
  Setup ignores runtime records whose `identifier` is not a non-empty string,
  keeps duplicate same-identifier runtime records plan-stable by supported
  device-type identity, and samples apply registry/`host.initialized`
  timestamps after both provisioning locks. Occupied `registry.json` and
  `known-projects.json` FIFOs and other non-files fail closed before JSON
  read. Occupied `leases/` or `pins/` paths that do not resolve to directories,
  including dangling directory symlinks, block a confirmable fresh plan and
  configured-host `ready`. Occupied `capacity-transactions/` or `evidence/`
  paths that do not resolve to directories, including files, FIFOs, and
  dangling directory symlinks, are the same class of existing-state failure,
  so setup cannot commit a host and then fail while creating those
  directories. Occupied `idle-policy.json` that is malformed or not
  a regular file is the same class of existing-state failure, so setup cannot
  provision a host and then fail at `brokerd` idle-policy reconciliation.
  Under-lock plan recomputation treats a dangling host-config symlink as
  occupied existing host state rather than a missing destination that apply
  may replace. Path-access remediations walk past `EACCES` ancestors so
  `chmod` targets the searchable parent that actually failed, not an
  unreachable destination. Occupied `events.ndjson` that is not a writable
  regular file blocks a confirmable fresh plan so apply cannot create
  Simulators and then fail opening the audit log. Occupied `brokerd.json` that
  is not a regular file blocks setup before the service-status probe so preview
  cannot hang on a FIFO metadata read. Occupied `app-snapshot.json` that is not
  a regular file is finishing work rather than a blocking open. Occupied
  `brokerd.log` that is not a writable regular file blocks setup before the
  provisioning worker so apply cannot commit a host and then fail opening the
  service log. A leftover regular file, FIFO, directory, dangling symlink, or
  other non-socket at the selected service socket is a `service-socket`
  blocker before the status probe, and an unwritable socket ancestor is a
  distinct `service-socket-parent` blocker, so apply cannot provision a host
  and then silently delete a non-socket entry or fail after commit, and the
  setup sheet can show both remediations. Duplicate snapshot `leaseId`,
  `eventId`, or per-project `purposeId` values are finishing work rather than
  `ready`. Confirmed apply creates only the lock path before revalidation and
  defers `evidence/`, `capacity-transactions/`, `leases/`, and `pins/` until
  the current plan ID matches.
  Snapshot `overview.leaseSaturation` outside `0` through `1` is
  finishing work rather than `ready`. The non-TTY copyable apply command
  includes the resolved `--host-config`, `--state-root`, and
  `--service-socket` paths even when those were selected only through
  environment variables.
  Complete lease
  records that name an unknown alias, point at another alias's Simulator, or
  share an alias with another lease file stay blocked instead of `ready`.
  Complete pin records that name an unknown alias or share an alias with
  another pin file stay blocked instead of collapsing into a `ready` snapshot.
  Snapshot freshness requires the snapshot simulator alias set to equal the
  current host alias set, so extra stale rows are finishing work.
  A truncated `app-snapshot.json` that omits dashboard-required fields such as
  `generatedAt`, `ok`, `overview`, or `recentEvents` is finishing work rather
  than `ready`. Nested snapshot records must also match the dashboard decoder:
  a simulator row with only `alias`, `simulatorId`, and `health` is finishing
  work because `BrokerSimulator` still requires `capabilities`,
  `deviceFamily`, `displayName`, `iosVersion`, and `powerState`. Deleting an
  empty `known-projects.json` is finishing work even when both project-ID
  sets are empty. Runtime `buildVersion` is emitted only
  when simctl reports a string, so a numeric build cannot reject the macOS
  setup plan decoder.
  Known-projects catalog keys must match each record `projectId`.
  Blocked-preview doctor and repair commands, plus pre-commit recovery, keep
  the selected broker paths and any explicit `--host-id` / `--ios-version`.
  Existing host-config directories or unreadable files are host-path blockers
  rather than `simctl-inventory` failures. Host-config permission remediations
  chmod the path that failed, not an already-usable parent. The macOS app omits
  `--host-id` when finishing an already configured host so a non-slug existing
  ID is not slugified into a mismatch. The macOS app hides the read-only
  `Finish setup` action while setup is applying and surfaces service log,
  doctor-issue, and incomplete-rollback diagnostics from CLI setup errors.
  After setup preview or apply, the app announces success only when the
  refreshed dashboard still has a live `brokerd`. Health-failure doctor issues
  keep path-qualified `host status` and `simulators repair` commands, and the
  macOS app now decodes those per-issue `remediationCommands` into the
  displayed setup failure. Present optional lease/pin snapshot fields such as
  `jobId`, `note`, and `purposeId` must be strings when present; mistyped
  values stay blocked instead of `ready`. Snapshot freshness compares
  catalog-backed project IDs with `known-projects.json` for set equality, so
  an empty or incomplete snapshot `projects` array is finishing work rather
  than a stale `ready`. Getting
  started now carries the same next-Alpha warning as the root README so
  published `0.1.0-alpha.2` installs are not directed at `simbroker setup`.
- Public CI no longer runs the full-repo home-path leak scan on
  GitHub-hosted runners. Ubuntu (10 minutes) runs skill ownership,
  `test:broker-core`, and `test:harness-adoption`. macOS (15 minutes)
  runs `test:client`. `verify:public-surface` stays on local `npm test`
  so it searches the operator home path. `package_distribution.sh`
  scans the staged payload only and does not rerun the full-repo scan.
  GitHub CI skips those payload-scan tests; they stay on local Darwin
  `npm test` because they exceed the 120-second client-file timeout.
  Client tests still use `--test-concurrency=1 --test-timeout=120000`
  without `--test-force-exit`, in-file `describe` concurrency `1`,
  referenced keepalive children, fixture `simctl` for in-process
  snapshots, and synthetic containment pids.
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
