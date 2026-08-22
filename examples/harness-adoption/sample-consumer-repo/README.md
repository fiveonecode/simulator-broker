# Sample Consumer Repo

This sample repo demonstrates a small pattern library a consumer repo can copy and adapt to become broker-aware.

Included surfaces:

- `.simulator-broker/project.json`
- `AGENTS.md` and `CLAUDE.md`
- `scripts/with-broker-lease.sh`
- `scripts/run-manual-testing-session.sh`
- `scripts/run-agent-ui-session.sh`
- `scripts/run-agent-build-test.sh`
- `ci/run-ui-test.sh`
- `.github/workflows/broker-ui-test.yml`

Fresh repos can scaffold the starting project file with:

```bash
simbroker project init --repo-root /path/to/repo
```

Run `simbroker setup` once on the Mac first. The generated UI purposes require
an iPhone but remain iOS-version agnostic unless the project explicitly passes
`--ios-version`.

Then adapt the generated purposes and add the wrapper scripts shown in this sample.

Example local usage:

```bash
SIMBROKER_BIN=/path/to/simbroker \
SIMBROKER_HOST_CONFIG=/path/to/host-config.json \
SIMBROKER_STATE_ROOT=/path/to/state \
BROKER_RUN_DIR=/tmp/sample-broker-run \
BROKER_ACTOR_ID=agent-local \
bash scripts/run-agent-ui-session.sh
```

`scripts/with-broker-lease.sh` records downstream command PID metadata with `simbroker lease register-process`. On downstream failure it calls `simbroker lease contain --reason forced-abort`, writes evidence under `$BROKER_RUN_DIR/simulator-broker-evidence`, and preserves the downstream exit status.

Optional containment environment:

```bash
BROKER_MEMORY_CEILING_MIB=32768
BROKER_MONITOR_INTERVAL_MS=1000
BROKER_SIMULATOR_PROCESS_NAMES="Sample App Test Host App"
```

Other sample flows:

```bash
bash scripts/run-manual-testing-session.sh
bash scripts/run-agent-build-test.sh
bash ci/run-ui-test.sh
```
