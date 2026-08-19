// -------------------------------------------------------------------------- //
//                                  IMPORTS                                   //
// -------------------------------------------------------------------------- //

import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import picomatch from "picomatch";
import dayjs from "dayjs";

import { listArtifactFiles } from "./config.js";
import {
  buildDetachedRunReservedProtocolPaths,
  buildDetachedRunResultClaimPath,
  buildWindowsObservedProcessIdentityPath,
  findActiveDetachedRun,
  readDetachedRunArtifact,
  removeDetachedRunArtifact,
  withDetachedRunLaunchClaim,
  withDetachedRunResultClaim,
} from "./detached-run.js";
import {
  DEFAULT_COMMAND_MAX_STDERR_BYTES,
  DEFAULT_COMMAND_MAX_STDOUT_BYTES,
  getAgentHome,
  getDefaultArtifactsRoot,
  getLegacyArtifactsRoot,
  runCommand,
} from "./runtime.js";
import type { CommandResult, RuleResult, VerifyProfile, VerifyRunResult } from "./types.js";

// -------------------------------------------------------------------------- //
//                                 VERIFY                                     //
// -------------------------------------------------------------------------- //

type ExecuteVerifyInput = {
  abortSignal?: AbortSignal;
  artifactsDir: string;
  detachedRunArtifactPath?: string;
  paths: string[];
  preserveDetachedRunArtifact?: boolean;
  profile: VerifyProfile;
  repoRoot: string;
  taskContractId?: string;
  taskTreeFingerprint?: string;
};

const VERIFY_RESULT_FILE_NAME = "verify-result.json";
const DETACHED_TERMINAL_STATUSES = new Set(["failed", "failed-to-start", "passed", "process-exited-without-result", "timeout"]);
type ArtifactFileFilter = (artifactFile: string) => boolean;
type DetachedOutputStreamName = "stderr" | "stdout";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function expandTemplate(template: string, input: ExecuteVerifyInput, pathsFilePath: string): string {
  return template
    .replaceAll("{artifactsDir}", shellQuote(input.artifactsDir))
    .replaceAll("{pathsCsv}", shellQuote(input.paths.join(",")))
    .replaceAll("{pathsFile}", shellQuote(pathsFilePath))
    .replaceAll("{repoRoot}", shellQuote(input.repoRoot));
}

function takeUtf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let output = "";

  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) {
      break;
    }

    output += character;
    bytes += characterBytes;
  }

  return output;
}

function makeBoundedDetachedOutputRelay(
  commandId: string,
  streamName: DetachedOutputStreamName,
  maxBytes: number,
  write: (chunk: string) => void,
): (chunk: string) => void {
  let forwardedBytes = 0;
  let truncated = false;

  return (chunk: string): void => {
    if (truncated) {
      return;
    }

    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    const remainingBytes = Math.max(0, maxBytes - forwardedBytes);
    if (chunkBytes <= remainingBytes) {
      write(chunk);
      forwardedBytes += chunkBytes;
      return;
    }

    const prefix = takeUtf8Prefix(chunk, remainingBytes);
    if (prefix.length > 0) {
      write(prefix);
      forwardedBytes += Buffer.byteLength(prefix, "utf8");
    }

    write(
      `\n[agent-harness detached ${streamName} log truncated for command ${commandId} after ${forwardedBytes} byte${forwardedBytes === 1 ? "" : "s"}; see verify-result.json for retained output]\n`,
    );
    truncated = true;
  };
}

function normalizeArtifactFilePath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

function toArtifactFilePath(artifactsDirectory: string, filePath: string | undefined): string | undefined {
  if (filePath === undefined) {
    return undefined;
  }

  const relativePath = path.relative(artifactsDirectory, resolveExistingPathPrefix(filePath));
  if (relativePath.length === 0 || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return undefined;
  }

  return normalizeArtifactFilePath(relativePath);
}

function buildDetachedProtocolArtifactFilter(input: ExecuteVerifyInput, stableResultPath: string): ArtifactFileFilter {
  if (input.detachedRunArtifactPath === undefined) {
    return () => false;
  }

  const liveArtifactExists = existsSync(input.detachedRunArtifactPath);
  const excludedFiles = new Set<string>();
  const excludedPrefixes: string[] = [];
  const excludeFile = (filePath: string | undefined): void => {
    const artifactFilePath = toArtifactFilePath(input.artifactsDir, filePath);
    if (artifactFilePath !== undefined) {
      excludedFiles.add(artifactFilePath);
    }
  };
  const excludeDirectory = (directoryPath: string): void => {
    const artifactFilePath = toArtifactFilePath(input.artifactsDir, directoryPath);
    if (artifactFilePath !== undefined) {
      excludedPrefixes.push(`${artifactFilePath}/`);
    }
  };

  excludeFile(input.detachedRunArtifactPath);
  excludeFile(buildWindowsObservedProcessIdentityPath(input.detachedRunArtifactPath));
  excludeFile(stableResultPath);
  excludeFile(buildDetachedRunResultClaimPath(stableResultPath));
  buildDetachedRunReservedProtocolPaths(input.detachedRunArtifactPath, stableResultPath)
    .forEach((entry) => excludeFile(entry.filePath));
  excludeDirectory(path.join(input.artifactsDir, "detached"));

  if (liveArtifactExists === false) {
    return (artifactFile: string) => {
      const normalizedArtifactFile = normalizeArtifactFilePath(artifactFile);
      return excludedFiles.has(normalizedArtifactFile)
        || excludedPrefixes.some((prefix) => normalizedArtifactFile.startsWith(prefix));
    };
  }

  excludeFile(path.join(input.artifactsDir, "detached", "paths.txt"));

  try {
    const artifact = readDetachedRunArtifact(input.detachedRunArtifactPath);
    excludeFile(artifact.resultPath);
    excludeFile(artifact.phasePath);
    excludeFile(artifact.stdoutPath);
    excludeFile(artifact.stderrPath);
    excludeFile(artifact.logPaths.stdout);
    excludeFile(artifact.logPaths.stderr);
    excludeFile(buildDetachedRunResultClaimPath(artifact.resultPath ?? stableResultPath));
    buildDetachedRunReservedProtocolPaths(
      input.detachedRunArtifactPath,
      artifact.resultPath ?? stableResultPath,
      artifact.phasePath,
      artifact.logPaths,
    ).forEach((entry) => excludeFile(entry.filePath));
  } catch {
    // A malformed live protocol artifact cannot satisfy proof requirements.
  }

  return (artifactFile: string) => {
    const normalizedArtifactFile = normalizeArtifactFilePath(artifactFile);
    return excludedFiles.has(normalizedArtifactFile)
      || excludedPrefixes.some((prefix) => normalizedArtifactFile.startsWith(prefix));
  };
}

function findArtifacts(
  artifactsDirectory: string,
  patterns: string[],
  isExcludedArtifact: ArtifactFileFilter = () => false,
): { missing: string[]; present: string[] } {
  const artifactFiles = existsSync(artifactsDirectory)
    ? listArtifactFiles(artifactsDirectory).filter((artifactFile) => isExcludedArtifact(artifactFile) === false)
    : [];
  const missing: string[] = [];
  const present: string[] = [];

  patterns.forEach((pattern) => {
    const matches = artifactFiles.filter((artifactFile) => picomatch(pattern)(artifactFile));

    if (matches.length === 0) {
      missing.push(pattern);
      return;
    }

    present.push(...matches);
  });

  return {
    missing: [...new Set(missing)].sort(),
    present: [...new Set(present)].sort(),
  };
}

function isDescendantOf(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);

  return relativePath.length > 0
    && relativePath.startsWith("..") === false
    && path.isAbsolute(relativePath) === false;
}

function isPathEqual(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function resolveExistingPathPrefix(candidatePath: string): string {
  const resolvedPath = path.resolve(candidatePath);
  const missingParts: string[] = [];
  let currentPath = resolvedPath;

  while (existsSync(currentPath) === false) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    missingParts.unshift(path.basename(currentPath));
    currentPath = parentPath;
  }

  return path.resolve(realpathSync(currentPath), ...missingParts);
}

function isTempHarnessArtifactPath(artifactsDir: string): boolean {
  const resolvedTempRoot = resolveExistingPathPrefix(tmpdir());
  const relativePath = path.relative(resolvedTempRoot, artifactsDir);

  if (
    relativePath.length === 0
    || relativePath.startsWith("..")
    || path.isAbsolute(relativePath)
  ) {
    return false;
  }

  return relativePath.split(path.sep)[0]?.startsWith("agent-harness-") === true;
}

function isNestedHarnessArtifactPath(rootPath: string, artifactsDir: string): boolean {
  if (isDescendantOf(rootPath, artifactsDir) === false) {
    return false;
  }

  return path.relative(rootPath, artifactsDir)
    .split(path.sep)
    .filter(Boolean)
    .length >= 2;
}

function assertSafeArtifactsDirectory(input: ExecuteVerifyInput): string {
  const artifactsDir = resolveExistingPathPrefix(input.artifactsDir);
  const repoRoot = resolveExistingPathPrefix(input.repoRoot);
  const filesystemRoot = path.parse(artifactsDir).root;
  const agentHarnessRoot = resolveExistingPathPrefix(path.join(getAgentHome(), "agent-harness"));
  const legacyCodexHarnessRoot = resolveExistingPathPrefix(
    path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "agent-harness"),
  );
  const defaultArtifactsRoot = resolveExistingPathPrefix(getDefaultArtifactsRoot(repoRoot));
  const legacyArtifactsRoot = resolveExistingPathPrefix(getLegacyArtifactsRoot(repoRoot));
  const unsafeExactPaths = [
    agentHarnessRoot,
    legacyCodexHarnessRoot,
    filesystemRoot,
    resolveExistingPathPrefix(homedir()),
    resolveExistingPathPrefix(tmpdir()),
    repoRoot,
    defaultArtifactsRoot,
    legacyArtifactsRoot,
  ];

  if (unsafeExactPaths.some((unsafePath) => isPathEqual(unsafePath, artifactsDir))) {
    throw new Error(`Refusing to clear unsafe verification artifacts directory: ${artifactsDir}`);
  }

  if (isDescendantOf(repoRoot, artifactsDir)) {
    if (isDescendantOf(legacyArtifactsRoot, artifactsDir)) {
      return artifactsDir;
    }
    throw new Error(`Refusing to clear repository source path as verification artifacts: ${artifactsDir}`);
  }

  if (
    isDescendantOf(defaultArtifactsRoot, artifactsDir)
    || isNestedHarnessArtifactPath(agentHarnessRoot, artifactsDir)
    || isNestedHarnessArtifactPath(legacyCodexHarnessRoot, artifactsDir)
    || isTempHarnessArtifactPath(artifactsDir)
  ) {
    return artifactsDir;
  }

  throw new Error(`Refusing to clear untrusted verification artifacts directory: ${artifactsDir}`);
}

function matchesFailurePattern(commandResult: CommandResult, failurePatterns: string[]): string[] {
  const matchedFromFullOutput = new Set(commandResult.failurePatternMatches);
  const commandOutput = `${commandResult.stdout}\n${commandResult.stderr}`;

  return failurePatterns.filter(
    (pattern) => matchedFromFullOutput.has(pattern) || new RegExp(pattern, "i").test(commandOutput),
  );
}

function summarizeCommandResult(commandResult: CommandResult, failureMatches: string[]): string[] {
  return [
    ...failureMatches,
    ...(commandResult.timedOut ? [`Command timed out after ${commandResult.timeoutMs} ms.`] : []),
    ...(commandResult.timedOut === false && commandResult.exitCode !== 0
      ? [`Command exited with code ${commandResult.exitCode}.`]
      : []),
    ...(commandResult.stdoutTruncated
      ? [`Command stdout truncated from ${commandResult.stdoutBytes} bytes to budget ${commandResult.maxStdoutBytes} bytes.`]
      : []),
    ...(commandResult.stderrTruncated
      ? [`Command stderr truncated from ${commandResult.stderrBytes} bytes to budget ${commandResult.maxStderrBytes} bytes.`]
      : []),
  ];
}

async function clearObsoleteDetachedRunArtifact(detachedRunArtifactPath: string): Promise<void> {
  if (existsSync(detachedRunArtifactPath) === false) {
    return;
  }

  const activeRun = findActiveDetachedRun(detachedRunArtifactPath);
  if (activeRun !== undefined) {
    throw new Error(
      `Cannot start inline verification while detached run ${detachedRunArtifactPath} is still active with pid ${activeRun.pid}. Run its detached status command first.`,
    );
  }

  const artifact = readDetachedRunArtifact(detachedRunArtifactPath);
  if (DETACHED_TERMINAL_STATUSES.has(artifact.status) === false) {
    removeDetachedRunArtifact(detachedRunArtifactPath);
    return;
  }

  removeDetachedRunArtifact(detachedRunArtifactPath);
}

export async function executeVerifyProfile(input: ExecuteVerifyInput): Promise<VerifyRunResult> {
  const safeArtifactsDir = assertSafeArtifactsDirectory(input);
  const safeInput: ExecuteVerifyInput = {
    ...input,
    artifactsDir: safeArtifactsDir,
  };

  if (safeInput.preserveDetachedRunArtifact !== true) {
    if (safeInput.detachedRunArtifactPath !== undefined) {
      await clearObsoleteDetachedRunArtifact(safeInput.detachedRunArtifactPath);
    }
    rmSync(safeArtifactsDir, { force: true, recursive: true });
  }
  mkdirSync(safeArtifactsDir, { recursive: true });

  const stableResultPath = path.join(safeArtifactsDir, VERIFY_RESULT_FILE_NAME);
  const execute = async (): Promise<VerifyRunResult> => {
    const pathsFilePath = path.join(safeArtifactsDir, "paths.txt");
    writeFileSync(pathsFilePath, `${safeInput.paths.join("\n")}\n`);

    const commandResults: CommandResult[] = [];
    const summary: RuleResult[] = [];

    for (const command of safeInput.profile.commands) {
      const resolvedCwd = command.cwd ? path.resolve(safeInput.repoRoot, command.cwd) : safeInput.repoRoot;
      const resolvedCommand = expandTemplate(command.run, safeInput, pathsFilePath);
      const relayDetachedOutput = safeInput.preserveDetachedRunArtifact === true;
      const commandResult = await runCommand(command.id, resolvedCommand, resolvedCwd, {
        abortSignal: safeInput.abortSignal,
        failurePatterns: safeInput.profile.failure_patterns,
        maxStderrBytes: command.maxStderrBytes,
        maxStdoutBytes: command.maxStdoutBytes,
        stderr: relayDetachedOutput
          ? makeBoundedDetachedOutputRelay(
              command.id,
              "stderr",
              command.maxStderrBytes ?? DEFAULT_COMMAND_MAX_STDERR_BYTES,
              (chunk) => process.stderr.write(chunk),
            )
          : undefined,
        stdout: relayDetachedOutput
          ? makeBoundedDetachedOutputRelay(
              command.id,
              "stdout",
              command.maxStdoutBytes ?? DEFAULT_COMMAND_MAX_STDOUT_BYTES,
              (chunk) => process.stdout.write(chunk),
            )
          : undefined,
        timeoutMs: command.timeoutMs ?? safeInput.profile.timeoutMs,
      });
      const failureMatches = matchesFailurePattern(commandResult, safeInput.profile.failure_patterns);

      commandResults.push(commandResult);
      summary.push({
        details: summarizeCommandResult(commandResult, failureMatches),
        name: command.id,
        passed: commandResult.success && failureMatches.length === 0,
      });
    }

    const isDetachedProtocolArtifact = buildDetachedProtocolArtifactFilter(safeInput, stableResultPath);
    const artifactCheck = findArtifacts(safeArtifactsDir, safeInput.profile.required_artifacts, isDetachedProtocolArtifact);
    const requiredSignalFailures = safeInput.profile.required_pass_signals.filter((requiredSignal) => {
      const matchingSummary = summary.find((entry) => entry.name === requiredSignal);
      return matchingSummary?.passed !== true;
    });

    if (requiredSignalFailures.length > 0) {
      summary.push({
        details: requiredSignalFailures.map((requiredSignal) => `Missing pass signal for ${requiredSignal}`),
        name: "required-pass-signals",
        passed: false,
      });
    }

    if (artifactCheck.missing.length > 0) {
      summary.push({
        details: artifactCheck.missing.map((artifactPattern) => `Missing artifact pattern ${artifactPattern}`),
        name: "required-artifacts",
        passed: false,
      });
    }

    const warnings = safeInput.profile.advisory
      ? summary.filter((entry) => entry.passed === false)
      : [];
    const allArtifacts = existsSync(safeArtifactsDir)
      ? listArtifactFiles(safeArtifactsDir).filter((artifactFile) => isDetachedProtocolArtifact(artifactFile) === false)
      : [];
    const result: VerifyRunResult = {
      advisory: safeInput.profile.advisory,
      artifacts: allArtifacts,
      artifactsDir: safeArtifactsDir,
      commands: commandResults,
      coversBoundaries: safeInput.profile.covers_boundaries,
      coversScenarios: safeInput.profile.covers_scenarios,
      generatedAt: dayjs().toISOString(),
      passed: safeInput.profile.advisory || summary.every((entry) => entry.passed),
      paths: [...safeInput.paths].sort(),
      profileId: safeInput.profile.id,
      proofKind: safeInput.profile.proof_kind,
      requiredArtifactsMissing: artifactCheck.missing,
      requiredArtifactsPresent: artifactCheck.present,
      summary,
      taskContractId: safeInput.taskContractId,
      taskTreeFingerprint: safeInput.taskTreeFingerprint,
      warnings,
    };

    writeFileSync(stableResultPath, JSON.stringify(result, null, 2));
    return result;
  };
  const executeWithResultClaim = async (): Promise<VerifyRunResult> => {
    return withDetachedRunResultClaim(stableResultPath, execute);
  };

  return safeInput.detachedRunArtifactPath !== undefined && safeInput.preserveDetachedRunArtifact !== true
    ? await withDetachedRunLaunchClaim(safeInput.detachedRunArtifactPath, executeWithResultClaim)
    : safeInput.preserveDetachedRunArtifact === true
      ? await execute()
      : await executeWithResultClaim();
}
