---
tracker:
  kind: local
  project: simulator-broker
workspace:
  repo_path: .
  base_ref: refs/heads/main
codex:
  command: codex app-server --listen stdio://
validation:
  command: ./scripts/validate.sh
  evidence_path: .symphony/evidence.json
  log: .symphony/validation.log
  protected_paths:
    - WORKFLOW.md
    - package.json
    - scripts/validate.sh
    - .agents/manifests
    - .agents/verify
handoff:
  default_push: false
  default_pr: false
  require_explicit_pr_handoff: true
  local_commit: true
  final_acceptance: human
agent:
  max_repair_turns: 2
safety:
  require_clean_base_repo: true
  stop_after_validated_local_handoff: true
---

# Simulator Broker Workflow

Implement one source-owned Simulator Broker task using the repository contracts.

- Read `AGENTS.md` and the linked specs before editing.
- Match every changed path to `.agents/manifests/*.yaml` and open the required
  skills before implementation.
- Keep local paths, credentials, private task context, machine identities,
  simulator identifiers, and host-local configuration out of public files.
- Use a task session under
  `$AGENT_HOME/agent-harness/simulator-broker/` and satisfy every selected
  verification profile before closeout.
- Run `./scripts/validate.sh` before handoff.
- Do not weaken this workflow, its validator, or `.agents` verification
  contracts from an ordinary implementation task.
- Do not push or open a pull request from the default run path. Leave a
  validated local commit for explicit human-reviewed PR handoff.

Stop after the requested task is implemented, the canonical validator passes,
and the repository harness reports a clean completed session.
