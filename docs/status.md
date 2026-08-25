# Current capabilities

Related: [README](../README.md), [Getting started](getting-started.md), [spec/README.md](../spec/README.md)

This Alpha already includes:

- a file-backed `broker-core` under `broker-core/`
- a `simctl` adapter for provisioning, lifecycle control, and drift observation
- the `simbroker` CLI under `client/bin/simbroker.mjs`
- a local `brokerd` service under `client/bin/brokerd.mjs` and `client/service/`
- broker-mediated `boot`, `shutdown`, `erase`, and `repair`
- stable exit codes for invalid requests, unavailable capacity, repair-needed
  aliases, override-required flows, and internal failures
- guided `simbroker setup` preview/confirmation that selects the newest
  compatible installed runtime, provisions or reuses the six starter aliases,
  starts `brokerd`, refreshes the snapshot, verifies health, and reruns without
  duplicates
- advanced `host init --bootstrap-config` compatibility with its unchanged iOS
  18 default
- `erase-on-acquire` leases behind a reset lock, with rollback if reset fails
  before a lease is handed out
- lease selection that prefers a matching pin, then compatible warm capacity,
  then shutdown capacity
- optional Automatic shutdown configured only through broker commands
- a macOS operator app with Overview, Simulators, Projects, and Events
- a broker-owned `app-snapshot.json` read model
- app-driven setup-plan review and per-repo onboarding commands. Public
  first-run order is Homebrew CLI, optional Homebrew cask, then **Set Up This
  Mac** / **Complete first-time setup** or `simbroker setup`. Homebrew does not
  create simulators. Hello world runs
  only after a host config exists and after `capacity check` for
  `agent-ui-session`. Read `purposes[].status`, not the top-level
  `status`. Stop on `unavailable` and preview with `capacity reconcile`.
  Stop on `repair_needed` and use `doctor` plus
  `simulators repair --alias <alias>`
- CLI-only install through `bash scripts/install_local.sh --cli-only`, plus
  the contributor app+CLI path `npm run install:local`
- tagged Alpha CLI tarball through `npm run package:cli` and GitHub Releases
- public Node test CI: GitHub-hosted Ubuntu for broker-core and
  harness-adoption, GitHub-hosted macOS for client tests. Home-path
  public-surface scanning is `npm test` on the operator machine.
  `package_distribution.sh` payload-scan tests also stay on local Darwin
  `npm test`; GitHub CI skips them.
- GitHub issue forms for install failure, bug, and feature, plus a light PR
  template that does not require a harness session
- Homebrew formula `fiveonecode/simulator-broker/simbroker` for the Alpha CLI
  tarball. Homebrew clones `fiveonecode/homebrew-simulator-broker` for that
  tap name; `Formula/` and `Casks/` in this repository stay the source of
  truth. Packable `simbroker` npm CLI (`npm run package:npm`), and a
  Homebrew cask that installs `Simulator Broker.app` from the signed,
  notarized GitHub Release zip when that zip is attached
- local-debug packaging through `npm run package:local`
- signed distribution packaging through `npm run package:distribution`
- `simbroker project init` for `.simulator-broker/project.json`
  with version-agnostic iPhone UI requirements by default
- `capacity check` and human-confirmed `capacity reconcile`
- `idle` inspect, reconcile, and confirm-only cleanup
- sample consumer artifacts under `examples/harness-adoption/`
- the `broker-harness-adoption` skill under `.agents/skills/broker-harness-adoption/`

Automatic shutdown is unconfigured on a fresh install. Choose a duration in
the app or CLI. Do not create or edit broker state files by hand.

Tracked-text public safety is checked with `npm run verify:public-surface`.
For an extra machine-local denylist, create an ignored `.public-safety.local`
with one private name, alias, or path per line.

## Development commands

```bash
npm test
npm run verify:public-surface
npm run test:install-smoke
npm run test:app
npm run test:client
node client/bin/simbroker.mjs service start
node client/bin/simbroker.mjs setup --json
node client/bin/simbroker.mjs service status
node client/bin/simbroker.mjs app snapshot
node client/bin/simbroker.mjs capacity check --repo-root "$PWD" --purpose agent-ui-session --json
node client/bin/simbroker.mjs idle status --json
node client/bin/simbroker.mjs pin create --repo-root "$PWD" --purpose manual-testing --alias manual-1
node client/bin/simbroker.mjs lease release --lease-file /tmp/simbroker-lease.json
node client/bin/simbroker.mjs simulators boot --alias ui-1
```

The Alpha GitHub Release attaches the signed, notarized
`Simulator-Broker-<version>.zip` used by the Homebrew cask.
