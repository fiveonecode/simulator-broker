import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MONITOR_INTERVAL_MS = 1000;
export const DEFAULT_CONTAINMENT_TERM_WAIT_MS = 250;
const DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 3000;
export const DEFAULT_CONTAINMENT_POST_KILL_POLL_MS = 10;
export const DEFAULT_CONTAINMENT_POST_KILL_WAIT_MS = 50;
const COMMAND_PID_IDENTITY_TOLERANCE_MS = 15_000;
export const STALE_CONTAINMENT_PROCESS_SAMPLER_INVOCATIONS = 2
  + Math.floor(DEFAULT_CONTAINMENT_POST_KILL_WAIT_MS / DEFAULT_CONTAINMENT_POST_KILL_POLL_MS)
  + 1;
const DEFAULT_TERM_WAIT_MS = DEFAULT_CONTAINMENT_TERM_WAIT_MS;
const DEFAULT_POST_KILL_POLL_MS = DEFAULT_CONTAINMENT_POST_KILL_POLL_MS;
const DEFAULT_POST_KILL_WAIT_MS = DEFAULT_CONTAINMENT_POST_KILL_WAIT_MS;
const PROCESS_SAMPLER_ARGS = Object.freeze([
  "-axww",
  "-o",
  "pid=,ppid=,pgid=,rss=,vsz=,etime=,stat=,command=",
]);
export const PROCESS_SAMPLER_TIMEOUT_MS = 10_000;
const COMMAND_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const COMMAND_WRAPPER_NAMES = new Set(["env", "exec"]);
const ENV_WRAPPER_VALUE_OPTIONS = new Set(["-C", "--chdir", "-P", "-S", "--split-string", "-u", "--unset"]);
const MEMORY_REASONS = new Set(["memory-ceiling"]);
const FORCE_REASONS = new Set(["forced-abort", "timeout", "stale-owner", "manual-cleanup"]);
const SHELL_PROCESS_NAMES = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);
const PROCESS_SAMPLER_COMMAND_PATTERNS = [
  /(?:^|\s|\/)ps\s+-axo\s+pid=,ppid=,pgid=,rss=,vsz=,etime=,stat=,command=/,
  /(?:^|\s|\/)ps\s+-axww\s+-o\s+pid=,ppid=,pgid=,rss=,vsz=,etime=,stat=,command=/,
];
export const CONTAINMENT_REASONS = Object.freeze([
  "memory-ceiling",
  "forced-abort",
  "timeout",
  "stale-owner",
  "manual-cleanup",
]);

function sleepSync(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function advanceNowIso(now, deltaMilliseconds = 0) {
  const baseDate = typeof now === "string"
    ? new Date(now)
    : (now instanceof Date ? now : new Date(now ?? Date.now()));
  const baseMilliseconds = baseDate.getTime();
  if (!Number.isFinite(baseMilliseconds)) {
    return new Date().toISOString();
  }
  return new Date(baseMilliseconds + Math.max(0, Number(deltaMilliseconds) || 0)).toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, contents) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, contents.endsWith("\n") ? contents : `${contents}\n`);
}

function writeJson(filePath, payload) {
  writeText(filePath, JSON.stringify(payload, null, 2));
}

function safeSegment(value) {
  return String(value ?? "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "unknown";
}

function timestampSegment(timestamp) {
  return safeSegment(String(timestamp ?? new Date().toISOString()).replace(/[:]/g, "-"));
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeRegisteredCommand(value) {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean);
    return normalized.length > 0 ? normalized : null;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || null;
  }
  return null;
}

export function defaultSimulatorProcessNames(lease) {
  const names = new Set([
    "Test Host App",
    "XCTRunner",
    "xctest",
  ]);
  if (lease.projectName) {
    names.add(`${lease.projectName} Test Host App`);
    names.add(`${lease.projectName}Tests`);
    names.add(`${lease.projectName}UITests`);
  }
  return [...names];
}

export function isSupportedContainmentReason(reason) {
  return CONTAINMENT_REASONS.includes(String(reason ?? ""));
}

export function buildLeaseRuntimeMetadata(lease, options = {}) {
  const existing = lease.runtime && typeof lease.runtime === "object" ? lease.runtime : {};
  const memoryCeilingBytes = normalizePositiveInteger(options.memoryCeilingBytes ?? existing.memoryCeilingBytes);
  const monitorIntervalMs = normalizePositiveInteger(options.monitorIntervalMs ?? existing.monitorIntervalMs)
    ?? DEFAULT_MONITOR_INTERVAL_MS;
  const simulatorProcessNames = normalizeStringArray(
    options.simulatorProcessNames ?? existing.simulatorProcessNames,
  );

  return {
    command: normalizeRegisteredCommand(existing.command),
    commandRegisteredAt: options.commandRegisteredAt ?? existing.commandRegisteredAt ?? null,
    commandPgid: normalizePositiveInteger(existing.commandPgid),
    commandPid: normalizePositiveInteger(existing.commandPid),
    evidenceRoot: options.evidenceRoot ?? existing.evidenceRoot ?? null,
    lastObservation: existing.lastObservation ?? null,
    memoryCeilingBytes,
    monitorIntervalMs,
    ownerPgid: normalizePositiveInteger(options.ownerPgid ?? existing.ownerPgid),
    ownerPid: normalizePositiveInteger(options.ownerPid ?? existing.ownerPid ?? lease.ownerPid),
    ownerRegisteredAt: options.ownerRegisteredAt ?? existing.ownerRegisteredAt ?? null,
    simulatorProcessNames,
    updatedAt: options.updatedAt ?? existing.updatedAt ?? null,
  };
}

export function mergeLeaseRuntimeMetadata(lease, update = {}) {
  const existing = buildLeaseRuntimeMetadata(lease);
  const command = update.command === undefined
    ? existing.command
    : normalizeRegisteredCommand(update.command);
  const simulatorProcessNames = update.simulatorProcessNames === undefined
    ? existing.simulatorProcessNames
    : normalizeStringArray(update.simulatorProcessNames);
  const nextCommandPid = normalizePositiveInteger(update.commandPid ?? existing.commandPid);
  const nextOwnerPid = normalizePositiveInteger(update.ownerPid ?? existing.ownerPid ?? lease.ownerPid);
  const commandPidReplaced = update.commandPid !== undefined && update.commandPid !== null;
  const ownerPidReplaced = update.ownerPid !== undefined && update.ownerPid !== null;
  const clearedCommand = commandPidReplaced && update.command === undefined;

  return {
    ...existing,
    command: clearedCommand ? null : (command ?? existing.command),
    commandRegisteredAt: update.commandRegisteredAt ?? existing.commandRegisteredAt,
    commandPgid: commandPidReplaced && update.commandPgid === undefined
      ? null
      : normalizePositiveInteger(update.commandPgid ?? existing.commandPgid),
    commandPid: nextCommandPid,
    evidenceRoot: update.evidenceRoot ?? existing.evidenceRoot,
    memoryCeilingBytes: normalizePositiveInteger(update.memoryCeilingBytes ?? existing.memoryCeilingBytes),
    monitorIntervalMs: normalizePositiveInteger(update.monitorIntervalMs ?? existing.monitorIntervalMs)
      ?? DEFAULT_MONITOR_INTERVAL_MS,
    ownerPgid: ownerPidReplaced && update.ownerPgid === undefined
      ? null
      : normalizePositiveInteger(update.ownerPgid ?? existing.ownerPgid),
    ownerPid: nextOwnerPid,
    ownerRegisteredAt: update.ownerRegisteredAt ?? existing.ownerRegisteredAt,
    simulatorProcessNames,
    updatedAt: update.updatedAt ?? existing.updatedAt,
  };
}

export function leaseHasContainmentProcessMetadata(lease) {
  const runtime = lease.runtime && typeof lease.runtime === "object" ? lease.runtime : {};
  return Boolean(
    normalizePositiveInteger(runtime.commandPid)
      || normalizePositiveInteger(runtime.commandPgid)
      || normalizePositiveInteger(runtime.memoryCeilingBytes)
      || normalizePositiveInteger(runtime.ownerPgid)
      || normalizeStringArray(runtime.simulatorProcessNames).length > 0,
  );
}

function looksLikeShellProcess(command) {
  const executable = path.basename(String(command ?? "").trim().split(/\s+/, 1)[0] ?? "").replace(/^-+/, "");
  return SHELL_PROCESS_NAMES.has(executable);
}

function parsePsOutput(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
      if (!match) {
        return null;
      }
      return {
        command: match[8] ?? "",
        elapsed: match[6],
        pgid: Number(match[3]),
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssBytes: Number(match[4]) * 1024,
        stat: match[7],
        vszBytes: Number(match[5]) * 1024,
      };
    })
    .filter(Boolean);
}

function processSamplerTimeoutError(cause) {
  const error = new Error("Process inventory sampling timed out.");
  error.cause = cause;
  error.code = "PROCESS_SAMPLER_TIMEOUT";
  error.reasonCode = "process-sampler-timeout";
  return error;
}

export function defaultProcessSampler({
  spawnSyncImpl = spawnSync,
  timeoutMs = PROCESS_SAMPLER_TIMEOUT_MS,
} = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "simbroker-ps-"));
  const outputPath = path.join(tempDir, "processes.txt");
  let outputFd = null;

  try {
    outputFd = fs.openSync(outputPath, "w");
    const result = spawnSyncImpl("ps", PROCESS_SAMPLER_ARGS, {
      stdio: ["ignore", outputFd, "ignore"],
      timeout: timeoutMs,
    });
    if (result.error) {
      if (result.error.code === "ETIMEDOUT") {
        throw processSamplerTimeoutError(result.error);
      }
      throw result.error;
    }
    if (result.signal === "SIGTERM" && result.status === null) {
      throw processSamplerTimeoutError(null);
    }
    if (result.status !== 0) {
      const error = new Error(`ps exited with status ${result.status}`);
      error.code = "PS_SAMPLER_FAILED";
      error.status = result.status;
      error.signal = result.signal;
      throw error;
    }
    fs.closeSync(outputFd);
    outputFd = null;
    const output = fs.readFileSync(outputPath, "utf8");
    return parsePsOutput(output);
  } finally {
    if (outputFd !== null) {
      fs.closeSync(outputFd);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function normalizeProcessRecord(record) {
  const pid = normalizePositiveInteger(record.pid);
  if (!pid) {
    return null;
  }
  const rssBytes = normalizeNonNegativeInteger(record.rssBytes)
    ?? (normalizeNonNegativeInteger(record.rssKb) === null ? null : Number(record.rssKb) * 1024)
    ?? 0;
  const vszBytes = normalizeNonNegativeInteger(record.vszBytes)
    ?? (normalizeNonNegativeInteger(record.vszKb) === null ? null : Number(record.vszKb) * 1024)
    ?? 0;
  return {
    command: String(record.command ?? ""),
    elapsed: record.elapsed ? String(record.elapsed) : null,
    pgid: normalizePositiveInteger(record.pgid),
    pid,
    ppid: normalizePositiveInteger(record.ppid),
    rssBytes,
    stat: record.stat ? String(record.stat) : null,
    vszBytes,
  };
}

function normalizeProcessTable(records) {
  return records
    .map(normalizeProcessRecord)
    .filter((record) => record && !PROCESS_SAMPLER_COMMAND_PATTERNS.some((pattern) => pattern.test(String(record.command ?? "").trim())))
    .filter(Boolean)
    .sort((left, right) => left.pid - right.pid);
}

function collectDescendantPids(processes, rootPids) {
  const childrenByParent = new Map();
  for (const processRecord of processes) {
    if (!processRecord.ppid) {
      continue;
    }
    const children = childrenByParent.get(processRecord.ppid) ?? [];
    children.push(processRecord.pid);
    childrenByParent.set(processRecord.ppid, children);
  }

  const discovered = new Set();
  const queue = [...rootPids];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const child of childrenByParent.get(parent) ?? []) {
      if (discovered.has(child)) {
        continue;
      }
      discovered.add(child);
      queue.push(child);
    }
  }
  return discovered;
}

function commandReferencesLeaseSimulator(processRecord, lease) {
  const command = processRecord.command ?? "";
  return Boolean(lease.simulatorId && command.includes(lease.simulatorId));
}

function ownerProcessGroupLeasePids(lease, runtime, processes, ownerPgid) {
  const groupProcesses = processes.filter((processRecord) => processRecord.pgid === ownerPgid);
  const ownedRootPids = groupProcesses
    .filter((processRecord) =>
      looksLikeShellProcess(processRecord.command) === false
        && (commandMatchesSimulatorLease(processRecord, lease, runtime)
          || commandReferencesLeaseSimulator(processRecord, lease)))
    .map((processRecord) => processRecord.pid);
  if (ownedRootPids.length === 0) {
    return new Set();
  }
  const descendantPids = collectDescendantPids(processes, ownedRootPids);
  return new Set([...ownedRootPids, ...descendantPids]);
}

function parseElapsedMilliseconds(elapsed) {
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

function normalizeCommandToken(token) {
  return String(token ?? "")
    .trim()
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/\\+$/g, "");
}

function splitShellWords(text) {
  const input = String(text ?? "");
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  const pushCurrent = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      pushCurrent();
      continue;
    }
    current += character;
  }

  if (escaping) {
    current += "\\";
  }
  pushCurrent();
  return tokens;
}

function commandTokens(command) {
  const rawTokens = Array.isArray(command)
    ? command.map((entry) => String(entry))
    : splitShellWords(command);
  return rawTokens
    .map(normalizeCommandToken)
    .filter(Boolean);
}

function commandExecutableNames(command) {
  const tokens = commandTokens(command);
  if (tokens.length === 0) {
    return [];
  }
  let cursor = 0;
  while (cursor < tokens.length && COMMAND_ASSIGNMENT_PATTERN.test(tokens[cursor])) {
    cursor += 1;
  }
  if (cursor >= tokens.length) {
    return [];
  }

  const names = [];
  const pushExecutable = (token) => {
    const executable = path.basename(token).replace(/^-+/, "");
    if (executable) {
      names.push(executable);
    }
  };

  pushExecutable(tokens[cursor]);
  const wrapper = path.basename(tokens[cursor]).replace(/^-+/, "");
  if (!COMMAND_WRAPPER_NAMES.has(wrapper)) {
    return [...new Set(names)];
  }

  cursor += 1;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token === "--" || COMMAND_ASSIGNMENT_PATTERN.test(token)) {
      cursor += 1;
      continue;
    }
    if (wrapper === "env" && token.startsWith("-")) {
      const splitArgument = token === "-S" || token === "--split-string"
        ? (tokens[cursor + 1] ?? "")
        : (token.startsWith("-S")
          ? token.slice(2)
          : (token.startsWith("--split-string=") ? token.slice("--split-string=".length) : null));
      if (splitArgument !== null) {
        for (const executable of commandExecutableNames(splitArgument)) {
          names.push(executable);
        }
        break;
      }
      cursor += ENV_WRAPPER_VALUE_OPTIONS.has(token) ? 2 : 1;
      continue;
    }
    if (wrapper === "exec" && token.startsWith("-")) {
      if (token === "-a") {
        pushExecutable(tokens[cursor + 1] ?? "");
        cursor += 2;
        continue;
      }
      if (token.startsWith("-a") && token.length > 2) {
        pushExecutable(token.slice(2));
        cursor += 1;
        continue;
      }
      const optionCharacters = token.slice(1);
      if (optionCharacters && /^[acl]+$/.test(optionCharacters)) {
        if (optionCharacters.includes("a")) {
          pushExecutable(tokens[cursor + 1] ?? "");
        }
        cursor += optionCharacters.includes("a") ? 2 : 1;
        continue;
      }
    }
    const nestedWrapper = path.basename(token).replace(/^-+/, "");
    if (COMMAND_WRAPPER_NAMES.has(nestedWrapper)) {
      for (const executable of commandExecutableNames(tokens.slice(cursor))) {
        names.push(executable);
      }
      break;
    }
    pushExecutable(token);
    break;
  }

  return [...new Set(names)];
}

function commandExecutableName(command) {
  return commandExecutableNames(command)[0] ?? null;
}

function processExecutableCandidates(command) {
  const text = String(command ?? "").trim();
  if (!text) {
    return [];
  }
  const candidates = new Set(commandExecutableNames(text));
  for (let index = 0; index < text.length; index += 1) {
    if (!/\s/.test(text[index])) {
      continue;
    }
    const prefix = text.slice(0, index).trimEnd();
    if (!prefix) {
      continue;
    }
    const executable = path.basename(prefix).replace(/^-+/, "");
    if (executable) {
      candidates.add(executable);
    }
  }
  return [...candidates];
}

function processLifetimeMatchesTimestamp(processRecord, startedAtValue, now) {
  const startedAt = Date.parse(startedAtValue ?? "");
  const observedAt = Date.parse(typeof now === "string" ? now : new Date(now ?? Date.now()).toISOString());
  const elapsedMilliseconds = parseElapsedMilliseconds(processRecord.elapsed);
  if (!Number.isFinite(startedAt) || !Number.isFinite(observedAt) || elapsedMilliseconds === null || observedAt < startedAt) {
    return false;
  }
  return elapsedMilliseconds + COMMAND_PID_IDENTITY_TOLERANCE_MS >= observedAt - startedAt;
}

function ownerPidMatchesLease(processRecord, lease, runtime, now) {
  if (processLooksDefunct(processRecord)) {
    return false;
  }
  const registeredOwnerPgid = normalizePositiveInteger(runtime.ownerPgid);
  if (registeredOwnerPgid && processRecord.pgid !== registeredOwnerPgid) {
    return false;
  }
  return processLifetimeMatchesTimestamp(processRecord, runtime.ownerRegisteredAt ?? lease.startedAt, now);
}

function commandPidMatchesRegisteredMetadata(processRecord, runtime, now) {
  if (processLooksDefunct(processRecord)) {
    return false;
  }
  if (!processLifetimeMatchesTimestamp(processRecord, runtime.commandRegisteredAt ?? runtime.updatedAt, now)) {
    return false;
  }
  const expectedExecutables = commandExecutableNames(runtime.command);
  if (expectedExecutables.length === 0) {
    return true;
  }
  const actualExecutables = processExecutableCandidates(processRecord.command);
  if (actualExecutables.length === 0 || !actualExecutables.some((name) => expectedExecutables.includes(name))) {
    return false;
  }
  return true;
}

function commandPidMatchesLease(processRecord, runtime, ownerPid, ownerProcessPresent, now) {
  if (processLooksDefunct(processRecord)) {
    return false;
  }
  const commandPgid = normalizePositiveInteger(runtime.commandPgid);
  if (commandPgid) {
    if (processRecord.pgid !== commandPgid) {
      return false;
    }
    if (ownerProcessPresent && ownerPid && processRecord.ppid === ownerPid) {
      return commandPidMatchesRegisteredMetadata(processRecord, runtime, now);
    }
    return commandPidMatchesRegisteredMetadata(processRecord, runtime, now);
  }
  if (ownerProcessPresent && ownerPid) {
    return processRecord.ppid === ownerPid
      && commandPidMatchesRegisteredMetadata(processRecord, runtime, now);
  }
  if (!commandExecutableName(runtime.command)) {
    return commandPidMatchesRegisteredMetadata(processRecord, runtime, now);
  }
  return commandPidMatchesRegisteredMetadata(processRecord, runtime, now);
}

function commandProcessGroupStillMatchesLease(processes, byPid, runtime, now) {
  const commandPgid = normalizePositiveInteger(runtime.commandPgid);
  if (!commandPgid) {
    return false;
  }
  const groupMembers = processes.filter((processRecord) => processRecord.pgid === commandPgid);
  if (groupMembers.length === 0) {
    return false;
  }
  const groupLeaderRecord = byPid.get(commandPgid);
  const groupLeader = groupLeaderRecord?.pgid === commandPgid ? groupLeaderRecord : null;
  if (!groupLeader) {
    return true;
  }
  if (processLooksDefunct(groupLeader)) {
    return groupMembers.some((processRecord) =>
      processRecord.pid !== groupLeader.pid && !processLooksDefunct(processRecord));
  }
  return processLifetimeMatchesTimestamp(groupLeader, runtime.commandRegisteredAt ?? runtime.updatedAt, now);
}

function simulatorProcessNamesForLease(lease, runtime) {
  const configured = normalizeStringArray(runtime.simulatorProcessNames);
  return [...new Set([
    ...defaultSimulatorProcessNames(lease),
    ...configured,
  ])];
}

function commandMatchesSimulatorLease(processRecord, lease, runtime) {
  const command = processRecord.command ?? "";
  if (!lease.simulatorId || !command.includes(lease.simulatorId)) {
    return false;
  }
  return simulatorProcessNamesForLease(lease, runtime)
    .some((name) => command.includes(name));
}

function addOwnedProcess(ownedByPid, processRecord, reason) {
  const existing = ownedByPid.get(processRecord.pid);
  if (existing) {
    existing.reasons.add(reason);
    return;
  }
  ownedByPid.set(processRecord.pid, {
    ...processRecord,
    reasons: new Set([reason]),
  });
}

export function discoverLeaseOwnedProcesses(lease, processRecords, options = {}) {
  const runtime = buildLeaseRuntimeMetadata(lease);
  const processes = normalizeProcessTable(processRecords);
  const byPid = new Map(processes.map((processRecord) => [processRecord.pid, processRecord]));
  const ownedByPid = new Map();
  const simulatorMatchedRootPids = [];
  const ownerPid = normalizePositiveInteger(runtime.ownerPid ?? lease.ownerPid);
  const commandPid = normalizePositiveInteger(runtime.commandPid);
  const registeredOwnerPgid = normalizePositiveInteger(runtime.ownerPgid);
  const commandPgid = normalizePositiveInteger(runtime.commandPgid);
  const ownerProcessRecord = ownerPid ? byPid.get(ownerPid) : null;
  const validatedOwnerPid = ownerPid && ownerProcessRecord
    && ownerPidMatchesLease(ownerProcessRecord, lease, runtime, options.now)
    ? ownerPid
    : null;
  const ownerProcessPresent = Boolean(validatedOwnerPid);
  const inferredOwnerPgid = validatedOwnerPid ? normalizePositiveInteger(ownerProcessRecord?.pgid) : null;
  const ownerPgid = registeredOwnerPgid ?? inferredOwnerPgid;
  const commandGroupStillMatchesLease = commandProcessGroupStillMatchesLease(processes, byPid, runtime, options.now);
  const validatedCommandPid = commandPid && byPid.has(commandPid)
    && commandPidMatchesLease(byPid.get(commandPid), runtime, validatedOwnerPid, ownerProcessPresent, options.now)
    ? commandPid
    : null;
  const rootPids = [...new Set([validatedOwnerPid, validatedCommandPid].filter(Boolean))];

  if (validatedOwnerPid) {
    const processRecord = byPid.get(validatedOwnerPid);
    if (processRecord) {
      addOwnedProcess(ownedByPid, processRecord, "owner-pid");
    }
  }
  if (validatedCommandPid) {
    const processRecord = byPid.get(validatedCommandPid);
    if (processRecord) {
      addOwnedProcess(ownedByPid, processRecord, "command-pid");
    }
  }

  for (const pid of collectDescendantPids(processes, rootPids)) {
    const processRecord = byPid.get(pid);
    if (processRecord) {
      addOwnedProcess(ownedByPid, processRecord, "descendant");
    }
  }

  if (ownerPgid) {
    const ownerGroupLeasePids = ownerProcessGroupLeasePids(lease, runtime, processes, ownerPgid);
    for (const processRecord of processes) {
      if (ownerGroupLeasePids.has(processRecord.pid) === false) {
        continue;
      }
      addOwnedProcess(
        ownedByPid,
        processRecord,
        processRecord.pgid === ownerPgid ? "owner-process-group" : "descendant",
      );
    }
  }

  const claimCommandProcessGroup = isSignalableProcessGroupId(commandPgid)
    && (validatedCommandPid
      ? Boolean(
        (ownerPgid && commandPgid !== ownerPgid)
          || (!ownerPgid && validatedCommandPid === commandPgid),
      )
      : Boolean(commandGroupStillMatchesLease && (!ownerPgid || commandPgid !== ownerPgid)));
  if (claimCommandProcessGroup) {
    for (const processRecord of processes) {
      if (processRecord.pgid === commandPgid) {
        addOwnedProcess(ownedByPid, processRecord, "command-process-group");
      }
    }
  }

  for (const processRecord of processes) {
    if (commandMatchesSimulatorLease(processRecord, lease, runtime)) {
      addOwnedProcess(ownedByPid, processRecord, "simulator-process");
      simulatorMatchedRootPids.push(processRecord.pid);
    }
  }

  for (const pid of collectDescendantPids(processes, simulatorMatchedRootPids)) {
    const processRecord = byPid.get(pid);
    if (processRecord) {
      addOwnedProcess(ownedByPid, processRecord, "descendant");
    }
  }

  const owned = [...ownedByPid.values()].map((processRecord) => ({
    ...processRecord,
    reasons: [...processRecord.reasons].sort(),
  }));
  const ownedPidSet = new Set(owned.map((processRecord) => processRecord.pid));
  const skipped = processes
    .filter((processRecord) => !ownedPidSet.has(processRecord.pid))
    .map((processRecord) => ({
      ...processRecord,
      skippedReason: "not-associated-with-lease",
    }));

  return {
    commandPgid,
    owned,
    ownerPgid,
    skipped,
  };
}

function totalRssBytes(processes) {
  return processes.reduce((total, processRecord) => total + (processRecord.rssBytes ?? 0), 0);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "0 B";
  }
  const gib = bytes / (1024 ** 3);
  if (gib >= 1) {
    return `${gib.toFixed(2)} GiB`;
  }
  const mib = bytes / (1024 ** 2);
  return `${mib.toFixed(2)} MiB`;
}

function formatProcessTable(processes) {
  const header = "PID PPID PGID RSS_BYTES VSZ_BYTES ELAPSED STAT COMMAND";
  const rows = processes.map((processRecord) => [
    processRecord.pid,
    processRecord.ppid ?? "",
    processRecord.pgid ?? "",
    processRecord.rssBytes ?? 0,
    processRecord.vszBytes ?? 0,
    processRecord.elapsed ?? "",
    processRecord.stat ?? "",
    processRecord.command ?? "",
  ].join(" "));
  return [header, ...rows].join("\n");
}

function processLooksDefunct(processRecord) {
  const stat = String(processRecord?.stat ?? "").trim().toUpperCase();
  if (stat.startsWith("Z")) {
    return true;
  }
  return String(processRecord?.command ?? "").includes("<defunct>");
}

function evidenceAdjacentPids(lease, runtime, requesterPid) {
  return new Set([
    normalizePositiveInteger(runtime.ownerPid ?? lease.ownerPid),
    normalizePositiveInteger(runtime.commandPid),
    normalizePositiveInteger(requesterPid),
  ].filter(Boolean));
}

function isLeaseAdjacentEvidenceProcess(processRecord, lease, runtime, requesterPid) {
  const adjacentPids = evidenceAdjacentPids(lease, runtime, requesterPid);
  if (adjacentPids.has(processRecord.pid)) {
    return true;
  }
  return Boolean(lease.simulatorId) && String(processRecord.command ?? "").includes(lease.simulatorId);
}

function evidenceProcessTable(discovery, lease, runtime, requesterPid) {
  const byPid = new Map();
  for (const processRecord of discovery.owned) {
    byPid.set(processRecord.pid, processRecord);
  }
  for (const processRecord of discovery.skipped) {
    if (isLeaseAdjacentEvidenceProcess(processRecord, lease, runtime, requesterPid)) {
      byPid.set(processRecord.pid, processRecord);
    }
  }
  return [...byPid.values()].sort((left, right) => left.pid - right.pid);
}

function formatOwnedTree(owned) {
  if (owned.length === 0) {
    return "No lease-owned processes were discovered.\n";
  }
  return owned
    .map((processRecord) =>
      `${processRecord.pid} ppid=${processRecord.ppid ?? ""} pgid=${processRecord.pgid ?? ""} rss=${formatBytes(processRecord.rssBytes)} reasons=${processRecord.reasons.join(",")} command=${processRecord.command}`)
    .join("\n");
}

function defaultDiagnosticSampler() {
  return {
    sample(pid) {
      return execFileSync("sample", [String(pid), "1"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
      });
    },
    vmmapSummary(pid) {
      return execFileSync("vmmap", ["-summary", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: DEFAULT_DIAGNOSTIC_TIMEOUT_MS,
      });
    },
  };
}

function maybeCaptureDiagnostics(evidenceDir, owned, diagnosticSampler) {
  if (!diagnosticSampler) {
    return [];
  }
  const captured = [];
  const targets = [...owned]
    .sort((left, right) => (right.rssBytes ?? 0) - (left.rssBytes ?? 0))
    .slice(0, 3);
  for (const processRecord of targets) {
    if (typeof diagnosticSampler.vmmapSummary === "function") {
      const fileName = `vmmap-summary-${processRecord.pid}.txt`;
      try {
        writeText(path.join(evidenceDir, fileName), diagnosticSampler.vmmapSummary(processRecord.pid));
        captured.push(fileName);
      } catch (error) {
        writeText(path.join(evidenceDir, fileName), `vmmap failed: ${error?.message ?? String(error)}`);
      }
    }
    if (typeof diagnosticSampler.sample === "function") {
      const fileName = `sample-${processRecord.pid}.txt`;
      try {
        writeText(path.join(evidenceDir, fileName), diagnosticSampler.sample(processRecord.pid));
        captured.push(fileName);
      } catch (error) {
        writeText(path.join(evidenceDir, fileName), `sample failed: ${error?.message ?? String(error)}`);
      }
    }
  }
  return captured;
}

function defaultProcessController() {
  return {
    killPid(pid, signal) {
      try {
        process.kill(pid, signal);
        return { ok: true };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { ok: true, alreadyExited: true };
        }
        return {
          ok: false,
          error: error?.message ?? String(error),
          errorCode: error?.code ?? null,
        };
      }
    },
    killProcessGroup(pgid, signal) {
      try {
        process.kill(-pgid, signal);
        return { ok: true };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { ok: true, alreadyExited: true };
        }
        return {
          ok: false,
          error: error?.message ?? String(error),
          errorCode: error?.code ?? null,
        };
      }
    },
  };
}

function killPid(processController, pid, signal) {
  if (typeof processController.killPid === "function") {
    return processController.killPid(pid, signal);
  }
  if (typeof processController.kill === "function") {
    return processController.kill(pid, signal);
  }
  return defaultProcessController().killPid(pid, signal);
}

function killProcessGroup(processController, pgid, signal) {
  if (typeof processController.killProcessGroup === "function") {
    return processController.killProcessGroup(pgid, signal);
  }
  return defaultProcessController().killProcessGroup(pgid, signal);
}

function actionErrorCode(result) {
  if (typeof result?.errorCode === "string" && result.errorCode) {
    return result.errorCode;
  }
  if (typeof result?.error?.code === "string" && result.error.code) {
    return result.error.code;
  }
  return null;
}

function isSignalableProcessGroupId(pgid) {
  return Number.isInteger(pgid) && pgid > 1;
}

function terminateOwnedProcesses({
  discovery,
  killOwner = false,
  lease,
  now,
  processController,
  processSampler,
  requesterPid,
  termWaitMs = DEFAULT_TERM_WAIT_MS,
}) {
  const actions = [];
  const ownedByPid = new Map(discovery.owned.map((processRecord) => [processRecord.pid, processRecord]));
  const ownerPid = discovery.owned.find((processRecord) => processRecord.reasons.includes("owner-pid"))?.pid ?? null;
  const skippedRequesterPid = normalizePositiveInteger(requesterPid);
  const requesterInCommandGroup = Boolean(
    skippedRequesterPid
      && discovery.commandPgid
      && [...discovery.owned, ...discovery.skipped].some((processRecord) =>
        processRecord.pid === skippedRequesterPid && processRecord.pgid === discovery.commandPgid),
  );
  const commandGroupOwned = discovery.commandPgid
    && isSignalableProcessGroupId(discovery.commandPgid)
    && discovery.ownerPgid
    && discovery.commandPgid !== discovery.ownerPgid
    && discovery.owned.some((processRecord) => processRecord.pgid === discovery.commandPgid)
    && !requesterInCommandGroup;

  if (commandGroupOwned) {
    const result = killProcessGroup(processController, discovery.commandPgid, "SIGTERM");
    actions.push({
      ok: result?.ok !== false,
      signal: "SIGTERM",
      target: "process-group",
      pgid: discovery.commandPgid,
      error: result?.error ?? null,
      errorCode: actionErrorCode(result),
    });
  }

  const sortedPids = [...ownedByPid.values()]
    .sort((left, right) => {
      const leftDepth = left.reasons.includes("descendant") || left.reasons.includes("simulator-process") ? 0 : 1;
      const rightDepth = right.reasons.includes("descendant") || right.reasons.includes("simulator-process") ? 0 : 1;
      return leftDepth - rightDepth || left.pid - right.pid;
    })
    .map((processRecord) => processRecord.pid);

  for (const pid of sortedPids) {
    if (pid === process.pid) {
      actions.push({
        ok: true,
        pid,
        skipped: true,
        signal: "SIGTERM",
        target: "pid",
        why: "current-broker-process",
      });
      continue;
    }
    if (pid === skippedRequesterPid) {
      actions.push({
        ok: true,
        pid,
        skipped: true,
        signal: "SIGTERM",
        target: "pid",
        why: "active-containment-requester",
      });
      continue;
    }
    if (pid === ownerPid && !killOwner) {
      actions.push({
        ok: true,
        pid,
        skipped: true,
        signal: "SIGTERM",
        target: "pid",
        why: "lease-owner-not-killed-by-default",
      });
      continue;
    }
    const result = killPid(processController, pid, "SIGTERM");
    actions.push({
      ok: result?.ok !== false,
      pid,
      signal: "SIGTERM",
      target: "pid",
      error: result?.error ?? null,
      errorCode: actionErrorCode(result),
    });
  }

  sleepSync(termWaitMs);

  let revalidatedOwnedPids = null;
  if (typeof processSampler === "function" && lease) {
    const currentRecords = normalizeProcessTable(processSampler());
    const currentDiscovery = discoverLeaseOwnedProcesses(lease, currentRecords, {
      now: advanceNowIso(now, termWaitMs),
    });
    revalidatedOwnedPids = new Set(currentDiscovery.owned.map((processRecord) => processRecord.pid));
  }

  for (const pid of sortedPids) {
    if (pid === process.pid || pid === skippedRequesterPid || (pid === ownerPid && !killOwner)) {
      continue;
    }
    if (revalidatedOwnedPids && revalidatedOwnedPids.has(pid) === false) {
      continue;
    }
    const result = killPid(processController, pid, "SIGKILL");
    actions.push({
      ok: result?.ok !== false,
      pid,
      signal: "SIGKILL",
      target: "pid",
      error: result?.error ?? null,
      errorCode: actionErrorCode(result),
    });
  }

  return actions;
}

function cleanupActionFailed(action) {
  return action.ok === false && action.errorCode !== "ESRCH";
}

function selectedTestsFromCommand(command) {
  const text = Array.isArray(command) ? command.join(" ") : String(command ?? "");
  const tests = new Set();
  const regex = /-only-testing(?::|[=\s]+)([^\s]+)/g;
  let match = regex.exec(text);
  while (match) {
    tests.add(match[1]);
    match = regex.exec(text);
  }
  return [...tests].sort();
}

function evidenceRootForLease(paths, lease, runtime) {
  if (runtime.evidenceRoot) {
    return runtime.evidenceRoot;
  }
  if (lease.sessionDir) {
    return path.join(lease.sessionDir, "simulator-broker-evidence");
  }
  return path.join(paths.evidenceDir ?? path.join(paths.stateRoot, "evidence"), lease.leaseId);
}

function shouldContain(reason, runtime, ownedRssBytes) {
  if (MEMORY_REASONS.has(reason)) {
    const ceiling = normalizePositiveInteger(runtime.memoryCeilingBytes);
    return Boolean(ceiling && ownedRssBytes > ceiling);
  }
  return FORCE_REASONS.has(reason);
}

function remainingCleanableOwnedPids(discovery, skippedPidSet) {
  return discovery.owned
    .filter((processRecord) => !skippedPidSet.has(processRecord.pid) && !processLooksDefunct(processRecord))
    .map((processRecord) => processRecord.pid)
    .filter((pid, index, values) => values.indexOf(pid) === index)
    .sort((left, right) => left - right);
}

function observeAfterCleanup(lease, {
  killedPids,
  now,
  postKillPollMs = DEFAULT_POST_KILL_POLL_MS,
  postKillWaitMs = DEFAULT_POST_KILL_WAIT_MS,
  processSampler,
  skippedPidSet,
}) {
  const sampler = processSampler ?? defaultProcessSampler;
  const killedPidSet = new Set(killedPids);
  const boundedWaitMs = Math.max(0, normalizeNonNegativeInteger(postKillWaitMs) ?? DEFAULT_POST_KILL_WAIT_MS);
  const boundedPollMs = Math.max(1, normalizeNonNegativeInteger(postKillPollMs) ?? DEFAULT_POST_KILL_POLL_MS);
  let waitedMs = 0;

  while (true) {
    const records = normalizeProcessTable(sampler());
    const discovery = discoverLeaseOwnedProcesses(lease, records, {
      now: advanceNowIso(now, waitedMs),
    });
    const remainingOwnedPids = remainingCleanableOwnedPids(discovery, skippedPidSet);
    const killedPidStillVisible = remainingOwnedPids.some((pid) => killedPidSet.has(pid));
    if (!killedPidStillVisible || waitedMs >= boundedWaitMs) {
      return {
        discovery,
        processRecords: records,
        remainingOwnedPids,
      };
    }

    const nextWaitMs = Math.min(boundedPollMs, boundedWaitMs - waitedMs);
    sleepSync(nextWaitMs);
    waitedMs += nextWaitMs;
  }
}

export function observeLeaseProcesses(lease, options = {}) {
  const processSampler = options.processSampler ?? defaultProcessSampler;
  const processRecords = normalizeProcessTable(processSampler());
  const discovery = discoverLeaseOwnedProcesses(lease, processRecords, {
    now: options.now ?? options.timestamp,
  });
  const excludedRssPid = normalizePositiveInteger(options.requesterPid);
  const ownerPid = normalizePositiveInteger(lease.runtime?.ownerPid ?? lease.ownerPid);
  const downstreamOwnedProcessCount = discovery.owned.filter((processRecord) =>
    processRecord.pid !== excludedRssPid && processRecord.pid !== ownerPid).length;
  const ownedRssBytes = totalRssBytes(discovery.owned.filter((processRecord) => processRecord.pid !== excludedRssPid));
  return {
    discovery,
    observation: {
      downstreamOwnedProcessCount,
      memoryCeilingBytes: normalizePositiveInteger(lease.runtime?.memoryCeilingBytes),
      ownedProcessCount: discovery.owned.length,
      ownedRssBytes,
      ownedRssHuman: formatBytes(ownedRssBytes),
      processCount: processRecords.length,
      simulatorProcessCount: discovery.owned.filter((processRecord) => processRecord.reasons.includes("simulator-process")).length,
    },
    processRecords,
  };
}

export function containLeaseProcesses(lease, options = {}) {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const reason = options.reason ?? "manual-cleanup";
  const runtime = buildLeaseRuntimeMetadata(lease);
  const observed = observeLeaseProcesses(lease, options);
  const ownedRssBytes = observed.observation.ownedRssBytes;
  const contained = shouldContain(reason, runtime, ownedRssBytes);

  if (!contained) {
    return {
      contained: false,
      evidenceDir: null,
      observation: {
        ...observed.observation,
        checkedAt: timestamp,
        reason,
      },
      reason,
    };
  }

  const evidenceDir = path.join(
    evidenceRootForLease(options.paths, lease, runtime),
    `${timestampSegment(timestamp)}-${safeSegment(reason)}-${safeSegment(lease.leaseId ?? `${process.pid}-${Date.now()}`)}`,
  );
  ensureDir(evidenceDir);

  writeJson(path.join(evidenceDir, "lease.json"), lease);
  writeText(
    path.join(evidenceDir, "processes-before.txt"),
    formatProcessTable(evidenceProcessTable(observed.discovery, lease, runtime, options.requesterPid)),
  );
  writeText(path.join(evidenceDir, "process-tree-before.txt"), formatOwnedTree(observed.discovery.owned));
  writeJson(path.join(evidenceDir, "broker-status-before.json"), options.brokerStatusBefore ?? {});

  const diagnosticSampler = options.captureDiagnostics
    ? (options.diagnosticSampler ?? defaultDiagnosticSampler())
    : options.diagnosticSampler ?? null;
  const diagnosticFiles = maybeCaptureDiagnostics(evidenceDir, observed.discovery.owned, diagnosticSampler);
  const processController = options.processController ?? defaultProcessController();
  const cleanupActions = terminateOwnedProcesses({
    discovery: observed.discovery,
    killOwner: options.killOwner === true,
    lease,
    now: options.now ?? timestamp,
    processController,
    processSampler: options.processSampler ?? defaultProcessSampler,
    requesterPid: options.requesterPid,
    termWaitMs: options.termWaitMs ?? DEFAULT_TERM_WAIT_MS,
  });

  const cleanupFailures = cleanupActions
    .filter(cleanupActionFailed)
    .map((action) => ({
      error: action.error ?? null,
      errorCode: action.errorCode ?? null,
      pgid: action.pgid ?? null,
      pid: action.pid ?? null,
      signal: action.signal,
      target: action.target,
    }));
  const skippedPidSet = new Set(
    cleanupActions
      .filter((action) => action.target === "pid" && action.skipped)
      .map((action) => action.pid),
  );
  const killedPids = cleanupActions
    .filter((action) => action.target === "pid" && !action.skipped && action.ok)
    .map((action) => action.pid)
    .filter((pid, index, values) => values.indexOf(pid) === index)
    .sort((left, right) => left - right);
  const afterCleanup = observeAfterCleanup(lease, {
    killedPids,
    now: advanceNowIso(options.now ?? timestamp, options.termWaitMs ?? DEFAULT_TERM_WAIT_MS),
    postKillPollMs: options.postKillPollMs,
    postKillWaitMs: options.postKillWaitMs,
    processSampler: options.processSampler ?? defaultProcessSampler,
    skippedPidSet,
  });
  const afterDiscovery = afterCleanup.discovery;
  const remainingOwnedPids = afterCleanup.remainingOwnedPids;
  writeText(
    path.join(evidenceDir, "processes-after.txt"),
    formatProcessTable(evidenceProcessTable(afterDiscovery, lease, runtime, options.requesterPid)),
  );
  writeJson(path.join(evidenceDir, "broker-status-after.json"), options.brokerStatusAfter ?? {});
  writeJson(path.join(evidenceDir, "cleanup-actions.json"), cleanupActions);
  const cleanupComplete = cleanupFailures.length === 0 && remainingOwnedPids.length === 0;
  const skippedPids = cleanupActions
    .filter((action) => action.target === "pid" && action.skipped)
    .map((action) => ({
      pid: action.pid,
      why: action.why,
    }));
  const skippedUnrelated = observed.discovery.skipped
    .filter((processRecord) => isLeaseAdjacentEvidenceProcess(processRecord, lease, runtime, options.requesterPid))
    .map((processRecord) => ({
      command: processRecord.command,
      pid: processRecord.pid,
      why: processRecord.skippedReason,
    }));

  const summary = {
    actorId: lease.actorId,
    actorType: lease.actorType,
    alias: lease.alias,
    command: runtime.command ?? null,
    commandPgid: runtime.commandPgid ?? null,
    commandPid: runtime.commandPid ?? null,
    diagnosticFiles,
    evidenceDir,
    jobId: lease.jobId ?? null,
    cleanupComplete,
    cleanupFailures,
    killedPids,
    leaseId: lease.leaseId,
    memoryCeilingBytes: runtime.memoryCeilingBytes,
    ownedProcessCountBefore: observed.discovery.owned.length,
    ownedProcessCountAfter: afterDiscovery.owned.length,
    ownedRssBytes,
    ownedRssHuman: formatBytes(ownedRssBytes),
    ownerPgid: runtime.ownerPgid ?? null,
    ownerPid: runtime.ownerPid ?? lease.ownerPid ?? null,
    projectId: lease.projectId,
    purposeId: lease.purposeId,
    reason,
    remainingOwnedPids,
    selectedTests: selectedTestsFromCommand(runtime.command),
    simulatorId: lease.simulatorId,
    skippedPids: [...skippedPids, ...skippedUnrelated],
    timestamp,
  };

  writeJson(path.join(evidenceDir, "summary.json"), summary);

  return {
    cleanupActions,
    cleanupComplete,
    cleanupFailures,
    contained: true,
    evidenceDir,
    observation: {
      ...observed.observation,
      checkedAt: timestamp,
      reason,
    },
    remainingOwnedPids,
    reason,
    summary,
  };
}
