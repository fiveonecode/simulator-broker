import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";

import { createCommandRequest, executeBrokerCommand, format, parseArgs, streamEventsLocal } from "../command-dispatch.mjs";
import {
  executeServiceCommand,
  probeService,
  serviceCommandExecutionTimeoutMs,
  serviceCommandTimeoutMs,
  serviceStopTimeoutMs,
  serviceStartupTimeoutMs,
  streamServiceEvents,
} from "../service/service-client.mjs";
import {
  DEFAULT_CONTAINMENT_POST_KILL_WAIT_MS,
  DEFAULT_CONTAINMENT_TERM_WAIT_MS,
  PROCESS_SAMPLER_TIMEOUT_MS,
  STALE_CONTAINMENT_PROCESS_SAMPLER_INVOCATIONS,
} from "../../broker-core/containment.mjs";
import { HOST_BOOTSTRAP_DEVICE_WARNING, readEventsBroker, resolveBrokerPaths } from "../../broker-core/index.mjs";
import { SIMCTL_COMMAND_TIMEOUT_MS } from "../../broker-core/simctl.mjs";
import { createDeviceRecord, createSimctlFixture } from "../../broker-core/test/support/simctl-fixture.mjs";

const CLI_PATH = path.resolve("client/bin/simbroker.mjs");
const CLI_TEST_TIMEOUT_MS = 60_000;

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-cli-test-"));
}

function makeFifo(filePath) {
  const result = spawnSync("mkfifo", [filePath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeFixture() {
  const root = makeTempDir();
  const hostConfigPath = path.join(root, "host-config.json");
  const stateRoot = path.join(root, "state");
  const repoRoot = path.join(root, "repo");
  const projectFilePath = path.join(repoRoot, ".simulator-broker/project.json");
  const simctl = createSimctlFixture(root, {
    devices: [
      createDeviceRecord({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        name: "UI One",
        udid: "SIM-UI-1",
      }),
      createDeviceRecord({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-A16",
        name: "iPad One",
        udid: "SIM-IPAD-1",
      }),
    ],
  });

  writeJson(hostConfigPath, {
    version: 1,
    hostId: "cli-host",
    aliases: [
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
        alias: "ipad-1",
        capabilities: ["interactive-resettable"],
        deviceFamily: "iPad",
        displayName: "iPad One",
        iosVersion: "18.2",
        resetPolicy: "erase-on-acquire",
        simulatorId: "SIM-IPAD-1",
      },
    ],
  });

  writeJson(projectFilePath, {
    version: 1,
    projectId: "cli-demo",
    projectName: "CLI Demo",
    purposes: [
      {
        id: "agent-ui-session",
        displayName: "Agent UI Session",
        capability: "interactive-resettable",
        defaultActorType: "agent",
        requires: {
          deviceFamily: "iPhone",
          iosVersion: "18",
        },
      },
    ],
  });

  return {
    hostConfigPath,
    projectFilePath,
    repoRoot,
    root,
    simctl,
    stateRoot,
  };
}

function makeCapacityFixture() {
  const root = makeTempDir();
  const hostConfigPath = path.join(root, "host-config.json");
  const stateRoot = path.join(root, "state");
  const repoRoot = path.join(root, "repo");
  const projectFilePath = path.join(repoRoot, ".simulator-broker/project.json");
  const simctl = createSimctlFixture(root, {
    devices: [
      createDeviceRecord({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        name: "UI One",
        udid: "SIM-UI-1",
      }),
    ],
  });

  writeJson(hostConfigPath, {
    version: 1,
    hostId: "capacity-cli-host",
    aliases: [
      {
        alias: "ui-1",
        capabilities: ["interactive-resettable"],
        deviceFamily: "iPhone",
        displayName: "UI One",
        iosVersion: "18.2",
        resetPolicy: "erase-on-acquire",
        simulatorId: "SIM-UI-1",
      },
    ],
  });

  writeJson(projectFilePath, {
    version: 1,
    projectId: "capacity-cli-demo",
    projectName: "Capacity CLI Demo",
    purposes: [
      {
        id: "agent-ipad-session",
        displayName: "Agent iPad Session",
        capability: "interactive-resettable",
        defaultActorType: "agent",
        requires: {
          deviceFamily: "iPad",
          iosVersion: "18",
        },
      },
    ],
  });

  return {
    hostConfigPath,
    projectFilePath,
    repoRoot,
    root,
    simctl,
    stateRoot,
  };
}

function spawnCli(fixture, ...args) {
  return spawnSync(process.execPath, [
    CLI_PATH,
    "--host-config", fixture.hostConfigPath,
    "--state-root", fixture.stateRoot,
    ...args,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...fixture.simctl?.env,
    },
    killSignal: "SIGKILL",
    timeout: CLI_TEST_TIMEOUT_MS,
  });
}

function runCli(fixture, ...args) {
  const result = spawnCli(fixture, ...args);

  return {
    ...result,
    json: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

function spawnKeepaliveProcess() {
  // Keep the ChildProcess handle referenced. unref() lets Node 20 fire
  // beforeExit during `await exit`, which cancels later describe() tests.
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
}

function waitForProcessExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", resolve);
  });
}

async function stopKeepaliveProcess(child, signal = "SIGKILL") {
  if (!child?.pid) {
    return;
  }
  const exited = waitForProcessExit(child);
  try {
    process.kill(child.pid, signal);
  } catch {
    child.unref();
    return;
  }
  await exited;
}

function runCliAsync(fixture, envOverrides, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      CLI_PATH,
      "--host-config", fixture.hostConfigPath,
      "--state-root", fixture.stateRoot,
      ...args,
    ], {
      env: {
        ...process.env,
        ...fixture.simctl?.env,
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, CLI_TEST_TIMEOUT_MS);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        json: stdout ? JSON.parse(stdout) : null,
        signal,
        status,
        stderr,
        stdout,
      });
    });
  });
}

function spawnCliControllable(fixture, envOverrides, ...args) {
  const child = spawn(process.execPath, [
    CLI_PATH,
    "--host-config", fixture.hostConfigPath,
    "--state-root", fixture.stateRoot,
    ...args,
  ], {
    env: {
      ...process.env,
      ...fixture.simctl?.env,
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve({
        json: stdout ? JSON.parse(stdout) : null,
        signal,
        status,
        stderr,
        stdout,
      });
    });
  });
  return { child, result };
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for test condition.");
}

function holdServiceStartLock(fixture) {
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    stateRoot: fixture.stateRoot,
  });
  fs.mkdirSync(paths.serviceLockDir, { recursive: true });
  writeJson(paths.serviceLockOwnerPath, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: "test-held-service-start-lock",
  });
  return paths;
}

function runCliAsyncWithTimeout(fixture, envOverrides, timeoutMs, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      CLI_PATH,
      "--host-config", fixture.hostConfigPath,
      "--state-root", fixture.stateRoot,
      ...args,
    ], {
      env: {
        ...process.env,
        ...fixture.simctl?.env,
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timeout.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      let json = null;
      if (stdout && timedOut === false) {
        try {
          json = JSON.parse(stdout);
        } catch {
          json = null;
        }
      }
      resolve({
        json,
        signal,
        status,
        stderr,
        stdout,
        timedOut,
      });
    });
  });
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

describe("simbroker", { concurrency: 1 }, () => {
test("host init can bootstrap a starter host config on a fresh machine path", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };

  const result = runCli(fixture, "host", "init", "--bootstrap-config", "--host-id", "fresh-machine");
  assert.equal(result.status, 0);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.hostConfigCreated, true);
  const hostConfig = JSON.parse(fs.readFileSync(fixture.hostConfigPath, "utf8"));
  assert.equal(hostConfig.hostId, "fresh-machine");
  assert.equal(hostConfig.aliases.length, 6);
  assert.ok(hostConfig.aliases.some((alias) => alias.alias === "ui-2"));
  assert.ok(hostConfig.aliases.some((alias) => alias.alias === "build-2"));
  assert.ok(hostConfig.aliases.every((alias) => /^[0-9A-F-]{36}$/.test(alias.simulatorId)));
  assert.match(result.stderr, /creates real iOS Simulator devices/);
  assert.equal(result.json.bootstrapWarning, HOST_BOOTSTRAP_DEVICE_WARNING);
});

test("host init --bootstrap-config reports runtime-not-found with --ios-version guidance", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root, {
      runtimes: [
        {
          identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
          isAvailable: true,
          supportedDeviceTypes: [
            {
              identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
              name: "iPhone 16",
              productFamily: "iPhone",
            },
            {
              identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-A16",
              name: "iPad (A16)",
              productFamily: "iPad",
            },
          ],
          version: "26.0",
        },
      ],
    }),
    stateRoot: path.join(root, "state"),
  };

  const result = runCli(fixture, "host", "init", "--bootstrap-config", "--host-id", "cli-missing-runtime");
  assert.notEqual(result.status, 0);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.reasonCode, "runtime-not-found");
  assert.match(result.json.error, /--ios-version/);
  assert.match(result.json.error, /xcrun simctl list runtimes/);
});

test("host init --bootstrap-config warns on stdout-adjacent stderr before devices exist", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };

  assert.equal(fs.existsSync(fixture.hostConfigPath), false);
  const result = runCli(fixture, "host", "init", "--bootstrap-config", "--host-id", "warn-before-create");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Warning: host init --bootstrap-config creates real iOS Simulator devices/);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.hostConfigCreated, true);
  assert.equal(result.json.bootstrapWarning, HOST_BOOTSTRAP_DEVICE_WARNING);
  assert.match(result.stdout, /creates real iOS Simulator devices/);
});

test("host init can bootstrap a starter host config without an explicit host id", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };

  const result = runCli(fixture, "host", "init", "--bootstrap-config");
  assert.equal(result.status, 0);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.hostConfigCreated, true);
  assert.equal(typeof result.json.hostId, "string");
  assert.notEqual(result.json.hostId.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(fixture.hostConfigPath, "utf8")).hostId, result.json.hostId);
});

test("host init honors explicit false for bootstrap-config on a fresh machine path", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };

  const result = runCli(fixture, "host", "init", "--bootstrap-config=false");

  assert.equal(result.status, 2);
  assert.equal(result.json.reasonCode, "missing-host-config");
  assert.equal(fs.existsSync(fixture.hostConfigPath), false);
});

test("host init honors explicit false for force during bootstrap", () => {
  const fixture = makeFixture();

  const result = runCli(fixture, "host", "init", "--bootstrap-config", "--force=false");

  assert.equal(result.status, 0);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.hostConfigCreated, false);
  assert.equal(result.json.bootstrapWarning, undefined);
  assert.doesNotMatch(result.stderr, /creates real iOS Simulator devices/);
  const hostConfig = JSON.parse(fs.readFileSync(fixture.hostConfigPath, "utf8"));
  assert.equal(hostConfig.aliases.length, 2);
  assert.equal(hostConfig.aliases.some((alias) => alias.alias === "build-2"), false);
});

test("host init rejects unknown flags before mutating host config", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };

  const result = runCli(fixture, "host", "init", "--bootstrap-config", "--ios-verison", "17");

  assert.equal(result.status, 2);
  assert.equal(result.json.reasonCode, "invalid-flag");
  assert.equal(fs.existsSync(fixture.hostConfigPath), false);
});

test("setup JSON preview and confirmed apply create six aliases, start brokerd, and rerun idempotently", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };

  const preview = runCli(fixture, "setup", "--json", "--host-id", "guided-cli");
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.json.mode, "preview");
  assert.equal(preview.json.status, "changes_required");
  assert.equal(preview.json.devices.length, 6);
  assert.equal(preview.json.confirmation.createCount, 6);
  assert.equal(fs.existsSync(fixture.hostConfigPath), false);

  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "guided-cli",
    "--json",
  );
  assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
  assert.equal(applied.json.status, "ready");
  assert.deepEqual(applied.json.devices, { created: 6, reused: 0, total: 6 });
  assert.equal(applied.json.service.running, true);
  assert.equal(applied.json.service.identityVerified, true);
  assert.equal(applied.json.snapshot.ready, true);
  assert.equal(applied.json.health.ok, true);
  assert.equal(readJson(fixture.hostConfigPath).aliases.length, 6);

  const secondPreview = runCli(fixture, "setup", "--json");
  assert.equal(secondPreview.status, 0, secondPreview.stderr);
  assert.equal(secondPreview.json.status, "ready");
  assert.equal(secondPreview.json.confirmation.required, false);
  const secondApply = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    secondPreview.json.planId,
    "--json",
  );
  assert.equal(secondApply.status, 0, `${secondApply.stdout}\n${secondApply.stderr}`);
  assert.equal(secondApply.json.devices.created, 0);
  assert.equal(readJson(fixture.simctl.statePath).devices.length, 6);

  const stopped = runCli(fixture, "service", "stop");
  assert.equal(stopped.status, 0, stopped.stderr);
});

test("setup identity blockers provide a stop command for the running service paths", (t) => {
  const fixture = makeFixture();
  t.after(() => {
    runCli(fixture, "service", "stop");
  });

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);
  const otherHostConfigPath = path.join(fixture.root, "other-host-config.json");
  fs.copyFileSync(fixture.hostConfigPath, otherHostConfigPath);
  const mismatchedFixture = {
    ...fixture,
    hostConfigPath: otherHostConfigPath,
  };

  const preview = runCli(mismatchedFixture, "setup", "--json");
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.json.status, "blocked");
  const serviceIdentity = preview.json.prerequisites.find(({ id }) => id === "service-identity");
  assert.ok(serviceIdentity, JSON.stringify(preview.json, null, 2));
  const serviceSocketPath = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    stateRoot: fixture.stateRoot,
  }).serviceSocketPath;
  const selectedPaths = resolveBrokerPaths({
    hostConfigPath: otherHostConfigPath,
    stateRoot: fixture.stateRoot,
  });
  assert.deepEqual(serviceIdentity.remediationCommands, [
    `simbroker service stop --host-config '${fixture.hostConfigPath}' --state-root '${fixture.stateRoot}' --service-socket '${serviceSocketPath}'`,
    `simbroker setup --host-config '${otherHostConfigPath}' --state-root '${fixture.stateRoot}' --service-socket '${selectedPaths.serviceSocketPath}'`,
  ]);

  const stopped = spawnSync(process.execPath, [
    CLI_PATH,
    "service", "stop",
    "--host-config", fixture.hostConfigPath,
    "--state-root", fixture.stateRoot,
    "--service-socket", serviceSocketPath,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...fixture.simctl.env,
    },
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(runCli(fixture, "service", "status").json.running, false);
});

test("setup apply rechecks service identity before provisioning", (t) => {
  const occupant = makeFixture();
  const freshRoot = makeTempDir();
  const freshFixture = {
    hostConfigPath: path.join(freshRoot, "host-config.json"),
    simctl: occupant.simctl,
    stateRoot: path.join(freshRoot, "state"),
  };
  const freshSocketPath = resolveBrokerPaths({
    hostConfigPath: freshFixture.hostConfigPath,
    stateRoot: freshFixture.stateRoot,
  }).serviceSocketPath;
  t.after(() => {
    runCli(occupant, "--service-socket", freshSocketPath, "service", "stop");
  });

  assert.equal(runCli(occupant, "host", "init").status, 0);
  const preview = runCli(freshFixture, "setup", "--json", "--host-id", "apply-identity");
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.json.status, "changes_required");
  assert.equal(fs.existsSync(freshFixture.hostConfigPath), false);

  assert.equal(runCli(occupant, "--service-socket", freshSocketPath, "service", "start").status, 0);
  const applied = runCli(
    freshFixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "apply-identity",
    "--json",
  );
  assert.equal(applied.status, 3, applied.stderr);
  assert.equal(applied.json.reasonCode, "setup-prerequisite-failed");
  assert.equal(applied.json.failedStage, "preflight");
  assert.equal(applied.json.blockerReasonCode, "service-identity-mismatch");
  assert.equal(applied.json.hostCommitted, undefined);
  assert.equal(fs.existsSync(freshFixture.hostConfigPath), false);
});

test("setup blocks unconfigured hosts when the target socket already has a different broker", (t) => {
  const fixture = makeFixture();
  t.after(() => {
    runCli(fixture, "service", "stop");
  });

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);
  const serviceSocketPath = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    stateRoot: fixture.stateRoot,
  }).serviceSocketPath;
  const freshRoot = makeTempDir();
  const freshFixture = {
    hostConfigPath: path.join(freshRoot, "host-config.json"),
    simctl: fixture.simctl,
    stateRoot: path.join(freshRoot, "state"),
  };

  const preview = runCli(freshFixture, "--service-socket", serviceSocketPath, "setup", "--json");
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.json.status, "blocked");
  assert.equal(preview.json.confirmation.required, false);
  assert.ok(preview.json.prerequisites.some((issue) => issue.id === "service-identity" && issue.status === "blocked"));
  assert.equal(fs.existsSync(freshFixture.hostConfigPath), false);
});

test("setup blocks when brokerd.json is occupied and not a regular file", { timeout: 5_000 }, () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    stateRoot: fixture.stateRoot,
  });
  fs.mkdirSync(paths.stateRoot, { recursive: true });
  makeFifo(paths.serviceMetadataPath);

  const preview = runCli(fixture, "setup", "--json", "--host-id", "metadata-fifo");
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.json.status, "blocked");
  assert.equal(preview.json.confirmation.required, false);
  const serviceMetadata = preview.json.prerequisites.find(({ id }) => id === "service-metadata");
  assert.ok(serviceMetadata, JSON.stringify(preview.json, null, 2));
  assert.equal(serviceMetadata.status, "blocked");
  assert.deepEqual(serviceMetadata.remediationCommands, [
    `simbroker doctor --host-config '${fixture.hostConfigPath}' --state-root '${fixture.stateRoot}' --service-socket '${paths.serviceSocketPath}'`,
  ]);

  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "metadata-fifo",
    "--json",
  );
  assert.equal(applied.status, 3, applied.stderr);
  assert.equal(applied.json.reasonCode, "setup-prerequisite-failed");
  assert.equal(applied.json.failedStage, "preflight");
  assert.equal(applied.json.blockerReasonCode, "service-metadata");
  assert.equal(fs.existsSync(fixture.hostConfigPath), false);
  assert.equal(fs.lstatSync(paths.serviceMetadataPath).isFIFO(), true);
});

test("setup treats an occupied app-snapshot.json FIFO as finishing work", (t) => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  t.after(() => {
    runCli(fixture, "service", "stop");
  });
  const preview = runCli(fixture, "setup", "--json", "--host-id", "snapshot-fifo");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "snapshot-fifo",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.json.status, "ready");

  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    stateRoot: fixture.stateRoot,
  });
  fs.rmSync(paths.appSnapshotPath);
  makeFifo(paths.appSnapshotPath);

  const finishing = runCli(fixture, "setup", "--json");
  assert.equal(finishing.status, 0, finishing.stderr);
  assert.equal(finishing.json.status, "changes_required");
  assert.equal(finishing.json.service.action, "keep");
  assert.equal(finishing.json.confirmation.required, false);
  assert.equal(fs.lstatSync(paths.appSnapshotPath).isFIFO(), true);

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup blocks a brokerd.log FIFO before provisioning", { timeout: 5_000 }, () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "log-fifo");
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.json.status, "changes_required");
  assert.equal(fs.existsSync(fixture.hostConfigPath), false);

  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    stateRoot: fixture.stateRoot,
  });
  fs.mkdirSync(paths.stateRoot, { recursive: true });
  makeFifo(paths.serviceLogPath);

  const blocked = runCli(fixture, "setup", "--json", "--host-id", "log-fifo");
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.json.status, "blocked");
  assert.equal(blocked.json.confirmation.required, false);
  const serviceLog = blocked.json.prerequisites.find(({ id }) => id === "service-log");
  assert.ok(serviceLog, JSON.stringify(blocked.json, null, 2));
  assert.equal(serviceLog.status, "blocked");
  assert.deepEqual(serviceLog.remediationCommands, [
    `simbroker doctor --host-config '${fixture.hostConfigPath}' --state-root '${fixture.stateRoot}' --service-socket '${paths.serviceSocketPath}'`,
  ]);

  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "log-fifo",
    "--json",
  );
  assert.equal(applied.status, 3, applied.stderr);
  assert.equal(applied.json.reasonCode, "setup-prerequisite-failed");
  assert.equal(applied.json.failedStage, "preflight");
  assert.equal(applied.json.blockerReasonCode, "service-log");
  assert.equal(fs.existsSync(fixture.hostConfigPath), false);
  assert.equal(fs.lstatSync(paths.serviceLogPath).isFIFO(), true);
});

test("setup blocks a read-only brokerd.log before provisioning", { timeout: 5_000 }, () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    stateRoot: fixture.stateRoot,
  });
  fs.mkdirSync(paths.stateRoot, { recursive: true });
  fs.writeFileSync(paths.serviceLogPath, "");
  fs.chmodSync(paths.serviceLogPath, 0o444);

  const blocked = runCli(fixture, "setup", "--json", "--host-id", "log-readonly");
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.json.status, "blocked");
  assert.equal(blocked.json.confirmation.required, false);
  const serviceLog = blocked.json.prerequisites.find(({ id }) => id === "service-log");
  assert.ok(serviceLog, JSON.stringify(blocked.json, null, 2));
  assert.equal(serviceLog.status, "blocked");
  assert.deepEqual(serviceLog.remediationCommands, [
    `simbroker doctor --host-config '${fixture.hostConfigPath}' --state-root '${fixture.stateRoot}' --service-socket '${paths.serviceSocketPath}'`,
  ]);

  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    blocked.json.planId,
    "--host-id",
    "log-readonly",
    "--json",
  );
  assert.equal(applied.status, 3, applied.stderr);
  assert.equal(applied.json.reasonCode, "setup-prerequisite-failed");
  assert.equal(applied.json.failedStage, "preflight");
  assert.equal(applied.json.blockerReasonCode, "service-log");
  assert.equal(fs.existsSync(fixture.hostConfigPath), false);
  fs.chmodSync(paths.serviceLogPath, 0o644);
});

test("setup blocks a dangling service socket before provisioning", { timeout: 5_000 }, () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    stateRoot: fixture.stateRoot,
  });
  fs.symlinkSync(path.join(root, "missing.sock"), paths.serviceSocketPath);

  const blocked = runCli(fixture, "setup", "--json", "--host-id", "socket-dangling");
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.json.status, "blocked");
  assert.equal(blocked.json.confirmation.required, false);
  const serviceSocket = blocked.json.prerequisites.find(({ id }) => id === "service-socket");
  assert.ok(serviceSocket, JSON.stringify(blocked.json, null, 2));
  assert.equal(serviceSocket.status, "blocked");
  assert.deepEqual(serviceSocket.remediationCommands, [
    `simbroker doctor --host-config '${fixture.hostConfigPath}' --state-root '${fixture.stateRoot}' --service-socket '${paths.serviceSocketPath}'`,
  ]);

  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    blocked.json.planId,
    "--host-id",
    "socket-dangling",
    "--json",
  );
  assert.equal(applied.status, 3, applied.stderr);
  assert.equal(applied.json.reasonCode, "setup-prerequisite-failed");
  assert.equal(applied.json.failedStage, "preflight");
  assert.equal(applied.json.blockerReasonCode, "service-socket");
  assert.equal(fs.existsSync(fixture.hostConfigPath), false);
  assert.equal(fs.lstatSync(paths.serviceSocketPath).isSymbolicLink(), true);
});

test("setup blocks an unwritable service socket parent before provisioning", { timeout: 5_000 }, (t) => {
  const root = makeTempDir();
  const socketDir = path.join(root, "sockets");
  fs.mkdirSync(socketDir, { recursive: true });
  const serviceSocketPath = path.join(socketDir, "broker.sock");
  fs.chmodSync(socketDir, 0o500);
  t.after(() => {
    try {
      fs.chmodSync(socketDir, 0o755);
    } catch {
      // Restore enough access for temp cleanup.
    }
  });
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };

  const blocked = runCli(
    fixture,
    "--service-socket",
    serviceSocketPath,
    "setup",
    "--json",
    "--host-id",
    "socket-parent",
  );
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.json.status, "blocked");
  assert.equal(blocked.json.confirmation.required, false);
  const serviceSocket = blocked.json.prerequisites.find(({ id }) => id === "service-socket");
  assert.ok(serviceSocket, JSON.stringify(blocked.json, null, 2));
  assert.equal(serviceSocket.status, "blocked");
  assert.equal(serviceSocket.details.checkedPath, socketDir);
  assert.deepEqual(serviceSocket.remediationCommands, [
    `chmod u+wx '${socketDir}'`,
  ]);

  const applied = runCli(
    fixture,
    "--service-socket",
    serviceSocketPath,
    "setup",
    "--apply",
    "--confirm",
    blocked.json.planId,
    "--host-id",
    "socket-parent",
    "--json",
  );
  assert.equal(applied.status, 3, applied.stderr);
  assert.equal(applied.json.reasonCode, "setup-prerequisite-failed");
  assert.equal(applied.json.failedStage, "preflight");
  assert.equal(applied.json.blockerReasonCode, "service-socket");
  assert.equal(fs.existsSync(fixture.hostConfigPath), false);
});

test("concurrent confirmed setup allows one commit without duplicate devices", async () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "concurrent-guided-cli");
  assert.equal(preview.status, 0, preview.stderr);

  const results = await Promise.all([
    runCliAsync(fixture, {}, "setup", "--apply", "--confirm", preview.json.planId, "--host-id", "concurrent-guided-cli", "--json"),
    runCliAsync(fixture, {}, "setup", "--apply", "--confirm", preview.json.planId, "--host-id", "concurrent-guided-cli", "--json"),
  ]);
  const winner = results.find((result) => result.status === 0);
  const loser = results.find((result) => result.status === 5);

  assert.ok(winner, results.map((result) => result.stderr).join("\n"));
  assert.equal(winner.json.status, "ready");
  assert.equal(Object.hasOwn(winner.json, "expectedHost"), false);
  assert.ok(loser, results.map((result) => result.stderr).join("\n"));
  assert.equal(loser.json.reasonCode, "setup-plan-stale");
  assert.equal(readJson(fixture.hostConfigPath).aliases.length, 6);
  assert.equal(readJson(fixture.simctl.statePath).devices.length, 6);

  const stopped = runCli(fixture, "service", "stop");
  assert.equal(stopped.status, 0, stopped.stderr);
});

test("non-TTY setup is read-only and prints a copyable confirmed apply command", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };

  const preview = spawnCli(fixture, "setup", "--host-id", "human-preview");
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Simulator pool \(6\)/);
  assert.match(preview.stdout, /manual-1/);
  assert.match(preview.stdout, /ipad-1/);
  assert.match(preview.stdout, /Runtime: iOS 18\.2/);
  assert.match(preview.stdout, /simbroker setup --apply --confirm/);
  assert.equal(fs.existsSync(fixture.hostConfigPath), false);
});

test("non-TTY setup apply command includes environment-selected paths", () => {
  const root = makeTempDir();
  const hostConfigPath = path.join(root, "host-config.json");
  const stateRoot = path.join(root, "state");
  const serviceSocket = path.join(root, "broker.sock");
  const simctl = createSimctlFixture(root);
  const preview = spawnSync(process.execPath, [
    CLI_PATH,
    "setup",
    "--host-id",
    "env-selected-paths",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...simctl.env,
      SIMBROKER_HOST_CONFIG: hostConfigPath,
      SIMBROKER_SERVICE_SOCKET: serviceSocket,
      SIMBROKER_STATE_ROOT: stateRoot,
    },
    killSignal: "SIGKILL",
    timeout: CLI_TEST_TIMEOUT_MS,
  });

  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /simbroker setup --apply --confirm/);
  assert.equal(preview.stdout.includes(`--host-config '${hostConfigPath}'`), true);
  assert.equal(preview.stdout.includes(`--state-root '${stateRoot}'`), true);
  assert.equal(preview.stdout.includes(`--service-socket '${serviceSocket}'`), true);
  assert.equal(fs.existsSync(hostConfigPath), false);
});

test("setup rejects missing or stale confirmation and irrelevant flags before mutation", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };

  const missing = runCli(fixture, "setup", "--apply", "--json");
  assert.equal(missing.status, 5);
  assert.equal(missing.json.reasonCode, "setup-confirmation-required");
  assert.match(missing.json.recoveryCommand, /^simbroker setup --host-config '/);
  assert.match(missing.json.recoveryCommand, /--state-root '/);
  assert.match(missing.json.recoveryCommand, /--service-socket '/);
  assert.equal(missing.json.recoveryCommand.includes(fixture.hostConfigPath), true);
  assert.equal(missing.json.recoveryCommand.includes(fixture.stateRoot), true);
  assert.equal(fs.existsSync(fixture.hostConfigPath), false);

  const missingWithSelections = runCli(
    fixture,
    "setup",
    "--apply",
    "--json",
    "--host-id",
    "guided-retry",
    "--ios-version",
    "18",
  );
  assert.equal(missingWithSelections.status, 5);
  assert.equal(missingWithSelections.json.reasonCode, "setup-confirmation-required");
  assert.match(missingWithSelections.json.recoveryCommand, /--host-id 'guided-retry'/);
  assert.match(missingWithSelections.json.recoveryCommand, /--ios-version '18'/);
  assert.equal(fs.existsSync(fixture.hostConfigPath), false);

  const stale = runCli(fixture, "setup", "--apply", "--confirm", "sha256:stale", "--json");
  assert.equal(stale.status, 5);
  assert.equal(stale.json.reasonCode, "setup-plan-stale");
  assert.equal(fs.existsSync(fixture.hostConfigPath), false);

  for (const args of [
    ["--force"],
    ["--yes"],
    ["--repo-root", root],
    ["--project-file", path.join(root, "project.json")],
    ["--unknown"],
  ]) {
    const rejected = runCli(fixture, "setup", ...args, "--json");
    assert.equal(rejected.status, 2, args[0]);
    assert.equal(rejected.json.reasonCode, "invalid-flag", args[0]);
  }

  for (const iosVersion of ["banana", "26.4.1", "26.", ".4"]) {
    const rejected = runCli(fixture, "setup", "--ios-version", iosVersion, "--json");
    assert.equal(rejected.status, 2, iosVersion);
    assert.equal(rejected.json.reasonCode, "invalid-flag", iosVersion);
    assert.equal(rejected.json.flag, "ios-version", iosVersion);
  }
});

test("setup treats a truncated dashboard snapshot as finishing work", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "truncated-snapshot");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "truncated-snapshot",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.json.status, "ready");

  const snapshotPath = path.join(fixture.stateRoot, "app-snapshot.json");
  const snapshot = readJson(snapshotPath);
  delete snapshot.generatedAt;
  delete snapshot.idle;
  delete snapshot.overview;
  delete snapshot.recentEvents;
  writeJson(snapshotPath, snapshot);

  const finishing = runCli(fixture, "setup", "--json");
  assert.equal(finishing.status, 0, finishing.stderr);
  assert.equal(finishing.json.status, "changes_required");
  assert.equal(finishing.json.service.action, "keep");
  assert.equal(finishing.json.confirmation.required, false);

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup treats incomplete nested snapshot simulator records as finishing work", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "nested-snapshot-simulators");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "nested-snapshot-simulators",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.json.status, "ready");

  const snapshotPath = path.join(fixture.stateRoot, "app-snapshot.json");
  const snapshot = readJson(snapshotPath);
  snapshot.simulators = snapshot.simulators.map((simulator) => ({
    alias: simulator.alias,
    health: simulator.health,
    simulatorId: simulator.simulatorId,
  }));
  writeJson(snapshotPath, snapshot);

  const finishing = runCli(fixture, "setup", "--json");
  assert.equal(finishing.status, 0, finishing.stderr);
  assert.equal(finishing.json.status, "changes_required");
  assert.equal(finishing.json.service.action, "keep");
  assert.equal(finishing.json.confirmation.required, false);

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup treats duplicate snapshot project identities as finishing work", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "duplicate-snapshot-projects");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "duplicate-snapshot-projects",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.json.status, "ready");

  const snapshotPath = path.join(fixture.stateRoot, "app-snapshot.json");
  const snapshot = readJson(snapshotPath);
  const duplicateProject = {
    activeAliases: [],
    activeLeaseCount: 0,
    pinnedAliasCount: 0,
    projectId: "demo-app",
    projectName: "Demo App",
    purposes: [],
  };
  snapshot.projects = [duplicateProject, { ...duplicateProject }];
  writeJson(snapshotPath, snapshot);

  const finishing = runCli(fixture, "setup", "--json");
  assert.equal(finishing.status, 0, finishing.stderr);
  assert.equal(finishing.json.status, "changes_required");
  assert.equal(finishing.json.service.action, "keep");
  assert.equal(finishing.json.confirmation.required, false);

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup treats duplicate snapshot pin aliases as finishing work", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "duplicate-snapshot-pins");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "duplicate-snapshot-pins",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.json.status, "ready");

  const snapshotPath = path.join(fixture.stateRoot, "app-snapshot.json");
  const snapshot = readJson(snapshotPath);
  const duplicatePin = {
    actorId: "codex",
    actorType: "agent",
    alias: "manual-1",
    createdAt: "2026-08-28T00:00:00.000Z",
    pinId: "pin-1",
    projectId: "demo-app",
    projectName: "Demo App",
    repoRoot: path.join(root, "repo"),
  };
  snapshot.pins = [duplicatePin, { ...duplicatePin }];
  writeJson(snapshotPath, snapshot);

  const finishing = runCli(fixture, "setup", "--json");
  assert.equal(finishing.status, 0, finishing.stderr);
  assert.equal(finishing.json.status, "changes_required");
  assert.equal(finishing.json.service.action, "keep");
  assert.equal(finishing.json.confirmation.required, false);

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup treats duplicate snapshot active-lease identities as finishing work", (t) => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  t.after(() => {
    runCli(fixture, "service", "stop");
  });
  const preview = runCli(fixture, "setup", "--json", "--host-id", "duplicate-snapshot-leases");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "duplicate-snapshot-leases",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.json.status, "ready");

  const snapshotPath = path.join(fixture.stateRoot, "app-snapshot.json");
  const snapshot = readJson(snapshotPath);
  const simulator = snapshot.simulators[0];
  const duplicateLease = {
    actorId: "codex",
    actorType: "agent",
    alias: simulator.alias,
    displayName: simulator.displayName,
    leaseId: "lease-1",
    leaseKind: "exclusive",
    ownerPid: 4242,
    projectId: "demo-app",
    projectName: "Demo App",
    purposeId: "agent-ui-session",
    repoRoot: path.join(root, "repo"),
    simulatorId: simulator.simulatorId,
    startedAt: "2026-08-28T00:00:00.000Z",
  };
  snapshot.activeLeases = [duplicateLease, { ...duplicateLease }];
  writeJson(snapshotPath, snapshot);

  const finishing = runCli(fixture, "setup", "--json");
  assert.equal(finishing.status, 0, finishing.stderr);
  assert.equal(finishing.json.status, "changes_required");
  assert.equal(finishing.json.service.action, "keep");
  assert.equal(finishing.json.confirmation.required, false);

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup treats duplicate snapshot simulator aliases as finishing work", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "duplicate-snapshot-simulators");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "duplicate-snapshot-simulators",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.json.status, "ready");

  const snapshotPath = path.join(fixture.stateRoot, "app-snapshot.json");
  const snapshot = readJson(snapshotPath);
  snapshot.simulators = [...snapshot.simulators, { ...snapshot.simulators[0] }];
  writeJson(snapshotPath, snapshot);

  const finishing = runCli(fixture, "setup", "--json");
  assert.equal(finishing.status, 0, finishing.stderr);
  assert.equal(finishing.json.status, "changes_required");
  assert.equal(finishing.json.service.action, "keep");
  assert.equal(finishing.json.confirmation.required, false);

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup treats snapshot integers outside the safe integer range as finishing work", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "snapshot-int-range");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "snapshot-int-range",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.json.status, "ready");

  const snapshotPath = path.join(fixture.stateRoot, "app-snapshot.json");
  const snapshot = readJson(snapshotPath);
  snapshot.overview.totalAliases = 9223372036854775808;
  writeJson(snapshotPath, snapshot);

  const finishing = runCli(fixture, "setup", "--json");
  assert.equal(finishing.status, 0, finishing.stderr);
  assert.equal(finishing.json.status, "changes_required");
  assert.equal(finishing.json.service.action, "keep");
  assert.equal(finishing.json.confirmation.required, false);

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup treats out-of-range snapshot leaseSaturation as finishing work", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "snapshot-saturation");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "snapshot-saturation",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.json.status, "ready");

  const snapshotPath = path.join(fixture.stateRoot, "app-snapshot.json");
  const snapshot = readJson(snapshotPath);
  snapshot.overview.leaseSaturation = 1e308;
  writeJson(snapshotPath, snapshot);

  const finishing = runCli(fixture, "setup", "--json");
  assert.equal(finishing.status, 0, finishing.stderr);
  assert.equal(finishing.json.status, "changes_required");
  assert.equal(finishing.json.service.action, "keep");
  assert.equal(finishing.json.confirmation.required, false);

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup treats incomplete nested snapshot event records as finishing work", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "nested-snapshot-events");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "nested-snapshot-events",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.json.status, "ready");

  const snapshotPath = path.join(fixture.stateRoot, "app-snapshot.json");
  const snapshot = readJson(snapshotPath);
  snapshot.recentEvents = [
    ...(Array.isArray(snapshot.recentEvents) ? snapshot.recentEvents : []),
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "lease.acquired",
    },
  ];
  writeJson(snapshotPath, snapshot);

  const finishing = runCli(fixture, "setup", "--json");
  assert.equal(finishing.status, 0, finishing.stderr);
  assert.equal(finishing.json.status, "changes_required");
  assert.equal(finishing.json.service.action, "keep");
  assert.equal(finishing.json.confirmation.required, false);

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup treats extra snapshot simulator rows as finishing work", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "stale-snapshot-alias");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "stale-snapshot-alias",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  const snapshotPath = path.join(fixture.stateRoot, "app-snapshot.json");
  const snapshot = readJson(snapshotPath);
  snapshot.simulators = [
    ...snapshot.simulators,
    {
      alias: "retired-1",
      capabilities: ["manual-persistent"],
      deviceFamily: "iPhone",
      displayName: "Retired One",
      health: "healthy",
      iosVersion: "18.0",
      powerState: "shutdown",
      simulatorId: "SIM-RETIRED-1",
    },
  ];
  writeJson(snapshotPath, snapshot);

  const finishing = runCli(fixture, "setup", "--json");
  assert.equal(finishing.status, 0, finishing.stderr);
  assert.equal(finishing.json.status, "changes_required");
  assert.equal(finishing.json.service.action, "keep");

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup treats a path-mismatched snapshot as finishing work", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "snapshot-validation");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "snapshot-validation",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  const snapshotPath = path.join(fixture.stateRoot, "app-snapshot.json");
  const snapshot = readJson(snapshotPath);
  snapshot.hostConfigPath = path.join(root, "different-host.json");
  writeJson(snapshotPath, snapshot);

  const finishing = runCli(fixture, "setup", "--json");
  assert.equal(finishing.status, 0, finishing.stderr);
  assert.equal(finishing.json.status, "changes_required");
  assert.equal(finishing.json.service.action, "keep");

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup treats newer known-projects, lease, or pin records as snapshot finishing work", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "fresh-state-mtime");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "fresh-state-mtime",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.json.status, "ready");

  const snapshotPath = path.join(fixture.stateRoot, "app-snapshot.json");
  const snapshotMtime = fs.statSync(snapshotPath).mtimeMs;
  const knownProjectsPath = path.join(fixture.stateRoot, "known-projects.json");
  writeJson(knownProjectsPath, {
    projects: {
      "fresh-state-mtime": {
        lastObservedAt: "2026-08-25T00:00:00.000Z",
        projectFilePath: path.join(root, "repo/.simulator-broker/project.json"),
        projectId: "fresh-state-mtime",
        projectName: "Fresh State Mtime",
        purposes: [],
        repoRoot: path.join(root, "repo"),
      },
    },
    updatedAt: "2026-08-25T00:00:00.000Z",
    version: 1,
  });
  const newerMtime = new Date(snapshotMtime + 2000);
  fs.utimesSync(knownProjectsPath, newerMtime, newerMtime);

  const finishing = runCli(fixture, "setup", "--json");
  assert.equal(finishing.status, 0, finishing.stderr);
  assert.equal(finishing.json.status, "changes_required");
  assert.equal(finishing.json.service.action, "keep");
  assert.equal(finishing.json.confirmation.required, false);

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup treats deleted known-projects, lease, or pin records as snapshot finishing work", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "deleted-state");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "deleted-state",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.json.status, "ready");

  const snapshotPath = path.join(fixture.stateRoot, "app-snapshot.json");
  const snapshot = readJson(snapshotPath);
  const leasesDir = path.join(fixture.stateRoot, "leases");
  const pinsDir = path.join(fixture.stateRoot, "pins");
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.mkdirSync(pinsDir, { recursive: true });
  writeJson(path.join(leasesDir, "lease-1.json"), {
    alias: "ui-1",
    leaseId: "lease-1",
  });
  snapshot.activeLeases = [{ alias: "ui-1", leaseId: "lease-1" }];
  writeJson(snapshotPath, snapshot);
  fs.rmSync(path.join(leasesDir, "lease-1.json"));

  const deletedLease = runCli(fixture, "setup", "--json");
  assert.equal(deletedLease.status, 0, deletedLease.stderr);
  assert.equal(deletedLease.json.status, "changes_required");
  assert.equal(deletedLease.json.confirmation.required, false);

  writeJson(path.join(pinsDir, "pin-1.json"), {
    alias: "manual-1",
    pinId: "pin-1",
  });
  const pinSnapshot = readJson(snapshotPath);
  pinSnapshot.activeLeases = [];
  pinSnapshot.pins = [{ alias: "manual-1", pinId: "pin-1" }];
  writeJson(snapshotPath, pinSnapshot);
  fs.rmSync(path.join(pinsDir, "pin-1.json"));

  const deletedPin = runCli(fixture, "setup", "--json");
  assert.equal(deletedPin.status, 0, deletedPin.stderr);
  assert.equal(deletedPin.json.status, "changes_required");

  const knownProjectsPath = path.join(fixture.stateRoot, "known-projects.json");
  writeJson(knownProjectsPath, {
    projects: {
      "deleted-state": {
        lastObservedAt: "2026-08-25T00:00:00.000Z",
        projectFilePath: path.join(root, "repo/.simulator-broker/project.json"),
        projectId: "deleted-state",
        projectName: "Deleted State",
        purposes: [],
        repoRoot: path.join(root, "repo"),
      },
    },
    updatedAt: "2026-08-25T00:00:00.000Z",
    version: 1,
  });
  const catalogSnapshot = readJson(snapshotPath);
  catalogSnapshot.activeLeases = [];
  catalogSnapshot.pins = [];
  catalogSnapshot.projects = [{
    projectFilePath: path.join(root, "repo/.simulator-broker/project.json"),
    projectId: "deleted-state",
    projectName: "Deleted State",
  }];
  writeJson(snapshotPath, catalogSnapshot);
  fs.rmSync(knownProjectsPath);

  const deletedCatalog = runCli(fixture, "setup", "--json");
  assert.equal(deletedCatalog.status, 0, deletedCatalog.stderr);
  assert.equal(deletedCatalog.json.status, "changes_required");

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup treats deletion of an empty known-projects catalog as snapshot finishing work", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "empty-catalog-deleted");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "empty-catalog-deleted",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.json.status, "ready");

  const knownProjectsPath = path.join(fixture.stateRoot, "known-projects.json");
  writeJson(knownProjectsPath, {
    projects: {},
    updatedAt: "2026-08-25T00:00:00.000Z",
    version: 1,
  });
  const snapshotPath = path.join(fixture.stateRoot, "app-snapshot.json");
  const snapshot = readJson(snapshotPath);
  snapshot.projects = [];
  writeJson(snapshotPath, snapshot);
  fs.rmSync(knownProjectsPath);

  const finishing = runCli(fixture, "setup", "--json");
  assert.equal(finishing.status, 0, finishing.stderr);
  assert.equal(finishing.json.status, "changes_required");
  assert.equal(finishing.json.confirmation.required, false);

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup treats omitted catalog-backed projects as snapshot finishing work", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "omitted-catalog");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "omitted-catalog",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.json.status, "ready");

  const knownProjectsPath = path.join(fixture.stateRoot, "known-projects.json");
  writeJson(knownProjectsPath, {
    projects: {
      "omitted-catalog": {
        lastObservedAt: "2026-08-25T00:00:00.000Z",
        projectFilePath: path.join(root, "repo/.simulator-broker/project.json"),
        projectId: "omitted-catalog",
        projectName: "Omitted Catalog",
        purposes: [],
        repoRoot: path.join(root, "repo"),
      },
    },
    updatedAt: "2026-08-25T00:00:00.000Z",
    version: 1,
  });
  const snapshotPath = path.join(fixture.stateRoot, "app-snapshot.json");
  const snapshot = readJson(snapshotPath);
  snapshot.projects = [];
  writeJson(snapshotPath, snapshot);

  const finishing = runCli(fixture, "setup", "--json");
  assert.equal(finishing.status, 0, finishing.stderr);
  assert.equal(finishing.json.status, "changes_required");
  assert.equal(finishing.json.confirmation.required, false);

  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("setup blocks when known-projects JSON is malformed after a healthy snapshot", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "corrupt-catalog");
  const applied = runCli(
    fixture,
    "setup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--host-id",
    "corrupt-catalog",
    "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(runCli(fixture, "service", "stop").status, 0);

  const knownProjectsPath = path.join(fixture.stateRoot, "known-projects.json");
  fs.writeFileSync(knownProjectsPath, "{not-json\n");
  const blocked = runCli(fixture, "setup", "--json");
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.json.status, "blocked");
  assert.ok(blocked.json.prerequisites.some((issue) =>
    issue.id === "known-projects" && issue.status === "blocked"));
});

test("setup resumes a missing registry for an exact untouched starter host", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "registry-resume");
  const applied = runCli(
    fixture,
    "setup", "--apply", "--confirm", preview.json.planId,
    "--host-id", "registry-resume", "--json",
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(runCli(fixture, "service", "stop").status, 0);
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    stateRoot: fixture.stateRoot,
  });
  fs.rmSync(paths.registryPath);

  const recoveryPreview = runCli(fixture, "setup", "--json");
  assert.equal(recoveryPreview.status, 0, recoveryPreview.stderr);
  assert.equal(recoveryPreview.json.status, "changes_required");
  assert.ok(recoveryPreview.json.prerequisites.some((issue) =>
    issue.id === "registry" && issue.status === "info"));

  const recovered = runCli(
    fixture,
    "setup", "--apply", "--confirm", recoveryPreview.json.planId, "--json",
  );
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.json.devices.created, 0);
  assert.equal(fs.existsSync(paths.registryPath), true);
  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("SIGTERM cooperatively cancels provisioning and rolls back pre-commit devices", async () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "signal-setup");
  assert.equal(preview.status, 0, preview.stderr);
  const baselineCount = readJson(fixture.simctl.statePath).devices.length;

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      CLI_PATH,
      "--host-config", fixture.hostConfigPath,
      "--state-root", fixture.stateRoot,
      "setup", "--apply", "--confirm", preview.json.planId,
      "--host-id", "signal-setup", "--json",
    ], {
      env: {
        ...process.env,
        ...fixture.simctl.env,
        SIMBROKER_SIMCTL_FIXTURE_CREATE_DELAY_MS: "750",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    const deadline = Date.now() + 10_000;
    const poll = setInterval(() => {
      try {
        if (readJson(fixture.simctl.statePath).devices.length > baselineCount) {
          clearInterval(poll);
          child.kill("SIGTERM");
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          child.kill("SIGKILL");
          reject(new Error("Timed out waiting for setup to create its first simulator."));
        }
      } catch {
        // The fixture file is replaced atomically; retry until it is readable.
      }
    }, 20);
    child.once("close", (status, signal) => {
      clearInterval(poll);
      resolve({ json: stdout ? JSON.parse(stdout) : null, signal, status, stderr });
    });
  });

  assert.equal(result.signal, null);
  assert.equal(result.status, 143, result.stderr);
  assert.equal(result.json.reasonCode, "setup-interrupted");
  assert.equal(result.json.hostCommitted, false);
  assert.equal(fs.existsSync(fixture.hostConfigPath), false);
  assert.equal(readJson(fixture.simctl.statePath).devices.length, baselineCount);
});

test("SIGTERM interrupts setup while service startup is waiting", async (t) => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    stateRoot: fixture.stateRoot,
  });
  fs.mkdirSync(paths.serviceLockDir, { recursive: true });
  fs.writeFileSync(paths.serviceLockOwnerPath, `${JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: "setup-cancellation-test",
  })}\n`);
  t.after(() => {
    fs.rmSync(paths.serviceLockDir, { force: true, recursive: true });
    runCli(fixture, "service", "stop");
  });
  const preview = runCli(fixture, "setup", "--json", "--host-id", "service-wait-signal");
  assert.equal(preview.status, 0, preview.stderr);

  const startedAt = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      CLI_PATH,
      "setup", "--apply", "--confirm", preview.json.planId,
      "--host-id", "service-wait-signal", "--json",
      "--host-config", fixture.hostConfigPath,
      "--state-root", fixture.stateRoot,
    ], {
      env: {
        ...process.env,
        ...fixture.simctl.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    const deadline = Date.now() + 10_000;
    const poll = setInterval(() => {
      if (fs.existsSync(fixture.hostConfigPath) && fs.existsSync(paths.serviceLogPath)) {
        clearInterval(poll);
        child.kill("SIGTERM");
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        child.kill("SIGKILL");
        reject(new Error("Timed out waiting for setup service startup."));
      }
    }, 10);
    child.once("close", (status, signal) => {
      clearInterval(poll);
      resolve({ json: stdout ? JSON.parse(stdout) : null, signal, status, stderr });
    });
  });

  assert.equal(result.signal, null);
  assert.equal(result.status, 143, result.stderr);
  assert.equal(result.json.reasonCode, "setup-interrupted");
  assert.equal(result.json.hostCommitted, true);
  assert.ok(Date.now() - startedAt < 5_000);
});

test("setup rejects a snapshot whose host changed after provisioning", async () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };
  const preview = runCli(fixture, "setup", "--json", "--host-id", "identity-race");
  const paths = holdServiceStartLock(fixture);
  fs.rmSync(paths.serviceLogPath, { force: true });
  const invocation = spawnCliControllable(
    fixture,
    {},
    "setup", "--apply", "--confirm", preview.json.planId,
    "--host-id", "identity-race", "--json",
  );
  await waitUntil(() => fs.existsSync(fixture.hostConfigPath) && fs.existsSync(paths.serviceLogPath));
  const replacedHost = readJson(fixture.hostConfigPath);
  replacedHost.hostId = "replacement-host";
  writeJson(fixture.hostConfigPath, replacedHost);
  fs.rmSync(paths.serviceLockDir, { force: true, recursive: true });

  const result = await invocation.result;
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.json.reasonCode, "setup-committed-host-mismatch");
  assert.equal(result.json.expectedHostId, "identity-race");
  assert.equal(result.json.actualHostId, "replacement-host");
  assert.equal(result.json.hostCommitted, true);
  assert.equal(runCli(fixture, "service", "stop").status, 0);
});

test("global path flags reject valueless overrides before defaulting", () => {
  const fixture = makeFixture();

  const result = runCli(fixture, "host", "status", "--state-root");

  assert.equal(result.status, 2);
  assert.equal(result.json.reasonCode, "missing-flag");
  assert.equal(result.json.flag, "state-root");
});

test("project init scaffolds a starter repo config that can be validated immediately", () => {
  const root = makeTempDir();
  const fixture = {
    hostConfigPath: path.join(root, "host-config.json"),
    repoRoot: path.join(root, "repo"),
    simctl: createSimctlFixture(root),
    stateRoot: path.join(root, "state"),
  };

  const initResult = runCli(
    fixture,
    "project",
    "init",
    "--repo-root",
    fixture.repoRoot,
    "--project-id",
    "new-repo",
    "--project-name",
    "New Repo",
  );
  assert.equal(initResult.status, 0);
  assert.equal(initResult.json.ok, true);
  assert.equal(initResult.json.projectConfig.projectId, "new-repo");
  const defaultUiPurpose = initResult.json.projectConfig.purposes.find((purpose) => purpose.id === "agent-ui-session");
  assert.deepEqual(defaultUiPurpose.requires, { deviceFamily: "iPhone" });

  const explicitRoot = path.join(root, "explicit-repo");
  const explicitResult = runCli(
    fixture,
    "project",
    "init",
    "--repo-root",
    explicitRoot,
    "--project-id",
    "explicit-repo",
    "--ios-version",
    "26",
  );
  assert.equal(explicitResult.status, 0);
  const explicitUiPurpose = explicitResult.json.projectConfig.purposes.find((purpose) => purpose.id === "agent-ui-session");
  assert.deepEqual(explicitUiPurpose.requires, { deviceFamily: "iPhone", iosVersion: "26" });

  const validateResult = runCli(fixture, "project", "validate", "--repo-root", fixture.repoRoot);
  assert.equal(validateResult.status, 0);
  assert.equal(validateResult.json.projectConfig.purposes.some((purpose) => purpose.id === "agent-ui-session"), true);
});

test("project validate can discover the project file from --repo-root", () => {
  const fixture = makeFixture();
  const result = runCli(fixture, "project", "validate", "--repo-root", fixture.repoRoot);
  assert.equal(result.status, 0);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.projectConfig.projectId, "cli-demo");
});

test("project forget removes an inactive registration and refreshes the local app snapshot", () => {
  const fixture = makeFixture();

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "project", "validate", "--repo-root", fixture.repoRoot).status, 0);

  const forgotten = runCli(fixture, "project", "forget", "--project-id", "cli-demo");
  assert.equal(forgotten.status, 0);
  assert.equal(forgotten.json.transport, "direct");
  assert.equal(forgotten.json.forgotten, true);
  assert.equal(Object.hasOwn(readJson(path.join(fixture.stateRoot, "known-projects.json")).projects, "cli-demo"), false);
  const snapshot = readJson(path.join(fixture.stateRoot, "app-snapshot.json"));
  assert.equal(snapshot.projects.some((project) => project.projectId === "cli-demo"), false);

  const repeated = runCli(fixture, "project", "forget", "--project-id", "cli-demo");
  assert.equal(repeated.status, 0);
  assert.equal(repeated.json.unchanged, true);

  const missingId = runCli(fixture, "project", "forget");
  assert.equal(missingId.status, 2);
  assert.equal(missingId.json.reasonCode, "missing-flag");

  const unknownFlag = runCli(fixture, "project", "forget", "--project-id", "cli-demo", "--project-idd", "typo");
  assert.equal(unknownFlag.status, 2);
  assert.equal(unknownFlag.json.reasonCode, "invalid-flag");
  assert.equal(unknownFlag.json.flag, "project-idd");
});

test("project init honors explicit false for overwrite", () => {
  const fixture = makeFixture();
  const projectFilePath = path.join(fixture.repoRoot, ".simulator-broker/project.json");
  const before = readJson(projectFilePath);

  const result = runCli(
    fixture,
    "project",
    "init",
    "--repo-root",
    fixture.repoRoot,
    "--project-id",
    "replacement-project",
    "--overwrite=false",
  );

  assert.equal(result.status, 2);
  assert.equal(result.json.reasonCode, "project-config-exists");
  assert.deepEqual(readJson(projectFilePath), before);
});

test("doctor returns actual health data for the doctor command surface", () => {
  const fixture = makeFixture();
  const initResult = runCli(fixture, "host", "init");
  assert.equal(initResult.status, 0);

  const doctorResult = runCli(fixture, "doctor", "--json");
  assert.equal(doctorResult.status, 0);
  assert.equal(doctorResult.json.ok, true);
  assert.deepEqual(doctorResult.json.issues, []);
});

test("group help returns useful command lists for project, lease, host, and capacity", () => {
  const fixture = makeFixture();

  const projectHelp = runCli(fixture, "project", "--help", "--json");
  assert.equal(projectHelp.status, 0);
  assert.equal(projectHelp.json.ok, true);
  assert.equal(projectHelp.json.group, "project");
  assert.ok(projectHelp.json.commands.some((command) => command.includes("project forget")));

  const leaseHelp = runCli(fixture, "lease", "--help", "--json");
  assert.equal(leaseHelp.status, 0);
  assert.equal(leaseHelp.json.ok, true);
  assert.equal(leaseHelp.json.group, "lease");
  assert.ok(leaseHelp.json.commands.some((command) => command.includes("register-process")));
  assert.ok(leaseHelp.json.commands.some((command) => command.includes("contain")));

  const hostHelp = runCli(fixture, "host", "--help", "--json");
  assert.equal(hostHelp.status, 0);
  assert.equal(hostHelp.json.ok, true);
  assert.equal(hostHelp.json.group, "host");
  assert.ok(hostHelp.json.commands.some((command) => command.includes("host status")));

  const capacityHelp = runCli(fixture, "capacity", "--help", "--json");
  assert.equal(capacityHelp.status, 0);
  assert.equal(capacityHelp.json.ok, true);
  assert.equal(capacityHelp.json.group, "capacity");
  assert.ok(capacityHelp.json.commands.some((command) => command.includes("capacity check")));
  assert.ok(capacityHelp.json.commands.some((command) => command.includes("--confirm <plan-id>")));
});

test("bare help and doctor print human text by default and JSON with --json", () => {
  const fixture = makeFixture();
  assert.equal(runCli(fixture, "host", "init").status, 0);

  const humanInvocations = [
    [],
    ["--help"],
    ["help"],
  ];

  for (const args of humanInvocations) {
    const result = spawnCli(fixture, ...args);
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.stdout.trimStart()[0], "{");
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /host/);
    assert.match(result.stdout, /Top-level commands:/);
    assert.match(result.stdout, /doctor/);
    assert.match(result.stdout, /simbroker <group> --help/);
    assert.match(result.stdout, /simbroker doctor --help/);
    assert.match(result.stdout, /--json/);
  }

  const jsonInvocations = [
    ["--json"],
    ["--help", "--json"],
    ["help", "--json"],
  ];

  for (const args of jsonInvocations) {
    const result = runCli(fixture, ...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.group, "global");
    assert.equal(typeof result.json.usage, "string");
    assert.ok(Array.isArray(result.json.commands));
    assert.ok(result.json.commands.includes("host"));
    assert.ok(result.json.commands.includes("doctor"));
  }

  const doctorText = spawnCli(fixture, "doctor");
  assert.equal(doctorText.status, 0, doctorText.stderr);
  assert.notEqual(doctorText.stdout.trimStart()[0], "{");
  assert.match(doctorText.stdout, /Simulator Broker doctor/);
  assert.match(doctorText.stdout, /Status: healthy/);
  assert.match(doctorText.stdout, /Checklist:/);
  assert.match(doctorText.stdout, /No issues found/);
  assert.match(doctorText.stdout, /Next:/);

  const doctorJson = runCli(fixture, "doctor", "--json");
  assert.equal(doctorJson.status, 0, doctorJson.stderr);
  assert.equal(doctorJson.json.ok, true);
  assert.deepEqual(doctorJson.json.issues, []);
  assert.equal(typeof doctorJson.json.hostConfigPath, "string");
  assert.equal(typeof doctorJson.json.stateRoot, "string");
});

test("every advertised group and doctor have a working --help page", () => {
  const fixture = makeFixture();
  const advertised = [
    ["host", "host status"],
    ["project", "project forget"],
    ["lease", "lease contain"],
    ["capacity", "capacity check"],
    ["idle", "idle status"],
    ["events", "events watch"],
    ["pin", "pin create"],
    ["simulators", "simulators repair"],
    ["service", "service start"],
    ["doctor", "doctor --json"],
  ];

  for (const [group, expectedCommand] of advertised) {
    const human = spawnCli(fixture, group, "--help");
    assert.equal(human.status, 0, human.stderr || human.stdout);
    assert.notEqual(human.stdout.trimStart()[0], "{");
    assert.match(human.stdout, /Usage:/);
    assert.match(human.stdout, new RegExp(expectedCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (group === "host") {
      assert.match(human.stdout, /creates real iOS Simulator devices/);
    }

    const machine = runCli(fixture, group, "--help", "--json");
    assert.equal(machine.status, 0, machine.stderr);
    assert.equal(machine.json.ok, true);
    assert.equal(machine.json.group, group);
    assert.ok(machine.json.commands.some((command) => command.includes(expectedCommand)));
  }
});

test("doctor human formatter names unhealthy aliases and next commands", () => {
  const text = format({
    hostConfigPath: "/tmp/host-config.json",
    issues: [{
      alias: "ui-1",
      health: "repair-needed",
      reasonCode: "alias-unhealthy",
    }],
    ok: false,
    stateRoot: "/tmp/state",
  });

  assert.notEqual(text.trimStart()[0], "{");
  assert.match(text, /Status: needs attention/);
  assert.match(text, /Alias ui-1: repair-needed/);
  assert.match(text, /simbroker simulators repair --alias 'ui-1'/);
});

test("setup human errors include doctor issues and exact alias repair commands", () => {
  const text = format({
    command: "setup",
    completedStages: ["host", "service"],
    doctorIssues: [{
      alias: "ui-1",
      health: "repair-needed",
      reasonCode: "alias-unhealthy",
    }],
    error: "Setup health verification failed.",
    failedStage: "health",
    hostCommitted: true,
    ok: false,
    recoveryCommand: "simbroker setup",
  });

  assert.match(text, /Doctor issues:/);
  assert.match(text, /Alias ui-1: repair-needed/);
  assert.match(text, /simbroker simulators repair --alias 'ui-1'/);
});

test("setup human errors keep selected paths on health-failure repair commands", () => {
  const text = format({
    command: "setup",
    completedStages: ["host", "service"],
    doctorIssues: [{
      alias: "ui-1",
      health: "repair-needed",
      reasonCode: "alias-unhealthy",
      remediationCommands: [
        "simbroker host status --host-config '/tmp/custom-host.json' --state-root '/tmp/custom-state' --service-socket '/tmp/custom.sock'",
        "simbroker simulators repair --alias ui-1 --host-config '/tmp/custom-host.json' --state-root '/tmp/custom-state' --service-socket '/tmp/custom.sock'",
      ],
    }],
    error: "Setup health verification failed.",
    failedStage: "health",
    hostCommitted: true,
    ok: false,
    recoveryCommand: "simbroker setup --host-config '/tmp/custom-host.json' --state-root '/tmp/custom-state' --service-socket '/tmp/custom.sock'",
  });

  assert.match(text, /Doctor issues:/);
  assert.match(text, /Alias ui-1: repair-needed/);
  assert.match(text, /simbroker host status --host-config '\/tmp\/custom-host\.json'/);
  assert.match(text, /simbroker simulators repair --alias ui-1 --host-config '\/tmp\/custom-host\.json'/);
  assert.match(text, /--state-root '\/tmp\/custom-state'/);
  assert.match(text, /--service-socket '\/tmp\/custom\.sock'/);
  assert.equal(text.includes("inspect with `simbroker host status`, then repair"), false);
});

test("setup human errors report incomplete rollback without exposing simulator ids", () => {
  const text = format({
    command: "setup",
    error: "Primary provisioning failure.",
    failedStage: "provisioning",
    hostCommitted: false,
    ok: false,
    recoveryCommand: "simbroker setup",
    rollbackFailureCount: 2,
    rollbackFailures: [{
      error: "delete failed",
      operation: "delete",
      simulatorId: "PRIVATE-SIMULATOR-ID",
    }],
  });

  assert.match(text, /Rollback cleanup was incomplete for 2 Simulator operation\(s\)\./);
  assert.equal(text.includes("PRIVATE-SIMULATOR-ID"), false);
  assert.match(text, /simbroker setup/);
});

test("doctor human output reports missing registry and next commands", () => {
  const fixture = makeFixture();

  const doctorText = spawnCli(fixture, "doctor");
  assert.equal(doctorText.status, 0, doctorText.stderr);
  assert.match(doctorText.stdout, /Status: needs attention/);
  assert.match(doctorText.stdout, /Registry: missing/);
  assert.match(doctorText.stdout, /simbroker host init --bootstrap-config/);

  const doctorJson = runCli(makeFixture(), "doctor", "--json");
  assert.equal(doctorJson.status, 0);
  assert.equal(doctorJson.json.ok, false);
  assert.ok(doctorJson.json.issues.some((issue) => issue.reasonCode === "missing-registry"));
});

test("capacity check, preview, and confirmed apply work through the direct CLI", () => {
  const fixture = makeCapacityFixture();
  assert.equal(runCli(fixture, "host", "init").status, 0);

  const check = runCli(
    fixture,
    "capacity",
    "check",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ipad-session",
    "--json",
  );
  assert.equal(check.status, 0);
  assert.equal(check.json.transport, "direct");
  assert.equal(check.json.status, "needs_attention");
  assert.equal(check.json.purposes[0].recommendedAction, "create_capacity");
  assert.equal(JSON.stringify(check.json).includes(fixture.root), false);
  assert.equal(JSON.stringify(check.json).includes("SIM-UI-1"), false);

  const preview = runCli(
    fixture,
    "capacity",
    "reconcile",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ipad-session",
    "--json",
  );
  assert.equal(preview.status, 0);
  assert.equal(preview.json.status, "changes_required");
  assert.equal(preview.json.actions.length, 1);
  assert.match(preview.json.planId, /^sha256:/);

  const explicitFalseApply = runCli(
    fixture,
    "capacity",
    "reconcile",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ipad-session",
    "--apply=false",
    "--confirm",
    preview.json.planId,
    "--actor-type",
    "human",
    "--actor-id",
    "operator",
    "--json",
  );
  assert.equal(explicitFalseApply.status, 0);
  assert.equal(explicitFalseApply.json.status, "changes_required");
  assert.equal(readJson(fixture.hostConfigPath).aliases.some((alias) => alias.alias === "ipad-1"), false);

  const missingConfirm = runCli(
    fixture,
    "capacity",
    "reconcile",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ipad-session",
    "--apply",
    "--actor-type",
    "human",
    "--actor-id",
    "operator",
    "--json",
  );
  assert.equal(missingConfirm.status, 5);
  assert.equal(missingConfirm.json.reasonCode, "capacity-confirmation-required");

  const staleConfirm = runCli(
    fixture,
    "capacity",
    "reconcile",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ipad-session",
    "--apply",
    "--confirm",
    "sha256:not-current",
    "--actor-type",
    "human",
    "--actor-id",
    "operator",
    "--json",
  );
  assert.equal(staleConfirm.status, 5);
  assert.equal(staleConfirm.json.reasonCode, "capacity-plan-stale");

  const apply = runCli(
    fixture,
    "capacity",
    "reconcile",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ipad-session",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--actor-type",
    "human",
    "--actor-id",
    "operator",
    "--json",
  );
  assert.equal(apply.status, 0);
  assert.equal(apply.json.status, "applied");
  assert.equal(apply.json.created, 1);
  assert.equal(JSON.stringify(apply.json).includes("operator"), false);

  const hostConfig = readJson(fixture.hostConfigPath);
  assert.equal(hostConfig.aliases.some((alias) => alias.alias === "ipad-1"), true);
  const appSnapshot = readJson(path.join(fixture.stateRoot, "app-snapshot.json"));
  assert.equal(appSnapshot.simulators.some((simulator) => simulator.alias === "ipad-1"), true);

  const afterPreview = runCli(
    fixture,
    "capacity",
    "reconcile",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ipad-session",
    "--json",
  );
  assert.equal(afterPreview.status, 0);
  assert.equal(afterPreview.json.status, "no_changes");
});

test("direct local CLI serializes concurrent lease acquires for the same alias", async () => {
  const fixture = makeFixture();
  assert.equal(runCli(fixture, "host", "init").status, 0);

  const [left, right] = await Promise.all([
    runCliAsync(
      fixture,
      { SIMBROKER_LOCAL_ONLY: "1" },
      "lease",
      "acquire",
      "--repo-root",
      fixture.repoRoot,
      "--purpose",
      "agent-ui-session",
      "--actor-id",
      "agent-left",
      "--actor-type",
      "agent",
      "--owner-pid",
      String(process.pid),
      "--lease-file",
      path.join(fixture.root, "left-lease.json"),
    ),
    runCliAsync(
      fixture,
      { SIMBROKER_LOCAL_ONLY: "1" },
      "lease",
      "acquire",
      "--repo-root",
      fixture.repoRoot,
      "--purpose",
      "agent-ui-session",
      "--actor-id",
      "agent-right",
      "--actor-type",
      "agent",
      "--owner-pid",
      String(process.pid),
      "--lease-file",
      path.join(fixture.root, "right-lease.json"),
    ),
  ]);

  const results = [left, right];
  const successes = results.filter((result) => result.status === 0);
  const failures = results.filter((result) => result.status !== 0);

  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(successes[0].json.transport, "direct");
  assert.equal(failures[0].status, 3);
  assert.equal(failures[0].json.reasonCode, "no-matching-alias");
  assert.equal(fs.readdirSync(path.join(fixture.stateRoot, "leases")).length, 1);
});

test("direct local CLI serializes concurrent pin creation for the same alias", async () => {
  const fixture = makeFixture();
  assert.equal(runCli(fixture, "host", "init").status, 0);

  const [left, right] = await Promise.all([
    runCliAsync(
      fixture,
      { SIMBROKER_LOCAL_ONLY: "1" },
      "pin",
      "create",
      "--repo-root",
      fixture.repoRoot,
      "--purpose",
      "agent-ui-session",
      "--alias",
      "ui-1",
    ),
    runCliAsync(
      fixture,
      { SIMBROKER_LOCAL_ONLY: "1" },
      "pin",
      "create",
      "--repo-root",
      fixture.repoRoot,
      "--purpose",
      "agent-ui-session",
      "--alias",
      "ui-1",
    ),
  ]);

  assert.equal(left.status, 0);
  assert.equal(right.status, 0);
  assert.equal(fs.readdirSync(path.join(fixture.stateRoot, "pins")).length, 1);
  assert.ok([left.json.unchanged, right.json.unchanged].includes(true));
});

test("capacity apply contains snapshot refresh failures after finalization", () => {
  const fixture = makeCapacityFixture();
  assert.equal(runCli(fixture, "host", "init").status, 0);
  const snapshotDirectory = path.join(fixture.root, "snapshot-directory");
  fs.mkdirSync(snapshotDirectory);
  const paths = {
    ...resolveBrokerPaths({
      hostConfigPath: fixture.hostConfigPath,
      projectFilePath: fixture.projectFilePath,
      stateRoot: fixture.stateRoot,
    }),
    appSnapshotPath: snapshotDirectory,
  };
  const baseOptions = {
    processExists: () => true,
    purposeId: "agent-ipad-session",
    simctlAdapter: fixture.simctl.adapter,
  };
  const preview = executeBrokerCommand(paths, {
    command: "reconcile",
    group: "capacity",
    options: baseOptions,
  });

  const applied = executeBrokerCommand(paths, {
    command: "reconcile",
    group: "capacity",
    options: {
      ...baseOptions,
      actorId: "operator",
      actorType: "human",
      apply: true,
      confirmPlanId: preview.planId,
    },
  });

  assert.equal(applied.status, "applied");
  assert.equal(applied.snapshotRefresh.ok, false);
  assert.equal(readJson(fixture.hostConfigPath).aliases.some((alias) => alias.alias === "ipad-1"), true);
  const transactions = fs.readdirSync(paths.capacityTransactionsDir)
    .map((entry) => readJson(path.join(paths.capacityTransactionsDir, entry)));
  assert.equal(transactions.some((transaction) => transaction.status === "finalized"), true);
});

test("idle cleanup preview skips final app snapshot refresh", () => {
  const fixture = makeFixture();
  assert.equal(runCli(fixture, "host", "init").status, 0);
  const snapshotDirectory = path.join(fixture.root, "snapshot-directory");
  fs.mkdirSync(snapshotDirectory);
  const paths = {
    ...resolveBrokerPaths({
      hostConfigPath: fixture.hostConfigPath,
      projectFilePath: fixture.projectFilePath,
      stateRoot: fixture.stateRoot,
    }),
    appSnapshotPath: snapshotDirectory,
  };

  const preview = executeBrokerCommand(paths, {
    command: "cleanup",
    group: "idle",
    options: {
      processExists: () => true,
      simctlAdapter: fixture.simctl.adapter,
    },
  });

  assert.equal(preview.mode, "preview");
  assert.equal(preview.status, "no_changes");
});

test("lease acquire preserves the committed lease when snapshot refresh fails", () => {
  const fixture = makeFixture();
  assert.equal(runCli(fixture, "host", "init").status, 0);
  const snapshotDirectory = path.join(fixture.root, "snapshot-directory");
  fs.mkdirSync(snapshotDirectory);
  const paths = {
    ...resolveBrokerPaths({
      hostConfigPath: fixture.hostConfigPath,
      projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
      stateRoot: fixture.stateRoot,
    }),
    appSnapshotPath: snapshotDirectory,
  };

  const acquired = executeBrokerCommand(paths, {
    command: "acquire",
    group: "lease",
    options: {
      actorId: "agent-snapshot-warning",
      actorType: "agent",
      ownerPid: process.pid,
      processExists: (pid) => pid === process.pid,
      projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
      purposeId: "agent-ui-session",
      simctlAdapter: fixture.simctl.adapter,
    },
  });

  assert.equal(acquired.ok, true);
  assert.equal(acquired.snapshotRefresh.ok, false);
  assert.equal(fs.existsSync(path.join(paths.leasesDir, `${acquired.lease.leaseId}.json`)), true);
});

test("lease acquire preserves the committed lease when idle policy metadata is malformed", () => {
  const fixture = makeFixture();
  assert.equal(runCli(fixture, "host", "init").status, 0);
  fs.writeFileSync(path.join(fixture.stateRoot, "idle-policy.json"), "{not-json\n");
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });

  const acquired = executeBrokerCommand(paths, {
    command: "acquire",
    group: "lease",
    options: {
      actorId: "agent-idle-policy-warning",
      actorType: "agent",
      ownerPid: process.pid,
      processExists: (pid) => pid === process.pid,
      projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
      purposeId: "agent-ui-session",
      simctlAdapter: fixture.simctl.adapter,
    },
  });

  assert.equal(acquired.ok, true);
  assert.equal(acquired.snapshotRefresh, undefined);
  assert.equal(fs.existsSync(path.join(paths.leasesDir, `${acquired.lease.leaseId}.json`)), true);
  assert.equal(readJson(paths.appSnapshotPath).idle.configured, false);
});

test("lease acquire CLI preserves committed leases when idle policy metadata is malformed", () => {
  const fixture = makeFixture();
  assert.equal(runCli(fixture, "host", "init").status, 0);
  fs.writeFileSync(path.join(fixture.stateRoot, "idle-policy.json"), "{not-json\n");

  const acquired = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--json",
  );

  assert.equal(acquired.status, 0, acquired.stderr);
  assert.equal(acquired.json.snapshotRefresh, undefined);
  assert.deepEqual(acquired.json.scheduler, {
    active: false,
    limitation: "invalid-config",
  });
  assert.equal(fs.existsSync(path.join(fixture.stateRoot, "leases", `${acquired.json.lease.leaseId}.json`)), true);
});

test("idle mutations surface final snapshot refresh failures", () => {
  const fixture = makeFixture();
  assert.equal(runCli(fixture, "host", "init").status, 0);
  const snapshotDirectory = path.join(fixture.root, "snapshot-directory");
  fs.mkdirSync(snapshotDirectory);
  const paths = {
    ...resolveBrokerPaths({
      hostConfigPath: fixture.hostConfigPath,
      projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
      stateRoot: fixture.stateRoot,
    }),
    appSnapshotPath: snapshotDirectory,
  };

  assert.throws(() => {
    executeBrokerCommand(paths, {
      command: "enable",
      group: "idle",
      options: {
        actorId: "operator",
        actorType: "human",
        graceSeconds: 60,
        processExists: () => true,
        simctlAdapter: fixture.simctl.adapter,
      },
    });
  }, (error) =>
    error.payload?.reasonCode === "snapshot-refresh-failed"
    && error.payload?.error === "Failed to refresh the app snapshot after the idle command committed."
    && error.cause?.message.includes(snapshotDirectory)
    && error.payload?.cause === undefined
    && !JSON.stringify(error.payload).includes(snapshotDirectory));
  assert.equal(readJson(paths.idlePolicyPath).graceSeconds, 60);
});

test("malformed idle policy does not break non-scheduler direct commands", () => {
  const fixture = makeFixture();
  assert.equal(runCli(fixture, "host", "init").status, 0);
  const acquired = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--json",
  );
  assert.equal(acquired.status, 0);
  fs.writeFileSync(path.join(fixture.stateRoot, "idle-policy.json"), "{not-json\n");

  const help = runCli(fixture, "help", "--json");
  assert.equal(help.status, 0);
  assert.equal("scheduler" in help.json, false);

  const hostStatus = runCli(fixture, "host", "status", "--json");
  assert.equal(hostStatus.status, 0);
  assert.equal(hostStatus.json.snapshotRefresh, undefined);

  const release = runCli(fixture, "lease", "release", "--lease-id", acquired.json.lease.leaseId, "--json");
  assert.equal(release.status, 0);
  assert.equal(release.json.snapshotRefresh, undefined);
});

test("final snapshot refresh propagates process sampler timeouts", () => {
  const fixture = makeFixture();
  const projectFilePath = path.join(fixture.repoRoot, ".simulator-broker/project.json");
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath,
    stateRoot: fixture.stateRoot,
  });
  const samplerTimeout = new Error("process sampler timed out");
  samplerTimeout.reasonCode = "process-sampler-timeout";

  assert.equal(runCli(fixture, "host", "init").status, 0);
  executeBrokerCommand(paths, {
    command: "acquire",
    group: "lease",
    options: {
      actorId: "agent-sampler-timeout",
      actorType: "agent",
      ownerPid: process.pid,
      processExists: (pid) => pid === process.pid,
      projectFilePath,
      purposeId: "agent-ui-session",
      simctlAdapter: fixture.simctl.adapter,
    },
  });

  assert.throws(
    () => executeBrokerCommand(paths, {
      command: "show",
      group: "project",
      options: {
        processExists: (pid) => pid === process.pid,
        processSampler: () => {
          throw samplerTimeout;
        },
        projectFilePath,
        simctlAdapter: fixture.simctl.adapter,
      },
    }),
    (error) => error.reasonCode === "process-sampler-timeout",
  );
});

test("final snapshot refresh propagates simctl timeouts", () => {
  const fixture = makeFixture();
  const projectFilePath = path.join(fixture.repoRoot, ".simulator-broker/project.json");
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath,
    stateRoot: fixture.stateRoot,
  });
  const simctlTimeout = new Error("simctl list devices timed out");
  simctlTimeout.command = ["xcrun", "simctl", "list", "--json", "devices"];
  simctlTimeout.timedOut = true;
  simctlTimeout.timeoutMs = SIMCTL_COMMAND_TIMEOUT_MS;
  const timedOutSimctl = {
    ...fixture.simctl.adapter,
    listDevices() {
      throw simctlTimeout;
    },
  };

  assert.equal(runCli(fixture, "host", "init").status, 0);

  assert.throws(
    () => executeBrokerCommand(paths, {
      command: "show",
      group: "project",
      options: {
        projectFilePath,
        simctlAdapter: timedOutSimctl,
      },
    }),
    (error) => error.payload?.reasonCode === "simctl-timeout"
      && error.payload?.timeoutMs === SIMCTL_COMMAND_TIMEOUT_MS
      && error.payload?.command?.join(" ") === "xcrun simctl list --json devices",
  );
});

test("capacity check reports malformed project JSON as an invalid request", () => {
  const fixture = makeCapacityFixture();
  assert.equal(runCli(fixture, "host", "init").status, 0);
  fs.writeFileSync(fixture.projectFilePath, "{not-json\n");

  const result = runCli(
    fixture,
    "capacity",
    "check",
    "--repo-root",
    fixture.repoRoot,
    "--json",
  );

  assert.equal(result.status, 2);
  assert.equal(result.json.exitCode, 2);
  assert.equal(result.json.reasonCode, "invalid-config");
  assert.equal(result.stderr, "");
});

test("capacity check and preview keep malformed host JSON errors public-safe", () => {
  const fixture = makeCapacityFixture();
  fs.writeFileSync(fixture.hostConfigPath, "{not-json\n");

  for (const command of ["check", "reconcile"]) {
    const result = runCli(
      fixture,
      "capacity",
      command,
      "--repo-root",
      fixture.repoRoot,
      "--json",
    );

    assert.equal(result.status, 2);
    assert.equal(result.json.exitCode, 2);
    assert.equal(result.json.reasonCode, "invalid-config");
    assert.equal("stack" in result.json, false);
    assert.equal(result.stdout.includes(fixture.root), false);
    assert.equal(result.stderr, "");
  }
});

test("capacity commands reject unknown flags before mutation", () => {
  const fixture = makeCapacityFixture();
  assert.equal(runCli(fixture, "host", "init").status, 0);

  const result = runCli(
    fixture,
    "capacity",
    "check",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ipad-session",
    "--local-detail",
  );

  assert.equal(result.status, 2);
  assert.equal(result.json.reasonCode, "invalid-flag");
  assert.equal(readJson(fixture.hostConfigPath).aliases.length, 1);
});

test("lease contain requests include the active client pid", () => {
  const fixture = makeFixture();
  const { flags } = parseArgs([
    "--lease-file", path.join(fixture.root, "lease.json"),
    "--reason", "forced-abort",
  ]);
  const request = createCommandRequest({
    projectFilePath: fixture.projectFilePath,
  }, "lease", "contain", flags);

  assert.equal(request.options.requesterPid, process.pid);
});

test("lease acquire defaults owner pid to the caller parent process when the flag is omitted", () => {
  const fixture = makeFixture();
  const { flags } = parseArgs([
    "--purpose", "agent-ui-session",
    "--lease-file", path.join(fixture.root, "lease.json"),
  ]);
  const request = createCommandRequest({
    projectFilePath: fixture.projectFilePath,
  }, "lease", "acquire", flags);

  assert.equal(request.options.ownerPid, process.ppid);
  assert.equal(Object.hasOwn(request.options, "ownerPgid"), false);
});

test("lease register-process omits absent command and pgid fields", () => {
  const fixture = makeFixture();
  const { flags } = parseArgs([
    "--lease-file", path.join(fixture.root, "lease.json"),
    "--pid", String(process.pid),
  ]);
  const request = createCommandRequest({
    projectFilePath: fixture.projectFilePath,
  }, "lease", "register-process", flags);

  assert.equal(Object.hasOwn(request.options, "command"), false);
  assert.equal(Object.hasOwn(request.options, "commandPgid"), false);
  assert.equal(Object.hasOwn(request.options, "ownerPid"), false);
  assert.equal(Object.hasOwn(request.options, "ownerPgid"), false);
});

test("lease contain accepts equals-form reason flags", () => {
  const fixture = makeFixture();
  const { flags } = parseArgs([
    "--lease-file", path.join(fixture.root, "lease.json"),
    "--reason=memory-ceiling",
  ]);
  const request = createCommandRequest({
    projectFilePath: fixture.projectFilePath,
  }, "lease", "contain", flags);

  assert.equal(request.options.reason, "memory-ceiling");
});

test("lease contain honors explicit false for kill-owner", () => {
  const fixture = makeFixture();
  const { flags } = parseArgs([
    "--lease-file", path.join(fixture.root, "lease.json"),
    "--kill-owner=false",
  ]);
  const request = createCommandRequest({
    projectFilePath: fixture.projectFilePath,
  }, "lease", "contain", flags);

  assert.equal(request.options.killOwner, false);
});

test("lease contain honors explicit false for diagnostic capture", () => {
  const fixture = makeFixture();
  const { flags } = parseArgs([
    "--lease-file", path.join(fixture.root, "lease.json"),
    "--capture-diagnostics=false",
  ]);
  const request = createCommandRequest({
    projectFilePath: fixture.projectFilePath,
  }, "lease", "contain", flags);

  assert.equal(request.options.captureDiagnostics, false);
});

test("lease contain rejects invalid diagnostic capture values", () => {
  const fixture = makeFixture();
  const { flags } = parseArgs([
    "--lease-file", path.join(fixture.root, "lease.json"),
    "--capture-diagnostics=no",
  ]);

  assert.throws(() => {
    createCommandRequest({
      projectFilePath: fixture.projectFilePath,
    }, "lease", "contain", flags);
  }, (error) => error.payload?.reasonCode === "invalid-flag" && error.payload.flag === "capture-diagnostics");
});

test("simulator lifecycle requests honor explicit false for force-override", () => {
  const fixture = makeFixture();
  const { flags } = parseArgs([
    "--alias", "ui-1",
    "--actor-type", "human",
    "--actor-id", "operator-1",
    "--force-override=false",
    "--override-reason", "operator declined override",
    "--expected-alias", "ui-1",
    "--expected-lease-id", "lease-123",
  ]);
  const request = createCommandRequest({
    projectFilePath: fixture.projectFilePath,
  }, "simulators", "repair", flags);

  assert.equal(request.options.forceOverride, false);
});

test("destructive commands reject unknown flags before constructing options", () => {
  const fixture = makeFixture();
  const paths = {
    projectFilePath: fixture.projectFilePath,
  };
  const cases = [
    {
      args: ["--alias", "ui-1", "--state-rooot", fixture.stateRoot],
      command: "erase",
      flag: "state-rooot",
      group: "simulators",
    },
    {
      args: ["--pid", String(process.pid), "--memory-ceilling-mib", "4096"],
      command: "register-process",
      flag: "memory-ceilling-mib",
      group: "lease",
    },
    {
      args: ["--lease-id", "lease-123", "--lease-iid", "lease-456"],
      command: "release",
      flag: "lease-iid",
      group: "lease",
    },
    {
      args: ["--lease-id", "lease-123", "--term-wiat-ms", "1000"],
      command: "contain",
      flag: "term-wiat-ms",
      group: "lease",
    },
    {
      args: ["--alias", "ui-1", "--purpose", "agent-ui-session", "--purpsoe", "typo"],
      command: "create",
      flag: "purpsoe",
      group: "pin",
    },
    {
      args: ["--alias", "ui-1", "--allias", "ui-2"],
      command: "clear",
      flag: "allias",
      group: "pin",
    },
  ];

  for (const item of cases) {
    const { flags } = parseArgs(item.args);
    assert.throws(() => {
      createCommandRequest(paths, item.group, item.command, flags);
    }, (error) => error.payload?.reasonCode === "invalid-flag" && error.payload.flag === item.flag);
  }
});

test("lease acquire rejects unknown flags before constructing options", () => {
  const fixture = makeFixture();
  const { flags } = parseArgs([
    "--purpose", "agent-ui-session",
    "--memory-ceilling-mib", "4096",
  ]);

  assert.throws(() => {
    createCommandRequest({
      projectFilePath: fixture.projectFilePath,
    }, "lease", "acquire", flags);
  }, (error) => error.payload?.reasonCode === "invalid-flag" && error.payload.flag === "memory-ceilling-mib");
});

test("lease release request carries requester actor flags", () => {
  const fixture = makeFixture();
  const { flags } = parseArgs([
    "--lease-id", "lease-123",
    "--actor-type", "human",
    "--actor-id", "operator-1",
  ]);
  const request = createCommandRequest({
    projectFilePath: fixture.projectFilePath,
  }, "lease", "release", flags);

  assert.equal(request.options.actorType, "human");
  assert.equal(request.options.actorId, "operator-1");
});

test("idle command requests enforce explicit policy and confirmed cleanup shapes", () => {
  const { flags: enableFlags } = parseArgs([
    "--grace-seconds", "60",
    "--actor-type", "human",
    "--actor-id", "operator-1",
  ]);
  const enable = createCommandRequest({}, "idle", "enable", enableFlags);
  assert.deepEqual(enable.options, {
    actorId: "operator-1",
    actorType: "human",
    graceSeconds: 60,
  });

  for (const value of ["59", "86401"]) {
    const { flags: outOfRangeFlags } = parseArgs([
      "--grace-seconds",
      value,
      "--actor-type",
      "human",
      "--actor-id",
      "operator-1",
    ]);
    assert.throws(() => {
      createCommandRequest({}, "idle", "enable", outOfRangeFlags);
    }, (error) => error.payload?.reasonCode === "invalid-flag");
  }

  const { flags: cleanupFlags } = parseArgs([
    "--apply",
    "--confirm", "plan-1",
    "--actor-type", "human",
    "--actor-id", "operator-1",
  ]);
  const cleanup = createCommandRequest({}, "idle", "cleanup", cleanupFlags);
  assert.deepEqual(cleanup.options, {
    actorId: "operator-1",
    actorType: "human",
    apply: true,
    confirmPlanId: "plan-1",
  });

  const { flags: invalidPreviewFlags } = parseArgs(["--actor-id", "operator-1"]);
  assert.throws(() => {
    createCommandRequest({}, "idle", "cleanup", invalidPreviewFlags);
  }, (error) => error.payload?.reasonCode === "invalid-flag");
});

test("events watch follow rejects non-positive poll intervals", () => {
  for (const value of ["0", "-1"]) {
    const { flags } = parseArgs([
      "--follow",
      "--json-lines",
      "--poll-interval-ms",
      value,
    ]);
    assert.throws(() => {
      createCommandRequest({}, "events", "watch", flags);
    }, (error) => error.payload?.reasonCode === "invalid-flag");
  }
});

test("events watch honors explicit false for follow", () => {
  const { flags } = parseArgs([
    "--follow=false",
    "--limit",
    "5",
  ]);
  const request = createCommandRequest({}, "events", "watch", flags);

  assert.equal(request.type, "command");
  assert.equal(request.options.limit, 5);
  assert.equal(Object.hasOwn(request.options, "follow"), false);
});

test("events watch can write json lines without following", () => {
  const { flags } = parseArgs([
    "--follow=false",
    "--json-lines",
    "--limit",
    "5",
  ]);
  const request = createCommandRequest({}, "events", "watch", flags);

  assert.equal(request.type, "events-stream");
  assert.equal(request.options.follow, false);
  assert.equal(request.options.jsonLines, true);
  assert.equal(request.options.limit, 5);
});

test("events watch rejects negative limits", () => {
  const { flags } = parseArgs([
    "--limit",
    "-1",
  ]);

  assert.throws(() => {
    createCommandRequest({}, "events", "watch", flags);
  }, (error) => error.payload?.reasonCode === "invalid-flag");
});

test("events watch rejects unknown flags for one-shot and stream requests", () => {
  for (const args of [
    ["--folow"],
    ["--follow", "--json-lines", "--folow"],
  ]) {
    const { flags } = parseArgs(args);
    assert.throws(() => {
      createCommandRequest({}, "events", "watch", flags);
    }, (error) => error.payload?.reasonCode === "invalid-flag" && error.payload.flag === "folow");
  }
});

test("service control commands reject unknown flags before dispatch", () => {
  const fixture = makeFixture();

  const result = runCli(fixture, "service", "status", "--state-rooot", fixture.stateRoot);

  assert.equal(result.status, 2);
  assert.equal(result.json.reasonCode, "invalid-flag");
  assert.equal(result.json.flag, "state-rooot");
});

test("service containment timeout scales with term wait and diagnostics", () => {
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "contain",
    group: "lease",
    options: {},
  }), 885_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "contain",
    group: "lease",
    options: {
      termWaitMs: 60_000,
    },
  }), 945_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "contain",
    group: "lease",
    options: {
      captureDiagnostics: true,
    },
  }), 905_000);
});

test("service lease acquire timeout includes reset and boot-on-acquire budgets", () => {
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "acquire",
    group: "lease",
    options: {},
  }), 1_425_250);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "acquire",
    group: "lease",
    options: {
      leaseLockTimeoutMilliseconds: 90_000,
      resetLockTimeoutMilliseconds: 120_000,
      resetSettleMilliseconds: 500,
    },
  }), 1_545_500);
});

test("service idle timeouts cover serialized state, snapshots, and bounded shutdown work", () => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "status",
    group: "idle",
    options: {},
  }, { paths }), 885_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "cleanup",
    group: "idle",
    options: { apply: true },
  }, { paths }), 1_125_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "reconcile",
    group: "idle",
    options: {},
  }, { paths }), 1_125_000);
});

test("service stop timeout adds serialized command drain and idle reconciliation budgets", () => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });
  const idleReconciliationBudgetMilliseconds = serviceCommandTimeoutMs({
    command: "reconcile",
    group: "idle",
    options: {},
  }, { paths });
  const activeCommandDrainTimeoutMilliseconds = idleReconciliationBudgetMilliseconds + 25_000;

  assert.equal(
    serviceStopTimeoutMs(paths, { activeCommandDrainTimeoutMilliseconds }),
    idleReconciliationBudgetMilliseconds + activeCommandDrainTimeoutMilliseconds,
  );
});

test("service mutation timeouts cover broker lock waits", () => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });

  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "init",
    group: "host",
    options: {},
  }), 885_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "init",
    group: "host",
    options: {
      bootstrapConfig: true,
      hostBootstrapRetirementCount: 0,
    },
  }), 5_285_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "init",
    group: "host",
    options: {
      bootstrapConfig: true,
      hostBootstrapRetirementCount: 6,
    },
  }), 7_095_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "init",
    group: "host",
    options: {
      bootstrapConfig: true,
    },
  }, {
    paths,
  }), 885_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "init",
    group: "host",
    options: {
      bootstrapConfig: true,
      force: true,
    },
  }, {
    paths,
  }), 6_135_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "release",
    group: "lease",
    options: {},
  }), 885_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "status",
    group: "host",
    options: {},
  }), 885_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "status",
    group: "doctor",
    options: {},
  }), 885_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "explain",
    group: "lease",
    options: {},
  }), 885_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "create",
    group: "pin",
    options: {},
  }), 885_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "boot",
    group: "simulators",
    options: {},
  }), 1_125_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "shutdown",
    group: "simulators",
    options: {},
  }), 1_005_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "erase",
    group: "simulators",
    options: {},
  }), 1_125_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "repair",
    group: "simulators",
    options: {},
  }), 2_145_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "repair",
    group: "simulators",
    options: {
      capacityLockTimeoutMilliseconds: 120_000,
      leaseLockTimeoutMilliseconds: 90_000,
    },
  }), 2_265_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "repair",
    group: "simulators",
    options: {},
  }, {
    pendingRetirementCount: 3,
  }), 2_865_000);
});

test("service command transfer timeout reserves queue budget before dispatch", () => {
  const request = {
    command: "release",
    group: "lease",
    options: {},
  };
  assert.equal(serviceCommandExecutionTimeoutMs(request), 885_000);
  assert.equal(serviceCommandTimeoutMs(request), 945_000);
});

test("service command timeout budgets stale containment sampling from lease files", () => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    stateRoot: fixture.stateRoot,
  });
  writeJson(path.join(paths.leasesDir, "stale-containment-1.json"), {
    leaseId: "stale-containment-1",
    runtime: {
      commandPid: 4242,
    },
  });
  writeJson(path.join(paths.leasesDir, "stale-containment-2.json"), {
    leaseId: "stale-containment-2",
    runtime: {
      ownerPgid: 5252,
    },
  });
  const staleContainmentBudgetMs = 2 * (
    (STALE_CONTAINMENT_PROCESS_SAMPLER_INVOCATIONS * PROCESS_SAMPLER_TIMEOUT_MS)
    + DEFAULT_CONTAINMENT_TERM_WAIT_MS
    + DEFAULT_CONTAINMENT_POST_KILL_WAIT_MS
  );
  const request = {
    command: "release",
    group: "lease",
    options: {},
  };

  assert.equal(serviceCommandExecutionTimeoutMs(request, { paths }), 885_000 + (2 * staleContainmentBudgetMs));
  assert.equal(serviceCommandTimeoutMs(request, { paths }), 945_000 + (2 * staleContainmentBudgetMs));
});

test("service startup timeout covers startup reconciliation, snapshot, and lock work", () => {
  assert.equal(
    serviceStartupTimeoutMs(),
    (12 * SIMCTL_COMMAND_TIMEOUT_MS) + (4 * PROCESS_SAMPLER_TIMEOUT_MS) + 120_000 + 5_000,
  );
});

test("service startup timeout budgets stale containment from lease files", () => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    stateRoot: fixture.stateRoot,
  });
  writeJson(path.join(paths.leasesDir, "stale-containment-1.json"), {
    leaseId: "stale-containment-1",
    runtime: {
      commandPid: 4242,
    },
  });
  writeJson(path.join(paths.leasesDir, "stale-containment-2.json"), {
    leaseId: "stale-containment-2",
    runtime: {
      ownerPgid: 5252,
    },
  });
  const staleContainmentBudgetMs = 2 * (
    (STALE_CONTAINMENT_PROCESS_SAMPLER_INVOCATIONS * PROCESS_SAMPLER_TIMEOUT_MS)
    + DEFAULT_CONTAINMENT_TERM_WAIT_MS
    + DEFAULT_CONTAINMENT_POST_KILL_WAIT_MS
  );

  assert.equal(
    serviceStartupTimeoutMs({ paths }),
    (8 * SIMCTL_COMMAND_TIMEOUT_MS)
      + (4 * PROCESS_SAMPLER_TIMEOUT_MS)
      + 120_000
      + staleContainmentBudgetMs
      + 5_000,
  );
});

test("service start stops waiting when the spawned brokerd exits before readiness", async () => {
  const fixture = makeFixture();
  assert.equal(runCli(fixture, "host", "init").status, 0);
  fs.writeFileSync(path.join(fixture.stateRoot, "idle-policy.json"), "{not-json\n");

  const result = await runCliAsyncWithTimeout(fixture, {}, 3000, "service", "start");

  assert.equal(result.timedOut, false, result.stderr);
  assert.equal(result.status, 3);
  assert.equal(result.json.reasonCode, "service-unavailable");
});

test("service start stops waiting when brokerd exits even if a startup lock directory remains", async () => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    stateRoot: fixture.stateRoot,
  });
  assert.equal(runCli(fixture, "host", "init").status, 0);
  fs.writeFileSync(path.join(fixture.stateRoot, "idle-policy.json"), "{not-json\n");
  fs.mkdirSync(paths.serviceLockDir, { recursive: true });
  writeJson(paths.serviceLockOwnerPath, {
    pid: 999999999,
    startedAt: new Date().toISOString(),
    token: "dead-startup-lock",
  });

  const result = await runCliAsyncWithTimeout(fixture, {}, 4000, "service", "start");

  assert.equal(result.timedOut, false, result.stderr);
  assert.equal(result.status, 3);
  assert.equal(result.json.reasonCode, "service-unavailable");
});

test("service probe treats request timeout as unavailable instead of missing", async (t) => {
  const root = makeTempDir();
  const socketPath = path.join(root, "busy.sock");
  const server = http.createServer(() => {});
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await listen(server, socketPath);

  const paths = resolveBrokerPaths({
    serviceSocketPath: socketPath,
    stateRoot: path.join(root, "state"),
  });

  await assert.rejects(
    () => probeService(paths, { timeoutMs: 25 }),
    (error) => error.payload?.reasonCode === "service-unavailable",
  );
});

test("CLI waits for the service identity probe before routing command requests", async (t) => {
  const fixture = makeFixture();
  const socketPath = path.join(fixture.root, "slow-status.sock");
  let commandRequests = 0;
  const commandBodies = [];
  const server = http.createServer((request, response) => {
    if (request.url === "/v1/service/status") {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`${JSON.stringify({
          ok: true,
          running: true,
          service: {
            hostConfigPath: fixture.hostConfigPath,
            pid: process.pid,
            socketPath,
            stateRoot: fixture.stateRoot,
          },
        })}\n`);
      }, 350);
      return;
    }

    if (request.url === "/v1/command") {
      commandRequests += 1;
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        commandBodies.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`${JSON.stringify({
          hostId: "slow-status-host",
          ok: true,
        })}\n`);
      });
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}\n");
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await listen(server, socketPath);

  const result = await runCliAsync(fixture, {}, "--service-socket", socketPath, "host", "status");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.transport, "service");
  assert.equal(result.json.hostId, "slow-status-host");
  assert.equal(commandRequests, 1);
  assert.deepEqual(commandBodies[0].expectedServiceIdentity, {
    hostConfigPath: fixture.hostConfigPath,
    pid: process.pid,
    socketPath,
    stateRoot: fixture.stateRoot,
  });
});

test("service client rejects malformed JSON responses through BrokerError", async (t) => {
  const root = makeTempDir();
  const socketPath = path.join(root, "malformed.sock");
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith("/v1/events/stream")) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end("{not-json");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{not-json");
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await listen(server, socketPath);

  const paths = resolveBrokerPaths({
    serviceSocketPath: socketPath,
    stateRoot: path.join(root, "state"),
  });

  await assert.rejects(
    () => executeServiceCommand(paths, { command: "status", group: "host" }, { timeoutMs: 250 }),
    (error) =>
      error.payload?.reasonCode === "service-unavailable"
        && /JSON/.test(error.message),
  );
  await assert.rejects(
    () => streamServiceEvents(paths, {}, { write() {} }, { timeoutMs: 250 }),
    (error) =>
      error.payload?.reasonCode === "service-unavailable"
        && /JSON/.test(error.message),
  );
});

test("service command waits abort immediately when setup cancellation fires", async (t) => {
  const root = makeTempDir();
  const socketPath = path.join(root, "cancelled-command.sock");
  let requestReceivedResolve;
  const requestReceived = new Promise((resolve) => {
    requestReceivedResolve = resolve;
  });
  const server = http.createServer((_request, _response) => {
    requestReceivedResolve();
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await listen(server, socketPath);
  const paths = resolveBrokerPaths({
    serviceSocketPath: socketPath,
    stateRoot: path.join(root, "state"),
  });
  const abortController = new AbortController();
  const command = executeServiceCommand(
    paths,
    { command: "status", group: "doctor", options: {} },
    { signal: abortController.signal, timeoutMs: 60_000 },
  );

  await requestReceived;
  abortController.abort();

  await assert.rejects(command, (error) => error.payload?.reasonCode === "service-unavailable");
});

test("service client rejects aborted event streams", async (t) => {
  const root = makeTempDir();
  const socketPath = path.join(root, "aborted-stream.sock");
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write("{\"eventId\":\"partial\"");
    setImmediate(() => {
      response.destroy(new Error("simulated stream failure"));
    });
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await listen(server, socketPath);

  const paths = resolveBrokerPaths({
    serviceSocketPath: socketPath,
    stateRoot: path.join(root, "state"),
  });
  const neverSettled = new Error("aborted event stream did not reject");

  await assert.rejects(
    () => Promise.race([
      streamServiceEvents(paths, { follow: true }, { write() {} }, { timeoutMs: null }),
      new Promise((_, reject) => {
        setTimeout(() => reject(neverSettled), 500);
      }),
    ]),
    (error) => error !== neverSettled && error.payload?.reasonCode === "service-unavailable",
  );
});

test("service client applies backpressure while forwarding event streams", async (t) => {
  const root = makeTempDir();
  const socketPath = path.join(root, "backpressure-stream.sock");
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write("{\"eventId\":\"first\"}\n");
    setTimeout(() => {
      response.end("{\"eventId\":\"second\"}\n");
    }, 25);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await listen(server, socketPath);

  const paths = resolveBrokerPaths({
    serviceSocketPath: socketPath,
    stateRoot: path.join(root, "state"),
  });
  const chunks = [];
  let firstChunkResolve;
  const firstChunk = new Promise((resolve) => {
    firstChunkResolve = resolve;
  });
  const output = new EventEmitter();
  output.write = (chunk) => {
    chunks.push(String(chunk));
    firstChunkResolve();
    return chunks.length > 1;
  };

  const streamPromise = streamServiceEvents(paths, { follow: true }, output, { timeoutMs: null });
  await firstChunk;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(chunks.length, 1);

  output.emit("drain");
  const result = await streamPromise;

  assert.deepEqual(result, { handled: true });
  assert.deepEqual(chunks, [
    "{\"eventId\":\"first\"}\n",
    "{\"eventId\":\"second\"}\n",
  ]);
});

test("local event follow loop stops when its abort signal fires", async () => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });
  const abortController = new AbortController();
  let sleepCount = 0;

  const result = await streamEventsLocal(paths, {
    follow: true,
    pollIntervalMs: 1,
  }, {
    signal: abortController.signal,
    sleepFn: async () => {
      sleepCount += 1;
      abortController.abort();
    },
    writeEventLine() {},
  });

  assert.equal(result.cancelled, true);
  assert.equal(sleepCount, 1);
});

test("local event streaming waits for async event writers", async () => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });
  const writeSteps = [];

  assert.equal(runCli(fixture, "host", "init").status, 0);

  const result = await streamEventsLocal(paths, {
    follow: false,
    limit: 1,
  }, {
    async writeEventLine() {
      writeSteps.push("start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      writeSteps.push("finish");
    },
  });

  assert.equal(result.handled, true);
  assert.deepEqual(writeSteps, ["start", "finish"]);
});

test("local event follow advances past filtered unmatched events", async () => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });
  const abortController = new AbortController();
  const emitted = [];
  let sleepCount = 0;
  const leaseFile = path.join(fixture.root, "filtered-lease.json");

  assert.equal(runCli(fixture, "host", "init").status, 0);

  const result = await streamEventsLocal(paths, {
    follow: true,
    pollIntervalMs: 1,
    type: "pin.created",
  }, {
    signal: abortController.signal,
    sleepFn: async () => {
      sleepCount += 1;
      if (sleepCount === 1) {
        assert.equal(runCli(
          fixture,
          "lease",
          "acquire",
          "--repo-root",
          fixture.repoRoot,
          "--purpose",
          "agent-ui-session",
          "--actor-id",
          "agent-filtered",
          "--actor-type",
          "agent",
          "--owner-pid",
          String(process.pid),
          "--lease-file",
          leaseFile,
        ).status, 0);
      }
      if (sleepCount >= 2) {
        abortController.abort();
      }
    },
    writeEventLine(event) {
      emitted.push(event);
    },
  });

  assert.equal(result.cancelled, true);
  assert.deepEqual(emitted, []);
  assert.equal(result.cursor, readEventsBroker(paths).events.at(-1).eventId);
});

test("local event follow with a limit pages bursts without dropping older unseen events", async () => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });
  const abortController = new AbortController();
  const emitted = [];
  let sleepCount = 0;
  const firstLeaseFile = path.join(fixture.root, "first-burst-lease.json");
  const secondLeaseFile = path.join(fixture.root, "second-burst-lease.json");

  assert.equal(runCli(fixture, "host", "init").status, 0);

  const result = await streamEventsLocal(paths, {
    follow: true,
    limit: 2,
    pollIntervalMs: 1,
  }, {
    signal: abortController.signal,
    sleepFn: async () => {
      sleepCount += 1;
      if (sleepCount === 1) {
        assert.equal(runCli(
          fixture,
          "lease",
          "acquire",
          "--repo-root",
          fixture.repoRoot,
          "--purpose",
          "agent-ui-session",
          "--actor-id",
          "agent-burst-1",
          "--actor-type",
          "agent",
          "--owner-pid",
          String(process.pid),
          "--lease-file",
          firstLeaseFile,
        ).status, 0);
        assert.equal(runCli(fixture, "lease", "release", "--lease-file", firstLeaseFile).status, 0);
        assert.equal(runCli(
          fixture,
          "lease",
          "acquire",
          "--repo-root",
          fixture.repoRoot,
          "--purpose",
          "agent-ui-session",
          "--actor-id",
          "agent-burst-2",
          "--actor-type",
          "agent",
          "--owner-pid",
          String(process.pid),
          "--lease-file",
          secondLeaseFile,
        ).status, 0);
      }
      if (sleepCount >= 4) {
        abortController.abort();
      }
    },
    writeEventLine(event) {
      emitted.push(event);
    },
  });

  assert.equal(result.cancelled, true);
  assert.deepEqual(
    emitted
      .filter((event) => event.type.startsWith("lease."))
      .map((event) => [event.type, event.payload.actorId ?? event.payload.previousActorId]),
    [
      ["lease.acquired", "agent-burst-1"],
      ["lease.released", "agent-burst-1"],
      ["lease.acquired", "agent-burst-2"],
    ],
  );
});

test("service capacity apply uses a dedicated mutation timeout", () => {
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "check",
    group: "capacity",
    options: {},
  }), 395_000);
  assert.equal(serviceCommandTimeoutMs({
    command: "check",
    group: "capacity",
    options: {},
  }), 455_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "reconcile",
    group: "capacity",
    options: {},
  }), 395_000);
  assert.equal(serviceCommandTimeoutMs({
    command: "reconcile",
    group: "capacity",
    options: {},
  }), 455_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "reconcile",
    group: "capacity",
    options: {
      apply: true,
    },
  }), 3_005_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "reconcile",
    group: "capacity",
    options: {
      apply: true,
      capacityLockTimeoutMilliseconds: 240_000,
      leaseLockTimeoutMilliseconds: 120_000,
    },
  }), 3_305_000);
  assert.equal(serviceCommandExecutionTimeoutMs({
    command: "reconcile",
    group: "capacity",
    options: {
      apply: true,
    },
  }, {
    capacityActionCount: 3,
  }), 4_925_000);
});

test("lease register-process requires a positive pid", () => {
  const fixture = makeFixture();
  const leaseFile = path.join(fixture.root, "lease.json");

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-1",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--lease-file",
    leaseFile,
  ).status, 0);

  const missingPid = runCli(
    fixture,
    "lease",
    "register-process",
    "--lease-file",
    leaseFile,
  );
  assert.equal(missingPid.status, 2);
  assert.equal(missingPid.json.reasonCode, "missing-flag");

  const invalidPid = runCli(
    fixture,
    "lease",
    "register-process",
    "--lease-file",
    leaseFile,
    "--pid",
    "0",
  );
  assert.equal(invalidPid.status, 2);
  assert.equal(invalidPid.json.reasonCode, "invalid-flag");
});

test("lease register-process preserves simulator process names when the flag is omitted", () => {
  const fixture = makeFixture();
  const leaseFile = path.join(fixture.root, "lease.json");

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-1",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--lease-file",
    leaseFile,
    "--simulator-process-names",
    "CustomTestHost",
  ).status, 0);

  const registerResult = runCli(
    fixture,
    "lease",
    "register-process",
    "--lease-file",
    leaseFile,
    "--pid",
    String(process.pid),
  );
  assert.equal(registerResult.status, 0);

  const lease = readJson(path.join(fixture.stateRoot, "leases", `${registerResult.json.lease.leaseId}.json`));
  assert.deepEqual(lease.runtime.simulatorProcessNames, ["CustomTestHost"]);
});

test("lease register-process rejects a valueless simulator process name list", () => {
  const fixture = makeFixture();
  const leaseFile = path.join(fixture.root, "lease.json");

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-1",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--lease-file",
    leaseFile,
  ).status, 0);

  const registerResult = runCli(
    fixture,
    "lease",
    "register-process",
    "--lease-file",
    leaseFile,
    "--pid",
    String(process.pid),
    "--simulator-process-names",
  );
  assert.equal(registerResult.status, 2);
  assert.equal(registerResult.json.reasonCode, "missing-flag");
});

test("lease register-process rejects an empty simulator process name list", () => {
  const fixture = makeFixture();
  const leaseFile = path.join(fixture.root, "lease.json");

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-1",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--lease-file",
    leaseFile,
  ).status, 0);

  const registerResult = runCli(
    fixture,
    "lease",
    "register-process",
    "--lease-file",
    leaseFile,
    "--pid",
    String(process.pid),
    "--simulator-process-names=",
  );
  assert.equal(registerResult.status, 2);
  assert.equal(registerResult.json.reasonCode, "missing-flag");
});

test("lease acquire rejects invalid memory ceiling flags", () => {
  const fixture = makeFixture();

  assert.equal(runCli(fixture, "host", "init").status, 0);

  const missingCeilingValue = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-1",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--memory-ceiling-bytes",
  );
  assert.equal(missingCeilingValue.status, 2);
  assert.equal(missingCeilingValue.json.reasonCode, "missing-flag");

  const zeroCeiling = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-1",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--memory-ceiling-bytes",
    "0",
  );
  assert.equal(zeroCeiling.status, 2);
  assert.equal(zeroCeiling.json.reasonCode, "invalid-flag");

  const negativeCeiling = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-1",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--memory-ceiling-mib",
    "-1",
  );
  assert.equal(negativeCeiling.status, 2);
  assert.equal(negativeCeiling.json.reasonCode, "invalid-flag");

  const truncatedBytes = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-1",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--memory-ceiling-bytes",
    "512MiB",
  );
  assert.equal(truncatedBytes.status, 2);
  assert.equal(truncatedBytes.json.reasonCode, "invalid-flag");

  const fractionalMib = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-1",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--memory-ceiling-mib",
    "1.5",
  );
  assert.equal(fractionalMib.status, 2);
  assert.equal(fractionalMib.json.reasonCode, "invalid-flag");
});

test("lease contain rejects unsupported reasons", () => {
  const fixture = makeFixture();
  const leaseFile = path.join(fixture.root, "lease.json");

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-1",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--lease-file",
    leaseFile,
  ).status, 0);

  const invalidReason = runCli(
    fixture,
    "lease",
    "contain",
    "--lease-file",
    leaseFile,
    "--reason",
    "typo",
  );
  assert.equal(invalidReason.status, 2);
  assert.equal(invalidReason.json.reasonCode, "invalid-flag");
});

test("lease contain rejects a valueless reason flag", () => {
  const fixture = makeFixture();
  const leaseFile = path.join(fixture.root, "lease.json");

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-1",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--lease-file",
    leaseFile,
  ).status, 0);

  const missingReasonValue = runCli(
    fixture,
    "lease",
    "contain",
    "--lease-file",
    leaseFile,
    "--reason",
  );
  assert.equal(missingReasonValue.status, 2);
  assert.equal(missingReasonValue.json.reasonCode, "missing-flag");
});

test("lease contain rejects a negative term wait", () => {
  const fixture = makeFixture();
  const leaseFile = path.join(fixture.root, "lease.json");

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-1",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--lease-file",
    leaseFile,
  ).status, 0);

  const result = runCli(
    fixture,
    "lease",
    "contain",
    "--lease-file",
    leaseFile,
    "--term-wait-ms",
    "-1",
  );

  assert.equal(result.status, 2);
  assert.equal(result.json.reasonCode, "invalid-flag");
  assert.equal(fs.existsSync(leaseFile), true);
});

test("lease contain keeps a no-breach lease active during snapshot refresh after owner exit", async () => {
  const fixture = makeFixture();
  const leaseFile = path.join(fixture.root, "lease.json");

  assert.equal(runCli(fixture, "host", "init").status, 0);

  const owner = spawnKeepaliveProcess();

  try {
    const acquireResult = runCli(
      fixture,
      "lease",
      "acquire",
      "--repo-root",
      fixture.repoRoot,
      "--purpose",
      "agent-ui-session",
      "--actor-id",
      "agent-contain",
      "--actor-type",
      "agent",
      "--owner-pid",
      String(owner.pid),
      "--lease-file",
      leaseFile,
      "--memory-ceiling-bytes",
      String(512 * 1024 * 1024),
    );
    assert.equal(acquireResult.status, 0);

    await stopKeepaliveProcess(owner, "SIGTERM");

    const containResult = runCli(
      fixture,
      "lease",
      "contain",
      "--lease-file",
      leaseFile,
      "--reason",
      "memory-ceiling",
    );
    assert.equal(containResult.status, 0);
    assert.equal(containResult.json.contained, false);
    assert.equal(fs.existsSync(leaseFile), true);
  } finally {
    await stopKeepaliveProcess(owner);
  }
});

test("lease register-process keeps a recovered stale lease active during snapshot refresh", async () => {
  const fixture = makeFixture();
  const leaseFile = path.join(fixture.root, "lease.json");

  assert.equal(runCli(fixture, "host", "init").status, 0);

  const owner = spawnKeepaliveProcess();
  const command = spawnKeepaliveProcess();

  try {
    const acquireResult = runCli(
      fixture,
      "lease",
      "acquire",
      "--repo-root",
      fixture.repoRoot,
      "--purpose",
      "agent-ui-session",
      "--actor-id",
      "agent-contain",
      "--actor-type",
      "agent",
      "--owner-pid",
      String(owner.pid),
      "--lease-file",
      leaseFile,
    );
    assert.equal(acquireResult.status, 0);

    await stopKeepaliveProcess(owner, "SIGTERM");

    const pgidResult = spawnSync("ps", ["-o", "pgid=", "-p", String(command.pid)], {
      encoding: "utf8",
    });
    assert.equal(pgidResult.status, 0);
    const commandPgid = Number.parseInt(pgidResult.stdout.trim(), 10);
    assert.equal(Number.isInteger(commandPgid), true);

    const registerResult = runCli(
      fixture,
      "lease",
      "register-process",
      "--lease-file",
      leaseFile,
      "--pid",
      String(command.pid),
      "--pgid",
      String(commandPgid),
      "--command",
      "node keepalive",
    );
    assert.equal(registerResult.status, 0);
    assert.equal(fs.existsSync(leaseFile), true);
    assert.equal(fs.existsSync(path.join(fixture.stateRoot, "leases", `${registerResult.json.lease.leaseId}.json`)), true);
    process.kill(command.pid, 0);
  } finally {
    await stopKeepaliveProcess(owner);
    await stopKeepaliveProcess(command);
  }
});

test("events watch returns recorded broker events", () => {
  const fixture = makeFixture();
  const leaseFile = path.join(fixture.root, "lease.json");

  assert.equal(runCli(fixture, "host", "init").status, 0);
  const acquireResult = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-1",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--lease-file",
    leaseFile,
  );
  assert.equal(acquireResult.status, 0);

  const eventsResult = runCli(fixture, "events", "watch");
  assert.equal(eventsResult.status, 0);
  assert.equal(eventsResult.json.ok, true);
  assert.ok(eventsResult.json.events.some((event) => event.type === "host.initialized"));
  assert.ok(eventsResult.json.events.some((event) => event.type === "lease.acquired"));
});

test("app snapshot returns the broker read model and writes the canonical snapshot artifact", () => {
  const fixture = makeFixture();
  const leaseFile = path.join(fixture.root, "lease.json");

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-app",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--lease-file",
    leaseFile,
  ).status, 0);

  const snapshotResult = runCli(fixture, "app", "snapshot", "--event-limit", "5");
  assert.equal(snapshotResult.status, 0);
  assert.equal(snapshotResult.json.transport, "direct");
  assert.equal(snapshotResult.json.overview.leasedAliases, 1);
  assert.equal(snapshotResult.json.hostConfigPath, fixture.hostConfigPath);
  assert.equal(snapshotResult.json.activeLeases[0].actorId, "agent-app");
  assert.equal(snapshotResult.json.projects[0].projectFilePath, path.join(fixture.repoRoot, ".simulator-broker/project.json"));
  assert.equal(snapshotResult.json.projects[0].purposes[0].displayName, "Agent UI Session");
  assert.ok(fs.existsSync(path.join(fixture.stateRoot, "app-snapshot.json")));
  assert.ok(fs.existsSync(path.join(fixture.stateRoot, "known-projects.json")));
});

test("app snapshot rejects negative event limits", () => {
  const fixture = makeFixture();

  assert.equal(runCli(fixture, "host", "init").status, 0);
  const snapshotResult = runCli(fixture, "app", "snapshot", "--event-limit", "-1");

  assert.equal(snapshotResult.status, 2);
  assert.equal(snapshotResult.json.reasonCode, "invalid-flag");
});

test("simulators boot and shutdown update lifecycle fields in direct CLI mode", () => {
  const fixture = makeFixture();

  assert.equal(runCli(fixture, "host", "init").status, 0);

  const bootResult = runCli(fixture, "simulators", "boot", "--alias", "ui-1");
  assert.equal(bootResult.status, 0);
  assert.equal(bootResult.json.transport, "direct");
  assert.equal(bootResult.json.simulator.powerState, "booted");
  assert.ok(bootResult.json.simulator.lastBootedAt);

  const shutdownResult = runCli(fixture, "simulators", "shutdown", "--alias", "ui-1");
  assert.equal(shutdownResult.status, 0);
  assert.equal(shutdownResult.json.transport, "direct");
  assert.equal(shutdownResult.json.simulator.powerState, "shutdown");
  assert.ok(shutdownResult.json.simulator.lastShutdownAt);
});

test("direct CLI uses exit code 2 for invalid requests", () => {
  const fixture = makeFixture();
  const result = runCli(fixture, "unknown-command");

  assert.equal(result.status, 2);
  assert.equal(result.json.exitCode, 2);
  assert.equal(result.json.reasonCode, "unknown-command");
});

test("direct CLI rejects extra positional arguments", () => {
  const fixture = makeFixture();
  const result = runCli(fixture, "simulators", "erase", "ui-2", "--alias", "ui-1");

  assert.equal(result.status, 2);
  assert.equal(result.json.exitCode, 2);
  assert.equal(result.json.reasonCode, "unknown-command");
  assert.match(result.json.error, /Unexpected positional argument ui-2/);
});

test("direct CLI uses exit code 3 when no alias is available", () => {
  const fixture = makeFixture();

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-primary",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
  ).status, 0);

  const exhausted = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-secondary",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
  );

  assert.equal(exhausted.status, 3);
  assert.equal(exhausted.json.exitCode, 3);
  assert.equal(exhausted.json.reasonCode, "no-matching-alias");
});

test("direct CLI uses exit code 4 for repair-needed aliases", () => {
  const fixture = makeFixture();

  assert.equal(runCli(fixture, "host", "init").status, 0);

  const simctlState = readJson(fixture.simctl.statePath);
  simctlState.devices = simctlState.devices.filter((device) => device.udid !== "SIM-UI-1");
  writeJson(fixture.simctl.statePath, simctlState);

  const unhealthy = runCli(fixture, "simulators", "boot", "--alias", "ui-1");
  assert.equal(unhealthy.status, 4);
  assert.equal(unhealthy.json.exitCode, 4);
  assert.equal(unhealthy.json.reasonCode, "unhealthy-alias");
});

test("direct CLI uses exit code 5 when a human override is required", () => {
  const fixture = makeFixture();

  assert.equal(runCli(fixture, "host", "init").status, 0);
  const acquire = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-owner",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
  );
  assert.equal(acquire.status, 0);

  const deniedRepair = runCli(
    fixture,
    "simulators",
    "repair",
    "--alias",
    "ui-1",
    "--actor-id",
    "agent-other",
    "--actor-type",
    "agent",
  );

  assert.equal(deniedRepair.status, 5);
  assert.equal(deniedRepair.json.exitCode, 5);
  assert.equal(deniedRepair.json.reasonCode, "human-override-required");
});
});
