# macOS Installed App Launch Smoke
Related: `spec/tasks/README.md`, `scripts/install_smoke.sh`, `scripts/package_smoke.sh`, `scripts/install_local.sh`, `scripts/install_distribution.sh`, `spec/build-and-test.md`

> **Document ID:** `GSB-MAC-TASK-008`
> **Version:** `0.2.1`
> **Last Updated:** `2026-04-14`
> **Status:** `Implemented`
> **Owner:** `spec-steward`
> **Implementation Owner:** `ios-dev`

## 1. Objective and context

The current install and package smoke tests prove broker bootstrap, service start, lease acquire, snapshot generation, and cleanup, but they do not prove that the installed macOS app bundle can actually launch.

That leaves a gap where packaging could succeed but the app bundle could still fail at runtime.

## 2. Scope and boundaries

### In scope

- installed app launch verification in `install_smoke.sh`
- packaged app launch verification in `package_smoke.sh`
- deterministic launch arguments for smoke runs
- process cleanup after smoke launch

### Out of scope

- UI screenshot review as a hard gate
- notarization and release signing; see `GSB-MAC-TASK-009`
- full UI automation

### Required skills for implementation

- `apple-doc-research`
- `swift-concurrency-pro`
- `xcode-build`

## 3. Reproduction and current failure

Run either smoke script today and inspect the assertions:

```bash
bash scripts/install_smoke.sh
bash scripts/package_smoke.sh
```

Current behavior:

- snapshot files are validated
- broker lifecycle is validated
- the app bundle is never opened and the process is never checked

## 4. Requirements

### Functional requirements

- `REQ-001` `install_smoke.sh` must launch the installed app bundle after the smoke fixture state is prepared.
- `REQ-002` `package_smoke.sh` must launch the packaged installed app bundle after installation from the portable bundle.
- `REQ-003` Launch verification must use deterministic `--state-root` and `--host-config` arguments pointing at the smoke fixture.
- `REQ-004` Each smoke script must assert that the app process starts successfully.
- `REQ-005` Each smoke script must clean up the launched app process before exit, including failure paths.

### Minimum launch proof contract

- the app process exists after `open -na <app> --args ...`
- the launch does not crash immediately
- the app can read the smoke snapshot state prepared by the script

## 5. Implementation contract

### Write scope

- `scripts/install_smoke.sh`
- `scripts/package_smoke.sh`
- `spec/build-and-test.md` if command documentation changes

### Required implementation shape

- Use the installed app path that the script already knows or can derive deterministically.
- Pass the same state root and host config the smoke script already created.
- Use `pgrep -x SimulatorBrokerApp` or an equally deterministic process-existence proof.
- Add a trap/finally-style cleanup path that kills the app on success and failure.
- If telemetry from `GSB-MAC-TASK-006` is available, optionally capture a small log snippet on failure, but do not make that a hard dependency.

## 6. Non-functional and security requirements

- Launch verification must add only a small amount of wall-clock time to smoke tests.
- The scripts must leave no orphaned app process on pass or fail.
- Security/privacy impact is `N/A`: same local fixture state already created by smoke tests is reused.

## 7. Verification and completion

### Required checks

1. Run install smoke:
   ```bash
   bash scripts/install_smoke.sh
   ```
2. Run package smoke:
   ```bash
   bash scripts/package_smoke.sh
   ```
3. Confirm both scripts:
   - launch the app
   - verify process existence
   - kill the app during cleanup

### Completion criteria

- both smoke scripts prove installed-app launch, not just CLI/service bootstrap
- cleanup remains deterministic
- no existing smoke assertions regress

## 8. Risks and sequencing

- Prefer landing after `GSB-MAC-TASK-006` if you want better failure logs, but this task must not depend on telemetry work to be correct.

## Document history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.2.1 | 2026-04-14 | Codex | Hardened launch-smoke cleanup so failed app-launch verification still releases leases and brokerd processes deterministically. |
| 0.2.0 | 2026-04-14 | Codex | Implemented installed-app launch verification in install and package smoke coverage with deterministic launch args and cleanup proof. |
| 0.1.0 | 2026-04-11 | Codex | Initial worker-ready task spec |

## Related documents

- `spec/tasks/macos-telemetry-instrumentation.md`
- `spec/tasks/macos-distribution-readiness.md`
