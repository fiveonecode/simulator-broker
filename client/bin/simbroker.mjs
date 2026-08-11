#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { BROKER_EXIT_CODES, INTERNAL_ERROR_REASON_CODE, resolveBrokerExitCode } from "../../broker-core/error-contract.mjs";
import { BrokerError, idlePolicyConfiguredBroker, resolveBrokerPaths } from "../../broker-core/index.mjs";
import {
  createCommandRequest,
  executeBrokerCommand,
  flagValue,
  format,
  parseArgs,
  streamEventsLocal,
} from "../command-dispatch.mjs";
import {
  executeServiceCommand,
  probeService,
  requestServiceStop,
  serviceCommandTimeoutMs,
  serviceStartupTimeoutMs,
  streamServiceEvents,
} from "../service/service-client.mjs";

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

function serviceStartupLockHeld(paths) {
  return fs.existsSync(paths.serviceLockDir);
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

async function waitForSpawnedService(paths, child, { timeoutMs = 5000 } = {}) {
  const startedAt = Date.now();
  const childExit = observeChildExit(child);
  while (Date.now() - startedAt < timeoutMs) {
    const outcome = await Promise.race([
      probeService(paths, { timeoutMs: 250 }).then((probe) => ({ probe })),
      childExit.then((exit) => ({ exit })),
    ]);
    if (outcome.exit) {
      const probe = await probeService(paths, { timeoutMs: 250 });
      if (probe) {
        return {
          childExit: null,
          probe,
        };
      }
      if (serviceStartupLockHeld(paths)) {
        await sleep(100);
        continue;
      }
      return {
        childExit: outcome.exit,
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
    ]);
    if (delay) {
      const probe = await probeService(paths, { timeoutMs: 250 });
      if (probe) {
        return {
          childExit: null,
          probe,
        };
      }
      if (serviceStartupLockHeld(paths)) {
        await sleep(100);
        continue;
      }
      return {
        childExit: delay,
        probe: null,
      };
    }
  }
  return {
    childExit: null,
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

async function startService(paths) {
  const running = await probeService(paths);
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

  const { childExit, probe } = await waitForSpawnedService(paths, child, { timeoutMs: serviceStartupTimeoutMs({ paths }) });
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

  const stopped = await waitForServiceToStop(paths);
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
  const canUseService = !localOnlyMode(process.env);
  let service = canUseService
    ? await probeService(paths, { timeoutMs: serviceCommandTimeoutMs(request) })
    : null;

  if (!service
    && canUseService
    && request.group === "lease"
    && request.command === "acquire"
    && idlePolicyConfiguredBroker(paths)) {
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
      const configured = typeof payload.configured === "boolean"
        ? payload.configured
        : idlePolicyConfiguredBroker(paths);
      if (request.group === "idle" || configured) {
        result.scheduler = {
          active: configured,
          limitation: null,
        };
      }
    }
    return result;
  }

  const payload = appendTransport(executeBrokerCommand(paths, request), "direct");
  let schedulerRunning = false;
  if (canUseService
    && request.group === "lease"
    && request.command === "acquire"
    && idlePolicyConfiguredBroker(paths)) {
    await startService(paths);
    schedulerRunning = true;
  }
  if (requestMayReportScheduler(request)) {
    const configured = request.group === "idle" && typeof payload.configured === "boolean"
      ? payload.configured
      : idlePolicyConfiguredBroker(paths);
    if (request.group === "idle" || configured) {
      payload.scheduler = {
        active: schedulerRunning,
        limitation: localOnlyMode(process.env)
          ? "local-only-mode"
          : (configured && !schedulerRunning ? "service-not-running" : null),
      };
    }
  }
  return payload;
}

async function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  rejectExtraPositionals(positionals);
  const [group, command] = positionals;
  const paths = buildPaths(flags);

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
    }));
  })
  .catch((error) => {
    if (error instanceof BrokerError) {
      process.stdout.write(format(error.payload));
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
      }));
      process.exit(exitCode);
      return;
    }

    process.stdout.write(format({
      error: error?.message ?? String(error),
      exitCode: BROKER_EXIT_CODES.internal,
      ok: false,
      reasonCode: INTERNAL_ERROR_REASON_CODE,
      stack: error?.stack ?? null,
    }));
    process.exit(BROKER_EXIT_CODES.internal);
  });
