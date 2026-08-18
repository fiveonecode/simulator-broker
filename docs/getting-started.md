# Getting started

Related: [README](../README.md), [Concepts](concepts.md), [Current capabilities](status.md), [CONTRIBUTING](../CONTRIBUTING.md)

This page is the newcomer install and first-run guide. Specs under `spec/` remain
the implementation contract. `simbroker` help and `simbroker doctor` print
human-readable text by default; pass `--json` for machine-readable payloads.
A small public patch follows the public-patches track in
[CONTRIBUTING.md](../CONTRIBUTING.md); it does not require the agent harness.

## Prerequisites

- macOS with Xcode and iOS Simulator support installed
- Node.js 20 or newer on `PATH`
- `xcodegen` on `PATH` only if you install the macOS app (example: `brew install xcodegen`)

Repo-owned macOS app entrypoints fail fast when `xcodegen` or `xcodebuild` is
missing or unusable. The CLI-only installer does not call them.

## Install the CLI from this checkout

```bash
bash scripts/install_local.sh --cli-only
command -v simbroker
simbroker --help
```

This copies `broker-core`, `client`, and `package.json` into the install prefix
and writes a `simbroker` wrapper. It does not run XcodeGen or build the app.

- If Homebrew is present and `$(brew --prefix)/bin` is writable, the wrapper
  is installed there so a new login shell already has it on `PATH`.
- Otherwise the wrapper is installed to `~/.local/bin` and the installer
  appends one guarded PATH snippet to your login profile (`~/.zprofile` on
  zsh). The snippet is idempotent.
- `source "$HOME/Library/Application Support/SimulatorBroker/install/env.sh"`
  remains a fallback for the current shell.

## Install the app from this checkout

```bash
npm run install:local
command -v simbroker
open "$HOME/Applications/Simulator Broker.app"
```

That path builds the Debug app, copies the CLI runtime, writes `simbroker`,
and copies `Simulator Broker.app` to `~/Applications`. It also persists PATH
the same way as the CLI-only installer.

## First-run host setup

The app is the preferred first-run surface.

1. Launch `Simulator Broker.app`.
2. If it shows **Set Up This Mac**, click **Complete first-time setup**.
3. Wait until the dashboard shows the broker is ready.

CLI fallback, which prints a warning and then creates real simulator devices:

```bash
simbroker host init --bootstrap-config
simbroker service start
```

Then register each repo you want the broker to know about:

```bash
simbroker project init --repo-root /path/to/repo
simbroker project validate --repo-root /path/to/repo
```

For agent-first repos, follow [spec/harness-integration.md](../spec/harness-integration.md)
or the `broker-harness-adoption` skill.

## Hello world

```bash
mkdir -p /tmp/sample-broker-repo && cd /tmp/sample-broker-repo
simbroker project init
simbroker project validate
simbroker capacity check --purpose agent-ui-session --json
simbroker lease acquire --purpose agent-ui-session --lease-file /tmp/simbroker-hello-lease.json
simbroker host status
simbroker lease release --lease-file /tmp/simbroker-hello-lease.json
```

## Reinstalling

Do not take the broker offline while it has an active lease.

1. Check `simbroker host status --json` for active leases.
2. Stop the service with `simbroker service stop`.
3. Quit `Simulator Broker.app`.
4. Re-run `bash scripts/install_local.sh --cli-only` or `npm run install:local`.
   Open a new login shell if `command -v simbroker` fails.
5. Run `simbroker service start` and reopen the app.

The installer preserves host config and broker state.

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
- Leave `~/Library/Application Support/SimulatorBroker/state` in place unless
  you intend to reset live host state.

## Local-debug and signed packaging

`npm run package:local` builds an unsigned Debug zip for developers. It is not
Gatekeeper-ready.

Signed distribution packaging is a separate operator path:

```bash
SIMBROKER_DISTRIBUTION_TEAM_ID=<team-id> \
SIMBROKER_DISTRIBUTION_SIGNING_IDENTITY='Developer ID Application: Example (TEAMID)' \
npm run package:distribution
```

No signed build is published on GitHub Releases yet.

## What to read next

- [Concepts](concepts.md)
- [Current capabilities](status.md)
- [Harness integration](../spec/harness-integration.md)
