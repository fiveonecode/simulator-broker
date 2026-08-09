# macOS Desktop Command Surface
Related: `spec/tasks/README.md`, `spec/agents.md`, `app/Sources/SimulatorBrokerApp.swift`, `app/Sources/RootView.swift`, `app/Sources/BrokerDashboardStore.swift`

> **Document ID:** `GSB-MAC-TASK-002`
> **Version:** `0.2.0`
> **Last Updated:** `2026-04-13`
> **Status:** `Implemented`
> **Owner:** `spec-steward`
> **Implementation Owner:** `ios-dev`

## 1. Objective and context

The macOS app exposes almost all important broker actions only as in-content buttons.

That is below the expected desktop bar for an operator app because:

- pane switching is mouse-only
- refresh is toolbar-only
- simulator actions such as boot, shutdown, erase, repair, release lease, create pin, and clear pin have no keyboard or menu path
- the app does not use native `Commands` to make important actions discoverable from the menu bar

### Desired outcome

The app must expose a first-class macOS command surface for navigation and high-value broker operations.

## 2. Scope and boundaries

### In scope

- `Commands` definitions in the app scene
- keyboard shortcuts for high-frequency actions
- disabled-state and visibility logic for menu items
- focused routing to the currently active window/store

### Assumptions and constraints

- The app remains a multiwindow `WindowGroup` macOS app.
- `GSB-MAC-TASK-001` is the preferred predecessor because commands must target a window-owned store rather than a shared singleton.
- This task must stay SwiftUI-first and must not depend on ad hoc `NSMenu` mutation.

### Out of scope

- settings/preferences UI; no durable user preferences are defined yet
- scene restoration persistence; see `GSB-MAC-TASK-004`
- visual toolbar polish; see `GSB-MAC-TASK-005`

### Required skills for implementation

- `swiftui-pro`
- `xcode-build`

## 3. Reproduction and current failure

### Static evidence

- [SimulatorBrokerApp.swift](../../app/Sources/SimulatorBrokerApp.swift) defines no `.commands`
- repo search currently finds no `keyboardShortcut`, `CommandMenu`, `Commands`, or `Settings`
- major simulator actions are only visible inside [RootView.swift](../../app/Sources/RootView.swift)

### Manual reproduction

1. Launch the app with the fixture command from `GSB-MAC-TASK-001`.
2. Use the menu bar and keyboard only.
3. Attempt to:
   - switch from `Overview` to `Simulators`
   - trigger refresh
   - boot or repair the selected simulator
   - release the selected lease
4. Observe that the menu bar does not expose these actions and there are no app-defined keyboard shortcuts.

## 4. Requirements

### Functional requirements

- `REQ-001` The app must define SwiftUI `Commands` for pane navigation and core broker actions.
- `REQ-002` The following global actions must exist and be discoverable from the menu bar:
  - refresh snapshot
  - switch to Overview
  - switch to Simulators
  - switch to Projects
  - switch to Events
- `REQ-003` The currently focused simulator window must expose context-aware broker actions when a simulator is selected:
  - boot simulator
  - shutdown simulator
  - erase simulator
  - repair simulator
  - release active lease when present
  - create pin when eligible
  - clear pin when present
- `REQ-004` Menu items must mirror the same enabled/disabled logic as the in-content buttons.
- `REQ-005` Global pane commands must always target the focused window only.
- `REQ-006` Each pane-switching command must have a keyboard shortcut.
- `REQ-007` Refresh must have a keyboard shortcut and must not run when the active window is already applying an action.
- `REQ-008` Destructive or high-risk broker actions must be reachable from the menu bar but must not receive default keyboard shortcuts in this task.

### Required command layout

- Add a `View`-oriented command group for pane switching.
- Add a `Broker` command menu for refresh and broker operations.
- Keep menu labels short, explicit, and action-oriented.
- Do not hide destructive actions entirely; disable them when unavailable and present the same confirmation flow as the in-content UI when triggered.

### Required shortcut contract

- `Overview` must use `Command-1`.
- `Simulators` must use `Command-2`.
- `Projects` must use `Command-3`.
- `Events` must use `Command-4`.
- `Refresh Snapshot` must use `Command-R`.
- `Boot`, `Shutdown`, `Erase`, `Repair`, `Release Lease`, `Create Pin`, and `Clear Pin` must be menu-accessible but have no default keyboard shortcuts in this task.

### Required focus-routing contract

- Commands must act on the frontmost app window only.
- The command surface must resolve against explicit focused scene values for:
  - the active `BrokerDashboardStore`
  - the active pane
  - the selected simulator alias, if any
  - the active action-availability snapshot used by the in-content buttons
- If no eligible focused window exists, broker-action menu items must remain disabled rather than falling back to any hidden global store.

## 5. Implementation contract

### Write scope

- `app/Sources/SimulatorBrokerApp.swift`
- `app/Sources/RootView.swift`
- `app/Sources/BrokerDashboardStore.swift`
- new focused-value or command-support files if needed
- `app/Tests/**` as needed

### Required architecture

- Use SwiftUI `Commands` and focused scene/window state instead of manual `NSMenu` mutation.
- If the active window's selected simulator or selected pane must be surfaced to commands, use a narrow SwiftUI-focused-value pattern or an equivalent explicit scene binding.
- Keep confirmation and mutation logic in the store or dedicated action helpers, not inside the `Commands` builder.
- Do not introduce a `Settings` scene in this task. There are no durable preferences to justify it yet.

### Required implementation sequence

1. Add focused-value plumbing from the main scene so the active window can expose the current store, pane, selection, and action-availability state to `Commands`.
2. Add a dedicated SwiftUI `Commands` type or equivalent scene-owned command builder rather than building command logic inline in the `App` body.
3. Wire pane-navigation commands and exact keyboard shortcuts first.
4. Wire refresh second, using the same mutation path as the existing toolbar/content refresh control.
5. Wire simulator-specific broker actions last, ensuring their disabled-state logic matches the existing content buttons exactly.
6. Verify that confirmation flows invoked from the menu reuse the same confirmation state and execution helpers as the existing buttons.

### Shortcut contract

- Use the exact mappings defined in `Required shortcut contract`.
- Do not invent additional shortcuts for destructive actions in this task.
- If a platform-level conflict is discovered during implementation, update the spec before changing the mapping.

## 6. Non-functional and security requirements

- Menu actions must be fast to evaluate and must not trigger background mutation just by becoming enabled.
- Security and privacy impact is `N/A`: this task exposes existing actions through desktop affordances but does not add new permissions or data access.

## 7. Verification and completion

### Required checks

1. Build and test:
   ```bash
   bash scripts/test_app.sh
   ```
2. Manual verification with the runtime fixture:
   - menu bar shows pane navigation and broker actions
   - keyboard shortcuts switch panes in the focused window only
   - refresh works from the keyboard
   - disabled states match content-button availability
   - destructive actions still show confirmation UI
3. Add tests for any new pure command-routing helpers or availability logic.

### Requirement-to-proof mapping

| Requirement | Verification |
|---|---|
| `REQ-001` to `REQ-008` | manual command-surface proof plus any helper tests |

### Completion criteria

- commands exist, are discoverable, and target the focused window correctly
- no action is enabled in the menu while disabled in content, or vice versa
- the implementation does not bypass the existing broker mutation paths
- the exact shortcut mappings in this spec are present

## 8. Risks and sequencing

- Prefer landing `GSB-MAC-TASK-001` first so commands bind to correct per-window state.
- This task may share supporting helpers with `GSB-MAC-TASK-003`, but it should remain independently shippable.

## Document history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.2.0 | 2026-04-13 | Codex | Mark task implemented after landing focused-window SwiftUI commands, exact pane shortcuts, and shared broker-action availability/confirmation routing. |
| 0.1.0 | 2026-04-11 | Codex | Initial worker-ready task spec |

## Related documents

- `spec/tasks/macos-window-state-isolation.md`
- `spec/tasks/macos-rootview-refactor.md`
