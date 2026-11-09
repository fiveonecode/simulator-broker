import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BrokerError,
  acquireLeaseBroker,
  cleanupIdleBroker,
  deletePurposeSimulatorsBroker,
  deleteSimulatorBroker,
  enableIdlePolicyBroker,
  eraseSimulatorBroker,
  hostStatusBroker,
  initBroker,
  readEventsBroker,
  reconcileUiPrepareBroker,
  releaseLeaseBroker,
  repairSimulatorBroker,
  resolveBrokerPaths,
} from "../index.mjs";
import { createDeviceRecord, createSimctlFixture } from "./support/simctl-fixture.mjs";

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-ui-prepare-"));
  const simctl = createSimctlFixture(root, {
    devices: [
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
    ],
  });
  const paths = {
    hostConfigPath: path.join(root, "host-config.json"),
    projectFilePath: path.join(root, "repo/.simulator-broker/project.json"),
    root,
    simctl,
    stateRoot: path.join(root, "state"),
  };
  writeJson(paths.hostConfigPath, {
    version: 1,
    hostId: "test-host",
    aliases: ["SIM-UI-1", "SIM-UI-2"].map((simulatorId, index) => ({
      alias: `ui-${index + 1}`,
      capabilities: ["interactive-resettable"],
      deviceFamily: "iPhone",
      displayName: `UI ${index + 1}`,
      iosVersion: "18.2",
      resetPolicy: "erase-on-acquire",
      simulatorId,
    })),
  });
  writeJson(paths.projectFilePath, {
    version: 1,
    projectId: "demo-app",
    projectName: "Demo App",
    purposes: [{
      id: "agent-ui-session",
      displayName: "Agent UI Session",
      capability: "interactive-resettable",
      defaultActorType: "agent",
      requires: { deviceFamily: "iPhone", iosVersion: "18" },
    }],
  });
  const resolvedPaths = resolveBrokerPaths({
    hostConfigPath: paths.hostConfigPath,
    projectFilePath: paths.projectFilePath,
    stateRoot: paths.stateRoot,
  });
  const calls = [];
  const adapter = new Proxy(paths.simctl.adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args) => {
        if (property === "shutdownDevice" || property === "eraseDevice" || property === "bootDevice" || property === "waitForBooted") {
          calls.push([property, args[0]]);
        }
        return value.apply(target, args);
      };
    },
  });
  initBroker(resolvedPaths, {
    processExists: () => true,
    simctlAdapter: adapter,
  });
  return { adapter, calls, paths, resolvedPaths };
}

function runtimeOptions(fixture, overrides = {}) {
  return {
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    simctlAdapter: fixture.adapter,
    ...overrides,
  };
}

test("a prepared UI alias is reused with waitReady and the next lease erases again", () => {
  const fixture = makeFixture();
  const first = acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
    actorId: "agent-a",
    actorType: "agent",
    purposeId: "agent-ui-session",
  })).lease;
  const erasesAfterFirst = fixture.calls.filter((call) => call[0] === "eraseDevice").length;
  assert.equal(erasesAfterFirst, 1);
  releaseLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, { leaseId: first.leaseId }));
  assert.equal(fixture.calls.filter((call) => call[0] === "eraseDevice").length, 1);
  reconcileUiPrepareBroker(fixture.resolvedPaths, runtimeOptions(fixture));
  assert.equal(fixture.calls.filter((call) => call[0] === "eraseDevice").length, 2);
  const registry = readJson(path.join(fixture.paths.stateRoot, "registry.json"));
  assert.equal(registry.aliases[first.alias].prepare, null);
  assert.equal(registry.aliases[first.alias].cleanProof.ready, true);
  assert.equal(registry.aliases[first.alias].cleanProofConsumedBy, null);
  assert.equal(registry.aliases[first.alias].cleanProof.dataIdentity.includes(":"), true);

  fixture.calls.length = 0;
  const second = acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
    actorId: "agent-b",
    actorType: "agent",
    purposeId: "agent-ui-session",
  })).lease;
  assert.equal(second.alias, first.alias);
  assert.deepEqual(fixture.calls.map((call) => call[0]), ["waitForBooted"]);
  assert.equal(readJson(path.join(fixture.paths.stateRoot, "registry.json")).aliases[second.alias].cleanProofConsumedBy, second.leaseId);
  releaseLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, { leaseId: second.leaseId }));

  fixture.calls.length = 0;
  acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
    actorId: "agent-c",
    actorType: "agent",
    purposeId: "agent-ui-session",
  }));
  assert.equal(fixture.calls.some((call) => call[0] === "eraseDevice"), true);
  const events = readEventsBroker(fixture.resolvedPaths, { type: "simulator.prepared" }).events ?? readEventsBroker(fixture.resolvedPaths, {}).events;
  const prepared = (events ?? []).filter((event) => event.type === "simulator.prepared");
  assert.equal(prepared.length > 0, true);
  assert.equal(Object.hasOwn(prepared[0].payload, "dataIdentity"), false);
  assert.equal(prepared[0].payload.source, "lease-release");
});

test("an empty runtime list does not latch repair-needed during UI prepare", () => {
  const fixture = makeFixture();
  const lease = acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
    actorId: "agent-a",
    actorType: "agent",
    purposeId: "agent-ui-session",
  })).lease;
  releaseLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, { leaseId: lease.leaseId }));
  const registryPath = path.join(fixture.paths.stateRoot, "registry.json");
  const registry = readJson(registryPath);
  registry.aliases[lease.alias].prepare.ownerPid = process.pid;
  registry.aliases[lease.alias].prepare.state = "erasing";
  writeJson(registryPath, registry);
  holdAliasResetLock(fixture, lease.alias);
  const simctlState = readJson(fixture.paths.simctl.statePath);
  simctlState.runtimes = [];
  writeJson(fixture.paths.simctl.statePath, simctlState);

  const status = hostStatusBroker(fixture.resolvedPaths, runtimeOptions(fixture));
  const alias = status.simulators.find((simulator) => simulator.alias === lease.alias);
  assert.equal(alias.health, "healthy");
  assert.equal(alias.prepareState, "erasing");
});

test("a lease opened during erase is not reclaimed as a dead owner", () => {
  const fixture = makeFixture();
  const survivorId = "00000000-0000-4000-8000-000000000099";
  const adapter = new Proxy(fixture.adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "eraseDevice") {
        return value;
      }
      return (simulatorId) => {
        const registeredAt = new Date().toISOString();
        writeJson(path.join(fixture.paths.stateRoot, "leases", `${survivorId}.json`), {
          actorId: "agent-survivor",
          actorType: "agent",
          alias: "ui-2",
          leaseId: survivorId,
          ownerPid: process.pid,
          projectId: "demo-app",
          purposeId: "agent-ui-session",
          runtime: { ownerPid: process.pid, ownerRegisteredAt: registeredAt },
          simulatorId: "SIM-UI-2",
          startedAt: registeredAt,
        });
        return value.call(target, simulatorId);
      };
    },
  });
  acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
    actorId: "agent-a",
    actorType: "agent",
    processSampler: () => [{
      command: "node",
      elapsed: "01:00:00",
      pgid: process.pid,
      pid: process.pid,
      state: "R",
    }],
    purposeId: "agent-ui-session",
    simctlAdapter: adapter,
  }));
  assert.equal(fs.existsSync(path.join(fixture.paths.stateRoot, "leases", `${survivorId}.json`)), true);
  const registry = readJson(path.join(fixture.paths.stateRoot, "registry.json"));
  assert.equal(registry.aliases["ui-2"].activeLeaseId, survivorId);
});

test("acquire does not reclaim a lease that was replaced during boot", () => {
  const fixture = makeFixture();
  const replacementId = "00000000-0000-4000-8000-000000000088";
  const adapter = new Proxy(fixture.adapter, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "bootDevice") {
        return value;
      }
      return (simulatorId) => {
        const result = value.call(target, simulatorId);
        const leasesDir = path.join(fixture.paths.stateRoot, "leases");
        const originalName = fs.readdirSync(leasesDir).find((name) => name.endsWith(".json"));
        const registryPath = path.join(fixture.paths.stateRoot, "registry.json");
        const registry = readJson(registryPath);
        const original = readJson(path.join(leasesDir, originalName));
        fs.rmSync(path.join(leasesDir, originalName));
        writeJson(path.join(leasesDir, `${replacementId}.json`), {
          ...original,
          actorId: "agent-replacement",
          leaseId: replacementId,
        });
        registry.aliases[original.alias].activeLeaseId = replacementId;
        writeJson(registryPath, registry);
        return result;
      };
    },
  });
  assert.throws(() => {
    acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
      actorId: "agent-a",
      actorType: "agent",
      purposeId: "agent-ui-session",
      simctlAdapter: adapter,
    }));
  }, (error) => error instanceof BrokerError && error.payload?.reasonCode === "lease-lost");
  const registry = readJson(path.join(fixture.paths.stateRoot, "registry.json"));
  assert.equal(registry.aliases["ui-1"].activeLeaseId, replacementId);
  assert.equal(registry.aliases["ui-1"].health, "healthy");
  assert.equal(fs.existsSync(path.join(fixture.paths.stateRoot, "leases", `${replacementId}.json`)), true);
});

test("a missing device still becomes repair-needed and records the reason", () => {
  const fixture = makeFixture();
  const simctlState = readJson(fixture.paths.simctl.statePath);
  simctlState.devices = simctlState.devices.filter((device) => device.udid !== "SIM-UI-1");
  writeJson(fixture.paths.simctl.statePath, simctlState);
  hostStatusBroker(fixture.resolvedPaths, runtimeOptions(fixture));
  const registry = readJson(path.join(fixture.paths.stateRoot, "registry.json"));
  assert.equal(registry.aliases["ui-1"].health, "repair-needed");
  assert.equal(registry.aliases["ui-1"].driftReason, "simulator-missing");
  const events = readEventsBroker(fixture.resolvedPaths, {}).events;
  const unhealthy = events.filter((event) => event.type === "simulator.unhealthy" && event.alias === "ui-1");
  assert.equal(unhealthy.length, 1);
  assert.equal(unhealthy[0].payload.driftReason, "simulator-missing");
});

test("an unresolved runtime on an idle alias is a mismatch only when an iOS runtime exists", () => {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.paths.stateRoot, "registry.json");
  const registry = readJson(registryPath);
  registry.aliases["ui-1"].health = "repairing";
  writeJson(registryPath, registry);
  const simctlState = readJson(fixture.paths.simctl.statePath);
  simctlState.devices.find((device) => device.udid === "SIM-UI-2").runtimeIdentifier = "com.apple.CoreSimulator.SimRuntime.missing";
  writeJson(fixture.paths.simctl.statePath, simctlState);

  hostStatusBroker(fixture.resolvedPaths, runtimeOptions(fixture));
  const afterIos = readJson(registryPath);
  assert.equal(afterIos.aliases["ui-1"].health, "repair-needed");
  assert.equal(afterIos.aliases["ui-1"].driftReason, "repair-interrupted");
  assert.equal(afterIos.aliases["ui-2"].health, "repair-needed");
  assert.equal(afterIos.aliases["ui-2"].driftReason, "simulator-config-mismatch");
  const events = readEventsBroker(fixture.resolvedPaths, {}).events.filter((event) => event.type === "simulator.unhealthy");
  assert.equal(events.some((event) => event.alias === "ui-1" && event.payload.driftReason === "repair-interrupted"), true);

  const watchOnly = makeFixture();
  const watchState = readJson(watchOnly.paths.simctl.statePath);
  watchState.runtimes = [{
    identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-11-0",
    isAvailable: true,
    version: "11.0",
  }];
  watchState.devices = watchState.devices.filter((device) => device.udid !== "SIM-UI-1");
  writeJson(watchOnly.paths.simctl.statePath, watchState);
  hostStatusBroker(watchOnly.resolvedPaths, runtimeOptions(watchOnly));
  assert.equal(readJson(path.join(watchOnly.paths.stateRoot, "registry.json")).aliases["ui-1"].health, "healthy");
});

function writeLockOwner(dir, startedAt) {
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "owner.json"), {
    pid: process.pid,
    startedAt,
  });
}

function holdAliasResetLock(fixture, alias) {
  writeLockOwner(
    path.join(fixture.paths.stateRoot, "locks", "reset", `${alias}.lock`),
    new Date().toISOString(),
  );
}

test("a recycled reset-capacity owner does not keep the slot", () => {
  const fixture = makeFixture();
  const lease = acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
    actorId: "agent-a",
    actorType: "agent",
    purposeId: "agent-ui-session",
  })).lease;
  releaseLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, { leaseId: lease.leaseId }));
  fixture.calls.length = 0;
  const startedAt = "2000-01-01T00:00:00.000Z";
  for (const slot of ["1", "2"]) {
    writeLockOwner(path.join(fixture.paths.stateRoot, "locks", "reset-capacity", slot), startedAt);
  }

  reconcileUiPrepareBroker(fixture.resolvedPaths, {
    resetLockTimeoutMilliseconds: 400,
    simctlAdapter: fixture.adapter,
  });

  assert.deepEqual(fixture.calls.filter((call) => call[0] === "eraseDevice"), [["eraseDevice", "SIM-UI-1"]]);
});

function holdResetCapacity(stateRoot) {
  const startedAt = new Date().toISOString();
  for (const slot of ["1", "2"]) {
    writeLockOwner(path.join(stateRoot, "locks", "reset-capacity", slot), startedAt);
  }
}

function releaseResetCapacity(stateRoot) {
  fs.rmSync(path.join(stateRoot, "locks", "reset-capacity"), { force: true, recursive: true });
}

function writeSurvivorLease(stateRoot, survivorId) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
  const registeredAt = new Date().toISOString();
  writeJson(path.join(stateRoot, "leases", `${survivorId}.json`), {
    actorId: "agent-survivor",
    actorType: "agent",
    alias: "ui-2",
    leaseId: survivorId,
    ownerPid: process.pid,
    projectId: "demo-app",
    purposeId: "agent-ui-session",
    runtime: { ownerPid: process.pid, ownerRegisteredAt: registeredAt },
    simulatorId: "SIM-UI-2",
    startedAt: registeredAt,
  });
}

function liveProcessSampler() {
  return [{
    command: "node",
    elapsed: "01:00:00",
    pgid: process.pid,
    pid: process.pid,
    state: "R",
  }];
}

test("a lease opened while acquire waits for reset capacity stays live", () => {
  const fixture = makeFixture();
  holdResetCapacity(fixture.paths.stateRoot);
  const survivorId = "00000000-0000-4000-8000-000000000097";
  let planted = false;
  acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
    actorId: "agent-a",
    actorType: "agent",
    processExists(pid) {
      if (!planted && pid === process.pid) {
        planted = true;
        writeSurvivorLease(fixture.paths.stateRoot, survivorId);
        releaseResetCapacity(fixture.paths.stateRoot);
      }
      return pid === process.pid;
    },
    processSampler: liveProcessSampler,
    purposeId: "agent-ui-session",
  }));
  assert.equal(planted, true);
  assert.equal(fs.existsSync(path.join(fixture.paths.stateRoot, "leases", `${survivorId}.json`)), true);
  const registry = readJson(path.join(fixture.paths.stateRoot, "registry.json"));
  assert.equal(registry.aliases["ui-2"].activeLeaseId, survivorId);
});

test("a lease opened while prepare waits for reset capacity stays live", () => {
  const fixture = makeFixture();
  const lease = acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
    actorId: "agent-a",
    actorType: "agent",
    purposeId: "agent-ui-session",
  })).lease;
  releaseLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, { leaseId: lease.leaseId }));
  holdResetCapacity(fixture.paths.stateRoot);
  const survivorId = "00000000-0000-4000-8000-000000000096";
  let planted = false;
  reconcileUiPrepareBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
    processExists(pid) {
      if (!planted && pid === process.pid) {
        planted = true;
        writeSurvivorLease(fixture.paths.stateRoot, survivorId);
        releaseResetCapacity(fixture.paths.stateRoot);
      }
      return pid === process.pid;
    },
    processSampler: liveProcessSampler,
  }));
  assert.equal(planted, true);
  assert.equal(fs.existsSync(path.join(fixture.paths.stateRoot, "leases", `${survivorId}.json`)), true);
  const registry = readJson(path.join(fixture.paths.stateRoot, "registry.json"));
  assert.equal(registry.aliases["ui-2"].activeLeaseId, survivorId);
});

test("acquire does not erase a lease that replaced it during the reset wait", () => {
  const fixture = makeFixture();
  holdResetCapacity(fixture.paths.stateRoot);
  const replacementId = "00000000-0000-4000-8000-000000000077";
  let planted = false;
  assert.throws(() => {
    acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
      actorId: "agent-a",
      actorType: "agent",
      processExists(pid) {
        if (!planted && pid === process.pid) {
          planted = true;
          const leasesDir = path.join(fixture.paths.stateRoot, "leases");
          const [originalName] = fs.readdirSync(leasesDir).filter((name) => name.endsWith(".json"));
          const original = readJson(path.join(leasesDir, originalName));
          fs.rmSync(path.join(leasesDir, originalName));
          const registeredAt = new Date().toISOString();
          writeJson(path.join(leasesDir, `${replacementId}.json`), {
            actorId: "agent-replacement",
            actorType: "agent",
            alias: original.alias,
            leaseId: replacementId,
            ownerPid: process.pid,
            projectId: original.projectId,
            purposeId: original.purposeId,
            runtime: { ownerPid: process.pid, ownerRegisteredAt: registeredAt },
            simulatorId: original.simulatorId,
            startedAt: registeredAt,
          });
          const registryPath = path.join(fixture.paths.stateRoot, "registry.json");
          const registry = readJson(registryPath);
          registry.aliases[original.alias].activeLeaseId = replacementId;
          writeJson(registryPath, registry);
          releaseResetCapacity(fixture.paths.stateRoot);
        }
        return pid === process.pid;
      },
      processSampler: liveProcessSampler,
      purposeId: "agent-ui-session",
    }));
  }, (error) => error instanceof BrokerError && error.payload?.reasonCode === "lease-lost" && error.exitCode === 3);
  assert.equal(planted, true);
  assert.equal(fixture.calls.some((call) => call[0] === "eraseDevice" || call[0] === "shutdownDevice" || call[0] === "bootDevice"), false);
  assert.equal(fs.existsSync(path.join(fixture.paths.stateRoot, "leases", `${replacementId}.json`)), true);
  const registry = readJson(path.join(fixture.paths.stateRoot, "registry.json"));
  assert.equal(registry.aliases["ui-1"].activeLeaseId, replacementId);
  assert.equal(registry.aliases["ui-1"].health, "healthy");
});

test("a dead prepare owner does not keep the alias unusable", () => {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.paths.stateRoot, "registry.json");
  const registry = readJson(registryPath);
  registry.aliases["ui-1"].powerState = "booted";
  registry.aliases["ui-1"].prepare = {
    ownerPid: 999999,
    state: "erasing",
    token: "dead-prepare",
  };
  writeJson(registryPath, registry);

  const lease = acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
    actorId: "agent-a",
    actorType: "agent",
    purposeId: "agent-ui-session",
  })).lease;

  assert.equal(lease.alias, "ui-1");
  assert.equal(fixture.calls.some((call) => call[0] === "eraseDevice"), true);
  const after = readJson(registryPath);
  assert.equal(after.aliases["ui-1"].prepare?.state ?? null, null);
  assert.equal(after.aliases["ui-1"].health, "healthy");
});

test("a reused prepare owner pid does not keep the alias unusable", () => {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.paths.stateRoot, "registry.json");
  const registry = readJson(registryPath);
  registry.aliases["ui-1"].powerState = "booted";
  registry.aliases["ui-1"].prepare = {
    ownerPid: process.pid,
    ownerStartedAt: "2000-01-01T00:00:00.000Z",
    state: "erasing",
    token: "reused-prepare",
  };
  writeJson(registryPath, registry);

  const lease = acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
    actorId: "agent-a",
    actorType: "agent",
    processSampler: liveProcessSampler,
    purposeId: "agent-ui-session",
  })).lease;

  assert.equal(lease.alias, "ui-1");
  assert.equal(fixture.calls.some((call) => call[0] === "eraseDevice"), true);
  assert.equal(readJson(registryPath).aliases["ui-1"].health, "healthy");
});

test("a live prepare pid does not keep the alias unusable after the reset lock is free", () => {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.paths.stateRoot, "registry.json");
  const registry = readJson(registryPath);
  registry.aliases["ui-1"].powerState = "booted";
  registry.aliases["ui-1"].prepare = {
    ownerPid: process.pid,
    ownerStartedAt: new Date().toISOString(),
    state: "erasing",
    token: "live-prepare",
  };
  writeJson(registryPath, registry);

  const lease = acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
    actorId: "agent-a",
    actorType: "agent",
    purposeId: "agent-ui-session",
  })).lease;

  assert.equal(lease.alias, "ui-1");
  assert.equal(fixture.calls.some((call) => call[0] === "eraseDevice"), true);
  const after = readJson(registryPath);
  assert.equal(after.aliases["ui-1"].prepare ?? null, null);
  assert.equal(after.aliases["ui-1"].health, "healthy");
});

test("an inventory failure before shutdown drops the lease without repair", () => {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.paths.stateRoot, "registry.json");
  const before = readJson(registryPath).aliases["ui-1"];
  const originalListDeviceTypes = fixture.adapter.listDeviceTypes.bind(fixture.adapter);
  let thrown = false;
  fixture.adapter.listDeviceTypes = () => {
    const leaseExists = fs.readdirSync(fixture.resolvedPaths.leasesDir).some((name) => name.endsWith(".json"));
    if (leaseExists && !thrown) {
      thrown = true;
      throw new Error("simctl list devicetypes timed out after 120000ms");
    }
    return originalListDeviceTypes();
  };

  assert.throws(() => {
    acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
      actorId: "agent-a",
      actorType: "agent",
      purposeId: "agent-ui-session",
    }));
  }, (error) => error instanceof Error && /timed out/.test(error.message) && error.beforeDeviceMutation === true);

  assert.equal(thrown, true);
  assert.equal(fixture.calls.some((call) => call[0] === "shutdownDevice" || call[0] === "eraseDevice" || call[0] === "bootDevice"), false);
  const after = readJson(registryPath).aliases["ui-1"];
  assert.equal(after.health, before.health);
  assert.equal(after.driftReason ?? null, before.driftReason ?? null);
  assert.deepEqual(after.cleanProof ?? null, before.cleanProof ?? null);
  assert.equal(after.prepare ?? null, before.prepare ?? null);
  assert.equal(after.activeLeaseId, null);
  assert.equal(fs.readdirSync(fixture.resolvedPaths.leasesDir).length, 0);
});

// The mutation lock polls every 150ms. A 400ms timeout fails on the third
// poll. The fourth blocked mkdir is the follow-up drop, which must succeed.
function blockNthNewLeaseLock(lockDir, ownerPath, nthNewDirectory, run) {
  const originalMkdirSync = fs.mkdirSync;
  let newDirectories = 0;
  let blocking = false;
  let blockedAttempts = 0;
  fs.mkdirSync = function patchedMkdirSync(target, ...args) {
    if (target !== lockDir) {
      return originalMkdirSync.call(fs, target, ...args);
    }
    if (blocking) {
      blockedAttempts += 1;
      if (blockedAttempts >= 4) {
        fs.rmSync(lockDir, { force: true, recursive: true });
        blocking = false;
        return originalMkdirSync.call(fs, target, ...args);
      }
      const held = new Error("EEXIST");
      held.code = "EEXIST";
      throw held;
    }
    if (!fs.existsSync(target)) {
      newDirectories += 1;
      if (newDirectories === nthNewDirectory) {
        originalMkdirSync.call(fs, target);
        writeJson(ownerPath, {
          pid: process.pid,
          startedAt: new Date().toISOString(),
        });
        blocking = true;
        const held = new Error("EEXIST");
        held.code = "EEXIST";
        throw held;
      }
    }
    return originalMkdirSync.call(fs, target, ...args);
  };
  try {
    return run();
  } finally {
    fs.mkdirSync = originalMkdirSync;
    fs.rmSync(lockDir, { force: true, recursive: true });
  }
}

function assertDroppedLockWait(error) {
  assert.equal(error instanceof BrokerError, true);
  assert.equal(error.payload?.reasonCode, "alias-busy");
  assert.equal(error.exitCode, 3);
  assert.equal(error.payload?.leaseId, undefined);
  assert.equal(error.payload?.rollbackFailed, undefined);
  return true;
}

test("a publish lock timeout after simctl drops the lease without repair", () => {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.paths.stateRoot, "registry.json");
  const before = readJson(registryPath).aliases["ui-1"];

  assert.throws(() => {
    blockNthNewLeaseLock(
      fixture.resolvedPaths.leaseLockDir,
      fixture.resolvedPaths.leaseLockOwnerPath,
      3,
      () => {
        acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
          actorId: "agent-a",
          actorType: "agent",
          purposeId: "agent-ui-session",
          resetLockTimeoutMilliseconds: 400,
        }));
      },
    );
  }, assertDroppedLockWait);

  const after = readJson(registryPath).aliases["ui-1"];
  assert.equal(fixture.calls.some((call) => call[0] === "eraseDevice"), true);
  assert.equal(fixture.calls.some((call) => call[0] === "bootDevice"), true);
  assert.equal(after.health, before.health);
  assert.equal(after.driftReason, before.driftReason);
  assert.deepEqual(after.cleanProof ?? null, before.cleanProof ?? null);
  assert.equal(after.prepare ?? null, before.prepare ?? null);
  assert.equal(after.activeLeaseId, null);
  assert.equal(fs.readdirSync(fixture.resolvedPaths.leasesDir).length, 0);
  assert.equal(readEventsBroker(fixture.resolvedPaths, {}).events.some((event) => event.type === "lease.acquired"), false);
});

test("a lease.acquired lock timeout drops the lease without changing health", () => {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.paths.stateRoot, "registry.json");

  assert.throws(() => {
    blockNthNewLeaseLock(
      fixture.resolvedPaths.leaseLockDir,
      fixture.resolvedPaths.leaseLockOwnerPath,
      4,
      () => {
        acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
          actorId: "agent-a",
          actorType: "agent",
          purposeId: "agent-ui-session",
          resetLockTimeoutMilliseconds: 400,
        }));
      },
    );
  }, assertDroppedLockWait);

  const after = readJson(registryPath).aliases["ui-1"];
  assert.equal(fixture.calls.some((call) => call[0] === "eraseDevice"), true);
  assert.equal(after.health, "healthy");
  assert.equal(after.driftReason, null);
  assert.equal(after.cleanProof?.ready, true);
  assert.equal(after.powerState, "booted");
  assert.equal(after.activeLeaseId, null);
  assert.equal(fs.readdirSync(fixture.resolvedPaths.leasesDir).length, 0);
  const events = readEventsBroker(fixture.resolvedPaths, {}).events;
  assert.equal(events.some((event) => event.type === "simulator.booted"), true);
  assert.equal(events.some((event) => event.type === "lease.acquired"), false);
});

test("purpose delete counts a preparing UI alias as held", () => {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.paths.stateRoot, "registry.json");
  const registry = readJson(registryPath);
  registry.aliases["ui-1"].health = "repair-needed";
  registry.aliases["ui-1"].driftReason = "runtime-not-found";
  registry.aliases["ui-1"].driftCauseCode = "runtime-not-found";
  registry.aliases["ui-1"].prepare = {
    ownerPid: process.pid,
    state: "erasing",
    token: "prepare-token",
  };
  writeJson(registryPath, registry);
  holdAliasResetLock(fixture, "ui-1");

  assert.throws(() => {
    deletePurposeSimulatorsBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
      actorId: "agent-a",
      actorType: "agent",
      purposeId: "agent-ui-session",
    }));
  }, (error) => error instanceof BrokerError
    && error.payload?.reasonCode === "human-override-required"
    && error.payload?.failed === 0
    && error.payload?.held === 1);
  assert.equal(fixture.calls.length, 0);
  assert.equal(readJson(registryPath).aliases["ui-1"].prepare.state, "erasing");
});

test("a queued prepare does not hide a missing device", () => {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.paths.stateRoot, "registry.json");
  const registry = readJson(registryPath);
  registry.aliases["ui-1"].powerState = "booted";
  registry.aliases["ui-1"].prepare = {
    ownerPid: null,
    state: "queued",
    token: "queued-missing",
  };
  writeJson(registryPath, registry);
  const simctlState = readJson(fixture.paths.simctl.statePath);
  simctlState.devices = simctlState.devices.filter((device) => device.udid !== "SIM-UI-1");
  writeJson(fixture.paths.simctl.statePath, simctlState);

  const lease = acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
    actorId: "agent-a",
    actorType: "agent",
    purposeId: "agent-ui-session",
  })).lease;

  assert.equal(lease.alias, "ui-2");
  const after = readJson(registryPath).aliases["ui-1"];
  assert.equal(after.health, "repair-needed");
  assert.equal(after.driftReason, "simulator-missing");
  assert.equal(after.powerState, "shutdown");
  assert.equal(after.prepare.state, "queued");
});

test("purpose delete counts a reset-lock timeout as held", () => {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.paths.stateRoot, "registry.json");
  const registry = readJson(registryPath);
  registry.aliases["ui-1"].health = "repair-needed";
  registry.aliases["ui-1"].driftReason = "runtime-not-found";
  registry.aliases["ui-1"].driftCauseCode = "runtime-not-found";
  writeJson(registryPath, registry);
  holdAliasResetLock(fixture, "ui-1");

  assert.throws(() => {
    deletePurposeSimulatorsBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
      actorId: "agent-a",
      actorType: "agent",
      purposeId: "agent-ui-session",
      resetLockTimeoutMilliseconds: 400,
    }));
  }, (error) => error instanceof BrokerError
    && error.payload?.reasonCode === "human-override-required"
    && error.payload?.failed === 0
    && error.payload?.held === 1);
  assert.equal(fixture.calls.length, 0);
});

test("acquire skips an alias that prepare is still erasing", () => {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.paths.stateRoot, "registry.json");
  const registry = readJson(registryPath);
  registry.aliases["ui-1"].powerState = "booted";
  registry.aliases["ui-1"].prepare = {
    ownerPid: process.pid,
    state: "erasing",
    token: "prepare-token",
  };
  writeJson(registryPath, registry);
  holdAliasResetLock(fixture, "ui-1");

  const lease = acquireLeaseBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
    actorId: "agent-a",
    actorType: "agent",
    purposeId: "agent-ui-session",
  })).lease;

  assert.equal(lease.alias, "ui-2");
  const after = readJson(registryPath);
  assert.equal(after.aliases["ui-1"].prepare.state, "erasing");
  assert.equal(after.aliases["ui-1"].health, "healthy");
  assert.equal(after.aliases["ui-1"].activeLeaseId, null);
});

test("delete is refused while UI prepare is erasing", () => {
  const fixture = makeFixture();
  const registryPath = path.join(fixture.paths.stateRoot, "registry.json");
  const registry = readJson(registryPath);
  registry.aliases["ui-1"].prepare = {
    ownerPid: process.pid,
    state: "erasing",
    token: "prepare-token",
  };
  writeJson(registryPath, registry);
  holdAliasResetLock(fixture, "ui-1");

  assert.throws(() => {
    deleteSimulatorBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
      alias: "ui-1",
    }));
  }, (error) => error instanceof BrokerError && error.payload?.reasonCode === "alias-busy" && error.exitCode === 3);
  assert.equal(fixture.calls.length, 0);
  assert.equal(readJson(registryPath).aliases["ui-1"].prepare.state, "erasing");
});

test("confirmed idle cleanup records simulator.unhealthy when sync finds a missing device", () => {
  const fixture = makeFixture();
  enableIdlePolicyBroker(fixture.resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    graceSeconds: 60,
  });
  const simctlState = readJson(fixture.paths.simctl.statePath);
  simctlState.devices = simctlState.devices.filter((device) => device.udid !== "SIM-UI-1");
  writeJson(fixture.paths.simctl.statePath, simctlState);
  const preview = cleanupIdleBroker(fixture.resolvedPaths, runtimeOptions(fixture));
  cleanupIdleBroker(fixture.resolvedPaths, runtimeOptions(fixture, {
    actorId: "operator",
    actorType: "human",
    apply: true,
    confirmPlanId: preview.planId,
  }));
  const registry = readJson(path.join(fixture.paths.stateRoot, "registry.json"));
  assert.equal(registry.aliases["ui-1"].health, "repair-needed");
  assert.equal(registry.aliases["ui-1"].driftReason, "simulator-missing");
  const events = readEventsBroker(fixture.resolvedPaths, {}).events.filter((event) => event.type === "simulator.unhealthy");
  assert.equal(events.some((event) => event.alias === "ui-1" && event.payload.driftReason === "simulator-missing"), true);
});

test("manual UI erase and repair wait on the alias reset lock", () => {
  const fixture = makeFixture();
  writeLockOwner(
    path.join(fixture.paths.stateRoot, "locks", "reset", "ui-1.lock"),
    new Date().toISOString(),
  );
  const locked = {
    alias: "ui-1",
    resetLockTimeoutMilliseconds: 400,
  };

  assert.throws(() => {
    eraseSimulatorBroker(fixture.resolvedPaths, runtimeOptions(fixture, locked));
  }, (error) => error instanceof BrokerError && error.payload?.reasonCode === "reset-lock-timeout");
  assert.throws(() => {
    repairSimulatorBroker(fixture.resolvedPaths, runtimeOptions(fixture, locked));
  }, (error) => error instanceof BrokerError && error.payload?.reasonCode === "reset-lock-timeout");
  assert.equal(fixture.calls.length, 0);
});
