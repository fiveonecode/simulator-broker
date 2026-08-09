import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SIMCTL_INVENTORY_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
export const SIMCTL_COMMAND_TIMEOUT_MS = 120_000;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function readFixtureState(statePath) {
  if (fs.existsSync(statePath) === false) {
    throw new Error(`simctl fixture state not found at ${statePath}`);
  }

  const rawState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  return {
    devices: Array.isArray(rawState.devices) ? rawState.devices : [],
    devicetypes: Array.isArray(rawState.devicetypes) ? rawState.devicetypes : [],
    runtimes: Array.isArray(rawState.runtimes) ? rawState.runtimes : [],
  };
}

function writeFixtureState(statePath, state) {
  writeJsonAtomic(statePath, state);
}

function groupDevicesByRuntime(devices) {
  const grouped = {};
  for (const device of devices) {
    const runtimeIdentifier = device.runtimeIdentifier ?? "unknown-runtime";
    grouped[runtimeIdentifier] ??= [];
    grouped[runtimeIdentifier].push({
      availabilityError: device.availabilityError ?? undefined,
      dataPath: device.dataPath ?? undefined,
      deviceTypeIdentifier: device.deviceTypeIdentifier,
      isAvailable: device.isAvailable !== false,
      lastBootedAt: device.lastBootedAt ?? undefined,
      logPath: device.logPath ?? undefined,
      name: device.name,
      state: device.state ?? "Shutdown",
      udid: device.udid,
    });
  }
  return grouped;
}

function buildRuntimeLookup(runtimesJson) {
  const runtimes = Array.isArray(runtimesJson?.runtimes) ? runtimesJson.runtimes : [];
  return new Map(runtimes.map((runtime) => [runtime.identifier, runtime]));
}

function buildDeviceTypeLookup(deviceTypesJson) {
  const deviceTypes = Array.isArray(deviceTypesJson?.devicetypes) ? deviceTypesJson.devicetypes : [];
  return new Map(deviceTypes.map((deviceType) => [deviceType.identifier, deviceType]));
}

export function createDeviceIndex({ deviceTypesJson, devicesJson, runtimesJson }) {
  const runtimeLookup = buildRuntimeLookup(runtimesJson);
  const deviceTypeLookup = buildDeviceTypeLookup(deviceTypesJson);
  const index = new Map();
  const grouped = devicesJson?.devices ?? {};

  for (const [runtimeIdentifier, devices] of Object.entries(grouped)) {
    const runtime = runtimeLookup.get(runtimeIdentifier) ?? {};
    for (const device of devices) {
      const deviceType = deviceTypeLookup.get(device.deviceTypeIdentifier) ?? {};
      index.set(device.udid, {
        deviceFamily: deviceType.productFamily ?? device.productFamily ?? null,
        deviceTypeIdentifier: device.deviceTypeIdentifier,
        isAvailable: device.isAvailable !== false,
        name: device.name,
        runtimeIdentifier,
        runtimeVersion: runtime.version ?? null,
        state: device.state ?? "Shutdown",
        udid: device.udid,
      });
    }
  }

  return index;
}

function commandTimedOut(error) {
  return error?.code === "ETIMEDOUT" || error?.killed === true || error?.signal === "SIGTERM";
}

function wrapCommandError(error, args, { timeoutMs = SIMCTL_COMMAND_TIMEOUT_MS } = {}) {
  const timedOut = commandTimedOut(error);
  const wrapped = new Error(timedOut
    ? `simctl ${args.join(" ")} timed out after ${timeoutMs}ms`
    : `simctl ${args.join(" ")} failed`);
  wrapped.command = ["xcrun", "simctl", ...args];
  wrapped.exitCode = timedOut ? 124 : (error.status ?? 1);
  wrapped.stderr = error.stderr?.toString("utf8") ?? "";
  wrapped.stdout = error.stdout?.toString("utf8") ?? "";
  wrapped.timedOut = timedOut;
  wrapped.timeoutMs = timeoutMs;
  return wrapped;
}

function throwSimctlResult(args, result) {
  const error = new Error(result.timedOut === true
    ? `simctl ${args.join(" ")} timed out after ${result.timeoutMs}ms`
    : `simctl ${args.join(" ")} failed`);
  error.command = ["xcrun", "simctl", ...args];
  error.exitCode = result.exitCode ?? 1;
  error.stderr = result.stderr ?? "";
  error.stdout = result.stdout ?? "";
  error.timedOut = result.timedOut === true;
  error.timeoutMs = result.timeoutMs;
  throw error;
}

function isAlreadyShutdownResult(result) {
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /current state:\s*Shutdown/i.test(output) || /already\s+shutdown/i.test(output);
}

function isAlreadyDeletedResult(result) {
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /Invalid device/i.test(output) || /Unable to find a device/i.test(output);
}

function defaultCommandRunner(args, { allowFailure = false, maxBuffer = undefined, timeoutMs = SIMCTL_COMMAND_TIMEOUT_MS } = {}) {
  try {
    return execFileSync("xcrun", ["simctl", ...args], {
      encoding: "utf8",
      ...(maxBuffer === undefined ? {} : { maxBuffer }),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
  } catch (error) {
    const wrapped = wrapCommandError(error, args, { timeoutMs });
    if (allowFailure) {
      return {
        exitCode: wrapped.exitCode,
        stderr: wrapped.stderr,
        stdout: wrapped.stdout,
        timedOut: wrapped.timedOut,
        timeoutMs: wrapped.timeoutMs,
      };
    }
    throw wrapped;
  }
}

export function createSystemSimctlAdapter({ commandRunner = defaultCommandRunner } = {}) {
  const runCommand = (args, options = {}) => commandRunner(args, {
    timeoutMs: SIMCTL_COMMAND_TIMEOUT_MS,
    ...options,
  });
  return {
    bootDevice(simulatorId) {
      const args = ["boot", simulatorId];
      const result = runCommand(args, { allowFailure: true });
      if (typeof result === "object" && result !== null && result.exitCode !== 0) {
        throwSimctlResult(args, result);
      }
      runCommand(["bootstatus", simulatorId, "-b"]);
    },
    createDevice(name, deviceTypeId, runtimeId) {
      return String(runCommand(["create", name, deviceTypeId, runtimeId])).trim();
    },
    deleteDevice(simulatorId) {
      const args = ["delete", simulatorId];
      const result = runCommand(args, { allowFailure: true });
      if (typeof result === "object" && result !== null && result.exitCode !== 0 && !isAlreadyDeletedResult(result)) {
        throwSimctlResult(args, result);
      }
    },
    eraseDevice(simulatorId) {
      runCommand(["erase", simulatorId]);
    },
    listDeviceTypes() {
      return JSON.parse(runCommand(["list", "--json", "devicetypes"], {
        maxBuffer: SIMCTL_INVENTORY_MAX_BUFFER_BYTES,
      }));
    },
    listDevices() {
      return JSON.parse(runCommand(["list", "--json", "devices"], {
        maxBuffer: SIMCTL_INVENTORY_MAX_BUFFER_BYTES,
      }));
    },
    listRuntimes() {
      return JSON.parse(runCommand(["list", "--json", "runtimes"], {
        maxBuffer: SIMCTL_INVENTORY_MAX_BUFFER_BYTES,
      }));
    },
    renameDevice(simulatorId, name) {
      runCommand(["rename", simulatorId, name]);
    },
    shutdownDevice(simulatorId) {
      const args = ["shutdown", simulatorId];
      const result = runCommand(args, { allowFailure: true });
      if (typeof result === "object" && result !== null && result.exitCode !== 0 && !isAlreadyShutdownResult(result)) {
        throwSimctlResult(args, result);
      }
    },
  };
}

export function createFixtureSimctlAdapter({ statePath }) {
  const resolvedStatePath = path.resolve(statePath);

  function mutateState(mutator) {
    const state = readFixtureState(resolvedStatePath);
    const result = mutator(state);
    writeFixtureState(resolvedStatePath, state);
    return result;
  }

  function findDeviceOrThrow(state, simulatorId) {
    const device = state.devices.find((candidate) => candidate.udid === simulatorId);
    if (!device) {
      throw new Error(`Unknown simulator ${simulatorId}`);
    }
    return device;
  }

  return {
    bootDevice(simulatorId) {
      mutateState((state) => {
        const device = findDeviceOrThrow(state, simulatorId);
        device.lastBootedAt = new Date().toISOString();
        device.state = "Booted";
      });
    },
    createDevice(name, deviceTypeId, runtimeId) {
      return mutateState((state) => {
        const runtime = state.runtimes.find((candidate) => candidate.identifier === runtimeId);
        if (!runtime) {
          throw new Error(`Unknown runtime ${runtimeId}`);
        }
        const deviceType = state.devicetypes.find((candidate) => candidate.identifier === deviceTypeId)
          ?? runtime.supportedDeviceTypes?.find((candidate) => candidate.identifier === deviceTypeId);
        if (!deviceType) {
          throw new Error(`Unknown device type ${deviceTypeId}`);
        }
        const udid = crypto.randomUUID().toUpperCase();
        state.devices.push({
          deviceTypeIdentifier: deviceTypeId,
          isAvailable: true,
          name,
          runtimeIdentifier: runtimeId,
          runtimeVersion: runtime.version ?? null,
          state: "Shutdown",
          udid,
        });
        return udid;
      });
    },
    deleteDevice(simulatorId) {
      mutateState((state) => {
        state.devices = state.devices.filter((candidate) => candidate.udid !== simulatorId);
      });
    },
    eraseDevice(simulatorId) {
      mutateState((state) => {
        const device = findDeviceOrThrow(state, simulatorId);
        device.lastBootedAt = null;
        device.state = "Shutdown";
      });
    },
    listDeviceTypes() {
      const state = readFixtureState(resolvedStatePath);
      return { devicetypes: state.devicetypes };
    },
    listDevices() {
      const state = readFixtureState(resolvedStatePath);
      return { devices: groupDevicesByRuntime(state.devices) };
    },
    listRuntimes() {
      const state = readFixtureState(resolvedStatePath);
      return { runtimes: state.runtimes };
    },
    renameDevice(simulatorId, name) {
      mutateState((state) => {
        const device = findDeviceOrThrow(state, simulatorId);
        device.name = name;
      });
    },
    shutdownDevice(simulatorId) {
      mutateState((state) => {
        const device = findDeviceOrThrow(state, simulatorId);
        device.state = "Shutdown";
      });
    },
  };
}

export function resolveSimctlAdapter({ env = process.env, simctlAdapter } = {}) {
  if (simctlAdapter) {
    return simctlAdapter;
  }
  if (env.SIMBROKER_SIMCTL_FIXTURE_STATE) {
    return createFixtureSimctlAdapter({
      statePath: env.SIMBROKER_SIMCTL_FIXTURE_STATE,
    });
  }
  return createSystemSimctlAdapter();
}
