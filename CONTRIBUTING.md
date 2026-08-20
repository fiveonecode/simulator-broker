# Contributing

Thanks for taking the time to improve Simulator Broker.

This project is **Alpha**, **macOS-only**, and needs **Xcode** to create or run
iOS Simulators. Report install failures, bugs, and feature requests with the
[issue forms](https://github.com/fiveonecode/simulator-broker/issues/new/choose).
Look at issues labeled `good first issue` if you want a bounded starter task.

This page has two tracks:

1. **Public patches** — Node.js 20 and the Node test suites. You do not need
   the agent harness or a Codex session directory.
2. **Maintainers and agent runs** — the existing `agent:context` /
   `agent:verify` / `agent:complete` flow.

## Public patches

Use this track for a small public change: a spec tweak, a CLI or broker-core
fix, a doc edit, or a focused app patch.

Requirements:

- Node.js 20 or newer on `PATH`
- macOS with Xcode and iOS Simulator support for work that talks to simulators
- `xcodegen` on `PATH` only if you change or build the macOS app

From the repo root, run the Node suites that match what you changed. These
commands do not go through `agent:*`:

```bash
npm run test:broker-core
npm run test:client
npm run test:docs
npm run test:harness-adoption
```

Run `npm run test:docs` for doc, README, or template changes; it runs the `docs/test` front-door checks.

App work also needs XcodeGen and `npm run test:app`. The full suite is
`npm test`. GitHub-hosted Ubuntu CI runs public-surface, `test:broker-core`,
`test:client`, and `test:harness-adoption`. That job does not run
`npm run test:app` or `npm run test:docs`.

You do not need to run `agent:context`, `agent:verify`, or `agent:complete`,
and you do not need to create a task session directory.

### Pull requests

The pull-request template is a short public-patch checklist. It does not ask
for a harness session directory.

- Keep changes focused and reviewable.
- Include tests or explain why a deterministic test is not available.
- Keep private or local context out of committed files.
- Do not commit generated Xcode projects, derived data, local broker state,
  credentials, machine-specific paths, or task-session artifacts.

## Maintainers and agent runs

Use this track for maintainer work and agent runs that follow the product
harness. Harness enforcement is unchanged: `agent:complete` still requires
structured commits, selected verification profiles, and session artifacts.

Before editing, identify the changed paths and create a task session:

```bash
npm run agent:context -- --paths <files> --session-dir <session-dir>
```

Run every verification profile reported by the context command. Specs and
docs normally require:

```bash
npm run agent:verify -- --profile spec-only --paths <files> --session-dir <session-dir>
```

Implementation changes normally require:

```bash
npm run agent:verify -- --profile implementation --paths <files> --session-dir <session-dir>
npm test
```

Close the session with:

```bash
npm run agent:complete -- --session-dir <session-dir>
```

Meaningful task commits use the structured sections documented in
[AGENTS.md](AGENTS.md).
