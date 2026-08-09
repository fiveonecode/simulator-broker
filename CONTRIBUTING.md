# Contributing

Thanks for taking the time to improve Simulator Broker.

## Setup

Requirements:

- macOS with Xcode and iOS Simulator support
- Node.js LTS
- `xcodegen` on `PATH`

Install and verify from the repo root:

```bash
npm install --package-lock-only
npm run agent:catalog -- --format md
npm test
```

The macOS app project is generated locally and is not checked in:

```bash
npm run build:app
```

## Development Workflow

Before editing, identify the changed paths and create a task session:

```bash
npm run agent:context -- --paths <files> --session-dir "$HOME/.codex/agent-harness/simulator-broker-app/<session>"
```

Run every verification profile reported by the context command. Specs and
harness-only changes normally require:

```bash
npm run agent:verify -- --profile spec-only --paths <files> --session-dir "$HOME/.codex/agent-harness/simulator-broker-app/<session>"
```

Implementation changes normally require:

```bash
npm test
```

## Pull Requests

- Keep changes focused and reviewable.
- Include tests or explain why a deterministic test is not available.
- Keep private/local context out of committed files.
- Do not commit generated Xcode projects, derived data, local broker state,
  credentials, machine-specific paths, or task-session artifacts.

Meaningful task commits should use the structured sections documented in
`AGENTS.md`.
