# Simulator Broker App

Standalone home for a reusable simulator broker plus macOS app surface.

## License

Simulator Broker is available under the MIT License. See [LICENSE](LICENSE).

Current status:

- a first extracted file-backed `broker-core` slice exists under `broker-core/`
- a real `simctl` adapter boundary now exists under `broker-core/simctl.mjs` for provisioning, lifecycle control, and drift observation
- a first `simbroker` CLI exists under `client/bin/simbroker.mjs`
- a first `brokerd` local service exists under `client/bin/brokerd.mjs` and `client/service/`
- broker-mediated lifecycle controls for `boot`, `shutdown`, `erase`, and `repair` now exist in the CLI and service contracts
- direct and service-backed broker failures now expose stable exit codes for invalid requests, unavailable capacity, repair-needed aliases, override-required flows, and internal failures
- `host init --bootstrap-config` now provisions real simulator devices, including dual iPhone UI aliases (`ui-1`, `ui-2`), a second dedicated `build-fast` alias for overlapping build-test demand, and records their actual IDs and runtime versions in host config
- `erase-on-acquire` leases now run behind a dedicated reset lock and roll back cleanly if reset fails before a lease is handed out
- a macOS operator app now exists under `app/` with Overview, Simulators, Projects, and Events screens plus broker-backed actions for pinning, release, and lifecycle control
- the macOS app overview, empty-state, simulator-detail, destructive-confirmation, and override-required remediation flows now have captured operator-facing evidence; the app also supports alternate broker roots with `--state-root`, `--host-config`, optional `--cli-path`, and direct deep-link review targeting
- the broker now publishes a canonical `app-snapshot.json` read model under the broker state root for the app and smoke tooling
- the app can issue broker commands over the local `brokerd` Unix socket without bypassing broker policy
- the app now classifies first-run setup state, can bootstrap host config and start `brokerd` through the installed CLI, and shows per-repo onboarding commands when the machine is ready but no repo has been registered yet
- a local install flow now exists through `npm run install:local` or `scripts/install_local.sh`
- a local-debug portable bundle now exists through `npm run package:local` for local development convenience, and a separate signed distribution path now exists through `npm run package:distribution`
- first-run host setup can now bootstrap a starter host config through `simbroker host init --bootstrap-config`
- fresh repos can now scaffold `.simulator-broker/project.json` through `simbroker project init`
- repo capacity can now be diagnosed with `simbroker capacity check`; missing
  broker-managed capacity can be previewed with non-mutating `capacity
  reconcile` and applied only with exact human confirmation of the current plan
- broker-aware sample consumer repo artifacts now cover manual human, interactive agent, unattended agent, and CI patterns under `examples/harness-adoption/`
- a guide-aligned `broker-harness-adoption` skill lives under `.agents/skills/broker-harness-adoption/`
- the repo is ready for continued implementation on top of the active specs

## Prerequisites

Before running any local build, install, or app test command from this repo:

- macOS with Xcode and iOS Simulator support installed
- `xcodegen` available on `PATH`
- Node.js LTS available on `PATH`

The repo-owned macOS entrypoints now fail fast with actionable errors when `xcodegen` or `xcodebuild` is missing or misconfigured.

## Immediate goals

- expand happy-path operator-control evidence beyond the current destructive and override-required remediation flows
- preserve deterministic broker behavior across repos
- preserve repo-owned policy instead of moving policy authority into the app

## Repo-Local Contributor Install

Use this path when you already have repo access on the machine and want the quickest contributor setup.

1. Run `npm run install:local`.
2. Run `source "$HOME/Library/Application Support/SimulatorBroker/install/env.sh"`.
3. Verify the shell resolves the installed CLI with `command -v simbroker`.
4. Launch `Simulator Broker.app`.
5. If the app shows `Set Up This Mac`, click `Complete first-time setup`.
6. When the dashboard shows the broker is ready, onboard each repo with `simbroker project init --repo-root /path/to/repo` and `simbroker project validate --repo-root /path/to/repo`.
7. For agent-first repos, apply the `broker-harness-adoption` skill or follow [spec/harness-integration.md](spec/harness-integration.md).

Canonical contributor flow:

```bash
npm run install:local
source "$HOME/Library/Application Support/SimulatorBroker/install/env.sh"
command -v simbroker
open "$HOME/Applications/Simulator Broker.app"
mkdir -p /tmp/sample-broker-repo && cd /tmp/sample-broker-repo
simbroker project init
simbroker project validate
simbroker capacity check --purpose agent-ui-session --json
simbroker lease explain --purpose agent-ui-session
```

The app is the preferred first-run host setup surface. Use `simbroker host init --bootstrap-config` as the CLI fallback if you are not using the app UI.

## Reinstalling An Existing Local Install

Use this sequence when replacing an existing local install. Do not take the broker offline while it has an active lease.

1. Check that there are no active leases with `simbroker host status --json`.
2. Stop the running service with `simbroker service stop`.
3. Quit `Simulator Broker.app` before replacing its bundle.
4. Run `npm run install:local`, then reload the installed environment helper.
5. Start the replacement service with `simbroker service start` and relaunch `Simulator Broker.app`.

The installer preserves the host config and broker state. It can stop and restart a service when the existing wrapper is intact, but stopping the service and quitting the app first avoids leaving an old daemon or app process attached to a replaced runtime.

## Removing a Stale Local Project Registration

If a repository has been moved or deleted, remove only its local broker registration with an explicit project ID:

```bash
simbroker project forget --project-id <project-id> --json
```

The command is idempotent, updates the broker-owned app snapshot, and preserves the repository itself and historical audit events. It refuses to remove a project that still has an active lease or pin; release or clear those first instead of editing `known-projects.json` by hand.

Troubleshooting a broken local install:

- if `command -v simbroker` resolves to a repo checkout such as `.../Projects/simulator-broker/client/bin/simbroker.mjs`, the machine is still using a dev wrapper rather than the installed runtime
- if `"$HOME/Library/Application Support/SimulatorBroker/install/env.sh"` is missing after a prior setup attempt, treat the machine as partially installed
- if `simbroker` is still available, run `simbroker service stop` and quit `Simulator Broker.app` before manually removing the install paths
- remove `"$HOME/.local/bin/simbroker"`, `"$HOME/Applications/Simulator Broker.app"`, and `"$HOME/Library/Application Support/SimulatorBroker/install"`, then rerun `npm run install:local`, reload `env.sh`, and run `simbroker service start`
- preserve `"$HOME/Library/Application Support/SimulatorBroker/state"` unless you intentionally want to reset the live broker host state

## Local-Debug Portable Bundle

Use this only for local development convenience when you want a zipped Debug bundle. It is not the primary quick-start path for repo contributors and it is not Gatekeeper-ready.

```bash
npm run package:local
npm run test:package-smoke
```

## Signed Distribution Packaging

Use this path for operator validation or shipping work. It is separate from the contributor install flow and requires operator-supplied signing inputs.

```bash
SIMBROKER_DISTRIBUTION_TEAM_ID=<team-id> \
SIMBROKER_DISTRIBUTION_SIGNING_IDENTITY='Developer ID Application: Example (TEAMID)' \
npm run package:distribution
```

## Development And Verification Commands

```bash
npm test
npm run test:install-smoke
npm run test:app
npm run test:client
node client/bin/simbroker.mjs service start --host-config "$HOME/Library/Application Support/SimulatorBroker/host-config.json"
node client/bin/simbroker.mjs service status
node client/bin/simbroker.mjs app snapshot
node client/bin/simbroker.mjs capacity check --repo-root "$PWD" --purpose agent-ui-session --json
node client/bin/simbroker.mjs capacity reconcile --repo-root "$PWD" --purpose agent-ui-session --json
node client/bin/simbroker.mjs capacity reconcile --repo-root "$PWD" --purpose agent-ui-session --apply --confirm <plan-id> --actor-type human --actor-id <operator-id> --json
node client/bin/simbroker.mjs pin create --repo-root "$PWD" --purpose manual-testing --alias manual-1
node client/bin/simbroker.mjs lease release --lease-file /tmp/simbroker-lease.json
node client/bin/simbroker.mjs simulators boot --alias ui-1
node client/bin/simbroker.mjs simulators repair --alias ui-1 --actor-type human --force-override --override-reason "recover unhealthy alias" --expected-alias ui-1 --expected-lease-id <lease-id>
npm run agent:catalog -- --format md
npm run agent:context -- --paths spec/README.md --session-dir "$HOME/.codex/agent-harness/simulator-broker-app/bootstrap"
npm run agent:verify -- --profile spec-only --paths spec/README.md --session-dir "$HOME/.codex/agent-harness/simulator-broker-app/bootstrap"
```

## Security

Please report security issues privately through GitHub Security Advisories when
available. See [SECURITY.md](SECURITY.md) for supported reporting paths and
the data that should not be posted publicly.

## Contributing

Contributor setup, verification, and PR expectations are documented in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Source of truth

- [spec/README.md](spec/README.md)
- [spec/global-simulator-broker.md](spec/global-simulator-broker.md)
- [spec/architecture.md](spec/architecture.md)
- [spec/implementation-plan.md](spec/implementation-plan.md)
- [spec/harness-integration.md](spec/harness-integration.md)
- [references/README.md](references/README.md)
