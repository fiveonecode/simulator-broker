import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { evaluateSetupPrerequisites } from "../setup-preflight.mjs";

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
