// -------------------------------------------------------------------------- //
//                                  IMPORTS                                   //
// -------------------------------------------------------------------------- //

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import dayjs from "dayjs";

import type { CommandBudget, CommandResult, RuleResult } from "./types.js";

export const DEFAULT_COMMAND_TIMEOUT_MS = 3_600_000;
export const DEFAULT_COMMAND_MAX_STDOUT_BYTES = 2_097_152;
export const DEFAULT_COMMAND_MAX_STDERR_BYTES = 2_097_152;
export const RUN_COMMAND_PROCESS_GROUPS_ENV = "AGENT_HARNESS_RUN_COMMAND_PROCESS_GROUPS";
const COMMAND_TIMEOUT_EXIT_CODE = 124;
const COMMAND_TIMEOUT_KILL_GRACE_MS = 5_000;
const WINDOWS_PROCESS_PROBE_TIMEOUT_MS = 1_000;
const VALUELESS_FLAG_SENTINEL = "__agent_harness_valueless_flag__";

// -------------------------------------------------------------------------- //
//                                 ARGUMENTS                                  //
// -------------------------------------------------------------------------- //

export type ParsedArguments = {
  command: string;
  flags: Map<string, string[]>;
};

export function parseArguments(argv: string[]): ParsedArguments {
  const [command = "", ...rest] = argv;
  const flags = new Map<string, string[]>();
  let index = 0;

  while (index < rest.length) {
    const token = rest[index];

    if (token.startsWith("--") === false) {
      index += 1;
      continue;
    }

    const key = token.slice(2);
    const nextToken = rest[index + 1];
    const existing = flags.get(key) ?? [];

    if (nextToken === undefined || nextToken.startsWith("--")) {
      existing.push(VALUELESS_FLAG_SENTINEL);
      flags.set(key, existing);
      index += 1;
      continue;
    }

    let valueIndex = index + 1;
    while (valueIndex < rest.length && rest[valueIndex]?.startsWith("--") === false) {
      existing.push(rest[valueIndex] ?? "");
      valueIndex += 1;
    }
    flags.set(key, existing);

    index = valueIndex;
  }

  return {
    command,
    flags,
  };
}

export function getFlagValue(flags: Map<string, string[]>, key: string): string | undefined {
  const value = flags.get(key)?.at(-1);
  return value === VALUELESS_FLAG_SENTINEL ? "true" : value;
}

export function getExplicitFlagValue(flags: Map<string, string[]>, key: string): string | undefined {
  const value = flags.get(key)?.at(-1);
  return value === VALUELESS_FLAG_SENTINEL ? undefined : value;
}

export function getListFlag(flags: Map<string, string[]>, key: string): string[] {
  const values = flags.get(key) ?? [];

  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function shellQuoteForPlatform(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return `"${value.replaceAll('"', '""')}"`;
  }

  return shellQuote(value);
}

export function getAgentHome(): string {
  return process.env.AGENT_HOME
    ?? path.join(os.homedir(), ".agents");
}

type WindowsProcessIdentity = {
  pid: number;
  startTime?: string;
};

function sanitizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function readPackageName(repoRoot: string): string | undefined {
  const packageJsonPath = path.join(repoRoot, "package.json");
  if (existsSync(packageJsonPath) === false) {
    return undefined;
  }

  try {
    const payload = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
    if (typeof payload === "object" && payload !== null && "name" in payload) {
      const name = (payload as { name?: unknown }).name;
      return typeof name === "string" ? name : undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function sanitizeRepoSlug(repoRoot: string): string {
  const packageSlug = readPackageName(repoRoot);
  const slug = sanitizeSlug(packageSlug ?? path.basename(repoRoot));

  return slug || "repo";
}

export function getDefaultArtifactsRoot(repoRoot: string): string {
  const overrideRoot = process.env.AGENT_HARNESS_ARTIFACTS_ROOT;

  if (overrideRoot) {
    return path.resolve(repoRoot, overrideRoot);
  }

  return path.join(getAgentHome(), "agent-harness", sanitizeRepoSlug(repoRoot));
}

export function getLegacyArtifactsRoot(repoRoot: string): string {
  return path.join(repoRoot, "artifacts", "agent-harness");
}

// -------------------------------------------------------------------------- //
//                                 OUTPUT                                     //
// -------------------------------------------------------------------------- //

export function createArtifactsDirectory(repoRoot: string, requestedPath?: string): string {
  const artifactsDirectory = requestedPath
    ? path.resolve(repoRoot, requestedPath)
    : path.join(getDefaultArtifactsRoot(repoRoot), dayjs().format("YYYYMMDD-HHmmss"));

  mkdirSync(artifactsDirectory, { recursive: true });
  return artifactsDirectory;
}

export function finalizeJsonOutput(summaryFilePath: string | undefined, payload: unknown): void {
  if (summaryFilePath) {
    mkdirSync(path.dirname(summaryFilePath), { recursive: true });
    writeFileSync(summaryFilePath, JSON.stringify(payload, null, 2));
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function makeRuleResult(details: string[], name: string, passed: boolean): RuleResult {
  return {
    details,
    name,
    passed,
  };
}

// -------------------------------------------------------------------------- //
//                                COMMANDS                                    //
// -------------------------------------------------------------------------- //

type ResolvedCommandBudget = {
  maxStderrBytes: number;
  maxStdoutBytes: number;
  timeoutMs: number;
};

type RunCommandOptions = CommandBudget & {
  abortSignal?: AbortSignal;
  failurePatterns?: string[];
  relayParentSignal?: (signal: NodeJS.Signals) => void;
  stderr?: (chunk: string) => void;
  stdout?: (chunk: string) => void;
};

type StreamOutput = {
  bytes: number;
  maxBytes: number;
  matchedFailurePatterns: string[];
  text: string;
  truncated: boolean;
};

const FORWARDED_PARENT_SIGNALS: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM"];

function shouldCreateCommandProcessGroup(environment: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform !== "win32" && environment[RUN_COMMAND_PROCESS_GROUPS_ENV] !== "0";
}

function resolveCommandBudget(budget: CommandBudget = {}): ResolvedCommandBudget {
  return {
    maxStderrBytes: budget.maxStderrBytes ?? DEFAULT_COMMAND_MAX_STDERR_BYTES,
    maxStdoutBytes: budget.maxStdoutBytes ?? DEFAULT_COMMAND_MAX_STDOUT_BYTES,
    timeoutMs: budget.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  };
}

class FailurePatternTracker {
  private carryover = "";
  private readonly carryoverLimit: number;
  private readonly compiledPatterns: Array<{ pattern: string; regex: RegExp }>;
  private decoderEnded = false;
  private readonly matchedPatterns = new Set<string>();
  private readonly streamDecoder = new StringDecoder("utf8");

  constructor(private readonly failurePatterns: string[]) {
    this.compiledPatterns = failurePatterns.flatMap((pattern) => {
      try {
        return [{ pattern, regex: new RegExp(pattern, "i") }];
      } catch {
        return [];
      }
    });

    const longestPattern = failurePatterns.reduce((longest, pattern) => Math.max(longest, pattern.length), 0);
    this.carryoverLimit = Math.max(4_096, longestPattern * 4);
  }

  private appendDecodedText(text: string): void {
    if (this.compiledPatterns.length === 0 || this.matchedPatterns.size === this.compiledPatterns.length) {
      return;
    }

    const searchWindow = `${this.carryover}${text}`;

    for (const { pattern, regex } of this.compiledPatterns) {
      if (this.matchedPatterns.has(pattern) === false && regex.test(searchWindow)) {
        this.matchedPatterns.add(pattern);
      }
    }

    this.carryover = searchWindow.slice(-this.carryoverLimit);
  }

  append(chunk: Buffer): void {
    this.appendDecodedText(this.streamDecoder.write(chunk));
  }

  getMatches(): string[] {
    if (this.decoderEnded === false) {
      this.decoderEnded = true;
      this.appendDecodedText(this.streamDecoder.end());
    }

    return this.failurePatterns.filter((pattern) => this.matchedPatterns.has(pattern));
  }
}

class OutputAccumulator {
  private exactChunks: Buffer[] | undefined = [];
  private readonly failurePatternTracker: FailurePatternTracker;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private truncated = false;
  private totalBytes = 0;

  constructor(private readonly maxBytes: number, failurePatterns: string[] = []) {
    this.failurePatternTracker = new FailurePatternTracker(failurePatterns);
    this.headLimit = Math.floor(maxBytes / 2);
    this.tailLimit = maxBytes - this.headLimit;
  }

  append(chunk: Buffer): void {
    this.failurePatternTracker.append(chunk);

    const nextTotalBytes = this.totalBytes + chunk.length;

    if (this.truncated === false && nextTotalBytes <= this.maxBytes) {
      this.exactChunks?.push(chunk);
      this.totalBytes = nextTotalBytes;
      return;
    }

    if (this.truncated === false) {
      const existing = Buffer.concat(this.exactChunks ?? []);
      const combined = Buffer.concat([existing, chunk]);
      this.head = combined.subarray(0, this.headLimit);
      this.tail = combined.subarray(Math.max(0, combined.length - this.tailLimit));
      this.exactChunks = undefined;
      this.truncated = true;
      this.totalBytes = nextTotalBytes;
      return;
    }

    this.tail = Buffer.concat([this.tail, chunk]).subarray(Math.max(0, this.tail.length + chunk.length - this.tailLimit));
    this.totalBytes = nextTotalBytes;
  }

  finish(): StreamOutput {
    if (this.truncated === false) {
      return {
        bytes: this.totalBytes,
        maxBytes: this.maxBytes,
        matchedFailurePatterns: this.failurePatternTracker.getMatches(),
        text: Buffer.concat(this.exactChunks ?? []).toString("utf8"),
        truncated: false,
      };
    }

    const omittedBytes = Math.max(0, this.totalBytes - this.head.length - this.tail.length);
    const marker = `\n[agent-harness truncated ${omittedBytes} byte${omittedBytes === 1 ? "" : "s"}; original=${this.totalBytes}; max=${this.maxBytes}]\n`;
    return {
      bytes: this.totalBytes,
      maxBytes: this.maxBytes,
      matchedFailurePatterns: this.failurePatternTracker.getMatches(),
      text: `${this.head.toString("utf8")}${marker}${this.tail.toString("utf8")}`,
      truncated: true,
    };
  }
}

export function buildWindowsTaskkillArgs(pid: number, force = false): string[] {
  const args = ["/PID", String(pid), "/T"];
  if (force) {
    args.push("/F");
  }

  return args;
}

function readWindowsProcessIdentity(pid: number): WindowsProcessIdentity | undefined {
  if (pid <= 0 || process.platform !== "win32") {
    return undefined;
  }

  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { $p.CreationDate }`,
  ], {
    encoding: "utf8",
    timeout: WINDOWS_PROCESS_PROBE_TIMEOUT_MS,
  });
  const startTime = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (result.status !== 0 || startTime.length === 0) {
    return undefined;
  }

  return { pid, startTime };
}

export function windowsProcessIdentityStillMatches(identity: WindowsProcessIdentity | undefined): boolean {
  if (identity === undefined || identity.startTime === undefined) {
    return false;
  }

  return readWindowsProcessIdentity(identity.pid)?.startTime === identity.startTime;
}

function terminateWindowsProcessTree(pid: number, identity: WindowsProcessIdentity | undefined, force = false): boolean {
  if (windowsProcessIdentityStillMatches(identity) === false) {
    return false;
  }

  const result = spawnSync("taskkill", buildWindowsTaskkillArgs(pid, force), {
    stdio: "ignore",
  });
  return result.status === 0;
}

function terminateChildProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
  detached: boolean,
  windowsProcessIdentity?: WindowsProcessIdentity,
): void {
  if (child.pid === undefined) {
    return;
  }

  try {
    if (process.platform === "win32") {
      if (terminateWindowsProcessTree(child.pid, windowsProcessIdentity, signal === "SIGKILL")) {
        return;
      }
      child.kill(signal);
      return;
    }

    if (detached) {
      process.kill(-child.pid, signal);
      return;
    }

    child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process may already have exited between timeout handling and signal delivery.
    }
  }
}

export async function runCommand(
  commandId: string,
  commandText: string,
  cwd: string,
  options?: RunCommandOptions,
): Promise<CommandResult> {
  const startedAt = Date.now();
  const resolvedBudget = resolveCommandBudget(options);
  const failurePatterns = options?.failurePatterns ?? [];
  const spawnDetached = shouldCreateCommandProcessGroup();
  const relayParentSignal = options?.relayParentSignal ?? ((signal: NodeJS.Signals) => process.kill(process.pid, signal));

  return await new Promise<CommandResult>((resolve) => {
    if (options?.abortSignal?.aborted) {
      resolve({
        commandId,
        cwd,
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        failurePatternMatches: [],
        maxStderrBytes: resolvedBudget.maxStderrBytes,
        maxStdoutBytes: resolvedBudget.maxStdoutBytes,
        stderr: "Command aborted before start.\n",
        stderrBytes: "Command aborted before start.\n".length,
        stderrTruncated: false,
        stdout: "",
        stdoutBytes: 0,
        stdoutTruncated: false,
        success: false,
        timedOut: false,
        timeoutMs: resolvedBudget.timeoutMs,
      });
      return;
    }

    let timedOut = false;
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let killHandle: ReturnType<typeof setTimeout> | undefined;
    const stderr = new OutputAccumulator(resolvedBudget.maxStderrBytes, failurePatterns);
    const stdout = new OutputAccumulator(resolvedBudget.maxStdoutBytes, failurePatterns);
    const stderrDecoder = new StringDecoder("utf8");
    const stdoutDecoder = new StringDecoder("utf8");
    const child = spawn(commandText, {
      cwd,
      detached: spawnDetached,
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const windowsProcessIdentity = child.pid === undefined ? undefined : readWindowsProcessIdentity(child.pid);

    const parentSignalHandlers = new Map<NodeJS.Signals, () => void>();
    const clearParentSignalHandlers = (): void => {
      for (const [signal, handler] of parentSignalHandlers) {
        process.removeListener(signal, handler);
      }
      parentSignalHandlers.clear();
    };
    const clearAbortHandler = (): void => {
      options?.abortSignal?.removeEventListener("abort", abortCommand);
    };

    FORWARDED_PARENT_SIGNALS.forEach((signal) => {
      const handler = (): void => {
        clearParentSignalHandlers();
        terminateChildProcess(child, signal, spawnDetached, windowsProcessIdentity);
        relayParentSignal(signal);
      };

      parentSignalHandlers.set(signal, handler);
      process.once(signal, handler);
    });

    function finish(exitCode: number | null): void {
      if (settled) {
        return;
      }
      settled = true;
      const finalStdout = stdoutDecoder.end();
      const finalStderr = stderrDecoder.end();
      if (finalStdout.length > 0) {
        options?.stdout?.(finalStdout);
      }
      if (finalStderr.length > 0) {
        options?.stderr?.(finalStderr);
      }
      clearParentSignalHandlers();
      clearAbortHandler();

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (killHandle) {
        clearTimeout(killHandle);
      }

      const stderrOutput = stderr.finish();
      const stdoutOutput = stdout.finish();
      const resolvedExitCode = timedOut ? COMMAND_TIMEOUT_EXIT_CODE : exitCode ?? 1;
      const failurePatternMatches = [...new Set([...stdoutOutput.matchedFailurePatterns, ...stderrOutput.matchedFailurePatterns])];

      resolve({
        commandId,
        cwd,
        durationMs: Date.now() - startedAt,
        exitCode: resolvedExitCode,
        failurePatternMatches,
        maxStderrBytes: stderrOutput.maxBytes,
        maxStdoutBytes: stdoutOutput.maxBytes,
        stderr: stderrOutput.text,
        stderrBytes: stderrOutput.bytes,
        stderrTruncated: stderrOutput.truncated,
        stdout: stdoutOutput.text,
        stdoutBytes: stdoutOutput.bytes,
        stdoutTruncated: stdoutOutput.truncated,
        success: timedOut === false && resolvedExitCode === 0,
        timedOut,
        timeoutMs: resolvedBudget.timeoutMs,
      });
    }

    function abortCommand(): void {
      terminateChildProcess(child, "SIGTERM", spawnDetached, windowsProcessIdentity);
      killHandle = setTimeout(() => {
        terminateChildProcess(child, "SIGKILL", spawnDetached, windowsProcessIdentity);
      }, COMMAND_TIMEOUT_KILL_GRACE_MS);
    }

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      terminateChildProcess(child, "SIGTERM", spawnDetached, windowsProcessIdentity);
      killHandle = setTimeout(() => {
        terminateChildProcess(child, "SIGKILL", spawnDetached, windowsProcessIdentity);
      }, COMMAND_TIMEOUT_KILL_GRACE_MS);
    }, resolvedBudget.timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      if (text.length > 0) {
        options?.stderr?.(text);
      }
      stderr.append(chunk);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = stdoutDecoder.write(chunk);
      if (text.length > 0) {
        options?.stdout?.(text);
      }
      stdout.append(chunk);
    });

    options?.abortSignal?.addEventListener("abort", abortCommand, { once: true });
    if (options?.abortSignal?.aborted) {
      abortCommand();
    }

    child.on("close", (exitCode) => {
      finish(exitCode);
    });

    child.on("error", () => {
      finish(1);
    });
  });
}
