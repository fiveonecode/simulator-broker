# macOS Desktop Chrome Polish
Related: `spec/tasks/README.md`, `app/Sources/RootView.swift`, `app/Sources/SharedViews.swift`, `spec/agents.md`

> **Document ID:** `GSB-MAC-TASK-005`
> **Version:** `0.2.1`
> **Last Updated:** `2026-08-04`
> **Status:** `Implemented`
> **Owner:** `spec-steward`
> **Implementation Owner:** `ios-dev`

## 1. Objective and context

The app's current desktop chrome still fights native macOS presentation in four related ways:

- custom capsule status pills are rendered inside the system toolbar
- inline status banners create a second full-width chrome band under the titlebar
- simulator search is attached too low in the hierarchy
- project and event master lists are padded like content cards instead of native source lists

These findings are tightly related and should be implemented as one cohesive polish task rather than four overlapping UI edits.

## 2. Scope and boundaries

### In scope

- toolbar content treatment
- status-banner presentation
- simulator search placement
- project/events master-list layout and list style

### Assumptions and constraints

- This task is presentation-only and must preserve the existing operator actions and copy.
- If `GSB-MAC-TASK-003` lands first, this task must follow the refactored file boundaries rather than reintroducing a large shared root file.
- The solution must remain SwiftUI-first and must not add AppKit-only chrome customization.

### Out of scope

- adding custom `glassEffect` surfaces
- command menus and keyboard shortcuts
- structural file decomposition beyond what is necessary to implement the visual changes cleanly

### Required skills for implementation

- `swiftui-pro`
- `xcode-build`
- `screenshot-analyze-verification` if screenshots are captured as acceptance evidence

## 3. Reproduction and current failure

### Runtime reproduction

1. Launch the app with the deterministic fixture:
   ```bash
   session_dir="${AGENT_HOME:-$HOME/.agents}/agent-harness/simulator-broker-app/desktop-chrome-polish-repro"
   fixture_root="$session_dir/runtime-fixture"
   state_root="$fixture_root/state"
   host_config="$fixture_root/host-config.json"
   mkdir -p "$state_root"
   printf '{}\n' > "$host_config"
   node -e 'const fs=require("fs"); const snapshot=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); snapshot.stateRoot=process.argv[2]; snapshot.hostConfigPath=process.argv[3]; fs.writeFileSync(process.argv[4], JSON.stringify(snapshot,null,2));' app/Tests/Fixtures/busy-snapshot.json "$state_root" "$host_config" "$state_root/app-snapshot.json"
   ./script/build_and_run.sh -- --state-root "$state_root" --host-config "$host_config"
   ```
2. Inspect:
   - the toolbar in any pane
   - the full-width status messages under the titlebar
   - the simulator pane search field
   - the projects and events left-hand lists

### Static evidence

- toolbar pills are assembled in [RootView.swift](../../app/Sources/RootView.swift) and drawn by [StatusPill](../../app/Sources/SharedViews.swift)
- full-width status banners are assembled in [RootView.swift](../../app/Sources/RootView.swift) and drawn by [InlineStatusBanner](../../app/Sources/SharedViews.swift)
- simulator search is currently attached inside the simulator content column
- project and event master lists use padded layout rather than edge-aligned source-list behavior

## 4. Requirements

### Toolbar requirements

- `REQ-001` Remove custom capsule-background status pills from the toolbar.
- `REQ-002` Replace them with toolbar-native content using plain `Label`, `Text`, semantic tint, badges, or other standard SwiftUI toolbar treatments.
- `REQ-003` Keep the same underlying status information visible: command status, last snapshot time, and refresh affordance.

### Status-message requirements

- `REQ-004` Success, error, and startup-state messages must no longer render as a flush, edge-to-edge colored band directly under the titlebar.
- `REQ-005` Status surfaces must render as inset content cards at the top of the active pane content area, not as a titlebar-adjacent safe-area band.
- `REQ-006` Existing status copy and action buttons must remain intact unless another task changes copy intentionally.

### Search requirements

- `REQ-007` Simulator search must move to the root simulator browsing container that owns the simulator master/detail split, using SwiftUI's toolbar/search presentation rather than a nested child-column attachment.
- `REQ-008` Search scope must remain the full simulator browser dataset.

### Source-list requirements

- `REQ-009` Project and event master panes must use edge-aligned native macOS source-list/sidebar presentation with no card-style outer padding.
- `REQ-010` Selection highlighting must read as a normal split-view master pane rather than an inset content card.

### Explicit visual contract

- The toolbar may show concise status using plain text or labels, but it must not show pill-shaped custom backgrounds.
- Status cards must sit within the pane content column with normal content padding and rounded container styling that reads as content, not chrome.
- Simulator search must remain visible while the simulator pane is active even when the detail column changes selection.
- Projects and Events master panes must use `List(selection:)` with native sidebar or source-list styling; they must not be wrapped in extra background cards just to create inset spacing.

## 5. Implementation contract

### Write scope

- `app/Sources/RootView.swift`
- `app/Sources/SharedViews.swift`
- new focused feature files if `GSB-MAC-TASK-003` lands first or in parallel

### Guardrails

- Prefer standard SwiftUI macOS chrome before adding any custom visual treatment.
- Do not add bespoke translucent effects to replace the removed pills/banners.
- Do not change business logic, broker command routing, or text copy except where required to rehost the same message in a more native container.
- Do not introduce `AppKit` just to style toolbar or list chrome.

### Required implementation sequence

1. Remove toolbar pill usage and replace it with native toolbar items while keeping the same status information available.
2. Move inline status banners into inset pane-content cards without changing their message copy or button actions.
3. Reattach simulator search at the simulator-browser container level and confirm the filtered dataset remains unchanged.
4. Restyle Projects and Events master panes as native source lists with edge-aligned selection behavior.
5. Run a Light and Dark mode visual pass before claiming completion.

## 6. Non-functional and security requirements

- The UI must continue to work in Light and Dark mode.
- Search placement changes must not regress discoverability.
- Security and privacy impact is `N/A`: presentation-only task.

## 7. Verification and completion

### Required checks

1. Build and test:
   ```bash
   bash scripts/test_app.sh
   ```
2. Manual UI review with the fixture:
   - toolbar uses native-looking content rather than embedded pills
   - inline status messages render as inset content cards, not a second titlebar band
   - simulator search appears at the simulator-browser container level in toolbar/search presentation
   - projects/events master columns align like native source lists
3. If screenshot evidence is used for acceptance, run it through `screenshot-analyze-verification`.

### Completion criteria

- all four chrome issues are resolved together
- no custom chrome-inside-chrome treatment remains in the toolbar
- no behavioral regressions are introduced while moving the search/list hierarchy

## 8. Risks and sequencing

- Prefer landing after `GSB-MAC-TASK-003` if the refactor is already in progress, but this task must remain executable independently.
- This task should not block telemetry, test, or distribution work.

## Document history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.2.1 | 2026-08-04 | Codex | Updated deterministic fixture preparation to preserve the selected host-config identity required by current snapshots. |
| 0.2.0 | 2026-04-14 | Codex | Implemented native toolbar status treatment, inset status cards, toolbar-level simulator search, and sidebar-style project/event lists. |
| 0.1.0 | 2026-04-11 | Codex | Initial worker-ready task spec |

## Related documents

- `spec/tasks/macos-rootview-refactor.md`
- `spec/tasks/macos-desktop-command-surface.md`
