# simbroker

Alpha CLI for Simulator Broker. Node.js 20 or newer is required. Creating and
running iOS Simulators still requires macOS and Xcode.

```bash
npm install -g https://github.com/fiveonecode/simulator-broker/releases/download/v0.1.0-alpha.2/simbroker-0.1.0-alpha.2.tgz
simbroker --help
```

From a clone, `npm run package:npm` writes the same tarball. The repo-root
package stays private and is not this CLI.

> **Next Alpha availability:** the published `0.1.0-alpha.2` package predates
> guided setup. `simbroker setup` is currently available from `main` and source
> installs; use the clone installer to try it now, or wait for the next Alpha.

`simbroker setup` is the safe machine onboarding path: it previews Xcode and
runtime readiness plus the exact six-device starter pool, asks once, starts the
service, refreshes the app snapshot, and verifies health. It is idempotent.
