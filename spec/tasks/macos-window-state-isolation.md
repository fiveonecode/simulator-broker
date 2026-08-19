# macOS Window State Isolation
Related: `spec/tasks/README.md`, `spec/agents.md`, `spec/build-and-test.md`, `app/Sources/SimulatorBrokerApp.swift`, `app/Sources/BrokerDashboardStore.swift`, `app/Sources/RootView.swift`

> **Document ID:** `GSB-MAC-TASK-001`
> **Version:** `0.2.1`
> **Last Updated:** `2026-08-04`
> **Status:** `Implemented`
> **Owner:** `spec-steward`
> **Implementation Owner:** `ios-dev`

## 1. Objective and context

The app currently uses one shared `BrokerDashboardStore` for every `WindowGroup` window.

That breaks normal macOS multiwindow behavior:

- opening a second window mirrors and mutates the first window's pane selection, inspected item, filters, search text, banners, and in-flight loading state
- closing any one window can stop the shared refresh loop for every remaining window
- the app behaves like a single-window iOS scene inside a macOS multiwindow shell

### Desired outcome

Each app window must own independent UI state and its own refresh lifecycle while still reading the same broker authority and snapshot contract.

### Success criteria

- changing pane selection, filters, search text, or inspected objects in one window does not mutate another window
- closing one window does not stop refresh or interaction in another window
- deep-linked launch arguments still seed the first state of a new window
- no broker mutation behavior regresses

## 2. Scope and boundaries

### In scope

- scene and store ownership for the main `WindowGroup`
- per-window refresh lifecycle
- dependency construction for `BrokerDashboardStore`
- tests covering independent store lifecycle and startup behavior

### Out of scope

- scene restoration persistence across relaunch; that belongs to `GSB-MAC-TASK-004`
- large-scale view-file decomposition; that belongs to `GSB-MAC-TASK-003`
- command menus and keyboard shortcuts; that belongs to `GSB-MAC-TASK-002`

### Required skills for implementation

- `swift-concurrency-pro`
- `swiftui-pro`
- `xcode-build`

## 3. Reproduction and current failure

### Static evidence

- [SimulatorBrokerApp.swift](../../app/Sources/SimulatorBrokerApp.swift) constructs one `BrokerDashboardStore` in `App.init()`
- the same store instance is injected into every `WindowGroup` scene
- [BrokerDashboardStore.swift](../../app/Sources/BrokerDashboardStore.swift) stores pane selection, inspected IDs, filters, search text, banners, loading flags, and refresh tasks as mutable instance state
- [SimulatorBrokerApp.swift](../../app/Sources/SimulatorBrokerApp.swift) calls `store.stop()` in `onDisappear`, so one window disappearing can stop the shared refresh loop

### Manual reproduction

1. Prepare a deterministic fixture:
   ```bash
   session_dir="${AGENT_HOME:-$HOME/.agents}/agent-harness/simulator-broker-app/window-state-isolation-repro"
   fixture_root="$session_dir/runtime-fixture"
   state_root="$fixture_root/state"
   host_config="$fixture_root/host-config.json"
   mkdir -p "$state_root"
   printf '{}\n' > "$host_config"
   node -e 'const fs=require("fs"); const snapshot=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); snapshot.stateRoot=process.argv[2]; snapshot.hostConfigPath=process.argv[3]; fs.writeFileSync(process.argv[4], JSON.stringify(snapshot,null,2));' app/Tests/Fixtures/busy-snapshot.json "$state_root" "$host_config" "$state_root/app-snapshot.json"
   ./script/build_and_run.sh -- --state-root "$state_root" --host-config "$host_config"
   ```
2. In the first window, switch to `Simulators`, search for `ui-2`, and select `ui-2`.
3. Use the app menu `File > New Window`.
4. Observe that the second window inherits or overwrites the first window's visible state instead of starting independently.
5. Close either window and observe whether refresh indicators, generated-at timestamps, or action availability stop updating in the remaining window.

## 4. Requirements

### Functional requirements

- `REQ-001` Every main app window must own an independent `BrokerDashboardStore` or an equivalent per-scene controller.
- `REQ-002` A window's refresh loop must start and stop with that window only.
- `REQ-003` Creating a second window must not mutate pane selection, search text, filters, inspected simulator, inspected project, inspected event, banners, or in-flight loading flags in an existing window.
- `REQ-004` Launch arguments (`--pane`, `--simulator-alias`, `--project-id`, `--event-id`, `--state-root`, `--host-config`, `--cli-path`) must still seed the initial state of the newly created store for the launched window.
- `REQ-005` Multiple windows may share immutable runtime configuration and broker authority endpoints, but they must not share mutable scene UI state.
- `REQ-006` Closing one window while another remains open must not cancel refresh or mutation capability in the remaining window.

### Edge and failure requirements

- `REQ-007` If a window opens while brokerd is unavailable, its read-only state classification must remain local to that window.
- `REQ-008` If two windows trigger refresh concurrently, the app must remain correct even if the underlying broker snapshot file changes between refreshes.
- `REQ-009` Store lifecycle cleanup must remain idempotent so repeated scene disappearances do not crash or leak work.

## 5. Implementation contract

### Write scope

- `app/Sources/SimulatorBrokerApp.swift`
- `app/Sources/BrokerDashboardStore.swift`
- `app/Tests/**` as needed for scene/store lifecycle coverage
- new app source files are allowed if they reduce coupling cleanly

### Read-only context

- `app/Sources/BrokerLaunchContext.swift`
- `app/Sources/BrokerSnapshotLoader.swift`
- `spec/tasks/macos-scene-restoration.md`
- `spec/tasks/macos-rootview-refactor.md`

### Required implementation shape

- Move store construction out of `App.init()` as a shared singleton pattern.
- The scene closure must construct a fresh window-owned store from the same launch/runtime inputs.
- If a factory helper is introduced, it must return a new store per invocation and must not cache mutable scene state globally.
- Keep broker loader and command-client construction deterministic and explicit.
- Do not move broker mutation logic into the `App` type.
- Do not introduce an `AppKit` bridge for this task unless a SwiftUI-only design is proven insufficient.

### Data and state rules

- mutable window state remains owned by the scene/store instance
- immutable runtime path resolution may still come from the launch context
- global app-singleton state is forbidden unless it is demonstrably immutable

## 6. Non-functional and security requirements

- Refresh cadence and performance must not regress from the current 2-second poll behavior.
- No new background task leaks are allowed after a window closes.
- Security and privacy impact is `N/A`: this task changes ownership of existing in-memory UI state only and does not expand secrets, permissions, or external data access.

## 7. Verification and completion

### Required implementation checks

1. Build and unit test:
   ```bash
   bash scripts/test_app.sh
   ```
2. Add or extend focused tests that prove:
   - distinct store instances maintain independent mutable state
   - calling `stop()` on one store does not affect another store
   - deep-link initialization still seeds a fresh store correctly
3. Manual multiwindow proof using the reproduction fixture above:
   - window A and window B can diverge in pane/filter/selection state
   - closing window A does not freeze window B

### Requirement-to-proof mapping

| Requirement | Verification |
|---|---|
| `REQ-001` to `REQ-006` | unit tests plus manual two-window proof |
| `REQ-007` to `REQ-009` | focused store lifecycle tests |

### Completion criteria

- all requirements above are satisfied
- app tests pass
- manual two-window reproduction no longer shows cross-window state bleed
- no new shared mutable singleton is introduced to replace the old shared store problem

## 8. Risks and sequencing

- This task should land before `GSB-MAC-TASK-004` because scene restoration depends on correct per-window ownership.
- This task should preferably land before `GSB-MAC-TASK-002` because command routing should target the correct window-owned state model.

## Document history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.2.1 | 2026-08-04 | Codex | Updated deterministic fixture preparation to preserve the selected host-config identity required by current snapshots. |
| 0.2.0 | 2026-04-11 | Codex | Implemented per-window `BrokerDashboardStore` ownership, isolated refresh lifecycles, and launch-context seeding coverage. |
| 0.1.0 | 2026-04-11 | Codex | Initial worker-ready task spec |

## Related documents

- `spec/tasks/macos-scene-restoration.md`
- `spec/tasks/macos-rootview-refactor.md`
- `spec/build-and-test.md`
