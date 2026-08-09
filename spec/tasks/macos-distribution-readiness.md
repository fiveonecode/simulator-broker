# macOS Distribution Readiness
Related: `spec/tasks/README.md`, `app/project.yml`, `scripts/package_local.sh`, `scripts/install_distribution.sh`, `spec/build-and-test.md`

> **Document ID:** `GSB-MAC-TASK-009`
> **Version:** `0.2.0`
> **Last Updated:** `2026-04-14`
> **Status:** `Implemented`
> **Owner:** `spec-steward`
> **Implementation Owner:** `ios-dev`

## 1. Objective and context

The current package flow produces a locally runnable portable bundle, but it is not distribution-ready:

- it packages the Debug app from DerivedData
- signing is ad hoc (`Signature=adhoc`, `TeamIdentifier=not set`)
- `spctl` rejects the built app
- the docs and script names do not clearly separate local-debug packaging from signed distribution packaging

This task defines how to make the packaging story honest and implementation-ready without requiring repo-committed secrets.

## 2. Scope and boundaries

### In scope

- separating local-debug packaging from release/distribution packaging semantics
- release build packaging path and validation contract
- explicit signing/notarization readiness checks
- documentation of what remains operator-supplied

### Assumptions and constraints

- `scripts/install_distribution.sh` remains an installer for an already-built payload; it is not the packaging entrypoint.
- The repo must not depend on committed signing secrets, certificates, or notarization credentials.
- The repo already has a useful local-debug portable bundle path and that convenience must remain available.

### Out of scope

- storing Apple certificates, private keys, or credentials in the repo
- performing real notarization when credentials are unavailable
- changing the broker CLI or app runtime behavior unrelated to packaging

### Required skills for implementation

- `apple-doc-research`
- `xcode-build`

## 3. Reproduction and current failure

### Current reproduction

```bash
bash scripts/package_local.sh
codesign -dvvv --entitlements :- DerivedData/SimulatorBrokerApp/Build/Products/Debug/SimulatorBrokerApp.app
spctl -a -vv DerivedData/SimulatorBrokerApp/Build/Products/Debug/SimulatorBrokerApp.app
```

Current result:

- the package is built from `Debug`
- the app is ad hoc signed
- `spctl` rejects it

## 4. Requirements

### Packaging requirements

- `REQ-001` The repo must distinguish between:
  - local debug packaging for development convenience
  - release/distribution packaging for operator validation or shipping
- `REQ-002` A release/distribution packaging path must not silently package the Debug app.
- `REQ-003` The packaging docs and script names/help text must clearly state which path is local-debug only and which path is intended for signed distribution.
- `REQ-004` `scripts/package_local.sh` must remain the explicit Debug/development bundle path.
- `REQ-005` A new `scripts/package_distribution.sh` entrypoint must be added for Release packaging; this task must not overload `package_local.sh` with dual semantics.

### Signing/readiness requirements

- `REQ-006` The distribution-oriented path must run explicit signing/readiness validation commands and fail clearly when signing prerequisites are missing.
- `REQ-007` The repo must document which inputs are operator-supplied and therefore cannot be committed:
  - Apple team ID
  - signing identity
  - notarization credentials or equivalent secure operator configuration
- `REQ-008` The repo must not claim notarization success or Gatekeeper readiness when only ad hoc signing is present.

### Build configuration requirements

- `REQ-009` The distribution-oriented path must build the app in `Release`.
- `REQ-010` The distribution-oriented path must validate the produced artifact with `codesign` and `spctl`.
- `REQ-011` If additional XcodeGen settings, entitlements files, or signing config files are required, their purpose and ownership must be explicit.

### Required packaging contract

- `scripts/package_local.sh`
  - continues to build or package the Debug app
  - continues to produce a local portable bundle for development convenience
  - must document that it is not a distribution-ready artifact
- `scripts/package_distribution.sh`
  - must build the app in `Release`
  - must require operator-supplied signing prerequisites before packaging
  - accepts `--team-id` / `SIMBROKER_DISTRIBUTION_TEAM_ID` and `--signing-identity` / `SIMBROKER_DISTRIBUTION_SIGNING_IDENTITY`
  - accepts optional `--notarytool-profile` / `SIMBROKER_NOTARYTOOL_PROFILE` for notarization and stapling
  - must validate the built artifact with `codesign` and `spctl`
  - must write a machine-readable summary file indicating at minimum: build configuration, signing identity summary, team identifier summary, `spctl` result, and notarization status
- `package.json`
  - must expose a canonical distribution packaging alias such as `npm run package:distribution`

## 5. Implementation contract

### Write scope

- `app/project.yml`
- packaging/install scripts under `scripts/`
- `app/README.md` and `spec/build-and-test.md`
- additional config files under `app/` if needed for entitlements or release settings

### Required implementation shape

- Preserve `scripts/package_local.sh` as the clearly marked local-debug packaging path for local development.
- Introduce `scripts/package_distribution.sh` as the separate distribution-oriented path that builds Release artifacts.
- Add validation output that makes it impossible to mistake ad hoc signing for distribution readiness.
- If true notarization cannot be executed in CI/local by default, document the exact credential boundary rather than pretending it is complete.

### Required implementation sequence

1. Keep `scripts/package_local.sh` explicitly Debug-only and update its help text and generated bundle README to say so.
2. Add `scripts/package_distribution.sh` that:
   - generates the Xcode project
   - builds the app in `Release`
   - fails early if required signing inputs are missing
   - validates the built app with `codesign -dvvv --entitlements :-` and `spctl -a -vv`
   - writes a summary JSON describing signing and notarization-readiness state
3. Update any XcodeGen signing configuration or entitlements wiring needed for the Release path.
4. Update `package.json`, `app/README.md`, and `spec/build-and-test.md` so local-debug and distribution packaging are described as two distinct flows.
5. If notarization is not executed automatically, document the exact follow-up operator step and the credential boundary instead of implying completion.

### Guardrails

- Do not commit signing secrets.
- Do not rename a debug-only package as “distribution-ready”.
- Do not block ordinary local debug runs on signing/notarization requirements.

## 6. Non-functional and security requirements

- Security is central to this task. The implementation must keep secrets outside the repo and make signing state explicit.
- Reliability requirement: packaging scripts must fail with actionable diagnostics, not vague copy errors.

## 7. Verification and completion

### Required checks

1. Local-debug package path still works for development use.
2. Distribution-oriented package path builds `Release` through `scripts/package_distribution.sh`.
3. Validation commands are explicit and documented:
   ```bash
   codesign -dvvv --entitlements :- <built-app>
   spctl -a -vv <built-app>
   ```
4. If signing prerequisites are absent, the distribution-oriented path fails clearly with a message explaining the missing prerequisites.
5. The distribution summary JSON accurately reports whether notarization was executed or skipped.

### Completion criteria

- local-debug packaging remains available and correctly labeled
- distribution-oriented packaging is distinct and explicit
- validation output makes signing/notarization readiness honest and auditable

## 8. Risks and sequencing

- This task may require current Apple signing guidance confirmation during implementation.
- `GSB-MAC-TASK-008` may reuse the packaged app path but should not be blocked on notarization work.

## Document history

| Version | Date | Author | Changes |
|---|---|---|---|
| 0.2.0 | 2026-04-14 | Codex | Marked implemented and recorded the concrete distribution-packaging operator inputs |
| 0.1.0 | 2026-04-11 | Codex | Initial worker-ready task spec |

## Related documents

- `spec/tasks/macos-installed-app-launch-smoke.md`
- `app/README.md`
