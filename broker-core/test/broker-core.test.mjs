import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acquireLeaseBroker,
  appSnapshotBroker,
  appSnapshotBrokerUnderMutationLock,
  BrokerError,
  bootSimulatorBroker,
  checkCapacityBroker,
  clearPinBroker,
  cleanupIdleBroker,
  containLeaseBroker,
  createPinBroker,
  disableIdlePolicyBroker,
  doctorBroker,
  enableIdlePolicyBroker,
  eraseSimulatorBroker,
  explainLeaseBroker,
  forgetKnownProjectBroker,
  HOST_BOOTSTRAP_DEVICE_WARNING,
  hostStatusBroker,
  initBroker,
  initProjectBroker,
  idleStatusBroker,
  readEventsBroker,
  reconcileIdleBroker,
  registerLeaseProcessBroker,
  reconcileCapacityBroker,
  repairSimulatorBroker,
  releaseLeaseBroker,
  resolveBrokerPaths,
  shutdownSimulatorBroker,
  validateHostConfig,
  validateProjectBroker,
  writeAppSnapshotArtifact,
  writeAppSnapshotArtifactUnderMutationLock,
} from "../index.mjs";
import { defaultProcessSampler } from "../containment.mjs";
import { SIMCTL_COMMAND_TIMEOUT_MS, SIMCTL_INVENTORY_MAX_BUFFER_BYTES, createSystemSimctlAdapter } from "../simctl.mjs";
import { createDeviceRecord, createSimctlFixture } from "./support/simctl-fixture.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-test-"));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function makePaths() {
  const root = makeTempDir();
  const hostConfigPath = path.join(root, "host-config.json");
  const stateRoot = path.join(root, "state");
  const projectFilePath = path.join(root, "repo/.simulator-broker/project.json");
  const simctl = createSimctlFixture(root, {
    devices: [
      createDeviceRecord({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        name: "Manual",
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
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-A16",
        name: "iPad One",
        udid: "SIM-IPAD-1",
      }),
    ],
  });
  return {
    hostConfigPath,
    projectFilePath,
    root,
    simctl,
    stateRoot,
  };
}

function runtimeOptions(paths, overrides = {}) {
  return {
    simctlAdapter: paths.simctl.adapter,
    ...overrides,
  };
}

function driftUiOneDeviceFamily(paths) {
  const fixtureState = readJson(paths.simctl.statePath);
  fixtureState.devices.find((device) => device.udid === "SIM-UI-1").deviceTypeIdentifier = "com.apple.CoreSimulator.SimDeviceType.iPad-A16";
  writeJson(paths.simctl.statePath, fixtureState);
}

function writeBaseHostConfig(hostConfigPath) {
  writeJson(hostConfigPath, {
    version: 1,
    hostId: "test-host",
    aliases: [
      {
        alias: "manual-1",
        capabilities: ["manual-persistent"],
        deviceFamily: "iPhone",
        displayName: "Manual",
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
}

function writeBaseProject(projectFilePath, projectId = "demo-app") {
  writeJson(projectFilePath, {
    version: 1,
    projectId,
    projectName: "Demo App",
    purposes: [
      {
        id: "manual-testing",
        displayName: "Manual Testing",
        capability: "manual-persistent",
        defaultActorType: "human",
      },
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
      {
        id: "agent-ipad-session",
        displayName: "Agent iPad Session",
        capability: "interactive-resettable",
        defaultActorType: "agent",
        requires: {
          deviceFamily: "iPad",
          iosVersion: "18.2",
        },
      },
    ],
  });
}

function writeIPhoneOnlyHostConfig(hostConfigPath) {
  writeJson(hostConfigPath, {
    version: 1,
    hostId: "test-host",
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
}

function writeCapacityProject(projectFilePath, purposes) {
  writeJson(projectFilePath, {
    version: 1,
    projectId: "capacity-demo",
    projectName: "Capacity Demo",
    purposes,
  });
}

function brokerPaths(paths) {
  return resolveBrokerPaths({
    hostConfigPath: paths.hostConfigPath,
    projectFilePath: paths.projectFilePath,
    stateRoot: paths.stateRoot,
  });
}

function readCapacityTransactions(resolvedPaths) {
  if (!fs.existsSync(resolvedPaths.capacityTransactionsDir)) {
    return [];
  }
  return fs.readdirSync(resolvedPaths.capacityTransactionsDir)
    .map((entry) => readJson(path.join(resolvedPaths.capacityTransactionsDir, entry)));
}

function makeProcessFixture(records) {
  const table = records.map((record) => ({
    alive: true,
    command: "",
    elapsed: "00:01",
    pgid: record.pid,
    ppid: 1,
    rssBytes: 0,
    stat: "S",
    vszBytes: 0,
    ...record,
  }));
  const actions = [];
  return {
    actions,
    controller: {
      killPid(pid, signal) {
        actions.push({ pid, signal, target: "pid" });
        const record = table.find((candidate) => candidate.pid === pid);
        if (record && signal === "SIGTERM") {
          record.alive = false;
        }
        return { ok: true };
      },
      killProcessGroup(pgid, signal) {
        actions.push({ pgid, signal, target: "process-group" });
        for (const record of table) {
          if (record.pgid === pgid && signal === "SIGTERM") {
            record.alive = false;
          }
        }
        return { ok: true };
      },
    },
    isAlive(pid) {
      return table.some((record) => record.pid === pid && record.alive);
    },
    sampler() {
      return table
        .filter((record) => record.alive)
        .map(({ alive, ...record }) => ({ ...record }));
    },
  };
}

function liveProcessSampler(...records) {
  const table = records.map((record) => ({
    command: "",
    elapsed: "00:01",
    pgid: record.pid,
    ppid: 1,
    rssBytes: 0,
    stat: "S",
    vszBytes: 0,
    ...record,
  }));
  return () => table.map((record) => ({ ...record }));
}

test("project validation succeeds for valid config", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);

  const result = validateProjectBroker(brokerPaths(paths), runtimeOptions(paths));
  assert.equal(result.ok, true);
  assert.equal(result.projectConfig.projectId, "demo-app");
  assert.equal(result.projectConfig.purposes[1].requires.deviceFamily, "iPhone");
  const knownProjects = readJson(path.join(paths.stateRoot, "known-projects.json"));
  assert.equal(knownProjects.projects["demo-app"].projectFilePath, paths.projectFilePath);
  assert.equal(knownProjects.projects["demo-app"].purposes[1].displayName, "Agent UI Session");
});

test("project validation records known projects under the lease mutation lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: process.pid,
    startedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.throws(() => {
    validateProjectBroker(resolvedPaths, {
      leaseLockTimeoutMilliseconds: 1,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "alias-busy");
});

test("project forget removes an inactive local registration, preserves audit history, and is idempotent", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  validateProjectBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  const forgotten = forgetKnownProjectBroker(resolvedPaths, runtimeOptions(paths, {
    now: "2026-08-10T00:00:00.000Z",
    processExists: () => true,
    projectId: "demo-app",
  }));
  assert.deepEqual(forgotten, {
    forgotten: true,
    ok: true,
    projectId: "demo-app",
  });

  const knownProjects = readJson(resolvedPaths.knownProjectsPath);
  assert.equal(Object.hasOwn(knownProjects.projects, "demo-app"), false);
  const events = readEventsBroker(resolvedPaths, { limit: 10 }).events;
  assert.equal(events.some((event) => event.type === "project.forgotten" && event.payload?.projectId === "demo-app"), true);
  const snapshot = appSnapshotBroker(resolvedPaths, runtimeOptions(paths, {
    eventLimit: 10,
    processExists: () => true,
  }));
  assert.equal(snapshot.projects.some((project) => project.projectId === "demo-app"), false);

  const repeated = forgetKnownProjectBroker(resolvedPaths, runtimeOptions(paths, {
    now: "2026-08-10T00:01:00.000Z",
    processExists: () => true,
    projectId: "demo-app",
  }));
  assert.deepEqual(repeated, {
    ok: true,
    projectId: "demo-app",
    unchanged: true,
  });
});

test("project forget refuses a registered project with an active lease or pin", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  validateProjectBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, runtimeOptions(paths, {
    actorId: "agent-forget-test",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
  })).lease;

  assert.throws(() => {
    forgetKnownProjectBroker(resolvedPaths, runtimeOptions(paths, {
      processExists: (pid) => pid === process.pid,
      projectId: "demo-app",
    }));
  }, (error) => error.payload?.reasonCode === "project-in-use"
    && error.payload?.activeLeaseCount === 1
    && error.payload?.pinCount === 0);
  assert.equal(Object.hasOwn(readJson(resolvedPaths.knownProjectsPath).projects, "demo-app"), true);

  releaseLeaseBroker(resolvedPaths, runtimeOptions(paths, {
    leaseId: lease.leaseId,
    processExists: (pid) => pid === process.pid,
  }));
  createPinBroker(resolvedPaths, runtimeOptions(paths, {
    actorId: "human-forget-test",
    actorType: "human",
    alias: "ui-1",
    processExists: () => true,
    purposeId: "agent-ui-session",
  }));

  assert.throws(() => {
    forgetKnownProjectBroker(resolvedPaths, runtimeOptions(paths, {
      processExists: () => true,
      projectId: "demo-app",
    }));
  }, (error) => error.payload?.reasonCode === "project-in-use"
    && error.payload?.activeLeaseCount === 0
    && error.payload?.pinCount === 1);
  assert.equal(Object.hasOwn(readJson(resolvedPaths.knownProjectsPath).projects, "demo-app"), true);
});

test("project forget waits on the lease mutation lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  validateProjectBroker(resolvedPaths, runtimeOptions(paths));
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: process.pid,
    startedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.throws(() => {
    forgetKnownProjectBroker(resolvedPaths, runtimeOptions(paths, {
      leaseLockTimeoutMilliseconds: 1,
      processExists: (pid) => pid === process.pid,
      projectId: "demo-app",
    }));
  }, (error) => error.payload?.reasonCode === "alias-busy");
  assert.equal(Object.hasOwn(readJson(resolvedPaths.knownProjectsPath).projects, "demo-app"), true);
});

test("project init waits on the lease mutation lock before writing config", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);
  const repoRoot = path.dirname(path.dirname(paths.projectFilePath));

  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });

  assert.throws(() => {
    initProjectBroker(resolvedPaths, {
      leaseLockTimeoutMilliseconds: 1,
      processExists: (pid) => pid === process.pid,
      projectFilePath: paths.projectFilePath,
      repoRoot,
    });
  }, (error) => error.payload?.reasonCode === "alias-busy");

  assert.equal(fs.existsSync(paths.projectFilePath), false);
});

test("project init rolls back project config when known project registration fails", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);
  const repoRoot = path.dirname(path.dirname(paths.projectFilePath));
  fs.mkdirSync(resolvedPaths.knownProjectsPath, { recursive: true });

  assert.throws(() => {
    initProjectBroker(resolvedPaths, {
      processExists: () => true,
      projectFilePath: paths.projectFilePath,
      repoRoot,
    });
  });

  assert.equal(fs.existsSync(paths.projectFilePath), false);
});

test("project init rechecks config existence after acquiring the mutation lock", (t) => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);
  const repoRoot = path.dirname(path.dirname(paths.projectFilePath));
  writeBaseProject(paths.projectFilePath);
  const originalExistsSync = fs.existsSync;
  let skippedPreLockCheck = false;

  t.after(() => {
    fs.existsSync = originalExistsSync;
  });

  fs.existsSync = (filePath) => {
    if (filePath === paths.projectFilePath && !skippedPreLockCheck) {
      skippedPreLockCheck = true;
      return false;
    }
    return originalExistsSync(filePath);
  };

  assert.throws(() => {
    initProjectBroker(resolvedPaths, {
      processExists: () => true,
      projectFilePath: paths.projectFilePath,
      projectId: "replacement-project",
      repoRoot,
    });
  }, (error) => error.payload?.reasonCode === "project-config-exists");

  assert.equal(readJson(paths.projectFilePath).projectId, "demo-app");
});

test("project init preserves a competing config created by another state root", (t) => {
  const paths = makePaths();
  const repoRoot = path.dirname(path.dirname(paths.projectFilePath));
  const alternatePaths = resolveBrokerPaths({
    hostConfigPath: paths.hostConfigPath,
    projectFilePath: paths.projectFilePath,
    stateRoot: path.join(paths.root, "alternate-state"),
  });
  const originalExistsSync = fs.existsSync;
  const originalLinkSync = fs.linkSync;
  const originalRenameSync = fs.renameSync;
  let competingConfigWritten = false;

  t.after(() => {
    fs.existsSync = originalExistsSync;
    fs.linkSync = originalLinkSync;
    fs.renameSync = originalRenameSync;
  });

  const writeCompetingConfig = (destinationPath) => {
    if (destinationPath === paths.projectFilePath && !competingConfigWritten) {
      competingConfigWritten = true;
      writeBaseProject(paths.projectFilePath, "competing-project");
    }
  };
  fs.existsSync = (filePath) => {
    if (filePath === paths.projectFilePath && !competingConfigWritten) {
      return false;
    }
    return originalExistsSync(filePath);
  };
  fs.linkSync = (existingPath, newPath) => {
    writeCompetingConfig(newPath);
    return originalLinkSync(existingPath, newPath);
  };
  fs.renameSync = (oldPath, newPath) => {
    writeCompetingConfig(newPath);
    return originalRenameSync(oldPath, newPath);
  };

  assert.throws(() => {
    initProjectBroker(alternatePaths, {
      processExists: () => true,
      projectFilePath: paths.projectFilePath,
      projectId: "replacement-project",
      repoRoot,
    });
  }, (error) => error.payload?.reasonCode === "project-config-exists");

  assert.equal(competingConfigWritten, true);
  assert.equal(readJson(paths.projectFilePath).projectId, "competing-project");
});

test("host init creates registry and host status snapshot", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);

  initBroker(brokerPaths(paths), runtimeOptions(paths, { processExists: () => true }));
  const status = hostStatusBroker(brokerPaths(paths), runtimeOptions(paths, { processExists: () => true }));
  assert.equal(status.summary.totalAliases, 4);
  assert.equal(status.simulators[0].health, "healthy");
  assert.ok(fs.existsSync(path.join(paths.stateRoot, "registry.json")));
});

test("host status waits on the lease mutation lock before refreshing state", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: process.pid,
    startedAt: new Date(0).toISOString(),
  });

  assert.throws(() => {
    hostStatusBroker(resolvedPaths, {
      leaseLockTimeoutMilliseconds: 1,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "alias-busy" && error.exitCode === 3);

  assert.equal(fs.existsSync(resolvedPaths.leaseLockOwnerPath), true);
});

test("lease mutation lock waits instead of deleting while another stale-lock reclaimer is active", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: 424242,
    startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });
  writeJson(path.join(resolvedPaths.leaseLockDir, "reclaiming.json"), {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  const futureMarkerTime = new Date(Date.now() + 60 * 1000);
  fs.utimesSync(path.join(resolvedPaths.leaseLockDir, "reclaiming.json"), futureMarkerTime, futureMarkerTime);

  assert.throws(() => {
    hostStatusBroker(resolvedPaths, {
      leaseLockTimeoutMilliseconds: 1,
      processExists: () => false,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "alias-busy");

  assert.equal(fs.existsSync(resolvedPaths.leaseLockDir), true);
  assert.equal(fs.existsSync(resolvedPaths.leaseLockOwnerPath), true);
});

test("stale lock reclaim preserves a replacement marker owned by another reclaimer", (t) => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const markerPath = path.join(resolvedPaths.leaseLockDir, "reclaiming.json");
  const originalRenameSync = fs.renameSync;
  const originalRmSync = fs.rmSync;
  const originalUtimesSync = fs.utimesSync;
  let replacementMarkerWritten = false;

  t.after(() => {
    fs.renameSync = originalRenameSync;
  });

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(markerPath, {
    pid: 424242,
    startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    token: "stale-marker",
  });
  const staleTime = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(markerPath, staleTime, staleTime);
  fs.utimesSync(resolvedPaths.leaseLockDir, staleTime, staleTime);

  const writeReplacementMarker = () => {
    if (replacementMarkerWritten) {
      return;
    }
    replacementMarkerWritten = true;
    originalRmSync(markerPath, { force: true });
    writeJson(markerPath, {
      pid: 999999,
      startedAt: new Date().toISOString(),
      token: "replacement-marker",
    });
    const futureMarkerTime = new Date(Date.now() + 60 * 1000);
    originalUtimesSync(markerPath, futureMarkerTime, futureMarkerTime);
  };
  fs.renameSync = (oldPath, newPath) => {
    if (oldPath === markerPath) {
      writeReplacementMarker();
      return originalRenameSync(oldPath, newPath);
    }
    return originalRenameSync(oldPath, newPath);
  };

  assert.throws(() => {
    hostStatusBroker(resolvedPaths, {
      leaseLockTimeoutMilliseconds: 1,
      processExists: () => false,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "alias-busy");

  assert.equal(replacementMarkerWritten, true);
  assert.equal(readJson(markerPath).token, "replacement-marker");
});

test("lease mutation lock retries when the owner file disappears during read", (t) => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;
  let ownerReadRaced = false;

  t.after(() => {
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
  });

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });

  fs.existsSync = (filePath) => {
    if (filePath === resolvedPaths.leaseLockOwnerPath && !ownerReadRaced) {
      return true;
    }
    return originalExistsSync(filePath);
  };
  fs.readFileSync = (filePath, ...args) => {
    if (filePath === resolvedPaths.leaseLockOwnerPath && !ownerReadRaced) {
      ownerReadRaced = true;
      fs.rmSync(resolvedPaths.leaseLockDir, { force: true, recursive: true });
      const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      error.code = "ENOENT";
      throw error;
    }
    return originalReadFileSync(filePath, ...args);
  };

  const status = hostStatusBroker(resolvedPaths, {
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(status.ok, true);
  assert.equal(ownerReadRaced, true);
});

test("lease mutation lock reclaims a reused live pid with a newer process lifetime", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const staleOwnerPid = 424242;

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: staleOwnerPid,
    startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });

  const status = hostStatusBroker(resolvedPaths, {
    processExists: (pid) => pid === staleOwnerPid,
    processSampler: liveProcessSampler({
      command: "unrelated-worker",
      elapsed: "00:01",
      pgid: staleOwnerPid,
      pid: staleOwnerPid,
    }),
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(status.ok, true);
  assert.equal(fs.existsSync(resolvedPaths.leaseLockDir), false);
});

test("doctor waits on the lease mutation lock before refreshing state", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: process.pid,
    startedAt: new Date(0).toISOString(),
  });

  assert.throws(() => {
    doctorBroker(resolvedPaths, {
      leaseLockTimeoutMilliseconds: 1,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "alias-busy" && error.exitCode === 3);

  assert.equal(fs.existsSync(resolvedPaths.leaseLockOwnerPath), true);
});

test("host init can bootstrap a starter host config when none exists yet", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);

  const result = initBroker(resolvedPaths, {
    bootstrapConfig: true,
    hostId: "bootstrap-host",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(result.ok, true);
  assert.equal(result.hostConfigCreated, true);
  assert.equal(readJson(paths.hostConfigPath).hostId, "bootstrap-host");
  const status = hostStatusBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  assert.equal(status.summary.totalAliases, 6);
  assert.ok(status.simulators.some((simulator) => simulator.alias === "manual-1"));
  assert.ok(status.simulators.some((simulator) => simulator.alias === "ui-2"));
  assert.ok(status.simulators.some((simulator) => simulator.alias === "build-2"));
  assert.ok(status.simulators.every((simulator) => /^[0-9A-F-]{36}$/.test(simulator.simulatorId)));
  const simctlState = readJson(paths.simctl.statePath);
  assert.ok(simctlState.devices.some((device) => device.name === "Simulator Broker bootstrap-host manual-1"));
});

test("host init warns before creating bootstrap simulators", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);
  const order = [];
  const adapter = {
    ...paths.simctl.adapter,
    createDevice(name, deviceTypeId, runtimeId) {
      order.push("create");
      return paths.simctl.adapter.createDevice(name, deviceTypeId, runtimeId);
    },
  };

  const result = initBroker(resolvedPaths, {
    bootstrapConfig: true,
    hostId: "bootstrap-warning-host",
    processExists: () => true,
    simctlAdapter: adapter,
    writeBootstrapWarning(message) {
      order.push("warn");
      assert.equal(message, HOST_BOOTSTRAP_DEVICE_WARNING);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.hostConfigCreated, true);
  assert.equal(result.bootstrapWarning, HOST_BOOTSTRAP_DEVICE_WARNING);
  assert.equal(order[0], "warn");
  assert.ok(order.includes("create"));
});

test("host bootstrap rolls back simulators created before a later alias fails", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);
  const baselineUdids = readJson(paths.simctl.statePath).devices.map((device) => device.udid).sort();
  let createCount = 0;
  const failingAdapter = {
    ...paths.simctl.adapter,
    createDevice(name, deviceTypeId, runtimeId) {
      createCount += 1;
      if (createCount === 3) {
        paths.simctl.adapter.createDevice(name, deviceTypeId, runtimeId);
        throw new Error("simctl create failed");
      }
      return paths.simctl.adapter.createDevice(name, deviceTypeId, runtimeId);
    },
  };

  assert.throws(() => {
    initBroker(resolvedPaths, {
      bootstrapConfig: true,
      hostId: "bootstrap-rollback",
      processExists: () => true,
      simctlAdapter: failingAdapter,
    });
  }, /simctl create failed/);

  assert.equal(fs.existsSync(paths.hostConfigPath), false);
  assert.deepEqual(readJson(paths.simctl.statePath).devices.map((device) => device.udid).sort(), baselineUdids);
});

test("host bootstrap rolls back created simulators when host config commit fails", () => {
  const paths = makePaths();
  const blockedParentPath = path.join(paths.root, "blocked-host-parent");
  fs.writeFileSync(blockedParentPath, "not a directory\n");
  const resolvedPaths = brokerPaths({
    ...paths,
    hostConfigPath: path.join(blockedParentPath, "host-config.json"),
  });
  const baselineUdids = readJson(paths.simctl.statePath).devices.map((device) => device.udid).sort();

  assert.throws(() => {
    initBroker(resolvedPaths, {
      bootstrapConfig: true,
      hostId: "bootstrap-write-fails",
      processExists: () => true,
      simctlAdapter: paths.simctl.adapter,
    });
  }, /EEXIST|ENOTDIR|not a directory/);

  assert.deepEqual(readJson(paths.simctl.statePath).devices.map((device) => device.udid).sort(), baselineUdids);
});

test("path resolution rejects broker resource overlaps", () => {
  const root = makeTempDir();
  const stateRoot = path.join(root, "state");
  const hostConfigPath = path.join(root, "host-config.json");
  const projectFilePath = path.join(root, "repo/.simulator-broker/project.json");

  assert.throws(() => {
    resolveBrokerPaths({
      hostConfigPath: path.join(stateRoot, "app-snapshot.json"),
      projectFilePath,
      stateRoot,
    });
  }, (error) =>
    error.payload?.reasonCode === "invalid-config"
      && error.payload?.resource === "hostConfigPath"
      && error.payload?.conflictingResource === "appSnapshotPath");

  assert.throws(() => {
    resolveBrokerPaths({
      hostConfigPath,
      projectFilePath,
      serviceSocketPath: path.join(stateRoot, "brokerd.json"),
      stateRoot,
    });
  }, (error) =>
    error.payload?.reasonCode === "invalid-config"
      && error.payload?.resource === "serviceSocketPath"
      && error.payload?.conflictingResource === "serviceMetadataPath");

  if (fs.existsSync(root.toUpperCase())) {
    assert.throws(() => {
      resolveBrokerPaths({
        hostConfigPath: path.join(root, "State", "app-snapshot.json"),
        projectFilePath,
        stateRoot,
      });
    }, (error) =>
      error.payload?.reasonCode === "invalid-config"
        && error.payload?.resource === "hostConfigPath"
        && error.payload?.conflictingResource === "appSnapshotPath");

    const numericRoot = path.join(root, "123");
    fs.mkdirSync(numericRoot);
    assert.throws(() => {
      resolveBrokerPaths({
        hostConfigPath: path.join(numericRoot, "State", "app-snapshot.json"),
        projectFilePath,
        stateRoot: path.join(numericRoot, "state"),
      });
    }, (error) =>
      error.payload?.reasonCode === "invalid-config"
        && error.payload?.resource === "hostConfigPath"
        && error.payload?.conflictingResource === "appSnapshotPath");
  }
});

test("host config validation rejects duplicate simulator ids", () => {
  assert.throws(() => {
    validateHostConfig({
      aliases: [
        {
          alias: "manual-1",
          capabilities: ["manual-persistent"],
          deviceFamily: "iPhone",
          displayName: "Manual",
          iosVersion: "18.2",
          simulatorId: "SIM-DUPLICATE",
        },
        {
          alias: "ui-1",
          capabilities: ["interactive-resettable"],
          deviceFamily: "iPhone",
          displayName: "UI",
          iosVersion: "18.2",
          simulatorId: "SIM-DUPLICATE",
        },
      ],
      hostId: "duplicate-host",
      version: 1,
    });
  }, (error) =>
    error.payload?.reasonCode === "invalid-config"
      && error.payload?.field === "host-config.aliases"
      && /Duplicate simulatorId/.test(error.message));
});

test("forced host bootstrap rejects active leases and pins before replacing config", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, {
    bootstrapConfig: true,
    hostId: "bootstrap-host",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });
  initProjectBroker(resolvedPaths, {
    projectId: "bootstrap-claims",
    projectName: "Bootstrap Claims",
    repoRoot: path.join(paths.root, "repo"),
  });
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-ui",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.throws(() => {
    initBroker(resolvedPaths, {
      bootstrapConfig: true,
      force: true,
      hostId: "replacement-host",
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) =>
    error.payload?.reasonCode === "alias-busy"
      && error.payload?.activeLeaseCount === 1
      && error.payload?.pinCount === 0);
  assert.equal(readJson(paths.hostConfigPath).hostId, "bootstrap-host");

  releaseLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });
  createPinBroker(resolvedPaths, {
    actorId: "human-1",
    actorType: "human",
    alias: "ui-1",
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.throws(() => {
    initBroker(resolvedPaths, {
      bootstrapConfig: true,
      force: true,
      hostId: "replacement-host",
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) =>
    error.payload?.reasonCode === "alias-busy"
      && error.payload?.activeLeaseCount === 0
      && error.payload?.pinCount === 1);
  assert.equal(readJson(paths.hostConfigPath).hostId, "bootstrap-host");
});

test("forced host bootstrap retires replaced managed simulators after config commit", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, {
    bootstrapConfig: true,
    hostId: "bootstrap-host",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const previousHostConfig = readJson(paths.hostConfigPath);
  const previousSimulatorIds = previousHostConfig.aliases.map((alias) => alias.simulatorId).sort();
  const operations = [];
  const adapter = {
    ...paths.simctl.adapter,
    deleteDevice(simulatorId) {
      operations.push({
        action: "delete",
        hostIdAtDelete: readJson(paths.hostConfigPath).hostId,
        simulatorId,
      });
      return paths.simctl.adapter.deleteDevice(simulatorId);
    },
  };

  const result = initBroker(resolvedPaths, {
    bootstrapConfig: true,
    force: true,
    hostId: "replacement-host",
    processExists: () => true,
    simctlAdapter: adapter,
  });

  assert.equal(result.ok, true);
  assert.equal(result.hostConfigCreated, true);
  assert.equal(readJson(paths.hostConfigPath).hostId, "replacement-host");
  assert.deepEqual(
    operations.filter((operation) => operation.action === "delete").map((operation) => operation.simulatorId).sort(),
    previousSimulatorIds,
  );
  assert.ok(operations.every((operation) => operation.hostIdAtDelete === "replacement-host"));
  const currentDevices = readJson(paths.simctl.statePath).devices;
  for (const simulatorId of previousSimulatorIds) {
    assert.equal(currentDevices.some((device) => device.udid === simulatorId), false);
  }
  for (const alias of readJson(paths.hostConfigPath).aliases) {
    assert.equal(currentDevices.some((device) => device.udid === alias.simulatorId), true);
  }
});

test("forced host bootstrap preserves failed simulator retirements for retry", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, {
    bootstrapConfig: true,
    hostId: "bootstrap-host",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const previousHostConfig = readJson(paths.hostConfigPath);
  const previousSimulatorIds = previousHostConfig.aliases.map((alias) => alias.simulatorId).sort();
  const failingSimulatorId = previousSimulatorIds[1];
  const attemptedRetirements = [];
  const firstAdapter = {
    ...paths.simctl.adapter,
    deleteDevice(simulatorId) {
      attemptedRetirements.push(simulatorId);
      if (simulatorId === failingSimulatorId) {
        throw new Error(`temporary delete failure for ${simulatorId}`);
      }
      return paths.simctl.adapter.deleteDevice(simulatorId);
    },
  };

  assert.throws(() => {
    initBroker(resolvedPaths, {
      bootstrapConfig: true,
      force: true,
      hostId: "replacement-host",
      processExists: () => true,
      simctlAdapter: firstAdapter,
    });
  }, /temporary delete failure/);

  assert.deepEqual([...new Set(attemptedRetirements)].sort(), previousSimulatorIds);
  const afterFailedRetirement = readJson(paths.simctl.statePath).devices;
  assert.equal(afterFailedRetirement.some((device) => device.udid === failingSimulatorId), true);
  for (const simulatorId of previousSimulatorIds.filter((candidate) => candidate !== failingSimulatorId)) {
    assert.equal(afterFailedRetirement.some((device) => device.udid === simulatorId), false);
  }
  assert.deepEqual(readJson(paths.hostConfigPath).pendingRetirements, [failingSimulatorId]);

  initBroker(resolvedPaths, {
    bootstrapConfig: true,
    force: true,
    hostId: "retry-host",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(readJson(paths.hostConfigPath).pendingRetirements, undefined);
  assert.equal(readJson(paths.simctl.statePath).devices.some((device) => device.udid === failingSimulatorId), false);
});

test("forced host bootstrap persists pending retirements before inventory failures", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, {
    bootstrapConfig: true,
    hostId: "bootstrap-host",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const previousHostConfig = readJson(paths.hostConfigPath);
  const previousSimulatorIds = previousHostConfig.aliases.map((alias) => alias.simulatorId).sort();
  const failingAdapter = {
    ...paths.simctl.adapter,
    listDevices() {
      if (fs.existsSync(paths.hostConfigPath) && readJson(paths.hostConfigPath).hostId === "replacement-host") {
        throw new Error("inventory unavailable");
      }
      return paths.simctl.adapter.listDevices();
    },
  };

  assert.throws(() => {
    initBroker(resolvedPaths, {
      bootstrapConfig: true,
      force: true,
      hostId: "replacement-host",
      processExists: () => true,
      simctlAdapter: failingAdapter,
    });
  }, /inventory unavailable/);

  const failedHostConfig = readJson(paths.hostConfigPath);
  const replacementSimulatorIds = failedHostConfig.aliases.map((alias) => alias.simulatorId).sort();
  assert.equal(failedHostConfig.hostId, "replacement-host");
  assert.deepEqual([...(failedHostConfig.pendingRetirements ?? [])].sort(), previousSimulatorIds);
  assert.notDeepEqual(replacementSimulatorIds, previousSimulatorIds);
  const afterFailedInventory = readJson(paths.simctl.statePath).devices;
  for (const simulatorId of [...previousSimulatorIds, ...replacementSimulatorIds]) {
    assert.equal(afterFailedInventory.some((device) => device.udid === simulatorId), true);
  }

  initBroker(resolvedPaths, {
    bootstrapConfig: true,
    force: true,
    hostId: "retry-host",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const finalHostConfig = readJson(paths.hostConfigPath);
  const finalSimulatorIds = finalHostConfig.aliases.map((alias) => alias.simulatorId).sort();
  assert.equal(finalHostConfig.pendingRetirements, undefined);
  const finalDevices = readJson(paths.simctl.statePath).devices;
  for (const simulatorId of [...previousSimulatorIds, ...replacementSimulatorIds]) {
    assert.equal(finalDevices.some((device) => device.udid === simulatorId), false);
  }
  for (const simulatorId of finalSimulatorIds) {
    assert.equal(finalDevices.some((device) => device.udid === simulatorId), true);
  }
});

test("forced host bootstrap writes pending retirements in the first replacement commit", (t) => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, {
    bootstrapConfig: true,
    hostId: "bootstrap-host",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const previousHostConfig = readJson(paths.hostConfigPath);
  const previousSimulatorIds = previousHostConfig.aliases.map((alias) => alias.simulatorId).sort();
  const originalRenameSync = fs.renameSync;
  let replacementHostConfigWriteCount = 0;
  t.after(() => {
    fs.renameSync = originalRenameSync;
  });

  fs.renameSync = function renameSyncWithReplacementInterruption(source, target) {
    originalRenameSync.call(this, source, target);
    if (path.resolve(String(target)) !== path.resolve(paths.hostConfigPath)) {
      return;
    }
    const persistedHostConfig = readJson(paths.hostConfigPath);
    if (persistedHostConfig.hostId !== "replacement-host") {
      return;
    }
    replacementHostConfigWriteCount += 1;
    if (replacementHostConfigWriteCount === 1) {
      throw new Error("interrupted after first replacement host config commit");
    }
  };

  assert.throws(() => {
    initBroker(resolvedPaths, {
      bootstrapConfig: true,
      force: true,
      hostId: "replacement-host",
      processExists: () => true,
      simctlAdapter: paths.simctl.adapter,
    });
  }, /interrupted after first replacement host config commit/);

  const interruptedHostConfig = readJson(paths.hostConfigPath);
  assert.equal(interruptedHostConfig.hostId, "replacement-host");
  assert.deepEqual([...(interruptedHostConfig.pendingRetirements ?? [])].sort(), previousSimulatorIds);
});

test("default process sampler handles process tables larger than child process buffers", () => {
  const binDir = makeTempDir();
  const fakePsPath = path.join(binDir, "ps");
  const fakePsScriptPath = path.join(binDir, "fake-ps.mjs");
  fs.writeFileSync(fakePsScriptPath, [
    "const command = 'x'.repeat(11 * 1024 * 1024);",
    "process.stdout.write(`123 1 123 4 8 00:01 S ${command}\\n`);",
  ].join("\n"));
  fs.writeFileSync(fakePsPath, [
    "#!/bin/sh",
    `exec ${shellQuote(process.execPath)} ${shellQuote(fakePsScriptPath)} "$@"`,
  ].join("\n"));
  fs.chmodSync(fakePsPath, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  try {
    const records = defaultProcessSampler();
    assert.equal(records.length, 1);
    assert.equal(records[0].pid, 123);
    assert.equal(records[0].command.length, 11 * 1024 * 1024);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("default process sampler bounds stalled process inventory subprocesses", () => {
  let receivedTimeout = null;
  assert.throws(() => {
    defaultProcessSampler({
      spawnSyncImpl(_command, _args, options) {
        receivedTimeout = options.timeout;
        const error = new Error("spawn timed out");
        error.code = "ETIMEDOUT";
        return { error };
      },
      timeoutMs: 1234,
    });
  }, (error) => {
    assert.equal(receivedTimeout, 1234);
    assert.equal(error.code, "PROCESS_SAMPLER_TIMEOUT");
    assert.equal(error.reasonCode, "process-sampler-timeout");
    return true;
  });
});

test("system simctl boot propagates nonzero command results", () => {
  const adapter = createSystemSimctlAdapter({
    commandRunner(args, options) {
      assert.deepEqual(args, ["boot", "SIM-FAIL"]);
      assert.equal(options.allowFailure, true);
      return {
        exitCode: 60,
        stderr: "Unable to boot device",
        stdout: "",
      };
    },
  });

  assert.throws(() => {
    adapter.bootDevice("SIM-FAIL");
  }, (error) => error.exitCode === 60 && error.stderr === "Unable to boot device");
});

test("system simctl boot waits for boot status before returning", () => {
  const calls = [];
  const adapter = createSystemSimctlAdapter({
    commandRunner(args, options) {
      calls.push({ args, options });
      return "";
    },
  });

  adapter.bootDevice("SIM-BOOT");

  assert.deepEqual(calls.map((call) => call.args), [
    ["boot", "SIM-BOOT"],
    ["bootstatus", "SIM-BOOT", "-b"],
  ]);
  assert.equal(calls[0].options.allowFailure, true);
  assert.equal(calls[0].options.timeoutMs, SIMCTL_COMMAND_TIMEOUT_MS);
  assert.equal(calls[1].options.timeoutMs, SIMCTL_COMMAND_TIMEOUT_MS);
});

test("system simctl warm readiness waits for boot status", () => {
  const calls = [];
  const adapter = createSystemSimctlAdapter({
    commandRunner(args, options) {
      calls.push({ args, options });
      return "";
    },
  });

  adapter.waitForBooted("SIM-WARM");

  assert.deepEqual(calls.map((call) => call.args), [
    ["bootstatus", "SIM-WARM", "-b"],
  ]);
  assert.equal(calls[0].options.timeoutMs, SIMCTL_COMMAND_TIMEOUT_MS);
});

test("system simctl inventory commands use an expanded output buffer", () => {
  const calls = [];
  const adapter = createSystemSimctlAdapter({
    commandRunner(args, options) {
      calls.push({ args, options });
      if (args.at(-1) === "devices") {
        return JSON.stringify({ devices: {} });
      }
      if (args.at(-1) === "devicetypes") {
        return JSON.stringify({ devicetypes: [] });
      }
      return JSON.stringify({ runtimes: [] });
    },
  });

  adapter.listDevices();
  adapter.listDeviceTypes();
  adapter.listRuntimes();

  assert.deepEqual(calls.map((call) => call.args), [
    ["list", "--json", "devices"],
    ["list", "--json", "devicetypes"],
    ["list", "--json", "runtimes"],
  ]);
  assert.ok(calls.every((call) => call.options.maxBuffer === SIMCTL_INVENTORY_MAX_BUFFER_BYTES));
});

test("system simctl commands use bounded execution timeouts", () => {
  const calls = [];
  const adapter = createSystemSimctlAdapter({
    commandRunner(args, options) {
      calls.push({ args, options });
      return "";
    },
  });

  adapter.eraseDevice("SIM-TIMEOUT");

  assert.deepEqual(calls.map((call) => call.args), [
    ["erase", "SIM-TIMEOUT"],
  ]);
  assert.equal(calls[0].options.timeoutMs, SIMCTL_COMMAND_TIMEOUT_MS);
});

test("system simctl timeout failures surface as command failures", () => {
  const adapter = createSystemSimctlAdapter({
    commandRunner(args, options) {
      assert.deepEqual(args, ["boot", "SIM-TIMEOUT"]);
      assert.equal(options.allowFailure, true);
      return {
        exitCode: 124,
        stderr: "",
        stdout: "",
        timedOut: true,
        timeoutMs: options.timeoutMs,
      };
    },
  });

  assert.throws(() => {
    adapter.bootDevice("SIM-TIMEOUT");
  }, (error) =>
    error.exitCode === 124
      && error.timedOut === true
      && error.timeoutMs === SIMCTL_COMMAND_TIMEOUT_MS
      && /timed out/.test(error.message));
});

test("system simctl shutdown propagates failures except already-shutdown results", () => {
  const failingAdapter = createSystemSimctlAdapter({
    commandRunner(args, options) {
      assert.deepEqual(args, ["shutdown", "SIM-FAIL"]);
      assert.equal(options.allowFailure, true);
      return {
        exitCode: 61,
        stderr: "Unable to shutdown device",
        stdout: "",
      };
    },
  });
  assert.throws(() => {
    failingAdapter.shutdownDevice("SIM-FAIL");
  }, (error) => error.exitCode === 61 && error.stderr === "Unable to shutdown device");

  const alreadyShutdownAdapter = createSystemSimctlAdapter({
    commandRunner(args, options) {
      assert.deepEqual(args, ["shutdown", "SIM-SHUTDOWN"]);
      assert.equal(options.allowFailure, true);
      return {
        exitCode: 405,
        stderr: "Unable to shutdown device in current state: Shutdown",
        stdout: "",
      };
    },
  });
  assert.doesNotThrow(() => {
    alreadyShutdownAdapter.shutdownDevice("SIM-SHUTDOWN");
  });
});

test("system simctl delete propagates failures except already-deleted results", () => {
  const failingAdapter = createSystemSimctlAdapter({
    commandRunner(args, options) {
      assert.deepEqual(args, ["delete", "SIM-FAIL"]);
      assert.equal(options.allowFailure, true);
      return {
        exitCode: 62,
        stderr: "Unable to delete device",
        stdout: "",
      };
    },
  });
  assert.throws(() => {
    failingAdapter.deleteDevice("SIM-FAIL");
  }, (error) => error.exitCode === 62 && error.stderr === "Unable to delete device");

  const alreadyDeletedAdapter = createSystemSimctlAdapter({
    commandRunner(args, options) {
      assert.deepEqual(args, ["delete", "SIM-MISSING"]);
      assert.equal(options.allowFailure, true);
      return {
        exitCode: 163,
        stderr: "Invalid device: SIM-MISSING",
        stdout: "",
      };
    },
  });
  assert.doesNotThrow(() => {
    alreadyDeletedAdapter.deleteDevice("SIM-MISSING");
  });
});

test("host init bootstraps a default host id when none is provided", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);

  const result = initBroker(resolvedPaths, {
    bootstrapConfig: true,
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(result.ok, true);
  assert.equal(result.hostConfigCreated, true);
  assert.equal(typeof result.hostId, "string");
  assert.notEqual(result.hostId.length, 0);
  assert.equal(readJson(paths.hostConfigPath).hostId, result.hostId);
});

test("capacity check reports missing iPad capacity without exposing local identifiers", () => {
  const paths = makePaths();
  writeIPhoneOnlyHostConfig(paths.hostConfigPath);
  writeCapacityProject(paths.projectFilePath, [
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
  ]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  const report = checkCapacityBroker(resolvedPaths, {
    processExists: () => true,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(report.ok, true);
  assert.equal(report.command, "capacity.check");
  assert.equal(report.status, "needs_attention");
  assert.equal(report.repo.projectId, "capacity-demo");
  assert.equal(report.repo.repoRoot, null);
  assert.equal(report.host.configured, true);
  assert.equal(report.host.inventoryFresh, true);
  assert.equal(report.purposes.length, 1);
  assert.equal(report.purposes[0].status, "unavailable");
  assert.deepEqual(report.purposes[0].blockingReasons, [{ code: "no-matching-capacity" }]);
  assert.equal(report.purposes[0].recommendedAction, "create_capacity");
  assert.equal(report.summary.unavailable, 1);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(paths.root), false);
  assert.equal(serialized.includes("SIM-UI-1"), false);
  assert.equal(serialized.includes("ui-1"), false);
});

test("capacity check and preview map malformed project JSON to invalid config", () => {
  const paths = makePaths();
  writeIPhoneOnlyHostConfig(paths.hostConfigPath);
  fs.mkdirSync(path.dirname(paths.projectFilePath), { recursive: true });
  fs.writeFileSync(paths.projectFilePath, "{not-json\n");
  const resolvedPaths = brokerPaths(paths);

  for (const operation of [
    () => checkCapacityBroker(resolvedPaths, {
      simctlAdapter: paths.simctl.adapter,
    }),
    () => reconcileCapacityBroker(resolvedPaths, {
      simctlAdapter: paths.simctl.adapter,
    }),
  ]) {
    assert.throws(operation, (error) =>
      error.payload?.reasonCode === "invalid-config" && error.exitCode === 2);
  }
});

test("project-backed operations map malformed project JSON to invalid config", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  fs.mkdirSync(path.dirname(paths.projectFilePath), { recursive: true });
  fs.writeFileSync(paths.projectFilePath, "{not-json\n");
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  for (const operation of [
    () => validateProjectBroker(resolvedPaths, {
      simctlAdapter: paths.simctl.adapter,
    }),
    () => explainLeaseBroker(resolvedPaths, {
      purposeId: "agent-ui-session",
      simctlAdapter: paths.simctl.adapter,
    }),
    () => acquireLeaseBroker(resolvedPaths, {
      actorId: "agent-malformed",
      actorType: "agent",
      ownerPid: process.pid,
      processExists: (pid) => pid === process.pid,
      purposeId: "agent-ui-session",
      simctlAdapter: paths.simctl.adapter,
    }),
    () => createPinBroker(resolvedPaths, {
      actorId: "human-malformed",
      actorType: "human",
      alias: "ui-1",
      purposeId: "agent-ui-session",
      simctlAdapter: paths.simctl.adapter,
    }),
  ]) {
    assert.throws(operation, (error) =>
      error.payload?.reasonCode === "invalid-config" && error.exitCode === 2);
  }
});

test("capacity check and preview map malformed host JSON to public-safe invalid config", () => {
  const paths = makePaths();
  fs.mkdirSync(path.dirname(paths.hostConfigPath), { recursive: true });
  fs.writeFileSync(paths.hostConfigPath, "{not-json\n");
  writeCapacityProject(paths.projectFilePath, [
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
  ]);
  const resolvedPaths = brokerPaths(paths);

  for (const operation of [
    () => checkCapacityBroker(resolvedPaths, {
      simctlAdapter: paths.simctl.adapter,
    }),
    () => reconcileCapacityBroker(resolvedPaths, {
      simctlAdapter: paths.simctl.adapter,
    }),
  ]) {
    assert.throws(operation, (error) => {
      const serialized = JSON.stringify(error.payload);
      return error.payload?.reasonCode === "invalid-config"
        && error.exitCode === 2
        && serialized.includes(paths.root) === false
        && "stack" in error.payload === false;
    });
  }
});

test("capacity check validates host setup before degrading inventory failures", () => {
  const paths = makePaths();
  writeCapacityProject(paths.projectFilePath, [{
    id: "agent-ipad-session",
    displayName: "Agent iPad Session",
    capability: "interactive-resettable",
    defaultActorType: "agent",
    requires: {
      deviceFamily: "iPad",
      iosVersion: "18",
    },
  }]);
  const resolvedPaths = brokerPaths(paths);
  const unavailableInventoryAdapter = {
    ...paths.simctl.adapter,
    listDeviceTypes() {
      throw new Error("simctl inventory unavailable");
    },
  };

  const missingHostReport = checkCapacityBroker(resolvedPaths, {
    purposeId: "agent-ipad-session",
    simctlAdapter: unavailableInventoryAdapter,
  });
  assert.equal(missingHostReport.host.configured, false);
  assert.equal(missingHostReport.host.inventoryFresh, false);
  assert.equal(missingHostReport.purposes[0].status, "setup_missing");
  assert.deepEqual(missingHostReport.purposes[0].blockingReasons, [{ code: "missing-host-config" }]);

  writeJson(paths.hostConfigPath, {
    aliases: "invalid",
    hostId: "invalid-host",
    version: 1,
  });
  assert.throws(() => {
    checkCapacityBroker(resolvedPaths, {
      purposeId: "agent-ipad-session",
      simctlAdapter: unavailableInventoryAdapter,
    });
  }, (error) => error.payload?.reasonCode === "invalid-config" && error.exitCode === 2);
});

test("capacity check and preview ignore stale leases without changing broker state artifacts", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  acquireLeaseBroker(resolvedPaths, {
    actorId: "stale-agent",
    actorType: "agent",
    ownerPid: 424242,
    processExists: () => true,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });

  const leasePath = fs.readdirSync(resolvedPaths.leasesDir)
    .map((entry) => path.join(resolvedPaths.leasesDir, entry))[0];
  const trackedPaths = [
    resolvedPaths.eventsPath,
    resolvedPaths.knownProjectsPath,
    resolvedPaths.registryPath,
    leasePath,
  ];
  const before = new Map(trackedPaths.map((filePath) => [filePath, fs.readFileSync(filePath, "utf8")]));

  const check = checkCapacityBroker(resolvedPaths, {
    processExists: () => false,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });
  const preview = reconcileCapacityBroker(resolvedPaths, {
    processExists: () => false,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(check.purposes[0].status, "available");
  assert.equal(preview.status, "no_changes");
  for (const filePath of trackedPaths) {
    assert.equal(fs.readFileSync(filePath, "utf8"), before.get(filePath));
  }
});

test("capacity matching requires the provisioning reset policy", () => {
  const paths = makePaths();
  writeJson(paths.hostConfigPath, {
    version: 1,
    hostId: "test-host",
    aliases: [{
      alias: "build-ipad-1",
      capabilities: ["build-clean"],
      deviceFamily: "iPad",
      displayName: "Build iPad",
      iosVersion: "18.2",
      resetPolicy: "none",
      simulatorId: "SIM-IPAD-1",
    }],
  });
  writeCapacityProject(paths.projectFilePath, [{
    id: "clean-build",
    displayName: "Clean Build",
    capability: "build-clean",
    defaultActorType: "agent",
    requires: {
      deviceFamily: "iPad",
      iosVersion: "18",
    },
  }]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  const report = checkCapacityBroker(resolvedPaths, {
    purposeId: "clean-build",
    simctlAdapter: paths.simctl.adapter,
  });
  const preview = reconcileCapacityBroker(resolvedPaths, {
    purposeId: "clean-build",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(report.purposes[0].status, "unavailable");
  assert.equal(report.purposes[0].recommendedAction, "create_capacity");
  assert.equal(preview.status, "changes_required");
  assert.equal(preview.actions[0].requirement.resetPolicy, "erase-on-acquire");
});

test("capacity check accepts an already-provisioned custom capability", () => {
  const paths = makePaths();
  writeJson(paths.hostConfigPath, {
    version: 1,
    hostId: "test-host",
    aliases: [{
      alias: "custom-ipad-1",
      capabilities: ["custom-diagnostics"],
      deviceFamily: "iPad",
      displayName: "Custom Diagnostics",
      iosVersion: "18.2",
      resetPolicy: "none",
      simulatorId: "SIM-IPAD-1",
    }],
  });
  writeCapacityProject(paths.projectFilePath, [{
    id: "custom-diagnostics",
    displayName: "Custom Diagnostics",
    capability: "custom-diagnostics",
    defaultActorType: "agent",
    requires: {
      deviceFamily: "iPad",
      iosVersion: "18",
    },
  }]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  const report = checkCapacityBroker(resolvedPaths, {
    purposeId: "custom-diagnostics",
    simctlAdapter: paths.simctl.adapter,
  });
  const preview = reconcileCapacityBroker(resolvedPaths, {
    purposeId: "custom-diagnostics",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(report.purposes[0].status, "available");
  assert.equal(report.purposes[0].recommendedAction, "none");
  assert.equal(preview.status, "no_changes");
});

test("capacity reconcile preview deduplicates equivalent tuples and is deterministic", () => {
  const paths = makePaths();
  writeIPhoneOnlyHostConfig(paths.hostConfigPath);
  writeCapacityProject(paths.projectFilePath, [
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
    {
      id: "ci-ipad-session",
      displayName: "CI iPad Session",
      capability: "interactive-resettable",
      defaultActorType: "ci",
      requires: {
        deviceFamily: "iPad",
        iosVersion: "18",
      },
    },
  ]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  const first = reconcileCapacityBroker(resolvedPaths, {
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });
  const second = reconcileCapacityBroker(resolvedPaths, {
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(first.status, "changes_required");
  assert.equal(first.planId, second.planId);
  assert.deepEqual(first, second);
  assert.equal(first.actions.length, 1);
  assert.equal(first.actions[0].kind, "create_capacity");
  assert.deepEqual(first.actions[0].purposeIds, ["agent-ipad-session", "ci-ipad-session"]);
  assert.deepEqual(first.actions[0].requirement, {
    capability: "interactive-resettable",
    deviceFamily: "iPad",
    iosVersion: "18",
    resetPolicy: "erase-on-acquire",
  });
});

test("capacity reconcile treats busy matching capacity as non-actionable", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-busy",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });

  const plan = reconcileCapacityBroker(resolvedPaths, {
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(plan.status, "blocked");
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.blockedReasons[0].purposeId, "agent-ipad-session");
  assert.deepEqual(plan.blockedReasons[0].blockingReasons, [{ code: "matching-capacity-busy" }]);
  assert.equal(plan.blockedReasons[0].recommendedAction, "retry_when_available");
});

test("capacity reconcile apply creates additive capacity and is idempotent after a fresh no-changes preview", () => {
  const paths = makePaths();
  writeIPhoneOnlyHostConfig(paths.hostConfigPath);
  writeCapacityProject(paths.projectFilePath, [
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
  ]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const beforeHostConfig = readJson(paths.hostConfigPath);
  const preview = reconcileCapacityBroker(resolvedPaths, {
    processExists: () => true,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      processExists: () => true,
      purposeId: "agent-ipad-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "capacity-confirmation-required");

  const apply = reconcileCapacityBroker(resolvedPaths, {
    actorId: " operator ",
    actorType: "human",
    apply: true,
    confirmPlanId: preview.planId,
    processExists: () => true,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(apply.status, "applied");
  assert.equal(apply.created, 1);
  assert.equal(JSON.stringify(apply).includes("operator"), false);
  const hostConfig = readJson(paths.hostConfigPath);
  assert.equal(hostConfig.aliases.length, beforeHostConfig.aliases.length + 1);
  const createdAlias = hostConfig.aliases.find((alias) => alias.deviceFamily === "iPad");
  assert.equal(createdAlias.alias, "ipad-1");
  assert.equal(createdAlias.capabilities[0], "interactive-resettable");
  assert.equal(createdAlias.resetPolicy, "erase-on-acquire");
  assert.match(createdAlias.simulatorId, /^[0-9A-F-]{36}$/);
  const appliedTransaction = readCapacityTransactions(resolvedPaths)
    .find((transaction) => transaction.status === "finalized" && transaction.additions.length === 1);
  assert.ok(appliedTransaction);
  assert.equal(appliedTransaction.actorId, "operator");

  const check = checkCapacityBroker(resolvedPaths, {
    processExists: () => true,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(check.status, "ready");
  assert.equal(check.purposes[0].status, "available");

  const noChangesPreview = reconcileCapacityBroker(resolvedPaths, {
    processExists: () => true,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(noChangesPreview.status, "no_changes");
  const noChangesApply = reconcileCapacityBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    apply: true,
    confirmPlanId: noChangesPreview.planId,
    processExists: () => true,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(noChangesApply.status, "no_changes");
  assert.equal(noChangesApply.created, 0);
});

test("capacity reconcile apply rejects stale and non-human confirmation before mutation", () => {
  const paths = makePaths();
  writeIPhoneOnlyHostConfig(paths.hostConfigPath);
  writeCapacityProject(paths.projectFilePath, [
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
  ]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const hostConfigBefore = fs.readFileSync(paths.hostConfigPath, "utf8");
  const deviceCountBefore = readJson(paths.simctl.statePath).devices.length;

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, {
      actorId: "agent",
      actorType: "agent",
      apply: true,
      confirmPlanId: "sha256:not-current",
      processExists: () => true,
      purposeId: "agent-ipad-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-human-required" && error.exitCode === 5);

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, {
      actorId: "   ",
      actorType: "human",
      apply: true,
      confirmPlanId: "sha256:not-current",
      processExists: () => true,
      purposeId: "agent-ipad-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-human-required" && error.exitCode === 5);

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      confirmPlanId: "sha256:not-current",
      processExists: () => true,
      purposeId: "agent-ipad-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-plan-stale" && error.exitCode === 5);

  assert.equal(fs.readFileSync(paths.hostConfigPath, "utf8"), hostConfigBefore);
  assert.equal(readJson(paths.simctl.statePath).devices.length, deviceCountBefore);
  const events = readEventsBroker(resolvedPaths, {
    type: "capacity.reconcile.failed",
  });
  assert.equal(events.events.length, 3);
  assert.ok(events.events.every((event) => event.payload.reasonCode.startsWith("capacity-")));
  const blankActorTransaction = readCapacityTransactions(resolvedPaths)
    .find((transaction) =>
      transaction.status === "rejected"
      && transaction.actorType === "human"
      && transaction.rejection?.reasonCode === "capacity-human-required");
  assert.ok(blankActorTransaction);
  assert.equal(blankActorTransaction.actorId, null);
});

test("capacity reconcile apply preserves shape errors when rejection plans cannot be built", () => {
  const invalidProjectPaths = makePaths();
  writeJson(invalidProjectPaths.projectFilePath, {
    projectId: "invalid-project",
    projectName: "Invalid Project",
    purposes: "invalid",
    version: 1,
  });
  const invalidProjectBrokerPaths = brokerPaths(invalidProjectPaths);

  assert.throws(() => {
    reconcileCapacityBroker(invalidProjectBrokerPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      simctlAdapter: invalidProjectPaths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-confirmation-required" && error.exitCode === 5);

  const unknownPurposePaths = makePaths();
  writeIPhoneOnlyHostConfig(unknownPurposePaths.hostConfigPath);
  writeCapacityProject(unknownPurposePaths.projectFilePath, [{
    id: "known-purpose",
    displayName: "Known Purpose",
    capability: "interactive-resettable",
    defaultActorType: "agent",
    requires: {
      deviceFamily: "iPhone",
      iosVersion: "18",
    },
  }]);
  const unknownPurposeBrokerPaths = brokerPaths(unknownPurposePaths);

  assert.throws(() => {
    reconcileCapacityBroker(unknownPurposeBrokerPaths, {
      actorId: "agent",
      actorType: "agent",
      apply: true,
      confirmPlanId: "sha256:not-current",
      purposeId: "unknown-purpose",
      simctlAdapter: unknownPurposePaths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-human-required" && error.exitCode === 5);
});

test("capacity reconcile apply preserves setup blocker reason codes", () => {
  const missingHostPaths = makePaths();
  writeCapacityProject(missingHostPaths.projectFilePath, [{
    id: "agent-ipad-session",
    displayName: "Agent iPad Session",
    capability: "interactive-resettable",
    defaultActorType: "agent",
    requires: {
      deviceFamily: "iPad",
      iosVersion: "18",
    },
  }]);
  const missingHostBrokerPaths = brokerPaths(missingHostPaths);
  const missingHostPreview = reconcileCapacityBroker(missingHostBrokerPaths, {
    purposeId: "agent-ipad-session",
    simctlAdapter: missingHostPaths.simctl.adapter,
  });

  assert.throws(() => {
    reconcileCapacityBroker(missingHostBrokerPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      confirmPlanId: missingHostPreview.planId,
      purposeId: "agent-ipad-session",
      simctlAdapter: missingHostPaths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "missing-host-config" && error.exitCode === 2);

  const missingProjectPaths = makePaths();
  writeIPhoneOnlyHostConfig(missingProjectPaths.hostConfigPath);
  const missingProjectBrokerPaths = brokerPaths(missingProjectPaths);
  const missingProjectPreview = reconcileCapacityBroker(missingProjectBrokerPaths, {
    simctlAdapter: missingProjectPaths.simctl.adapter,
  });

  assert.throws(() => {
    reconcileCapacityBroker(missingProjectBrokerPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      confirmPlanId: missingProjectPreview.planId,
      simctlAdapter: missingProjectPaths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "missing-project-file" && error.exitCode === 2);
});

test("capacity reconcile rolls back transaction-created devices when create fails", () => {
  const paths = makePaths();
  writeIPhoneOnlyHostConfig(paths.hostConfigPath);
  writeCapacityProject(paths.projectFilePath, [
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
    {
      id: "agent-ipad-clean-build",
      displayName: "Agent iPad Clean Build",
      capability: "build-clean",
      defaultActorType: "agent",
      requires: {
        deviceFamily: "iPad",
        iosVersion: "18",
      },
    },
  ]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const preview = reconcileCapacityBroker(resolvedPaths, {
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });
  const hostConfigBefore = fs.readFileSync(paths.hostConfigPath, "utf8");
  let createCalls = 0;
  const failingAdapter = {
    ...paths.simctl.adapter,
    createDevice(name, deviceTypeId, runtimeId) {
      createCalls += 1;
      if (createCalls === 2) {
        throw new Error("simctl create failed");
      }
      return paths.simctl.adapter.createDevice(name, deviceTypeId, runtimeId);
    },
  };

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      confirmPlanId: preview.planId,
      processExists: () => true,
      simctlAdapter: failingAdapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-reconcile-rolled-back" && error.exitCode === 1);

  assert.equal(fs.readFileSync(paths.hostConfigPath, "utf8"), hostConfigBefore);
  const simctlState = readJson(paths.simctl.statePath);
  assert.equal(simctlState.devices.some((device) => device.name.includes("ipad-1")), false);
  const transactions = fs.readdirSync(path.join(paths.stateRoot, "capacity-transactions"));
  assert.equal(transactions.length, 1);
  const transaction = readJson(path.join(paths.stateRoot, "capacity-transactions", transactions[0]));
  assert.equal(transaction.status, "rolled_back");
});

test("capacity reconcile resolves planned simulator additions when create side effects lose their result", () => {
  const paths = makePaths();
  writeIPhoneOnlyHostConfig(paths.hostConfigPath);
  writeCapacityProject(paths.projectFilePath, [{
    id: "agent-ipad-session",
    displayName: "Agent iPad Session",
    capability: "interactive-resettable",
    defaultActorType: "agent",
    requires: {
      deviceFamily: "iPad",
      iosVersion: "18",
    },
  }]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const preview = reconcileCapacityBroker(resolvedPaths, {
    processExists: () => true,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });
  const interruptedAdapter = {
    ...paths.simctl.adapter,
    createDevice(name, deviceTypeId, runtimeId) {
      paths.simctl.adapter.createDevice(name, deviceTypeId, runtimeId);
      throw new Error("simctl create result was interrupted");
    },
  };

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      confirmPlanId: preview.planId,
      processExists: () => true,
      purposeId: "agent-ipad-session",
      simctlAdapter: interruptedAdapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-reconcile-rolled-back");

  const simctlState = readJson(paths.simctl.statePath);
  assert.equal(simctlState.devices.some((device) => device.name.includes("ipad-1")), false);
  const transactionPath = fs.readdirSync(resolvedPaths.capacityTransactionsDir)
    .map((entry) => path.join(resolvedPaths.capacityTransactionsDir, entry))[0];
  const transaction = readJson(transactionPath);
  assert.equal(transaction.status, "rolled_back");
  assert.equal(transaction.additions[0].alias, "ipad-1");
  assert.equal(typeof transaction.additions[0].simulatorId, "string");
  assert.equal(typeof transaction.additions[0].simulatorIdRecoveredAt, "string");
});

test("capacity rollback does not delete preexisting matching simulators after create fails", () => {
  const paths = makePaths();
  writeIPhoneOnlyHostConfig(paths.hostConfigPath);
  writeCapacityProject(paths.projectFilePath, [{
    id: "agent-ipad-session",
    displayName: "Agent iPad Session",
    capability: "interactive-resettable",
    defaultActorType: "agent",
    requires: {
      deviceFamily: "iPad",
      iosVersion: "18",
    },
  }]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const simctlState = readJson(paths.simctl.statePath);
  simctlState.devices.push(createDeviceRecord({
    deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-A16",
    name: "Simulator Broker test-host ipad-1",
    udid: "SIM-PREEXISTING-IPAD",
  }));
  writeJson(paths.simctl.statePath, simctlState);
  const preview = reconcileCapacityBroker(resolvedPaths, {
    processExists: () => true,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });
  const failingAdapter = {
    ...paths.simctl.adapter,
    createDevice() {
      throw new Error("simctl create failed before side effects");
    },
  };

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      confirmPlanId: preview.planId,
      processExists: () => true,
      purposeId: "agent-ipad-session",
      simctlAdapter: failingAdapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-reconcile-rolled-back");

  const updatedSimctlState = readJson(paths.simctl.statePath);
  assert.ok(updatedSimctlState.devices.some((device) => device.udid === "SIM-PREEXISTING-IPAD"));
  const transactionPath = fs.readdirSync(resolvedPaths.capacityTransactionsDir)
    .map((entry) => path.join(resolvedPaths.capacityTransactionsDir, entry))[0];
  const transaction = readJson(transactionPath);
  assert.equal(transaction.status, "rolled_back");
  assert.deepEqual(transaction.additions[0].preCreateDeviceIds, ["SIM-PREEXISTING-IPAD"]);
  assert.equal(transaction.additions[0].simulatorId, null);
});

test("capacity reconcile recovers a committed transaction without deleting committed capacity", () => {
  const paths = makePaths();
  writeIPhoneOnlyHostConfig(paths.hostConfigPath);
  writeCapacityProject(paths.projectFilePath, [
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
  ]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const preview = reconcileCapacityBroker(resolvedPaths, {
    processExists: () => true,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      capacityAuditFailureStage: "after-commit",
      confirmPlanId: preview.planId,
      processExists: () => true,
      purposeId: "agent-ipad-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-committed-recovery-required" && error.exitCode === 1);

  assert.equal(readJson(paths.hostConfigPath).aliases.some((alias) => alias.alias === "ipad-1"), true);
  const recoveredPreview = reconcileCapacityBroker(resolvedPaths, {
    processExists: () => true,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(recoveredPreview.status, "no_changes");
  let transactions = fs.readdirSync(path.join(paths.stateRoot, "capacity-transactions"));
  let transaction = readJson(path.join(paths.stateRoot, "capacity-transactions", transactions[0]));
  assert.equal(transaction.status, "committed_recovery_required");
  const events = readEventsBroker(resolvedPaths, {
    type: "capacity.reconcile.applied",
  });
  assert.equal(events.events.some((event) => event.payload.recovered === true), false);

  const recoveredApply = reconcileCapacityBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    apply: true,
    confirmPlanId: recoveredPreview.planId,
    processExists: () => true,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(recoveredApply.status, "no_changes");
  transactions = fs.readdirSync(path.join(paths.stateRoot, "capacity-transactions"))
    .map((entry) => readJson(path.join(paths.stateRoot, "capacity-transactions", entry)));
  transaction = transactions.find((entry) => entry.additions?.some((addition) => addition.alias === "ipad-1"));
  assert.ok(transaction);
  assert.equal(transaction.status, "finalized");
  assert.equal(transaction.recoveryState, "committed");
  const recoveredEvents = readEventsBroker(resolvedPaths, {
    type: "capacity.reconcile.applied",
  });
  assert.ok(recoveredEvents.events.some((event) => event.payload.recovered === true));
});

test("capacity reconcile preserves committed capacity when the post-commit state audit throws", () => {
  const paths = makePaths();
  writeIPhoneOnlyHostConfig(paths.hostConfigPath);
  writeCapacityProject(paths.projectFilePath, [{
    id: "agent-ipad-session",
    displayName: "Agent iPad Session",
    capability: "interactive-resettable",
    defaultActorType: "agent",
    requires: {
      deviceFamily: "iPad",
      iosVersion: "18",
    },
  }]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const preview = reconcileCapacityBroker(resolvedPaths, {
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });
  const failingAuditAdapter = {
    ...paths.simctl.adapter,
    listDevices() {
      if (readJson(paths.hostConfigPath).aliases.some((alias) => alias.alias === "ipad-1")) {
        throw new Error("post-commit inventory audit failed");
      }
      return paths.simctl.adapter.listDevices();
    },
  };

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      confirmPlanId: preview.planId,
      processExists: () => true,
      purposeId: "agent-ipad-session",
      simctlAdapter: failingAuditAdapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-committed-recovery-required");

  assert.equal(readJson(paths.hostConfigPath).aliases.some((alias) => alias.alias === "ipad-1"), true);
  assert.equal(readJson(paths.simctl.statePath).devices.some((device) => device.name.includes("ipad-1")), true);
  const transactionPath = fs.readdirSync(resolvedPaths.capacityTransactionsDir)
    .map((entry) => path.join(resolvedPaths.capacityTransactionsDir, entry))[0];
  assert.equal(readJson(transactionPath).status, "committed_recovery_required");
});

test("capacity reconcile times out instead of reclaiming a live lock owner", () => {
  const paths = makePaths();
  writeIPhoneOnlyHostConfig(paths.hostConfigPath);
  writeCapacityProject(paths.projectFilePath, [{
    id: "agent-ipad-session",
    displayName: "Agent iPad Session",
    capability: "interactive-resettable",
    defaultActorType: "agent",
    requires: {
      deviceFamily: "iPad",
      iosVersion: "18",
    },
  }]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const preview = reconcileCapacityBroker(resolvedPaths, {
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });
  fs.mkdirSync(resolvedPaths.capacityLockDir, { recursive: true });
  writeJson(resolvedPaths.capacityLockOwnerPath, {
    pid: process.pid,
    startedAt: new Date(0).toISOString(),
  });

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      capacityLockTimeoutMilliseconds: 1,
      processExists: (pid) => pid === process.pid,
      purposeId: "agent-ipad-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-confirmation-required" && error.exitCode === 5);

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      capacityLockTimeoutMilliseconds: 1,
      confirmPlanId: preview.planId,
      processExists: (pid) => pid === process.pid,
      purposeId: "agent-ipad-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-apply-blocked");

  assert.equal(fs.existsSync(resolvedPaths.capacityLockOwnerPath), true);
  assert.equal(readJson(paths.hostConfigPath).aliases.some((alias) => alias.alias === "ipad-1"), false);
  assert.equal(readEventsBroker(resolvedPaths, {
    type: "capacity.reconcile.failed",
  }).events.length, 0);
});

test("capacity reconcile apply waits for the lease mutation lock before mutating state", () => {
  const paths = makePaths();
  writeIPhoneOnlyHostConfig(paths.hostConfigPath);
  writeCapacityProject(paths.projectFilePath, [{
    id: "agent-ipad-session",
    displayName: "Agent iPad Session",
    capability: "interactive-resettable",
    defaultActorType: "agent",
    requires: {
      deviceFamily: "iPad",
      iosVersion: "18",
    },
  }]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const preview = reconcileCapacityBroker(resolvedPaths, {
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: process.pid,
    startedAt: new Date(0).toISOString(),
  });

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      confirmPlanId: preview.planId,
      leaseLockTimeoutMilliseconds: 1,
      processExists: (pid) => pid === process.pid,
      purposeId: "agent-ipad-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "alias-busy" && error.exitCode === 3);

  assert.equal(fs.existsSync(resolvedPaths.leaseLockOwnerPath), true);
  assert.equal(fs.existsSync(resolvedPaths.capacityLockOwnerPath), false);
  assert.equal(readJson(paths.hostConfigPath).aliases.some((alias) => alias.alias === "ipad-1"), false);
  assert.deepEqual(readCapacityTransactions(resolvedPaths), []);
});

test("capacity reconcile merges a current host-config repair before committing additions", () => {
  const paths = makePaths();
  writeIPhoneOnlyHostConfig(paths.hostConfigPath);
  writeCapacityProject(paths.projectFilePath, [{
    id: "agent-ipad-session",
    displayName: "Agent iPad Session",
    capability: "interactive-resettable",
    defaultActorType: "agent",
    requires: {
      deviceFamily: "iPad",
      iosVersion: "18",
    },
  }]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const preview = reconcileCapacityBroker(resolvedPaths, {
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });
  let repairedSimulatorId = null;
  const interleavingAdapter = {
    ...paths.simctl.adapter,
    createDevice(name, deviceTypeId, runtimeId) {
      const createdSimulatorId = paths.simctl.adapter.createDevice(name, deviceTypeId, runtimeId);
      repairedSimulatorId = paths.simctl.adapter.createDevice(
        "Repaired UI One",
        "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        runtimeId,
      );
      const currentHostConfig = readJson(paths.hostConfigPath);
      const repairedAlias = currentHostConfig.aliases.find((alias) => alias.alias === "ui-1");
      repairedAlias.simulatorId = repairedSimulatorId;
      repairedAlias.iosVersion = "18.2";
      writeJson(paths.hostConfigPath, currentHostConfig);
      return createdSimulatorId;
    },
  };

  const applied = reconcileCapacityBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    apply: true,
    confirmPlanId: preview.planId,
    processExists: () => true,
    purposeId: "agent-ipad-session",
    simctlAdapter: interleavingAdapter,
  });

  assert.equal(applied.status, "applied");
  const hostConfig = readJson(paths.hostConfigPath);
  assert.equal(hostConfig.aliases.find((alias) => alias.alias === "ui-1").simulatorId, repairedSimulatorId);
  assert.equal(hostConfig.aliases.some((alias) => alias.alias === "ipad-1"), true);
});

test("invalid capacity apply leaves committed recovery pending", () => {
  const paths = makePaths();
  writeIPhoneOnlyHostConfig(paths.hostConfigPath);
  writeCapacityProject(paths.projectFilePath, [{
    id: "agent-ipad-session",
    displayName: "Agent iPad Session",
    capability: "interactive-resettable",
    defaultActorType: "agent",
    requires: {
      deviceFamily: "iPad",
      iosVersion: "18",
    },
  }]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const preview = reconcileCapacityBroker(resolvedPaths, {
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      capacityAuditFailureStage: "after-commit",
      confirmPlanId: preview.planId,
      processExists: () => true,
      purposeId: "agent-ipad-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-committed-recovery-required");

  const pendingTransactionPath = fs.readdirSync(resolvedPaths.capacityTransactionsDir)
    .map((entry) => path.join(resolvedPaths.capacityTransactionsDir, entry))
    .find((entry) => readJson(entry).status === "committed_recovery_required");
  assert.ok(pendingTransactionPath);

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      processExists: () => true,
      purposeId: "agent-ipad-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-confirmation-required");

  assert.equal(readJson(pendingTransactionPath).status, "committed_recovery_required");
  const recoveredEvents = readEventsBroker(resolvedPaths, {
    type: "capacity.reconcile.applied",
  });
  assert.equal(recoveredEvents.events.some((event) => event.payload.recovered === true), false);
});

test("rollback-incomplete capacity transactions block later creation until deletion succeeds", () => {
  const paths = makePaths();
  writeIPhoneOnlyHostConfig(paths.hostConfigPath);
  writeCapacityProject(paths.projectFilePath, [
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
    {
      id: "agent-ipad-clean-build",
      displayName: "Agent iPad Clean Build",
      capability: "build-clean",
      defaultActorType: "agent",
      requires: {
        deviceFamily: "iPad",
        iosVersion: "18",
      },
    },
  ]);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const preview = reconcileCapacityBroker(resolvedPaths, {
    simctlAdapter: paths.simctl.adapter,
  });
  let createCalls = 0;
  const failedCleanupAdapter = {
    ...paths.simctl.adapter,
    createDevice(name, deviceTypeId, runtimeId) {
      createCalls += 1;
      if (createCalls > 1) {
        throw new Error("simctl create failed");
      }
      return paths.simctl.adapter.createDevice(name, deviceTypeId, runtimeId);
    },
    deleteDevice() {},
  };

  const applyOptions = {
    actorId: "operator",
    actorType: "human",
    apply: true,
    confirmPlanId: preview.planId,
    processExists: () => true,
    simctlAdapter: failedCleanupAdapter,
  };
  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, applyOptions);
  }, (error) => error.payload?.reasonCode === "capacity-rollback-incomplete");
  assert.equal(createCalls, 2);
  const incompleteTransactionPath = fs.readdirSync(resolvedPaths.capacityTransactionsDir)
    .map((entry) => path.join(resolvedPaths.capacityTransactionsDir, entry))
    .find((entry) => readJson(entry).status === "rollback_incomplete");
  assert.ok(incompleteTransactionPath);

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, applyOptions);
  }, (error) => error.payload?.reasonCode === "capacity-rollback-incomplete");
  assert.equal(createCalls, 2);
  assert.equal(readJson(incompleteTransactionPath).status, "rollback_incomplete");
});

test("ambiguous failed capacity transactions remain recovery-blocking", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  writeJson(path.join(resolvedPaths.capacityTransactionsDir, "ambiguous.json"), {
    actorId: "operator",
    actorType: "human",
    additions: [
      { alias: "ui-1", simulatorId: "SIM-UI-1" },
      { alias: "uncommitted", simulatorId: "SIM-UNKNOWN" },
    ],
    planId: "sha256:ambiguous",
    projectId: "demo-app",
    status: "failed",
    transactionId: "ambiguous",
  });
  const preview = reconcileCapacityBroker(resolvedPaths, {
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.throws(() => {
    reconcileCapacityBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      confirmPlanId: preview.planId,
      processExists: () => true,
      purposeId: "agent-ipad-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-recovery-ambiguous");
  assert.equal(readJson(path.join(resolvedPaths.capacityTransactionsDir, "ambiguous.json")).status, "failed");
  const failedEvents = readEventsBroker(resolvedPaths, {
    type: "capacity.reconcile.failed",
  });
  assert.equal(failedEvents.events.length, 1);
  assert.equal(failedEvents.events[0].payload.reasonCode, "capacity-recovery-ambiguous");
  assert.equal(failedEvents.events[0].payload.recovered, true);
});

test("simulator repair shares the host-config mutation lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.mkdirSync(resolvedPaths.capacityLockDir, { recursive: true });
  writeJson(resolvedPaths.capacityLockOwnerPath, {
    pid: process.pid,
    startedAt: new Date(0).toISOString(),
  });

  assert.throws(() => {
    repairSimulatorBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      alias: "ui-1",
      capacityLockTimeoutMilliseconds: 1,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "capacity-apply-blocked");
  assert.equal(fs.existsSync(resolvedPaths.capacityLockOwnerPath), true);
});

test("state load recovers interrupted repairing aliases to repair-needed", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const registry = readJson(resolvedPaths.registryPath);
  registry.aliases["ui-1"].health = "repairing";
  registry.aliases["ui-1"].driftReason = null;
  writeJson(resolvedPaths.registryPath, registry);

  const status = hostStatusBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const recovered = status.simulators.find((simulator) => simulator.alias === "ui-1");

  assert.equal(recovered.health, "repair-needed");
  assert.equal(recovered.driftReason, "repair-interrupted");
  assert.equal(readJson(resolvedPaths.registryPath).aliases["ui-1"].health, "repair-needed");
  assert.doesNotThrow(() => {
    repairSimulatorBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      alias: "ui-1",
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  });
});

test("starter host bootstrap leaves a second build alias available when one build lease is already active", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, {
    bootstrapConfig: true,
    hostId: "bootstrap-host",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });
  initProjectBroker(resolvedPaths, {
    projectId: "build-demo",
    projectName: "Build Demo",
    repoRoot: path.join(paths.root, "repo"),
  });

  const firstLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-build-1",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-build-test",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.match(firstLease.alias, /^build-[12]$/);

  const explanation = explainLeaseBroker(resolvedPaths, {
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-build-test",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(explanation.ok, true);
  assert.equal(explanation.availableAliases.length, 1);
  assert.notEqual(explanation.availableAliases[0], firstLease.alias);
  assert.match(explanation.availableAliases[0], /^build-[12]$/);
});

test("starter host bootstrap leaves a second iPhone UI alias available when one ui lease is already active", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, {
    bootstrapConfig: true,
    hostId: "bootstrap-host",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });
  initProjectBroker(resolvedPaths, {
    projectId: "ui-demo",
    projectName: "UI Demo",
    repoRoot: path.join(paths.root, "repo"),
  });

  const firstLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-ui-1",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.match(firstLease.alias, /^ui-[12]$/);

  const explanation = explainLeaseBroker(resolvedPaths, {
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(explanation.ok, true);
  assert.equal(explanation.availableAliases.length, 1);
  assert.notEqual(explanation.availableAliases[0], firstLease.alias);
  assert.match(explanation.availableAliases[0], /^ui-[12]$/);
});

test("acquire rolls back the lease when erase-on-acquire reset fails", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const failingAdapter = {
    ...paths.simctl.adapter,
    eraseDevice(simulatorId) {
      if (simulatorId === "SIM-UI-1") {
        throw new Error("simctl erase failed");
      }
      return paths.simctl.adapter.eraseDevice(simulatorId);
    },
  };

  initBroker(resolvedPaths, {
    processExists: () => true,
    simctlAdapter: failingAdapter,
  });

  assert.throws(() => {
    acquireLeaseBroker(resolvedPaths, {
      actorId: "agent-reset",
      actorType: "agent",
      ownerPid: process.pid,
      processExists: (pid) => pid === process.pid,
      purposeId: "agent-ui-session",
      simctlAdapter: failingAdapter,
    });
  }, /Failed to reset alias/);

  const registry = readJson(path.join(paths.stateRoot, "registry.json"));
  assert.equal(registry.aliases["ui-1"].activeLeaseId, null);
  assert.equal(registry.aliases["ui-1"].health, "repair-needed");
  assert.equal(fs.readdirSync(path.join(paths.stateRoot, "leases")).length, 0);
});

test("acquire rejects lease artifacts that overlap broker config or state", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  for (const artifactPath of [
    paths.hostConfigPath,
    paths.projectFilePath,
    resolvedPaths.registryPath,
    path.join(resolvedPaths.stateRoot, "lease-artifact.json"),
  ]) {
    assert.throws(() => {
      acquireLeaseBroker(resolvedPaths, {
        actorId: "agent-artifact",
        actorType: "agent",
        leaseFile: artifactPath,
        ownerPid: process.pid,
        processExists: (pid) => pid === process.pid,
        purposeId: "agent-ui-session",
        simctlAdapter: paths.simctl.adapter,
      });
    }, (error) =>
      error.payload?.reasonCode === "invalid-lease-artifact-path"
        && error.exitCode === 2
        && error.payload.artifactPath === path.resolve(artifactPath));
  }

  assert.equal(validateHostConfig(readJson(paths.hostConfigPath)).aliases.length, 4);
  assert.equal(readJson(paths.projectFilePath).projectId, "demo-app");
  assert.deepEqual(fs.readdirSync(resolvedPaths.leasesDir), []);
});

test("acquire rejects lease artifacts through symlinked protected parents", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const stateLink = path.join(paths.root, "state-link");
  const rootLink = path.join(paths.root, "root-link");

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.symlinkSync(resolvedPaths.stateRoot, stateLink, "dir");
  fs.symlinkSync(paths.root, rootLink, "dir");

  for (const artifactPath of [
    path.join(stateLink, "lease-artifact.json"),
    path.join(rootLink, path.basename(paths.hostConfigPath)),
  ]) {
    assert.throws(() => {
      acquireLeaseBroker(resolvedPaths, {
        actorId: "agent-symlink-artifact",
        actorType: "agent",
        leaseFile: artifactPath,
        ownerPid: process.pid,
        processExists: (pid) => pid === process.pid,
        purposeId: "agent-ui-session",
        simctlAdapter: paths.simctl.adapter,
      });
    }, (error) =>
      error.payload?.reasonCode === "invalid-lease-artifact-path"
        && error.exitCode === 2
        && error.payload.artifactPath === path.resolve(artifactPath));
  }

  assert.equal(validateHostConfig(readJson(paths.hostConfigPath)).aliases.length, 4);
  assert.deepEqual(fs.readdirSync(resolvedPaths.leasesDir), []);
});

test("acquire rolls back the canonical lease when emitted lease artifact write fails", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const blockedParentPath = path.join(paths.root, "blocked-lease-parent");
  fs.writeFileSync(blockedParentPath, "not a directory\n");

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  assert.throws(() => {
    acquireLeaseBroker(resolvedPaths, {
      actorId: "agent-artifact-failure",
      actorType: "agent",
      leaseFile: path.join(blockedParentPath, "lease.json"),
      ownerPid: process.pid,
      processExists: (pid) => pid === process.pid,
      purposeId: "agent-ui-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "lease-artifact-path-exists");

  assert.deepEqual(fs.readdirSync(resolvedPaths.leasesDir), []);
  assert.equal(readJson(resolvedPaths.registryPath).aliases["ui-1"].activeLeaseId, null);
});

test("acquire rejects lease artifact paths used by active leases", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const sharedLeaseFile = path.join(paths.root, "shared-lease.json");

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const firstLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-first-artifact",
    actorType: "agent",
    leaseFile: sharedLeaseFile,
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.throws(() => {
    acquireLeaseBroker(resolvedPaths, {
      actorId: "agent-second-artifact",
      actorType: "agent",
      leaseFile: sharedLeaseFile,
      ownerPid: process.pid,
      processExists: (pid) => pid === process.pid,
      purposeId: "agent-ui-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) =>
    error.payload?.reasonCode === "lease-artifact-path-in-use"
      && error.payload.activeLeaseId === firstLease.leaseId);

  assert.equal(readJson(sharedLeaseFile).leaseId, firstLease.leaseId);
  assert.deepEqual(fs.readdirSync(resolvedPaths.leasesDir).sort(), [`${firstLease.leaseId}.json`]);
});

test("acquire rolls back lease files when registry persistence fails", (t) => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const leaseFile = path.join(paths.root, "registry-failure-lease.json");
  const originalRenameSync = fs.renameSync;
  let registryWriteFailed = false;

  t.after(() => {
    fs.renameSync = originalRenameSync;
  });

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.renameSync = (oldPath, newPath) => {
    if (newPath === resolvedPaths.registryPath && !registryWriteFailed) {
      registryWriteFailed = true;
      const error = new Error("Injected registry persistence failure.");
      error.code = "ENOSPC";
      throw error;
    }
    return originalRenameSync(oldPath, newPath);
  };

  assert.throws(() => {
    acquireLeaseBroker(resolvedPaths, {
      actorId: "agent-registry-failure",
      actorType: "agent",
      leaseFile,
      ownerPid: process.pid,
      processExists: (pid) => pid === process.pid,
      purposeId: "agent-ui-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, /Injected registry persistence failure/);

  assert.equal(registryWriteFailed, true);
  assert.equal(fs.existsSync(leaseFile), false);
  assert.deepEqual(fs.readdirSync(resolvedPaths.leasesDir), []);
  assert.equal(readJson(resolvedPaths.registryPath).aliases["ui-1"].activeLeaseId, null);
});

test("lease updates restore the previous lease files when artifact persistence fails", (t) => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const leaseFile = path.join(paths.root, "lease-update-artifact.json");
  const originalRenameSync = fs.renameSync;
  let artifactWriteFailed = false;

  t.after(() => {
    fs.renameSync = originalRenameSync;
  });

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-update-artifact",
    actorType: "agent",
    leaseFile,
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  const canonicalLeasePath = path.join(resolvedPaths.leasesDir, `${lease.leaseId}.json`);
  const canonicalBefore = fs.readFileSync(canonicalLeasePath, "utf8");
  const artifactBefore = fs.readFileSync(leaseFile, "utf8");

  fs.renameSync = (oldPath, newPath) => {
    if (newPath === leaseFile && !artifactWriteFailed) {
      artifactWriteFailed = true;
      const error = new Error("Injected lease artifact persistence failure.");
      error.code = "ENOSPC";
      throw error;
    }
    return originalRenameSync(oldPath, newPath);
  };

  assert.throws(() => {
    registerLeaseProcessBroker(resolvedPaths, {
      commandPid: process.pid,
      leaseId: lease.leaseId,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, /Injected lease artifact persistence failure/);

  assert.equal(artifactWriteFailed, true);
  assert.equal(fs.readFileSync(canonicalLeasePath, "utf8"), canonicalBefore);
  assert.equal(fs.readFileSync(leaseFile, "utf8"), artifactBefore);
  assert.equal(readJson(resolvedPaths.registryPath).aliases[lease.alias].activeLeaseId, lease.leaseId);
});

test("lease release keeps lease files when registry persistence fails", (t) => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const leaseFile = path.join(paths.root, "release-registry-failure.json");
  const originalRenameSync = fs.renameSync;
  let registryWriteFailed = false;

  t.after(() => {
    fs.renameSync = originalRenameSync;
  });

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-release-registry",
    actorType: "agent",
    leaseFile,
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  const canonicalLeasePath = path.join(resolvedPaths.leasesDir, `${lease.leaseId}.json`);

  fs.renameSync = (oldPath, newPath) => {
    if (newPath === resolvedPaths.registryPath && !registryWriteFailed) {
      registryWriteFailed = true;
      const error = new Error("Injected release registry persistence failure.");
      error.code = "ENOSPC";
      throw error;
    }
    return originalRenameSync(oldPath, newPath);
  };

  assert.throws(() => {
    releaseLeaseBroker(resolvedPaths, {
      leaseId: lease.leaseId,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, /Injected release registry persistence failure/);

  assert.equal(registryWriteFailed, true);
  assert.equal(fs.existsSync(canonicalLeasePath), true);
  assert.equal(fs.existsSync(leaseFile), true);
  assert.equal(readJson(resolvedPaths.registryPath).aliases[lease.alias].activeLeaseId, lease.leaseId);
});

test("lease release preserves active state when artifact cleanup fails", (t) => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const leaseFile = path.join(paths.root, "release-artifact-failure.json");
  const originalRmSync = fs.rmSync;
  let artifactCleanupFailed = false;

  t.after(() => {
    fs.rmSync = originalRmSync;
  });

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-release-artifact",
    actorType: "agent",
    leaseFile,
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  const canonicalLeasePath = path.join(resolvedPaths.leasesDir, `${lease.leaseId}.json`);

  fs.rmSync = (targetPath, options) => {
    if (targetPath === leaseFile && !artifactCleanupFailed) {
      artifactCleanupFailed = true;
      const error = new Error("Injected lease artifact cleanup failure.");
      error.code = "EACCES";
      throw error;
    }
    return originalRmSync(targetPath, options);
  };

  assert.throws(() => {
    releaseLeaseBroker(resolvedPaths, {
      leaseId: lease.leaseId,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, /Injected lease artifact cleanup failure/);

  assert.equal(artifactCleanupFailed, true);
  assert.equal(fs.existsSync(canonicalLeasePath), true);
  assert.equal(fs.existsSync(leaseFile), true);
  assert.equal(readJson(resolvedPaths.registryPath).aliases[lease.alias].activeLeaseId, lease.leaseId);
});

test("release rejects a historical protected lease artifact before deleting broker files", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const safeLeaseFile = path.join(paths.root, "lease.json");

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-owner",
    actorType: "agent",
    leaseFile: safeLeaseFile,
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  const canonicalLeasePath = path.join(resolvedPaths.leasesDir, `${lease.leaseId}.json`);
  writeJson(canonicalLeasePath, {
    ...readJson(canonicalLeasePath),
    artifactPath: paths.hostConfigPath,
  });

  assert.throws(() => {
    releaseLeaseBroker(resolvedPaths, {
      leaseId: lease.leaseId,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "invalid-lease-artifact-path" && error.exitCode === 2);

  assert.equal(validateHostConfig(readJson(paths.hostConfigPath)).aliases.length, 4);
  assert.equal(fs.existsSync(canonicalLeasePath), true);
  assert.equal(readJson(resolvedPaths.registryPath).aliases[lease.alias].activeLeaseId, lease.leaseId);
});

test("reset lock timeout preserves a live owner lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.mkdirSync(resolvedPaths.resetLockDir, { recursive: true });
  writeJson(resolvedPaths.resetLockOwnerPath, {
    pid: process.pid,
    startedAt: new Date(0).toISOString(),
  });
  const oldTimestamp = new Date(0);
  fs.utimesSync(resolvedPaths.resetLockDir, oldTimestamp, oldTimestamp);
  fs.utimesSync(resolvedPaths.resetLockOwnerPath, oldTimestamp, oldTimestamp);

  assert.throws(() => {
    acquireLeaseBroker(resolvedPaths, {
      actorId: "agent-reset-lock",
      actorType: "agent",
      ownerPid: process.pid,
      processExists: (pid) => pid === process.pid,
      purposeId: "agent-ui-session",
      resetLockTimeoutMilliseconds: 1,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "reset-on-acquire-failed");

  assert.equal(fs.existsSync(resolvedPaths.resetLockOwnerPath), true);
  assert.equal(readJson(resolvedPaths.resetLockOwnerPath).pid, process.pid);
  assert.equal(fs.readdirSync(path.join(paths.stateRoot, "leases")).length, 0);
});

test("project init scaffolds a starter project file and records it for later app snapshots", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);

  const result = initProjectBroker(resolvedPaths, {
    iosVersion: "18",
    projectId: "fresh-repo",
    projectName: "Fresh Repo",
    repoRoot: path.join(paths.root, "repo"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.projectConfig.projectId, "fresh-repo");
  assert.ok(fs.existsSync(paths.projectFilePath));
  const knownProjects = readJson(path.join(paths.stateRoot, "known-projects.json"));
  assert.equal(knownProjects.projects["fresh-repo"].projectName, "Fresh Repo");
  assert.equal(
    knownProjects.projects["fresh-repo"].purposes.find((purpose) => purpose.id === "agent-ui-session")?.requires?.iosVersion,
    "18",
  );
});

test("project init default ids include a repo-root hash to avoid basename collisions", () => {
  const paths = makePaths();
  const firstRepoRoot = path.join(paths.root, "left", "shared-repo");
  const secondRepoRoot = path.join(paths.root, "right", "shared-repo");
  const firstProjectFile = path.join(firstRepoRoot, ".simulator-broker/project.json");
  const secondProjectFile = path.join(secondRepoRoot, ".simulator-broker/project.json");
  const firstPaths = resolveBrokerPaths({
    hostConfigPath: paths.hostConfigPath,
    projectFilePath: firstProjectFile,
    stateRoot: paths.stateRoot,
  });
  const secondPaths = resolveBrokerPaths({
    hostConfigPath: paths.hostConfigPath,
    projectFilePath: secondProjectFile,
    stateRoot: paths.stateRoot,
  });

  const first = initProjectBroker(firstPaths, {
    projectName: "Shared Repo",
    repoRoot: firstRepoRoot,
  });
  const second = initProjectBroker(secondPaths, {
    projectName: "Shared Repo",
    repoRoot: secondRepoRoot,
  });

  assert.match(first.projectConfig.projectId, /^shared-repo-[a-f0-9]{16}$/);
  assert.match(second.projectConfig.projectId, /^shared-repo-[a-f0-9]{16}$/);
  assert.notEqual(first.projectConfig.projectId, second.projectConfig.projectId);
  const knownProjects = readJson(path.join(paths.stateRoot, "known-projects.json"));
  assert.ok(knownProjects.projects[first.projectConfig.projectId]);
  assert.ok(knownProjects.projects[second.projectConfig.projectId]);
});

test("project validate records prototype-like project ids as own known-project entries", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeJson(paths.projectFilePath, {
    projectId: "__proto__",
    projectName: "Prototype Project",
    purposes: [{
      id: "agent-ui-session",
      displayName: "Agent UI Session",
      capability: "interactive-resettable",
      defaultActorType: "agent",
    }],
    version: 1,
  });
  const resolvedPaths = brokerPaths(paths);

  const result = validateProjectBroker(resolvedPaths, {
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(result.ok, true);
  const knownProjects = readJson(path.join(paths.stateRoot, "known-projects.json"));
  assert.equal(Object.hasOwn(knownProjects.projects, "__proto__"), true);
  assert.equal(knownProjects.projects["__proto__"].projectName, "Prototype Project");
  const snapshot = appSnapshotBroker(resolvedPaths, {
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(snapshot.projects.some((project) => project.projectId === "__proto__"), true);
});

test("registry records prototype-like aliases as own entries", () => {
  const paths = makePaths();
  writeJson(paths.hostConfigPath, {
    version: 1,
    hostId: "prototype-alias-host",
    aliases: [{
      alias: "__proto__",
      capabilities: ["interactive-resettable"],
      deviceFamily: "iPhone",
      displayName: "Prototype Alias",
      iosVersion: "18.2",
      resetPolicy: "erase-on-acquire",
      simulatorId: "SIM-UI-1",
    }],
  });
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const registry = readJson(resolvedPaths.registryPath);

  assert.equal(Object.hasOwn(registry.aliases, "__proto__"), true);
  assert.equal(registry.aliases["__proto__"].alias, "__proto__");

  registry.aliases["__proto__"].health = "repair-needed";
  registry.aliases["__proto__"].driftReason = "operator-check";
  writeJson(resolvedPaths.registryPath, registry);

  const status = hostStatusBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const simulator = status.simulators.find((candidate) => candidate.alias === "__proto__");

  assert.equal(simulator?.health, "repair-needed");
  assert.equal(simulator?.driftReason, "operator-check");
  assert.equal(readJson(resolvedPaths.registryPath).aliases["__proto__"].health, "repair-needed");
});

test("app snapshot summarizes active leases, pins, projects, and recent events", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  createPinBroker(resolvedPaths, {
    actorId: "human-1",
    actorType: "human",
    alias: "manual-1",
    purposeId: "manual-testing",
    simctlAdapter: paths.simctl.adapter,
  });
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-1",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  const snapshot = appSnapshotBroker(resolvedPaths, {
    eventLimit: 10,
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.hostConfigPath, resolvedPaths.hostConfigPath);
  assert.equal(snapshot.overview.totalAliases, 4);
  assert.equal(snapshot.overview.leasedAliases, 1);
  assert.equal(snapshot.overview.pinnedAliases, 1);
  assert.equal(snapshot.activeLeases.length, 1);
  assert.equal(snapshot.pins.length, 1);
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0].projectId, "demo-app");
  assert.equal(snapshot.projects[0].projectFilePath, paths.projectFilePath);
  assert.equal(snapshot.projects[0].repoRoot, path.join(paths.root, "repo"));
  assert.ok(snapshot.projects[0].purposes.some((purpose) => purpose.purposeId === "agent-ui-session"));
  assert.equal(snapshot.projects[0].purposes.find((purpose) => purpose.purposeId === "agent-ui-session")?.displayName, "Agent UI Session");
  assert.equal(snapshot.projects[0].purposes.find((purpose) => purpose.purposeId === "agent-ui-session")?.capability, "interactive-resettable");
  assert.equal(snapshot.simulators.find((simulator) => simulator.alias === lease.alias)?.activeLeaseSummary?.actorId, "agent-1");
  assert.ok(snapshot.recentEvents.some((event) => event.type === "lease.acquired"));
});

test("app snapshot does not mutate broker lease or registry state", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-snapshot",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  const registryBefore = readJson(resolvedPaths.registryPath);

  const snapshot = appSnapshotBroker(resolvedPaths, {
    processExists: () => false,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(snapshot.activeLeases.length, 0);
  assert.deepEqual(readJson(resolvedPaths.registryPath), registryBefore);
  assert.equal(fs.existsSync(path.join(resolvedPaths.leasesDir, `${lease.leaseId}.json`)), true);
});

test("locked app snapshot writer waits on the lease mutation lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: process.pid,
    startedAt: "2026-04-10T00:00:00.000Z",
  });

  assert.throws(() => {
    writeAppSnapshotArtifactUnderMutationLock(resolvedPaths, {
      leaseLockTimeoutMilliseconds: 1,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "alias-busy");

  assert.equal(fs.existsSync(resolvedPaths.appSnapshotPath), false);
});

test("locked app snapshot writer samples snapshot time after acquiring the mutation lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  enableIdlePolicyBroker(resolvedPaths, {
    actorId: "operator-idle",
    actorType: "human",
    graceSeconds: 60,
    now: "2026-01-01T00:00:00.000Z",
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-snapshot-idle",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  releaseLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    now: "2026-01-01T00:00:00.000Z",
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });

  const timestamps = [
    "2026-01-01T00:00:59.999Z",
    "2026-01-01T00:01:05.000Z",
  ];
  const snapshot = writeAppSnapshotArtifactUnderMutationLock(resolvedPaths, {
    now: () => timestamps.shift(),
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(snapshot.generatedAt, "2026-01-01T00:01:05.000Z");
  assert.equal(snapshot.idle.eligibleCount, 1);
  assert.equal(snapshot.idle.nextScheduledCleanupAt, "2026-01-01T00:01:05.000Z");
});

test("app snapshot preserves explicitly skipped leases with dead owners", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-snapshot-skip",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  const snapshot = appSnapshotBroker(resolvedPaths, {
    processExists: () => false,
    simctlAdapter: paths.simctl.adapter,
    skipLeaseIds: [lease.leaseId],
  });

  assert.equal(snapshot.activeLeases.length, 1);
  assert.equal(snapshot.activeLeases[0].leaseId, lease.leaseId);
  assert.equal(snapshot.simulators.find((simulator) => simulator.alias === lease.alias)?.activeLeaseId, lease.leaseId);
});

test("app snapshot restarts idle grace in memory for unreclaimed stale leases", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  enableIdlePolicyBroker(resolvedPaths, {
    actorId: "operator-idle",
    actorType: "human",
    graceSeconds: 60,
    now: "2026-01-01T00:00:00.000Z",
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });
  const firstLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-idle-first",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  releaseLeaseBroker(resolvedPaths, {
    leaseId: firstLease.leaseId,
    now: "2026-01-01T00:00:00.000Z",
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });
  const staleLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-idle-stale",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  const registryBefore = readJson(resolvedPaths.registryPath);

  const snapshot = appSnapshotBroker(resolvedPaths, {
    now: "2026-01-01T02:00:00.000Z",
    processExists: () => false,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(snapshot.activeLeases.length, 0);
  assert.equal(snapshot.idle.configured, true);
  assert.equal(snapshot.idle.eligibleCount, 0);
  assert.equal(snapshot.idle.nextScheduledCleanupAt, "2026-01-01T02:01:00.000Z");
  assert.equal(
    snapshot.simulators.find((simulator) => simulator.alias === staleLease.alias)?.lastLeaseReleasedAt,
    "2026-01-01T02:00:00.000Z",
  );
  assert.deepEqual(readJson(resolvedPaths.registryPath), registryBefore);
  assert.equal(fs.existsSync(path.join(resolvedPaths.leasesDir, `${staleLease.leaseId}.json`)), true);
});

test("app snapshot keeps containment-aware stale leases active without restarting idle grace", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test SIM-UI-1", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  enableIdlePolicyBroker(resolvedPaths, {
    actorId: "operator-idle",
    actorType: "human",
    graceSeconds: 60,
    now: "2026-01-01T00:00:00.000Z",
    processExists: (pid) => pid === process.pid,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });
  const firstLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-idle-first",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    processSampler: processes.sampler,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  releaseLeaseBroker(resolvedPaths, {
    leaseId: firstLease.leaseId,
    now: "2026-01-01T00:00:00.000Z",
    processExists: (pid) => pid === process.pid,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });
  const staleLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-idle-containment",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: 999999,
    processExists: () => true,
    processSampler: processes.sampler,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: staleLease.leaseId,
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });
  const registryBefore = readJson(resolvedPaths.registryPath);

  const snapshot = appSnapshotBroker(resolvedPaths, {
    now: "2026-01-01T02:00:00.000Z",
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(snapshot.activeLeases.length, 1);
  assert.equal(snapshot.activeLeases[0].leaseId, staleLease.leaseId);
  assert.equal(snapshot.idle.eligibleCount, 0);
  assert.equal(snapshot.idle.nextScheduledCleanupAt, null);
  assert.equal(
    snapshot.simulators.find((simulator) => simulator.alias === staleLease.alias)?.lastLeaseReleasedAt,
    "2026-01-01T00:00:00.000Z",
  );
  assert.deepEqual(readJson(resolvedPaths.registryPath), registryBefore);
  assert.equal(fs.existsSync(path.join(resolvedPaths.leasesDir, `${staleLease.leaseId}.json`)), true);
  assert.equal(processes.isAlive(2000), true);
  assert.deepEqual(processes.actions, []);
});

test("acquire and release reuse the most recently released warm alias", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const firstLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-1",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  releaseLeaseBroker(resolvedPaths, {
    leaseId: firstLease.leaseId,
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });

  const secondLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-2",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.equal(firstLease.alias, secondLease.alias);
  const fixture = readJson(paths.simctl.statePath);
  assert.equal(fixture.devices.find((device) => device.udid === secondLease.simulatorId).state, "Booted");
});

test("repeated build leases reuse the same warm build alias", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, {
    bootstrapConfig: true,
    hostId: "bootstrap-host",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });
  initProjectBroker(resolvedPaths, {
    projectId: "build-reuse-demo",
    projectName: "Build Reuse Demo",
    repoRoot: path.join(paths.root, "repo"),
  });
  const firstLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "build-agent-1",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-build-test",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  releaseLeaseBroker(resolvedPaths, {
    leaseId: firstLease.leaseId,
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });

  const secondLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "build-agent-2",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-build-test",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.equal(firstLease.alias, secondLease.alias);
  const fixture = readJson(paths.simctl.statePath);
  assert.equal(fixture.devices.find((device) => device.udid === secondLease.simulatorId).state, "Booted");
});

test("stale lease recovery restarts grace and reuses the reclaimed warm alias", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => false }));
  const staleLeaseArtifactPath = path.join(paths.root, "stale-lease.json");
  const staleLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    leaseFile: staleLeaseArtifactPath,
    ownerPid: 424242,
    processExists: () => false,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  assert.equal(fs.existsSync(staleLeaseArtifactPath), true);

  const freshLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "live-agent",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.equal(staleLease.alias, freshLease.alias);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${staleLease.leaseId}.json`)), false);
  assert.equal(fs.existsSync(staleLeaseArtifactPath), false);
  const events = readEventsBroker(resolvedPaths).events;
  assert.ok(events.some((event) => event.type === "lease.reclaimed" && event.leaseId === staleLease.leaseId));
});

test("acquire marks an alias repair-needed and rolls back when boot fails", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const failingAdapter = {
    ...paths.simctl.adapter,
    bootDevice() {
      throw new Error("private runtime detail");
    },
  };
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  assert.throws(() => {
    acquireLeaseBroker(resolvedPaths, {
      actorId: "agent-boot",
      actorType: "agent",
      ownerPid: process.pid,
      processExists: (pid) => pid === process.pid,
      purposeId: "agent-ui-session",
      simctlAdapter: failingAdapter,
    });
  }, (error) => error.payload?.reasonCode === "boot-on-acquire-failed" && error.exitCode === 4);

  assert.equal(fs.readdirSync(resolvedPaths.leasesDir).length, 0);
  const registry = readJson(resolvedPaths.registryPath);
  assert.equal(registry.aliases["ui-1"].health, "repair-needed");
  assert.equal(registry.aliases["ui-1"].driftReason, "boot-on-acquire-failed");
});

test("acquire reports boot failure when rollback registry persistence also fails", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const sabotagingAdapter = {
    ...paths.simctl.adapter,
    bootDevice(simulatorId) {
      paths.simctl.adapter.bootDevice(simulatorId);
      fs.rmSync(resolvedPaths.registryPath);
      fs.mkdirSync(resolvedPaths.registryPath);
    },
  };
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  assert.throws(() => {
    acquireLeaseBroker(resolvedPaths, {
      actorId: "agent-boot",
      actorType: "agent",
      ownerPid: process.pid,
      processExists: (pid) => pid === process.pid,
      purposeId: "agent-ui-session",
      simctlAdapter: sabotagingAdapter,
    });
  }, (error) =>
    error instanceof BrokerError
      && error.payload?.reasonCode === "boot-on-acquire-failed"
      && error.payload?.rollbackFailed === true);

  assert.equal(fs.readdirSync(resolvedPaths.leasesDir).length, 1);
  fs.rmSync(resolvedPaths.registryPath, { force: true, recursive: true });
});

test("state load removes leftover acquire-rollback lease files without resurrecting them", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const leftoverLeaseId = "00000000-0000-4000-8000-000000000001";
  writeJson(path.join(resolvedPaths.leasesDir, `${leftoverLeaseId}.json`), {
    actorType: "agent",
    alias: "ui-1",
    leaseId: leftoverLeaseId,
    ownerPid: process.pid,
    projectId: "demo-app",
    purposeId: "agent-ui-session",
  });
  const registry = readJson(resolvedPaths.registryPath);
  registry.aliases["ui-1"].activeLeaseId = null;
  registry.aliases["ui-1"].driftReason = "boot-on-acquire-failed";
  registry.aliases["ui-1"].health = "repair-needed";
  writeJson(resolvedPaths.registryPath, registry);

  hostStatusBroker(resolvedPaths, {
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(fs.readdirSync(resolvedPaths.leasesDir).length, 0);
  const recovered = readJson(resolvedPaths.registryPath);
  assert.equal(recovered.aliases["ui-1"].activeLeaseId, null);
  assert.equal(recovered.aliases["ui-1"].health, "repair-needed");
  assert.equal(recovered.aliases["ui-1"].driftReason, "boot-on-acquire-failed");
  assert.equal(
    readEventsBroker(resolvedPaths).events.some((event) =>
      event.type === "lease.reclaimed"
      && event.leaseId === leftoverLeaseId
      && event.payload?.reasonCode === "acquire-rollback-leftover"),
    true,
  );
});

test("state load keeps a live lease that still matches a repair-needed registry holder", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const inProgressLeaseId = "00000000-0000-4000-8000-000000000002";
  writeJson(path.join(resolvedPaths.leasesDir, `${inProgressLeaseId}.json`), {
    actorType: "agent",
    alias: "ui-1",
    leaseId: inProgressLeaseId,
    ownerPid: process.pid,
    projectId: "demo-app",
    purposeId: "agent-ui-session",
  });
  const registry = readJson(resolvedPaths.registryPath);
  registry.aliases["ui-1"].activeLeaseId = inProgressLeaseId;
  registry.aliases["ui-1"].driftReason = "boot-on-acquire-failed";
  registry.aliases["ui-1"].health = "repair-needed";
  writeJson(resolvedPaths.registryPath, registry);

  const status = hostStatusBroker(resolvedPaths, {
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(fs.existsSync(path.join(resolvedPaths.leasesDir, `${inProgressLeaseId}.json`)), true);
  assert.equal(status.simulators.find((simulator) => simulator.alias === "ui-1")?.activeLeaseId, inProgressLeaseId);
});

test("acquire samples boot-on-acquire timestamps inside the mutation lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const lockStartedAt = "2026-04-10T00:00:00.000Z";
  const acquiredAt = "2026-04-10T00:00:30.000Z";
  const timestamps = [lockStartedAt, acquiredAt];
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-boot",
    actorType: "agent",
    now: () => timestamps.shift() ?? acquiredAt,
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.equal(lease.startedAt, acquiredAt);
  const registry = readJson(resolvedPaths.registryPath);
  assert.equal(registry.aliases["ui-1"].lastBootedAt, acquiredAt);
  const bootEvent = readEventsBroker(resolvedPaths).events.find((event) => event.type === "simulator.booted");
  assert.equal(bootEvent.timestamp, acquiredAt);
});

test("acquire waits for already booted warm aliases before returning", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const fixture = readJson(paths.simctl.statePath);
  fixture.devices.find((device) => device.udid === "SIM-MANUAL-1").state = "Booted";
  writeJson(paths.simctl.statePath, fixture);
  const resolvedPaths = brokerPaths(paths);
  const waitCalls = [];
  const readinessAdapter = {
    ...paths.simctl.adapter,
    bootDevice() {
      assert.fail("warm acquisition should not boot an already booted simulator");
    },
    waitForBooted(simulatorId) {
      waitCalls.push(simulatorId);
      paths.simctl.adapter.waitForBooted(simulatorId);
    },
  };

  initBroker(resolvedPaths, runtimeOptions(paths, {
    processExists: () => true,
    simctlAdapter: readinessAdapter,
  }));
  const acquired = acquireLeaseBroker(resolvedPaths, {
    actorId: "human-warm",
    actorType: "human",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "manual-testing",
    simctlAdapter: readinessAdapter,
  });

  assert.equal(acquired.lease.alias, "manual-1");
  assert.deepEqual(waitCalls, ["SIM-MANUAL-1"]);
});

test("shutdown candidates prefer the most recently released compatible alias", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  const first = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-first",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  const second = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-second",
    actorType: "agent",
    now: "2026-01-01T00:00:01.000Z",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  releaseLeaseBroker(resolvedPaths, {
    leaseId: first.leaseId,
    now: "2026-01-01T00:00:02.000Z",
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });
  releaseLeaseBroker(resolvedPaths, {
    leaseId: second.leaseId,
    now: "2026-01-01T00:00:03.000Z",
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });
  const fixture = readJson(paths.simctl.statePath);
  fixture.devices.find((device) => device.udid === first.simulatorId).state = "Shutdown";
  fixture.devices.find((device) => device.udid === second.simulatorId).state = "Shutdown";
  writeJson(paths.simctl.statePath, fixture);

  const selected = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-third",
    actorType: "agent",
    now: "2026-01-01T00:00:04.000Z",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  assert.equal(selected.alias, second.alias);
});

test("candidate selection falls back to host order when either release timestamp is missing", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const registry = readJson(resolvedPaths.registryPath);
  registry.aliases["ui-1"].lastLeaseReleasedAt = null;
  registry.aliases["ui-2"].lastLeaseReleasedAt = "2026-01-01T00:00:00.000Z";
  writeJson(resolvedPaths.registryPath, registry);

  const selected = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-host-order",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.equal(selected.alias, "ui-1");
});

test("candidate selection stays host-ordered when any same-tier release timestamp is missing", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  const hostConfig = readJson(paths.hostConfigPath);
  hostConfig.aliases.push({
    alias: "ui-3",
    capabilities: ["interactive-resettable"],
    deviceFamily: "iPhone",
    displayName: "UI Three",
    iosVersion: "18.2",
    resetPolicy: "erase-on-acquire",
    simulatorId: "SIM-UI-3",
  });
  writeJson(paths.hostConfigPath, hostConfig);
  const fixture = readJson(paths.simctl.statePath);
  fixture.devices.push(createDeviceRecord({
    deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
    name: "UI Three",
    udid: "SIM-UI-3",
  }));
  writeJson(paths.simctl.statePath, fixture);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const registry = readJson(resolvedPaths.registryPath);
  registry.aliases["ui-1"].lastLeaseReleasedAt = "2026-01-01T00:00:01.000Z";
  registry.aliases["ui-2"].lastLeaseReleasedAt = null;
  registry.aliases["ui-3"].lastLeaseReleasedAt = "2026-01-01T00:00:02.000Z";
  writeJson(resolvedPaths.registryPath, registry);

  const selected = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-mixed-release-order",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.equal(selected.alias, "ui-1");
});

test("idle policy is absent by default, strictly bounded, and stored outside project state", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  const initial = idleStatusBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  assert.equal(initial.configured, false);
  assert.equal(initial.graceSeconds, null);
  assert.equal(fs.existsSync(resolvedPaths.idlePolicyPath), false);
  assert.throws(() => {
    enableIdlePolicyBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      graceSeconds: 59,
    });
  }, (error) => error.payload?.reasonCode === "invalid-flag");

  enableIdlePolicyBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    graceSeconds: 60,
  });
  assert.deepEqual(readJson(resolvedPaths.idlePolicyPath), {
    graceSeconds: 60,
    version: 1,
  });
  const configured = idleStatusBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  assert.equal(configured.configured, true);
  assert.equal(configured.graceSeconds, 60);
  assert.equal(appSnapshotBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true })).idle.configured, true);

  disableIdlePolicyBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
  });
  assert.equal(fs.existsSync(resolvedPaths.idlePolicyPath), false);
});

test("idle policy mutations timestamp audit events after acquiring the mutation lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const enableTimestamps = [
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:30.000Z",
  ];

  enableIdlePolicyBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    graceSeconds: 60,
    now: () => enableTimestamps.shift(),
  });

  const disableTimestamps = [
    "2026-01-01T00:01:00.000Z",
    "2026-01-01T00:01:45.000Z",
  ];
  disableIdlePolicyBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    now: () => disableTimestamps.shift(),
  });

  const events = readEventsBroker(resolvedPaths, { limit: 10 }).events;
  assert.equal(events.find((event) => event.type === "idle.policy.enabled")?.timestamp, "2026-01-01T00:00:30.000Z");
  assert.equal(events.find((event) => event.type === "idle.policy.disabled")?.timestamp, "2026-01-01T00:01:45.000Z");
});

test("app snapshot reads honor the lease mutation lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: process.pid,
    startedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.throws(() => {
    appSnapshotBrokerUnderMutationLock(resolvedPaths, runtimeOptions(paths, {
      leaseMutationLockWait: false,
      processExists: () => true,
    }));
  }, (error) => error.payload?.reasonCode === "alias-busy");
});

test("malformed idle policy JSON maps to public-safe invalid config", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.writeFileSync(resolvedPaths.idlePolicyPath, "{not-json\n");

  const snapshot = appSnapshotBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.idle.configured, false);
  assert.equal(snapshot.idle.graceSeconds, null);

  for (const operation of [
    () => idleStatusBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true })),
    () => reconcileIdleBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true })),
  ]) {
    assert.throws(operation, (error) => {
      const serialized = JSON.stringify(error.payload);
      return error.payload?.reasonCode === "invalid-config"
        && error.exitCode === 2
        && serialized.includes(paths.root) === false
        && "stack" in error.payload === false;
    });
  }
});

test("idle policy read errors stay public-safe while preserving diagnostics", (t) => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  writeJson(resolvedPaths.idlePolicyPath, {
    graceSeconds: 60,
    version: 1,
  });
  const originalReadFileSync = fs.readFileSync;
  t.after(() => {
    fs.readFileSync = originalReadFileSync;
  });
  fs.readFileSync = (filePath, ...args) => {
    if (filePath === resolvedPaths.idlePolicyPath) {
      const error = new Error(`EACCES: permission denied, open '${resolvedPaths.idlePolicyPath}'`);
      error.code = "EACCES";
      throw error;
    }
    return originalReadFileSync(filePath, ...args);
  };

  for (const operation of [
    () => idleStatusBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true })),
    () => reconcileIdleBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true })),
  ]) {
    assert.throws(operation, (error) => {
      const serialized = JSON.stringify(error.payload);
      return error.payload?.reasonCode === "internal-error"
        && error.payload?.error === "Idle policy could not be read."
        && serialized.includes(paths.root) === false
        && "stack" in error.payload === false
        && error.cause?.message.includes(resolvedPaths.idlePolicyPath);
    });
  }
});

test("idle state read errors stay public-safe across status, reconcile, and cleanup", (t) => {
  const originalReadFileSync = fs.readFileSync;
  t.after(() => {
    fs.readFileSync = originalReadFileSync;
  });

  const scenarios = [
    {
      name: "host config during status",
      prepare(paths, resolvedPaths) {
        return {
          operation: () => idleStatusBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true })),
          targetPath: resolvedPaths.hostConfigPath,
        };
      },
    },
    {
      name: "registry during status",
      prepare(paths, resolvedPaths) {
        return {
          operation: () => idleStatusBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true })),
          targetPath: resolvedPaths.registryPath,
        };
      },
    },
    {
      name: "pin during reconciliation",
      prepare(paths, resolvedPaths) {
        enableIdlePolicyBroker(resolvedPaths, {
          actorId: "operator",
          actorType: "human",
          graceSeconds: 60,
        });
        const pin = createPinBroker(resolvedPaths, runtimeOptions(paths, {
          actorId: "operator",
          actorType: "human",
          alias: "ui-1",
          processExists: () => true,
          purposeId: "agent-ui-session",
        })).pin;
        return {
          operation: () => reconcileIdleBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true })),
          targetPath: path.join(resolvedPaths.pinsDir, `${pin.pinId}.json`),
        };
      },
    },
    {
      name: "lease during cleanup preview",
      prepare(paths, resolvedPaths) {
        const lease = acquireLeaseBroker(resolvedPaths, runtimeOptions(paths, {
          actorId: "agent-cleanup-read",
          actorType: "agent",
          ownerPid: process.pid,
          processExists: (pid) => pid === process.pid,
          purposeId: "agent-ui-session",
        })).lease;
        return {
          operation: () => cleanupIdleBroker(resolvedPaths, runtimeOptions(paths, {
            processExists: (pid) => pid === process.pid,
          })),
          targetPath: path.join(resolvedPaths.leasesDir, `${lease.leaseId}.json`),
        };
      },
    },
  ];

  for (const scenario of scenarios) {
    fs.readFileSync = originalReadFileSync;
    const paths = makePaths();
    writeBaseHostConfig(paths.hostConfigPath);
    writeBaseProject(paths.projectFilePath);
    const resolvedPaths = brokerPaths(paths);
    initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
    const { operation, targetPath } = scenario.prepare(paths, resolvedPaths);
    fs.readFileSync = (filePath, ...args) => {
      if (filePath === targetPath) {
        const error = new Error(`EACCES: permission denied, open '${targetPath}'`);
        error.code = "EACCES";
        throw error;
      }
      return originalReadFileSync(filePath, ...args);
    };

    assert.throws(operation, (error) => {
      const serialized = JSON.stringify(error.payload);
      return error instanceof BrokerError
        && error.payload?.reasonCode === "internal-error"
        && error.payload?.error === "Idle broker state could not be read."
        && serialized.includes(paths.root) === false
        && "stack" in error.payload === false
        && error.cause?.message.includes(targetPath);
    }, scenario.name);
  }
});

test("missing host idle state errors stay public-safe while preserving local cause", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);

  assert.throws(() => {
    idleStatusBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  }, (error) => {
    const serialized = JSON.stringify(error.payload);
    return error instanceof BrokerError
      && error.payload?.reasonCode === "missing-host-config"
      && error.exitCode === 2
      && error.payload?.error === "Idle broker state could not be read."
      && serialized.includes(paths.root) === false
      && serialized.includes("host init") === false
      && "hostConfigPath" in error.payload === false
      && "suggestedCommand" in error.payload === false
      && error.cause?.payload?.hostConfigPath === resolvedPaths.hostConfigPath
      && error.cause?.payload?.suggestedCommand.includes(resolvedPaths.hostConfigPath);
  });
});

test("parseable invalid host idle state errors stay public-safe while preserving local cause", () => {
  const paths = makePaths();
  const resolvedPaths = brokerPaths(paths);
  const privateAlias = "private-ui-alias";
  const privateSimulatorId = "SIM-PRIVATE-ID";
  writeJson(paths.hostConfigPath, {
    aliases: [
      {
        alias: privateAlias,
        capabilities: ["interactive-resettable"],
        deviceFamily: "iPhone",
        displayName: "Private UI One",
        iosVersion: "18.2",
        simulatorId: privateSimulatorId,
      },
      {
        alias: privateAlias,
        capabilities: ["interactive-resettable"],
        deviceFamily: "iPhone",
        displayName: "Private UI Two",
        iosVersion: "18.2",
        simulatorId: "SIM-OTHER-PRIVATE-ID",
      },
    ],
    hostId: "private-host",
    version: 1,
  });
  writeJson(resolvedPaths.idlePolicyPath, {
    graceSeconds: 60,
    version: 1,
  });

  for (const operation of [
    () => idleStatusBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true })),
    () => reconcileIdleBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true })),
    () => cleanupIdleBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true })),
  ]) {
    assert.throws(operation, (error) => {
      const serialized = JSON.stringify(error.payload);
      return error instanceof BrokerError
        && error.payload?.reasonCode === "invalid-config"
        && error.exitCode === 2
        && error.payload?.error === "Idle broker state could not be read."
        && serialized.includes(privateAlias) === false
        && serialized.includes(privateSimulatorId) === false
        && serialized.includes(paths.root) === false
        && "stack" in error.payload === false
        && error.cause?.message.includes(privateAlias);
    });
  }
});

test("stale idle state lease artifact path errors stay public-safe while preserving local cause", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test SIM-UI-1", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });
  const overlappingArtifactPath = path.join(resolvedPaths.stateRoot, "overlapping-lease-artifact.json");
  const leasePath = path.join(resolvedPaths.leasesDir, `${lease.leaseId}.json`);
  const staleLease = readJson(leasePath);
  staleLease.artifactPath = overlappingArtifactPath;
  writeJson(leasePath, staleLease);

  assert.throws(() => {
    idleStatusBroker(resolvedPaths, {
      processController: processes.controller,
      processExists: (pid) => pid !== 999999,
      processSampler: processes.sampler,
      simctlAdapter: paths.simctl.adapter,
      termWaitMs: 0,
    });
  }, (error) => {
    const serialized = JSON.stringify(error.payload);
    return error instanceof BrokerError
      && error.payload?.reasonCode === "internal-error"
      && error.payload?.error === "Idle broker state could not be read."
      && serialized.includes(paths.root) === false
      && "artifactPath" in error.payload === false
      && "protectedPath" in error.payload === false
      && error.cause?.payload?.reasonCode === "invalid-lease-artifact-path"
      && error.cause?.payload?.artifactPath === overlappingArtifactPath;
  });
});

test("malformed idle policy shapes reject non-number grace durations", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  writeJson(resolvedPaths.idlePolicyPath, {
    graceSeconds: "60",
    version: 1,
  });

  assert.throws(
    () => idleStatusBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true })),
    (error) => error.payload?.reasonCode === "invalid-config"
      && error.payload?.field === "idle-policy.graceSeconds"
      && JSON.stringify(error.payload).includes(paths.root) === false,
  );
});

test("idle policy persistence errors stay public-safe while preserving diagnostics", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.mkdirSync(resolvedPaths.idlePolicyPath, { recursive: true });

  assert.throws(() => {
    enableIdlePolicyBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      graceSeconds: 60,
    });
  }, (error) => {
    const serialized = JSON.stringify(error.payload);
    return error.payload?.reasonCode === "internal-error"
      && error.payload?.error === "Idle policy could not be persisted."
      && serialized.includes(paths.root) === false
      && "stack" in error.payload === false
      && error.cause?.message.includes(resolvedPaths.idlePolicyPath);
  });
});

test("idle policy removal errors stay public-safe while preserving diagnostics", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.mkdirSync(resolvedPaths.idlePolicyPath, { recursive: true });

  assert.throws(() => {
    disableIdlePolicyBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
    });
  }, (error) => {
    const serialized = JSON.stringify(error.payload);
    return error.payload?.reasonCode === "internal-error"
      && error.payload?.error === "Idle policy could not be removed."
      && serialized.includes(paths.root) === false
      && "stack" in error.payload === false
      && error.cause?.message.includes(resolvedPaths.idlePolicyPath);
  });
});

test("stale lease recovery starts a fresh idle grace period", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  enableIdlePolicyBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    graceSeconds: 60,
  });
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: 424242,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  const recovered = reconcileIdleBroker(resolvedPaths, {
    now: "2026-01-01T01:00:00.000Z",
    processExists: () => false,
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(recovered.eligibleCount, 0);
  assert.equal(readJson(resolvedPaths.registryPath).aliases[lease.alias].lastLeaseReleasedAt, "2026-01-01T01:00:00.000Z");
  assert.equal(readJson(paths.simctl.statePath).devices.find((device) => device.udid === lease.simulatorId).state, "Booted");

  const atBoundary = reconcileIdleBroker(resolvedPaths, {
    now: "2026-01-01T01:01:00.000Z",
    processExists: () => false,
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(atBoundary.shutdownCount, 1);
  assert.equal(readJson(paths.simctl.statePath).devices.find((device) => device.udid === lease.simulatorId).state, "Shutdown");
});

test("stale lease recovery timestamps release after entering the mutation lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  enableIdlePolicyBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    graceSeconds: 60,
  });
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: 424242,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  const timestamps = [
    "2026-01-01T01:00:00.000Z",
    "2026-01-01T01:00:45.000Z",
  ];

  const recovered = reconcileIdleBroker(resolvedPaths, {
    now: () => timestamps.shift(),
    processExists: () => false,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(recovered.eligibleCount, 0);
  assert.equal(readJson(resolvedPaths.registryPath).aliases[lease.alias].lastLeaseReleasedAt, "2026-01-01T01:00:45.000Z");
});

function makeStaleLeaseForReadRecovery() {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: 424242,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  return { lease, paths, resolvedPaths };
}

test("host status stale lease recovery timestamps release after entering the mutation lock", () => {
  const { lease, paths, resolvedPaths } = makeStaleLeaseForReadRecovery();
  const timestamps = [
    "2026-01-01T01:00:00.000Z",
    "2026-01-01T01:00:45.000Z",
  ];

  hostStatusBroker(resolvedPaths, {
    now: () => timestamps.shift(),
    processExists: () => false,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(readJson(resolvedPaths.registryPath).aliases[lease.alias].lastLeaseReleasedAt, "2026-01-01T01:00:45.000Z");
});

test("doctor stale lease recovery timestamps release after entering the mutation lock", () => {
  const { lease, paths, resolvedPaths } = makeStaleLeaseForReadRecovery();
  const timestamps = [
    "2026-01-01T01:00:00.000Z",
    "2026-01-01T01:00:45.000Z",
  ];

  doctorBroker(resolvedPaths, {
    now: () => timestamps.shift(),
    processExists: () => false,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(readJson(resolvedPaths.registryPath).aliases[lease.alias].lastLeaseReleasedAt, "2026-01-01T01:00:45.000Z");
});

test("lease explain stale lease recovery timestamps release after entering the mutation lock", () => {
  const { lease, paths, resolvedPaths } = makeStaleLeaseForReadRecovery();
  const timestamps = [
    "2026-01-01T01:00:00.000Z",
    "2026-01-01T01:00:45.000Z",
  ];

  explainLeaseBroker(resolvedPaths, {
    now: () => timestamps.shift(),
    processExists: () => false,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(readJson(resolvedPaths.registryPath).aliases[lease.alias].lastLeaseReleasedAt, "2026-01-01T01:00:45.000Z");
});

test("stale containment recovery timestamps release after containment completes", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test SIM-UI-1", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  enableIdlePolicyBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    graceSeconds: 60,
  });
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });
  const timestamps = [
    "2026-01-01T01:00:00.000Z",
    "2026-01-01T01:00:05.000Z",
    "2026-01-01T01:00:30.000Z",
    "2026-01-01T01:00:45.000Z",
  ];

  const recovered = reconcileIdleBroker(resolvedPaths, {
    now: () => timestamps.shift() ?? "2026-01-01T01:00:45.000Z",
    processController: processes.controller,
    processExists: (pid) => pid !== 999999,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(recovered.eligibleCount, 0);
  assert.equal(readJson(resolvedPaths.registryPath).aliases[lease.alias].lastLeaseReleasedAt, "2026-01-01T01:00:45.000Z");
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
  const containedEvent = readEventsBroker(resolvedPaths, { type: "lease.contained" }).events.at(-1);
  assert.equal(containedEvent.leaseId, lease.leaseId);
  assert.equal(containedEvent.timestamp, "2026-01-01T01:00:45.000Z");
});

test("explicit containment timestamps release after containment completes", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test SIM-UI-1", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-contain",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });
  const timestamps = [
    "2026-01-01T01:00:00.000Z",
    "2026-01-01T01:00:30.000Z",
    "2026-01-01T01:00:45.000Z",
  ];

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    now: () => timestamps.shift() ?? "2026-01-01T01:00:45.000Z",
    processController: processes.controller,
    processExists: (pid) => pid !== 999999,
    processSampler: processes.sampler,
    reason: "manual-cleanup",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(readJson(resolvedPaths.registryPath).aliases[lease.alias].lastLeaseReleasedAt, "2026-01-01T01:00:45.000Z");
  const containedEvent = readEventsBroker(resolvedPaths, { type: "lease.contained" }).events.at(-1);
  assert.equal(containedEvent.leaseId, lease.leaseId);
  assert.equal(containedEvent.timestamp, "2026-01-01T01:00:45.000Z");
});

test("lease release timestamps release after entering the mutation lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  const timestamps = [
    "2026-01-01T01:00:00.000Z",
    "2026-01-01T01:00:45.000Z",
  ];

  releaseLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    now: () => timestamps.shift(),
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(readJson(resolvedPaths.registryPath).aliases[lease.alias].lastLeaseReleasedAt, "2026-01-01T01:00:45.000Z");
});

test("idle status timestamps summary after entering the mutation lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  enableIdlePolicyBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    graceSeconds: 60,
  });
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-boundary",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  releaseLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    now: "2026-01-01T00:00:00.000Z",
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });
  const timestamps = [
    "2026-01-01T00:00:59.999Z",
    "2026-01-01T00:01:00.000Z",
  ];

  const status = idleStatusBroker(resolvedPaths, {
    now: () => timestamps.shift(),
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(status.eligibleCount, 1);
  assert.equal(status.nextScheduledCleanupAt, "2026-01-01T00:01:00.000Z");
});

test("idle reconciliation waits for the broker mutation lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  enableIdlePolicyBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    graceSeconds: 60,
  });
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: process.pid,
    startedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.throws(() => {
    reconcileIdleBroker(resolvedPaths, {
      leaseLockTimeoutMilliseconds: 1,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "alias-busy");
});

test("idle reconciliation supports nonblocking lease mutation lock attempts", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  enableIdlePolicyBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    graceSeconds: 60,
  });
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: process.pid,
    startedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.throws(() => {
    reconcileIdleBroker(resolvedPaths, {
      leaseMutationLockWait: false,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "alias-busy");
});

test("nonblocking idle reconciliation reclaims stale lease mutation locks", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  enableIdlePolicyBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    graceSeconds: 60,
  });
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: 424242,
    startedAt: "2026-01-01T00:00:00.000Z",
  });

  const result = reconcileIdleBroker(resolvedPaths, {
    leaseMutationLockWait: false,
    processExists: () => false,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(resolvedPaths.leaseLockDir), false);
});

test("idle reconciliation honors the grace boundary and all protected simulator classes", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  enableIdlePolicyBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    graceSeconds: 60,
  });
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-boundary",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  releaseLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    now: "2026-01-01T00:00:00.000Z",
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });

  const beforeBoundary = reconcileIdleBroker(resolvedPaths, {
    now: "2026-01-01T00:00:59.999Z",
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(beforeBoundary.eligibleCount, 0);
  assert.equal(readJson(paths.simctl.statePath).devices.find((device) => device.udid === lease.simulatorId).state, "Booted");

  const atBoundary = reconcileIdleBroker(resolvedPaths, {
    now: "2026-01-01T00:01:00.000Z",
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(atBoundary.eligibleCount, 1);
  assert.equal(atBoundary.shutdownCount, 1);
  assert.equal(readJson(paths.simctl.statePath).devices.find((device) => device.udid === lease.simulatorId).state, "Shutdown");

  const active = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-active",
    actorType: "agent",
    now: "2026-01-01T00:02:00.000Z",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  const pin = createPinBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    alias: "ui-2",
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).pin;
  const fixture = readJson(paths.simctl.statePath);
  fixture.devices.find((device) => device.udid === "SIM-MANUAL-1").state = "Booted";
  fixture.devices.find((device) => device.udid === "SIM-UI-2").state = "Booted";
  fixture.devices.find((device) => device.udid === "SIM-IPAD-1").state = "Booted";
  fixture.devices.push(createDeviceRecord({
    deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
    name: "External",
    state: "Booted",
    udid: "SIM-EXTERNAL-1",
  }));
  writeJson(paths.simctl.statePath, fixture);
  const registry = readJson(resolvedPaths.registryPath);
  registry.aliases["ui-2"].lastLeaseReleasedAt = "2025-12-31T00:00:00.000Z";
  registry.aliases["ipad-1"].health = "repair-needed";
  registry.aliases["ipad-1"].driftReason = "test-unhealthy";
  registry.aliases["ipad-1"].lastLeaseReleasedAt = "2025-12-31T00:00:00.000Z";
  writeJson(resolvedPaths.registryPath, registry);

  const protectedResult = reconcileIdleBroker(resolvedPaths, {
    now: "2026-01-01T01:00:00.000Z",
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(protectedResult.eligibleCount, 0);
  assert.equal(readJson(paths.simctl.statePath).devices.find((device) => device.udid === active.simulatorId).state, "Booted");
  assert.equal(readJson(paths.simctl.statePath).devices.find((device) => device.udid === pin.alias.replace("ui-2", "SIM-UI-2")).state, "Booted");
  assert.equal(readJson(paths.simctl.statePath).devices.find((device) => device.udid === "SIM-MANUAL-1").state, "Booted");
  assert.equal(readJson(paths.simctl.statePath).devices.find((device) => device.udid === "SIM-EXTERNAL-1").state, "Booted");
});

test("confirmed idle cleanup is count-only, plan-bound, and records shutdown failures once", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const fixture = readJson(paths.simctl.statePath);
  for (const device of fixture.devices) {
    device.state = "Booted";
  }
  writeJson(paths.simctl.statePath, fixture);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  const preview = cleanupIdleBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  assert.equal(preview.eligibleCount, 3);
  assert.equal(preview.status, "changes_required");
  const result = cleanupIdleBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    apply: true,
    confirmPlanId: preview.planId,
    lifecycleAdapter: {
      shutdown({ hostAlias }) {
        if (hostAlias.alias === "ui-2") {
          throw new Error("private runtime detail");
        }
        paths.simctl.adapter.shutdownDevice(hostAlias.simulatorId);
      },
    },
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(result.eligibleCount, 3);
  assert.equal(result.shutdownCount, 2);
  assert.equal(result.failureCount, 1);
  assert.equal(result.status, "repair_needed");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("ui-2"), false);
  assert.equal(serialized.includes("SIM-UI-2"), false);
  assert.equal(serialized.includes("private runtime detail"), false);
  assert.equal(readJson(resolvedPaths.registryPath).aliases["ui-2"].driftReason, "idle-shutdown-failed");
  const cleanupEvent = readEventsBroker(resolvedPaths, { type: "idle.cleanup.applied" }).events.at(-1);
  assert.equal(cleanupEvent.payload.actorId, "operator");
  assert.equal(JSON.stringify(result).includes("operator"), false);

  assert.throws(() => {
    cleanupIdleBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      confirmPlanId: preview.planId,
      processExists: () => true,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "idle-plan-stale" && error.exitCode === 5);
});

test("confirmed idle cleanup samples operation timestamps after acquiring the lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const fixture = readJson(paths.simctl.statePath);
  for (const device of fixture.devices) {
    device.state = "Booted";
  }
  writeJson(paths.simctl.statePath, fixture);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const preview = cleanupIdleBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const sampledTimestamps = [
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:01:00.000Z",
    "2026-01-01T00:02:00.000Z",
    "2026-01-01T00:03:00.000Z",
    "2026-01-01T00:04:00.000Z",
    "2026-01-01T00:05:00.000Z",
  ];

  const result = cleanupIdleBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    apply: true,
    confirmPlanId: preview.planId,
    now: () => sampledTimestamps.shift() ?? "2026-01-01T00:01:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const registry = readJson(resolvedPaths.registryPath);
  assert.equal(result.lastCleanupResult.completedAt, "2026-01-01T00:05:00.000Z");
  assert.equal(registry.aliases["ui-1"].lastShutdownAt, "2026-01-01T00:02:00.000Z");
  assert.equal(registry.aliases["ui-2"].lastShutdownAt, "2026-01-01T00:03:00.000Z");
  assert.equal(registry.aliases["ipad-1"].lastShutdownAt, "2026-01-01T00:04:00.000Z");
  assert.equal(registry.updatedAt, "2026-01-01T00:05:00.000Z");
  const cleanupEvent = readEventsBroker(resolvedPaths, { type: "idle.cleanup.applied" }).events.at(-1);
  assert.equal(cleanupEvent.timestamp, "2026-01-01T00:05:00.000Z");
});

test("idle cleanup audit append failures do not mark shut down aliases for repair", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const fixture = readJson(paths.simctl.statePath);
  for (const device of fixture.devices) {
    device.state = "Booted";
  }
  writeJson(paths.simctl.statePath, fixture);
  const resolvedPaths = brokerPaths(paths);
  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  const preview = cleanupIdleBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.rmSync(resolvedPaths.eventsPath, { force: true });
  fs.mkdirSync(resolvedPaths.eventsPath);

  const result = cleanupIdleBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    apply: true,
    confirmPlanId: preview.planId,
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(result.eligibleCount, 3);
  assert.equal(result.shutdownCount, 3);
  assert.equal(result.failureCount, 0);
  assert.equal(result.status, "success");
  const registry = readJson(resolvedPaths.registryPath);
  assert.equal(registry.aliases["ui-1"].powerState, "shutdown");
  assert.notEqual(registry.aliases["ui-1"].driftReason, "idle-shutdown-failed");
});

test("idle cleanup registry persistence failures stay public-safe after shutdowns", (t) => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const fixture = readJson(paths.simctl.statePath);
  for (const device of fixture.devices) {
    device.state = "Booted";
  }
  writeJson(paths.simctl.statePath, fixture);
  const resolvedPaths = brokerPaths(paths);
  const originalRenameSync = fs.renameSync;

  t.after(() => {
    fs.renameSync = originalRenameSync;
  });

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const preview = cleanupIdleBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  let registryWriteCount = 0;
  fs.renameSync = (oldPath, newPath) => {
    if (path.resolve(newPath) === resolvedPaths.registryPath) {
      registryWriteCount += 1;
      if (registryWriteCount === 1) {
        throw new Error(`EACCES: permission denied, rename '${oldPath}' -> '${newPath}'`);
      }
    }
    return originalRenameSync(oldPath, newPath);
  };

  assert.throws(() => {
    cleanupIdleBroker(resolvedPaths, {
      actorId: "operator",
      actorType: "human",
      apply: true,
      confirmPlanId: preview.planId,
      processExists: () => true,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => {
    const serialized = JSON.stringify(error.payload);
    return error.payload?.reasonCode === "internal-error"
      && error.payload?.error === "Idle registry state could not be persisted."
      && error.payload?.command === "idle.cleanup"
      && error.payload?.eligibleCount === 3
      && error.payload?.shutdownCount === 3
      && error.payload?.failureCount === 0
      && error.payload?.status === "success"
      && serialized.includes(paths.root) === false
      && "stack" in error.payload === false
      && error.cause?.message.includes(resolvedPaths.registryPath);
  });

  const postFailureFixture = readJson(paths.simctl.statePath);
  assert.equal(postFailureFixture.devices.find((device) => device.udid === "SIM-UI-1").state, "Shutdown");
});

test("idle cleanup preview does not reclaim stale containment-aware leases", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test SIM-UI-1", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const preview = cleanupIdleBroker(resolvedPaths, {
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(preview.eligibleCount, 0);
  assert.equal(preview.status, "no_changes");
  assert.equal(processes.isAlive(2000), true);
  assert.deepEqual(processes.actions, []);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), true);
  assert.equal(readEventsBroker(resolvedPaths).events.some((event) => event.type === "lease.contained"), false);
});

test("idle cleanup apply does not contain stale leases excluded from the confirmed plan", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test SIM-UI-1", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const containedLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: containedLease.leaseId,
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });
  const idleLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "idle-agent",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  releaseLeaseBroker(resolvedPaths, {
    leaseId: idleLease.leaseId,
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const preview = cleanupIdleBroker(resolvedPaths, {
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });
  assert.equal(preview.eligibleCount, 1);
  assert.equal(preview.status, "changes_required");

  const result = cleanupIdleBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    apply: true,
    confirmPlanId: preview.planId,
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.shutdownCount, 1);
  assert.equal(result.status, "success");
  assert.equal(processes.isAlive(2000), true);
  assert.deepEqual(processes.actions, []);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${containedLease.leaseId}.json`)), true);
  assert.equal(readEventsBroker(resolvedPaths).events.some((event) => event.type === "lease.contained"), false);
  assert.equal(readJson(paths.simctl.statePath).devices.find((device) => device.udid === containedLease.simulatorId).state, "Booted");
  assert.equal(readJson(paths.simctl.statePath).devices.find((device) => device.udid === idleLease.simulatorId).state, "Shutdown");
});

test("idle cleanup apply does not persist snapshot-only stale-lease registry edits", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const staleLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: 424242,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  const idleLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "idle-agent",
    actorType: "agent",
    now: "2026-01-01T00:00:00.000Z",
    ownerPid: process.pid,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  releaseLeaseBroker(resolvedPaths, {
    leaseId: idleLease.leaseId,
    now: "2026-01-01T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });
  const registry = readJson(resolvedPaths.registryPath);
  registry.aliases[staleLease.alias].driftReason = "test-unhealthy";
  registry.aliases[staleLease.alias].health = "repair-needed";
  writeJson(resolvedPaths.registryPath, registry);
  const staleAliasBefore = readJson(resolvedPaths.registryPath).aliases[staleLease.alias];

  const preview = cleanupIdleBroker(resolvedPaths, {
    now: "2026-01-01T02:00:00.000Z",
    processExists: () => false,
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(preview.eligibleCount, 1);

  const result = cleanupIdleBroker(resolvedPaths, {
    actorId: "operator",
    actorType: "human",
    apply: true,
    confirmPlanId: preview.planId,
    now: "2026-01-01T02:00:00.000Z",
    processExists: () => false,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(result.shutdownCount, 1);
  const staleAliasAfter = readJson(resolvedPaths.registryPath).aliases[staleLease.alias];
  assert.equal(staleAliasAfter.activeLeaseId, staleLease.leaseId);
  assert.equal(staleAliasAfter.lastLeaseReleasedAt, staleAliasBefore.lastLeaseReleasedAt);
  assert.equal(staleAliasAfter.health, "repair-needed");
  assert.equal(fs.existsSync(path.join(resolvedPaths.leasesDir, `${staleLease.leaseId}.json`)), true);
  assert.equal(readJson(paths.simctl.statePath).devices.find((device) => device.udid === idleLease.simulatorId).state, "Shutdown");
});

test("releasing a healthy lease is not blocked by unrelated stale containment failure", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processSampler = () => ([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024, stat: "S", vszBytes: 0 },
  ]);
  const processController = {
    killPid(pid, signal) {
      if (pid === 2000 && (signal === "SIGTERM" || signal === "SIGKILL")) {
        return {
          ok: false,
          error: "operation not permitted",
          errorCode: "EPERM",
        };
      }
      return { ok: true };
    },
  };

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const staleLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    alias: "ui-1",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: staleLease.leaseId,
    processExists: () => true,
    processSampler,
    simctlAdapter: paths.simctl.adapter,
  });
  const healthyLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "live-agent",
    actorType: "agent",
    alias: "ui-2",
    ownerPid: 3000,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  const result = releaseLeaseBroker(resolvedPaths, {
    leaseId: healthyLease.leaseId,
    processController,
    processExists: (pid) => pid === 3000,
    processSampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${healthyLease.leaseId}.json`)), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${staleLease.leaseId}.json`)), true);
  const updatedStaleLease = readJson(path.join(paths.stateRoot, "leases", `${staleLease.leaseId}.json`));
  assert.equal(updatedStaleLease.runtime.lastObservation.cleanupComplete, false);
  assert.deepEqual(updatedStaleLease.runtime.lastObservation.remainingOwnedPids, [2000]);
});

test("release by lease-file skips stale cleanup for the target lease", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const leaseArtifactPath = path.join(paths.root, "target-lease.json");
  const processSampler = () => ([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024, stat: "S", vszBytes: 0 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    alias: "ui-1",
    leaseFile: leaseArtifactPath,
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: () => true,
    processSampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = releaseLeaseBroker(resolvedPaths, {
    leaseFile: leaseArtifactPath,
    processExists: () => false,
    processSampler: () => [],
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
  assert.equal(fs.existsSync(leaseArtifactPath), false);
});

test("lease monitor records owned process status without releasing below the memory ceiling", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "with-broker-lease", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "xcodebuild test SIM-UI-1", pgid: 2000, pid: 2000, ppid: 1000, rssBytes: 20 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-monitor",
    actorType: "agent",
    memoryCeilingBytes: 100 * 1024 * 1024,
    ownerPgid: 1000,
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 1000, pid: 1000 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test -only-testing:DemoTests/FastPath",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    reason: "memory-ceiling",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(result.contained, false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), true);
  const updatedLease = readJson(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`));
  assert.equal(updatedLease.runtime.lastObservation.downstreamOwnedProcessCount, 1);
  assert.equal(updatedLease.runtime.lastObservation.ownedProcessCount, 2);
  assert.equal(updatedLease.runtime.lastObservation.ownedRssBytes, 22 * 1024 * 1024);
});

test("lease containment rejects negative term waits before mutation", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-negative-wait",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.throws(() => {
    containLeaseBroker(resolvedPaths, {
      leaseId: lease.leaseId,
      processExists: (pid) => pid === process.pid,
      reason: "manual-cleanup",
      simctlAdapter: paths.simctl.adapter,
      termWaitMs: -1,
    });
  }, (error) => error instanceof BrokerError && error.payload?.reasonCode === "invalid-flag");
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), true);
});

test("memory ceiling containment captures evidence and kills only lease-owned processes", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "with-broker-lease", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "xcodebuild test SIM-UI-1", pgid: 2000, pid: 2000, ppid: 1000, rssBytes: 40 * 1024 * 1024 },
    { command: "swift-test-worker", pgid: 2000, pid: 2001, ppid: 2000, rssBytes: 10 * 1024 * 1024 },
    { command: "/tmp/Demo App Test Host App --sim SIM-UI-1", pgid: 3000, pid: 3000, ppid: 1, rssBytes: 150 * 1024 * 1024 },
    { command: "/tmp/Demo App Test Host App --sim SIM-MANUAL-1", pgid: 4000, pid: 4000, ppid: 1, rssBytes: 300 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-memory",
    actorType: "agent",
    memoryCeilingBytes: 100 * 1024 * 1024,
    ownerPgid: 1000,
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 1000, pid: 1000 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test -only-testing:DemoTests/LeakyPath",
    commandPgid: 2000,
    commandPid: 2000,
    diagnosticSampler: {
      sample: (pid) => `sample ${pid}`,
      vmmapSummary: (pid) => `vmmap ${pid}`,
    },
    leaseId: lease.leaseId,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    simulatorProcessNames: ["Demo App Test Host App"],
  });

  const result = containLeaseBroker(resolvedPaths, {
    captureDiagnostics: true,
    diagnosticSampler: {
      sample: (pid) => `sample ${pid}`,
      vmmapSummary: (pid) => `vmmap ${pid}`,
    },
    leaseId: lease.leaseId,
    processController: processes.controller,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    reason: "memory-ceiling",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(processes.isAlive(2001), false);
  assert.equal(processes.isAlive(3000), false);
  assert.equal(processes.isAlive(4000), true);
  assert.ok(fs.existsSync(path.join(result.evidenceDir, "lease.json")));
  assert.ok(fs.existsSync(path.join(result.evidenceDir, "processes-before.txt")));
  assert.ok(fs.existsSync(path.join(result.evidenceDir, "cleanup-actions.json")));
  assert.ok(fs.existsSync(path.join(result.evidenceDir, "summary.json")));
  assert.ok(fs.existsSync(path.join(result.evidenceDir, "vmmap-summary-3000.txt")));
  const summary = readJson(path.join(result.evidenceDir, "summary.json"));
  const processesBefore = fs.readFileSync(path.join(result.evidenceDir, "processes-before.txt"), "utf8");
  const processesAfter = fs.readFileSync(path.join(result.evidenceDir, "processes-after.txt"), "utf8");
  assert.equal(summary.reason, "memory-ceiling");
  assert.equal(summary.simulatorId, "SIM-UI-1");
  assert.equal(summary.commandPid, 2000);
  assert.equal(summary.commandPgid, 2000);
  assert.ok(summary.killedPids.includes(3000));
  assert.equal(summary.ownerPid, 1000);
  assert.equal(summary.ownerPgid, 1000);
  assert.equal(summary.skippedPids.some((entry) => entry.pid === 4000), false);
  assert.match(processesBefore, /SIM-UI-1/);
  assert.doesNotMatch(processesBefore, /SIM-MANUAL-1/);
  assert.doesNotMatch(processesAfter, /SIM-MANUAL-1/);
  const events = readEventsBroker(resolvedPaths).events;
  assert.ok(events.some((event) => event.type === "lease.contained" && event.leaseId === lease.leaseId));
});

test("containment evidence directory names include lease ids for same-timestamp bundles", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const evidenceRoot = path.join(paths.root, "shared-evidence");
  const timestamp = "2026-04-10T00:00:00.000Z";

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const firstLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-evidence-1",
    actorType: "agent",
    evidenceDir: evidenceRoot,
    memoryCeilingBytes: 1,
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 1000, pid: 1000 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  const firstProcesses = makeProcessFixture([
    { command: "with-broker-lease", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
  ]);
  const firstContainment = containLeaseBroker(resolvedPaths, {
    leaseId: firstLease.leaseId,
    processController: firstProcesses.controller,
    processExists: (pid) => pid === 1000,
    processSampler: firstProcesses.sampler,
    reason: "memory-ceiling",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
    timestamp,
  });
  assert.equal(firstContainment.contained, true);

  const secondLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-evidence-2",
    actorType: "agent",
    evidenceDir: evidenceRoot,
    memoryCeilingBytes: 1,
    ownerPid: 2000,
    processExists: (pid) => pid === 2000,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 2000, pid: 2000 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  const secondProcesses = makeProcessFixture([
    { command: "with-broker-lease", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
  ]);
  const secondContainment = containLeaseBroker(resolvedPaths, {
    leaseId: secondLease.leaseId,
    processController: secondProcesses.controller,
    processExists: (pid) => pid === 2000,
    processSampler: secondProcesses.sampler,
    reason: "memory-ceiling",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
    timestamp,
  });

  assert.equal(secondContainment.contained, true);
  assert.notEqual(firstContainment.evidenceDir, secondContainment.evidenceDir);
  assert.match(path.basename(firstContainment.evidenceDir), new RegExp(`${firstLease.leaseId}$`));
  assert.match(path.basename(secondContainment.evidenceDir), new RegExp(`${secondLease.leaseId}$`));
  assert.deepEqual(fs.readdirSync(evidenceRoot).sort(), [
    path.basename(firstContainment.evidenceDir),
    path.basename(secondContainment.evidenceDir),
  ].sort());
});

test("manual cleanup contains descendants of detached simulator-matched roots", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "with-broker-lease", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "xcodebuild test SIM-UI-1", pgid: 2000, pid: 2000, ppid: 1000, rssBytes: 40 * 1024 * 1024 },
    { command: "/tmp/Demo App Test Host App --sim SIM-UI-1", pgid: 3000, pid: 3000, ppid: 1, rssBytes: 150 * 1024 * 1024 },
    { command: "simulator-helper-worker", pgid: 3000, pid: 3001, ppid: 3000, rssBytes: 20 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-manual-cleanup",
    actorType: "agent",
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    simulatorProcessNames: ["Demo App Test Host App"],
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processController: processes.controller,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    reason: "manual-cleanup",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(processes.isAlive(3000), false);
  assert.equal(processes.isAlive(3001), false);
  assert.ok(result.summary.killedPids.includes(3000));
  assert.ok(result.summary.killedPids.includes(3001));
});

test("manual cleanup keeps default simulator process names when custom names are configured", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "with-broker-lease", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "xctest SIM-UI-1", pgid: 3000, pid: 3000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-cleanup",
    actorType: "agent",
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
    simulatorProcessNames: ["Custom Detached Host"],
  }).lease;

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processController: processes.controller,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    reason: "manual-cleanup",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(processes.isAlive(1000), true);
  assert.equal(processes.isAlive(3000), false);
  assert.ok(result.summary.killedPids.includes(3000));
});

test("memory ceiling ignores the active containment requester rss", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "with-broker-lease", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "node client/bin/simbroker.mjs lease contain", pgid: 1000, pid: 1500, ppid: 1000, rssBytes: 18 * 1024 * 1024 },
    { command: "xcodebuild test SIM-UI-1", pgid: 1000, pid: 2000, ppid: 1000, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-monitor",
    actorType: "agent",
    memoryCeilingBytes: 50 * 1024 * 1024,
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: (pid) => pid === 1000,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processController: processes.controller,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    reason: "memory-ceiling",
    requesterPid: 1500,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, false);
  const updatedLease = readJson(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`));
  assert.equal(updatedLease.runtime.lastObservation.ownedRssBytes, 42 * 1024 * 1024);
});

test("forced-abort avoids process-group kill when owner PGID is only inferable from the owner process", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "bash", pgid: 3000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "xcodebuild test SIM-UI-1", pgid: 3000, pid: 2000, ppid: 1000, rssBytes: 40 * 1024 * 1024 },
    { command: "swift-test-worker", pgid: 3000, pid: 2001, ppid: 2000, rssBytes: 10 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-cleanup",
    actorType: "agent",
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 3000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processController: processes.controller,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    reason: "forced-abort",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(processes.isAlive(1000), true);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(processes.isAlive(2001), false);
  assert.equal(result.cleanupActions.some((action) => action.target === "process-group"), false);
});

test("forced-abort skips the active containment requester pid", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "bash", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "node client/bin/simbroker.mjs lease contain", pgid: 1000, pid: 1500, ppid: 1000, rssBytes: 5 * 1024 * 1024 },
    { command: "xcodebuild test SIM-UI-1", pgid: 1000, pid: 2000, ppid: 1000, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-cleanup",
    actorType: "agent",
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: (pid) => pid === 1000,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processController: processes.controller,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    reason: "forced-abort",
    requesterPid: 1500,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(processes.isAlive(1500), true);
  assert.equal(processes.isAlive(2000), false);
  assert.ok(result.cleanupActions.some((action) => action.pid === 1500 && action.skipped === true && action.why === "active-containment-requester"));
});

test("forced-abort avoids command process-group termination when the requester is inside that group", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "bash", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "xcodebuild test SIM-UI-1", pgid: 2000, pid: 2000, ppid: 1000, rssBytes: 40 * 1024 * 1024 },
    { command: "node client/bin/simbroker.mjs lease contain", pgid: 2000, pid: 2500, ppid: 2000, rssBytes: 5 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-cleanup",
    actorType: "agent",
    ownerPgid: 1000,
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 1000, pid: 1000 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processController: processes.controller,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    reason: "forced-abort",
    requesterPid: 2500,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(processes.isAlive(2500), true);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(result.cleanupActions.some((action) => action.target === "process-group" && action.pgid === 2000), false);
  assert.ok(result.cleanupActions.some((action) => action.pid === 2500 && action.skipped === true && action.why === "active-containment-requester"));
});

test("forced-abort does not group-kill when the owner process group is unknown", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "-zsh", pgid: 5000, pid: 5000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "xcodebuild test SIM-UI-1", pgid: 3000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-cleanup",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 3000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    reason: "manual-cleanup",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(result.cleanupActions.some((action) => action.target === "process-group"), false);
  assert.equal(processes.isAlive(5000), true);
  assert.equal(processes.isAlive(2000), false);
});

test("forced-abort does not process-group kill when the command pgid is 1", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "bash", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "xcodebuild test SIM-UI-1", pgid: 1, pid: 2000, ppid: 1000, rssBytes: 40 * 1024 * 1024 },
    { command: "swift-test-worker", pgid: 1, pid: 2001, ppid: 2000, rssBytes: 10 * 1024 * 1024 },
    { command: "node unrelated-worker.js", pgid: 1, pid: 3000, ppid: 1, rssBytes: 12 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-cleanup",
    actorType: "agent",
    ownerPgid: 1000,
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 1000, pid: 1000 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  const leasePath = path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`);
  const seededLease = readJson(leasePath);
  seededLease.runtime = {
    ...seededLease.runtime,
    command: ["xcodebuild test"],
    commandPgid: 1,
    commandPid: 2000,
    commandRegisteredAt: seededLease.startedAt,
    ownerPgid: 1000,
    ownerPid: 1000,
    ownerRegisteredAt: seededLease.startedAt,
    updatedAt: seededLease.startedAt,
  };
  writeJson(leasePath, seededLease);

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processController: processes.controller,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    reason: "forced-abort",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(processes.isAlive(2001), false);
  assert.equal(processes.isAlive(3000), true);
  assert.equal(result.cleanupActions.some((action) => action.target === "process-group"), false);
});

test("forced-abort only claims the command process group when the command root still validates", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "bash", elapsed: "00:01", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "node unrelated-worker.js", elapsed: "00:01", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 30 * 1024 * 1024 },
    { command: "swift-test-worker", elapsed: "00:01", pgid: 2000, pid: 2001, ppid: 2000, rssBytes: 10 * 1024 * 1024 },
    { command: "/tmp/Demo App Test Host App --sim SIM-UI-1", elapsed: "00:30", pgid: 4000, pid: 4000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-cleanup",
    actorType: "agent",
    ownerPgid: 1000,
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 1000, pid: 1000 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
    simulatorProcessNames: ["Demo App Test Host App"],
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    simulatorProcessNames: ["Demo App Test Host App"],
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    now: "2026-06-18T00:30:00.000Z",
    processController: processes.controller,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    reason: "forced-abort",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(processes.isAlive(2000), true);
  assert.equal(processes.isAlive(2001), true);
  assert.equal(processes.isAlive(4000), false);
  assert.equal(result.cleanupActions.some((action) => action.target === "process-group" && action.pgid === 2000), false);
});

test("contain keeps the lease active when cleanup reports a hard failure", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const actions = [];
  const processSampler = () => ([
    { command: "bash", elapsed: "00:01", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024, stat: "S", vszBytes: 0 },
    { command: "xcodebuild test SIM-UI-1", elapsed: "00:01", pgid: 2000, pid: 2000, ppid: 1000, rssBytes: 40 * 1024 * 1024, stat: "S", vszBytes: 0 },
  ]);
  const processController = {
    killPid(pid, signal) {
      actions.push({ pid, signal, target: "pid" });
      if (pid === 2000) {
        return {
          ok: false,
          error: "operation not permitted",
          errorCode: "EPERM",
        };
      }
      return { ok: true };
    },
  };

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-cleanup",
    actorType: "agent",
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: (pid) => pid === 1000,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.throws(() => {
    containLeaseBroker(resolvedPaths, {
      leaseId: lease.leaseId,
      processController,
      processExists: (pid) => pid === 1000,
      processSampler,
      reason: "forced-abort",
      simctlAdapter: paths.simctl.adapter,
      termWaitMs: 0,
    });
  }, (error) => error.payload?.reasonCode === "containment-incomplete");

  assert.equal(actions.some((action) => action.pid === 2000 && action.signal === "SIGTERM"), true);
  assert.equal(actions.some((action) => action.pid === 2000 && action.signal === "SIGKILL"), true);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), true);
  const registry = readJson(path.join(paths.stateRoot, "registry.json"));
  assert.equal(registry.aliases[lease.alias].activeLeaseId, lease.leaseId);
  const updatedLease = readJson(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`));
  assert.equal(updatedLease.runtime.lastObservation.cleanupComplete, false);
  assert.deepEqual(updatedLease.runtime.lastObservation.remainingOwnedPids, [2000]);
  const events = readEventsBroker(resolvedPaths).events.filter((event) => event.type === "lease.contained" && event.leaseId === lease.leaseId);
  assert.equal(events.length, 0);
});

test("contain treats a defunct killed simulator-like pid as cleaned up", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const table = [
    { alive: true, command: "with-broker-lease", elapsed: "00:01", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024, stat: "S", vszBytes: 0 },
    { alive: true, command: "/tmp/Demo App Test Host App --sim SIM-UI-1", elapsed: "00:01", pgid: 3000, pid: 3000, ppid: 1, rssBytes: 150 * 1024 * 1024, stat: "S", vszBytes: 0 },
  ];
  const processController = {
    killPid(pid, signal) {
      const record = table.find((candidate) => candidate.pid === pid);
      if (record && signal === "SIGTERM") {
        record.command = "node <defunct>";
        record.rssBytes = 0;
        record.stat = "Z";
      }
      return { ok: true };
    },
  };
  const processSampler = () => table.filter((record) => record.alive).map(({ alive, ...record }) => ({ ...record }));

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-memory",
    actorType: "agent",
    memoryCeilingBytes: 100 * 1024 * 1024,
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
    simulatorProcessNames: ["Demo App Test Host App"],
  }).lease;

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processController,
    processExists: (pid) => pid === 1000,
    processSampler,
    reason: "memory-ceiling",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(result.summary.cleanupComplete, true);
  assert.deepEqual(result.summary.remainingOwnedPids, []);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("contain treats a defunct killed descendant pid as cleaned up", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const table = [
    { alive: true, command: "with-broker-lease", elapsed: "00:01", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024, stat: "S", vszBytes: 0 },
    { alive: true, command: "xcodebuild test SIM-UI-1", elapsed: "00:01", pgid: 2000, pid: 2000, ppid: 1000, rssBytes: 40 * 1024 * 1024, stat: "S", vszBytes: 0 },
  ];
  const processController = {
    killPid(pid, signal) {
      const record = table.find((candidate) => candidate.pid === pid);
      if (record && signal === "SIGTERM") {
        record.command = "xcodebuild <defunct>";
        record.rssBytes = 0;
        record.stat = "Z";
      }
      return { ok: true };
    },
  };
  const processSampler = () => table.filter((record) => record.alive).map(({ alive, ...record }) => ({ ...record }));

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-abort",
    actorType: "agent",
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: (pid) => pid === 1000,
    processSampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processController,
    processExists: (pid) => pid === 1000,
    processSampler,
    reason: "forced-abort",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(result.summary.cleanupComplete, true);
  assert.deepEqual(result.summary.remainingOwnedPids, []);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("contain does not send SIGKILL to a PID that no longer revalidates after SIGTERM", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const table = [
    { alive: true, command: "with-broker-lease", elapsed: "00:01", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024, stat: "S", vszBytes: 0 },
    { alive: true, command: "xcodebuild test SIM-UI-1", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1000, rssBytes: 40 * 1024 * 1024, stat: "S", vszBytes: 0 },
  ];
  const actions = [];
  const processController = {
    killPid(pid, signal) {
      actions.push({ pid, signal, target: "pid" });
      const record = table.find((candidate) => candidate.pid === pid && candidate.alive);
      if (record && signal === "SIGTERM") {
        record.alive = false;
        table.push({
          alive: true,
          command: "node unrelated-worker.js",
          elapsed: "00:01",
          pgid: 9000,
          pid,
          ppid: 1,
          rssBytes: 20 * 1024 * 1024,
          stat: "S",
          vszBytes: 0,
        });
      }
      return { ok: true };
    },
  };
  const processSampler = () => table.filter((record) => record.alive).map(({ alive, ...record }) => ({ ...record }));

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-memory",
    actorType: "agent",
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: (pid) => pid === 1000,
    processSampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processController,
    processExists: (pid) => pid === 1000,
    processSampler,
    reason: "manual-cleanup",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(actions.some((action) => action.pid === 2000 && action.signal === "SIGKILL"), false);
  assert.equal(table.some((record) => record.alive && record.pid === 2000 && record.command === "node unrelated-worker.js"), true);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("contain waits briefly for a SIGKILLed pid to disappear before judging cleanup", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const ownerRecord = { command: "with-broker-lease", elapsed: "00:01", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024, stat: "S", vszBytes: 0 };
  const childRecord = { command: "xcodebuild test SIM-UI-1", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1000, rssBytes: 40 * 1024 * 1024, stat: "S", vszBytes: 0 };
  let sampleCount = 0;
  const processSampler = () => {
    sampleCount += 1;
    return sampleCount <= 3
      ? [{ ...ownerRecord }, { ...childRecord }]
      : [{ ...ownerRecord }];
  };
  const actions = [];
  const processController = {
    killPid(pid, signal) {
      actions.push({ pid, signal, target: "pid" });
      return { ok: true };
    },
  };

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-delayed-kill",
    actorType: "agent",
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processController,
    processExists: (pid) => pid === 1000,
    processSampler,
    postKillPollMs: 1,
    postKillWaitMs: 10,
    reason: "forced-abort",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.summary.cleanupComplete, true);
  assert.equal(actions.some((action) => action.pid === 2000 && action.signal === "SIGKILL"), true);
  assert.deepEqual(result.summary.remainingOwnedPids, []);
  assert.ok(sampleCount >= 4);
});

test("contain validates the after-sample at the post-wait timestamp", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const table = [
    { alive: true, command: "with-broker-lease", elapsed: "00:01", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024, stat: "S", vszBytes: 0 },
    { alive: true, command: "xcodebuild test SIM-UI-1", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1000, rssBytes: 40 * 1024 * 1024, stat: "S", vszBytes: 0 },
  ];
  const actions = [];
  const processController = {
    killPid(pid, signal) {
      actions.push({ pid, signal, target: "pid" });
      const record = table.find((candidate) => candidate.pid === pid && candidate.alive);
      if (record && signal === "SIGTERM") {
        record.alive = false;
        table.push({
          alive: true,
          command: "xcodebuild helper",
          elapsed: "00:01",
          pgid: 2000,
          pid,
          ppid: 1,
          rssBytes: 20 * 1024 * 1024,
          stat: "S",
          vszBytes: 0,
        });
      }
      return { ok: true };
    },
  };
  const processSampler = () => table.filter((record) => record.alive).map(({ alive, ...record }) => ({ ...record }));

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-memory",
    actorType: "agent",
    now: "2026-06-18T00:00:00.000Z",
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: (pid) => pid === 1000,
    processSampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:16.000Z",
    processController,
    processExists: (pid) => pid === 1000,
    processSampler,
    reason: "manual-cleanup",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 1000,
  });

  assert.equal(result.contained, true);
  assert.equal(actions.some((action) => action.pid === 2000 && action.signal === "SIGKILL"), false);
  assert.equal(table.some((record) => record.alive && record.pid === 2000 && record.command === "xcodebuild helper"), true);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("contain ignores the wide ps sampler process in after samples", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const table = [
    { alive: true, command: "with-broker-lease", elapsed: "00:01", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024, stat: "S", vszBytes: 0 },
    { alive: true, command: "xcodebuild test SIM-UI-1", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1000, rssBytes: 40 * 1024 * 1024, stat: "S", vszBytes: 0 },
  ];
  const processController = {
    killPid(pid, signal) {
      const record = table.find((candidate) => candidate.pid === pid && candidate.alive);
      if (record && signal === "SIGTERM") {
        record.alive = false;
        table.push({
          alive: true,
          command: "ps -axww -o pid=,ppid=,pgid=,rss=,vsz=,etime=,stat=,command=",
          elapsed: "00:01",
          pgid: 1000,
          pid: 3000,
          ppid: 1000,
          rssBytes: 1024,
          stat: "S",
          vszBytes: 0,
        });
      }
      return { ok: true };
    },
  };
  const processSampler = () => table.filter((record) => record.alive).map(({ alive, ...record }) => ({ ...record }));

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-manual-cleanup",
    actorType: "agent",
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: (pid) => pid === 1000,
    processSampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processController,
    processExists: (pid) => pid === 1000,
    processSampler,
    reason: "manual-cleanup",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(result.summary.cleanupComplete, true);
  assert.deepEqual(result.summary.remainingOwnedPids, []);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner reclaim runs containment when process metadata exists", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test SIM-UI-1", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
  const events = readEventsBroker(resolvedPaths).events;
  assert.ok(events.some((event) => event.type === "lease.contained" && event.leaseId === lease.leaseId && event.payload.reason === "stale-owner"));
});

test("stale owner containment does not trust a reused command pid without matching identity", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "node unrelated-worker.js", pgid: 3000, pid: 2000, ppid: 1, rssBytes: 30 * 1024 * 1024 },
    { command: "/tmp/Demo App Test Host App --sim SIM-UI-1", pgid: 4000, pid: 4000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
    simulatorProcessNames: ["Demo App Test Host App"],
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2001,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: () => true,
    processSampler: () => ([
      { command: "xcodebuild test", elapsed: "00:30", pgid: 2001, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024, stat: "S", vszBytes: 0 },
    ]),
    simctlAdapter: paths.simctl.adapter,
    simulatorProcessNames: ["Demo App Test Host App"],
  });

  const status = hostStatusBroker(resolvedPaths, {
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), true);
  assert.equal(processes.isAlive(4000), false);
  const evidenceRoot = path.join(paths.stateRoot, "evidence", lease.leaseId);
  const evidenceDirs = fs.readdirSync(evidenceRoot);
  const summary = readJson(path.join(evidenceRoot, evidenceDirs[0], "summary.json"));
  assert.equal(summary.killedPids.includes(2000), false);
  assert.equal(summary.killedPids.includes(4000), true);
});

test("stale owner containment preserves a pid-only command root when command age and executable still match", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test SIM-UI-1", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment preserves an exec-wrapped command root when pid identity still matches", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: ["env", "FOO=bar", "xcodebuild", "test"],
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment preserves a structured env argv when assignment values contain spaces", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: ["env", "FOO=bar baz", "xcodebuild", "test"],
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-19T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-19T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment preserves a command root when ps reports an unescaped executable path with spaces", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    {
      command: "/Applications/Xcode 16.2.app/Contents/Developer/usr/bin/xcodebuild test",
      elapsed: "00:30",
      pgid: 2000,
      pid: 2000,
      ppid: 1,
      rssBytes: 40 * 1024 * 1024,
    },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "/Applications/Xcode\\ 16.2.app/Contents/Developer/usr/bin/xcodebuild test",
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-19T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-19T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment preserves an env -S wrapped command root when pid identity still matches", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "env -S 'xcodebuild test'",
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment preserves an env --split-string wrapped command root when pid identity still matches", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "env --split-string=xcodebuild\\ test",
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment preserves an attached env -S wrapped command root when pid identity still matches", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "env -S'xcodebuild test'",
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment skips env assignments inside split-string registrations", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "env -S 'FOO=bar xcodebuild test'",
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment preserves an env -P wrapped command root when pid identity still matches", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "env -P /usr/bin xcodebuild test",
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment preserves an exec-wrapped command root when exec options are present", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: ["exec", "-c", "-a", "runner", "xcodebuild", "test"],
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment preserves an exec-wrapped command root when exec options are combined", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "runner", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: ["exec", "-ca", "runner", "xcodebuild", "test"],
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment preserves a nested exec env wrapped command root when pid identity still matches", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: ["exec", "env", "FOO=bar", "xcodebuild", "test"],
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment preserves a shell-escaped env assignment before the command root", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "env FOO=bar\\ baz xcodebuild test",
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("manual cleanup keeps the owner alive when the owner and command pid are the same process", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "shared-owner-command",
    actorType: "agent",
    ownerPid: 2000,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    ownerPid: 2000,
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => true,
    processSampler: processes.sampler,
    reason: "manual-cleanup",
    requesterPid: 999999,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(processes.isAlive(2000), true);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("manual cleanup preserves a pid-only command root when command text and pgid were not registered", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    reason: "manual-cleanup",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment ignores a defunct registered command pid", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test <defunct>", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 0, stat: "Z" },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.actions.some((action) => action.pid === 2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment preserves a command process-group root when command text was not registered", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment keeps a live registered command process group after the command root exits", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "command-group-leader", elapsed: "00:30", pgid: 3000, pid: 3000, ppid: 1, rssBytes: 10 * 1024 * 1024 },
    { command: "swift-test-worker", elapsed: "00:30", pgid: 3000, pid: 3001, ppid: 3000, rssBytes: 10 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    now: "2026-06-18T00:00:00.000Z",
    ownerPgid: 1000,
    ownerPid: 999999,
    processExists: () => true,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 1000, pid: 999999 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 3000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    processSampler: () => ([
      { command: "xcodebuild test", elapsed: "00:30", pgid: 3000, pid: 2000, ppid: 1, rssBytes: 10 * 1024 * 1024, stat: "S", vszBytes: 0 },
    ]),
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(3000), false);
  assert.equal(processes.isAlive(3001), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment keeps a live registered command process group after the command root exits without owner pgid metadata", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "command-group-leader", elapsed: "00:30", pgid: 3000, pid: 3000, ppid: 1, rssBytes: 10 * 1024 * 1024 },
    { command: "swift-test-worker", elapsed: "00:30", pgid: 3000, pid: 3001, ppid: 3000, rssBytes: 10 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    now: "2026-06-18T00:00:00.000Z",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 3000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    processSampler: () => ([
      { command: "xcodebuild test", elapsed: "00:30", pgid: 3000, pid: 2000, ppid: 1, rssBytes: 10 * 1024 * 1024, stat: "S", vszBytes: 0 },
    ]),
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(3000), false);
  assert.equal(processes.isAlive(3001), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("manual cleanup keeps a live registered command process group when the command root is the group leader and owner pgid metadata is absent", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test", elapsed: "00:30", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
    { command: "swift-test-worker", elapsed: "00:30", pgid: 2000, pid: 2001, ppid: 1, rssBytes: 10 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "live-command-group",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    reason: "manual-cleanup",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(processes.isAlive(2000), false);
  assert.equal(processes.isAlive(2001), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment keeps a leaderless command group when an unrelated process reuses the group leader pid", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "unrelated-process", elapsed: "00:01", pgid: 4000, pid: 3000, ppid: 1, rssBytes: 5 * 1024 * 1024 },
    { command: "swift-test-worker", elapsed: "00:30", pgid: 3000, pid: 3001, ppid: 1, rssBytes: 10 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    now: "2026-06-18T00:00:00.000Z",
    ownerPgid: 1000,
    ownerPid: 999999,
    processExists: () => true,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 1000, pid: 999999 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 3000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    processSampler: () => ([
      { command: "xcodebuild test", elapsed: "00:30", pgid: 3000, pid: 2000, ppid: 1, rssBytes: 10 * 1024 * 1024, stat: "S", vszBytes: 0 },
    ]),
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(3000), true);
  assert.equal(processes.isAlive(3001), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment still rejects a reused pid-only command root when the process is too new", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild other-project SIM-OTHER-1", elapsed: "00:01", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), true);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("forced-abort does not trust a reused direct-child command pid even when the owner is still live", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "bash", elapsed: "00:30", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "node unrelated-worker.js", elapsed: "00:01", pgid: 2000, pid: 2000, ppid: 1000, rssBytes: 10 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "live-owner-reused-child",
    actorType: "agent",
    ownerPgid: 1000,
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    processSampler: liveProcessSampler({ command: "bash", pgid: 1000, pid: 1000 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    now: "2026-06-18T00:30:00.000Z",
    processController: processes.controller,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    reason: "forced-abort",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(processes.isAlive(1000), true);
  assert.equal(processes.isAlive(2000), true);
  assert.equal(result.summary.killedPids.includes(2000), false);
});

test("manual cleanup does not trust a reused owner pid as a containment root", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "node unrelated-parent.js", elapsed: "00:01", pgid: 9000, pid: 1000, ppid: 1, rssBytes: 20 * 1024 * 1024 },
    { command: "node unrelated-child.js", elapsed: "00:01", pgid: 9000, pid: 1001, ppid: 1000, rssBytes: 10 * 1024 * 1024 },
    { command: "/tmp/Demo App Test Host App --sim SIM-UI-1", elapsed: "00:30", pgid: 3000, pid: 3000, ppid: 1, rssBytes: 150 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPgid: 9000,
    ownerPid: 1000,
    processExists: () => true,
    processSampler: liveProcessSampler({ command: "bash", pgid: 9000, pid: 1000 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
    simulatorProcessNames: ["Demo App Test Host App"],
  }).lease;

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    now: "2026-06-18T00:30:00.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    reason: "manual-cleanup",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(processes.isAlive(1000), true);
  assert.equal(processes.isAlive(1001), true);
  assert.equal(processes.isAlive(3000), false);
});

test("stale owner containment does not trust a reused owner pid that still passes processExists", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "node unrelated-worker.js", elapsed: "00:01", pgid: 9000, pid: 1000, ppid: 1, rssBytes: 20 * 1024 * 1024 },
    { command: "/tmp/Demo App Test Host App --sim SIM-UI-1", elapsed: "00:30", pgid: 4000, pid: 4000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    now: "2026-06-18T00:00:00.000Z",
    ownerPgid: 1000,
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 1000, pid: 1000 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
    simulatorProcessNames: ["Demo App Test Host App"],
  }).lease;

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(1000), true);
  assert.equal(processes.isAlive(4000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale lease cleanup revalidates acquired owner pid identity", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "node unrelated-worker.js", elapsed: "00:01", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 20 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    now: "2026-06-18T00:00:00.000Z",
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:10:00.000Z",
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(1000), true);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
  assert.ok(readEventsBroker(resolvedPaths).events.some((event) => event.type === "lease.reclaimed" && event.leaseId === lease.leaseId));
});

test("stale owner containment treats a defunct owner as stale even while processExists still passes", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "bash <defunct>", elapsed: "00:20", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 0, stat: "Z" },
    { command: "/tmp/Demo App Test Host App --sim SIM-UI-1", elapsed: "00:30", pgid: 4000, pid: 4000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    now: "2026-06-18T00:00:00.000Z",
    ownerPgid: 1000,
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 1000, pid: 1000 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
    simulatorProcessNames: ["Demo App Test Host App"],
  }).lease;

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:00:20.000Z",
    processController: processes.controller,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(1000), true);
  assert.equal(processes.isAlive(4000), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment revalidates a command pid before trusting its matching process group", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "node unrelated-worker.js", elapsed: "00:01", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 30 * 1024 * 1024 },
    { command: "swift-test-worker", elapsed: "00:01", pgid: 2000, pid: 2001, ppid: 2000, rssBytes: 10 * 1024 * 1024 },
    { command: "/tmp/Demo App Test Host App --sim SIM-UI-1", elapsed: "00:30", pgid: 4000, pid: 4000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
    simulatorProcessNames: ["Demo App Test Host App"],
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    simulatorProcessNames: ["Demo App Test Host App"],
  });

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:30:00.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), true);
  assert.equal(processes.isAlive(2001), true);
  assert.equal(processes.isAlive(4000), false);
});

test("stale owner containment uses immutable command registration time for pid identity", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild reused-command SIM-OTHER-1", elapsed: "00:05", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });
  const leasePath = path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`);
  const recordedLease = readJson(leasePath);
  recordedLease.runtime.updatedAt = "2026-06-18T00:19:00.000Z";
  writeJson(leasePath, recordedLease);

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:20:00.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2000), true);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment uses owner PGID only for simulator-tied processes when command metadata was never registered", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "-zsh", pgid: 2000, pid: 5000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "node --test broker-core.test.mjs", pgid: 2000, pid: 6000, ppid: 1, rssBytes: 20 * 1024 * 1024 },
    { command: "/tmp/Demo App Test Host App --sim SIM-UI-1", pgid: 2000, pid: 2001, ppid: 1, rssBytes: 40 * 1024 * 1024 },
    { command: "xctest worker", pgid: 2000, pid: 2002, ppid: 2001, rssBytes: 10 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPgid: 2000,
    ownerPid: 999999,
    processExists: () => true,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 2000, pid: 999999 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
    simulatorProcessNames: ["Demo App Test Host App"],
  }).lease;

  const status = hostStatusBroker(resolvedPaths, {
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2001), false);
  assert.equal(processes.isAlive(2002), false);
  assert.equal(processes.isAlive(5000), true);
  assert.equal(processes.isAlive(6000), true);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
  const events = readEventsBroker(resolvedPaths).events;
  assert.ok(events.some((event) => event.type === "lease.contained" && event.leaseId === lease.leaseId && event.payload.reason === "stale-owner"));
});

test("stale owner containment includes xcodebuild UDID matches in owner PGID fallback", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "-zsh", pgid: 2000, pid: 5000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "xcodebuild test -destination id=SIM-UI-1", pgid: 2000, pid: 2001, ppid: 1, rssBytes: 40 * 1024 * 1024 },
    { command: "swift-test-worker", pgid: 2000, pid: 2002, ppid: 2001, rssBytes: 10 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPgid: 2000,
    ownerPid: 999999,
    processExists: () => true,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 2000, pid: 999999 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  const status = hostStatusBroker(resolvedPaths, {
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2001), false);
  assert.equal(processes.isAlive(2002), false);
  assert.equal(processes.isAlive(5000), true);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("forced-abort applies owner PGID fallback for simulator-tied helpers while the owner is still live", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "bash", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "xcodebuild test -destination id=SIM-UI-1", pgid: 1000, pid: 2001, ppid: 1, rssBytes: 40 * 1024 * 1024 },
    { command: "swift-test-worker", pgid: 3000, pid: 2002, ppid: 2001, rssBytes: 10 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "live-owner-owner-group-fallback",
    actorType: "agent",
    ownerPgid: 1000,
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 1000, pid: 1000 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processController: processes.controller,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    reason: "forced-abort",
    requesterPid: 1500,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(processes.isAlive(1000), true);
  assert.equal(processes.isAlive(2001), false);
  assert.equal(processes.isAlive(2002), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("forced-abort applies inferred owner PGID fallback for simulator-tied helpers while the owner is still live", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "bash", pgid: 1000, pid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "xcodebuild test -destination id=SIM-UI-1", pgid: 1000, pid: 2001, ppid: 1, rssBytes: 40 * 1024 * 1024 },
    { command: "swift-test-worker", pgid: 3000, pid: 2002, ppid: 2001, rssBytes: 10 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "live-owner-inferred-owner-group-fallback",
    actorType: "agent",
    ownerPid: 1000,
    processExists: (pid) => pid === 1000,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 1000, pid: 1000 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    processController: processes.controller,
    processExists: (pid) => pid === 1000,
    processSampler: processes.sampler,
    reason: "forced-abort",
    requesterPid: 1500,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(processes.isAlive(1000), true);
  assert.equal(processes.isAlive(2001), false);
  assert.equal(processes.isAlive(2002), false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("stale owner containment collects descendants outside the owner PGID fallback group", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "-zsh", pgid: 2000, pid: 5000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "xcodebuild test -destination id=SIM-UI-1", pgid: 2000, pid: 2001, ppid: 1, rssBytes: 40 * 1024 * 1024 },
    { command: "swift-test-worker", pgid: 3000, pid: 2002, ppid: 2001, rssBytes: 10 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "dead-agent",
    actorType: "agent",
    ownerPgid: 2000,
    ownerPid: 999999,
    processExists: () => true,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 2000, pid: 999999 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  const status = hostStatusBroker(resolvedPaths, {
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(2001), false);
  assert.equal(processes.isAlive(2002), false);
  assert.equal(processes.isAlive(5000), true);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), false);
});

test("register-process persists an updated owner pid for stale-owner checks", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "service-agent",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPid: 2000,
    leaseId: lease.leaseId,
    ownerPid: process.pid,
    processExists: () => true,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 1000, pid: process.pid }),
    simctlAdapter: paths.simctl.adapter,
  });

  const updatedLease = readJson(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`));
  assert.equal(updatedLease.ownerPid, process.pid);
  assert.equal(updatedLease.runtime.ownerPid, process.pid);
});

test("acquire rejects owner pid 1 for containment-aware leases", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  assert.throws(() => {
    acquireLeaseBroker(resolvedPaths, {
      actorId: "bad-owner",
      actorType: "agent",
      ownerPid: 1,
      processExists: () => true,
      purposeId: "agent-ui-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "invalid-flag");
});

test("acquire rejects an owner pgid that does not match the live owner pid", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  assert.throws(() => {
    acquireLeaseBroker(resolvedPaths, {
      actorId: "bad-owner-group",
      actorType: "agent",
      ownerPgid: 4000,
      ownerPid: 2000,
      processExists: () => true,
      processSampler: () => ([
        { command: "with-broker-lease", pid: 2000, pgid: 3000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
      ]),
      purposeId: "agent-ui-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "invalid-flag");
});

test("acquire rejects an owner pgid when the live owner pid cannot be sampled", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  assert.throws(() => {
    acquireLeaseBroker(resolvedPaths, {
      actorId: "service-agent",
      actorType: "agent",
      ownerPgid: 3000,
      ownerPid: 2000,
      processExists: (pid) => pid === process.pid,
      processSampler: () => [],
      purposeId: "agent-ui-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "invalid-flag");
});

test("acquire rejects an owner pgid when the sampled owner pid is defunct", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  assert.throws(() => {
    acquireLeaseBroker(resolvedPaths, {
      actorId: "bad-owner-group",
      actorType: "agent",
      ownerPgid: 3000,
      ownerPid: 2000,
      processExists: () => true,
      processSampler: () => ([
        { command: "with-broker-lease <defunct>", pid: 2000, pgid: 3000, ppid: 1, rssBytes: 0, stat: "Z" },
      ]),
      purposeId: "agent-ui-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "invalid-flag");
});

test("register-process clears a stale command pgid when replacing the command pid without --pgid", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test SIM-UI-1", elapsed: "05:00", pgid: 3000, pid: 3000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "replacement-command",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    processSampler: () => ([
      { command: "xcodebuild test", elapsed: "05:00", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024, stat: "S", vszBytes: 0 },
    ]),
    simctlAdapter: paths.simctl.adapter,
  });
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPid: 3000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:30:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const updatedLease = readJson(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`));
  assert.equal(updatedLease.runtime.commandPgid, null);

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:35:00.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(3000), false);
});

test("register-process clears stale command text when replacing the command pid without --command", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "swift-test-worker --run-ui-suite", elapsed: "05:00", pgid: 3000, pid: 3000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "replacement-command",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    processSampler: () => ([
      { command: "xcodebuild test", elapsed: "05:00", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024, stat: "S", vszBytes: 0 },
    ]),
    simctlAdapter: paths.simctl.adapter,
  });
  registerLeaseProcessBroker(resolvedPaths, {
    commandPgid: 3000,
    commandPid: 3000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:30:00.000Z",
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const updatedLease = readJson(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`));
  assert.equal(updatedLease.runtime.command, null);

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:35:00.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(3000), false);
});

test("register-process rejects pid 1 as a containment root", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "service-agent",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.throws(() => {
    registerLeaseProcessBroker(resolvedPaths, {
      command: "xcodebuild test",
      commandPgid: 1,
      commandPid: 1,
      leaseId: lease.leaseId,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "invalid-flag");
});

test("register-process rejects owner pid 1 as a containment root", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "service-agent",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.throws(() => {
    registerLeaseProcessBroker(resolvedPaths, {
      command: "xcodebuild test",
      commandPid: 2000,
      leaseId: lease.leaseId,
      ownerPid: 1,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "invalid-flag");
});

test("register-process rejects a pgid that does not match the live command pid", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "service-agent",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.throws(() => {
    registerLeaseProcessBroker(resolvedPaths, {
      command: "xcodebuild test",
      commandPgid: 4000,
      commandPid: 2000,
      leaseId: lease.leaseId,
      processExists: (pid) => pid === process.pid,
      processSampler: () => ([
        { command: "xcodebuild test", pid: 2000, pgid: 3000, ppid: process.pid, rssBytes: 40 * 1024 * 1024 },
      ]),
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "invalid-flag");
});

test("register-process rejects a pgid when the live command pid cannot be sampled", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "service-agent",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.throws(() => {
    registerLeaseProcessBroker(resolvedPaths, {
      command: "xcodebuild test",
      commandPgid: 3000,
      commandPid: 2000,
      leaseId: lease.leaseId,
      processExists: (pid) => pid === process.pid,
      processSampler: () => [],
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "invalid-flag");
});

test("register-process rejects a pgid when the sampled command pid is defunct", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "service-agent",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.throws(() => {
    registerLeaseProcessBroker(resolvedPaths, {
      command: "xcodebuild test",
      commandPgid: 3000,
      commandPid: 2000,
      leaseId: lease.leaseId,
      processExists: (pid) => pid === process.pid,
      processSampler: () => ([
        { command: "xcodebuild test <defunct>", pid: 2000, pgid: 3000, ppid: process.pid, rssBytes: 0, stat: "Z" },
      ]),
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "invalid-flag");
});

test("register-process rejects an owner pgid that does not match the live owner pid", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "service-agent",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.throws(() => {
    registerLeaseProcessBroker(resolvedPaths, {
      command: "xcodebuild test",
      commandPid: 2000,
      leaseId: lease.leaseId,
      ownerPgid: 4000,
      ownerPid: 2000,
      processExists: (pid) => pid === 2000,
      processSampler: () => ([
        { command: "with-broker-lease", pid: 2000, pgid: 3000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
      ]),
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "invalid-flag");
});

test("register-process rejects an owner pgid when the live owner pid cannot be sampled", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "service-agent",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.throws(() => {
    registerLeaseProcessBroker(resolvedPaths, {
      command: "xcodebuild test",
      commandPid: 2000,
      leaseId: lease.leaseId,
      ownerPgid: 3000,
      ownerPid: 2000,
      processExists: (pid) => pid === process.pid,
      processSampler: () => [],
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "invalid-flag");
});

test("register-process rejects an owner pgid when the sampled owner pid is defunct", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "service-agent",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.throws(() => {
    registerLeaseProcessBroker(resolvedPaths, {
      command: "xcodebuild test",
      commandPid: 2000,
      leaseId: lease.leaseId,
      ownerPgid: 3000,
      ownerPid: 2000,
      processExists: () => true,
      processSampler: () => ([
        { command: "with-broker-lease <defunct>", pid: 2000, pgid: 3000, ppid: 1, rssBytes: 0, stat: "Z" },
      ]),
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "invalid-flag");
});

test("register-process skips stale cleanup for the target lease during a handoff", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const leaseArtifactPath = path.join(paths.root, "handoff-lease.json");

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "handoff-owner",
    actorType: "agent",
    leaseFile: leaseArtifactPath,
    ownerPgid: 1000,
    ownerPid: 1000,
    processExists: () => true,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 1000, pid: 1000 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  const result = registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPid: 3000,
    leaseFile: leaseArtifactPath,
    ownerPid: 2000,
    processExists: (pid) => pid === 2000,
    processSampler: () => ([
      { command: "with-broker-lease", elapsed: "00:05", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
      { command: "xcodebuild test SIM-UI-1", elapsed: "00:05", pgid: 3000, pid: 3000, ppid: 2000, rssBytes: 40 * 1024 * 1024 },
    ]),
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(result.ok, true);
  const updatedLease = readJson(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`));
  assert.equal(updatedLease.ownerPid, 2000);
  assert.equal(updatedLease.runtime.commandPid, 3000);
  assert.equal(fs.existsSync(leaseArtifactPath), true);
});

test("register-process refreshes command registration time when the command pid changes", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test SIM-UI-1", elapsed: "05:00", pgid: 3000, pid: 3000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "replacement-command",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPid: 2000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPid: 3000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:30:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const updatedLease = readJson(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`));
  assert.equal(updatedLease.runtime.commandRegisteredAt, "2026-06-18T00:30:00.000Z");

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:35:00.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(3000), false);
});

test("register-process refreshes command registration time when a later registration reuses the same numeric pid", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test SIM-UI-1", elapsed: "05:00", pgid: 3000, pid: 3000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "reused-command-pid",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 3000,
    commandPid: 3000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 3000,
    commandPid: 3000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:30:00.000Z",
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const updatedLease = readJson(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`));
  assert.equal(updatedLease.runtime.commandRegisteredAt, "2026-06-18T00:30:00.000Z");

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:35:00.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(3000), false);
});

test("register-process clears stale command metadata when a same-pid handoff omits command and pgid", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "swift-test-worker --run-ui-suite", elapsed: "05:00", pgid: 3000, pid: 3000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "same-pid-command-handoff",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 3000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:00:00.000Z",
    processExists: () => true,
    processSampler: () => ([
      { command: "xcodebuild test", elapsed: "05:00", pgid: 2000, pid: 3000, ppid: 1, rssBytes: 40 * 1024 * 1024, stat: "S", vszBytes: 0 },
    ]),
    simctlAdapter: paths.simctl.adapter,
  });
  registerLeaseProcessBroker(resolvedPaths, {
    commandPid: 3000,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:30:00.000Z",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  const updatedLease = readJson(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`));
  assert.equal(updatedLease.runtime.command, null);
  assert.equal(updatedLease.runtime.commandPgid, null);
  assert.equal(updatedLease.runtime.commandRegisteredAt, "2026-06-18T00:30:00.000Z");

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:35:00.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 0);
  assert.equal(processes.isAlive(3000), false);
});

test("register-process validates a later owner pid against its own registration time", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "with-broker-lease", elapsed: "05:00", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "swift-test-worker", elapsed: "05:00", pgid: 3000, pid: 2001, ppid: 2000, rssBytes: 10 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "owner-handoff",
    actorType: "agent",
    ownerPid: 1000,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPid: 9999,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:30:00.000Z",
    ownerPid: 2000,
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const updatedLease = readJson(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`));
  assert.equal(updatedLease.runtime.ownerRegisteredAt, "2026-06-18T00:30:00.000Z");

  const result = containLeaseBroker(resolvedPaths, {
    leaseId: lease.leaseId,
    now: "2026-06-18T00:35:00.000Z",
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    reason: "manual-cleanup",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(processes.isAlive(2000), true);
  assert.equal(processes.isAlive(2001), false);
});

test("register-process clears a stale owner pgid when replacing the owner pid without --owner-pgid", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "with-broker-lease", elapsed: "05:00", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "swift-test-worker", elapsed: "05:00", pgid: 3000, pid: 2001, ppid: 2000, rssBytes: 10 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "owner-handoff",
    actorType: "agent",
    ownerPgid: 1000,
    ownerPid: 1000,
    processExists: () => true,
    processSampler: liveProcessSampler({ command: "with-broker-lease", pgid: 1000, pid: 1000 }),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPid: 9999,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:30:00.000Z",
    ownerPid: 2000,
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const updatedLease = readJson(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`));
  assert.equal(updatedLease.runtime.ownerPgid, null);

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:35:00.000Z",
    processController: processes.controller,
    processExists: (pid) => pid === 2000,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 1);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), true);
  assert.equal(processes.isAlive(2001), true);
});

test("register-process refreshes owner identity when a later registration reuses the same numeric owner pid", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "with-broker-lease", elapsed: "05:00", pgid: 3000, pid: 2000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    { command: "swift-test-worker", elapsed: "05:00", pgid: 3000, pid: 2001, ppid: 2000, rssBytes: 10 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "owner-reused-pid-handoff",
    actorType: "agent",
    ownerPgid: 1000,
    ownerPid: 2000,
    processExists: () => true,
    processSampler: () => ([
      { command: "with-broker-lease", pid: 2000, pgid: 1000, ppid: 1, rssBytes: 2 * 1024 * 1024 },
    ]),
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPid: 9999,
    leaseId: lease.leaseId,
    now: "2026-06-18T00:30:00.000Z",
    ownerPid: 2000,
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const updatedLease = readJson(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`));
  assert.equal(updatedLease.runtime.ownerRegisteredAt, "2026-06-18T00:30:00.000Z");
  assert.equal(updatedLease.runtime.ownerPgid, null);

  const status = hostStatusBroker(resolvedPaths, {
    now: "2026-06-18T00:35:00.000Z",
    processController: processes.controller,
    processExists: (pid) => pid === 2000,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(status.summary.leasedAliases, 1);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), true);
  assert.equal(processes.isAlive(2001), true);
});

test("explicit contain uses the requested reason even after the owner already exited", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const processes = makeProcessFixture([
    { command: "xcodebuild test SIM-UI-1", pgid: 2000, pid: 2000, ppid: 1, rssBytes: 40 * 1024 * 1024 },
  ]);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "manual-cleanup",
    actorType: "agent",
    ownerPid: 999999,
    processExists: () => true,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  registerLeaseProcessBroker(resolvedPaths, {
    command: "xcodebuild test",
    commandPgid: 2000,
    commandPid: 2000,
    leaseId: lease.leaseId,
    processExists: () => true,
    processSampler: processes.sampler,
    simctlAdapter: paths.simctl.adapter,
  });

  const result = containLeaseBroker(resolvedPaths, {
    captureDiagnostics: true,
    diagnosticSampler: {
      sample: (pid) => `sample ${pid}`,
      vmmapSummary: (pid) => `vmmap ${pid}`,
    },
    leaseId: lease.leaseId,
    processController: processes.controller,
    processExists: () => false,
    processSampler: processes.sampler,
    reason: "manual-cleanup",
    simctlAdapter: paths.simctl.adapter,
    termWaitMs: 0,
  });

  assert.equal(result.contained, true);
  assert.equal(result.reason, "manual-cleanup");
  assert.equal(result.summary.reason, "manual-cleanup");
  const events = readEventsBroker(resolvedPaths).events.filter((event) => event.type === "lease.contained" && event.leaseId === lease.leaseId);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.reason, "manual-cleanup");
});

test("contain rejects unsupported reasons", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-owner",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.throws(() => {
    containLeaseBroker(resolvedPaths, {
      leaseId: lease.leaseId,
      processExists: (pid) => pid === process.pid,
      reason: "typo",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "invalid-flag");
});

test("pins block other projects but allow the pinned project", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath, "project-a");
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const pin = createPinBroker(resolvedPaths, {
    actorId: "human-1",
    actorType: "human",
    alias: "ui-1",
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).pin;
  assert.equal(pin.alias, "ui-1");

  const otherProjectFile = path.join(paths.root, "other/.simulator-broker/project.json");
  writeBaseProject(otherProjectFile, "project-b");
  const otherPaths = resolveBrokerPaths({
    hostConfigPath: paths.hostConfigPath,
    projectFilePath: otherProjectFile,
    stateRoot: paths.stateRoot,
  });

  const explanation = explainLeaseBroker(otherPaths, {
    purposeId: "agent-ui-session",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(explanation.availableAliases.length, 1);
  assert.equal(explanation.availableAliases[0], "ui-2");

  const pinnedLease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-a",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  assert.equal(pinnedLease.alias, "ui-1");

  const clearResult = clearPinBroker(resolvedPaths, {
    alias: "ui-1",
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(clearResult.ok, true);
});

test("pin create removes the pin file when registry persistence fails", (t) => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const originalRenameSync = fs.renameSync;
  let registryWriteFailed = false;

  t.after(() => {
    fs.renameSync = originalRenameSync;
  });

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.renameSync = (oldPath, newPath) => {
    if (newPath === resolvedPaths.registryPath && !registryWriteFailed) {
      registryWriteFailed = true;
      const error = new Error("Injected registry persistence failure.");
      error.code = "EACCES";
      throw error;
    }
    return originalRenameSync(oldPath, newPath);
  };

  assert.throws(() => {
    createPinBroker(resolvedPaths, {
      actorId: "human-1",
      actorType: "human",
      alias: "ui-1",
      purposeId: "agent-ui-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, /Injected registry persistence failure/);

  assert.equal(registryWriteFailed, true);
  assert.deepEqual(fs.readdirSync(resolvedPaths.pinsDir), []);
  assert.equal(readJson(resolvedPaths.registryPath).aliases["ui-1"].pinId, null);
});

test("pin clear preserves the pin file when registry persistence fails", (t) => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const originalRenameSync = fs.renameSync;
  let registryWriteCount = 0;

  t.after(() => {
    fs.renameSync = originalRenameSync;
  });

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const pin = createPinBroker(resolvedPaths, {
    actorId: "human-1",
    actorType: "human",
    alias: "ui-1",
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).pin;
  const pinFilePath = path.join(resolvedPaths.pinsDir, `${pin.pinId}.json`);

  fs.renameSync = (oldPath, newPath) => {
    if (newPath === resolvedPaths.registryPath) {
      registryWriteCount += 1;
      if (registryWriteCount === 2) {
        const error = new Error("Injected registry persistence failure.");
        error.code = "EACCES";
        throw error;
      }
    }
    return originalRenameSync(oldPath, newPath);
  };

  assert.throws(() => {
    clearPinBroker(resolvedPaths, {
      alias: "ui-1",
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, /Injected registry persistence failure/);

  assert.equal(registryWriteCount, 2);
  assert.equal(fs.existsSync(pinFilePath), true);
  assert.equal(readJson(resolvedPaths.registryPath).aliases["ui-1"].pinId, pin.pinId);
});

test("pin clearing waits on the lease mutation lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  createPinBroker(resolvedPaths, {
    actorId: "human-1",
    actorType: "human",
    alias: "ui-1",
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  });
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: process.pid,
    startedAt: "2026-04-10T00:00:00.000Z",
  });

  assert.throws(() => {
    clearPinBroker(resolvedPaths, {
      alias: "ui-1",
      leaseLockTimeoutMilliseconds: 1,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "alias-busy");
});

test("lease containment waits on the lease mutation lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-holder",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: process.pid,
    startedAt: "2026-04-10T00:00:00.000Z",
  });

  assert.throws(() => {
    containLeaseBroker(resolvedPaths, {
      leaseId: lease.leaseId,
      leaseLockTimeoutMilliseconds: 1,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "alias-busy");
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), true);
});

test("pin creation rejects aliases that do not satisfy the target purpose", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  assert.throws(() => {
    createPinBroker(resolvedPaths, {
      actorId: "human-1",
      actorType: "human",
      alias: "manual-1",
      purposeId: "agent-ipad-session",
      simctlAdapter: paths.simctl.adapter,
    });
  }, /does not satisfy purpose/);
});

test("events and app snapshots honor a zero event limit", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-events",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(readEventsBroker(resolvedPaths, { limit: 0 }).events.length, 0);
  assert.equal(appSnapshotBroker(resolvedPaths, { eventLimit: 0 }).recentEvents.length, 0);
});

test("app snapshot reuses one process sample for active lease checks", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-snapshot-a",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  });
  acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-snapshot-b",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  });
  const liveSampler = liveProcessSampler({ command: "node broker-core.test.mjs", pid: process.pid });
  let sampleCount = 0;

  const snapshot = appSnapshotBroker(resolvedPaths, {
    processExists: (pid) => pid === process.pid,
    processSampler: () => {
      sampleCount += 1;
      return liveSampler();
    },
  });

  assert.equal(snapshot.activeLeases.length, 2);
  assert.equal(sampleCount, 1);
});

test("app snapshot reads only a bounded event tail for recent events", (t) => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const events = Array.from({ length: 120 }, (_, index) => ({
    alias: null,
    eventId: `event-${String(index).padStart(3, "0")}`,
    payload: {},
    projectId: null,
    purposeId: null,
    timestamp: new Date(Date.UTC(2026, 3, 9, 10, 0, index)).toISOString(),
    type: "test.event",
  }));
  fs.writeFileSync(resolvedPaths.eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

  const originalReadFileSync = fs.readFileSync;
  const eventsPath = path.resolve(resolvedPaths.eventsPath);
  t.after(() => {
    fs.readFileSync = originalReadFileSync;
  });
  fs.readFileSync = function readFileSyncWithoutFullEventHistory(target, ...args) {
    const targetPath = typeof target === "string" ? path.resolve(target) : null;
    if (targetPath === eventsPath) {
      throw new Error("snapshot should not read the full event history");
    }
    return originalReadFileSync.call(this, target, ...args);
  };

  const snapshot = appSnapshotBroker(resolvedPaths, { eventLimit: 3 });

  assert.deepEqual(snapshot.recentEvents.map((event) => event.eventId), [
    "event-119",
    "event-118",
    "event-117",
  ]);
});

test("bounded event tail reads preserve UTF-8 across chunk boundaries", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  let textPaddingLength = 0;
  let encodedEvent = null;
  const splitCharacter = "é";
  while (textPaddingLength < 70_000) {
    const event = {
      alias: "ui-1",
      eventId: "event-utf8-boundary",
      payload: {
        text: `${splitCharacter}${"x".repeat(textPaddingLength)}`,
      },
      projectId: "sample-project",
      purposeId: "agent-ui-session",
      timestamp: "2026-04-09T10:15:00.000Z",
      type: "test.event",
    };
    const candidate = Buffer.from(`${JSON.stringify(event)}\n`);
    const splitOffset = candidate.indexOf(Buffer.from(splitCharacter));
    if (splitOffset === candidate.length - (64 * 1024) - 1) {
      encodedEvent = candidate;
      break;
    }
    textPaddingLength += 1;
  }
  assert.ok(encodedEvent, "expected test event to place a multibyte character across the tail chunk boundary");
  fs.writeFileSync(resolvedPaths.eventsPath, encodedEvent);

  const result = readEventsBroker(resolvedPaths, { limit: 1 });

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].payload.text.startsWith(splitCharacter), true);
  assert.equal(result.events[0].payload.text.includes("\uFFFD"), false);
});

test("event reads skip interrupted partial NDJSON records without rewriting", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.appendFileSync(resolvedPaths.eventsPath, "{\"eventId\":\"partial\"");
  const interruptedContent = fs.readFileSync(resolvedPaths.eventsPath, "utf8");

  const events = readEventsBroker(resolvedPaths).events;
  const readContent = fs.readFileSync(resolvedPaths.eventsPath, "utf8");

  assert.ok(events.some((event) => event.type === "host.initialized"));
  assert.equal(readContent, interruptedContent);

  acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-events",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  });
  const repairedContent = fs.readFileSync(resolvedPaths.eventsPath, "utf8");
  assert.equal(repairedContent.includes("\"partial\""), false);
  assert.equal(repairedContent.endsWith("\n"), true);
  assert.ok(readEventsBroker(resolvedPaths).events.some((event) => event.type === "lease.acquired"));
});

test("event append repairs an interrupted tail without reading the whole NDJSON log", (t) => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.appendFileSync(resolvedPaths.eventsPath, "{\"eventId\":\"partial\"");
  const originalReadFileSync = fs.readFileSync;
  const eventsPath = path.resolve(resolvedPaths.eventsPath);
  t.after(() => {
    fs.readFileSync = originalReadFileSync;
  });

  fs.readFileSync = function readFileSyncWithoutEvents(target, ...args) {
    const targetPath = typeof target === "string" ? path.resolve(target) : null;
    if (targetPath === eventsPath) {
      throw new Error("append should not reparse the full event log");
    }
    return originalReadFileSync.call(this, target, ...args);
  };

  try {
    acquireLeaseBroker(resolvedPaths, {
      actorId: "agent-events",
      actorType: "agent",
      ownerPid: process.pid,
      processExists: (pid) => pid === process.pid,
      purposeId: "agent-ui-session",
      simctlAdapter: paths.simctl.adapter,
    });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  const repairedContent = fs.readFileSync(resolvedPaths.eventsPath, "utf8");
  assert.equal(repairedContent.includes("\"partial\""), false);
  assert.ok(readEventsBroker(resolvedPaths).events.some((event) => event.type === "lease.acquired"));
});

test("lease release succeeds when audit append fails after state mutation", (t) => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const originalAppendFileSync = fs.appendFileSync;

  t.after(() => {
    fs.appendFileSync = originalAppendFileSync;
  });

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-events",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  let failNextAuditAppend = true;
  fs.appendFileSync = function appendFileSyncWithInjectedFailure(target, ...args) {
    if (failNextAuditAppend && typeof target === "number") {
      failNextAuditAppend = false;
      throw new Error("Injected audit append failure.");
    }
    return originalAppendFileSync.call(this, target, ...args);
  };

  const release = releaseLeaseBroker(resolvedPaths, {
    actorId: "operator-1",
    actorType: "human",
    leaseId: lease.leaseId,
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(release.ok, true);
  assert.equal(fs.existsSync(path.join(resolvedPaths.leasesDir, `${lease.leaseId}.json`)), false);
  assert.equal(readEventsBroker(resolvedPaths).events.some((event) => event.type === "lease.acquired"), true);
  assert.equal(fs.readdirSync(path.join(resolvedPaths.stateRoot, "audit-append-failures")).length, 1);
});

test("lifecycle actions wait on the lease mutation lock", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  fs.mkdirSync(resolvedPaths.leaseLockDir, { recursive: true });
  writeJson(resolvedPaths.leaseLockOwnerPath, {
    pid: process.pid,
    startedAt: "2026-04-10T00:00:00.000Z",
  });

  assert.throws(() => {
    bootSimulatorBroker(resolvedPaths, {
      alias: "ui-1",
      leaseLockTimeoutMilliseconds: 1,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "alias-busy");
});

test("lease release records the requesting actor separately from the previous holder", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-holder",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  releaseLeaseBroker(resolvedPaths, {
    actorId: "operator-1",
    actorType: "human",
    leaseId: lease.leaseId,
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });

  const releaseEvent = readEventsBroker(resolvedPaths, { type: "lease.released" }).events.at(-1);
  assert.equal(releaseEvent.actorType, "human");
  assert.equal(releaseEvent.payload.actorId, "operator-1");
  assert.equal(releaseEvent.payload.previousActorId, "agent-holder");
  assert.equal(releaseEvent.payload.previousActorType, "agent");
});

test("broker-owned state files are restricted to the current user", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-private-state",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  createPinBroker(resolvedPaths, {
    actorId: "human-1",
    actorType: "human",
    alias: "ui-2",
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  });
  writeAppSnapshotArtifact(resolvedPaths);

  const statePaths = [
    resolvedPaths.stateRoot,
    resolvedPaths.leasesDir,
    resolvedPaths.locksDir,
    resolvedPaths.pinsDir,
    resolvedPaths.registryPath,
    path.join(resolvedPaths.leasesDir, `${lease.leaseId}.json`),
    resolvedPaths.eventsPath,
    resolvedPaths.appSnapshotPath,
    ...fs.readdirSync(resolvedPaths.pinsDir).map((entry) => path.join(resolvedPaths.pinsDir, entry)),
  ];

  for (const statePath of statePaths) {
    const mode = fs.statSync(statePath).mode & 0o777;
    assert.equal(mode & 0o077, 0, `${statePath} mode ${mode.toString(8)} should not grant group/other access`);
  }
});

test("requires can target iPad aliases by family and exact ios version", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-ipad",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ipad-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  assert.equal(lease.alias, "ipad-1");
});

test("boot and shutdown update lifecycle state and emit auditable events", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const bootResult = bootSimulatorBroker(resolvedPaths, {
    alias: "ui-1",
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(bootResult.simulator.powerState, "booted");
  assert.ok(bootResult.simulator.lastBootedAt);

  const shutdownResult = shutdownSimulatorBroker(resolvedPaths, {
    alias: "ui-1",
    simctlAdapter: paths.simctl.adapter,
  });
  assert.equal(shutdownResult.simulator.powerState, "shutdown");
  assert.ok(shutdownResult.simulator.lastShutdownAt);

  const events = readEventsBroker(resolvedPaths).events;
  assert.ok(events.some((event) => event.type === "simulator.booted" && event.alias === "ui-1"));
  assert.ok(events.some((event) => event.type === "simulator.shutdown" && event.alias === "ui-1"));
});

test("shutdown is denied when another active actor holds the alias", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-owner",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.throws(() => {
    shutdownSimulatorBroker(resolvedPaths, {
      actorId: "agent-other",
      actorType: "agent",
      alias: lease.alias,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "lease-conflict");
});

test("shutdown requires an active lease reference even when actor metadata matches the holder", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-owner",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.throws(() => {
    shutdownSimulatorBroker(resolvedPaths, {
      actorId: lease.actorId,
      actorType: lease.actorType,
      alias: lease.alias,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "lease-conflict");
});

test("repair can force-override a conflicting lease and clear repair-needed state", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const leaseFilePath = path.join(paths.stateRoot, "leases");

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-owner",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;
  const registry = readJson(path.join(paths.stateRoot, "registry.json"));
  registry.aliases[lease.alias].health = "repair-needed";
  registry.aliases[lease.alias].driftReason = "simulator-missing";
  writeJson(path.join(paths.stateRoot, "registry.json"), registry);

  assert.throws(() => {
    repairSimulatorBroker(resolvedPaths, {
      actorId: "agent-repair",
      actorType: "agent",
      alias: lease.alias,
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined && error.payload?.reasonCode === "human-override-required");

  const repaired = repairSimulatorBroker(resolvedPaths, {
    actorId: "human-operator",
    actorType: "human",
    alias: lease.alias,
    expectedAlias: lease.alias,
    expectedLeaseId: lease.leaseId,
    forceOverride: true,
    lifecycleAdapter: {
      repair(context) {
        assert.equal(context.alias, lease.alias);
      },
    },
    overrideReason: "simulator became unhealthy",
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(repaired.revokedLease.leaseId, lease.leaseId);
  assert.equal(repaired.simulator.health, "healthy");
  assert.equal(repaired.simulator.powerState, "shutdown");
  assert.ok(repaired.simulator.lastRepairedAt);
  assert.equal(fs.existsSync(path.join(leaseFilePath, `${lease.leaseId}.json`)), false);

  const events = readEventsBroker(resolvedPaths).events;
  assert.ok(events.some((event) => event.type === "lease.revoked" && event.leaseId === lease.leaseId));
  assert.ok(events.some((event) => event.type === "simulator.repair.started" && event.alias === lease.alias));
  assert.ok(events.some((event) => event.type === "simulator.repaired" && event.alias === lease.alias));
});

test("repair rebinds a missing simulator through the default simctl adapter", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));

  const fixtureState = readJson(paths.simctl.statePath);
  fixtureState.devices = fixtureState.devices.filter((device) => device.udid !== "SIM-UI-1");
  writeJson(paths.simctl.statePath, fixtureState);

  const beforeRepair = hostStatusBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const brokenAlias = beforeRepair.simulators.find((simulator) => simulator.alias === "ui-1");
  assert.equal(brokenAlias.health, "repair-needed");

  const repaired = repairSimulatorBroker(resolvedPaths, {
    actorId: "human-operator",
    actorType: "human",
    alias: "ui-1",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(repaired.simulator.health, "healthy");
  assert.equal(repaired.simulator.powerState, "shutdown");
  assert.notEqual(repaired.simulator.simulatorId, "SIM-UI-1");

  const hostConfig = readJson(paths.hostConfigPath);
  assert.equal(hostConfig.aliases.find((alias) => alias.alias === "ui-1")?.simulatorId, repaired.simulator.simulatorId);

  const updatedFixtureState = readJson(paths.simctl.statePath);
  assert.ok(updatedFixtureState.devices.some((device) => device.udid === repaired.simulator.simulatorId));
});

test("repair creates a replacement before deleting a drifted simulator", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  const operations = [];
  const baseAdapter = paths.simctl.adapter;
  const adapter = {
    ...baseAdapter,
    createDevice(name, deviceTypeId, runtimeId) {
      operations.push({
        action: "create",
        oldStillPresent: readJson(paths.simctl.statePath).devices.some((device) => device.udid === "SIM-UI-1"),
      });
      return baseAdapter.createDevice(name, deviceTypeId, runtimeId);
    },
    deleteDevice(simulatorId) {
      operations.push({
        action: "delete",
        simulatorId,
      });
      return baseAdapter.deleteDevice(simulatorId);
    },
    shutdownDevice(simulatorId) {
      operations.push({
        action: "shutdown",
        simulatorId,
      });
      return baseAdapter.shutdownDevice(simulatorId);
    },
  };

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  driftUiOneDeviceFamily(paths);

  const repaired = repairSimulatorBroker(resolvedPaths, {
    actorId: "human-operator",
    actorType: "human",
    alias: "ui-1",
    processExists: () => true,
    simctlAdapter: adapter,
  });

  assert.equal(repaired.simulator.health, "healthy");
  assert.equal(operations.find((operation) => operation.action === "create")?.oldStillPresent, true);
  assert.ok(operations.findIndex((operation) => operation.action === "create")
    < operations.findIndex((operation) => operation.action === "delete" && operation.simulatorId === "SIM-UI-1"));
  assert.equal(readJson(paths.simctl.statePath).devices.some((device) => device.udid === "SIM-UI-1"), false);
});

test("repair preserves failed simulator retirements for retry", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  driftUiOneDeviceFamily(paths);

  const failingAdapter = {
    ...paths.simctl.adapter,
    deleteDevice(simulatorId) {
      if (simulatorId === "SIM-UI-1") {
        throw new Error("temporary repair delete failure");
      }
      return paths.simctl.adapter.deleteDevice(simulatorId);
    },
  };
  const repaired = repairSimulatorBroker(resolvedPaths, {
    actorId: "human-operator",
    actorType: "human",
    alias: "ui-1",
    processExists: () => true,
    simctlAdapter: failingAdapter,
  });

  assert.equal(repaired.simulator.health, "healthy");
  assert.deepEqual(readJson(paths.hostConfigPath).pendingRetirements, ["SIM-UI-1"]);
  assert.equal(readJson(paths.simctl.statePath).devices.some((device) => device.udid === "SIM-UI-1"), true);

  repairSimulatorBroker(resolvedPaths, {
    actorId: "human-operator",
    actorType: "human",
    alias: "ui-1",
    processExists: () => true,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(readJson(paths.hostConfigPath).pendingRetirements, undefined);
  assert.equal(readJson(paths.simctl.statePath).devices.some((device) => device.udid === "SIM-UI-1"), false);
});

test("repair persists pending simulator retirement before inventory failures", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  driftUiOneDeviceFamily(paths);

  let listDevicesCalls = 0;
  const failingInventoryAdapter = {
    ...paths.simctl.adapter,
    listDevices() {
      listDevicesCalls += 1;
      if (listDevicesCalls > 2) {
        throw new Error("temporary repair inventory failure");
      }
      return paths.simctl.adapter.listDevices();
    },
  };

  let thrownError = null;
  try {
    repairSimulatorBroker(resolvedPaths, {
      actorId: "human-operator",
      actorType: "human",
      alias: "ui-1",
      processExists: () => true,
      simctlAdapter: failingInventoryAdapter,
    });
  } catch (error) {
    thrownError = error;
  }
  assert.ok(thrownError);
  assert.match(thrownError.payload.cause, /temporary repair inventory failure/);

  assert.deepEqual(readJson(paths.hostConfigPath).pendingRetirements, ["SIM-UI-1"]);
  assert.notEqual(readJson(paths.hostConfigPath).aliases.find((alias) => alias.alias === "ui-1").simulatorId, "SIM-UI-1");
});

test("repair rolls back a created replacement when host config commit fails before rename", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  driftUiOneDeviceFamily(paths);

  assert.throws(() => {
    repairSimulatorBroker(resolvedPaths, {
      actorId: "human-operator",
      actorType: "human",
      alias: "ui-1",
      processExists: () => true,
      repairCommitFailureStage: "before-rename",
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.payload?.reasonCode === "simulator-action-failed");

  const hostConfig = readJson(paths.hostConfigPath);
  const fixtureState = readJson(paths.simctl.statePath);
  assert.equal(hostConfig.aliases.find((alias) => alias.alias === "ui-1")?.simulatorId, "SIM-UI-1");
  assert.equal(fixtureState.devices.some((device) => device.udid === "SIM-UI-1"), true);
  assert.equal(fixtureState.devices.some((device) => device.name === "SimulatorBroker test-host ui-1"), false);
});

test("erase is allowed for the current holder and records the reset timestamp", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-owner",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  const erased = eraseSimulatorBroker(resolvedPaths, {
    alias: lease.alias,
    leaseId: lease.leaseId,
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
  });

  assert.equal(erased.simulator.lastErasedAt !== null, true);
  assert.equal(erased.simulator.powerState, "shutdown");
  assert.equal(erased.simulator.activeLeaseSummary.leaseId, lease.leaseId);
});

test("erase cannot force-override another live lease holder", () => {
  const paths = makePaths();
  writeBaseHostConfig(paths.hostConfigPath);
  writeBaseProject(paths.projectFilePath);
  const resolvedPaths = brokerPaths(paths);
  let eraseCalled = false;

  initBroker(resolvedPaths, runtimeOptions(paths, { processExists: () => true }));
  const lease = acquireLeaseBroker(resolvedPaths, {
    actorId: "agent-owner",
    actorType: "agent",
    ownerPid: process.pid,
    processExists: (pid) => pid === process.pid,
    purposeId: "agent-ui-session",
    simctlAdapter: paths.simctl.adapter,
  }).lease;

  assert.throws(() => {
    eraseSimulatorBroker(resolvedPaths, {
      actorId: "human-operator",
      actorType: "human",
      alias: lease.alias,
      expectedAlias: lease.alias,
      expectedLeaseId: lease.leaseId,
      forceOverride: true,
      lifecycleAdapter: {
        erase() {
          eraseCalled = true;
        },
      },
      overrideReason: "operator requested reset",
      processExists: (pid) => pid === process.pid,
      simctlAdapter: paths.simctl.adapter,
    });
  }, (error) => error.reasonCode === undefined
    && error.payload?.reasonCode === "lease-conflict"
    && error.exitCode === 3);

  assert.equal(eraseCalled, false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, "leases", `${lease.leaseId}.json`)), true);
});
