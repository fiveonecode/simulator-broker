import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acquireLeaseBroker,
  hostStatusBroker,
  initBroker,
  readEventsBroker,
  reconcileUiPrepareBroker,
  releaseLeaseBroker,
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
  registry.aliases[lease.alias].prepare.state = "erasing";
  writeJson(registryPath, registry);
  const simctlState = readJson(fixture.paths.simctl.statePath);
  simctlState.runtimes = [];
  writeJson(fixture.paths.simctl.statePath, simctlState);

  const status = hostStatusBroker(fixture.resolvedPaths, runtimeOptions(fixture));
  const alias = status.simulators.find((simulator) => simulator.alias === lease.alias);
  assert.equal(alias.health, "healthy");
  assert.equal(alias.prepareState, "erasing");
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
