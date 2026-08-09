# macOS Scene Restoration
Related: `spec/tasks/README.md`, `app/Sources/BrokerDashboardStore.swift`, `app/Sources/RootView.swift`, `app/Sources/BrokerLaunchContext.swift`

> **Document ID:** `GSB-MAC-TASK-004`
> **Version:** `0.2.0`
> **Last Updated:** `2026-04-13`
> **Status:** `Implemented`
> **Owner:** `spec-steward`
> **Implementation Owner:** `ios-dev`

## 1. Objective and context

The app does not currently persist window-local context across normal macOS scene restoration.

Lost state today includes:

- selected pane
- inspected simulator alias
- inspected project ID
- inspected event ID
- simulator search text
- simulator filter selections

This is a desktop ergonomics problem rather than a correctness bug, but it is still a clear mismatch with a multiwindow Mac app.

## 2. Scope and boundaries

### In scope

- scene-local state persistence for primary operator context
- restore behavior for normal window reopen / relaunch scenarios
- explicit precedence between launch arguments and restored values

### Out of scope

- cross-device sync or user defaults sync
- durable user preferences unrelated to a specific scene
- temporary banners, modals, and in-flight action flags

### Required skills for implementation

- `swiftui-pro`
- `xcode-build`

## 3. Reproduction and current failure

1. Launch the app with the deterministic fixture.
2. Switch to `Simulators`, search for `ui-2`, set non-default filters, and select `ui-2`.
3. Close the window and reopen a window for the app.
4. Observe that the pane/filter/selection context returns to defaults rather than restoring the prior scene context.

Static evidence: the current state is stored as plain mutable properties in [BrokerDashboardStore.swift](../../app/Sources/BrokerDashboardStore.swift) and is not bridged through `@SceneStorage`.

## 4. Requirements

### Functional requirements

- `REQ-001` The app must restore the following per-window scene context:
  - selected pane
  - inspected simulator alias
  - inspected project ID
  - inspected event ID
  - simulator search text
  - simulator actor filter
  - simulator health filter
  - simulator project filter
  - simulator purpose filter
- `REQ-002` Transient state must not be restored:
  - success or error banners
  - active confirmation dialogs or sheets
  - in-flight loading flags
  - override-request payloads
- `REQ-003` Explicit launch arguments must win over restored state when a new scene is created with deep-link inputs.
- `REQ-004` Restored values must remain local to the scene/window that owns them.
- `REQ-005` Clearing filters or changing pane selection must update stored scene state immediately.

### State encoding requirements

- `REQ-006` Scene-stored values must use stable serialized representations so future app launches can decode them safely.
- `REQ-007` Invalid or stale stored values must fall back to safe defaults rather than crashing the app.

## 5. Implementation contract

### Write scope

- `app/Sources/RootView.swift`
- `app/Sources/BrokerDashboardStore.swift`
- `app/Sources/BrokerLaunchContext.swift` only if launch/restoration precedence needs explicit helpers
- tests for encode/decode and fallback behavior

### Preferred implementation shape

- Use `@SceneStorage` at the scene/root-view ownership boundary.
- Keep durable state ownership explicit rather than scattering `@SceneStorage` across deeply nested leaf views.
- If helper serializers are needed for filter enums, place them in a small support type rather than embedding stringly typed conversions across the view tree.

### Guardrails

- Do not use `@AppStorage` for scene-local context.
- Do not restore transient destructive-confirmation state.
- Do not let restoration override explicit command-line launch targeting.

## 6. Non-functional and security requirements

- Restoration must not noticeably delay initial render.
- Corrupt stored state must fail closed to defaults.
- Security and privacy impact is `N/A`: only local UI context is persisted.

## 7. Verification and completion

### Required checks

1. Build and test:
   ```bash
   bash scripts/test_app.sh
   ```
2. Add tests that prove:
   - valid stored values restore correctly
   - invalid stored values fall back safely
   - explicit launch arguments override restored state
3. Manual proof:
   - set pane, search, filters, and selection
   - close and reopen the window
   - confirm the expected context returns

### Completion criteria

- restored state covers the required fields and excludes the forbidden transient fields
- no crash occurs when stored state is missing or malformed
- deep-link launch behavior remains correct

## 8. Risks and sequencing

- Prefer landing after `GSB-MAC-TASK-001` so the restored state binds to a window-owned store.
- Refactor work in `GSB-MAC-TASK-003` may make this easier if it lands first.

## Document history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.2.0 | 2026-04-13 | Codex | Implemented scene-local restoration with launch-argument precedence and store-level verification coverage |
| 0.1.0 | 2026-04-11 | Codex | Initial worker-ready task spec |

## Related documents

- `spec/tasks/macos-window-state-isolation.md`
- `spec/tasks/macos-rootview-refactor.md`
