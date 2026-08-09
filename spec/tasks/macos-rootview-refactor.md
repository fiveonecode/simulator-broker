# macOS Root View Refactor
Related: `spec/tasks/README.md`, `app/Sources/RootView.swift`, `app/Sources/SharedViews.swift`, `app/Sources/BrokerDashboardStore.swift`

> **Document ID:** `GSB-MAC-TASK-003`
> **Version:** `0.2.0`
> **Last Updated:** `2026-04-13`
> **Status:** `Implemented`
> **Owner:** `spec-steward`
> **Implementation Owner:** `ios-dev`

## 1. Objective and context

[RootView.swift](../../app/Sources/RootView.swift) is currently a very large mixed-responsibility file.

It contains:

- the app shell
- all four major screens
- simulator detail UI
- destructive confirmation state
- override confirmation state
- async broker action orchestration

That makes the scene structure hard to navigate and increases the chance that future work will pile even more behavior into the same file.

### Desired outcome

The app should be organized into focused scene and feature view files whose ownership is obvious from file names and explicit inputs.

## 2. Scope and boundaries

### In scope

- decomposing `RootView.swift` into smaller files
- moving large subviews and sheet content into dedicated types
- reducing inline async action logic inside view bodies
- preserving existing behavior and current broker mutation contract

### Out of scope

- redesigning UI or changing command semantics beyond what the refactor needs
- scene restoration persistence
- telemetry instrumentation

### Required skills for implementation

- `swiftui-pro`
- `xcode-build`

## 3. Reproduction and current failure

### Static evidence

- `RootView.swift` currently contains the root shell plus multiple feature surfaces in one file
- the simulator detail area mixes modal state, lifecycle confirmations, override handling, and mutation triggering
- the file is large enough that worker ownership is ambiguous

### Current worker pain

- command-surface work, scene-restoration work, and UI-polish work all currently collide in the same file
- code review must reason about unrelated screens and action logic together
- future subagent decomposition would produce overlapping write scopes

## 4. Requirements

### Functional requirements

- `REQ-001` The root shell must remain behaviorally identical after refactoring.
- `REQ-002` `RootView.swift` must become a composition/root-layout file rather than the host for all feature bodies.
- `REQ-003` The following surfaces must live in dedicated files with names that reflect their ownership:
  - Overview screen
  - Simulators screen
  - Projects screen
  - Events screen
  - Simulator detail view
  - destructive lifecycle confirmation view/sheet
  - override confirmation view/sheet
- `REQ-004` Async action triggers must move out of deeply nested inline closures when a named helper or dedicated subview can own them more clearly.
- `REQ-005` The refactor must not change broker command routing, error handling, or current text copy unless another task explicitly requires it.

### Structural requirements

- `REQ-006` Keep the root shell file under a maintainable size target of roughly 250 lines or less unless a stronger local reason is documented.
- `REQ-007` New files must be named after the primary type they contain.
- `REQ-008` Shared generic styling components may remain in `SharedViews.swift`, but feature-specific content must not be added there.

## 5. Implementation contract

### Minimum target file layout

- `app/Sources/RootView.swift` — shell composition only
- `app/Sources/OverviewScreen.swift`
- `app/Sources/SimulatorsScreen.swift`
- `app/Sources/ProjectsScreen.swift`
- `app/Sources/EventsScreen.swift`
- `app/Sources/SimulatorDetailView.swift`
- additional small files for confirmation/override surfaces if they remain non-trivial

### Write scope

- `app/Sources/RootView.swift`
- new `app/Sources/*.swift` files as listed above
- `app/Tests/**` only if behavior-preserving coverage needs adjustment

### Guardrails

- Do not move broker transport or mutation logic into SwiftUI views if it can stay in the store.
- Do not create a grab-bag `Helpers.swift` or `Components.swift` file for feature-specific logic.
- Do not perform a silent visual redesign while refactoring structure.
- If a child view only exists to render one small row, it may remain local to its feature file rather than being promoted to a global shared component.

## 6. Non-functional and security requirements

- Compilation time must not regress due to cyclical file organization.
- Readability and future worker ownership are primary non-functional goals.
- Security and privacy impact is `N/A`: this task is structural only.

## 7. Verification and completion

### Required checks

1. Build and test:
   ```bash
   bash scripts/test_app.sh
   ```
2. Manual parity check with the runtime fixture:
   - Overview, Simulators, Projects, and Events all render as before
   - simulator lifecycle confirmations still work
   - override-required UI still appears when forced through the same state inputs as before
3. Diff review must show no copy changes or behavior changes outside intentional file movement and helper extraction.

### Completion criteria

- `RootView.swift` is reduced to shell/composition responsibilities
- the new file layout is feature-oriented and obvious to a future worker
- behavior remains intact

## 8. Risks and sequencing

- Land this before large UI-polish work if possible.
- If `GSB-MAC-TASK-001` changes store ownership first, this refactor must preserve that new ownership model rather than reintroducing coupling.

## Document history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.2.0 | 2026-04-13 | Codex | Implemented the feature-oriented root-view decomposition with dedicated screen, detail, and confirmation files. |
| 0.1.0 | 2026-04-11 | Codex | Initial worker-ready task spec |

## Related documents

- `spec/tasks/macos-window-state-isolation.md`
- `spec/tasks/macos-desktop-chrome-polish.md`
