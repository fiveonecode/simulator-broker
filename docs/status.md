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
- `host init --bootstrap-config` that provisions real simulator devices,
  including dual iPhone UI aliases (`ui-1`, `ui-2`) and a dedicated
  `build-fast` alias
- `erase-on-acquire` leases behind a reset lock, with rollback if reset fails
  before a lease is handed out
- lease selection that prefers a matching pin, then compatible warm capacity,
  then shutdown capacity
- optional Automatic shutdown configured only through broker commands
- a macOS operator app with Overview, Simulators, Projects, and Events
- a broker-owned `app-snapshot.json` read model
- app-driven first-run setup and per-repo onboarding commands
- CLI-only install through `bash scripts/install_local.sh --cli-only`, plus
  the contributor app+CLI path `npm run install:local`
- tagged Alpha CLI tarball through `npm run package:cli` and GitHub Releases
- public Node test CI on GitHub-hosted Ubuntu for broker-core, client,
  harness-adoption, and public-surface checks
- local-debug packaging through `npm run package:local`
- signed distribution packaging through `npm run package:distribution`
- `simbroker project init` for `.simulator-broker/project.json`
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
node client/bin/simbroker.mjs service status
node client/bin/simbroker.mjs app snapshot
node client/bin/simbroker.mjs capacity check --repo-root "$PWD" --purpose agent-ui-session --json
node client/bin/simbroker.mjs idle status --json
node client/bin/simbroker.mjs pin create --repo-root "$PWD" --purpose manual-testing --alias manual-1
node client/bin/simbroker.mjs lease release --lease-file /tmp/simbroker-lease.json
node client/bin/simbroker.mjs simulators boot --alias ui-1
```

## Lower-priority public follow-through

- Homebrew formula, notarized app, and npm package
- issue templates and starter issues
