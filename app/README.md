# App

The macOS operator app lives here.

Prerequisites for local build and test commands:

- macOS with Xcode and iOS Simulator support installed
- `xcodegen` available on `PATH`
- Node.js LTS available on `PATH`

Current implementation:

- XcodeGen spec in `app/project.yml`
- SwiftUI source under `app/Sources/`
- XCTest coverage under `app/Tests/`
- runtime data source is the broker-owned `app-snapshot.json` artifact under the broker state root
- broker mutations are sent through the local `brokerd` Unix socket so the app shares the same authority as the CLI
- Overview includes Automatic shutdown status, explicit duration entry,
  Apply/Disable actions, and count-confirmed cleanup over broker transport
- local-debug packaging stays available through `scripts/package_local.sh`
- Release distribution packaging now lives in `scripts/package_distribution.sh` and writes an explicit readiness summary instead of implying shipping readiness

Contributor onboarding should start from the repo root with `npm run install:local`, not from the local-debug bundle path.

Local development commands:

```bash
./script/build_and_run.sh
./script/build_and_run.sh --verify
bash scripts/generate_app_project.sh
bash scripts/test_app.sh
npm run test:app:build
npm run test:app:focus -- SimulatorBrokerAppTests/BrokerDashboardStoreTests
npm run test:app:focus -- SimulatorBrokerAppTests/BrokerSnapshotLoaderTests --result-bundle-path "$PWD/artifacts/app-test.xcresult"
npm run install:local
npm run package:local
SIMBROKER_DISTRIBUTION_TEAM_ID=<team-id> \
SIMBROKER_DISTRIBUTION_SIGNING_IDENTITY='Developer ID Application: Example (TEAMID)' \
npm run package:distribution
```

`npm run package:local` packages the Debug app into a portable local-development bundle. It is intentionally not signed, notarized, or Gatekeeper-ready for shipping.

`npm run package:distribution` builds the app in `Release`, requires operator-supplied signing inputs, runs `codesign` and `spctl`, optionally uses `SIMBROKER_NOTARYTOOL_PROFILE` for notarization and stapling, and writes a summary JSON next to the produced archive under `artifacts/distribution/`. If notarization credentials are unavailable, the command still writes the summary and tells the operator to rerun with a keychain-backed notarytool profile instead of pretending the archive is ship-ready.

If you already have the repo checkout on the target machine, prefer `npm run install:local` plus `source "$HOME/Library/Application Support/SimulatorBroker/install/env.sh"` over `npm run package:local`.

`bash scripts/test_app.sh` writes stable result bundles under `artifacts/app-tests/` by default and prints the exact `xcodebuild` command it executes, so focused reruns can be collected into a task session without reconstructing the command by hand.
Each run also gives the XCTest host a fresh temporary broker state root and
host-config path instead of touching the default local broker installation.

The Codex app `Run` action is expected to point at `./script/build_and_run.sh`.

By default the app reads:

- `~/Library/Application Support/SimulatorBroker/state/app-snapshot.json`
- `~/Library/Application Support/SimulatorBroker/state/brokerd.json`

When the local service is running, the app can:

- create and clear pins
- release active leases
- request `boot`, `shutdown`, `erase`, and `repair`
- configure or disable Automatic shutdown with an explicitly entered valid duration
- preview a count and confirm one-time cleanup of currently idle automated simulators
- surface broker override-required errors and ask the human for confirmation details

Automatic shutdown is unconfigured initially, so the duration field is blank.
The app never writes host configuration, policy, or state files directly.

The current local install flow copies the built app bundle to `~/Applications/Simulator Broker.app` by default.

For smoke tests or alternate broker fixtures, override the state root at launch time:

```bash
./script/build_and_run.sh -- --state-root /tmp/simbroker-fixture/state
```

You can also deep-link the initial operator surface for deterministic QA or handoff workflows:

```bash
./script/build_and_run.sh -- --state-root /tmp/simbroker-fixture/state --pane simulators --simulator-alias ui-2
```

An explicitly isolated broker socket can travel with the same launch context;
the app forwards it unchanged to guided setup preview and apply:

```bash
./script/build_and_run.sh -- --state-root /tmp/simbroker-fixture/state --service-socket /tmp/simbroker-fixture/brokerd.sock
```

You can also launch the app binary directly with an environment override:

```bash
SIMBROKER_STATE_ROOT="/tmp/simbroker-fixture/state" /path/to/SimulatorBrokerApp.app/Contents/MacOS/SimulatorBrokerApp
```
