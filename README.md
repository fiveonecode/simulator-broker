# Simulator Broker

A local control plane so humans, AI agents, and CI jobs can share iOS Simulators
on one Mac without stealing devices from each other.

**Status:** Alpha · macOS only · Xcode required
[![Node tests](https://github.com/fiveonecode/simulator-broker/actions/workflows/ci.yml/badge.svg)](https://github.com/fiveonecode/simulator-broker/actions/workflows/ci.yml)

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

From a clone, with Node.js 20+ on `PATH`:

```bash
bash scripts/install_local.sh --cli-only
command -v simbroker
simbroker --help
```

That copies the CLI runtime only. It does not run XcodeGen or build the macOS
app. If Homebrew is installed, `simbroker` lands in `$(brew --prefix)/bin`.
Otherwise the installer writes `~/.local/bin/simbroker` and one guarded
login-shell PATH line. Open a new terminal if this shell still cannot resolve
`simbroker`. `source .../env.sh` remains a fallback.

To try a tagged build without cloning, download
`simulator-broker-<version>-cli.tar.gz` from
[Releases](https://github.com/fiveonecode/simulator-broker/releases), extract
it, and run `./bin/simbroker --help`. Node.js 20+ is still required.

Xcode is still required to create and run iOS Simulators. Alpha CLI tarballs
are attached to
[GitHub Releases](https://github.com/fiveonecode/simulator-broker/releases).
There is no Homebrew formula or npm package yet.

`simbroker` help and `simbroker doctor` print human-readable text by default.
Pass `--json` for machine-readable payloads.

First-run host setup is `simbroker host init --bootstrap-config`. It prints a
warning and then creates real Simulator devices. Do not run it casually on a
machine whose simulator inventory you cannot afford to change.

To install the operator app as well, use the contributor command in
[Develop it](#develop-it).

## Develop it

Same Node.js requirement, plus Xcode and XcodeGen, then:

```bash
npm run install:local
npm test
npm run build:app
```

`install:local` builds the Debug app, installs the CLI, and copies
`Simulator Broker.app` to `~/Applications`.

Contributor setup is in [CONTRIBUTING.md](CONTRIBUTING.md). A small public
patch uses Node.js 20 and the Node test suites. Maintainers and agent runs
keep the `agent:context` / `agent:verify` / `agent:complete` track.

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
