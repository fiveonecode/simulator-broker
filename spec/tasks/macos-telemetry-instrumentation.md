# macOS Telemetry Instrumentation
Related: `spec/tasks/README.md`, `app/Sources/SimulatorBrokerApp.swift`, `app/Sources/BrokerDashboardStore.swift`, `script/build_and_run.sh`

> **Document ID:** `GSB-MAC-TASK-006`
> **Version:** `0.2.0`
> **Last Updated:** `2026-04-14`
> **Status:** `Implemented`
> **Owner:** `spec-steward`
> **Implementation Owner:** `ios-dev`

## 1. Objective and context

The app currently lacks unified logging around the operator flows that matter most:

- app start and refresh loop lifecycle
- snapshot refresh
- first-time setup
- brokerd start
- lease release
- pin create / clear
- lifecycle actions (`boot`, `shutdown`, `erase`, `repair`)
- command failures and override-required outcomes

That makes runtime debugging slower and leaves the new macOS telemetry skill with nothing concrete to verify.

## 2. Scope and boundaries

### In scope

- app-side `Logger` / `OSLog` instrumentation
- log category design
- low-noise success and failure logging for operator actions
- telemetry verification using `./script/build_and_run.sh --telemetry`

### Out of scope

- remote analytics, metrics backends, or crash reporting services
- noisy property-by-property state dump logging
- redesigning the broker command protocol

### Required skills for implementation

- `swift-concurrency-pro`
- `xcode-build`

## 3. Reproduction and current failure

### Static evidence

- repo search currently finds no `Logger` or `OSLog` usage under `app/`
- operator flows in [BrokerDashboardStore.swift](../../app/Sources/BrokerDashboardStore.swift) perform refresh and mutation work silently
- [script/build_and_run.sh](../../script/build_and_run.sh) now supports `--telemetry`, but the app does not emit meaningful subsystem/category events yet

### Runtime reproduction

1. Launch the app in telemetry mode against a fixture or live broker state:
   ```bash
   ./script/build_and_run.sh --telemetry
   ```
2. Trigger refresh, start brokerd, refresh snapshot, and any available simulator action.
3. Observe that there are no app-owned structured log lines for those actions.

## 4. Requirements

### Functional requirements

- `REQ-001` The app must use `Logger` from `OSLog` rather than `print`.
- `REQ-002` Logging categories must be explicit and stable. Required initial categories:
  - `AppLifecycle`
  - `Refresh`
  - `Setup`
  - `Commands`
- `REQ-003` App startup must log window/store startup and refresh-loop start.
- `REQ-004` Refresh must log:
  - manual vs silent refresh start
  - refresh success with snapshot timestamp when available
  - refresh failure with a concise failure summary
- `REQ-005` Setup flows must log:
  - first-time host bootstrap start/result
  - brokerd start start/result
  - snapshot refresh start/result
- `REQ-006` Command flows must log:
  - action name
  - alias when applicable
  - success result
  - failure result
  - override-required condition when returned by the broker
- `REQ-007` Stop/store teardown must log refresh-loop stop.

### Logging hygiene requirements

- `REQ-008` Do not log secrets, tokens, raw snapshot contents, or unbounded file payloads.
- `REQ-009` Session paths and alias IDs may be logged only when they are already visible in normal operator UI and materially help debugging.
- `REQ-010` Silent polling refreshes must remain lower-noise than user-triggered actions.

## 5. Implementation contract

### Write scope

- `app/Sources/SimulatorBrokerApp.swift`
- `app/Sources/BrokerDashboardStore.swift`
- a new small support file such as `app/Sources/BrokerLogger.swift` if useful
- tests or log-helper tests if they improve coverage

### Required implementation shape

- Define one consistent subsystem based on `Bundle.main.bundleIdentifier` with a sane fallback.
- Use feature-specific categories instead of one global catch-all logger.
- Add logs at action boundaries, not at every internal property mutation.
- If helper wrappers are created, keep them small and transparent.

## 6. Non-functional and security requirements

- Logs must remain low-noise enough to use in `log stream` during local triage.
- The app must build and run identically with logging enabled.
- Security/privacy requirements are fulfilled only if `REQ-008` through `REQ-010` are satisfied.

## 7. Verification and completion

### Required checks

1. Build and run telemetry mode:
   ```bash
   ./script/build_and_run.sh --telemetry
   ```
2. Exercise:
   - startup
   - refresh
   - brokerd start if available
   - snapshot refresh
   - one mutation action
3. Verify the expected log categories and events appear in unified logs.
4. Run:
   ```bash
   bash scripts/test_app.sh
   ```

### Completion criteria

- required categories exist
- the named actions emit clear, filterable log lines
- no `print`-style debug spam remains in app runtime paths

## 8. Risks and sequencing

- Landing this before `GSB-MAC-TASK-008` and `GSB-MAC-TASK-009` is strongly preferred.
- Command logs must remain accurate if `GSB-MAC-TASK-003` refactors action ownership.

## Document history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.2.0 | 2026-04-14 | Codex | Implemented unified `Logger` instrumentation for app lifecycle, refresh, setup, and command flows; verified via `--telemetry` and focused app tests |
| 0.1.0 | 2026-04-11 | Codex | Initial worker-ready task spec |

## Related documents

- `spec/tasks/macos-installed-app-launch-smoke.md`
- `spec/tasks/macos-runtime-test-triage.md`
