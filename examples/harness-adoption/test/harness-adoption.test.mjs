import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { createDeviceRecord, createSimctlFixture } from "../../../broker-core/test/support/simctl-fixture.mjs";

const SAMPLE_REPO = path.resolve("examples/harness-adoption/sample-consumer-repo");
const CLI_PATH = path.resolve("client/bin/simbroker.mjs");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-harness-"));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeExecutable(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
}

function makeHostFixture() {
  const root = makeTempDir();
  const hostConfigPath = path.join(root, "host-config.json");
  const stateRoot = path.join(root, "state");
  const simctl = createSimctlFixture(root, {
    devices: [
      createDeviceRecord({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        name: "Manual One",
        udid: "SIM-MANUAL-1",
      }),
      createDeviceRecord({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        name: "UI One",
        udid: "SIM-UI-1",
      }),
      createDeviceRecord({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        name: "UI Two",
        udid: "SIM-UI-2",
      }),
      createDeviceRecord({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        name: "Build One",
        udid: "SIM-BUILD-1",
      }),
      createDeviceRecord({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        name: "Automation One",
        udid: "SIM-AUTO-1",
      }),
    ],
  });
  writeJson(hostConfigPath, {
    version: 1,
    hostId: "harness-host",
    aliases: [
      {
        alias: "manual-1",
        capabilities: ["manual-persistent"],
        deviceFamily: "iPhone",
        displayName: "Manual One",
        iosVersion: "18.2",
        simulatorId: "SIM-MANUAL-1",
      },
      {
        alias: "ui-1",
        capabilities: ["interactive-resettable"],
        deviceFamily: "iPhone",
        displayName: "UI One",
        iosVersion: "18.2",
        resetPolicy: "erase-on-acquire",
        simulatorId: "SIM-UI-1",
      },
      {
        alias: "ui-2",
        capabilities: ["interactive-resettable"],
        deviceFamily: "iPhone",
        displayName: "UI Two",
        iosVersion: "18.2",
        resetPolicy: "erase-on-acquire",
        simulatorId: "SIM-UI-2",
      },
      {
        alias: "build-1",
        capabilities: ["build-fast"],
        deviceFamily: "iPhone",
        displayName: "Build One",
        iosVersion: "18.2",
        simulatorId: "SIM-BUILD-1",
      },
      {
        alias: "auto-1",
        capabilities: ["automation-resettable"],
        deviceFamily: "iPhone",
        displayName: "Automation One",
        iosVersion: "18.2",
        resetPolicy: "erase-on-acquire",
        simulatorId: "SIM-AUTO-1",
      },
    ],
  });
  return { hostConfigPath, root, simctl, stateRoot };
}

function runCommand(command, args, env, cwd = SAMPLE_REPO) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env?.simctl,
      ...env,
    },
  });
}

function runScript(scriptPath, env) {
  return runCommand("bash", [scriptPath], env);
}

function activeLeaseFiles(stateRoot) {
  const leasesDir = path.join(stateRoot, "leases");
  if (!fs.existsSync(leasesDir)) {
    return [];
  }
  return fs.readdirSync(leasesDir).filter((entry) => entry.endsWith(".json"));
}

function activeLeaseActors(stateRoot) {
  const leasesDir = path.join(stateRoot, "leases");
  return activeLeaseFiles(stateRoot)
    .map((entry) => JSON.parse(fs.readFileSync(path.join(leasesDir, entry), "utf8")).actorId)
    .sort();
}

async function waitFor(check, { intervalMs = 25, message, timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(message ?? "Timed out waiting for condition.");
}

function waitForChildExit(child) {
  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("exit", (code, signal) => {
      resolve({
        code,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
}

function processState(pid) {
  const result = spawnSync("ps", ["-o", "stat=,command=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return { defunct: false, exists: false };
  }
  const line = result.stdout.trim();
  if (!line) {
    return { defunct: false, exists: false };
  }
  const [stat = "", ...commandParts] = line.split(/\s+/);
  const command = commandParts.join(" ");
  const defunct = stat.toUpperCase().startsWith("Z") || command.includes("<defunct>");
  return {
    defunct,
    exists: !defunct,
  };
}

function processExists(pid) {
  return processState(pid).exists;
}

test("sample repo agent wrapper acquires by purpose and releases on exit", () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "agent-run");
  const sessionDir = path.join(fixture.root, "agent-session");

  const result = runScript(path.join(SAMPLE_REPO, "scripts/run-agent-ui-session.sh"), {
    BROKER_ACTOR_ID: "agent-smoke",
    BROKER_RUN_DIR: runDir,
    SESSION_DIR: sessionDir,
    SIMBROKER_BIN: CLI_PATH,
    SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
    SIMBROKER_STATE_ROOT: fixture.stateRoot,
    ...fixture.simctl.env,
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(runDir, "agent-ui-session-report.json"), "utf8"));
  assert.equal(report.projectId, "sample-consumer-repo");
  assert.equal(report.purposeId, "agent-ui-session");
  assert.equal(report.actorType, "agent");
  assert.ok(["ui-1", "ui-2"].includes(report.simulatorAlias));
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
});

test("sample repo manual wrapper acquires the manual purpose and releases on exit", () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "manual-run");

  const result = runScript(path.join(SAMPLE_REPO, "scripts/run-manual-testing-session.sh"), {
    BROKER_ACTOR_ID: "human-smoke",
    BROKER_RUN_DIR: runDir,
    SIMBROKER_BIN: CLI_PATH,
    SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
    SIMBROKER_STATE_ROOT: fixture.stateRoot,
    ...fixture.simctl.env,
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(runDir, "manual-testing-report.json"), "utf8"));
  assert.equal(report.projectId, "sample-consumer-repo");
  assert.equal(report.purposeId, "manual-testing");
  assert.equal(report.actorType, "human");
  assert.equal(report.simulatorAlias, "manual-1");
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
});

test("sample repo agent build-test wrapper emits job metadata and releases on exit", () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "agent-build-run");
  const sessionDir = path.join(fixture.root, "agent-build-session");

  const result = runScript(path.join(SAMPLE_REPO, "scripts/run-agent-build-test.sh"), {
    BROKER_ACTOR_ID: "agent-build-smoke",
    BROKER_JOB_ID: "agent-build-42",
    BROKER_JOB_KIND: "build-test",
    BROKER_RUN_DIR: runDir,
    SESSION_DIR: sessionDir,
    SIMBROKER_BIN: CLI_PATH,
    SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
    SIMBROKER_STATE_ROOT: fixture.stateRoot,
    ...fixture.simctl.env,
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(runDir, "agent-build-test-report.json"), "utf8"));
  assert.equal(report.projectId, "sample-consumer-repo");
  assert.equal(report.purposeId, "agent-build-test");
  assert.equal(report.actorType, "agent");
  assert.equal(report.jobId, "agent-build-42");
  assert.equal(report.jobKind, "build-test");
  assert.equal(report.simulatorAlias, "build-1");
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
});

test("sample repo ci wrapper emits job metadata and releases on exit", () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "ci-run");

  const result = runScript(path.join(SAMPLE_REPO, "ci/run-ui-test.sh"), {
    BROKER_ACTOR_ID: "ci-smoke",
    BROKER_RUN_DIR: runDir,
    CI_JOB_ID: "build-42",
    CI_JOB_KIND: "ui-test",
    SIMBROKER_BIN: CLI_PATH,
    SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
    SIMBROKER_STATE_ROOT: fixture.stateRoot,
    ...fixture.simctl.env,
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(runDir, "ci-ui-test-report.json"), "utf8"));
  assert.equal(report.projectId, "sample-consumer-repo");
  assert.equal(report.purposeId, "ci-ui-test");
  assert.equal(report.actorType, "ci");
  assert.equal(report.jobId, "build-42");
  assert.equal(report.jobKind, "ui-test");
  assert.equal(report.simulatorAlias, "auto-1");
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
});

test("shared lease wrapper releases the lease after downstream failure", () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "failure-run");

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-failure",
      "--run-dir", runDir,
      "--",
      "bash", "-lc", "exit 7",
    ],
    {
      SIMBROKER_BIN: CLI_PATH,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.equal(result.status, 7, result.stderr);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
});

test("shared lease wrapper keeps concurrent shared-run releases isolated", async () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "shared-concurrent-run");
  const firstDone = path.join(runDir, "first.done");
  const secondDone = path.join(runDir, "second.done");
  const wrapperPath = path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh");
  const env = {
    ...process.env,
    ...fixture.simctl.env,
    SIMBROKER_BIN: CLI_PATH,
    SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
    SIMBROKER_STATE_ROOT: fixture.stateRoot,
  };

  fs.mkdirSync(runDir, { recursive: true });

  const spawnWrapper = (actorId, doneFlag) => spawn("bash", [
    wrapperPath,
    "--purpose", "agent-ui-session",
    "--actor-type", "agent",
    "--actor-id", actorId,
    "--run-dir", runDir,
    "--",
    "bash", "-lc", "while [[ ! -f \"$1\" ]]; do sleep 0.05; done", "_", doneFlag,
  ], {
    cwd: SAMPLE_REPO,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const firstRun = spawnWrapper("agent-one", firstDone);
  await waitFor(
    () => activeLeaseFiles(fixture.stateRoot).length === 1,
    { message: "First wrapper never acquired its lease." },
  );

  const secondRun = spawnWrapper("agent-two", secondDone);
  await waitFor(
    () => activeLeaseFiles(fixture.stateRoot).length === 2,
    { message: "Second wrapper never acquired its lease." },
  );
  assert.deepEqual(activeLeaseActors(fixture.stateRoot), ["agent-one", "agent-two"]);

  fs.writeFileSync(firstDone, "done\n");
  const firstResult = await waitForChildExit(firstRun);
  assert.equal(firstResult.code, 0, firstResult.stderr);

  await waitFor(
    () => activeLeaseFiles(fixture.stateRoot).length === 1,
    { message: "First wrapper did not release exactly one lease." },
  );
  assert.deepEqual(activeLeaseActors(fixture.stateRoot), ["agent-two"]);

  fs.writeFileSync(secondDone, "done\n");
  const secondResult = await waitForChildExit(secondRun);
  assert.equal(secondResult.code, 0, secondResult.stderr);

  await waitFor(
    () => activeLeaseFiles(fixture.stateRoot).length === 0,
    { message: "Second wrapper did not release its lease." },
  );
});

test("shared lease wrapper fails the success path when the first release attempt fails", () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "release-retry-run");
  const proxyCli = path.join(fixture.root, "simbroker-release-proxy.sh");
  const releaseCountFile = path.join(fixture.root, "release-count.txt");

  writeExecutable(proxyCli, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "lease" && "\${2:-}" == "release" ]]; then
  count="0"
  if [[ -f "${releaseCountFile}" ]]; then
    count="$(cat "${releaseCountFile}")"
  fi
  if [[ "$count" == "0" ]]; then
    printf '1' > "${releaseCountFile}"
    exit 1
  fi
fi
exec "${CLI_PATH}" "$@"
`);

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-release-retry",
      "--run-dir", runDir,
      "--",
      "bash", "-lc", "exit 0",
    ],
    {
      SIMBROKER_BIN: proxyCli,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.notEqual(result.status, 0);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
});

test("shared lease wrapper contains detached simulator-like processes after downstream failure", async () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "detached-failure-run");
  const pidFile = path.join(runDir, "detached.pid");

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-detached-failure",
      "--run-dir", runDir,
      "--",
      process.execPath,
      "-e",
      `
        const { spawn } = require("node:child_process");
        const fs = require("node:fs");
        const child = spawn(process.execPath, [
          "-e",
          "setInterval(() => {}, 1000)",
          process.env.SIMBROKER_SIMULATOR_ID,
          "BrokerFixtureTestHost"
        ], { detached: true, stdio: "ignore" });
        child.unref();
        fs.mkdirSync(require("node:path").dirname(process.argv[1]), { recursive: true });
        fs.writeFileSync(process.argv[1], String(child.pid));
        process.exit(7);
      `,
      pidFile,
    ],
    {
      BROKER_SIMULATOR_PROCESS_NAMES: "BrokerFixtureTestHost",
      SIMBROKER_BIN: CLI_PATH,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.equal(result.status, 7, result.stderr);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
  const detachedPid = Number(fs.readFileSync(pidFile, "utf8"));
  for (let attempt = 0; attempt < 20 && processExists(detachedPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(processExists(detachedPid), false);
  const evidenceRoot = path.join(runDir, "simulator-broker-evidence");
  assert.ok(fs.existsSync(evidenceRoot));
  const evidenceDirs = fs.readdirSync(evidenceRoot);
  assert.equal(evidenceDirs.length, 1);
  const summary = JSON.parse(fs.readFileSync(path.join(evidenceRoot, evidenceDirs[0], "summary.json"), "utf8"));
  assert.equal(summary.reason, "forced-abort");
  assert.ok(summary.killedPids.includes(detachedPid));
});

test("shared lease wrapper contains the child before releasing when registration fails", async () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "cleanup-run");
  const leaseFile = path.join(runDir, "simulator-lease.json");
  const pidFile = path.join(runDir, "child.pid");
  const evidenceRoot = path.join(runDir, "simulator-broker-evidence");
  const proxyCli = path.join(fixture.root, "simbroker-proxy.sh");

  writeExecutable(proxyCli, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "lease" && "\${2:-}" == "register-process" ]]; then
  exit 1
fi
exec "${CLI_PATH}" "$@"
`);

  const wrapper = spawn("bash", [
    path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
    "--purpose", "agent-build-test",
    "--actor-type", "agent",
    "--actor-id", "agent-cleanup-failure",
    "--run-dir", runDir,
    "--",
    process.execPath,
    "-e",
    `
      const fs = require("node:fs");
      fs.mkdirSync(require("node:path").dirname(process.argv[1]), { recursive: true });
      fs.writeFileSync(process.argv[1], String(process.pid));
      setInterval(() => {}, 1000);
    `,
    pidFile,
  ], {
    cwd: SAMPLE_REPO,
    env: {
      ...process.env,
      ...fixture.simctl.env,
      SIMBROKER_BIN: proxyCli,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve, reject) => {
    wrapper.on("error", reject);
    wrapper.on("exit", (code) => {
      if (code === 0) {
        reject(new Error("wrapper unexpectedly succeeded"));
        return;
      }
      resolve();
    });
  });

  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  for (let attempt = 0; attempt < 20 && processExists(childPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(processExists(childPid), false);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
  assert.equal(fs.existsSync(leaseFile), false);
  assert.ok(fs.existsSync(evidenceRoot));
  const evidenceDirs = fs.readdirSync(evidenceRoot);
  assert.equal(evidenceDirs.length, 1);
  const summary = JSON.parse(fs.readFileSync(path.join(evidenceRoot, evidenceDirs[0], "summary.json"), "utf8"));
  assert.equal(summary.reason, "forced-abort");
  assert.ok(summary.killedPids.includes(childPid));
});

test("shared lease wrapper carries simulator process names into pre-registration cleanup", async () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "custom-host-cleanup-run");
  const pidFile = path.join(runDir, "detached.pid");
  const evidenceRoot = path.join(runDir, "simulator-broker-evidence");
  const proxyCli = path.join(fixture.root, "simbroker-register-fail.sh");

  writeExecutable(proxyCli, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "lease" && "\${2:-}" == "register-process" ]]; then
  exit 1
fi
exec "${CLI_PATH}" "$@"
`);

  const wrapper = spawn("bash", [
    path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
    "--purpose", "agent-build-test",
    "--actor-type", "agent",
    "--actor-id", "agent-custom-host",
    "--run-dir", runDir,
    "--",
    process.execPath,
    "-e",
    `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, [
        "-e",
        "setInterval(() => {}, 1000)",
        process.env.SIMBROKER_SIMULATOR_ID,
        "CustomDetachedHost"
      ], { detached: true, stdio: "ignore" });
      child.unref();
      fs.mkdirSync(require("node:path").dirname(process.argv[1]), { recursive: true });
      fs.writeFileSync(process.argv[1], String(child.pid));
      process.exit(0);
    `,
    pidFile,
  ], {
    cwd: SAMPLE_REPO,
    env: {
      ...process.env,
      ...fixture.simctl.env,
      BROKER_SIMULATOR_PROCESS_NAMES: "CustomDetachedHost",
      SIMBROKER_BIN: proxyCli,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve, reject) => {
    wrapper.on("error", reject);
    wrapper.on("exit", (code) => {
      if (code === 0) {
        reject(new Error("wrapper unexpectedly succeeded"));
        return;
      }
      resolve();
    });
  });

  const detachedPid = Number(fs.readFileSync(pidFile, "utf8"));
  for (let attempt = 0; attempt < 20 && processExists(detachedPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(processExists(detachedPid), false);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
  const evidenceDirs = fs.readdirSync(evidenceRoot);
  assert.equal(evidenceDirs.length, 1);
  const summary = JSON.parse(fs.readFileSync(path.join(evidenceRoot, evidenceDirs[0], "summary.json"), "utf8"));
  assert.equal(summary.reason, "forced-abort");
  assert.ok(summary.killedPids.includes(detachedPid));
});

test("shared lease wrapper keeps the lease when abort containment fails", () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "failed-containment-run");
  const leaseFile = path.join(runDir, "simulator-lease.json");
  const proxyCli = path.join(fixture.root, "simbroker-containment-fail.sh");

  writeExecutable(proxyCli, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "lease" && "\${2:-}" == "register-process" ]]; then
  exit 1
fi
if [[ "\${1:-}" == "lease" && "\${2:-}" == "contain" ]]; then
  exit 1
fi
exec "${CLI_PATH}" "$@"
`);

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-failed-containment",
      "--run-dir", runDir,
      "--",
      "bash", "-lc", "exit 0",
    ],
    {
      SIMBROKER_BIN: proxyCli,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.notEqual(result.status, 0);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 1);
  assert.equal(fs.existsSync(leaseFile), true);
});

test("shared lease wrapper checks for detached hosts before success release when memory monitoring is enabled", async () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "successful-detached-memory-run");
  const pidFile = path.join(runDir, "detached.pid");
  const evidenceRoot = path.join(runDir, "simulator-broker-evidence");

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-success-detached-host",
      "--run-dir", runDir,
      "--",
      process.execPath,
      "-e",
      `
        const { spawn } = require("node:child_process");
        const fs = require("node:fs");
        const child = spawn(process.execPath, [
          "-e",
          "setInterval(() => {}, 1000)",
          process.env.SIMBROKER_SIMULATOR_ID,
          "SuccessDetachedHost"
        ], { detached: true, stdio: "ignore" });
        child.unref();
        fs.mkdirSync(require("node:path").dirname(process.argv[1]), { recursive: true });
        fs.writeFileSync(process.argv[1], String(child.pid));
        process.exit(0);
      `,
      pidFile,
    ],
    {
      BROKER_MEMORY_CEILING_BYTES: String(512 * 1024 * 1024),
      BROKER_MONITOR_INTERVAL_MS: "100",
      BROKER_SIMULATOR_PROCESS_NAMES: "SuccessDetachedHost",
      SIMBROKER_BIN: CLI_PATH,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
  const detachedPid = Number(fs.readFileSync(pidFile, "utf8"));
  for (let attempt = 0; attempt < 20 && processExists(detachedPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(processExists(detachedPid), false);
  const evidenceDirs = fs.readdirSync(evidenceRoot);
  assert.equal(evidenceDirs.length, 1);
  const summary = JSON.parse(fs.readFileSync(path.join(evidenceRoot, evidenceDirs[0], "summary.json"), "utf8"));
  assert.equal(summary.reason, "manual-cleanup");
  assert.ok(summary.killedPids.includes(detachedPid));
});

test("shared lease wrapper releases normally after a clean memory-monitored success", () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "clean-memory-success-run");
  const evidenceRoot = path.join(runDir, "simulator-broker-evidence");

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-clean-memory-success",
      "--run-dir", runDir,
      "--",
      "bash", "-lc", "exit 0",
    ],
    {
      BROKER_MEMORY_CEILING_BYTES: String(512 * 1024 * 1024),
      BROKER_MONITOR_INTERVAL_MS: "100",
      SIMBROKER_BIN: CLI_PATH,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
  assert.equal(fs.existsSync(evidenceRoot), false);
});

test("shared lease wrapper stops the memory monitor after the child exits cleanly", () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "post-exit-memory-success-run");
  const exitedFlag = path.join(runDir, "child-exited.flag");
  const postExitPollCountFile = path.join(runDir, "post-exit-monitor-count.txt");
  const proxyCli = path.join(fixture.root, "simbroker-post-exit-memory-success.sh");

  writeExecutable(proxyCli, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "lease" && "\${2:-}" == "contain" && " $* " == *" --reason memory-ceiling "* && -f "${exitedFlag}" ]]; then
  count="0"
  if [[ -f "${postExitPollCountFile}" ]]; then
    count="$(cat "${postExitPollCountFile}")"
  fi
  count="$((count + 1))"
  printf '%s' "$count" > "${postExitPollCountFile}"
  if [[ "$count" -gt 1 ]]; then
    printf '{"ok":false,"error":"Broker service is unavailable.","reasonCode":"service-unavailable","exitCode":3}\n'
    exit 3
  fi
fi
exec "${CLI_PATH}" "$@"
`);

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-post-exit-memory-success",
      "--run-dir", runDir,
      "--",
      "bash", "-lc", "sleep 0.05; mkdir -p \"$(dirname \"$1\")\"; : > \"$1\"; exit 0", "_", exitedFlag,
    ],
    {
      BROKER_MEMORY_CEILING_BYTES: String(512 * 1024 * 1024),
      BROKER_MONITOR_INTERVAL_MS: "100",
      SIMBROKER_BIN: proxyCli,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
  const postExitPollCount = fs.existsSync(postExitPollCountFile)
    ? Number(fs.readFileSync(postExitPollCountFile, "utf8"))
    : 0;
  assert.ok(postExitPollCount <= 1);
});

test("shared lease wrapper releases normally when register-process loses a fast-command race", () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "post-exit-register-race-run");
  const evidenceRoot = path.join(runDir, "simulator-broker-evidence");
  const proxyCli = path.join(fixture.root, "simbroker-post-exit-register-race.sh");

  writeExecutable(proxyCli, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "lease" && "\${2:-}" == "register-process" ]]; then
  register_pid=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --pid)
        register_pid="\${2:-}"
        shift 2
        ;;
      *)
        shift
        ;;
    esac
  done
  if [[ -n "$register_pid" ]]; then
    for _ in $(seq 1 100); do
      register_stat="$(ps -o stat= -p "$register_pid" 2>/dev/null | tr -d '[:space:]')"
      if [[ -z "$register_stat" || "$register_stat" == Z* ]]; then
        break
      fi
      sleep 0.01
    done
  fi
  printf '{"ok":false,"error":"Flag --pgid requires a live process for --pid 123.","reasonCode":"invalid-flag","exitCode":2}\n'
  exit 2
fi
exec "${CLI_PATH}" "$@"
`);

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-post-exit-register-race",
      "--run-dir", runDir,
      "--",
      "bash", "-lc", "sleep 0.05; exit 0",
    ],
    {
      SIMBROKER_BIN: proxyCli,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
  assert.equal(fs.existsSync(evidenceRoot), false);
});

test("shared lease wrapper keeps the lease when final memory observation fails", () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "final-memory-observation-fail-run");
  const leaseFile = path.join(runDir, "simulator-lease.json");
  const doneFlag = path.join(runDir, "command-finished.flag");
  const proxyCli = path.join(fixture.root, "simbroker-final-memory-observation-fail.sh");

  writeExecutable(proxyCli, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "lease" && "\${2:-}" == "contain" && " $* " == *" --reason memory-ceiling "* && -f "\${FINAL_MEMORY_OBSERVATION_FAIL_FLAG:-}" ]]; then
  printf '{"ok":false,"error":"Broker service is unavailable.","reasonCode":"service-unavailable","exitCode":3}\n'
  exit 3
fi
exec "${CLI_PATH}" "$@"
`);

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-final-memory-observation-failure",
      "--run-dir", runDir,
      "--",
      "bash", "-lc", `mkdir -p "$(dirname "$1")"; touch "$1"; exit 0`, "_", doneFlag,
    ],
    {
      BROKER_MEMORY_CEILING_BYTES: String(512 * 1024 * 1024),
      BROKER_MONITOR_INTERVAL_MS: "100",
      FINAL_MEMORY_OBSERVATION_FAIL_FLAG: doneFlag,
      SIMBROKER_BIN: proxyCli,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.equal(result.status, 3);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 1);
  assert.equal(fs.existsSync(leaseFile), true);
});

test("shared lease wrapper keeps the lease when a monitor failure happens after the command already exited", () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "post-exit-monitor-fail-run");
  const leaseFile = path.join(runDir, "simulator-lease.json");
  const exitedFlag = path.join(runDir, "child-exited.flag");
  const proxyCli = path.join(fixture.root, "simbroker-post-exit-monitor-fail.sh");

  writeExecutable(proxyCli, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "lease" && "\${2:-}" == "contain" && " $* " == *" --reason memory-ceiling "* ]]; then
  if [[ -f "${exitedFlag}" ]]; then
  printf '{"ok":false,"error":"Broker service is unavailable.","reasonCode":"service-unavailable","exitCode":3}\n'
  exit 3
  fi
fi
exec "${CLI_PATH}" "$@"
`);

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-post-exit-monitor-failure",
      "--run-dir", runDir,
      "--",
      "bash", "-lc", "sleep 0.05; mkdir -p \"$(dirname \"$0\")\"; : > \"$0\"; exit 0", exitedFlag,
    ],
    {
      BROKER_MEMORY_CEILING_BYTES: String(512 * 1024 * 1024),
      BROKER_MONITOR_INTERVAL_MS: "100",
      SIMBROKER_BIN: proxyCli,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.equal(result.status, 3);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 1);
  assert.equal(fs.existsSync(leaseFile), true);
});

test("shared lease wrapper aborts into cleanup when memory containment fails", async () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "memory-containment-fail-run");
  const pidFile = path.join(runDir, "child.pid");
  const proxyCli = path.join(fixture.root, "simbroker-memory-containment-fail.sh");

  writeExecutable(proxyCli, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "lease" && "\${2:-}" == "contain" && " $* " == *" --reason memory-ceiling "* ]]; then
  printf '{"ok":false,"error":"Broker service is unavailable.","reasonCode":"service-unavailable","exitCode":3}\n'
  exit 3
fi
exec "${CLI_PATH}" "$@"
`);

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-memory-containment-failure",
      "--run-dir", runDir,
      "--",
      process.execPath,
      "-e",
      `
        const fs = require("node:fs");
        fs.mkdirSync(require("node:path").dirname(process.argv[1]), { recursive: true });
        fs.writeFileSync(process.argv[1], String(process.pid));
        setInterval(() => {}, 1000);
      `,
      pidFile,
    ],
    {
      BROKER_MEMORY_CEILING_BYTES: "1",
      BROKER_MONITOR_INTERVAL_MS: "100",
      SIMBROKER_BIN: proxyCli,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.notEqual(result.status, 0);
  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  for (let attempt = 0; attempt < 20 && processExists(childPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(processExists(childPid), false);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
});

test("shared lease wrapper removes the stable alias after monitor containment succeeds", () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "memory-containment-success-run");
  const leaseAliasFile = path.join(runDir, "simulator-lease.json");
  const proxyCli = path.join(fixture.root, "simbroker-memory-containment-success.sh");

  writeExecutable(proxyCli, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "lease" && "\${2:-}" == "contain" && " $* " == *" --reason memory-ceiling "* ]]; then
  lease_file=""
  while [[ "$#" -gt 0 ]]; do
    if [[ "\${1:-}" == "--lease-file" ]]; then
      lease_file="\${2:-}"
      shift 2
      continue
    fi
    shift
  done
  lease_id="$(node -e 'const fs=require("fs"); const lease=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(lease.leaseId)' "$lease_file")"
  rm -f "$lease_file" "$SIMBROKER_STATE_ROOT/leases/$lease_id.json"
  printf '{"ok":true,"contained":true,"reason":"memory-ceiling"}\n'
  exit 0
fi
exec "${CLI_PATH}" "$@"
`);

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-memory-contained",
      "--run-dir", runDir,
      "--",
      "bash", "-lc", "sleep 0.3",
    ],
    {
      BROKER_MEMORY_CEILING_BYTES: "1",
      BROKER_MONITOR_INTERVAL_MS: "100",
      SIMBROKER_BIN: proxyCli,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.equal(result.status, 3, result.stderr);
  assert.throws(() => fs.lstatSync(leaseAliasFile), (error) => error.code === "ENOENT");
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
});

test("shared lease wrapper removes the stable alias after final containment succeeds", () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "final-memory-containment-success-run");
  const leaseAliasFile = path.join(runDir, "simulator-lease.json");
  const proxyCli = path.join(fixture.root, "simbroker-final-memory-containment-success.sh");

  writeExecutable(proxyCli, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "lease" && "\${2:-}" == "contain" && " $* " == *" --reason memory-ceiling "* ]]; then
  lease_file=""
  while [[ "$#" -gt 0 ]]; do
    if [[ "\${1:-}" == "--lease-file" ]]; then
      lease_file="\${2:-}"
      shift 2
      continue
    fi
    shift
  done
  lease_id="$(node -e 'const fs=require("fs"); const lease=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(lease.leaseId)' "$lease_file")"
  rm -f "$lease_file" "$SIMBROKER_STATE_ROOT/leases/$lease_id.json"
  printf '{"ok":true,"contained":true,"reason":"memory-ceiling"}\n'
  exit 0
fi
exec "${CLI_PATH}" "$@"
`);

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-final-memory-contained",
      "--run-dir", runDir,
      "--",
      "bash", "-lc", "exit 0",
    ],
    {
      BROKER_MEMORY_CEILING_BYTES: String(512 * 1024 * 1024),
      BROKER_MONITOR_INTERVAL_MS: "100",
      SIMBROKER_BIN: proxyCli,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.equal(result.status, 3, result.stderr);
  assert.throws(() => fs.lstatSync(leaseAliasFile), (error) => error.code === "ENOENT");
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
});

test("shared lease wrapper checks detached hosts on successful non-memory runs when simulator names are configured", async () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "successful-detached-non-memory-run");
  const pidFile = path.join(runDir, "detached.pid");
  const evidenceRoot = path.join(runDir, "simulator-broker-evidence");

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-success-detached-non-memory-host",
      "--run-dir", runDir,
      "--",
      process.execPath,
      "-e",
      `
        const { spawn } = require("node:child_process");
        const fs = require("node:fs");
        const child = spawn(process.execPath, [
          "-e",
          "setInterval(() => {}, 1000)",
          process.env.SIMBROKER_SIMULATOR_ID,
          "SuccessDetachedHost"
        ], { detached: true, stdio: "ignore" });
        child.unref();
        fs.mkdirSync(require("node:path").dirname(process.argv[1]), { recursive: true });
        fs.writeFileSync(process.argv[1], String(child.pid));
        process.exit(0);
      `,
      pidFile,
    ],
    {
      BROKER_SIMULATOR_PROCESS_NAMES: "SuccessDetachedHost",
      SIMBROKER_BIN: CLI_PATH,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
  const detachedPid = Number(fs.readFileSync(pidFile, "utf8"));
  for (let attempt = 0; attempt < 20 && processExists(detachedPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(processExists(detachedPid), false);
  const evidenceDirs = fs.readdirSync(evidenceRoot);
  assert.equal(evidenceDirs.length, 1);
  const summary = JSON.parse(fs.readFileSync(path.join(evidenceRoot, evidenceDirs[0], "summary.json"), "utf8"));
  assert.equal(summary.reason, "manual-cleanup");
  assert.ok(summary.killedPids.includes(detachedPid));
});

test("shared lease wrapper runs manual cleanup when the final observation reports a downstream-only helper", () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "successful-downstream-helper-observation-run");
  const manualCleanupFlag = path.join(runDir, "manual-cleanup-called.flag");
  const proxyCli = path.join(fixture.root, "simbroker-success-downstream-helper.sh");

  writeExecutable(proxyCli, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "lease" && "\${2:-}" == "contain" && " $* " == *" --reason memory-ceiling "* ]]; then
  printf '{"ok":true,"contained":false,"reason":"memory-ceiling","observation":{"downstreamOwnedProcessCount":1,"ownedProcessCount":2,"simulatorProcessCount":0}}\n'
  exit 0
fi
if [[ "\${1:-}" == "lease" && "\${2:-}" == "contain" && " $* " == *" --reason manual-cleanup "* ]]; then
  mkdir -p "$(dirname '${manualCleanupFlag}')"
  : > '${manualCleanupFlag}'
  exit 0
fi
exec "${CLI_PATH}" "$@"
`);

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-success-downstream-helper",
      "--run-dir", runDir,
      "--",
      "bash", "-lc", "exit 0",
    ],
    {
      SIMBROKER_BIN: proxyCli,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(manualCleanupFlag), true);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
});

test("shared lease wrapper checks detached hosts on successful non-memory runs with default simulator names", async () => {
  const fixture = makeHostFixture();
  const runDir = path.join(fixture.root, "successful-detached-default-name-run");
  const pidFile = path.join(runDir, "detached.pid");
  const evidenceRoot = path.join(runDir, "simulator-broker-evidence");

  const result = runCommand(
    "bash",
    [
      path.join(SAMPLE_REPO, "scripts/with-broker-lease.sh"),
      "--purpose", "agent-build-test",
      "--actor-type", "agent",
      "--actor-id", "agent-success-detached-default-host",
      "--run-dir", runDir,
      "--",
      process.execPath,
      "-e",
      `
        const { spawn } = require("node:child_process");
        const fs = require("node:fs");
        const child = spawn(process.execPath, [
          "-e",
          "setInterval(() => {}, 1000)",
          process.env.SIMBROKER_SIMULATOR_ID,
          "XCTRunner"
        ], { detached: true, stdio: "ignore" });
        child.unref();
        fs.mkdirSync(require("node:path").dirname(process.argv[1]), { recursive: true });
        fs.writeFileSync(process.argv[1], String(child.pid));
        process.exit(0);
      `,
      pidFile,
    ],
    {
      SIMBROKER_BIN: CLI_PATH,
      SIMBROKER_HOST_CONFIG: fixture.hostConfigPath,
      SIMBROKER_STATE_ROOT: fixture.stateRoot,
      ...fixture.simctl.env,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(activeLeaseFiles(fixture.stateRoot).length, 0);
  const detachedPid = Number(fs.readFileSync(pidFile, "utf8"));
  for (let attempt = 0; attempt < 20 && processExists(detachedPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(processExists(detachedPid), false);
  const evidenceDirs = fs.readdirSync(evidenceRoot);
  assert.equal(evidenceDirs.length, 1);
  const summary = JSON.parse(fs.readFileSync(path.join(evidenceRoot, evidenceDirs[0], "summary.json"), "utf8"));
  assert.equal(summary.reason, "manual-cleanup");
  assert.ok(summary.killedPids.includes(detachedPid));
});

test("sample repo project file validates against the current broker contract", () => {
  const fixture = makeHostFixture();
  const result = runCommand(CLI_PATH, [
    "--host-config", fixture.hostConfigPath,
    "--state-root", fixture.stateRoot,
    "project",
    "validate",
    "--repo-root", SAMPLE_REPO,
  ], fixture.simctl.env);

  assert.equal(result.status, 0, result.stdout || result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.projectConfig.projectId, "sample-consumer-repo");
});
