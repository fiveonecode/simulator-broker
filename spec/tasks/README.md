# macOS App Task Specs
Related: `spec/README.md`, `spec/agents.md`, `spec/build-and-test.md`, `app/README.md`

## Purpose

This directory contains the worker-ready implementation tasks derived from the April 11, 2026 macOS app audit.
All nine task specs in this directory are now implemented; keep them as source-of-truth contracts plus completion history for the remediation set.

Each task spec is written so a worker can take ownership of one issue or one tightly related issue cluster and execute it end to end without opening a clarification loop first.

Each task document must be treated as a full worker contract:

- what is wrong
- how to reproduce it
- exact implementation boundaries
- concrete completion requirements
- deterministic verification steps

## Audit coverage map

| Audit issue | Task spec |
|---|---|
| Shared `WindowGroup` store causes cross-window state bleed and stop/start interference | `spec/tasks/macos-window-state-isolation.md` |
| Desktop command surface is missing for pane switching and broker actions | `spec/tasks/macos-desktop-command-surface.md` |
| `RootView.swift` is oversized and mixes layout with action orchestration | `spec/tasks/macos-rootview-refactor.md` |
| Pane selection, inspected item, filters, and search are not scene-restorable | `spec/tasks/macos-scene-restoration.md` |
| Toolbar pills, status bands, search placement, and master-list styling fight native macOS chrome | `spec/tasks/macos-desktop-chrome-polish.md` |
| Operator flows lack unified `Logger` / `OSLog` instrumentation | `spec/tasks/macos-telemetry-instrumentation.md` |
| App test workflow is full-suite-only and weak for focused reruns and triage | `spec/tasks/macos-runtime-test-triage.md` |
| Install and package smoke tests do not prove the installed app launches | `spec/tasks/macos-installed-app-launch-smoke.md` |
| Portable package flow is still local-debug signed and not distribution-ready | `spec/tasks/macos-distribution-readiness.md` |

## Not included here

The following audit findings were already addressed in commit `7df76bd0a99949d062d2cd83575c8df731a29151` and therefore do not need new worker specs in this directory:

- missing canonical macOS `build_and_run` entrypoint
- missing Codex `Run` action
- missing harness routing for the repo-shipped macOS app skills
- harness crash when `.agents/evals/` is absent

## Worker assignment guidance

- Assign one worker per task spec whenever possible.
- Do not combine `macos-window-state-isolation` and `macos-scene-restoration` into one worker unless the owner explicitly wants one branch for both. They touch related state surfaces but are intentionally written as separate slices.
- Do not combine `macos-rootview-refactor` with `macos-desktop-chrome-polish` unless the refactor lands first and the same worker owns both write scopes.
- `macos-distribution-readiness` can proceed independently from all UI tasks.
- `macos-telemetry-instrumentation` should land before or alongside `macos-installed-app-launch-smoke` so launch-smoke failures are easier to diagnose.

## Common baseline

Unless a task spec explicitly overrides this, workers should assume:

- the repo baseline already includes `./script/build_and_run.sh`
- the Codex app `Run` action already points at `./script/build_and_run.sh`
- the app remains XcodeGen/Xcode-based rather than SwiftPM-native
- specs are the source of truth and `spec-only` is the required verification profile for these planning docs
