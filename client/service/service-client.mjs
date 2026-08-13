import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import {
  DEFAULT_CONTAINMENT_POST_KILL_WAIT_MS,
  DEFAULT_CONTAINMENT_TERM_WAIT_MS,
  PROCESS_SAMPLER_TIMEOUT_MS,
  STALE_CONTAINMENT_PROCESS_SAMPLER_INVOCATIONS,
  leaseHasContainmentProcessMetadata,
} from "../../broker-core/containment.mjs";
import { BrokerError } from "../../broker-core/index.mjs";
import { SIMCTL_COMMAND_TIMEOUT_MS } from "../../broker-core/simctl.mjs";

const DEFAULT_COMMAND_TIMEOUT_MS = 25_000;
const DEFAULT_COMMAND_QUEUE_TIMEOUT_MS = 60_000;
const CONTAINMENT_DIAGNOSTIC_TIMEOUT_MS = 20_000;
const CAPACITY_APPLY_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const DEFAULT_RESET_SETTLE_MS = 250;
const SIMCTL_INVENTORY_COMMANDS_PER_STATE_LOAD = 3;
const PROCESS_SAMPLER_INVOCATIONS_PER_STATE_LOAD = 1;
const SERVICE_STARTUP_LAUNCHER_OVERHEAD_MS = 5_000;
const SERVICE_STARTUP_LOCK_PROCESS_SAMPLER_INVOCATIONS = 2;
const SERVICE_STARTUP_STATE_LOADS = 2;
const SERVICE_STARTUP_LEASE_LOCK_WAITS = 2;
const LEASE_ACQUIRE_SIMCTL_COMMANDS = 4;
const CAPACITY_APPLY_PLAN_EVALUATIONS = 2;
const CAPACITY_APPLY_FINALIZATION_STATE_LOADS = 1;
const CAPACITY_APPLY_FINAL_SNAPSHOT_STATE_LOADS = 1;
const CAPACITY_SIMCTL_COMMANDS_PER_ACTION = SIMCTL_INVENTORY_COMMANDS_PER_STATE_LOAD + 1;
const CAPACITY_ROLLBACK_INVENTORY_COMMANDS = SIMCTL_INVENTORY_COMMANDS_PER_STATE_LOAD;
const CAPACITY_ROLLBACK_SIMCTL_COMMANDS_PER_ACTION = SIMCTL_INVENTORY_COMMANDS_PER_STATE_LOAD + 1;
const HOST_BOOTSTRAP_ALIAS_COUNT = 6;
const HOST_BOOTSTRAP_BASELINE_STATE_LOADS = 1;
const HOST_BOOTSTRAP_REPLACEMENT_STATE_LOADS = 1;
const HOST_BOOTSTRAP_RETIREMENT_STATE_LOADS = 1;
const HOST_BOOTSTRAP_SIMCTL_COMMANDS_PER_ALIAS = SIMCTL_INVENTORY_COMMANDS_PER_STATE_LOAD + 2;
const SIMULATOR_LIFECYCLE_SIMCTL_COMMANDS = {
  boot: 2,
  erase: 2,
  repair: 10,
  shutdown: 1,
};

function positiveDurationMs(value, fallbackMs = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

function nonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function nonNegativeDurationMs(value, fallbackMs = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallbackMs;
}

function leaseLockTimeoutMs(request) {
  return positiveDurationMs(request?.options?.leaseLockTimeoutMilliseconds, DEFAULT_LOCK_TIMEOUT_MS);
}

function capacityLockTimeoutMs(request) {
  return positiveDurationMs(request?.options?.capacityLockTimeoutMilliseconds, DEFAULT_LOCK_TIMEOUT_MS);
}

function commandQueueTimeoutMs(request) {
  return positiveDurationMs(request?.options?.serviceCommandQueueTimeoutMilliseconds, DEFAULT_COMMAND_QUEUE_TIMEOUT_MS);
}

function containmentTermWaitMs(request) {
  return positiveDurationMs(request?.options?.termWaitMs);
}

function staleContainmentTermWaitMs(request) {
  return nonNegativeDurationMs(request?.options?.termWaitMs, DEFAULT_CONTAINMENT_TERM_WAIT_MS);
}

function readJsonIfPresent(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function staleContainmentLeaseCountFromPaths(paths) {
  const leasesDir = paths?.leasesDir
    ?? (typeof paths?.stateRoot === "string" ? path.join(paths.stateRoot, "leases") : null);
  if (!leasesDir || !fs.existsSync(leasesDir)) {
    return 0;
  }
  let count = 0;
  for (const entry of fs.readdirSync(leasesDir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const lease = readJsonIfPresent(path.join(leasesDir, entry));
    if (lease && leaseHasContainmentProcessMetadata(lease)) {
      count += 1;
    }
  }
  return count;
}

function pendingRetirementCountFromPaths(paths) {
  const hostConfig = readJsonIfPresent(paths?.hostConfigPath);
  return Array.isArray(hostConfig?.pendingRetirements) ? hostConfig.pendingRetirements.length : 0;
}

function hostBootstrapRetirementCountFromPaths(paths) {
  const hostConfig = readJsonIfPresent(paths?.hostConfigPath);
  if (!hostConfig) {
    return 0;
  }
  const simulatorIds = new Set();
  for (const alias of Array.isArray(hostConfig.aliases) ? hostConfig.aliases : []) {
    if (typeof alias?.simulatorId === "string" && alias.simulatorId.trim() !== "") {
      simulatorIds.add(alias.simulatorId);
    }
  }
  for (const simulatorId of Array.isArray(hostConfig.pendingRetirements) ? hostConfig.pendingRetirements : []) {
    if (typeof simulatorId === "string" && simulatorId.trim() !== "") {
      simulatorIds.add(simulatorId);
    }
  }
  return simulatorIds.size;
}

function hostAliasCountFromPaths(paths, fallback = HOST_BOOTSTRAP_ALIAS_COUNT) {
  const hostConfig = readJsonIfPresent(paths?.hostConfigPath);
  return Array.isArray(hostConfig?.aliases) ? hostConfig.aliases.length : fallback;
}

function selectedCapacityPurposeCountFromPaths(paths, request) {
  const projectConfig = readJsonIfPresent(paths?.projectFilePath);
  const purposes = Array.isArray(projectConfig?.purposes) ? projectConfig.purposes : [];
  if (purposes.length === 0) {
    return 1;
  }
  const requestedPurpose = request?.options?.purposeId;
  if (typeof requestedPurpose === "string" && requestedPurpose.trim() !== "") {
    return purposes.some((purpose) => purpose?.id === requestedPurpose) ? 1 : purposes.length;
  }
  return purposes.length;
}

function nonTerminalCapacityRecoveryWorkload(paths) {
  if (!paths?.capacityTransactionsDir || !fs.existsSync(paths.capacityTransactionsDir)) {
    return {
      additions: 0,
      transactions: 0,
    };
  }
  let additions = 0;
  let transactions = 0;
  for (const entry of fs.readdirSync(paths.capacityTransactionsDir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const transaction = readJsonIfPresent(path.join(paths.capacityTransactionsDir, entry));
    if (!transaction || ["finalized", "rejected", "rolled_back"].includes(transaction.status)) {
      continue;
    }
    transactions += 1;
    const transactionAdditions = Array.isArray(transaction.additions)
      ? transaction.additions.length
      : (Array.isArray(transaction.actions) ? transaction.actions.length : 0);
    additions += transactionAdditions;
  }
  return {
    additions,
    transactions,
  };
}

function serviceCommandWritesFinalSnapshot(request) {
  if (request?.group === "help" || request?.group === "events") {
    return false;
  }
  if (request?.group === "capacity" && request?.options?.apply !== true) {
    return false;
  }
  return true;
}

function brokerStateLoadCount(request) {
  if (request?.group === "help" || request?.group === "events") {
    return 0;
  }
  if (request?.group === "capacity") {
    return 0;
  }
  return 1 + (serviceCommandWritesFinalSnapshot(request) ? 1 : 0);
}

function commandMayRunStaleContainment(request) {
  if (request?.group === "help" || request?.group === "events") {
    return false;
  }
  if (request?.group === "capacity") {
    return request?.command === "reconcile" && request?.options?.apply === true;
  }
  return true;
}

function stateLoadBudgetMs(stateLoadCount) {
  return stateLoadCount * (
    (SIMCTL_INVENTORY_COMMANDS_PER_STATE_LOAD * SIMCTL_COMMAND_TIMEOUT_MS)
    + (PROCESS_SAMPLER_INVOCATIONS_PER_STATE_LOAD * PROCESS_SAMPLER_TIMEOUT_MS)
  );
}

function staleContainmentBudgetMs(request, options = {}, stateLoadCount = 1) {
  if (!commandMayRunStaleContainment(request)) {
    return 0;
  }
  const loadCount = nonNegativeInteger(stateLoadCount);
  if (loadCount === 0) {
    return 0;
  }
  const staleContainmentLeaseCount = nonNegativeInteger(
    options.staleContainmentLeaseCount
      ?? request?.options?.staleContainmentLeaseCount
      ?? staleContainmentLeaseCountFromPaths(options.paths),
  );
  return loadCount * staleContainmentLeaseCount * (
    (STALE_CONTAINMENT_PROCESS_SAMPLER_INVOCATIONS * PROCESS_SAMPLER_TIMEOUT_MS)
    + staleContainmentTermWaitMs(request)
    + DEFAULT_CONTAINMENT_POST_KILL_WAIT_MS
  );
}

function brokerStateLoadBudgetMs(request, stateLoadCount, options = {}) {
  return stateLoadBudgetMs(stateLoadCount)
    + staleContainmentBudgetMs(request, options, stateLoadCount);
}

function finalSnapshotLeaseLockTimeoutMs(request) {
  return serviceCommandWritesFinalSnapshot(request) ? leaseLockTimeoutMs(request) : 0;
}

function serviceCommandUsesSerializedStateReadLock(request) {
  if (request?.group === "doctor") {
    return true;
  }
  if (request?.group === "host") {
    return request?.command === "status";
  }
  if (request?.group === "lease") {
    return request?.command === "explain";
  }
  return false;
}

function leaseAcquireResetSimctlBudgetMs(request) {
  return request?.group === "lease" && request?.command === "acquire"
    ? LEASE_ACQUIRE_SIMCTL_COMMANDS * SIMCTL_COMMAND_TIMEOUT_MS
    : 0;
}

function serviceCommandUsesLeaseMutationLock(request) {
  if (request?.group === "lease") {
    return ["acquire", "contain", "register-process", "release"].includes(request?.command);
  }
  if (request?.group === "pin") {
    return ["clear", "create"].includes(request?.command);
  }
  if (request?.group === "simulators") {
    return ["boot", "erase", "repair", "shutdown"].includes(request?.command);
  }
  if (request?.group === "idle") {
    return true;
  }
  return false;
}

function idleShutdownSimctlBudgetMs(request, options = {}) {
  if (request?.group !== "idle"
    || !["cleanup", "reconcile"].includes(request?.command)
    || (request.command === "cleanup" && request?.options?.apply !== true)) {
    return 0;
  }
  return hostAliasCountFromPaths(options.paths) * SIMCTL_COMMAND_TIMEOUT_MS;
}

function simulatorLifecycleSimctlBudgetMs(request, options = {}) {
  if (request?.group !== "simulators") {
    return 0;
  }
  const pendingRetirementCount = request?.command === "repair"
    ? positiveDurationMs(
      options.pendingRetirementCount
        ?? (options.paths?.hostConfigPath ? pendingRetirementCountFromPaths(options.paths) : request?.options?.pendingRetirementCount),
      pendingRetirementCountFromPaths(options.paths),
    )
    : 0;
  const directCommandCount = (SIMULATOR_LIFECYCLE_SIMCTL_COMMANDS[request?.command] ?? 0)
    + (request?.command === "repair" ? pendingRetirementCount * 2 : 0);
  if (directCommandCount === 0) {
    return 0;
  }
  return directCommandCount * SIMCTL_COMMAND_TIMEOUT_MS;
}

function hostBootstrapRetirementCount(request, options = {}) {
  if (options.hostBootstrapRetirementCount !== undefined) {
    return nonNegativeInteger(options.hostBootstrapRetirementCount);
  }
  if (options.paths?.hostConfigPath) {
    return hostBootstrapRetirementCountFromPaths(options.paths);
  }
  if (request?.options?.hostBootstrapRetirementCount !== undefined) {
    return nonNegativeInteger(request.options.hostBootstrapRetirementCount);
  }
  return HOST_BOOTSTRAP_ALIAS_COUNT;
}

function hostInitWillProvisionBootstrap(request, options = {}) {
  if (request?.group !== "host" || request?.command !== "init" || request?.options?.bootstrapConfig !== true) {
    return false;
  }
  if (request?.options?.force === true) {
    return true;
  }
  if (options.paths?.hostConfigPath) {
    return !fs.existsSync(options.paths.hostConfigPath);
  }
  return true;
}

function hostInitBootstrapBudgetMs(request, options = {}) {
  if (!hostInitWillProvisionBootstrap(request, options)) {
    return 0;
  }
  const retirementCount = hostBootstrapRetirementCount(request, options);
  const stateLoadCount = HOST_BOOTSTRAP_BASELINE_STATE_LOADS
    + HOST_BOOTSTRAP_REPLACEMENT_STATE_LOADS
    + (retirementCount > 0 ? HOST_BOOTSTRAP_RETIREMENT_STATE_LOADS : 0);
  const commandCount = (HOST_BOOTSTRAP_ALIAS_COUNT * HOST_BOOTSTRAP_SIMCTL_COMMANDS_PER_ALIAS)
    + (retirementCount * 2);
  return capacityLockTimeoutMs(request)
    + brokerStateLoadBudgetMs(request, stateLoadCount, options)
    + (commandCount * SIMCTL_COMMAND_TIMEOUT_MS);
}

function capacityActionCount(request, options = {}) {
  return positiveDurationMs(
    options.capacityActionCount
      ?? (options.paths?.projectFilePath ? selectedCapacityPurposeCountFromPaths(options.paths, request) : request?.options?.capacityActionCount),
    selectedCapacityPurposeCountFromPaths(options.paths, request),
  );
}

function capacityRecoveryWorkload(options = {}) {
  const explicitTransactions = positiveDurationMs(options.capacityRecoveryTransactionCount, 0);
  const explicitAdditions = positiveDurationMs(options.capacityRecoveryAdditionCount, 0);
  if (explicitTransactions > 0 || explicitAdditions > 0) {
    return {
      additions: explicitAdditions,
      transactions: explicitTransactions,
    };
  }
  return nonTerminalCapacityRecoveryWorkload(options.paths);
}

function capacityReconcileSimctlBudgetMs(request, options = {}) {
  if (request?.group !== "capacity" || request?.command !== "reconcile") {
    return 0;
  }
  if (request?.options?.apply !== true) {
    return brokerStateLoadBudgetMs(request, 1, options);
  }
  const recovery = capacityRecoveryWorkload(options);
  const actionCount = capacityActionCount(request, options);
  const stateLoadCount = CAPACITY_APPLY_PLAN_EVALUATIONS
    + CAPACITY_APPLY_FINALIZATION_STATE_LOADS
    + CAPACITY_APPLY_FINAL_SNAPSHOT_STATE_LOADS
    + recovery.transactions;
  const commandCount = (actionCount * CAPACITY_SIMCTL_COMMANDS_PER_ACTION)
    + CAPACITY_ROLLBACK_INVENTORY_COMMANDS
    + (actionCount * CAPACITY_ROLLBACK_SIMCTL_COMMANDS_PER_ACTION)
    + (recovery.additions * CAPACITY_SIMCTL_COMMANDS_PER_ACTION);
  return brokerStateLoadBudgetMs(request, stateLoadCount, options)
    + (commandCount * SIMCTL_COMMAND_TIMEOUT_MS);
}

function capacityCheckSimctlBudgetMs(request) {
  return request?.group === "capacity" && request?.command === "check"
    ? brokerStateLoadBudgetMs(request, 1)
    : 0;
}

export function serviceCommandExecutionTimeoutMs(request, options = {}) {
  if (options.timeoutMs !== undefined) {
    return options.timeoutMs;
  }
  const stateLoadBudgetForRequestMs = brokerStateLoadBudgetMs(request, brokerStateLoadCount(request), options);
  const snapshotLockBudgetMs = finalSnapshotLeaseLockTimeoutMs(request);
  const serializedReadLockBudgetMs = serviceCommandUsesSerializedStateReadLock(request) ? leaseLockTimeoutMs(request) : 0;
  if (request?.group === "host" && request?.command === "init") {
    return DEFAULT_COMMAND_TIMEOUT_MS
      + leaseLockTimeoutMs(request)
      + snapshotLockBudgetMs
      + stateLoadBudgetForRequestMs
      + hostInitBootstrapBudgetMs(request, options);
  }
  if (request?.group === "lease" && request?.command === "acquire") {
    return Math.max(
      DEFAULT_COMMAND_TIMEOUT_MS,
      DEFAULT_COMMAND_TIMEOUT_MS
        + leaseLockTimeoutMs(request)
        + positiveDurationMs(request?.options?.resetLockTimeoutMilliseconds, DEFAULT_LOCK_TIMEOUT_MS)
        + positiveDurationMs(request?.options?.resetSettleMilliseconds, DEFAULT_RESET_SETTLE_MS)
        + leaseAcquireResetSimctlBudgetMs(request)
        + snapshotLockBudgetMs
        + stateLoadBudgetForRequestMs,
    );
  }
  if (request?.group === "lease" && request?.command === "contain") {
    const diagnosticTimeoutMs = request?.options?.captureDiagnostics ? CONTAINMENT_DIAGNOSTIC_TIMEOUT_MS : 0;
    return Math.max(
      DEFAULT_COMMAND_TIMEOUT_MS,
      DEFAULT_COMMAND_TIMEOUT_MS
        + leaseLockTimeoutMs(request)
        + containmentTermWaitMs(request)
        + diagnosticTimeoutMs
        + snapshotLockBudgetMs
        + stateLoadBudgetForRequestMs,
    );
  }
  if (request?.group === "capacity"
    && request?.command === "reconcile"
    && request?.options?.apply === true) {
    return Math.max(
      CAPACITY_APPLY_TIMEOUT_MS,
      DEFAULT_COMMAND_TIMEOUT_MS
        + capacityLockTimeoutMs(request)
        + leaseLockTimeoutMs(request)
        + snapshotLockBudgetMs
        + capacityReconcileSimctlBudgetMs(request, options),
    );
  }
  if (request?.group === "capacity" && request?.command === "check") {
    return DEFAULT_COMMAND_TIMEOUT_MS + capacityCheckSimctlBudgetMs(request);
  }
  if (request?.group === "capacity" && request?.command === "reconcile") {
    return DEFAULT_COMMAND_TIMEOUT_MS + capacityReconcileSimctlBudgetMs(request, options);
  }
  if (request?.group === "simulators" && request?.command === "repair") {
    return DEFAULT_COMMAND_TIMEOUT_MS
      + capacityLockTimeoutMs(request)
      + leaseLockTimeoutMs(request)
      + snapshotLockBudgetMs
      + stateLoadBudgetForRequestMs
      + simulatorLifecycleSimctlBudgetMs(request, options);
  }
  if (request?.group === "simulators") {
    return DEFAULT_COMMAND_TIMEOUT_MS
      + leaseLockTimeoutMs(request)
      + snapshotLockBudgetMs
      + stateLoadBudgetForRequestMs
      + simulatorLifecycleSimctlBudgetMs(request, options);
  }
  if (request?.group === "idle") {
    return DEFAULT_COMMAND_TIMEOUT_MS
      + leaseLockTimeoutMs(request)
      + snapshotLockBudgetMs
      + stateLoadBudgetForRequestMs
      + idleShutdownSimctlBudgetMs(request, options);
  }
  if (serviceCommandUsesLeaseMutationLock(request)) {
    return DEFAULT_COMMAND_TIMEOUT_MS
      + leaseLockTimeoutMs(request)
      + snapshotLockBudgetMs
      + stateLoadBudgetForRequestMs;
  }
  return DEFAULT_COMMAND_TIMEOUT_MS + serializedReadLockBudgetMs + snapshotLockBudgetMs + stateLoadBudgetForRequestMs;
}

export function serviceCommandTimeoutMs(request, options = {}) {
  if (options.timeoutMs !== undefined) {
    return options.timeoutMs;
  }
  return serviceCommandExecutionTimeoutMs(request, options) + commandQueueTimeoutMs(request);
}

export function appSnapshotExecutionTimeoutMs(options = {}) {
  if (options.timeoutMs !== undefined) {
    return options.timeoutMs;
  }
  return DEFAULT_COMMAND_TIMEOUT_MS
    + positiveDurationMs(options.leaseLockTimeoutMilliseconds, DEFAULT_LOCK_TIMEOUT_MS)
    + stateLoadBudgetMs(1);
}

export function serviceStopTimeoutMs(paths, response = {}) {
  return serviceCommandTimeoutMs({
    command: "reconcile",
    group: "idle",
    options: {},
  }, { paths }) + (response?.activeCommandDrainTimeoutMilliseconds ?? 0);
}

export function serviceStartupTimeoutMs(options = {}) {
  const startupIdleReconcileRequest = {
    command: "reconcile",
    group: "idle",
    options: {},
  };
  return stateLoadBudgetMs(SERVICE_STARTUP_STATE_LOADS)
    + staleContainmentBudgetMs(startupIdleReconcileRequest, options, 1)
    + (SERVICE_STARTUP_LEASE_LOCK_WAITS * DEFAULT_LOCK_TIMEOUT_MS)
    + (hostAliasCountFromPaths(options.paths) * SIMCTL_COMMAND_TIMEOUT_MS)
    + (SERVICE_STARTUP_LOCK_PROCESS_SAMPLER_INVOCATIONS * PROCESS_SAMPLER_TIMEOUT_MS)
    + SERVICE_STARTUP_LAUNCHER_OVERHEAD_MS;
}

function serviceCommandRequestBody(request, options = {}) {
  const body = options.expectedServiceIdentity === undefined
    ? { ...request }
    : {
      ...request,
      expectedServiceIdentity: options.expectedServiceIdentity,
    };
  if (options.timeoutMs === undefined) {
    body.clientRequestStartedAtMilliseconds = Date.now();
    body.clientCommandExecutionTimeoutMilliseconds = serviceCommandExecutionTimeoutMs(request, options);
    body.clientCommandQueueTimeoutMilliseconds = commandQueueTimeoutMs(request);
  }
  return body;
}

function requestJson(paths, { body, method, requestPath, timeoutMs = 500 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      headers: payload ? {
        "content-length": Buffer.byteLength(payload),
        "content-type": "application/json",
      } : undefined,
      method,
      path: requestPath,
      socketPath: paths.serviceSocketPath,
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        let parsed;
        try {
          parsed = parseServiceResponseJson(paths, responseBody);
        } catch (error) {
          reject(error);
          return;
        }
        if ((response.statusCode ?? 500) >= 400) {
          const errorPayload = parsed ?? {
            error: `Broker service request failed with status ${response.statusCode}.`,
            ok: false,
          };
          reject(new BrokerError(errorPayload.error ?? "Broker service request failed.", {
            ...errorPayload,
            exitCode: errorPayload.exitCode ?? 1,
          }));
          return;
        }
        resolve(parsed);
      });
    });

    if (timeoutMs !== null && timeoutMs !== undefined) {
      request.setTimeout(timeoutMs, () => {
        const timeoutError = new Error("Broker service request timed out.");
        timeoutError.code = "ESERVICE_TIMEOUT";
        request.destroy(timeoutError);
      });
    }

    request.on("error", (error) => {
      reject(error);
    });

    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function parseServiceResponseJson(paths, responseBody) {
  if (!responseBody) {
    return null;
  }
  try {
    return JSON.parse(responseBody);
  } catch (error) {
    throw malformedServiceResponseError(paths, error);
  }
}

function malformedServiceResponseError(paths, error) {
  return new BrokerError("Broker service returned malformed JSON.", {
    cause: error?.message ?? String(error),
    reasonCode: "service-unavailable",
    serviceSocketPath: paths.serviceSocketPath,
  });
}

function serviceUnavailableError(paths, error) {
  return new BrokerError("Broker service is unavailable.", {
    cause: error?.message ?? String(error),
    reasonCode: "service-unavailable",
    serviceSocketPath: paths.serviceSocketPath,
  });
}

function serviceBusyError(paths, error) {
  return new BrokerError("Broker service did not respond before the timeout.", {
    cause: error?.message ?? String(error),
    reasonCode: "service-unavailable",
    serviceSocketPath: paths.serviceSocketPath,
  });
}

export async function probeService(paths, options = {}) {
  try {
    return await requestJson(paths, {
      method: "GET",
      requestPath: "/v1/service/status",
      timeoutMs: options.timeoutMs ?? 250,
    });
  } catch (error) {
    if (["ECONNREFUSED", "ENOENT"].includes(error?.code)) {
      return null;
    }
    if (error?.code === "ESERVICE_TIMEOUT" || error?.code === "ETIMEDOUT" || error?.message === "Broker service request timed out.") {
      throw serviceBusyError(paths, error);
    }
    throw serviceUnavailableError(paths, error);
  }
}

export async function executeServiceCommand(paths, request, options = {}) {
  const timeoutOptions = {
    ...options,
    paths,
  };
  const body = serviceCommandRequestBody(request, timeoutOptions);
  try {
    return await requestJson(paths, {
      body,
      method: "POST",
      requestPath: "/v1/command",
      timeoutMs: serviceCommandTimeoutMs(request, timeoutOptions),
    });
  } catch (error) {
    if (error instanceof BrokerError) {
      throw error;
    }
    throw serviceUnavailableError(paths, error);
  }
}

export async function requestServiceStop(paths, options = {}) {
  const body = options.expectedServiceIdentity === undefined
    ? {}
    : {
      expectedServiceIdentity: options.expectedServiceIdentity,
    };
  try {
    return await requestJson(paths, {
      body,
      method: "POST",
      requestPath: "/v1/service/stop",
      timeoutMs: options.timeoutMs ?? 2000,
    });
  } catch (error) {
    if (error instanceof BrokerError) {
      throw error;
    }
    throw serviceUnavailableError(paths, error);
  }
}

export async function streamServiceEvents(paths, requestOptions = {}, stream = process.stdout, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finishResolve = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const finishReject = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(requestOptions)) {
      if (value === null || value === undefined || value === false) {
        continue;
      }
      search.set(key, String(value));
    }

    const request = http.request({
      method: "GET",
      path: `/v1/events/stream?${search.toString()}`,
      socketPath: paths.serviceSocketPath,
    }, (response) => {
      const rejectStreamFailure = (error) => {
        finishReject(serviceUnavailableError(paths, error));
      };
      response.on("aborted", () => {
        rejectStreamFailure(new Error("Broker service event stream aborted."));
      });
      response.on("error", rejectStreamFailure);

      if ((response.statusCode ?? 500) >= 400) {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          let parsed;
          try {
            parsed = parseServiceResponseJson(paths, responseBody);
          } catch (error) {
            finishReject(error);
            return;
          }
          finishReject(new BrokerError(parsed?.error ?? "Broker service event stream failed.", {
            ...(parsed ?? {}),
            exitCode: parsed?.exitCode ?? 1,
          }));
        });
        return;
      }

      response.on("data", (chunk) => {
        let canContinue = false;
        try {
          canContinue = stream.write(chunk);
        } catch (error) {
          rejectStreamFailure(error);
          response.destroy(error);
          return;
        }
        if (!canContinue) {
          response.pause();
          if (typeof stream.once === "function") {
            stream.once("drain", () => {
              response.resume();
            });
          } else {
            response.resume();
          }
        }
      });
      response.on("end", () => {
        finishResolve({ handled: true });
      });
    });

    const streamTimeoutMs = options.timeoutMs ?? (requestOptions.follow ? null : 2000);
    if (streamTimeoutMs !== null && streamTimeoutMs !== undefined) {
      request.setTimeout(streamTimeoutMs, () => {
        const timeoutError = new Error("Broker service event stream timed out.");
        timeoutError.code = "ESERVICE_TIMEOUT";
        request.destroy(timeoutError);
      });
    }

    request.on("error", (error) => {
      if (error instanceof BrokerError) {
        finishReject(error);
        return;
      }
      finishReject(serviceUnavailableError(paths, error));
    });
    request.end();
  });
}
