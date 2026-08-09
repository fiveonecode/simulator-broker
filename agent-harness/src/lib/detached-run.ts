// -------------------------------------------------------------------------- //
//                                  IMPORTS                                   //
// -------------------------------------------------------------------------- //

import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, type Stats, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import dayjs from "dayjs";

import { RUN_COMMAND_PROCESS_GROUPS_ENV, shellQuoteForPlatform } from "./runtime.js";
import type {
  CommentaryPolicy,
  DetachedRunArtifact,
  DetachedRunMaterialEvent,
  DetachedRunStatus,
  DetachedRunStatusResult,
} from "./types.js";

// -------------------------------------------------------------------------- //
//                                   TYPES                                    //
// -------------------------------------------------------------------------- //

export type StartDetachedRunInput = {
  beforeSpawn?: () => void;
  artifactPath: string;
  command: string;
  commandArgs?: string[];
  commentaryPolicy?: CommentaryPolicy;
  cwd: string;
  logLimitBytes?: number;
  phasePath?: string;
  resultPath?: string;
  resultReadLimitBytes?: number;
  resumeCommand?: string;
  stderrPath?: string;
  stdoutPath?: string;
  statusCommand?: string;
  timeoutMs?: number;
};

export type InspectDetachedRunInput = {
  artifactPath: string;
  now?: string;
};

export type WaitForDetachedRunEventInput = {
  artifactPath: string;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
};

type DetachedSpawnCommand = {
  args: string[];
  command: string;
  detached: boolean;
  ownsLogFiles: boolean;
  shell: boolean;
};

type RegularFileSnapshot = {
  dev: number;
  ino: number;
  mtimeMs: number;
  sha256: string;
  size: number;
  source: Buffer;
};

// -------------------------------------------------------------------------- //
//                                  HELPERS                                   //
// -------------------------------------------------------------------------- //

const DEFAULT_POLL_INTERVAL_MS = 5000;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
export const DETACHED_RUN_ARTIFACT_ENV = "AGENT_HARNESS_DETACHED_RUN_ARTIFACT";
export const DETACHED_RUN_OWNER_TOKEN_ENV = "AGENT_HARNESS_DETACHED_RUN_OWNER_TOKEN";
const DARWIN_PROCESS_START_TIME_SCRIPT = String.raw`
import ctypes
import sys

PROC_PIDTBSDINFO = 3

class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16),
        ("pbi_name", ctypes.c_char * 32),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
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
const DETACHED_TIMEOUT_WATCHDOG_SCRIPT = `
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const artifactPath = process.argv[2];
const delayMs = Number(process.argv[3]);
const ownerPid = Number(process.argv[4]);
const ownerStartedAt = process.argv[5];
const artifactWriteLockRetryMs = 10;
const artifactWriteLockTimeoutMs = 5000;
const detachedProtocolArtifactReadLimitBytes = 8 * 1024 * 1024;
const detachedTerminationGraceMs = 5000;
const detachedWindowsProcessProbeTimeoutMs = 1000;
const watchdogPollIntervalMs = 1000;
const terminalStatuses = new Set(["failed", "failed-to-start", "passed", "process-exited-without-result", "timeout"]);
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}
function stripUtf8Bom(source) {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
}
function readJsonFile(filePath, description = "JSON file") {
  return JSON.parse(stripUtf8Bom(readRegularFileSnapshot(filePath, description).source.toString("utf8")));
}
function getFileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}
function buildDetachedRunResultClaimPath(resultPath) {
  return \`\${path.resolve(resultPath)}.detached-result.lock\`;
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
    throw new Error(\`\${description} path \${resolvedPath} must not be a symlink.\`);
  }
  if (!stats.isFile()) {
    return undefined;
  }
  return buildDetachedRunFileIdentityClaimPathForStats(stats);
}
function buildDetachedRunFileIdentityClaimPathForStats(stats) {
  const identity = createHash("sha256")
    .update(\`\${process.platform}:\${stats.dev}:\${stats.ino}\`)
    .digest("hex");
  return path.join(tmpdir(), "agent-harness-detached-run-locks", getDetachedRunLockUserNamespace(), \`\${identity}.lock\`);
}
function getDetachedRunLockUserNamespace() {
  const effectiveUserId = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  if (effectiveUserId !== undefined) {
    return \`uid-\${effectiveUserId}\`;
  }
  const userId = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (userId !== undefined) {
    return \`uid-\${userId}\`;
  }
  const username = process.env.USERNAME || process.env.USER || "unknown-user";
  return \`user-\${createHash("sha256").update(username).digest("hex").slice(0, 16)}\`;
}
function currentRegularFileMatchesIdentity(filePath, expectedStats) {
  try {
    const stats = lstatSync(filePath);
    return stats.isFile() && stats.dev === expectedStats.dev && stats.ino === expectedStats.ino;
  } catch (error) {
    if (!error || error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
function assertRegularFile(stats, description, filePath) {
  if (!stats.isFile()) {
    throw new Error(\`\${description} \${filePath} is not a regular file.\`);
  }
}
function assertProtocolArtifactReadWithinLimit(stats, description, filePath) {
  if (stats.size > detachedProtocolArtifactReadLimitBytes) {
    throw new Error(
      \`\${description} \${filePath} is too large to read (\${stats.size} bytes; limit \${detachedProtocolArtifactReadLimitBytes} bytes).\`,
    );
  }
}
function readRegularFileSnapshot(filePath, description) {
  const pathStats = lstatSync(filePath);
  if (pathStats.isSymbolicLink()) {
    throw new Error(\`\${description} \${filePath} must not be a symlink.\`);
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
      throw new Error(\`\${description} \${filePath} must not be a symlink.\`);
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
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
    if (fd !== undefined) {
      closeSync(fd);
    }
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
function lockOwnerIsAlive(metadata) {
  if (isPidAlive(metadata.pid) === false) {
    return false;
  }
  if (metadata.processIdentity) {
    return processSnapshotIdentityMatches(metadata.processIdentity);
  }
  return true;
}
function reclaimStaleArtifactWriteLock(lockPath) {
  return withLockReclamationMutex(lockPath, () => reclaimStaleArtifactWriteLockWithMutex(lockPath));
}
function removeLockSnapshot(lockPath, snapshot) {
  const reclaimedPath = \`\${lockPath}.reclaimed-\${process.pid}-\${Date.now()}-\${Math.random().toString(16).slice(2)}\`;
  try {
    renameSync(lockPath, reclaimedPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
  const reclaimedSnapshot = readLockSnapshot(reclaimedPath);
  const reclaimedMatches = reclaimedSnapshot
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
function reclaimStaleArtifactWriteLockWithMutex(lockPath) {
  if (!existsSync(lockPath)) {
    return false;
  }
  const snapshot = readLockSnapshot(lockPath);
  if (snapshot && lockOwnerIsAlive(snapshot.metadata) === false && lockSnapshotStillMatches(lockPath, snapshot)) {
    return removeLockSnapshot(lockPath, snapshot);
  }
  return false;
}
function reclaimStaleArtifactWriteLockReclamationMutex(mutexPath) {
  const guardPath = mutexPath + ".takeover.lock";
  if (!claimArtifactWriteLockFile(guardPath)) {
    reclaimStaleArtifactWriteLockWithMutex(guardPath);
    if (!claimArtifactWriteLockFile(guardPath)) {
      return false;
    }
  }
  try {
    return reclaimStaleArtifactWriteLockWithMutex(mutexPath);
  } finally {
    removeOwnedArtifactWriteLock(guardPath);
  }
}
function createLockMetadata() {
  const startedAt = new Date().toISOString();
  const startTime = getProcessStartTime(process.pid);
  return {
    lockToken: \`\${process.pid}-\${Date.now()}-\${Math.random().toString(16).slice(2)}\`,
    pid: process.pid,
    processIdentity: startTime === undefined ? undefined : { pid: process.pid, startTime },
    startedAt,
  };
}
function claimArtifactWriteLockFile(lockPath) {
  const temporaryPath = \`\${lockPath}.tmp-\${process.pid}-\${Date.now()}-\${Math.random().toString(16).slice(2)}\`;
  writeFileSync(temporaryPath, JSON.stringify(createLockMetadata()));
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
function writeLockMetadataAtomically(lockPath, metadata) {
  const temporaryPath = \`\${lockPath}.tmp-\${process.pid}-\${Date.now()}-\${Math.random().toString(16).slice(2)}\`;
  writeFileSync(temporaryPath, JSON.stringify(metadata));
  try {
    renameSync(temporaryPath, lockPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
function claimArtifactWriteLockFileWithMetadata(lockPath, metadata) {
  const temporaryPath = \`\${lockPath}.tmp-\${process.pid}-\${Date.now()}-\${Math.random().toString(16).slice(2)}\`;
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
function claimArtifactWriteLock(lockPath) {
  return withLockReclamationMutex(lockPath, () => claimArtifactWriteLockFile(lockPath));
}
function withLockReclamationMutex(lockPath, callback) {
  const mutexPath = \`\${lockPath}.reclaim.lock\`;
  const deadline = Date.now() + artifactWriteLockTimeoutMs;
  let lockClaimed = false;
  while (!lockClaimed) {
    try {
      lockClaimed = claimArtifactWriteLockFile(mutexPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
    if (!lockClaimed) {
      if (reclaimStaleArtifactWriteLockReclamationMutex(mutexPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        const error = new Error(\`EEXIST: file already exists, open '\${mutexPath}'\`);
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
  if (metadata && metadata.pid === process.pid) {
    rmSync(lockPath, { force: true });
  }
}
function withArtifactWriteLock(callback) {
  const lockPath = \`\${artifactPath}.lock\`;
  const deadline = Date.now() + artifactWriteLockTimeoutMs;
  let lockClaimed = false;
  while (!lockClaimed) {
    try {
      lockClaimed = claimArtifactWriteLock(lockPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
    if (!lockClaimed) {
      if (Date.now() >= deadline) {
        const error = new Error(\`EEXIST: file already exists, open '\${lockPath}'\`);
        error.code = "EEXIST";
        throw error;
      }
      reclaimStaleArtifactWriteLock(lockPath);
      sleepSync(artifactWriteLockRetryMs);
    }
  }
  try {
    return callback();
  } finally {
    removeOwnedArtifactWriteLock(lockPath);
  }
}
function isPidAlive(pid) {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return !isPidZombie(pid);
  } catch (error) {
    return Boolean(error && error.code === "EPERM") && !isPidZombie(pid);
  }
}
function isPidZombie(pid) {
  if (process.platform === "win32") {
    return false;
  }
  try {
    const stat = readFileSync(\`/proc/\${pid}/stat\`, "utf8");
    const commandEnd = stat.lastIndexOf(") ");
    if (commandEnd >= 0) {
      return stat.slice(commandEnd + 2).trim().split(/\\s+/)[0] === "Z";
    }
  } catch {}
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const state = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return result.status === 0 && /\\bZ/.test(state);
}
function getLinuxProcessStartTicks(pid) {
  try {
    const stat = readFileSync(\`/proc/\${pid}/stat\`, "utf8");
    const commandEnd = stat.lastIndexOf(") ");
    if (commandEnd < 0) {
      return undefined;
    }
    const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\\s+/);
    const startTicks = fieldsAfterCommand[19];
    return startTicks === undefined || /^\\d+$/.test(startTicks) === false ? undefined : \`linux-start-ticks:\${startTicks}\`;
  } catch {
    return undefined;
  }
}
function getDarwinProcessStartTime(pid) {
  if (process.platform !== "darwin") {
    return undefined;
  }
  const result = spawnSync("python3", ["-c", ${JSON.stringify(DARWIN_PROCESS_START_TIME_SCRIPT)}, String(pid)], { encoding: "utf8" });
  const startTime = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return result.status === 0 && /^\\d+:\\d+$/.test(startTime) ? \`darwin-proc-bsdinfo:\${startTime}\` : undefined;
}
function getProcessStartTime(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      \`$p = Get-CimInstance Win32_Process -Filter "ProcessId = \${pid}"; if ($null -ne $p) { $p.CreationDate }\`,
    ], { encoding: "utf8", timeout: detachedWindowsProcessProbeTimeoutMs });
    const creationDate = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return result.status === 0 && creationDate.length > 0 ? creationDate : undefined;
  }
  if (isPidZombie(pid)) {
    return undefined;
  }
  const linuxStartTicks = getLinuxProcessStartTicks(pid);
  if (linuxStartTicks !== undefined) {
    return linuxStartTicks;
  }
  const darwinStartTime = getDarwinProcessStartTime(pid);
  if (darwinStartTime !== undefined) {
    return darwinStartTime;
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const startTime = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return result.status === 0 && startTime.length > 0 ? startTime : undefined;
}
function processIdentityMatches(artifact) {
  if (isPidAlive(artifact.pid) === false) {
    return false;
  }
  if (!artifact.processIdentity || typeof artifact.processIdentity.startTime !== "string") {
    return false;
  }
  const currentStartTime = getProcessStartTime(artifact.pid);
  return currentStartTime === undefined || currentStartTime === artifact.processIdentity.startTime;
}
function getProcessSnapshotIdentityMatchState(identity) {
  if (isPidAlive(identity.pid) === false) {
    return "dead";
  }
  if (typeof identity.startTime !== "string") {
    return "mismatch";
  }
  const currentStartTime = getProcessStartTime(identity.pid);
  if (currentStartTime === undefined) {
    return "unavailable";
  }
  return currentStartTime === identity.startTime ? "match" : "mismatch";
}
function processSnapshotIdentityMatches(identity) {
  const matchState = getProcessSnapshotIdentityMatchState(identity);
  return matchState === "match" || matchState === "unavailable";
}
function processSnapshotIdentityMatchesExactly(identity) {
  return getProcessSnapshotIdentityMatchState(identity) === "match";
}
function sameProcessSnapshotIdentity(left, right) {
  return left.pid === right.pid && typeof left.startTime === "string" && left.startTime === right.startTime;
}
function artifactIdentityMatchesOwnedRun(artifact) {
  return artifact.pid === ownerPid && artifact.startedAt === ownerStartedAt;
}
function mergeProcessIdentities(identities) {
  const seen = new Set();
  return identities.filter((identity) => {
    const key = \`\${identity.pid}:\${identity.startTime || ""}\`;
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
    const payload = readJsonFile(\`\${path.resolve(artifact.artifactPath)}.windows-processes.json\`);
    const identities = payload && typeof payload === "object" && Array.isArray(payload.processGroupIdentities)
      ? payload.processGroupIdentities
      : [];
    return identities.filter((identity) => {
      return identity && typeof identity === "object" && Number.isInteger(identity.pid) && identity.pid > 0 && typeof identity.startTime === "string";
    });
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
    return [];
  }
}
function ownedProcessGroupIdentities(artifact) {
  return mergeProcessIdentities([
    ...(artifact.processIdentity ? [artifact.processIdentity] : []),
    ...(Array.isArray(artifact.processGroupIdentities) ? artifact.processGroupIdentities : []),
    ...readWindowsObservedProcessIdentities(artifact),
  ]);
}
function artifactWriteClaimBelongsToArtifact(artifact, metadata) {
  const hasRunBinding = metadata.artifactPath !== undefined
    || metadata.startedAt !== undefined
    || metadata.processIdentity !== undefined
    || (Array.isArray(metadata.processGroupIdentities) && metadata.processGroupIdentities.length > 0);
  const artifactIdentities = ownedProcessGroupIdentities(artifact);
  if (hasRunBinding) {
    if (metadata.artifactPath !== undefined && path.resolve(metadata.artifactPath) !== path.resolve(artifact.artifactPath)) {
      return false;
    }
    if (metadata.startedAt !== undefined && metadata.startedAt !== artifact.startedAt) {
      return false;
    }
    if (metadata.processIdentity !== undefined) {
      return artifactIdentities.some((identity) => sameProcessSnapshotIdentity(identity, metadata.processIdentity));
    }
    if (Array.isArray(metadata.processGroupIdentities) && metadata.processGroupIdentities.length > 0) {
      return metadata.processGroupIdentities.some((metadataIdentity) => {
        return artifactIdentities.some((artifactIdentity) => sameProcessSnapshotIdentity(artifactIdentity, metadataIdentity));
      });
    }
    return true;
  }
  return metadata.pid === artifact.pid;
}
function claimDetachedRunFileIdentityForArtifact(artifact, description, filePath, primaryClaimPath, expectedStats) {
  const identityClaimPath = buildDetachedRunFileIdentityClaimPathForStats(expectedStats);
  try {
    withLockReclamationMutex(primaryClaimPath, () => {
      const snapshot = readLockSnapshot(primaryClaimPath);
      if (snapshot === undefined || !artifactWriteClaimBelongsToArtifact(artifact, snapshot.metadata)) {
        throw new Error(\`\${description} ownership lock \${primaryClaimPath} no longer belongs to this detached run.\`);
      }
      if (!currentRegularFileMatchesIdentity(filePath, expectedStats)) {
        throw new Error(\`\${description} \${path.resolve(filePath)} changed before its file-identity claim was acquired.\`);
      }
      const lockPaths = Array.isArray(snapshot.metadata.additionalLockPaths) ? snapshot.metadata.additionalLockPaths : [primaryClaimPath];
      if (lockPaths.includes(identityClaimPath)) {
        if (!currentRegularFileMatchesIdentity(filePath, expectedStats)) {
          throw new Error(\`\${description} \${path.resolve(filePath)} changed before its file-identity claim was verified.\`);
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
        throw new Error(\`Detached run already active for \${description} \${path.resolve(filePath)}.\`);
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
        throw new Error(\`\${description} \${path.resolve(filePath)} changed after its file-identity claim was acquired.\`);
      }
    });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return \`Could not claim \${description} file identity for \${filePath}: \${message}\`;
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
function getWindowsChildProcessIds(parentPids) {
  const parents = parentPids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (parents.length === 0) {
    return [];
  }
  const script = [
    "$parents = @(" + parents.join(",") + ");",
    "$seen = @{};",
    "while ($parents.Count -gt 0) {",
    "  $next = @();",
    "  foreach ($parent in $parents) {",
    "    Get-CimInstance Win32_Process -Filter \\"ParentProcessId = $parent\\" | ForEach-Object {",
    "      $pidKey = [string]$_.ProcessId;",
    "      if (-not $seen.ContainsKey($pidKey)) {",
    "        $seen[$pidKey] = $true;",
    "        $next += [int]$_.ProcessId;",
    "      }",
    "    };",
    "  }",
    "  $parents = $next;",
    "}",
    "$seen.Keys",
  ].join("\\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: detachedWindowsProcessProbeTimeoutMs });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (result.status !== 0 || stdout.trim().length === 0) {
    return [];
  }
  return stdout
    .split(/\\s+/)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
}
function getProcessGroupMemberIdentities(processGroupId, knownProcessGroupIdentities = []) {
  if (processGroupId <= 0) {
    return [];
  }
  if (process.platform === "win32") {
    return mergeProcessIdentities([
      ...knownProcessGroupIdentities.filter((identity) => processSnapshotIdentityMatchesExactly(identity)),
      ...getWindowsChildProcessIds([
      processGroupId,
      ...knownProcessGroupIdentities.map((identity) => identity.pid),
      ]).flatMap((pid) => {
        const startTime = getProcessStartTime(pid);
        return startTime === undefined ? [] : [{ pid, startTime }];
      }),
    ]);
  }
  const result = spawnSync("pgrep", ["-g", String(processGroupId)], { encoding: "utf8" });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (result.status !== 0 || stdout.trim().length === 0) {
    return [];
  }
  return stdout
    .split(/\\s+/)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0)
    .flatMap((pid) => {
      const startTime = getProcessStartTime(pid);
      return startTime === undefined ? [] : [{ pid, startTime }];
    });
}
function refreshProcessGroupIdentitiesWhileLeaderAlive(artifact) {
  const processGroupId = artifact.processGroupId || artifact.pid;
  if (processGroupId <= 0) {
    return artifact;
  }
  const artifactProcessGroupIdentities = Array.isArray(artifact.processGroupIdentities) ? artifact.processGroupIdentities : [];
  const previousProcessGroupIdentities = mergeProcessIdentities([
    ...artifactProcessGroupIdentities,
    ...readWindowsObservedProcessIdentities(artifact),
  ]);
  const leaderIdentityMatchesExactly = artifact.processIdentity !== undefined
    && artifact.pid === artifact.processIdentity.pid
    && processSnapshotIdentityMatchesExactly(artifact.processIdentity);
  const observedProcessGroupIdentities = getProcessGroupMemberIdentities(processGroupId, previousProcessGroupIdentities);
  if (
    leaderIdentityMatchesExactly === false
    && processGroupStillBelongsToRun(artifact, observedProcessGroupIdentities) === false
    && processGroupCanBeObservedAsRunOwned(artifact, processGroupId, observedProcessGroupIdentities) === false
  ) {
    return artifact;
  }
  const processGroupIdentities = mergeProcessIdentities([
    ...previousProcessGroupIdentities,
    ...observedProcessGroupIdentities,
  ]);
  if (
    processGroupIdentities.length === artifactProcessGroupIdentities.length
    && processGroupIdentities.every((identity) => {
      return artifactProcessGroupIdentities.some((artifactIdentity) => sameProcessSnapshotIdentity(identity, artifactIdentity));
    })
  ) {
    return artifact;
  }
  return {
    ...artifact,
    processGroupIdentities,
  };
}
function processGroupStillBelongsToRun(artifact, processGroupIdentities) {
  const ownedIdentities = ownedProcessGroupIdentities(artifact);
  return processGroupIdentities.some((identity) => {
    return ownedIdentities.some((ownedIdentity) => sameProcessSnapshotIdentity(identity, ownedIdentity));
  });
}
function processGroupCanBeObservedAsRunOwned(artifact, processGroupId, processGroupIdentities) {
  if (
    process.platform === "win32"
    || artifact.processIdentity === undefined
    || processGroupId !== artifact.pid
    || processGroupIdentities.length === 0
  ) {
    return false;
  }
  return artifact.pid === artifact.processIdentity.pid && processSnapshotIdentityMatchesExactly(artifact.processIdentity);
}
function processGroupHasExactOwnedMember(artifact, processGroupId) {
  return processGroupId > 0 && processGroupStillBelongsToRun(
    artifact,
    getProcessGroupMemberIdentities(processGroupId, ownedProcessGroupIdentities(artifact)),
  );
}
function runStillBelongsToOwnedProcessGroup(artifact) {
  if (processIdentityMatches(artifact)) {
    return true;
  }
  const processGroupId = artifact.processGroupId || artifact.pid;
  return processGroupId > 0
    && processGroupStillBelongsToRun(
      artifact,
      getProcessGroupMemberIdentities(processGroupId, Array.isArray(artifact.processGroupIdentities) ? artifact.processGroupIdentities : []),
    );
}
function terminateWindowsProcessTree(pid, force = false) {
  const args = ["/PID", String(pid), "/T"];
  if (force) {
    args.push("/F");
  }
  const result = spawnSync("taskkill", args, { stdio: "ignore" });
  return result.status === 0;
}
function terminate(artifact) {
  let terminationArtifact = refreshProcessGroupIdentitiesWhileLeaderAlive(artifact);
  if (runStillBelongsToOwnedProcessGroup(terminationArtifact) === false) {
    return true;
  }
  const processGroupId = terminationArtifact.processGroupId || terminationArtifact.pid;
  if (process.platform === "win32") {
    const exactIdentities = ownedProcessGroupIdentities(terminationArtifact)
      .filter((identity) => processSnapshotIdentityMatchesExactly(identity));
    exactIdentities.forEach((identity) => {
      terminateWindowsProcessTree(identity.pid);
    });
    sleepSync(detachedTerminationGraceMs);
    exactIdentities.forEach((identity) => {
      terminateWindowsProcessTree(identity.pid, true);
    });
    terminationArtifact = refreshProcessGroupIdentitiesWhileLeaderAlive(terminationArtifact);
    return runStillBelongsToOwnedProcessGroup(terminationArtifact) === false;
  }
  let signaledProcessGroup = false;
  if (process.platform !== "win32" && processGroupHasExactOwnedMember(terminationArtifact, processGroupId)) {
    try {
      process.kill(-processGroupId, "SIGTERM");
      signaledProcessGroup = true;
    } catch {}
  }
  if (!signaledProcessGroup && terminationArtifact.pid > 0 && processSnapshotIdentityMatchesExactly(terminationArtifact.processIdentity || {})) {
    if (process.platform === "win32" && terminateWindowsProcessTree(terminationArtifact.pid)) {
      return;
    }
    try {
      process.kill(terminationArtifact.pid, "SIGTERM");
    } catch {}
  }
  const graceDeadline = Date.now() + detachedTerminationGraceMs;
  while (Date.now() < graceDeadline) {
    sleepSync(Math.min(100, Math.max(0, graceDeadline - Date.now())));
    terminationArtifact = refreshProcessGroupIdentitiesWhileLeaderAlive(terminationArtifact);
  }
  if (
    process.platform !== "win32"
    && processGroupHasExactOwnedMember(terminationArtifact, processGroupId)
  ) {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {}
  }
  if (processSnapshotIdentityMatchesExactly(terminationArtifact.processIdentity || {}) && terminationArtifact.pid > 0) {
    try {
      process.kill(terminationArtifact.pid, "SIGKILL");
    } catch {}
  }
  terminationArtifact = refreshProcessGroupIdentitiesWhileLeaderAlive(terminationArtifact);
  return runStillBelongsToOwnedProcessGroup(terminationArtifact) === false;
}
function resultArtifactHasTrustedPreDeadlineBoundary(artifact, stats, source) {
  const deadlineAtMs = Date.parse(artifact.deadlineAt || "");
  if (Number.isFinite(deadlineAtMs) === false) {
    return true;
  }
  if (Number.isFinite(stats.mtimeMs) === false || stats.mtimeMs >= deadlineAtMs) {
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
  if (!resultArtifactHasTrustedPreDeadlineBoundary(artifact, stats, source)) {
    return false;
  }
  const startedAtMs = Date.parse(artifact.startedAt);
  return baselineContentChanged || (matchingBaseline && matchingBaseline.existed === false) || Number.isFinite(startedAtMs) === false || stats.mtimeMs >= startedAtMs;
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
  const resolvedPath = path.resolve(artifactPath);
  const parsedPath = path.parse(resolvedPath);
  const candidate = parsedPath.name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  const digest = createHash("sha256").update(resolvedPath).digest("hex").slice(0, 12);
  return \`\${candidate || "detached-run"}-\${digest}\`;
}
function pathIsWithinDirectory(filePath, directoryPath) {
  const relativePath = path.relative(path.resolve(directoryPath), path.resolve(filePath));
  return relativePath.length === 0 || (relativePath.startsWith("..") === false && path.isAbsolute(relativePath) === false);
}
function existingPathIsWithinDirectory(filePath, directoryPath) {
  try {
    return pathIsWithinDirectory(realpathSync(filePath), realpathSync(directoryPath));
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
    return false;
  }
}
function buildQuarantinableResultArtifactCandidatePaths(artifact) {
  const artifactDirectory = path.dirname(path.resolve(artifact.artifactPath));
  return buildResultArtifactCandidatePaths(artifact)
    .filter((candidate) => pathIsWithinDirectory(candidate, artifactDirectory) && existingPathIsWithinDirectory(candidate, artifactDirectory));
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
      if (!error || error.code !== "ENOENT") {
        throw error;
      }
      return [];
    }
  })[0];
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
function quarantineLateResultArtifactsForCurrentRun(artifact) {
  const deadlineAtMs = Date.parse(artifact.deadlineAt || "");
  if (Number.isFinite(deadlineAtMs) === false) {
    return;
  }
  withArtifactWriteLock(() => {
    if (!existsSync(artifactPath)) {
      return;
    }
    const latestArtifact = readJsonFile(artifactPath, "Detached run artifact");
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
        renameSync(candidate, \`\${candidate}.late-\${process.pid}-\${Date.now()}.quarantined\`);
      } catch (error) {
        if (!error || error.code !== "ENOENT") {
          throw error;
        }
      }
    });
  });
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
      failureReason: \`Result artifact \${resultPath} does not expose a boolean passed field.\`,
      status: "unknown",
    };
  } catch (error) {
    return {
      failureReason: \`Could not read result artifact \${resultPath}: \${error instanceof Error ? error.message : String(error)}\`,
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
        failureReason: \`Result artifact \${resultPath} is not a regular file.\`,
        resultPath,
        sha256: \`non-regular:\${pathStats.dev}:\${pathStats.ino}:\${pathStats.mode}:\${pathStats.size}\`,
        source: "",
        stats: pathStats,
      };
    }
    if (pathStats.size > readLimitBytes) {
      return {
        failureReason: \`Result artifact \${resultPath} is too large to read (\${pathStats.size} bytes; limit \${readLimitBytes} bytes).\`,
        resultPath,
        sha256: \`oversized:\${pathStats.dev}:\${pathStats.ino}:\${pathStats.mtimeMs}:\${pathStats.size}\`,
        source: "",
        stats: pathStats,
      };
    }
    fd = openSync(resultPath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0));
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      return {
        failureReason: \`Result artifact \${resultPath} is not a regular file.\`,
        resultPath,
        sha256: \`non-regular:\${stats.dev}:\${stats.ino}:\${stats.mode}:\${stats.size}\`,
        source: "",
        stats,
      };
    }
    if (stats.size > readLimitBytes) {
      return {
        failureReason: \`Result artifact \${resultPath} is too large to read (\${stats.size} bytes; limit \${readLimitBytes} bytes).\`,
        resultPath,
        sha256: \`oversized:\${stats.dev}:\${stats.ino}:\${stats.mtimeMs}:\${stats.size}\`,
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
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
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
function writeJsonFileAtomically(filePath, payload) {
  const temporaryPath = \`\${filePath}.\${process.pid}.\${Date.now()}.\${Math.random().toString(16).slice(2)}.tmp\`;
  writeFileSync(temporaryPath, \`\${JSON.stringify(payload, null, 2)}\\n\`);
  renameSync(temporaryPath, filePath);
}
function writeTerminalArtifact(artifact, observedAt, resultPath, status, failureReason) {
  withArtifactWriteLock(() => {
    const latestArtifact = readJsonFile(artifactPath, "Detached run artifact");
    if (latestArtifact.pid !== artifact.pid || latestArtifact.startedAt !== artifact.startedAt) {
      return;
    }
    if (terminalStatuses.has(latestArtifact.status)) {
      return;
    }
    writeJsonFileAtomically(artifactPath, {
      ...latestArtifact,
      failureReason,
      finishedAt: latestArtifact.finishedAt || observedAt,
      lastMaterialEvent: {
        at: observedAt,
        phase: latestArtifact.phase,
        status,
        type: status,
      },
      lastObservedAt: observedAt,
      resultPath: resultPath || latestArtifact.resultPath,
      status,
      statusUpdatedAt: observedAt,
    });
  });
}
function writeRunningResultObservation(artifact, observedAt, resultPath) {
  withArtifactWriteLock(() => {
    const latestArtifact = readJsonFile(artifactPath, "Detached run artifact");
    if (latestArtifact.pid !== artifact.pid || latestArtifact.startedAt !== artifact.startedAt) {
      return;
    }
    if (terminalStatuses.has(latestArtifact.status)) {
      return;
    }
    writeJsonFileAtomically(artifactPath, {
      ...latestArtifact,
      lastObservedAt: observedAt,
      resultObservedWhileRunningAt: latestArtifact.resultObservedWhileRunningAt || observedAt,
      resultPath: resultPath || latestArtifact.resultPath,
    });
  });
}
function inspectDeadline() {
  const observedAt = new Date().toISOString();
  const artifact = readJsonFile(artifactPath, "Detached run artifact");
  if (!artifactIdentityMatchesOwnedRun(artifact)) {
    return;
  }
  if (artifact.watchdogPid !== undefined && artifact.watchdogPid !== process.pid) {
    return;
  }
  if (terminalStatuses.has(artifact.status)) {
    return;
  }
  const observedAtMs = Date.parse(observedAt);
  const deadlineAtMs = Date.parse(artifact.deadlineAt || "");
  const deadlineExceeded = Number.isFinite(deadlineAtMs) && observedAtMs >= deadlineAtMs;
  const recordTimeout = () => {
    if (!terminate(artifact)) {
      setTimeout(inspectDeadline, watchdogPollIntervalMs);
      return;
    }
    quarantineLateResultArtifactsForCurrentRun(artifact);
    writeTerminalArtifact(artifact, observedAt, undefined, "timeout", \`Run timed out after \${artifact.timeoutMs || "unknown"}ms.\`);
  };
  const resultStatus = discoverResultStatusSnapshot(artifact);
  if (resultStatus) {
    if (resultStatus.status === "passed" || resultStatus.status === "failed") {
      if (runStillBelongsToOwnedProcessGroup(artifact)) {
        if (deadlineExceeded) {
          recordTimeout();
          return;
        }
        writeRunningResultObservation(artifact, observedAt, resultStatus.resultPath);
        if (Number.isFinite(deadlineAtMs) && observedAtMs < deadlineAtMs) {
          const remainingMs = deadlineAtMs - observedAtMs;
          setTimeout(inspectDeadline, Math.max(0, Math.min(watchdogPollIntervalMs, remainingMs + 1)));
          return;
        }
      } else {
        if (deadlineExceeded && artifact.resultObservedWhileRunningAt !== undefined) {
          recordTimeout();
          return;
        }
        writeTerminalArtifact(artifact, observedAt, resultStatus.resultPath, resultStatus.status, resultStatus.failureReason);
        return;
      }
    } else if (!runStillBelongsToOwnedProcessGroup(artifact)) {
      writeTerminalArtifact(artifact, observedAt, resultStatus.resultPath, "failed", resultStatus.failureReason);
      return;
    }
  }
  if (!deadlineExceeded) {
    if (!runStillBelongsToOwnedProcessGroup(artifact)) {
      writeTerminalArtifact(artifact, observedAt, undefined, "process-exited-without-result", "Process is no longer alive and no result artifact was found.");
      return;
    }
    const remainingMs = Number.isFinite(deadlineAtMs) ? deadlineAtMs - observedAtMs : watchdogPollIntervalMs;
    setTimeout(inspectDeadline, Math.max(0, Math.min(watchdogPollIntervalMs, remainingMs + 1)));
    return;
  }
  recordTimeout();
}
setTimeout(inspectDeadline, Number.isFinite(delayMs) ? Math.min(delayMs, watchdogPollIntervalMs) : 0);
`;
const DETACHED_BOUNDED_LOG_SCRIPT = `
const { closeSync, constants, openSync, writeSync } = require("node:fs");

const logPath = process.argv[2];
const limitBytes = Number(process.argv[3]);
const streamName = process.argv[4] || "output";
const nofollow = constants.O_NOFOLLOW || 0;
const fd = openSync(logPath, constants.O_WRONLY | constants.O_APPEND | nofollow);
let writtenBytes = 0;
let truncated = false;

function writeBuffer(buffer) {
  if (buffer.length === 0) {
    return;
  }
  writeSync(fd, buffer, 0, buffer.length);
}

process.stdin.on("data", (chunk) => {
  if (truncated) {
    return;
  }

  const remainingBytes = Math.max(0, limitBytes - writtenBytes);
  if (chunk.length <= remainingBytes) {
    writeBuffer(chunk);
    writtenBytes += chunk.length;
    return;
  }

  if (remainingBytes > 0) {
    writeBuffer(chunk.subarray(0, remainingBytes));
    writtenBytes += remainingBytes;
  }

  writeBuffer(Buffer.from("\\n[agent-harness detached " + streamName + " log truncated after " + writtenBytes + " bytes; see result artifacts for retained output]\\n"));
  truncated = true;
});

process.stdin.on("end", () => {
  closeSync(fd);
});
`;
const TERMINAL_STATUSES: DetachedRunStatus[] = [
  "failed",
  "failed-to-start",
  "passed",
  "process-exited-without-result",
  "timeout",
];
const WATCHDOG_STATUS_GRACE_MS = 100;
const ARTIFACT_WRITE_LOCK_RETRY_MS = 10;
const ARTIFACT_WRITE_LOCK_TIMEOUT_MS = 5000;
const DETACHED_RUN_ARTIFACT_OWNERSHIP_GRACE_MS = 5000;
const DETACHED_PROTOCOL_ARTIFACT_READ_LIMIT_BYTES = 8 * 1024 * 1024;
const DETACHED_LOG_LIMIT_BYTES = 8 * 1024 * 1024;
const DETACHED_TERMINATION_GRACE_MS = 5 * 1000;
const DETACHED_WINDOWS_PROCESS_PROBE_TIMEOUT_MS = 1000;
const NOFOLLOW_OPEN_FLAG = constants.O_NOFOLLOW ?? 0;

type DetachedProcessIdentity = NonNullable<DetachedRunArtifact["processIdentity"]>;
type ArtifactWriteLockMetadata = {
  additionalLockPaths?: string[];
  artifactPath?: string;
  lockToken?: string;
  pid: number;
  processGroupIdentities?: DetachedProcessIdentity[];
  processIdentity?: DetachedProcessIdentity;
  startedAt?: string;
};

type DetachedRunPathClaim = {
  lockPaths: string[];
  metadata: ArtifactWriteLockMetadata;
};

type ArtifactWriteLockSnapshot = {
  dev: number;
  ino: number;
  metadata: ArtifactWriteLockMetadata;
  source: string;
};

type ResultArtifactSnapshot = {
  failureReason?: string;
  resultPath: string;
  sha256: string;
  source: string;
  stats: Pick<Stats, "ctimeMs" | "dev" | "ino" | "mtimeMs" | "size">;
};

type ResultArtifactStatusSnapshot = {
  failureReason?: string;
  resultPath: string;
  status: "failed" | "passed" | "unknown";
};

type ProcessIdentityProbeOptions = {
  windowsDeadlineAtMs?: number;
};

type DetachedRunArtifactOwnershipWaitOptions = {
  launchInactiveGraceMs?: number;
  pollIntervalMs?: number;
};

type ArtifactWriteLockOptions = {
  processIdentityProbeOptions?: ProcessIdentityProbeOptions;
};

type ProtocolPathSnapshot = {
  dev?: number;
  ino?: number;
  realPath?: string;
  resolvedPath: string;
};

type ProtocolPathEntry = {
  description: string;
  filePath: string;
};

function buildDefaultResumeCommand(artifactPath: string): string {
  return `npm run agent:detached-status -- --artifact ${shellQuoteForPlatform(artifactPath)} --wait`;
}

function buildDefaultStatusCommand(artifactPath: string): string {
  return `npm run agent:detached-status -- --artifact ${shellQuoteForPlatform(artifactPath)}`;
}

function buildRunLogPaths(artifactPath: string, stderrPath?: string, stdoutPath?: string): { stderr: string; stdout: string } {
  const detachedDir = path.join(path.dirname(artifactPath), "detached", getDetachedRunArtifactProtocolName(artifactPath));
  return {
    stderr: path.resolve(stderrPath ?? path.join(detachedDir, "stderr.log")),
    stdout: path.resolve(stdoutPath ?? path.join(detachedDir, "stdout.log")),
  };
}

function buildDefaultResultArtifactPath(artifactPath: string): string {
  return path.join(path.dirname(artifactPath), "detached", getDetachedRunArtifactProtocolName(artifactPath), "verify-result.json");
}

export function buildDetachedRunWatchdogScriptPath(artifactPath: string): string {
  return path.join(path.dirname(path.resolve(artifactPath)), "detached", getDetachedRunArtifactProtocolName(artifactPath), "timeout-watchdog.cjs");
}

export function buildDetachedRunBoundedLogScriptPath(artifactPath: string): string {
  return path.join(path.dirname(path.resolve(artifactPath)), "detached", getDetachedRunArtifactProtocolName(artifactPath), "bounded-log.cjs");
}

export function buildDetachedRunWindowsMonitorScriptPath(artifactPath: string): string {
  return path.join(path.dirname(path.resolve(artifactPath)), "detached", getDetachedRunArtifactProtocolName(artifactPath), "windows-monitor.ps1");
}

export function buildDetachedRunWindowsMonitorLaunchPath(artifactPath: string): string {
  return path.join(path.dirname(path.resolve(artifactPath)), "detached", getDetachedRunArtifactProtocolName(artifactPath), "windows-monitor-launch.json");
}

export function getDetachedRunArtifactProtocolName(artifactPath: string): string {
  const resolvedPath = path.resolve(artifactPath);
  const parsedPath = path.parse(resolvedPath);
  const candidate = parsedPath.name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  const digest = createHash("sha256").update(resolvedPath).digest("hex").slice(0, 12);

  return `${candidate || "detached-run"}-${digest}`;
}

export function assertProtocolPathDoesNotAlias(
  leftDescription: string,
  leftPath: string | undefined,
  rightDescription: string,
  rightPath: string | undefined,
): void {
  if (leftPath === undefined || rightPath === undefined) {
    return;
  }

  const leftSnapshot = getProtocolPathSnapshot(leftDescription, leftPath);
  const rightSnapshot = getProtocolPathSnapshot(rightDescription, rightPath);
  if (protocolPathSnapshotsAlias(leftSnapshot, rightSnapshot)) {
    throw new Error(`${leftDescription} path ${leftSnapshot.resolvedPath} must not alias ${rightDescription} path.`);
  }
}

function getProtocolPathSnapshot(description: string, filePath: string): ProtocolPathSnapshot {
  const resolvedPath = path.resolve(filePath);
  const missingSegments: string[] = [];
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
        ? {
            dev: stats.dev,
            ino: stats.ino,
            realPath,
            resolvedPath,
          }
        : {
            realPath,
            resolvedPath,
          };
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

function buildResultArtifactCandidatePaths(artifactPath: string, resultPath?: string): string[] {
  const candidates = resultPath === undefined
    ? [buildDefaultResultArtifactPath(artifactPath)]
    : [resultPath];

  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function pathIsWithinDirectory(filePath: string, directoryPath: string): boolean {
  const relativePath = path.relative(path.resolve(directoryPath), path.resolve(filePath));
  return relativePath.length === 0 || (relativePath.startsWith("..") === false && path.isAbsolute(relativePath) === false);
}

function existingPathIsWithinDirectory(filePath: string, directoryPath: string): boolean {
  try {
    return pathIsWithinDirectory(realpathSync(filePath), realpathSync(directoryPath));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function buildQuarantinableResultArtifactCandidatePaths(artifactPath: string, resultPath?: string): string[] {
  const artifactDirectory = path.dirname(path.resolve(artifactPath));
  return buildResultArtifactCandidatePaths(artifactPath, resultPath)
    .filter((candidate) => pathIsWithinDirectory(candidate, artifactDirectory) && existingPathIsWithinDirectory(candidate, artifactDirectory));
}

export function buildDetachedRunResultClaimPath(resultPath: string): string {
  return `${path.resolve(resultPath)}.detached-result.lock`;
}

function buildDetachedRunFileIdentityClaimPath(description: string, filePath: string): string | undefined {
  const resolvedPath = path.resolve(filePath);
  let stats: Stats;
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
  if (stats.isFile() === false) {
    return undefined;
  }

  return buildDetachedRunFileIdentityClaimPathForStats(stats);
}

function buildDetachedRunFileIdentityClaimPathForStats(stats: Pick<Stats, "dev" | "ino">): string {
  const identity = createHash("sha256")
    .update(`${process.platform}:${stats.dev}:${stats.ino}`)
    .digest("hex");
  return path.join(tmpdir(), "agent-harness-detached-run-locks", getDetachedRunLockUserNamespace(), `${identity}.lock`);
}

function getDetachedRunLockUserNamespace(): string {
  const effectiveUserId = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  if (effectiveUserId !== undefined) {
    return `uid-${effectiveUserId}`;
  }
  const userId = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (userId !== undefined) {
    return `uid-${userId}`;
  }
  const username = process.env.USERNAME ?? process.env.USER ?? "unknown-user";
  return `user-${createHash("sha256").update(username).digest("hex").slice(0, 16)}`;
}

function fileStatsMatchIdentity(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function currentRegularFileMatchesIdentity(filePath: string, expectedStats: Pick<Stats, "dev" | "ino">): boolean {
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

function buildDetachedRunResultClaimPaths(resultPath: string): string[] {
  return [
    buildDetachedRunResultClaimPath(resultPath),
    buildDetachedRunFileIdentityClaimPath("Result artifact", resultPath),
  ].filter((lockPath): lockPath is string => lockPath !== undefined);
}

function buildDetachedRunLogClaimPath(logPath: string): string {
  return `${path.resolve(logPath)}.detached-log.lock`;
}

function buildDetachedRunLogClaimPaths(description: string, logPath: string): string[] {
  return [
    buildDetachedRunLogClaimPath(logPath),
    buildDetachedRunFileIdentityClaimPath(description, logPath),
  ].filter((lockPath): lockPath is string => lockPath !== undefined);
}

export function buildDetachedRunPhaseClaimPath(phasePath: string): string {
  return `${path.resolve(phasePath)}.detached-phase.lock`;
}

function buildDetachedRunPhaseClaimPaths(phasePath: string): string[] {
  return [
    buildDetachedRunPhaseClaimPath(phasePath),
    buildDetachedRunFileIdentityClaimPath("Phase artifact", phasePath),
  ].filter((lockPath): lockPath is string => lockPath !== undefined);
}

export function buildWindowsObservedProcessIdentityPath(artifactPath: string): string {
  return `${path.resolve(artifactPath)}.windows-processes.json`;
}

function buildDetachedRunClaimProtocolPaths(description: string, claimPaths: string[]): ProtocolPathEntry[] {
  return claimPaths.flatMap((claimPath) => [
    { description, filePath: claimPath },
    { description: `${description} reclamation mutex`, filePath: `${claimPath}.reclaim.lock` },
    { description: `${description} reclamation takeover guard`, filePath: `${claimPath}.reclaim.lock.takeover.lock` },
  ]);
}

export function buildDetachedRunReservedProtocolPaths(
  artifactPath: string,
  resultPath?: string,
  phasePath?: string,
  logPaths?: { stderr: string; stdout: string },
): ProtocolPathEntry[] {
  const artifactWriteLockPath = `${path.resolve(artifactPath)}.lock`;
  const launchLockPath = `${path.resolve(artifactPath)}.launch.lock`;
  const resultClaimPaths = resultPath === undefined
    ? undefined
    : buildDetachedRunResultClaimPaths(resultPath);
  const phaseClaimPaths = phasePath === undefined
    ? undefined
    : buildDetachedRunPhaseClaimPaths(phasePath);
  const stderrLogClaimPaths = logPaths === undefined
    ? undefined
    : buildDetachedRunLogClaimPaths("stderr log", logPaths.stderr);
  const stdoutLogClaimPaths = logPaths === undefined
    ? undefined
    : buildDetachedRunLogClaimPaths("stdout log", logPaths.stdout);

  return [
    { description: "detached run artifact write lock", filePath: artifactWriteLockPath },
    { description: "detached run artifact write lock reclamation mutex", filePath: `${artifactWriteLockPath}.reclaim.lock` },
    { description: "detached run artifact write lock reclamation takeover guard", filePath: `${artifactWriteLockPath}.reclaim.lock.takeover.lock` },
    { description: "detached run launch lock", filePath: launchLockPath },
    { description: "detached run launch lock reclamation mutex", filePath: `${launchLockPath}.reclaim.lock` },
    { description: "detached run launch lock reclamation takeover guard", filePath: `${launchLockPath}.reclaim.lock.takeover.lock` },
    { description: "timeout watchdog script", filePath: buildDetachedRunWatchdogScriptPath(artifactPath) },
    { description: "bounded log script", filePath: buildDetachedRunBoundedLogScriptPath(artifactPath) },
    { description: "Windows monitor script", filePath: buildDetachedRunWindowsMonitorScriptPath(artifactPath) },
    { description: "Windows monitor launch data", filePath: buildDetachedRunWindowsMonitorLaunchPath(artifactPath) },
    ...(resultClaimPaths === undefined ? [] : buildDetachedRunClaimProtocolPaths("result artifact ownership lock", resultClaimPaths)),
    ...(phaseClaimPaths === undefined ? [] : buildDetachedRunClaimProtocolPaths("phase artifact ownership lock", phaseClaimPaths)),
    ...(stderrLogClaimPaths === undefined ? [] : buildDetachedRunClaimProtocolPaths("stderr log ownership lock", stderrLogClaimPaths)),
    ...(stdoutLogClaimPaths === undefined ? [] : buildDetachedRunClaimProtocolPaths("stdout log ownership lock", stdoutLogClaimPaths)),
  ];
}

function assertPathDoesNotAliasDetachedRunReservedProtocolPaths(
  description: string,
  filePath: string | undefined,
  artifactPath: string,
  resultPath?: string,
  phasePath?: string,
): void {
  buildDetachedRunReservedProtocolPaths(artifactPath, resultPath, phasePath).forEach((reservedPath) => {
    assertProtocolPathDoesNotAlias(description, filePath, reservedPath.description, reservedPath.filePath);
  });
}

function compactProtocolPathEntries(entries: Array<{ description: string; filePath: string | undefined }>): ProtocolPathEntry[] {
  return entries.filter((entry): entry is ProtocolPathEntry => entry.filePath !== undefined);
}

function assertDetachedRunClaimPathsDoNotAliasProtocolPaths(
  description: string,
  claimPaths: string[],
  protocolPaths: ProtocolPathEntry[],
): void {
  claimPaths.forEach((claimPath) => {
    protocolPaths.forEach((protocolPath) => {
      if (protocolPath.description === description && path.resolve(protocolPath.filePath) === path.resolve(claimPath)) {
        return;
      }
      assertProtocolPathDoesNotAlias(description, claimPath, protocolPath.description, protocolPath.filePath);
    });
  });
}

function buildDetachedRunProducerProtocolPaths(
  artifactPath: string,
  logPaths: { stderr: string; stdout: string },
  phasePath: string | undefined,
  resultPath: string,
  windowsObservedProcessIdentityPath: string,
): ProtocolPathEntry[] {
  return compactProtocolPathEntries([
    { description: "detached run artifact", filePath: artifactPath },
    { description: "Windows process sidecar", filePath: windowsObservedProcessIdentityPath },
    { description: "result artifact", filePath: resultPath },
    { description: "phase artifact", filePath: phasePath },
    { description: "stdout log", filePath: logPaths.stdout },
    { description: "stderr log", filePath: logPaths.stderr },
    ...buildDetachedRunReservedProtocolPaths(artifactPath, resultPath, phasePath, logPaths),
  ]);
}

function closeFd(fd: number | undefined): void {
  if (fd === undefined) {
    return;
  }

  closeSync(fd);
}

function closeFdBeforeThrow(fd: number, error: Error): never {
  closeFd(fd);
  throw error;
}

function getFileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function hashDetachedRunOwnerToken(ownerToken: string): string {
  return createHash("sha256").update(ownerToken).digest("hex");
}

function assertRegularFile(stats: Stats, description: string, filePath: string): void {
  if (stats.isFile() === false) {
    throw new Error(`${description} ${filePath} is not a regular file.`);
  }
}

function assertProtocolArtifactReadWithinLimit(stats: Pick<Stats, "size">, description: string, filePath: string): void {
  if (stats.size > DETACHED_PROTOCOL_ARTIFACT_READ_LIMIT_BYTES) {
    throw new Error(`${description} ${filePath} is too large to read (${stats.size} bytes; limit ${DETACHED_PROTOCOL_ARTIFACT_READ_LIMIT_BYTES} bytes).`);
  }
}

function readRegularFileSnapshot(filePath: string, description: string): RegularFileSnapshot {
  const pathStats = lstatSync(filePath);
  if (pathStats.isSymbolicLink()) {
    throw new Error(`${description} ${filePath} must not be a symlink.`);
  }
  assertRegularFile(pathStats, description, filePath);
  assertProtocolArtifactReadWithinLimit(pathStats, description, filePath);
  let fd: number | undefined;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW_OPEN_FLAG);
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

function protocolPathSnapshotsAlias(left: ProtocolPathSnapshot, right: ProtocolPathSnapshot): boolean {
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

function openDetachedRunLogFile(filePath: string, description: string): number {
  try {
    const fd = openSync(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NONBLOCK | NOFOLLOW_OPEN_FLAG,
      0o666,
    );
    const stats = fstatSync(fd);
    if (stats.isFile() === false) {
      closeFdBeforeThrow(fd, new Error(`${description} ${filePath} is not a regular file.`));
    }
    return fd;
  } catch (error) {
    if (errorCode(error) === "ELOOP") {
      throw new Error(`${description} ${filePath} must not be a symlink.`);
    }
    throw error;
  }
}

export function formatDetachedCommandForPlatform(
  input: StartDetachedRunInput,
  platform: NodeJS.Platform = process.platform,
): string {
  if (input.commandArgs === undefined) {
    return input.command;
  }

  return [
    input.command,
    ...input.commandArgs,
  ].map((argument) => shellQuoteForPlatform(argument, platform)).join(" ");
}

function quoteWindowsProcessArgument(value: string): string {
  if (value.length > 0 && /[\s"]/u.test(value) === false) {
    return value;
  }

  let quoted = '"';
  let pendingBackslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      pendingBackslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += `${"\\".repeat(pendingBackslashes * 2 + 1)}"`;
      pendingBackslashes = 0;
      continue;
    }
    quoted += `${"\\".repeat(pendingBackslashes)}${character}`;
    pendingBackslashes = 0;
  }

  return `${quoted}${"\\".repeat(pendingBackslashes * 2)}"`;
}

function formatWindowsProcessArgumentsForCommandLine(commandArgs: string[]): string {
  return commandArgs.map((argument) => quoteWindowsProcessArgument(argument)).join(" ");
}

function spawnStdoutText(result: SpawnSyncReturns<string>): string {
  return typeof result.stdout === "string" ? result.stdout : "";
}

function getLinuxProcessStartTicks(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(") ");
    if (commandEnd < 0) {
      return undefined;
    }
    const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTicks = fieldsAfterCommand[19];
    return startTicks === undefined || /^\d+$/u.test(startTicks) === false
      ? undefined
      : `linux-start-ticks:${startTicks}`;
  } catch {
    return undefined;
  }
}

function getDarwinProcessStartTime(pid: number): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }

  const result = spawnSync("python3", ["-c", DARWIN_PROCESS_START_TIME_SCRIPT, String(pid)], { encoding: "utf8" });
  const startTime = spawnStdoutText(result).trim();
  return result.status === 0 && /^\d+:\d+$/u.test(startTime)
    ? `darwin-proc-bsdinfo:${startTime}`
    : undefined;
}

type WindowsDetachedMonitorLaunch = {
  arguments: string;
  command: string;
  stderrLimitBytes: number;
  stderrPath: string;
  stdoutLimitBytes: number;
  stdoutPath: string;
};

function buildWindowsDetachedMonitorScript(): string {
  const script = [
    "param([string]$launchPath);",
    "$ErrorActionPreference = 'Stop';",
    "$launch = Get-Content -LiteralPath $launchPath -Raw | ConvertFrom-Json;",
    "$command = [string]$launch.command;",
    "$commandLineArguments = [string]$launch.arguments;",
    "$stdoutLogPath = [string]$launch.stdoutPath;",
    "$stderrLogPath = [string]$launch.stderrPath;",
    "$stdoutLogLimitBytes = [int64]$launch.stdoutLimitBytes;",
    "$stderrLogLimitBytes = [int64]$launch.stderrLimitBytes;",
    "$cimOperationTimeoutSec = 1;",
    "$known = @{};",
    "$knownObservedAt = @{};",
    "$knownProbeFailedAt = @{};",
    "$eventSource = \"AgentHarnessProcessStart_$PID\";",
    "$eventsRegistered = $false;",
    "$stdoutLogBytes = 0;",
    "$stderrLogBytes = 0;",
    "$stdoutLogTruncated = $false;",
    "$stderrLogTruncated = $false;",
    "$utf8NoBom = New-Object System.Text.UTF8Encoding $false;",
    "function Write-BoundedLogText([string]$path, [string]$text, [string]$streamName) {",
    "  if ($null -eq $text) { return }",
    "  if ($streamName -eq 'stdout') { $limitBytes = $stdoutLogLimitBytes; $writtenBytes = $script:stdoutLogBytes; $isTruncated = $script:stdoutLogTruncated } else { $limitBytes = $stderrLogLimitBytes; $writtenBytes = $script:stderrLogBytes; $isTruncated = $script:stderrLogTruncated }",
    "  if ($isTruncated) { return }",
    "  $bytes = $utf8NoBom.GetBytes($text);",
    "  $remainingBytes = [Math]::Max([int64]0, $limitBytes - $writtenBytes);",
    "  $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read);",
    "  try {",
    "    if ($bytes.Length -le $remainingBytes) {",
    "      if ($bytes.Length -gt 0) { $stream.Write($bytes, 0, $bytes.Length) }",
    "      $writtenBytes += $bytes.Length;",
    "    } else {",
    "      if ($remainingBytes -gt 0) { $stream.Write($bytes, 0, [int]$remainingBytes); $writtenBytes += $remainingBytes }",
    "      $markerBytes = $utf8NoBom.GetBytes(\"`n[agent-harness detached $streamName log truncated after $writtenBytes bytes; see result artifacts for retained output]`n\");",
    "      $stream.Write($markerBytes, 0, $markerBytes.Length);",
    "      $isTruncated = $true;",
    "    }",
    "  } finally { $stream.Dispose() }",
    "  if ($streamName -eq 'stdout') { $script:stdoutLogBytes = $writtenBytes; $script:stdoutLogTruncated = $isTruncated } else { $script:stderrLogBytes = $writtenBytes; $script:stderrLogTruncated = $isTruncated }",
    "}",
    "function Start-RootProcess {",
    "  $startInfo = New-Object System.Diagnostics.ProcessStartInfo;",
    "  $startInfo.FileName = $command;",
    "  $startInfo.Arguments = $commandLineArguments;",
    "  $startInfo.UseShellExecute = $false;",
    "  $startInfo.RedirectStandardOutput = $true;",
    "  $startInfo.RedirectStandardError = $true;",
    "  $process = New-Object System.Diagnostics.Process;",
    "  $process.StartInfo = $startInfo;",
    "  $process.add_OutputDataReceived({ param($sender, $eventArgs) if ($null -ne $eventArgs.Data) { Write-BoundedLogText $stdoutLogPath \"$($eventArgs.Data)`n\" 'stdout' } });",
    "  $process.add_ErrorDataReceived({ param($sender, $eventArgs) if ($null -ne $eventArgs.Data) { Write-BoundedLogText $stderrLogPath \"$($eventArgs.Data)`n\" 'stderr' } });",
    "  if (-not $process.Start()) { throw 'Detached Windows process monitor could not start the root process.' }",
    "  $process.BeginOutputReadLine();",
    "  $process.BeginErrorReadLine();",
    "  return $process",
    "}",
    "function Get-BoundedCimInstance([string]$className, [string]$filter) {",
    "  try { return @(Get-CimInstance -ClassName $className -Filter $filter -OperationTimeoutSec $cimOperationTimeoutSec) } catch { return @() }",
    "}",
    "function Get-CreationDate([int]$processId) {",
    "  $process = Get-BoundedCimInstance 'Win32_Process' \"ProcessId = $processId\" | Select-Object -First 1;",
    "  if ($null -ne $process) { return [string]$process.CreationDate }",
    "  return $null",
    "}",
    "function Test-ProcessAlive([int]$processId) {",
    "  return $null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)",
    "}",
    "function Remember-Process([int]$processId) {",
    "  $processKey = [string]$processId;",
    "  $known[$processKey] = Get-CreationDate $processId;",
    "  $knownObservedAt[$processKey] = Get-Date;",
    "  $knownProbeFailedAt.Remove($processKey) | Out-Null;",
    "}",
    "function Write-KnownProcesses {",
    "  if ([string]::IsNullOrWhiteSpace($env:AGENT_HARNESS_DETACHED_RUN_ARTIFACT)) { return }",
    "  $items = @();",
    "  foreach ($processId in @($known.Keys)) {",
    "    $creationDate = $known[$processId];",
    "    if ($null -ne $creationDate -and [string]$creationDate -ne '') { $items += @{ pid = [int]$processId; startTime = [string]$creationDate } }",
    "  }",
    "  $sidecar = \"$env:AGENT_HARNESS_DETACHED_RUN_ARTIFACT.windows-processes.json\";",
    "  $temp = \"$sidecar.tmp.$PID.$([guid]::NewGuid().ToString('N'))\";",
    "  try { $json = @{ processGroupIdentities = $items } | ConvertTo-Json -Depth 5 -Compress; $utf8NoBom = New-Object System.Text.UTF8Encoding $false; $bytes = $utf8NoBom.GetBytes($json); $stream = [System.IO.File]::Open($temp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None); try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }; $tempInfo = Get-Item -LiteralPath $temp -Force; if ($tempInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw \"temporary sidecar path is a reparse point\" }; if (-not ($tempInfo -is [System.IO.FileInfo])) { throw \"temporary sidecar path is not a regular file\" }; Move-Item -LiteralPath $temp -Destination $sidecar -Force } catch { $message = $_.Exception.Message; Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue; throw \"Detached Windows process monitor could not publish process identities: $message\" }",
    "}",
    "function Remember-Descendants([int[]]$parentIds) {",
    "  $parents = @($parentIds);",
    "  $seen = @{};",
    "  while ($parents.Count -gt 0) {",
    "    $next = @();",
    "    foreach ($parentId in $parents) {",
    "      Get-BoundedCimInstance 'Win32_Process' \"ParentProcessId = $parentId\" | ForEach-Object {",
    "        $processId = [int]$_.ProcessId;",
    "        $processKey = [string]$processId;",
    "        if (-not $known.ContainsKey($processKey)) { Remember-Process $processId }",
    "        if (-not $seen.ContainsKey($processKey)) { $seen[$processKey] = $true; $next += $processId }",
    "      }",
    "    }",
    "    $parents = $next;",
    "  }",
    "}",
    "function Process-QueuedStartEvents([bool]$publish = $true) {",
    "  if (-not $eventsRegistered) { return }",
    "  while ($true) {",
    "    $event = Get-Event -SourceIdentifier $eventSource -ErrorAction SilentlyContinue | Select-Object -First 1;",
    "    if ($null -eq $event) { break }",
    "    Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue;",
    "    $eventProcessId = [int]$event.SourceEventArgs.NewEvent.ProcessID;",
    "    $eventParentId = [int]$event.SourceEventArgs.NewEvent.ParentProcessID;",
    "    if ($known.ContainsKey([string]$eventParentId)) { Remember-Process $eventProcessId; if ($publish) { Write-KnownProcesses } }",
    "  }",
    "}",
    "function Remove-KnownProcess([string]$processKey) {",
    "  $known.Remove($processKey) | Out-Null;",
    "  $knownObservedAt.Remove($processKey) | Out-Null;",
    "  $knownProbeFailedAt.Remove($processKey) | Out-Null;",
    "}",
    "function Stop-KnownProcessIfIdentityMatches([int]$processId) {",
    "  $processKey = [string]$processId;",
    "  if (-not $known.ContainsKey($processKey)) { return }",
    "  $knownCreationDate = $known[$processKey];",
    "  if ($null -eq $knownCreationDate -or [string]$knownCreationDate -eq '') { Remove-KnownProcess $processKey; return }",
    "  $currentCreationDate = Get-CreationDate $processId;",
    "  if ($null -eq $currentCreationDate -or $currentCreationDate -ne $knownCreationDate) { Remove-KnownProcess $processKey; return }",
    "  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue",
    "}",
    "function Stop-KnownProcesses {",
    "  foreach ($processId in @($known.Keys)) { Stop-KnownProcessIfIdentityMatches ([int]$processId) }",
    "}",
    "function Stop-LaunchedProcessTree {",
    "  for ($cleanupAttempt = 0; $cleanupAttempt -lt 5; $cleanupAttempt++) {",
    "    try { Process-QueuedStartEvents $false } catch {}",
    "    if ($null -ne $root) { Remember-Descendants @([int]$root.Id) }",
    "    Remember-Descendants @($known.Keys | ForEach-Object { [int]$_ })",
    "    try { Process-QueuedStartEvents $false } catch {}",
    "    Stop-KnownProcesses",
    "    Start-Sleep -Milliseconds 100",
    "  }",
    "}",
    "try { Register-CimIndicationEvent -Query 'SELECT * FROM Win32_ProcessStartTrace' -SourceIdentifier $eventSource | Out-Null; $eventsRegistered = $true } catch { throw \"Detached Windows process monitor could not register process-start events: $($_.Exception.Message)\" }",
    "$root = $null;",
    "$root = Start-RootProcess;",
    "try {",
    "  $rootCreationDate = Get-CreationDate $root.Id;",
    "  Remember-Process $root.Id;",
    "  Process-QueuedStartEvents;",
    "  if ($null -ne $rootCreationDate) { $known[[string]$root.Id] = $rootCreationDate }",
    "  Write-KnownProcesses;",
    "  while ($true) {",
    "    Process-QueuedStartEvents;",
    "    $running = $false;",
    "    foreach ($processId in @($known.Keys)) {",
    "      $knownCreationDate = $known[$processId];",
    "      $currentCreationDate = Get-CreationDate ([int]$processId);",
    "      if ($null -ne $knownCreationDate -and $null -ne $currentCreationDate -and $currentCreationDate -ne $knownCreationDate) { $known.Remove($processId); $knownObservedAt.Remove($processId); $knownProbeFailedAt.Remove($processId); Write-KnownProcesses; continue }",
    "      if ($null -eq $knownCreationDate -and $null -ne $currentCreationDate) { $known[[string]$processId] = $currentCreationDate; $knownCreationDate = $currentCreationDate; $knownProbeFailedAt.Remove($processId) | Out-Null; Write-KnownProcesses }",
    "      if ($null -ne $currentCreationDate) { $knownProbeFailedAt.Remove($processId) | Out-Null }",
    "      Get-BoundedCimInstance 'Win32_Process' \"ParentProcessId = $processId\" | ForEach-Object { if ($null -ne $_.CreationDate) { Remember-Process ([int]$_.ProcessId); Write-KnownProcesses; $running = $true } }",
    "      if ($null -eq $currentCreationDate) {",
    "        if (-not (Test-ProcessAlive ([int]$processId))) { $known.Remove($processId); $knownObservedAt.Remove($processId); $knownProbeFailedAt.Remove($processId); Write-KnownProcesses; continue }",
    "        $failureObservedAt = $knownProbeFailedAt[$processId];",
    "        if ($null -eq $failureObservedAt) { $knownProbeFailedAt[$processId] = Get-Date }",
    "        $running = $true",
    "        continue",
    "      }",
    "      $running = $true",
    "    }",
    "    if (-not $running) { break }",
    "    Start-Sleep -Milliseconds 100",
    "  }",
    "} catch { Stop-LaunchedProcessTree; throw } finally { if ($eventsRegistered) { Unregister-Event -SourceIdentifier $eventSource -ErrorAction SilentlyContinue; Remove-Event -SourceIdentifier $eventSource -ErrorAction SilentlyContinue } }",
    "try { if ($null -ne $root) { $root.WaitForExit(); $root.CancelOutputRead(); $root.CancelErrorRead() } } catch {}",
    "try { if ($null -ne $root) { $root.Refresh(); if ($root.ExitCode -ne $null) { exit $root.ExitCode } } } catch {}",
  ].join(" ");

  return script;
}

export function buildWindowsDetachedMonitorSpawnArgs(scriptPath: string, launchPath: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    launchPath,
  ];
}

function buildWindowsShellMonitorLaunch(command: string, logPaths: { stderr: string; stdout: string }, logLimitBytes: number): WindowsDetachedMonitorLaunch {
  return {
    arguments: formatWindowsProcessArgumentsForCommandLine(["/d", "/s", "/c", command]),
    command: process.env.ComSpec ?? "cmd.exe",
    stderrLimitBytes: logLimitBytes,
    stderrPath: logPaths.stderr,
    stdoutLimitBytes: logLimitBytes,
    stdoutPath: logPaths.stdout,
  };
}

function buildWindowsArgvMonitorLaunch(
  command: string,
  commandArgs: string[],
  logPaths: { stderr: string; stdout: string },
  logLimitBytes: number,
): WindowsDetachedMonitorLaunch {
  return {
    arguments: formatWindowsProcessArgumentsForCommandLine(commandArgs),
    command,
    stderrLimitBytes: logLimitBytes,
    stderrPath: logPaths.stderr,
    stdoutLimitBytes: logLimitBytes,
    stdoutPath: logPaths.stdout,
  };
}

function writeWindowsDetachedMonitorFiles(artifactPath: string, launch: WindowsDetachedMonitorLaunch): { launchPath: string; scriptPath: string } {
  const scriptPath = buildDetachedRunWindowsMonitorScriptPath(artifactPath);
  const launchPath = buildDetachedRunWindowsMonitorLaunchPath(artifactPath);
  writeDetachedProtocolFile(scriptPath, buildWindowsDetachedMonitorScript(), 0o600);
  writeDetachedProtocolFile(launchPath, `${JSON.stringify(launch, null, 2)}\n`, 0o600);

  return { launchPath, scriptPath };
}

function getDetachedSpawnCommand(
  commandText: string,
  input: StartDetachedRunInput,
  shouldUseShellMonitor: boolean,
  artifactPath: string,
  logPaths: { stderr: string; stdout: string },
): DetachedSpawnCommand {
  const logLimitBytes = input.logLimitBytes ?? DETACHED_LOG_LIMIT_BYTES;
  if (process.platform === "win32" && input.commandArgs !== undefined) {
    const monitorFiles = writeWindowsDetachedMonitorFiles(
      artifactPath,
      buildWindowsArgvMonitorLaunch(input.command, input.commandArgs, logPaths, logLimitBytes),
    );
    return {
      args: buildWindowsDetachedMonitorSpawnArgs(monitorFiles.scriptPath, monitorFiles.launchPath),
      command: "powershell.exe",
      detached: false,
      ownsLogFiles: true,
      shell: false,
    };
  }

  if (shouldUseShellMonitor && process.platform === "win32") {
    const monitorFiles = writeWindowsDetachedMonitorFiles(
      artifactPath,
      buildWindowsShellMonitorLaunch(commandText, logPaths, logLimitBytes),
    );
    return {
      args: buildWindowsDetachedMonitorSpawnArgs(monitorFiles.scriptPath, monitorFiles.launchPath),
      command: "powershell.exe",
      detached: false,
      ownsLogFiles: true,
      shell: false,
    };
  }

  if (shouldUseShellMonitor) {
    const boundedLogScriptPath = writeDetachedBoundedLogScript(artifactPath);
    return {
      args: [],
      command: formatPosixShellCommandForDetachedSpawn(commandText, {
        boundedLogScriptPath,
        logLimitBytes,
        logPaths,
        nodePath: process.execPath,
      }),
      detached: true,
      ownsLogFiles: true,
      shell: true,
    };
  }

  return {
    args: input.commandArgs ?? [],
    command: input.command,
    detached: false,
    ownsLogFiles: false,
    shell: false,
  };
}

type PosixDetachedLogMonitorConfig = {
  boundedLogScriptPath: string;
  logLimitBytes: number;
  logPaths: {
    stderr: string;
    stdout: string;
  };
  nodePath: string;
};

function formatPosixShellCommandForDetachedSpawn(command: string, logConfig?: PosixDetachedLogMonitorConfig): string {
  const logSetupLines = logConfig === undefined
    ? [
        "_agent_harness_cleanup_logs() { :; }",
        "_agent_harness_wait_for_loggers() { :; }",
      ]
    : [
        `_agent_harness_stdout_log=${shellQuoteForPlatform(logConfig.logPaths.stdout, "linux")}`,
        `_agent_harness_stderr_log=${shellQuoteForPlatform(logConfig.logPaths.stderr, "linux")}`,
        `_agent_harness_bounded_log_script=${shellQuoteForPlatform(logConfig.boundedLogScriptPath, "linux")}`,
        `_agent_harness_node=${shellQuoteForPlatform(logConfig.nodePath, "linux")}`,
        `_agent_harness_log_limit=${logConfig.logLimitBytes}`,
        "_agent_harness_stdout_fifo=\"$_agent_harness_stdout_log.$$.stdout.fifo\"",
        "_agent_harness_stderr_fifo=\"$_agent_harness_stderr_log.$$.stderr.fifo\"",
        "_agent_harness_cleanup_logs() {",
        "  rm -f \"$_agent_harness_stdout_fifo\" \"$_agent_harness_stderr_fifo\"",
        "}",
        "_agent_harness_wait_for_logger() {",
        "  _agent_harness_logger_pid=\"$1\"",
        "  if [ -z \"$_agent_harness_logger_pid\" ]; then",
        "    return 0",
        "  fi",
        "  _agent_harness_logger_wait_remaining=20",
        "  while kill -0 \"$_agent_harness_logger_pid\" 2>/dev/null; do",
        "    if _agent_harness_is_zombie \"$_agent_harness_logger_pid\"; then",
        "      break",
        "    fi",
        "    if [ \"$_agent_harness_logger_wait_remaining\" -le 0 ]; then",
        "      break",
        "    fi",
        "    _agent_harness_logger_wait_remaining=$((_agent_harness_logger_wait_remaining - 1))",
        "    sleep 0.05",
        "  done",
        "  if kill -0 \"$_agent_harness_logger_pid\" 2>/dev/null && ! _agent_harness_is_zombie \"$_agent_harness_logger_pid\"; then",
        "    kill -TERM \"$_agent_harness_logger_pid\" 2>/dev/null || true",
        "    sleep 0.1",
        "    if kill -0 \"$_agent_harness_logger_pid\" 2>/dev/null && ! _agent_harness_is_zombie \"$_agent_harness_logger_pid\"; then",
        "      kill -KILL \"$_agent_harness_logger_pid\" 2>/dev/null || true",
        "    fi",
        "  fi",
        "  wait \"$_agent_harness_logger_pid\" 2>/dev/null || true",
        "}",
        "_agent_harness_wait_for_loggers() {",
        "  _agent_harness_wait_for_logger \"$_agent_harness_stdout_logger_pid\"",
        "  _agent_harness_wait_for_logger \"$_agent_harness_stderr_logger_pid\"",
        "  _agent_harness_cleanup_logs",
        "}",
        "_agent_harness_cleanup_logs",
        "mkfifo \"$_agent_harness_stdout_fifo\" \"$_agent_harness_stderr_fifo\"",
        "\"$_agent_harness_node\" \"$_agent_harness_bounded_log_script\" \"$_agent_harness_stdout_log\" \"$_agent_harness_log_limit\" stdout < \"$_agent_harness_stdout_fifo\" &",
        "_agent_harness_stdout_logger_pid=$!",
        "\"$_agent_harness_node\" \"$_agent_harness_bounded_log_script\" \"$_agent_harness_stderr_log\" \"$_agent_harness_log_limit\" stderr < \"$_agent_harness_stderr_fifo\" &",
        "_agent_harness_stderr_logger_pid=$!",
      ];
  const commandEndLine = logConfig === undefined
    ? ") &"
    : ") > \"$_agent_harness_stdout_fifo\" 2> \"$_agent_harness_stderr_fifo\" &";

  return [
    ...logSetupLines,
    "_agent_harness_is_zombie() {",
    "  _agent_harness_stat=\"\"",
    "  _agent_harness_state=\"\"",
    "  if [ -r \"/proc/$1/stat\" ]; then",
    "    _agent_harness_stat=$(cat \"/proc/$1/stat\" 2>/dev/null || true)",
    "    _agent_harness_state=${_agent_harness_stat##*) }",
    "    _agent_harness_state=${_agent_harness_state%% *}",
    "    if [ \"$_agent_harness_state\" = \"Z\" ]; then",
    "      return 0",
    "    fi",
    "  fi",
    "  _agent_harness_state=$(ps -o stat= -p \"$1\" 2>/dev/null || true)",
    "  case \"$_agent_harness_state\" in",
    "    *Z*) return 0 ;;",
    "    *) return 1 ;;",
    "  esac",
    "}",
    "_agent_harness_get_start_identity() {",
    "  if _agent_harness_is_zombie \"$1\"; then",
    "    return 1",
    "  fi",
    "  if [ -r \"/proc/$1/stat\" ]; then",
    "    _agent_harness_identity_stat=$(cat \"/proc/$1/stat\" 2>/dev/null || true)",
    "    _agent_harness_identity_after_command=${_agent_harness_identity_stat##*) }",
    "    set -- $_agent_harness_identity_after_command",
    "    _agent_harness_identity_start_ticks=${20:-}",
    "    case \"$_agent_harness_identity_start_ticks\" in",
    "      *[!0-9]*|'') ;;",
    "      *) printf 'linux-start-ticks:%s\\n' \"$_agent_harness_identity_start_ticks\"; return 0 ;;",
    "    esac",
    "  fi",
    "  _agent_harness_identity_lstart=$(ps -o lstart= -p \"$1\" 2>/dev/null | tr -s '[:space:]' '_' | sed 's/^_//; s/_$//' || true)",
    "  if [ -n \"$_agent_harness_identity_lstart\" ]; then",
    "    printf 'ps-lstart:%s\\n' \"$_agent_harness_identity_lstart\"",
    "    return 0",
    "  fi",
    "  return 1",
    "}",
    "_agent_harness_add_known_pid() {",
    "  _agent_harness_known_identity=$(_agent_harness_get_start_identity \"$1\" 2>/dev/null || true)",
    "  if [ -z \"$_agent_harness_known_identity\" ]; then",
    "    return 1",
    "  fi",
    "  case \" $_agent_harness_known_pids \" in",
    "    *\" $1 \"*)",
    "      case \" $_agent_harness_known_pid_identities \" in",
    "        *\" $1:$_agent_harness_known_identity \"*) return 0 ;;",
    "        *) return 1 ;;",
    "      esac",
    "      ;;",
    "    *) _agent_harness_known_pids=\"$_agent_harness_known_pids$1 \" ;;",
    "  esac",
    "  case \" $_agent_harness_known_pid_identities \" in",
    "    *\" $1:$_agent_harness_known_identity \"*) ;;",
    "    *) _agent_harness_known_pid_identities=\"$_agent_harness_known_pid_identities$1:$_agent_harness_known_identity \" ;;",
    "  esac",
    "  return 0",
    "}",
    "_agent_harness_pid_identity_matches() {",
    "  _agent_harness_current_identity=$(_agent_harness_get_start_identity \"$1\" 2>/dev/null || true)",
    "  if [ -z \"$_agent_harness_current_identity\" ]; then",
    "    return 1",
    "  fi",
    "  case \" $_agent_harness_known_pid_identities \" in",
    "    *\" $1:$_agent_harness_current_identity \"*) return 0 ;;",
    "    *) return 1 ;;",
    "  esac",
    "}",
    "_agent_harness_is_monitor_helper() {",
    "  if [ \"$1\" = \"$_agent_harness_wrapper_pid\" ]; then",
    "    return 0",
    "  fi",
    "  if [ -n \"${_agent_harness_stdout_logger_pid:-}\" ] && [ \"$1\" = \"$_agent_harness_stdout_logger_pid\" ]; then",
    "    return 0",
    "  fi",
    "  if [ -n \"${_agent_harness_stderr_logger_pid:-}\" ] && [ \"$1\" = \"$_agent_harness_stderr_logger_pid\" ]; then",
    "    return 0",
    "  fi",
    "  if [ \"$1\" = \"$_agent_harness_command_pid\" ]; then",
    "    return 1",
    "  fi",
    "  _agent_harness_helper_pid=\"$1\"",
    "  while [ -n \"$_agent_harness_helper_pid\" ] && [ \"$_agent_harness_helper_pid\" != \"1\" ]; do",
    "    _agent_harness_parent_pid=\"\"",
    "    for _agent_harness_parent_candidate in $(ps -o ppid= -p \"$_agent_harness_helper_pid\" 2>/dev/null || true); do",
    "      _agent_harness_parent_pid=\"$_agent_harness_parent_candidate\"",
    "      break",
    "    done",
    "    if [ -z \"$_agent_harness_parent_pid\" ]; then",
    "      break",
    "    fi",
    "    if [ \"$_agent_harness_parent_pid\" = \"$_agent_harness_command_pid\" ]; then",
    "      return 1",
    "    fi",
    "    if [ \"$_agent_harness_parent_pid\" = \"$_agent_harness_wrapper_pid\" ]; then",
    "      return 0",
    "    fi",
    "    if [ \"$_agent_harness_parent_pid\" = \"$_agent_harness_helper_pid\" ]; then",
    "      break",
    "    fi",
    "    _agent_harness_helper_pid=\"$_agent_harness_parent_pid\"",
    "  done",
    "  return 1",
    "}",
    "_agent_harness_is_group_member() {",
    "  _agent_harness_member_pgid=\"\"",
    "  for _agent_harness_member_pgid_candidate in $(ps -o pgid= -p \"$1\" 2>/dev/null || true); do",
    "    _agent_harness_member_pgid=\"$_agent_harness_member_pgid_candidate\"",
    "    break",
    "  done",
    "  if [ \"$_agent_harness_member_pgid\" = \"$_agent_harness_wrapper_pid\" ]; then",
    "    return 0",
    "  fi",
    "  return 1",
    "}",
    "_agent_harness_add_outside_group_pid() {",
    "  case \" $_agent_harness_outside_group_pids \" in",
    "    *\" $1 \"*) ;;",
    "    *) _agent_harness_outside_group_pids=\"$_agent_harness_outside_group_pids$1 \" ;;",
    "  esac",
    "}",
    "_agent_harness_is_outside_group_pid() {",
    "  case \" $_agent_harness_outside_group_pids \" in",
    "    *\" $1 \"*) return 0 ;;",
    "    *) return 1 ;;",
    "  esac",
    "}",
    "_agent_harness_retire_pid() {",
    "  case \" $_agent_harness_retired_pids \" in",
    "    *\" $1 \"*) ;;",
    "    *) _agent_harness_retired_pids=\"$_agent_harness_retired_pids$1 \" ;;",
    "  esac",
    "}",
    "_agent_harness_is_retired_pid() {",
    "  case \" $_agent_harness_retired_pids \" in",
    "    *\" $1 \"*) return 0 ;;",
    "    *) return 1 ;;",
    "  esac",
    "}",
    "_agent_harness_track_group_members() {",
    "  for _agent_harness_pid in $(pgrep -g \"$_agent_harness_wrapper_pid\" 2>/dev/null || true); do",
    "    if ! _agent_harness_is_monitor_helper \"$_agent_harness_pid\"; then",
    "      _agent_harness_add_known_pid \"$_agent_harness_pid\"",
    "    fi",
    "  done",
    "}",
    "_agent_harness_track_descendants() {",
    "  _agent_harness_parents=\"$_agent_harness_known_pids\"",
    "  while [ -n \"$_agent_harness_parents\" ]; do",
    "    _agent_harness_next_parents=\"\"",
    "    for _agent_harness_parent in $_agent_harness_parents; do",
    "      if _agent_harness_is_monitor_helper \"$_agent_harness_parent\"; then",
    "        continue",
    "      fi",
    "      if _agent_harness_is_retired_pid \"$_agent_harness_parent\"; then",
    "        continue",
    "      fi",
    "      for _agent_harness_child in $(pgrep -P \"$_agent_harness_parent\" 2>/dev/null || true); do",
    "        if _agent_harness_is_monitor_helper \"$_agent_harness_child\"; then",
    "          continue",
    "        fi",
    "        _agent_harness_child_was_known=0",
    "        case \" $_agent_harness_known_pids \" in",
    "          *\" $_agent_harness_child \"*) _agent_harness_child_was_known=1 ;;",
    "          *) ;;",
    "        esac",
    "        if ! _agent_harness_add_known_pid \"$_agent_harness_child\"; then",
    "          continue",
    "        fi",
    "        if [ \"$_agent_harness_child_was_known\" -eq 0 ]; then",
    "          _agent_harness_next_parents=\"$_agent_harness_next_parents$_agent_harness_child \"",
    "        fi",
    "        if ! _agent_harness_is_group_member \"$_agent_harness_child\"; then",
    "          _agent_harness_add_outside_group_pid \"$_agent_harness_child\"",
    "        fi",
    "      done",
    "    done",
    "    _agent_harness_parents=\"$_agent_harness_next_parents\"",
    "  done",
    "}",
    "_agent_harness_stop_known_pids() {",
    "  _agent_harness_signal=\"$1\"",
    "  for _agent_harness_pid in $_agent_harness_known_pids; do",
    "    if ! _agent_harness_is_monitor_helper \"$_agent_harness_pid\"; then",
    "      if _agent_harness_is_retired_pid \"$_agent_harness_pid\"; then",
    "        continue",
    "      fi",
    "      if ! _agent_harness_pid_identity_matches \"$_agent_harness_pid\"; then",
    "        continue",
    "      fi",
    "      if _agent_harness_is_group_member \"$_agent_harness_pid\" || _agent_harness_is_outside_group_pid \"$_agent_harness_pid\" || [ \"$_agent_harness_pid\" = \"$_agent_harness_command_pid\" ]; then",
    "        kill -\"$_agent_harness_signal\" \"$_agent_harness_pid\" 2>/dev/null || true",
    "      fi",
    "    fi",
    "  done",
    "}",
    "_agent_harness_terminate_known_pids() {",
    "  _agent_harness_track_group_members",
    "  _agent_harness_track_descendants",
    "  _agent_harness_stop_known_pids TERM",
    `  sleep ${DETACHED_TERMINATION_GRACE_MS / 1000}`,
    "  _agent_harness_stop_known_pids KILL",
    "}",
    "_agent_harness_wrapper_pid=$$",
    "(",
    command,
    commandEndLine,
    "_agent_harness_command_pid=$!",
    "_agent_harness_known_pids=\"\"",
    "_agent_harness_known_pid_identities=\"\"",
    "_agent_harness_add_known_pid \"$_agent_harness_command_pid\" || true",
    "_agent_harness_outside_group_pids=\"\"",
    "_agent_harness_retired_pids=\"\"",
    "_agent_harness_command_status=0",
    "_agent_harness_command_reaped=0",
    "_agent_harness_zombie_grace_remaining=10",
    "trap '_agent_harness_terminate_known_pids; _agent_harness_wait_for_loggers; exit 143' HUP INT TERM",
    "while :; do",
    "  _agent_harness_track_group_members",
    "  _agent_harness_track_descendants",
    "  if [ \"$_agent_harness_command_reaped\" -eq 0 ]; then",
    "    if kill -0 \"$_agent_harness_command_pid\" 2>/dev/null && ! _agent_harness_is_zombie \"$_agent_harness_command_pid\"; then",
    "      :",
    "    else",
    "      wait \"$_agent_harness_command_pid\" || _agent_harness_command_status=$?",
    "      _agent_harness_command_reaped=1",
    "      _agent_harness_track_group_members",
    "      _agent_harness_track_descendants",
    "    fi",
    "  fi",
    "  _agent_harness_group_has_worker=0",
    "  _agent_harness_group_has_group_worker=0",
    "  _agent_harness_group_has_outside_worker=0",
    "  _agent_harness_group_has_zombie=0",
    "  for _agent_harness_pid in $_agent_harness_known_pids; do",
    "    if _agent_harness_is_monitor_helper \"$_agent_harness_pid\"; then",
    "      continue",
    "    fi",
    "    if _agent_harness_is_retired_pid \"$_agent_harness_pid\"; then",
    "      continue",
    "    fi",
    "    if ! kill -0 \"$_agent_harness_pid\" 2>/dev/null; then",
    "      _agent_harness_retire_pid \"$_agent_harness_pid\"",
    "      continue",
    "    fi",
    "    if ! _agent_harness_pid_identity_matches \"$_agent_harness_pid\"; then",
    "      _agent_harness_retire_pid \"$_agent_harness_pid\"",
    "      continue",
    "    fi",
    "    _agent_harness_pid_is_group_worker=0",
    "    if _agent_harness_is_group_member \"$_agent_harness_pid\" || [ \"$_agent_harness_pid\" = \"$_agent_harness_command_pid\" ]; then",
    "      _agent_harness_pid_is_group_worker=1",
    "    fi",
    "    if [ \"$_agent_harness_pid_is_group_worker\" -eq 0 ] && ! _agent_harness_is_outside_group_pid \"$_agent_harness_pid\"; then",
    "      _agent_harness_retire_pid \"$_agent_harness_pid\"",
    "      continue",
    "    fi",
    "    if _agent_harness_is_zombie \"$_agent_harness_pid\"; then",
    "      _agent_harness_group_has_zombie=1",
    "      continue",
    "    fi",
    "    _agent_harness_group_has_worker=1",
    "    if [ \"$_agent_harness_pid_is_group_worker\" -eq 1 ]; then",
    "      _agent_harness_group_has_group_worker=1",
    "    else",
    "      _agent_harness_group_has_outside_worker=1",
    "    fi",
    "  done",
    "  if [ \"$_agent_harness_command_reaped\" -eq 0 ]; then",
    "    sleep 0.1",
    "    continue",
    "  fi",
    "  if [ \"$_agent_harness_group_has_worker\" -eq 0 ] && [ \"$_agent_harness_group_has_zombie\" -eq 1 ] && [ \"$_agent_harness_zombie_grace_remaining\" -gt 0 ]; then",
    "    _agent_harness_zombie_grace_remaining=$((_agent_harness_zombie_grace_remaining - 1))",
    "    sleep 0.1",
    "    continue",
    "  fi",
    "  if [ \"$_agent_harness_group_has_worker\" -eq 0 ]; then",
    "    break",
    "  fi",
    "  sleep 0.1",
    "done",
    "trap - HUP INT TERM",
    "_agent_harness_wait_for_loggers",
    "exit \"$_agent_harness_command_status\"",
  ].join("\n");
}

function assertPosixDetachedShellMonitorAvailable(): void {
  const result = spawnSync("/bin/sh", ["-c", "command -v pgrep >/dev/null 2>&1"], {
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw new Error(`Detached POSIX shell monitor requires pgrep on PATH: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error("Detached POSIX shell monitor requires pgrep on PATH.");
  }
}

export function formatShellCommandForDetachedSpawn(command: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? command : formatPosixShellCommandForDetachedSpawn(command);
}

function discoverResultStatusSnapshot(artifact: DetachedRunArtifact): ResultArtifactStatusSnapshot | undefined {
  return buildResultArtifactCandidatePaths(artifact.artifactPath, artifact.resultPath)
    .flatMap((candidate): ResultArtifactStatusSnapshot[] => {
      if (existsSync(candidate) === false) {
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

function getResultArtifactBaselines(artifactPath: string, resultPath?: string): DetachedRunArtifact["resultArtifactBaselines"] {
  return buildResultArtifactCandidatePaths(artifactPath, resultPath)
    .map((candidate) => {
      if (existsSync(candidate) === false) {
        return {
          existed: false,
          path: candidate,
        };
      }
      let snapshot: RegularFileSnapshot;
      try {
        snapshot = readRegularFileSnapshot(candidate, "Result artifact baseline");
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return {
            existed: false,
            path: candidate,
          };
        }
        throw error;
      }
      return {
        existed: true,
        mtimeMs: snapshot.mtimeMs,
        path: candidate,
        sha256: snapshot.sha256,
        size: snapshot.size,
      };
    });
}

function getPhaseArtifactBaseline(phasePath?: string): DetachedRunArtifact["phaseArtifactBaseline"] {
  if (phasePath === undefined) {
    return undefined;
  }

  const resolvedPath = path.resolve(phasePath);
  if (existsSync(resolvedPath) === false) {
    return {
      existed: false,
      path: resolvedPath,
    };
  }

  const stats = statSync(resolvedPath);
  if (stats.isFile() === false) {
    throw new Error(`Phase artifact baseline ${resolvedPath} is not a regular file.`);
  }
  const snapshot = readRegularFileSnapshot(resolvedPath, "Phase artifact baseline");
  return {
    existed: true,
    mtimeMs: snapshot.mtimeMs,
    path: resolvedPath,
    sha256: snapshot.sha256,
    size: snapshot.size,
  };
}

function getWindowsProcessProbeTimeoutMs(options: ProcessIdentityProbeOptions): number {
  if (options.windowsDeadlineAtMs === undefined) {
    return DETACHED_WINDOWS_PROCESS_PROBE_TIMEOUT_MS;
  }

  return Math.max(0, Math.min(DETACHED_WINDOWS_PROCESS_PROBE_TIMEOUT_MS, options.windowsDeadlineAtMs - Date.now()));
}

function getWindowsProcessRefreshProbeOptions(): ProcessIdentityProbeOptions {
  return process.platform === "win32"
    ? { windowsDeadlineAtMs: Date.now() + DETACHED_WINDOWS_PROCESS_PROBE_TIMEOUT_MS }
    : {};
}

function getProcessIdentity(pid: number, options: ProcessIdentityProbeOptions = {}): DetachedProcessIdentity | undefined {
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
    ], {
      encoding: "utf8",
      timeout,
    });
    const startTime = typeof result.stdout === "string" ? result.stdout.trim() : "";
    if (result.status !== 0 || startTime.length === 0) {
      return undefined;
    }

    return {
      pid,
      startTime,
    };
  }

  if (isPidZombie(pid)) {
    return undefined;
  }

  const linuxStartTicks = getLinuxProcessStartTicks(pid);
  if (linuxStartTicks !== undefined) {
    return {
      pid,
      startTime: linuxStartTicks,
    };
  }

  const darwinStartTime = getDarwinProcessStartTime(pid);
  if (darwinStartTime !== undefined) {
    return {
      pid,
      startTime: darwinStartTime,
    };
  }

  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const startTime = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (result.status !== 0 || startTime.length === 0) {
    return undefined;
  }

  return {
    pid,
    startTime,
  };
}

function mergeProcessIdentities(identities: DetachedProcessIdentity[]): DetachedProcessIdentity[] {
  const seen = new Set<string>();
  return identities.filter((identity) => {
    const key = `${identity.pid}:${identity.startTime ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isDetachedProcessAlive(artifact: DetachedRunArtifact, options: ProcessIdentityProbeOptions = {}): boolean {
  if (isPidAlive(artifact.pid) === false) {
    return false;
  }

  if (artifact.processIdentity?.startTime === undefined) {
    return false;
  }

  const currentIdentity = getProcessIdentity(artifact.pid, options);
  return currentIdentity === undefined || currentIdentity.startTime === artifact.processIdentity.startTime;
}

function isProcessGroupPossiblyAlive(processGroupId: number): boolean {
  if (processGroupId <= 0 || process.platform === "win32") {
    return false;
  }

  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function isUnverifiedStartupCleanupStillAlive(artifact: DetachedRunArtifact): boolean {
  if (
    artifact.startupCleanupUnverified !== true
    || artifact.processIdentity !== undefined
    || (artifact.processGroupIdentities ?? []).length > 0
  ) {
    return false;
  }

  const processGroupId = artifact.processGroupId ?? artifact.pid;
  return process.platform === "win32"
    ? isPidAlive(artifact.pid)
    : isProcessGroupPossiblyAlive(processGroupId) || isPidAlive(artifact.pid);
}

type ProcessIdentityMatchState = "dead" | "match" | "mismatch" | "unavailable";

function getProcessIdentityMatchState(
  identity: DetachedProcessIdentity,
  options: ProcessIdentityProbeOptions = {},
): ProcessIdentityMatchState {
  if (isPidAlive(identity.pid) === false) {
    return "dead";
  }

  if (identity.startTime === undefined) {
    return "mismatch";
  }

  const currentIdentity = getProcessIdentity(identity.pid, options);
  if (currentIdentity === undefined) {
    return "unavailable";
  }
  return currentIdentity.startTime === identity.startTime ? "match" : "mismatch";
}

function processIdentityMatches(identity: DetachedProcessIdentity, options: ProcessIdentityProbeOptions = {}): boolean {
  const matchState = getProcessIdentityMatchState(identity, options);
  return matchState === "match" || matchState === "unavailable";
}

function processIdentityMatchesExactly(identity: DetachedProcessIdentity, options: ProcessIdentityProbeOptions = {}): boolean {
  return getProcessIdentityMatchState(identity, options) === "match";
}

function isDetachedProcessAliveExactly(artifact: DetachedRunArtifact, options: ProcessIdentityProbeOptions = {}): boolean {
  if (artifact.processIdentity === undefined) {
    return false;
  }

  return artifact.pid === artifact.processIdentity.pid && processIdentityMatchesExactly(artifact.processIdentity, options);
}

function sameProcessIdentity(left: DetachedProcessIdentity, right: DetachedProcessIdentity): boolean {
  return left.pid === right.pid && left.startTime !== undefined && left.startTime === right.startTime;
}

function getOwnedProcessGroupIdentities(artifact: DetachedRunArtifact): DetachedProcessIdentity[] {
  return mergeProcessIdentities([
    ...(artifact.processIdentity === undefined ? [] : [artifact.processIdentity]),
    ...(artifact.processGroupIdentities ?? []),
    ...readWindowsObservedProcessIdentities(artifact.artifactPath),
  ]);
}

function readWindowsObservedProcessIdentities(artifactPath: string): DetachedProcessIdentity[] {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    const payload = readJsonFile<unknown>(buildWindowsObservedProcessIdentityPath(artifactPath));
    if (typeof payload !== "object" || payload === null || Array.isArray(payload) || !("processGroupIdentities" in payload)) {
      return [];
    }

    const identities = (payload as { processGroupIdentities?: unknown }).processGroupIdentities;
    if (Array.isArray(identities) === false) {
      return [];
    }

    return identities.flatMap((identity): DetachedProcessIdentity[] => {
      if (
        typeof identity !== "object"
        || identity === null
        || Array.isArray(identity)
        || "pid" in identity === false
        || typeof identity.pid !== "number"
      ) {
        return [];
      }

      const startTime = "startTime" in identity && typeof identity.startTime === "string"
        ? identity.startTime
        : undefined;
      return [{
        pid: identity.pid,
        startTime,
      }];
    });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return isPidZombie(pid) === false;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") {
      return isPidZombie(pid) === false;
    }
    return false;
  }
}

function isPidZombie(pid: number): boolean {
  if (process.platform === "win32") {
    return false;
  }

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(") ");
    if (commandEnd >= 0) {
      return stat.slice(commandEnd + 2).trim().split(/\s+/)[0] === "Z";
    }
  } catch {
    // Fall back to ps on POSIX systems without Linux procfs.
  }

  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const state = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return result.status === 0 && /\bZ/.test(state);
}

function terminateWindowsProcessTree(pid: number, force = false): boolean {
  const args = ["/PID", String(pid), "/T"];
  if (force) {
    args.push("/F");
  }
  const result = spawnSync("taskkill", args, {
    stdio: "ignore",
  });
  return result.status === 0;
}

function getExactWindowsSpawnedProcessTreeIdentities(
  pid: number,
  knownProcessGroupIdentities: DetachedProcessIdentity[],
): DetachedProcessIdentity[] {
  const options = getWindowsProcessRefreshProbeOptions();
  const exactKnownIdentities = mergeProcessIdentities(knownProcessGroupIdentities)
    .filter((identity) => processIdentityMatchesExactly(identity, options));
  if (exactKnownIdentities.length === 0) {
    return [];
  }

  return mergeProcessIdentities([
    ...exactKnownIdentities,
    ...getProcessGroupMemberIdentitiesForKnownParents(pid, exactKnownIdentities, options),
  ]);
}

function getWindowsChildProcessIds(parentPids: number[], options: ProcessIdentityProbeOptions = {}): number[] {
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
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout,
  });
  const stdout = spawnStdoutText(result);
  if (result.status !== 0 || stdout.trim().length === 0) {
    return [];
  }

  return stdout
    .split(/\s+/)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
}

function getProcessGroupMemberIdentitiesForKnownParents(
  processGroupId: number,
  knownProcessGroupIdentities: DetachedProcessIdentity[],
  options: ProcessIdentityProbeOptions = {},
): DetachedProcessIdentity[] {
  if (processGroupId <= 0) {
    return [];
  }

  if (process.platform === "win32") {
    const matchingKnownProcessGroupIdentities = knownProcessGroupIdentities.filter((identity) => processIdentityMatchesExactly(identity, options));
    return mergeProcessIdentities([
      ...matchingKnownProcessGroupIdentities,
      ...getWindowsChildProcessIds(matchingKnownProcessGroupIdentities.map((identity) => identity.pid), options)
        .flatMap((pid) => {
          const identity = getProcessIdentity(pid, options);
          return identity === undefined ? [] : [identity];
        }),
    ]);
  }

  const result = spawnSync("pgrep", ["-g", String(processGroupId)], {
    encoding: "utf8",
  });
  const stdout = spawnStdoutText(result);
  if (result.status !== 0 || stdout.trim().length === 0) {
    return [];
  }

  return stdout
    .split(/\s+/)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0)
    .flatMap((pid) => {
      const identity = getProcessIdentity(pid);
      return identity === undefined ? [] : [identity];
    });
}

function getProcessGroupMemberIdentities(processGroupId: number): DetachedProcessIdentity[] {
  return getProcessGroupMemberIdentitiesForKnownParents(processGroupId, []);
}

function processGroupStillBelongsToRun(artifact: DetachedRunArtifact, processGroupIdentities: DetachedProcessIdentity[]): boolean {
  const ownedIdentities = getOwnedProcessGroupIdentities(artifact);
  return processGroupIdentities.some((identity) => {
    return ownedIdentities.some((ownedIdentity) => sameProcessIdentity(identity, ownedIdentity));
  });
}

function processGroupCanBeObservedAsRunOwned(
  artifact: DetachedRunArtifact,
  processGroupId: number,
  processGroupIdentities: DetachedProcessIdentity[],
  options: ProcessIdentityProbeOptions = {},
): boolean {
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

function processGroupHasExactOwnedMember(
  artifact: DetachedRunArtifact,
  processGroupId: number,
  options: ProcessIdentityProbeOptions = {},
): boolean {
  return processGroupId > 0
    && processGroupStillBelongsToRun(
      artifact,
      getProcessGroupMemberIdentitiesForKnownParents(processGroupId, getOwnedProcessGroupIdentities(artifact), options),
    );
}

function refreshProcessGroupIdentitiesWhileLeaderAlive(
  artifact: DetachedRunArtifact,
  options: ProcessIdentityProbeOptions = getWindowsProcessRefreshProbeOptions(),
): DetachedRunArtifact {
  const processGroupId = artifact.processGroupId ?? artifact.pid;
  if (processGroupId <= 0) {
    return artifact;
  }

  const artifactProcessGroupIdentities = artifact.processGroupIdentities ?? [];
  const previousProcessGroupIdentities = mergeProcessIdentities([
    ...artifactProcessGroupIdentities,
    ...readWindowsObservedProcessIdentities(artifact.artifactPath),
  ]);
  const leaderIdentityMatchesExactly = isDetachedProcessAliveExactly(artifact, options);
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
    processGroupIdentities.length === artifactProcessGroupIdentities.length
    && processGroupIdentities.every((identity) => {
      return artifactProcessGroupIdentities.some((artifactIdentity) => sameProcessIdentity(identity, artifactIdentity));
    })
  ) {
    return artifact;
  }

  return {
    ...artifact,
    processGroupIdentities,
  };
}

function isDetachedRunAlive(
  artifact: DetachedRunArtifact,
  options: ProcessIdentityProbeOptions = getWindowsProcessRefreshProbeOptions(),
): boolean {
  if (isDetachedProcessAlive(artifact, options)) {
    return true;
  }

  if (isUnverifiedStartupCleanupStillAlive(artifact)) {
    return true;
  }

  const processGroupId = artifact.processGroupId ?? artifact.pid;
  if (processGroupId <= 0) {
    return false;
  }

  return processGroupStillBelongsToRun(
    artifact,
    getProcessGroupMemberIdentitiesForKnownParents(processGroupId, artifact.processGroupIdentities ?? [], options),
  );
}

function isTerminalStatus(status: DetachedRunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function readArtifactWriteLockMetadata(lockPath: string): ArtifactWriteLockMetadata | undefined {
  return readArtifactWriteLockSnapshot(lockPath)?.metadata;
}

function readArtifactWriteLockSnapshot(lockPath: string): ArtifactWriteLockSnapshot | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW_OPEN_FLAG);
    const stats = fstatSync(fd);
    if (stats.isFile() === false) {
      return undefined;
    }
    const source = readFileSync(fd, "utf8");
    const metadata = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source) as unknown;
    if (
      typeof metadata === "object"
      && metadata !== null
      && "pid" in metadata
      && typeof metadata.pid === "number"
    ) {
      return {
        dev: stats.dev,
        ino: stats.ino,
        metadata: metadata as ArtifactWriteLockMetadata,
        source,
      };
    }
  } catch {
    return undefined;
  } finally {
    closeFd(fd);
  }

  return undefined;
}

function artifactWriteLockSnapshotStillMatches(lockPath: string, snapshot: ArtifactWriteLockSnapshot): boolean {
  const current = readArtifactWriteLockSnapshot(lockPath);
  return current !== undefined
    && current.dev === snapshot.dev
    && current.ino === snapshot.ino
    && current.source === snapshot.source
    && (
      snapshot.metadata.lockToken === undefined
      || current.metadata.lockToken === snapshot.metadata.lockToken
    );
}

function artifactWriteLockOwnerIsAlive(metadata: ArtifactWriteLockMetadata, options: ProcessIdentityProbeOptions = {}): boolean {
  if (metadata.artifactPath !== undefined) {
    try {
      const artifact = readDetachedRunArtifact(metadata.artifactPath);
      if (isTerminalStatus(artifact.status) === false && isDetachedRunAlive(artifact, options)) {
        return true;
      }
    } catch {
      // Fall back to the lock-local owner identity below.
    }
  }

  const processIdentities = mergeProcessIdentities([
    ...(metadata.processIdentity === undefined ? [] : [metadata.processIdentity]),
    ...(metadata.processGroupIdentities ?? []),
  ]);
  if (processIdentities.length > 0) {
    return processIdentities.some((identity) => {
      const matchState = getProcessIdentityMatchState(identity, options);
      return matchState === "match" || matchState === "unavailable";
    });
  }

  return isPidAlive(metadata.pid);
}

function removeArtifactWriteLockSnapshot(lockPath: string, snapshot: ArtifactWriteLockSnapshot): boolean {
  const reclaimedPath = `${lockPath}.reclaimed-${process.pid}-${dayjs().valueOf()}-${Math.random().toString(16).slice(2)}`;
  try {
    renameSync(lockPath, reclaimedPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }

  const reclaimedSnapshot = readArtifactWriteLockSnapshot(reclaimedPath);
  const reclaimedMatches = reclaimedSnapshot !== undefined
    && reclaimedSnapshot.dev === snapshot.dev
    && reclaimedSnapshot.ino === snapshot.ino
    && reclaimedSnapshot.source === snapshot.source
    && (
      snapshot.metadata.lockToken === undefined
      || reclaimedSnapshot.metadata.lockToken === snapshot.metadata.lockToken
    );
  if (reclaimedMatches) {
    rmSync(reclaimedPath, { force: true });
    return true;
  }

  try {
    if (existsSync(lockPath) === false) {
      renameSync(reclaimedPath, lockPath);
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "EEXIST") {
      throw error;
    }
  }

  return false;
}

function reclaimStaleDetachedRunArtifactWriteLock(lockPath: string, options: ArtifactWriteLockOptions = {}): boolean {
  return withDetachedRunArtifactWriteLockReclamationMutex(lockPath, () => {
    return reclaimStaleDetachedRunArtifactWriteLockWithMutex(lockPath, options);
  }, options);
}

function reclaimStaleDetachedRunArtifactWriteLockWithMutex(lockPath: string, options: ArtifactWriteLockOptions = {}): boolean {
  if (existsSync(lockPath) === false) {
    return false;
  }

  const snapshot = readArtifactWriteLockSnapshot(lockPath);
  if (
    snapshot !== undefined
    && artifactWriteLockOwnerIsAlive(snapshot.metadata, options.processIdentityProbeOptions) === false
    && artifactWriteLockSnapshotStillMatches(lockPath, snapshot)
  ) {
    return removeArtifactWriteLockSnapshot(lockPath, snapshot);
  }

  return false;
}

function reclaimStaleDetachedRunArtifactWriteLockReclamationMutex(
  mutexPath: string,
  options: ArtifactWriteLockOptions = {},
): boolean {
  const guardPath = `${mutexPath}.takeover.lock`;
  if (claimDetachedRunArtifactWriteLockFile(guardPath, options) === false) {
    reclaimStaleDetachedRunArtifactWriteLockWithMutex(guardPath, options);
    if (claimDetachedRunArtifactWriteLockFile(guardPath, options) === false) {
      return false;
    }
  }

  try {
    return reclaimStaleDetachedRunArtifactWriteLockWithMutex(mutexPath, options);
  } finally {
    removeOwnedDetachedRunArtifactWriteLock(guardPath);
  }
}

function buildArtifactWriteLockOwnerMetadata(options: ArtifactWriteLockOptions = {}): ArtifactWriteLockMetadata {
  const startedAt = dayjs().toISOString();
  const processIdentity = getProcessIdentity(process.pid, options.processIdentityProbeOptions);
  return {
    lockToken: randomUUID(),
    pid: process.pid,
    processIdentity,
    startedAt,
  };
}

function claimDetachedRunArtifactWriteLockFile(
  lockPath: string,
  options: ArtifactWriteLockOptions = {},
  metadata?: ArtifactWriteLockMetadata,
): boolean {
  const temporaryPath = `${lockPath}.tmp-${process.pid}-${dayjs().valueOf()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(temporaryPath, JSON.stringify(metadata ?? buildArtifactWriteLockOwnerMetadata(options)));
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

function claimDetachedRunArtifactWriteLock(lockPath: string, options: ArtifactWriteLockOptions = {}): boolean {
  return withDetachedRunArtifactWriteLockReclamationMutex(lockPath, () => {
    return claimDetachedRunArtifactWriteLockFile(lockPath, options);
  }, options);
}

function claimDetachedRunArtifactWriteLockWithMetadata(lockPath: string, metadata: ArtifactWriteLockMetadata): boolean {
  return withDetachedRunArtifactWriteLockReclamationMutex(lockPath, () => {
    return claimDetachedRunArtifactWriteLockFile(lockPath, {}, metadata);
  });
}

function claimDetachedRunPathOwnership(
  description: string,
  displayPath: string,
  lockPaths: string[],
): DetachedRunPathClaim {
  const metadata = {
    ...buildArtifactWriteLockOwnerMetadata(),
    additionalLockPaths: lockPaths.length > 1 ? lockPaths : undefined,
  };
  const claimedLockPaths: string[] = [];
  try {
    lockPaths.forEach((lockPath) => {
      mkdirSync(path.dirname(lockPath), { recursive: true });
      let lockClaimed = false;
      try {
        lockClaimed = claimDetachedRunArtifactWriteLockWithMetadata(lockPath, metadata);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw error;
        }
      }
      if (lockClaimed === false) {
        reclaimStaleDetachedRunArtifactWriteLock(lockPath);
        try {
          lockClaimed = claimDetachedRunArtifactWriteLockFile(lockPath, {}, metadata);
        } catch (error) {
          if (errorCode(error) !== "EEXIST") {
            throw error;
          }
        }
      }
      if (lockClaimed === false) {
        throw new Error(`Detached run already active for ${description} ${path.resolve(displayPath)}.`);
      }
      claimedLockPaths.push(lockPath);
    });
  } catch (error) {
    claimedLockPaths.forEach((lockPath) => {
      removeOwnedDetachedRunArtifactWriteLock(lockPath);
    });
    throw error;
  }

  return {
    lockPaths,
    metadata,
  };
}

function claimAdditionalDetachedRunPathOwnership(
  description: string,
  displayPath: string,
  claim: DetachedRunPathClaim,
  additionalLockPaths: string[],
): DetachedRunPathClaim {
  const newLockPaths = additionalLockPaths.filter((lockPath) => claim.lockPaths.includes(lockPath) === false);
  if (newLockPaths.length === 0) {
    return claim;
  }

  const nextLockPaths = [...claim.lockPaths, ...newLockPaths];
  const nextMetadata = {
    ...claim.metadata,
    additionalLockPaths: nextLockPaths.length > 1 ? nextLockPaths : undefined,
  };
  const claimedLockPaths: string[] = [];
  try {
    newLockPaths.forEach((lockPath) => {
      mkdirSync(path.dirname(lockPath), { recursive: true });
      let lockClaimed = false;
      try {
        lockClaimed = claimDetachedRunArtifactWriteLockWithMetadata(lockPath, nextMetadata);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw error;
        }
      }
      if (lockClaimed === false) {
        reclaimStaleDetachedRunArtifactWriteLock(lockPath);
        try {
          lockClaimed = claimDetachedRunArtifactWriteLockFile(lockPath, {}, nextMetadata);
        } catch (error) {
          if (errorCode(error) !== "EEXIST") {
            throw error;
          }
        }
      }
      if (lockClaimed === false) {
        throw new Error(`Detached run already active for ${description} ${path.resolve(displayPath)}.`);
      }
      claimedLockPaths.push(lockPath);
    });
    replaceDetachedRunPathClaimOwner({ lockPaths: nextLockPaths, metadata: claim.metadata }, displayPath, description, nextMetadata);
    return {
      lockPaths: nextLockPaths,
      metadata: nextMetadata,
    };
  } catch (error) {
    claimedLockPaths.forEach((lockPath) => {
      removeOwnedDetachedRunArtifactWriteLock(lockPath);
    });
    throw error;
  }
}

function claimDetachedRunResultPath(resultPath: string): DetachedRunPathClaim {
  return claimDetachedRunPathOwnership(
    "result artifact",
    resultPath,
    buildDetachedRunResultClaimPaths(resultPath),
  );
}

function claimDetachedRunLogPath(description: string, logPath: string): DetachedRunPathClaim {
  return claimDetachedRunPathOwnership(
    description,
    logPath,
    buildDetachedRunLogClaimPaths(description, logPath),
  );
}

function claimDetachedRunLogFileIdentityPath(
  description: string,
  logPath: string,
  claim: DetachedRunPathClaim,
): DetachedRunPathClaim {
  const identityClaimPath = buildDetachedRunFileIdentityClaimPath(description, logPath);
  return identityClaimPath === undefined
    ? claim
    : claimAdditionalDetachedRunPathOwnership(description, logPath, claim, [identityClaimPath]);
}

function claimDetachedRunPhasePath(phasePath: string): DetachedRunPathClaim {
  return claimDetachedRunPathOwnership(
    "phase artifact",
    phasePath,
    buildDetachedRunPhaseClaimPaths(phasePath),
  );
}

export async function withDetachedRunResultClaim<T>(resultPath: string, operation: () => Promise<T>): Promise<T> {
  const claim = claimDetachedRunResultPath(resultPath);
  try {
    return await operation();
  } finally {
    removeOwnedDetachedRunPathClaim(claim);
  }
}

function replaceDetachedRunPathClaimOwner(
  claim: DetachedRunPathClaim,
  displayPath: string,
  label: string,
  nextMetadata: ArtifactWriteLockMetadata,
): void {
  claim.lockPaths.forEach((lockPath) => {
    const snapshot = readArtifactWriteLockSnapshot(lockPath);
    if (snapshot?.metadata.lockToken !== claim.metadata.lockToken) {
      throw new Error(`Detached ${label} ownership lock changed before launch completed for ${path.resolve(displayPath)}.`);
    }

    const temporaryPath = `${lockPath}.tmp-${process.pid}-${dayjs().valueOf()}-${Math.random().toString(16).slice(2)}`;
    writeFileSync(temporaryPath, JSON.stringify({
      ...nextMetadata,
      additionalLockPaths: claim.lockPaths.length > 1 ? claim.lockPaths : undefined,
    }));
    try {
      renameSync(temporaryPath, lockPath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  });
}

function replaceDetachedRunResultClaimOwner(
  resultPath: string,
  previousClaim: DetachedRunPathClaim,
  nextMetadata: ArtifactWriteLockMetadata,
): void {
  replaceDetachedRunPathClaimOwner(previousClaim, resultPath, "result artifact", nextMetadata);
}

function replaceDetachedRunPhaseClaimOwner(
  phasePath: string,
  previousClaim: DetachedRunPathClaim,
  nextMetadata: ArtifactWriteLockMetadata,
): void {
  replaceDetachedRunPathClaimOwner(previousClaim, phasePath, "phase artifact", nextMetadata);
}

function artifactWriteClaimBelongsToArtifact(
  artifact: DetachedRunArtifact,
  metadata: ArtifactWriteLockMetadata,
): boolean {
  const hasRunBinding = metadata.artifactPath !== undefined
    || metadata.startedAt !== undefined
    || metadata.processIdentity !== undefined
    || (metadata.processGroupIdentities ?? []).length > 0;
  const artifactIdentities = getOwnedProcessGroupIdentities(artifact);
  if (hasRunBinding) {
    if (metadata.artifactPath !== undefined && path.resolve(metadata.artifactPath) !== path.resolve(artifact.artifactPath)) {
      return false;
    }
    if (metadata.startedAt !== undefined && metadata.startedAt !== artifact.startedAt) {
      return false;
    }
    if (metadata.processIdentity !== undefined) {
      return artifactIdentities.some((identity) => sameProcessIdentity(identity, metadata.processIdentity as DetachedProcessIdentity));
    }
    if ((metadata.processGroupIdentities ?? []).length > 0) {
      return (metadata.processGroupIdentities ?? []).some((metadataIdentity) => {
        return artifactIdentities.some((artifactIdentity) => sameProcessIdentity(artifactIdentity, metadataIdentity));
      });
    }
    return true;
  }

  return metadata.pid === artifact.pid;
}

function claimDetachedRunFileIdentityForArtifact(
  artifact: DetachedRunArtifact,
  description: string,
  filePath: string,
  primaryClaimPath: string,
  expectedStats: Pick<Stats, "dev" | "ino">,
): string | undefined {
  const identityClaimPath = buildDetachedRunFileIdentityClaimPathForStats(expectedStats);
  try {
    withDetachedRunArtifactWriteLockReclamationMutex(primaryClaimPath, () => {
      const snapshot = readArtifactWriteLockSnapshot(primaryClaimPath);
      if (snapshot === undefined || artifactWriteClaimBelongsToArtifact(artifact, snapshot.metadata) === false) {
        throw new Error(`${description} ownership lock ${primaryClaimPath} no longer belongs to this detached run.`);
      }
      if (currentRegularFileMatchesIdentity(filePath, expectedStats) === false) {
        throw new Error(`${description} ${path.resolve(filePath)} changed before its file-identity claim was acquired.`);
      }
      const lockPaths = snapshot.metadata.additionalLockPaths ?? [primaryClaimPath];
      if (lockPaths.includes(identityClaimPath)) {
        if (currentRegularFileMatchesIdentity(filePath, expectedStats) === false) {
          throw new Error(`${description} ${path.resolve(filePath)} changed before its file-identity claim was verified.`);
        }
        return;
      }
      claimAdditionalDetachedRunPathOwnership(description, filePath, {
        lockPaths,
        metadata: snapshot.metadata,
      }, [identityClaimPath]);
      if (currentRegularFileMatchesIdentity(filePath, expectedStats) === false) {
        throw new Error(`${description} ${path.resolve(filePath)} changed after its file-identity claim was acquired.`);
      }
    });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Could not claim ${description} file identity for ${filePath}: ${message}`;
  }
}

function claimDetachedRunResultFileIdentityForArtifact(
  artifact: DetachedRunArtifact,
  resultPath: string,
  expectedStats: Pick<Stats, "dev" | "ino">,
): string | undefined {
  return claimDetachedRunFileIdentityForArtifact(
    artifact,
    "result artifact",
    resultPath,
    buildDetachedRunResultClaimPath(resultPath),
    expectedStats,
  );
}

function claimDetachedRunPhaseFileIdentityForArtifact(
  artifact: DetachedRunArtifact,
  phasePath: string,
  expectedStats: Pick<Stats, "dev" | "ino">,
): string | undefined {
  const primaryClaimPath = buildDetachedRunPhaseClaimPath(phasePath);
  if (readArtifactWriteLockSnapshot(primaryClaimPath) === undefined) {
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

function removeDetachedRunResultClaimForArtifact(artifact: DetachedRunArtifact): void {
  if (artifact.resultPath === undefined) {
    return;
  }

  const lockPath = buildDetachedRunResultClaimPath(artifact.resultPath);
  const primarySnapshot = readArtifactWriteLockSnapshot(lockPath);
  const lockPaths = primarySnapshot?.metadata.additionalLockPaths ?? [lockPath];
  removeDetachedRunPathClaimsForArtifact(artifact, lockPaths);
}

function removeDetachedRunLogClaimForArtifact(artifact: DetachedRunArtifact, logPath: string): void {
  const primaryLockPath = buildDetachedRunLogClaimPath(logPath);
  const primarySnapshot = readArtifactWriteLockSnapshot(primaryLockPath);
  const lockPaths = primarySnapshot?.metadata.additionalLockPaths ?? [primaryLockPath];
  removeDetachedRunPathClaimsForArtifact(artifact, lockPaths);
}

function removeDetachedRunLogClaimsForArtifact(artifact: DetachedRunArtifact): void {
  removeDetachedRunLogClaimForArtifact(artifact, artifact.stderrPath);
  removeDetachedRunLogClaimForArtifact(artifact, artifact.stdoutPath);
}

function removeDetachedRunPathClaimsForArtifact(artifact: DetachedRunArtifact, lockPaths: string[]): void {
  lockPaths.forEach((lockPath) => {
    withDetachedRunArtifactWriteLockReclamationMutex(lockPath, () => {
      const snapshot = readArtifactWriteLockSnapshot(lockPath);
      if (snapshot === undefined) {
        return;
      }

      const metadata = snapshot.metadata;
      if (
        artifactWriteClaimBelongsToArtifact(artifact, metadata)
        && artifactWriteLockSnapshotStillMatches(lockPath, snapshot)
      ) {
        removeArtifactWriteLockSnapshot(lockPath, snapshot);
      }
    });
  });
}

function removeDetachedRunPhaseClaimForArtifact(artifact: DetachedRunArtifact): void {
  if (artifact.phasePath === undefined) {
    return;
  }

  const lockPath = buildDetachedRunPhaseClaimPath(artifact.phasePath);
  const primarySnapshot = readArtifactWriteLockSnapshot(lockPath);
  const lockPaths = primarySnapshot?.metadata.additionalLockPaths ?? [lockPath];
  removeDetachedRunPathClaimsForArtifact(artifact, lockPaths);
}

function resultPathCanBeQuarantinedByArtifact(artifact: DetachedRunArtifact, resultPath: string): boolean {
  const lockPath = buildDetachedRunResultClaimPath(resultPath);
  const snapshot = readArtifactWriteLockSnapshot(lockPath);
  if (snapshot === undefined) {
    return false;
  }

  return artifactWriteClaimBelongsToArtifact(artifact, snapshot.metadata)
    && artifactWriteLockSnapshotStillMatches(lockPath, snapshot);
}

function resultPathHasOwnedPrimaryClaim(artifact: DetachedRunArtifact, resultPath: string): boolean {
  const lockPath = buildDetachedRunResultClaimPath(resultPath);
  const snapshot = readArtifactWriteLockSnapshot(lockPath);
  if (snapshot === undefined) {
    return false;
  }

  return artifactWriteClaimBelongsToArtifact(artifact, snapshot.metadata)
    && artifactWriteLockSnapshotStillMatches(lockPath, snapshot);
}

function withDetachedRunArtifactWriteLockReclamationMutex<T>(
  lockPath: string,
  operation: () => T,
  options: ArtifactWriteLockOptions = {},
): T {
  const mutexPath = `${lockPath}.reclaim.lock`;
  const deadline = Date.now() + ARTIFACT_WRITE_LOCK_TIMEOUT_MS;
  let mutexClaimed = false;
  while (mutexClaimed === false) {
    try {
      mkdirSync(path.dirname(mutexPath), { recursive: true });
      mutexClaimed = claimDetachedRunArtifactWriteLockFile(mutexPath, options);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
    if (mutexClaimed === false) {
      if (reclaimStaleDetachedRunArtifactWriteLockReclamationMutex(mutexPath, options)) {
        continue;
      }
      if (Date.now() >= deadline) {
        const error = new Error(`EEXIST: file already exists, open '${mutexPath}'`);
        (error as NodeJS.ErrnoException).code = "EEXIST";
        throw error;
      }
      sleepSync(ARTIFACT_WRITE_LOCK_RETRY_MS);
    }
  }

  try {
    return operation();
  } finally {
    removeOwnedDetachedRunArtifactWriteLock(mutexPath);
  }
}

function removeOwnedDetachedRunArtifactWriteLock(lockPath: string): void {
  const metadata = readArtifactWriteLockMetadata(lockPath);
  if (metadata?.pid === process.pid) {
    rmSync(lockPath, { force: true });
  }
}

function removeOwnedDetachedRunPathClaim(claim: DetachedRunPathClaim): void {
  claim.lockPaths.forEach((lockPath) => {
    removeOwnedDetachedRunArtifactWriteLock(lockPath);
  });
}

export async function withDetachedRunLaunchClaim<T>(artifactPath: string, launch: () => Promise<T>): Promise<T> {
  const lockPath = `${path.resolve(artifactPath)}.launch.lock`;
  const deadline = Date.now() + ARTIFACT_WRITE_LOCK_TIMEOUT_MS;
  let lockClaimed = false;
  while (lockClaimed === false) {
    try {
      mkdirSync(path.dirname(lockPath), { recursive: true });
      lockClaimed = claimDetachedRunArtifactWriteLock(lockPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
    if (lockClaimed === false) {
      if (Date.now() >= deadline) {
        const error = new Error(`EEXIST: file already exists, open '${lockPath}'`);
        (error as NodeJS.ErrnoException).code = "EEXIST";
        throw error;
      }
      reclaimStaleDetachedRunArtifactWriteLock(lockPath);
      await sleep(ARTIFACT_WRITE_LOCK_RETRY_MS);
    }
  }

  try {
    return await launch();
  } finally {
    removeOwnedDetachedRunArtifactWriteLock(lockPath);
  }
}

export function withDetachedRunLaunchClaimSync<T>(
  artifactPath: string,
  launch: () => T,
): { acquired: false } | { acquired: true; value: T } {
  const lockPath = `${path.resolve(artifactPath)}.launch.lock`;
  let lockClaimed = false;
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
      lockClaimed = claimDetachedRunArtifactWriteLock(lockPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
    if (lockClaimed === false) {
      reclaimStaleDetachedRunArtifactWriteLock(lockPath);
      try {
        lockClaimed = claimDetachedRunArtifactWriteLock(lockPath);
      } catch (retryError) {
        if (errorCode(retryError) === "EEXIST") {
          return { acquired: false };
        }
        throw retryError;
      }
    }
    if (lockClaimed === false) {
      return { acquired: false };
    }
    return {
      acquired: true,
      value: launch(),
    };
  } finally {
    if (lockClaimed) {
      removeOwnedDetachedRunArtifactWriteLock(lockPath);
    }
  }
}

export function detachedRunLaunchClaimIsActive(artifactPath: string): boolean {
  const lockPath = `${path.resolve(artifactPath)}.launch.lock`;
  if (existsSync(lockPath) === false) {
    return false;
  }

  reclaimStaleDetachedRunArtifactWriteLock(lockPath);
  return existsSync(lockPath);
}

function detachedRunLaunchClaimBelongsToCurrentProcess(artifactPath: string): boolean {
  const lockPath = `${path.resolve(artifactPath)}.launch.lock`;
  return readArtifactWriteLockMetadata(lockPath)?.pid === process.pid;
}

function withDetachedRunArtifactWriteLock<T>(
  artifactPath: string,
  write: () => T,
  options: ArtifactWriteLockOptions = {},
): T {
  const lockPath = `${artifactPath}.lock`;
  const deadline = Date.now() + ARTIFACT_WRITE_LOCK_TIMEOUT_MS;
  let lockClaimed = false;
  while (lockClaimed === false) {
    try {
      lockClaimed = claimDetachedRunArtifactWriteLock(lockPath, options);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
    if (lockClaimed === false) {
      if (Date.now() >= deadline) {
        const error = new Error(`EEXIST: file already exists, open '${lockPath}'`);
        (error as NodeJS.ErrnoException).code = "EEXIST";
        throw error;
      }
      reclaimStaleDetachedRunArtifactWriteLock(lockPath, options);
      sleepSync(ARTIFACT_WRITE_LOCK_RETRY_MS);
    }
  }

  try {
    return write();
  } finally {
    removeOwnedDetachedRunArtifactWriteLock(lockPath);
  }
}

function makeFailedToStartArtifact(
  input: StartDetachedRunInput,
  artifactPath: string,
  cwd: string,
  deadlineAt: string | undefined,
  failureReason: string,
  failedAt: string,
  logPaths: { stderr: string; stdout: string },
  resumeCommand: string,
  resultPath: string,
  startedAt: string,
  statusCommand: string,
): DetachedRunArtifact {
  return {
    artifactPath,
    command: formatDetachedCommandForPlatform(input),
    commentaryPolicy: input.commentaryPolicy ?? "event-only",
    cwd,
    deadlineAt,
    failureReason,
    finishedAt: failedAt,
    lastMaterialEvent: {
      at: failedAt,
      status: "failed-to-start",
      type: "failed-to-start",
    },
    logPaths,
    logLimitBytes: input.logLimitBytes ?? DETACHED_LOG_LIMIT_BYTES,
    phasePath: input.phasePath === undefined ? undefined : path.resolve(input.phasePath),
    pid: 0,
    resultReadLimitBytes: input.resultReadLimitBytes,
    resultPath,
    resumeCommand,
    startedAt,
    status: "failed-to-start",
    statusCommand,
    statusUpdatedAt: failedAt,
    stderrPath: logPaths.stderr,
    stdoutPath: logPaths.stdout,
    timeoutMs: input.timeoutMs,
    version: 1,
  };
}

function makeCompletedStartupArtifact(
  input: StartDetachedRunInput,
  artifactPath: string,
  cwd: string,
  deadlineAt: string | undefined,
  finishedAt: string,
  logPaths: { stderr: string; stdout: string },
  pid: number,
  resultPath: string,
  resultStatus: { failureReason?: string; status: "failed" | "passed" },
  resumeCommand: string,
  startedAt: string,
  statusCommand: string,
): DetachedRunArtifact {
  return {
    artifactPath,
    command: formatDetachedCommandForPlatform(input),
    commentaryPolicy: input.commentaryPolicy ?? "event-only",
    cwd,
    deadlineAt,
    failureReason: resultStatus.failureReason,
    finishedAt,
    lastMaterialEvent: {
      at: finishedAt,
      status: resultStatus.status,
      type: resultStatus.status,
    },
    logPaths,
    logLimitBytes: input.logLimitBytes ?? DETACHED_LOG_LIMIT_BYTES,
    phasePath: input.phasePath === undefined ? undefined : path.resolve(input.phasePath),
    pid,
    processGroupId: pid,
    resultReadLimitBytes: input.resultReadLimitBytes,
    resultPath,
    resumeCommand,
    startedAt,
    status: resultStatus.status,
    statusCommand,
    statusUpdatedAt: finishedAt,
    stderrPath: logPaths.stderr,
    stdoutPath: logPaths.stdout,
    timeoutMs: input.timeoutMs,
    version: 1,
  };
}

function makeProcessExitedWithoutResultStartupArtifact(
  input: StartDetachedRunInput,
  artifactPath: string,
  cwd: string,
  deadlineAt: string | undefined,
  exitedAt: string,
  logPaths: { stderr: string; stdout: string },
  pid: number,
  resumeCommand: string,
  resultPath: string,
  startedAt: string,
  statusCommand: string,
): DetachedRunArtifact {
  return {
    artifactPath,
    command: formatDetachedCommandForPlatform(input),
    commentaryPolicy: input.commentaryPolicy ?? "event-only",
    cwd,
    deadlineAt,
    failureReason: "Process is no longer alive and no result artifact was found.",
    finishedAt: exitedAt,
    lastMaterialEvent: {
      at: exitedAt,
      status: "process-exited-without-result",
      type: "process-exited-without-result",
    },
    logPaths,
    logLimitBytes: input.logLimitBytes ?? DETACHED_LOG_LIMIT_BYTES,
    phasePath: input.phasePath === undefined ? undefined : path.resolve(input.phasePath),
    pid,
    processGroupId: pid,
    resultReadLimitBytes: input.resultReadLimitBytes,
    resultPath,
    resumeCommand,
    startedAt,
    status: "process-exited-without-result",
    statusCommand,
    statusUpdatedAt: exitedAt,
    stderrPath: logPaths.stderr,
    stdoutPath: logPaths.stdout,
    timeoutMs: input.timeoutMs,
    version: 1,
  };
}

function makeEventForStatus(status: DetachedRunStatus): DetachedRunMaterialEvent {
  if (status === "running") {
    return "started";
  }

  return status;
}

function makeStatusMessage(artifact: DetachedRunArtifact, event: DetachedRunMaterialEvent): string {
  if (event === "phase-change") {
    return `Detached run phase changed to ${artifact.phase ?? "unknown"}.`;
  }

  if (artifact.status === "passed") {
    return "Detached run passed.";
  }

  if (artifact.status === "failed") {
    return "Detached run failed.";
  }

  if (artifact.status === "failed-to-start") {
    return "Detached run failed to start.";
  }

  if (artifact.status === "process-exited-without-result") {
    return "Detached run process exited without a result artifact.";
  }

  if (artifact.status === "timeout") {
    return "Detached run timed out.";
  }

  return "Detached run started.";
}

function readJsonFile<T>(filePath: string, description = "JSON file"): T {
  const source = readRegularFileSnapshot(filePath, description).source.toString("utf8");
  return JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source) as T;
}

function readPhaseArtifactSnapshotForRun(artifact: DetachedRunArtifact): RegularFileSnapshot | undefined {
  if (artifact.phasePath === undefined || existsSync(artifact.phasePath) === false) {
    return undefined;
  }

  let snapshot: RegularFileSnapshot;
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
  if (
    matchesBaselineMetadata
    && baselineContentChanged === false
  ) {
    return undefined;
  }

  const claimFailureReason = claimDetachedRunPhaseFileIdentityForArtifact(artifact, artifact.phasePath, snapshot);
  if (claimFailureReason !== undefined) {
    return undefined;
  }

  const startedAtMs = dayjs(artifact.startedAt).valueOf();
  if (Number.isFinite(startedAtMs) === false) {
    return snapshot;
  }

  return baseline?.existed === false || baselineContentChanged || snapshot.mtimeMs >= startedAtMs
    ? snapshot
    : undefined;
}

function readPhase(artifact: DetachedRunArtifact): string | undefined {
  const snapshot = readPhaseArtifactSnapshotForRun(artifact);
  const source = snapshot?.source.toString("utf8").trim() ?? "";
  if (source.length === 0) {
    return undefined;
  }

  try {
    const payload = JSON.parse(source) as unknown;
    if (typeof payload === "object" && payload !== null && "phase" in payload) {
      const candidatePhase = payload.phase;
      return typeof candidatePhase === "string" && candidatePhase.trim().length > 0
        ? candidatePhase.trim()
        : undefined;
    }
  } catch {
    // Plain text phase files are supported for simple shell-driven workflows.
  }

  return source;
}

function parseResultStatus(resultPath: string, source: string): { failureReason?: string; status: "failed" | "passed" | "unknown" } {
  try {
    const payload = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source) as unknown;
    if (typeof payload === "object" && payload !== null && "passed" in payload) {
      const passed = payload.passed;
      if (passed === true) {
        return { status: "passed" };
      }
      if (passed === false) {
        return { status: "failed" };
      }
    }
    return {
      failureReason: `Result artifact ${resultPath} does not expose a boolean passed field.`,
      status: "unknown",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      failureReason: `Could not read result artifact ${resultPath}: ${message}`,
      status: "unknown",
    };
  }
}

function getResultArtifactReadLimitBytes(artifact: DetachedRunArtifact): number {
  const requestedLimit = artifact.resultReadLimitBytes;
  return Number.isFinite(requestedLimit) && requestedLimit !== undefined && requestedLimit > 0
    ? Math.max(DETACHED_PROTOCOL_ARTIFACT_READ_LIMIT_BYTES, Math.trunc(requestedLimit))
    : DETACHED_PROTOCOL_ARTIFACT_READ_LIMIT_BYTES;
}

function readResultArtifactSnapshot(
  resultPath: string,
  readLimitBytes = DETACHED_PROTOCOL_ARTIFACT_READ_LIMIT_BYTES,
): ResultArtifactSnapshot | undefined {
  let fd: number | undefined;
  try {
    const pathStats = lstatSync(resultPath);
    if (pathStats.isFile() === false) {
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
    fd = openSync(resultPath, constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW_OPEN_FLAG);
    const stats = fstatSync(fd, { bigint: false });
    if (stats.isFile() === false) {
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

function readResultStatusSnapshot(artifact: DetachedRunArtifact, resultPath: string): ResultArtifactStatusSnapshot | undefined {
  const snapshot = readResultArtifactSnapshot(resultPath, getResultArtifactReadLimitBytes(artifact));
  if (snapshot === undefined || resultArtifactBelongsToRun(artifact, resultPath, snapshot.stats, snapshot.source, snapshot.sha256) === false) {
    return undefined;
  }
  if (snapshot.failureReason !== undefined) {
    return {
      failureReason: snapshot.failureReason,
      resultPath,
      status: "unknown",
    };
  }
  if (resultPathHasOwnedPrimaryClaim(artifact, resultPath) === false) {
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

function resultArtifactBelongsToRun(
  artifact: DetachedRunArtifact,
  resultPath: string,
  stats: Pick<Stats, "ctimeMs" | "dev" | "ino" | "mtimeMs" | "size">,
  source: string,
  sha256?: string,
): boolean {
  const matchingBaseline = artifact.resultArtifactBaselines?.find((baseline) => baseline.path === resultPath);
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
    ? baselineSha256 !== undefined && (sha256 ?? getFileSha256(resultPath)) !== baselineSha256
    : hasComparableBaseline && stats.size !== baselineSize;
  if (
    matchesBaselineMetadata
    && baselineContentChanged === false
  ) {
    return false;
  }
  if (sha256?.startsWith("non-regular:") === true) {
    return true;
  }

  if (resultArtifactHasTrustedPreDeadlineBoundary(artifact, stats, source) === false) {
    return false;
  }

  const startedAtMs = dayjs(artifact.startedAt).valueOf();
  if (Number.isFinite(startedAtMs) === false) {
    return true;
  }

  return baselineContentChanged || matchingBaseline?.existed === false || stats.mtimeMs >= startedAtMs;
}

function resultArtifactHasTrustedPreDeadlineBoundary(
  artifact: DetachedRunArtifact,
  stats: { ctimeMs: number; mtimeMs: number },
  source: string,
): boolean {
  const deadlineAtMs = artifact.deadlineAt === undefined ? Number.NaN : dayjs(artifact.deadlineAt).valueOf();
  if (Number.isFinite(deadlineAtMs) === false) {
    return true;
  }

  if (Number.isFinite(stats.mtimeMs) === false || stats.mtimeMs >= deadlineAtMs) {
    return false;
  }
  if (stats.mtimeMs % 1000 === 0 && deadlineAtMs - stats.mtimeMs < 1000) {
    return false;
  }

  try {
    const payload = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source) as unknown;
    if (typeof payload === "object" && payload !== null && "generatedAt" in payload) {
      const generatedAt = payload.generatedAt;
      const generatedAtMs = typeof generatedAt === "string" ? dayjs(generatedAt).valueOf() : Number.NaN;
      if (Number.isFinite(generatedAtMs)) {
        return generatedAtMs < deadlineAtMs;
      }
    }
  } catch {
    // Malformed result artifacts are still reported, but cannot prove freshness.
  }

  return true;
}

function quarantineLateResultArtifacts(artifact: DetachedRunArtifact): void {
  const deadlineAtMs = artifact.deadlineAt === undefined ? Number.NaN : dayjs(artifact.deadlineAt).valueOf();
  if (Number.isFinite(deadlineAtMs) === false) {
    return;
  }

  withDetachedRunArtifactWriteLock(artifact.artifactPath, () => {
    if (existsSync(artifact.artifactPath) === false) {
      return;
    }
    const latestArtifact = readJsonFile<DetachedRunArtifact>(artifact.artifactPath);
    if (sameDetachedRunIdentity(latestArtifact, artifact) === false) {
      return;
    }

    buildQuarantinableResultArtifactCandidatePaths(artifact.artifactPath, artifact.resultPath)
      .forEach((candidate) => {
        if (existsSync(candidate) === false) {
          return;
        }

        const snapshot = readResultArtifactSnapshot(candidate, getResultArtifactReadLimitBytes(artifact));
        if (snapshot === undefined) {
          return;
        }
        if (resultArtifactHasTrustedPreDeadlineBoundary(artifact, snapshot.stats, snapshot.source)) {
          return;
        }
        if (resultPathCanBeQuarantinedByArtifact(artifact, candidate) === false) {
          return;
        }

        const quarantinePath = `${candidate}.late-${process.pid}-${Date.now()}.quarantined`;
        try {
          renameSync(candidate, quarantinePath);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") {
            throw error;
          }
        }
      });
  });
}

function startDetachedTimeoutWatchdog(artifact: DetachedRunArtifact): number | undefined {
  if (artifact.deadlineAt === undefined || artifact.timeoutMs === undefined || isTerminalStatus(artifact.status)) {
    return undefined;
  }

  const delayMs = Math.max(0, dayjs(artifact.deadlineAt).diff(dayjs(), "millisecond") + WATCHDOG_STATUS_GRACE_MS);
  const watchdogScriptPath = writeDetachedTimeoutWatchdogScript(artifact.artifactPath);
  const child = spawn(process.execPath, [
    watchdogScriptPath,
    artifact.artifactPath,
    String(delayMs),
    String(artifact.pid),
    artifact.startedAt,
  ], {
    detached: process.platform !== "win32",
    env: process.env,
    stdio: "ignore",
  });

  child.once("error", (error) => {
    recordDetachedWatchdogStartupFailure(artifact, error);
  });
  if (child.pid === undefined) {
    throw new Error("Detached timeout watchdog failed to start: child process id was not exposed.");
  }
  child.unref();

  return child.pid;
}

function writeDetachedTimeoutWatchdogScript(artifactPath: string): string {
  const watchdogScriptPath = buildDetachedRunWatchdogScriptPath(artifactPath);
  writeDetachedProtocolFile(watchdogScriptPath, DETACHED_TIMEOUT_WATCHDOG_SCRIPT, 0o600);

  return watchdogScriptPath;
}

function writeDetachedProtocolFile(filePath: string, source: string, mode = 0o600): void {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    writeFileSync(temporaryPath, source, { flag: "wx", mode });
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function writeDetachedBoundedLogScript(artifactPath: string): string {
  const boundedLogScriptPath = buildDetachedRunBoundedLogScriptPath(artifactPath);
  writeDetachedProtocolFile(boundedLogScriptPath, DETACHED_BOUNDED_LOG_SCRIPT, 0o600);

  return boundedLogScriptPath;
}

function recordDetachedWatchdogStartupFailure(artifact: DetachedRunArtifact, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const cleanupSucceeded = terminateDetachedProcess(artifact);
  const failedAt = dayjs().toISOString();
  if (cleanupSucceeded === false) {
    writeDetachedRunArtifact(artifact.artifactPath, {
      ...artifact,
      failureReason: `Detached timeout watchdog failed to start and cleanup could not confirm termination: ${message}`,
      lastObservedAt: failedAt,
      status: "running",
      statusUpdatedAt: failedAt,
    });
    return;
  }

  writeDetachedRunArtifact(artifact.artifactPath, {
    ...artifact,
    failureReason: `Detached timeout watchdog failed to start: ${message}`,
    finishedAt: failedAt,
    lastMaterialEvent: {
      at: failedAt,
      phase: artifact.phase,
      status: "failed-to-start",
      type: "failed-to-start",
    },
    lastObservedAt: failedAt,
    status: "failed-to-start",
    statusUpdatedAt: failedAt,
  });
}

function terminateDetachedProcess(artifact: DetachedRunArtifact): boolean {
  let terminationArtifact = refreshProcessGroupIdentitiesWhileLeaderAlive(artifact);
  if (isDetachedRunAlive(terminationArtifact) === false) {
    return true;
  }

  const processGroupId = terminationArtifact.processGroupId ?? terminationArtifact.pid;
  if (process.platform === "win32") {
    const exactIdentities = getOwnedProcessGroupIdentities(terminationArtifact)
      .filter((identity) => processIdentityMatchesExactly(identity));
    exactIdentities.forEach((identity) => {
      terminateWindowsProcessTree(identity.pid);
    });
    sleepSync(DETACHED_TERMINATION_GRACE_MS);
    exactIdentities.forEach((identity) => {
      terminateWindowsProcessTree(identity.pid, true);
    });
    terminationArtifact = refreshProcessGroupIdentitiesWhileLeaderAlive(terminationArtifact);
    return isDetachedRunAlive(terminationArtifact) === false;
  }

  let signaledProcessGroup = false;
  if (processGroupHasExactOwnedMember(terminationArtifact, processGroupId)) {
    try {
      process.kill(-processGroupId, "SIGTERM");
      signaledProcessGroup = true;
    } catch {
      // Fall back to the direct pid when the process group is already gone.
    }
  }

  if (signaledProcessGroup === false && terminationArtifact.pid > 0 && isDetachedProcessAliveExactly(terminationArtifact)) {
    try {
      process.kill(terminationArtifact.pid, "SIGTERM");
    } catch {
      // Status detection should still be recorded even when cleanup races exit.
    }
  }

  const graceDeadline = Date.now() + DETACHED_TERMINATION_GRACE_MS;
  while (Date.now() < graceDeadline) {
    sleepSync(Math.min(100, Math.max(0, graceDeadline - Date.now())));
    terminationArtifact = refreshProcessGroupIdentitiesWhileLeaderAlive(terminationArtifact);
  }

  if (processGroupHasExactOwnedMember(terminationArtifact, processGroupId)) {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      // Fall back to the direct pid when the process group is already gone.
    }
  }

  if (isDetachedProcessAliveExactly(terminationArtifact) && terminationArtifact.pid > 0) {
    try {
      process.kill(terminationArtifact.pid, "SIGKILL");
    } catch {
      // The process may exit during the SIGTERM grace window.
    }
  }

  terminationArtifact = refreshProcessGroupIdentitiesWhileLeaderAlive(terminationArtifact);
  return isDetachedRunAlive(terminationArtifact) === false;
}

function processGroupHasExactKnownMember(processGroupId: number, knownProcessGroupIdentities: DetachedProcessIdentity[]): boolean {
  if (processGroupId <= 0 || knownProcessGroupIdentities.length === 0) {
    return false;
  }

  const currentProcessGroupIdentities = getProcessGroupMemberIdentitiesForKnownParents(processGroupId, knownProcessGroupIdentities);
  return currentProcessGroupIdentities.some((identity) => {
    return knownProcessGroupIdentities.some((knownIdentity) => sameProcessIdentity(identity, knownIdentity));
  });
}

function terminateSpawnedDetachedProcess(pid: number, knownProcessGroupIdentities: DetachedProcessIdentity[] = []): boolean {
  if (pid <= 0) {
    return true;
  }

  if (process.platform === "win32") {
    let exactIdentities = getExactWindowsSpawnedProcessTreeIdentities(pid, knownProcessGroupIdentities);
    if (exactIdentities.length === 0) {
      return isPidAlive(pid) === false;
    }
    exactIdentities.forEach((identity) => {
      terminateWindowsProcessTree(identity.pid);
    });
    sleepSync(DETACHED_TERMINATION_GRACE_MS);
    exactIdentities = getExactWindowsSpawnedProcessTreeIdentities(pid, knownProcessGroupIdentities);
    exactIdentities.forEach((identity) => {
      terminateWindowsProcessTree(identity.pid, true);
    });
    sleepSync(100);
    return getExactWindowsSpawnedProcessTreeIdentities(pid, knownProcessGroupIdentities).length === 0;
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The process may have already exited after the startup failure.
      }
    }
  }

  sleepSync(DETACHED_TERMINATION_GRACE_MS);

  const ownedIdentities = mergeProcessIdentities(knownProcessGroupIdentities);
  if (ownedIdentities.length === 0) {
    return isPidAlive(pid) === false;
  }
  if (processGroupHasExactKnownMember(pid, ownedIdentities)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Fall back to the direct pid when the process group is already gone.
    }
  }

  if (ownedIdentities.some((identity) => identity.pid === pid && processIdentityMatchesExactly(identity))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may exit during the SIGTERM grace window.
    }
  }
  sleepSync(100);
  return processGroupHasExactKnownMember(pid, ownedIdentities) === false
    && ownedIdentities.every((identity) => processIdentityMatchesExactly(identity) === false);
}

function sameDetachedRunIdentity(left: DetachedRunArtifact, right: DetachedRunArtifact): boolean {
  return left.pid === right.pid && left.startedAt === right.startedAt;
}

export function shouldPreserveCurrentDetachedRunArtifact(
  currentArtifact: DetachedRunArtifact | undefined,
  nextArtifact: DetachedRunArtifact,
  options: { allowReplacingDifferentRun?: boolean } = {},
): boolean {
  if (currentArtifact === undefined) {
    return options.allowReplacingDifferentRun !== true;
  }

  if (sameDetachedRunIdentity(currentArtifact, nextArtifact) && isTerminalStatus(currentArtifact.status)) {
    return true;
  }

  if (
    currentArtifact !== undefined
    && sameDetachedRunIdentity(currentArtifact, nextArtifact)
    && isTerminalStatus(currentArtifact.status) === false
    && isTerminalStatus(nextArtifact.status) === false
  ) {
    const currentObservedAt = dayjs(currentArtifact.lastObservedAt ?? currentArtifact.statusUpdatedAt).valueOf();
    const nextObservedAt = dayjs(nextArtifact.lastObservedAt ?? nextArtifact.statusUpdatedAt).valueOf();
    if (
      Number.isFinite(currentObservedAt)
      && Number.isFinite(nextObservedAt)
      && nextObservedAt < currentObservedAt
    ) {
      return true;
    }
    if (
      currentArtifact.lastObservedAt !== undefined
      && nextArtifact.lastObservedAt !== undefined
      && Number.isFinite(currentObservedAt)
      && Number.isFinite(nextObservedAt)
      && nextObservedAt === currentObservedAt
    ) {
      return true;
    }
  }

  return options.allowReplacingDifferentRun !== true && sameDetachedRunIdentity(currentArtifact, nextArtifact) === false;
}

export function removeDetachedRunArtifact(artifactPath: string): DetachedRunArtifact | undefined {
  const resolvedArtifactPath = path.resolve(artifactPath);
  let removedArtifact: DetachedRunArtifact | undefined;
  withDetachedRunArtifactWriteLock(resolvedArtifactPath, () => {
    if (existsSync(resolvedArtifactPath) === false) {
      return;
    }

    removedArtifact = readJsonFile<DetachedRunArtifact>(resolvedArtifactPath);
    removeDetachedRunResultClaimForArtifact(removedArtifact);
    removeDetachedRunPhaseClaimForArtifact(removedArtifact);
    removeDetachedRunLogClaimsForArtifact(removedArtifact);
    rmSync(resolvedArtifactPath, { force: true });
  });

  return removedArtifact;
}

function writeDetachedRunArtifact(
  artifactPath: string,
  artifact: DetachedRunArtifact,
  options: { allowReplacingDifferentRun?: boolean; lockOptions?: ArtifactWriteLockOptions } = {},
): DetachedRunArtifact {
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  return withDetachedRunArtifactWriteLock(artifactPath, () => {
    return writeDetachedRunArtifactWithCurrentLock(artifactPath, artifact, options);
  }, options.lockOptions);
}

function writeDetachedRunArtifactWithCurrentLock(
  artifactPath: string,
  artifact: DetachedRunArtifact,
  options: { allowReplacingDifferentRun?: boolean } = {},
): DetachedRunArtifact {
  const currentArtifact = existsSync(artifactPath)
    ? readJsonFile<DetachedRunArtifact>(artifactPath)
    : undefined;
  if (shouldPreserveCurrentDetachedRunArtifact(currentArtifact, artifact, options)) {
    if (currentArtifact === undefined) {
      return artifact;
    }
    return currentArtifact;
  }

  const temporaryPath = `${artifactPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`);
    renameSync(temporaryPath, artifactPath);
    return artifact;
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function writeFailedToStartArtifactForLaunchAttempt(artifactPath: string, artifact: DetachedRunArtifact): DetachedRunArtifact {
  mkdirSync(path.dirname(artifactPath), { recursive: true });
  return withDetachedRunArtifactWriteLock(artifactPath, () => {
    const currentArtifact = existsSync(artifactPath)
      ? readJsonFile<DetachedRunArtifact>(artifactPath)
      : undefined;
    if (currentArtifact !== undefined && sameDetachedRunIdentity(currentArtifact, artifact) === false) {
      return currentArtifact;
    }

    return writeDetachedRunArtifactWithCurrentLock(artifactPath, artifact, { allowReplacingDifferentRun: true });
  });
}

function validateDetachedRunCwd(cwd: string): void {
  const stats = statSync(cwd);
  if (stats.isDirectory() === false) {
    throw new Error(`Detached run cwd is not a directory: ${cwd}`);
  }
}

// -------------------------------------------------------------------------- //
//                                    API                                     //
// -------------------------------------------------------------------------- //

export function readDetachedRunArtifact(artifactPath: string): DetachedRunArtifact {
  return readJsonFile<DetachedRunArtifact>(artifactPath, "Detached run artifact");
}

export function detachedRunArtifactBelongsToCurrentProcess(artifactPath: string): boolean {
  const resolvedArtifactPath = path.resolve(artifactPath);
  if (existsSync(resolvedArtifactPath) === false) {
    return false;
  }

  const artifact = readDetachedRunArtifact(resolvedArtifactPath);
  const ownerToken = process.env[DETACHED_RUN_OWNER_TOKEN_ENV];
  if (
    ownerToken !== undefined
    && artifact.processOwnerTokenSha256 !== undefined
    && artifact.processOwnerTokenSha256 === hashDetachedRunOwnerToken(ownerToken)
  ) {
    return path.resolve(artifact.artifactPath) === resolvedArtifactPath;
  }

  return path.resolve(artifact.artifactPath) === resolvedArtifactPath
    && artifact.pid === process.pid
    && artifact.processIdentity !== undefined
    && processIdentityMatchesExactly(artifact.processIdentity);
}

export async function shouldPreserveDetachedRunArtifactForCurrentProcess(
  artifactPath: string,
  options: DetachedRunArtifactOwnershipWaitOptions = {},
): Promise<boolean> {
  const resolvedArtifactPath = path.resolve(artifactPath);
  if (path.resolve(process.env[DETACHED_RUN_ARTIFACT_ENV] ?? "") !== resolvedArtifactPath) {
    return false;
  }

  const graceMs = options.launchInactiveGraceMs ?? DETACHED_RUN_ARTIFACT_OWNERSHIP_GRACE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? ARTIFACT_WRITE_LOCK_RETRY_MS;
  let inactiveDeadline: number | undefined;

  while (true) {
    if (detachedRunArtifactBelongsToCurrentProcess(resolvedArtifactPath)) {
      return true;
    }

    if (detachedRunLaunchClaimIsActive(resolvedArtifactPath)) {
      inactiveDeadline = undefined;
      await sleep(pollIntervalMs);
      continue;
    }

    inactiveDeadline ??= Date.now() + graceMs;
    if (Date.now() >= inactiveDeadline) {
      return false;
    }

    await sleep(Math.min(pollIntervalMs, Math.max(0, inactiveDeadline - Date.now())));
  }
}

export function findActiveDetachedRun(artifactPath: string): DetachedRunArtifact | undefined {
  const resolvedArtifactPath = path.resolve(artifactPath);
  if (existsSync(resolvedArtifactPath) === false) {
    return undefined;
  }

  const artifact = readDetachedRunArtifact(resolvedArtifactPath);
  if (isTerminalStatus(artifact.status)) {
    return undefined;
  }

  return isDetachedRunAlive(artifact) ? artifact : undefined;
}

export function startDetachedRun(input: StartDetachedRunInput): DetachedRunArtifact {
  const artifactPath = path.resolve(input.artifactPath);
  if (detachedRunLaunchClaimBelongsToCurrentProcess(artifactPath)) {
    return startDetachedRunWithLaunchClaim(input, artifactPath);
  }

  const launchClaim = withDetachedRunLaunchClaimSync(artifactPath, () => startDetachedRunWithLaunchClaim(input, artifactPath));
  if (launchClaim.acquired === false) {
    throw new Error(
      `Detached run launch already active for ${artifactPath}. Use the existing status command before starting another run.`,
    );
  }

  return launchClaim.value;
}

function startDetachedRunWithLaunchClaim(input: StartDetachedRunInput, artifactPath: string): DetachedRunArtifact {
  const activeRun = findActiveDetachedRun(artifactPath);
  if (activeRun !== undefined) {
    throw new Error(
      `Detached run already active for ${artifactPath} with pid ${activeRun.pid}. Use the existing status command before starting another run.`,
    );
  }

  const cwd = path.resolve(input.cwd);
  const logPaths = buildRunLogPaths(artifactPath, input.stderrPath, input.stdoutPath);
  const startedAt = dayjs().toISOString();
  const statusCommand = input.statusCommand ?? buildDefaultStatusCommand(artifactPath);
  const resumeCommand = input.resumeCommand ?? buildDefaultResumeCommand(artifactPath);
  const deadlineAt = input.timeoutMs === undefined
    ? undefined
    : dayjs(startedAt).add(input.timeoutMs, "millisecond").toISOString();
  const resultPath = path.resolve(input.resultPath ?? buildDefaultResultArtifactPath(artifactPath));
  const phasePath = input.phasePath === undefined ? undefined : path.resolve(input.phasePath);
  const processOwnerToken = randomUUID();
  const windowsObservedProcessIdentityPath = buildWindowsObservedProcessIdentityPath(artifactPath);

  let stderrFd: number | undefined;
  let stdoutFd: number | undefined;
  let stderrLogClaim: DetachedRunPathClaim | undefined;
  let stderrLogClaimTransferred = false;
  let stdoutLogClaim: DetachedRunPathClaim | undefined;
  let stdoutLogClaimTransferred = false;
  let phaseClaim: DetachedRunPathClaim | undefined;
  let phaseClaimTransferred = false;
  let resultClaim: DetachedRunPathClaim | undefined;
  let resultClaimTransferred = false;
  let spawnedArtifact: DetachedRunArtifact | undefined;
  const transferStartupClaimOwnersToArtifact = (
    artifact: DetachedRunArtifact,
    processGroupIdentities: DetachedProcessIdentity[],
    processIdentity?: DetachedProcessIdentity,
  ): string[] => {
    const failures: string[] = [];
    const metadataForClaim = (claim: DetachedRunPathClaim): ArtifactWriteLockMetadata => ({
      lockToken: claim.metadata.lockToken,
      artifactPath,
      pid: artifact.pid,
      processGroupIdentities,
      processIdentity,
      startedAt,
    });
    const recordFailure = (label: string, error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${label}: ${message}`);
    };

    if (resultClaim !== undefined && resultClaimTransferred === false) {
      try {
        replaceDetachedRunResultClaimOwner(resultPath, resultClaim, metadataForClaim(resultClaim));
        resultClaimTransferred = true;
      } catch (error) {
        recordFailure("result artifact", error);
      }
    }
    if (stdoutLogClaim !== undefined && stdoutLogClaimTransferred === false) {
      try {
        replaceDetachedRunPathClaimOwner(stdoutLogClaim, artifact.stdoutPath, "stdout log", metadataForClaim(stdoutLogClaim));
        stdoutLogClaimTransferred = true;
      } catch (error) {
        recordFailure("stdout log", error);
      }
    }
    if (stderrLogClaim !== undefined && stderrLogClaimTransferred === false) {
      try {
        replaceDetachedRunPathClaimOwner(stderrLogClaim, artifact.stderrPath, "stderr log", metadataForClaim(stderrLogClaim));
        stderrLogClaimTransferred = true;
      } catch (error) {
        recordFailure("stderr log", error);
      }
    }
    if (phasePath !== undefined && phaseClaim !== undefined && phaseClaimTransferred === false) {
      try {
        replaceDetachedRunPhaseClaimOwner(phasePath, phaseClaim, metadataForClaim(phaseClaim));
        phaseClaimTransferred = true;
      } catch (error) {
        recordFailure("phase artifact", error);
      }
    }

    return failures;
  };
  const throwIfStartupClaimTransferFailed = (failures: string[]): void => {
    if (failures.length > 0) {
      throw new Error(`Could not transfer detached startup path ownership to artifact: ${failures.join("; ")}`);
    }
  };
  try {
    const resultClaimPath = buildDetachedRunResultClaimPath(resultPath);
    const resultClaimPaths = buildDetachedRunResultClaimPaths(resultPath);
    const phaseClaimPath = phasePath === undefined ? undefined : buildDetachedRunPhaseClaimPath(phasePath);
    const phaseClaimPaths = phasePath === undefined ? [] : buildDetachedRunPhaseClaimPaths(phasePath);
    mkdirSync(path.dirname(logPaths.stdout), { recursive: true });
    mkdirSync(path.dirname(logPaths.stderr), { recursive: true });

    const stderrLogClaimPaths = buildDetachedRunLogClaimPaths("stderr log", logPaths.stderr);
    const stdoutLogClaimPaths = buildDetachedRunLogClaimPaths("stdout log", logPaths.stdout);
    assertProtocolPathDoesNotAlias("Result artifact", resultPath, "detached run artifact", artifactPath);
    assertProtocolPathDoesNotAlias("Result artifact", resultPath, "Windows process sidecar", windowsObservedProcessIdentityPath);
    assertProtocolPathDoesNotAlias("Result artifact", resultPath, "stdout log", logPaths.stdout);
    assertProtocolPathDoesNotAlias("Result artifact", resultPath, "stderr log", logPaths.stderr);
    assertPathDoesNotAliasDetachedRunReservedProtocolPaths("Result artifact", resultPath, artifactPath, resultPath, phasePath);
    assertProtocolPathDoesNotAlias("Phase artifact", phasePath, "detached run artifact", artifactPath);
    assertProtocolPathDoesNotAlias("Phase artifact", phasePath, "Windows process sidecar", windowsObservedProcessIdentityPath);
    assertProtocolPathDoesNotAlias("Phase artifact", phasePath, "result artifact", resultPath);
    assertProtocolPathDoesNotAlias("Phase artifact", phasePath, "result artifact ownership lock", resultClaimPath);
    assertProtocolPathDoesNotAlias("Phase artifact", phasePath, "phase artifact ownership lock", phaseClaimPath);
    assertProtocolPathDoesNotAlias("Phase artifact", phasePath, "stdout log", logPaths.stdout);
    assertProtocolPathDoesNotAlias("Phase artifact", phasePath, "stderr log", logPaths.stderr);
    assertPathDoesNotAliasDetachedRunReservedProtocolPaths("Phase artifact", phasePath, artifactPath, resultPath);
    assertProtocolPathDoesNotAlias("stdout log", logPaths.stdout, "detached run artifact", artifactPath);
    assertProtocolPathDoesNotAlias("stdout log", logPaths.stdout, "Windows process sidecar", windowsObservedProcessIdentityPath);
    assertProtocolPathDoesNotAlias("stdout log", logPaths.stdout, "stderr log", logPaths.stderr);
    assertProtocolPathDoesNotAlias("stdout log", logPaths.stdout, "result artifact ownership lock", resultClaimPath);
    assertProtocolPathDoesNotAlias("stdout log", logPaths.stdout, "phase artifact ownership lock", phaseClaimPath);
    assertPathDoesNotAliasDetachedRunReservedProtocolPaths("stdout log", logPaths.stdout, artifactPath, resultPath, phasePath);
    assertProtocolPathDoesNotAlias("stderr log", logPaths.stderr, "detached run artifact", artifactPath);
    assertProtocolPathDoesNotAlias("stderr log", logPaths.stderr, "Windows process sidecar", windowsObservedProcessIdentityPath);
    assertProtocolPathDoesNotAlias("stderr log", logPaths.stderr, "result artifact ownership lock", resultClaimPath);
    assertProtocolPathDoesNotAlias("stderr log", logPaths.stderr, "phase artifact ownership lock", phaseClaimPath);
    assertPathDoesNotAliasDetachedRunReservedProtocolPaths("stderr log", logPaths.stderr, artifactPath, resultPath, phasePath);
    const producerProtocolPaths = buildDetachedRunProducerProtocolPaths(
      artifactPath,
      logPaths,
      phasePath,
      resultPath,
      windowsObservedProcessIdentityPath,
    );
    assertDetachedRunClaimPathsDoNotAliasProtocolPaths("result artifact ownership lock", resultClaimPaths, producerProtocolPaths);
    assertDetachedRunClaimPathsDoNotAliasProtocolPaths("phase artifact ownership lock", phaseClaimPaths, producerProtocolPaths);
    assertDetachedRunClaimPathsDoNotAliasProtocolPaths("stderr log ownership lock", stderrLogClaimPaths, producerProtocolPaths);
    assertDetachedRunClaimPathsDoNotAliasProtocolPaths("stdout log ownership lock", stdoutLogClaimPaths, producerProtocolPaths);
    resultClaim = claimDetachedRunResultPath(resultPath);
    if (phasePath !== undefined) {
      phaseClaim = claimDetachedRunPhasePath(phasePath);
    }
    stdoutLogClaim = claimDetachedRunLogPath("stdout log", logPaths.stdout);
    stderrLogClaim = claimDetachedRunLogPath("stderr log", logPaths.stderr);
    const releaseLauncherClaims = (): void => {
      if (resultClaim !== undefined && resultClaimTransferred === false) {
        removeOwnedDetachedRunPathClaim(resultClaim);
        resultClaim = undefined;
      }
      if (phaseClaim !== undefined && phaseClaimTransferred === false) {
        removeOwnedDetachedRunPathClaim(phaseClaim);
        phaseClaim = undefined;
      }
      if (stdoutLogClaim !== undefined && stdoutLogClaimTransferred === false) {
        removeOwnedDetachedRunPathClaim(stdoutLogClaim);
        stdoutLogClaim = undefined;
      }
      if (stderrLogClaim !== undefined && stderrLogClaimTransferred === false) {
        removeOwnedDetachedRunPathClaim(stderrLogClaim);
        stderrLogClaim = undefined;
      }
    };
    input.beforeSpawn?.();
    let artifact = withDetachedRunArtifactWriteLock(artifactPath, () => {
      validateDetachedRunCwd(cwd);
      const resultArtifactBaselines = getResultArtifactBaselines(artifactPath, resultPath);
      const phaseArtifactBaseline = getPhaseArtifactBaseline(phasePath);
      if (process.platform === "win32") {
        rmSync(buildWindowsObservedProcessIdentityPath(artifactPath), { force: true });
      }
      stdoutFd = openDetachedRunLogFile(logPaths.stdout, "Detached stdout log");
      stderrFd = openDetachedRunLogFile(logPaths.stderr, "Detached stderr log");
      if (stdoutLogClaim !== undefined) {
        stdoutLogClaim = claimDetachedRunLogFileIdentityPath("stdout log", logPaths.stdout, stdoutLogClaim);
      }
      if (stderrLogClaim !== undefined) {
        stderrLogClaim = claimDetachedRunLogFileIdentityPath("stderr log", logPaths.stderr, stderrLogClaim);
      }
      const useShell = input.commandArgs === undefined;
      const commandText = input.commandArgs === undefined ? input.command : formatDetachedCommandForPlatform(input);
      const shouldUseShellMonitor = process.platform !== "win32" || useShell || input.commandArgs !== undefined;
      if (process.platform !== "win32") {
        assertPosixDetachedShellMonitorAvailable();
      }
      const spawnCommand = getDetachedSpawnCommand(commandText, input, shouldUseShellMonitor, artifactPath, logPaths);
      const child = spawn(
        spawnCommand.command,
        spawnCommand.args,
        {
          cwd,
          detached: spawnCommand.detached,
          env: {
            ...process.env,
            [DETACHED_RUN_ARTIFACT_ENV]: artifactPath,
            [DETACHED_RUN_OWNER_TOKEN_ENV]: processOwnerToken,
            [RUN_COMMAND_PROCESS_GROUPS_ENV]: "0",
          },
          shell: spawnCommand.shell,
          stdio: spawnCommand.ownsLogFiles ? "ignore" : ["ignore", stdoutFd, stderrFd],
        },
      );
      child.once("error", (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const failedAt = dayjs().toISOString();
        const failedArtifact = makeFailedToStartArtifact(
          input,
          artifactPath,
          cwd,
          deadlineAt,
          message,
          failedAt,
          logPaths,
          resumeCommand,
          resultPath,
          startedAt,
          statusCommand,
        );
        writeFailedToStartArtifactForLaunchAttempt(artifactPath, failedArtifact);
      });
      if (child.pid === undefined) {
        throw new Error("Detached command did not expose a child process id.");
      }

      const processIdentity = getProcessIdentity(child.pid);
      if (processIdentity === undefined) {
        const startupProcessGroupIdentities = getProcessGroupMemberIdentities(child.pid);
        const startupArtifact = makeCompletedStartupArtifact(
          input,
          artifactPath,
          cwd,
          deadlineAt,
          dayjs().toISOString(),
          logPaths,
          child.pid,
          resultPath,
          { status: "failed" },
          resumeCommand,
          startedAt,
          statusCommand,
        );
        const startupClaimTransferFailures = transferStartupClaimOwnersToArtifact(startupArtifact, startupProcessGroupIdentities);
        const startupResultStatus = discoverResultStatusSnapshot({
          ...startupArtifact,
          resultArtifactBaselines,
          resultPath,
          status: "running",
        });
        if (isPidAlive(child.pid) === false && startupProcessGroupIdentities.length === 0) {
          if (startupResultStatus !== undefined) {
            const completedStartupResultStatus: { failureReason?: string; status: "failed" | "passed" } = startupResultStatus.status === "passed"
              ? { status: "passed" }
              : {
                  failureReason: startupResultStatus.failureReason,
                  status: "failed",
                };
            releaseLauncherClaims();
            const completedArtifact = writeDetachedRunArtifactWithCurrentLock(
              artifactPath,
              makeCompletedStartupArtifact(
                input,
                artifactPath,
                cwd,
                deadlineAt,
                dayjs().toISOString(),
                logPaths,
                child.pid,
                startupResultStatus.resultPath,
                completedStartupResultStatus,
                resumeCommand,
                startedAt,
                statusCommand,
              ),
              { allowReplacingDifferentRun: true },
            );
            removeDetachedRunResultClaimForArtifact(completedArtifact);
            removeDetachedRunPhaseClaimForArtifact(completedArtifact);
            removeDetachedRunLogClaimsForArtifact(completedArtifact);
            return completedArtifact;
          }
          releaseLauncherClaims();
          const noResultArtifact = writeDetachedRunArtifactWithCurrentLock(
            artifactPath,
            makeProcessExitedWithoutResultStartupArtifact(
              input,
              artifactPath,
              cwd,
              deadlineAt,
              dayjs().toISOString(),
              logPaths,
              child.pid,
              resumeCommand,
              resultPath,
              startedAt,
              statusCommand,
            ),
            { allowReplacingDifferentRun: true },
          );
          removeDetachedRunResultClaimForArtifact(noResultArtifact);
          removeDetachedRunPhaseClaimForArtifact(noResultArtifact);
          removeDetachedRunLogClaimsForArtifact(noResultArtifact);
          return noResultArtifact;
        }
        const cleanupSucceeded = terminateSpawnedDetachedProcess(child.pid, startupProcessGroupIdentities);
        if (cleanupSucceeded === false) {
          if (resultClaim === undefined) {
            throw new Error(`Detached result artifact ownership lock was not acquired for ${resultPath}.`);
          }
          if (stdoutLogClaim === undefined) {
            throw new Error(`Detached stdout log ownership lock was not acquired for ${logPaths.stdout}.`);
          }
          if (stderrLogClaim === undefined) {
            throw new Error(`Detached stderr log ownership lock was not acquired for ${logPaths.stderr}.`);
          }
          if (phasePath !== undefined && phaseClaim === undefined) {
            throw new Error(`Detached phase artifact ownership lock was not acquired for ${phasePath}.`);
          }
          const failedAt = dayjs().toISOString();
          const processGroupIdentities = mergeProcessIdentities(startupProcessGroupIdentities);
          const nextArtifact: DetachedRunArtifact = {
            artifactPath,
            command: formatDetachedCommandForPlatform(input),
            commentaryPolicy: input.commentaryPolicy ?? "event-only",
            cwd,
            deadlineAt,
            failureReason: "Detached run startup could not capture process identity and cleanup could not confirm termination.",
            lastMaterialEvent: {
              at: startedAt,
              status: "running",
              type: "started",
            },
            lastObservedAt: failedAt,
            logPaths,
            logLimitBytes: input.logLimitBytes ?? DETACHED_LOG_LIMIT_BYTES,
            phaseArtifactBaseline,
            phasePath,
            pid: child.pid,
            processGroupIdentities,
            processGroupId: child.pid,
            processOwnerTokenSha256: hashDetachedRunOwnerToken(processOwnerToken),
            resultArtifactBaselines,
            resultReadLimitBytes: input.resultReadLimitBytes,
            resultPath,
            resumeCommand,
            startedAt,
            status: "running",
            statusCommand,
            statusUpdatedAt: failedAt,
            startupCleanupUnverified: true,
            stderrPath: logPaths.stderr,
            stdoutPath: logPaths.stdout,
            timeoutMs: input.timeoutMs,
            version: 1,
          };
          spawnedArtifact = nextArtifact;
          throwIfStartupClaimTransferFailed(transferStartupClaimOwnersToArtifact(nextArtifact, processGroupIdentities));
          child.unref();
          return writeDetachedRunArtifactWithCurrentLock(artifactPath, nextArtifact, { allowReplacingDifferentRun: true });
        }
        throw new Error(`Could not capture detached process identity for pid ${child.pid}.`);
      }
      if (resultClaim === undefined) {
        throw new Error(`Detached result artifact ownership lock was not acquired for ${resultPath}.`);
      }
      if (stdoutLogClaim === undefined) {
        throw new Error(`Detached stdout log ownership lock was not acquired for ${logPaths.stdout}.`);
      }
      if (stderrLogClaim === undefined) {
        throw new Error(`Detached stderr log ownership lock was not acquired for ${logPaths.stderr}.`);
      }
      if (phasePath !== undefined && phaseClaim === undefined) {
        throw new Error(`Detached phase artifact ownership lock was not acquired for ${phasePath}.`);
      }
      const processGroupIdentities = mergeProcessIdentities([
        processIdentity,
        ...getProcessGroupMemberIdentities(child.pid),
      ]);
      const nextArtifact: DetachedRunArtifact = {
        artifactPath,
        command: formatDetachedCommandForPlatform(input),
        commentaryPolicy: input.commentaryPolicy ?? "event-only",
        cwd,
        deadlineAt,
        lastMaterialEvent: {
          at: startedAt,
          status: "running",
          type: "started",
        },
        logPaths,
        logLimitBytes: input.logLimitBytes ?? DETACHED_LOG_LIMIT_BYTES,
        phaseArtifactBaseline,
        phasePath,
        pid: child.pid,
        processGroupIdentities,
        processGroupId: child.pid,
        processIdentity,
        processOwnerTokenSha256: hashDetachedRunOwnerToken(processOwnerToken),
        resultArtifactBaselines,
        resultReadLimitBytes: input.resultReadLimitBytes,
        resultPath,
        resumeCommand,
        startedAt,
        status: "running",
        statusCommand,
        statusUpdatedAt: startedAt,
        stderrPath: logPaths.stderr,
        stdoutPath: logPaths.stdout,
        timeoutMs: input.timeoutMs,
        version: 1,
      };
      spawnedArtifact = nextArtifact;
      throwIfStartupClaimTransferFailed(transferStartupClaimOwnersToArtifact(nextArtifact, processGroupIdentities, processIdentity));

      child.unref();
      return writeDetachedRunArtifactWithCurrentLock(artifactPath, nextArtifact, { allowReplacingDifferentRun: true });
    });
    spawnedArtifact = artifact;
    const watchdogPid = startDetachedTimeoutWatchdog(artifact);
    if (watchdogPid !== undefined) {
      artifact = {
        ...artifact,
        watchdogPid,
      };
      spawnedArtifact = artifact;
      artifact = writeDetachedRunArtifact(artifactPath, artifact);
      spawnedArtifact = artifact;
    }
    return artifact;
  } catch (error) {
    let cleanupSucceeded = true;
    if (spawnedArtifact !== undefined) {
      cleanupSucceeded = terminateDetachedProcess(spawnedArtifact);
    }
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = dayjs().toISOString();
    if (spawnedArtifact !== undefined && cleanupSucceeded === false) {
      let nextArtifact: DetachedRunArtifact = {
        ...spawnedArtifact,
        failureReason: `Detached run startup failed after spawning and cleanup could not confirm termination: ${message}`,
        lastObservedAt: failedAt,
        status: "running",
        statusUpdatedAt: failedAt,
      };
      const transferFailures = transferStartupClaimOwnersToArtifact(
        nextArtifact,
        nextArtifact.processGroupIdentities ?? [],
        nextArtifact.processIdentity,
      );
      if (transferFailures.length > 0) {
        nextArtifact = {
          ...nextArtifact,
          failureReason: `${nextArtifact.failureReason}; detached startup path ownership transfer remains incomplete: ${transferFailures.join("; ")}`,
        };
      }
      const artifact = writeDetachedRunArtifact(artifactPath, nextArtifact, { allowReplacingDifferentRun: true });
      return artifact;
    }
    if (spawnedArtifact !== undefined && resultClaimTransferred) {
      removeDetachedRunResultClaimForArtifact(spawnedArtifact);
    } else if (resultClaim !== undefined) {
      removeOwnedDetachedRunPathClaim(resultClaim);
    }
    if (spawnedArtifact !== undefined && phaseClaimTransferred) {
      removeDetachedRunPhaseClaimForArtifact(spawnedArtifact);
    } else if (phaseClaim !== undefined) {
      removeOwnedDetachedRunPathClaim(phaseClaim);
    }
    if (spawnedArtifact !== undefined && stdoutLogClaimTransferred) {
      removeDetachedRunLogClaimForArtifact(spawnedArtifact, spawnedArtifact.stdoutPath);
    } else if (stdoutLogClaim !== undefined) {
      removeOwnedDetachedRunPathClaim(stdoutLogClaim);
    }
    if (spawnedArtifact !== undefined && stderrLogClaimTransferred) {
      removeDetachedRunLogClaimForArtifact(spawnedArtifact, spawnedArtifact.stderrPath);
    } else if (stderrLogClaim !== undefined) {
      removeOwnedDetachedRunPathClaim(stderrLogClaim);
    }
    const artifact = makeFailedToStartArtifact(
      input,
      artifactPath,
      cwd,
      deadlineAt,
      message,
      failedAt,
      logPaths,
      resumeCommand,
      resultPath,
      startedAt,
      statusCommand,
    );
    writeDetachedRunArtifact(artifactPath, artifact, { allowReplacingDifferentRun: true });
    return artifact;
  } finally {
    closeFd(stdoutFd);
    closeFd(stderrFd);
  }
}

export function inspectDetachedRun(input: InspectDetachedRunInput): DetachedRunStatusResult {
  const artifactPath = path.resolve(input.artifactPath);
  const processIdentityProbeOptions = getWindowsProcessRefreshProbeOptions();
  const lockOptions = { processIdentityProbeOptions };
  const artifact = refreshProcessGroupIdentitiesWhileLeaderAlive(readDetachedRunArtifact(artifactPath), processIdentityProbeOptions);
  const observedAt = input.now ?? dayjs().toISOString();
  const previousPhase = artifact.phase;
  const previousStatus = artifact.status;
  const artifactIsTerminal = isTerminalStatus(artifact.status);
  if (artifact.status === "timeout") {
    quarantineLateResultArtifacts(artifact);
  }
  let phaseFailureReason: string | undefined;
  let nextPhase = artifact.phase;
  if (artifactIsTerminal === false) {
    try {
      nextPhase = readPhase(artifact);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      phaseFailureReason = `Could not read phase artifact: ${message}`;
    }
  }
  const resultStatusSnapshot = artifactIsTerminal ? undefined : discoverResultStatusSnapshot(artifact);
  let nextResultPath = resultStatusSnapshot?.resultPath ?? artifact.resultPath;
  let nextResultObservedWhileRunningAt = artifact.resultObservedWhileRunningAt;
  let failureReason = artifact.failureReason;
  let nextStatus = artifact.status;
  let processAlive: boolean | undefined;
  const isRunProcessAlive = (): boolean => {
    processAlive ??= isDetachedRunAlive(artifact, processIdentityProbeOptions);
    return processAlive;
  };

  const deadlineAtMs = artifact.deadlineAt === undefined ? Number.NaN : dayjs(artifact.deadlineAt).valueOf();
  const deadlineExceeded = isTerminalStatus(artifact.status) === false
    && Number.isFinite(deadlineAtMs)
    && dayjs(observedAt).valueOf() >= deadlineAtMs;
  const markTimedOut = (): void => {
    failureReason = `Run timed out after ${artifact.timeoutMs ?? "unknown"}ms.`;
    if (terminateDetachedProcess(artifact)) {
      nextStatus = "timeout";
      quarantineLateResultArtifacts(artifact);
    } else {
      failureReason = `${failureReason} Cleanup could not be verified, so the run is still treated as active.`;
      nextStatus = "running";
    }
  };

  if (phaseFailureReason !== undefined && artifactIsTerminal === false) {
    failureReason = phaseFailureReason;
    if (deadlineExceeded) {
      markTimedOut();
    } else {
      nextStatus = isRunProcessAlive() ? "running" : "failed";
    }
  } else if (resultStatusSnapshot !== undefined) {
    let resultStatus = resultStatusSnapshot;
    nextResultPath = resultStatus.resultPath;
    const runProcessAlive = isTerminalStatus(artifact.status) === false && isRunProcessAlive();
    if (runProcessAlive && nextResultObservedWhileRunningAt === undefined) {
      nextResultObservedWhileRunningAt = observedAt;
    }
    const shouldApplyDeadlineFailure = deadlineExceeded
      && (runProcessAlive || nextResultObservedWhileRunningAt !== undefined);
    if (isTerminalStatus(artifact.status) === false && shouldApplyDeadlineFailure) {
      markTimedOut();
    } else if (runProcessAlive) {
      nextStatus = "running";
    } else {
      if (resultStatus.status === "unknown" && isTerminalStatus(artifact.status) === false) {
        const settledResultStatus = discoverResultStatusSnapshot(artifact);
        if (settledResultStatus !== undefined) {
          resultStatus = settledResultStatus;
          nextResultPath = settledResultStatus.resultPath;
        }
      }
      failureReason = resultStatus.failureReason;
      nextStatus = resultStatus.status === "unknown" ? "failed" : resultStatus.status;
    }
  } else if (isTerminalStatus(artifact.status) === false) {
    if (deadlineExceeded) {
      markTimedOut();
    } else if (isRunProcessAlive() === false) {
      failureReason = "Process is no longer alive and no result artifact was found.";
      nextStatus = "process-exited-without-result";
    } else {
      nextStatus = "running";
    }
  }

  const phaseChanged = nextPhase !== undefined && nextPhase !== previousPhase;
  const statusChanged = nextStatus !== previousStatus;
  const event: DetachedRunMaterialEvent | undefined = statusChanged
    ? makeEventForStatus(nextStatus)
    : phaseChanged
      ? "phase-change"
      : undefined;
  const nextArtifact: DetachedRunArtifact = {
    ...artifact,
    failureReason,
    finishedAt: isTerminalStatus(nextStatus) ? artifact.finishedAt ?? observedAt : artifact.finishedAt,
    lastMaterialEvent: event === undefined
      ? artifact.lastMaterialEvent
      : {
          at: observedAt,
          phase: nextPhase ?? artifact.phase,
          status: nextStatus,
          type: event,
        },
    lastObservedAt: observedAt,
    phase: nextPhase ?? artifact.phase,
    phaseUpdatedAt: phaseChanged ? observedAt : artifact.phaseUpdatedAt,
    resultObservedWhileRunningAt: nextResultObservedWhileRunningAt,
    resultPath: nextResultPath,
    status: nextStatus,
    statusUpdatedAt: statusChanged ? observedAt : artifact.statusUpdatedAt,
  };

  const persistedArtifact = writeDetachedRunArtifact(artifactPath, nextArtifact, { lockOptions });
  if (isTerminalStatus(persistedArtifact.status)) {
    removeDetachedRunResultClaimForArtifact(persistedArtifact);
    removeDetachedRunPhaseClaimForArtifact(persistedArtifact);
    removeDetachedRunLogClaimsForArtifact(persistedArtifact);
  }
  const persistedPhaseChanged = persistedArtifact.phase !== undefined && persistedArtifact.phase !== previousPhase;
  const persistedStatusChanged = persistedArtifact.status !== previousStatus;
  const persistedEvent: DetachedRunMaterialEvent | undefined = persistedStatusChanged
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

export async function waitForDetachedRunEvent(input: WaitForDetachedRunEventInput): Promise<DetachedRunStatusResult | undefined> {
  const startedAt = dayjs();
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (pollIntervalMs > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`Detached status poll interval must be at most ${MAX_NODE_TIMER_DELAY_MS}ms.`);
  }

  while (true) {
    const result = inspectDetachedRun({ artifactPath: input.artifactPath });
    if (result.shouldOutput) {
      return result;
    }

    if (
      input.waitTimeoutMs !== undefined
      && dayjs().diff(startedAt, "millisecond") >= input.waitTimeoutMs
    ) {
      return undefined;
    }

    const remainingWaitMs = input.waitTimeoutMs === undefined
      ? undefined
      : input.waitTimeoutMs - dayjs().diff(startedAt, "millisecond");
    if (remainingWaitMs !== undefined && remainingWaitMs <= 0) {
      return undefined;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, remainingWaitMs === undefined ? pollIntervalMs : Math.min(pollIntervalMs, remainingWaitMs));
    });
  }
}
