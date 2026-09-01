# Security Policy

## Supported Versions

Security fixes are considered for the current `main` branch and for the latest
tagged Alpha (`0.1.0-alpha.7`). Older Alpha tags are not supported. The
published Alpha has exactly four custom GitHub Release assets:

1. `simulator-broker-0.1.0-alpha.7-cli.tar.gz`
2. `simulator-broker-0.1.0-alpha.7-cli.tar.gz.sha256`
3. `simbroker-0.1.0-alpha.7.tgz`
4. `Simulator-Broker-0.1.0-alpha.7.zip`

The Homebrew formula and cask install the matching CLI and signed, notarized
app archives. GitHub's generated source archives appear separately.

## Reporting A Vulnerability

Use GitHub Security Advisories for private reports when available. If that is
not available, email `support@51code.tw` with a subject that starts with
`Security: simulator-broker`. Do not open a public GitHub issue for
vulnerability reports.

Do not include live credentials, private machine paths, private task links, or
third-party customer data in public issues, pull requests, logs, or examples.

Useful private report details include:

- affected command, script, or app surface
- exact version or commit
- reproduction steps using synthetic data
- observed impact
- any safe, redacted logs
