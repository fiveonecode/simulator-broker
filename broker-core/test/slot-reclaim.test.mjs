import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acquireLeaseBroker,
  doctorBroker,
  hostStatusBroker,
  initBroker,
  initProjectBroker,
  readEventsBroker,
  reconcileIdleBroker,
  releaseLeaseBroker,
  resolveBrokerPaths,
  validateHostConfig,
} from "../index.mjs";
import {
  DEFAULT_SLOT_RECLAIM_MAX_DISK_BYTES,
  DEFAULT_SLOT_RECLAIM_POLICY,
  classifyReclaimSlot,
  evaluateSlotReclaim,
  formatSlotReclaimPolicyLine,
  isSlotHeldForReclaim,
  lastUsedAtForSlot,
  resolveSlotReclaimPolicy,
} from "../slot-reclaim.mjs";
import { createDeviceRecord, createSimctlFixture } from "./support/simctl-fixture.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-slot-reclaim-"));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeBuildFixture(slotReclaim) {
  const root = makeTempDir();
  const hostConfigPath = path.join(root, "host-config.json");
  const stateRoot = path.join(root, "state");
  const projectFilePath = path.join(root, "repo/.simulator-broker/project.json");
  const simctl = createSimctlFixture(root, {
    devices: [
      createDeviceRecord({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        diskBytes: 0,
        name: "Build One",
        udid: "SIM-BUILD-1",
      }),
      createDeviceRecord({
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        diskBytes: 0,
        name: "Manual One",
        udid: "SIM-MANUAL-1",
      }),
    ],
  });
  writeJson(hostConfigPath, {
    version: 1,
    hostId: "reclaim-host",
    aliases: [
      {
        alias: "build-1",
        capabilities: ["build-fast"],
        deviceFamily: "iPhone",
        displayName: "Build iPhone",
        iosVersion: "18.2",
        resetPolicy: "none",
        simulatorId: "SIM-BUILD-1",
      },
      {
        alias: "manual-1",
        capabilities: ["manual-persistent"],
        deviceFamily: "iPhone",
        displayName: "Manual iPhone",
        iosVersion: "18.2",
        resetPolicy: "none",
        simulatorId: "SIM-MANUAL-1",
      },
    ],
    ...(slotReclaim === undefined ? {} : { slotReclaim }),
  });
  writeJson(projectFilePath, {
    version: 1,
    projectId: "reclaim-demo",
    projectName: "Reclaim Demo",
    purposes: [
      {
        id: "agent-build-test",
        displayName: "Agent Build Test",
        capability: "build-fast",
        defaultActorType: "agent",
      },
      {
        id: "manual-testing",
        displayName: "Manual Testing",
        capability: "manual-persistent",
        defaultActorType: "human",
      },
    ],
  });
  return {
    hostConfigPath,
    projectFilePath,
    resolvedPaths: resolveBrokerPaths({
      hostConfigPath,
      projectFilePath,
      stateRoot,
    }),
    root,
    simctl,
    stateRoot,
  };
}

function runtimeOptions(paths, overrides = {}) {
  return {
    processExists: (pid) => pid === process.pid,
    simctlAdapter: paths.simctl.adapter,
    ...overrides,
  };
}

function acquireBuildLease(paths, now, overrides = {}) {
  return acquireLeaseBroker(paths.resolvedPaths, runtimeOptions(paths, {
    actorId: "agent-build",
    actorType: "agent",
    now,
    ownerPid: process.pid,
    purposeId: "agent-build-test",
    ...overrides,
  })).lease;
}

function releaseLease(paths, lease, now) {
  return releaseLeaseBroker(paths.resolvedPaths, runtimeOptions(paths, {
    leaseId: lease.leaseId,
    now,
  }));
}

function setDeviceDiskBytes(paths, simulatorId, diskBytes) {
  const fixture = readJson(paths.simctl.statePath);
  fixture.devices.find((device) => device.udid === simulatorId).diskBytes = diskBytes;
  writeJson(paths.simctl.statePath, fixture);
}

test("slot reclaim policy defaults keep build on and manual off", () => {
  const policy = resolveSlotReclaimPolicy(null);
  assert.equal(policy.enabled, true);
  assert.equal(policy.build.enabled, true);
  assert.equal(policy.manual.enabled, false);
  assert.equal(policy.build.maxDiskBytes, DEFAULT_SLOT_RECLAIM_MAX_DISK_BYTES);
  assert.equal(policy.build.maxLeasesSinceErase, 8);
  assert.equal(policy.build.maxAgeSeconds, 86_400);
  assert.match(formatSlotReclaimPolicyLine(policy), /build on/);
  assert.match(formatSlotReclaimPolicyLine(policy), /manual off/);
});

test("slot reclaim classification skips erase-on-acquire and prefers manual", () => {
  assert.equal(classifyReclaimSlot({
    capabilities: ["build-fast"],
    resetPolicy: "erase-on-acquire",
  }), null);
  assert.equal(classifyReclaimSlot({
    capabilities: ["interactive-resettable"],
    resetPolicy: "erase-on-acquire",
  }), null);
  assert.equal(classifyReclaimSlot({
    capabilities: ["build-fast"],
    resetPolicy: "none",
  }), "build");
  assert.equal(classifyReclaimSlot({
    capabilities: ["manual-persistent", "build-fast"],
    resetPolicy: "none",
  }), "manual");
});

test("held slots are never selected for reclaim", () => {
  const policy = DEFAULT_SLOT_RECLAIM_POLICY;
  const nowMs = Date.parse("2026-10-21T00:00:00.000Z");
  assert.equal(isSlotHeldForReclaim({ activeLease: { leaseId: "live" } }), true);
  assert.equal(isSlotHeldForReclaim({ activePin: { pinId: "pin" } }), true);
  assert.equal(isSlotHeldForReclaim({ acquiring: true }), true);
  assert.equal(isSlotHeldForReclaim({ registryEntry: { activeLeaseId: "live" } }), true);
  assert.equal(isSlotHeldForReclaim({}), false);
  assert.deepEqual(evaluateSlotReclaim({
    className: "build",
    diskBytes: DEFAULT_SLOT_RECLAIM_MAX_DISK_BYTES,
    held: true,
    leasesSinceErase: 99,
    nowMs,
    policy,
  }), { reclaim: false, skipReason: "held" });
});

test("disk, lease, and age thresholds each trigger reclaim", () => {
  const policy = resolveSlotReclaimPolicy({
    build: {
      maxAgeSeconds: 3_600,
      maxDiskBytes: 100,
      maxLeasesSinceErase: 2,
    },
  });
  const nowMs = Date.parse("2026-10-21T02:00:00.000Z");
  assert.equal(evaluateSlotReclaim({
    className: "build",
    diskBytes: 100,
    lastErasedAt: "2026-10-21T01:30:00.000Z",
    leasesSinceErase: 0,
    nowMs,
    policy,
  }).reason, "disk");
  assert.equal(evaluateSlotReclaim({
    className: "build",
    diskBytes: 10,
    lastErasedAt: "2026-10-21T01:30:00.000Z",
    leasesSinceErase: 2,
    nowMs,
    policy,
  }).reason, "leases");
  assert.equal(evaluateSlotReclaim({
    className: "build",
    diskBytes: 10,
    lastErasedAt: "2026-10-21T00:00:00.000Z",
    leasesSinceErase: 0,
    nowMs,
    policy,
  }).reason, "age");
  assert.equal(evaluateSlotReclaim({
    className: "build",
    diskBytes: 10,
    lastUsedAt: "2026-10-21T00:00:00.000Z",
    leasesSinceErase: 0,
    nowMs,
    policy,
  }).reason, "age");
  assert.equal(evaluateSlotReclaim({
    className: "build",
    diskBytes: 10,
    leasesSinceErase: 0,
    nowMs,
    policy,
  }).skipReason, "below-threshold");
});

test("manual class stays disabled unless opted in", () => {
  const nowMs = Date.parse("2026-10-21T02:00:00.000Z");
  assert.equal(evaluateSlotReclaim({
    className: "manual",
    diskBytes: DEFAULT_SLOT_RECLAIM_MAX_DISK_BYTES,
    lastUsedAt: "2026-10-20T00:00:00.000Z",
    leasesSinceErase: 99,
    nowMs,
    policy: DEFAULT_SLOT_RECLAIM_POLICY,
  }).skipReason, "class-disabled");
  assert.equal(evaluateSlotReclaim({
    className: "manual",
    diskBytes: DEFAULT_SLOT_RECLAIM_MAX_DISK_BYTES,
    nowMs,
    policy: resolveSlotReclaimPolicy({ manual: { enabled: true } }),
  }).reason, "disk");
  assert.equal(evaluateSlotReclaim({
    className: "build",
    diskBytes: DEFAULT_SLOT_RECLAIM_MAX_DISK_BYTES,
    nowMs,
    policy: resolveSlotReclaimPolicy({ enabled: false }),
  }).skipReason, "disabled");
  assert.equal(lastUsedAtForSlot({
    lastBootedAt: "2026-10-20T00:00:00.000Z",
    lastLeaseReleasedAt: "2026-10-21T00:00:00.000Z",
  }), "2026-10-21T00:00:00.000Z");
});

test("host config validation accepts, defaults, and rejects slotReclaim", () => {
  const base = {
    version: 1,
    hostId: "reclaim-host",
    aliases: [
      {
        alias: "build-1",
        capabilities: ["build-fast"],
        deviceFamily: "iPhone",
        displayName: "Build",
        iosVersion: "18.2",
        simulatorId: "SIM-BUILD-1",
      },
    ],
  };
  const omitted = validateHostConfig(base);
  assert.equal("slotReclaim" in omitted, false);

  const parsed = validateHostConfig({
    ...base,
    slotReclaim: {
      build: { maxLeasesSinceErase: 3 },
      manual: { enabled: true },
    },
  });
  assert.equal(parsed.slotReclaim.enabled, true);
  assert.equal(parsed.slotReclaim.build.maxLeasesSinceErase, 3);
  assert.equal(parsed.slotReclaim.build.enabled, true);
  assert.equal(parsed.slotReclaim.manual.enabled, true);

  assert.throws(() => validateHostConfig({
    ...base,
    slotReclaim: { unexpected: true },
  }), (error) => error.payload?.field === "host-config.slotReclaim");
  assert.throws(() => validateHostConfig({
    ...base,
    slotReclaim: { build: { maxDiskBytes: 0 } },
  }), (error) => error.payload?.field === "host-config.slotReclaim.build.maxDiskBytes");
  assert.throws(() => validateHostConfig({
    ...base,
    slotReclaim: { enabled: "yes" },
  }), (error) => error.payload?.field === "host-config.slotReclaim.enabled");
});

test("held build slots are not erased even when over the disk cap", () => {
  const paths = makeBuildFixture();
  initBroker(paths.resolvedPaths, runtimeOptions(paths));
  initProjectBroker(paths.resolvedPaths, {
    overwrite: true,
    projectId: "reclaim-demo",
    projectName: "Reclaim Demo",
    repoRoot: path.join(paths.root, "repo"),
  });
  const lease = acquireBuildLease(paths, "2026-10-21T00:00:00.000Z");
  setDeviceDiskBytes(paths, "SIM-BUILD-1", DEFAULT_SLOT_RECLAIM_MAX_DISK_BYTES);

  const reconciled = reconcileIdleBroker(paths.resolvedPaths, runtimeOptions(paths, {
    now: "2026-10-21T01:00:00.000Z",
  }));
  assert.equal(reconciled.slotReclaim.reclaimedCount, 0);
  assert.equal(readJson(paths.simctl.statePath).devices.find((device) => device.udid === "SIM-BUILD-1").diskBytes, DEFAULT_SLOT_RECLAIM_MAX_DISK_BYTES);
  assert.equal(readJson(path.join(paths.stateRoot, "registry.json")).aliases["build-1"].activeLeaseId, lease.leaseId);
  assert.equal(readEventsBroker(paths.resolvedPaths).events.some((event) => event.type === "slot.reclaimed"), false);
});

test("disk threshold erases a free build slot between leases", () => {
  const paths = makeBuildFixture();
  initBroker(paths.resolvedPaths, runtimeOptions(paths));
  initProjectBroker(paths.resolvedPaths, {
    overwrite: true,
    projectId: "reclaim-demo",
    projectName: "Reclaim Demo",
    repoRoot: path.join(paths.root, "repo"),
  });
  const lease = acquireBuildLease(paths, "2026-10-21T00:00:00.000Z");
  setDeviceDiskBytes(paths, "SIM-BUILD-1", DEFAULT_SLOT_RECLAIM_MAX_DISK_BYTES);
  releaseLease(paths, lease, "2026-10-21T00:10:00.000Z");

  const device = readJson(paths.simctl.statePath).devices.find((candidate) => candidate.udid === "SIM-BUILD-1");
  assert.equal(device.diskBytes, 0);
  assert.equal(device.state, "Shutdown");
  const registry = readJson(path.join(paths.stateRoot, "registry.json"));
  assert.equal(registry.aliases["build-1"].leasesSinceErase, 0);
  assert.equal(registry.aliases["build-1"].lastErasedAt, "2026-10-21T00:10:00.000Z");
  assert.equal(registry.aliases["build-1"].powerState, "shutdown");
  const event = readEventsBroker(paths.resolvedPaths).events.find((candidate) => candidate.type === "slot.reclaimed");
  assert.equal(event.alias, "build-1");
  assert.equal(event.payload.reason, "disk");
  assert.equal(event.payload.source, "lease-release");
});

test("lease-count threshold reclaims a free build slot", () => {
  const paths = makeBuildFixture({
    build: { maxLeasesSinceErase: 2 },
  });
  initBroker(paths.resolvedPaths, runtimeOptions(paths));
  initProjectBroker(paths.resolvedPaths, {
    overwrite: true,
    projectId: "reclaim-demo",
    projectName: "Reclaim Demo",
    repoRoot: path.join(paths.root, "repo"),
  });
  const first = acquireBuildLease(paths, "2026-10-21T00:00:00.000Z");
  releaseLease(paths, first, "2026-10-21T00:05:00.000Z");
  assert.equal(readJson(path.join(paths.stateRoot, "registry.json")).aliases["build-1"].leasesSinceErase, 1);
  assert.equal(readEventsBroker(paths.resolvedPaths).events.some((event) => event.type === "slot.reclaimed"), false);

  const second = acquireBuildLease(paths, "2026-10-21T00:10:00.000Z");
  releaseLease(paths, second, "2026-10-21T00:15:00.000Z");
  const event = readEventsBroker(paths.resolvedPaths).events.find((candidate) => candidate.type === "slot.reclaimed");
  assert.equal(event.payload.reason, "leases");
  assert.equal(readJson(path.join(paths.stateRoot, "registry.json")).aliases["build-1"].leasesSinceErase, 0);
});

test("manual slots stay intact unless the host opts in", () => {
  const paths = makeBuildFixture();
  initBroker(paths.resolvedPaths, runtimeOptions(paths));
  initProjectBroker(paths.resolvedPaths, {
    overwrite: true,
    projectId: "reclaim-demo",
    projectName: "Reclaim Demo",
    repoRoot: path.join(paths.root, "repo"),
  });
  const lease = acquireLeaseBroker(paths.resolvedPaths, runtimeOptions(paths, {
    actorId: "human-manual",
    actorType: "human",
    now: "2026-10-21T00:00:00.000Z",
    ownerPid: process.pid,
    purposeId: "manual-testing",
  })).lease;
  setDeviceDiskBytes(paths, "SIM-MANUAL-1", DEFAULT_SLOT_RECLAIM_MAX_DISK_BYTES);
  releaseLease(paths, lease, "2026-10-21T00:10:00.000Z");
  assert.equal(readJson(paths.simctl.statePath).devices.find((device) => device.udid === "SIM-MANUAL-1").diskBytes, DEFAULT_SLOT_RECLAIM_MAX_DISK_BYTES);
  assert.equal(readEventsBroker(paths.resolvedPaths).events.some((event) => event.type === "slot.reclaimed"), false);

  writeJson(paths.hostConfigPath, {
    ...readJson(paths.hostConfigPath),
    slotReclaim: { manual: { enabled: true } },
  });
  reconcileIdleBroker(paths.resolvedPaths, runtimeOptions(paths, {
    now: "2026-10-21T00:20:00.000Z",
  }));
  assert.equal(readJson(paths.simctl.statePath).devices.find((device) => device.udid === "SIM-MANUAL-1").diskBytes, 0);
  assert.equal(readEventsBroker(paths.resolvedPaths).events.some((event) => (
    event.type === "slot.reclaimed" && event.alias === "manual-1"
  )), true);
});

test("disabling build reclaim leaves a large slot in place", () => {
  const paths = makeBuildFixture({
    build: { enabled: false },
  });
  initBroker(paths.resolvedPaths, runtimeOptions(paths));
  initProjectBroker(paths.resolvedPaths, {
    overwrite: true,
    projectId: "reclaim-demo",
    projectName: "Reclaim Demo",
    repoRoot: path.join(paths.root, "repo"),
  });
  const lease = acquireBuildLease(paths, "2026-10-21T00:00:00.000Z");
  setDeviceDiskBytes(paths, "SIM-BUILD-1", DEFAULT_SLOT_RECLAIM_MAX_DISK_BYTES);
  releaseLease(paths, lease, "2026-10-21T00:10:00.000Z");
  assert.equal(readJson(paths.simctl.statePath).devices.find((device) => device.udid === "SIM-BUILD-1").diskBytes, DEFAULT_SLOT_RECLAIM_MAX_DISK_BYTES);
});

test("host status and doctor surface the reclaim policy", () => {
  const paths = makeBuildFixture();
  initBroker(paths.resolvedPaths, runtimeOptions(paths));
  const status = hostStatusBroker(paths.resolvedPaths, runtimeOptions(paths));
  assert.equal(status.slotReclaim.enabled, true);
  assert.equal(status.slotReclaim.build.enabled, true);
  assert.equal(status.slotReclaim.manual.enabled, false);
  assert.match(status.slotReclaim.summary, /manual off/);
  assert.equal(status.simulators.find((simulator) => simulator.alias === "build-1").leasesSinceErase, 0);

  const doctor = doctorBroker(paths.resolvedPaths, runtimeOptions(paths));
  assert.equal(doctor.ok, true);
  assert.equal(doctor.slotReclaim.enabled, true);
  assert.match(doctor.slotReclaim.summary, /build on/);
});
