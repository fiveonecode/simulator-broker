# Agent Rules

Use Simulator Broker for broker-managed simulator work in this repo.

- Acquire simulators by purpose from `.simulator-broker/project.json`.
- Use `bash scripts/run-agent-ui-session.sh` for interactive agent sessions.
- Use `bash scripts/run-agent-build-test.sh` for unattended agent build or test runs.
- Use `simbroker lease explain --repo-root "$PWD" --purpose <purpose>` and `simbroker host status` when a lease request is denied.
- Use `simbroker lease show --lease-file "$SIMBROKER_LEASE_FILE"` and `simbroker events watch` for deeper diagnosis while a run is active.
- Do not hardcode host alias names into repo logic.
- Do not call direct `simctl` boot, shutdown, erase, or repair on broker-managed aliases.
