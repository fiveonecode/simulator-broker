#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

import { BROKER_EXIT_CODES, INTERNAL_ERROR_REASON_CODE, resolveBrokerExitCode } from "../../broker-core/error-contract.mjs";
import {
  BrokerError,
  HOST_BOOTSTRAP_DEVICE_WARNING,
  idlePolicyConfiguredBroker,
  previewSetupBroker,
  resolveBrokerPaths,
} from "../../broker-core/index.mjs";
import {
  createCommandRequest,
  executeBrokerCommand,
  flagValue,
  format,
  hostInitOptions,
  parseArgs,
  streamEventsLocal,
} from "../command-dispatch.mjs";
import {
  executeServiceCommand,
  probeService,
  requestServiceStop,
  serviceCommandTimeoutMs,
  serviceStopTimeoutMs,
  serviceStartupTimeoutMs,
  streamServiceEvents,
} from "../service/service-client.mjs";
import {
  blockedSetupPreview,
  completeSetupPreview,
  evaluateSetupPrerequisites,
  inspectSetupPostDoctorSnapshot,
} from "../setup-preflight.mjs";
import { applySetupBrokerInWorker } from "../setup-provisioning.mjs";

const BROKERD_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "brokerd.mjs");
const SERVICE_CONTROL_FLAGS = new Set([
  "help",
  "host-config",
  "json",
  "project-file",
  "repo-root",
  "service-socket",
  "state-root",
]);
const BROKER_PATH_FLAGS = new Set([
  "host-config",
  "project-file",
  "repo-root",
  "service-socket",
  "state-root",
]);
const SETUP_FLAGS = new Set([
  "apply",
  "confirm",
  "help",
  "host-config",
  "host-id",
  "ios-version",
  "json",
  "service-socket",
  "state-root",
]);

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function removeIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function ensurePrivateDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirPath, 0o700);
}

function ensurePrivateFile(filePath) {
  fs.chmodSync(filePath, 0o600);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendTransport(payload, transport) {
  return {
    ...payload,
    transport,
  };
}

function requestMayReportScheduler(request) {
  return request.group === "idle"
    || (request.group === "lease" && request.command === "acquire");
}

function isInvalidConfigBrokerError(error) {
  return error instanceof BrokerError && error.payload?.reasonCode === "invalid-config";
}

function canReportCommittedAcquireMetadataWarning(request, payload, error) {
  return request.group === "lease"
    && request.command === "acquire"
    && payload?.lease != null
    && isInvalidConfigBrokerError(error);
}

function schedulerMetadataForRequest(paths, request, payload, activeWhenConfigured) {
  try {
    const configured = typeof payload.configured === "boolean"
      ? payload.configured
      : idlePolicyConfiguredBroker(paths);
    return {
      configured,
      scheduler: request.group === "idle" || configured
        ? {
          active: activeWhenConfigured(configured),
          limitation: activeWhenConfigured(configured) || !configured ? null : "service-not-running",
        }
        : null,
    };
  } catch (error) {
    if (canReportCommittedAcquireMetadataWarning(request, payload, error)) {
      return {
        configured: false,
        scheduler: {
          active: false,
          limitation: "invalid-config",
        },
      };
    }
    throw error;
  }
}

function rejectValuelessPathFlags(flags) {
  for (const key of BROKER_PATH_FLAGS) {
    if (!flags.has(key)) {
      continue;
    }
    const value = flagValue(flags, key);
    if (value === null || String(value).trim() === "") {
      throw new BrokerError(`Missing required flag --${key}.`, {
        flag: key,
        reasonCode: "missing-flag",
      });
    }
  }
}

function localOnlyMode(env = process.env) {
  return env.SIMBROKER_LOCAL_ONLY === "1";
}

function buildPaths(flags) {
  rejectValuelessPathFlags(flags);
  return resolveBrokerPaths({
    cwd: process.cwd(),
    hostConfigPath: flagValue(flags, "host-config"),
    projectFilePath: flagValue(flags, "project-file"),
    repoRoot: flagValue(flags, "repo-root"),
    serviceSocketPath: flagValue(flags, "service-socket"),
    stateRoot: flagValue(flags, "state-root"),
  });
}

function rejectUnknownServiceControlFlags(flags) {
  for (const key of flags.keys()) {
    if (!SERVICE_CONTROL_FLAGS.has(key)) {
      throw new BrokerError(`Unknown flag --${key}.`, {
        flag: key,
        reasonCode: "invalid-flag",
      });
    }
  }
}

function rejectExtraPositionals(positionals) {
  if (positionals.length <= 2) {
    return;
  }
  throw new BrokerError(`Unexpected positional argument ${positionals[2]}.`, {
    command: positionals.join(" "),
    reasonCode: "unknown-command",
    usage: "simbroker <group> <command> [flags]",
  });
}

function serviceMetadataSnapshot(paths) {
  return readJsonIfExists(paths.serviceMetadataPath) ?? {
    hostConfigPath: paths.hostConfigPath,
    socketPath: paths.serviceSocketPath,
    stateRoot: paths.stateRoot,
  };
}

function normalizedServicePath(value) {
  return typeof value === "string" && value.trim() !== "" ? path.resolve(value) : null;
}

function servicePathMismatches(paths, service) {
  return [
    ["hostConfigPath", paths.hostConfigPath],
    ["socketPath", paths.serviceSocketPath],
    ["stateRoot", paths.stateRoot],
  ].filter(([field, expectedPath]) =>
    normalizedServicePath(service?.[field]) !== path.resolve(expectedPath));
}

function assertServiceMatchesPaths(paths, probe) {
  const mismatches = servicePathMismatches(paths, probe?.service);
  if (mismatches.length === 0) {
    return;
  }
  throw new BrokerError("Broker service is running with different broker paths.", {
    actual: {
      hostConfigPath: normalizedServicePath(probe?.service?.hostConfigPath),
      socketPath: normalizedServicePath(probe?.service?.socketPath),
      stateRoot: normalizedServicePath(probe?.service?.stateRoot),
    },
    expected: {
      hostConfigPath: paths.hostConfigPath,
      socketPath: paths.serviceSocketPath,
      stateRoot: paths.stateRoot,
    },
    mismatchedFields: mismatches.map(([field]) => field),
    reasonCode: "service-identity-mismatch",
  });
}

async function serviceStatus(paths) {
  const probe = await probeService(paths);
  if (probe) {
    assertServiceMatchesPaths(paths, probe);
  }
  const metadata = serviceMetadataSnapshot(paths);
  return {
    ok: true,
    running: probe !== null,
    service: probe?.service ?? metadata,
    staleMetadata: probe === null && fs.existsSync(paths.serviceMetadataPath),
  };
}

function observeChildExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
    child.once("error", reject);
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Operation was aborted.");
  }
}

function abortOutcome(signal) {
  if (!signal) {
    return new Promise(() => {});
  }
  if (signal.aborted) {
    return Promise.resolve({ aborted: true });
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ aborted: true }), { once: true });
  });
}
async function waitForSpawnedService(paths, child, { signal, timeoutMs = 5000 } = {}) {
  const startedAt = Date.now();
  const childExit = observeChildExit(child);
  const aborted = abortOutcome(signal);
  let lastExit = null;
  while (Date.now() - startedAt < timeoutMs) {
    throwIfAborted(signal);
    const outcome = await Promise.race([
      probeService(paths, { signal, timeoutMs: 250 }).then((probe) => ({ probe })),
      childExit.then((exit) => ({ exit })),
      aborted,
    ]);
    throwIfAborted(signal);
    if (outcome.exit) {
      lastExit = outcome.exit;
      const probe = await probeService(paths, { signal, timeoutMs: 250 });
      if (probe) {
        return {
          childExit: null,
          probe,
        };
      }
      return {
        childExit: lastExit,
        probe: null,
      };
    }
    if (outcome.probe) {
      return {
        childExit: null,
        probe: outcome.probe,
      };
    }
    const delay = await Promise.race([
      sleep(100).then(() => null),
      childExit.then((exit) => exit),
      aborted,
    ]);
    throwIfAborted(signal);
    if (delay) {
      lastExit = delay;
      const probe = await probeService(paths, { signal, timeoutMs: 250 });
      if (probe) {
        return {
          childExit: null,
          probe,
        };
      }
      return {
        childExit: lastExit,
        probe: null,
      };
    }
  }
  return {
    childExit: lastExit,
    probe: null,
  };
}

async function waitForServiceToStop(paths, { timeoutMs = 5000 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const probe = await probeService(paths, { timeoutMs: 250 });
      if (!probe) {
        return true;
      }
    } catch (error) {
      if (!(error instanceof BrokerError) || error.payload?.reasonCode !== "service-unavailable") {
        throw error;
      }
    }
    await sleep(100);
  }
  return false;
}

function terminateSpawnedService(child) {
  if (!Number.isInteger(child.pid)) {
    return;
  }
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    // The child may already have exited after reporting its startup failure.
  }
}

async function startService(paths, { signal } = {}) {
  throwIfAborted(signal);
  const running = await probeService(paths, { signal });
  if (running) {
    assertServiceMatchesPaths(paths, running);
    return {
      ok: true,
      running: true,
      service: running.service,
      unchanged: true,
    };
  }

  ensurePrivateDir(paths.stateRoot);
  throwIfAborted(signal);
  const logFd = fs.openSync(paths.serviceLogPath, "a", 0o600);
  ensurePrivateFile(paths.serviceLogPath);
  const child = spawn(process.execPath, [
    BROKERD_PATH,
    "--host-config", paths.hostConfigPath,
    "--state-root", paths.stateRoot,
    "--service-socket", paths.serviceSocketPath,
  ], {
    detached: true,
    env: process.env,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  let startupOutcome;
  try {
    startupOutcome = await waitForSpawnedService(paths, child, {
      signal,
      timeoutMs: serviceStartupTimeoutMs({ paths }),
    });
  } catch (error) {
    if (signal?.aborted) {
      terminateSpawnedService(child);
    }
    throw error;
  }
  const { childExit, probe } = startupOutcome;
  throwIfAborted(signal);
  if (childExit) {
    throw new BrokerError("Broker service exited before it became available.", {
      exitStatus: childExit.code,
      logPath: paths.serviceLogPath,
      reasonCode: "service-unavailable",
      serviceMetadataPath: paths.serviceMetadataPath,
      serviceSocketPath: paths.serviceSocketPath,
      signal: childExit.signal,
    });
  }
  if (!probe) {
    terminateSpawnedService(child);
    throw new BrokerError("Broker service failed to start.", {
      logPath: paths.serviceLogPath,
      reasonCode: "service-start-timeout",
      serviceMetadataPath: paths.serviceMetadataPath,
      serviceSocketPath: paths.serviceSocketPath,
    });
  }
  assertServiceMatchesPaths(paths, probe);

  return {
    ok: true,
    running: true,
    service: probe.service,
    started: true,
  };
}

async function stopService(paths) {
  const status = await serviceStatus(paths);
  if (!status.running) {
    removeIfExists(paths.serviceMetadataPath);
    removeIfExists(paths.serviceSocketPath);
    return {
      ok: true,
      service: status.service,
      unchanged: true,
    };
  }

  let response = null;
  let stopError = null;
  try {
    response = await requestServiceStop(paths, {
      expectedServiceIdentity: status.service,
    });
  } catch (error) {
    stopError = error;
    if (error instanceof BrokerError && error.payload?.reasonCode === "service-identity-mismatch") {
      throw error;
    }
  }

  const stopped = await waitForServiceToStop(paths, {
    timeoutMs: serviceStopTimeoutMs(paths, response),
  });
  if (!stopped && stopError) {
    throw stopError;
  }
  if (!stopped) {
    throw new BrokerError("Broker service did not stop before the timeout.", {
      reasonCode: "service-stop-timeout",
      serviceMetadataPath: paths.serviceMetadataPath,
      serviceSocketPath: paths.serviceSocketPath,
    });
  }

  removeIfExists(paths.serviceMetadataPath);
  removeIfExists(paths.serviceSocketPath);

  return {
    ok: true,
    service: response?.service ?? status.service,
    stopped: true,
  };
}

async function runServiceAwareRequest(paths, request) {
  const canUseService = !localOnlyMode(process.env) && request.group !== "help";
  let service = canUseService
    ? await probeService(paths, { timeoutMs: serviceCommandTimeoutMs(request) })
    : null;
  let policyConfiguredForStartup = false;
  if (!service
    && canUseService
    && request.group === "lease"
    && request.command === "acquire") {
    try {
      policyConfiguredForStartup = idlePolicyConfiguredBroker(paths);
    } catch (error) {
      if (!isInvalidConfigBrokerError(error)) {
        throw error;
      }
    }
  }

  if (!service
    && canUseService
    && request.group === "lease"
    && request.command === "acquire"
    && policyConfiguredForStartup) {
    await startService(paths);
    service = await probeService(paths, { timeoutMs: serviceCommandTimeoutMs(request) });
    if (!service) {
      throw new BrokerError("Broker service did not become available for policy-enabled lease acquisition.", {
        reasonCode: "service-unavailable",
      });
    }
  }

  if (request.type === "events-stream") {
    if (service) {
      assertServiceMatchesPaths(paths, service);
      await streamServiceEvents(paths, request.options);
      return {
        handled: true,
      };
    }
    await streamEventsLocal(paths, request.options);
    return {
      handled: true,
    };
  }

  if (service) {
    assertServiceMatchesPaths(paths, service);
    const payload = await executeServiceCommand(paths, request, {
      expectedServiceIdentity: service.service,
    });
    const result = appendTransport(payload, "service");
    if (requestMayReportScheduler(request)) {
      try {
        const configured = typeof payload.configured === "boolean"
          ? payload.configured
          : idlePolicyConfiguredBroker(paths);
        if (request.group === "idle" || configured) {
          result.scheduler = {
            active: configured,
            limitation: null,
          };
        }
      } catch (error) {
        if (!canReportCommittedAcquireMetadataWarning(request, payload, error)) {
          throw error;
        }
        result.scheduler = {
          active: false,
          limitation: "invalid-config",
        };
      }
    }
    return result;
  }

  const payload = appendTransport(executeBrokerCommand(paths, request), "direct");
  let schedulerRunning = false;
  let configuredForScheduler = false;
  if (canUseService
    && request.group === "lease"
    && request.command === "acquire") {
    const schedulerMetadata = schedulerMetadataForRequest(paths, request, payload, () => false);
    configuredForScheduler = schedulerMetadata.configured;
    if (schedulerMetadata.scheduler?.limitation === "invalid-config") {
      payload.scheduler = schedulerMetadata.scheduler;
      return payload;
    }
  }
  if (canUseService
    && request.group === "lease"
    && request.command === "acquire"
    && configuredForScheduler) {
    try {
      await startService(paths);
      schedulerRunning = true;
    } catch {
      // The direct lease acquire has already committed; return it with the scheduler limitation.
    }
  }
  if (requestMayReportScheduler(request)) {
    const { configured, scheduler } = schedulerMetadataForRequest(paths, request, payload, () => schedulerRunning);
    if (scheduler) {
      payload.scheduler = {
        active: scheduler.active,
        limitation: localOnlyMode(process.env)
          ? "local-only-mode"
          : (scheduler.limitation ?? (configured && !schedulerRunning ? "service-not-running" : null)),
      };
    }
  }
  return payload;
}

function rejectUnknownSetupFlags(flags) {
  for (const key of flags.keys()) {
    if (!SETUP_FLAGS.has(key)) {
      throw new BrokerError(`Flag --${key} is not valid for setup.`, {
        flag: key,
        reasonCode: "invalid-flag",
      });
    }
  }
}

function setupBooleanFlag(flags, key) {
  if (!flags.has(key)) {
    return false;
  }
  const value = flags.get(key);
  if (value === true || value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new BrokerError(`Flag --${key} must be passed without a value or with true/false.`, {
    flag: key,
    reasonCode: "invalid-flag",
  });
}

function setupValueFlag(flags, key) {
  if (!flags.has(key)) {
    return null;
  }
  const value = flagValue(flags, key);
  if (value === null || String(value).trim() === "") {
    throw new BrokerError(`Missing required flag --${key}.`, {
      flag: key,
      reasonCode: "missing-flag",
    });
  }
  return value;
}

function setupOptions(flags) {
  rejectUnknownSetupFlags(flags);
  const apply = setupBooleanFlag(flags, "apply");
  const confirmPlanId = setupValueFlag(flags, "confirm");
  if (!apply && confirmPlanId !== null) {
    throw new BrokerError("--confirm requires --apply for setup.", {
      reasonCode: "invalid-flag",
    });
  }
  const iosVersion = setupValueFlag(flags, "ios-version");
  if (iosVersion !== null && !/^\d+(?:\.\d+)?$/.test(iosVersion)) {
    throw new BrokerError("Flag --ios-version must be an iOS major or exact major.minor version.", {
      flag: "ios-version",
      reasonCode: "invalid-flag",
    });
  }
  return {
    apply,
    confirmPlanId,
    hostId: setupValueFlag(flags, "host-id"),
    iosVersion,
  };
}

function setupPrerequisiteFromError(error) {
  const reasonCode = error?.payload?.reasonCode ?? error?.reasonCode ?? "simctl-inventory-invalid";
  const runtimeProblem = reasonCode === "runtime-not-found" || reasonCode === "device-type-not-found";
  return {
    details: {
      error: error?.message ?? String(error),
      reasonCode,
    },
    id: runtimeProblem ? "ios-runtime" : "simctl-inventory",
    remediationCommands: runtimeProblem
      ? ["Open Xcode > Settings > Components", "xcodebuild -downloadPlatform iOS"]
      : ["xcrun simctl list --json runtimes", "xcrun simctl list --json devices", "xcrun simctl list --json devicetypes"],
    status: "blocked",
    summary: runtimeProblem
      ? "No installed iOS runtime supports both starter device families."
      : "Simulator inventory could not be read as valid JSON.",
  };
}

function serviceIdentityRecoveryCommands(error, paths) {
  const actual = error?.payload?.actual;
  const retryCommand = setupRecoveryCommand(paths);
  if ([actual?.hostConfigPath, actual?.stateRoot, actual?.socketPath]
    .every((value) => typeof value === "string" && value.length > 0)) {
    return [
      [
        "simbroker service stop",
        "--host-config", shellQuoteArgument(actual.hostConfigPath),
        "--state-root", shellQuoteArgument(actual.stateRoot),
        "--service-socket", shellQuoteArgument(actual.socketPath),
      ].join(" "),
      retryCommand,
    ];
  }
  return ["simbroker service status --json", retryCommand];
}

async function buildSetupPreview(paths, options) {
  const prerequisites = evaluateSetupPrerequisites(paths);
  if (prerequisites.some((prerequisite) => prerequisite.status === "blocked")) {
    return blockedSetupPreview(paths, prerequisites, options);
  }

  let corePreview;
  try {
    corePreview = previewSetupBroker(paths, {
      hostId: options.hostId ?? undefined,
      iosVersion: options.iosVersion ?? undefined,
    });
    prerequisites.push({
      id: "simctl-inventory",
      remediationCommands: [],
      status: "ready",
      summary: "Installed Simulator runtimes, devices, and device types were read successfully.",
    });
  } catch (error) {
    return blockedSetupPreview(paths, [...prerequisites, setupPrerequisiteFromError(error)], options);
  }

  let running = false;
  if (corePreview.status !== "blocked") {
    try {
      running = (await serviceStatus(paths)).running;
    } catch (error) {
      corePreview = {
        ...corePreview,
        prerequisites: [...corePreview.prerequisites, {
          details: error?.payload ?? { error: error?.message ?? String(error) },
          id: "service-identity",
          remediationCommands: serviceIdentityRecoveryCommands(error, paths),
          status: "blocked",
          summary: error?.message ?? "The running broker service uses different paths.",
        }],
        status: "blocked",
      };
    }
  }
  return completeSetupPreview(corePreview, prerequisites, {
    serviceRunning: running,
    snapshotReady: setupSnapshotReady(paths, corePreview),
  });
}

function setupSnapshotReady(paths, corePreview) {
  if (!corePreview.host.configured || !fs.existsSync(paths.appSnapshotPath)) {
    return false;
  }
  try {
    const snapshot = JSON.parse(fs.readFileSync(paths.appSnapshotPath, "utf8"));
    if (path.resolve(snapshot.hostConfigPath ?? "") !== path.resolve(paths.hostConfigPath)
      || path.resolve(snapshot.stateRoot ?? "") !== path.resolve(paths.stateRoot)
      || snapshot.hostId !== corePreview.host.hostId) {
      return false;
    }
    const snapshotAliases = new Map(
      (Array.isArray(snapshot.simulators) ? snapshot.simulators : [])
        .map((simulator) => [simulator.alias, simulator]),
    );
    if (!corePreview.devices.every((device) => {
      const snapshotDevice = snapshotAliases.get(device.alias);
      return snapshotDevice
        && snapshotDevice.simulatorId === device.simulatorId
        && snapshotDevice.health !== "repair-needed"
        && snapshotDevice.health !== "repairing";
    })) {
      return false;
    }
    const snapshotMtime = fs.statSync(paths.appSnapshotPath).mtimeMs;
    const relevantStateMtime = setupDoctorStateMtime(paths);
    return snapshotMtime >= relevantStateMtime
      && setupDoctorStateReadable(paths)
      && setupDoctorRecordsMatchSnapshot(paths, snapshot);
  } catch {
    return false;
  }
}

function setupDoctorStateFiles(paths) {
  const files = [];
  if (fs.existsSync(paths.knownProjectsPath)) {
    files.push(paths.knownProjectsPath);
  }
  for (const directoryPath of [paths.leasesDir, paths.pinsDir]) {
    if (!fs.existsSync(directoryPath)) {
      continue;
    }
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      files.push(path.join(directoryPath, entry.name));
    }
  }
  return files;
}

function setupDoctorStateMtime(paths) {
  return [
    paths.hostConfigPath,
    paths.registryPath,
    paths.leasesDir,
    paths.pinsDir,
    ...setupDoctorStateFiles(paths),
  ]
    .filter((filePath) => fs.existsSync(filePath))
    .reduce((latest, filePath) => Math.max(latest, fs.statSync(filePath).mtimeMs), 0);
}

function setupJsonRecordIds(directoryPath, idField) {
  const ids = new Set();
  if (!fs.existsSync(directoryPath)) {
    return ids;
  }
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const record = JSON.parse(fs.readFileSync(path.join(directoryPath, entry.name), "utf8"));
    if (typeof record?.[idField] === "string" && record[idField].trim() !== "") {
      ids.add(record[idField]);
    } else {
      ids.add(entry.name);
    }
  }
  return ids;
}

function setupSameStringSet(left, right) {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function setupDoctorRecordsMatchSnapshot(paths, snapshot) {
  const snapshotLeaseIds = new Set(
    (Array.isArray(snapshot.activeLeases) ? snapshot.activeLeases : [])
      .map((lease) => lease?.leaseId)
      .filter((leaseId) => typeof leaseId === "string" && leaseId.trim() !== ""),
  );
  const snapshotPinIds = new Set(
    (Array.isArray(snapshot.pins) ? snapshot.pins : [])
      .map((pin) => pin?.pinId)
      .filter((pinId) => typeof pinId === "string" && pinId.trim() !== ""),
  );
  if (!setupSameStringSet(snapshotLeaseIds, setupJsonRecordIds(paths.leasesDir, "leaseId"))) {
    return false;
  }
  if (!setupSameStringSet(snapshotPinIds, setupJsonRecordIds(paths.pinsDir, "pinId"))) {
    return false;
  }
  const catalogProjectIds = new Set(
    (Array.isArray(snapshot.projects) ? snapshot.projects : [])
      .filter((project) => typeof project?.projectFilePath === "string" && project.projectFilePath.length > 0)
      .map((project) => project.projectId)
      .filter((projectId) => typeof projectId === "string" && projectId.length > 0),
  );
  if (catalogProjectIds.size === 0) {
    return true;
  }
  if (!fs.existsSync(paths.knownProjectsPath)) {
    return false;
  }
  const knownProjects = JSON.parse(fs.readFileSync(paths.knownProjectsPath, "utf8"));
  const currentProjectIds = new Set(Object.keys(knownProjects?.projects ?? {}));
  for (const projectId of catalogProjectIds) {
    if (!currentProjectIds.has(projectId)) {
      return false;
    }
  }
  return true;
}

function assertReadableLeaseRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("lease record must be an object");
  }
  if (typeof record.leaseId !== "string" || record.leaseId.trim() === "") {
    throw new Error("lease.leaseId must be a non-empty string");
  }
  if (typeof record.alias !== "string" || record.alias.trim() === "") {
    throw new Error("lease.alias must be a non-empty string");
  }
}

function assertReadablePinRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("pin record must be an object");
  }
  if (typeof record.pinId !== "string" || record.pinId.trim() === "") {
    throw new Error("pin.pinId must be a non-empty string");
  }
  if (typeof record.alias !== "string" || record.alias.trim() === "") {
    throw new Error("pin.alias must be a non-empty string");
  }
}

function setupDoctorStateReadable(paths) {
  try {
    for (const filePath of setupDoctorStateFiles(paths)) {
      const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (path.dirname(filePath) === paths.leasesDir) {
        assertReadableLeaseRecord(record);
      } else if (path.dirname(filePath) === paths.pinsDir) {
        assertReadablePinRecord(record);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function shellQuoteArgument(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function setupRecoveryCommand(paths) {
  return [
    "simbroker",
    "setup",
    "--host-config",
    shellQuoteArgument(paths.hostConfigPath),
    "--state-root",
    shellQuoteArgument(paths.stateRoot),
    "--service-socket",
    shellQuoteArgument(paths.serviceSocketPath),
  ].join(" ");
}

function setupApplyCommand(preview, flags, options) {
  const parts = ["simbroker", "setup", "--apply", "--confirm", shellQuoteArgument(preview.planId)];
  for (const [flag, value] of [
    ["ios-version", options.iosVersion],
    ["host-id", options.hostId],
    ["host-config", flagValue(flags, "host-config")],
    ["state-root", flagValue(flags, "state-root")],
    ["service-socket", flagValue(flags, "service-socket")],
  ]) {
    if (value !== null) {
      parts.push(`--${flag}`, shellQuoteArgument(value));
    }
  }
  return parts.join(" ");
}

function setupInterruptedError(signalName, completedStages, hostCommitted, failedStage, recoveryCommand) {
  return new BrokerError("Setup was interrupted.", {
    command: "setup",
    completedStages,
    exitCode: signalName === "SIGTERM" ? 143 : 130,
    failedStage,
    hostCommitted,
    reasonCode: "setup-interrupted",
    recoveryCommand,
  });
}

function assertSetupCommittedHostIdentity(snapshot, expectedHostIdentity) {
  const expectedSimulatorIds = new Map(
    (expectedHostIdentity?.simulators ?? []).map(({ alias, simulatorId }) => [alias, simulatorId]),
  );
  const actualSimulatorIds = new Map(
    (snapshot.simulators ?? []).map(({ alias, simulatorId }) => [alias, simulatorId]),
  );
  const mismatchedSimulatorAliases = [...new Set([
    ...expectedSimulatorIds.keys(),
    ...actualSimulatorIds.keys(),
  ])]
    .filter((alias) => actualSimulatorIds.get(alias) !== expectedSimulatorIds.get(alias))
    .sort();
  if (snapshot.hostId !== expectedHostIdentity?.hostId || mismatchedSimulatorAliases.length > 0) {
    throw new BrokerError("The refreshed snapshot no longer matches the host committed by setup.", {
      actualHostId: snapshot.hostId ?? null,
      expectedHostId: expectedHostIdentity?.hostId ?? null,
      mismatchedSimulatorAliases,
      reasonCode: "setup-committed-host-mismatch",
    });
  }
}

function decorateSetupFailure(error, stage, completedStages, hostCommitted, serviceRunning, recoveryCommand) {
  if (error instanceof BrokerError) {
    error.payload.command = "setup";
    error.payload.completedStages ??= completedStages;
    error.payload.failedStage ??= stage;
    error.payload.hostCommitted ??= hostCommitted;
    error.payload.recoveryCommand = recoveryCommand;
    error.payload.serviceRunning ??= serviceRunning;
    return error;
  }
  return new BrokerError(error?.message ?? String(error), {
    command: "setup",
    completedStages,
    failedStage: stage,
    hostCommitted,
    reasonCode: INTERNAL_ERROR_REASON_CODE,
    recoveryCommand,
    serviceRunning,
  });
}

async function applySetup(paths, options, cancellation) {
  const completedStages = ["preflight", "confirmation"];
  const recoveryCommand = setupRecoveryCommand(paths);
  let activeStage = "provisioning";
  let hostCommitted = fs.existsSync(paths.hostConfigPath);
  let serviceRunning = false;
  const checkCancellation = () => {
    if (cancellation.signalName !== null) {
      throw setupInterruptedError(
        cancellation.signalName,
        completedStages,
        hostCommitted,
        activeStage,
        recoveryCommand,
      );
    }
  };

  let coreResult;
  try {
    checkCancellation();
    coreResult = await applySetupBrokerInWorker(paths, {
      confirmPlanId: options.confirmPlanId,
      hostId: options.hostId ?? undefined,
      iosVersion: options.iosVersion ?? undefined,
    }, cancellation);
    hostCommitted = true;
    completedStages.push("host", "devices", "registry");
  } catch (error) {
    throw decorateSetupFailure(error, "provisioning", completedStages, fs.existsSync(paths.hostConfigPath), false, recoveryCommand);
  }

  let serviceResult;
  activeStage = "service-start";
  try {
    checkCancellation();
    serviceResult = await startService(paths, { signal: cancellation.signal });
    checkCancellation();
    serviceRunning = true;
    completedStages.push("service");
  } catch (error) {
    checkCancellation();
    throw decorateSetupFailure(error, "service-start", completedStages, hostCommitted, false, recoveryCommand);
  }

  let snapshot;
  activeStage = "snapshot-refresh";
  try {
    checkCancellation();
    snapshot = await executeServiceCommand(paths, {
      command: "snapshot",
      group: "app",
      options: { eventLimit: 50 },
      type: "command",
    }, {
      expectedServiceIdentity: serviceResult.service,
      signal: cancellation.signal,
    });
    checkCancellation();
    if (path.resolve(snapshot.hostConfigPath) !== path.resolve(paths.hostConfigPath)
      || path.resolve(snapshot.stateRoot) !== path.resolve(paths.stateRoot)) {
      throw new BrokerError("The refreshed snapshot belongs to different broker paths.", {
        reasonCode: "service-identity-mismatch",
      });
    }
    const expectedHostIdentity = coreResult.setupCommittedHostIdentity;
    assertSetupCommittedHostIdentity(snapshot, expectedHostIdentity);
    completedStages.push("snapshot");
  } catch (error) {
    checkCancellation();
    throw decorateSetupFailure(error, "snapshot-refresh", completedStages, hostCommitted, serviceRunning, recoveryCommand);
  }

  let health;
  activeStage = "health";
  try {
    checkCancellation();
    health = await executeServiceCommand(paths, {
      command: "status",
      group: "doctor",
      options: {},
      type: "command",
    }, {
      expectedServiceIdentity: serviceResult.service,
      signal: cancellation.signal,
    });
    checkCancellation();
    const postDoctorSnapshot = JSON.parse(fs.readFileSync(paths.appSnapshotPath, "utf8"));
    if (path.resolve(postDoctorSnapshot.hostConfigPath) !== path.resolve(paths.hostConfigPath)
      || path.resolve(postDoctorSnapshot.stateRoot) !== path.resolve(paths.stateRoot)) {
      throw new BrokerError("The post-doctor snapshot belongs to different broker paths.", {
        reasonCode: "service-identity-mismatch",
      });
    }
    assertSetupCommittedHostIdentity(postDoctorSnapshot, coreResult.setupCommittedHostIdentity);
    const postDoctorHealth = inspectSetupPostDoctorSnapshot(postDoctorSnapshot, {
      requireStarterAliases: coreResult.host.created === true,
    });
    if (!health.ok || !postDoctorHealth.ok) {
      const snapshotIssues = postDoctorHealth.unhealthyAliases.map((simulator) => ({
        alias: simulator.alias,
        health: simulator.health ?? "repair-needed",
        reasonCode: "alias-unhealthy",
      }));
      const doctorIssues = (health.issues ?? []).length > 0 ? health.issues : snapshotIssues;
      const unhealthyIssue = doctorIssues.some((issue) => issue.alias);
      throw new BrokerError("Broker health verification failed after setup.", {
        doctorIssues,
        exitCode: unhealthyIssue ? BROKER_EXIT_CODES.repairNeeded : BROKER_EXIT_CODES.unavailable,
        missingExpectedAliases: postDoctorHealth.missingExpectedAliases,
        reasonCode: "setup-health-check-failed",
      });
    }
    completedStages.push("health");
  } catch (error) {
    checkCancellation();
    throw decorateSetupFailure(error, "health", completedStages, hostCommitted, serviceRunning, recoveryCommand);
  }

  const { setupCommittedHostIdentity: _setupCommittedHostIdentity, ...publicCoreResult } = coreResult;
  return {
    ...publicCoreResult,
    health: { issueCount: 0, ok: true },
    nextSteps: [],
    service: {
      identityVerified: true,
      running: true,
      started: serviceResult.started === true,
    },
    snapshot: { ready: true },
  };
}

async function promptForSetupConfirmation() {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question("Create or adopt these 6 Simulator devices and finish setup? [y/N] ");
    return /^y(?:es)?$/i.test(answer.trim());
  } catch {
    return false;
  } finally {
    readline.close();
  }
}

async function runSetup(paths, flags) {
  const options = setupOptions(flags);
  const preview = await buildSetupPreview(paths, options);
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && !wantsJson();
  const recoveryCommand = setupRecoveryCommand(paths);

  if (options.apply && !options.confirmPlanId) {
    throw new BrokerError("Setup apply requires the current plan confirmation.", {
      command: "setup",
      currentPlanId: preview.planId,
      failedStage: "confirmation",
      reasonCode: "setup-confirmation-required",
      recoveryCommand,
    });
  }

  if (preview.status === "blocked") {
    if (options.apply) {
      const blocker = preview.prerequisites.find((prerequisite) => prerequisite.status === "blocked");
      throw new BrokerError("Setup prerequisites are not ready.", {
        blockerReasonCode: blocker?.details?.reasonCode ?? blocker?.id ?? null,
        command: "setup",
        failedStage: "preflight",
        prerequisites: preview.prerequisites,
        reasonCode: "setup-prerequisite-failed",
        recoveryCommand,
      });
    }
    return preview;
  }

  if (!options.apply) {
    if (wantsJson()) {
      return preview;
    }
    if (!interactive) {
      return {
        ...preview,
        confirmation: {
          ...preview.confirmation,
          applyCommand: setupApplyCommand(preview, flags, options),
        },
      };
    }
    if (!preview.confirmation.required) {
      if (preview.status === "ready") {
        return preview;
      }
      options.apply = true;
      options.confirmPlanId = preview.planId;
    } else {
      process.stdout.write(format(preview, { json: false }));
      if (!await promptForSetupConfirmation()) {
        return {
          command: "setup",
          mode: "preview",
          ok: true,
          schemaVersion: 1,
          status: "cancelled",
        };
      }
      options.apply = true;
      options.confirmPlanId = preview.planId;
    }
  }

  const cancellationController = new AbortController();
  const cancellation = {
    requestProvisioningCancellation: null,
    signal: cancellationController.signal,
    signalName: null,
  };
  const recordSignal = (signalName) => {
    if (cancellation.signalName !== null) {
      return;
    }
    cancellation.signalName = signalName;
    cancellationController.abort(new Error(`Setup received ${signalName}.`));
    cancellation.requestProvisioningCancellation?.(signalName);
  };
  const handleSigint = () => recordSignal("SIGINT");
  const handleSigterm = () => recordSignal("SIGTERM");
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
  try {
    return await applySetup(paths, options, cancellation);
  } finally {
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);
  }
}

const invocation = parseArgs(process.argv.slice(2));

function wantsJson() {
  return invocation.flags.has("json");
}

async function main() {
  const { flags, positionals } = invocation;
  rejectExtraPositionals(positionals);
  const [group, command] = positionals;
  if (group === "setup" && command === undefined && !flags.has("help")) {
    rejectUnknownSetupFlags(flags);
  }
  const paths = buildPaths(flags);

  if (flags.has("help") || group === "help" || command === "help") {
    const request = createCommandRequest(paths, group, command, flags);
    return runServiceAwareRequest(paths, request);
  }

  if (group === "host" && command === "init") {
    const initOptions = hostInitOptions(flags);
    if (initOptions.bootstrapConfig === true) {
      const configExists = fs.existsSync(paths.hostConfigPath);
      if (configExists === false || initOptions.force === true) {
        process.stderr.write(`${HOST_BOOTSTRAP_DEVICE_WARNING}\n`);
      }
    }
  }

  if (group === "setup" && command === undefined) {
    return runSetup(paths, flags);
  }

  switch (`${group ?? ""}:${command ?? ""}`) {
    case "service:start":
      rejectUnknownServiceControlFlags(flags);
      return appendTransport(await startService(paths), "service-control");
    case "service:status":
      rejectUnknownServiceControlFlags(flags);
      return appendTransport(await serviceStatus(paths), "service-control");
    case "service:stop":
      rejectUnknownServiceControlFlags(flags);
      return appendTransport(await stopService(paths), "service-control");
    default: {
      const request = createCommandRequest(paths, group, command, flags);
      return runServiceAwareRequest(paths, request);
    }
  }
}

main()
  .then((payload) => {
    if (payload?.handled) {
      return;
    }
    process.stdout.write(format({
      ok: true,
      ...payload,
    }, { json: wantsJson() }));
  })
  .catch((error) => {
    if (error instanceof BrokerError) {
      const setupInvocation = invocation.positionals[0] === "setup";
      let recoveryCommand = "simbroker setup";
      if (setupInvocation) {
        try {
          recoveryCommand = setupRecoveryCommand(buildPaths(invocation.flags));
        } catch {
          recoveryCommand = "simbroker setup";
        }
      }
      const payload = setupInvocation
        ? {
            command: "setup",
            failedStage: "arguments",
            recoveryCommand,
            ...error.payload,
          }
        : error.payload;
      process.stdout.write(format(payload, { json: wantsJson() || !setupInvocation }));
      process.exit(error.exitCode);
      return;
    }
    if (typeof error?.reasonCode === "string") {
      const exitCode = error.exitCode ?? resolveBrokerExitCode(error.reasonCode);
      process.stdout.write(format({
        error: error?.message ?? String(error),
        exitCode,
        ok: false,
        reasonCode: error.reasonCode,
      }, { json: true }));
      process.exit(exitCode);
      return;
    }

    process.stdout.write(format({
      error: error?.message ?? String(error),
      exitCode: BROKER_EXIT_CODES.internal,
      ok: false,
      reasonCode: INTERNAL_ERROR_REASON_CODE,
      stack: error?.stack ?? null,
    }, { json: true }));
    process.exit(BROKER_EXIT_CODES.internal);
  });
