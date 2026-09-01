import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildLeaseRuntimeMetadata,
  containLeaseProcesses,
  defaultProcessSampler,
  discoverLeaseOwnedProcesses,
  isSupportedContainmentReason,
  leaseHasContainmentProcessMetadata,
  mergeLeaseRuntimeMetadata,
} from "./containment.mjs";
import { resolveBrokerExitCode } from "./error-contract.mjs";
import { SIMCTL_COMMAND_TIMEOUT_MS, createDeviceIndex, resolveSimctlAdapter } from "./simctl.mjs";

export const DEFAULT_HOST_CONFIG_PATH = path.join(os.homedir(), "Library/Application Support/SimulatorBroker/host-config.json");
export const DEFAULT_STATE_ROOT = path.join(os.homedir(), "Library/Application Support/SimulatorBroker/state");
export const DEFAULT_PROJECT_FILE = ".simulator-broker/project.json";
export const HOST_BOOTSTRAP_DEVICE_WARNING =
  "Warning: host init --bootstrap-config creates real iOS Simulator devices on this Mac.";

const HOST_CONFIG_VERSION = 1;
const KNOWN_PROJECTS_VERSION = 1;
const PROJECT_CONFIG_VERSION = 1;
const REGISTRY_VERSION = 1;
const IDLE_POLICY_VERSION = 1;
const IDLE_SCHEMA_VERSION = 1;
const MIN_IDLE_GRACE_SECONDS = 60;
const MAX_IDLE_GRACE_SECONDS = 86_400;
const ALLOWED_DEVICE_FAMILIES = new Set(["iPhone", "iPad"]);
const ALLOWED_RESET_POLICIES = new Set(["none", "erase-on-acquire"]);
const ALLOWED_HEALTH_STATES = new Set(["healthy", "state-drift", "repair-needed", "repairing"]);
const ALLOWED_POWER_STATES = new Set(["shutdown", "booted"]);
const DEFAULT_STARTER_IOS_VERSION = "18";
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const DEFAULT_LOCK_POLL_MS = 150;
const LOCK_OWNER_PID_IDENTITY_TOLERANCE_MS = 15_000;
const DEFAULT_RESET_SETTLE_MS = 250;
const CAPACITY_SCHEMA_VERSION = 1;
const SETUP_SCHEMA_VERSION = 1;
// Covers fresh-plan inventory, six create/rename pairs, post-commit state load,
// and the largest late-failure attribution/delete rollback while the lock is held.
const SETUP_MAX_SIMCTL_COMMANDS_UNDER_CAPACITY_LOCK = 30;
const SETUP_CAPACITY_LOCK_TIMEOUT_MS =
  (SETUP_MAX_SIMCTL_COMMANDS_UNDER_CAPACITY_LOCK * SIMCTL_COMMAND_TIMEOUT_MS)
  + DEFAULT_LOCK_TIMEOUT_MS;
const CAPACITY_RESET_POLICY_BY_CAPABILITY = Object.freeze({
  "automation-resettable": "erase-on-acquire",
  "build-clean": "erase-on-acquire",
  "build-fast": "none",
  "interactive-resettable": "erase-on-acquire",
  "manual-persistent": "none",
});
const CAPACITY_DEFAULT_FAMILY_BY_CAPABILITY = Object.freeze({
  "automation-resettable": "iPhone",
  "build-clean": "iPhone",
  "build-fast": "iPhone",
  "interactive-resettable": "iPhone",
  "manual-persistent": "iPhone",
});
const CAPACITY_ALIAS_PREFIX_BY_CAPABILITY = Object.freeze({
  "automation-resettable": "automation",
  "build-clean": "clean-build",
  "build-fast": "build",
  "interactive-resettable": "ui",
  "manual-persistent": "manual",
});
const CAPACITY_TERMINAL_TRANSACTION_STATES = new Set([
  "finalized",
  "rejected",
  "rolled_back",
]);

export class BrokerError extends Error {
  constructor(message, { exitCode, ...payload } = {}) {
    super(message);
    this.name = "BrokerError";
    this.exitCode = exitCode ?? resolveBrokerExitCode(payload.reasonCode);
    this.payload = {
      ok: false,
      error: message,
      ...payload,
      exitCode: this.exitCode,
    };
  }
}

function nowIso(now = new Date()) {
  const value = typeof now === "function" ? now() : now;
  return typeof value === "string" ? value : value.toISOString();
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeNonNegativeInteger(value) {
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function requireBoundedInteger(value, flagName, minimum, maximum) {
  const number = Number(value);
  if (Number.isInteger(number) && number >= minimum && number <= maximum) {
    return number;
  }
  if (value === undefined || value === null) {
    throw new BrokerError(`Missing required flag --${flagName}.`, {
      reasonCode: "missing-flag",
    });
  }
  throw new BrokerError(`Flag --${flagName} must be an integer from ${minimum} through ${maximum}.`, {
    reasonCode: "invalid-flag",
  });
}

function requirePositiveInteger(value, flagName) {
  const normalized = normalizePositiveInteger(value);
  if (normalized !== null) {
    return normalized;
  }
  if (value === undefined || value === null) {
    throw new BrokerError(`Missing required flag --${flagName}.`, {
      reasonCode: "missing-flag",
    });
  }
  throw new BrokerError(`Flag --${flagName} must be a positive integer.`, {
    reasonCode: "invalid-flag",
  });
}

function requireProjectId(value) {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  throw new BrokerError("Flag --project-id must be a non-empty string.", {
    flag: "project-id",
    reasonCode: "invalid-flag",
  });
}

function optionalNonNegativeInteger(value, flagName) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = normalizeNonNegativeInteger(value);
  if (normalized !== null) {
    return normalized;
  }
  throw new BrokerError(`Flag --${flagName} must be a nonnegative integer.`, {
    reasonCode: "invalid-flag",
  });
}

function requireContainmentRootInteger(value, flagName) {
  const normalized = requirePositiveInteger(value, flagName);
  if (normalized > 1) {
    return normalized;
  }
  throw new BrokerError(`Flag --${flagName} must be greater than 1.`, {
    reasonCode: "invalid-flag",
  });
}

function optionalContainmentGroupInteger(value, flagName) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = requirePositiveInteger(value, flagName);
  if (normalized > 1) {
    return normalized;
  }
  throw new BrokerError(`Flag --${flagName} must be greater than 1 when provided.`, {
    reasonCode: "invalid-flag",
  });
}

function validateRegisteredCommandGroup(commandPid, commandPgid, processSampler) {
  if (!commandPgid || typeof processSampler !== "function") {
    return;
  }
  const liveCommand = processSampler().find((processRecord) =>
    normalizePositiveInteger(processRecord?.pid) === commandPid);
  if (!liveCommand) {
    throw new BrokerError(`Flag --pgid requires a live process for --pid ${commandPid}.`, {
      reasonCode: "invalid-flag",
    });
  }
  const liveCommandStat = String(liveCommand.stat ?? "").trim().toUpperCase();
  if (liveCommandStat.startsWith("Z") || String(liveCommand.command ?? "").includes("<defunct>")) {
    throw new BrokerError(`Flag --pgid requires a non-defunct process for --pid ${commandPid}.`, {
      reasonCode: "invalid-flag",
    });
  }
  const liveCommandPgid = normalizePositiveInteger(liveCommand.pgid);
  if (liveCommandPgid !== commandPgid) {
    throw new BrokerError(`Flag --pgid must match the current process group for --pid ${commandPid}.`, {
      reasonCode: "invalid-flag",
    });
  }
}

function processSampleLooksDefunct(processRecord) {
  const stat = String(processRecord?.stat ?? "").trim().toUpperCase();
  if (stat.startsWith("Z")) {
    return true;
  }
  return String(processRecord?.command ?? "").includes("<defunct>");
}

function validateRegisteredOwnerGroup(ownerPid, ownerPgid, processSampler, options = {}) {
  if (!ownerPid || !ownerPgid || typeof processSampler !== "function") {
    return;
  }
  const liveOwner = processSampler().find((processRecord) =>
    normalizePositiveInteger(processRecord?.pid) === ownerPid);
  if (!liveOwner) {
    if (options.requireLiveOwner === true) {
      throw new BrokerError(`Flag --owner-pgid requires a live process for --owner-pid ${ownerPid}.`, {
        reasonCode: "invalid-flag",
      });
    }
    return;
  }
  if (processSampleLooksDefunct(liveOwner)) {
    throw new BrokerError(`Flag --owner-pgid requires a non-defunct process for --owner-pid ${ownerPid}.`, {
      reasonCode: "invalid-flag",
    });
  }
  const liveOwnerPgid = normalizePositiveInteger(liveOwner.pgid);
  if (liveOwnerPgid !== ownerPgid) {
    throw new BrokerError(`Flag --owner-pgid must match the current process group for --owner-pid ${ownerPid}.`, {
      reasonCode: "invalid-flag",
    });
  }
}

function validateContainmentReason(reason) {
  if (!isSupportedContainmentReason(reason)) {
    throw new BrokerError(`Unsupported containment reason: ${reason}.`, {
      reasonCode: "invalid-flag",
    });
  }
  return reason;
}

function shortHash(input) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function slugifyIdentifier(input, fallback = "simulator-broker") {
  const normalized = (typeof input === "string" ? input : "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function humanizeName(input, fallback = "Simulator Broker") {
  const normalized = input
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return fallback;
  }
  return normalized
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function defaultHostId() {
  return slugifyIdentifier(os.hostname(), "simulator-broker-host");
}

function sleepSync(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureRestrictedDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirPath, 0o700);
}

function writeJsonAtomic(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function writeJsonNoReplace(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let linked = false;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
    fs.linkSync(tempPath, filePath);
    linked = true;
  } finally {
    removeIfExists(tempPath);
  }
  return linked;
}

function writeJsonAtomicRestricted(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function writeJsonAtomicDurable(filePath, payload, options = {}) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd = null;
  let committed = false;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (options.failStage === "before-rename") {
      throw new Error("Injected host config write failure before rename.");
    }
    fs.renameSync(tempPath, filePath);
    committed = true;
    if (options.failStage === "after-rename") {
      throw new Error("Injected host config write failure after rename.");
    }
    const dirFd = fs.openSync(path.dirname(filePath), "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
    if (options.failStage === "after-directory-sync") {
      throw new Error("Injected host config write failure after directory sync.");
    }
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close failures while preserving the original write error.
      }
    }
    removeIfExists(tempPath);
    error.hostConfigCommitted = committed;
    throw error;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Digest(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
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

function processRecordLooksDefunct(processRecord) {
  return String(processRecord?.stat ?? "").includes("Z")
    || String(processRecord?.command ?? "").includes("<defunct>");
}

function processRecordAliveAtTimestamp(processRecord, startedAtValue, observedAtValue) {
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
  return elapsedMilliseconds + LOCK_OWNER_PID_IDENTITY_TOLERANCE_MS >= observedAt - startedAt;
}

function writeNdjsonRecords(filePath, records) {
  ensureRestrictedDir(path.dirname(filePath));
  const content = records.length > 0
    ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
    : "";
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, content, { mode: 0o600 });
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function readNdjsonRecords(filePath, { repair = false } = {}) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, "utf8");
  const records = [];
  let needsRepair = content.length > 0 && !content.endsWith("\n");
  for (const line of content.split("\n")) {
    if (!line) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      needsRepair = true;
    }
  }
  if (repair && needsRepair) {
    writeNdjsonRecords(filePath, records);
  }
  return records;
}

function parseNdjsonRecords(content) {
  const records = [];
  for (const line of content.split("\n")) {
    if (!line) {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      // Tail readers intentionally ignore interrupted trailing records.
    }
  }
  return records;
}

function readNdjsonTailRecords(filePath, limit) {
  if (!fs.existsSync(filePath) || limit <= 0) {
    return [];
  }
  const fileSize = fs.statSync(filePath).size;
  if (fileSize === 0) {
    return [];
  }

  const fd = fs.openSync(filePath, "r");
  const chunks = [];
  let content = "";
  let position = fileSize;
  let records = [];
  const chunkSize = NDJSON_TAIL_REPAIR_CHUNK_BYTES;
  try {
    while (position > 0) {
      const bytesToRead = Math.min(chunkSize, position);
      position -= bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, position);
      chunks.unshift(buffer);
      content = Buffer.concat(chunks).toString("utf8");
      records = parseNdjsonRecords(content);
      if (records.length >= limit) {
        break;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return records.slice(-limit);
}

const NDJSON_TAIL_REPAIR_CHUNK_BYTES = 64 * 1024;
const NDJSON_TAIL_RECORD_MAX_BYTES = 1024 * 1024;

function findLastNewlineOffset(fd, fileSize) {
  const buffer = Buffer.alloc(Math.min(NDJSON_TAIL_REPAIR_CHUNK_BYTES, fileSize));
  let position = fileSize;
  while (position > 0) {
    const bytesToRead = Math.min(buffer.length, position);
    position -= bytesToRead;
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, position);
    const newlineIndex = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (newlineIndex !== -1) {
      return position + newlineIndex;
    }
  }
  return -1;
}

function repairNdjsonTail(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const fileSize = fs.statSync(filePath).size;
  if (fileSize === 0) {
    return;
  }

  const fd = fs.openSync(filePath, "r+");
  let modified = false;
  try {
    const lastByte = Buffer.alloc(1);
    fs.readSync(fd, lastByte, 0, 1, fileSize - 1);
    if (lastByte[0] === 0x0a) {
      return;
    }

    const lastNewlineOffset = findLastNewlineOffset(fd, fileSize);
    const tailStart = lastNewlineOffset === -1 ? 0 : lastNewlineOffset + 1;
    const tailLength = fileSize - tailStart;
    if (tailLength > NDJSON_TAIL_RECORD_MAX_BYTES) {
      fs.ftruncateSync(fd, tailStart);
      modified = true;
      return;
    }

    const tailBuffer = Buffer.alloc(tailLength);
    fs.readSync(fd, tailBuffer, 0, tailLength, tailStart);
    const tailContent = tailBuffer.toString("utf8");
    try {
      JSON.parse(tailContent);
      fs.writeSync(fd, "\n", fileSize, "utf8");
      modified = true;
    } catch {
      fs.ftruncateSync(fd, tailStart);
      modified = true;
    }
  } finally {
    if (modified) {
      fs.fsyncSync(fd);
    }
    fs.closeSync(fd);
  }
}

function appendNdjson(filePath, payload) {
  ensureRestrictedDir(path.dirname(filePath));
  repairNdjsonTail(filePath);
  const previousSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  const fd = fs.openSync(filePath, "a", 0o600);
  try {
    fs.appendFileSync(fd, `${JSON.stringify(payload)}\n`);
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.ftruncateSync(fd, previousSize);
    } catch {
      // Preserve the original append failure.
    }
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, 0o600);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonIfExists(filePath, fallback = null) {
  try {
    return fs.existsSync(filePath) ? readJson(filePath) : fallback;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

function removeIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function parseVersionParts(rawValue) {
  return String(rawValue ?? "")
    .match(/\d+/g)
    ?.map((part) => Number(part)) ?? [];
}

function compareVersionParts(left, right) {
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return 0;
}

function compareVersions(left, right) {
  return compareVersionParts(parseVersionParts(left), parseVersionParts(right));
}

function isHostSchemaIosVersion(version) {
  return /^\d+(\.\d+)?$/.test(String(version ?? ""));
}

function isMajorOnlyVersion(version) {
  return /^\d+$/.test(String(version ?? ""));
}

function simulatorDisplayName(hostId, alias) {
  return `Simulator Broker ${hostId} ${alias}`;
}

function searchUpForFile(startDir, relativeTarget) {
  let currentDir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(currentDir, relativeTarget);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function defaultProcessExists(pid) {
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

function requireObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerError(`${name} must be an object.`, {
      reasonCode: "invalid-config",
      field: name,
    });
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BrokerError(`${name} must be a non-empty string.`, {
      reasonCode: "invalid-config",
      field: name,
    });
  }
  return value.trim();
}

function requireOptionalString(value, name) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return requireString(value, name);
}

function requireArray(value, name) {
  if (!Array.isArray(value)) {
    throw new BrokerError(`${name} must be an array.`, {
      reasonCode: "invalid-config",
      field: name,
    });
  }
  return value;
}

function validateVersion(value, expectedVersion, name) {
  if (value !== expectedVersion) {
    throw new BrokerError(`${name}.version must equal ${expectedVersion}.`, {
      reasonCode: "invalid-config",
      field: `${name}.version`,
    });
  }
}

function validateDeviceFamily(value, field) {
  const deviceFamily = requireString(value, field);
  if (!ALLOWED_DEVICE_FAMILIES.has(deviceFamily)) {
    throw new BrokerError(`${field} must be one of ${[...ALLOWED_DEVICE_FAMILIES].join(", ")}.`, {
      reasonCode: "invalid-config",
      field,
    });
  }
  return deviceFamily;
}

function validateIosVersion(value, field) {
  const iosVersion = requireString(value, field);
  if (isHostSchemaIosVersion(iosVersion) === false) {
    throw new BrokerError(`${field} must match <major> or <major.minor>.`, {
      reasonCode: "invalid-config",
      field,
    });
  }
  return iosVersion;
}

function validateCapabilities(value, field) {
  const capabilities = requireArray(value, field).map((capability, index) =>
    requireString(capability, `${field}[${index}]`));
  if (capabilities.length === 0) {
    throw new BrokerError(`${field} must include at least one capability.`, {
      reasonCode: "invalid-config",
      field,
    });
  }
  return [...new Set(capabilities)];
}

function normalizeResetPolicy(value, field) {
  const resetPolicy = value === undefined ? "none" : requireString(value, field);
  if (!ALLOWED_RESET_POLICIES.has(resetPolicy)) {
    throw new BrokerError(`${field} must be one of ${[...ALLOWED_RESET_POLICIES].join(", ")}.`, {
      reasonCode: "invalid-config",
      field,
    });
  }
  return resetPolicy;
}

function validateHostAlias(rawAlias, index) {
  const alias = requireObject(rawAlias, `aliases[${index}]`);
  return {
    alias: requireString(alias.alias, `aliases[${index}].alias`),
    capabilities: validateCapabilities(alias.capabilities, `aliases[${index}].capabilities`),
    deviceFamily: validateDeviceFamily(alias.deviceFamily, `aliases[${index}].deviceFamily`),
    displayName: requireString(alias.displayName, `aliases[${index}].displayName`),
    iosVersion: validateIosVersion(alias.iosVersion, `aliases[${index}].iosVersion`),
    resetPolicy: normalizeResetPolicy(alias.resetPolicy, `aliases[${index}].resetPolicy`),
    simulatorId: requireString(alias.simulatorId, `aliases[${index}].simulatorId`),
  };
}

function validatePendingRetirements(rawRetirements) {
  if (rawRetirements === undefined || rawRetirements === null) {
    return [];
  }
  return [...new Set(requireArray(rawRetirements, "host-config.pendingRetirements")
    .map((simulatorId, index) => requireString(simulatorId, `host-config.pendingRetirements[${index}]`)))];
}

function validatePurposeRequires(rawRequires, fieldPrefix) {
  if (rawRequires === undefined || rawRequires === null) {
    return null;
  }
  const requires = requireObject(rawRequires, `${fieldPrefix}.requires`);
  const extraFields = Object.keys(requires).filter((field) => !["deviceFamily", "iosVersion"].includes(field));
  if (extraFields.length > 0) {
    throw new BrokerError(`${fieldPrefix}.requires contains unsupported fields: ${extraFields.join(", ")}.`, {
      reasonCode: "invalid-config",
      field: `${fieldPrefix}.requires`,
    });
  }

  const normalized = {};
  if (requires.deviceFamily !== undefined) {
    normalized.deviceFamily = validateDeviceFamily(requires.deviceFamily, `${fieldPrefix}.requires.deviceFamily`);
  }
  if (requires.iosVersion !== undefined) {
    normalized.iosVersion = validateIosVersion(requires.iosVersion, `${fieldPrefix}.requires.iosVersion`);
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function validateProjectPurpose(rawPurpose, fieldPrefix) {
  const purpose = requireObject(rawPurpose, fieldPrefix);
  return {
    capability: requireString(purpose.capability, `${fieldPrefix}.capability`),
    defaultActorType: requireOptionalString(purpose.defaultActorType, `${fieldPrefix}.defaultActorType`),
    displayName: requireString(purpose.displayName, `${fieldPrefix}.displayName`),
    id: requireString(purpose.id, `${fieldPrefix}.id`),
    requires: validatePurposeRequires(purpose.requires, fieldPrefix),
  };
}

export function validateHostConfig(rawConfig) {
  const config = requireObject(rawConfig, "host-config");
  validateVersion(config.version, HOST_CONFIG_VERSION, "host-config");
  const aliases = requireArray(config.aliases, "host-config.aliases").map(validateHostAlias);
  const aliasIds = new Set();
  const simulatorIds = new Set();
  for (const alias of aliases) {
    if (aliasIds.has(alias.alias)) {
      throw new BrokerError(`Duplicate alias ${alias.alias} in host config.`, {
        reasonCode: "invalid-config",
        field: "host-config.aliases",
      });
    }
    aliasIds.add(alias.alias);
    if (simulatorIds.has(alias.simulatorId)) {
      throw new BrokerError(`Duplicate simulatorId ${alias.simulatorId} in host config.`, {
        reasonCode: "invalid-config",
        field: "host-config.aliases",
      });
    }
    simulatorIds.add(alias.simulatorId);
  }
  return {
    aliases,
    hostId: requireString(config.hostId, "host-config.hostId"),
    pendingRetirements: validatePendingRetirements(config.pendingRetirements),
    version: HOST_CONFIG_VERSION,
  };
}

export function validateProjectConfig(rawConfig) {
  const config = requireObject(rawConfig, "project-config");
  validateVersion(config.version, PROJECT_CONFIG_VERSION, "project-config");
  const purposes = requireArray(config.purposes, "project-config.purposes")
    .map((purpose, index) => validateProjectPurpose(purpose, `project-config.purposes[${index}]`));
  const purposeIds = new Set();
  for (const purpose of purposes) {
    if (purposeIds.has(purpose.id)) {
      throw new BrokerError(`Duplicate purpose ${purpose.id} in project config.`, {
        reasonCode: "invalid-config",
        field: "project-config.purposes",
      });
    }
    purposeIds.add(purpose.id);
  }
  return {
    projectId: requireString(config.projectId, "project-config.projectId"),
    projectName: requireString(config.projectName, "project-config.projectName"),
    purposes,
    version: PROJECT_CONFIG_VERSION,
  };
}

function missingHostConfigError(paths) {
  return new BrokerError(`Host config was not found at ${paths.hostConfigPath}.`, {
    hostConfigPath: paths.hostConfigPath,
    reasonCode: "missing-host-config",
    suggestedCommand: `simbroker host init --bootstrap-config --host-config "${paths.hostConfigPath}"`,
  });
}

function readHostConfigOrThrow(paths) {
  if (!pathOccupied(paths.hostConfigPath)) {
    throw missingHostConfigError(paths);
  }
  let stats;
  try {
    stats = fs.statSync(paths.hostConfigPath);
  } catch {
    stats = null;
  }
  if (stats?.isFile() !== true) {
    throw new BrokerError("Host config could not be read as a regular file.", {
      hostConfigPath: paths.hostConfigPath,
      reasonCode: "invalid-config",
    });
  }
  try {
    return validateHostConfig(readJson(paths.hostConfigPath));
  } catch (error) {
    if (error instanceof BrokerError) {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw new BrokerError("Host config contains invalid JSON.", {
        reasonCode: "invalid-config",
      });
    }
    throw error;
  }
}

function readProjectJsonOrThrow(projectFilePath) {
  try {
    return readJson(projectFilePath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new BrokerError("Project config contains invalid JSON.", {
        reasonCode: "invalid-config",
      });
    }
    throw error;
  }
}

function buildStarterAliasTemplates({
  hostId = defaultHostId(),
  iosVersion = DEFAULT_STARTER_IOS_VERSION,
} = {}) {
  const normalizedHostId = slugifyIdentifier(hostId, defaultHostId());
  const normalizedIosVersion = validateIosVersion(iosVersion ?? DEFAULT_STARTER_IOS_VERSION, "starter-host-config.iosVersion");
  return {
    hostId: normalizedHostId,
    templates: [
      {
        alias: "manual-1",
        capabilities: ["manual-persistent"],
        deviceFamily: "iPhone",
        displayName: "Manual iPhone",
        iosVersion: normalizedIosVersion,
        resetPolicy: "none",
        simulatorName: simulatorDisplayName(normalizedHostId, "manual-1"),
      },
      {
        alias: "ui-1",
        capabilities: ["interactive-resettable", "automation-resettable"],
        deviceFamily: "iPhone",
        displayName: "UI iPhone",
        iosVersion: normalizedIosVersion,
        resetPolicy: "erase-on-acquire",
        simulatorName: simulatorDisplayName(normalizedHostId, "ui-1"),
      },
      {
        alias: "ui-2",
        capabilities: ["interactive-resettable", "automation-resettable"],
        deviceFamily: "iPhone",
        displayName: "UI iPhone 2",
        iosVersion: normalizedIosVersion,
        resetPolicy: "erase-on-acquire",
        simulatorName: simulatorDisplayName(normalizedHostId, "ui-2"),
      },
      {
        alias: "build-1",
        capabilities: ["build-fast"],
        deviceFamily: "iPhone",
        displayName: "Build iPhone",
        iosVersion: normalizedIosVersion,
        resetPolicy: "none",
        simulatorName: simulatorDisplayName(normalizedHostId, "build-1"),
      },
      {
        alias: "build-2",
        capabilities: ["build-fast"],
        deviceFamily: "iPhone",
        displayName: "Build iPhone 2",
        iosVersion: normalizedIosVersion,
        resetPolicy: "none",
        simulatorName: simulatorDisplayName(normalizedHostId, "build-2"),
      },
      {
        alias: "ipad-1",
        capabilities: ["interactive-resettable"],
        deviceFamily: "iPad",
        displayName: "UI iPad",
        iosVersion: normalizedIosVersion,
        resetPolicy: "erase-on-acquire",
        simulatorName: simulatorDisplayName(normalizedHostId, "ipad-1"),
      },
    ],
  };
}

function buildStarterProjectConfig({
  projectId,
  projectName,
  iosVersion,
} = {}) {
  const normalizedIosVersion = iosVersion === undefined || iosVersion === null
    ? null
    : validateIosVersion(iosVersion, "starter-project-config.iosVersion");
  const uiRequirements = {
    deviceFamily: "iPhone",
    ...(normalizedIosVersion === null ? {} : { iosVersion: normalizedIosVersion }),
  };
  return {
    projectId,
    projectName,
    purposes: [
      {
        id: "manual-testing",
        displayName: "Manual Testing",
        capability: "manual-persistent",
        defaultActorType: "human",
      },
      {
        id: "agent-ui-session",
        displayName: "Agent UI Session",
        capability: "interactive-resettable",
        defaultActorType: "agent",
        requires: uiRequirements,
      },
      {
        id: "agent-build-test",
        displayName: "Agent Build Test",
        capability: "build-fast",
        defaultActorType: "agent",
      },
      {
        id: "ci-ui-test",
        displayName: "CI UI Test",
        capability: "automation-resettable",
        defaultActorType: "ci",
        requires: uiRequirements,
      },
      {
        id: "ci-build-test",
        displayName: "CI Build Test",
        capability: "build-fast",
        defaultActorType: "ci",
      },
    ],
    version: PROJECT_CONFIG_VERSION,
  };
}

function isAvailableIosRuntime(runtime) {
  return runtime?.isAvailable !== false
    && typeof runtime?.identifier === "string"
    && runtime.identifier.includes(".iOS-");
}

function runtimeMatchesRequestedVersion(runtime, requestedVersion) {
  if (typeof runtime?.version !== "string" || runtime.version.length === 0) {
    return false;
  }
  if (!isHostSchemaIosVersion(runtime.version)) {
    return false;
  }
  if (!requestedVersion) {
    return true;
  }
  const runtimeVersion = runtime.version;
  return isMajorOnlyVersion(requestedVersion)
    ? runtimeVersion.split(".")[0] === String(requestedVersion)
    : runtimeVersion === String(requestedVersion);
}

function selectRuntimeForAlias(simctl, iosVersion) {
  const runtimes = (simctl.listRuntimes().runtimes ?? [])
    .filter(isAvailableIosRuntime)
    .filter((runtime) => runtimeMatchesRequestedVersion(runtime, iosVersion))
    .sort((left, right) => compareVersions(right.version, left.version));

  if (runtimes.length === 0) {
    throw new BrokerError(
      `No available iOS runtime matched ${iosVersion}. Pass --ios-version to match an installed runtime from \`xcrun simctl list runtimes\`.`,
      {
        iosVersion,
        reasonCode: "runtime-not-found",
      },
    );
  }

  return runtimes[0];
}

function setupDeviceTypeRecordIsComplete(deviceType) {
  return typeof deviceType?.identifier === "string" && deviceType.identifier.length > 0
    && typeof deviceType?.name === "string" && deviceType.name.length > 0;
}

function isCompleteSetupDeviceType(deviceType, deviceFamily) {
  return deviceType?.productFamily === deviceFamily && setupDeviceTypeRecordIsComplete(deviceType);
}

function requireCompleteSetupDeviceType(deviceType, deviceFamily, runtime) {
  if (!isCompleteSetupDeviceType(deviceType, deviceFamily)) {
    throw new BrokerError(`No available ${deviceFamily} simulator type matched runtime ${runtime.version}.`, {
      deviceFamily,
      reasonCode: "device-type-not-found",
      runtimeId: runtime.identifier,
    });
  }
  return deviceType;
}

function selectPreferredDeviceType(runtime, deviceFamily) {
  const supportedDeviceTypes = Array.isArray(runtime.supportedDeviceTypes)
    ? runtime.supportedDeviceTypes.filter((deviceType) => isCompleteSetupDeviceType(deviceType, deviceFamily))
    : [];

  if (supportedDeviceTypes.length === 0) {
    throw new BrokerError(`No available ${deviceFamily} simulator type matched runtime ${runtime.version}.`, {
      deviceFamily,
      reasonCode: "device-type-not-found",
      runtimeId: runtime.identifier,
    });
  }

  const exactNamePattern = deviceFamily === "iPhone" ? /^iPhone \d+$/ : /^iPad \(/;
  const preferred = supportedDeviceTypes
    .filter((deviceType) => exactNamePattern.test(deviceType.name))
    .sort((left, right) => {
      const versionComparison = compareVersions(right.name, left.name);
      if (versionComparison !== 0) {
        return versionComparison;
      }
      return compareSetupDeviceTypes(left, right);
    });

  if (preferred[0]) {
    return preferred[0];
  }

  return [...supportedDeviceTypes].sort(compareSetupDeviceTypes)[0];
}

function compareSetupDeviceTypes(left, right) {
  const identifierComparison = String(left?.identifier ?? "").localeCompare(String(right?.identifier ?? ""));
  if (identifierComparison !== 0) {
    return identifierComparison;
  }
  return String(left?.name ?? "").localeCompare(String(right?.name ?? ""));
}

function deleteAliasSimulator(simctl, simulatorId) {
  simctl.shutdownDevice(simulatorId);
  simctl.deleteDevice(simulatorId);
}

function rollbackCreatedAliasSimulator(simctl, simulatorId) {
  try {
    deleteAliasSimulator(simctl, simulatorId);
  } catch {
    // Preserve the host-config commit failure that required rollback.
  }
}

function pendingRetirementIdsForHostReplacement(previousHostConfig, nextHostConfig) {
  const nextSimulatorIds = new Set(nextHostConfig.aliases.map((alias) => alias.simulatorId));
  const pendingRetirementIds = new Set(previousHostConfig.pendingRetirements ?? []);

  for (const alias of previousHostConfig.aliases) {
    if (!nextSimulatorIds.has(alias.simulatorId)) {
      pendingRetirementIds.add(alias.simulatorId);
    }
  }

  return [...pendingRetirementIds].filter((simulatorId) => !nextSimulatorIds.has(simulatorId));
}

function retirePendingHostSimulators(simctl, pendingRetirementIds, nextHostConfig) {
  if (pendingRetirementIds.length === 0) {
    return {
      failedRetirements: [],
      pendingRetirements: [],
      retiredSimulatorIds: [],
    };
  }

  const nextSimulatorIds = new Set(nextHostConfig.aliases.map((alias) => alias.simulatorId));
  const currentSimulatorIds = new Set(readSimulatorDeviceIndex(simctl).keys());
  const retiredSimulatorIds = [];
  const failedRetirements = [];

  for (const simulatorId of pendingRetirementIds) {
    if (nextSimulatorIds.has(simulatorId) || !currentSimulatorIds.has(simulatorId)) {
      continue;
    }
    try {
      deleteAliasSimulator(simctl, simulatorId);
      retiredSimulatorIds.push(simulatorId);
    } catch (error) {
      failedRetirements.push({
        error,
        simulatorId,
      });
    }
  }

  return {
    failedRetirements,
    pendingRetirements: failedRetirements.map((failure) => failure.simulatorId),
    retiredSimulatorIds,
  };
}

function ensureAliasSimulator(simctl, template, currentSimulatorId = null, options = {}) {
  const runtime = selectRuntimeForAlias(simctl, template.iosVersion);
  const deviceType = selectPreferredDeviceType(runtime, template.deviceFamily);
  const deviceIndex = createDeviceIndex({
    deviceTypesJson: simctl.listDeviceTypes(),
    devicesJson: simctl.listDevices(),
    runtimesJson: simctl.listRuntimes(),
  });

  const currentDevice = currentSimulatorId ? deviceIndex.get(currentSimulatorId) ?? null : null;
  if (
    currentDevice
    && currentDevice.isAvailable
    && currentDevice.runtimeIdentifier === runtime.identifier
    && currentDevice.deviceTypeIdentifier === deviceType.identifier
  ) {
    if (currentDevice.name !== template.simulatorName) {
      simctl.renameDevice(currentDevice.udid, template.simulatorName);
    }
    return {
      created: false,
      iosVersion: runtime.version,
      simulatorId: currentDevice.udid,
    };
  }

  const reusableDevice = [...deviceIndex.values()].find((device) =>
    device.isAvailable
      && device.name === template.simulatorName
      && device.runtimeIdentifier === runtime.identifier
      && device.deviceTypeIdentifier === deviceType.identifier);
  if (reusableDevice) {
    return {
      created: false,
      iosVersion: runtime.version,
      replacedSimulatorId: currentDevice && currentDevice.udid !== reusableDevice.udid ? currentDevice.udid : null,
      simulatorId: reusableDevice.udid,
    };
  }

  if (currentDevice && options.deferCurrentDeviceDeletion !== true) {
    deleteAliasSimulator(simctl, currentDevice.udid);
  }

  return {
    created: true,
    iosVersion: runtime.version,
    replacedSimulatorId: currentDevice ? currentDevice.udid : null,
    simulatorId: simctl.createDevice(template.simulatorName, deviceType.identifier, runtime.identifier),
  };
}

function readSimulatorDeviceIndex(simctl) {
  return createDeviceIndex({
    deviceTypesJson: simctl.listDeviceTypes(),
    devicesJson: simctl.listDevices(),
    runtimesJson: simctl.listRuntimes(),
  });
}

function rollbackCreatedSimulators(simctl, createdSimulatorIds, options = {}) {
  const rollbackIds = new Set(createdSimulatorIds);
  const failures = [];
  if (options.baselineDeviceIds && options.plannedSimulatorNames) {
    try {
      const currentIndex = readSimulatorDeviceIndex(simctl);
      for (const device of currentIndex.values()) {
        if (!options.baselineDeviceIds.has(device.udid) && options.plannedSimulatorNames.has(device.name)) {
          rollbackIds.add(device.udid);
        }
      }
    } catch (error) {
      failures.push({ error, operation: "inventory", simulatorId: null });
    }
  }

  for (const simulatorId of [...rollbackIds].reverse()) {
    try {
      simctl.deleteDevice(simulatorId);
    } catch (error) {
      failures.push({ error, operation: "delete", simulatorId });
    }
  }
  return failures;
}

function attachRollbackFailures(error, failures) {
  if (failures.length === 0) {
    return error;
  }
  const payload = error?.payload && typeof error.payload === "object"
    ? error.payload
    : { reasonCode: error?.reasonCode ?? "internal-error" };
  payload.rollbackFailureCount = failures.length;
  payload.rollbackFailures = failures.map((failure) => ({
    error: failure.error?.message ?? String(failure.error),
    operation: failure.operation,
    simulatorId: failure.simulatorId,
  }));
  if (error && (typeof error === "object" || typeof error === "function")) {
    error.payload = payload;
    return error;
  }
  return new BrokerError(String(error), payload);
}

function buildProvisionedStarterHostConfig(options = {}) {
  const { hostId, templates } = buildStarterAliasTemplates(options);
  const simctl = resolveSimctlAdapter(options);
  const createdSimulatorIds = [];
  const baselineDeviceIds = new Set(readSimulatorDeviceIndex(simctl).keys());
  const plannedSimulatorNames = new Set(templates.map((template) => template.simulatorName));

  try {
    const hostConfig = {
      aliases: templates.map((template) => {
        const provisioned = ensureAliasSimulator(simctl, template);
        if (provisioned.created) {
          createdSimulatorIds.push(provisioned.simulatorId);
        }
        return {
          alias: template.alias,
          capabilities: template.capabilities,
          deviceFamily: template.deviceFamily,
          displayName: template.displayName,
          iosVersion: provisioned.iosVersion,
          resetPolicy: template.resetPolicy,
          simulatorId: provisioned.simulatorId,
        };
      }),
      hostId,
      version: HOST_CONFIG_VERSION,
    };
    return {
      createdSimulatorIds,
      hostConfig,
    };
  } catch (error) {
    const rollbackFailures = rollbackCreatedSimulators(simctl, createdSimulatorIds, {
      baselineDeviceIds,
      plannedSimulatorNames,
    });
    throw attachRollbackFailures(error, rollbackFailures);
  }
}

function emitHostBootstrapWarning(options = {}) {
  if (typeof options.writeBootstrapWarning === "function") {
    options.writeBootstrapWarning(HOST_BOOTSTRAP_DEVICE_WARNING);
  }
}

function writeHostConfig(paths, hostConfig) {
  writeJsonAtomicRestricted(paths.hostConfigPath, hostConfig);
}

function hostConfigWithPendingRetirements(hostConfig, pendingRetirements) {
  if (pendingRetirements.length === 0) {
    const { pendingRetirements: _removed, ...cleanHostConfig } = hostConfig;
    return cleanHostConfig;
  }
  return {
    ...hostConfig,
    pendingRetirements,
  };
}

function readSimctlInventory(options = {}) {
  const simctl = resolveSimctlAdapter(options);
  return {
    deviceTypesJson: simctl.listDeviceTypes(),
    devicesJson: simctl.listDevices(),
    runtimesJson: simctl.listRuntimes(),
    simctl,
  };
}

function setupRuntimeBuildVersion(runtime) {
  const value = runtime?.buildversion ?? runtime?.buildVersion ?? null;
  return typeof value === "string" ? value : null;
}

function setupRuntimeSupportedTypeKey(runtime) {
  const types = Array.isArray(runtime?.supportedDeviceTypes) ? runtime.supportedDeviceTypes : [];
  return types
    .map((deviceType) => typeof deviceType?.identifier === "string" ? deviceType.identifier : "")
    .sort()
    .join("\n");
}

function compareSetupRuntimes(left, right) {
  const versionComparison = compareVersions(right.version, left.version);
  if (versionComparison !== 0) {
    return versionComparison;
  }
  const buildComparison = String(setupRuntimeBuildVersion(right) ?? "")
    .localeCompare(String(setupRuntimeBuildVersion(left) ?? ""), undefined, { numeric: true });
  if (buildComparison !== 0) {
    return buildComparison;
  }
  const identifierComparison = String(left.identifier ?? "").localeCompare(String(right.identifier ?? ""));
  if (identifierComparison !== 0) {
    return identifierComparison;
  }
  return setupRuntimeSupportedTypeKey(left).localeCompare(setupRuntimeSupportedTypeKey(right));
}

function runtimeSupportedDeviceTypes(runtime, inventory) {
  const runtimeDeviceTypes = Array.isArray(runtime?.supportedDeviceTypes)
    ? runtime.supportedDeviceTypes
    : [];
  if (runtimeDeviceTypes.length > 0) {
    return runtimeDeviceTypes;
  }
  return Array.isArray(inventory?.deviceTypesJson?.devicetypes)
    ? inventory.deviceTypesJson.devicetypes
    : [];
}

function compatibleSetupDeviceTypes(runtime, inventory) {
  const supportedDeviceTypes = runtimeSupportedDeviceTypes(runtime, inventory);
  return {
    iPad: supportedDeviceTypes.some((deviceType) => isCompleteSetupDeviceType(deviceType, "iPad")),
    iPhone: supportedDeviceTypes.some((deviceType) => isCompleteSetupDeviceType(deviceType, "iPhone")),
  };
}

function selectPreferredDeviceTypeForSetup(runtime, inventory, deviceFamily) {
  return selectPreferredDeviceType({
    ...runtime,
    supportedDeviceTypes: runtimeSupportedDeviceTypes(runtime, inventory),
  }, deviceFamily);
}

function selectRuntimeForSetup(inventory, requestedVersion) {
  const runtimesByIdentifier = new Map();
  for (const runtime of inventory.runtimesJson?.runtimes ?? []) {
    if (!isAvailableIosRuntime(runtime) || !runtimeMatchesRequestedVersion(runtime, requestedVersion)) {
      continue;
    }
    const families = compatibleSetupDeviceTypes(runtime, inventory);
    if (!families.iPhone || !families.iPad) {
      continue;
    }
    const existing = runtimesByIdentifier.get(runtime.identifier);
    if (!existing || compareSetupRuntimes(runtime, existing) < 0) {
      runtimesByIdentifier.set(runtime.identifier, runtime);
    }
  }
  const runtimes = [...runtimesByIdentifier.values()].sort(compareSetupRuntimes);
  if (runtimes.length === 0) {
    const qualifier = requestedVersion ? ` matching ${requestedVersion}` : "";
    throw new BrokerError(`No available iOS runtime${qualifier} supports both iPhone and iPad setup devices.`, {
      iosVersion: requestedVersion ?? null,
      reasonCode: "runtime-not-found",
    });
  }
  return runtimes[0];
}

function setupRuntimeSummary(runtime, requestedVersion) {
  return {
    buildVersion: setupRuntimeBuildVersion(runtime),
    identifier: runtime.identifier,
    selectionSource: requestedVersion ? "explicit" : "automatic",
    version: runtime.version,
  };
}

function setupDevicePlan(inventory, hostId, runtime) {
  const { templates } = buildStarterAliasTemplates({
    hostId,
    iosVersion: runtime.version,
  });
  const deviceTypes = {
    iPad: requireCompleteSetupDeviceType(
      selectPreferredDeviceTypeForSetup(runtime, inventory, "iPad"),
      "iPad",
      runtime,
    ),
    iPhone: requireCompleteSetupDeviceType(
      selectPreferredDeviceTypeForSetup(runtime, inventory, "iPhone"),
      "iPhone",
      runtime,
    ),
  };
  const deviceIndex = createDeviceIndex({
    deviceTypesJson: inventory.deviceTypesJson,
    devicesJson: inventory.devicesJson,
    runtimesJson: inventory.runtimesJson,
  });
  const devices = templates.map((template) => {
    const deviceType = deviceTypes[template.deviceFamily];
    const reusable = [...deviceIndex.values()]
      .filter((device) => typeof device.udid === "string" && device.udid.length > 0
        && device.isAvailable
        && device.name === template.simulatorName
        && device.runtimeIdentifier === runtime.identifier
        && device.deviceTypeIdentifier === deviceType.identifier)
      .sort((left, right) => left.udid.localeCompare(right.udid))[0] ?? null;
    return {
      action: reusable ? "reuse" : "create",
      alias: template.alias,
      capabilities: template.capabilities,
      deviceFamily: template.deviceFamily,
      deviceTypeIdentifier: deviceType.identifier,
      deviceTypeName: deviceType.name,
      displayName: template.displayName,
      resetPolicy: template.resetPolicy,
      runtimeIdentifier: runtime.identifier,
      runtimeVersion: runtime.version,
      simulatorId: reusable?.udid ?? null,
      simulatorName: template.simulatorName,
    };
  });
  return {
    devices,
    deviceTypes,
  };
}

function requestedSetupHostId(options) {
  return typeof options.hostId === "string" && options.hostId.trim() !== ""
    ? slugifyIdentifier(options.hostId, defaultHostId())
    : null;
}

function setupHostConfigDigest(hostConfig) {
  return hostConfig ? sha256Digest(hostConfig) : null;
}

function setupPlanFingerprint({ configured, devices, hostConfig, hostId, runtime }) {
  return sha256Digest({
    devices: devices.map((device) => ({
      action: device.action,
      alias: device.alias,
      capabilities: device.capabilities,
      deviceFamily: device.deviceFamily,
      deviceTypeIdentifier: device.deviceTypeIdentifier,
      displayName: device.displayName,
      resetPolicy: device.resetPolicy,
      reusableSimulatorId: device.action === "reuse" ? device.simulatorId : null,
      runtimeIdentifier: device.runtimeIdentifier,
      runtimeVersion: device.runtimeVersion,
      simulatorName: device.simulatorName,
    })),
    host: {
      configured,
      digest: setupHostConfigDigest(hostConfig),
      hostId,
    },
    runtime: runtime ? {
      buildVersion: runtime.buildVersion,
      identifier: runtime.identifier,
      version: runtime.version,
    } : null,
    schemaVersion: SETUP_SCHEMA_VERSION,
  });
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function setupHostMatchesCommittedStarterPlan(hostConfig, devices, inventory) {
  if (hostConfig.pendingRetirements.length > 0 || hostConfig.aliases.length !== 6) {
    return false;
  }
  const iosVersion = hostConfig.aliases[0]?.iosVersion;
  if (!iosVersion || hostConfig.aliases.some((alias) => alias.iosVersion !== iosVersion)) {
    return false;
  }
  const runtimeIdentifiers = new Set(devices.map((device) => device.runtimeIdentifier));
  if (runtimeIdentifiers.size !== 1) {
    return false;
  }
  const runtimeIdentifier = [...runtimeIdentifiers][0];
  let runtime;
  let setupDeviceTypes;
  try {
    runtime = selectRuntimeForSetup(inventory, iosVersion);
    if (runtime.identifier !== runtimeIdentifier || runtime.version !== iosVersion) {
      return false;
    }
    setupDeviceTypes = {
      iPad: selectPreferredDeviceTypeForSetup(runtime, inventory, "iPad").identifier,
      iPhone: selectPreferredDeviceTypeForSetup(runtime, inventory, "iPhone").identifier,
    };
  } catch {
    return false;
  }
  const { templates } = buildStarterAliasTemplates({ hostId: hostConfig.hostId, iosVersion });
  const aliasesById = new Map(hostConfig.aliases.map((alias) => [alias.alias, alias]));
  const devicesByAlias = new Map(devices.map((device) => [device.alias, device]));
  return templates.every((template) => {
    const alias = aliasesById.get(template.alias);
    const device = devicesByAlias.get(template.alias);
    return alias
      && device
      && alias.deviceFamily === template.deviceFamily
      && alias.displayName === template.displayName
      && alias.resetPolicy === template.resetPolicy
      && sameStringArray(alias.capabilities, template.capabilities)
      && device.simulatorId === alias.simulatorId
      && device.simulatorName === template.simulatorName
      && device.runtimeIdentifier === runtime.identifier
      && device.runtimeVersion === runtime.version
      && device.deviceTypeIdentifier === setupDeviceTypes[template.deviceFamily];
  });
}

function pathOccupied(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return false;
    }
    return true;
  }
}

function setupOccupiedDirectoryInvalid(directoryPath) {
  if (!pathOccupied(directoryPath)) {
    return false;
  }
  try {
    return fs.statSync(directoryPath).isDirectory() !== true;
  } catch {
    return true;
  }
}

function setupOwnedStateDirectoriesInvalid(paths) {
  return setupOccupiedDirectoryInvalid(paths.capacityTransactionsDir)
    || setupOccupiedDirectoryInvalid(paths.evidenceDir);
}

function setupOccupiedAuditLogInvalid(paths) {
  if (!pathOccupied(paths.eventsPath)) {
    return false;
  }
  try {
    if (fs.statSync(paths.eventsPath).isFile() !== true) {
      return true;
    }
    fs.accessSync(paths.eventsPath, fs.constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

function readOccupiedJsonFile(filePath, message) {
  if (!pathOccupied(filePath)) {
    return null;
  }
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    stats = null;
  }
  if (stats?.isFile() !== true) {
    throw new BrokerError(message, {
      path: filePath,
      reasonCode: "invalid-config",
    });
  }
  const payload = readJsonIfExists(filePath);
  if (payload === null) {
    throw new BrokerError(message, {
      path: filePath,
      reasonCode: "invalid-config",
    });
  }
  return payload;
}

function readOccupiedKnownProjects(filePath) {
  return readOccupiedJsonFile(
    filePath,
    "The existing known-projects catalog could not be read as a regular file.",
  );
}

function readOccupiedRegistry(filePath) {
  return readOccupiedJsonFile(
    filePath,
    "The existing broker registry could not be read as a regular file.",
  );
}

function readOccupiedIdlePolicy(paths) {
  if (!pathOccupied(paths.idlePolicyPath)) {
    return null;
  }
  let stats;
  try {
    stats = fs.statSync(paths.idlePolicyPath);
  } catch {
    stats = null;
  }
  if (stats?.isFile() !== true) {
    throw new BrokerError("The existing idle policy could not be read as a regular file.", {
      path: paths.idlePolicyPath,
      reasonCode: "invalid-config",
    });
  }
  return readIdlePolicy(paths);
}

function setupStateContainsLeaseOrPinRecords(paths) {
  try {
    return [paths.leasesDir, paths.pinsDir].some((directoryPath) => {
      if (setupOccupiedDirectoryInvalid(directoryPath)) {
        return true;
      }
      return fs.existsSync(directoryPath)
        && fs.readdirSync(directoryPath, { withFileTypes: true })
          .some((entry) => entry.name.endsWith(".json"));
    });
  } catch {
    // Unreadable mutation state is not safe to reinterpret as an untouched setup.
    return true;
  }
}

function setupStateContainsExistingBrokerArtifacts(paths) {
  try {
    if (pathOccupied(paths.registryPath)) {
      return true;
    }
    if (setupOwnedStateDirectoriesInvalid(paths)) {
      return true;
    }
    return setupStateContainsLeaseOrPinRecords(paths);
  } catch {
    return true;
  }
}

function shellQuoteArgument(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function setupCliCommandWithSelectedPaths(command, paths) {
  return [
    command,
    "--host-config",
    shellQuoteArgument(paths.hostConfigPath),
    "--state-root",
    shellQuoteArgument(paths.stateRoot),
    "--service-socket",
    shellQuoteArgument(paths.serviceSocketPath),
  ].join(" ");
}

function setupExistingHostState(paths, inventory, options = {}) {
  let hostConfig;
  try {
    hostConfig = readHostConfigOrThrow(paths);
  } catch (error) {
    if (!(error instanceof BrokerError)) {
      throw error;
    }
    const hostId = requestedSetupHostId(options);
    const planId = setupPlanFingerprint({
      configured: true,
      devices: [],
      hostConfig: null,
      hostId,
      runtime: null,
    });
    return {
      hostConfig: null,
      preview: {
        command: "setup",
        confirmation: { createCount: 0, required: false, reuseCount: 0 },
        devices: [],
        host: { action: "keep", configured: true, hostId },
        mode: "preview",
        nextSteps: [setupCliCommandWithSelectedPaths("simbroker doctor", paths)],
        ok: true,
        planId,
        prerequisites: [{
          details: error.payload,
          id: "host-config",
          status: "blocked",
          summary: error.message,
          remediationCommands: [setupCliCommandWithSelectedPaths("simbroker doctor", paths)],
        }],
        runtime: null,
        schemaVersion: SETUP_SCHEMA_VERSION,
        service: { action: "blocked", running: false },
        status: "blocked",
      },
    };
  }

  const deviceIndex = createDeviceIndex({
    deviceTypesJson: inventory.deviceTypesJson,
    devicesJson: inventory.devicesJson,
    runtimesJson: inventory.runtimesJson,
  });
  const deviceTypes = new Map((inventory.deviceTypesJson?.devicetypes ?? [])
    .map((deviceType) => [deviceType.identifier, deviceType]));
  const issues = [];
  const requestedHostId = requestedSetupHostId(options);
  if (requestedHostId !== null && requestedHostId !== hostConfig.hostId) {
    issues.push({
      id: "host-id",
      status: "blocked",
      summary: `Requested host ID ${requestedHostId} does not match the existing host ${hostConfig.hostId}.`,
      details: {
        configuredHostId: hostConfig.hostId,
        requestedHostId,
      },
      remediationCommands: [setupCliCommandWithSelectedPaths("simbroker setup", paths)],
    });
  }
  try {
    normalizeKnownProjects(readOccupiedKnownProjects(paths.knownProjectsPath), nowIso(options.now));
  } catch (error) {
    issues.push({
      id: "known-projects",
      status: "blocked",
      summary: "The existing known-projects catalog is invalid and setup will not replace it automatically.",
      details: error instanceof BrokerError ? error.payload : { message: error.message },
      remediationCommands: [setupCliCommandWithSelectedPaths("simbroker doctor", paths)],
    });
  }
  try {
    readOccupiedIdlePolicy(paths);
  } catch (error) {
    issues.push({
      id: "idle-policy",
      status: "blocked",
      summary: "The existing idle policy is invalid and setup will not replace it automatically.",
      details: error instanceof BrokerError ? error.payload : { message: error.message },
      remediationCommands: [setupCliCommandWithSelectedPaths("simbroker doctor", paths)],
    });
  }
  try {
    if (setupOwnedStateDirectoriesInvalid(paths)) {
      throw new BrokerError("The existing capacity-transactions or evidence directory could not be used as a directory.", {
        capacityTransactionsDir: paths.capacityTransactionsDir,
        evidenceDir: paths.evidenceDir,
        reasonCode: "invalid-config",
      });
    }
  } catch (error) {
    issues.push({
      id: "state-root",
      status: "blocked",
      summary: "The existing capacity-transactions or evidence directory is invalid and setup will not replace it automatically.",
      details: error instanceof BrokerError ? error.payload : { message: error.message },
      remediationCommands: [setupCliCommandWithSelectedPaths("simbroker doctor", paths)],
    });
  }
  try {
    const hostAliasesById = new Map(hostConfig.aliases.map((alias) => [alias.alias, alias]));
    if (setupOccupiedDirectoryInvalid(paths.leasesDir) || setupOccupiedDirectoryInvalid(paths.pinsDir)) {
      throw new BrokerError("The existing lease or pin directory could not be used as a directory.", {
        leasesDir: paths.leasesDir,
        pinsDir: paths.pinsDir,
        reasonCode: "invalid-config",
      });
    }
    const seenLeaseAliases = new Set();
    for (const { name, record } of listJsonFileEntries(paths.leasesDir)) {
      assertValidLeaseRecord(record);
      assertStoredRecordFileName(name, record.leaseId, "lease");
      const hostAlias = hostAliasesById.get(record.alias);
      if (!hostAlias) {
        throw new BrokerError(`Lease ${record.leaseId} names unknown alias ${record.alias}.`, {
          alias: record.alias,
          leaseId: record.leaseId,
          reasonCode: "invalid-config",
        });
      }
      if (record.simulatorId !== hostAlias.simulatorId) {
        throw new BrokerError(
          `Lease ${record.leaseId} simulator ${record.simulatorId} does not match alias ${record.alias}.`,
          {
            alias: record.alias,
            expectedSimulatorId: hostAlias.simulatorId,
            leaseId: record.leaseId,
            reasonCode: "invalid-config",
            simulatorId: record.simulatorId,
          },
        );
      }
      if (seenLeaseAliases.has(record.alias)) {
        throw new BrokerError(`Multiple lease records claim alias ${record.alias}.`, {
          alias: record.alias,
          reasonCode: "invalid-config",
        });
      }
      seenLeaseAliases.add(record.alias);
    }
    const seenPinAliases = new Set();
    for (const { name, record } of listJsonFileEntries(paths.pinsDir)) {
      assertValidPinRecord(record);
      assertStoredRecordFileName(name, record.pinId, "pin");
      if (!hostAliasesById.has(record.alias)) {
        throw new BrokerError(`Pin ${record.pinId} names unknown alias ${record.alias}.`, {
          alias: record.alias,
          pinId: record.pinId,
          reasonCode: "invalid-config",
        });
      }
      if (seenPinAliases.has(record.alias)) {
        throw new BrokerError(`Multiple pin records claim alias ${record.alias}.`, {
          alias: record.alias,
          reasonCode: "invalid-config",
        });
      }
      seenPinAliases.add(record.alias);
    }
  } catch (error) {
    issues.push({
      id: "leases",
      status: "blocked",
      summary: "Existing lease or pin records are invalid and setup will not replace them automatically.",
      details: error instanceof BrokerError ? error.payload : { message: error.message },
      remediationCommands: [setupCliCommandWithSelectedPaths("simbroker doctor", paths)],
    });
  }
  let registry = null;
  let registryInitializationRequired = false;
  let registryMissing = false;
  try {
    const persistedRegistry = readOccupiedRegistry(paths.registryPath);
    if (persistedRegistry === null) {
      registryMissing = true;
      registry = normalizeRegistry(null, hostConfig, nowIso(options.now));
    } else {
      assertValidPersistedRegistry(persistedRegistry, hostConfig);
      registry = normalizeRegistry(persistedRegistry, hostConfig, nowIso(options.now));
    }
  } catch (error) {
    issues.push({
      id: "registry",
      status: "blocked",
      summary: "The existing broker registry is invalid and setup will not replace it automatically.",
      details: error instanceof BrokerError ? error.payload : { message: error.message },
      remediationCommands: [setupCliCommandWithSelectedPaths("simbroker doctor", paths)],
    });
  }
  const devices = hostConfig.aliases.map((alias) => {
    const device = deviceIndex.get(alias.simulatorId) ?? null;
    const deviceType = device ? deviceTypes.get(device.deviceTypeIdentifier) ?? null : null;
    const registryHealth = registry?.aliases?.[alias.alias]?.health ?? "healthy";
    const healthy = Boolean(device?.isAvailable)
      && iosVersionSatisfies(device.runtimeVersion ?? "", alias.iosVersion)
      && device.deviceFamily === alias.deviceFamily
      && registryHealth !== "repair-needed"
      && registryHealth !== "repairing";
    if (!healthy) {
      issues.push({
        alias: alias.alias,
        id: `alias-${alias.alias}`,
        status: "blocked",
        summary: registryHealth === "repair-needed" || registryHealth === "repairing"
          ? `Managed alias ${alias.alias} requires repair before setup can continue.`
          : `Managed alias ${alias.alias} does not resolve to its configured available Simulator.`,
        remediationCommands: [
          setupCliCommandWithSelectedPaths(
            `simbroker simulators repair --alias ${shellQuoteArgument(alias.alias)}`,
            paths,
          ),
        ],
      });
    }
    return {
      action: "reuse",
      alias: alias.alias,
      capabilities: alias.capabilities,
      deviceFamily: alias.deviceFamily,
      deviceTypeIdentifier: device?.deviceTypeIdentifier ?? null,
      deviceTypeName: deviceType?.name ?? "Unavailable",
      displayName: alias.displayName,
      resetPolicy: alias.resetPolicy,
      runtimeIdentifier: device?.runtimeIdentifier ?? null,
      runtimeVersion: alias.iosVersion,
      simulatorId: alias.simulatorId,
      simulatorName: device?.name ?? alias.displayName,
    };
  });
  if (registryMissing) {
    const canResumeRegistryInitialization = issues.length === 0
      && setupHostMatchesCommittedStarterPlan(hostConfig, devices, inventory)
      && !setupStateContainsLeaseOrPinRecords(paths);
    registryInitializationRequired = canResumeRegistryInitialization;
    issues.push(canResumeRegistryInitialization
      ? {
        id: "registry",
        status: "info",
        summary: "The committed starter host registry will be initialized when setup resumes.",
        remediationCommands: [],
      }
      : {
        id: "registry",
        status: "blocked",
        summary: "The existing broker registry is missing and setup will not recreate it automatically.",
        remediationCommands: [setupCliCommandWithSelectedPaths("simbroker doctor", paths)],
      });
  }
  const planId = setupPlanFingerprint({
    configured: true,
    devices,
    hostConfig,
    hostId: requestedHostId ?? hostConfig.hostId,
    runtime: null,
  });
  const blocked = issues.some((issue) => issue.status === "blocked");
  return {
    hostConfig,
    preview: {
      command: "setup",
      confirmation: { createCount: 0, required: false, reuseCount: devices.length },
      devices,
      host: { action: "keep", configured: true, hostId: hostConfig.hostId },
      mode: "preview",
      nextSteps: blocked
        ? issues.flatMap((issue) => issue.remediationCommands)
        : (registryInitializationRequired ? [] : ["simbroker project init", "simbroker project validate"]),
      ok: true,
      planId,
      prerequisites: issues,
      runtime: null,
      schemaVersion: SETUP_SCHEMA_VERSION,
      service: { action: blocked ? "blocked" : "start", running: false },
      status: blocked ? "blocked" : (registryInitializationRequired ? "changes_required" : "ready"),
    },
  };
}

function blockedUnconfiguredSetupPreview(paths, options = {}, prerequisite) {
  const hostId = requestedSetupHostId(options)
    ?? slugifyIdentifier(options.hostId ?? defaultHostId(), defaultHostId());
  const planId = setupPlanFingerprint({
    configured: false,
    devices: [],
    hostConfig: null,
    hostId,
    runtime: null,
  });
  return {
    hostConfig: null,
    preview: {
      command: "setup",
      confirmation: { createCount: 0, required: false, reuseCount: 0 },
      devices: [],
      host: { action: "keep", configured: false, hostId },
      mode: "preview",
      nextSteps: prerequisite.remediationCommands ?? [],
      ok: true,
      planId,
      prerequisites: [prerequisite],
      runtime: null,
      schemaVersion: SETUP_SCHEMA_VERSION,
      service: { action: "blocked", running: false },
      status: "blocked",
    },
  };
}

function blockedSetupExistingStateWithoutHost(paths, options = {}) {
  return blockedUnconfiguredSetupPreview(paths, options, {
    id: "state-root",
    remediationCommands: [setupCliCommandWithSelectedPaths("simbroker doctor", paths)],
    status: "blocked",
    summary: "The selected state root already contains broker state and setup will not create a new host over it.",
  });
}

function blockedSetupInvalidKnownProjectsWithoutHost(paths, options, error) {
  return blockedUnconfiguredSetupPreview(paths, options, {
    details: error instanceof BrokerError ? error.payload : { message: error.message },
    id: "known-projects",
    remediationCommands: [setupCliCommandWithSelectedPaths("simbroker doctor", paths)],
    status: "blocked",
    summary: "The existing known-projects catalog is invalid and setup will not replace it automatically.",
  });
}

function blockedSetupInvalidIdlePolicyWithoutHost(paths, options, error) {
  return blockedUnconfiguredSetupPreview(paths, options, {
    details: error instanceof BrokerError ? error.payload : { message: error.message },
    id: "idle-policy",
    remediationCommands: [setupCliCommandWithSelectedPaths("simbroker doctor", paths)],
    status: "blocked",
    summary: "The existing idle policy is invalid and setup will not replace it automatically.",
  });
}

function blockedSetupInvalidEventsWithoutHost(paths, options = {}) {
  return blockedUnconfiguredSetupPreview(paths, options, {
    details: { path: paths.eventsPath },
    id: "events",
    remediationCommands: [setupCliCommandWithSelectedPaths("simbroker doctor", paths)],
    status: "blocked",
    summary: "The existing audit log is not a writable regular file and setup will not create a new host over it.",
  });
}

function buildSetupPlan(paths, options = {}) {
  const inventory = readSimctlInventory(options);
  if (pathOccupied(paths.hostConfigPath)) {
    return setupExistingHostState(paths, inventory, options);
  }
  if (setupStateContainsExistingBrokerArtifacts(paths)) {
    return blockedSetupExistingStateWithoutHost(paths, options);
  }
  if (pathOccupied(paths.knownProjectsPath)) {
    try {
      normalizeKnownProjects(readOccupiedKnownProjects(paths.knownProjectsPath), nowIso(options.now));
    } catch (error) {
      return blockedSetupInvalidKnownProjectsWithoutHost(paths, options, error);
    }
  }
  if (pathOccupied(paths.idlePolicyPath)) {
    try {
      readOccupiedIdlePolicy(paths);
    } catch (error) {
      return blockedSetupInvalidIdlePolicyWithoutHost(paths, options, error);
    }
  }
  if (setupOccupiedAuditLogInvalid(paths)) {
    return blockedSetupInvalidEventsWithoutHost(paths, options);
  }

  const runtime = selectRuntimeForSetup(inventory, options.iosVersion);
  const hostId = slugifyIdentifier(options.hostId ?? defaultHostId(), defaultHostId());
  const { devices } = setupDevicePlan(inventory, hostId, runtime);
  const runtimeSummary = setupRuntimeSummary(runtime, options.iosVersion);
  const createCount = devices.filter((device) => device.action === "create").length;
  const reuseCount = devices.length - createCount;
  const planId = setupPlanFingerprint({
    configured: false,
    devices,
    hostConfig: null,
    hostId,
    runtime: runtimeSummary,
  });
  return {
    hostConfig: null,
    inventory,
    preview: {
      command: "setup",
      confirmation: { createCount, required: true, reuseCount },
      devices,
      host: { action: "create", configured: false, hostId },
      mode: "preview",
      nextSteps: [],
      ok: true,
      planId,
      prerequisites: [],
      runtime: runtimeSummary,
      schemaVersion: SETUP_SCHEMA_VERSION,
      service: { action: "start", running: false },
      status: "changes_required",
    },
  };
}

export function previewSetupBroker(paths, options = {}) {
  return buildSetupPlan(paths, options).preview;
}

function setupCancellationError(options) {
  const signalName = options.getCancellationSignalName?.() ?? options.cancellationSignalName ?? "SIGINT";
  return new BrokerError("Setup was interrupted.", {
    completedStages: options.completedStages ?? [],
    failedStage: options.failedStage ?? "provisioning",
    hostCommitted: options.hostCommitted === true,
    reasonCode: "setup-interrupted",
    recoveryCommand: "simbroker setup",
    serviceRunning: false,
    exitCode: signalName === "SIGTERM" ? 143 : 130,
  });
}

function throwIfSetupCancelled(options, state = {}) {
  if (options.signal?.aborted || options.isCancelled?.() === true) {
    throw setupCancellationError({
      ...options,
      ...state,
    });
  }
}

function setupHostConfigFromPlan(plan, simulatorIdsByAlias) {
  return {
    aliases: plan.devices.map((device) => ({
      alias: device.alias,
      capabilities: device.capabilities,
      deviceFamily: device.deviceFamily,
      displayName: device.displayName,
      iosVersion: device.runtimeVersion,
      resetPolicy: device.resetPolicy,
      simulatorId: simulatorIdsByAlias.get(device.alias),
    })),
    hostId: plan.host.hostId,
    version: HOST_CONFIG_VERSION,
  };
}

function setupCommittedHostIdentity(hostConfig) {
  return {
    hostId: hostConfig.hostId,
    simulators: hostConfig.aliases.map(({ alias, simulatorId }) => ({ alias, simulatorId })),
  };
}

export function applySetupBroker(paths, options = {}) {
  const lockTimestamp = nowIso(options.now);
  return withCapacityLock(paths, () => withLeaseMutationLock(paths, () => {
    const timestamp = nowIso(options.now);
    const { preview, inventory } = buildSetupPlan(paths, options);
    if (!options.confirmPlanId) {
      throw new BrokerError("Setup requires confirmation of the current plan.", {
        currentPlanId: preview.planId,
        failedStage: "confirmation",
        reasonCode: "setup-confirmation-required",
        recoveryCommand: "simbroker setup",
      });
    }
    if (options.confirmPlanId !== preview.planId) {
      throw new BrokerError("The setup plan changed. Preview it again before applying.", {
        confirmedPlanId: options.confirmPlanId,
        currentPlanId: preview.planId,
        failedStage: "confirmation",
        reasonCode: "setup-plan-stale",
        recoveryCommand: "simbroker setup",
      });
    }
    if (preview.status === "blocked") {
      throw new BrokerError("Setup is blocked by the current host configuration.", {
        failedStage: "planning",
        prerequisites: preview.prerequisites,
        reasonCode: "setup-prerequisite-failed",
        recoveryCommand: "simbroker setup",
      });
    }

    ensureStatePaths(paths);

    if (preview.host.configured) {
      const state = loadBrokerState(paths, stateLoadOptions(options, timestamp));
      return {
        setupCommittedHostIdentity: setupCommittedHostIdentity(state.hostConfig),
        command: "setup",
        devices: { created: 0, reused: state.hostConfig.aliases.length, total: state.hostConfig.aliases.length },
        host: { configured: true, created: false },
        mode: "apply",
        ok: true,
        planId: preview.planId,
        schemaVersion: SETUP_SCHEMA_VERSION,
        status: "ready",
      };
    }

    const simctl = inventory.simctl;
    const baselineDeviceIds = new Set(readSimulatorDeviceIndex(simctl).keys());
    const setupAttemptId = options.setupAttemptId ?? crypto.randomUUID();
    const attributableSimulatorNames = new Set();
    const createdSimulatorIds = [];
    const simulatorIdsByAlias = new Map();
    let hostCommitted = false;
    try {
      for (const device of preview.devices) {
        throwIfSetupCancelled(options, {
          completedStages: createdSimulatorIds.length === 0 ? [] : ["devices-partial"],
          failedStage: "devices",
          hostCommitted,
        });
        if (device.action === "reuse") {
          simulatorIdsByAlias.set(device.alias, device.simulatorId);
          continue;
        }
        const temporaryName = `${device.simulatorName} [setup ${setupAttemptId} ${device.alias}]`;
        attributableSimulatorNames.add(temporaryName);
        let simulatorId = null;
        try {
          simulatorId = simctl.createDevice(
            temporaryName,
            device.deviceTypeIdentifier,
            device.runtimeIdentifier,
          );
          createdSimulatorIds.push(simulatorId);
          simctl.renameDevice(simulatorId, device.simulatorName);
          simulatorIdsByAlias.set(device.alias, simulatorId);
        } catch (error) {
          if (simulatorId === null) {
            const currentIndex = readSimulatorDeviceIndex(simctl);
            for (const candidate of currentIndex.values()) {
              if (!baselineDeviceIds.has(candidate.udid)
                && candidate.name === temporaryName
                && candidate.runtimeIdentifier === device.runtimeIdentifier
                && candidate.deviceTypeIdentifier === device.deviceTypeIdentifier) {
                createdSimulatorIds.push(candidate.udid);
              }
            }
          }
          throw error;
        }
      }
      throwIfSetupCancelled(options, {
        completedStages: ["devices"],
        failedStage: "host-config",
        hostCommitted,
      });
      const hostConfig = setupHostConfigFromPlan(preview, simulatorIdsByAlias);
      writeJsonAtomicDurable(paths.hostConfigPath, hostConfig, {
        failStage: options.hostWriteFailStage,
      });
      fs.chmodSync(paths.hostConfigPath, 0o600);
      hostCommitted = true;
      const state = loadBrokerState(paths, stateLoadOptions(options, timestamp));
      appendEventRecord(paths, "host.initialized", {
        alias: null,
        leaseId: null,
        payload: {
          aliasCount: state.hostConfig.aliases.length,
          bootstrapConfig: true,
          hostId: state.hostConfig.hostId,
          setupPlanId: preview.planId,
        },
        projectId: null,
        purposeId: null,
      }, timestamp);
      return {
        setupCommittedHostIdentity: setupCommittedHostIdentity(state.hostConfig),
        command: "setup",
        devices: {
          created: createdSimulatorIds.length,
          reused: preview.devices.length - createdSimulatorIds.length,
          total: preview.devices.length,
        },
        host: { configured: true, created: true },
        mode: "apply",
        ok: true,
        planId: preview.planId,
        schemaVersion: SETUP_SCHEMA_VERSION,
        status: "ready",
      };
    } catch (error) {
      hostCommitted = hostCommitted || error?.hostConfigCommitted === true || fs.existsSync(paths.hostConfigPath);
      let failure = error;
      if (!hostCommitted) {
        const rollbackFailures = rollbackCreatedSimulators(simctl, createdSimulatorIds, {
          baselineDeviceIds,
          plannedSimulatorNames: attributableSimulatorNames,
        });
        failure = attachRollbackFailures(failure, rollbackFailures);
      }
      if (failure instanceof BrokerError) {
        failure.payload.hostCommitted = hostCommitted;
        failure.payload.recoveryCommand ??= "simbroker setup";
      }
      throw failure;
    }
  }, {
    checkCancellation: () => throwIfSetupCancelled(options, {
      completedStages: [],
      failedStage: "confirmation",
      hostCommitted: false,
    }),
    initializePersistentState: false,
    now: lockTimestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  }), {
    checkCancellation: () => throwIfSetupCancelled(options, {
      completedStages: [],
      failedStage: "confirmation",
      hostCommitted: false,
    }),
    initializePersistentState: false,
    now: lockTimestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    reclaimTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
    timeoutMs: options.capacityLockTimeoutMilliseconds ?? SETUP_CAPACITY_LOCK_TIMEOUT_MS,
  });
}

function syncRegistryWithSimctl(hostConfig, registry, options = {}) {
  const inventory = options.simctlInventory ?? readSimctlInventory(options);
  const deviceIndex = createDeviceIndex({
    deviceTypesJson: inventory.deviceTypesJson,
    devicesJson: inventory.devicesJson,
    runtimesJson: inventory.runtimesJson,
  });

  for (const hostAlias of hostConfig.aliases) {
    const registryEntry = registry.aliases[hostAlias.alias];
    const device = deviceIndex.get(hostAlias.simulatorId) ?? null;

    if (!device || device.isAvailable === false) {
      registryEntry.health = "repair-needed";
      registryEntry.driftReason = device ? "simulator-unavailable" : "simulator-missing";
      registryEntry.powerState = "shutdown";
      continue;
    }

    if (device.deviceFamily !== hostAlias.deviceFamily || !iosVersionSatisfies(device.runtimeVersion ?? "", hostAlias.iosVersion)) {
      registryEntry.health = "repair-needed";
      registryEntry.driftReason = "simulator-config-mismatch";
      registryEntry.powerState = device.state === "Booted" ? "booted" : "shutdown";
      continue;
    }

    registryEntry.powerState = device.state === "Booted" ? "booted" : "shutdown";
    if (registryEntry.health === "repairing") {
      registryEntry.health = "repair-needed";
      registryEntry.driftReason = registryEntry.driftReason ?? "repair-interrupted";
      continue;
    }
    if (registryEntry.health === "healthy" || registryEntry.health === "state-drift") {
      registryEntry.health = "healthy";
      registryEntry.driftReason = null;
    }
  }
}

function normalizeKnownProjects(rawKnownProjects, timestamp) {
  if (rawKnownProjects === null) {
    rawKnownProjects = {
      projects: Object.create(null),
      updatedAt: timestamp,
      version: KNOWN_PROJECTS_VERSION,
    };
  }

  validateVersion(rawKnownProjects.version, KNOWN_PROJECTS_VERSION, "known-projects");
  const rawProjects = requireObject(rawKnownProjects.projects, "known-projects.projects");
  const projects = Object.create(null);

  for (const [projectId, rawProject] of Object.entries(rawProjects)) {
    const fieldPrefix = `known-projects.projects.${projectId}`;
    const project = requireObject(rawProject, fieldPrefix);
    const purposes = requireArray(project.purposes, `${fieldPrefix}.purposes`)
      .map((purpose, index) => validateProjectPurpose(purpose, `${fieldPrefix}.purposes[${index}]`));
    const purposeIds = new Set();
    for (const purpose of purposes) {
      if (purposeIds.has(purpose.id)) {
        throw new BrokerError(`Duplicate purpose ${purpose.id} in ${fieldPrefix}.purposes.`, {
          field: `${fieldPrefix}.purposes`,
          reasonCode: "invalid-config",
        });
      }
      purposeIds.add(purpose.id);
    }

    const recordProjectId = requireString(project.projectId, `${fieldPrefix}.projectId`);
    if (recordProjectId !== projectId) {
      throw new BrokerError(`${fieldPrefix}.projectId must equal the catalog key.`, {
        actualProjectId: recordProjectId,
        catalogKey: projectId,
        field: `${fieldPrefix}.projectId`,
        reasonCode: "invalid-config",
      });
    }
    projects[projectId] = {
      lastObservedAt: typeof project.lastObservedAt === "string" ? project.lastObservedAt : timestamp,
      projectFilePath: requireString(project.projectFilePath, `${fieldPrefix}.projectFilePath`),
      projectId: recordProjectId,
      projectName: requireString(project.projectName, `${fieldPrefix}.projectName`),
      purposes,
      repoRoot: requireString(project.repoRoot, `${fieldPrefix}.repoRoot`),
    };
  }

  return {
    projects,
    updatedAt: typeof rawKnownProjects.updatedAt === "string" ? rawKnownProjects.updatedAt : timestamp,
    version: KNOWN_PROJECTS_VERSION,
  };
}

function assertValidPersistedRegistry(rawRegistry, hostConfig) {
  requireObject(rawRegistry, "registry");
  const rawAliases = requireObject(rawRegistry.aliases, "registry.aliases");
  if (
    hostConfig.aliases.length > 0
    && !hostConfig.aliases.some((hostAlias) => Object.hasOwn(rawAliases, hostAlias.alias))
  ) {
    throw new BrokerError("registry.aliases must include at least one configured host alias.", {
      field: "registry.aliases",
      reasonCode: "invalid-config",
    });
  }
  for (const hostAlias of hostConfig.aliases) {
    if (!Object.hasOwn(rawAliases, hostAlias.alias)) {
      continue;
    }
    const fieldPrefix = `registry.aliases.${hostAlias.alias}`;
    const entry = requireObject(rawAliases[hostAlias.alias], fieldPrefix);
    if (Object.hasOwn(entry, "health") && !ALLOWED_HEALTH_STATES.has(entry.health)) {
      throw new BrokerError(
        `${fieldPrefix}.health must be one of ${[...ALLOWED_HEALTH_STATES].join(", ")}.`,
        {
          field: `${fieldPrefix}.health`,
          reasonCode: "invalid-config",
        },
      );
    }
    if (Object.hasOwn(entry, "powerState") && !ALLOWED_POWER_STATES.has(entry.powerState)) {
      throw new BrokerError(
        `${fieldPrefix}.powerState must be one of ${[...ALLOWED_POWER_STATES].join(", ")}.`,
        {
          field: `${fieldPrefix}.powerState`,
          reasonCode: "invalid-config",
        },
      );
    }
  }
  return rawRegistry;
}

function normalizeRegistry(rawRegistry, hostConfig, timestamp) {
  if (rawRegistry === null) {
    rawRegistry = {
      aliases: Object.create(null),
      updatedAt: timestamp,
      version: REGISTRY_VERSION,
    };
  }
  validateVersion(rawRegistry.version, REGISTRY_VERSION, "registry");
  const aliases = Object.create(null);
  const rawAliases = requireObject(rawRegistry.aliases, "registry.aliases");
  for (const hostAlias of hostConfig.aliases) {
    const entry = Object.hasOwn(rawAliases, hostAlias.alias) ? rawAliases[hostAlias.alias] : {};
    aliases[hostAlias.alias] = {
      activeLeaseId: typeof entry.activeLeaseId === "string" ? entry.activeLeaseId : null,
      alias: hostAlias.alias,
      driftReason: typeof entry.driftReason === "string" ? entry.driftReason : null,
      health: ALLOWED_HEALTH_STATES.has(entry.health) ? entry.health : "healthy",
      lastBootedAt: typeof entry.lastBootedAt === "string" ? entry.lastBootedAt : null,
      lastErasedAt: typeof entry.lastErasedAt === "string" ? entry.lastErasedAt : null,
      lastLeaseReleasedAt: typeof entry.lastLeaseReleasedAt === "string" ? entry.lastLeaseReleasedAt : null,
      lastLeaseStartedAt: typeof entry.lastLeaseStartedAt === "string" ? entry.lastLeaseStartedAt : null,
      lastRepairedAt: typeof entry.lastRepairedAt === "string" ? entry.lastRepairedAt : null,
      lastShutdownAt: typeof entry.lastShutdownAt === "string" ? entry.lastShutdownAt : null,
      pinId: typeof entry.pinId === "string" ? entry.pinId : null,
      powerState: ALLOWED_POWER_STATES.has(entry.powerState) ? entry.powerState : "shutdown",
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : timestamp,
    };
  }
  return {
    aliases,
    idle: {
      lastCleanupResult: normalizeIdleCleanupResult(rawRegistry.idle?.lastCleanupResult),
    },
    updatedAt: timestamp,
    version: REGISTRY_VERSION,
  };
}

function normalizeIdleCleanupResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const completedAt = typeof value.completedAt === "string" ? value.completedAt : null;
  const source = typeof value.source === "string" ? value.source : null;
  const status = typeof value.status === "string" ? value.status : null;
  const eligibleCount = normalizeNonNegativeInteger(value.eligibleCount);
  const shutdownCount = normalizeNonNegativeInteger(value.shutdownCount);
  const failureCount = normalizeNonNegativeInteger(value.failureCount);
  if (!completedAt || !source || !status || eligibleCount === null || shutdownCount === null || failureCount === null) {
    return null;
  }
  return {
    completedAt,
    eligibleCount,
    failureCount,
    shutdownCount,
    source,
    status,
  };
}

function validateIdlePolicy(rawPolicy) {
  const policy = requireObject(rawPolicy, "idle-policy");
  const keys = Object.keys(policy).sort();
  if (keys.length !== 2 || keys[0] !== "graceSeconds" || keys[1] !== "version") {
    throw new BrokerError("idle-policy may contain only version and graceSeconds.", {
      reasonCode: "invalid-config",
    });
  }
  validateVersion(policy.version, IDLE_POLICY_VERSION, "idle-policy");
  if (typeof policy.graceSeconds !== "number"
    || !Number.isInteger(policy.graceSeconds)
    || policy.graceSeconds < MIN_IDLE_GRACE_SECONDS
    || policy.graceSeconds > MAX_IDLE_GRACE_SECONDS) {
    throw new BrokerError(`idle-policy.graceSeconds must be an integer from ${MIN_IDLE_GRACE_SECONDS} through ${MAX_IDLE_GRACE_SECONDS}.`, {
      field: "idle-policy.graceSeconds",
      reasonCode: "invalid-config",
    });
  }
  return {
    graceSeconds: policy.graceSeconds,
    version: IDLE_POLICY_VERSION,
  };
}

function readIdlePolicy(paths) {
  let rawPolicy;
  try {
    rawPolicy = readJsonIfExists(paths.idlePolicyPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new BrokerError("Idle policy contains invalid JSON.", {
        reasonCode: "invalid-config",
      });
    }
    const readError = new BrokerError("Idle policy could not be read.", {
      reasonCode: "internal-error",
    });
    Object.defineProperty(readError, "cause", {
      configurable: true,
      value: error,
      writable: true,
    });
    throw readError;
  }
  return rawPolicy === null ? null : validateIdlePolicy(rawPolicy);
}

function removeIdlePolicy(paths) {
  try {
    removeIfExists(paths.idlePolicyPath);
  } catch (error) {
    const removalError = new BrokerError("Idle policy could not be removed.", {
      reasonCode: "internal-error",
    });
    Object.defineProperty(removalError, "cause", {
      configurable: true,
      value: error,
      writable: true,
    });
    throw removalError;
  }
}

function requireHumanIdleActor(options, action) {
  if (options.actorType !== "human") {
    throw new BrokerError(`${action} requires --actor-type human.`, {
      reasonCode: "idle-human-required",
    });
  }
  if (typeof options.actorId !== "string" || options.actorId.trim() === "") {
    throw new BrokerError(`${action} requires --actor-id <operator-id>.`, {
      reasonCode: "idle-human-required",
    });
  }
  return options.actorId.trim();
}

function idleBaseCandidates(state) {
  return state.hostConfig.aliases.filter((hostAlias) => {
    const registryEntry = state.registry.aliases[hostAlias.alias];
    return registryEntry.powerState === "booted"
      && registryEntry.health === "healthy"
      && !state.leasesByAlias.has(hostAlias.alias)
      && !state.pinsByAlias.has(hostAlias.alias)
      && !hostAlias.capabilities.includes("manual-persistent");
  });
}

function idleDeadline(registryEntry, graceSeconds) {
  const releasedAtMs = Date.parse(registryEntry.lastLeaseReleasedAt ?? "");
  if (!Number.isFinite(releasedAtMs)) {
    return null;
  }
  return releasedAtMs + (graceSeconds * 1_000);
}

function idleEligibleCandidates(state, policy, timestamp) {
  const nowMs = Date.parse(timestamp);
  return idleBaseCandidates(state).filter((hostAlias) => {
    const deadline = idleDeadline(state.registry.aliases[hostAlias.alias], policy.graceSeconds);
    return deadline !== null && deadline <= nowMs;
  });
}

function unconfiguredIdleSummary(state) {
  return {
    configured: false,
    eligibleCount: 0,
    graceSeconds: null,
    lastCleanupResult: state.registry.idle.lastCleanupResult,
    nextScheduledCleanupAt: null,
  };
}

function isIdlePolicyReadError(error) {
  return error instanceof BrokerError
    && (error.payload?.field === "idle-policy.graceSeconds"
      || error.message.startsWith("Idle policy")
      || error.message.startsWith("idle-policy"));
}

function buildIdleSummary(paths, state, timestamp) {
  const policy = readIdlePolicy(paths);
  if (!policy) {
    return unconfiguredIdleSummary(state);
  }
  const baseCandidates = idleBaseCandidates(state);
  const deadlines = baseCandidates
    .map((hostAlias) => idleDeadline(state.registry.aliases[hostAlias.alias], policy.graceSeconds))
    .filter((deadline) => deadline !== null);
  return {
    configured: true,
    eligibleCount: idleEligibleCandidates(state, policy, timestamp).length,
    graceSeconds: policy.graceSeconds,
    lastCleanupResult: state.registry.idle.lastCleanupResult,
    nextScheduledCleanupAt: deadlines.length === 0
      ? null
      : new Date(Math.max(Date.parse(timestamp), Math.min(...deadlines))).toISOString(),
  };
}

function idleCleanupPlan(state) {
  const candidates = idleBaseCandidates(state);
  const fingerprint = {
    candidates: candidates.map((hostAlias) => ({
      alias: hostAlias.alias,
      simulatorId: hostAlias.simulatorId,
    })).sort((left, right) => left.alias.localeCompare(right.alias)),
    command: "idle.cleanup",
    schemaVersion: IDLE_SCHEMA_VERSION,
  };
  return {
    candidates,
    publicPlan: {
      command: "idle.cleanup",
      eligibleCount: candidates.length,
      mode: "preview",
      ok: true,
      planId: sha256Digest(fingerprint),
      schemaVersion: IDLE_SCHEMA_VERSION,
      status: candidates.length > 0 ? "changes_required" : "no_changes",
    },
  };
}

function listJsonFileEntries(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs.readdirSync(dirPath)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const filePath = path.join(dirPath, name);
      let stats;
      try {
        stats = fs.statSync(filePath);
      } catch {
        throw new BrokerError(`Unable to read ${filePath}.`, {
          path: filePath,
          reasonCode: "invalid-config",
        });
      }
      if (stats.isFile() !== true) {
        throw new BrokerError(`${filePath} is not a regular JSON file.`, {
          path: filePath,
          reasonCode: "invalid-config",
        });
      }
      return { name, record: readJson(filePath) };
    });
}

function listJsonFiles(dirPath) {
  return listJsonFileEntries(dirPath).map((entry) => entry.record);
}

function assertStoredRecordFileName(fileName, recordId, kind) {
  const expectedFileName = `${recordId}.json`;
  if (fileName !== expectedFileName) {
    throw new BrokerError(`${kind} file ${fileName} does not match ${kind} ID ${recordId}.`, {
      expectedFileName,
      fileName,
      reasonCode: "invalid-config",
      recordId,
    });
  }
}

function requirePositiveIntegerField(value, name) {
  if (typeof value !== "number" || Number.isSafeInteger(value) !== true || value <= 0) {
    throw new BrokerError(`${name} must be a positive integer.`, {
      field: name,
      reasonCode: "invalid-config",
    });
  }
  return value;
}

function assertValidLeaseRecord(record) {
  requireObject(record, "lease");
  requireString(record.leaseId, "lease.leaseId");
  requireString(record.alias, "lease.alias");
  requireString(record.simulatorId, "lease.simulatorId");
  requireString(record.actorType, "lease.actorType");
  requireString(record.actorId, "lease.actorId");
  requireString(record.projectId, "lease.projectId");
  requireString(record.projectName, "lease.projectName");
  requireString(record.purposeId, "lease.purposeId");
  requireString(record.displayName, "lease.displayName");
  requireString(record.leaseKind, "lease.leaseKind");
  requireString(record.repoRoot, "lease.repoRoot");
  requireString(record.startedAt, "lease.startedAt");
  requirePositiveIntegerField(record.ownerPid, "lease.ownerPid");
  requireOptionalString(record.artifactPath, "lease.artifactPath");
  requireOptionalString(record.expiresAt, "lease.expiresAt");
  requireOptionalString(record.jobId, "lease.jobId");
  requireOptionalString(record.jobKind, "lease.jobKind");
  requireOptionalString(record.pinId, "lease.pinId");
  requireOptionalString(record.resetPolicy, "lease.resetPolicy");
  requireOptionalString(record.sessionDir, "lease.sessionDir");
  return record;
}

function assertValidPinRecord(record) {
  requireObject(record, "pin");
  requireString(record.pinId, "pin.pinId");
  requireString(record.alias, "pin.alias");
  requireString(record.projectId, "pin.projectId");
  requireString(record.projectName, "pin.projectName");
  requireString(record.actorId, "pin.actorId");
  requireString(record.actorType, "pin.actorType");
  requireString(record.createdAt, "pin.createdAt");
  requireString(record.repoRoot, "pin.repoRoot");
  requireOptionalString(record.note, "pin.note");
  requireOptionalString(record.purposeId, "pin.purposeId");
  return record;
}

function leaseMatchesPin(leaseOrRequest, pin) {
  return leaseOrRequest.projectId === pin.projectId
    && (pin.purposeId === null || leaseOrRequest.purposeId === pin.purposeId);
}

function resolveRepoRoot(projectFilePath) {
  return path.resolve(path.dirname(projectFilePath), "..");
}

function compareNullableTimestamps(left, right) {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }
  return new Date(left).getTime() - new Date(right).getTime();
}

function iosVersionSatisfies(aliasVersion, requiredVersion) {
  if (requiredVersion === undefined || requiredVersion === null) {
    return true;
  }
  const aliasParts = aliasVersion.split(".");
  const requiredParts = requiredVersion.split(".");
  return requiredParts.every((part, index) => aliasParts[index] === part);
}

function satisfiesRequires(hostAlias, requires) {
  if (requires === null) {
    return true;
  }
  if (requires.deviceFamily && hostAlias.deviceFamily !== requires.deviceFamily) {
    return false;
  }
  if (requires.iosVersion && !iosVersionSatisfies(hostAlias.iosVersion, requires.iosVersion)) {
    return false;
  }
  return true;
}

function serializeCause(code, details = {}) {
  return { code, ...details };
}

function buildCandidateAnalysis({ hostConfig, registry, leasesByAlias, pinsByAlias, purpose, projectConfig, explicitAlias }) {
  const allowedPinnedAliases = new Set(
    [...pinsByAlias.values()]
      .filter((pin) => leaseMatchesPin({ projectId: projectConfig.projectId, purposeId: purpose.id }, pin))
      .map((pin) => pin.alias),
  );

  return hostConfig.aliases.map((hostAlias, index) => {
    const reasons = [];
    const registryEntry = registry.aliases[hostAlias.alias];
    const activeLease = leasesByAlias.get(hostAlias.alias) ?? null;
    const activePin = pinsByAlias.get(hostAlias.alias) ?? null;
    if (explicitAlias && hostAlias.alias !== explicitAlias) {
      reasons.push(serializeCause("alias-not-requested"));
    }
    if (!hostAlias.capabilities.includes(purpose.capability)) {
      reasons.push(serializeCause("capability-mismatch", { requiredCapability: purpose.capability }));
    }
    if (!satisfiesRequires(hostAlias, purpose.requires)) {
      reasons.push(serializeCause("requires-mismatch", {
        requires: purpose.requires,
      }));
    }
    if (activePin && !allowedPinnedAliases.has(hostAlias.alias)) {
      reasons.push(serializeCause("pinned-for-other-project", {
        pinId: activePin.pinId,
        projectId: activePin.projectId,
        purposeId: activePin.purposeId,
      }));
    }
    if (activeLease) {
      reasons.push(serializeCause("lease-conflict", {
        actorId: activeLease.actorId,
        actorType: activeLease.actorType,
        jobId: activeLease.jobId,
        leaseId: activeLease.leaseId,
        projectId: activeLease.projectId,
        purposeId: activeLease.purposeId,
      }));
    }
    if (registryEntry.health === "repair-needed" || registryEntry.health === "repairing") {
      reasons.push(serializeCause("unhealthy-alias", {
        driftReason: registryEntry.driftReason,
        health: registryEntry.health,
      }));
    }

    return {
      alias: hostAlias.alias,
      displayName: hostAlias.displayName,
      hostAlias,
      index,
      pin: activePin,
      reasons,
      registryEntry,
    };
  });
}

function sortCandidates(candidates) {
  const tierOf = (candidate) => {
    if (candidate.pin) {
      return 0;
    }
    return candidate.registryEntry.powerState === "booted" ? 1 : 2;
  };
  const releasedAt = (candidate) => Date.parse(candidate.registryEntry.lastLeaseReleasedAt ?? "");
  const tierHasCompleteReleaseTimes = new Map();
  for (const candidate of candidates) {
    const tier = tierOf(candidate);
    const complete = Number.isFinite(releasedAt(candidate));
    tierHasCompleteReleaseTimes.set(tier, (tierHasCompleteReleaseTimes.get(tier) ?? true) && complete);
  }
  return [...candidates].sort((left, right) => {
    const tierComparison = tierOf(left) - tierOf(right);
    if (tierComparison !== 0) {
      return tierComparison;
    }
    if (tierHasCompleteReleaseTimes.get(tierOf(left))) {
      const releaseComparison = releasedAt(right) - releasedAt(left);
      if (releaseComparison !== 0) {
        return releaseComparison;
      }
    }
    return left.index - right.index;
  });
}

function summarizeSelectionFailure(candidateAnalysis) {
  return candidateAnalysis.map((candidate) => ({
    alias: candidate.alias,
    reasons: candidate.reasons,
  }));
}

function summarizeLeaseHolder(lease) {
  if (!lease) {
    return null;
  }
  return {
    actorId: lease.actorId,
    actorType: lease.actorType,
    jobId: lease.jobId ?? null,
    leaseId: lease.leaseId,
    projectId: lease.projectId,
    purposeId: lease.purposeId,
  };
}

function summarizePinOwner(pin) {
  if (!pin) {
    return null;
  }
  return {
    pinId: pin.pinId,
    projectId: pin.projectId,
    purposeId: pin.purposeId,
  };
}

function createKnownProjectRecord(projectConfig, projectFilePath, timestamp) {
  return {
    lastObservedAt: timestamp,
    projectFilePath,
    projectId: projectConfig.projectId,
    projectName: projectConfig.projectName,
    purposes: projectConfig.purposes.map((purpose) => ({ ...purpose })),
    repoRoot: resolveRepoRoot(projectFilePath),
  };
}

function writeKnownProjects(paths, knownProjects) {
  writeJsonAtomicRestricted(paths.knownProjectsPath, knownProjects);
}

function rememberKnownProject(paths, knownProjects, projectConfig, projectFilePath, timestamp) {
  knownProjects.projects[projectConfig.projectId] = createKnownProjectRecord(projectConfig, projectFilePath, timestamp);
  knownProjects.updatedAt = timestamp;
  writeKnownProjects(paths, knownProjects);
}

function rememberKnownProjectFromDisk(paths, projectConfig, projectFilePath, timestamp) {
  const knownProjects = normalizeKnownProjects(readJsonIfExists(paths.knownProjectsPath), timestamp);
  rememberKnownProject(paths, knownProjects, projectConfig, projectFilePath, timestamp);
  return knownProjects;
}

function rememberKnownProjectWithMutationLock(paths, projectConfig, projectFilePath, timestamp, options = {}) {
  return withLeaseMutationLock(paths, () =>
    rememberKnownProjectFromDisk(paths, projectConfig, projectFilePath, timestamp), {
    now: timestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

function sortByDescendingTimestamp(left, right, selector) {
  return compareNullableTimestamps(selector(right), selector(left));
}

function summarizeProjectRecords(activeLeases, pins, recentEvents, knownProjects) {
  const byProject = new Map();

  function ensureProject(projectId, projectName, metadata = null) {
    if (!projectId) {
      return null;
    }
    const existing = byProject.get(projectId);
    if (existing) {
      if (!existing.projectName && projectName) {
        existing.projectName = projectName;
      }
      if (!existing.projectFilePath && metadata?.projectFilePath) {
        existing.projectFilePath = metadata.projectFilePath;
      }
      if (!existing.repoRoot && metadata?.repoRoot) {
        existing.repoRoot = metadata.repoRoot;
      }
      return existing;
    }

    const created = {
      activeAliases: new Set(),
      activeLeaseCount: 0,
      lastEventAt: null,
      pinnedAliasCount: 0,
      projectFilePath: metadata?.projectFilePath ?? null,
      projectId,
      projectName: projectName ?? projectId,
      repoRoot: metadata?.repoRoot ?? null,
      purposes: new Map(),
    };
    byProject.set(projectId, created);
    return created;
  }

  function ensurePurpose(project, purposeId, metadata = null) {
    if (!purposeId) {
      return null;
    }
    const existing = project.purposes.get(purposeId);
    if (existing) {
      if (!existing.capability && metadata?.capability) {
        existing.capability = metadata.capability;
      }
      if (!existing.defaultActorType && metadata?.defaultActorType) {
        existing.defaultActorType = metadata.defaultActorType;
      }
      if (!existing.displayName && metadata?.displayName) {
        existing.displayName = metadata.displayName;
      }
      if (!existing.requires && metadata?.requires) {
        existing.requires = metadata.requires;
      }
      return existing;
    }
    const created = {
      activeLeaseCount: 0,
      capability: metadata?.capability ?? null,
      defaultActorType: metadata?.defaultActorType ?? null,
      displayName: metadata?.displayName ?? purposeId,
      pinnedAliasCount: 0,
      purposeId,
      requires: metadata?.requires ?? null,
    };
    project.purposes.set(purposeId, created);
    return created;
  }

  for (const knownProject of Object.values(knownProjects.projects)) {
    const project = ensureProject(knownProject.projectId, knownProject.projectName, knownProject);
    for (const purpose of knownProject.purposes) {
      ensurePurpose(project, purpose.id, {
        capability: purpose.capability,
        defaultActorType: purpose.defaultActorType,
        displayName: purpose.displayName,
        requires: purpose.requires,
      });
    }
  }

  for (const lease of activeLeases) {
    const project = ensureProject(lease.projectId, lease.projectName, knownProjects.projects[lease.projectId] ?? null);
    if (!project) {
      continue;
    }
    project.activeLeaseCount += 1;
    project.activeAliases.add(lease.alias);
    const knownPurpose = knownProjects.projects[lease.projectId]?.purposes.find((candidate) => candidate.id === lease.purposeId) ?? null;
    const purpose = ensurePurpose(project, lease.purposeId, knownPurpose ? {
      capability: knownPurpose.capability,
      defaultActorType: knownPurpose.defaultActorType,
      displayName: knownPurpose.displayName,
      requires: knownPurpose.requires,
    } : null);
    if (purpose) {
      purpose.activeLeaseCount += 1;
    }
  }

  for (const pin of pins) {
    const project = ensureProject(pin.projectId, pin.projectName, knownProjects.projects[pin.projectId] ?? null);
    if (!project) {
      continue;
    }
    project.pinnedAliasCount += 1;
    project.activeAliases.add(pin.alias);
    const knownPurpose = knownProjects.projects[pin.projectId]?.purposes.find((candidate) => candidate.id === pin.purposeId) ?? null;
    const purpose = ensurePurpose(project, pin.purposeId, knownPurpose ? {
      capability: knownPurpose.capability,
      defaultActorType: knownPurpose.defaultActorType,
      displayName: knownPurpose.displayName,
      requires: knownPurpose.requires,
    } : null);
    if (purpose) {
      purpose.pinnedAliasCount += 1;
    }
  }

  for (const event of recentEvents) {
    const project = event.projectId ? (byProject.get(event.projectId) ?? null) : null;
    if (!project) {
      continue;
    }
    if (project.lastEventAt === null || compareNullableTimestamps(project.lastEventAt, event.timestamp) < 0) {
      project.lastEventAt = event.timestamp;
    }
    const knownPurpose = event.projectId
      ? knownProjects.projects[event.projectId]?.purposes.find((candidate) => candidate.id === event.purposeId)
      : null;
    ensurePurpose(project, event.purposeId ?? null, knownPurpose ? {
      capability: knownPurpose.capability,
      defaultActorType: knownPurpose.defaultActorType,
      displayName: knownPurpose.displayName,
      requires: knownPurpose.requires,
    } : null);
  }

  return Array.from(byProject.values())
    .map((project) => ({
      activeAliases: Array.from(project.activeAliases).sort(),
      activeLeaseCount: project.activeLeaseCount,
      lastEventAt: project.lastEventAt,
      pinnedAliasCount: project.pinnedAliasCount,
      projectFilePath: project.projectFilePath,
      projectId: project.projectId,
      projectName: project.projectName,
      repoRoot: project.repoRoot,
      purposes: Array.from(project.purposes.values()).sort((left, right) => left.purposeId.localeCompare(right.purposeId)),
    }))
    .sort((left, right) => {
      const projectNameComparison = left.projectName.localeCompare(right.projectName);
      if (projectNameComparison !== 0) {
        return projectNameComparison;
      }
      return left.projectId.localeCompare(right.projectId);
    });
}

function createAppSnapshot(paths, state, { eventLimit = 50, timestamp } = {}) {
  const recentEventPayload = readEventsBroker(paths, {
    limit: eventLimit,
  });
  const activeLeases = Array.from(state.leasesByAlias.values())
    .sort((left, right) => sortByDescendingTimestamp(left, right, (lease) => lease.startedAt));
  const pins = Array.from(state.pinsByAlias.values())
    .sort((left, right) => sortByDescendingTimestamp(left, right, (pin) => pin.createdAt));
  const simulators = state.hostConfig.aliases.map((hostAlias) =>
    aliasSnapshot(hostAlias, state.registry.aliases[hostAlias.alias], state.leasesByAlias.get(hostAlias.alias), state.pinsByAlias.get(hostAlias.alias)));
  const recentEvents = [...recentEventPayload.events]
    .sort((left, right) => sortByDescendingTimestamp(left, right, (event) => event.timestamp));
  let idle;
  try {
    idle = buildIdleSummary(paths, state, timestamp);
  } catch (error) {
    if (!isIdlePolicyReadError(error)) {
      throw error;
    }
    idle = unconfiguredIdleSummary(state);
  }

  return {
    activeLeases,
    generatedAt: timestamp,
    hostConfigPath: paths.hostConfigPath,
    hostId: state.hostConfig.hostId,
    idle,
    ok: true,
    overview: {
      leaseSaturation: simulators.length === 0
        ? 0
        : Number((simulators.filter((simulator) => simulator.activeLeaseId !== null).length / simulators.length).toFixed(2)),
      leasedAliases: simulators.filter((simulator) => simulator.activeLeaseId !== null).length,
      pinnedAliases: simulators.filter((simulator) => simulator.pin !== null).length,
      totalAliases: simulators.length,
      unhealthyAliases: simulators.filter((simulator) => simulator.health === "repair-needed" || simulator.health === "repairing").length,
    },
    pins,
    projects: summarizeProjectRecords(activeLeases, pins, recentEvents, state.knownProjects),
    recentEvents,
    simulators,
    stateRoot: paths.stateRoot,
  };
}

function writeRegistry(paths, registry) {
  writeJsonAtomicRestricted(paths.registryPath, registry);
}

function throwIdleRegistryPersistenceError(error, details) {
  const persistenceError = new BrokerError("Idle registry state could not be persisted.", {
    reasonCode: "internal-error",
    ...details,
  });
  Object.defineProperty(persistenceError, "cause", {
    configurable: true,
    value: error,
    writable: true,
  });
  throw persistenceError;
}

function writeIdleRegistry(paths, registry, details) {
  try {
    writeRegistry(paths, registry);
  } catch (error) {
    throwIdleRegistryPersistenceError(error, details);
  }
}

function findHostAliasOrThrow(state, alias) {
  const hostAlias = state.hostConfig.aliases.find((candidate) => candidate.alias === alias);
  if (!hostAlias) {
    throw new BrokerError(`Unknown alias ${alias}.`, {
      alias,
      reasonCode: "unknown-alias",
    });
  }
  return hostAlias;
}

function loadLeaseReferenceForAlias(paths, options, alias) {
  if (!options.leaseId && !options.leaseFile) {
    return null;
  }
  const lease = loadLeaseByIdOrFile(paths, options);
  if (lease.alias !== alias) {
    throw new BrokerError(`Lease ${lease.leaseId} does not belong to alias ${alias}.`, {
      alias,
      leaseAlias: lease.alias,
      leaseId: lease.leaseId,
      reasonCode: "lease-alias-mismatch",
    });
  }
  return lease;
}

function makeLifecycleActorId(actorType) {
  if (actorType === "human") {
    return "human:local-cli";
  }
  return `${actorType}:${process.pid}`;
}

function resolveLifecycleRequester(paths, state, options, alias) {
  const activeLease = state.leasesByAlias.get(alias) ?? null;
  const activePin = state.pinsByAlias.get(alias) ?? null;
  const leaseReference = loadLeaseReferenceForAlias(paths, options, alias);
  const actorType = options.actorType ?? leaseReference?.actorType ?? "human";
  const actorId = options.actorId ?? leaseReference?.actorId ?? makeLifecycleActorId(actorType);
  const jobId = options.jobId ?? leaseReference?.jobId ?? null;

  if (leaseReference && !activeLease) {
    throw new BrokerError(`Lease ${leaseReference.leaseId} is not active for alias ${alias}.`, {
      alias,
      leaseId: leaseReference.leaseId,
      reasonCode: "inactive-lease-reference",
    });
  }

  if (leaseReference && activeLease && leaseReference.leaseId !== activeLease.leaseId) {
    throw new BrokerError(`Lease ${leaseReference.leaseId} is not the active lease for alias ${alias}.`, {
      activeLeaseId: activeLease.leaseId,
      alias,
      leaseId: leaseReference.leaseId,
      reasonCode: "inactive-lease-reference",
    });
  }

  const holderMatches = activeLease
    ? Boolean(leaseReference && leaseReference.leaseId === activeLease.leaseId)
    : false;

  return {
    activeLease,
    activePin,
    actorId,
    actorType,
    holderMatches,
    jobId,
    leaseReference,
  };
}

function assertLifecycleHealth(action, alias, registryEntry) {
  if ((action === "boot" || action === "shutdown")
    && (registryEntry.health === "repair-needed" || registryEntry.health === "repairing")) {
    throw new BrokerError(`Alias ${alias} is unhealthy and cannot be ${action}ed.`, {
      alias,
      driftReason: registryEntry.driftReason,
      health: registryEntry.health,
      reasonCode: "unhealthy-alias",
      suggestedNextActions: [`simbroker simulators repair --alias ${alias}`],
    });
  }
  if ((action === "erase" || action === "repair") && registryEntry.health === "repairing") {
    throw new BrokerError(`Alias ${alias} is already repairing.`, {
      alias,
      health: registryEntry.health,
      reasonCode: "alias-busy",
    });
  }
}

function validateForceOverride(action, options, requester, alias, activeLease) {
  if (action !== "repair") {
    throw new BrokerError(`Alias ${alias} is leased by another actor and cannot accept ${action}.`, {
      action,
      alias,
      allowOverride: false,
      currentHolder: summarizeLeaseHolder(activeLease),
      reasonCode: "lease-conflict",
    });
  }
  if (requester.actorType !== "human") {
    throw new BrokerError(`Only a human operator may force-override alias ${alias}.`, {
      action,
      alias,
      currentHolder: summarizeLeaseHolder(activeLease),
      reasonCode: "human-override-required",
    });
  }
  if (options.forceOverride !== true) {
    throw new BrokerError(`Alias ${alias} requires an explicit human override before ${action}.`, {
      action,
      alias,
      currentHolder: summarizeLeaseHolder(activeLease),
      reasonCode: "override-required",
      requiredConfirmationFields: ["forceOverride", "overrideReason", "expectedAlias", "expectedLeaseId"],
    });
  }
  const overrideReason = requireOptionalString(options.overrideReason, "overrideReason");
  if (!overrideReason) {
    throw new BrokerError("overrideReason is required when forceOverride is true.", {
      alias,
      reasonCode: "missing-override-reason",
    });
  }
  if (options.expectedAlias !== alias) {
    throw new BrokerError(`expectedAlias must match ${alias}.`, {
      alias,
      expectedAlias: options.expectedAlias ?? null,
      reasonCode: "override-alias-mismatch",
    });
  }
  if (options.expectedLeaseId !== activeLease.leaseId) {
    throw new BrokerError(`expectedLeaseId must match the active lease ${activeLease.leaseId}.`, {
      activeLeaseId: activeLease.leaseId,
      alias,
      expectedLeaseId: options.expectedLeaseId ?? null,
      reasonCode: "override-lease-mismatch",
    });
  }
  return overrideReason;
}

function revokeLeaseForOverride(paths, state, lease, { action, actorId, actorType, overrideReason, timestamp }) {
  assertLeaseArtifactPathAllowed(paths, lease.artifactPath);
  const registryEntry = state.registry.aliases[lease.alias];
  registryEntry.activeLeaseId = null;
  registryEntry.lastLeaseReleasedAt = timestamp;
  registryEntry.updatedAt = timestamp;
  state.registry.updatedAt = timestamp;
  state.leasesByAlias.delete(lease.alias);
  writeRegistry(paths, state.registry);
  removeLeaseRecordFiles(paths, lease);
  appendEventRecord(paths, "lease.revoked", {
    alias: lease.alias,
    actorType,
    jobId: lease.jobId,
    leaseId: lease.leaseId,
    payload: {
      action,
      actorId,
      overrideReason,
      previousActorId: lease.actorId,
      previousActorType: lease.actorType,
    },
    projectId: lease.projectId,
    purposeId: lease.purposeId,
  }, timestamp);
  return summarizeLeaseHolder(lease);
}

function repairHostAlias(paths, state, hostAlias, options = {}) {
  const simctl = resolveSimctlAdapter(options);
  const currentSimulatorId = hostAlias.simulatorId;
  const previousIosVersion = hostAlias.iosVersion;
  const provisioned = ensureAliasSimulator(simctl, {
    alias: hostAlias.alias,
    deviceFamily: hostAlias.deviceFamily,
    displayName: hostAlias.displayName,
    iosVersion: hostAlias.iosVersion,
    resetPolicy: hostAlias.resetPolicy,
    simulatorName: simulatorDisplayName(state.hostConfig.hostId, hostAlias.alias),
  }, currentSimulatorId, {
    deferCurrentDeviceDeletion: true,
  });
  hostAlias.simulatorId = provisioned.simulatorId;
  hostAlias.iosVersion = provisioned.iosVersion;
  const pendingRetirementIds = [...new Set([
    ...(state.hostConfig.pendingRetirements ?? []),
    provisioned.replacedSimulatorId,
  ].filter(Boolean))];
  const committedHostConfig = hostConfigWithPendingRetirements(state.hostConfig, pendingRetirementIds);
  try {
    writeJsonAtomicDurable(paths.hostConfigPath, committedHostConfig, {
      failStage: options.repairCommitFailureStage,
    });
  } catch (error) {
    if (error.hostConfigCommitted !== true) {
      hostAlias.simulatorId = currentSimulatorId;
      hostAlias.iosVersion = previousIosVersion;
      if (provisioned.created) {
        rollbackCreatedAliasSimulator(simctl, provisioned.simulatorId);
      }
    }
    throw error;
  }
  if (pendingRetirementIds.length > 0) {
    state.hostConfig.pendingRetirements = pendingRetirementIds;
  } else {
    delete state.hostConfig.pendingRetirements;
  }

  const retirement = retirePendingHostSimulators(simctl, pendingRetirementIds, state.hostConfig);
  const nextHostConfig = hostConfigWithPendingRetirements(state.hostConfig, retirement.pendingRetirements);
  writeJsonAtomicDurable(paths.hostConfigPath, nextHostConfig);
  if (retirement.pendingRetirements.length > 0) {
    state.hostConfig.pendingRetirements = retirement.pendingRetirements;
  } else {
    delete state.hostConfig.pendingRetirements;
  }
  return {
    replacedSimulatorId: provisioned.replacedSimulatorId,
    simulatorId: provisioned.simulatorId,
  };
}

function resolveLifecycleAdapter(options = {}) {
  if (options.lifecycleAdapter) {
    const adapter = options.lifecycleAdapter;
    return {
      boot: typeof adapter.boot === "function" ? adapter.boot : () => {},
      erase: typeof adapter.erase === "function" ? adapter.erase : () => {},
      repair: typeof adapter.repair === "function" ? adapter.repair : () => {},
      shutdown: typeof adapter.shutdown === "function" ? adapter.shutdown : () => {},
      waitReady: typeof adapter.waitReady === "function" ? adapter.waitReady : () => {},
    };
  }

  const simctl = resolveSimctlAdapter(options);
  return {
    boot: ({ hostAlias }) => {
      simctl.bootDevice(hostAlias.simulatorId);
    },
    erase: ({ hostAlias }) => {
      simctl.shutdownDevice(hostAlias.simulatorId);
      simctl.eraseDevice(hostAlias.simulatorId);
    },
    repair: (context) => repairHostAlias(context.paths, context.state, context.hostAlias, options),
    shutdown: ({ hostAlias }) => {
      simctl.shutdownDevice(hostAlias.simulatorId);
    },
    waitReady: ({ hostAlias }) => {
      if (typeof simctl.waitForBooted === "function") {
        simctl.waitForBooted(hostAlias.simulatorId);
      }
    },
  };
}

function invokeLifecycleAdapter(action, adapter, context) {
  const fn = adapter[action];
  try {
    return fn(context);
  } catch (error) {
    if (error instanceof BrokerError) {
      throw error;
    }
    throw new BrokerError(`Simulator ${action} failed for alias ${context.alias}.`, {
      action,
      alias: context.alias,
      cause: error?.message ?? String(error),
      reasonCode: "simulator-action-failed",
    });
  }
}

function ensureLockPaths(paths) {
  ensureRestrictedDir(paths.stateRoot);
  ensureRestrictedDir(paths.locksDir);
}

function ensureStatePaths(paths) {
  ensureLockPaths(paths);
  if (paths.evidenceDir) {
    ensureRestrictedDir(paths.evidenceDir);
  }
  if (paths.capacityTransactionsDir) {
    ensureRestrictedDir(paths.capacityTransactionsDir);
  }
  ensureRestrictedDir(paths.leasesDir);
  ensureRestrictedDir(paths.pinsDir);
}

function initializeLockScope(paths, initializePersistentState) {
  if (initializePersistentState) {
    ensureStatePaths(paths);
  } else {
    ensureLockPaths(paths);
  }
}

function withResetLock(paths, work, {
  now = nowIso(),
  processExists = defaultProcessExists,
  processSampler = processExists === defaultProcessExists ? defaultProcessSampler : null,
  pollMs = DEFAULT_LOCK_POLL_MS,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
} = {}) {
  ensureStatePaths(paths);
  const startedAt = Date.now();

  while (true) {
    try {
      fs.mkdirSync(paths.resetLockDir);
      fs.chmodSync(paths.resetLockDir, 0o700);
      writeJsonAtomicRestricted(paths.resetLockOwnerPath, {
        pid: process.pid,
        startedAt: now,
      });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const lockSnapshot = readLockSnapshot(paths.resetLockDir, paths.resetLockOwnerPath, {
        processExists,
        processSampler,
        timeoutMs,
      });
      if (lockSnapshot.released
        || ((lockSnapshot.staleOwner || lockSnapshot.abandonedOwner)
          && reclaimStaleLock(paths.resetLockDir, paths.resetLockOwnerPath, lockSnapshot, {
            processExists,
            processSampler,
            timeoutMs,
          }))) {
        continue;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new BrokerError("Timed out waiting for the simulator reset lock.", {
          reasonCode: "reset-lock-timeout",
          stateRoot: paths.stateRoot,
        });
      }

      sleepSync(pollMs);
    }
  }

  try {
    return work();
  } finally {
    removeLockIfOwned(paths.resetLockDir, paths.resetLockOwnerPath);
  }
}

function removeLockIfOwned(lockDir, ownerPath) {
  const owner = readJsonIfExists(ownerPath, {});
  if (!Number.isInteger(owner?.pid) || owner.pid === process.pid) {
    fs.rmSync(lockDir, { force: true, recursive: true });
  }
}

function readLockOwnerTimestampMs(lockDir, ownerPath) {
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

function sameLockReclaimMarkerOwner(left, right) {
  return typeof left?.token === "string"
    && left.token.length > 0
    && left.token === right?.token;
}

function readLockSnapshot(lockDir, ownerPath, { processExists, processSampler, timeoutMs }) {
  const owner = readJsonIfExists(ownerPath, {});
  const hasOwnerPid = Number.isInteger(owner?.pid) && owner.pid > 0;
  const staleOwner = hasOwnerPid && !lockOwnerProcessIsLive(owner, {
    observedAt: new Date(),
    processExists,
    processSampler,
  });
  const ownerTimestamp = readLockOwnerTimestampMs(lockDir, ownerPath);
  const lockIdentity = readPathIdentity(lockDir);
  return {
    abandonedOwner: ownerTimestamp !== null && !hasOwnerPid && Date.now() - ownerTimestamp > timeoutMs,
    hasOwnerPid,
    lockIdentity,
    owner,
    ownerTimestamp,
    released: ownerTimestamp === null || lockIdentity === null,
    staleOwner,
  };
}

function writeLockReclaimMarker(markerPath, token) {
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

function restoreClaimedLockReclaimMarker(claimedMarkerPath, markerPath) {
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

function acquireLockReclaimMarker(lockDir, timeoutMs) {
  const markerPath = path.join(lockDir, "reclaiming.json");
  const token = crypto.randomUUID();
  try {
    return writeLockReclaimMarker(markerPath, token);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    if (error?.code === "EEXIST") {
      const markerTimestamp = readLockOwnerTimestampMs(lockDir, markerPath);
      const markerIdentity = readPathIdentity(markerPath);
      const markerOwner = readJsonIfExists(markerPath, null);
      if (markerTimestamp !== null && markerIdentity !== null && Date.now() - markerTimestamp > timeoutMs) {
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
        const claimedMarkerOwner = readJsonIfExists(claimedMarkerPath, null);
        if (
          !samePathIdentity(markerIdentity, claimedMarkerIdentity)
          || !sameLockReclaimMarkerOwner(markerOwner, claimedMarkerOwner)
        ) {
          restoreClaimedLockReclaimMarker(claimedMarkerPath, markerPath);
          return null;
        }
        try {
          return writeLockReclaimMarker(markerPath, token);
        } catch (claimError) {
          if (claimError?.code === "ENOENT" || claimError?.code === "EEXIST") {
            return null;
          }
          throw claimError;
        } finally {
          removeIfExists(claimedMarkerPath);
        }
      }
      return null;
    }
    throw error;
  }
}

function removeLockReclaimMarkerIfOwned(marker) {
  const owner = readJsonIfExists(marker.markerPath, null);
  if (owner?.token === marker.token) {
    removeIfExists(marker.markerPath);
  }
}

function reclaimStaleLock(lockDir, ownerPath, previousSnapshot, { processExists, processSampler, timeoutMs }) {
  const marker = acquireLockReclaimMarker(lockDir, timeoutMs);
  if (marker === null) {
    return false;
  }

  let removed = false;
  try {
    const latestSnapshot = readLockSnapshot(lockDir, ownerPath, {
      processExists,
      processSampler,
      timeoutMs,
    });
    if (latestSnapshot.released) {
      return true;
    }
    const stillAbandonedWithoutOwner = !latestSnapshot.hasOwnerPid
      && !previousSnapshot.hasOwnerPid
      && samePathIdentity(latestSnapshot.lockIdentity, previousSnapshot.lockIdentity)
      && previousSnapshot.ownerTimestamp !== null
      && Date.now() - previousSnapshot.ownerTimestamp > timeoutMs;
    if (latestSnapshot.staleOwner || latestSnapshot.abandonedOwner || stillAbandonedWithoutOwner) {
      removed = true;
      fs.rmSync(lockDir, { force: true, recursive: true });
      return true;
    }
    return false;
  } finally {
    if (!removed) {
      removeLockReclaimMarkerIfOwned(marker);
    }
  }
}

function lockOwnerProcessIsLive(owner, { observedAt, processExists, processSampler }) {
  const ownerPid = normalizePositiveInteger(owner?.pid);
  if (ownerPid === null || processExists(ownerPid) !== true) {
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
  const processRecord = processRecords.find((record) => normalizePositiveInteger(record?.pid) === ownerPid);
  if (!processRecord || processRecordLooksDefunct(processRecord)) {
    return false;
  }
  const lifetimeMatches = processRecordAliveAtTimestamp(processRecord, owner?.startedAt, observedAt);
  return lifetimeMatches !== false;
}

function withCapacityLock(paths, work, {
  checkCancellation = null,
  initializePersistentState = true,
  now = nowIso(),
  processExists = defaultProcessExists,
  processSampler = processExists === defaultProcessExists ? defaultProcessSampler : null,
  pollMs = DEFAULT_LOCK_POLL_MS,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  reclaimTimeoutMs = timeoutMs,
  wait = true,
} = {}) {
  initializeLockScope(paths, initializePersistentState);
  const startedAt = Date.now();

  while (true) {
    checkCancellation?.();
    try {
      fs.mkdirSync(paths.capacityLockDir);
      fs.chmodSync(paths.capacityLockDir, 0o700);
      writeJsonAtomicRestricted(paths.capacityLockOwnerPath, {
        pid: process.pid,
        startedAt: now,
      });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      if (!wait) {
        throw new BrokerError("The capacity reconcile lock is already held.", {
          reasonCode: "capacity-apply-blocked",
        });
      }

      const lockSnapshot = readLockSnapshot(paths.capacityLockDir, paths.capacityLockOwnerPath, {
        processExists,
        processSampler,
        timeoutMs: reclaimTimeoutMs,
      });
      if (lockSnapshot.released
        || ((lockSnapshot.staleOwner || lockSnapshot.abandonedOwner)
          && reclaimStaleLock(paths.capacityLockDir, paths.capacityLockOwnerPath, lockSnapshot, {
            processExists,
            processSampler,
            timeoutMs: reclaimTimeoutMs,
          }))) {
        continue;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new BrokerError("Timed out waiting for the capacity reconcile lock.", {
          reasonCode: "capacity-apply-blocked",
        });
      }

      checkCancellation?.();
      sleepSync(pollMs);
    }
  }

  try {
    return work();
  } finally {
    removeLockIfOwned(paths.capacityLockDir, paths.capacityLockOwnerPath);
  }
}

function withLeaseMutationLock(paths, work, {
  checkCancellation = null,
  initializePersistentState = true,
  now = nowIso(),
  processExists = defaultProcessExists,
  processSampler = processExists === defaultProcessExists ? defaultProcessSampler : null,
  pollMs = DEFAULT_LOCK_POLL_MS,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  wait = true,
} = {}) {
  initializeLockScope(paths, initializePersistentState);
  const startedAt = Date.now();

  while (true) {
    checkCancellation?.();
    try {
      fs.mkdirSync(paths.leaseLockDir);
      fs.chmodSync(paths.leaseLockDir, 0o700);
      writeJsonAtomicRestricted(paths.leaseLockOwnerPath, {
        pid: process.pid,
        startedAt: now,
      });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const lockSnapshot = readLockSnapshot(paths.leaseLockDir, paths.leaseLockOwnerPath, {
        processExists,
        processSampler,
        timeoutMs,
      });
      if (lockSnapshot.released
        || ((lockSnapshot.staleOwner || lockSnapshot.abandonedOwner)
          && reclaimStaleLock(paths.leaseLockDir, paths.leaseLockOwnerPath, lockSnapshot, {
            processExists,
            processSampler,
            timeoutMs,
          }))) {
        continue;
      }

      if (!wait) {
        throw new BrokerError("The broker lease mutation lock is already held.", {
          reasonCode: "alias-busy",
        });
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new BrokerError("Timed out waiting for the broker lease mutation lock.", {
          reasonCode: "alias-busy",
        });
      }

      checkCancellation?.();
      sleepSync(pollMs);
    }
  }

  try {
    return work();
  } finally {
    removeLockIfOwned(paths.leaseLockDir, paths.leaseLockOwnerPath);
  }
}

function getLeaseFilePath(paths, leaseId) {
  return path.join(paths.leasesDir, `${leaseId}.json`);
}

function pathContainsPath(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === "" || (relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function flipAsciiCase(value) {
  return [...value].map((character) => {
    const lower = character.toLowerCase();
    const upper = character.toUpperCase();
    if (lower === upper) {
      return character;
    }
    return character === lower ? upper : lower;
  }).join("");
}

function sameExistingPath(leftPath, rightPath) {
  try {
    const left = fs.statSync(leftPath);
    const right = fs.statSync(rightPath);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

function existingPathUsesCaseInsensitiveSemantics(existingPath) {
  let candidatePath = existingPath;
  while (true) {
    const parentPath = path.dirname(candidatePath);
    const basename = path.basename(candidatePath);
    if (parentPath === candidatePath || basename === "") {
      return false;
    }

    const flippedBasename = flipAsciiCase(basename);
    if (flippedBasename !== basename) {
      return sameExistingPath(candidatePath, path.join(parentPath, flippedBasename));
    }
    candidatePath = parentPath;
  }
}

function canonicalPathDetailsForComparison(filePath) {
  const resolvedPath = path.resolve(filePath);
  const pendingSegments = [];
  let candidatePath = resolvedPath;

  while (true) {
    try {
      const existingPath = fs.realpathSync(candidatePath);
      const canonicalPath = path.join(existingPath, ...pendingSegments.reverse());
      return {
        canonicalPath,
        comparisonPath: existingPathUsesCaseInsensitiveSemantics(existingPath)
          ? canonicalPath.toLowerCase()
          : canonicalPath,
      };
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        throw error;
      }
      const parentPath = path.dirname(candidatePath);
      if (parentPath === candidatePath) {
        return {
          canonicalPath: resolvedPath,
          comparisonPath: resolvedPath,
        };
      }
      pendingSegments.push(path.basename(candidatePath));
      candidatePath = parentPath;
    }
  }
}

function canonicalPathForComparison(filePath) {
  return canonicalPathDetailsForComparison(filePath).comparisonPath;
}

function brokerPathEntry(name, filePath, options = {}) {
  if (!filePath) {
    return null;
  }
  const resolvedPath = path.resolve(filePath);
  const pathDetails = canonicalPathDetailsForComparison(resolvedPath);
  return {
    canonicalPath: pathDetails.canonicalPath,
    comparisonPath: pathDetails.comparisonPath,
    external: options.external === true,
    kind: options.kind ?? "file",
    name,
    resolvedPath,
  };
}

function brokerPathEntriesOverlap(left, right) {
  if (left.resolvedPath === right.resolvedPath
    || left.canonicalPath === right.canonicalPath
    || left.comparisonPath === right.comparisonPath) {
    return true;
  }
  if (left.external && right.kind === "dir") {
    return pathContainsPath(right.resolvedPath, left.resolvedPath)
      || pathContainsPath(right.canonicalPath, left.canonicalPath)
      || pathContainsPath(right.comparisonPath, left.comparisonPath);
  }
  if (right.external && left.kind === "dir") {
    return pathContainsPath(left.resolvedPath, right.resolvedPath)
      || pathContainsPath(left.canonicalPath, right.canonicalPath)
      || pathContainsPath(left.comparisonPath, right.comparisonPath);
  }
  return false;
}

function assertBrokerPathsDistinct(paths) {
  const entries = [
    brokerPathEntry("hostConfigPath", paths.hostConfigPath, { external: true }),
    brokerPathEntry("projectFilePath", paths.projectFilePath, { external: true }),
    brokerPathEntry("serviceSocketPath", paths.serviceSocketPath, { external: true }),
    brokerPathEntry("stateRoot", paths.stateRoot, { kind: "root" }),
    brokerPathEntry("appSnapshotPath", paths.appSnapshotPath),
    brokerPathEntry("knownProjectsPath", paths.knownProjectsPath),
    brokerPathEntry("idlePolicyPath", paths.idlePolicyPath),
    brokerPathEntry("registryPath", paths.registryPath),
    brokerPathEntry("eventsPath", paths.eventsPath),
    brokerPathEntry("serviceLogPath", paths.serviceLogPath),
    brokerPathEntry("serviceMetadataPath", paths.serviceMetadataPath),
    brokerPathEntry("capacityLockOwnerPath", paths.capacityLockOwnerPath),
    brokerPathEntry("leaseLockOwnerPath", paths.leaseLockOwnerPath),
    brokerPathEntry("resetLockOwnerPath", paths.resetLockOwnerPath),
    brokerPathEntry("serviceLockOwnerPath", paths.serviceLockOwnerPath),
    brokerPathEntry("capacityTransactionsDir", paths.capacityTransactionsDir, { kind: "dir" }),
    brokerPathEntry("evidenceDir", paths.evidenceDir, { kind: "dir" }),
    brokerPathEntry("leasesDir", paths.leasesDir, { kind: "dir" }),
    brokerPathEntry("locksDir", paths.locksDir, { kind: "dir" }),
    brokerPathEntry("pinsDir", paths.pinsDir, { kind: "dir" }),
    brokerPathEntry("capacityLockDir", paths.capacityLockDir, { kind: "dir" }),
    brokerPathEntry("leaseLockDir", paths.leaseLockDir, { kind: "dir" }),
    brokerPathEntry("resetLockDir", paths.resetLockDir, { kind: "dir" }),
    brokerPathEntry("serviceLockDir", paths.serviceLockDir, { kind: "dir" }),
  ].filter(Boolean);

  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex];
      const right = entries[rightIndex];
      if (brokerPathEntriesOverlap(left, right)) {
        throw new BrokerError("Broker resource paths must be distinct.", {
          conflictingPath: right.resolvedPath,
          conflictingResource: right.name,
          reasonCode: "invalid-config",
          resource: left.name,
          resourcePath: left.resolvedPath,
        });
      }
    }
  }
}

function leaseArtifactPathOverlap(paths, artifactPath) {
  if (!artifactPath) {
    return null;
  }
  const resolvedArtifactPath = path.resolve(artifactPath);
  const canonicalArtifactPath = canonicalPathForComparison(resolvedArtifactPath);
  const protectedDirs = [
    paths.stateRoot,
  ].filter(Boolean).map((candidate) => {
    const resolvedPath = path.resolve(candidate);
    return {
      canonicalPath: canonicalPathForComparison(resolvedPath),
      resolvedPath,
    };
  });
  const protectedFiles = [
    paths.hostConfigPath,
    paths.projectFilePath,
  ].filter(Boolean).map((candidate) => {
    const resolvedPath = path.resolve(candidate);
    return {
      canonicalPath: canonicalPathForComparison(resolvedPath),
      resolvedPath,
    };
  });

  const overlappingDir = protectedDirs.find((candidate) =>
    pathContainsPath(candidate.resolvedPath, resolvedArtifactPath)
      || pathContainsPath(candidate.canonicalPath, canonicalArtifactPath));
  if (overlappingDir) {
    return {
      artifactPath: resolvedArtifactPath,
      protectedPath: overlappingDir.resolvedPath,
      protectedType: "state-root",
    };
  }

  const overlappingFile = protectedFiles.find((candidate) =>
    candidate.resolvedPath === resolvedArtifactPath
      || candidate.canonicalPath === canonicalArtifactPath);
  if (overlappingFile) {
    return {
      artifactPath: resolvedArtifactPath,
      protectedPath: overlappingFile.resolvedPath,
      protectedType: "config-file",
    };
  }

  return null;
}

function assertLeaseArtifactPathAllowed(paths, artifactPath) {
  const overlap = leaseArtifactPathOverlap(paths, artifactPath);
  if (!overlap) {
    return;
  }
  throw new BrokerError("Lease artifact path overlaps broker configuration or state.", {
    artifactPath: overlap.artifactPath,
    protectedPath: overlap.protectedPath,
    protectedType: overlap.protectedType,
    reasonCode: "invalid-lease-artifact-path",
  });
}

function assertLeaseArtifactPathUnused(activeLeases, artifactPath, ignoredLeaseId = null) {
  if (!artifactPath) {
    return;
  }
  const resolvedArtifactPath = path.resolve(artifactPath);
  const canonicalArtifactPath = canonicalPathForComparison(resolvedArtifactPath);
  const activeLease = activeLeases.find((lease) =>
    lease.leaseId !== ignoredLeaseId
      && lease.artifactPath
      && canonicalPathForComparison(lease.artifactPath) === canonicalArtifactPath);
  if (!activeLease) {
    return;
  }

  throw new BrokerError("Lease artifact path is already used by another active lease.", {
    activeLeaseId: activeLease.leaseId,
    activeLeaseAlias: activeLease.alias,
    artifactPath: resolvedArtifactPath,
    reasonCode: "lease-artifact-path-in-use",
  });
}

function removeLeaseRecordFiles(paths, leaseRecord) {
  assertLeaseArtifactPathAllowed(paths, leaseRecord.artifactPath);
  removeIfExists(getLeaseFilePath(paths, leaseRecord.leaseId));
  if (leaseRecord.artifactPath) {
    removeIfExists(leaseRecord.artifactPath);
  }
}

function removeLeaseArtifactFile(paths, leaseRecord) {
  assertLeaseArtifactPathAllowed(paths, leaseRecord.artifactPath);
  if (leaseRecord.artifactPath) {
    removeIfExists(leaseRecord.artifactPath);
  }
}

function removeCanonicalLeaseRecordFile(paths, leaseRecord) {
  removeIfExists(getLeaseFilePath(paths, leaseRecord.leaseId));
}

function snapshotLeaseRecordFiles(paths, leaseRecord) {
  const canonicalLeasePath = getLeaseFilePath(paths, leaseRecord.leaseId);
  const artifactPath = leaseRecord.artifactPath ? path.resolve(leaseRecord.artifactPath) : null;
  const canonicalExists = fs.existsSync(canonicalLeasePath);
  const artifactExists = artifactPath !== null && fs.existsSync(artifactPath);
  return {
    artifactExists,
    artifactPath,
    artifactRecord: artifactExists ? readJson(artifactPath) : null,
    canonicalExists,
    canonicalLeasePath,
    canonicalRecord: canonicalExists ? readJson(canonicalLeasePath) : null,
  };
}

function restoreLeaseRecordFiles(snapshot) {
  if (snapshot.canonicalExists) {
    writeJsonAtomicRestricted(snapshot.canonicalLeasePath, snapshot.canonicalRecord);
  } else {
    removeIfExists(snapshot.canonicalLeasePath);
  }
  if (snapshot.artifactPath === null) {
    return;
  }
  if (snapshot.artifactExists) {
    writeJsonAtomic(snapshot.artifactPath, snapshot.artifactRecord);
  } else {
    removeIfExists(snapshot.artifactPath);
  }
}

function writeLeaseRecord(paths, leaseRecord, { replaceArtifact = true } = {}) {
  assertLeaseArtifactPathAllowed(paths, leaseRecord.artifactPath);
  const canonicalLeasePath = getLeaseFilePath(paths, leaseRecord.leaseId);
  const rollbackSnapshot = snapshotLeaseRecordFiles(paths, leaseRecord);
  writeJsonAtomicRestricted(canonicalLeasePath, leaseRecord);
  try {
    if (leaseRecord.artifactPath) {
      if (replaceArtifact) {
        writeJsonAtomic(leaseRecord.artifactPath, leaseRecord);
      } else {
        try {
          writeJsonNoReplace(leaseRecord.artifactPath, leaseRecord);
        } catch (error) {
          if (error?.code === "EEXIST") {
            throw new BrokerError("Lease artifact path already exists.", {
              artifactPath: path.resolve(leaseRecord.artifactPath),
              reasonCode: "lease-artifact-path-exists",
            });
          }
          throw error;
        }
      }
    }
  } catch (error) {
    try {
      restoreLeaseRecordFiles(rollbackSnapshot);
    } catch (restoreError) {
      error.restoreError = restoreError?.message ?? String(restoreError);
    }
    throw error;
  }
}

function getPinFilePath(paths, pinId) {
  return path.join(paths.pinsDir, `${pinId}.json`);
}

function buildEvent(eventType, payload, timestamp) {
  return {
    eventId: crypto.randomUUID(),
    timestamp,
    type: eventType,
    ...payload,
  };
}

function recordAuditAppendFailure(paths, eventRecord, error) {
  try {
    const failuresDir = path.join(paths.stateRoot, "audit-append-failures");
    writeJsonAtomicRestricted(path.join(failuresDir, `${eventRecord.eventId}.json`), {
      event: eventRecord,
      failedAt: eventRecord.timestamp,
      reason: error?.message ?? String(error),
      reasonCode: "audit-append-failed",
    });
  } catch {
    // The state mutation already committed; preserve the command result when even failure evidence cannot be recorded.
  }
}

function appendEventRecord(paths, eventType, payload, timestamp) {
  const eventRecord = buildEvent(eventType, payload, timestamp);
  try {
    appendNdjson(paths.eventsPath, eventRecord);
    return {
      eventId: eventRecord.eventId,
      ok: true,
    };
  } catch (error) {
    recordAuditAppendFailure(paths, eventRecord, error);
    return {
      eventId: eventRecord.eventId,
      ok: false,
      reasonCode: "audit-append-failed",
    };
  }
}

function brokerStatusForLease(paths, state, lease) {
  return {
    activeLeaseId: state.registry.aliases[lease.alias]?.activeLeaseId ?? null,
    alias: lease.alias,
    leaseId: lease.leaseId,
    registryPath: paths.registryPath,
    stateRoot: paths.stateRoot,
  };
}

function removeLeaseAfterContainment(paths, state, lease, timestamp) {
  assertLeaseArtifactPathAllowed(paths, lease.artifactPath);
  const registryEntry = state.registry.aliases[lease.alias];
  if (registryEntry) {
    registryEntry.activeLeaseId = null;
    registryEntry.lastLeaseReleasedAt = timestamp;
    registryEntry.updatedAt = timestamp;
    state.registry.updatedAt = timestamp;
    writeRegistry(paths, state.registry);
  }
  if (state.leasesByAlias) {
    state.leasesByAlias.delete(lease.alias);
  }
  removeLeaseRecordFiles(paths, lease);
}

function writeContainmentObservation(paths, lease, observation, timestamp) {
  const runtime = buildLeaseRuntimeMetadata(lease, {
    updatedAt: timestamp,
  });
  lease.runtime = {
    ...runtime,
    lastObservation: observation,
  };
  writeLeaseRecord(paths, lease);
}

function containmentFailureObservation(result) {
  return {
    ...result.observation,
    cleanupComplete: result.cleanupComplete,
    cleanupFailures: result.cleanupFailures,
    remainingOwnedPids: result.remainingOwnedPids,
  };
}

function containLeaseRecord(paths, state, lease, options = {}) {
  const timestamp = nowIso(options.now);
  const result = containLeaseProcesses(lease, {
    brokerStatusBefore: brokerStatusForLease(paths, state, lease),
    captureDiagnostics: options.captureDiagnostics,
    diagnosticSampler: options.diagnosticSampler,
    killOwner: options.killOwner,
    paths,
    postKillPollMs: options.postKillPollMs,
    postKillWaitMs: options.postKillWaitMs,
    processController: options.processController,
    processSampler: options.processSampler,
    reason: options.reason,
    requesterPid: options.requesterPid,
    termWaitMs: options.termWaitMs,
    timestamp,
  });

  if (!result.contained) {
    writeContainmentObservation(paths, lease, result.observation, timestamp);
    return {
      contained: false,
      leaseId: lease.leaseId,
      observation: result.observation,
      ok: true,
      reason: result.reason,
    };
  }

  if (!result.cleanupComplete) {
    if (result.evidenceDir) {
      writeJsonAtomicRestricted(path.join(result.evidenceDir, "broker-status-after.json"), brokerStatusForLease(paths, state, lease));
    }
    writeContainmentObservation(paths, lease, containmentFailureObservation(result), timestamp);
    throw new BrokerError("Containment did not finish cleanup; lease remains active.", {
      cleanupFailures: result.cleanupFailures,
      evidenceDir: result.evidenceDir,
      leaseId: lease.leaseId,
      ownedProcessCountAfter: result.summary.ownedProcessCountAfter,
      reason: result.reason,
      reasonCode: "containment-incomplete",
      remainingOwnedPids: result.remainingOwnedPids,
    });
  }

  const releasedAt = nowIso(options.now);
  removeLeaseAfterContainment(paths, state, lease, releasedAt);
  if (result.evidenceDir) {
    writeJsonAtomicRestricted(path.join(result.evidenceDir, "broker-status-after.json"), brokerStatusForLease(paths, state, lease));
  }
  appendEventRecord(paths, "lease.contained", {
    alias: lease.alias,
    actorType: lease.actorType,
    jobId: lease.jobId ?? null,
    leaseId: lease.leaseId,
    payload: {
      actorId: lease.actorId,
      evidenceDir: result.evidenceDir,
      killedPids: result.summary.killedPids,
      ownedProcessCountAfter: result.summary.ownedProcessCountAfter,
      ownedProcessCountBefore: result.summary.ownedProcessCountBefore,
      ownedRssBytes: result.summary.ownedRssBytes,
      reason: result.reason,
      skippedPids: result.summary.skippedPids,
    },
    projectId: lease.projectId,
    purposeId: lease.purposeId,
  }, releasedAt);

  return {
    cleanupActions: result.cleanupActions,
    contained: true,
    evidenceDir: result.evidenceDir,
    leaseId: lease.leaseId,
    observation: result.observation,
    ok: true,
    reason: result.reason,
    summary: result.summary,
  };
}

function loadBrokerState(paths, { processExists = defaultProcessExists, registryPersistenceDetails, skipLeaseIds, timestamp = nowIso(), ...simctlOptions } = {}) {
  ensureStatePaths(paths);
  const hostConfig = readHostConfigOrThrow(paths);
  const knownProjects = normalizeKnownProjects(readJsonIfExists(paths.knownProjectsPath), timestamp);
  const registry = normalizeRegistry(readJsonIfExists(paths.registryPath), hostConfig, timestamp);
  const pins = listJsonFiles(paths.pinsDir);
  const leases = listJsonFiles(paths.leasesDir);
  const skippedLeaseIds = skipLeaseIds instanceof Set ? skipLeaseIds : new Set(skipLeaseIds ?? []);
  const processSampler = simctlOptions.processSampler
    ?? (processExists === defaultProcessExists ? defaultProcessSampler : null);
  const stateProcessSampler = memoizeProcessSampler(processSampler);
  const activeLeases = [];
  for (const lease of leases) {
    if (skippedLeaseIds.has(lease.leaseId)) {
      activeLeases.push(lease);
      continue;
    }
    if (isLeftoverAcquireRollbackLease(lease, registry)) {
      reclaimLeftoverAcquireRollbackLease(paths, lease, timestamp);
      continue;
    }
    if (leaseOwnerIsLive(lease, { processExists, processSampler: stateProcessSampler, timestamp })) {
      activeLeases.push(lease);
      continue;
    }
    if (leaseHasContainmentProcessMetadata(lease)) {
      try {
        containLeaseRecord(paths, {
          hostConfig,
          knownProjects,
          leasesByAlias: new Map(),
          pinsByAlias: new Map(),
          registry,
        }, lease, {
          processController: simctlOptions.processController,
          processSampler: simctlOptions.processSampler,
          reason: "stale-owner",
          termWaitMs: simctlOptions.termWaitMs,
          now: simctlOptions.now ?? timestamp,
        });
      } catch (error) {
        if (error instanceof BrokerError && error.payload?.reasonCode === "containment-incomplete") {
          activeLeases.push(lease);
          continue;
        }
        throw error;
      }
      continue;
    }
    const registryEntry = registry.aliases[lease.alias];
    if (registryEntry) {
      registryEntry.activeLeaseId = null;
      registryEntry.lastLeaseReleasedAt = timestamp;
      registryEntry.updatedAt = timestamp;
    }
    removeLeaseRecordFiles(paths, lease);
    appendEventRecord(paths, "lease.reclaimed", {
      alias: lease.alias,
      actorType: lease.actorType,
      jobId: lease.jobId ?? null,
      leaseId: lease.leaseId,
      payload: {
        projectId: lease.projectId,
        purposeId: lease.purposeId,
      },
      projectId: lease.projectId,
      purposeId: lease.purposeId,
    }, timestamp);
  }

  const leasesByAlias = new Map(activeLeases.map((lease) => [lease.alias, lease]));
  const pinsByAlias = new Map(pins.map((pin) => [pin.alias, pin]));
  for (const hostAlias of hostConfig.aliases) {
    const entry = registry.aliases[hostAlias.alias];
    entry.activeLeaseId = leasesByAlias.get(hostAlias.alias)?.leaseId ?? null;
    entry.pinId = pinsByAlias.get(hostAlias.alias)?.pinId ?? null;
    entry.updatedAt = timestamp;
  }
  syncRegistryWithSimctl(hostConfig, registry, simctlOptions);
  registry.updatedAt = timestamp;
  if (registryPersistenceDetails) {
    writeIdleRegistry(paths, registry, registryPersistenceDetails);
  } else {
    writeRegistry(paths, registry);
  }
  writeKnownProjects(paths, knownProjects);

  return {
    hostConfig,
    knownProjects,
    leases: activeLeases,
    leasesByAlias,
    pins,
    pinsByAlias,
    registry,
    timestamp,
  };
}

function memoizeProcessSampler(processSampler) {
  if (typeof processSampler !== "function") {
    return processSampler;
  }
  let sampled = false;
  let processRecords = null;
  return () => {
    if (!sampled) {
      processRecords = processSampler();
      sampled = true;
    }
    return processRecords;
  };
}

function isLeftoverAcquireRollbackLease(lease, registry) {
  const registryEntry = registry.aliases[lease.alias];
  if (!registryEntry) {
    return false;
  }
  if (registryEntry.health !== "repair-needed") {
    return false;
  }
  if (registryEntry.driftReason !== "boot-on-acquire-failed"
    && registryEntry.driftReason !== "reset-on-acquire-failed") {
    return false;
  }
  return registryEntry.activeLeaseId !== lease.leaseId;
}

function reclaimLeftoverAcquireRollbackLease(paths, lease, timestamp) {
  removeLeaseRecordFiles(paths, lease);
  appendEventRecord(paths, "lease.reclaimed", {
    alias: lease.alias,
    actorType: lease.actorType,
    jobId: lease.jobId ?? null,
    leaseId: lease.leaseId,
    payload: {
      projectId: lease.projectId,
      purposeId: lease.purposeId,
      reasonCode: "acquire-rollback-leftover",
    },
    projectId: lease.projectId,
    purposeId: lease.purposeId,
  }, timestamp);
}

function leaseOwnerIsLive(lease, {
  processExists = defaultProcessExists,
  processSampler = processExists === defaultProcessExists ? defaultProcessSampler : null,
  timestamp = nowIso(),
} = {}) {
  if (!processExists(lease.ownerPid)) {
    return false;
  }
  const runtime = buildLeaseRuntimeMetadata(lease);
  const recordedOwnerPid = normalizePositiveInteger(runtime.ownerPid ?? lease.ownerPid);
  if (!recordedOwnerPid) {
    return false;
  }
  const canValidateOwnerIdentity = Boolean(runtime.ownerRegisteredAt || leaseHasContainmentProcessMetadata(lease));
  if (!canValidateOwnerIdentity || !processSampler) {
    return true;
  }
  const discovery = discoverLeaseOwnedProcesses(lease, processSampler(), { now: timestamp });
  return discovery.owned.some((processRecord) =>
    processRecord.pid === recordedOwnerPid && processRecord.reasons.includes("owner-pid"));
}

function readBrokerStateSnapshot(paths, {
  processExists = defaultProcessExists,
  processSampler = processExists === defaultProcessExists ? defaultProcessSampler : null,
  skipLeaseIds,
  timestamp = nowIso(),
  ...simctlOptions
} = {}) {
  const hostConfig = readHostConfigOrThrow(paths);
  const knownProjects = normalizeKnownProjects(readJsonIfExists(paths.knownProjectsPath), timestamp);
  const registry = normalizeRegistry(readJsonIfExists(paths.registryPath), hostConfig, timestamp);
  const pins = listJsonFiles(paths.pinsDir);
  const skippedLeaseIds = skipLeaseIds instanceof Set ? skipLeaseIds : new Set(skipLeaseIds ?? []);
  const stateProcessSampler = memoizeProcessSampler(processSampler);
  const leases = [];
  for (const lease of listJsonFiles(paths.leasesDir)) {
    if (skippedLeaseIds.has(lease.leaseId)) {
      leases.push(lease);
      continue;
    }
    if (isLeftoverAcquireRollbackLease(lease, registry)) {
      continue;
    }
    if (leaseOwnerIsLive(lease, { processExists, processSampler: stateProcessSampler, timestamp })) {
      leases.push(lease);
      continue;
    }
    if (leaseHasContainmentProcessMetadata(lease)) {
      leases.push(lease);
      continue;
    }
    const registryEntry = registry.aliases[lease.alias];
    if (registryEntry) {
      registryEntry.lastLeaseReleasedAt = timestamp;
    }
  }
  const leasesByAlias = new Map(leases.map((lease) => [lease.alias, lease]));
  const pinsByAlias = new Map(pins.map((pin) => [pin.alias, pin]));

  for (const hostAlias of hostConfig.aliases) {
    const entry = registry.aliases[hostAlias.alias];
    entry.activeLeaseId = leasesByAlias.get(hostAlias.alias)?.leaseId ?? null;
    entry.pinId = pinsByAlias.get(hostAlias.alias)?.pinId ?? null;
    entry.updatedAt = timestamp;
  }
  syncRegistryWithSimctl(hostConfig, registry, simctlOptions);
  registry.updatedAt = timestamp;

  return {
    hostConfig,
    knownProjects,
    leases,
    leasesByAlias,
    pins,
    pinsByAlias,
    registry,
    timestamp,
  };
}

function getPurpose(projectConfig, purposeId) {
  const purpose = projectConfig.purposes.find((candidate) => candidate.id === purposeId);
  if (!purpose) {
    throw new BrokerError(`Unknown purpose ${purposeId}.`, {
      purposeId,
      projectId: projectConfig.projectId,
      reasonCode: "unknown-purpose",
    });
  }
  return purpose;
}

function readProjectConfigOrThrow(paths, projectFilePath) {
  const resolvedProjectFile = projectFilePath ?? paths.projectFilePath;
  if (!resolvedProjectFile) {
    throw new BrokerError("No project file found. Provide --project-file or run from a repo with .simulator-broker/project.json.", {
      reasonCode: "missing-project-file",
    });
  }
  return {
    projectConfig: validateProjectConfig(readProjectJsonOrThrow(resolvedProjectFile)),
    projectFilePath: resolvedProjectFile,
  };
}

function aliasSnapshot(hostAlias, registryEntry, activeLease, activePin) {
  return {
    activeLeaseId: activeLease?.leaseId ?? null,
    activeLeaseSummary: summarizeLeaseHolder(activeLease),
    alias: hostAlias.alias,
    capabilities: hostAlias.capabilities,
    deviceFamily: hostAlias.deviceFamily,
    displayName: hostAlias.displayName,
    driftReason: registryEntry.driftReason,
    health: registryEntry.health,
    iosVersion: hostAlias.iosVersion,
    lastBootedAt: registryEntry.lastBootedAt,
    lastErasedAt: registryEntry.lastErasedAt,
    lastLeaseReleasedAt: registryEntry.lastLeaseReleasedAt,
    lastLeaseStartedAt: registryEntry.lastLeaseStartedAt,
    lastRepairedAt: registryEntry.lastRepairedAt,
    lastShutdownAt: registryEntry.lastShutdownAt,
    pin: summarizePinOwner(activePin),
    powerState: registryEntry.powerState,
    resetPolicy: hostAlias.resetPolicy,
    simulatorId: hostAlias.simulatorId,
  };
}

export function resolveBrokerPaths({
  cwd = process.cwd(),
  env = process.env,
  hostConfigPath,
  projectFilePath,
  repoRoot,
  serviceSocketPath,
  stateRoot,
} = {}) {
  const resolvedHostConfigPath = path.resolve(hostConfigPath ?? env.SIMBROKER_HOST_CONFIG ?? DEFAULT_HOST_CONFIG_PATH);
  const resolvedStateRoot = path.resolve(stateRoot ?? env.SIMBROKER_STATE_ROOT ?? DEFAULT_STATE_ROOT);
  const resolvedRepoRoot = repoRoot ? path.resolve(repoRoot) : null;
  const resolvedServiceSocketPath = path.resolve(
    serviceSocketPath ?? env.SIMBROKER_SERVICE_SOCKET ?? path.join(os.tmpdir(), `simbroker-${shortHash(resolvedStateRoot)}.sock`),
  );
  const resolvedProjectFilePath = projectFilePath
    ? path.resolve(projectFilePath)
    : (env.SIMBROKER_PROJECT_FILE
      ? path.resolve(env.SIMBROKER_PROJECT_FILE)
      : (resolvedRepoRoot ? path.join(resolvedRepoRoot, DEFAULT_PROJECT_FILE) : searchUpForFile(cwd, DEFAULT_PROJECT_FILE)));

  const paths = {
    appSnapshotPath: path.join(resolvedStateRoot, "app-snapshot.json"),
    capacityLockDir: path.join(resolvedStateRoot, "locks", "capacity.lock"),
    capacityLockOwnerPath: path.join(resolvedStateRoot, "locks", "capacity.lock", "owner.json"),
    capacityTransactionsDir: path.join(resolvedStateRoot, "capacity-transactions"),
    evidenceDir: path.join(resolvedStateRoot, "evidence"),
    eventsPath: path.join(resolvedStateRoot, "events.ndjson"),
    hostConfigPath: resolvedHostConfigPath,
    idlePolicyPath: path.join(resolvedStateRoot, "idle-policy.json"),
    knownProjectsPath: path.join(resolvedStateRoot, "known-projects.json"),
    leaseLockDir: path.join(resolvedStateRoot, "locks", "lease-mutation.lock"),
    leaseLockOwnerPath: path.join(resolvedStateRoot, "locks", "lease-mutation.lock", "owner.json"),
    leasesDir: path.join(resolvedStateRoot, "leases"),
    locksDir: path.join(resolvedStateRoot, "locks"),
    pinsDir: path.join(resolvedStateRoot, "pins"),
    projectFilePath: resolvedProjectFilePath,
    registryPath: path.join(resolvedStateRoot, "registry.json"),
    resetLockDir: path.join(resolvedStateRoot, "locks", "reset.lock"),
    resetLockOwnerPath: path.join(resolvedStateRoot, "locks", "reset.lock", "owner.json"),
    serviceLockDir: path.join(resolvedStateRoot, "locks", "service-start.lock"),
    serviceLockOwnerPath: path.join(resolvedStateRoot, "locks", "service-start.lock", "owner.json"),
    serviceLogPath: path.join(resolvedStateRoot, "brokerd.log"),
    serviceMetadataPath: path.join(resolvedStateRoot, "brokerd.json"),
    serviceSocketPath: resolvedServiceSocketPath,
    stateRoot: resolvedStateRoot,
  };
  assertBrokerPathsDistinct(paths);
  return paths;
}

function stateLoadOptions(options, timestamp) {
  const termWaitMs = optionalNonNegativeInteger(options.termWaitMs, "term-wait-ms");
  return {
    processController: options.processController,
    processExists: options.processExists,
    processSampler: options.processSampler,
    skipLeaseIds: options.skipLeaseIds,
    simctlAdapter: options.simctlAdapter,
    simctlInventory: options.simctlInventory,
    termWaitMs,
    timestamp,
    now: options.now,
  };
}

function assertHostConfigCanBeReplaced(paths, options, timestamp) {
  const state = loadBrokerState(paths, stateLoadOptions(options, timestamp));
  if (state.leases.length === 0 && state.pins.length === 0) {
    return;
  }
  throw new BrokerError("Cannot replace the host config while leases or pins are active.", {
    activeLeaseCount: state.leases.length,
    pinCount: state.pins.length,
    reasonCode: "alias-busy",
  });
}

export function initBroker(paths, options = {}) {
  const timestamp = nowIso(options.now);
  let hostConfigCreated = false;

  const initializeUnderMutationLock = () => withLeaseMutationLock(paths, () => {
    if (options.bootstrapConfig) {
      const configExists = fs.existsSync(paths.hostConfigPath);
      if (configExists && options.force !== true) {
        hostConfigCreated = false;
      } else {
        let previousHostConfig = null;
        if (configExists) {
          previousHostConfig = readHostConfigOrThrow(paths);
          assertHostConfigCanBeReplaced(paths, options, timestamp);
        }
        emitHostBootstrapWarning(options);
        const provisioned = buildProvisionedStarterHostConfig({
          hostId: options.hostId,
          iosVersion: options.iosVersion,
          simctlAdapter: options.simctlAdapter,
        });
        const pendingRetirementIds = previousHostConfig === null
          ? []
          : pendingRetirementIdsForHostReplacement(previousHostConfig, provisioned.hostConfig);
        try {
          writeHostConfig(paths, hostConfigWithPendingRetirements(provisioned.hostConfig, pendingRetirementIds));
          hostConfigCreated = true;
        } catch (error) {
          const simctl = resolveSimctlAdapter(options);
          const rollbackFailures = rollbackCreatedSimulators(simctl, provisioned.createdSimulatorIds);
          throw attachRollbackFailures(error, rollbackFailures);
        }
        if (previousHostConfig !== null) {
          const simctl = resolveSimctlAdapter(options);
          const retirement = retirePendingHostSimulators(simctl, pendingRetirementIds, provisioned.hostConfig);
          writeHostConfig(paths, hostConfigWithPendingRetirements(provisioned.hostConfig, retirement.pendingRetirements));
          if (retirement.failedRetirements.length > 0) {
            throw retirement.failedRetirements[0].error;
          }
        }
      }
    }

    const state = loadBrokerState(paths, stateLoadOptions(options, timestamp));
    appendEventRecord(paths, "host.initialized", {
      alias: null,
      leaseId: null,
      payload: {
        aliasCount: state.hostConfig.aliases.length,
        bootstrapConfig: hostConfigCreated,
        hostId: state.hostConfig.hostId,
      },
      projectId: null,
      purposeId: null,
    }, timestamp);
    return state;
  }, {
    now: timestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });

  const state = options.bootstrapConfig
    ? withCapacityLock(paths, initializeUnderMutationLock, {
      now: timestamp,
      processExists: options.processExists,
      processSampler: options.processSampler,
      timeoutMs: options.capacityLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
    })
    : initializeUnderMutationLock();

  return {
    hostId: state.hostConfig.hostId,
    hostConfigCreated,
    hostConfigPath: paths.hostConfigPath,
    initializedAt: timestamp,
    ok: true,
    stateRoot: paths.stateRoot,
    ...(hostConfigCreated ? { bootstrapWarning: HOST_BOOTSTRAP_DEVICE_WARNING } : {}),
  };
}

export function doctorBroker(paths, options = {}) {
  const lockTimestamp = nowIso(options.now);
  let reportTimestamp = lockTimestamp;
  const issues = [];
  let hostConfig = null;
  try {
    hostConfig = readHostConfigOrThrow(paths);
  } catch (error) {
    if (error instanceof BrokerError) {
      issues.push(error.payload);
    } else {
      throw error;
    }
  }

  if (!fs.existsSync(paths.registryPath)) {
    issues.push({
      reasonCode: "missing-registry",
      registryPath: paths.registryPath,
    });
  }

  if (hostConfig) {
    const state = withLeaseMutationLock(
      paths,
      () => {
        const stateTimestamp = nowIso(options.now);
        reportTimestamp = stateTimestamp;
        return loadBrokerState(paths, stateLoadOptions(options, stateTimestamp));
      },
      {
        now: lockTimestamp,
        processExists: options.processExists,
        processSampler: options.processSampler,
        timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
      },
    );
    for (const hostAlias of state.hostConfig.aliases) {
      const registryEntry = state.registry.aliases[hostAlias.alias];
      if (registryEntry.health !== "healthy" && registryEntry.health !== "state-drift") {
        issues.push({
          alias: hostAlias.alias,
          health: registryEntry.health,
          reasonCode: "alias-unhealthy",
        });
      }
    }
  }

  return {
    hostConfigPath: paths.hostConfigPath,
    issues,
    ok: issues.length === 0,
    stateRoot: paths.stateRoot,
    timestamp: reportTimestamp,
  };
}

export function initProjectBroker(paths, options = {}) {
  const timestamp = nowIso(options.now);
  const repoRoot = options.repoRoot
    ? path.resolve(options.repoRoot)
    : (paths.projectFilePath ? resolveRepoRoot(paths.projectFilePath) : process.cwd());
  const projectFilePath = options.projectFilePath
    ? path.resolve(options.projectFilePath)
    : (paths.projectFilePath ?? path.join(repoRoot, DEFAULT_PROJECT_FILE));

  const projectConfigExistsError = () => new BrokerError(`Project config already exists at ${projectFilePath}.`, {
    projectFilePath,
    reasonCode: "project-config-exists",
    suggestedCommand: `simbroker project init --repo-root "${repoRoot}" --overwrite`,
  });

  if (fs.existsSync(projectFilePath) && options.overwrite !== true) {
    throw projectConfigExistsError();
  }

  const derivedRepoName = path.basename(repoRoot);
  const defaultProjectId = `${slugifyIdentifier(derivedRepoName, "sample-broker-project")}-${shortHash(repoRoot)}`;
  const projectName = requireString(
    options.projectName ?? humanizeName(derivedRepoName, "Sample Broker Project"),
    "project-init.projectName",
  );
  const projectId = requireString(
    options.projectId ?? defaultProjectId,
    "project-init.projectId",
  );
  const projectConfig = buildStarterProjectConfig({
    iosVersion: options.iosVersion,
    projectId,
    projectName,
  });

  return withLeaseMutationLock(paths, () => {
    if (fs.existsSync(projectFilePath) && options.overwrite !== true) {
      throw projectConfigExistsError();
    }

    const previousProjectFile = fs.existsSync(projectFilePath)
      ? {
          content: fs.readFileSync(projectFilePath),
          mode: fs.statSync(projectFilePath).mode & 0o777,
        }
      : null;
    let wroteProjectFile = false;
    try {
      if (options.overwrite === true) {
        writeJsonAtomic(projectFilePath, projectConfig);
      } else {
        writeJsonNoReplace(projectFilePath, projectConfig);
      }
      wroteProjectFile = true;
      rememberKnownProjectFromDisk(paths, projectConfig, projectFilePath, timestamp);
    } catch (error) {
      if (error?.code === "EEXIST" && options.overwrite !== true) {
        throw projectConfigExistsError();
      }
      if (wroteProjectFile) {
        if (previousProjectFile) {
          fs.mkdirSync(path.dirname(projectFilePath), { recursive: true });
          fs.writeFileSync(projectFilePath, previousProjectFile.content, { mode: previousProjectFile.mode });
          fs.chmodSync(projectFilePath, previousProjectFile.mode);
        } else {
          removeIfExists(projectFilePath);
        }
      }
      throw error;
    }

    return {
      created: true,
      ok: true,
      projectConfig,
      projectFilePath,
      repoRoot,
      suggestedNextCommands: [
        `simbroker project validate --repo-root "${repoRoot}"`,
        `simbroker lease explain --repo-root "${repoRoot}" --purpose agent-ui-session`,
      ],
    };
  }, {
    now: timestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

export function hostStatusBroker(paths, options = {}) {
  const lockTimestamp = nowIso(options.now);
  return withLeaseMutationLock(paths, () => {
    const timestamp = nowIso(options.now);
    const state = loadBrokerState(paths, stateLoadOptions(options, timestamp));
    const simulators = state.hostConfig.aliases.map((hostAlias) =>
      aliasSnapshot(hostAlias, state.registry.aliases[hostAlias.alias], state.leasesByAlias.get(hostAlias.alias), state.pinsByAlias.get(hostAlias.alias)));
    return {
      hostId: state.hostConfig.hostId,
      ok: true,
      stateRoot: paths.stateRoot,
      summary: {
        leasedAliases: simulators.filter((simulator) => simulator.activeLeaseId !== null).length,
        pinnedAliases: simulators.filter((simulator) => simulator.pin !== null).length,
        totalAliases: simulators.length,
        unhealthyAliases: simulators.filter((simulator) => simulator.health === "repair-needed" || simulator.health === "repairing").length,
      },
      simulators,
    };
  }, {
    now: lockTimestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

export function listSimulatorsBroker(paths, options = {}) {
  return hostStatusBroker(paths, options);
}

export function validateProjectBroker(paths, options = {}) {
  const timestamp = nowIso(options.now);
  return withLeaseMutationLock(paths, () => {
    const { projectConfig, projectFilePath } = readProjectConfigOrThrow(paths, options.projectFilePath);
    rememberKnownProjectFromDisk(paths, projectConfig, projectFilePath, timestamp);
    return {
      ok: true,
      projectConfig,
      projectFilePath,
    };
  }, {
    now: timestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

export function showProjectBroker(paths, options = {}) {
  return validateProjectBroker(paths, options);
}

export function forgetKnownProjectBroker(paths, options = {}) {
  const timestamp = nowIso(options.now);
  const projectId = requireProjectId(options.projectId);
  return withLeaseMutationLock(paths, () => {
    const state = loadBrokerState(paths, stateLoadOptions(options, timestamp));
    const activeLeaseCount = state.leases.filter((lease) => lease.projectId === projectId).length;
    const pinCount = state.pins.filter((pin) => pin.projectId === projectId).length;
    if (activeLeaseCount > 0 || pinCount > 0) {
      throw new BrokerError(`Cannot forget project ${projectId} while it has active leases or pins.`, {
        activeLeaseCount,
        pinCount,
        projectId,
        reasonCode: "project-in-use",
      });
    }

    if (Object.hasOwn(state.knownProjects.projects, projectId) === false) {
      return {
        ok: true,
        projectId,
        unchanged: true,
      };
    }

    delete state.knownProjects.projects[projectId];
    state.knownProjects.updatedAt = timestamp;
    writeKnownProjects(paths, state.knownProjects);
    appendEventRecord(paths, "project.forgotten", {
      alias: null,
      leaseId: null,
      payload: {
        projectId,
      },
      projectId: null,
      purposeId: null,
    }, timestamp);
    return {
      forgotten: true,
      ok: true,
      projectId,
    };
  }, {
    now: timestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

function loadEventRecords(paths) {
  ensureStatePaths(paths);
  return readNdjsonRecords(paths.eventsPath, { repair: false });
}

function loadTailEventRecords(paths, limit) {
  ensureStatePaths(paths);
  return readNdjsonTailRecords(paths.eventsPath, limit);
}

function canUseTailEventRead(options) {
  return options.afterEventId === undefined
    && options.alias === undefined
    && options.projectId === undefined
    && options.purposeId === undefined
    && options.type === undefined
    && Number.isInteger(options.limit)
    && options.limit > 0
    && options.limitMode !== "head";
}

export function readEventsBroker(paths, options = {}) {
  const events = canUseTailEventRead(options)
    ? loadTailEventRecords(paths, options.limit)
    : loadEventRecords(paths);
  const afterEventId = options.afterEventId ?? null;
  const afterIndex = afterEventId === null
    ? -1
    : events.findIndex((event) => event.eventId === afterEventId);

  if (afterEventId !== null && afterIndex === -1) {
    throw new BrokerError(`Event cursor ${afterEventId} was not found.`, {
      afterEventId,
      reasonCode: "event-cursor-not-found",
    });
  }

  const scanned = events.slice(afterIndex + 1);
  let filtered = scanned;
  if (options.alias) {
    filtered = filtered.filter((event) => event.alias === options.alias);
  }
  if (options.projectId) {
    filtered = filtered.filter((event) => event.projectId === options.projectId);
  }
  if (options.purposeId) {
    filtered = filtered.filter((event) => event.purposeId === options.purposeId);
  }
  if (options.type) {
    filtered = filtered.filter((event) => event.type === options.type);
  }
  let nextCursor = scanned.at(-1)?.eventId ?? afterEventId;
  if (Number.isInteger(options.limit) && options.limit >= 0) {
    const limitMode = options.limitMode === "head" ? "head" : "tail";
    if (options.limit === 0) {
      filtered = [];
    } else if (limitMode === "head") {
      const limited = filtered.slice(0, options.limit);
      if (limited.length < filtered.length) {
        nextCursor = limited.at(-1)?.eventId ?? afterEventId;
      }
      filtered = limited;
    } else {
      filtered = filtered.slice(-options.limit);
    }
  }

  return {
    cursor: filtered.at(-1)?.eventId ?? afterEventId,
    events: filtered,
    nextCursor,
    ok: true,
    scannedCursor: scanned.at(-1)?.eventId ?? afterEventId,
  };
}

export function appSnapshotBroker(paths, options = {}) {
  const timestamp = nowIso(options.now);
  const state = readBrokerStateSnapshot(paths, stateLoadOptions(options, timestamp));
  return createAppSnapshot(paths, state, {
    eventLimit: options.eventLimit ?? 50,
    timestamp,
  });
}

export function appSnapshotBrokerUnderMutationLock(paths, options = {}) {
  const lockTimestamp = nowIso(options.now);
  return withLeaseMutationLock(paths, () => {
    const timestamp = nowIso(options.now);
    return appSnapshotBroker(paths, {
      ...options,
      now: timestamp,
    });
  }, {
    now: lockTimestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
    wait: options.leaseMutationLockWait !== false,
  });
}

export function writeAppSnapshotArtifact(paths, options = {}) {
  try {
    const snapshot = appSnapshotBroker(paths, options);
    writeJsonAtomicRestricted(paths.appSnapshotPath, snapshot);
    return snapshot;
  } catch (error) {
    if (error instanceof BrokerError && error.payload.reasonCode === "missing-host-config") {
      return null;
    }
    throw error;
  }
}

export function writeAppSnapshotArtifactUnderMutationLock(paths, options = {}) {
  const lockTimestamp = nowIso(options.now);
  return withLeaseMutationLock(paths, () => {
    const timestamp = nowIso(options.now);
    return writeAppSnapshotArtifact(paths, {
      ...options,
      now: timestamp,
    });
  }, {
    now: lockTimestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
    wait: options.leaseMutationLockWait !== false,
  });
}

export function idlePolicyConfiguredBroker(paths) {
  return readIdlePolicy(paths) !== null;
}

export function enableIdlePolicyBroker(paths, options = {}) {
  const lockTimestamp = nowIso(options.now);
  const actorId = requireHumanIdleActor(options, "Idle policy enable");
  const graceSeconds = requireBoundedInteger(
    options.graceSeconds,
    "grace-seconds",
    MIN_IDLE_GRACE_SECONDS,
    MAX_IDLE_GRACE_SECONDS,
  );
  return withLeaseMutationLock(paths, () => {
    const timestamp = nowIso(options.now);
    try {
      ensureStatePaths(paths);
      writeJsonAtomicRestricted(paths.idlePolicyPath, {
        graceSeconds,
        version: IDLE_POLICY_VERSION,
      });
    } catch (error) {
      const persistenceError = new BrokerError("Idle policy could not be persisted.", {
        reasonCode: "internal-error",
      });
      Object.defineProperty(persistenceError, "cause", {
        configurable: true,
        value: error,
        writable: true,
      });
      throw persistenceError;
    }
    appendEventRecord(paths, "idle.policy.enabled", {
      alias: null,
      actorType: "human",
      jobId: null,
      leaseId: null,
      payload: {
        actorId,
        graceSeconds,
      },
      projectId: null,
      purposeId: null,
    }, timestamp);
    return {
      command: "idle.enable",
      configured: true,
      graceSeconds,
      ok: true,
      schemaVersion: IDLE_SCHEMA_VERSION,
    };
  }, {
    now: lockTimestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

export function disableIdlePolicyBroker(paths, options = {}) {
  const lockTimestamp = nowIso(options.now);
  const actorId = requireHumanIdleActor(options, "Idle policy disable");
  return withLeaseMutationLock(paths, () => {
    const timestamp = nowIso(options.now);
    const unchanged = !fs.existsSync(paths.idlePolicyPath);
    removeIdlePolicy(paths);
    appendEventRecord(paths, "idle.policy.disabled", {
      alias: null,
      actorType: "human",
      jobId: null,
      leaseId: null,
      payload: {
        actorId,
        unchanged,
      },
      projectId: null,
      purposeId: null,
    }, timestamp);
    return {
      command: "idle.disable",
      configured: false,
      graceSeconds: null,
      ok: true,
      schemaVersion: IDLE_SCHEMA_VERSION,
      unchanged,
    };
  }, {
    now: lockTimestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

function loadPublicSafeIdleState(loader) {
  try {
    return loader();
  } catch (error) {
    const reasonCode = error instanceof BrokerError
      && ["missing-host-config", "invalid-config"].includes(error.payload?.reasonCode)
      ? error.payload.reasonCode
      : "internal-error";
    const readError = new BrokerError("Idle broker state could not be read.", {
      reasonCode,
    });
    Object.defineProperty(readError, "cause", {
      configurable: true,
      value: error,
      writable: true,
    });
    throw readError;
  }
}

export function idleStatusBroker(paths, options = {}) {
  return withLeaseMutationLock(paths, () => {
    const timestamp = nowIso(options.now);
    const state = loadPublicSafeIdleState(() => loadBrokerState(paths, {
      ...stateLoadOptions(options, timestamp),
      registryPersistenceDetails: {
        command: "idle.status",
      },
    }));
    return {
      command: "idle.status",
      ok: true,
      schemaVersion: IDLE_SCHEMA_VERSION,
      ...buildIdleSummary(paths, state, timestamp),
    };
  }, {
    now: nowIso(options.now),
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

function idleCleanupStatus(shutdownCount, failureCount) {
  if (failureCount > 0) {
    return "repair_needed";
  }
  return shutdownCount > 0 ? "success" : "no_changes";
}

function performIdleShutdowns(paths, state, candidates, options, timestamp, { command, eventType, source }) {
  const adapter = resolveLifecycleAdapter(options);
  let shutdownCount = 0;
  let failureCount = 0;
  for (const hostAlias of candidates) {
    const registryEntry = state.registry.aliases[hostAlias.alias];
    try {
      invokeLifecycleAdapter("shutdown", adapter, {
        action: "shutdown",
        alias: hostAlias.alias,
        hostAlias,
        paths,
        requester: {
          actorId: options.actorId ?? "idle-policy",
          actorType: options.actorType ?? "system",
          jobId: null,
        },
        state,
        timestamp,
      });
    } catch {
      const attemptTimestamp = nowIso(options.now);
      registryEntry.health = "repair-needed";
      registryEntry.driftReason = "idle-shutdown-failed";
      registryEntry.updatedAt = attemptTimestamp;
      state.registry.updatedAt = attemptTimestamp;
      failureCount += 1;
      writeIdleRegistry(paths, state.registry, {
        command,
        eligibleCount: candidates.length,
        failureCount,
        shutdownCount,
        status: idleCleanupStatus(shutdownCount, failureCount),
      });
      appendEventRecord(paths, "idle.simulator.shutdown_failed", {
        alias: hostAlias.alias,
        actorType: options.actorType ?? "system",
        jobId: null,
        leaseId: null,
        payload: { reasonCode: "idle-shutdown-failed", source },
        projectId: null,
        purposeId: null,
      }, attemptTimestamp);
      continue;
    }
    const attemptTimestamp = nowIso(options.now);
    registryEntry.powerState = "shutdown";
    registryEntry.lastShutdownAt = attemptTimestamp;
    registryEntry.updatedAt = attemptTimestamp;
    shutdownCount += 1;
    appendEventRecord(paths, "idle.simulator.shutdown", {
      alias: hostAlias.alias,
      actorType: options.actorType ?? "system",
      jobId: null,
      leaseId: null,
      payload: { reasonCode: "idle-grace-expired", source },
      projectId: null,
      purposeId: null,
    }, attemptTimestamp);
  }

  const completedAt = candidates.length > 0 ? nowIso(options.now) : timestamp;
  const lastCleanupResult = {
    completedAt,
    eligibleCount: candidates.length,
    failureCount,
    shutdownCount,
    source,
    status: idleCleanupStatus(shutdownCount, failureCount),
  };
  if (candidates.length > 0 || options.persistNoChanges !== false) {
    state.registry.idle.lastCleanupResult = lastCleanupResult;
    state.registry.updatedAt = completedAt;
    writeIdleRegistry(paths, state.registry, {
      command,
      eligibleCount: candidates.length,
      failureCount,
      shutdownCount,
      status: lastCleanupResult.status,
    });
    appendEventRecord(paths, eventType, {
      alias: null,
      actorType: options.actorType ?? "system",
      jobId: null,
      leaseId: null,
      payload: {
        actorId: options.actorId ?? null,
        eligibleCount: candidates.length,
        failureCount,
        shutdownCount,
        source,
        status: lastCleanupResult.status,
      },
      projectId: null,
      purposeId: null,
    }, completedAt);
  }
  return {
    command,
    eligibleCount: candidates.length,
    failureCount,
    lastCleanupResult,
    ok: true,
    schemaVersion: IDLE_SCHEMA_VERSION,
    shutdownCount,
    status: lastCleanupResult.status,
  };
}

export function reconcileIdleBroker(paths, options = {}) {
  return withLeaseMutationLock(paths, () => {
    const timestamp = nowIso(options.now);
    const policy = readIdlePolicy(paths);
    if (!policy) {
      return {
        command: "idle.reconcile",
        configured: false,
        eligibleCount: 0,
        failureCount: 0,
        ok: true,
        schemaVersion: IDLE_SCHEMA_VERSION,
        shutdownCount: 0,
        status: "not_configured",
      };
    }
    const state = loadPublicSafeIdleState(() => loadBrokerState(paths, {
      ...stateLoadOptions(options, timestamp),
      registryPersistenceDetails: {
        command: "idle.reconcile",
      },
    }));
    const candidates = idleEligibleCandidates(state, policy, timestamp);
    return {
      configured: true,
      graceSeconds: policy.graceSeconds,
      ...performIdleShutdowns(paths, state, candidates, options, timestamp, {
        command: "idle.reconcile",
        eventType: "idle.reconciled",
        source: options.source ?? "manual-reconcile",
      }),
    };
  }, {
    now: nowIso(options.now),
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
    wait: options.leaseMutationLockWait !== false,
  });
}

export function cleanupIdleBroker(paths, options = {}) {
  if (options.apply !== true) {
    return withLeaseMutationLock(paths, () => {
      const timestamp = nowIso(options.now);
      const state = loadPublicSafeIdleState(() =>
        readBrokerStateSnapshot(paths, stateLoadOptions(options, timestamp)));
      return idleCleanupPlan(state).publicPlan;
    }, {
      now: nowIso(options.now),
      processExists: options.processExists,
      processSampler: options.processSampler,
      timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
    });
  }

  const actorId = requireHumanIdleActor(options, "Idle cleanup apply");
  if (typeof options.confirmPlanId !== "string" || options.confirmPlanId.trim() === "") {
    throw new BrokerError("Idle cleanup apply requires --confirm <plan-id>.", {
      reasonCode: "idle-confirmation-required",
    });
  }
  return withLeaseMutationLock(paths, () => {
    const timestamp = nowIso(options.now);
    const state = loadPublicSafeIdleState(() =>
      readBrokerStateSnapshot(paths, stateLoadOptions(options, timestamp)));
    const plan = idleCleanupPlan(state);
    if (options.confirmPlanId !== plan.publicPlan.planId) {
      throw new BrokerError("Idle cleanup confirmation is stale; rerun preview and confirm the current plan.", {
        reasonCode: "idle-plan-stale",
      });
    }
    const persistState = {
      ...state,
      registry: normalizeRegistry(readJsonIfExists(paths.registryPath), state.hostConfig, timestamp),
    };
    syncRegistryWithSimctl(persistState.hostConfig, persistState.registry, stateLoadOptions(options, timestamp));
    const result = performIdleShutdowns(paths, persistState, plan.candidates, {
      ...options,
      actorId,
      actorType: "human",
    }, timestamp, {
      command: "idle.cleanup",
      eventType: "idle.cleanup.applied",
      source: "confirmed-cleanup",
    });
    return {
      ...result,
      mode: "apply",
      planId: plan.publicPlan.planId,
    };
  }, {
    now: nowIso(options.now),
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

export function explainLeaseBroker(paths, options = {}) {
  const lockTimestamp = nowIso(options.now);
  return withLeaseMutationLock(paths, () => {
    const timestamp = nowIso(options.now);
    const state = loadBrokerState(paths, stateLoadOptions(options, timestamp));
    const { projectConfig, projectFilePath } = readProjectConfigOrThrow(paths, options.projectFilePath);
    rememberKnownProjectFromDisk(paths, projectConfig, projectFilePath, timestamp);
    const purpose = getPurpose(projectConfig, options.purposeId);
    const analysis = buildCandidateAnalysis({
      explicitAlias: options.alias ?? null,
      hostConfig: state.hostConfig,
      leasesByAlias: state.leasesByAlias,
      pinsByAlias: state.pinsByAlias,
      projectConfig,
      purpose,
      registry: state.registry,
    });
    const available = sortCandidates(analysis.filter((candidate) => candidate.reasons.length === 0)).map((candidate) => candidate.alias);
    return {
      availableAliases: available,
      candidateAnalysis: summarizeSelectionFailure(analysis),
      ok: available.length > 0,
      projectFilePath,
      purpose,
    };
  }, {
    now: lockTimestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

function publicRepoCapacitySummary(projectConfig) {
  return {
    configured: projectConfig !== null,
    projectId: projectConfig?.projectId ?? null,
    repoRoot: null,
  };
}

function publicHostCapacitySummary(hostConfigured, inventoryFresh) {
  return {
    configured: hostConfigured,
    inventoryFresh,
  };
}

function capacitySummary(purposeReports) {
  return {
    available: purposeReports.filter((purpose) => purpose.status === "available").length,
    repairNeeded: purposeReports.filter((purpose) => purpose.status === "repair_needed").length,
    setupMissing: purposeReports.filter((purpose) => purpose.status === "setup_missing").length,
    unavailable: purposeReports.filter((purpose) => purpose.status === "unavailable").length,
    unknown: purposeReports.filter((purpose) => purpose.status === "unknown").length,
  };
}

function checkStatusFromSummary(summary) {
  return summary.unavailable === 0
    && summary.repairNeeded === 0
    && summary.setupMissing === 0
    && summary.unknown === 0
    ? "ready"
    : "needs_attention";
}

function loadCapacityProject(paths, options = {}) {
  const projectFilePath = options.projectFilePath ?? paths.projectFilePath;
  if (!projectFilePath || fs.existsSync(projectFilePath) === false) {
    return {
      error: {
        code: "missing-project-file",
      },
      projectConfig: null,
      projectFilePath: projectFilePath ?? null,
    };
  }

  const projectConfig = validateProjectConfig(readProjectJsonOrThrow(projectFilePath));

  return {
    error: null,
    projectConfig,
    projectFilePath,
  };
}

function selectCapacityPurposes(projectConfig, purposeId) {
  if (purposeId) {
    return [getPurpose(projectConfig, purposeId)];
  }
  return [...projectConfig.purposes].sort((left, right) => left.id.localeCompare(right.id));
}

function capacityProvisioningPolicy(purpose) {
  const resetPolicy = CAPACITY_RESET_POLICY_BY_CAPABILITY[purpose.capability];
  const defaultDeviceFamily = CAPACITY_DEFAULT_FAMILY_BY_CAPABILITY[purpose.capability];
  if (!resetPolicy || !defaultDeviceFamily) {
    return {
      blocker: {
        code: "unsupported-capability",
      },
      requirement: null,
    };
  }
  return {
    blocker: null,
    requirement: {
      capability: purpose.capability,
      deviceFamily: purpose.requires?.deviceFamily ?? defaultDeviceFamily,
      iosVersion: purpose.requires?.iosVersion ?? null,
      resetPolicy,
    },
  };
}

function publicRequestedCapacity(requirement) {
  if (!requirement) {
    return null;
  }
  return {
    capability: requirement.capability,
    deviceFamily: requirement.deviceFamily,
    iosVersion: requirement.iosVersion,
    resetPolicy: requirement.resetPolicy,
  };
}

function selectRuntimeFromInventory(inventory, iosVersion) {
  const runtimes = (inventory.runtimesJson?.runtimes ?? [])
    .filter(isAvailableIosRuntime)
    .filter((runtime) => runtimeMatchesRequestedVersion(runtime, iosVersion))
    .sort((left, right) => compareVersions(right.version, left.version));
  if (runtimes.length === 0) {
    return {
      blocker: {
        code: "runtime-not-found",
      },
      runtime: null,
    };
  }
  return {
    blocker: null,
    runtime: runtimes[0],
  };
}

function selectDeviceTypeFromInventory(inventory, runtime, deviceFamily) {
  const supported = runtimeSupportedDeviceTypes(runtime, inventory)
    .filter((deviceType) => deviceType.productFamily === deviceFamily);
  if (supported.length === 0) {
    return {
      blocker: {
        code: "device-type-not-found",
      },
      deviceType: null,
    };
  }
  return {
    blocker: null,
    deviceType: selectPreferredDeviceType({
      ...runtime,
      supportedDeviceTypes: supported,
    }, deviceFamily),
  };
}

function capacityProvisioningForRequirement(inventory, requirement) {
  if (!inventory || !requirement) {
    return {
      blocker: {
        code: "inventory-unavailable",
      },
      deviceType: null,
      runtime: null,
    };
  }
  const runtimeResult = selectRuntimeFromInventory(inventory, requirement.iosVersion);
  if (runtimeResult.blocker) {
    return {
      blocker: runtimeResult.blocker,
      deviceType: null,
      runtime: null,
    };
  }
  const deviceTypeResult = selectDeviceTypeFromInventory(inventory, runtimeResult.runtime, requirement.deviceFamily);
  if (deviceTypeResult.blocker) {
    return {
      blocker: deviceTypeResult.blocker,
      deviceType: null,
      runtime: runtimeResult.runtime,
    };
  }
  return {
    blocker: null,
    deviceType: deviceTypeResult.deviceType,
    runtime: runtimeResult.runtime,
  };
}

function publicRecommendedActionForProvisioningBlocker(blocker) {
  switch (blocker?.code) {
    case "runtime-not-found":
      return "install_runtime";
    case "device-type-not-found":
      return "run_broker_doctor";
    case "unsupported-capability":
    case "inventory-unavailable":
    default:
      return "inspect_unknown";
  }
}

function publicReason(code) {
  return { code };
}

function structuralCapacityMatches(hostAlias, purpose, requirement) {
  return hostAlias.capabilities.includes(purpose.capability)
    && satisfiesRequires(hostAlias, purpose.requires)
    && (!requirement || hostAlias.resetPolicy === requirement.resetPolicy);
}

function evaluatePurposeCapacity({ inventory, projectConfig, purpose, state }) {
  const policy = capacityProvisioningPolicy(purpose);
  const analysis = buildCandidateAnalysis({
    explicitAlias: null,
    hostConfig: state.hostConfig,
    leasesByAlias: state.leasesByAlias,
    pinsByAlias: state.pinsByAlias,
    projectConfig,
    purpose,
    registry: state.registry,
  });
  const structuralCandidates = analysis.filter((candidate) =>
    structuralCapacityMatches(candidate.hostAlias, purpose, policy.requirement));
  const availableCandidates = structuralCandidates.filter((candidate) => candidate.reasons.length === 0);
  const provisioning = policy.blocker ? {
    blocker: policy.blocker,
    deviceType: null,
    runtime: null,
  } : capacityProvisioningForRequirement(inventory, policy.requirement);

  if (availableCandidates.length > 0) {
    return {
      actionKind: null,
      blockingReasons: [],
      matched: {
        available: availableCandidates.length,
        structural: structuralCandidates.length,
      },
      privateStructuralCandidates: structuralCandidates,
      provisioning,
      purpose,
      recommendedAction: "none",
      requirement: policy.requirement,
      status: "available",
    };
  }

  if (policy.blocker && structuralCandidates.length === 0) {
    return {
      actionKind: null,
      blockingReasons: [publicReason(policy.blocker.code)],
      privateStructuralCandidates: [],
      provisioning,
      purpose,
      recommendedAction: "inspect_unknown",
      requirement: null,
      status: "unknown",
    };
  }

  if (structuralCandidates.length === 0) {
    const blockingReason = provisioning.blocker ?? publicReason("no-matching-capacity");
    return {
      actionKind: provisioning.blocker ? null : "create_capacity",
      blockingReasons: [publicReason(blockingReason.code)],
      matched: null,
      privateStructuralCandidates: [],
      provisioning,
      purpose,
      recommendedAction: provisioning.blocker
        ? publicRecommendedActionForProvisioningBlocker(provisioning.blocker)
        : "create_capacity",
      requirement: policy.requirement,
      status: "unavailable",
    };
  }

  const reasonCodes = new Set();
  for (const candidate of structuralCandidates) {
    for (const reason of candidate.reasons) {
      if (reason.code === "lease-conflict") {
        reasonCodes.add("matching-capacity-busy");
      } else if (reason.code === "pinned-for-other-project") {
        reasonCodes.add("pin-conflict");
      } else if (reason.code === "unhealthy-alias") {
        reasonCodes.add("repair-needed");
      }
    }
  }

  if (reasonCodes.size === 1 && reasonCodes.has("repair-needed")) {
    return {
      actionKind: provisioning.blocker ? null : "create_replacement_capacity",
      blockingReasons: [publicReason("repair-needed")],
      matched: null,
      privateStructuralCandidates: structuralCandidates,
      provisioning,
      purpose,
      recommendedAction: provisioning.blocker
        ? publicRecommendedActionForProvisioningBlocker(provisioning.blocker)
        : "create_replacement_capacity",
      requirement: policy.requirement,
      status: "repair_needed",
    };
  }

  const blockingReasons = Array.from(reasonCodes).sort().map(publicReason);
  return {
    actionKind: null,
    blockingReasons: blockingReasons.length > 0 ? blockingReasons : [publicReason("no-eligible-capacity")],
    matched: null,
    privateStructuralCandidates: structuralCandidates,
    provisioning,
    purpose,
    recommendedAction: reasonCodes.has("pin-conflict")
      ? "inspect_pin_conflict"
      : (reasonCodes.has("matching-capacity-busy") ? "retry_when_available" : "inspect_unknown"),
    requirement: policy.requirement,
    status: "unavailable",
  };
}

function publicPurposeCapacityReport(evaluation) {
  return {
    blockingReasons: evaluation.blockingReasons,
    matched: evaluation.matched ?? null,
    purposeId: evaluation.purpose.id,
    recommendedAction: evaluation.recommendedAction,
    requested: publicRequestedCapacity(evaluation.requirement),
    status: evaluation.status,
  };
}

function setupMissingPurposeReport(purpose, reasonCode) {
  const policy = capacityProvisioningPolicy(purpose);
  return {
    actionKind: null,
    blockingReasons: [publicReason(reasonCode)],
    matched: null,
    privateStructuralCandidates: [],
    provisioning: {
      blocker: {
        code: reasonCode,
      },
      deviceType: null,
      runtime: null,
    },
    purpose,
    recommendedAction: reasonCode === "missing-host-config" ? "configure_host" : "configure_repo",
    requirement: policy.requirement,
    status: "setup_missing",
  };
}

function unknownPurposeCapacityReport(purpose, reasonCode) {
  const policy = capacityProvisioningPolicy(purpose);
  return {
    actionKind: null,
    blockingReasons: [publicReason(reasonCode)],
    matched: null,
    privateStructuralCandidates: [],
    provisioning: {
      blocker: {
        code: reasonCode,
      },
      deviceType: null,
      runtime: null,
    },
    purpose,
    recommendedAction: "run_broker_doctor",
    requirement: policy.requirement,
    status: "unknown",
  };
}

function missingHostCapacityEvaluation(project, selectedPurposes, timestamp, {
  inventory = null,
  inventoryFresh = false,
} = {}) {
  const evaluations = selectedPurposes.map((purpose) => setupMissingPurposeReport(purpose, "missing-host-config"));
  const purposes = evaluations.map(publicPurposeCapacityReport);
  const summary = capacitySummary(purposes);
  return {
    evaluations,
    hostConfigured: false,
    inventory,
    inventoryFresh,
    projectConfig: project.projectConfig,
    projectFilePath: project.projectFilePath,
    report: {
      command: "capacity.check",
      host: publicHostCapacitySummary(false, inventoryFresh),
      ok: true,
      purposes,
      repo: publicRepoCapacitySummary(project.projectConfig),
      schemaVersion: CAPACITY_SCHEMA_VERSION,
      status: checkStatusFromSummary(summary),
      summary,
    },
    state: null,
    timestamp,
  };
}

function buildCapacityEvaluation(paths, options = {}) {
  const timestamp = nowIso(options.now);
  const project = loadCapacityProject(paths, options);
  let selectedPurposes = [];
  if (project.projectConfig) {
    selectedPurposes = selectCapacityPurposes(project.projectConfig, options.purposeId);
  }

  if (!project.projectConfig) {
    const summary = capacitySummary([]);
    summary.setupMissing = 1;
    return {
      evaluations: [],
      hostConfigured: fs.existsSync(paths.hostConfigPath),
      inventory: null,
      inventoryFresh: false,
      projectConfig: null,
      projectFilePath: project.projectFilePath,
      report: {
        command: "capacity.check",
        host: publicHostCapacitySummary(fs.existsSync(paths.hostConfigPath), false),
        ok: true,
        purposes: [],
        repo: publicRepoCapacitySummary(null),
        schemaVersion: CAPACITY_SCHEMA_VERSION,
        status: "needs_attention",
        summary,
      },
      state: null,
      timestamp,
    };
  }

  try {
    readHostConfigOrThrow(paths);
  } catch (error) {
    if (error instanceof BrokerError && error.payload.reasonCode === "missing-host-config") {
      return missingHostCapacityEvaluation(project, selectedPurposes, timestamp);
    }
    throw error;
  }

  let inventory = null;
  try {
    inventory = readSimctlInventory(options);
  } catch {
    const evaluations = selectedPurposes.map((purpose) => unknownPurposeCapacityReport(purpose, "inventory-unavailable"));
    const purposes = evaluations.map(publicPurposeCapacityReport);
    const summary = capacitySummary(purposes);
    return {
      evaluations,
      hostConfigured: fs.existsSync(paths.hostConfigPath),
      inventory: null,
      inventoryFresh: false,
      projectConfig: project.projectConfig,
      projectFilePath: project.projectFilePath,
      report: {
        command: "capacity.check",
        host: publicHostCapacitySummary(fs.existsSync(paths.hostConfigPath), false),
        ok: true,
        purposes,
        repo: publicRepoCapacitySummary(project.projectConfig),
        schemaVersion: CAPACITY_SCHEMA_VERSION,
        status: checkStatusFromSummary(summary),
        summary,
      },
      state: null,
      timestamp,
    };
  }

  let state = null;
  try {
    const loadCapacityState = options.apply === true ? loadBrokerState : readBrokerStateSnapshot;
    state = loadCapacityState(paths, stateLoadOptions({
      ...options,
      simctlInventory: inventory,
    }, timestamp));
  } catch (error) {
    if (error instanceof BrokerError && error.payload.reasonCode === "missing-host-config") {
      return missingHostCapacityEvaluation(project, selectedPurposes, timestamp, {
        inventory,
        inventoryFresh: true,
      });
    }
    throw error;
  }

  const evaluations = selectedPurposes.map((purpose) => evaluatePurposeCapacity({
    inventory,
    projectConfig: project.projectConfig,
    purpose,
    state,
  }));
  const purposes = evaluations.map(publicPurposeCapacityReport);
  const summary = capacitySummary(purposes);
  return {
    evaluations,
    hostConfigured: true,
    inventory,
    inventoryFresh: true,
    projectConfig: project.projectConfig,
    projectFilePath: project.projectFilePath,
    report: {
      command: "capacity.check",
      host: publicHostCapacitySummary(true, true),
      ok: true,
      purposes,
      repo: publicRepoCapacitySummary(project.projectConfig),
      schemaVersion: CAPACITY_SCHEMA_VERSION,
      status: checkStatusFromSummary(summary),
      summary,
    },
    state,
    timestamp,
  };
}

export function checkCapacityBroker(paths, options = {}) {
  return buildCapacityEvaluation(paths, options).report;
}

function requirementTupleKey(requirement) {
  return canonicalJson({
    capability: requirement.capability,
    deviceFamily: requirement.deviceFamily,
    iosVersion: requirement.iosVersion,
    resetPolicy: requirement.resetPolicy,
  });
}

function capacityAliasPrefix(requirement) {
  const basePrefix = CAPACITY_ALIAS_PREFIX_BY_CAPABILITY[requirement.capability] ?? "capacity";
  if (requirement.deviceFamily === "iPad" && basePrefix === "ui") {
    return "ipad";
  }
  if (requirement.deviceFamily === "iPad" && !basePrefix.includes("ipad")) {
    return `${basePrefix}-ipad`;
  }
  return basePrefix;
}

function nextCapacityAlias(existingAliases, requirement) {
  const prefix = capacityAliasPrefix(requirement);
  let index = 1;
  while (existingAliases.has(`${prefix}-${index}`)) {
    index += 1;
  }
  const alias = `${prefix}-${index}`;
  existingAliases.add(alias);
  return alias;
}

function capacityDisplayName(requirement) {
  const capabilityLabel = {
    "automation-resettable": "Automation",
    "build-clean": "Clean Build",
    "build-fast": "Build",
    "interactive-resettable": "UI",
    "manual-persistent": "Manual",
  }[requirement.capability] ?? "Capacity";
  return `${capabilityLabel} ${requirement.deviceFamily}`;
}

function buildCapacityHostFingerprint(evaluation) {
  if (!evaluation.state) {
    return {
      configured: evaluation.hostConfigured,
      inventoryFresh: evaluation.inventoryFresh,
    };
  }
  return {
    aliases: evaluation.state.hostConfig.aliases
      .map((hostAlias) => {
        const registryEntry = evaluation.state.registry.aliases[hostAlias.alias] ?? {};
        const activeLease = evaluation.state.leasesByAlias.get(hostAlias.alias) ?? null;
        const pin = evaluation.state.pinsByAlias.get(hostAlias.alias) ?? null;
        return {
          activeLease: activeLease ? {
            projectId: activeLease.projectId,
            purposeId: activeLease.purposeId,
          } : null,
          alias: hostAlias.alias,
          capabilities: [...hostAlias.capabilities].sort(),
          deviceFamily: hostAlias.deviceFamily,
          health: registryEntry.health ?? null,
          iosVersion: hostAlias.iosVersion,
          pin: pin ? {
            projectId: pin.projectId,
            purposeId: pin.purposeId,
          } : null,
          resetPolicy: hostAlias.resetPolicy,
          simulatorId: hostAlias.simulatorId,
        };
      })
      .sort((left, right) => left.alias.localeCompare(right.alias)),
    configured: true,
    inventory: {
      deviceTypes: (evaluation.inventory?.deviceTypesJson?.devicetypes ?? [])
        .map((deviceType) => ({
          identifier: deviceType.identifier,
          name: deviceType.name,
          productFamily: deviceType.productFamily,
        }))
        .sort((left, right) => left.identifier.localeCompare(right.identifier)),
      runtimes: (evaluation.inventory?.runtimesJson?.runtimes ?? [])
        .map((runtime) => ({
          identifier: runtime.identifier,
          isAvailable: runtime.isAvailable !== false,
          version: runtime.version ?? null,
        }))
        .sort((left, right) => left.identifier.localeCompare(right.identifier)),
    },
    inventoryFresh: evaluation.inventoryFresh,
  };
}

function planBlockerForEvaluation(evaluation) {
  if (evaluation.status === "setup_missing" || evaluation.status === "unknown") {
    return {
      blockingReasons: evaluation.blockingReasons,
      purposeId: evaluation.purpose.id,
      recommendedAction: evaluation.recommendedAction,
    };
  }
  if (evaluation.actionKind === null && evaluation.status !== "available") {
    return {
      blockingReasons: evaluation.blockingReasons,
      purposeId: evaluation.purpose.id,
      recommendedAction: evaluation.recommendedAction,
    };
  }
  if (evaluation.actionKind !== null && evaluation.provisioning.blocker) {
    return {
      blockingReasons: [publicReason(evaluation.provisioning.blocker.code)],
      purposeId: evaluation.purpose.id,
      recommendedAction: publicRecommendedActionForProvisioningBlocker(evaluation.provisioning.blocker),
    };
  }
  return null;
}

function buildCapacityPlan(paths, options = {}) {
  const evaluation = buildCapacityEvaluation(paths, options);
  const actionsByTuple = new Map();
  const blockedReasons = [];

  if (!evaluation.projectConfig) {
    blockedReasons.push({
      blockingReasons: [publicReason("missing-project-file")],
      purposeId: null,
      recommendedAction: "configure_repo",
    });
  }

  for (const purposeEvaluation of evaluation.evaluations) {
    const blocker = planBlockerForEvaluation(purposeEvaluation);
    if (blocker) {
      blockedReasons.push(blocker);
      continue;
    }
    if (!purposeEvaluation.actionKind) {
      continue;
    }
    const key = requirementTupleKey(purposeEvaluation.requirement);
    const existing = actionsByTuple.get(key) ?? {
      kind: purposeEvaluation.actionKind,
      privatePurposeEvaluations: [],
      purposeIds: [],
      requirement: purposeEvaluation.requirement,
    };
    existing.privatePurposeEvaluations.push(purposeEvaluation);
    existing.purposeIds.push(purposeEvaluation.purpose.id);
    if (purposeEvaluation.actionKind === "create_replacement_capacity") {
      existing.kind = "create_replacement_capacity";
    }
    actionsByTuple.set(key, existing);
  }

  const existingAliases = new Set(evaluation.state?.hostConfig.aliases.map((alias) => alias.alias) ?? []);
  const actions = Array.from(actionsByTuple.values())
    .sort((left, right) => requirementTupleKey(left.requirement).localeCompare(requirementTupleKey(right.requirement)))
    .map((action, index) => {
      const alias = nextCapacityAlias(existingAliases, action.requirement);
      const displayName = capacityDisplayName(action.requirement);
      const runtime = action.privatePurposeEvaluations[0].provisioning.runtime;
      const deviceType = action.privatePurposeEvaluations[0].provisioning.deviceType;
      return {
        actionId: `capacity-${index + 1}`,
        kind: action.kind,
        private: {
          alias,
          capabilities: [action.requirement.capability],
          deviceFamily: action.requirement.deviceFamily,
          deviceTypeIdentifier: deviceType.identifier,
          displayName,
          iosVersion: runtime.version,
          resetPolicy: action.requirement.resetPolicy,
          runtimeIdentifier: runtime.identifier,
          simulatorName: simulatorDisplayName(evaluation.state.hostConfig.hostId, alias),
        },
        purposeIds: [...new Set(action.purposeIds)].sort(),
        requirement: action.requirement,
      };
    });

  const publicActions = actions.map((action) => ({
    actionId: action.actionId,
    kind: action.kind,
    purposeIds: action.purposeIds,
    requirement: action.requirement,
  }));
  const sortedBlockedReasons = blockedReasons.sort((left, right) =>
    `${left.purposeId}:${left.recommendedAction}`.localeCompare(`${right.purposeId}:${right.recommendedAction}`));
  const status = sortedBlockedReasons.length > 0
    ? "blocked"
    : (publicActions.length > 0 ? "changes_required" : "no_changes");
  const fingerprint = {
    actions: publicActions,
    blockedReasons: sortedBlockedReasons,
    command: "capacity.reconcile",
    host: buildCapacityHostFingerprint(evaluation),
    project: evaluation.projectConfig ? {
      projectId: evaluation.projectConfig.projectId,
      purposes: evaluation.evaluations.map((purposeEvaluation) => ({
        capability: purposeEvaluation.purpose.capability,
        id: purposeEvaluation.purpose.id,
        requires: purposeEvaluation.purpose.requires,
      })).sort((left, right) => left.id.localeCompare(right.id)),
    } : null,
    schemaVersion: CAPACITY_SCHEMA_VERSION,
    status,
  };
  const planId = sha256Digest(fingerprint);

  return {
    actions,
    blockedReasons: sortedBlockedReasons,
    evaluation,
    fingerprint,
    publicPlan: {
      actions: publicActions,
      blockedReasons: sortedBlockedReasons,
      command: "capacity.reconcile",
      mode: options.apply ? "apply" : "preview",
      ok: true,
      planId,
      schemaVersion: CAPACITY_SCHEMA_VERSION,
      status,
    },
  };
}

function getCapacityTransactionPath(paths, transactionId) {
  return path.join(paths.capacityTransactionsDir, `${transactionId}.json`);
}

function listCapacityTransactions(paths) {
  ensureDir(paths.capacityTransactionsDir);
  return listJsonFiles(paths.capacityTransactionsDir);
}

function writeCapacityTransaction(paths, transaction) {
  writeJsonAtomicRestricted(getCapacityTransactionPath(paths, transaction.transactionId), transaction);
}

function appendCapacityEvent(paths, type, transaction, payload, timestamp) {
  appendEventRecord(paths, type, {
    alias: null,
    actorType: transaction.actorType,
    jobId: null,
    leaseId: null,
    payload: {
      actorId: transaction.actorId,
      planId: transaction.planId,
      transactionId: transaction.transactionId,
      ...payload,
    },
    projectId: transaction.projectId,
    purposeId: null,
  }, timestamp);
}

function createPlannedCapacityAddition(action) {
  return {
    actionId: action.actionId,
    alias: action.private.alias,
    capabilities: action.private.capabilities,
    deviceFamily: action.private.deviceFamily,
    deviceTypeIdentifier: action.private.deviceTypeIdentifier,
    displayName: action.private.displayName,
    iosVersion: action.private.iosVersion,
    resetPolicy: action.private.resetPolicy,
    runtimeIdentifier: action.private.runtimeIdentifier,
    simulatorId: null,
    simulatorName: action.private.simulatorName,
  };
}

function createCurrentDeviceIndex(simctl) {
  return createDeviceIndex({
    deviceTypesJson: simctl.listDeviceTypes(),
    devicesJson: simctl.listDevices(),
    runtimesJson: simctl.listRuntimes(),
  });
}

function matchingPlannedCapacityDevices(deviceIndex, addition) {
  return [...deviceIndex.values()].filter((device) =>
    device.name === addition.simulatorName
      && device.deviceTypeIdentifier === addition.deviceTypeIdentifier
      && device.runtimeIdentifier === addition.runtimeIdentifier);
}

function capturePreCreateDeviceIds(simctl, addition) {
  return matchingPlannedCapacityDevices(createCurrentDeviceIndex(simctl), addition)
    .map((device) => device.udid)
    .sort();
}

function resolvePlannedCapacityAdditions(transaction, simctl, timestamp) {
  const additions = Array.isArray(transaction.additions) ? transaction.additions : [];
  let deviceIndex = null;
  const ambiguous = [];
  let changed = false;
  const resolvedAdditions = additions.map((addition) => {
    if (addition.simulatorId) {
      return addition;
    }
    if (!addition.simulatorName || !addition.deviceTypeIdentifier || !addition.runtimeIdentifier) {
      return addition;
    }
    deviceIndex ??= createCurrentDeviceIndex(simctl);
    const preCreateDeviceIds = new Set(Array.isArray(addition.preCreateDeviceIds) ? addition.preCreateDeviceIds : []);
    const matches = matchingPlannedCapacityDevices(deviceIndex, addition)
      .filter((device) => !preCreateDeviceIds.has(device.udid));
    if (matches.length === 0) {
      return addition;
    }
    if (matches.length > 1) {
      ambiguous.push({
        actionId: addition.actionId,
        alias: addition.alias,
        matchCount: matches.length,
        simulatorName: addition.simulatorName,
      });
      return addition;
    }
    changed = true;
    return {
      ...addition,
      simulatorId: matches[0].udid,
      simulatorIdRecoveredAt: timestamp,
    };
  });

  return {
    additions: resolvedAdditions,
    ambiguous,
    changed,
  };
}

function rollbackCapacityTransaction(paths, transaction, simctl, timestamp, publicError) {
  const failedDeletes = [];
  const resolution = resolvePlannedCapacityAdditions(transaction, simctl, timestamp);
  if (resolution.changed) {
    transaction.additions = resolution.additions;
  }
  for (const ambiguous of resolution.ambiguous) {
    failedDeletes.push({
      actionId: ambiguous.actionId,
      cause: `Ambiguous planned simulator identity for ${ambiguous.simulatorName}.`,
    });
  }
  for (const addition of transaction.additions.filter((candidate) => candidate.simulatorId)) {
    try {
      deleteCapacityDevice(simctl, addition.simulatorId);
    } catch (error) {
      failedDeletes.push({
        actionId: addition.actionId,
        cause: error?.message ?? String(error),
      });
    }
  }

  if (failedDeletes.length > 0) {
    transaction.rollbackFailures = failedDeletes;
    transaction.rollbackState = "rollback_incomplete";
    transaction.status = "rollback_incomplete";
    transaction.updatedAt = timestamp;
    writeCapacityTransaction(paths, transaction);
    appendCapacityEvent(paths, "capacity.reconcile.rollback_incomplete", transaction, {
      failedDeletes: failedDeletes.length,
      reasonCode: "rollback-incomplete",
    }, timestamp);
    throw new BrokerError("Capacity reconcile rollback is incomplete; local operator recovery is required.", {
      reasonCode: "capacity-rollback-incomplete",
      rollbackState: "rollback_incomplete",
      transactionId: transaction.transactionId,
    });
  }

  transaction.rollbackState = "rolled_back";
  transaction.status = "rolled_back";
  transaction.updatedAt = timestamp;
  writeCapacityTransaction(paths, transaction);
  appendCapacityEvent(paths, "capacity.reconcile.rolled_back", transaction, {
    reasonCode: publicError?.payload?.reasonCode ?? "capacity-reconcile-failed",
  }, timestamp);
  throw new BrokerError("Capacity reconcile failed; transaction-created simulators were rolled back.", {
    cause: publicError?.message ?? String(publicError),
    reasonCode: "capacity-reconcile-rolled-back",
    rollbackState: "rolled_back",
    transactionId: transaction.transactionId,
  });
}

function deleteCapacityDevice(simctl, simulatorId) {
  simctl.deleteDevice(simulatorId);
  const deviceIndex = createCurrentDeviceIndex(simctl);
  if (deviceIndex.has(simulatorId)) {
    throw new Error(`simctl delete left simulator ${simulatorId} present`);
  }
}

function recoverCapacityTransactions(paths, options = {}) {
  if (!fs.existsSync(paths.capacityTransactionsDir)) {
    return [];
  }
  const timestamp = nowIso(options.now);
  const transactions = listCapacityTransactions(paths);
  const recovered = [];
  if (transactions.length === 0) {
    return recovered;
  }

  const simctl = resolveSimctlAdapter(options);
  const hostConfig = fs.existsSync(paths.hostConfigPath) ? validateHostConfig(readJson(paths.hostConfigPath)) : null;

  for (const transaction of transactions) {
    if (CAPACITY_TERMINAL_TRANSACTION_STATES.has(transaction.status)) {
      continue;
    }
    const resolution = resolvePlannedCapacityAdditions(transaction, simctl, timestamp);
    if (resolution.changed) {
      transaction.additions = resolution.additions;
      transaction.updatedAt = timestamp;
      writeCapacityTransaction(paths, transaction);
    }
    if (resolution.ambiguous.length > 0) {
      transaction.recoveryState = "rollback_incomplete";
      transaction.rollbackFailures = resolution.ambiguous.map((ambiguous) => ({
        actionId: ambiguous.actionId,
        cause: `Ambiguous planned simulator identity for ${ambiguous.simulatorName}.`,
      }));
      transaction.status = "rollback_incomplete";
      transaction.updatedAt = timestamp;
      writeCapacityTransaction(paths, transaction);
      appendCapacityEvent(paths, "capacity.reconcile.rollback_incomplete", transaction, {
        reasonCode: "rollback-incomplete",
      }, timestamp);
      throw new BrokerError("Capacity reconcile recovery could not identify transaction-created simulators.", {
        reasonCode: "capacity-rollback-incomplete",
        transactionId: transaction.transactionId,
      });
    }
    const additions = Array.isArray(transaction.additions) ? transaction.additions : [];
    const presentAdditions = additions.filter((addition) =>
      addition.simulatorId
        && hostConfig?.aliases.some((hostAlias) =>
          hostAlias.alias === addition.alias && hostAlias.simulatorId === addition.simulatorId));

    if (additions.length > 0 && presentAdditions.length === additions.length) {
      transaction.status = "finalized";
      transaction.recoveryState = "committed";
      transaction.updatedAt = timestamp;
      writeCapacityTransaction(paths, transaction);
      appendCapacityEvent(paths, "capacity.reconcile.applied", transaction, {
        created: additions.length,
        recovered: true,
      }, timestamp);
      recovered.push({
        status: "finalized",
        transactionId: transaction.transactionId,
      });
      continue;
    }

    if (presentAdditions.length > 0) {
      transaction.status = "failed";
      transaction.recoveryState = "ambiguous";
      transaction.updatedAt = timestamp;
      writeCapacityTransaction(paths, transaction);
      appendCapacityEvent(paths, "capacity.reconcile.failed", transaction, {
        recovered: true,
        reasonCode: "capacity-recovery-ambiguous",
      }, timestamp);
      throw new BrokerError("Capacity reconcile recovery found an ambiguous committed state.", {
        reasonCode: "capacity-recovery-ambiguous",
        transactionId: transaction.transactionId,
      });
    }

    try {
      for (const addition of additions.filter((candidate) => candidate.simulatorId)) {
        deleteCapacityDevice(simctl, addition.simulatorId);
      }
    } catch (error) {
      transaction.status = "rollback_incomplete";
      transaction.recoveryState = "rollback_incomplete";
      transaction.updatedAt = timestamp;
      writeCapacityTransaction(paths, transaction);
      appendCapacityEvent(paths, "capacity.reconcile.rollback_incomplete", transaction, {
        reasonCode: "rollback-incomplete",
      }, timestamp);
      throw new BrokerError("Capacity reconcile recovery could not remove transaction-created simulators.", {
        cause: error?.message ?? String(error),
        reasonCode: "capacity-rollback-incomplete",
        transactionId: transaction.transactionId,
      });
    }

    transaction.status = "rolled_back";
    transaction.recoveryState = "rolled_back";
    transaction.updatedAt = timestamp;
    writeCapacityTransaction(paths, transaction);
    appendCapacityEvent(paths, "capacity.reconcile.rolled_back", transaction, {
      recovered: true,
    }, timestamp);
    recovered.push({
      status: "rolled_back",
      transactionId: transaction.transactionId,
    });
  }

  return recovered;
}

function applyBlockedExitReason(plan) {
  const reasonCodes = new Set(
    plan.blockedReasons.flatMap((blocked) => blocked.blockingReasons.map((reason) => reason.code)),
  );
  if (reasonCodes.has("repair-needed")) {
    return "capacity-repair-required";
  }
  if (reasonCodes.has("unsupported-capability")) {
    return "capacity-unsupported-capability";
  }
  if (reasonCodes.has("missing-host-config")) {
    return "missing-host-config";
  }
  if (reasonCodes.has("missing-project-file")) {
    return "missing-project-file";
  }
  return "capacity-apply-blocked";
}

function recordCapacityRejection(paths, plan, options, timestamp, error) {
  const transaction = createCapacityTransaction(plan, {
    actorId: options.actorId ?? null,
    actorType: options.actorType ?? null,
  }, timestamp);
  transaction.rejection = {
    reasonCode: error.payload?.reasonCode ?? "capacity-apply-blocked",
  };
  transaction.status = "rejected";
  transaction.updatedAt = timestamp;
  writeCapacityTransaction(paths, transaction);
  appendCapacityEvent(paths, "capacity.reconcile.failed", transaction, {
    reasonCode: transaction.rejection.reasonCode,
  }, timestamp);
}

function validateCapacityApplyShape(options) {
  if (!options.confirmPlanId) {
    throw new BrokerError("Capacity reconcile apply requires --confirm <plan-id>.", {
      reasonCode: "capacity-confirmation-required",
    });
  }
  if (options.actorType !== "human") {
    throw new BrokerError("Capacity reconcile apply requires --actor-type human.", {
      reasonCode: "capacity-human-required",
    });
  }
  if (!options.actorId) {
    throw new BrokerError("Capacity reconcile apply requires --actor-id <operator-id>.", {
      reasonCode: "capacity-human-required",
    });
  }
}

function normalizeCapacityActorId(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCapacityApplyOptions(options) {
  return {
    ...options,
    actorId: normalizeCapacityActorId(options.actorId),
  };
}

function validateCapacityApplyConfirmation(options, currentPlanId) {
  if (options.confirmPlanId !== currentPlanId) {
    throw new BrokerError("Capacity reconcile confirmation is stale; rerun preview and confirm the current plan.", {
      currentPlanId,
      reasonCode: "capacity-plan-stale",
    });
  }
}

function validateCapacityPlanIsApplicable(plan) {
  if (plan.publicPlan.status === "blocked") {
    throw new BrokerError("Capacity reconcile apply is blocked by the current plan.", {
      blockedReasons: plan.publicPlan.blockedReasons,
      planId: plan.publicPlan.planId,
      reasonCode: applyBlockedExitReason(plan),
    });
  }
}

function createCapacityTransaction(plan, options, timestamp) {
  return {
    actions: plan.publicPlan.actions,
    actorId: options.actorId,
    actorType: options.actorType,
    additions: [],
    beforeDigest: sha256Digest(plan.fingerprint),
    createdAt: timestamp,
    planId: plan.publicPlan.planId,
    projectId: plan.evaluation.projectConfig?.projectId ?? null,
    rollbackState: null,
    status: "intent",
    transactionId: crypto.randomUUID(),
    updatedAt: timestamp,
  };
}

function applyNoChangesPlan(paths, plan, options, timestamp) {
  const transaction = createCapacityTransaction(plan, options, timestamp);
  transaction.status = "finalized";
  transaction.updatedAt = timestamp;
  writeCapacityTransaction(paths, transaction);
  appendCapacityEvent(paths, "capacity.reconcile.no_changes", transaction, {
    created: 0,
  }, timestamp);
  return {
    auditStatus: "complete",
    command: "capacity.reconcile",
    created: 0,
    mode: "apply",
    ok: true,
    planId: plan.publicPlan.planId,
    schemaVersion: CAPACITY_SCHEMA_VERSION,
    status: "no_changes",
    unchanged: 0,
  };
}

function applyCapacityPlan(paths, plan, options, timestamp) {
  const simctl = resolveSimctlAdapter(options);
  const transaction = createCapacityTransaction(plan, options, timestamp);
  let hostConfigCommitted = false;
  writeCapacityTransaction(paths, transaction);

  try {
    for (const action of plan.actions) {
      const addition = createPlannedCapacityAddition(action);
      transaction.additions.push(addition);
      transaction.status = "creating";
      transaction.updatedAt = timestamp;
      addition.preCreateDeviceIds = capturePreCreateDeviceIds(simctl, addition);
      writeCapacityTransaction(paths, transaction);

      const simulatorId = simctl.createDevice(
        action.private.simulatorName,
        action.private.deviceTypeIdentifier,
        action.private.runtimeIdentifier,
      );
      Object.assign(addition, {
        simulatorId,
      });
      transaction.updatedAt = timestamp;
      writeCapacityTransaction(paths, transaction);
    }

    const currentHostConfig = readHostConfigOrThrow(paths);
    const nextHostConfig = {
      ...currentHostConfig,
      aliases: [
        ...currentHostConfig.aliases,
        ...transaction.additions.map((addition) => ({
          alias: addition.alias,
          capabilities: addition.capabilities,
          deviceFamily: addition.deviceFamily,
          displayName: addition.displayName,
          iosVersion: addition.iosVersion,
          resetPolicy: addition.resetPolicy,
          simulatorId: addition.simulatorId,
        })),
      ],
    };

    try {
      writeJsonAtomicDurable(paths.hostConfigPath, nextHostConfig, {
        failStage: options.capacityCommitFailureStage,
      });
      hostConfigCommitted = true;
    } catch (error) {
      hostConfigCommitted = error.hostConfigCommitted === true;
      throw error;
    }

    transaction.afterDigest = sha256Digest(nextHostConfig);
    transaction.status = "config_committed";
    transaction.updatedAt = timestamp;
    writeCapacityTransaction(paths, transaction);

    if (options.capacityAuditFailureStage === "after-commit") {
      throw new Error("Injected capacity audit failure after commit.");
    }

    loadBrokerState(paths, stateLoadOptions(options, timestamp));
    transaction.status = "finalized";
    transaction.updatedAt = timestamp;
    writeCapacityTransaction(paths, transaction);
    appendCapacityEvent(paths, "capacity.reconcile.applied", transaction, {
      created: transaction.additions.length,
    }, timestamp);

    return {
      auditStatus: "complete",
      command: "capacity.reconcile",
      created: transaction.additions.length,
      mode: "apply",
      ok: true,
      planId: plan.publicPlan.planId,
      schemaVersion: CAPACITY_SCHEMA_VERSION,
      status: "applied",
      unchanged: 0,
    };
  } catch (error) {
    if (hostConfigCommitted
      || (error instanceof BrokerError && error.payload.auditStatus === "committed_recovery_required")) {
      transaction.status = "committed_recovery_required";
      transaction.updatedAt = timestamp;
      writeCapacityTransaction(paths, transaction);
      appendCapacityEvent(paths, "capacity.reconcile.failed", transaction, {
        committed: true,
        reasonCode: "committed-recovery-required",
      }, timestamp);
      throw new BrokerError("Capacity reconcile committed host config but audit finalization requires recovery.", {
        auditStatus: "committed_recovery_required",
        reasonCode: "capacity-committed-recovery-required",
        transactionId: transaction.transactionId,
      });
    }
    rollbackCapacityTransaction(paths, transaction, simctl, timestamp, error);
  }
}

export function reconcileCapacityBroker(paths, options = {}) {
  if (options.apply !== true) {
    return buildCapacityPlan(paths, options).publicPlan;
  }

  const applyOptions = normalizeCapacityApplyOptions(options);
  const timestamp = nowIso(options.now);
  try {
    validateCapacityApplyShape(applyOptions);
  } catch (error) {
    if (error instanceof BrokerError) {
      try {
        withCapacityLock(paths, () => {
          try {
            const rejectedPlan = buildCapacityPlan(paths, {
              ...applyOptions,
              apply: false,
            });
            recordCapacityRejection(paths, rejectedPlan, applyOptions, timestamp, error);
          } catch {
            // Apply shape errors remain authoritative when rejection evidence cannot be built.
          }
        }, {
          now: timestamp,
          processExists: applyOptions.processExists,
          processSampler: applyOptions.processSampler,
          wait: false,
        });
      } catch {
        // Apply shape errors remain authoritative when rejection evidence cannot be safely recorded.
      }
    }
    throw error;
  }

  return withCapacityLock(paths, () => {
    const confirmedPlan = buildCapacityPlan(paths, {
      ...applyOptions,
      apply: false,
    });
    try {
      validateCapacityApplyConfirmation(applyOptions, confirmedPlan.publicPlan.planId);
      validateCapacityPlanIsApplicable(confirmedPlan);
    } catch (error) {
      if (error instanceof BrokerError) {
        recordCapacityRejection(paths, confirmedPlan, applyOptions, timestamp, error);
      }
      throw error;
    }

    return withLeaseMutationLock(paths, () => {
      recoverCapacityTransactions(paths, applyOptions);
      const plan = buildCapacityPlan(paths, {
        ...applyOptions,
        apply: true,
      });
      try {
        validateCapacityApplyConfirmation(applyOptions, plan.publicPlan.planId);
        validateCapacityPlanIsApplicable(plan);
      } catch (error) {
        if (error instanceof BrokerError) {
          recordCapacityRejection(paths, plan, applyOptions, timestamp, error);
        }
        throw error;
      }
      if (plan.publicPlan.status === "no_changes") {
        return applyNoChangesPlan(paths, plan, applyOptions, timestamp);
      }
      return applyCapacityPlan(paths, plan, applyOptions, timestamp);
    }, {
      now: timestamp,
      processExists: applyOptions.processExists,
      processSampler: applyOptions.processSampler,
      timeoutMs: applyOptions.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
    });
  }, {
    now: timestamp,
    processExists: applyOptions.processExists,
    processSampler: applyOptions.processSampler,
    timeoutMs: applyOptions.capacityLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

function acquireSelection(paths, options = {}) {
  const timestamp = nowIso(options.now);
  const state = loadBrokerState(paths, stateLoadOptions(options, timestamp));
  const { projectConfig, projectFilePath } = readProjectConfigOrThrow(paths, options.projectFilePath);
  rememberKnownProject(paths, state.knownProjects, projectConfig, projectFilePath, timestamp);
  const purpose = getPurpose(projectConfig, options.purposeId);
  const analysis = buildCandidateAnalysis({
    explicitAlias: options.alias ?? null,
    hostConfig: state.hostConfig,
    leasesByAlias: state.leasesByAlias,
    pinsByAlias: state.pinsByAlias,
    projectConfig,
    purpose,
    registry: state.registry,
  });
  const available = sortCandidates(analysis.filter((candidate) => candidate.reasons.length === 0));
  if (available.length === 0) {
    throw new BrokerError(`No alias is available for purpose ${purpose.id}.`, {
      candidateAnalysis: summarizeSelectionFailure(analysis),
      projectFilePath,
      projectId: projectConfig.projectId,
      purposeId: purpose.id,
      reasonCode: "no-matching-alias",
    });
  }
  return {
    projectConfig,
    projectFilePath,
    purpose,
    selected: available[0],
    state,
    timestamp,
  };
}

function rollbackAcquireLease(paths, state, leaseRecord, timestamp, reasonCode) {
  const registryEntry = state.registry.aliases[leaseRecord.alias];
  registryEntry.activeLeaseId = null;
  registryEntry.health = "repair-needed";
  registryEntry.driftReason = reasonCode;
  registryEntry.updatedAt = timestamp;
  state.registry.updatedAt = timestamp;
  writeRegistry(paths, state.registry);
  removeLeaseRecordFiles(paths, leaseRecord);
}

function rollbackAcquireLeaseFailureSafe(paths, state, leaseRecord, timestamp, reasonCode) {
  try {
    rollbackAcquireLease(paths, state, leaseRecord, timestamp, reasonCode);
    return null;
  } catch (error) {
    return error;
  }
}

function maybeResetLeaseOnAcquire(paths, state, leaseRecord, options = {}) {
  if (leaseRecord.resetPolicy !== "erase-on-acquire") {
    return;
  }

  const simctl = resolveSimctlAdapter(options);
  withResetLock(paths, () => {
    simctl.shutdownDevice(leaseRecord.simulatorId);
    simctl.eraseDevice(leaseRecord.simulatorId);
    sleepSync(options.resetSettleMilliseconds ?? DEFAULT_RESET_SETTLE_MS);
  }, {
    now: leaseRecord.startedAt,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.resetLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });

  const registryEntry = state.registry.aliases[leaseRecord.alias];
  registryEntry.health = "healthy";
  registryEntry.driftReason = null;
  registryEntry.lastErasedAt = leaseRecord.startedAt;
  registryEntry.lastShutdownAt = leaseRecord.startedAt;
  registryEntry.powerState = "shutdown";
  registryEntry.updatedAt = leaseRecord.startedAt;
  state.registry.updatedAt = leaseRecord.startedAt;
  writeRegistry(paths, state.registry);
}

function maybeBootLeaseOnAcquire(paths, state, leaseRecord, options = {}) {
  const registryEntry = state.registry.aliases[leaseRecord.alias];
  if (registryEntry.powerState === "booted") {
    const hostAlias = findHostAliasOrThrow(state, leaseRecord.alias);
    const adapter = resolveLifecycleAdapter(options);
    invokeLifecycleAdapter("waitReady", adapter, {
      action: "waitReady",
      alias: leaseRecord.alias,
      hostAlias,
      paths,
      requester: {
        actorId: leaseRecord.actorId,
        actorType: leaseRecord.actorType,
        jobId: leaseRecord.jobId,
      },
      state,
      timestamp: leaseRecord.startedAt,
    });
    return false;
  }
  const hostAlias = findHostAliasOrThrow(state, leaseRecord.alias);
  const adapter = resolveLifecycleAdapter(options);
  invokeLifecycleAdapter("boot", adapter, {
    action: "boot",
    alias: leaseRecord.alias,
    hostAlias,
    paths,
    requester: {
      actorId: leaseRecord.actorId,
      actorType: leaseRecord.actorType,
      jobId: leaseRecord.jobId,
    },
    state,
    timestamp: leaseRecord.startedAt,
  });
  registryEntry.powerState = "booted";
  registryEntry.health = "healthy";
  registryEntry.driftReason = null;
  registryEntry.lastBootedAt = leaseRecord.startedAt;
  registryEntry.updatedAt = leaseRecord.startedAt;
  state.registry.updatedAt = leaseRecord.startedAt;
  writeRegistry(paths, state.registry);
  appendEventRecord(paths, "simulator.booted", {
    alias: leaseRecord.alias,
    actorType: leaseRecord.actorType,
    jobId: leaseRecord.jobId,
    leaseId: leaseRecord.leaseId,
    payload: {
      action: "boot",
      actorId: leaseRecord.actorId,
      implicitOnAcquire: true,
      powerState: "booted",
    },
    projectId: leaseRecord.projectId,
    purposeId: leaseRecord.purposeId,
  }, leaseRecord.startedAt);
  return true;
}

export function acquireLeaseBroker(paths, options = {}) {
  const lockStartedAt = nowIso(options.now);
  return withLeaseMutationLock(paths, () => {
    const timestamp = nowIso(options.now);
    const selection = acquireSelection(paths, {
      ...options,
      now: timestamp,
    });
    const actorType = options.actorType ?? selection.purpose.defaultActorType ?? "unknown";
    const clientPid = normalizePositiveInteger(options.clientPid) ?? process.pid;
    const actorId = options.actorId ?? `${actorType}:${clientPid}`;
    const leaseId = crypto.randomUUID();
    const activePin = selection.state.pinsByAlias.get(selection.selected.alias) ?? null;
    const ownerPid = requireContainmentRootInteger(
      options.ownerPid === undefined ? process.ppid : options.ownerPid,
      "owner-pid",
    );
    const ownerPgid = optionalContainmentGroupInteger(options.ownerPgid, "owner-pgid");
    validateRegisteredOwnerGroup(ownerPid, ownerPgid, options.processSampler ?? defaultProcessSampler, {
      requireLiveOwner: ownerPgid !== null,
    });
    const sessionDir = options.sessionDir ? path.resolve(options.sessionDir) : null;
    const leaseRecord = {
      actorId,
      actorType,
      alias: selection.selected.hostAlias.alias,
      artifactPath: options.leaseFile ? path.resolve(options.leaseFile) : null,
      displayName: selection.selected.hostAlias.displayName,
      expiresAt: null,
      jobId: options.jobId ?? null,
      jobKind: options.jobKind ?? null,
      leaseId,
      leaseKind: activePin ? "pinned" : "ephemeral",
      ownerPid,
      pinId: activePin?.pinId ?? null,
      projectId: selection.projectConfig.projectId,
      projectName: selection.projectConfig.projectName,
      purposeId: selection.purpose.id,
      repoRoot: resolveRepoRoot(selection.projectFilePath),
      resetPolicy: selection.selected.hostAlias.resetPolicy,
      sessionDir,
      simulatorId: selection.selected.hostAlias.simulatorId,
      startedAt: selection.timestamp,
    };
    leaseRecord.runtime = buildLeaseRuntimeMetadata(leaseRecord, {
      evidenceRoot: options.evidenceDir
        ? path.resolve(options.evidenceDir)
        : (sessionDir ? path.join(sessionDir, "simulator-broker-evidence") : path.join(paths.evidenceDir, leaseId)),
      memoryCeilingBytes: options.memoryCeilingBytes,
      monitorIntervalMs: options.monitorIntervalMs,
      ownerPgid,
      ownerPid,
      ownerRegisteredAt: selection.timestamp,
      simulatorProcessNames: options.simulatorProcessNames,
      updatedAt: selection.timestamp,
    });
    assertLeaseArtifactPathUnused(selection.state.leases, leaseRecord.artifactPath, leaseRecord.leaseId);
    writeLeaseRecord(paths, leaseRecord, { replaceArtifact: false });
    const registryEntry = selection.state.registry.aliases[leaseRecord.alias];
    const previousRegistryEntry = {
      activeLeaseId: registryEntry.activeLeaseId,
      lastLeaseStartedAt: registryEntry.lastLeaseStartedAt,
      updatedAt: registryEntry.updatedAt,
    };
    const previousRegistryUpdatedAt = selection.state.registry.updatedAt;
    registryEntry.activeLeaseId = leaseId;
    registryEntry.lastLeaseStartedAt = selection.timestamp;
    registryEntry.updatedAt = selection.timestamp;
    selection.state.registry.updatedAt = selection.timestamp;
    try {
      writeRegistry(paths, selection.state.registry);
    } catch (error) {
      removeLeaseRecordFiles(paths, leaseRecord);
      registryEntry.activeLeaseId = previousRegistryEntry.activeLeaseId;
      registryEntry.lastLeaseStartedAt = previousRegistryEntry.lastLeaseStartedAt;
      registryEntry.updatedAt = previousRegistryEntry.updatedAt;
      selection.state.registry.updatedAt = previousRegistryUpdatedAt;
      throw error;
    }
    try {
      maybeResetLeaseOnAcquire(paths, selection.state, leaseRecord, options);
    } catch (error) {
      const rollbackError = rollbackAcquireLeaseFailureSafe(
        paths,
        selection.state,
        leaseRecord,
        selection.timestamp,
        "reset-on-acquire-failed",
      );
      throw new BrokerError(`Failed to reset alias ${leaseRecord.alias} before handing out the lease.`, {
        alias: leaseRecord.alias,
        cause: error?.message ?? String(error),
        leaseId: leaseRecord.leaseId,
        reasonCode: "reset-on-acquire-failed",
        ...(rollbackError ? {
          rollbackCause: rollbackError?.message ?? String(rollbackError),
          rollbackFailed: true,
        } : {}),
        resetPolicy: leaseRecord.resetPolicy,
        simulatorId: leaseRecord.simulatorId,
      });
    }
    try {
      maybeBootLeaseOnAcquire(paths, selection.state, leaseRecord, options);
    } catch (error) {
      const rollbackError = rollbackAcquireLeaseFailureSafe(
        paths,
        selection.state,
        leaseRecord,
        selection.timestamp,
        "boot-on-acquire-failed",
      );
      throw new BrokerError(`Failed to boot alias ${leaseRecord.alias} before handing out the lease.`, {
        alias: leaseRecord.alias,
        cause: error?.message ?? String(error),
        leaseId: leaseRecord.leaseId,
        reasonCode: "boot-on-acquire-failed",
        ...(rollbackError ? {
          rollbackCause: rollbackError?.message ?? String(rollbackError),
          rollbackFailed: true,
        } : {}),
        simulatorId: leaseRecord.simulatorId,
      });
    }
    appendEventRecord(paths, "lease.acquired", {
      alias: leaseRecord.alias,
      actorType,
      jobId: leaseRecord.jobId,
      leaseId,
      payload: {
        actorId,
        leaseKind: leaseRecord.leaseKind,
        pinId: leaseRecord.pinId,
      },
      projectId: leaseRecord.projectId,
      purposeId: leaseRecord.purposeId,
    }, selection.timestamp);
    return {
      lease: leaseRecord,
      ok: true,
    };
  }, {
    now: lockStartedAt,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

function loadLeaseByIdOrFile(paths, options = {}) {
  let leaseId = options.leaseId ?? null;
  if (!leaseId && options.leaseFile) {
    leaseId = readJson(path.resolve(options.leaseFile)).leaseId;
  }
  if (!leaseId) {
    throw new BrokerError("Lease id or lease file is required.", {
      reasonCode: "missing-lease-reference",
    });
  }
  const leasePath = getLeaseFilePath(paths, leaseId);
  if (!fs.existsSync(leasePath)) {
    throw new BrokerError(`Lease ${leaseId} was not found.`, {
      leaseId,
      reasonCode: "lease-not-found",
    });
  }
  return readJson(leasePath);
}

export function showLeaseBroker(paths, options = {}) {
  return {
    lease: loadLeaseByIdOrFile(paths, options),
    ok: true,
  };
}

export function registerLeaseProcessBroker(paths, options = {}) {
  const timestamp = nowIso(options.now);
  return withLeaseMutationLock(paths, () => {
    const lease = loadLeaseByIdOrFile(paths, options);
    const skipLeaseIds = new Set(options.skipLeaseIds ?? []);
    skipLeaseIds.add(lease.leaseId);
    const state = loadBrokerState(paths, stateLoadOptions({
      ...options,
      skipLeaseIds,
    }, timestamp));
    const commandPid = requireContainmentRootInteger(options.commandPid, "pid");
    const hasCommand = Object.prototype.hasOwnProperty.call(options, "command") && options.command !== undefined;
    const hasCommandPgid = Object.prototype.hasOwnProperty.call(options, "commandPgid") && options.commandPgid !== undefined;
    const hasOwnerPgid = Object.prototype.hasOwnProperty.call(options, "ownerPgid") && options.ownerPgid !== undefined;
    const hasOwnerPid = Object.prototype.hasOwnProperty.call(options, "ownerPid") && options.ownerPid !== undefined;
    const commandPgid = hasCommandPgid
      ? optionalContainmentGroupInteger(options.commandPgid, "pgid")
      : undefined;
    const ownerPgid = hasOwnerPgid
      ? optionalContainmentGroupInteger(options.ownerPgid, "owner-pgid")
      : undefined;
    const ownerPid = hasOwnerPid
      ? requireContainmentRootInteger(options.ownerPid, "owner-pid")
      : null;
    validateRegisteredCommandGroup(commandPid, commandPgid, options.processSampler ?? defaultProcessSampler);
    validateRegisteredOwnerGroup(
      ownerPid ?? normalizePositiveInteger(lease.runtime?.ownerPid ?? lease.ownerPid),
      ownerPgid,
      options.processSampler ?? defaultProcessSampler,
      { requireLiveOwner: ownerPgid !== undefined },
    );
    const command = hasCommand
      ? (Array.isArray(options.command)
        ? options.command
        : (typeof options.command === "string" ? options.command : null))
      : undefined;
    lease.runtime = mergeLeaseRuntimeMetadata(lease, {
      command,
      commandRegisteredAt: timestamp,
      commandPgid,
      commandPid,
      evidenceRoot: options.evidenceDir ? path.resolve(options.evidenceDir) : undefined,
      memoryCeilingBytes: options.memoryCeilingBytes,
      monitorIntervalMs: options.monitorIntervalMs,
      ownerPgid,
      ownerPid,
      ownerRegisteredAt: ownerPid !== null ? timestamp : lease.runtime?.ownerRegisteredAt,
      simulatorProcessNames: options.simulatorProcessNames,
      updatedAt: timestamp,
    });
    if (ownerPid) {
      lease.ownerPid = ownerPid;
    }
    writeLeaseRecord(paths, lease);
    appendEventRecord(paths, "lease.process-registered", {
      alias: lease.alias,
      actorType: lease.actorType,
      jobId: lease.jobId ?? null,
      leaseId: lease.leaseId,
      payload: {
        actorId: lease.actorId,
        command: lease.runtime.command,
        commandPgid: lease.runtime.commandPgid,
        commandPid: lease.runtime.commandPid,
        memoryCeilingBytes: lease.runtime.memoryCeilingBytes,
        ownerPgid: lease.runtime.ownerPgid,
        ownerPid: lease.runtime.ownerPid,
        simulatorProcessNames: lease.runtime.simulatorProcessNames,
      },
      projectId: lease.projectId,
      purposeId: lease.purposeId,
    }, timestamp);
    return {
      lease,
      ok: true,
      registeredAt: timestamp,
      registryActiveLeaseId: state.registry.aliases[lease.alias]?.activeLeaseId ?? null,
    };
  }, {
    now: timestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

export function containLeaseBroker(paths, options = {}) {
  const timestamp = nowIso(options.now);
  const reason = validateContainmentReason(options.reason ?? "manual-cleanup");
  const termWaitMs = optionalNonNegativeInteger(options.termWaitMs, "term-wait-ms");
  return withLeaseMutationLock(paths, () => {
    const lease = loadLeaseByIdOrFile(paths, options);
    const state = loadBrokerState(paths, stateLoadOptions({
      ...options,
      termWaitMs,
      skipLeaseIds: [lease.leaseId],
    }, timestamp));
    return containLeaseRecord(paths, state, lease, {
      captureDiagnostics: options.captureDiagnostics,
      diagnosticSampler: options.diagnosticSampler,
      killOwner: options.killOwner,
      processController: options.processController,
      processSampler: options.processSampler,
      postKillPollMs: options.postKillPollMs,
      postKillWaitMs: options.postKillWaitMs,
      reason,
      requesterPid: options.requesterPid,
      termWaitMs,
      now: options.now ?? timestamp,
    });
  }, {
    now: timestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

export function releaseLeaseBroker(paths, options = {}) {
  const lockStartedAt = nowIso(options.now);
  return withLeaseMutationLock(paths, () => {
    const timestamp = nowIso(options.now);
    const lease = loadLeaseByIdOrFile(paths, options);
    const skipLeaseIds = new Set(options.skipLeaseIds ?? []);
    skipLeaseIds.add(lease.leaseId);
    const state = loadBrokerState(paths, stateLoadOptions({
      ...options,
      skipLeaseIds,
    }, timestamp));
    assertLeaseArtifactPathAllowed(paths, lease.artifactPath);
    const leaseFileSnapshot = snapshotLeaseRecordFiles(paths, lease);
    const registrySnapshot = JSON.parse(JSON.stringify(state.registry));
    const registryEntry = state.registry.aliases[lease.alias];
    try {
      removeLeaseArtifactFile(paths, lease);
      if (registryEntry) {
        registryEntry.activeLeaseId = null;
        registryEntry.lastLeaseReleasedAt = timestamp;
        registryEntry.updatedAt = timestamp;
        state.registry.updatedAt = timestamp;
        writeRegistry(paths, state.registry);
      }
      removeCanonicalLeaseRecordFile(paths, lease);
    } catch (error) {
      try {
        restoreLeaseRecordFiles(leaseFileSnapshot);
        writeRegistry(paths, registrySnapshot);
      } catch (restoreError) {
        error.restoreError = restoreError?.message ?? String(restoreError);
      }
      throw error;
    }
    const actorType = options.actorType ?? lease.actorType;
    const actorId = options.actorId ?? lease.actorId;
    appendEventRecord(paths, "lease.released", {
      alias: lease.alias,
      actorType,
      jobId: options.jobId ?? lease.jobId,
      leaseId: lease.leaseId,
      payload: {
        actorId,
        previousActorId: lease.actorId,
        previousActorType: lease.actorType,
      },
      projectId: lease.projectId,
      purposeId: lease.purposeId,
    }, timestamp);
    return {
      leaseId: lease.leaseId,
      ok: true,
      releasedAt: timestamp,
    };
  }, {
    now: lockStartedAt,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

export function createPinBroker(paths, options = {}) {
  const timestamp = nowIso(options.now);
  return withLeaseMutationLock(paths, () => {
    const state = loadBrokerState(paths, stateLoadOptions(options, timestamp));
    const { projectConfig, projectFilePath } = readProjectConfigOrThrow(paths, options.projectFilePath);
    rememberKnownProject(paths, state.knownProjects, projectConfig, projectFilePath, timestamp);
    const purpose = getPurpose(projectConfig, options.purposeId);
    const hostAlias = state.hostConfig.aliases.find((candidate) => candidate.alias === options.alias);
    if (!hostAlias) {
      throw new BrokerError(`Unknown alias ${options.alias}.`, {
        alias: options.alias,
        reasonCode: "unknown-alias",
      });
    }
    if (!hostAlias.capabilities.includes(purpose.capability) || !satisfiesRequires(hostAlias, purpose.requires)) {
      throw new BrokerError(`Alias ${hostAlias.alias} does not satisfy purpose ${purpose.id}.`, {
        alias: hostAlias.alias,
        projectId: projectConfig.projectId,
        purposeId: purpose.id,
        reasonCode: "alias-purpose-mismatch",
        requiredCapability: purpose.capability,
        requires: purpose.requires,
      });
    }
    const registryEntry = state.registry.aliases[hostAlias.alias];
    if (registryEntry.health === "repair-needed" || registryEntry.health === "repairing") {
      throw new BrokerError(`Alias ${hostAlias.alias} is unhealthy.`, {
        alias: hostAlias.alias,
        driftReason: registryEntry.driftReason,
        health: registryEntry.health,
        reasonCode: "unhealthy-alias",
      });
    }
    const existingPin = state.pinsByAlias.get(hostAlias.alias);
    if (existingPin) {
      if (existingPin.projectId === projectConfig.projectId && existingPin.purposeId === purpose.id) {
        return {
          ok: true,
          pin: existingPin,
          projectFilePath,
          unchanged: true,
        };
      }
      throw new BrokerError(`Alias ${hostAlias.alias} is already pinned.`, {
        alias: hostAlias.alias,
        pinId: existingPin.pinId,
        projectId: existingPin.projectId,
        purposeId: existingPin.purposeId,
        reasonCode: "pin-conflict",
      });
    }
    const activeLease = state.leasesByAlias.get(hostAlias.alias);
    if (activeLease && !leaseMatchesPin({ projectId: projectConfig.projectId, purposeId: purpose.id }, activeLease)) {
      throw new BrokerError(`Alias ${hostAlias.alias} is leased by another project.`, {
        alias: hostAlias.alias,
        leaseId: activeLease.leaseId,
        projectId: activeLease.projectId,
        purposeId: activeLease.purposeId,
        reasonCode: "lease-conflict",
      });
    }
    const pin = {
      actorId: options.actorId ?? "human:local-cli",
      actorType: options.actorType ?? "human",
      alias: hostAlias.alias,
      createdAt: timestamp,
      note: options.note ?? null,
      pinId: crypto.randomUUID(),
      projectId: projectConfig.projectId,
      projectName: projectConfig.projectName,
      purposeId: purpose.id,
      repoRoot: resolveRepoRoot(projectFilePath),
    };
    const pinFilePath = getPinFilePath(paths, pin.pinId);
    writeJsonAtomicRestricted(pinFilePath, pin);
    registryEntry.pinId = pin.pinId;
    registryEntry.updatedAt = timestamp;
    state.registry.updatedAt = timestamp;
    try {
      writeRegistry(paths, state.registry);
    } catch (error) {
      removeIfExists(pinFilePath);
      registryEntry.pinId = null;
      registryEntry.updatedAt = timestamp;
      throw error;
    }
    appendEventRecord(paths, "pin.created", {
      alias: pin.alias,
      actorType: pin.actorType,
      jobId: null,
      leaseId: null,
      payload: {
        actorId: pin.actorId,
        pinId: pin.pinId,
      },
      projectId: pin.projectId,
      purposeId: pin.purposeId,
    }, timestamp);
    return {
      ok: true,
      pin,
    };
  }, {
    now: timestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

export function clearPinBroker(paths, options = {}) {
  const timestamp = nowIso(options.now);
  return withLeaseMutationLock(paths, () => {
    const state = loadBrokerState(paths, stateLoadOptions(options, timestamp));
    const pin = state.pinsByAlias.get(options.alias);
    if (!pin) {
      throw new BrokerError(`Alias ${options.alias} is not pinned.`, {
        alias: options.alias,
        reasonCode: "pin-not-found",
      });
    }
    const pinFilePath = getPinFilePath(paths, pin.pinId);
    state.registry.aliases[options.alias].pinId = null;
    state.registry.aliases[options.alias].updatedAt = timestamp;
    state.registry.updatedAt = timestamp;
    writeRegistry(paths, state.registry);
    removeIfExists(pinFilePath);
    appendEventRecord(paths, "pin.cleared", {
      alias: pin.alias,
      actorType: options.actorType ?? "human",
      jobId: null,
      leaseId: null,
      payload: {
        actorId: options.actorId ?? "human:local-cli",
        pinId: pin.pinId,
      },
      projectId: pin.projectId,
      purposeId: pin.purposeId,
    }, timestamp);
    return {
      alias: pin.alias,
      ok: true,
      pinId: pin.pinId,
    };
  }, {
    now: timestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

function lifecycleConflictError(action, alias, requester, { allowOverride = false, reasonCode = "lease-conflict" } = {}) {
  throw new BrokerError(`Alias ${alias} is leased by another actor and cannot accept ${action}.`, {
    action,
    alias,
    allowOverride,
    currentHolder: summarizeLeaseHolder(requester.activeLease),
    reasonCode,
  });
}

function lifecycleOwnershipContext(requester) {
  return {
    leaseId: requester.holderMatches ? requester.activeLease?.leaseId ?? null : null,
    projectId: requester.activeLease?.projectId ?? requester.activePin?.projectId ?? null,
    purposeId: requester.activeLease?.purposeId ?? requester.activePin?.purposeId ?? null,
  };
}

function lifecycleActorPayload(action, requester, revokedLeaseSummary, extra = {}) {
  return {
    action,
    actorId: requester.actorId,
    overrideApplied: revokedLeaseSummary !== null,
    revokedLease: revokedLeaseSummary,
    ...extra,
  };
}

function lifecycleResult(paths, state, hostAlias, revokedLeaseSummary, timestamp, action, unchanged = false) {
  return {
    action,
    alias: hostAlias.alias,
    ok: true,
    performedAt: timestamp,
    revokedLease: revokedLeaseSummary,
    simulator: aliasSnapshot(
      hostAlias,
      state.registry.aliases[hostAlias.alias],
      state.leasesByAlias.get(hostAlias.alias) ?? null,
      state.pinsByAlias.get(hostAlias.alias) ?? null,
    ),
    unchanged,
  };
}

function runLifecycleActionBroker(paths, action, options = {}) {
  const timestamp = nowIso(options.now);
  const state = loadBrokerState(paths, stateLoadOptions(options, timestamp));
  const hostAlias = findHostAliasOrThrow(state, options.alias);
  const registryEntry = state.registry.aliases[hostAlias.alias];
  const requester = resolveLifecycleRequester(paths, state, options, hostAlias.alias);
  const adapter = resolveLifecycleAdapter(options);

  assertLifecycleHealth(action, hostAlias.alias, registryEntry);

  let revokedLeaseSummary = null;
  if (requester.activeLease && !requester.holderMatches) {
    if (action === "boot" || action === "shutdown") {
      lifecycleConflictError(action, hostAlias.alias, requester);
    }
    const overrideReason = validateForceOverride(action, options, requester, hostAlias.alias, requester.activeLease);
    revokedLeaseSummary = revokeLeaseForOverride(paths, state, requester.activeLease, {
      action,
      actorId: requester.actorId,
      actorType: requester.actorType,
      overrideReason,
      timestamp,
    });
  }

  const ownership = lifecycleOwnershipContext(requester);

  if (action === "boot" || action === "shutdown") {
    const targetPowerState = action === "boot" ? "booted" : "shutdown";
    const eventType = action === "boot" ? "simulator.booted" : "simulator.shutdown";
    if (registryEntry.powerState === targetPowerState && registryEntry.health !== "state-drift") {
      return lifecycleResult(paths, state, hostAlias, revokedLeaseSummary, timestamp, action, true);
    }
    invokeLifecycleAdapter(action, adapter, {
      action,
      alias: hostAlias.alias,
      hostAlias,
      paths,
      requester,
      state,
      timestamp,
    });
    registryEntry.powerState = targetPowerState;
    registryEntry.health = "healthy";
    registryEntry.driftReason = null;
    if (action === "boot") {
      registryEntry.lastBootedAt = timestamp;
    } else {
      registryEntry.lastShutdownAt = timestamp;
    }
    registryEntry.updatedAt = timestamp;
    state.registry.updatedAt = timestamp;
    writeRegistry(paths, state.registry);
    appendEventRecord(paths, eventType, {
      alias: hostAlias.alias,
      actorType: requester.actorType,
      jobId: requester.jobId,
      leaseId: ownership.leaseId,
      payload: lifecycleActorPayload(action, requester, revokedLeaseSummary, {
        health: registryEntry.health,
        powerState: registryEntry.powerState,
      }),
      projectId: ownership.projectId,
      purposeId: ownership.purposeId,
    }, timestamp);
    return lifecycleResult(paths, state, hostAlias, revokedLeaseSummary, timestamp, action);
  }

  if (action === "erase") {
    invokeLifecycleAdapter(action, adapter, {
      action,
      alias: hostAlias.alias,
      hostAlias,
      paths,
      requester,
      state,
      timestamp,
    });
    registryEntry.powerState = "shutdown";
    registryEntry.lastErasedAt = timestamp;
    registryEntry.lastShutdownAt = timestamp;
    if (registryEntry.health === "state-drift") {
      registryEntry.health = "healthy";
      registryEntry.driftReason = null;
    }
    registryEntry.updatedAt = timestamp;
    state.registry.updatedAt = timestamp;
    writeRegistry(paths, state.registry);
    appendEventRecord(paths, "simulator.erased", {
      alias: hostAlias.alias,
      actorType: requester.actorType,
      jobId: requester.jobId,
      leaseId: ownership.leaseId,
      payload: lifecycleActorPayload(action, requester, revokedLeaseSummary, {
        health: registryEntry.health,
        powerState: registryEntry.powerState,
      }),
      projectId: ownership.projectId,
      purposeId: ownership.purposeId,
    }, timestamp);
    return lifecycleResult(paths, state, hostAlias, revokedLeaseSummary, timestamp, action);
  }

  if (action === "repair") {
    registryEntry.health = "repairing";
    registryEntry.updatedAt = timestamp;
    state.registry.updatedAt = timestamp;
    writeRegistry(paths, state.registry);
    appendEventRecord(paths, "simulator.repair.started", {
      alias: hostAlias.alias,
      actorType: requester.actorType,
      jobId: requester.jobId,
      leaseId: ownership.leaseId,
      payload: lifecycleActorPayload(action, requester, revokedLeaseSummary, {
        health: registryEntry.health,
      }),
      projectId: ownership.projectId,
      purposeId: ownership.purposeId,
    }, timestamp);

    try {
      const repairResult = invokeLifecycleAdapter(action, adapter, {
        action,
        alias: hostAlias.alias,
        hostAlias,
        paths,
        requester,
        state,
        timestamp,
      });
      if (repairResult?.simulatorId) {
        hostAlias.simulatorId = repairResult.simulatorId;
      }
    } catch (error) {
      registryEntry.health = "repair-needed";
      registryEntry.driftReason = error.payload?.cause ?? error.message;
      registryEntry.updatedAt = timestamp;
      state.registry.updatedAt = timestamp;
      writeRegistry(paths, state.registry);
      appendEventRecord(paths, "simulator.repair.failed", {
        alias: hostAlias.alias,
        actorType: requester.actorType,
        jobId: requester.jobId,
        leaseId: ownership.leaseId,
        payload: lifecycleActorPayload(action, requester, revokedLeaseSummary, {
          cause: error.payload?.cause ?? error.message,
          health: registryEntry.health,
        }),
        projectId: ownership.projectId,
        purposeId: ownership.purposeId,
      }, timestamp);
      throw error;
    }

    registryEntry.health = "healthy";
    registryEntry.driftReason = null;
    registryEntry.lastRepairedAt = timestamp;
    registryEntry.lastShutdownAt = timestamp;
    registryEntry.powerState = "shutdown";
    registryEntry.updatedAt = timestamp;
    state.registry.updatedAt = timestamp;
    writeRegistry(paths, state.registry);
    appendEventRecord(paths, "simulator.repaired", {
      alias: hostAlias.alias,
      actorType: requester.actorType,
      jobId: requester.jobId,
      leaseId: ownership.leaseId,
      payload: lifecycleActorPayload(action, requester, revokedLeaseSummary, {
        health: registryEntry.health,
        powerState: registryEntry.powerState,
      }),
      projectId: ownership.projectId,
      purposeId: ownership.purposeId,
    }, timestamp);
    return lifecycleResult(paths, state, hostAlias, revokedLeaseSummary, timestamp, action);
  }

  throw new BrokerError(`Unsupported simulator action ${action}.`, {
    action,
    alias: hostAlias.alias,
    reasonCode: "unsupported-simulator-action",
  });
}

export function bootSimulatorBroker(paths, options = {}) {
  const timestamp = nowIso(options.now);
  return withLeaseMutationLock(paths, () => runLifecycleActionBroker(paths, "boot", options), {
    now: timestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

export function shutdownSimulatorBroker(paths, options = {}) {
  const timestamp = nowIso(options.now);
  return withLeaseMutationLock(paths, () => runLifecycleActionBroker(paths, "shutdown", options), {
    now: timestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

export function eraseSimulatorBroker(paths, options = {}) {
  const timestamp = nowIso(options.now);
  return withLeaseMutationLock(paths, () => runLifecycleActionBroker(paths, "erase", options), {
    now: timestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}

export function repairSimulatorBroker(paths, options = {}) {
  const timestamp = nowIso(options.now);
  return withCapacityLock(paths, () => withLeaseMutationLock(paths, () => runLifecycleActionBroker(paths, "repair", options), {
    now: timestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.leaseLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  }), {
    now: timestamp,
    processExists: options.processExists,
    processSampler: options.processSampler,
    timeoutMs: options.capacityLockTimeoutMilliseconds ?? DEFAULT_LOCK_TIMEOUT_MS,
  });
}
