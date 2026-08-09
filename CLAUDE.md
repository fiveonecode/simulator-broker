## Local Operator Context

Use local operator-provided context if available. Do not commit private/local context files, machine paths, credentials, internal task links, or company-only notes.

## Source Of Truth

- Master spec entry: `spec/README.md`
- Core system spec: `spec/global-simulator-broker.md`
- Architecture overview: `spec/architecture.md`
- Build and verification rules: `spec/build-and-test.md`
- Repo structure contract: `spec/project-structure.md`
- Agent workflow contract: `spec/agents.md`

## Required Workflow

1. Identify the paths you intend to change and choose a task session dir under `$CODEX_HOME/agent-harness/simulator-broker-app/`.
2. Run `npm run agent:context -- --paths <files> --session-dir <dir>` and treat any reported verification obligations as blocking acceptance requirements, not optional suggestions.
3. If the task is underspecified, expected to span multiple autonomous rounds, or likely to need a clean resume, rerun `agent:context` with `--session-mode long-running`, then populate the session artifacts with `npm run agent:plan`, `npm run agent:handoff`, and `npm run agent:evaluate`.
4. Read the linked specs and open required skill `SKILL.md` files before implementation.
5. Make the change.
6. Run `npm run agent:verify -- --profile <profile-id> --paths <files> --session-dir <dir>` for each required profile.
   For verification profiles or commands marked `longRunning: true` or `commentaryPolicy: event-only`, prefer detached execution with `npm run agent:verify -- --profile <profile-id> --paths <files> --session-dir <dir> --detach`, then resume with `npm run agent:detached-status -- --artifact <detached-run.json> --wait`.
   Chat commentary for detached/event-waited runs must be event-based only: started/detached, phase change, pass, fail, timeout, process exited without result, or user decision needed. Do not post timer-based heartbeat updates while status reports no material change.
   After context compaction, interruption, or takeover of a long-running run, recover state by reading `detached-run.json`, git status, stdout/stderr logs referenced by the artifact, and the final result file such as `verify-result.json`. Do not infer current run state from chat history.
7. Update specs if behavior, contracts, or project structure changed.
8. Every meaningful task commit must be a structured git commit using the required sections: `Why:`, `Changed:`, `Verification:`, `Affected:`, `Refs:`, `Session:`. Commit messages are durable public output: use repo-relative paths, GitHub URLs, commit SHAs, and public task artifact labels such as `task-sessions/<session-name>`; never include machine-local or parent-relative paths. `agent:complete` rejects detected local-path forms in every new commit touching task paths.
9. Run `npm run agent:complete -- --session-dir <dir>` before claiming completion. If it reports `blocked`, the task is incomplete/blocked, not done.
10. Report exact verification commands, pass/fail outcomes, artifact paths, and the closing commit SHA.

## Harness Commands

- `npm run agent:catalog`
- `npm run agent:complete`
- `npm run agent:context`
- `npm run agent:detached-start`
- `npm run agent:detached-status`
- `npm run agent:doctor`
- `npm run agent:evaluate`
- `npm run agent:eval`
- `npm run agent:handoff`
- `npm run agent:plan`
- `npm run agent:scorecard`
- `npm run agent:soak`
- `npm run agent:verify`
- `npm --prefix agent-harness run preflight -- --paths-file <file>`

## Non-Skippable Gates

### Gate A — Skill Invocation

- Use `spec-creation-updating` whenever you create or materially change specs, manifests, or verification contracts.
- Use `apple-doc-research` for Apple platform API or WWDC guidance.
- Use `swiftui-pro` for SwiftUI implementation or review.
- Use `swift-concurrency-pro` for async/await, actor, task, or cross-thread correctness work.
- Use `screenshot-analyze-verification` whenever screenshots are used as acceptance evidence.
- Use `harness-engineering` when evolving the agent harness, manifests, verification profiles, or project automation around those surfaces.
- Use `xcode-build` whenever the macOS app must build, launch, debug, or expose a Codex Run action. Keep `script/build_and_run.sh` and `.codex/environments/environment.toml` wired together.
- Use `swiftui-pro` for SwiftUI scene structure, sidebars, toolbars, commands, search, settings, keyboard-driven desktop behavior, view refactors, window chrome, and modern macOS materials.
- Use `swift-concurrency-pro` for async service calls, task cancellation, actors, and cross-thread correctness.
- Use `apple-doc-research` when Apple framework, signing, packaging, notarization, or platform guidance is needed.

### Gate B — Verification

- Specs and harness setup changes must pass the `spec-only` profile unless a stronger profile is defined for that surface.
- Verification sessions: close the shared task session with `agent:complete` and treat any missing required proof as a failure or explicit block.
- Detached verification keeps the final result at the same `verify-result.json` path, so `agent:complete` remains the close-out gate.
- Do not claim implementation readiness without deterministic verification and a clean worktree closeout.

### Gate C — Evidence Before Done

- Report exact commands.
- Include pass/fail status.
- Include relevant artifact paths.
- Every meaningful task commit must be structured; do not leave unstructured task commits in durable history.
- Leave no new incidental worktree junk behind; delete temporary files or ignore them deliberately instead of committing them blindly.
- If the task is incomplete, say so explicitly.

## Working Tree Hygiene

- Do not overwrite unrelated changes if multiple agents touch the repo later.
- Delete temporary files or ignore them deliberately.
- Keep `AGENTS.md` and `CLAUDE.md` identical.
