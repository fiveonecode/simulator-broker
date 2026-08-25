import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  completeSetupPreview,
  evaluateSetupPrerequisites,
  inspectSetupPostDoctorSnapshot,
} from "../setup-preflight.mjs";

function makePaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-setup-preflight-"));
  return {
    hostConfigPath: path.join(root, "config", "host.json"),
    root,
    stateRoot: path.join(root, "state"),
  };
}

function readyCommandRunner(command, args) {
  const key = `${command} ${args.join(" ")}`;
  if (key === "/usr/bin/sw_vers -productVersion") {
    return "14.7\n";
  }
  if (key === "/usr/bin/xcode-select -p") {
    return "/Applications/Xcode.app/Contents/Developer\n";
  }
  if (key === "/usr/bin/xcodebuild -checkFirstLaunchStatus") {
    return "";
  }
  if (key === "/usr/bin/xcrun --find simctl") {
    return "/Applications/Xcode.app/Contents/Developer/usr/bin/simctl\n";
  }
  throw new Error(`Unexpected command: ${key}`);
}

test("setup preflight reports every supported prerequisite and informational disk bytes", () => {
  const paths = makePaths();
  const prerequisites = evaluateSetupPrerequisites(paths, {
    commandRunner: readyCommandRunner,
    env: {},
    nodeVersion: "20.0.0",
    platform: "darwin",
  });

  assert.deepEqual(prerequisites.map((prerequisite) => prerequisite.id), [
    "node",
    "macos",
    "xcode",
    "xcode-first-launch",
    "simctl",
    "host-config-path",
    "state-root-path",
    "disk-space",
  ]);
  assert.equal(prerequisites.some((prerequisite) => prerequisite.status === "blocked"), false);
  const disk = prerequisites.find((prerequisite) => prerequisite.id === "disk-space");
  assert.equal(disk.status, "info");
  assert.equal(typeof disk.details.availableBytes, "number");
  assert.match(disk.details.availableGiB, / GiB$/);
});

test("setup preflight blocks unsupported Node and macOS with actionable guidance", () => {
  const paths = makePaths();
  const prerequisites = evaluateSetupPrerequisites(paths, {
    commandRunner: readyCommandRunner,
    env: {},
    nodeVersion: "18.20.0",
    platform: "linux",
  });

  const node = prerequisites.find((prerequisite) => prerequisite.id === "node");
  const macos = prerequisites.find((prerequisite) => prerequisite.id === "macos");
  assert.equal(node.status, "blocked");
  assert.deepEqual(node.remediationCommands, ["brew install node@20"]);
  assert.equal(macos.status, "blocked");
});

test("setup preflight distinguishes Xcode selection, first-launch, and simctl blockers", () => {
  const paths = makePaths();
  const scenarios = [
    {
      blockedId: "xcode",
      runner(command, args) {
        if (`${command} ${args.join(" ")}` === "/usr/bin/sw_vers -productVersion") {
          return "14.0";
        }
        if (`${command} ${args.join(" ")}` === "/usr/bin/xcode-select -p") {
          return "/Library/Developer/CommandLineTools";
        }
        throw new Error("unavailable");
      },
    },
    {
      blockedId: "xcode-first-launch",
      runner(command, args) {
        const key = `${command} ${args.join(" ")}`;
        if (key === "/usr/bin/xcodebuild -checkFirstLaunchStatus") {
          const error = new Error("first launch pending");
          error.stderr = Buffer.from("first launch pending");
          throw error;
        }
        return readyCommandRunner(command, args);
      },
    },
    {
      blockedId: "simctl",
      runner(command, args) {
        const key = `${command} ${args.join(" ")}`;
        if (key === "/usr/bin/xcrun --find simctl") {
          throw new Error("simctl missing");
        }
        return readyCommandRunner(command, args);
      },
    },
  ];

  for (const scenario of scenarios) {
    const prerequisites = evaluateSetupPrerequisites(paths, {
      commandRunner: scenario.runner,
      env: {},
      nodeVersion: "20.0.0",
      platform: "darwin",
    });
    const blocked = prerequisites.find((prerequisite) => prerequisite.id === scenario.blockedId);
    assert.equal(blocked.status, "blocked", scenario.blockedId);
    assert.ok(blocked.remediationCommands.length > 0, scenario.blockedId);
  }
});

test("setup preflight accepts an existing writable host-config file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-setup-preflight-host-file-"));
  const hostConfigPath = path.join(root, "host.json");
  fs.writeFileSync(hostConfigPath, "{}\n");
  const paths = {
    hostConfigPath,
    stateRoot: path.join(root, "state"),
  };
  const prerequisites = evaluateSetupPrerequisites(paths, {
    commandRunner: readyCommandRunner,
    env: {},
    nodeVersion: "20.0.0",
    platform: "darwin",
  });
  const hostConfig = prerequisites.find((prerequisite) => prerequisite.id === "host-config-path");
  assert.equal(hostConfig.status, "ready");
});

test("setup preflight blocks destinations whose ancestor is a regular file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-setup-preflight-file-"));
  const blockingFile = path.join(root, "existing-file");
  fs.writeFileSync(blockingFile, "not-a-directory\n");
  const paths = {
    hostConfigPath: path.join(blockingFile, "host.json"),
    stateRoot: path.join(root, "state"),
  };
  const prerequisites = evaluateSetupPrerequisites(paths, {
    commandRunner: readyCommandRunner,
    env: {},
    nodeVersion: "20.0.0",
    platform: "darwin",
  });
  const hostConfig = prerequisites.find((prerequisite) => prerequisite.id === "host-config-path");
  assert.equal(hostConfig.status, "blocked");
  assert.match(hostConfig.summary, /searchable, writable directory/);
});

test("setup preflight blocks an existing state root that is a regular file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-setup-preflight-state-file-"));
  const stateRoot = path.join(root, "state-file");
  fs.writeFileSync(stateRoot, "not-a-directory\n");
  const paths = {
    hostConfigPath: path.join(root, "config", "host.json"),
    stateRoot,
  };
  const prerequisites = evaluateSetupPrerequisites(paths, {
    commandRunner: readyCommandRunner,
    env: {},
    nodeVersion: "20.0.0",
    platform: "darwin",
  });
  const stateRootCheck = prerequisites.find((prerequisite) => prerequisite.id === "state-root-path");
  assert.equal(stateRootCheck.status, "blocked");
  assert.match(stateRootCheck.summary, /not a directory/);
});

test("post-doctor snapshot inspection rejects unavailable or repair-needed aliases", () => {
  const healthy = inspectSetupPostDoctorSnapshot({
    overview: { unhealthyAliases: 0 },
    simulators: [
      { alias: "manual-1", health: "healthy", simulatorId: "SIM-1" },
      { alias: "ui-1", health: "healthy", simulatorId: "SIM-2" },
      { alias: "ui-2", health: "healthy", simulatorId: "SIM-3" },
      { alias: "build-1", health: "healthy", simulatorId: "SIM-4" },
      { alias: "build-2", health: "healthy", simulatorId: "SIM-5" },
      { alias: "ipad-1", health: "healthy", simulatorId: "SIM-6" },
    ],
  }, { requireStarterAliases: true });
  assert.equal(healthy.ok, true);

  const repairNeeded = inspectSetupPostDoctorSnapshot({
    overview: { unhealthyAliases: 0 },
    simulators: [
      { alias: "manual-1", health: "healthy", simulatorId: "SIM-1" },
      { alias: "ui-1", health: "repair-needed", simulatorId: "SIM-2" },
    ],
  });
  assert.equal(repairNeeded.ok, false);
  assert.deepEqual(repairNeeded.unhealthyAliases.map((simulator) => simulator.alias), ["ui-1"]);

  const unavailable = inspectSetupPostDoctorSnapshot({
    overview: { unhealthyAliases: 0 },
    simulators: [
      { alias: "ui-1", available: false, health: "healthy", simulatorId: "SIM-2" },
    ],
  });
  assert.equal(unavailable.ok, false);

  const missingAliases = inspectSetupPostDoctorSnapshot({
    overview: { unhealthyAliases: 0 },
    simulators: [{ alias: "ui-1", health: "healthy", simulatorId: "SIM-2" }],
  }, { requireStarterAliases: true });
  assert.equal(missingAliases.ok, false);
  assert.deepEqual(missingAliases.missingExpectedAliases, [
    "manual-1",
    "ui-2",
    "build-1",
    "build-2",
    "ipad-1",
  ]);
});

test("blocked completion guidance comes from the combined prerequisite blockers", () => {
  const preview = completeSetupPreview({
    confirmation: { createCount: 6, required: true, reuseCount: 0 },
    host: { configured: false },
    nextSteps: ["simbroker project init", "simbroker project validate"],
    prerequisites: [{
      id: "service-identity",
      remediationCommands: ["simbroker service stop", "simbroker setup"],
      status: "blocked",
      summary: "The running service uses different broker paths.",
    }],
    service: { action: "keep", running: true },
    status: "blocked",
  }, [], {
    serviceRunning: false,
    snapshotReady: false,
  });

  assert.equal(preview.status, "blocked");
  assert.equal(preview.confirmation.required, false);
  assert.deepEqual(preview.nextSteps, ["simbroker service stop", "simbroker setup"]);
  assert.equal(preview.nextSteps.includes("simbroker project init"), false);
});

test("core finishing work remains required when service and snapshot are already ready", () => {
  const preview = completeSetupPreview({
    host: { configured: true },
    nextSteps: [],
    prerequisites: [{
      id: "registry",
      remediationCommands: [],
      status: "info",
      summary: "The starter registry will be initialized.",
    }],
    service: { action: "keep", running: true },
    status: "changes_required",
  }, [], {
    serviceRunning: true,
    snapshotReady: true,
  });

  assert.equal(preview.status, "changes_required");
  assert.equal(preview.service.action, "keep");
});
