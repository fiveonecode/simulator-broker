# Agent Rules

Use Simulator Broker for broker-managed simulator work in this repo.

- Acquire simulators by purpose from `.simulator-broker/project.json`.
- Use `bash scripts/run-agent-ui-session.sh` for interactive agent sessions.
- Use `bash scripts/run-agent-build-test.sh` for unattended agent build or test runs.
- Use `simbroker lease explain --repo-root "$PWD" --purpose <purpose>` and `simbroker host status` when a lease request is denied.
- Use `simbroker lease show --lease-file "$SIMBROKER_LEASE_FILE"` and `simbroker events watch` for deeper diagnosis while a run is active.
- When `capacity check` reports `recommendedAction` `repair_matching_simulators`, repair that purpose once and then retry acquire once:

  `simbroker simulators repair --repo-root "$PWD" --purpose <purpose> --actor-type agent --actor-id <id> --json`

- A `repair_needed` status with `install_runtime`, `run_broker_doctor`, or `inspect_unknown` follows that recommended action. Do not run purpose repair for those actions. Do not run purpose delete for those actions.

- Exit `0` retries acquire once. Exit `5` stops for a human. Never pass `--force-override`.
- Exit `4` whose `reasons` include `runtime-not-found` or `device-type-not-found` runs purpose delete once:

  `simbroker simulators delete --repo-root "$PWD" --purpose <purpose> --actor-type agent --actor-id <id> --json`

  Delete exit `0` retries `capacity check` once and acquires only when `purposes[].status` is `available`. Delete exit `5` stops for a human. Any other repair or delete exit `4` runs `simbroker doctor` locally, reads `causeCode` and `driftReason`, and stops. Do not paste doctor output, aliases, simulator IDs, or host paths into public logs.
- When `capacity check` reports `recommendedAction` `create_capacity`, preview reconcile once and apply that plan once when status is `changes_required`:

  `simbroker capacity reconcile --repo-root "$PWD" --purpose <purpose> --apply --confirm <plan-id> --actor-type agent --actor-id <id> --json`

  Then run `capacity check` once and acquire only when `purposes[].status` is `available`. Stop on a blocked preview, apply exit `4` or `5`, or a check that is still not available. Do not apply a second time. Do not use `--actor-type ci`.
- Do not hardcode host alias names into repo logic.
- Do not call `xcrun simctl` boot, shutdown, erase, delete, or repair on broker-managed simulators.
- Do not put repair, delete, or capacity apply inside the wrapper scripts. Those scripts only acquire and release.
