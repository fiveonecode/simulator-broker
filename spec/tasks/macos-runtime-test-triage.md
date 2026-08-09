# macOS Runtime Test Triage
Related: `spec/tasks/README.md`, `spec/build-and-test.md`, `scripts/test_app.sh`, `package.json`, `app/project.yml`

> **Document ID:** `GSB-MAC-TASK-007`
> **Version:** `0.2.0`
> **Last Updated:** `2026-04-14`
> **Status:** `Implemented`
> **Owner:** `spec-steward`
> **Implementation Owner:** `ios-dev`

## 1. Objective and context

The current app test workflow is functional but weak for triage:

- `scripts/test_app.sh` always regenerates the project and runs the full scheme
- there is no focused rerun path for `-only-testing`
- there is no build-only path to separate compile failures from test failures
- there is no stable result-bundle contract for targeted reruns

The result is that even small app-test failures cost more time than necessary to isolate.

## 2. Scope and boundaries

### In scope

- `scripts/test_app.sh` interface design
- package-level script wiring for focused app-test reruns
- result-bundle output and command reporting
- docs for the new test-triage workflow

### Out of scope

- adding new UI test targets
- replacing XcodeGen/XCTest with another test harness
- install/package smoke launch verification; that belongs to `GSB-MAC-TASK-008`

### Required skills for implementation

- `swift-concurrency-pro`
- `xcode-build`

## 3. Reproduction and current failure

### Current workflow

```bash
bash scripts/test_app.sh
```

This always runs the entire app scheme. There is no documented or scripted equivalent of:

- build only
- focused `-only-testing`
- stable `xcresult` path selection
- reusing generated project/build settings for a second narrow rerun

## 4. Requirements

### Functional requirements

- `REQ-001` `scripts/test_app.sh` must accept focused rerun arguments and pass them through to `xcodebuild test`.
- `REQ-002` The script must support build-only mode so compile failures can be isolated without running tests.
- `REQ-003` The script must support a caller-specified result bundle path.
- `REQ-004` The script must print the exact `xcodebuild` command it is running.
- `REQ-005` The script must preserve the default no-flag full-suite behavior.
- `REQ-006` `package.json` and/or docs must expose at least one canonical example for focused reruns.

### Required CLI contract

At minimum the script must support:

- `--only-testing <Target/TestCase or Target/TestCase/testMethod>`
- `--build-only`
- `--result-bundle-path <path>`
- `--derived-data-path <path>` or preservation of the current env-based override

## 5. Implementation contract

### Write scope

- `scripts/test_app.sh`
- `package.json`
- `app/README.md` and/or `spec/build-and-test.md`

### Guardrails

- Keep the default behavior backward-compatible.
- Do not invent a new test harness; stay on XcodeGen + `xcodebuild`.
- Focus on triage ergonomics, not on changing what tests exist.

## 6. Non-functional and security requirements

- Focused reruns must remain deterministic.
- Result-bundle output must be easy to collect into a session dir.
- Security/privacy impact is `N/A`.

## 7. Verification and completion

### Required checks

1. Full suite:
   ```bash
   bash scripts/test_app.sh
   ```
2. Build-only:
   ```bash
   bash scripts/test_app.sh --build-only
   ```
3. Focused rerun against one existing app test:
   ```bash
   bash scripts/test_app.sh --only-testing SimulatorBrokerAppTests/BrokerDashboardStoreTests
   ```
4. Focused rerun with explicit result bundle path:
   ```bash
   bash scripts/test_app.sh --only-testing SimulatorBrokerAppTests/BrokerSnapshotLoaderTests --result-bundle-path "$PWD/artifacts/app-test.xcresult"
   ```

### Completion criteria

- all commands above work
- full-suite behavior remains unchanged
- the script output is sufficient for a worker to see exactly what failed and where the result bundle lives

## 8. Risks and sequencing

- Keep this independent from `GSB-MAC-TASK-008`; launch smoke is a separate contract.

## Document history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.2.0 | 2026-04-14 | Codex | Implemented focused reruns, build-only mode, stable result-bundle reporting, and package/doc wiring. |
| 0.1.0 | 2026-04-11 | Codex | Initial worker-ready task spec |

## Related documents

- `spec/tasks/macos-installed-app-launch-smoke.md`
- `spec/build-and-test.md`
