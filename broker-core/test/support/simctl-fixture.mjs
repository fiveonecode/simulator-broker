import fs from "node:fs";
import path from "node:path";

import { createFixtureSimctlAdapter } from "../../simctl.mjs";

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

export function defaultSimctlFixtureState({ devices = [] } = {}) {
  const runtime = {
    identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
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
    version: "18.2",
  };

  return {
    devices,
    devicetypes: [
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
    runtimes: [runtime],
  };
}

export function createDeviceRecord({
  deviceTypeIdentifier,
  isAvailable = true,
  name,
  runtimeIdentifier = "com.apple.CoreSimulator.SimRuntime.iOS-18-2",
  runtimeVersion = "18.2",
  state = "Shutdown",
  udid,
}) {
  return {
    deviceTypeIdentifier,
    isAvailable,
    name,
    runtimeIdentifier,
    runtimeVersion,
    state,
    udid,
  };
}

export function createSimctlFixture(root, { devices = [], runtimes } = {}) {
  const statePath = path.join(root, "simctl-state.json");
  const state = defaultSimctlFixtureState({ devices });
  if (runtimes !== undefined) {
    state.runtimes = runtimes;
  }
  writeJson(statePath, state);
  return {
    adapter: createFixtureSimctlAdapter({ statePath }),
    env: {
      SIMBROKER_SIMCTL_FIXTURE_STATE: statePath,
    },
    statePath,
  };
}
