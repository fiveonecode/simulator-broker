import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import url from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import {
  BROKER_EXIT_CODES,
  INTERNAL_ERROR_REASON_CODE,
  resolveBrokerExitCode,
  resolveBrokerHttpStatus,
} from "../../broker-core/error-contract.mjs";
import { defaultProcessSampler } from "../../broker-core/containment.mjs";
import {
  BrokerError,
  appSnapshotBrokerUnderMutationLock,
  readEventsBroker,
  reconcileIdleBroker,
  writeAppSnapshotArtifactUnderMutationLock,
} from "../../broker-core/index.mjs";
import { executeBrokerCommand, streamEventsLocal } from "../command-dispatch.mjs";
import { serviceCommandExecutionTimeoutMs } from "./service-client.mjs";

const SERVICE_REQUEST_BODY_TIMEOUT_MS = 30_000;
const SERVICE_COMMAND_BODY_MAX_BYTES = 64 * 1024;
const SERVICE_LOCK_OWNER_PID_IDENTITY_TOLERANCE_MS = 15_000;
const IDLE_RECONCILE_INTERVAL_MS = 30_000;
const LEASE_MUTATION_LOCK_BUSY_REASON_CODE = "alias-busy";

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(filePath), 0o700);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function ensurePrivateDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirPath, 0o700);
}

function removeIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sleepSync(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function parseProcessElapsedMilliseconds(elapsed) {
  const rawValue = String(elapsed ?? "").trim();
  if (!rawValue) {
    return null;
  }
  let days = 0;
  let timePortion = rawValue;
  if (rawValue.includes("-")) {
    const [dayPortion, trailing] = rawValue.split("-", 2);
    if (!/^\d+$/.test(dayPortion)) {
      return null;
    }
    days = Number(dayPortion);
    timePortion = trailing;
  }
  const parts = timePortion.split(":");
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => /^\d+$/.test(part) === false)) {
    return null;
  }
  const values = parts.map(Number);
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (values.length === 3) {
    [hours, minutes, seconds] = values;
  } else if (values.length === 2) {
    [minutes, seconds] = values;
  } else {
    [seconds] = values;
  }
  return ((((days * 24) + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function serviceLockProcessRecordLooksDefunct(processRecord) {
  return String(processRecord?.stat ?? "").includes("Z")
    || String(processRecord?.command ?? "").includes("<defunct>");
}

function serviceLockProcessLifetimeMatches(processRecord, startedAtValue, observedAtValue) {
  const startedAt = Date.parse(startedAtValue ?? "");
  const observedAt = Date.parse(typeof observedAtValue === "string"
    ? observedAtValue
    : new Date(observedAtValue ?? Date.now()).toISOString());
  const elapsedMilliseconds = parseProcessElapsedMilliseconds(processRecord?.elapsed);
  if (!Number.isFinite(startedAt)
    || !Number.isFinite(observedAt)
    || elapsedMilliseconds === null
    || observedAt < startedAt) {
    return null;
  }
  return elapsedMilliseconds + SERVICE_LOCK_OWNER_PID_IDENTITY_TOLERANCE_MS >= observedAt - startedAt;
}

function serviceLockOwnerProcessIsLive(owner, {
  observedAt,
  processExists: processExistsFn = processExists,
  processSampler = defaultProcessSampler,
} = {}) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || processExistsFn(owner.pid) !== true) {
    return false;
  }
  if (typeof processSampler !== "function") {
    return true;
  }
  let processRecords;
  try {
    processRecords = processSampler();
  } catch {
    return true;
  }
  if (!Array.isArray(processRecords)) {
    return true;
  }
  const processRecord = processRecords.find((record) => record?.pid === owner.pid);
  if (!processRecord || serviceLockProcessRecordLooksDefunct(processRecord)) {
    return false;
  }
  const lifetimeMatches = serviceLockProcessLifetimeMatches(processRecord, owner.startedAt, observedAt);
  return lifetimeMatches !== false;
}

function removeLockIfOwned(lockDir, ownerPath, token = null) {
  const owner = readJsonIfExists(ownerPath);
  const tokenMatches = token === null || owner?.token === token;
  if (tokenMatches && (!Number.isInteger(owner?.pid) || owner.pid === process.pid)) {
    fs.rmSync(lockDir, { force: true, recursive: true });
  }
}

function readPathIdentity(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return {
      birthtimeMs: stats.birthtimeMs,
      dev: stats.dev,
      ino: stats.ino,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function samePathIdentity(left, right) {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

function readPathTimestampMs(lockDir, ownerPath) {
  try {
    if (fs.existsSync(ownerPath)) {
      return fs.statSync(ownerPath).mtimeMs;
    }
    return fs.statSync(lockDir).mtimeMs;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function readServiceLockSnapshot(paths, timeoutMs, options = {}) {
  const owner = readJsonIfExists(paths.serviceLockOwnerPath);
  const hasOwnerPid = Number.isInteger(owner?.pid) && owner.pid > 0;
  const ownerLive = hasOwnerPid && serviceLockOwnerProcessIsLive(owner, {
    observedAt: options.observedAt ?? new Date().toISOString(),
    processExists: options.processExists,
    processSampler: options.processSampler,
  });
  const timestampMs = readPathTimestampMs(paths.serviceLockDir, paths.serviceLockOwnerPath);
  const lockIdentity = readPathIdentity(paths.serviceLockDir);
  return {
    abandonedOwner: timestampMs !== null && !hasOwnerPid && Date.now() - timestampMs > timeoutMs,
    hasOwnerPid,
    lockIdentity,
    owner,
    released: timestampMs === null || lockIdentity === null,
    staleOwner: hasOwnerPid && !ownerLive,
    timestampMs,
  };
}

function writeServiceLockReclaimMarker(markerPath, token) {
  const fd = fs.openSync(markerPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token,
    })}\n`);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(markerPath, 0o600);
  return { markerPath, token };
}

function restoreClaimedServiceLockReclaimMarker(claimedMarkerPath, markerPath) {
  try {
    fs.linkSync(claimedMarkerPath, markerPath);
  } catch (error) {
    if (error?.code !== "EEXIST" && error?.code !== "ENOENT") {
      throw error;
    }
  } finally {
    removeIfExists(claimedMarkerPath);
  }
}

function acquireServiceLockReclaimMarker(lockDir, timeoutMs) {
  const markerPath = path.join(lockDir, "reclaiming.json");
  const token = crypto.randomUUID();
  try {
    return writeServiceLockReclaimMarker(markerPath, token);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    if (error?.code === "EEXIST") {
      const markerTimestampMs = readPathTimestampMs(lockDir, markerPath);
      const markerIdentity = readPathIdentity(markerPath);
      if (markerTimestampMs === null || markerIdentity === null || Date.now() - markerTimestampMs <= timeoutMs) {
        return null;
      }
      const claimedMarkerPath = `${markerPath}.${process.pid}.${token}.stale`;
      try {
        fs.renameSync(markerPath, claimedMarkerPath);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") {
          return null;
        }
        throw renameError;
      }
      const claimedMarkerIdentity = readPathIdentity(claimedMarkerPath);
      if (!samePathIdentity(markerIdentity, claimedMarkerIdentity)) {
        restoreClaimedServiceLockReclaimMarker(claimedMarkerPath, markerPath);
        return null;
      }
      try {
        return writeServiceLockReclaimMarker(markerPath, token);
      } catch (claimError) {
        if (claimError?.code === "ENOENT" || claimError?.code === "EEXIST") {
          return null;
        }
        throw claimError;
      } finally {
        removeIfExists(claimedMarkerPath);
      }
    }
    throw error;
  }
}

function removeServiceLockReclaimMarkerIfOwned(marker) {
  const owner = readJsonIfExists(marker.markerPath);
  if (owner?.token === marker.token) {
    removeIfExists(marker.markerPath);
  }
}

function reclaimStaleServiceLock(paths, previousSnapshot, timeoutMs, options = {}) {
  const marker = acquireServiceLockReclaimMarker(paths.serviceLockDir, timeoutMs);
  if (marker === null) {
    return false;
  }

  let removed = false;
  try {
    const latestSnapshot = readServiceLockSnapshot(paths, timeoutMs, options);
    if (latestSnapshot.released) {
      return true;
    }
    const stillAbandonedWithoutOwner = !latestSnapshot.hasOwnerPid
      && !previousSnapshot.hasOwnerPid
      && samePathIdentity(latestSnapshot.lockIdentity, previousSnapshot.lockIdentity)
      && previousSnapshot.timestampMs !== null
      && Date.now() - previousSnapshot.timestampMs > timeoutMs;
    if (latestSnapshot.staleOwner || latestSnapshot.abandonedOwner || stillAbandonedWithoutOwner) {
      removed = true;
      fs.rmSync(paths.serviceLockDir, { force: true, recursive: true });
      return true;
    }
    return false;
  } finally {
    if (!removed) {
      removeServiceLockReclaimMarkerIfOwned(marker);
    }
  }
}

export function acquireServiceStartLock(paths, {
  pollMs = 25,
  processExists: processExistsFn = processExists,
  processSampler = defaultProcessSampler,
  timeoutMs = 5000,
} = {}) {
  const startedAt = Date.now();
  const token = crypto.randomUUID();
  fs.mkdirSync(path.dirname(paths.serviceLockDir), { recursive: true });
  while (true) {
    try {
      fs.mkdirSync(paths.serviceLockDir);
      fs.chmodSync(paths.serviceLockDir, 0o700);
      writeJsonAtomic(paths.serviceLockOwnerPath, {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        token,
      });
      return token;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const lockSnapshot = readServiceLockSnapshot(paths, timeoutMs, {
        processExists: processExistsFn,
        processSampler,
      });
      if (lockSnapshot.released
        || ((lockSnapshot.staleOwner || lockSnapshot.abandonedOwner)
          && reclaimStaleServiceLock(paths, lockSnapshot, timeoutMs, {
            processExists: processExistsFn,
            processSampler,
          }))) {
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new BrokerError("Timed out waiting for the broker service startup lock.", {
          reasonCode: "service-start-timeout",
          serviceSocketPath: paths.serviceSocketPath,
        });
      }
      sleepSync(pollMs);
    }
  }
}

function probeExistingService(socketPath) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const request = http.request({
      method: "GET",
      path: "/v1/service/status",
      socketPath,
      timeout: 250,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          const payload = body ? JSON.parse(body) : null;
          if (response.statusCode === 200 && payload?.service) {
            finish({
              metadata: payload.service,
              status: "running",
            });
            return;
          }
          finish({
            status: "unavailable",
          });
        } catch (error) {
          finish({
            error,
            status: "unavailable",
          });
        }
      });
    });
    request.on("timeout", () => {
      const timeoutError = new Error("Broker service status probe timed out.");
      timeoutError.code = "ESERVICE_TIMEOUT";
      request.destroy(timeoutError);
      finish({
        error: timeoutError,
        status: "timeout",
      });
    });
    request.on("error", (error) => {
      if (settled) {
        return;
      }
      finish({
        error,
        status: ["ECONNREFUSED", "ENOENT"].includes(error?.code) ? "stale" : "unavailable",
      });
    });
    request.end();
  });
}

function existingServiceUnavailableError(paths, probeResult) {
  return new BrokerError("Broker service socket is already owned by a live or unresponsive process.", {
    cause: probeResult?.error?.message ?? null,
    reasonCode: probeResult?.status === "timeout" ? "service-start-timeout" : "service-unavailable",
    serviceMetadataPath: paths.serviceMetadataPath,
    serviceSocketPath: paths.serviceSocketPath,
  });
}

function normalizedServiceIdentityPath(value) {
  return typeof value === "string" && value.trim() !== "" ? path.resolve(value) : null;
}

function serviceIdentitySnapshot(service) {
  return {
    hostConfigPath: normalizedServiceIdentityPath(service?.hostConfigPath),
    socketPath: normalizedServiceIdentityPath(service?.socketPath),
    stateRoot: normalizedServiceIdentityPath(service?.stateRoot),
  };
}

function assertExpectedServiceIdentity(metadata, expectedServiceIdentity) {
  if (expectedServiceIdentity === undefined || expectedServiceIdentity === null) {
    return;
  }
  if (typeof expectedServiceIdentity !== "object" || Array.isArray(expectedServiceIdentity)) {
    throw new BrokerError("expectedServiceIdentity must be an object when provided.", {
      reasonCode: "invalid-command-request",
    });
  }

  const expected = serviceIdentitySnapshot(expectedServiceIdentity);
  const actual = serviceIdentitySnapshot(metadata);
  const mismatchedFields = Object.keys(expected)
    .sort()
    .filter((field) => actual[field] !== expected[field]);
  if (mismatchedFields.length === 0) {
    return;
  }

  throw new BrokerError("Broker service identity changed before command dispatch.", {
    actual,
    expected,
    mismatchedFields,
    reasonCode: "service-identity-mismatch",
  });
}

function optionalBodyInteger(body, name, { positive = false } = {}) {
  const value = body?.[name];
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = Number(value);
  if (Number.isInteger(parsed) && (positive ? parsed > 0 : parsed >= 0)) {
    return parsed;
  }
  throw new BrokerError(`${name} must be a ${positive ? "positive" : "non-negative"} integer.`, {
    reasonCode: "invalid-command-request",
  });
}

function assertCommandFreshForDispatch(paths, body, nowMilliseconds = Date.now()) {
  const startedAt = optionalBodyInteger(body, "clientRequestStartedAtMilliseconds");
  const queueTimeoutMs = optionalBodyInteger(body, "clientCommandQueueTimeoutMilliseconds", { positive: true });
  const executionTimeoutMs = optionalBodyInteger(body, "clientCommandExecutionTimeoutMilliseconds", { positive: true });
  if (startedAt === null || queueTimeoutMs === null) {
    return;
  }
  const queuedMilliseconds = nowMilliseconds - startedAt;
  if (queuedMilliseconds > queueTimeoutMs) {
    throw new BrokerError("Broker service command expired before dispatch.", {
      queuedMilliseconds,
      queueTimeoutMilliseconds: queueTimeoutMs,
      reasonCode: "service-command-expired",
    });
  }
  if (executionTimeoutMs === null) {
    return;
  }
  const recomputedExecutionTimeoutMs = commandExecutionTimeoutMsForDispatch(paths, body);
  if (recomputedExecutionTimeoutMs <= executionTimeoutMs) {
    return;
  }
  throw new BrokerError("Broker service command expired before dispatch.", {
    executionTimeoutMilliseconds: executionTimeoutMs,
    queuedMilliseconds,
    queueTimeoutMilliseconds: queueTimeoutMs,
    reasonCode: "service-command-expired",
    recomputedExecutionTimeoutMilliseconds: recomputedExecutionTimeoutMs,
  });
}

function commandExecutionTimeoutMsForDispatch(paths, body) {
  return serviceCommandExecutionTimeoutMs(body, {
    paths: dispatchBudgetPaths(paths, body),
  });
}

function dispatchBudgetPaths(paths, body) {
  const requestedProjectFilePath = body?.options?.projectFilePath;
  if (typeof requestedProjectFilePath !== "string" || requestedProjectFilePath.trim() === "") {
    return paths;
  }
  const projectFilePath = path.resolve(requestedProjectFilePath);
  if (typeof paths.projectFilePath === "string" && path.resolve(paths.projectFilePath) === projectFilePath) {
    return paths;
  }
  return {
    ...paths,
    projectFilePath,
  };
}

function parseIntegerQuery(value) {
  if (value === null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function parseNonNegativeIntegerQuery(value, name) {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) {
    return parsed;
  }
  throw new BrokerError(`${name} must be a non-negative integer.`, {
    reasonCode: "invalid-command-request",
  });
}

function parsePositiveIntegerQuery(value, name) {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  throw new BrokerError(`${name} must be a positive integer.`, {
    reasonCode: "invalid-command-request",
  });
}

function eventStreamOptionsFromUrl(requestUrl) {
  return {
    afterEventId: requestUrl.searchParams.get("afterEventId"),
    alias: requestUrl.searchParams.get("alias"),
    follow: requestUrl.searchParams.get("follow") === "true",
    idleTimeoutMs: parseIntegerQuery(requestUrl.searchParams.get("idleTimeoutMs")),
    limit: parseNonNegativeIntegerQuery(requestUrl.searchParams.get("limit"), "limit") ?? undefined,
    pollIntervalMs: parsePositiveIntegerQuery(requestUrl.searchParams.get("pollIntervalMs"), "pollIntervalMs") ?? 250,
    projectId: requestUrl.searchParams.get("projectId"),
    purposeId: requestUrl.searchParams.get("purposeId"),
    type: requestUrl.searchParams.get("type"),
  };
}

function waitForResponseDrain(response, signal) {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (callback, value) => {
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(resolve);
    const onDrain = () => finish(resolve);
    const onError = (error) => finish(reject, error);
    response.once("drain", onDrain);
    response.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function requestBodyError(message) {
  return new BrokerError(message, {
    reasonCode: "invalid-command-request",
  });
}

function parseBody(request, {
  maxBytes = SERVICE_COMMAND_BODY_MAX_BYTES,
  signal = null,
  timeoutMs = SERVICE_REQUEST_BODY_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let settled = false;
    let timeout = null;

    const cleanup = () => {
      request.off("aborted", onAborted);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (timeout !== null) {
        clearTimeout(timeout);
      }
    };
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      finish(reject, requestBodyError("Broker service request body was aborted."));
    };
    const onAborted = () => {
      finish(reject, requestBodyError("Broker service request body was aborted."));
    };
    const onData = (chunk) => {
      bodyBytes += Buffer.byteLength(chunk, "utf8");
      if (bodyBytes > maxBytes) {
        request.pause();
        finish(reject, requestBodyError(`Broker service request body exceeds ${maxBytes} bytes.`));
        return;
      }
      body += chunk;
    };
    const onEnd = () => {
      if (!body) {
        finish(resolve, {});
        return;
      }
      try {
        finish(resolve, JSON.parse(body));
      } catch (error) {
        finish(reject, new BrokerError("Broker service received invalid JSON.", {
          reasonCode: "invalid-json",
        }));
      }
    };
    const onError = (error) => {
      finish(reject, error);
    };
    const onTimeout = () => {
      const error = requestBodyError("Broker service request body timed out.");
      if (!request.destroyed) {
        request.destroy();
      }
      finish(reject, error);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    const rawContentLength = Array.isArray(request.headers["content-length"])
      ? request.headers["content-length"][0]
      : request.headers["content-length"];
    if (rawContentLength !== undefined) {
      const declaredBodyBytes = Number(rawContentLength);
      if (!Number.isInteger(declaredBodyBytes) || declaredBodyBytes < 0) {
        finish(reject, requestBodyError("Broker service request Content-Length must be a non-negative integer."));
        return;
      }
      if (declaredBodyBytes > maxBytes) {
        finish(reject, requestBodyError(`Broker service request body exceeds ${maxBytes} bytes.`));
        return;
      }
    }

    timeout = setTimeout(onTimeout, timeoutMs);
    timeout.unref?.();
    request.setEncoding("utf8");
    request.on("aborted", onAborted);
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function sendJson(response, statusCode, payload, onComplete = undefined) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`, onComplete);
}

function serializeIdleReconciliationError(error) {
  return {
    brokerError: error instanceof BrokerError,
    message: error?.message ?? String(error),
    payload: error instanceof BrokerError ? error.payload : null,
    reasonCode: typeof error?.reasonCode === "string" ? error.reasonCode : null,
    stack: error?.stack ?? null,
  };
}

function deserializeIdleReconciliationError(serialized) {
  if (serialized?.brokerError && serialized.payload) {
    const { error: _error, ...payload } = serialized.payload;
    const brokerError = new BrokerError(serialized.message ?? serialized.payload.error, payload);
    brokerError.stack = serialized.stack ?? brokerError.stack;
    return brokerError;
  }
  const error = new Error(serialized?.message ?? "Scheduled idle reconciliation failed.");
  error.stack = serialized?.stack ?? error.stack;
  if (serialized?.reasonCode) {
    error.reasonCode = serialized.reasonCode;
  }
  return error;
}

function runServiceWorker(workerPayload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./brokerd.mjs", import.meta.url), {
      workerData: workerPayload,
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };
    worker.once("message", (message) => {
      if (message?.ok) {
        finish(resolve, message.result ?? null);
        return;
      }
      finish(reject, deserializeIdleReconciliationError(message?.error));
    });
    worker.once("error", (error) => {
      finish(reject, error);
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        finish(reject, new BrokerError("Broker service worker exited before completion.", {
          exitCode: code,
          reasonCode: "internal-error",
        }));
      }
    });
    worker.unref();
  });
}

function runBrokerCommandWorker(paths, request) {
  return runServiceWorker({
    paths,
    request,
    type: "command",
  });
}

function runAppSnapshotWorker(paths, options) {
  return runServiceWorker({
    options,
    paths,
    type: "app-snapshot",
  });
}

function serviceSnapshotRefreshError(snapshotRefresh) {
  return new BrokerError(snapshotRefresh?.error ?? "Failed to refresh the app snapshot after the command committed.", {
    reasonCode: snapshotRefresh?.reasonCode ?? "internal-error",
  });
}

function shouldSurfaceServiceSnapshotRefreshError(request) {
  return !(request.group === "lease" && request.command === "acquire");
}

function runIdleReconciliationWorker(paths, options, source, { waitForLeaseMutationLock = true } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./brokerd.mjs", import.meta.url), {
      workerData: {
        idleReconcileOptions: options.idleReconcileOptions ?? {},
        idleSnapshotOptions: options.idleSnapshotOptions ?? {},
        paths,
        source,
        type: "idle-reconciliation",
        waitForLeaseMutationLock,
      },
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };
    worker.once("message", (message) => {
      if (message?.ok) {
        finish(resolve, message.result ?? null);
        return;
      }
      finish(reject, deserializeIdleReconciliationError(message?.error));
    });
    worker.once("error", (error) => {
      finish(reject, error);
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        finish(reject, new BrokerError("Scheduled idle reconciliation worker exited before completion.", {
          exitCode: code,
          reasonCode: "internal-error",
        }));
      }
    });
    worker.unref();
  });
}

async function runIdleReconciliationWorkerTask(data) {
  const lockOptions = data.waitForLeaseMutationLock ? {} : { leaseMutationLockWait: false };
  const result = reconcileIdleBroker(data.paths, {
    ...(data.idleReconcileOptions ?? {}),
    ...lockOptions,
    persistNoChanges: false,
    source: data.source,
  });
  writeAppSnapshotArtifactUnderMutationLock(data.paths, {
    ...(data.idleSnapshotOptions ?? {}),
    leaseMutationLockWait: true,
  });
  return result;
}

export async function startBrokerService(paths, options = {}) {
  ensurePrivateDir(paths.stateRoot);
  const startupLockToken = acquireServiceStartLock(paths);
  let startupLockHeld = true;
  const releaseStartupLock = () => {
    if (startupLockHeld) {
      removeLockIfOwned(paths.serviceLockDir, paths.serviceLockOwnerPath, startupLockToken);
      startupLockHeld = false;
    }
  };

  const existingService = await probeExistingService(paths.serviceSocketPath);
  if (existingService.status === "running") {
    releaseStartupLock();
    return {
      metadata: existingService.metadata,
      shutdown: async () => {},
      unchanged: true,
    };
  }
  if (existingService.status !== "stale") {
    releaseStartupLock();
    throw existingServiceUnavailableError(paths, existingService);
  }
  removeIfExists(paths.serviceSocketPath);

  const startedAt = new Date().toISOString();
  const metadata = {
    hostConfigPath: paths.hostConfigPath,
    pid: process.pid,
    socketPath: paths.serviceSocketPath,
    startedAt,
    stateRoot: paths.stateRoot,
    transport: "unix-http",
  };

  const writeSnapshot = options.writeAppSnapshotArtifact ?? writeAppSnapshotArtifactUnderMutationLock;
  const reconcileIdle = options.reconcileIdleBroker ?? reconcileIdleBroker;
  const runScheduledIdleReconciliation = options.runScheduledIdleReconciliation
    ?? (options.writeAppSnapshotArtifact || options.reconcileIdleBroker
      ? async (source, args) => runIdleReconciliation(source, args)
      : (source, args) => runIdleReconciliationWorker(paths, options, source, args));
  const runIdleReconciliation = (source, { waitForLeaseMutationLock = true } = {}) => {
    const lockOptions = waitForLeaseMutationLock ? {} : { leaseMutationLockWait: false };
    const result = reconcileIdle(paths, {
      ...(options.idleReconcileOptions ?? {}),
      ...lockOptions,
      persistNoChanges: false,
      source,
    });
    writeSnapshot(paths, {
      ...(options.idleSnapshotOptions ?? {}),
      leaseMutationLockWait: true,
    });
    return result;
  };

  try {
    runIdleReconciliation("service-startup");
  } catch (error) {
    releaseStartupLock();
    removeIfExists(paths.serviceMetadataPath);
    removeIfExists(paths.serviceSocketPath);
    throw error;
  }

  let shuttingDown = false;
  let server = null;
  let idleReconcileTimer = null;
  let activeIdleReconciliation = null;
  let commandWorkerQueue = Promise.resolve();
  const activeCommandWorkers = new Map();
  const activeConnections = new Set();
  const activeRequests = new Set();
  const activeEventStreams = new Set();
  const runCommandWorker = options.runBrokerCommandWorker
    ?? ((request) => runBrokerCommandWorker(paths, request));

  function trackActiveRequest(request, response) {
    const controller = new AbortController();
    const activeRequest = {
      controller,
      request,
      response,
    };
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      activeRequests.delete(activeRequest);
      request.off("close", cleanup);
      response.off("close", cleanup);
      response.off("finish", cleanup);
    };

    activeRequests.add(activeRequest);
    request.on("close", cleanup);
    response.on("close", cleanup);
    response.on("finish", cleanup);
    return {
      controller,
      cleanup,
    };
  }

  function runSerializedCommandWorker(request) {
    return runSerializedServiceWork(request, () => {
      assertCommandFreshForDispatch(paths, request);
      return runCommandWorker(request);
    });
  }

  function runSerializedIdleReconciliation(source, args) {
    return runSerializedServiceWork(null, () => runScheduledIdleReconciliation(source, args));
  }

  function activeCommandDrainTimeoutMilliseconds(nowMilliseconds = Date.now()) {
    let timeoutMilliseconds = 0;
    for (const activeWorker of activeCommandWorkers.values()) {
      timeoutMilliseconds += Math.max(0, activeWorker.drainDeadlineMilliseconds - nowMilliseconds);
    }
    return Math.max(0, Math.ceil(timeoutMilliseconds));
  }

  function commandDrainDeadlineMilliseconds(request) {
    const executionTimeoutMs = optionalBodyInteger(request, "clientCommandExecutionTimeoutMilliseconds", { positive: true })
      ?? commandExecutionTimeoutMsForDispatch(paths, request);
    return Date.now() + executionTimeoutMs;
  }

  function runSerializedServiceWork(request, work) {
    if (shuttingDown) {
      throw new BrokerError("Broker service is shutting down.", {
        reasonCode: "service-unavailable",
      });
    }
    const priorCommandWorkers = commandWorkerQueue.catch(() => {});
    const commandWorker = priorCommandWorkers.then(work);
    if (request !== null) {
      activeCommandWorkers.set(commandWorker, {
        drainDeadlineMilliseconds: commandDrainDeadlineMilliseconds(request),
      });
    }
    commandWorkerQueue = commandWorker.catch(() => {});
    const forgetCommandWorker = () => {
      activeCommandWorkers.delete(commandWorker);
    };
    commandWorker.then(forgetCommandWorker, forgetCommandWorker);
    return commandWorker;
  }

  async function shutdown({ exitProcess = true } = {}) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (idleReconcileTimer !== null) {
      (options.clearIntervalFn ?? clearInterval)(idleReconcileTimer);
      idleReconcileTimer = null;
    }
    if (activeIdleReconciliation !== null) {
      await activeIdleReconciliation;
    }
    if (activeCommandWorkers.size > 0) {
      await Promise.allSettled([...activeCommandWorkers]);
      await new Promise((resolve) => setImmediate(resolve));
    }
    removeIfExists(paths.serviceMetadataPath);
    for (const stream of activeEventStreams) {
      stream.controller.abort();
      if (!stream.response.writableEnded) {
        stream.response.end();
      }
      if (!stream.response.destroyed) {
        stream.response.destroy();
      }
    }
    for (const activeRequest of activeRequests) {
      activeRequest.controller.abort();
      if (!activeRequest.request.destroyed) {
        activeRequest.request.destroy();
      }
      if (!activeRequest.response.destroyed) {
        activeRequest.response.destroy();
      }
    }
    for (const socket of activeConnections) {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }

    await new Promise((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });

    removeIfExists(paths.serviceSocketPath);
    if (exitProcess) {
      process.exit(0);
    }
  }

  server = http.createServer(async (request, response) => {
    let activeRequest = null;
    try {
      const requestUrl = new url.URL(request.url ?? "/", "http://brokerd.local");
      const isEventStream = request.method === "GET" && requestUrl.pathname === "/v1/events/stream";
      if (!isEventStream) {
        activeRequest = trackActiveRequest(request, response);
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/service/status") {
        sendJson(response, 200, {
          ok: true,
          running: true,
          service: metadata,
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/app/snapshot") {
        const payload = await runAppSnapshotWorker(paths, {
          eventLimit: parseNonNegativeIntegerQuery(requestUrl.searchParams.get("eventLimit"), "eventLimit") ?? 50,
        });
        sendJson(response, 200, {
          ok: true,
          ...payload,
          servedBy: metadata,
        });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v1/command") {
        const body = await parseBody(request, {
          signal: activeRequest?.controller.signal,
        });
        if (body.type === "events-stream") {
          throw new BrokerError("Event streaming requests must use /v1/events/stream.", {
            reasonCode: "invalid-command-request",
          });
        }
        assertExpectedServiceIdentity(metadata, body.expectedServiceIdentity);
        assertCommandFreshForDispatch(paths, body);
        const payload = await runSerializedCommandWorker(body);
        if (payload?.snapshotRefresh?.ok === false && shouldSurfaceServiceSnapshotRefreshError(body)) {
          throw serviceSnapshotRefreshError(payload.snapshotRefresh);
        }
        const serviceMetadata = body.group === "capacity" || body.group === "idle" ? {} : { servedBy: metadata };
        sendJson(response, 200, {
          ok: true,
          ...payload,
          ...serviceMetadata,
        });
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/v1/events/stream") {
        const streamOptions = eventStreamOptionsFromUrl(requestUrl);
        readEventsBroker(paths, {
          afterEventId: streamOptions.afterEventId,
          limit: 0,
        });
        const streamAbort = new AbortController();
        const activeStream = {
          controller: streamAbort,
          response,
        };
        activeEventStreams.add(activeStream);
        const abortStream = () => {
          streamAbort.abort();
        };
        request.on("aborted", abortStream);
        response.on("close", abortStream);
        response.on("error", abortStream);
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/x-ndjson",
        });
        let streamFailed = false;
        try {
          await streamEventsLocal(paths, streamOptions, {
            signal: streamAbort.signal,
            async writeEventLine(event) {
              if (!streamAbort.signal.aborted) {
                const canContinue = response.write(`${JSON.stringify(event)}\n`);
                if (!canContinue) {
                  await waitForResponseDrain(response, streamAbort.signal);
                }
              }
            },
          });
        } catch (error) {
          streamFailed = true;
          if (!streamAbort.signal.aborted && !response.destroyed) {
            response.destroy(error);
          }
        } finally {
          activeEventStreams.delete(activeStream);
          request.off("aborted", abortStream);
          response.off("close", abortStream);
          response.off("error", abortStream);
        }
        if (!streamFailed && !streamAbort.signal.aborted && !response.writableEnded) {
          response.end();
        }
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/v1/service/stop") {
        const body = await parseBody(request, {
          signal: activeRequest?.controller.signal,
        });
        assertExpectedServiceIdentity(metadata, body.expectedServiceIdentity);
        sendJson(response, 200, {
          activeCommandDrainTimeoutMilliseconds: activeCommandDrainTimeoutMilliseconds(),
          ok: true,
          service: metadata,
          stopping: true,
        }, () => {
          setImmediate(() => {
            shutdown({ exitProcess: false }).catch((error) => {
              console.error(error);
              process.exit(1);
            });
          });
        });
        return;
      }

      throw new BrokerError("Broker service route not found.", {
        reasonCode: "route-not-found",
      });
    } catch (error) {
      if (response.destroyed || response.writableEnded) {
        return;
      }
      response.shouldKeepAlive = false;
      if (error instanceof BrokerError) {
        sendJson(response, resolveBrokerHttpStatus(error.payload.reasonCode), error.payload);
        return;
      }
      if (typeof error?.reasonCode === "string") {
        const exitCode = error.exitCode ?? resolveBrokerExitCode(error.reasonCode);
        sendJson(response, resolveBrokerHttpStatus(error.reasonCode), {
          error: error?.message ?? String(error),
          exitCode,
          ok: false,
          reasonCode: error.reasonCode,
        });
        return;
      }

      sendJson(response, 500, {
        error: error?.message ?? String(error),
        exitCode: BROKER_EXIT_CODES.internal,
        ok: false,
        reasonCode: INTERNAL_ERROR_REASON_CODE,
        stack: error?.stack ?? null,
      });
    } finally {
      activeRequest?.cleanup();
    }
  });
  server.on("connection", (socket) => {
    activeConnections.add(socket);
    const cleanup = () => {
      activeConnections.delete(socket);
      socket.off("close", cleanup);
    };
    socket.on("close", cleanup);
    if (shuttingDown) {
      socket.destroy();
    }
  });

  process.on("SIGINT", () => {
    shutdown().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    shutdown().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  });

  process.on("uncaughtException", (error) => {
    console.error(error);
    removeIfExists(paths.serviceMetadataPath);
    removeIfExists(paths.serviceSocketPath);
    releaseStartupLock();
    process.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    console.error(error);
    removeIfExists(paths.serviceMetadataPath);
    removeIfExists(paths.serviceSocketPath);
    releaseStartupLock();
    process.exit(1);
  });

  return new Promise((resolve, reject) => {
    let umaskRestored = false;
    const previousUmask = process.umask(0o177);
    const restoreUmask = () => {
      if (!umaskRestored) {
        process.umask(previousUmask);
        umaskRestored = true;
      }
    };
    server.once("error", (error) => {
      restoreUmask();
      releaseStartupLock();
      reject(error);
    });
    server.listen(paths.serviceSocketPath, () => {
      restoreUmask();
      fs.chmodSync(paths.serviceSocketPath, 0o600);
      writeJsonAtomic(paths.serviceMetadataPath, metadata);
      idleReconcileTimer = (options.setIntervalFn ?? setInterval)(() => {
        if (activeIdleReconciliation !== null || shuttingDown) {
          return;
        }
        const scheduledIdleReconciliation = runSerializedIdleReconciliation("service-timer", {
          waitForLeaseMutationLock: false,
        }).catch((error) => {
          if (error instanceof BrokerError && error.payload?.reasonCode === LEASE_MUTATION_LOCK_BUSY_REASON_CODE) {
            return;
          }
          (options.onIdleReconcileError ?? console.error)(error);
        }).finally(() => {
          if (activeIdleReconciliation === scheduledIdleReconciliation) {
            activeIdleReconciliation = null;
          }
        });
        activeIdleReconciliation = scheduledIdleReconciliation;
      }, IDLE_RECONCILE_INTERVAL_MS);
      idleReconcileTimer?.unref?.();
      releaseStartupLock();
      resolve({
        metadata,
        shutdown,
      });
    });
  });
}

if (!isMainThread && workerData?.type === "idle-reconciliation") {
  runIdleReconciliationWorkerTask(workerData)
    .then((result) => {
      parentPort?.postMessage({ ok: true, result });
    })
    .catch((error) => {
      parentPort?.postMessage({
        error: serializeIdleReconciliationError(error),
        ok: false,
      });
    });
}

if (!isMainThread && workerData?.type === "command") {
  Promise.resolve()
    .then(() => executeBrokerCommand(workerData.paths, workerData.request))
    .then((result) => {
      parentPort?.postMessage({ ok: true, result });
    })
    .catch((error) => {
      parentPort?.postMessage({
        error: serializeIdleReconciliationError(error),
        ok: false,
      });
    });
}

if (!isMainThread && workerData?.type === "app-snapshot") {
  Promise.resolve()
    .then(() => appSnapshotBrokerUnderMutationLock(workerData.paths, workerData.options ?? {}))
    .then((result) => {
      parentPort?.postMessage({ ok: true, result });
    })
    .catch((error) => {
      parentPort?.postMessage({
        error: serializeIdleReconciliationError(error),
        ok: false,
      });
    });
}
