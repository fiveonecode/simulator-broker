# Simulator Broker

A local control plane so humans, AI agents, and CI jobs can share iOS Simulators
on one Mac without stealing devices from each other.

**Status:** Alpha · macOS only · Xcode required

Simulator Broker leases simulator aliases by *purpose* (for example
`agent-ui-session` or `manual-testing`) instead of hard-coding UDIDs. A local
`brokerd` service is the single authority. The macOS app shows what is leased,
pinned, booted, or unhealthy.

![Simulator Broker Overview](docs/images/macos-overview.png)

## Who this is for

- iOS and macOS engineers who run more than one simulator workflow on a machine
- people using AI coding agents that boot, reset, or test on the Simulator
- CI or unattended jobs that need a resettable device without colliding with a
  human checkout

If you only ever use one simulator by hand, you may not need this yet.

## Use it

From a clone, with Xcode, XcodeGen, and Node.js 20+ on `PATH`:

```bash
npm run install:local
source "$HOME/Library/Application Support/SimulatorBroker/install/env.sh"
command -v simbroker
open "$HOME/Applications/Simulator Broker.app"
```

There is no Homebrew formula, npm package, or GitHub Release yet. Building the
app from this checkout is the current install path. `~/.local/bin` must be on
`PATH`, or the `source .../env.sh` step is required in each new shell.

If the app shows **Set Up This Mac**, click **Complete first-time setup**.
That creates a starter simulator pool. The CLI equivalent is
`simbroker host init --bootstrap-config`, which also creates real simulator
devices.

## Develop it

Same prerequisites. Then:

```bash
npm test
npm run build:app
```

Contributor setup, verification, and pull-request expectations are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Five-minute hello world

After the CLI resolves and this Mac has a host config:

```bash
mkdir -p /tmp/sample-broker-repo && cd /tmp/sample-broker-repo
simbroker project init
simbroker project validate
simbroker capacity check --purpose agent-ui-session --json
simbroker lease acquire --purpose agent-ui-session --lease-file /tmp/simbroker-hello-lease.json
simbroker host status
simbroker lease release --lease-file /tmp/simbroker-hello-lease.json
```

`host init --bootstrap-config` provisions real Simulator devices. Do not run it
casually on a machine whose simulator inventory you cannot afford to change.

## Next reading

- [Getting started](docs/getting-started.md) — install, first-run, reinstall, and uninstall
- [Concepts](docs/concepts.md) — host, project, purpose, lease, pin, and `brokerd`
- [Current capabilities](docs/status.md) — what this Alpha already implements
- [Harness integration](spec/harness-integration.md) — make a consumer repo broker-aware
- [Sample consumer repo](examples/harness-adoption/sample-consumer-repo/README.md)

## Security

Please report security issues privately through GitHub Security Advisories when
available. See [SECURITY.md](SECURITY.md).

## License

Simulator Broker is available under the MIT License. See [LICENSE](LICENSE).

## Specs

Implementation contracts live under [`spec/`](spec/README.md). Start with
[spec/global-simulator-broker.md](spec/global-simulator-broker.md) and
[spec/architecture.md](spec/architecture.md).
