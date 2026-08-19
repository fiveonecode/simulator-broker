## What changed

<!-- A few sentences. Keep the diff focused on one change. -->

## How you verified

A public patch uses Node.js 20 and the Node suites that match the change.
You do not need the agent harness or a task session directory.

- [ ] `npm run test:broker-core` / `npm run test:client` / `npm run test:harness-adoption` as applicable, or I explained why a deterministic test is not available
- [ ] I did not commit private paths, credentials, generated Xcode projects, local broker state, or task-session artifacts

## Notes

This project is **Alpha**, **macOS-only**, and needs **Xcode** to talk to iOS
Simulators. See [CONTRIBUTING.md](CONTRIBUTING.md).
