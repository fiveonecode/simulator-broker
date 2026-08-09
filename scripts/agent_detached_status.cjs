const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const defaultPollIntervalMs = 5000;
const maxNodeTimerDelayMs = 2147483647;
const artifactWriteLockRetryMs = 10;
const artifactWriteLockTimeoutMs = 5000;
const detachedTerminationGraceMs = 5000;
const detachedWindowsProcessProbeTimeoutMs = 1000;
const detachedProtocolArtifactReadLimitBytes = 8 * 1024 * 1024;
const terminalStatuses = new Set(["failed", "failed-to-start", "passed", "process-exited-without-result", "timeout"]);

function parseArguments(argv) {
  const normalized = argv[0] === "detached-status" ? argv.slice(1) : argv;
  const flags = new Map();
  let index = 0;
  while (index < normalized.length) {
    const token = normalized[index];
    if (token === "--") {
      index += 1;
      continue;
    }
    if (!token.startsWith("--")) {
      index += 1;
      continue;
    }
    const key = token.slice(2);
    const existing = flags.get(key) || [];
    const nextToken = normalized[index + 1];
    if (nextToken === undefined || nextToken.startsWith("--")) {
      existing.push("true");
      flags.set(key, existing);
      index += 1;
      continue;
    }
    let valueIndex = index + 1;
    while (valueIndex < normalized.length && !normalized[valueIndex].startsWith("--")) {
      existing.push(normalized[valueIndex]);
      valueIndex += 1;
    }
    flags.set(key, existing);
    index = valueIndex;
  }
  return flags;
}

function getFlagValue(flags, key) {
  const values = flags.get(key);
  return values === undefined ? undefined : values.at(-1);
}

function parsePositiveIntegerFlag(flags, key) {
  const raw = getFlagValue(flags, key);
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "true") {
    throw new Error(`${key} requires a value.`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer.`);
  }
  return value;
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function stripUtf8Bom(source) {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
}

function readJson(filePath, description = "JSON file") {
  return JSON.parse(stripUtf8Bom(readRegularFileSnapshot(filePath, description).source.toString("utf8")));
}

function getFileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertRegularFile(stats, description, filePath) {
  if (!stats.isFile()) {
    throw new Error(`${description} ${filePath} is not a regular file.`);
  }
}

function assertProtocolArtifactReadWithinLimit(stats, description, filePath) {
  if (stats.size > detachedProtocolArtifactReadLimitBytes) {
    throw new Error(
      `${description} ${filePath} is too large to read (${stats.size} bytes; limit ${detachedProtocolArtifactReadLimitBytes} bytes).`,
    );
  }
}

function readRegularFileSnapshot(filePath, description) {
  const pathStats = lstatSync(filePath);
  if (pathStats.isSymbolicLink()) {
    throw new Error(`${description} ${filePath} must not be a symlink.`);
  }
  assertRegularFile(pathStats, description, filePath);
  assertProtocolArtifactReadWithinLimit(pathStats, description, filePath);
  let fd;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0));
    const stats = fstatSync(fd);
    assertRegularFile(stats, description, filePath);
    assertProtocolArtifactReadWithinLimit(stats, description, filePath);
    const source = readFileSync(fd);
    return {
      dev: stats.dev,
      ino: stats.ino,
      mtimeMs: stats.mtimeMs,
      sha256: createHash("sha256").update(source).digest("hex"),
      size: stats.size,
      source,
    };
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      throw new Error(`${description} ${filePath} must not be a symlink.`);
    }
    throw error;
  } finally {
    closeFd(fd);
  }
}

function closeFd(fd) {
  if (fd !== undefined) {
    closeSync(fd);
  }
}

function writeJson(filePath, payload) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporaryPath, JSON.stringify(payload, null, 2));
  renameSync(temporaryPath, filePath);
  return readJson(filePath);
}

function getProtocolPathSnapshot(description, filePath) {
  const resolvedPath = path.resolve(filePath);
  const missingSegments = [];
  let candidatePath = resolvedPath;
  while (true) {
    try {
      const stats = lstatSync(candidatePath);
      if (missingSegments.length === 0 && stats.isSymbolicLink()) {
        throw new Error(`${description} path ${resolvedPath} must not be a symlink.`);
      }
      const realPath = missingSegments.length === 0
        ? realpathSync(candidatePath)
        : path.join(realpathSync(candidatePath), ...missingSegments);
      return missingSegments.length === 0
        ? { dev: stats.dev, ino: stats.ino, realPath, resolvedPath }
        : { realPath, resolvedPath };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
      const parentPath = path.dirname(candidatePath);
      if (parentPath === candidatePath) {
        return { resolvedPath };
      }
      missingSegments.unshift(path.basename(candidatePath));
      candidatePath = parentPath;
    }
  }
}

function protocolPathSnapshotsAlias(left, right) {
  if (left.resolvedPath === right.resolvedPath) {
    return true;
  }
  if (left.realPath !== undefined && right.realPath !== undefined && left.realPath === right.realPath) {
    return true;
  }
  return left.dev !== undefined
    && left.ino !== undefined
    && right.dev !== undefined
    && right.ino !== undefined
    && left.dev === right.dev
    && left.ino === right.ino;
}

function assertProtocolPathDoesNotAlias(leftDescription, leftPath, rightDescription, rightPath) {
  if (leftPath === undefined || rightPath === undefined) {
    return;
  }
  const leftSnapshot = getProtocolPathSnapshot(leftDescription, leftPath);
  const rightSnapshot = getProtocolPathSnapshot(rightDescription, rightPath);
  if (protocolPathSnapshotsAlias(leftSnapshot, rightSnapshot)) {
    throw new Error(`${leftDescription} path ${leftSnapshot.resolvedPath} must not alias ${rightDescription} path.`);
  }
}

function assertSummaryFileDoesNotAliasDetachedProtocolPaths(summaryFile, protocolPaths) {
  if (summaryFile === undefined || summaryFile === "true") {
    return;
  }
  protocolPaths.forEach((protocolPath) => {
    assertProtocolPathDoesNotAlias("Summary file", path.resolve(summaryFile), protocolPath.description, protocolPath.filePath);
  });
}

function buildDetachedRunResultClaimPath(resultPath) {
  return `${path.resolve(resultPath)}.detached-result.lock`;
}

function buildDetachedRunFileIdentityClaimPath(description, filePath) {
  const resolvedPath = path.resolve(filePath);
  let stats;
  try {
    stats = lstatSync(resolvedPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${description} path ${resolvedPath} must not be a symlink.`);
  }
  if (!stats.isFile()) {
    return undefined;
  }
  return buildDetachedRunFileIdentityClaimPathForStats(stats);
}

function buildDetachedRunFileIdentityClaimPathForStats(stats) {
  const identity = createHash("sha256")
    .update(`${process.platform}:${stats.dev}:${stats.ino}`)
    .digest("hex");
  return path.join(tmpdir(), "agent-harness-detached-run-locks", getDetachedRunLockUserNamespace(), `${identity}.lock`);
}

function getDetachedRunLockUserNamespace() {
  const effectiveUserId = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  if (effectiveUserId !== undefined) {
    return `uid-${effectiveUserId}`;
  }
  const userId = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (userId !== undefined) {
    return `uid-${userId}`;
  }
  const username = process.env.USERNAME || process.env.USER || "unknown-user";
  return `user-${createHash("sha256").update(username).digest("hex").slice(0, 16)}`;
}

function fileStatsMatchIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function currentRegularFileMatchesIdentity(filePath, expectedStats) {
  try {
    const stats = lstatSync(filePath);
    return stats.isFile() && fileStatsMatchIdentity(stats, expectedStats);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function buildDetachedRunClaimProtocolPaths(description, claimPaths) {
  return claimPaths.flatMap((claimPath) => [
    { description, filePath: claimPath },
    { description: `${description} reclamation mutex`, filePath: `${claimPath}.reclaim.lock` },
    { description: `${description} reclamation takeover guard`, filePath: `${claimPath}.reclaim.lock.takeover.lock` },
  ]);
}

function buildDetachedRunResultClaimPaths(resultPath) {
  return [
    buildDetachedRunResultClaimPath(resultPath),
    buildDetachedRunFileIdentityClaimPath("Result artifact", resultPath),
  ].filter((lockPath) => lockPath !== undefined);
}

function buildDetachedRunLogClaimPath(logPath) {
  return `${path.resolve(logPath)}.detached-log.lock`;
}

function buildDetachedRunLogClaimPaths(description, logPath) {
  return [
    buildDetachedRunLogClaimPath(logPath),
    buildDetachedRunFileIdentityClaimPath(description, logPath),
  ].filter((lockPath) => lockPath !== undefined);
}

function buildDetachedRunPhaseClaimPath(phasePath) {
  return `${path.resolve(phasePath)}.detached-phase.lock`;
}

function buildDetachedRunPhaseClaimPaths(phasePath) {
  return [
    buildDetachedRunPhaseClaimPath(phasePath),
    buildDetachedRunFileIdentityClaimPath("Phase artifact", phasePath),
  ].filter((lockPath) => lockPath !== undefined);
}

function buildWindowsObservedProcessIdentityPath(artifactPath) {
  return `${path.resolve(artifactPath)}.windows-processes.json`;
}

function buildDetachedRunReservedProtocolPaths(artifactPath, resultPath, phasePath, logPaths) {
  const artifactWriteLockPath = `${path.resolve(artifactPath)}.lock`;
  const launchLockPath = `${path.resolve(artifactPath)}.launch.lock`;
  const resultClaimPaths = resultPath === undefined ? undefined : buildDetachedRunResultClaimPaths(resultPath);
  const phaseClaimPaths = phasePath === undefined ? undefined : buildDetachedRunPhaseClaimPaths(phasePath);
  const stderrLogClaimPaths = logPaths === undefined ? undefined : buildDetachedRunLogClaimPaths("stderr log", logPaths.stderr);
  const stdoutLogClaimPaths = logPaths === undefined ? undefined : buildDetachedRunLogClaimPaths("stdout log", logPaths.stdout);
  return [
    { description: "detached run artifact write lock", filePath: artifactWriteLockPath },
    { description: "detached run artifact write lock reclamation mutex", filePath: `${artifactWriteLockPath}.reclaim.lock` },
    { description: "detached run artifact write lock reclamation takeover guard", filePath: `${artifactWriteLockPath}.reclaim.lock.takeover.lock` },
    { description: "detached run launch lock", filePath: launchLockPath },
    { description: "detached run launch lock reclamation mutex", filePath: `${launchLockPath}.reclaim.lock` },
    { description: "detached run launch lock reclamation takeover guard", filePath: `${launchLockPath}.reclaim.lock.takeover.lock` },
    ...(resultClaimPaths === undefined ? [] : buildDetachedRunClaimProtocolPaths("result artifact ownership lock", resultClaimPaths)),
    ...(phaseClaimPaths === undefined ? [] : buildDetachedRunClaimProtocolPaths("phase artifact ownership lock", phaseClaimPaths)),
    ...(stderrLogClaimPaths === undefined ? [] : buildDetachedRunClaimProtocolPaths("stderr log ownership lock", stderrLogClaimPaths)),
    ...(stdoutLogClaimPaths === undefined ? [] : buildDetachedRunClaimProtocolPaths("stdout log ownership lock", stdoutLogClaimPaths)),
  ];
}

function buildDetachedRunProtocolPathsForArtifact(artifact) {
  return [
    { description: "detached run artifact", filePath: artifact.artifactPath },
    { description: "Windows process sidecar", filePath: buildWindowsObservedProcessIdentityPath(artifact.artifactPath) },
    { description: "result artifact", filePath: artifact.resultPath },
    { description: "phase artifact", filePath: artifact.phasePath },
    { description: "stdout log", filePath: artifact.stdoutPath },
    { description: "stderr log", filePath: artifact.stderrPath },
    ...buildDetachedRunReservedProtocolPaths(artifact.artifactPath, artifact.resultPath, artifact.phasePath, {
      stderr: artifact.stderrPath,
      stdout: artifact.stdoutPath,
    }),
  ];
}

function readLockMetadata(lockPath) {
  return readLockSnapshot(lockPath)?.metadata;
}

function readLockSnapshot(lockPath) {
  let fd;
  try {
    fd = openSync(lockPath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0));
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      return undefined;
    }
    const source = readFileSync(fd, "utf8");
    const metadata = JSON.parse(stripUtf8Bom(source));
    return metadata && typeof metadata === "object" && typeof metadata.pid === "number"
      ? { dev: stats.dev, ino: stats.ino, metadata, source }
      : undefined;
  } catch {
    return undefined;
  } finally {
    closeFd(fd);
  }
}

function lockSnapshotStillMatches(lockPath, snapshot) {
  const current = readLockSnapshot(lockPath);
  return current !== undefined
    && current.dev === snapshot.dev
    && current.ino === snapshot.ino
    && current.source === snapshot.source
    && (!snapshot.metadata.lockToken || current.metadata.lockToken === snapshot.metadata.lockToken);
}

function lockOwnerIsAlive(metadata, options = {}) {
  if (!isPidAlive(metadata.pid)) {
    return false;
  }
  if (metadata.processIdentity !== undefined) {
    return processIdentityMatches(metadata.processIdentity, options);
  }
  return true;
}

function removeLockSnapshot(lockPath, snapshot) {
  const reclaimedPath = `${lockPath}.reclaimed-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    renameSync(lockPath, reclaimedPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
  const reclaimedSnapshot = readLockSnapshot(reclaimedPath);
  const reclaimedMatches = reclaimedSnapshot !== undefined
    && reclaimedSnapshot.dev === snapshot.dev
    && reclaimedSnapshot.ino === snapshot.ino
    && reclaimedSnapshot.source === snapshot.source
    && (!snapshot.metadata.lockToken || reclaimedSnapshot.metadata.lockToken === snapshot.metadata.lockToken);
  if (reclaimedMatches) {
    rmSync(reclaimedPath, { force: true });
    return true;
  }
  try {
    if (!existsSync(lockPath)) {
      renameSync(reclaimedPath, lockPath);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "EEXIST") {
      throw error;
    }
  }
  return false;
}

function reclaimStaleArtifactWriteLock(lockPath, options = {}) {
  return withLockReclamationMutex(lockPath, () => reclaimStaleArtifactWriteLockWithMutex(lockPath, options), options);
}

function reclaimStaleArtifactWriteLockWithMutex(lockPath, options = {}) {
  if (!existsSync(lockPath)) {
    return false;
  }
  const snapshot = readLockSnapshot(lockPath);
  if (snapshot !== undefined && !lockOwnerIsAlive(snapshot.metadata, options.processIdentityProbeOptions) && lockSnapshotStillMatches(lockPath, snapshot)) {
    return removeLockSnapshot(lockPath, snapshot);
  }
  return false;
}

function reclaimStaleArtifactWriteLockReclamationMutex(mutexPath, options = {}) {
  const guardPath = `${mutexPath}.takeover.lock`;
  if (!claimArtifactWriteLockFile(guardPath, options)) {
    reclaimStaleArtifactWriteLockWithMutex(guardPath, options);
    if (!claimArtifactWriteLockFile(guardPath, options)) {
      return false;
    }
  }
  try {
    return reclaimStaleArtifactWriteLockWithMutex(mutexPath, options);
  } finally {
    removeOwnedArtifactWriteLock(guardPath);
  }
}

function createLockMetadata(options = {}) {
  const startedAt = new Date().toISOString();
  return {
    lockToken: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    pid: process.pid,
    processIdentity: getProcessIdentity(process.pid, options.processIdentityProbeOptions),
    startedAt,
  };
}

function claimArtifactWriteLockFile(lockPath, options = {}) {
  const temporaryPath = `${lockPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(temporaryPath, JSON.stringify(createLockMetadata(options)));
  try {
    linkSync(temporaryPath, lockPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function claimArtifactWriteLock(lockPath, options = {}) {
  return withLockReclamationMutex(lockPath, () => claimArtifactWriteLockFile(lockPath, options), options);
}

function withLockReclamationMutex(lockPath, callback, options = {}) {
  const mutexPath = `${lockPath}.reclaim.lock`;
  const deadline = Date.now() + artifactWriteLockTimeoutMs;
  let lockClaimed = false;
  while (!lockClaimed) {
    try {
      lockClaimed = claimArtifactWriteLockFile(mutexPath, options);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
    if (!lockClaimed) {
      if (reclaimStaleArtifactWriteLockReclamationMutex(mutexPath, options)) {
        continue;
      }
      if (Date.now() >= deadline) {
        const error = new Error(`EEXIST: file already exists, open '${mutexPath}'`);
        error.code = "EEXIST";
        throw error;
      }
      sleepSync(artifactWriteLockRetryMs);
    }
  }
  try {
    return callback();
  } finally {
    removeOwnedArtifactWriteLock(mutexPath);
  }
}

function removeOwnedArtifactWriteLock(lockPath) {
  const metadata = readLockMetadata(lockPath);
  if (metadata !== undefined && metadata.pid === process.pid) {
    rmSync(lockPath, { force: true });
  }
}

function withArtifactWriteLock(artifactPath, callback, options = {}) {
  const lockPath = `${artifactPath}.lock`;
  const deadline = Date.now() + artifactWriteLockTimeoutMs;
  let lockClaimed = false;
  while (!lockClaimed) {
    try {
      lockClaimed = claimArtifactWriteLock(lockPath, options);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
    if (!lockClaimed) {
      if (Date.now() >= deadline) {
        const error = new Error(`EEXIST: file already exists, open '${lockPath}'`);
        error.code = "EEXIST";
        throw error;
      }
      reclaimStaleArtifactWriteLock(lockPath, options);
      sleepSync(artifactWriteLockRetryMs);
    }
  }
  try {
    return callback();
  } finally {
    removeOwnedArtifactWriteLock(lockPath);
  }
}

function writeDetachedRunArtifact(artifactPath, nextArtifact, previousArtifact, options = {}) {
  return withArtifactWriteLock(artifactPath, () => {
    const latestArtifact = readJson(artifactPath, "Detached run artifact");
    if (latestArtifact.pid !== previousArtifact.pid || latestArtifact.startedAt !== previousArtifact.startedAt) {
      return latestArtifact;
    }
    if (isTerminalStatus(latestArtifact.status) && !isTerminalStatus(previousArtifact.status)) {
      return latestArtifact;
    }
    if (!isTerminalStatus(latestArtifact.status) && !isTerminalStatus(nextArtifact.status)) {
      const latestObservedAt = Date.parse(latestArtifact.lastObservedAt || latestArtifact.statusUpdatedAt || "");
      const nextObservedAt = Date.parse(nextArtifact.lastObservedAt || nextArtifact.statusUpdatedAt || "");
      if (Number.isFinite(latestObservedAt) && Number.isFinite(nextObservedAt) && nextObservedAt < latestObservedAt) {
        return latestArtifact;
      }
      if (
        latestArtifact.lastObservedAt !== undefined
        && nextArtifact.lastObservedAt !== undefined
        && Number.isFinite(latestObservedAt)
        && Number.isFinite(nextObservedAt)
        && nextObservedAt === latestObservedAt
      ) {
        return latestArtifact;
      }
    }
    return writeJson(artifactPath, nextArtifact);
  }, options.lockOptions);
}

function finalizeJsonOutput(summaryFilePath, payload) {
  const payloadSource = JSON.stringify(payload, null, 2);
  if (summaryFilePath !== undefined) {
    writeSummaryFileAtomically(path.resolve(summaryFilePath), payloadSource);
  }
  process.stdout.write(`${payloadSource}\n`);
}

function writeSummaryFileAtomically(summaryFilePath, payloadSource) {
  const summaryDirectoryPath = path.dirname(summaryFilePath);
  mkdirSync(summaryDirectoryPath, { recursive: true });
  const directorySnapshot = getSummaryDirectorySnapshot(summaryDirectoryPath);
  const summaryPathExisted = pathExists(summaryFilePath);
  const temporaryPath = path.join(
    summaryDirectoryPath,
    `.${path.basename(summaryFilePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let fd;
  try {
    fd = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o666,
    );
    writeFileSync(fd, payloadSource);
    closeSync(fd);
    fd = undefined;
    assertSummaryDirectoryUnchanged(summaryDirectoryPath, directorySnapshot);
    if (summaryPathExisted) {
      renameSync(temporaryPath, summaryFilePath);
    } else {
      try {
        linkSync(temporaryPath, summaryFilePath);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new Error(`Summary file ${summaryFilePath} appeared while publishing output; refusing to replace it.`);
        }
        throw error;
      }
    }
    assertSummaryDirectoryUnchanged(summaryDirectoryPath, directorySnapshot);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
    rmSync(temporaryPath, { force: true });
  }
}

function pathExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function getSummaryDirectorySnapshot(directoryPath) {
  const stats = lstatSync(directoryPath);
  if (!stats.isDirectory()) {
    throw new Error(`Summary directory ${directoryPath} is not a directory.`);
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
  };
}

function assertSummaryDirectoryUnchanged(directoryPath, snapshot) {
  const stats = lstatSync(directoryPath);
  if (
    !stats.isDirectory()
    || stats.dev !== snapshot.dev
    || stats.ino !== snapshot.ino
  ) {
    throw new Error(`Summary directory ${directoryPath} changed while publishing output.`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTerminalStatus(status) {
  return terminalStatuses.has(status);
}

function isPidAlive(pid) {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return !isPidZombie(pid);
  } catch (error) {
    return errorCode(error) === "EPERM" && !isPidZombie(pid);
  }
}

function isPidZombie(pid) {
  if (process.platform === "win32") {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(") ");
    if (commandEnd >= 0) {
      return stat.slice(commandEnd + 2).trim().split(/\s+/)[0] === "Z";
    }
  } catch {}
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const state = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return result.status === 0 && /\bZ/.test(state);
}

function getLinuxProcessStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(") ");
    if (commandEnd < 0) {
      return undefined;
    }
    const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTicks = fieldsAfterCommand[19];
    return startTicks === undefined || !/^\d+$/.test(startTicks) ? undefined : `linux-start-ticks:${startTicks}`;
  } catch {
    return undefined;
  }
}

function getDarwinProcessStartTime(pid) {
  if (process.platform !== "darwin") {
    return undefined;
  }
  const script = `
import ctypes
import sys
PROC_PIDTBSDINFO = 3
class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32), ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32), ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32), ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32), ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32), ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32), ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16), ("pbi_name", ctypes.c_char * 32),
        ("pbi_nfiles", ctypes.c_uint32), ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32), ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32), ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64), ("pbi_start_tvusec", ctypes.c_uint64),
    ]
pid = int(sys.argv[1])
info = ProcBsdInfo()
libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
size = ctypes.sizeof(info)
result = libproc.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ctypes.byref(info), size)
if result != size or info.pbi_pid != pid:
    sys.exit(1)
sys.stdout.write(f"{info.pbi_start_tvsec}:{info.pbi_start_tvusec}")
`;
  const result = spawnSync("python3", ["-c", script, String(pid)], { encoding: "utf8" });
  const startTime = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return result.status === 0 && /^\d+:\d+$/.test(startTime) ? `darwin-proc-bsdinfo:${startTime}` : undefined;
}

function getWindowsProcessProbeTimeoutMs(options) {
  if (options.windowsDeadlineAtMs === undefined) {
    return detachedWindowsProcessProbeTimeoutMs;
  }
  return Math.max(0, Math.min(detachedWindowsProcessProbeTimeoutMs, options.windowsDeadlineAtMs - Date.now()));
}

function getWindowsProcessRefreshProbeOptions() {
  return process.platform === "win32"
    ? { windowsDeadlineAtMs: Date.now() + detachedWindowsProcessProbeTimeoutMs }
    : {};
}

function getProcessIdentity(pid, options = {}) {
  if (pid <= 0) {
    return undefined;
  }
  if (process.platform === "win32") {
    const timeout = getWindowsProcessProbeTimeoutMs(options);
    if (timeout <= 0) {
      return undefined;
    }
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { $p.CreationDate }`,
    ], { encoding: "utf8", timeout });
    const startTime = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return result.status === 0 && startTime.length > 0 ? { pid, startTime } : undefined;
  }
  if (isPidZombie(pid)) {
    return undefined;
  }
  const linuxStartTicks = getLinuxProcessStartTicks(pid);
  if (linuxStartTicks !== undefined) {
    return { pid, startTime: linuxStartTicks };
  }
  const darwinStartTime = getDarwinProcessStartTime(pid);
  if (darwinStartTime !== undefined) {
    return { pid, startTime: darwinStartTime };
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const startTime = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return result.status === 0 && startTime.length > 0 ? { pid, startTime } : undefined;
}

function getProcessIdentityMatchState(identity, options = {}) {
  if (!isPidAlive(identity.pid) || typeof identity.startTime !== "string") {
    return isPidAlive(identity.pid) ? "mismatch" : "dead";
  }
  const currentIdentity = getProcessIdentity(identity.pid, options);
  if (currentIdentity === undefined) {
    return "unavailable";
  }
  return currentIdentity.startTime === identity.startTime ? "match" : "mismatch";
}

function processIdentityMatches(identity, options = {}) {
  const matchState = getProcessIdentityMatchState(identity, options);
  return matchState === "match" || matchState === "unavailable";
}

function processIdentityMatchesExactly(identity, options = {}) {
  return getProcessIdentityMatchState(identity, options) === "match";
}

function isProcessGroupPossiblyAlive(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0 || process.platform === "win32") {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function isUnverifiedStartupCleanupStillAlive(artifact) {
  if (
    artifact.startupCleanupUnverified !== true
    || artifact.processIdentity !== undefined
    || (Array.isArray(artifact.processGroupIdentities) && artifact.processGroupIdentities.length > 0)
  ) {
    return false;
  }
  const processGroupId = artifact.processGroupId || artifact.pid;
  return process.platform === "win32"
    ? isPidAlive(artifact.pid)
    : isProcessGroupPossiblyAlive(processGroupId) || isPidAlive(artifact.pid);
}

function sameProcessIdentity(left, right) {
  return left.pid === right.pid && typeof left.startTime === "string" && left.startTime === right.startTime;
}

function mergeProcessIdentities(identities) {
  const seen = new Set();
  return identities.filter((identity) => {
    if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0) {
      return false;
    }
    const key = `${identity.pid}:${identity.startTime || ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function readWindowsObservedProcessIdentities(artifact) {
  if (process.platform !== "win32") {
    return [];
  }
  try {
    const payload = readJson(`${path.resolve(artifact.artifactPath)}.windows-processes.json`);
    const identities = payload && typeof payload === "object" && Array.isArray(payload.processGroupIdentities)
      ? payload.processGroupIdentities
      : [];
    return identities.filter((identity) => {
      return identity && typeof identity === "object" && Number.isInteger(identity.pid) && identity.pid > 0 && typeof identity.startTime === "string";
    });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
    return [];
  }
}

function getOwnedProcessGroupIdentities(artifact) {
  return mergeProcessIdentities([
    ...(artifact.processIdentity === undefined ? [] : [artifact.processIdentity]),
    ...(Array.isArray(artifact.processGroupIdentities) ? artifact.processGroupIdentities : []),
    ...readWindowsObservedProcessIdentities(artifact),
  ]);
}

function artifactWriteClaimBelongsToArtifact(artifact, metadata) {
  const hasRunBinding = metadata.artifactPath !== undefined
    || metadata.startedAt !== undefined
    || metadata.processIdentity !== undefined
    || (Array.isArray(metadata.processGroupIdentities) && metadata.processGroupIdentities.length > 0);
  const artifactIdentities = getOwnedProcessGroupIdentities(artifact);
  if (hasRunBinding) {
    if (metadata.artifactPath !== undefined && path.resolve(metadata.artifactPath) !== path.resolve(artifact.artifactPath)) {
      return false;
    }
    if (metadata.startedAt !== undefined && metadata.startedAt !== artifact.startedAt) {
      return false;
    }
    if (metadata.processIdentity !== undefined) {
      return artifactIdentities.some((identity) => sameProcessIdentity(identity, metadata.processIdentity));
    }
    if (Array.isArray(metadata.processGroupIdentities) && metadata.processGroupIdentities.length > 0) {
      return metadata.processGroupIdentities.some((metadataIdentity) => {
        return artifactIdentities.some((artifactIdentity) => sameProcessIdentity(artifactIdentity, metadataIdentity));
      });
    }
    return true;
  }

  return metadata.pid === artifact.pid;
}

function writeLockMetadataAtomically(lockPath, metadata) {
  const temporaryPath = `${lockPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(temporaryPath, JSON.stringify(metadata));
  try {
    renameSync(temporaryPath, lockPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function claimArtifactWriteLockFileWithMetadata(lockPath, metadata) {
  const temporaryPath = `${lockPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(temporaryPath, JSON.stringify(metadata));
  try {
    linkSync(temporaryPath, lockPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function claimDetachedRunFileIdentityForArtifact(artifact, description, filePath, primaryClaimPath, expectedStats) {
  const identityClaimPath = buildDetachedRunFileIdentityClaimPathForStats(expectedStats);
  try {
    withLockReclamationMutex(primaryClaimPath, () => {
      const snapshot = readLockSnapshot(primaryClaimPath);
      if (snapshot === undefined || !artifactWriteClaimBelongsToArtifact(artifact, snapshot.metadata)) {
        throw new Error(`${description} ownership lock ${primaryClaimPath} no longer belongs to this detached run.`);
      }
      if (!currentRegularFileMatchesIdentity(filePath, expectedStats)) {
        throw new Error(`${description} ${path.resolve(filePath)} changed before its file-identity claim was acquired.`);
      }
      const lockPaths = Array.isArray(snapshot.metadata.additionalLockPaths) ? snapshot.metadata.additionalLockPaths : [primaryClaimPath];
      if (lockPaths.includes(identityClaimPath)) {
        if (!currentRegularFileMatchesIdentity(filePath, expectedStats)) {
          throw new Error(`${description} ${path.resolve(filePath)} changed before its file-identity claim was verified.`);
        }
        return;
      }
      const nextLockPaths = [...lockPaths, identityClaimPath];
      const nextMetadata = {
        ...snapshot.metadata,
        additionalLockPaths: nextLockPaths,
      };
      mkdirSync(path.dirname(identityClaimPath), { recursive: true });
      let identityClaimed = false;
      if (!claimArtifactWriteLockFileWithMetadata(identityClaimPath, nextMetadata)) {
        reclaimStaleArtifactWriteLock(identityClaimPath);
        identityClaimed = claimArtifactWriteLockFileWithMetadata(identityClaimPath, nextMetadata);
      } else {
        identityClaimed = true;
      }
      if (!identityClaimed) {
        throw new Error(`Detached run already active for ${description} ${path.resolve(filePath)}.`);
      }
      try {
        nextLockPaths.forEach((lockPath) => {
          writeLockMetadataAtomically(lockPath, nextMetadata);
        });
      } catch (error) {
        const identitySnapshot = readLockSnapshot(identityClaimPath);
        if (identitySnapshot?.metadata.lockToken === nextMetadata.lockToken) {
          rmSync(identityClaimPath, { force: true });
        }
        throw error;
      }
      if (!currentRegularFileMatchesIdentity(filePath, expectedStats)) {
        throw new Error(`${description} ${path.resolve(filePath)} changed after its file-identity claim was acquired.`);
      }
    });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Could not claim ${description} file identity for ${filePath}: ${message}`;
  }
}

function claimDetachedRunResultFileIdentityForArtifact(artifact, resultPath, expectedStats) {
  return claimDetachedRunFileIdentityForArtifact(
    artifact,
    "result artifact",
    resultPath,
    buildDetachedRunResultClaimPath(resultPath),
    expectedStats,
  );
}

function claimDetachedRunPhaseFileIdentityForArtifact(artifact, phasePath, expectedStats) {
  const primaryClaimPath = buildDetachedRunPhaseClaimPath(phasePath);
  if (readLockSnapshot(primaryClaimPath) === undefined) {
    return undefined;
  }
  return claimDetachedRunFileIdentityForArtifact(
    artifact,
    "phase artifact",
    phasePath,
    primaryClaimPath,
    expectedStats,
  );
}

function removeDetachedRunPathClaimsForArtifact(artifact, lockPaths) {
  lockPaths.forEach((lockPath) => {
    if (!existsSync(lockPath)) {
      return;
    }
    withLockReclamationMutex(lockPath, () => {
      const metadata = readLockMetadata(lockPath);
      if (metadata === undefined || !artifactWriteClaimBelongsToArtifact(artifact, metadata)) {
        return;
      }
      rmSync(lockPath, { force: true });
    });
  });
}

function removeDetachedRunResultClaimForArtifact(artifact) {
  if (artifact.resultPath === undefined) {
    return;
  }
  const lockPath = buildDetachedRunResultClaimPath(artifact.resultPath);
  const metadata = readLockMetadata(lockPath);
  const lockPaths = Array.isArray(metadata?.additionalLockPaths) ? metadata.additionalLockPaths : [lockPath];
  removeDetachedRunPathClaimsForArtifact(artifact, lockPaths);
}

function removeDetachedRunPhaseClaimForArtifact(artifact) {
  if (artifact.phasePath === undefined) {
    return;
  }
  const lockPath = buildDetachedRunPhaseClaimPath(artifact.phasePath);
  const metadata = readLockMetadata(lockPath);
  const lockPaths = Array.isArray(metadata?.additionalLockPaths) ? metadata.additionalLockPaths : [lockPath];
  removeDetachedRunPathClaimsForArtifact(artifact, lockPaths);
}

function removeDetachedRunLogClaimsForArtifact(artifact) {
  [
    { description: "stderr log", filePath: artifact.stderrPath },
    { description: "stdout log", filePath: artifact.stdoutPath },
  ].forEach((logPath) => {
    const lockPath = buildDetachedRunLogClaimPath(logPath.filePath);
    const metadata = readLockMetadata(lockPath);
    const lockPaths = Array.isArray(metadata?.additionalLockPaths) ? metadata.additionalLockPaths : [lockPath];
    removeDetachedRunPathClaimsForArtifact(artifact, lockPaths);
  });
}

function resultPathCanBeQuarantinedByArtifact(artifact, resultPath) {
  const lockPath = buildDetachedRunResultClaimPath(resultPath);
  const snapshot = readLockSnapshot(lockPath);
  if (snapshot === undefined) {
    return false;
  }
  return artifactWriteClaimBelongsToArtifact(artifact, snapshot.metadata) && lockSnapshotStillMatches(lockPath, snapshot);
}

function resultPathHasOwnedPrimaryClaim(artifact, resultPath) {
  const lockPath = buildDetachedRunResultClaimPath(resultPath);
  const snapshot = readLockSnapshot(lockPath);
  if (snapshot === undefined) {
    return false;
  }
  return artifactWriteClaimBelongsToArtifact(artifact, snapshot.metadata) && lockSnapshotStillMatches(lockPath, snapshot);
}

function getWindowsChildProcessIds(parentPids, options = {}) {
  const parents = parentPids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (parents.length === 0) {
    return [];
  }
  const timeout = getWindowsProcessProbeTimeoutMs(options);
  if (timeout <= 0) {
    return [];
  }
  const script = `
$parents = @(${parents.join(",")});
$seen = @{};
while ($parents.Count -gt 0) {
  $next = @();
  foreach ($parent in $parents) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId = $parent" | ForEach-Object {
      $pidKey = [string]$_.ProcessId;
      if (-not $seen.ContainsKey($pidKey)) {
        $seen[$pidKey] = $true;
        $next += [int]$_.ProcessId;
      }
    };
  }
  $parents = $next;
}
$seen.Keys
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (result.status !== 0 || stdout.trim().length === 0) {
    return [];
  }
  return stdout.split(/\s+/).map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry > 0);
}

function getProcessGroupMemberIdentitiesForKnownParents(processGroupId, knownProcessGroupIdentities, options = {}) {
  if (processGroupId <= 0) {
    return [];
  }
  if (process.platform === "win32") {
    return mergeProcessIdentities([
      ...knownProcessGroupIdentities.filter((identity) => processIdentityMatchesExactly(identity, options)),
      ...getWindowsChildProcessIds([processGroupId, ...knownProcessGroupIdentities.map((identity) => identity.pid)], options)
        .flatMap((pid) => {
          const identity = getProcessIdentity(pid, options);
          return identity === undefined ? [] : [identity];
        }),
    ]);
  }
  const result = spawnSync("pgrep", ["-g", String(processGroupId)], { encoding: "utf8" });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (result.status !== 0 || stdout.trim().length === 0) {
    return [];
  }
  return stdout.split(/\s+/).map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry) && entry > 0).flatMap((pid) => {
    const identity = getProcessIdentity(pid, options);
    return identity === undefined ? [] : [identity];
  });
}

function processGroupStillBelongsToRun(artifact, processGroupIdentities) {
  const ownedIdentities = getOwnedProcessGroupIdentities(artifact);
  return processGroupIdentities.some((identity) => {
    return ownedIdentities.some((ownedIdentity) => sameProcessIdentity(identity, ownedIdentity));
  });
}

function processGroupCanBeObservedAsRunOwned(artifact, processGroupId, processGroupIdentities, options = {}) {
  if (
    process.platform === "win32"
    || artifact.processIdentity === undefined
    || processGroupId !== artifact.pid
    || processGroupIdentities.length === 0
  ) {
    return false;
  }
  return artifact.pid === artifact.processIdentity.pid && processIdentityMatchesExactly(artifact.processIdentity, options);
}

function processGroupHasExactOwnedMember(artifact, processGroupId, options = getWindowsProcessRefreshProbeOptions()) {
  return processGroupId > 0 && processGroupStillBelongsToRun(
    artifact,
    getProcessGroupMemberIdentitiesForKnownParents(processGroupId, getOwnedProcessGroupIdentities(artifact), options),
  );
}

function refreshProcessGroupIdentitiesWhileLeaderAlive(artifact, options = getWindowsProcessRefreshProbeOptions()) {
  const processGroupId = artifact.processGroupId || artifact.pid;
  if (processGroupId <= 0) {
    return artifact;
  }
  const previousProcessGroupIdentities = mergeProcessIdentities([
    ...(Array.isArray(artifact.processGroupIdentities) ? artifact.processGroupIdentities : []),
    ...readWindowsObservedProcessIdentities(artifact),
  ]);
  const leaderIdentityMatchesExactly = artifact.processIdentity !== undefined
    && artifact.pid === artifact.processIdentity.pid
    && processIdentityMatchesExactly(artifact.processIdentity, options);
  const observedProcessGroupIdentities = getProcessGroupMemberIdentitiesForKnownParents(processGroupId, previousProcessGroupIdentities, options);
  if (
    leaderIdentityMatchesExactly === false
    && processGroupStillBelongsToRun(artifact, observedProcessGroupIdentities) === false
    && processGroupCanBeObservedAsRunOwned(artifact, processGroupId, observedProcessGroupIdentities, options) === false
  ) {
    return artifact;
  }
  const processGroupIdentities = mergeProcessIdentities([
    ...previousProcessGroupIdentities,
    ...observedProcessGroupIdentities,
  ]);
  if (
    processGroupIdentities.length === (artifact.processGroupIdentities || []).length
    && processGroupIdentities.every((identity) => {
      return (artifact.processGroupIdentities || []).some((previousIdentity) => sameProcessIdentity(identity, previousIdentity));
    })
  ) {
    return artifact;
  }
  return {
    ...artifact,
    processGroupIdentities,
  };
}

function isDetachedRunAlive(artifact, options = getWindowsProcessRefreshProbeOptions()) {
  if (processIdentityMatches(artifact.processIdentity || {}, options)) {
    return true;
  }
  if (isUnverifiedStartupCleanupStillAlive(artifact)) {
    return true;
  }
  const processGroupId = artifact.processGroupId || artifact.pid;
  return processGroupId > 0 && processGroupStillBelongsToRun(
    artifact,
    getProcessGroupMemberIdentitiesForKnownParents(processGroupId, mergeProcessIdentities([
      ...(artifact.processGroupIdentities || []),
      ...readWindowsObservedProcessIdentities(artifact),
    ]), options),
  );
}

function terminateWindowsProcessTree(pid, force = false) {
  const args = ["/PID", String(pid), "/T"];
  if (force) {
    args.push("/F");
  }
  return spawnSync("taskkill", args, { stdio: "ignore" }).status === 0;
}

function terminateDetachedProcess(artifact) {
  let terminationArtifact = refreshProcessGroupIdentitiesWhileLeaderAlive(artifact);
  const processIdentityProbeOptions = getWindowsProcessRefreshProbeOptions();
  if (!isDetachedRunAlive(terminationArtifact, processIdentityProbeOptions)) {
    return true;
  }
  if (process.platform === "win32") {
    const exactIdentities = getOwnedProcessGroupIdentities(terminationArtifact)
      .filter((identity) => processIdentityMatchesExactly(identity, processIdentityProbeOptions));
    exactIdentities.forEach((identity) => {
      terminateWindowsProcessTree(identity.pid);
    });
    sleepSync(detachedTerminationGraceMs);
    exactIdentities.forEach((identity) => {
      terminateWindowsProcessTree(identity.pid, true);
    });
    terminationArtifact = refreshProcessGroupIdentitiesWhileLeaderAlive(terminationArtifact, processIdentityProbeOptions);
    return !isDetachedRunAlive(terminationArtifact, processIdentityProbeOptions);
  }
  const processGroupId = terminationArtifact.processGroupId || terminationArtifact.pid;
  let signaledProcessGroup = false;
  if (processGroupHasExactOwnedMember(terminationArtifact, processGroupId)) {
    try {
      process.kill(-processGroupId, "SIGTERM");
      signaledProcessGroup = true;
    } catch {}
  }
  if (!signaledProcessGroup && terminationArtifact.pid > 0 && processIdentityMatchesExactly(terminationArtifact.processIdentity || {})) {
    try {
      process.kill(terminationArtifact.pid, "SIGTERM");
    } catch {}
  }
  const graceDeadline = Date.now() + detachedTerminationGraceMs;
  while (Date.now() < graceDeadline) {
    sleepSync(Math.min(100, Math.max(0, graceDeadline - Date.now())));
    terminationArtifact = refreshProcessGroupIdentitiesWhileLeaderAlive(terminationArtifact);
  }
  if (processGroupHasExactOwnedMember(terminationArtifact, processGroupId)) {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {}
  }
  if (terminationArtifact.pid > 0 && processIdentityMatchesExactly(terminationArtifact.processIdentity || {})) {
    try {
      process.kill(terminationArtifact.pid, "SIGKILL");
    } catch {}
  }
  terminationArtifact = refreshProcessGroupIdentitiesWhileLeaderAlive(terminationArtifact);
  return !isDetachedRunAlive(terminationArtifact);
}

function buildResultArtifactCandidatePaths(artifact) {
  const candidates = artifact.resultPath === undefined
    ? [buildDefaultResultArtifactPath(artifact.artifactPath)]
    : [artifact.resultPath];
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}
function buildDefaultResultArtifactPath(artifactPath) {
  return path.join(path.dirname(artifactPath), "detached", getDetachedRunArtifactProtocolName(artifactPath), "verify-result.json");
}
function getDetachedRunArtifactProtocolName(artifactPath) {
  const parsedPath = path.parse(path.resolve(artifactPath));
  const candidate = parsedPath.name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return candidate || "detached-run";
}

function pathIsWithinDirectory(filePath, directoryPath) {
  const relativePath = path.relative(path.resolve(directoryPath), path.resolve(filePath));
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function existingPathIsWithinDirectory(filePath, directoryPath) {
  try {
    return pathIsWithinDirectory(realpathSync(filePath), realpathSync(directoryPath));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function buildQuarantinableResultArtifactCandidatePaths(artifact) {
  const artifactDirectory = path.dirname(path.resolve(artifact.artifactPath));
  return buildResultArtifactCandidatePaths(artifact)
    .filter((candidate) => pathIsWithinDirectory(candidate, artifactDirectory) && existingPathIsWithinDirectory(candidate, artifactDirectory));
}

function resultArtifactHasTrustedPreDeadlineBoundary(artifact, stats, source) {
  const deadlineAtMs = Date.parse(artifact.deadlineAt || "");
  if (!Number.isFinite(deadlineAtMs)) {
    return true;
  }
  if (!Number.isFinite(stats.mtimeMs) || stats.mtimeMs >= deadlineAtMs) {
    return false;
  }
  if (stats.mtimeMs % 1000 === 0 && deadlineAtMs - stats.mtimeMs < 1000) {
    return false;
  }
  try {
    const payload = JSON.parse(stripUtf8Bom(source));
    const generatedAtMs = typeof payload?.generatedAt === "string" ? Date.parse(payload.generatedAt) : Number.NaN;
    if (Number.isFinite(generatedAtMs)) {
      return generatedAtMs < deadlineAtMs;
    }
  } catch {}
  return true;
}

function resultArtifactBelongsToRun(artifact, resultPath, stats, source, sha256) {
  const matchingBaseline = Array.isArray(artifact.resultArtifactBaselines)
    ? artifact.resultArtifactBaselines.find((baseline) => baseline.path === resultPath)
    : undefined;
  const baselineMtimeMs = matchingBaseline?.mtimeMs;
  const baselineSha256 = matchingBaseline?.sha256;
  const baselineSize = matchingBaseline?.size;
  const hasComparableBaseline = matchingBaseline?.existed !== false
    && baselineMtimeMs !== undefined
    && baselineSize !== undefined;
  const matchesBaselineMetadata = hasComparableBaseline
    && stats.mtimeMs === baselineMtimeMs
    && stats.size === baselineSize;
  const matchesBaselineComparableContent = matchingBaseline?.existed !== false
    && baselineSize !== undefined
    && stats.size === baselineSize;
  const baselineContentChanged = matchesBaselineComparableContent
    ? baselineSha256 !== undefined && (sha256 || getFileSha256(resultPath)) !== baselineSha256
    : hasComparableBaseline && stats.size !== baselineSize;
  if (matchesBaselineMetadata && !baselineContentChanged) {
    return false;
  }
  if (typeof sha256 === "string" && sha256.startsWith("non-regular:")) {
    return true;
  }
  if (!resultArtifactHasTrustedPreDeadlineBoundary(artifact, stats, source)) {
    return false;
  }
  const startedAtMs = Date.parse(artifact.startedAt);
  return baselineContentChanged || matchingBaseline?.existed === false || !Number.isFinite(startedAtMs) || stats.mtimeMs >= startedAtMs;
}

function discoverResultStatusSnapshot(artifact) {
  return buildResultArtifactCandidatePaths(artifact).flatMap((candidate) => {
    if (!existsSync(candidate)) {
      return [];
    }
    try {
      const snapshot = readResultStatusSnapshot(artifact, candidate);
      return snapshot === undefined ? [] : [snapshot];
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return [];
      }
      throw error;
    }
  })[0];
}

function parseResultStatus(resultPath, source) {
  try {
    const payload = JSON.parse(stripUtf8Bom(source));
    if (payload && typeof payload === "object" && payload.passed === true) {
      return { status: "passed" };
    }
    if (payload && typeof payload === "object" && payload.passed === false) {
      return { status: "failed" };
    }
    return {
      failureReason: `Result artifact ${resultPath} does not expose a boolean passed field.`,
      status: "unknown",
    };
  } catch (error) {
    return {
      failureReason: `Could not read result artifact ${resultPath}: ${error instanceof Error ? error.message : String(error)}`,
      status: "unknown",
    };
  }
}

function getResultArtifactReadLimitBytes(artifact) {
  const requestedLimit = Number(artifact.resultReadLimitBytes);
  return Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.max(detachedProtocolArtifactReadLimitBytes, Math.trunc(requestedLimit))
    : detachedProtocolArtifactReadLimitBytes;
}

function readResultArtifactSnapshot(resultPath, readLimitBytes = detachedProtocolArtifactReadLimitBytes) {
  let fd;
  try {
    const pathStats = lstatSync(resultPath);
    if (!pathStats.isFile()) {
      return {
        failureReason: `Result artifact ${resultPath} is not a regular file.`,
        resultPath,
        sha256: `non-regular:${pathStats.dev}:${pathStats.ino}:${pathStats.mode}:${pathStats.size}`,
        source: "",
        stats: pathStats,
      };
    }
    if (pathStats.size > readLimitBytes) {
      return {
        failureReason: `Result artifact ${resultPath} is too large to read (${pathStats.size} bytes; limit ${readLimitBytes} bytes).`,
        resultPath,
        sha256: `oversized:${pathStats.dev}:${pathStats.ino}:${pathStats.mtimeMs}:${pathStats.size}`,
        source: "",
        stats: pathStats,
      };
    }
    fd = openSync(resultPath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0));
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      return {
        failureReason: `Result artifact ${resultPath} is not a regular file.`,
        resultPath,
        sha256: `non-regular:${stats.dev}:${stats.ino}:${stats.mode}:${stats.size}`,
        source: "",
        stats,
      };
    }
    if (stats.size > readLimitBytes) {
      return {
        failureReason: `Result artifact ${resultPath} is too large to read (${stats.size} bytes; limit ${readLimitBytes} bytes).`,
        resultPath,
        sha256: `oversized:${stats.dev}:${stats.ino}:${stats.mtimeMs}:${stats.size}`,
        source: "",
        stats,
      };
    }
    const source = readFileSync(fd, "utf8");
    return {
      resultPath,
      sha256: createHash("sha256").update(source).digest("hex"),
      source,
      stats,
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  } finally {
    closeFd(fd);
  }
}

function readResultStatusSnapshot(artifact, resultPath) {
  const snapshot = readResultArtifactSnapshot(resultPath, getResultArtifactReadLimitBytes(artifact));
  if (snapshot === undefined || !resultArtifactBelongsToRun(artifact, resultPath, snapshot.stats, snapshot.source, snapshot.sha256)) {
    return undefined;
  }
  if (snapshot.failureReason !== undefined) {
    return {
      failureReason: snapshot.failureReason,
      resultPath,
      status: "unknown",
    };
  }
  if (!resultPathHasOwnedPrimaryClaim(artifact, resultPath)) {
    return undefined;
  }
  const claimFailureReason = claimDetachedRunResultFileIdentityForArtifact(artifact, resultPath, snapshot.stats);
  if (claimFailureReason !== undefined) {
    return {
      failureReason: claimFailureReason,
      resultPath,
      status: "unknown",
    };
  }

  return {
    ...parseResultStatus(resultPath, snapshot.source),
    resultPath,
  };
}

function quarantineLateResultArtifacts(artifact) {
  const deadlineAtMs = Date.parse(artifact.deadlineAt || "");
  if (!Number.isFinite(deadlineAtMs)) {
    return;
  }

  withArtifactWriteLock(artifact.artifactPath, () => {
    if (!existsSync(artifact.artifactPath)) {
      return;
    }
    const latestArtifact = readJson(artifact.artifactPath);
    if (latestArtifact.pid !== artifact.pid || latestArtifact.startedAt !== artifact.startedAt) {
      return;
    }
    buildQuarantinableResultArtifactCandidatePaths(artifact).forEach((candidate) => {
      if (!existsSync(candidate)) {
        return;
      }
      const snapshot = readResultArtifactSnapshot(candidate, getResultArtifactReadLimitBytes(artifact));
      if (snapshot === undefined) {
        return;
      }
      if (resultArtifactHasTrustedPreDeadlineBoundary(artifact, snapshot.stats, snapshot.source)) {
        return;
      }
      if (!resultPathCanBeQuarantinedByArtifact(artifact, candidate)) {
        return;
      }
      try {
        renameSync(candidate, `${candidate}.late-${process.pid}-${Date.now()}.quarantined`);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          throw error;
        }
      }
    });
  });
}

function readPhaseArtifactSnapshotForRun(artifact) {
  if (artifact.phasePath === undefined || !existsSync(artifact.phasePath)) {
    return undefined;
  }
  let snapshot;
  try {
    snapshot = readRegularFileSnapshot(artifact.phasePath, "Phase artifact");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const baseline = artifact.phaseArtifactBaseline;
  const matchesBaselineMetadata = baseline !== undefined
    && baseline.path === artifact.phasePath
    && baseline.mtimeMs !== undefined
    && baseline.size !== undefined
    && baseline.mtimeMs === snapshot.mtimeMs
    && baseline.size === snapshot.size;
  const matchesBaselineComparableContent = baseline !== undefined
    && baseline.path === artifact.phasePath
    && baseline.size !== undefined
    && baseline.size === snapshot.size;
  const baselineContentChanged = matchesBaselineComparableContent
    ? baseline.sha256 !== undefined && snapshot.sha256 !== baseline.sha256
    : baseline !== undefined
      && baseline.path === artifact.phasePath
      && baseline.size !== undefined
      && snapshot.size !== baseline.size;
  if (matchesBaselineMetadata && !baselineContentChanged) {
    return undefined;
  }
  const claimFailureReason = claimDetachedRunPhaseFileIdentityForArtifact(artifact, artifact.phasePath, snapshot);
  if (claimFailureReason !== undefined) {
    return undefined;
  }
  const startedAtMs = Date.parse(artifact.startedAt);
  return baseline?.existed === false || baselineContentChanged || !Number.isFinite(startedAtMs) || snapshot.mtimeMs >= startedAtMs
    ? snapshot
    : undefined;
}

function readPhase(artifact) {
  const snapshot = readPhaseArtifactSnapshotForRun(artifact);
  const source = snapshot?.source.toString("utf8").trim() || "";
  if (source.length === 0) {
    return undefined;
  }
  try {
    const payload = JSON.parse(source);
    return payload && typeof payload === "object" && typeof payload.phase === "string" && payload.phase.trim().length > 0
      ? payload.phase.trim()
      : undefined;
  } catch {
    return source;
  }
}

function makeEventForStatus(status) {
  if (status === "failed-to-start") {
    return "failed-to-start";
  }
  if (status === "process-exited-without-result") {
    return "process-exited-without-result";
  }
  if (status === "timeout") {
    return "timeout";
  }
  if (status === "passed" || status === "failed") {
    return status;
  }
  return undefined;
}

function makeStatusMessage(artifact, event) {
  if (event === "phase-change") {
    return `Detached run phase changed to ${artifact.phase || "unknown"}.`;
  }
  if (event === "passed") {
    return "Detached run passed.";
  }
  if (event === "failed") {
    return artifact.failureReason || "Detached run failed.";
  }
  if (event === "timeout") {
    return artifact.failureReason || "Detached run timed out.";
  }
  if (event === "process-exited-without-result") {
    return artifact.failureReason || "Detached run process exited without a result.";
  }
  if (event === "failed-to-start") {
    return artifact.failureReason || "Detached run failed to start.";
  }
  return undefined;
}

function inspectDetachedRun(artifactPath) {
  const resolvedArtifactPath = path.resolve(artifactPath);
  const processIdentityProbeOptions = getWindowsProcessRefreshProbeOptions();
  const lockOptions = { processIdentityProbeOptions };
  const artifact = refreshProcessGroupIdentitiesWhileLeaderAlive(readJson(resolvedArtifactPath, "Detached run artifact"), processIdentityProbeOptions);
  const observedAt = new Date().toISOString();
  const previousPhase = artifact.phase;
  const previousStatus = artifact.status;
  const artifactIsTerminal = isTerminalStatus(artifact.status);
  if (artifact.status === "timeout") {
    quarantineLateResultArtifacts(artifact);
  }
  let phaseFailureReason;
  let nextPhase = artifact.phase;
  if (!artifactIsTerminal) {
    try {
      nextPhase = readPhase(artifact);
    } catch (error) {
      phaseFailureReason = `Could not read phase artifact: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const resultStatusSnapshot = artifactIsTerminal ? undefined : discoverResultStatusSnapshot(artifact);
  let failureReason = artifact.failureReason;
  let nextResultPath = resultStatusSnapshot?.resultPath || artifact.resultPath;
  let nextResultObservedWhileRunningAt = artifact.resultObservedWhileRunningAt;
  let nextStatus = artifact.status;
  let processAlive;
  const isRunProcessAlive = () => {
    processAlive = processAlive ?? isDetachedRunAlive(artifact, processIdentityProbeOptions);
    return processAlive;
  };
  const deadlineAtMs = Date.parse(artifact.deadlineAt || "");
  const deadlineExceeded = !isTerminalStatus(artifact.status) && Number.isFinite(deadlineAtMs) && Date.parse(observedAt) >= deadlineAtMs;
  const markTimedOut = () => {
    failureReason = `Run timed out after ${artifact.timeoutMs ?? "unknown"}ms.`;
    if (terminateDetachedProcess(artifact)) {
      nextStatus = "timeout";
      quarantineLateResultArtifacts(artifact);
    } else {
      failureReason = `${failureReason} Cleanup could not be verified, so the run is still treated as active.`;
      nextStatus = "running";
    }
  };

  if (phaseFailureReason !== undefined && !artifactIsTerminal) {
    failureReason = phaseFailureReason;
    if (deadlineExceeded) {
      markTimedOut();
    } else {
      nextStatus = isRunProcessAlive() ? "running" : "failed";
    }
  } else if (resultStatusSnapshot !== undefined) {
    let resultStatus = resultStatusSnapshot;
    nextResultPath = resultStatus.resultPath;
    const runProcessAlive = !isTerminalStatus(artifact.status) && isRunProcessAlive();
    if (runProcessAlive && nextResultObservedWhileRunningAt === undefined) {
      nextResultObservedWhileRunningAt = observedAt;
    }
    const shouldApplyDeadlineFailure = deadlineExceeded
      && (runProcessAlive || nextResultObservedWhileRunningAt !== undefined);
    if (!isTerminalStatus(artifact.status) && shouldApplyDeadlineFailure) {
      markTimedOut();
    } else if (runProcessAlive) {
      nextStatus = "running";
    } else {
      if (resultStatus.status === "unknown" && !isTerminalStatus(artifact.status)) {
        const settledResultStatus = discoverResultStatusSnapshot(artifact);
        if (settledResultStatus !== undefined) {
          resultStatus = settledResultStatus;
          nextResultPath = settledResultStatus.resultPath;
        }
      }
      failureReason = resultStatus.failureReason;
      nextStatus = resultStatus.status === "unknown" ? "failed" : resultStatus.status;
    }
  } else if (!isTerminalStatus(artifact.status)) {
    if (deadlineExceeded) {
      markTimedOut();
    } else if (!isRunProcessAlive()) {
      failureReason = "Process is no longer alive and no result artifact was found.";
      nextStatus = "process-exited-without-result";
    } else {
      nextStatus = "running";
    }
  }

  const phaseChanged = nextPhase !== undefined && nextPhase !== previousPhase;
  const statusChanged = nextStatus !== previousStatus;
  const event = statusChanged ? makeEventForStatus(nextStatus) : phaseChanged ? "phase-change" : undefined;
  const nextArtifact = {
    ...artifact,
    failureReason,
    finishedAt: isTerminalStatus(nextStatus) ? artifact.finishedAt || observedAt : artifact.finishedAt,
    lastMaterialEvent: event === undefined
      ? artifact.lastMaterialEvent
      : {
          at: observedAt,
          phase: nextPhase || artifact.phase,
          status: nextStatus,
          type: event,
        },
    lastObservedAt: observedAt,
    phase: nextPhase || artifact.phase,
    phaseUpdatedAt: phaseChanged ? observedAt : artifact.phaseUpdatedAt,
    resultObservedWhileRunningAt: nextResultObservedWhileRunningAt,
    resultPath: nextResultPath,
    status: nextStatus,
    statusUpdatedAt: statusChanged ? observedAt : artifact.statusUpdatedAt,
  };
  const persistedArtifact = writeDetachedRunArtifact(resolvedArtifactPath, nextArtifact, artifact, { lockOptions });
  if (isTerminalStatus(persistedArtifact.status)) {
    removeDetachedRunResultClaimForArtifact(persistedArtifact);
    removeDetachedRunPhaseClaimForArtifact(persistedArtifact);
    removeDetachedRunLogClaimsForArtifact(persistedArtifact);
  }
  const persistedPhaseChanged = persistedArtifact.phase !== undefined && persistedArtifact.phase !== previousPhase;
  const persistedStatusChanged = persistedArtifact.status !== previousStatus;
  const persistedEvent = persistedStatusChanged
    ? makeEventForStatus(persistedArtifact.status)
    : persistedPhaseChanged
      ? "phase-change"
      : undefined;
  return {
    artifact: persistedArtifact,
    changed: persistedStatusChanged || persistedPhaseChanged,
    event: persistedEvent,
    message: persistedEvent === undefined ? undefined : makeStatusMessage(persistedArtifact, persistedEvent),
    shouldOutput: persistedEvent !== undefined || isTerminalStatus(persistedArtifact.status),
  };
}

async function waitForDetachedRunEvent(artifactPath, pollIntervalMs, waitTimeoutMs) {
  if (pollIntervalMs > maxNodeTimerDelayMs) {
    throw new Error(`Detached status poll interval must be at most ${maxNodeTimerDelayMs}ms.`);
  }
  const startedAt = Date.now();
  while (true) {
    const result = inspectDetachedRun(artifactPath);
    if (result.shouldOutput) {
      return result;
    }
    if (waitTimeoutMs !== undefined && Date.now() - startedAt >= waitTimeoutMs) {
      return undefined;
    }
    const remainingWaitMs = waitTimeoutMs === undefined ? undefined : waitTimeoutMs - (Date.now() - startedAt);
    if (remainingWaitMs !== undefined && remainingWaitMs <= 0) {
      return undefined;
    }
    await sleep(remainingWaitMs === undefined ? pollIntervalMs : Math.min(pollIntervalMs, remainingWaitMs));
  }
}

async function main() {
  const flags = parseArguments(process.argv.slice(2));
  const artifact = getFlagValue(flags, "artifact");
  if (artifact === undefined || artifact === "true") {
    throw new Error("detached-status requires --artifact <detached-run.json>.");
  }
  const summaryFile = getFlagValue(flags, "summary-file");
  const resolvedArtifactPath = path.resolve(artifact);
  if (summaryFile !== undefined && summaryFile !== "true") {
    assertSummaryFileDoesNotAliasDetachedProtocolPaths(summaryFile, [
      { description: "detached run artifact", filePath: resolvedArtifactPath },
      ...buildDetachedRunReservedProtocolPaths(resolvedArtifactPath),
      { description: "Windows process sidecar", filePath: buildWindowsObservedProcessIdentityPath(resolvedArtifactPath) },
    ]);
  }
  const statusResult = flags.has("wait")
    ? await waitForDetachedRunEvent(
        resolvedArtifactPath,
        parsePositiveIntegerFlag(flags, "poll-interval-ms") || defaultPollIntervalMs,
        parsePositiveIntegerFlag(flags, "wait-timeout-ms"),
      )
    : inspectDetachedRun(resolvedArtifactPath);
  if (statusResult === undefined || statusResult.shouldOutput === false) {
    return;
  }
  if (summaryFile !== undefined && summaryFile !== "true") {
    assertSummaryFileDoesNotAliasDetachedProtocolPaths(summaryFile, buildDetachedRunProtocolPathsForArtifact(statusResult.artifact));
  }
  finalizeJsonOutput(summaryFile === "true" ? undefined : summaryFile, statusResult);
  if (statusResult.artifact.status !== "passed" && statusResult.artifact.status !== "running") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
