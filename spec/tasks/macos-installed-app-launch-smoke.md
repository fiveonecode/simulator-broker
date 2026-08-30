# macOS Installed App Launch Smoke
Related: `spec/tasks/README.md`, `scripts/install_smoke.sh`, `scripts/installed_app_smoke_evidence.mjs`, `docs/test/installed-app-smoke-evidence.test.mjs`, `scripts/package_smoke.sh`, `scripts/install_local.sh`, `scripts/install_distribution.sh`, `spec/build-and-test.md`

> **Document ID:** `GSB-MAC-TASK-008`
> **Version:** `0.3.0`
> **Last Updated:** `2026-08-30`
> **Status:** `Implemented`
> **Owner:** `spec-steward`
> **Implementation Owner:** `ios-dev`

## 1. Objective and context

The install and package smoke tests prove broker bootstrap, service start, lease acquire, snapshot generation, and cleanup. The original installed-app proof added process liveness, but a live PID alone did not prove that the installed app opened the requested state root or decoded the prepared broker snapshot.

That left a gap where packaging and launch could succeed while the dashboard silently failed to load broker state. The implemented proof now correlates the canonical installed executable, its one new PID, the exact fixture state root, and a valid snapshot generation no older than the prepared snapshot through bounded app telemetry.

## 2. Scope and boundaries

### In scope

- installed app launch verification in `install_smoke.sh`
- packaged app launch verification in `package_smoke.sh`
- deterministic launch arguments for smoke runs
- correlated installed-app snapshot-decode evidence
- identity-safe process cleanup after smoke launch
- pure evidence-verifier tests for positive and negative correlations

### Out of scope

- UI screenshot review as a hard gate
- notarization and release signing; see `GSB-MAC-TASK-009`
- full UI automation
- new Swift telemetry; the existing `AppLifecycle` and `Refresh` events are sufficient

### Required skills for implementation

- `apple-doc-research`
- `harness-engineering`
- `spec-creation-updating`
- `swift-concurrency-pro`
- `xcode-build`

## 3. Reproduction and current failure

The former weak proof can be recognized by inspecting the launch assertion:

```bash
bash scripts/install_smoke.sh
bash scripts/package_smoke.sh
```

Former behavior:

- snapshot files are validated
- broker lifecycle is validated
- the installed app is opened and a matching process name is kept alive briefly
- no evidence proves that the app process used the requested state root or decoded the prepared snapshot

## 4. Requirements

### Functional requirements

- `REQ-001` `install_smoke.sh` must launch the installed app bundle after the smoke fixture state is prepared.
- `REQ-002` `package_smoke.sh` must launch the packaged installed app bundle after installation from the portable bundle.
- `REQ-003` Launch verification must use deterministic `--state-root` and `--host-config` arguments pointing at the smoke fixture.
- `REQ-004` Each smoke script must assert that exactly one new process starts for the installed bundle's canonical executable path and remains alive through evidence verification.
- `REQ-005` Each smoke script must clean up only the identity-verified launched process before exit, including failure paths; PID-only termination is forbidden.
- `REQ-006` A bounded `LC_ALL=C /usr/bin/log stream --level info --style ndjson` capture must subscribe before the app is opened and must filter the app subsystem, `AppLifecycle` / `Refresh` categories, and exact canonical `processImagePath`.
- `REQ-007` Launch must wait for the stream's known filtering preamble while the stream process is alive. Stream exit, permission failure, malformed output, or a readiness timeout fails closed.
- `REQ-008` Snapshot decoding is proved only when the same exact process ID and image path emit both `App launch prepared stateRoot=<expected>` and `Refresh succeeded mode=manual snapshotGeneratedAt=<observed>`, where the observed value is valid canonical ISO-8601 and is equal to or newer than the prepared snapshot generation.
- `REQ-009` The pure evidence verifier must accept the known stream preamble, valid event NDJSON, and the count sentinel. While polling it may ignore only one unterminated final line; any other malformed complete line is fatal.
- `REQ-010` The summary must expose `snapshotDecodeVerified`, `refreshVerified`, the canonical executable, process identity, state root, prepared lower-bound generation, observed decoded generation, and evidence artifact paths.
- `REQ-011` `package_smoke.sh` must continue to delegate the installed-app proof to `install_smoke.sh` rather than maintain a second implementation.

### Minimum launch proof contract

- the installed bundle executable is canonicalized and exactly one new matching process exists after `open --fresh --new -a <app> --args ...`
- that exact PID and executable remain live while evidence is accepted
- the pre-launch bounded telemetry stream remains live while evidence is accepted
- that exact process reports the exact fixture state root
- that exact process reports a successful manual refresh with a valid, non-`none` `generatedAt` equal to or newer than the prepared lower bound

## 5. Implementation contract

### Write scope

- `scripts/install_smoke.sh`
- `scripts/installed_app_smoke_evidence.mjs`
- `docs/test/installed-app-smoke-evidence.test.mjs`
- `docs/test/front-door.test.mjs`
- `.agents/manifests/implementation-foundation.yaml`
- `spec/build-and-test.md`
- this task spec

### Required implementation shape

- Use the installed app path that the script already knows or can derive deterministically.
- Pass the same state root and host config the smoke script already created.
- Read `CFBundleExecutable`, require it to be executable, and canonicalize it before process or telemetry matching.
- Snapshot matching processes before launch and require exactly one new PID whose `ps command=` is the canonical executable with optional arguments.
- Launch with `open --fresh --new -a` so saved-window restoration cannot suppress creation of the dashboard root and its initial refresh task.
- Start a 40-second narrow unified-log stream before `open`; use shorter readiness, launch, and evidence deadlines so the stream cannot time out successfully underneath verification.
- Regenerate the installed CLI snapshot after stream readiness and retain its valid `generatedAt` as a lower bound immediately before `open`. The daemon may legitimately publish a newer canonical artifact before the app refreshes, so the verifier accepts only the prepared generation or a newer valid generation.
- Verify the two existing public telemetry messages through `scripts/installed_app_smoke_evidence.mjs`; do not add app telemetry for this task.
- Keep the existing post-launch liveness delay as an additional check, never as a fallback proof.
- Add a trap/finally-style cleanup path that rechecks canonical executable identity before terminating the recorded PID.
- Keep the bounded log and proof JSON only in the caller's smoke artifact directory or the smoke run's temporary root.

## 6. Non-functional and security requirements

- Launch verification must add only a small amount of wall-clock time to smoke tests.
- The scripts must leave no orphaned app process on pass or fail.
- The source and deterministic tests must use public-safe synthetic paths; machine-local log and proof artifacts are never committed.
- The fresh-launch flag intentionally discards saved window restoration for the smoke bundle. This app stores only disposable dashboard selection, search, filter, and inspected-item state there; it has no document scene or user-authored data in restoration state. Durable broker configuration and snapshots live outside that state and are not cleared.
- Following the layered-failure guidance in [How Complex Systems Fail](https://how.complexsystems.fail), PID liveness is treated as one fallible signal rather than a root-cause claim. Acceptance requires independent identity, launch-context, and decoded-snapshot signals, and every missing or malformed layer fails closed with bounded diagnostics.

## 7. Verification and completion

### Required checks

1. Run pure helper and docs contracts:
   ```bash
   node --test docs/test/installed-app-smoke-evidence.test.mjs
   npm run test:docs
   bash -n scripts/install_smoke.sh scripts/package_smoke.sh
   ```
2. Run the focused snapshot loader tests:
   ```bash
   npm run test:app:focus -- SimulatorBrokerAppTests/BrokerSnapshotLoaderTests
   ```
3. Run install smoke with a durable artifact directory:
   ```bash
   bash scripts/install_smoke.sh --artifact-dir <session-artifacts>/install-smoke
   ```
4. After install smoke and its cleanup complete, run package smoke serially:
   ```bash
   bash scripts/package_smoke.sh --artifact-dir <session-artifacts>/package-smoke
   ```
5. Confirm both summaries set `snapshotDecodeVerified`, `refreshVerified`, and `launchVerified` to `true`; inspect the bounded NDJSON and evidence JSON to confirm one exact PID, executable, state root, and generated-at correlation.

### Completion criteria

- both smoke scripts prove the installed app decoded the prepared-or-newer canonical snapshot, not just that a same-named process lived
- wrong PID, executable path, state root, earlier/invalid/`none` generated-at values, split-PID evidence, malformed records, and missing evidence are rejected deterministically; a newer valid generation is accepted
- cleanup remains deterministic and revalidates executable identity before termination
- no existing smoke assertions regress

## 8. Risks and sequencing

- Unified-log delivery is asynchronous, so capture starts before launch and polling ignores only a trailing partial line. Deadlines remain below the stream timeout.
- The daemon can refresh `app-snapshot.json` after preparation. Treating the prepared generation as a monotonic lower bound proves prepared-or-fresher decoding without pausing brokerd or racing its periodic reconciliation.
- A PID may be reused after an app exits. Cleanup therefore refuses to signal a recorded PID unless its current command still matches the canonical installed executable.
- One broad historical log query could mix runs or expose unrelated local activity. The implementation keeps only the bounded, pre-launch, exact-path stream.

## Document history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.3.0 | 2026-08-30 | Codex | Replaced PID-only launch acceptance with bounded, exact-process snapshot-decode evidence, fail-closed parsing, deterministic negative tests, and identity-safe cleanup. |
| 0.2.1 | 2026-04-14 | Codex | Hardened launch-smoke cleanup so failed app-launch verification still releases leases and brokerd processes deterministically. |
| 0.2.0 | 2026-04-14 | Codex | Implemented installed-app launch verification in install and package smoke coverage with deterministic launch args and cleanup proof. |
| 0.1.0 | 2026-04-11 | Codex | Initial worker-ready task spec |

## Related documents

- `spec/tasks/macos-telemetry-instrumentation.md`
- `spec/tasks/macos-distribution-readiness.md`
