# Agent Rules

Use Simulator Broker for broker-managed simulator work in this repo.

- Acquire simulators by purpose from `.simulator-broker/project.json`.
- Use `bash scripts/run-agent-ui-session.sh` for interactive agent sessions.
- Use `bash scripts/run-agent-build-test.sh` for unattended agent build or test runs.
- Use `simbroker lease explain --repo-root "$PWD" --purpose <purpose>` and `simbroker host status` when a lease request is denied.
- Use `simbroker lease show --lease-file "$SIMBROKER_LEASE_FILE"` and `simbroker events watch` for deeper diagnosis while a run is active.
- When `capacity check` reports `recommendedAction` `repair_matching_simulators`, repair that purpose once and then retry acquire once. A `repair_needed` status with `install_runtime` or `run_broker_doctor` follows that action:

  `simbroker simulators repair --repo-root "$PWD" --purpose <purpose> --actor-type agent --actor-id <id> --json`

- Exit `0` retries acquire once. Exit `5` stops for a human. Never pass `--force-override`.
- Exit `4` runs `simbroker doctor` locally, reads `driftReason`, and stops. Do not paste doctor output, aliases, simulator IDs, or host paths into public logs.
- Do not hardcode host alias names into repo logic.
- Do not call `xcrun simctl` boot, shutdown, erase, delete, or repair on broker-managed simulators.
- Do not put repair inside the wrapper scripts. Those scripts only acquire and release.
