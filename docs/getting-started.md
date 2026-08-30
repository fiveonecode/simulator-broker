# Getting started

Related: [README](../README.md), [Concepts](concepts.md), [Current capabilities](status.md), [CONTRIBUTING](../CONTRIBUTING.md)

This page is the newcomer install and first-run guide. Specs under `spec/` remain
the implementation contract. `simbroker` help and `simbroker doctor` print
human-readable text by default; pass `--json` for machine-readable payloads.
A small public patch follows the public-patches track in
[CONTRIBUTING.md](../CONTRIBUTING.md); it does not require the agent harness.

> **Alpha.** macOS only. Xcode is required to create or run iOS Simulators.
> Interfaces can change. Install the CLI with Homebrew or the `simbroker`
> npm package. Install the operator app with the Homebrew cask.

## Prerequisites

- macOS 14 or newer with full Xcode and iOS Simulator support installed
- Node.js 20 or newer on `PATH`
- `xcodegen` on `PATH` only if you build the macOS app from source (example:
  `brew install xcodegen`)

Repo-owned macOS app entrypoints fail fast when `xcodegen` or `xcodebuild` is
missing or unusable. The CLI-only installer does not call them.

## Install the CLI with Homebrew

```bash
brew install fiveonecode/simulator-broker/simbroker
command -v simbroker
simbroker --help
```

That formula installs the tagged Alpha CLI tarball from GitHub Releases.
Homebrew clones
[`fiveonecode/homebrew-simulator-broker`](https://github.com/fiveonecode/homebrew-simulator-broker)
for the tap name `fiveonecode/simulator-broker`. `Formula/` and `Casks/`
in this repository stay the source of truth.

## Install the app with Homebrew

```bash
brew install --cask fiveonecode/simulator-broker/simulator-broker
open -a "Simulator Broker"
```

This is the recommended app install. The cask downloads the signed, notarized
`Simulator-Broker-<version>.zip` from
[GitHub Releases](https://github.com/fiveonecode/simulator-broker/releases) and
does not require XcodeGen. The app still needs the CLI installed separately.

## Install the CLI with npm

```bash
npm install -g https://github.com/fiveonecode/simulator-broker/releases/download/v0.1.0-alpha.3/simbroker-0.1.0-alpha.3.tgz
command -v simbroker
simbroker --help
```

From a clone, `npm run package:npm` writes the same tarball. The repo-root
package stays private.

## Install the CLI from this checkout

```bash
bash scripts/install_local.sh --cli-only
command -v simbroker
simbroker --help
```

This copies `broker-core`, `client`, and `package.json` into the install prefix
and writes a `simbroker` wrapper. It does not run XcodeGen or build the app.

To install from a tagged Alpha without cloning, download
`simulator-broker-<version>-cli.tar.gz` from
[GitHub Releases](https://github.com/fiveonecode/simulator-broker/releases),
then run:

```bash
tar -xzf simulator-broker-0.1.0-alpha.3-cli.tar.gz
./simulator-broker-0.1.0-alpha.3-cli/bin/simbroker --help
```

The archive is the Node CLI only and contains that versioned top-level
directory.

- If Homebrew is present and `$(brew --prefix)/bin` is writable, the wrapper
  is installed there so a new login shell already has it on `PATH`.
- Otherwise the wrapper is installed to `~/.local/bin` and the installer
  appends one guarded PATH snippet to your login profile (`~/.zprofile` on
  zsh). The snippet is idempotent.
- `source "$HOME/Library/Application Support/SimulatorBroker/install/env.sh"`
  remains a fallback for the current shell.

## Build the app from source (contributors)

```bash
npm run install:local
command -v simbroker
open "$HOME/Applications/Simulator Broker.app"
```

That path builds the Debug app, copies the CLI runtime, writes `simbroker`,
and copies `Simulator Broker.app` to `~/Applications`. It also persists PATH
the same way as the CLI-only installer. This source-build path requires
XcodeGen; the Homebrew cask does not.

## First-run host setup

Install the Homebrew CLI first and the app cask if you want the dashboard. Then
do this before hello world. Homebrew does not create Simulator devices.

1. Launch `Simulator Broker.app`.
2. If it shows **Set Up This Mac**, click **Complete first-time setup**.
3. Review Xcode readiness, the automatically selected iOS runtime, available
   disk space, and all six Create/Reuse rows.
4. Confirm **Create 6 Simulators & Finish Setup** (the count adjusts when an
   exact matching Simulator can be reused).
5. Wait until the dashboard reports that `brokerd` is running and every managed
   Simulator is healthy.

If the app says **Finish Local Broker Installation**, install the
Homebrew CLI (`brew install fiveonecode/simulator-broker/simbroker`) and
click **Refresh**.

The CLI is the same guided flow:

```bash
simbroker setup
```

It performs a read-only preview first and asks once before making changes. Use
`--ios-version 26` for the newest installed compatible 26.x runtime or an exact
value such as `--ios-version 26.4`. If no compatible runtime is installed,
setup shows Xcode Settings > Components and `xcodebuild -downloadPlatform iOS`
as manual recovery; it never downloads a runtime, accepts a license, runs
first-launch tasks, or invokes `sudo` for you.

In a non-interactive shell, preview and apply explicitly:

```bash
simbroker setup --json
simbroker setup --apply --confirm <plan-id> --json
```

`host init --bootstrap-config` remains available as an advanced compatibility
command and retains its iOS 18 default, but it is not the newcomer setup path.

After a lease is released, its Simulator may stay booted for fast reuse. This
is expected: Automatic shutdown is off by default. Check the current policy or
opt in with a human-chosen grace period:

```bash
simbroker idle status
simbroker idle enable --grace-seconds <60-86400> --actor-type human --actor-id <operator-id>
```

Then register each repo you want the broker to know about:

```bash
simbroker project init --repo-root /path/to/repo
simbroker project validate --repo-root /path/to/repo
```

For agent-first repos, follow [spec/harness-integration.md](../spec/harness-integration.md)
or the `broker-harness-adoption` skill.

## Hello world

Run this only after a host config exists from first-run setup.

```bash
mkdir -p /tmp/sample-broker-repo && cd /tmp/sample-broker-repo
simbroker project init
simbroker project validate
simbroker capacity check --purpose agent-ui-session --json
```

Read `purposes[].status` (and `summary` counts), not the top-level
`status`. Top-level `status` is only `ready` or `needs_attention`.

If `purposes[].status` is `unavailable`, stop. Preview missing capacity
with `simbroker capacity reconcile --json`. Do not acquire a lease.

If `purposes[].status` is `repair_needed`, stop. Run `simbroker doctor`,
then `simbroker simulators repair --alias <alias>` for the alias doctor
names. Do not acquire a lease.

If `purposes[].status` is `available`:

```bash
simbroker lease acquire --purpose agent-ui-session --lease-file /tmp/simbroker-hello-lease.json
simbroker host status
simbroker lease release --lease-file /tmp/simbroker-hello-lease.json
```

## Reinstall with Homebrew

Do not take the broker offline while it has an active lease or pin. First
inspect `simbroker host status --json`, wait until it reports none, then:

```bash
simbroker service stop
osascript -e 'quit app "Simulator Broker"'
brew update
brew reinstall fiveonecode/simulator-broker/simbroker
brew reinstall --cask fiveonecode/simulator-broker/simulator-broker
simbroker service start
open -a "Simulator Broker"
simbroker setup
```

Homebrew reinstall preserves
`$HOME/Library/Application Support/SimulatorBroker/host-config.json` and the
`state/` directory. `simbroker setup` verifies that existing data and repairs
only missing setup stages. A source install can instead rerun
`bash scripts/install_local.sh --cli-only` or `npm run install:local` after the
same stop and quit steps.

## Uninstall

After active leases and pins are gone, remove the app, CLI, and tap with:

```bash
simbroker service stop
osascript -e 'quit app "Simulator Broker"'
brew uninstall --cask fiveonecode/simulator-broker/simulator-broker
brew uninstall fiveonecode/simulator-broker/simbroker
brew untap fiveonecode/simulator-broker
```

Those commands preserve host configuration and broker state under
`$HOME/Library/Application Support/SimulatorBroker/`, so a later reinstall can
reuse them. To intentionally reset all broker configuration, leases, pins, and
event history too, run this only after uninstalling and after all leases end:

```bash
rm -rf "$HOME/Library/Application Support/SimulatorBroker"
```

That reset does not remove `.simulator-broker` files from repositories or
delete Simulator devices from Xcode.

## Removing a stale project registration

If a repository moved or was deleted, remove only its local registration:

```bash
simbroker project forget --project-id <project-id> --json
```

The command is idempotent. It refuses to remove a project that still has an
active lease or pin.

## Troubleshooting a broken local install

- If `command -v simbroker` resolves into this git checkout
  (`client/bin/simbroker.mjs`), the shell is still using a dev wrapper.
- If `env.sh` is missing after a setup attempt, treat the machine as
  partially installed.
- Stop `brokerd` and quit the app before deleting install paths. Then remove
  `~/.local/bin/simbroker`, `~/Applications/Simulator Broker.app`, and
  `~/Library/Application Support/SimulatorBroker/install`. Re-run
  `npm run install:local`.
- Leave `~/Library/Application Support/SimulatorBroker/host-config.json` and
  `state/` in place unless you intend to reset live broker state.

## Local-debug and signed packaging

`npm run package:local` builds an unsigned Debug zip for developers. It is not
Gatekeeper-ready.

Signed distribution packaging is a separate operator path:

```bash
SIMBROKER_DISTRIBUTION_TEAM_ID=<team-id> \
SIMBROKER_DISTRIBUTION_SIGNING_IDENTITY='Developer ID Application: Example (TEAMID)' \
npm run package:distribution
```

After Developer ID notarization and stapling of
`payload/app/Simulator Broker.app`, write the Homebrew cask zip:

```bash
npm run package:cask-zip
```

GitHub Releases attach the Alpha CLI tarball and the signed, notarized
`Simulator-Broker-<version>.zip`. The Homebrew cask
`fiveonecode/simulator-broker/simulator-broker` installs
`Simulator Broker.app` from that zip. Reproduce the zip with
`npm run package:cask-zip` from `payload/app/Simulator Broker.app` after
`npm run package:distribution` and Developer ID notarization.

## Report a problem

Use the GitHub issue forms. Pick **Install failure**, **Bug**, or **Feature**.
Do not paste credentials, private home paths, or live lease files. Security
reports go through [SECURITY.md](../SECURITY.md), not a public issue.

## What to read next

- [Concepts](concepts.md)
- [Current capabilities](status.md)
- [Harness integration](../spec/harness-integration.md)
