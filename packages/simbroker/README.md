# simbroker

Alpha CLI for Simulator Broker. Node.js 20 or newer is required. Creating and
running iOS Simulators still requires macOS and Xcode.

```bash
npm install -g https://github.com/fiveonecode/simulator-broker/releases/download/v0.1.0-alpha.3/simbroker-0.1.0-alpha.3.tgz
simbroker --help
```

From a clone, `npm run package:npm` writes the same tarball. The repo-root
package stays private and is not this CLI.

`simbroker setup` is the safe machine onboarding path: it previews Xcode and
runtime readiness plus the exact six-device starter pool, asks once, starts the
service, refreshes the app snapshot, and verifies health. It is idempotent.
