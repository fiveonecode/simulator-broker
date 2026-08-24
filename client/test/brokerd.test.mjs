import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { BrokerError, resolveBrokerPaths } from "../../broker-core/index.mjs";
import {
  DEFAULT_CONTAINMENT_POST_KILL_WAIT_MS,
  DEFAULT_CONTAINMENT_TERM_WAIT_MS,
  PROCESS_SAMPLER_TIMEOUT_MS,
  STALE_CONTAINMENT_PROCESS_SAMPLER_INVOCATIONS,
} from "../../broker-core/containment.mjs";
import { createDeviceRecord, createSimctlFixture } from "../../broker-core/test/support/simctl-fixture.mjs";
import { acquireServiceStartLock, runServiceWorker, startBrokerService } from "../service/brokerd.mjs";
import {
  appSnapshotExecutionTimeoutMs,
  serviceCommandExecutionTimeoutMs,
} from "../service/service-client.mjs";

const CLI_PATH = path.resolve("client/bin/simbroker.mjs");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-service-test-"));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeFixture(aliasCount = 2) {
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
      ...(aliasCount > 1 ? [createDeviceRecord({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-A16",
        name: "iPad One",
        udid: "SIM-IPAD-1",
      })] : []),
    ],
  });

  writeJson(hostConfigPath, {
    version: 1,
    hostId: "service-host",
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
      ...(aliasCount > 1 ? [{
        alias: "ipad-1",
        capabilities: ["interactive-resettable"],
        deviceFamily: "iPad",
        displayName: "iPad One",
        iosVersion: "18.2",
        resetPolicy: "erase-on-acquire",
        simulatorId: "SIM-IPAD-1",
      }] : []),
    ],
  });

  writeJson(projectFilePath, {
    version: 1,
    projectId: "service-demo",
    projectName: "Service Demo",
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
    hostId: "capacity-service-host",
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
    projectId: "capacity-service-demo",
    projectName: "Capacity Service Demo",
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

function cliArgs(fixture, extraArgs) {
  return [
    CLI_PATH,
    "--host-config", fixture.hostConfigPath,
    "--state-root", fixture.stateRoot,
    ...extraArgs,
  ];
}

function applySimctlFixtureEnv(t, fixture) {
  const originalFixtureState = process.env.SIMBROKER_SIMCTL_FIXTURE_STATE;
  process.env.SIMBROKER_SIMCTL_FIXTURE_STATE = fixture.simctl.statePath;
  t.after(() => {
    if (originalFixtureState === undefined) {
      delete process.env.SIMBROKER_SIMCTL_FIXTURE_STATE;
    } else {
      process.env.SIMBROKER_SIMCTL_FIXTURE_STATE = originalFixtureState;
    }
  });
}

function runCli(fixture, ...args) {
  const result = spawnSync(process.execPath, cliArgs(fixture, args), {
    encoding: "utf8",
    env: {
      ...process.env,
      ...fixture.simctl?.env,
    },
  });
  return {
    ...result,
    json: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

function runCliWithEnv(fixture, envOverrides, ...args) {
  const result = spawnSync(process.execPath, cliArgs(fixture, args), {
    encoding: "utf8",
    env: {
      ...process.env,
      ...fixture.simctl?.env,
      ...envOverrides,
    },
  });
  return {
    ...result,
    json: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

function runCliAsync(fixture, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cliArgs(fixture, args), {
      env: {
        ...process.env,
        ...fixture.simctl?.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({
        signal,
        status,
        stderr,
        stdout,
        json: options.parseJson === false || !stdout ? null : JSON.parse(stdout),
      });
    });
  });
}

function waitFor(predicate, { intervalMs = 25, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Timed out waiting for condition."));
        return;
      }
      setTimeout(poll, intervalMs);
    };
    poll();
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

function requestService(fixture, { body, method = "GET", requestPath }) {
  return new Promise((resolve, reject) => {
    const metadataPath = path.join(fixture.stateRoot, "brokerd.json");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      headers: payload ? {
        "content-length": Buffer.byteLength(payload),
        "content-type": "application/json",
      } : undefined,
      method,
      path: requestPath,
      socketPath: metadata.socketPath,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({
          json: body ? JSON.parse(body) : null,
          statusCode: response.statusCode ?? 0,
        });
      });
    });
    request.on("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function requestServiceJson(fixture, requestPath) {
  return requestService(fixture, {
    method: "GET",
    requestPath,
  });
}

async function stopServiceIfRunning(fixture) {
  const status = runCli(fixture, "service", "status");
  if (status.status !== 0 || status.json?.running !== true) {
    return;
  }
  const stop = runCli(fixture, "service", "stop");
  assert.equal(stop.status, 0);
}

test("service lifecycle routes CLI commands through brokerd and falls back after stop", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  const before = runCli(fixture, "service", "status");
  assert.equal(before.status, 0);
  assert.equal(before.json.running, false);

  assert.equal(runCli(fixture, "host", "init").status, 0);

  const start = runCli(fixture, "service", "start");
  assert.equal(start.status, 0);
  assert.equal(start.json.running, true);
  assert.equal(start.json.transport, "service-control");
  const servicePaths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: fixture.projectFilePath,
    stateRoot: fixture.stateRoot,
  });
  assert.equal(fs.statSync(servicePaths.stateRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(servicePaths.serviceLogPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(servicePaths.serviceMetadataPath).mode & 0o777, 0o600);

  const acquire = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-service",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--lease-file",
    path.join(fixture.root, "lease.json"),
  );
  assert.equal(acquire.status, 0);
  assert.equal(acquire.json.transport, "service");

  const stop = runCli(fixture, "service", "stop");
  assert.equal(stop.status, 0);
  assert.equal(stop.json.stopped, true);

  const release = runCli(
    fixture,
    "lease",
    "release",
    "--lease-file",
    path.join(fixture.root, "lease.json"),
  );
  assert.equal(release.status, 0);
  assert.equal(release.json.transport, "direct");
});

test("policy-enabled lease acquisition lazily starts brokerd and local-only reports its limitation", async (t) => {
  const fixture = makeFixture(1);
  t.after(async () => stopServiceIfRunning(fixture));
  assert.equal(runCli(fixture, "host", "init").status, 0);

  const unconfigured = runCliWithEnv(fixture, { SIMBROKER_LOCAL_ONLY: "1" }, "idle", "status");
  assert.equal(unconfigured.status, 0);
  assert.equal(unconfigured.json.configured, false);
  assert.deepEqual(unconfigured.json.scheduler, {
    active: false,
    limitation: "local-only-mode",
  });

  const enabled = runCli(
    fixture,
    "idle",
    "enable",
    "--grace-seconds",
    "60",
    "--actor-type",
    "human",
    "--actor-id",
    "operator",
  );
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(enabled.json.transport, "direct");
  assert.deepEqual(enabled.json.scheduler, {
    active: false,
    limitation: "service-not-running",
  });
  const localOnlyConfigured = runCliWithEnv(fixture, { SIMBROKER_LOCAL_ONLY: "1" }, "idle", "status");
  assert.equal(localOnlyConfigured.status, 0, localOnlyConfigured.stderr);
  assert.equal(localOnlyConfigured.json.configured, true);
  assert.deepEqual(localOnlyConfigured.json.scheduler, {
    active: false,
    limitation: "local-only-mode",
  });
  assert.equal(runCli(fixture, "service", "status").json.running, false);

  const acquire = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-type",
    "agent",
    "--actor-id",
    "agent-lazy-start",
    "--owner-pid",
    String(process.pid),
  );
  assert.equal(acquire.status, 0, acquire.stderr);
  assert.equal(acquire.json.transport, "service");
  assert.deepEqual(acquire.json.scheduler, {
    active: true,
    limitation: null,
  });
  assert.equal(runCli(fixture, "service", "status").json.running, true);

  const status = runCli(fixture, "idle", "status");
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.json.transport, "service");
  assert.equal(status.json.scheduler.active, true);
  assert.equal(Object.hasOwn(status.json, "servedBy"), false);
  assert.equal(JSON.stringify(status.json).includes(fixture.root), false);

  const release = runCli(fixture, "lease", "release", "--lease-id", acquire.json.lease.leaseId);
  assert.equal(release.status, 0, release.stderr);
  const preview = runCli(fixture, "idle", "cleanup");
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(preview.json.eligibleCount, 1);
  assert.equal(Object.hasOwn(preview.json, "servedBy"), false);
  assert.equal(JSON.stringify(preview.json).includes("ui-1"), false);
  assert.equal(JSON.stringify(preview.json).includes("SIM-UI-1"), false);
  assert.equal(JSON.stringify(preview.json).includes(fixture.root), false);
  const cleanup = runCli(
    fixture,
    "idle",
    "cleanup",
    "--apply",
    "--confirm",
    preview.json.planId,
    "--actor-type",
    "human",
    "--actor-id",
    "operator",
  );
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(cleanup.json.shutdownCount, 1);
  assert.equal(Object.hasOwn(cleanup.json, "servedBy"), false);
  assert.equal(JSON.stringify(cleanup.json).includes("ui-1"), false);
  assert.equal(JSON.stringify(cleanup.json).includes("SIM-UI-1"), false);
  assert.equal(JSON.stringify(cleanup.json).includes(fixture.root), false);
});

test("service routes project forget through brokerd and refreshes the shared app snapshot", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "project", "validate", "--repo-root", fixture.repoRoot).status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);

  const forgotten = runCli(fixture, "project", "forget", "--project-id", "service-demo");
  assert.equal(forgotten.status, 0);
  assert.equal(forgotten.json.transport, "service");
  assert.equal(forgotten.json.forgotten, true);
  assert.equal(Object.hasOwn(readJson(path.join(fixture.stateRoot, "known-projects.json")).projects, "service-demo"), false);
  const snapshot = readJson(path.join(fixture.stateRoot, "app-snapshot.json"));
  assert.equal(snapshot.projects.some((project) => project.projectId === "service-demo"), false);
});

test("service recomputes execution budgets before command dispatch", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  const start = runCli(fixture, "service", "start");
  assert.equal(start.status, 0);

  const hostConfig = readJson(fixture.hostConfigPath);
  writeJson(fixture.hostConfigPath, {
    ...hostConfig,
    pendingRetirements: ["SIM-OLD-1"],
  });
  const staleExecutionTimeout = serviceCommandExecutionTimeoutMs({
    command: "repair",
    group: "simulators",
    options: {},
  }, {
    pendingRetirementCount: 0,
  });

  const response = await requestService(fixture, {
    body: {
      clientCommandExecutionTimeoutMilliseconds: staleExecutionTimeout,
      clientCommandQueueTimeoutMilliseconds: 60_000,
      clientRequestStartedAtMilliseconds: Date.now(),
      command: "repair",
      group: "simulators",
      options: {
        alias: "ui-1",
      },
      type: "command",
    },
    method: "POST",
    requestPath: "/v1/command",
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json.reasonCode, "service-command-expired");
  assert.equal(response.json.executionTimeoutMilliseconds, 2_145_000);
  assert.equal(response.json.recomputedExecutionTimeoutMilliseconds, 2_385_000);
});

test("service recomputes execution budgets with stale containment lease files", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  const start = runCli(fixture, "service", "start");
  assert.equal(start.status, 0);

  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    stateRoot: fixture.stateRoot,
  });
  writeJson(path.join(paths.leasesDir, "stale-containment.json"), {
    leaseId: "stale-containment",
    runtime: {
      commandPid: 4242,
    },
  });
  const advertisedExecutionTimeout = serviceCommandExecutionTimeoutMs({
    command: "release",
    group: "lease",
    options: {},
  });
  const staleContainmentBudgetMs = (STALE_CONTAINMENT_PROCESS_SAMPLER_INVOCATIONS * PROCESS_SAMPLER_TIMEOUT_MS)
    + DEFAULT_CONTAINMENT_TERM_WAIT_MS
    + DEFAULT_CONTAINMENT_POST_KILL_WAIT_MS;

  const response = await requestService(fixture, {
    body: {
      clientCommandExecutionTimeoutMilliseconds: advertisedExecutionTimeout,
      clientCommandQueueTimeoutMilliseconds: 60_000,
      clientRequestStartedAtMilliseconds: Date.now(),
      command: "release",
      group: "lease",
      options: {},
      type: "command",
    },
    method: "POST",
    requestPath: "/v1/command",
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json.reasonCode, "service-command-expired");
  assert.equal(response.json.executionTimeoutMilliseconds, 885_000);
  assert.equal(response.json.recomputedExecutionTimeoutMilliseconds, 885_000 + (2 * staleContainmentBudgetMs));
});

test("service recomputes capacity budgets against the request project file", async (t) => {
  const fixture = makeFixture();
  const requestRepoRoot = path.join(fixture.root, "request-repo");
  const requestProjectFilePath = path.join(requestRepoRoot, ".simulator-broker/project.json");
  let service = null;
  const originalFixtureState = process.env.SIMBROKER_SIMCTL_FIXTURE_STATE;

  t.after(async () => {
    if (service !== null) {
      await service.shutdown({ exitProcess: false });
    }
    if (originalFixtureState === undefined) {
      delete process.env.SIMBROKER_SIMCTL_FIXTURE_STATE;
    } else {
      process.env.SIMBROKER_SIMCTL_FIXTURE_STATE = originalFixtureState;
    }
  });

  assert.equal(runCli(fixture, "host", "init").status, 0);
  writeJson(fixture.projectFilePath, {
    version: 1,
    projectId: "startup-budget-project",
    projectName: "Startup Budget Project",
    purposes: [
      { id: "startup-a", capability: "interactive-resettable", requires: { deviceFamily: "iPhone", iosVersion: "18" } },
      { id: "startup-b", capability: "interactive-resettable", requires: { deviceFamily: "iPhone", iosVersion: "18" } },
      { id: "startup-c", capability: "interactive-resettable", requires: { deviceFamily: "iPhone", iosVersion: "18" } },
    ],
  });
  writeJson(requestProjectFilePath, {
    version: 1,
    projectId: "request-budget-project",
    projectName: "Request Budget Project",
    purposes: [
      {
        id: "agent-ui-session",
        capability: "interactive-resettable",
        requires: { deviceFamily: "iPhone", iosVersion: "18" },
      },
    ],
  });

  const startupPaths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: fixture.projectFilePath,
    stateRoot: fixture.stateRoot,
  });
  const request = {
    command: "reconcile",
    group: "capacity",
    options: {
      apply: true,
      projectFilePath: requestProjectFilePath,
      purposeId: "agent-ui-session",
    },
    type: "command",
  };
  const requestExecutionTimeout = serviceCommandExecutionTimeoutMs(request, {
    paths: {
      ...startupPaths,
      projectFilePath: requestProjectFilePath,
    },
  });

  process.env.SIMBROKER_SIMCTL_FIXTURE_STATE = fixture.simctl.statePath;
  service = await startBrokerService(startupPaths);
  const response = await requestService(fixture, {
    body: {
      ...request,
      clientCommandExecutionTimeoutMilliseconds: requestExecutionTimeout,
      clientCommandQueueTimeoutMilliseconds: 60_000,
      clientRequestStartedAtMilliseconds: Date.now(),
    },
    method: "POST",
    requestPath: "/v1/command",
  });

  assert.equal(requestExecutionTimeout, 3_005_000);
  assert.equal(response.statusCode, 412);
  assert.equal(response.json.reasonCode, "capacity-confirmation-required");
});

test("concurrent service starts converge on one live brokerd", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);

  const [left, right] = await Promise.all([
    runCliAsync(fixture, ["service", "start"]),
    runCliAsync(fixture, ["service", "start"]),
  ]);

  assert.equal(left.status, 0, left.stderr);
  assert.equal(right.status, 0, right.stderr);
  assert.equal(left.json.running, true);
  assert.equal(right.json.running, true);
  assert.equal(new Set([left.json.service.pid, right.json.service.pid]).size, 1);

  const status = runCli(fixture, "service", "status");
  assert.equal(status.status, 0);
  assert.equal(status.json.running, true);
  assert.equal(status.json.service.pid, left.json.service.pid);
});

test("brokerd binds the service socket with restrictive permissions", async (t) => {
  const fixture = makeFixture();
  applySimctlFixtureEnv(t, fixture);
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: fixture.projectFilePath,
    stateRoot: fixture.stateRoot,
  });
  const originalUmask = process.umask;
  const initialUmask = originalUmask();
  const umaskValues = [];
  let service = null;

  t.after(async () => {
    process.umask = originalUmask;
    originalUmask(initialUmask);
    if (service !== null) {
      await service.shutdown({ exitProcess: false });
    }
  });

  process.umask = function patchedUmask(value) {
    if (arguments.length > 0) {
      umaskValues.push(value);
    }
    return originalUmask.apply(process, arguments);
  };

  assert.equal(runCli(fixture, "host", "init").status, 0);
  service = await startBrokerService(paths);

  assert.equal(umaskValues[0], 0o177);
  assert.equal(umaskValues.at(-1), initialUmask);
  assert.equal(originalUmask(), initialUmask);
  assert.equal(fs.statSync(paths.stateRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.serviceSocketPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.serviceMetadataPath).mode & 0o777, 0o600);
});

test("service shutdown closes incomplete command requests", async (t) => {
  const fixture = makeFixture();
  applySimctlFixtureEnv(t, fixture);
  assert.equal(runCli(fixture, "host", "init").status, 0);
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: fixture.projectFilePath,
    stateRoot: fixture.stateRoot,
  });
  let service = await startBrokerService(paths);
  let socket = null;

  t.after(async () => {
    socket?.destroy();
    if (service !== null) {
      await service.shutdown({ exitProcess: false });
    }
  });

  await new Promise((resolve, reject) => {
    socket = net.createConnection(paths.serviceSocketPath, resolve);
    socket.once("error", reject);
  });
  socket.on("error", () => {});
  socket.write([
    "POST /v1/command HTTP/1.1",
    "Host: brokerd.local",
    "Content-Type: application/json",
    "Content-Length: 128",
    "",
    "{\"type\":\"host-status\"",
  ].join("\r\n"));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const shutdownPromise = service.shutdown({ exitProcess: false });
  const shutdownResult = await Promise.race([
    shutdownPromise.then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 1_000)),
  ]);
  if (shutdownResult !== "closed") {
    socket.destroy();
    await shutdownPromise;
  }

  assert.equal(shutdownResult, "closed");
  service = null;
});

test("service shutdown closes connections before HTTP headers complete", async (t) => {
  const fixture = makeFixture();
  applySimctlFixtureEnv(t, fixture);
  assert.equal(runCli(fixture, "host", "init").status, 0);
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: fixture.projectFilePath,
    stateRoot: fixture.stateRoot,
  });
  let service = await startBrokerService(paths);
  let socket = null;

  t.after(async () => {
    socket?.destroy();
    if (service !== null) {
      await service.shutdown({ exitProcess: false });
    }
  });

  await new Promise((resolve, reject) => {
    socket = net.createConnection(paths.serviceSocketPath, resolve);
    socket.once("error", reject);
  });
  socket.on("error", () => {});
  socket.write("POST /v1/command HTTP/1.1\r\nHost: brokerd.local\r\n");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const shutdownPromise = service.shutdown({ exitProcess: false });
  const shutdownResult = await Promise.race([
    shutdownPromise.then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 1_000)),
  ]);
  if (shutdownResult !== "closed") {
    socket.destroy();
    await shutdownPromise;
  }

  assert.equal(shutdownResult, "closed");
  service = null;
});

test("brokerd rejects oversized command request bodies", async (t) => {
  const fixture = makeFixture();
  applySimctlFixtureEnv(t, fixture);
  assert.equal(runCli(fixture, "host", "init").status, 0);
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: fixture.projectFilePath,
    stateRoot: fixture.stateRoot,
  });
  const service = await startBrokerService(paths);

  t.after(async () => service.shutdown({ exitProcess: false }));

  const responseText = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };
    const socket = net.createConnection(paths.serviceSocketPath, () => {
      socket.end([
        "POST /v1/command HTTP/1.1",
        "Host: brokerd.local",
        "Content-Type: application/json",
        "Content-Length: 66560",
        "",
        "",
      ].join("\r\n"));
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => finish(resolve, response));
    socket.on("error", (error) => {
      if (error?.code === "EPIPE") {
        finish(resolve, response);
        return;
      }
      finish(reject, error);
    });
  });
  assert.match(responseText, /^HTTP\/1\.1 400/);
  assert.match(responseText, /\r\nConnection: close\r\n/i);
  assert.match(responseText, /"reasonCode": "invalid-command-request"/);
  assert.match(responseText, /request body exceeds/);
});

test("brokerd startup preserves a live service socket when the status probe times out", async (t) => {
  const root = makeTempDir();
  const paths = resolveBrokerPaths({
    hostConfigPath: path.join(root, "host-config.json"),
    serviceSocketPath: path.join(root, "busy.sock"),
    stateRoot: path.join(root, "state"),
  });
  fs.mkdirSync(paths.stateRoot, { recursive: true });
  writeJson(paths.serviceMetadataPath, {
    pid: process.pid,
    socketPath: paths.serviceSocketPath,
    startedAt: new Date().toISOString(),
    stateRoot: paths.stateRoot,
  });
  const busyServer = http.createServer((_request, response) => {
    setTimeout(() => {
      if (!response.destroyed) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          running: true,
          service: {
            pid: process.pid,
            socketPath: paths.serviceSocketPath,
          },
        }));
      }
    }, 1000);
  });
  t.after(() => new Promise((resolve) => busyServer.close(resolve)));
  await listen(busyServer, paths.serviceSocketPath);

  await assert.rejects(
    () => startBrokerService(paths),
    (error) => error.payload?.reasonCode === "service-start-timeout",
  );
  assert.equal(fs.existsSync(paths.serviceSocketPath), true);
  assert.equal(fs.existsSync(paths.serviceLockDir), false);
});

test("brokerd publishes service metadata only after startup snapshot refresh", async (t) => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    serviceSocketPath: path.join(fixture.root, "ready.sock"),
    stateRoot: fixture.stateRoot,
  });
  let snapshotRefreshed = false;
  const service = await startBrokerService(paths, {
    writeAppSnapshotArtifact(servicePaths) {
      snapshotRefreshed = true;
      assert.equal(servicePaths.serviceSocketPath, paths.serviceSocketPath);
      assert.equal(fs.existsSync(paths.serviceSocketPath), false);
      assert.equal(fs.existsSync(paths.serviceMetadataPath), false);
    },
  });
  t.after(async () => {
    await service.shutdown({ exitProcess: false });
  });

  assert.equal(snapshotRefreshed, true);
  assert.equal(fs.existsSync(paths.serviceSocketPath), true);
  assert.equal(fs.existsSync(paths.serviceMetadataPath), true);
});

test("brokerd workers reject clean exits that send no result", async () => {
  await assert.rejects(
    () => runServiceWorker({ type: "unknown-worker-type" }),
    (error) => error instanceof BrokerError
      && error.payload?.reasonCode === "internal-error",
  );
});

test("brokerd reconciles immediately, every thirty seconds, refreshes snapshots, and cancels the timer", async (t) => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    serviceSocketPath: path.join(fixture.root, "timer.sock"),
    stateRoot: fixture.stateRoot,
  });
  const sources = [];
  const reconcileLockWaits = [];
  const snapshotLockWaits = [];
  let snapshotCount = 0;
  let intervalMilliseconds = null;
  let timerCallback = null;
  let timerCleared = false;
  const timer = { unref() {} };
  const service = await startBrokerService(paths, {
    clearIntervalFn(value) {
      assert.equal(value, timer);
      timerCleared = true;
    },
    reconcileIdleBroker(_servicePaths, options) {
      sources.push(options.source);
      reconcileLockWaits.push(options.leaseMutationLockWait);
      return { ok: true };
    },
    setIntervalFn(callback, milliseconds) {
      timerCallback = callback;
      intervalMilliseconds = milliseconds;
      return timer;
    },
    writeAppSnapshotArtifact(_servicePaths, options) {
      snapshotLockWaits.push(options.leaseMutationLockWait);
      snapshotCount += 1;
    },
  });
  t.after(async () => {
    await service.shutdown({ exitProcess: false });
  });

  assert.deepEqual(sources, ["service-startup"]);
  assert.deepEqual(reconcileLockWaits, [undefined]);
  assert.deepEqual(snapshotLockWaits, [true]);
  assert.equal(snapshotCount, 1);
  assert.equal(intervalMilliseconds, 30_000);
  timerCallback();
  await waitFor(() => sources.length === 2);
  assert.deepEqual(sources, ["service-startup", "service-timer"]);
  assert.deepEqual(reconcileLockWaits, [undefined, false]);
  assert.deepEqual(snapshotLockWaits, [true, true]);
  assert.equal(snapshotCount, 2);

  await service.shutdown({ exitProcess: false });
  assert.equal(timerCleared, true);
});

test("brokerd dispatches scheduled idle reconciliation asynchronously without overlap", async (t) => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    serviceSocketPath: path.join(fixture.root, "async-timer.sock"),
    stateRoot: fixture.stateRoot,
  });
  let timerCallback = null;
  const timer = { unref() {} };
  const scheduledSources = [];
  const scheduledResolvers = [];
  const service = await startBrokerService(paths, {
    reconcileIdleBroker() {
      return { ok: true };
    },
    runScheduledIdleReconciliation(source) {
      scheduledSources.push(source);
      return new Promise((resolve) => {
        scheduledResolvers.push(resolve);
      });
    },
    setIntervalFn(callback) {
      timerCallback = callback;
      return timer;
    },
    writeAppSnapshotArtifact() {},
  });
  t.after(async () => {
    for (const resolve of scheduledResolvers.splice(0)) {
      resolve({ ok: true });
    }
    await service.shutdown({ exitProcess: false });
  });

  timerCallback();
  timerCallback();
  await waitFor(() => scheduledSources.length === 1);
  assert.deepEqual(scheduledSources, ["service-timer"]);

  scheduledResolvers.shift()({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  timerCallback();
  await waitFor(() => scheduledSources.length === 2);
  assert.deepEqual(scheduledSources, ["service-timer", "service-timer"]);

  scheduledResolvers.shift()({ ok: true });
  await service.shutdown({ exitProcess: false });
});

test("brokerd waits for active scheduled idle reconciliation during shutdown", async () => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    serviceSocketPath: path.join(fixture.root, "sw.sock"),
    stateRoot: fixture.stateRoot,
  });
  let timerCallback = null;
  const timer = { unref() {} };
  const scheduledResolvers = [];
  const service = await startBrokerService(paths, {
    reconcileIdleBroker() {
      return { ok: true };
    },
    runScheduledIdleReconciliation() {
      return new Promise((resolve) => {
        scheduledResolvers.push(resolve);
      });
    },
    setIntervalFn(callback) {
      timerCallback = callback;
      return timer;
    },
    writeAppSnapshotArtifact() {},
  });

  timerCallback();
  let shutdownResolved = false;
  const shutdownPromise = service.shutdown({ exitProcess: false }).then(() => {
    shutdownResolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownResolved, false);

  scheduledResolvers.shift()({ ok: true });
  await shutdownPromise;
  assert.equal(shutdownResolved, true);
});

test("brokerd serializes command workers", async (t) => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });
  const resolvers = [];
  const startedCommands = [];
  const service = await startBrokerService(paths, {
    reconcileIdleBroker() {
      return { ok: true };
    },
    runBrokerCommandWorker(request) {
      startedCommands.push(request.command);
      return new Promise((resolve) => {
        resolvers.push(() => resolve({
          command: request.command,
          group: request.group,
        }));
      });
    },
    writeAppSnapshotArtifact() {},
  });
  t.after(async () => service.shutdown({ exitProcess: false }));

  const firstRequest = requestService(fixture, {
    body: { command: "global", group: "help", type: "command" },
    method: "POST",
    requestPath: "/v1/command",
  });
  await waitFor(() => startedCommands.length === 1);
  const secondRequest = requestService(fixture, {
    body: { command: "host", group: "help", type: "command" },
    method: "POST",
    requestPath: "/v1/command",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(startedCommands, ["global"]);

  resolvers.shift()();
  await waitFor(() => startedCommands.length === 2);
  resolvers.shift()();

  const [firstResponse, secondResponse] = await Promise.all([
    firstRequest,
    secondRequest,
  ]);
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 200);
  assert.deepEqual(startedCommands, ["global", "host"]);
});

test("brokerd serializes scheduled idle reconciliation behind active command workers", async (t) => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });
  let timerCallback = null;
  const timer = { unref() {} };
  let resolveCommand = null;
  const events = [];
  const service = await startBrokerService(paths, {
    reconcileIdleBroker() {
      return { ok: true };
    },
    runBrokerCommandWorker(request) {
      events.push(`command:${request.command}`);
      return new Promise((resolve) => {
        resolveCommand = () => resolve({
          command: request.command,
          group: request.group,
        });
      });
    },
    runScheduledIdleReconciliation(source) {
      events.push(`reconcile:${source}`);
      return { ok: true };
    },
    setIntervalFn(callback) {
      timerCallback = callback;
      return timer;
    },
    writeAppSnapshotArtifact() {},
  });
  t.after(async () => service.shutdown({ exitProcess: false }));

  const request = requestService(fixture, {
    body: { command: "global", group: "help", type: "command" },
    method: "POST",
    requestPath: "/v1/command",
  });
  await waitFor(() => resolveCommand !== null);
  timerCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["command:global"]);

  resolveCommand();
  const response = await request;
  await waitFor(() => events.includes("reconcile:service-timer"));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(events, ["command:global", "reconcile:service-timer"]);
});

test("brokerd revalidates queued command expiry before worker dispatch", async (t) => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });
  const originalDateNow = Date.now;
  let nowMilliseconds = 1_000_000;
  const resolvers = [];
  const startedCommands = [];
  const service = await startBrokerService(paths, {
    reconcileIdleBroker() {
      return { ok: true };
    },
    runBrokerCommandWorker(request) {
      startedCommands.push(request.command);
      return new Promise((resolve) => {
        resolvers.push(() => resolve({
          command: request.command,
          group: request.group,
        }));
      });
    },
    writeAppSnapshotArtifact() {},
  });
  Date.now = () => nowMilliseconds;
  t.after(async () => {
    Date.now = originalDateNow;
    await service.shutdown({ exitProcess: false });
  });

  const firstRequest = requestService(fixture, {
    body: { command: "global", group: "help", type: "command" },
    method: "POST",
    requestPath: "/v1/command",
  });
  await waitFor(() => startedCommands.length === 1);
  const secondRequest = requestService(fixture, {
    body: {
      clientCommandExecutionTimeoutMilliseconds: 25_000,
      clientCommandQueueTimeoutMilliseconds: 1_000,
      clientRequestStartedAtMilliseconds: nowMilliseconds,
      command: "host",
      group: "help",
      options: {},
      type: "command",
    },
    method: "POST",
    requestPath: "/v1/command",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(startedCommands, ["global"]);

  nowMilliseconds += 1_001;
  resolvers.shift()();
  const [firstResponse, secondResponse] = await Promise.all([
    firstRequest,
    secondRequest,
  ]);

  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 409);
  assert.equal(secondResponse.json.reasonCode, "service-command-expired");
  assert.deepEqual(startedCommands, ["global"]);
});

test("brokerd waits for active command workers during shutdown", async (t) => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });
  let resolveCommand = null;
  const service = await startBrokerService(paths, {
    reconcileIdleBroker() {
      return { ok: true };
    },
    runBrokerCommandWorker(request) {
      return new Promise((resolve) => {
        resolveCommand = () => resolve({
          command: request.command,
          group: request.group,
        });
      });
    },
    writeAppSnapshotArtifact() {},
  });
  t.after(async () => service.shutdown({ exitProcess: false }));

  const request = requestService(fixture, {
    body: { command: "global", group: "help", type: "command" },
    method: "POST",
    requestPath: "/v1/command",
  });
  await waitFor(() => resolveCommand !== null);

  let shutdownResolved = false;
  const shutdownPromise = service.shutdown({ exitProcess: false }).then(() => {
    shutdownResolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownResolved, false);

  resolveCommand();
  const response = await request;
  await shutdownPromise;
  assert.equal(response.statusCode, 200);
  assert.equal(shutdownResolved, true);
});

test("brokerd waits for active app snapshot workers during shutdown", async (t) => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });
  let resolveSnapshot = null;
  const service = await startBrokerService(paths, {
    reconcileIdleBroker() {
      return { ok: true };
    },
    runAppSnapshotWorker() {
      return new Promise((resolve) => {
        resolveSnapshot = () => resolve({
          generatedAt: "2026-01-01T00:00:00.000Z",
        });
      });
    },
    writeAppSnapshotArtifact() {},
  });
  t.after(async () => service.shutdown({ exitProcess: false }));

  const request = requestServiceJson(fixture, "/v1/app/snapshot?eventLimit=10");
  await waitFor(() => resolveSnapshot !== null);

  let shutdownResolved = false;
  const shutdownPromise = service.shutdown({ exitProcess: false }).then(() => {
    shutdownResolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownResolved, false);

  resolveSnapshot();
  const response = await request;
  await shutdownPromise;
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.generatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(shutdownResolved, true);
});

test("service stop reports active command drain timeout budget", async (t) => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });
  let resolveCommand = null;
  let service = await startBrokerService(paths, {
    reconcileIdleBroker() {
      return { ok: true };
    },
    runBrokerCommandWorker(request) {
      return new Promise((resolve) => {
        resolveCommand = () => resolve({
          command: request.command,
          group: request.group,
        });
      });
    },
    writeAppSnapshotArtifact() {},
  });
  t.after(async () => {
    resolveCommand?.();
    if (service !== null) {
      await service.shutdown({ exitProcess: false });
    }
  });

  const commandRequest = requestService(fixture, {
    body: {
      clientCommandExecutionTimeoutMilliseconds: 123_456,
      clientCommandQueueTimeoutMilliseconds: 60_000,
      clientRequestStartedAtMilliseconds: Date.now(),
      command: "global",
      group: "help",
      options: {},
      type: "command",
    },
    method: "POST",
    requestPath: "/v1/command",
  });
  await waitFor(() => resolveCommand !== null);

  const stop = await requestService(fixture, {
    body: {},
    method: "POST",
    requestPath: "/v1/service/stop",
  });
  assert.equal(stop.statusCode, 200);
  assert.equal(stop.json.ok, true);
  assert.ok(stop.json.activeCommandDrainTimeoutMilliseconds > 100_000);
  assert.ok(stop.json.activeCommandDrainTimeoutMilliseconds <= 123_456);

  resolveCommand();
  const commandResponse = await commandRequest;
  assert.equal(commandResponse.statusCode, 200);
  await waitFor(() => !fs.existsSync(paths.serviceMetadataPath));
  service = null;
});

test("service stop reports active snapshot drain timeout budget", async (t) => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });
  const resolveSnapshots = [];
  let service = await startBrokerService(paths, {
    reconcileIdleBroker() {
      return { ok: true };
    },
    runAppSnapshotWorker() {
      return new Promise((resolve) => {
        resolveSnapshots.push(() => resolve({
          generatedAt: "2026-01-01T00:00:00.000Z",
        }));
      });
    },
    writeAppSnapshotArtifact() {},
  });
  t.after(async () => {
    for (const resolveSnapshot of resolveSnapshots) {
      resolveSnapshot();
    }
    if (service !== null) {
      await service.shutdown({ exitProcess: false });
    }
  });

  const firstSnapshotRequest = requestServiceJson(fixture, "/v1/app/snapshot?eventLimit=10");
  const secondSnapshotRequest = requestServiceJson(fixture, "/v1/app/snapshot?eventLimit=10");
  await waitFor(() => resolveSnapshots.length === 2);

  const stop = await requestService(fixture, {
    body: {},
    method: "POST",
    requestPath: "/v1/service/stop",
  });
  assert.equal(stop.statusCode, 200);
  assert.equal(stop.json.ok, true);
  assert.ok(stop.json.activeCommandDrainTimeoutMilliseconds > appSnapshotExecutionTimeoutMs());

  for (const resolveSnapshot of resolveSnapshots) {
    resolveSnapshot();
  }
  assert.equal((await firstSnapshotRequest).statusCode, 200);
  assert.equal((await secondSnapshotRequest).statusCode, 200);
  await waitFor(() => !fs.existsSync(paths.serviceMetadataPath));
  service = null;
});

test("service stop closes command admission before acknowledging shutdown", async (t) => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });
  let workerStarts = 0;
  let holdImmediate = false;
  const heldImmediateCallbacks = [];
  const originalSetImmediate = global.setImmediate;
  global.setImmediate = (callback, ...args) => {
    if (holdImmediate) {
      heldImmediateCallbacks.push(() => callback(...args));
      return {
        hasRef: () => false,
        ref() {
          return this;
        },
        unref() {
          return this;
        },
      };
    }
    return originalSetImmediate(callback, ...args);
  };
  const service = await startBrokerService(paths, {
    reconcileIdleBroker() {
      return { ok: true };
    },
    runBrokerCommandWorker() {
      workerStarts += 1;
      return { ok: true };
    },
    writeAppSnapshotArtifact() {},
  });
  t.after(async () => {
    holdImmediate = false;
    global.setImmediate = originalSetImmediate;
    for (const callback of heldImmediateCallbacks.splice(0)) {
      callback();
    }
    await service.shutdown({ exitProcess: false });
  });

  const metadata = readJson(paths.serviceMetadataPath);
  const body = JSON.stringify({
    command: "host",
    group: "help",
    options: {},
    type: "command",
  });
  let request = null;
  const responsePromise = new Promise((resolve, reject) => {
    request = http.request({
      headers: {
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json",
      },
      method: "POST",
      path: "/v1/command",
      socketPath: metadata.socketPath,
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        resolve({
          json: JSON.parse(responseBody),
          statusCode: response.statusCode ?? 0,
        });
      });
    });
    request.on("error", reject);
    request.write(body.slice(0, 8));
  });

  holdImmediate = true;
  const stop = await requestService(fixture, {
    body: {},
    method: "POST",
    requestPath: "/v1/service/stop",
  });
  assert.equal(stop.statusCode, 200);
  assert.equal(stop.json.ok, true);
  assert.equal(heldImmediateCallbacks.length, 1);

  request.end(body.slice(8));
  const response = await responsePromise;
  assert.equal(response.statusCode, 409);
  assert.equal(response.json.reasonCode, "service-unavailable");
  assert.equal(workerStarts, 0);

  holdImmediate = false;
  for (const callback of heldImmediateCallbacks.splice(0)) {
    callback();
  }
  await waitFor(() => !fs.existsSync(paths.serviceMetadataPath));
});

test("brokerd rejects late command worker admission during shutdown", async (t) => {
  const fixture = makeFixture();
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    projectFilePath: path.join(fixture.repoRoot, ".simulator-broker/project.json"),
    stateRoot: fixture.stateRoot,
  });
  let timerCallback = null;
  const timer = { unref() {} };
  const scheduledResolvers = [];
  let workerStarts = 0;
  const service = await startBrokerService(paths, {
    reconcileIdleBroker() {
      return { ok: true };
    },
    runBrokerCommandWorker() {
      workerStarts += 1;
      return { ok: true };
    },
    runScheduledIdleReconciliation() {
      return new Promise((resolve) => {
        scheduledResolvers.push(resolve);
      });
    },
    setIntervalFn(callback) {
      timerCallback = callback;
      return timer;
    },
    writeAppSnapshotArtifact() {},
  });
  t.after(async () => {
    for (const resolve of scheduledResolvers.splice(0)) {
      resolve({ ok: true });
    }
    await service.shutdown({ exitProcess: false });
  });

  timerCallback();
  await waitFor(() => scheduledResolvers.length === 1);

  const metadata = readJson(paths.serviceMetadataPath);
  const body = JSON.stringify({
    command: "host",
    group: "help",
    options: {},
    type: "command",
  });
  let request = null;
  const responsePromise = new Promise((resolve, reject) => {
    request = http.request({
      headers: {
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json",
      },
      method: "POST",
      path: "/v1/command",
      socketPath: metadata.socketPath,
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        resolve({
          json: JSON.parse(responseBody),
          statusCode: response.statusCode ?? 0,
        });
      });
    });
    request.on("error", reject);
    request.write(body.slice(0, 8));
  });

  await new Promise((resolve) => setImmediate(resolve));
  const shutdownPromise = service.shutdown({ exitProcess: false });
  request.end(body.slice(8));
  const response = await responsePromise;
  scheduledResolvers.shift()({ ok: true });
  await shutdownPromise;

  assert.equal(response.statusCode, 409);
  assert.equal(response.json.reasonCode, "service-unavailable");
  assert.equal(workerStarts, 0);
});

test("service startup lock waits while another stale-lock reclaimer is active", () => {
  const root = makeTempDir();
  const paths = resolveBrokerPaths({
    hostConfigPath: path.join(root, "host-config.json"),
    stateRoot: path.join(root, "state"),
  });
  fs.mkdirSync(paths.serviceLockDir, { recursive: true });
  writeJson(paths.serviceLockOwnerPath, {
    pid: 424242,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    token: "stale-owner",
  });
  const staleTime = new Date(Date.now() - 60_000);
  fs.utimesSync(paths.serviceLockOwnerPath, staleTime, staleTime);
  writeJson(path.join(paths.serviceLockDir, "reclaiming.json"), {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: "active-reclaimer",
  });
  const futureTime = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(paths.serviceLockDir, "reclaiming.json"), futureTime, futureTime);

  assert.throws(() => {
    acquireServiceStartLock(paths, {
      pollMs: 1,
      timeoutMs: 10,
    });
  }, (error) => error.payload?.reasonCode === "service-start-timeout");

  assert.equal(fs.existsSync(paths.serviceLockDir), true);
  assert.equal(readJson(paths.serviceLockOwnerPath).token, "stale-owner");
  assert.equal(readJson(path.join(paths.serviceLockDir, "reclaiming.json")).token, "active-reclaimer");
});

test("service startup lock reclaims an owner pid reused after the lock owner started", () => {
  const root = makeTempDir();
  const paths = resolveBrokerPaths({
    hostConfigPath: path.join(root, "host-config.json"),
    stateRoot: path.join(root, "state"),
  });
  fs.mkdirSync(paths.serviceLockDir, { recursive: true });
  writeJson(paths.serviceLockOwnerPath, {
    pid: 424242,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    token: "stale-owner",
  });
  const staleTime = new Date(Date.now() - 60_000);
  fs.utimesSync(paths.serviceLockOwnerPath, staleTime, staleTime);

  const token = acquireServiceStartLock(paths, {
    pollMs: 1,
    processExists: (pid) => pid === 424242,
    processSampler: () => [{
      command: "node unrelated-long-lived-process.js",
      elapsed: "00:01",
      pgid: 424242,
      pid: 424242,
      ppid: 1,
      rssBytes: 1024,
      stat: "S",
      vszBytes: 0,
    }],
    timeoutMs: 10,
  });

  assert.equal(typeof token, "string");
  assert.equal(readJson(paths.serviceLockOwnerPath).pid, process.pid);
  assert.equal(readJson(paths.serviceLockOwnerPath).token, token);
});

test("CLI refuses to route through a service with mismatched broker identity", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);
  const otherHostConfigPath = path.join(fixture.root, "other-host-config.json");

  const start = runCli(fixture, "--host-config", otherHostConfigPath, "service", "start");
  assert.equal(start.status, 3);
  assert.equal(start.json.reasonCode, "service-identity-mismatch");
  assert.deepEqual(start.json.mismatchedFields, ["hostConfigPath"]);

  const status = runCli(fixture, "--host-config", otherHostConfigPath, "host", "status");
  assert.equal(status.status, 3);
  assert.equal(status.json.reasonCode, "service-identity-mismatch");
});

test("service validates expected identity immediately before command dispatch", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);
  const metadata = readJson(path.join(fixture.stateRoot, "brokerd.json"));

  const rejected = await requestService(fixture, {
    body: {
      command: "mystery",
      expectedServiceIdentity: {
        hostConfigPath: fixture.hostConfigPath,
        socketPath: metadata.socketPath,
        stateRoot: path.join(fixture.root, "other-state"),
      },
      group: "unknown",
      options: {},
    },
    method: "POST",
    requestPath: "/v1/command",
  });

  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json.reasonCode, "service-identity-mismatch");
  assert.deepEqual(rejected.json.mismatchedFields, ["stateRoot"]);
});

test("service rejects expired queued commands before command dispatch", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);

  const rejected = await requestService(fixture, {
    body: {
      clientCommandExecutionTimeoutMilliseconds: 25_000,
      clientCommandQueueTimeoutMilliseconds: 1,
      clientRequestStartedAtMilliseconds: Date.now() - 60_000,
      command: "status",
      group: "host",
      options: {},
      type: "command",
    },
    method: "POST",
    requestPath: "/v1/command",
  });

  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json.exitCode, 3);
  assert.equal(rejected.json.reasonCode, "service-command-expired");
  assert.equal(rejected.json.ok, false);
});

test("service command lock waits stay off the brokerd event loop", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);
  const paths = resolveBrokerPaths({
    hostConfigPath: fixture.hostConfigPath,
    stateRoot: fixture.stateRoot,
  });
  fs.mkdirSync(paths.leaseLockDir, { recursive: true });
  writeJson(paths.leaseLockOwnerPath, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  const blockedCommand = requestService(fixture, {
    body: {
      command: "release",
      group: "lease",
      options: {
        leaseId: "missing-lease",
        leaseLockTimeoutMilliseconds: 1000,
      },
      type: "command",
    },
    method: "POST",
    requestPath: "/v1/command",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const status = await Promise.race([
    requestServiceJson(fixture, "/v1/service/status"),
    new Promise((resolve) => setTimeout(() => resolve(null), 250)),
  ]);

  assert.equal(status?.statusCode, 200);
  assert.equal(status?.json?.ok, true);
  const blockedResult = await blockedCommand;
  assert.equal(blockedResult.statusCode, 409);
  assert.equal(blockedResult.json.reasonCode, "alias-busy");
});

test("service validates expected identity before stop dispatch", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);
  const metadata = readJson(path.join(fixture.stateRoot, "brokerd.json"));

  const rejected = await requestService(fixture, {
    body: {
      expectedServiceIdentity: {
        hostConfigPath: fixture.hostConfigPath,
        socketPath: metadata.socketPath,
        stateRoot: path.join(fixture.root, "other-state"),
      },
    },
    method: "POST",
    requestPath: "/v1/service/stop",
  });

  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json.reasonCode, "service-identity-mismatch");
  assert.deepEqual(rejected.json.mismatchedFields, ["stateRoot"]);

  const status = runCli(fixture, "service", "status");
  assert.equal(status.status, 0);
  assert.equal(status.json.running, true);
});

test("service serializes concurrent lease acquires for the same alias", async (t) => {
  const fixture = makeFixture(1);
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);

  const [left, right] = await Promise.all([
    runCliAsync(fixture, [
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
    ]),
    runCliAsync(fixture, [
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
    ]),
  ]);

  const results = [left, right];
  const successes = results.filter((result) => result.status === 0);
  const failures = results.filter((result) => result.status !== 0);

  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(successes[0].json.transport, "service");
  assert.equal(failures[0].status, 3);
  assert.equal(failures[0].json.exitCode, 3);
  assert.equal(failures[0].json.reasonCode, "no-matching-alias");
});

test("service-backed lease acquire attributes default actor id to the requesting client", async (t) => {
  const fixture = makeFixture(1);
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);

  const acquire = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--owner-pid",
    String(process.pid),
  );

  assert.equal(acquire.status, 0);
  assert.equal(acquire.json.transport, "service");
  assert.match(acquire.json.lease.actorId, /^agent:\d+$/);
  assert.notEqual(acquire.json.lease.actorId, `agent:${acquire.json.servedBy.pid}`);
});

test("leases and pins survive service restarts because state stays in broker-core storage", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));
  const leaseFile = path.join(fixture.root, "restart-lease.json");

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);

  const pin = runCli(
    fixture,
    "pin",
    "create",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--alias",
    "ui-1",
  );
  assert.equal(pin.status, 0);

  const acquire = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-restart",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
    "--lease-file",
    leaseFile,
  );
  assert.equal(acquire.status, 0);

  assert.equal(runCli(fixture, "service", "stop").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);

  const status = runCli(fixture, "host", "status");
  assert.equal(status.status, 0);
  const alias = status.json.simulators.find((candidate) => candidate.alias === "ui-1");
  assert.equal(alias.pin.projectId, "service-demo");
  assert.equal(alias.activeLeaseSummary.actorId, "agent-restart");

  assert.equal(runCli(fixture, "lease", "release", "--lease-file", leaseFile).status, 0);
  assert.equal(runCli(fixture, "pin", "clear", "--alias", "ui-1").status, 0);
});

test("events watch streams NDJSON from the local service", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);

  const watchPromise = runCliAsync(fixture, [
    "events",
    "watch",
    "--follow",
    "--json-lines",
    "--idle-timeout-ms",
    "700",
  ], {
    parseJson: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 150));

  const acquire = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-stream",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
  );
  assert.equal(acquire.status, 0);

  const watch = await watchPromise;
  assert.equal(watch.status, 0);
  const events = watch.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "host.initialized"));
  assert.ok(events.some((event) => event.type === "lease.acquired"));
});

test("service-backed event stream rejects stale cursors before streaming headers", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);

  const watch = runCli(
    fixture,
    "events",
    "watch",
    "--follow",
    "--json-lines",
    "--after-event-id",
    "missing-event-cursor",
    "--idle-timeout-ms",
    "100",
  );

  assert.equal(watch.status, 2, watch.stderr);
  assert.equal(watch.json.reasonCode, "event-cursor-not-found");

  const status = runCli(fixture, "service", "status");
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.json.running, true);
});

test("service-backed event stream rejects non-positive polling intervals", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);

  for (const pollIntervalMs of ["0", "-1"]) {
    const response = await requestServiceJson(
      fixture,
      `/v1/events/stream?follow=true&pollIntervalMs=${encodeURIComponent(pollIntervalMs)}`,
    );

    assert.equal(response.statusCode, 400);
    assert.equal(response.json.reasonCode, "invalid-command-request");
    assert.equal(response.json.exitCode, 2);
  }
});

test("raw service routes reject negative event limits", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);

  for (const requestPath of [
    "/v1/app/snapshot?eventLimit=-1",
    "/v1/events/stream?limit=-1",
  ]) {
    const response = await requestServiceJson(fixture, requestPath);

    assert.equal(response.statusCode, 400);
    assert.equal(response.json.reasonCode, "invalid-command-request");
    assert.equal(response.json.exitCode, 2);
  }
});

test("events watch follow without idle timeout stays attached while quiet", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);

  const watcher = spawn(process.execPath, cliArgs(fixture, [
    "events",
    "watch",
    "--follow",
    "--json-lines",
  ]), {
    env: {
      ...process.env,
      ...fixture.simctl?.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let closed = false;
  watcher.stdout.setEncoding("utf8");
  watcher.stderr.setEncoding("utf8");
  watcher.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  watcher.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  watcher.on("close", () => {
    closed = true;
  });
  t.after(() => {
    if (!closed) {
      watcher.kill("SIGTERM");
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 2300));
  assert.equal(closed, false, stderr);

  const acquire = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-late-stream",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
  );
  assert.equal(acquire.status, 0);
  await waitFor(() => stdout.includes("lease.acquired"));
  watcher.kill("SIGTERM");
});

test("service stop closes active event streams", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);

  const watcher = runCliAsync(fixture, [
    "events",
    "watch",
    "--follow",
    "--json-lines",
  ], {
    parseJson: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 250));

  const stopped = runCli(fixture, "service", "stop");
  assert.equal(stopped.status, 0, stopped.stderr);

  const watch = await watcher;
  assert.equal(watch.status, 0, watch.stderr);
});

test("service exposes the app snapshot route and keeps the snapshot artifact current", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);

  const acquire = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-app-service",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
  );
  assert.equal(acquire.status, 0);

  const response = await requestServiceJson(fixture, "/v1/app/snapshot?eventLimit=10");
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.servedBy.transport, "unix-http");
  assert.equal(response.json.hostConfigPath, fixture.hostConfigPath);
  assert.equal(response.json.activeLeases[0].actorId, "agent-app-service");
  assert.equal(response.json.projects[0].projectFilePath, fixture.projectFilePath);
  assert.equal(response.json.projects[0].purposes[0].displayName, "Agent UI Session");

  const artifact = JSON.parse(fs.readFileSync(path.join(fixture.stateRoot, "app-snapshot.json"), "utf8"));
  assert.equal(artifact.hostConfigPath, fixture.hostConfigPath);
  assert.equal(artifact.overview.leasedAliases, 1);
  assert.equal(artifact.activeLeases[0].actorId, "agent-app-service");
});

test("service-backed capacity preview matches direct plan id and apply uses service transport", async (t) => {
  const fixture = makeCapacityFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  const directPreview = runCliWithEnv(
    fixture,
    { SIMBROKER_LOCAL_ONLY: "1" },
    "capacity",
    "reconcile",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ipad-session",
    "--json",
  );
  assert.equal(directPreview.status, 0);
  assert.equal(directPreview.json.transport, "direct");
  assert.equal(runCli(fixture, "service", "start").status, 0);

  const serviceCheck = runCli(
    fixture,
    "capacity",
    "check",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ipad-session",
    "--json",
  );
  assert.equal(serviceCheck.status, 0);
  assert.equal(serviceCheck.json.transport, "service");
  assert.equal(Object.hasOwn(serviceCheck.json, "servedBy"), false);
  assert.equal(JSON.stringify(serviceCheck.json).includes(fixture.root), false);

  const servicePreview = runCli(
    fixture,
    "capacity",
    "reconcile",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ipad-session",
    "--json",
  );
  assert.equal(servicePreview.status, 0);
  assert.equal(servicePreview.json.transport, "service");
  assert.equal(Object.hasOwn(servicePreview.json, "servedBy"), false);
  assert.equal(JSON.stringify(servicePreview.json).includes(fixture.root), false);
  assert.equal(servicePreview.json.planId, directPreview.json.planId);
  assert.deepEqual(servicePreview.json.actions, directPreview.json.actions);

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
    servicePreview.json.planId,
    "--actor-type",
    "human",
    "--actor-id",
    "operator",
    "--json",
  );
  assert.equal(apply.status, 0);
  assert.equal(apply.json.transport, "service");
  assert.equal(apply.json.status, "applied");
  assert.equal(apply.json.created, 1);

  const events = runCli(fixture, "events", "watch", "--type", "capacity.reconcile.applied");
  assert.equal(events.status, 0);
  assert.equal(events.json.events.length, 1);
  assert.equal(events.json.events[0].projectId, "capacity-service-demo");
});

test("service-backed repair can force-override a conflicting lease and audit the change", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);

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

  const registryPath = path.join(fixture.stateRoot, "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  registry.aliases["ui-1"].health = "repair-needed";
  registry.aliases["ui-1"].driftReason = "manual-drift";
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

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
  assert.notEqual(deniedRepair.status, 0);
  assert.equal(deniedRepair.status, 5);
  assert.equal(deniedRepair.json.exitCode, 5);
  assert.equal(deniedRepair.json.reasonCode, "human-override-required");

  const repair = runCli(
    fixture,
    "simulators",
    "repair",
    "--alias",
    "ui-1",
    "--actor-id",
    "human-operator",
    "--actor-type",
    "human",
    "--force-override",
    "--override-reason",
    "recover broken simulator",
    "--expected-alias",
    "ui-1",
    "--expected-lease-id",
    acquire.json.lease.leaseId,
  );
  assert.equal(repair.status, 0);
  assert.equal(repair.json.transport, "service");
  assert.equal(repair.json.revokedLease.leaseId, acquire.json.lease.leaseId);
  assert.equal(repair.json.simulator.health, "healthy");
  assert.equal(repair.json.simulator.powerState, "shutdown");

  const status = runCli(fixture, "host", "status");
  const alias = status.json.simulators.find((candidate) => candidate.alias === "ui-1");
  assert.equal(alias.activeLeaseSummary, null);
  assert.equal(alias.health, "healthy");

  const events = runCli(fixture, "events", "watch");
  assert.equal(events.status, 0);
  assert.ok(events.json.events.some((event) => event.type === "lease.revoked" && event.leaseId === acquire.json.lease.leaseId));
  assert.ok(events.json.events.some((event) => event.type === "simulator.repaired" && event.alias === "ui-1"));
});

test("service HTTP error responses expose stable status classes and exit codes", async (t) => {
  const fixture = makeFixture(1);
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);

  const invalidRequest = await requestService(fixture, {
    body: {
      command: "mystery",
      group: "unknown",
      options: {},
    },
    method: "POST",
    requestPath: "/v1/command",
  });
  assert.equal(invalidRequest.statusCode, 400);
  assert.equal(invalidRequest.json.exitCode, 2);
  assert.equal(invalidRequest.json.reasonCode, "unknown-command");

  assert.equal(runCli(
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
  ).status, 0);

  const exhausted = await requestService(fixture, {
    body: {
      command: "acquire",
      group: "lease",
      options: {
        actorId: "agent-secondary",
        actorType: "agent",
        ownerPid: process.pid,
        projectFilePath: fixture.projectFilePath,
        purposeId: "agent-ui-session",
      },
    },
    method: "POST",
    requestPath: "/v1/command",
  });
  assert.equal(exhausted.statusCode, 409);
  assert.equal(exhausted.json.exitCode, 3);
  assert.equal(exhausted.json.reasonCode, "no-matching-alias");

  const overrideRequired = await requestService(fixture, {
    body: {
      command: "repair",
      group: "simulators",
      options: {
        actorId: "agent-other",
        actorType: "agent",
        alias: "ui-1",
      },
    },
    method: "POST",
    requestPath: "/v1/command",
  });
  assert.equal(overrideRequired.statusCode, 412);
  assert.equal(overrideRequired.json.exitCode, 5);
  assert.equal(overrideRequired.json.reasonCode, "human-override-required");

  const registryPath = path.join(fixture.stateRoot, "registry.json");
  const registry = readJson(registryPath);
  registry.aliases["ui-1"].health = "repair-needed";
  registry.aliases["ui-1"].driftReason = "simulator-missing";
  writeJson(registryPath, registry);

  const repairNeeded = await requestService(fixture, {
    body: {
      command: "boot",
      group: "simulators",
      options: {
        alias: "ui-1",
      },
    },
    method: "POST",
    requestPath: "/v1/command",
  });
  assert.equal(repairNeeded.statusCode, 423);
  assert.equal(repairNeeded.json.exitCode, 4);
  assert.equal(repairNeeded.json.reasonCode, "unhealthy-alias");
});

test("service-backed project validation maps malformed project JSON to invalid config", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);
  fs.writeFileSync(fixture.projectFilePath, "{not-json\n");

  const result = runCli(
    fixture,
    "project",
    "validate",
    "--repo-root",
    fixture.repoRoot,
  );

  assert.equal(result.status, 2);
  assert.equal(result.json.reasonCode, "invalid-config");
  assert.equal(result.json.exitCode, 2);
});

test("service-backed mutations keep committed work when idle policy is malformed", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  const acquired = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-app-service",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
  );
  assert.equal(acquired.status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);
  fs.writeFileSync(path.join(fixture.stateRoot, "idle-policy.json"), "{not-json\n");

  const release = await requestService(fixture, {
    body: {
      command: "release",
      group: "lease",
      options: {
        actorId: "simulator-broker-app",
        actorType: "human",
        leaseId: acquired.json.lease.leaseId,
      },
      type: "command",
    },
    method: "POST",
    requestPath: "/v1/command",
  });

  assert.equal(release.statusCode, 200);
  assert.equal(release.json.ok, true);
  assert.equal(release.json.snapshotRefresh, undefined);
  assert.equal(fs.existsSync(path.join(fixture.stateRoot, "leases", `${acquired.json.lease.leaseId}.json`)), false);
});

test("service-backed lease acquire preserves committed leases when idle policy metadata is malformed", async (t) => {
  const fixture = makeFixture();
  t.after(async () => stopServiceIfRunning(fixture));

  assert.equal(runCli(fixture, "host", "init").status, 0);
  assert.equal(runCli(fixture, "service", "start").status, 0);
  fs.writeFileSync(path.join(fixture.stateRoot, "idle-policy.json"), "{not-json\n");

  const acquired = runCli(
    fixture,
    "lease",
    "acquire",
    "--repo-root",
    fixture.repoRoot,
    "--purpose",
    "agent-ui-session",
    "--actor-id",
    "agent-app-service",
    "--actor-type",
    "agent",
    "--owner-pid",
    String(process.pid),
  );

  assert.equal(acquired.status, 0, acquired.stderr);
  assert.equal(acquired.json.transport, "service");
  assert.equal(acquired.json.snapshotRefresh, undefined);
  assert.deepEqual(acquired.json.scheduler, {
    active: false,
    limitation: "invalid-config",
  });
  assert.equal(fs.existsSync(path.join(fixture.stateRoot, "leases", `${acquired.json.lease.leaseId}.json`)), true);
});
